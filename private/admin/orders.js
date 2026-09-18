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
const today = new Date();
let periodState = { type: 'month', year: today.getFullYear(), month: today.getMonth() + 1, anchorDate: toDateStr(today), date: toDateStr(today), startDate: addDaysLocal(toDateStr(today), -6), endDate: toDateStr(today) };
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
const KPI_DEFS = [
  { key: 'trackedVisitors', label: 'Vizitatori urmăriți' },
  { key: 'ctaClicks', label: 'Click-uri CTA' },
  { key: 'formStarted', label: 'Formular început' },
  { key: 'ordersCreated', label: 'Comenzi create' },
  { key: 'reachedCheckout', label: 'Checkout atins' },
  { key: 'paidOrders', label: 'Comenzi plătite' },
  { key: 'paidCustomers', label: 'Clienți plătitori' },
  { key: 'revenue', label: 'Venit', money: true }
];

function renderKpiCards(kpis) {
  const el = document.getElementById('kpi-cards');
  el.innerHTML = KPI_DEFS.map((d) => `
    <div class="stat">
      <div class="label">${d.label}</div>
      <div class="value">${d.money ? '£' + Number(kpis[d.key]).toFixed(2) : Number(kpis[d.key])}</div>
    </div>
  `).join('');
}

function pct(v) { return v === null || v === undefined ? 'N/A' : `${v.toFixed(1)}%`; }

function renderFunnel(stages) {
  const el = document.getElementById('funnel-chart');
  const maxCount = stages.length ? Math.max(1, ...stages.map((s) => s.count)) : 1;
  el.innerHTML = stages.map((s) => `
    <div class="funnel-row">
      <div class="funnel-row-label">${escapeHtml(s.label)}</div>
      <div class="funnel-row-bar-wrap">
        <div class="funnel-row-bar" style="width:${Math.max(2, (s.count / maxCount) * 100)}%"></div>
      </div>
      <div class="funnel-row-count">${s.count}</div>
      <div class="funnel-row-meta">
        <span title="Conversie față de etapa anterioară">${pct(s.conversionFromPrevPct)}</span>
        <span class="funnel-row-dropoff" title="Pierdere față de etapa anterioară">${s.dropOffCount === null ? '' : `−${s.dropOffCount} (${pct(s.dropOffPct)})`}</span>
      </div>
    </div>
  `).join('');
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

async function loadFunnelSummary() {
  try {
    const res = await fetch(`/api/admin/orders/funnel-summary?${buildPeriodParams()}`);
    const data = await res.json();
    if (!res.ok) { console.error('funnel-summary error:', data.error); return; }
    lastResolvedBounds = data.period;
    renderKpiCards(data.kpis);
    renderFunnel(data.funnel);
    renderTrend(data.trend);
    renderSources(data.sources);
    renderDataCompleteBanner(data.dataCompleteSince);
    if (syncPeriodCheckbox.checked) applyPeriodSyncToOrdersFilter();
  } catch (err) {
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

// Actiuni contextuale per comanda — Retry Extras STRICT cand backend-ul chiar l-ar accepta
// (plan platit cu extrase, status ready/preview_ready — vezi POST .../retry-extras in
// server.js), Anonimizează mereu disponibila (backend-ul refuza singur cu 409 daca exista o
// operatie activa, mesajul e afisat direct adminului).
function getOrderRowActions(order) {
  const actions = [{ id: 'anonymize', label: 'Anonimizează', variant: 'btn-danger btn-small' }];
  if ((order.plan === 'premium' || order.plan === 'video') && (order.status === 'ready' || order.status === 'preview_ready')) {
    actions.push({ id: 'retry-extras', label: 'Retry Extras', variant: 'btn-secondary btn-small' });
  }
  return actions;
}

// Compactare tabel Comenzi (2026-09-18) — sursa (utm_source/utm_campaign) e afisata trunchiata
// pe ecran ingust in coloana ei (vezi shared.css, td.col-source) — textul COMPLET ramane
// accesibil oricand prin atributul title (tooltip nativ), niciodata ascuns definitiv.
function renderSourceCell(o) {
  if (!o.utmSource && !o.utmCampaign) return '<span class="text-muted">—</span>';
  const full = `${o.utmSource || '(unknown)'}${o.utmCampaign ? ' / ' + o.utmCampaign : ''}`;
  return `<span title="${escapeHtml(full)}">${escapeHtml(full)}</span>`;
}

// Data pe doua randuri (zi + ora, fara secunde) — vezi shared.css, .order-date-time — reduce
// substantial latimea naturala a coloanei fata de un singur string lung
// ("18.09.2026, 14:32:07"), fara sa piarda informatie utila pentru o lista (secundele nu ajuta
// la scanare rapida; data/ora completa ramane oricum in log-urile/evenimentele comenzii).
function renderDateCell(createdAt) {
  const d = new Date(createdAt);
  const dateStr = d.toLocaleDateString('ro-RO');
  const timeStr = d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  return `${escapeHtml(dateStr)}<span class="order-date-time">${escapeHtml(timeStr)}</span>`;
}

function renderOrderRow(o) {
  const actions = getOrderRowActions(o);
  return `
    <tr data-order-id="${escapeHtml(o.id)}">
      <td class="col-date">${renderDateCell(o.createdAt)}</td>
      <td class="col-recipient" title="${escapeHtml(o.recipient)}">${escapeHtml(o.recipient)}</td>
      <td class="col-email"><span class="cell-truncate" title="${escapeHtml(o.email || '')}">${escapeHtml(o.email || '—')}</span>${o.isTestOrder ? ' <span class="badge b-draft" title="Exclusa din KPI-urile de conversie (Dashboard)">TEST</span>' : ''}</td>
      <td class="col-lang">${(o.lang || 'ro').toUpperCase()}</td>
      <td class="col-occasion">${escapeHtml(o.occasion)}</td>
      <td class="col-genre">${escapeHtml(o.genre)}</td>
      <td class="col-plan">${escapeHtml(o.plan)}</td>
      <td class="col-price">£${o.price}</td>
      <td class="col-status"><span class="badge b-${o.status}">${statusLabel[o.status] || o.status}</span></td>
      <td class="col-source">${renderSourceCell(o)}</td>
      <td class="col-actions">
        <div class="orders-row-actions">
          ${actions.map(a => `<button type="button" class="${a.variant}" data-order-action="${a.id}">${a.label}</button>`).join('')}
        </div>
      </td>
    </tr>
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
  ordersBody.innerHTML = '<tr><td colspan="11" class="empty">Se încarcă…</td></tr>';
  try {
    const res = await fetch(`/api/admin/orders?${buildQuery()}`);
    const data = await res.json();
    ordersCache = data.orders || [];

    document.getElementById('stat-count').textContent = data.totalCount;
    document.getElementById('stat-revenue').textContent = '£' + data.revenue;

    if (ordersCache.length === 0) {
      ordersBody.innerHTML = '<tr><td colspan="11" class="empty">Nicio comandă găsită</td></tr>';
    } else {
      ordersBody.innerHTML = ordersCache.map(renderOrderRow).join('');
    }
    renderPagination(data.matchingCount);
  } catch (err) {
    ordersBody.innerHTML = '<tr><td colspan="11" class="empty">Eroare la încărcarea comenzilor.</td></tr>';
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
paidFilter.addEventListener('change', () => { state.paid = paidFilter.value; state.offset = 0; loadOrders(); });
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
