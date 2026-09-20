// FUNNEL MATH (rescris 2026-09-19, FAZA 1 — clarificare Funnel de conversie, in urma auditului
// din aceeasi zi) — logica PURA a Conversion Funnel-ului, separata de orice acces DB, testabila
// izolat. Primeste STRICT numerele deja agregate (vezi db.js#getConversionFunnel) si NU calculeaza
// nimic din date brute — responsabilitatea ei e exclusiv formula, nu sursa cifrelor.
//
// CE S-A SCHIMBAT fata de versiunea veche (computeFunnelStages/FUNNEL_STAGES, un singur lant de
// 6 etape cu procent fata de ETAPA ANTERIOARA):
// 1) "Click-uri CTA" NU mai e o etapa a lantului secvential — un vizitator poate ajunge direct pe
//    /comanda.html fara sa treaca prin niciun CTA instrumentat (STRICT pe homepage, vezi
//    public/index.html) — a-l trata ca poarta obligatorie sugera fals un flux liniar care nu
//    exista. Ramane un KPI separat (vezi private/admin/orders.js, KPI_DEFS).
// 2) Etapele CU comanda (Comenzi create/Au ajuns la checkout/Au fost platite) nu mai raporteaza
//    procentul fata de etapa IMEDIAT anterioara, ci fata de COMENZI CREATE (baza cohortei, 100%)
//    — cerinta explicita: "din cei care au pornit o comanda in aceasta perioada, cati au ajuns la
//    checkout / cati au platit", nu un lant de conversii succesive care ar fi implicat o relatie
//    stricta cu etapele de trafic (care sunt event-time, nu cohortate — vezi computeTrafficStep).
// 3) Vizitatori -> Formular ramane un pas SEPARAT (computeTrafficStep), niciodata amestecat in
//    acelasi lant cu etapele cohortate — cele doua grupuri masoara lucruri diferite (fereastra de
//    evenimente vs cohorta de comenzi) si NU trebuie prezentate ca acelasi grup continuu de
//    persoane (vezi raportul de audit, sectiunea 11).
//
// REGULA STRICTA, neschimbata: niciodata un procent fals cand numitorul e 0 — null, nu 0%/
// Infinity%/NaN%. Interfata Admin afiseaza explicit "N/A" pentru null (vezi orders.js, pct()).

// Etapele COHORTATE — comenzi create in perioada selectata, urmarite pana la capat indiferent
// cand s-au intamplat checkout-ul/plata (vezi db.js#getConversionFunnel, cohortSql).
const COHORT_STAGES = [
  { key: 'ordersCreated', label: 'Comenzi create' },
  { key: 'reachedCheckout', label: 'Au ajuns la checkout' },
  { key: 'paidOrders', label: 'Au fost plătite' }
];

// pctOfBase: procentul fata de "Comenzi create" (baza cohortei, 100%) — NICIODATA fata de etapa
// anterioara. "Comenzi create" insusi nu are pctOfBase (e baza, nu are sens sa fie exprimat ca
// procent din el insusi) — interfata afiseaza acolo static "Bază".
function computeCohortFunnel(counts) {
  const base = counts.ordersCreated;
  return COHORT_STAGES.map((stage) => {
    const count = counts[stage.key];
    const pctOfBase = (stage.key === 'ordersCreated') ? null : ((base > 0) ? (count / base) * 100 : null);
    return { key: stage.key, label: stage.label, count, pctOfBase };
  });
}

// Conversie SUPLIMENTARA, optionala — "checkout -> plata" (din cei care AU ajuns la checkout,
// cati au si platit). Distincta de pctOfBase (care raporteaza mereu la Comenzi create) — util
// cand cineva vrea sa stie specific rata de finalizare a platii dupa ce a pornit checkout-ul.
function computeCheckoutToPaidPct(counts) {
  return (counts.reachedCheckout > 0) ? (counts.paidOrders / counts.reachedCheckout) * 100 : null;
}

// Pasul de TRAFIC — Vizitatori urmariti -> Formular inceput. Ambele sunt event-time (fereastra
// perioadei, vezi timeWindowClause), NU o cohorta legata de comenzi — un vizitator numarat aici
// nu corespunde neaparat aceluiasi grup de persoane din etapele cohortate de mai sus (vezi
// raportul de audit, sectiunea 11: amestecarea lor intr-un singur lant ar fi inselatoare).
function computeTrafficStep(counts) {
  const trackedVisitors = counts.trackedVisitors;
  const formStarted = counts.formStarted;
  const conversionPct = (trackedVisitors > 0) ? (formStarted / trackedVisitors) * 100 : null;
  return { trackedVisitors, formStarted, conversionPct };
}

module.exports = { COHORT_STAGES, computeCohortFunnel, computeCheckoutToPaidPct, computeTrafficStep };
