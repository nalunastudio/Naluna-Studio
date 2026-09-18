// FUNNEL MATH (2026-09-18, Funnel Analytics FAZA 2) — teste REALE pentru lib/funnel-math.js
// (logica pura a Conversion Funnel-ului). Acopera EXPLICIT cerinta "niciodata un procent fals
// cand numitorul e 0" — cazul cel mai important de verificat aici, pentru ca o implementare naiva
// (count/prev*100 fara garda) ar produce NaN%/Infinity% in exact acest caz.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFunnelStages, FUNNEL_STAGES } = require('../lib/funnel-math');

test('primul stagiu (trackedVisitors) nu are niciodata "etapa anterioara" — conversie/dropoff = null, niciodata 0/100%', () => {
  const stages = computeFunnelStages({ trackedVisitors: 100, ctaClicks: 40, formStarted: 20, ordersCreated: 10, reachedCheckout: 5, paidOrders: 2 });
  const first = stages[0];
  assert.equal(first.key, 'trackedVisitors');
  assert.equal(first.conversionFromPrevPct, null);
  assert.equal(first.dropOffCount, null);
  assert.equal(first.dropOffPct, null);
});

test('conversie normala: 40/100 -> 40%, dropoff 60 (60%)', () => {
  const stages = computeFunnelStages({ trackedVisitors: 100, ctaClicks: 40, formStarted: 40, ordersCreated: 40, reachedCheckout: 40, paidOrders: 40 });
  const ctaStage = stages.find((s) => s.key === 'ctaClicks');
  assert.equal(ctaStage.conversionFromPrevPct, 40);
  assert.equal(ctaStage.dropOffCount, 60);
  assert.equal(ctaStage.dropOffPct, 60);
});

test('CRITIC — numitor 0 (etapa anterioara = 0): conversie/dropoff% trebuie sa fie STRICT null, niciodata NaN/Infinity/0%', () => {
  const stages = computeFunnelStages({ trackedVisitors: 0, ctaClicks: 0, formStarted: 0, ordersCreated: 0, reachedCheckout: 0, paidOrders: 0 });
  for (const s of stages.slice(1)) {
    assert.equal(s.conversionFromPrevPct, null, `${s.key}: conversionFromPrevPct trebuie sa fie null, nu ${s.conversionFromPrevPct}`);
    assert.equal(s.dropOffPct, null, `${s.key}: dropOffPct trebuie sa fie null, nu ${s.dropOffPct}`);
    assert.equal(s.dropOffCount, 0, `${s.key}: dropOffCount ramane 0 (0 - 0), doar procentul e null`);
  }
});

test('numitor 0 dar numarator pozitiv (caz anormal, teoretic imposibil intr-un funnel real dar nu trebuie sa arunce) -> tot null, niciodata Infinity%', () => {
  const stages = computeFunnelStages({ trackedVisitors: 0, ctaClicks: 5, formStarted: 0, ordersCreated: 0, reachedCheckout: 0, paidOrders: 0 });
  const ctaStage = stages.find((s) => s.key === 'ctaClicks');
  assert.equal(ctaStage.conversionFromPrevPct, null);
  assert.notEqual(ctaStage.conversionFromPrevPct, Infinity);
});

test('dropOffCount niciodata negativ — clamp la 0 chiar daca o etapa "creste" fata de precedenta (posibil doar din cauza ferestrelor de timp diferite intre etape anonime si cohorta comenzilor)', () => {
  const stages = computeFunnelStages({ trackedVisitors: 10, ctaClicks: 15, formStarted: 5, ordersCreated: 3, reachedCheckout: 1, paidOrders: 1 });
  const ctaStage = stages.find((s) => s.key === 'ctaClicks');
  assert.equal(ctaStage.dropOffCount, 0);
  assert.equal(ctaStage.conversionFromPrevPct, 150);
});

test('ultima etapa (paidOrders) foloseste EXACT numarul de comenzi platite ca numarator', () => {
  const stages = computeFunnelStages({ trackedVisitors: 100, ctaClicks: 80, formStarted: 60, ordersCreated: 40, reachedCheckout: 20, paidOrders: 10 });
  const last = stages[stages.length - 1];
  assert.equal(last.key, 'paidOrders');
  assert.equal(last.count, 10);
  assert.equal(last.conversionFromPrevPct, 50);
});

test('FUNNEL_STAGES are exact 6 etape, in ordinea ceruta explicit (Tracked Visitors -> CTA -> Form Started -> Orders Created -> Reached Checkout -> Paid Orders)', () => {
  assert.deepEqual(FUNNEL_STAGES.map((s) => s.key), ['trackedVisitors', 'ctaClicks', 'formStarted', 'ordersCreated', 'reachedCheckout', 'paidOrders']);
});

test('output are exact aceleasi 6 chei ca input, in aceeasi ordine, indiferent de ordinea proprietatilor din obiectul de input', () => {
  const stages = computeFunnelStages({ paidOrders: 1, trackedVisitors: 10, formStarted: 3, ctaClicks: 5, reachedCheckout: 2, ordersCreated: 2 });
  assert.deepEqual(stages.map((s) => s.key), FUNNEL_STAGES.map((s) => s.key));
});
