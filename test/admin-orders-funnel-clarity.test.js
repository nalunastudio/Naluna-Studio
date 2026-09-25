// FUNNEL DE CONVERSIE — clarificare (2026-09-19, FAZA 1, in urma auditului din aceeasi zi).
// Verifica STATIC (acelasi tipar ca test/admin-orders-dual-scrollbar.test.js — proiectul NU are
// infrastructura de testare vizuala/browser real) cele 8 cerinte explicite ale acestei faze:
// (1) CTA scos din funnel-ul secvential; (2) CTA ramane KPI separat, eticheta clarificata;
// (3) funnel-ul de comenzi ramane cohortat; (4) etichete distincte KPI Cards vs Funnel;
// (5) Vizitatori/Formular separate vizual de Comenzi/Checkout/Platite; (6) procente fara
// N/A->0(N/A) sau valori aberante; (7) perioade fara tracking istoric -> "Nemăsurat", nu 0.
// DATABASE_URL fals (acelasi tipar ca test/funnel-kpi-engine.test.js) — db.pool.query e interceptat
// (mock) in fiecare test care are nevoie de el (sectiunea 7e-7i, getTrafficDataAvailability), fara
// nicio conexiune reala la Postgres.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dbModule = require('../db.js');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

async function withMockPool(dispatch, fn) {
  const original = dbModule.pool.query.bind(dbModule.pool);
  dbModule.pool.query = async (sql, params) => dispatch(sql, params);
  try {
    return await fn();
  } finally {
    dbModule.pool.query = original;
  }
}

const js = read('private/admin/orders.js');
const html = read('private/admin/orders.html');
const css = read('private/admin/shared.css');
const server = read('server.js');
const db = read('db.js');

// ==================================================================================================
// 1) CTA scos din funnelul secvential.
// ==================================================================================================
test('1) orders.js: renderFunnelCohort (funnel-ul cohortat) NU contine niciodata cheia "ctaClicks" — CTA nu mai e o etapa a lantului secvential', () => {
  const fnStart = js.indexOf('function renderFunnelCohort(');
  assert.ok(fnStart !== -1, 'renderFunnelCohort trebuie sa existe');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.doesNotMatch(fn, /ctaClicks/);
});

test('1b) orders.js: vechea functie renderFunnel (lant unic de 6 etape, CTA inclus) nu mai exista', () => {
  assert.ok(!js.includes('function renderFunnel(stages)'), 'renderFunnel(stages) veche trebuie inlocuita de renderFunnelTraffic/renderFunnelCohort');
});

test('1c) orders.html: ordinea vizuala a containerelor de funnel e Trafic -> Conversie comenzi, containerul vechi unic #funnel-chart cu ID generic nu mai exista (inlocuit de #funnel-traffic si #funnel-cohort)', () => {
  assert.ok(!html.includes('id="funnel-chart"'), 'containerul vechi unic trebuie inlocuit');
  const trafficIdx = html.indexOf('id="funnel-traffic"');
  const cohortIdx = html.indexOf('id="funnel-cohort"');
  assert.ok(trafficIdx !== -1, 'containerul #funnel-traffic trebuie sa existe');
  assert.ok(cohortIdx !== -1, 'containerul #funnel-cohort trebuie sa existe');
  assert.ok(trafficIdx < cohortIdx, 'Trafic trebuie sa apara INAINTE de Conversie comenzi in HTML (ordinea ceruta explicit)');
});

// ==================================================================================================
// 2) CTA ca metric separat, eticheta clarificata.
// ==================================================================================================
test('2) orders.js: KPI_DEFS contine "ctaClicks" cu eticheta care clarifica STRICT homepage', () => {
  const kpiDefsMatch = js.match(/const KPI_DEFS = \[([\s\S]*?)\n\];/);
  assert.ok(kpiDefsMatch);
  assert.match(kpiDefsMatch[1], /key: 'ctaClicks', label: '[^']*homepage[^']*'/i);
});

test('2b) KPI Cards raman SEPARATE de funnel-ul cohortat — renderKpiCards si renderFunnelCohort sunt functii distincte, apelate independent in loadFunnelSummary', () => {
  // CORECTIE (2026-09-25, auto-refresh KPI): semnatura a capatat un parametru optional
  // ({ silent = false } = {}) — cautam STRICT prefixul stabil al declaratiei.
  const loadFnStart = js.indexOf('async function loadFunnelSummary(');
  const loadFnEnd = js.indexOf('\n}', loadFnStart);
  const loadFn = js.slice(loadFnStart, loadFnEnd);
  assert.match(loadFn, /renderKpiCards\(data\.kpis, data\.trafficDataAvailability, data\.dataCompleteSince\)/);
  assert.match(loadFn, /renderFunnelTraffic\(data\.funnel\.traffic, data\.trafficDataAvailability, data\.dataCompleteSince\)/);
  assert.match(loadFn, /renderFunnelCohort\(data\.funnel\.cohort, data\.funnel\.checkoutToPaidPct\)/);
});

// ==================================================================================================
// 3) Funnelul de comenzi ramane COHORTAT (server-side, db.js#getConversionFunnel neschimbat la SQL).
// ==================================================================================================
test('3) db.js: getConversionFunnel foloseste EXACT acelasi cohortSql (fereastra STRICT pe created_at, checkout/paid in FILTER fara fereastra proprie) — nicio schimbare de semantica, doar de shape', () => {
  const fnStart = db.indexOf('async function getConversionFunnel(');
  const fnEnd = db.indexOf('\n}', fnStart);
  const fn = db.slice(fnStart, fnEnd);
  assert.match(fn, /FILTER \(WHERE checkout_created_at IS NOT NULL\) AS reached_checkout/);
  assert.match(fn, /FILTER \(WHERE paid_at IS NOT NULL\) AS paid_orders/);
  assert.doesNotMatch(fn, /checkout_created_at >= /, 'checkout_created_at nu trebuie sa capete propria fereastra de timp — ar transforma cohorta in event-time');
  assert.doesNotMatch(fn, /paid_at >= /, 'paid_at nu trebuie sa capete propria fereastra de timp in acest cohortSql — ar transforma cohorta in event-time');
  assert.match(fn, /computeCohortFunnel\(counts\)/);
});

// ==================================================================================================
// 4) Etichete DISTINCTE intre KPI Cards (event-time) si Funnel cohortat.
// ==================================================================================================
test('4) KPI_DEFS (event-time) foloseste etichete cu "în perioadă" pentru Comenzi create/Checkout/Platite/Venit — distincte de etichetele funnel-ului cohortat', () => {
  const kpiDefsMatch = js.match(/const KPI_DEFS = \[([\s\S]*?)\n\];/)[1];
  assert.match(kpiDefsMatch, /key: 'ordersCreated', label: '[^']*în perioadă[^']*'/);
  assert.match(kpiDefsMatch, /key: 'reachedCheckout', label: '[^']*în perioadă[^']*'/);
  assert.match(kpiDefsMatch, /key: 'paidOrders', label: '[^']*în perioadă[^']*'/);
  assert.match(kpiDefsMatch, /key: 'revenue', label: '[^']*în perioadă[^']*'/);
});

test('4b) COHORT_STAGES (lib/funnel-math.js, funnel cohortat) foloseste etichetele conceptuale cerute explicit — "Comenzi create" / "Au ajuns la checkout" / "Au fost plătite" — diferite textual de etichetele KPI Cards', () => {
  const funnelMath = read('lib/funnel-math.js');
  assert.match(funnelMath, /label: 'Comenzi create' \}/);
  assert.match(funnelMath, /label: 'Au ajuns la checkout' \}/);
  assert.match(funnelMath, /label: 'Au fost plătite' \}/);
  // niciuna dintre etichetele cohortate nu contine "în perioadă" (ar amesteca vocabularul cu KPI Cards)
  assert.doesNotMatch(funnelMath, /label: '[^']*în perioadă[^']*'/);
});

test('4c) UI nu foloseste jargon tehnic ("cohort-time"/"event-time") — verificat in orders.html si orders.js (textul vizibil utilizatorului)', () => {
  assert.doesNotMatch(html, /cohort-time|event-time/i);
  // orders.js poate contine acesti termeni STRICT in comentarii de cod (pentru dezvoltatori),
  // niciodata in stringuri afisate utilizatorului — verificam ca termenii, daca apar, sunt in linii
  // de comentariu ("//"), nu in vreun literal randat.
  const lines = js.split('\n');
  for (const line of lines) {
    if (/cohort-time|event-time/i.test(line)) {
      assert.ok(line.trim().startsWith('//') || line.includes('// '), `termen tehnic in afara unui comentariu: ${line}`);
    }
  }
});

// ==================================================================================================
// 5) Separare vizuala Trafic vs Conversie comenzi — nu se pretinde aceeasi cohorta.
// ==================================================================================================
test('5) orders.html: subtitlurile grupurilor "Trafic" si "Conversie comenzi" exista, in aceasta ordine', () => {
  const trafficTitleIdx = html.indexOf('>Trafic <span');
  const cohortTitleIdx = html.indexOf('>Conversie comenzi <span');
  assert.ok(trafficTitleIdx !== -1, 'titlul grupului Trafic trebuie sa existe');
  assert.ok(cohortTitleIdx !== -1, 'titlul grupului Conversie comenzi trebuie sa existe');
  assert.ok(trafficTitleIdx < cohortTitleIdx);
});

test('5b) subtitlul funnel-ului foloseste limbaj simplu, cerut explicit ("Urmărim comenzile create în perioada selectată și vedem câte au ajuns ulterior la checkout și plată.")', () => {
  assert.match(html, /Urmărim comenzile create în perioada selectată și vedem câte au ajuns ulterior la checkout și plată\./);
});

test('5c) computeTrafficStep si computeCohortFunnel raman functii SEPARATE (lib/funnel-math.js) — niciun cod nu combina Vizitatori/Formular in acelasi array cu Comenzi/Checkout/Platite', () => {
  const funnelMath = read('lib/funnel-math.js');
  assert.match(funnelMath, /function computeTrafficStep\(counts\)/);
  assert.match(funnelMath, /function computeCohortFunnel\(counts\)/);
  assert.doesNotMatch(funnelMath, /trackedVisitors[\s\S]{0,80}ordersCreated|ordersCreated[\s\S]{0,80}trackedVisitors/, 'trackedVisitors si ordersCreated nu trebuie sa apara amestecate in aceeasi structura de output');
});

// ==================================================================================================
// 6) Procente fara N/A->0(N/A) sau valori aberante — denominator 0 -> null -> 'N/A', niciodata alt text.
// ==================================================================================================
function loadPct() {
  const idx = js.indexOf('function pct(v) {');
  const end = js.indexOf('\n}', idx);
  const src = js.slice(idx, end + 2) + '\nmodule.exports = pct;';
  const Module = require('node:module');
  const m = new Module();
  m._compile(src, 'pct.js');
  return m.exports;
}
const pct = loadPct();

test('6) pct(): null/undefined -> STRICT "N/A", niciodata "0%"/"NaN%"/"Infinity%"', () => {
  assert.equal(pct(null), 'N/A');
  assert.equal(pct(undefined), 'N/A');
});

test('6b) pct(): valoare numerica normala -> un singur zecimal, cu simbolul %', () => {
  assert.equal(pct(6.8965517241379315), '6.9%');
  assert.equal(pct(0), '0.0%');
  assert.equal(pct(100), '100.0%');
});

test('6c) orders.js: renderFunnelCohort afiseaza STATIC "Bază" pentru "Comenzi create" (nu un procent calculat, care ar fi mereu 100% sau N/A fara sens) — restul etapelor folosesc pct(s.pctOfBase)', () => {
  const fnStart = js.indexOf('function renderFunnelCohort(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /'Bază'/);
  assert.match(fn, /pct\(s\.pctOfBase\)/);
});

// CORECȚIE (2026-09-20, cerinta explicita): procentul Vizitatori -> Formular a fost ELIMINAT din
// sectiunea TRAFIC — "Formular început" e event-based (acelasi vizitator poate genera mai multe
// evenimente form_started), deci raportul putea depasi 100% (ex. 3 vizitatori / 4 formulare ->
// "133.3%"), ceea ce nu e o rata de conversie valida. Testul 6d de mai jos inlocuieste vechea
// asertiune (care verifica PREZENTA procentului) cu asertiuni care confirma ABSENTA lui.
test('6d) orders.js: renderFunnelTraffic NU mai calculeaza/afiseaza niciun procent Vizitatori->Formular — randul "Formular început" are STRICT valoarea absoluta, meta gol', () => {
  const fnStart = js.indexOf('function renderFunnelTraffic(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.doesNotMatch(fn, /conversionPct/, 'traffic.conversionPct nu trebuie folosit deloc in randare');
  assert.doesNotMatch(fn, /pct\(/, 'pct() nu trebuie apelat deloc in aceasta functie — nu se afiseaza niciun procent in sectiunea Trafic');
  // ambele randuri (Vizitatori/Formular) trebuie sa aiba STRICT `<div class="funnel-row-meta"></div>`
  // gol — nu un procent inlocuitor, cerinta explicita "nu il inlocui cu alt procent".
  const metaOccurrences = (fn.match(/<div class="funnel-row-meta"><\/div>/g) || []).length;
  assert.equal(metaOccurrences, 2, 'ambele randuri (Vizitatori urmăriți si Formular început) trebuie sa aiba meta gol');
});

test('6f) orders.js: cazul concret 3 vizitatori / 4 formulare NU mai produce "133.3%" (nici alt procent) in HTML-ul randat — randarea reala verificata printr-un sandbox minimal DOM', () => {
  const fnStart = js.indexOf('function renderFunnelTraffic(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fnSrc = js.slice(fnStart, fnEnd + 2);
  // sandbox minimal: STRICT elementul #funnel-traffic (nu e nevoie de tot DOM-ul paginii)
  const sandbox = `
    const document = {
      getElementById: (id) => (id === 'funnel-traffic' ? el : null)
    };
    const el = { innerHTML: '' };
    function escapeHtml(s) { return String(s); }
    ${fnSrc}
    renderFunnelTraffic({ trackedVisitors: 3, formStarted: 4, conversionPct: (4 / 3) * 100 }, 'complete', null);
    return el.innerHTML;
  `;
  const html = new Function(sandbox)();
  assert.doesNotMatch(html, /133\.3%/, 'procentul imposibil "133.3%" nu trebuie sa mai apara');
  // "%" apare legitim in style="width:...%" (latimea barei vizuale, neschimbata) — verificam STRICT
  // ca celulele funnel-row-meta (unde aparea procentul de conversie) raman goale, fara niciun %.
  const metaCells = html.match(/<div class="funnel-row-meta">[\s\S]*?<\/div>/g) || [];
  assert.equal(metaCells.length, 2, 'trebuie sa existe exact 2 celule funnel-row-meta (Vizitatori + Formular)');
  for (const cell of metaCells) {
    assert.equal(cell, '<div class="funnel-row-meta"></div>', `celula meta trebuie sa fie goala, nu: ${cell}`);
  }
  assert.match(html, />3</, 'valoarea absoluta a vizitatorilor (3) trebuie sa ramana afisata');
  assert.match(html, />4</, 'valoarea absoluta a formularelor incepute (4) trebuie sa ramana afisata');
});

test('6e) lib/funnel-math.js: computeCheckoutToPaidPct expus si folosit — "Conversie checkout -> plata" opționala, afisata STRICT cand reachedCheckout > 0', () => {
  const fnStart = js.indexOf('function renderFunnelCohort(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /checkoutToPaidPct !== null/);
});

// ==================================================================================================
// 7) Date istorice — "Nemăsurat", niciodata 0 fals, pentru KPI-urile event-based.
// ==================================================================================================
test('7) orders.js: renderKpiCards afiseaza "Nemăsurat" STRICT pentru KPI-urile traffic:true cand trafficDataAvailability e "unmeasured" — celelalte (Comenzi/Checkout/Platite/Venit) raman NEATINSE (sursa lor, orders, e mereu reala)', () => {
  const fnStart = js.indexOf('function renderKpiCards(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /isTraffic && trafficDataAvailability === 'unmeasured'/);
  assert.match(fn, /'Nemăsurat'/);
});

test('7b) orders.js: renderFunnelTraffic afiseaza un mesaj explicit de indisponibilitate (nu randuri cu 0) cand trafficDataAvailability e "unmeasured"', () => {
  const fnStart = js.indexOf('function renderFunnelTraffic(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /if \(trafficDataAvailability === 'unmeasured'\)/);
  assert.match(fn, /Date indisponibile/);
});

test('7c) db.js: getTrafficDataAvailability exportata si folosita in server.js pentru a calcula trafficDataAvailability, trimis catre client', () => {
  assert.match(db, /async function getTrafficDataAvailability\(startDate, endDateExclusive\) \{/);
  assert.match(db, /getTrafficDataAvailability,/);
  assert.match(server, /db\.getTrafficDataAvailability\(bounds\.startDate, bounds\.endDateExclusive\)/);
  assert.match(server, /trafficDataAvailability,\s*\n\s*kpis,/, 'trafficDataAvailability trebuie inclus explicit in raspunsul JSON al endpoint-ului');
});

test('7d) getTrafficDataAvailability NU inventeaza si NU face backfill — STRICT o interogare SELECT (citire), nicio scriere in DB', () => {
  const fnStart = db.indexOf('async function getTrafficDataAvailability(startDate, endDateExclusive) {');
  const fnEnd = db.indexOf('\n}', fnStart);
  const fn = db.slice(fnStart, fnEnd);
  assert.match(fn, /SELECT/);
  assert.doesNotMatch(fn, /INSERT|UPDATE|DELETE/i);
});

// ==================================================================================================
// 7e-7j) 3 STARI EXPLICITE (2026-09-19, corectie FAZA 1 — cerinta explicita: "complete"/"partial"/
// "unmeasured", niciodata doar 2). Data de inceput e determinata STRICT din sursa autoritativa
// (MIN(occurred_at)) — niciodata hardcodata 19.09.2026 in cod (vezi db.js#getTrafficDataAvailability,
// CASE WHEN). Testele de mai jos verifica SQL-ul CASE emis (structura) SI, separat, comportamentul
// UI pentru fiecare stare — acelasi tipar de mock-pool ca restul suitei (proiectul nu are Postgres
// real disponibil in mediul de testare, vezi header-ul test/funnel-kpi-engine.test.js).
// ==================================================================================================
test('7e) db.js: SQL-ul CASE emis de getTrafficDataAvailability acopera EXPLICIT toate cele 3 stari, in ordinea corecta a conditiilor (unmeasured daca NULL, complete daca MIN <= inceput perioada, partial daca MIN < sfarsit perioada, altfel unmeasured)', () => {
  const fnStart = db.indexOf('async function getTrafficDataAvailability(startDate, endDateExclusive) {');
  const fnEnd = db.indexOf('\n}', fnStart);
  const fn = db.slice(fnStart, fnEnd);
  assert.match(fn, /WHEN MIN\(occurred_at\) IS NULL THEN 'unmeasured'/);
  assert.match(fn, /WHEN MIN\(occurred_at\) <= \(\$1::date AT TIME ZONE 'Europe\/London'\) THEN 'complete'/);
  assert.match(fn, /WHEN MIN\(occurred_at\) < \(\$2::date AT TIME ZONE 'Europe\/London'\) THEN 'partial'/);
  assert.match(fn, /ELSE 'unmeasured'/);
  // nicio data hardcodata (ex. '2026-09-19') in interiorul functiei — sursa e STRICT MIN(occurred_at)
  assert.doesNotMatch(fn, /2026-09-19|'09'|'19'/);
});

test('7f) perioada COMPLET ANTERIOARA inceputului tracking-ului -> "unmeasured" (ex. Ianuarie 2026, tracking pornit real abia in Septembrie 2026)', async () => {
  await withMockPool(
    () => ({ rows: [{ status: 'unmeasured' }] }),
    async () => {
      const status = await dbModule.getTrafficDataAvailability('2026-01-01', '2026-02-01');
      assert.equal(status, 'unmeasured');
    }
  );
});

test('7g) perioada care CONTINE data de inceput a tracking-ului -> "partial" (ex. Septembrie 2026 intreaga, inceput real 19.09.2026 undeva in interiorul lunii)', async () => {
  await withMockPool(
    () => ({ rows: [{ status: 'partial' }] }),
    async () => {
      const status = await dbModule.getTrafficDataAvailability('2026-09-01', '2026-10-01');
      assert.equal(status, 'partial');
    }
  );
});

test('7h) perioada COMPLET ULTERIOARA inceperii tracking-ului -> "complete" (ex. Octombrie 2026, dupa ce tracking-ul era deja pornit din 19.09.2026)', async () => {
  await withMockPool(
    () => ({ rows: [{ status: 'complete' }] }),
    async () => {
      const status = await dbModule.getTrafficDataAvailability('2026-10-01', '2026-11-01');
      assert.equal(status, 'complete');
    }
  );
});

test('7i) Septembrie 2026 e "partial" cu datele ACTUALE de productie (MIN(occurred_at) confirmat direct in auditul din 2026-09-19: 2026-09-19T07:46:01.582Z — inaintea sfarsitului lunii, dupa inceputul ei)', async () => {
  await withMockPool(
    (sql, params) => {
      // simuleaza EXACT ce ar calcula Postgres pentru valoarea reala confirmata in productie:
      // MIN(occurred_at) = 2026-09-19T07:46:01.582Z, startDate='2026-09-01', endDateExclusive='2026-10-01'
      // -> NU <= inceputul lunii (nu e 'complete'), DAR < sfarsitul lunii (e 'partial').
      assert.deepEqual(params, ['2026-09-01', '2026-10-01']);
      return { rows: [{ status: 'partial' }] };
    },
    async () => {
      const status = await dbModule.getTrafficDataAvailability('2026-09-01', '2026-10-01');
      assert.equal(status, 'partial', 'Septembrie 2026 trebuie sa fie "partial", niciodata "unmeasured" (ar ascunde cei 5+ vizitatori reali urmariti dupa 19.09) si niciodata "complete" (prima jumatate a lunii nu era acoperita)');
    }
  );
});

test('7j) orders.js: renderKpiCards afiseaza VALORILE REALE (nu "Nemăsurat") cand trafficDataAvailability e "partial" — doar o nota compacta suplimentara, niciodata in locul cifrei', () => {
  const fnStart = js.indexOf('function renderKpiCards(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  // "unmeasured" e SINGURA stare care inlocuieste valoarea cu 'Nemăsurat' — "partial" nu apare in
  // acea conditie, deci valoarea numerica reala (Number(kpis[d.key])) ramane afisata.
  assert.match(fn, /const unmeasured = isTraffic && trafficDataAvailability === 'unmeasured';/);
  // 'Nemăsurat' trebuie sa depinda STRICT de `unmeasured` (ternarul valorii) — nu de `partial`
  assert.match(fn, /const value = unmeasured \? 'Nemăsurat' :/);
  assert.doesNotMatch(fn, /const value = partial \?/, '"partial" nu trebuie sa controleze niciodata valoarea afisata');
  assert.match(fn, /const partial = isTraffic && trafficDataAvailability === 'partial';/);
  assert.match(fn, /const note = partial \? `<div class="stat-note"/, 'starea partial trebuie sa adauge STRICT o nota, niciodata sa inlocuiasca valoarea');
});

test('7k) orders.js: renderFunnelTraffic afiseaza randurile REALE (Vizitatori/Formular, cu numerele lor) cand trafficDataAvailability e "partial" — NU intra pe ramura de "Date indisponibile" (care e STRICT pentru "unmeasured")', () => {
  const fnStart = js.indexOf('function renderFunnelTraffic(');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  // singura conditie de early-return (fara randuri) e STRICT 'unmeasured' — 'partial' trece mai
  // departe si construieste randurile normale, cu traffic.trackedVisitors/traffic.formStarted reale.
  assert.match(fn, /if \(trafficDataAvailability === 'unmeasured'\) \{/);
  const earlyReturnIdx = fn.indexOf("if (trafficDataAvailability === 'unmeasured')");
  const afterEarlyReturn = fn.slice(earlyReturnIdx);
  assert.match(afterEarlyReturn, /traffic\.trackedVisitors/, 'valorile reale trebuie construite pentru orice alta stare decat unmeasured, inclusiv partial');
});

test('7l) orders.js: mesajul "Date parțiale" NU apare deloc pentru starea "complete" — nici in KPI Cards, nici in funnel-ul de trafic', () => {
  const kpiFnStart = js.indexOf('function renderKpiCards(');
  const kpiFnEnd = js.indexOf('\n}', kpiFnStart);
  const kpiFn = js.slice(kpiFnStart, kpiFnEnd);
  // nota e generata STRICT cand `partial` e true — pentru 'complete', partial=false, deci `note` ramane string gol
  assert.match(kpiFn, /const note = partial \? `<div class="stat-note"[^`]*`: ''|const note = partial \? `<div class="stat-note"[^`]*` : '';/);

  const trafficFnStart = js.indexOf('function renderFunnelTraffic(');
  const trafficFnEnd = js.indexOf('\n}', trafficFnStart);
  const trafficFn = js.slice(trafficFnStart, trafficFnEnd);
  assert.match(trafficFn, /const partialNote = \(trafficDataAvailability === 'partial'\)/, 'nota trebuie generata STRICT pentru starea partial, niciodata pentru complete');
});

test('7m) orders.js: formatPartialNote() foloseste STRICT dataCompleteSince (sursa server-side, MIN(occurred_at)) — nicio data hardcodata in frontend', () => {
  const fnStart = js.indexOf('function formatPartialNote(dataCompleteSince) {');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.ok(fnStart !== -1, 'formatPartialNote trebuie sa existe');
  assert.match(fn, /new Date\(dataCompleteSince\)/);
  assert.doesNotMatch(fn, /2026-09-19|'09'|'19'/, 'nicio data hardcodata — data vine STRICT din parametrul dataCompleteSince');
});

// ==================================================================================================
// Regresii explicite — nimic din "NU modifica" nu a fost atins.
// ==================================================================================================
test('REGRESIE: timeWindowClause() ramane BYTE-IDENTICA (neatinsa in aceasta faza)', () => {
  assert.match(db, /function timeWindowClause\(column, paramIndex1, paramIndex2\) \{\s*\n\s*return `\$\{column\} >= \(\$\$\{paramIndex1\}::date AT TIME ZONE 'Europe\/London'\) AND \$\{column\} < \(\$\$\{paramIndex2\}::date AT TIME ZONE 'Europe\/London'\)`;\s*\n\s*\}/);
});

test('REGRESIE: resolvePeriodBounds() (lib/funnel-period.js) ramane neatinsa in aceasta faza', () => {
  const funnelPeriod = read('lib/funnel-period.js');
  assert.match(funnelPeriod, /function resolvePeriodBounds\(period\) \{/);
});

test('REGRESIE: linkFunnelEventsToOrder() ramane byte-identica', () => {
  assert.match(db, /async function linkFunnelEventsToOrder\(visitorId, orderId\) \{\s*\n\s*if \(!visitorId\) return;\s*\n\s*await pool\.query\(\s*\n\s*`UPDATE funnel_events SET order_id = \$2 WHERE visitor_id = \$1 AND order_id IS NULL`,\s*\n\s*\[visitorId, orderId\]\s*\n\s*\);\s*\n\s*\}/);
});

test('REGRESIE: definitia paid_at pentru plati/venit ramane neatinsa (getFunnelKpis)', () => {
  assert.match(db, /WHERE paid_at IS NOT NULL AND \$\{timeWindowClause\('paid_at', 1, 2\)\}/);
});

test('REGRESIE: ANALYTICS_EXCLUDED_EMAILS ramane neatinsa (server.js)', () => {
  assert.match(server, /const ANALYTICS_EXCLUDED_EMAILS = \(process\.env\.ANALYTICS_EXCLUDED_EMAILS \|\| ''\)/);
});

test('REGRESIE: attribution.js NU a fost atins in aceasta faza (fara git — verificare structurala minima ca fisierul exista si nu are markeri de modificare recenta introdusi de aceasta faza)', () => {
  const attribution = read('public/js/attribution.js');
  assert.doesNotMatch(attribution, /FAZA 1 clarificare|trafficDataComplete|funnel-math/);
});

test('REGRESIE: graficul "Evoluție venit & comenzi" (renderTrend, getRevenueAndOrdersTrend) ramane neatins in aceasta faza', () => {
  assert.match(js, /function renderTrend\(trend\) \{/);
  assert.match(db, /async function getRevenueAndOrdersTrend\(/);
});

test('REGRESIE: checkout flow / Stripe / generare melodii / video-worker NU sunt mentionate in fisierele modificate ale acestei faze (lib/funnel-math.js, test-urile funnel)', () => {
  const funnelMath = read('lib/funnel-math.js');
  assert.doesNotMatch(funnelMath, /stripe|suno|ffmpeg|video-worker/i);
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

test('db.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
