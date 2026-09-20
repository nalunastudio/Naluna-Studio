// FUNNEL MATH (rescris 2026-09-19, FAZA 1 clarificare) — teste REALE pentru lib/funnel-math.js.
// Inlocuieste vechiul computeFunnelStages/FUNNEL_STAGES (un singur lant de 6 etape, CTA inclus,
// procent fata de etapa anterioara) cu 3 functii separate, per cerinta explicita a auditului din
// 2026-09-19 (sectiunea 11 — event-time si cohort-time nu trebuie amestecate sub aceeasi eticheta):
// computeTrafficStep (Vizitatori -> Formular, event-time), computeCohortFunnel (Comenzi create ->
// Checkout -> Platite, procent fata de BAZA cohortei — Comenzi create — niciodata fata de etapa
// anterioara), computeCheckoutToPaidPct (conversie optionala checkout -> plata).
//
// Acopera EXPLICIT cerinta "niciodata un procent fals cand numitorul e 0" — cazul cel mai
// important de verificat aici, pentru ca o implementare naiva (count/denom*100 fara garda) ar
// produce NaN%/Infinity% in exact acest caz.
const test = require('node:test');
const assert = require('node:assert/strict');
const { COHORT_STAGES, computeCohortFunnel, computeCheckoutToPaidPct, computeTrafficStep } = require('../lib/funnel-math');

// ==================================================================================================
// COHORT_STAGES / computeCohortFunnel
// ==================================================================================================
test('COHORT_STAGES are exact 3 etape, in ordinea ceruta explicit, FARA CTA (Comenzi create -> Au ajuns la checkout -> Au fost plătite)', () => {
  assert.deepEqual(COHORT_STAGES.map((s) => s.key), ['ordersCreated', 'reachedCheckout', 'paidOrders']);
  assert.deepEqual(COHORT_STAGES.map((s) => s.label), ['Comenzi create', 'Au ajuns la checkout', 'Au fost plătite']);
});

test('CRITIC — "ctaClicks" nu apare NICIODATA in output-ul funnel-ului cohortat, indiferent daca e prezent sau nu in obiectul de input', () => {
  const stages = computeCohortFunnel({ ordersCreated: 10, reachedCheckout: 5, paidOrders: 2, ctaClicks: 999, trackedVisitors: 999, formStarted: 999 });
  assert.equal(stages.some((s) => s.key === 'ctaClicks'), false);
  assert.deepEqual(stages.map((s) => s.key), ['ordersCreated', 'reachedCheckout', 'paidOrders']);
});

test('"Comenzi create" (baza cohortei) nu are pctOfBase (nu se raporteaza la el insusi)', () => {
  const stages = computeCohortFunnel({ ordersCreated: 29, reachedCheckout: 5, paidOrders: 2 });
  const base = stages.find((s) => s.key === 'ordersCreated');
  assert.equal(base.count, 29);
  assert.equal(base.pctOfBase, null);
});

test('pctOfBase se calculeaza STRICT fata de "Comenzi create" (baza), NICIODATA fata de etapa anterioara', () => {
  const stages = computeCohortFunnel({ ordersCreated: 29, reachedCheckout: 5, paidOrders: 2 });
  const checkout = stages.find((s) => s.key === 'reachedCheckout');
  const paid = stages.find((s) => s.key === 'paidOrders');
  assert.equal(checkout.pctOfBase, (5 / 29) * 100);
  // "paid fata de checkout" ar fi 2/5=40% — verificam explicit ca NU calculeaza asta, ci 2/29
  assert.equal(paid.pctOfBase, (2 / 29) * 100);
  assert.notEqual(paid.pctOfBase, 40);
});

test('CRITIC — baza (ordersCreated) 0: pctOfBase pentru toate celelalte etape trebuie sa fie STRICT null, niciodata NaN/Infinity/0%', () => {
  const stages = computeCohortFunnel({ ordersCreated: 0, reachedCheckout: 0, paidOrders: 0 });
  for (const s of stages) {
    assert.equal(s.pctOfBase, null, `${s.key}: pctOfBase trebuie sa fie null, nu ${s.pctOfBase}`);
  }
});

test('caz anormal (teoretic imposibil intr-un funnel real, dar nu trebuie sa arunce): baza 0, numarator pozitiv -> tot null, niciodata Infinity%', () => {
  const stages = computeCohortFunnel({ ordersCreated: 0, reachedCheckout: 3, paidOrders: 1 });
  const checkout = stages.find((s) => s.key === 'reachedCheckout');
  assert.equal(checkout.pctOfBase, null);
  assert.notEqual(checkout.pctOfBase, Infinity);
});

test('comanda creata in luna N si platita in N+1: cohorta lunii N o numara STRICT ca "platita" (contract cu db.js#getConversionFunnel — FILTER WHERE paid_at IS NOT NULL, fara fereastra de timp pe paid_at) — aici verificam ca formula insasi nu impune nicio conditie suplimentara de timp asupra numaratorului', () => {
  // Simuleaza exact ce ar produce db.js pentru o cohorta a lunii N in care 1 din cele 3 comenzi
  // create in N a fost platita abia in N+1 — cohortSql numara "paid_orders" STRICT prin
  // FILTER (WHERE paid_at IS NOT NULL), fara sa verifice CAND (vezi test/funnel-kpi-engine.test.js
  // pentru asertiunea directa asupra SQL-ului). computeCohortFunnel primeste deja acest numar
  // agregat si NU trebuie sa il respinga sau sa il recalculeze — testam ca formula pura reflecta
  // fidel orice numar agregat primit, indiferent cand s-a intamplat plata in realitate.
  const stages = computeCohortFunnel({ ordersCreated: 3, reachedCheckout: 2, paidOrders: 1 });
  const paid = stages.find((s) => s.key === 'paidOrders');
  assert.equal(paid.count, 1, 'comanda platita in N+1 tot conteaza in cohorta lunii N (numarul agregat vine deja asa din db.js)');
  assert.equal(paid.pctOfBase, (1 / 3) * 100);
});

// ==================================================================================================
// computeCheckoutToPaidPct
// ==================================================================================================
test('computeCheckoutToPaidPct: paid / reachedCheckout, NICIODATA fata de ordersCreated', () => {
  assert.equal(computeCheckoutToPaidPct({ reachedCheckout: 5, paidOrders: 2 }), 40);
});

test('CRITIC — computeCheckoutToPaidPct: reachedCheckout 0 -> STRICT null, niciodata NaN/Infinity', () => {
  assert.equal(computeCheckoutToPaidPct({ reachedCheckout: 0, paidOrders: 0 }), null);
  assert.equal(computeCheckoutToPaidPct({ reachedCheckout: 0, paidOrders: 3 }), null);
});

// ==================================================================================================
// computeTrafficStep — Vizitatori -> Formular, SEPARAT de cohorta comenzilor
// ==================================================================================================
test('computeTrafficStep: formStarted / trackedVisitors', () => {
  const step = computeTrafficStep({ trackedVisitors: 100, formStarted: 40 });
  assert.equal(step.trackedVisitors, 100);
  assert.equal(step.formStarted, 40);
  assert.equal(step.conversionPct, 40);
});

test('CRITIC — computeTrafficStep: trackedVisitors 0 -> conversionPct STRICT null, niciodata NaN/Infinity', () => {
  assert.equal(computeTrafficStep({ trackedVisitors: 0, formStarted: 0 }).conversionPct, null);
  assert.equal(computeTrafficStep({ trackedVisitors: 0, formStarted: 5 }).conversionPct, null);
});

test('computeTrafficStep nu primeste si nu foloseste niciodata campuri legate de comenzi (ordersCreated/reachedCheckout/paidOrders) — pas complet independent de cohorta', () => {
  const step = computeTrafficStep({ trackedVisitors: 10, formStarted: 5, ordersCreated: 999, reachedCheckout: 999, paidOrders: 999 });
  assert.deepEqual(Object.keys(step).sort(), ['conversionPct', 'formStarted', 'trackedVisitors']);
});
