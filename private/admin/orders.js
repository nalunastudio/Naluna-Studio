// Vânzări & Funnel — Admin NALUNA (2026-09-18, Funnel Analytics FAZA 2). Extinde pagina
// "Comenzi" (reorganizarea din 2026-09-18: paginare/search/filtrare REALE, server-side — vezi
// comentariul original de mai jos, neschimbat) cu Period Selector + KPI Cards + Conversion Funnel
// + Revenue & Orders Trend + Traffic & Sales Sources, toate dintr-un SINGUR endpoint agregat
// (GET /api/admin/orders/funnel-summary) — un singur round-trip HTTP pentru toată partea de sus a
// paginii, niciodată tot setul de comenzi/evenimente încărcat în browser.
//
// NOTA privind data/ora folosită pentru NAVIGAREA implicită (butoanele „Azi”/săgeți, eticheta
// perioadei): foloseste ceasul LOCAL al browserului adminului — STRICT pentru comoditatea
// interfeței (ce lună/săptămână/zi să afișeze implicit). Bucketing-ul REAL al datelor (ce comandă
// intră în ce perioadă) se întâmplă EXCLUSIV server-side, în Europe/London, prin
// lib/funnel-period.js — micile diferențe de fus orar ale ceasului browserului NU afectează
// niciodată corectitudinea cifrelor, doar eventual eticheta implicită arătată la încărcare.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDaysLocal(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return toDateStr(dt);
}
function isoMondayOfLocal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const diff = (dow === 0) ? -6 : (1 - dow);
  return addDaysLocal(dateStr, diff);
}
const MONTH_NAMES_RO = ['Ianuarie', 'Februarie', 'Martie', 'Aprilie', 'Mai', 'Iunie', 'Iulie', 'August', 'Septembrie', 'Octombrie', 'Noiembrie', 'Decembrie'];
const MONTH_SHORT_RO = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Noi', 'Dec'];
function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_SHORT_RO[m - 1]} ${y}`;
}

// ==========================================================================================
// PERIOD SELECTOR
// ==========================================================================================
// DEFAULT "Zi"/Azi in Europe/London (2026-09-26, cerinta explicita): la fiecare acces nou/refresh
// complet al paginii, perioada implicita trebuie sa fie "Zi" = ZIUA CURENTA in Europe/London, NU
// ceasul local al browserului adminului (care poate fi intr-un alt fus orar) — spre deosebire de
// restul navigarii Period Selector-ului (butoanele "Azi"/sageti, mai jos), care raman STRICT UI-
// convenience pe ceasul local browserului (comportament PRE-EXISTENT, documentat, neschimbat aici
// — bucketing-ul REAL al datelor tot in Europe/London, server-side, indiferent de aceasta valoare
// initiala). 'en-CA' formateaza nativ ca YYYY-MM-DD, exact formatul folosit de restul fisierului.
function todayInLondon() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const todayLondonStr = todayInLondon();
const [todayLondonYear, todayLondonMonth] = todayLondonStr.split('-').map(Number);
let periodState = { type: 'day', year: todayLondonYear, month: todayLondonMonth, anchorDate: todayLondonStr, date: todayLondonStr, startDate: addDaysLocal(todayLondonStr, -6), endDate: todayLondonStr };
let lastResolvedBounds = null; // { startDate, endDateExclusive } — umplut dupa fiecare raspuns de la server

const periodTypeTabs = document.getElementById('period-type-tabs');
const periodNav = document.getElementById('period-nav');
const periodLabel = document.getElementById('period-label');
const periodCustomRange = document.getElementById('period-custom-range');
const periodCustomStart = document.getElementById('period-custom-start');
const periodCustomEnd = document.getElementById('period-custom-end');

function buildPeriodParams() {
  const p = new URLSearchParams({ periodType: periodState.type });
  if (periodState.type === 'month') { p.set('year', periodState.year); p.set('month', periodState.month); }
  else if (periodState.type === 'week') { p.set('anchorDate', periodState.anchorDate); }
  else if (periodState.type === 'day') { p.set('date', periodState.date); }
  else if (periodState.type === 'custom') { p.set('startDate', periodState.startDate); p.set('endDate', periodState.endDate); }
  return p.toString();
}

function updatePeriodLabel() {
  if (periodState.type === 'month') {
    periodLabel.textContent = `${MONTH_NAMES_RO[periodState.month - 1]} ${periodState.year}`;
  } else if (periodState.type === 'week') {
    const monday = isoMondayOfLocal(periodState.anchorDate);
    const sunday = addDaysLocal(monday, 6);
    periodLabel.textContent = `${formatDateShort(monday)} – ${formatDateShort(sunday)}`;
  } else if (periodState.type === 'day') {
    periodLabel.textContent = formatDateShort(periodState.date);
  } else {
    periodLabel.textContent = `${formatDateShort(periodState.startDate)} – ${formatDateShort(periodState.endDate)}`;
  }
  periodNav.style.display = periodState.type === 'custom' ? 'none' : 'flex';
  periodCustomRange.style.display = periodState.type === 'custom' ? 'flex' : 'none';
}

periodTypeTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period-type]');
  if (!btn) return;
  periodTypeTabs.querySelectorAll('.period-tab').forEach((b) => b.classList.toggle('active', b === btn));
  periodState.type = btn.dataset.periodType;
  updatePeriodLabel();
  if (periodState.type !== 'custom') refreshAll();
});

document.getElementById('period-prev').addEventListener('click', () => {
  if (periodState.type === 'month') {
    periodState.month -= 1;
    if (periodState.month < 1) { periodState.month = 12; periodState.year -= 1; }
  } else if (periodState.type === 'week') {
    periodState.anchorDate = addDaysLocal(isoMondayOfLocal(periodState.anchorDate), -7);
  } else if (periodState.type === 'day') {
    periodState.date = addDaysLocal(periodState.date, -1);
  }
  updatePeriodLabel();
  refreshAll();
});
document.getElementById('period-next').addEventListener('click', () => {
  if (periodState.type === 'month') {
    periodState.month += 1;
    if (periodState.month > 12) { periodState.month = 1; periodState.year += 1; }
  } else if (periodState.type === 'week') {
    periodState.anchorDate = addDaysLocal(isoMondayOfLocal(periodState.anchorDate), 7);
  } else if (periodState.type === 'day') {
    periodState.date = addDaysLocal(periodState.date, 1);
  }
  updatePeriodLabel();
  refreshAll();
});
document.getElementById('period-today').addEventListener('click', () => {
  const t = toDateStr(new Date());
  periodState.year = new Date().getFullYear();
  periodState.month = new Date().getMonth() + 1;
  periodState.anchorDate = t;
  periodState.date = t;
  updatePeriodLabel();
  refreshAll();
});
periodCustomStart.value = periodState.startDate;
periodCustomEnd.value = periodState.endDate;
document.getElementById('period-custom-apply').addEventListener('click', () => {
  if (!periodCustomStart.value || !periodCustomEnd.value) return;
  periodState.startDate = periodCustomStart.value;
  periodState.endDate = periodCustomEnd.value;
  updatePeriodLabel();
  refreshAll();
});

// ==========================================================================================
// KPI CARDS + FUNNEL + TREND + SOURCES (un singur fetch, GET /api/admin/orders/funnel-summary)
// ==========================================================================================
// KPI_DEFS (2026-09-19, FAZA 1 clarificare) — traffic:true marcheaza cele 3 KPI event-based
// (Vizitatori/CTA/Formular), care nu au nicio sursa alta decat funnel_events si deci depind de
// trafficDataAvailability ('complete'/'partial'/'unmeasured', calculat server-side de
// db.getTrafficDataAvailability — vezi si formatDataCompleteSince mai jos). Etichetele
// "...în perioadă" pentru Comenzi create/Checkout-uri/Comenzi plătite/Venit clarifica explicit ca
// aceste KPI sunt event-time (ferestruite STRICT pe propriul lor timestamp), spre deosebire de
// Funnel-ul de conversie (cohortat — vezi renderFunnelCohort mai jos) care poate afisa cifre
// DIFERITE pentru "aceleasi" etape, din motive documentate in raportul de audit (sectiunea 11).
const KPI_DEFS = [
  { key: 'trackedVisitors', label: 'Vizitatori urmăriți', traffic: true, note: 'Doar vizitatorii cu Analytics acceptat' },
  { key: 'ctaClicks', label: 'Click-uri CTA homepage', traffic: true },
  { key: 'formStarted', label: 'Formular început', traffic: true },
  { key: 'ordersCreated', label: 'Comenzi create în perioadă' },
  // distinctCustomers (2026-09-25, KPI nou "Clienți distincți cu comandă" — cerinta explicita,
  // urmare a auditului aceleiasi zile): COUNT(DISTINCT lower(trim(email))) din comenzile REALE
  // create in perioada — vezi db.js#getFunnelKpis pentru sursa exacta. Plasat imediat dupa
  // "Comenzi create" (aceeasi sursa, tabela orders) — NU langa "Vizitatori urmăriți" (KPI diferit,
  // consent-gated), ca sa nu sugereze fals ca sunt aceeasi masuratoare. NU are `traffic:true` —
  // nu depinde de trafficDataAvailability/Analytics consent, e mereu masurabil complet.
  { key: 'distinctCustomers', label: 'Clienți distincți cu comandă' },
  { key: 'reachedCheckout', label: 'Checkout-uri create în perioadă' },
  { key: 'paidOrders', label: 'Comenzi plătite în perioadă' },
  { key: 'paidCustomers', label: 'Clienți plătitori în perioadă' },
  { key: 'revenue', label: 'Venit încasat în perioadă', money: true }
];

// "Date parțiale — tracking disponibil din <data>" (2026-09-19, FAZA 1 corectie, cerinta
// explicita) — data vine STRICT din dataCompleteSince (sursa autoritativa server-side, MIN(occurred_at)
// din funnel_events — vezi db.js#getFunnelDataCompleteSince/getTrafficDataAvailability), niciodata
// hardcodata aici.
function formatPartialNote(dataCompleteSince) {
  if (!dataCompleteSince) return '';
  return `Date parțiale — tracking disponibil din ${new Date(dataCompleteSince).toLocaleDateString('ro-RO')}`;
}

function renderKpiCards(kpis, trafficDataAvailability, dataCompleteSince) {
  const el = document.getElementById('kpi-cards');
  const partialNote = formatPartialNote(dataCompleteSince);
  el.innerHTML = KPI_DEFS.map((d) => {
    const isTraffic = Boolean(d.traffic);
    const unmeasured = isTraffic && trafficDataAvailability === 'unmeasured';
    const partial = isTraffic && trafficDataAvailability === 'partial';
    const value = unmeasured ? 'Nemăsurat' : (d.money ? '£' + Number(kpis[d.key]).toFixed(2) : Number(kpis[d.key]));
    const statClass = unmeasured ? ' stat-unmeasured' : (partial ? ' stat-partial' : '');
    const note = partial ? `<div class="stat-note" title="${escapeHtml(partialNote)}">Date parțiale</div>` : '';
    // d.note (2026-09-25, "Vizitatori urmăriți" — cerinta explicita): explicatie foarte scurta,
    // STRICT tooltip (title) — nu schimba formula KPI-ului, doar clarifica dependenta de consent.
    const labelTitle = d.note ? ` title="${escapeHtml(d.note)}"` : '';
    return `
    <div class="stat${statClass}">
      <div class="label"${labelTitle}>${d.label}</div>
      <div class="value">${value}</div>
      ${note}
    </div>
  `;
  }).join('');
}

// N/A (2026-09-19, neschimbat) = masuratoare VALIDA, dar numitorul e 0 — nu exista inca ce sa
// impartim. Distinct de "Nemăsurat" (renderFunnelTraffic/renderKpiCards) = perioada e dinaintea
// inceputului real al tracking-ului, deci nici numaratorul nici numitorul nu sunt masuratori
// valide — cele doua NU trebuie amestecate sub aceeasi eticheta.
function pct(v) { return v === null || v === undefined ? 'N/A' : `${v.toFixed(1)}%`; }

// TRAFIC — Vizitatori urmăriți -> Formular început (2026-09-19, FAZA 1 clarificare + corectie
// 3-stari). Pas SEPARAT de funnel-ul cohortat de mai jos (vezi renderFunnelCohort) — ambele sunt
// event-time (fereastra perioadei), NU o cohorta legata de comenzi, deci NU trebuie prezentate ca
// acelasi grup continuu de persoane cu etapele de comenzi (vezi raportul de audit, sectiunea 11).
// trafficDataAvailability 'unmeasured' -> mesaj, fara randuri (nicio cifra reala). 'partial' ->
// randurile SE AFISEAZA cu valorile reale (exista date pentru partea acoperita a perioadei),
// insotite de un mesaj compact — NICIODATA ascunse ca "Nemăsurat" (ar sterge date reale existente,
// cerinta explicita 2026-09-19).
// CORECȚIE (2026-09-20, cerinta explicita): NU se mai afiseaza niciun procent Vizitatori ->
// Formular in aceasta sectiune — "Formular început" e event-based (acelasi vizitator poate genera
// mai multe evenimente form_started), deci raportul formStarted/trackedVisitors poate depasi 100%
// (ex. 3 vizitatori / 4 formulare -> 133.3%), ceea ce nu e o rata de conversie valida si induce in
// eroare. Randurile arata STRICT valorile absolute — niciun procent inlocuitor.
function renderFunnelTraffic(traffic, trafficDataAvailability, dataCompleteSince) {
  const el = document.getElementById('funnel-traffic');
  if (trafficDataAvailability === 'unmeasured') {
    el.innerHTML = '<div class="empty">Date indisponibile — tracking-ul de trafic nu acoperă această perioadă.</div>';
    return;
  }
  const partialNote = (trafficDataAvailability === 'partial')
    ? `<div class="funnel-partial-note">${escapeHtml(formatPartialNote(dataCompleteSince))}</div>`
    : '';
  const maxCount = Math.max(1, traffic.trackedVisitors, traffic.formStarted);
  el.innerHTML = partialNote + `
    <div class="funnel-row">
      <div class="funnel-row-label">Vizitatori urmăriți</div>
      <div class="funnel-row-bar-wrap"><div class="funnel-row-bar" style="width:${Math.max(2, (traffic.trackedVisitors / maxCount) * 100)}%"></div></div>
      <div class="funnel-row-count">${traffic.trackedVisitors}</div>
      <div class="funnel-row-meta"></div>
    </div>
    <div class="funnel-row">
      <div class="funnel-row-label">Formular început</div>
      <div class="funnel-row-bar-wrap"><div class="funnel-row-bar" style="width:${Math.max(2, (traffic.formStarted / maxCount) * 100)}%"></div></div>
      <div class="funnel-row-count">${traffic.formStarted}</div>
      <div class="funnel-row-meta"></div>
    </div>
  `;
}

// CONVERSIE COMENZI — cohortat (2026-09-19, FAZA 1 clarificare): comenzile CREATE în perioada
// selectată formează baza (100%, fara procent afisat pe randul ei — vezi lib/funnel-math.js,
// computeCohortFunnel), Checkout/Plătite raportează procentul fata de ACEASTA baza, niciodata fata
// de etapa anterioara — cere explicita: "din cei care au pornit o comanda in aceasta perioada,
// cati au ajuns la checkout / cati au platit", indiferent CAND s-au intamplat acele etape
// ulterioare. CTA nu apare aici deloc (ramane STRICT KPI separat, vezi renderKpiCards) — un
// vizitator poate ajunge direct pe /comanda.html, fara niciun CTA instrumentat.
function renderFunnelCohort(cohort, checkoutToPaidPct) {
  const el = document.getElementById('funnel-cohort');
  const maxCount = Math.max(1, ...cohort.map((s) => s.count));
  el.innerHTML = cohort.map((s) => {
    const pctText = (s.key === 'ordersCreated') ? 'Bază' : pct(s.pctOfBase);
    const extra = (s.key === 'paidOrders' && checkoutToPaidPct !== null)
      ? `<span class="funnel-row-extra" title="Din comenzile care au ajuns la checkout, câte au și plătit">· ${pct(checkoutToPaidPct)} checkout→plată</span>`
      : '';
    return `
    <div class="funnel-row">
      <div class="funnel-row-label">${escapeHtml(s.label)}</div>
      <div class="funnel-row-bar-wrap">
        <div class="funnel-row-bar" style="width:${Math.max(2, (s.count / maxCount) * 100)}%"></div>
      </div>
      <div class="funnel-row-count">${s.count}</div>
      <div class="funnel-row-meta">
        <span title="Procent din Comenzi create (baza cohortei)">${pctText}</span>
        ${extra}
      </div>
    </div>
  `;
  }).join('');
}

function renderTrend(trend) {
  const el = document.getElementById('trend-chart');
  if (!trend.length) { el.innerHTML = '<div class="empty">Fără date în această perioadă.</div>'; return; }
  const maxRevenue = Math.max(1, ...trend.map((t) => t.revenue));
  const maxOrders = Math.max(1, ...trend.map((t) => t.ordersCreated));
  el.innerHTML = `<div class="trend-bars">${trend.map((t) => `
    <div class="trend-bar-col" title="${formatDateShort(t.date)} — ${t.ordersCreated} comenzi, £${t.revenue.toFixed(2)} venit">
      <div class="trend-bar-pair">
        <div class="trend-bar trend-bar-orders" style="height:${Math.max(2, (t.ordersCreated / maxOrders) * 100)}%"></div>
        <div class="trend-bar trend-bar-revenue" style="height:${Math.max(2, (t.revenue / maxRevenue) * 100)}%"></div>
      </div>
      <div class="trend-bar-date">${trend.length > 14 ? '' : formatDateShort(t.date).replace(/ \d{4}$/, '')}</div>
    </div>
  `).join('')}</div>
  <div class="trend-legend"><span class="trend-legend-item"><i class="trend-swatch trend-swatch-orders"></i>Comenzi create</span><span class="trend-legend-item"><i class="trend-swatch trend-swatch-revenue"></i>Venit</span></div>`;
}

function renderSources(sources) {
  const body = document.getElementById('sources-body');
  if (!sources.length) { body.innerHTML = '<tr><td colspan="9" class="empty">Nicio comandă în această perioadă.</td></tr>'; return; }
  body.innerHTML = sources.map((s) => `
    <tr>
      <td>${escapeHtml(s.source)}</td>
      <td>${escapeHtml(s.campaign)}</td>
      <td>${s.trackedVisitors}</td>
      <td>${s.formStarted}</td>
      <td>${s.ordersCreated}</td>
      <td>${s.reachedCheckout}</td>
      <td>${s.paidOrders}</td>
      <td>£${s.revenue.toFixed(2)}</td>
      <td>${pct(s.conversionRatePct)}</td>
    </tr>
  `).join('');
}

// Performanța creativelor (2026-09-22, atribuire reclame/creative prin utm_content) — ACELASI
// tipar de randare ca renderSources, cu o singura diferenta importanta: trackedVisitors/
// formStarted sunt event-based (funnel_events), deci supuse ACELUIASI semnal 3-stari
// trafficDataAvailability deja calculat pentru restul paginii (vezi renderFunnelTraffic) —
// 'unmeasured' inseamna ca acele doua coloane NU sunt cifre reale pentru NICIUN rand din aceasta
// perioada (afisate "—", niciodata 0 — 0 ar insemna fals "masurat, zero real"). 'partial' arata
// cifrele reale (exista date pentru partea acoperita a perioadei), cu o nota compacta deasupra
// tabelului. Comenzi create/Checkout/Plătite/Venit raman NEATINSE — sursa lor (tabela orders) e
// mereu reala, indiferent de tracking.
function renderCreatives(creatives, trafficDataAvailability, dataCompleteSince) {
  const noteEl = document.getElementById('creatives-partial-note');
  noteEl.innerHTML = (trafficDataAvailability === 'partial')
    ? `<div class="funnel-partial-note">${escapeHtml(formatPartialNote(dataCompleteSince))}</div>`
    : '';

  const body = document.getElementById('creatives-body');
  if (!creatives.length) { body.innerHTML = '<tr><td colspan="10" class="empty">Nicio comandă în această perioadă.</td></tr>'; return; }
  const unmeasured = trafficDataAvailability === 'unmeasured';
  body.innerHTML = creatives.map((c) => `
    <tr>
      <td>${escapeHtml(c.content)}</td>
      <td>${escapeHtml(c.campaigns)}</td>
      <td>${escapeHtml(c.sources)}</td>
      <td>${unmeasured ? '—' : c.trackedVisitors}</td>
      <td>${unmeasured ? '—' : c.formStarted}</td>
      <td>${c.ordersCreated}</td>
      <td>${c.reachedCheckout}</td>
      <td>${c.paidOrders}</td>
      <td>£${c.revenue.toFixed(2)}</td>
      <td>${pct(c.conversionRatePct)}</td>
    </tr>
  `).join('');
}

// SMART PREVIEW — comportament preview (2026-09-22) — ACELASI tipar 3-stari ('complete'/'partial'/
// 'unmeasured') ca restul paginii, dar cu propria sursa de "masurat de la" (previewDataAvailability/
// previewDataCompleteSince, vezi db.js#getPreviewDataAvailability) — Smart Preview e o
// functionalitate NOUA, deployata mult dupa restul tracking-ului, deci nu poate folosi
// trafficDataAvailability existent (ar afisa gresit perioade vechi ca "masurate").
// checkoutAfterPreview foloseste ACEEASI sursa de date (funnel_events, evenimentul preview_played
// legat de order_id) — 'unmeasured'/'partial' se aplica identic si acestei valori, nu doar
// pragurilor de ascultare.
const PREVIEW_DEFS = [
  { key: 'played', label: 'Preview pornit' },
  { key: 'progress25', label: 'Ascultat ≥25%' },
  { key: 'progress50', label: 'Ascultat ≥50%' },
  { key: 'progress75', label: 'Ascultat ≥75%' },
  { key: 'progress100', label: 'Ascultat 100%' },
  { key: 'completed', label: 'Finalizat (redare completă)' },
  { key: 'replayed', label: 'Replay' },
  { key: 'checkoutAfterPreview', label: 'Checkout după preview' }
];

function renderPreviewSection(preview, previewDataAvailability, previewDataCompleteSince) {
  const noteEl = document.getElementById('preview-partial-note');
  const el = document.getElementById('preview-cards');
  if (previewDataAvailability === 'unmeasured') {
    noteEl.innerHTML = '';
    el.innerHTML = PREVIEW_DEFS.map((d) => `
      <div class="stat stat-unmeasured">
        <div class="label">${d.label}</div>
        <div class="value">Nemăsurat</div>
      </div>
    `).join('');
    return;
  }
  noteEl.innerHTML = (previewDataAvailability === 'partial')
    ? `<div class="funnel-partial-note">${escapeHtml(formatPartialNote(previewDataCompleteSince))}</div>`
    : '';
  el.innerHTML = PREVIEW_DEFS.map((d) => `
    <div class="stat">
      <div class="label">${d.label}</div>
      <div class="value">${Number(preview[d.key])}</div>
    </div>
  `).join('');
}

function renderDataCompleteBanner(dataCompleteSince) {
  const el = document.getElementById('data-complete-banner');
  if (!dataCompleteSince) {
    el.textContent = 'Analiza funnel-ului (vizitatori urmăriți, click-uri CTA, formular început) nu are încă niciun eveniment înregistrat — Comenzile/Venitul rămân corecte și complete (sursă: tabela orders), dar KPI-urile de trafic vor apărea 0 până la primul eveniment real.';
    el.style.display = 'block';
  } else {
    const d = new Date(dataCompleteSince);
    el.textContent = `Analiza completă a funnel-ului (vizitatori urmăriți, click-uri CTA, formular început) e disponibilă începând cu ${d.toLocaleDateString('ro-RO')} — perioadele dinaintea acestei date nu au aceste 3 KPI-uri măsurate (nu înseamnă zero real, ci „nemăsurat”).`;
    el.style.display = 'block';
  }
}

// silent (2026-09-25, auto-refresh KPI — vezi raportul catre user): apelurile EXPLICITE ale
// utilizatorului (incarcarea paginii, navigarea Period Selector-ului, bifarea "Restrange la
// perioada", schimbarea filtrului "Doar plătite") raman NESCHIMBATE — silent=false implicit,
// tot resincronizeaza tabelul cu perioada (INCLUSIV resetarea paginii la 1, comportament corect
// cand utilizatorul chiar a schimbat ceva). Tick-ul periodic de fundal (autoRefreshTick, mai jos)
// cere STRICT silent=true — actualizeaza cardurile KPI/funnel FARA sa atinga starea tabelului
// (offset/cautare/filtre/pozitie de scroll), ca o reimprospatare de fundal sa nu "sara" admin-ul
// inapoi la pagina 1 sau sa ii stearga cautarea in timp ce citeste.
async function loadFunnelSummary({ silent = false } = {}) {
  try {
    const res = await fetch(`/api/admin/orders/funnel-summary?${buildPeriodParams()}`);
    const data = await res.json();
    if (!res.ok) { console.error('funnel-summary error:', data.error); return; }
    lastResolvedBounds = data.period;
    renderKpiCards(data.kpis, data.trafficDataAvailability, data.dataCompleteSince);
    renderFunnelTraffic(data.funnel.traffic, data.trafficDataAvailability, data.dataCompleteSince);
    renderFunnelCohort(data.funnel.cohort, data.funnel.checkoutToPaidPct);
    renderTrend(data.trend);
    renderSources(data.sources);
    renderCreatives(data.creatives, data.trafficDataAvailability, data.dataCompleteSince);
    renderPreviewSection(data.preview, data.previewDataAvailability, data.previewDataCompleteSince);
    renderDataCompleteBanner(data.dataCompleteSince);
    if (!silent && syncPeriodCheckbox.checked) applyPeriodSyncToOrdersFilter();
  } catch (err) {
    // Un fetch esuat (retea/server) NU trebuie sa strice pagina — ramanem STRICT pe ultimele
    // date afisate cu succes, niciodata un ecran gol/spart. Valabil identic pentru apelurile
    // explicite SI pentru tick-ul de fundal.
    console.error('Eroare la încărcarea rezumatului funnel:', err);
  }
}

// ==========================================================================================
// COMENZI — paginare/search/filtrare REALE, server-side (2026-09-18, reorganizare Admin). Inainte,
// GET /api/admin/orders intorcea TOATE comenzile si tabelul intreg era randat dintr-o singura
// lista incarcata in browser — nescalabil la sute/mii de comenzi. Acum: fiecare actiune (cautare,
// schimbare filtru, pagina urmatoare) cere serverului STRICT pagina curenta, niciodata tot tabelul.
// EXTINS (FAZA 2): filtre noi (platit/neplatit, sursa, campanie, real/test) + optiunea de a
// restrange automat la perioada selectata in Period Selector de mai sus.
// ==========================================================================================

const statusLabel = {
  draft: 'Neplătită',
  generating: 'Se compune',
  processing_provider_result: 'Se finalizează',
  preview_ready: 'Previzualizare gata',
  ready: 'Plătită și livrată',
  generation_failed: 'Eroare'
};

const PAGE_SIZE = 50;
// TABLE_COLSPAN (2026-09-26): Nr. comandă, Nr. client, Data, Pentru, Email, Limba, Ocazie, Gen,
// Pachet, Preț, Status, Sursă, Locație, Recovery, Acțiuni — 15 coloane totale (vezi orders.html).
const TABLE_COLSPAN = 15;
let state = { offset: 0, status: '', q: '', paid: '', utmSource: '', utmCampaign: '', testFilter: '', dateFrom: null, dateTo: null };
let ordersCache = [];

const searchInput = document.getElementById('orders-search');
const statusFilter = document.getElementById('orders-status-filter');
const paidFilter = document.getElementById('orders-paid-filter');
const sourceFilter = document.getElementById('orders-source-filter');
const campaignFilter = document.getElementById('orders-campaign-filter');
const testFilterEl = document.getElementById('orders-test-filter');
const syncPeriodCheckbox = document.getElementById('orders-sync-period');
const ordersBody = document.getElementById('orders-body');
const paginationInfo = document.getElementById('orders-pagination-info');
const prevBtn = document.getElementById('orders-prev-btn');
const nextBtn = document.getElementById('orders-next-btn');

// ==========================================================================================
// BARA DE SCROLL ORIZONTAL DE SUS (2026-09-19) — control real, sincronizat bidirectional cu
// bara de JOS (#orders-table-scroll, scroll-ul "clasic" al tabelului). UN SINGUR tabel
// (#orders-table) — bara de sus e doar o a doua "fereastra" spre acelasi scroll orizontal, nu un
// tabel/date duplicate. Spacer-ul din interiorul ei nu are continut vizibil, doar aceeasi latime
// reala scrollabila ca tabelul (table.scrollWidth), ca sa produca un scrollbar cu proportii
// identice cu cel de jos — actualizata la incarcare, la redimensionarea ferestrei, SI la orice
// schimbare a latimii tabelului insusi (filtrare/paginare/continut nou, via ResizeObserver).
// ==========================================================================================
const topScrollEl = document.getElementById('orders-table-scroll-top');
const topScrollSpacer = document.getElementById('orders-table-scroll-top-spacer');
const bottomScrollEl = document.getElementById('orders-table-scroll');
const ordersTableEl = document.getElementById('orders-table');

function syncTopScrollbarWidth() {
  topScrollSpacer.style.width = ordersTableEl.scrollWidth + 'px';
}

// Flag simplu impotriva unei bucle infinite: scroll pe A -> seteaza scrollLeft pe B -> ar
// declansa evenimentul "scroll" al lui B -> ar seta din nou scrollLeft pe A ... etc.
let syncingTableScroll = false;
topScrollEl.addEventListener('scroll', () => {
  if (syncingTableScroll) return;
  syncingTableScroll = true;
  bottomScrollEl.scrollLeft = topScrollEl.scrollLeft;
  syncingTableScroll = false;
});
bottomScrollEl.addEventListener('scroll', () => {
  if (syncingTableScroll) return;
  syncingTableScroll = true;
  topScrollEl.scrollLeft = bottomScrollEl.scrollLeft;
  syncingTableScroll = false;
});

window.addEventListener('resize', syncTopScrollbarWidth);
// Prinde schimbari de latime cauzate STRICT de continut (filtrare/paginare/randuri noi cu text
// mai lung/scurt), independent de redimensionarea ferestrei — ResizeObserver e larg suportat in
// toate browserele moderne folosite in Admin; fara el (foarte vechi), bara de sus tot functioneaza
// corect la incarcare/resize, doar nu s-ar auto-recalibra STRICT la schimbari de continut.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(syncTopScrollbarWidth).observe(ordersTableEl);
}

// dateTo trimis catre server e ULTIMA ZI INCLUSA (server.js o transforma in capat exclusiv) —
// bounds.endDateExclusive vine deja exclusiv din funnel-summary, deci scadem o zi aici.
function applyPeriodSyncToOrdersFilter() {
  if (!lastResolvedBounds) return;
  state.dateFrom = lastResolvedBounds.startDate;
  state.dateTo = addDaysLocal(lastResolvedBounds.endDateExclusive, -1);
  state.offset = 0;
  loadOrders();
}

syncPeriodCheckbox.addEventListener('change', () => {
  if (syncPeriodCheckbox.checked) {
    applyPeriodSyncToOrdersFilter();
    // CORECTIE (2026-09-25, audit discrepanta KPI vs tabel — cauza demonstrata: KPI cards se
    // reimprospateaza STRICT la navigarea Period Selector-ului (refreshAll), niciodata la
    // schimbarea filtrelor tabelului — un card "Comenzi plătite" putea ramane "inghetat" de la
    // ultima incarcare a paginii, in timp ce tabelul (interogare noua, la fiecare schimbare de
    // filtru) reflecta deja o plata sosita intre timp. Reimprospatam explicit si KPI-urile aici,
    // ca cele doua sa nu poata diverge vizual exact in momentul in care Adminul activeaza
    // "Restrange la perioada" ca sa compare tabelul cu KPI-urile de mai sus.
    loadFunnelSummary();
  } else {
    state.dateFrom = null;
    state.dateTo = null;
    state.offset = 0;
    loadOrders();
  }
});

async function loadFilterOptions() {
  try {
    const res = await fetch('/api/admin/orders/filter-options');
    const data = await res.json();
    sourceFilter.innerHTML = '<option value="">Toate sursele</option>' + (data.sources || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    campaignFilter.innerHTML = '<option value="">Toate campaniile</option>' + (data.campaigns || []).map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  } catch (err) { /* dropdown-urile raman cu optiunea implicita — filtrarea propriu-zisa tot functioneaza */ }
}

function buildQuery() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.offset });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  if (state.paid) params.set('paid', state.paid);
  if (state.utmSource) params.set('utmSource', state.utmSource);
  if (state.utmCampaign) params.set('utmCampaign', state.utmCampaign);
  if (state.testFilter) params.set('testFilter', state.testFilter);
  if (state.dateFrom) params.set('dateFrom', state.dateFrom);
  if (state.dateTo) params.set('dateTo', state.dateTo);
  return params.toString();
}

// CORECȚIE (2026-09-25, investigatie separata — "Retry Extras" fals-pozitiv pe comenzi Video):
// gasit prin audit read-only pe productie — 13/20 comenzi Video cu "Retry Extras" afisat aveau
// deja un videoclip COMPLET (videoKey + videoPreviewKey), 5/20 nici macar nu ajunsesera la
// confirmarea materialelor (video niciodata cerut) — butonul aparea generic, STRICT din
// plan+status, fara sa verifice vreo stare reala a video-ului. Risc real confirmat: backend-ul
// (POST .../retry-extras -> triggerVideoGeneration -> db.enqueueVideoRenderJob) NU verifica daca
// exista deja un videoclip complet inainte sa puna in coada un job nou — un admin care apasa
// butonul pe o comanda deja livrata ar fi declansat o re-randare reala, cu cost de compute.
//
// "Video are nevoie de retry" = media CONFIRMATA (altfel video nici n-a fost cerut vreodata —
// nimic de reincercat) SI varianta selectata NU are AMBELE chei (videoKey + videoPreviewKey) —
// daca ambele exista, video-ul e complet, punct. Extras-ul functie e SEPARATA de eligibilitatea
// de baza (status/paidAt) — se aplica STRICT peste ea, ca o restrangere suplimentara pentru
// "video", niciodata pentru "premium" (acolo, comportamentul ramane EXACT cel reparat anterior).
function isVideoRetryNeeded(order) {
  if (!order.mediaConfirmedAt) return false;
  const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);
  if (!variant) return false;
  return !(variant.videoKey && variant.videoPreviewKey);
}

// Actiuni contextuale per comanda — Retry Extras STRICT cand backend-ul chiar l-ar accepta
// (vezi guard-ul identic din POST .../retry-extras in server.js). 'preview_ready' e eligibil
// direct pentru "video" (randeaza INAINTE de plata, prin design), dar pentru restul planurilor
// (premium) DOAR daca order.paidAt e setat — altfel comanda pur si simplu nu a fost platita
// niciodata (a ajuns la preview_ready prima data, nu printr-o regenerare esuata dupa plata) si
// nu exista niciun extras de reincercat. Anonimizează mereu disponibila (backend-ul refuza
// singur cu 409 daca exista o operatie activa, mesajul e afisat direct adminului).
function getOrderRowActions(order) {
  const actions = [{ id: 'anonymize', label: 'Anonimizează', variant: 'btn-danger btn-small' }];
  const extrasEligible = (order.plan === 'premium' || order.plan === 'video') &&
    (order.status === 'ready' || (order.status === 'preview_ready' && (order.plan === 'video' || !!order.paidAt))) &&
    (order.plan !== 'video' || isVideoRetryNeeded(order));
  if (extrasEligible) {
    actions.push({ id: 'retry-extras', label: 'Retry Extras', variant: 'btn-secondary btn-small' });
  }
  return actions;
}

function renderSourceCell(o) {
  if (!o.utmSource && !o.utmCampaign) return '<span class="text-muted">—</span>';
  return `${escapeHtml(o.utmSource || '(unknown)')}${o.utmCampaign ? ' / ' + escapeHtml(o.utmCampaign) : ''}`;
}

function renderLocationCell(o) {
  return o.location ? escapeHtml(o.location) : '<span class="text-muted">—</span>';
}

// DIAGNOSTIC CLIENT COMPACT (2026-09-26, cerinta explicita, sectiunea 5) — STRICT date deja
// existente pe `o` (acelasi obiect primit de la GET /api/admin/orders, deja incarcat in
// ordersCache) — niciun fetch suplimentar, niciun eveniment inventat. previewReached foloseste
// STRICT statusul curent (irreversibil crescator: draft -> generating ->
// processing_provider_result -> preview_ready -> ready, sau generation_failed) — o comanda
// 'ready' a trecut necesarmente prin 'preview_ready', deci "preview gata" ramane adevarat si dupa.
// Nu expune NICIODATA accessToken/stripeSessionId/stripePaymentIntentId (date tehnice sensibile).
function getOrderDiagnosticItems(o) {
  const previewReached = o.status === 'preview_ready' || o.status === 'ready';
  const items = [
    { k: 'Status', v: statusLabel[o.status] || o.status },
    { k: 'Preview gata', v: previewReached ? 'Da' : 'Nu' },
    { k: 'Checkout creat', v: o.checkoutCreatedAt ? new Date(o.checkoutCreatedAt).toLocaleString('ro-RO') : 'Nu' },
    { k: 'Plătit', v: o.paidAt ? new Date(o.paidAt).toLocaleString('ro-RO') : 'Nu' },
    { k: 'Pachet', v: o.plan },
    { k: 'Preț', v: `£${o.price}` },
    { k: 'Sursă', v: (o.utmSource || o.utmCampaign) ? `${o.utmSource || '(unknown)'}${o.utmCampaign ? ' / ' + o.utmCampaign : ''}` : '—' },
    { k: 'Locație', v: o.location || '—' }
  ];
  if (o.error) items.push({ k: 'Eroare', v: o.error, err: true });
  return items;
}

function renderOrderDetailRow(o) {
  const items = getOrderDiagnosticItems(o);
  return `
    <tr class="order-detail-row" data-order-detail-for="${escapeHtml(o.id)}" style="display:none;">
      <td colspan="${TABLE_COLSPAN}">
        <div class="order-detail-grid">
          ${items.map((it) => `<div class="order-detail-item"><div class="k">${escapeHtml(it.k)}</div><div class="v${it.err ? ' err' : ''}">${escapeHtml(it.v)}</div></div>`).join('')}
        </div>
      </td>
    </tr>
  `;
}

// NR. CLIENT (2026-09-25, REFACUT server-side — vezi raportul catre user): numerotarea cronologica
// pe client distinct (lower(trim(email))) e acum calculata de server (db.getDistinctCustomerRanks,
// DENSE_RANK peste TOT setul filtrat — nu doar pagina curenta) si vine gata atasata pe fiecare
// comanda ca `o.clientNumber` (GET /api/admin/orders). Primul client din perioada/filtrele curente
// = 1, cel mai recent = numarul total de clienti distincti din acea perioada — corect INDIFERENT
// de paginare, spre deosebire de vechea implementare client-side (assignDistinctCustomerNumbers,
// eliminata — numerota STRICT pagina curenta, in ordine inversa).

// RECOVERY (2026-09-25, cerinta 9 — varianta minimala): `o.recovery` (GET /api/admin/orders) —
// STRICT ultima notificare (indiferent de tip) pentru aceasta comanda, sau null daca nu exista
// niciuna inca (normal, cat timp RECOVERY_EMAILS_ENABLED e oprit). Niciun istoric complet, niciun
// dashboard separat — un singur text compact, cu tooltip pentru detalii.
const RECOVERY_TYPE_LABEL = { preview_ready: 'Preview gata', preview_recovery: 'Reminder preview', checkout_recovery: 'Reminder checkout' };
const RECOVERY_STATUS_LABEL = {
  pending: 'în așteptare', sending: 'se trimite', sent: 'trimis',
  skipped_paid: 'sărit (plătit)', skipped_suppressed: 'sărit (suprimat)', skipped_unsubscribed: 'sărit (dezabonat)',
  skipped_test: 'sărit (test)', skipped_not_eligible: 'sărit (neeligibil)', skipped_cooldown: 'sărit (cooldown)',
  failed: 'eșuat', abandoned: 'abandonat'
};
function renderRecoveryCell(o) {
  if (!o.recovery) return '—';
  const typeLabel = RECOVERY_TYPE_LABEL[o.recovery.type] || o.recovery.type;
  const statusLabelText = RECOVERY_STATUS_LABEL[o.recovery.status] || o.recovery.status;
  const when = o.recovery.sentAt || o.recovery.createdAt;
  const whenStr = when ? new Date(when).toLocaleString('ro-RO') : '';
  return `<span title="${escapeHtml(whenStr)}">${escapeHtml(typeLabel)} · ${escapeHtml(statusLabelText)}</span>`;
}

// Nr. client -> "X (N)" (2026-09-26, cerinta explicita): X = rangul cronologic server-side peste
// setul filtrat curent (o.clientNumber, neschimbat); N = totalul LIFETIME real de comenzi al
// acelui client, INDIFERENT de pagina/perioada/filtrele curente (o.clientLifetimeOrderCount,
// server-side — vezi db.getLifetimeCustomerOrderCounts). Fara X (clientNumber null, teoretic
// imposibil in conditii normale) -> STRICT "—", niciun "(N)" orfan.
function renderClientNumberCell(o) {
  if (o.clientNumber == null) return '—';
  const n = o.clientLifetimeOrderCount != null ? o.clientLifetimeOrderCount : 1;
  return `${o.clientNumber} (${n})`;
}

function renderOrderRow(o) {
  const actions = getOrderRowActions(o);
  return `
    <tr data-order-id="${escapeHtml(o.id)}">
      <td>${o.orderNumber != null ? o.orderNumber : '—'}</td>
      <td>${renderClientNumberCell(o)}</td>
      <td>${new Date(o.createdAt).toLocaleString('ro-RO')}</td>
      <td>${escapeHtml(o.recipient)}</td>
      <td>${escapeHtml(o.email || '—')}${o.isTestOrder ? ' <span class="badge b-draft" title="Exclusa din KPI-urile de conversie (Dashboard)">TEST</span>' : ''}</td>
      <td>${(o.lang || 'ro').toUpperCase()}</td>
      <td>${escapeHtml(o.occasion)}</td>
      <td>${escapeHtml(o.genre)}</td>
      <td>${escapeHtml(o.plan)}</td>
      <td>£${o.price}</td>
      <td><span class="badge b-${o.status}">${statusLabel[o.status] || o.status}</span></td>
      <td>${renderSourceCell(o)}</td>
      <td>${renderLocationCell(o)}</td>
      <td>${renderRecoveryCell(o)}</td>
      <td>
        <div class="orders-row-actions">
          <button type="button" class="order-detail-toggle" data-order-detail-toggle="${escapeHtml(o.id)}">Detalii</button>
          ${actions.map(a => `<button type="button" class="${a.variant}" data-order-action="${a.id}">${a.label}</button>`).join('')}
        </div>
      </td>
    </tr>
    ${renderOrderDetailRow(o)}
  `;
}

function renderPagination(matchingCount) {
  const currentPage = Math.floor(state.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(matchingCount / PAGE_SIZE));
  const from = matchingCount === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + PAGE_SIZE, matchingCount);
  paginationInfo.textContent = `Afișez ${from}–${to} din ${matchingCount} · Pagina ${currentPage} din ${totalPages}`;
  prevBtn.disabled = state.offset === 0;
  nextBtn.disabled = state.offset + PAGE_SIZE >= matchingCount;
}

async function loadOrders() {
  ordersBody.innerHTML = `<tr><td colspan="${TABLE_COLSPAN}" class="empty">Se încarcă…</td></tr>`;
  try {
    const res = await fetch(`/api/admin/orders?${buildQuery()}`);
    const data = await res.json();
    ordersCache = data.orders || [];

    document.getElementById('stat-count').textContent = data.totalCount;
    document.getElementById('stat-revenue').textContent = '£' + data.revenue;

    if (ordersCache.length === 0) {
      ordersBody.innerHTML = `<tr><td colspan="${TABLE_COLSPAN}" class="empty">Nicio comandă găsită</td></tr>`;
    } else {
      ordersBody.innerHTML = ordersCache.map((o) => renderOrderRow(o)).join('');
    }
    renderPagination(data.matchingCount);
    syncTopScrollbarWidth();
  } catch (err) {
    ordersBody.innerHTML = `<tr><td colspan="${TABLE_COLSPAN}" class="empty">Eroare la încărcarea comenzilor.</td></tr>`;
    syncTopScrollbarWidth();
  }
}

// Debounce (300ms) — cautarea nu trimite o cerere la fiecare tasta apasata, ci abia dupa o
// scurta pauza in tastare.
let searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    state.offset = 0;
    loadOrders();
  }, 300);
});

statusFilter.addEventListener('change', () => { state.status = statusFilter.value; state.offset = 0; loadOrders(); });
// CORECTIE (2026-09-25, audit discrepanta KPI vs tabel — vezi raportul): filtrul "Doar plătite"
// e EXACT controlul pe care un Admin il foloseste ca sa compare tabelul cu cardul KPI "Comenzi
// plătite în perioadă" — reimprospatam si KPI-urile aici, din acelasi motiv ca la
// syncPeriodCheckbox mai sus, ca cele doua sa nu poata arata vreodata cifre dintr-un moment diferit.
paidFilter.addEventListener('change', () => { state.paid = paidFilter.value; state.offset = 0; loadOrders(); loadFunnelSummary(); });
sourceFilter.addEventListener('change', () => { state.utmSource = sourceFilter.value; state.offset = 0; loadOrders(); });
campaignFilter.addEventListener('change', () => { state.utmCampaign = campaignFilter.value; state.offset = 0; loadOrders(); });
testFilterEl.addEventListener('change', () => { state.testFilter = testFilterEl.value; state.offset = 0; loadOrders(); });

prevBtn.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadOrders();
});
nextBtn.addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  loadOrders();
});

async function handleAnonymize(orderId) {
  if (!confirm('Anonimizezi definitiv această comandă (cerere GDPR)? Șterge identitatea/contactul și toate materialele media. Acțiune IREVERSIBILĂ.')) return;
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/anonymize`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Nu am putut anonimiza comanda.'); return; }
    alert(`Comandă anonimizată. Fișiere șterse: ${data.filesDeleted}/${data.filesTotal}.`);
    loadOrders();
  } catch (err) {
    alert('Eroare de conexiune.');
  }
}

async function handleRetryExtras(orderId) {
  if (!confirm('Reîncerci generarea extraselor (WAV/video) pentru această comandă?')) return;
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/retry-extras`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Nu am putut reîncerca generarea.'); return; }
    alert(`Reîncercare finalizată — WAV: ${data.hasWav ? 'da' : 'nu'}, Video: ${data.hasVideo ? 'da' : 'nu'}${data.videoFailedReason ? ` (eroare video: ${data.videoFailedReason})` : ''}.`);
    loadOrders();
  } catch (err) {
    alert('Eroare de conexiune.');
  }
}

ordersBody.addEventListener('click', (e) => {
  const detailToggle = e.target.closest('[data-order-detail-toggle]');
  if (detailToggle) {
    const orderId = detailToggle.dataset.orderDetailToggle;
    const detailRow = ordersBody.querySelector(`[data-order-detail-for="${CSS.escape(orderId)}"]`);
    if (detailRow) detailRow.style.display = detailRow.style.display === 'none' ? '' : 'none';
    return;
  }
  const btn = e.target.closest('[data-order-action]');
  if (!btn) return;
  const orderId = btn.closest('[data-order-id]').dataset.orderId;
  const action = btn.dataset.orderAction;
  if (action === 'anonymize') handleAnonymize(orderId);
  else if (action === 'retry-extras') handleRetryExtras(orderId);
});

// ==========================================================================================
// INIT
// ==========================================================================================
function refreshAll() {
  loadFunnelSummary();
}

updatePeriodLabel();
loadFilterOptions();
refreshAll();
loadOrders();

// ==========================================================================================
// AUTO-REFRESH (2026-09-25, elimina riscul ramas de staleness — vezi raportul catre user:
// cardurile KPI se puteau "ingheta" la ultima incarcare/navigare de perioada, in timp ce o plata
// noua sosea intre timp; fixul anterior a acoperit STRICT schimbarea filtrelor tabelului
// (paidFilter/syncPeriodCheckbox) — asta ramane insuficient daca admin-ul lasa pagina deschisa,
// fara sa atinga niciun filtru). Tick periodic, silentios: reimprospateaza KPI/funnel-ul SI
// tabelul, fara sa resetezi cautarea/filtrele/pagina/pozitia de scroll a admin-ului — vezi
// loadFunnelSummary({silent:true}) mai sus (sare peste applyPeriodSyncToOrdersFilter, care altfel
// ar reseta state.offset la 0 la fiecare tick) si loadOrders() (foloseste STRICT `state` curent,
// neschimbat, niciun reset).
// ==========================================================================================
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000; // "rezonabil", cerinta explicita — 60s
let autoRefreshTimer = null;
let lastAutoRefreshAt = Date.now(); // init la pornire — pagina tocmai a incarcat date proaspete

async function autoRefreshTick() {
  // Pagina ascunsa (alt tab/fereastra minimizata) — ZERO cereri catre server, niciun risc de
  // request-uri excesive pentru file ramase deschise, uitate, in fundal (Page Visibility API,
  // suport universal in browserele moderne).
  if (typeof document !== 'undefined' && document.hidden) return;
  lastAutoRefreshAt = Date.now();
  // Cele doua reimprospatari sunt independente (fiecare cu propriul try/catch intern) — un esec
  // al uneia (retea/server) nu trebuie sa il opreasca pe celalalt si NICIODATA nu trebuie sa
  // arunce mai departe (pagina ramane exact cum era, niciodata stricata de un tick de fundal).
  await loadFunnelSummary({ silent: true });
  try {
    await loadOrders();
  } catch (err) {
    console.error('Eroare la reimprospatarea de fundal a tabelului de comenzi:', err);
  }
}

// Garda impotriva unui interval DUBLAT (ex. daca acest bloc ar rula de doua ori din greseala la
// reincarcare/reinitializare) — o a doua chemare e un no-op sigur, niciodata un al doilea timer
// concurent care ar dubla frecventa reala a request-urilor.
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS);
}
startAutoRefresh();

// Revenirea in prim-plan dupa ce tab-ul a stat ascuns mai mult decat intervalul normal —
// reimprospatare imediata (admin-ul nu trebuie sa astepte pana la 60s aditionale dupa ce a
// revenit), dar STRICT daca a trecut deja cel putin un interval intreg de la ultima
// reimprospatare reala — altfel un comutator rapid intre tab-uri nu declanseaza cereri suplimentare
// (nu dubleaza tick-ul periodic normal, care oricum va rula la timpul lui).
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (Date.now() - lastAutoRefreshAt) >= AUTO_REFRESH_INTERVAL_MS) {
      autoRefreshTick();
    }
  });
}
