// FUNNEL MATH (2026-09-18, Funnel Analytics FAZA 2) — logica PURA a Conversion Funnel-ului
// (conversie fata de etapa anterioara, pierdere absoluta/procentuala) — separata de orice acces
// DB, testabila izolat. Primeste STRICT numerele deja agregate (vezi db.js#getConversionFunnel)
// si NU calculeaza nimic din date brute — responsabilitatea ei e exclusiv formula, nu sursa
// cifrelor.
//
// REGULA STRICTA, ceruta explicit: niciodata un procent fals cand numitorul (etapa anterioara)
// e 0 — null, nu 0%/Infinity%. Interfata Admin trebuie sa afiseze explicit "N/A" pentru null,
// niciodata sa il trateze ca 0 (vezi private/admin/orders.js, functia pct()).
const FUNNEL_STAGES = [
  { key: 'trackedVisitors', label: 'Vizitatori urmăriți' },
  { key: 'ctaClicks', label: 'Click-uri CTA' },
  { key: 'formStarted', label: 'Formular început' },
  { key: 'ordersCreated', label: 'Comenzi create' },
  { key: 'reachedCheckout', label: 'Checkout atins' },
  { key: 'paidOrders', label: 'Comenzi plătite' }
];

function computeFunnelStages(counts) {
  return FUNNEL_STAGES.map((stage, i) => {
    const count = counts[stage.key];
    const prev = i === 0 ? null : counts[FUNNEL_STAGES[i - 1].key];
    const conversionFromPrevPct = (prev === null || prev === 0) ? null : (count / prev) * 100;
    const dropOffCount = (prev === null) ? null : Math.max(0, prev - count);
    const dropOffPct = (prev === null || prev === 0) ? null : (dropOffCount / prev) * 100;
    return { key: stage.key, label: stage.label, count, conversionFromPrevPct, dropOffCount, dropOffPct };
  });
}

module.exports = { computeFunnelStages, FUNNEL_STAGES };
