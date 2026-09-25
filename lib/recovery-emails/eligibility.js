// lib/recovery-emails/eligibility.js
// Logica PURA (fara I/O) de eligibilitate si deduplicare pentru sistemul de recovery emails —
// separata explicit ca sa poata fi testata cu fixtures, fara Postgres/Resend reale.
//
// DOUA ETAPE DISTINCTE, ambele documentate aici (vezi raportul catre user pentru varianta
// narativa completa):
//
// 1) SELECTIE PER CLIENT (pickWinnersPerClient) — ruleaza pe candidatii bruti intorsi de
//    db.findDueRecoveryCandidates (comenzi ELIGIBILE ca timp/stare, inca nenotificate pentru
//    tipul lor). Un client (lower(trim(email))) poate avea 2, 3, 4+ comenzi candidate simultan
//    (cerinta 5, "nu vreau sa primeasca 4 remindere aproape simultan") — aceasta functie alege
//    STRICT O SINGURA comanda per client, per tick de scanare, dupa o regula determinista:
//      a) 'checkout_recovery' are INTOTDEAUNA prioritate fata de 'preview_recovery' (mai
//         aproape de conversie — un client care a ajuns la checkout dar nu a platit e un semnal
//         mai puternic decat unul care doar are un preview neatins).
//      b) La egalitate de tip, castiga comanda cu qualifyingAt cel mai RECENT (generated_at
//         pentru preview_recovery, checkout_created_at pentru checkout_recovery) — cea mai
//         probabil relevanta/proaspata in mintea clientului.
//    Comenzile-sora NEALESE in acest tick NU primesc niciun rand in order_notifications (nu sunt
//    marcate "skipped" definitiv) — raman candidate valide pentru un tick VIITOR, cand vor fi
//    reevaluate de la zero fata de starea reala din DB (ex. daca între timp comanda castigatoare
//    a fost platita, sora ei poate deveni castigatoare la urmatorul tick, dupa ce cooldown-ul
//    clientului se ridica).
//
// 2) VERIFICARE FINALA INAINTE DE TRIMITERE (checkSendEligibility) — ruleaza DIN NOU, la
//    momentul in care worker-ul chiar preia (claim) randul din order_notifications si e gata sa
//    trimita — reverifica starea REALA, curenta a comenzii in DB (cerinta 4: "Inainte de ORICE
//    trimitere, reverifica starea actuala din DB"), pentru ca starea se poate fi schimbat intre
//    momentul enqueue-ului si momentul trimiterii (ex. clientul a platit exact in acest interval).

const RECOVERY_TYPES = ['preview_recovery', 'checkout_recovery'];
const TYPE_PRIORITY = { checkout_recovery: 2, preview_recovery: 1 };

function pickWinnersPerClient(candidates) {
  const byClient = new Map();
  for (const c of candidates || []) {
    const key = c.emailKey;
    const existing = byClient.get(key);
    if (!existing) { byClient.set(key, c); continue; }
    const incomingPriority = TYPE_PRIORITY[c.notificationType] || 0;
    const existingPriority = TYPE_PRIORITY[existing.notificationType] || 0;
    if (incomingPriority > existingPriority) { byClient.set(key, c); continue; }
    if (incomingPriority === existingPriority && new Date(c.qualifyingAt).getTime() > new Date(existing.qualifyingAt).getTime()) {
      byClient.set(key, c);
    }
  }
  return [...byClient.values()];
}

// order: obiect ordine (rowToOrder / camelCase) proaspat citit din DB. notificationType: tipul
// randului order_notifications care urmeaza sa fie trimis. Predicatele sunt functii — sincrone
// SAU care intorc o Promise (apelantul trebuie sa faca await) — injectate de apelant (server.js),
// niciodata I/O direct aici.
async function checkSendEligibility({ order, notificationType, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn }) {
  if (!order) return { ok: false, reason: 'skipped_not_eligible' };
  if (order.paidAt) return { ok: false, reason: 'skipped_paid' };
  if (order.anonymizedAt) return { ok: false, reason: 'skipped_not_eligible' };
  if (order.status === 'generation_failed') return { ok: false, reason: 'skipped_not_eligible' };
  if (!order.email) return { ok: false, reason: 'skipped_not_eligible' };
  if (isTestEmailFn && (await isTestEmailFn(order.email))) return { ok: false, reason: 'skipped_test' };
  if (isSuppressedFn && (await isSuppressedFn(order.email))) return { ok: false, reason: 'skipped_suppressed' };
  // 'preview_ready' e operational (livrare de acces la ce a comandat deja) — NICIODATA gated de
  // suppression-ul de marketing, doar de bounce/complaint (verificat mai sus, pentru toate
  // tipurile). Vezi cerinta 6 — unsubscribe-ul de marketing se aplica STRICT reminderelor.
  if (notificationType !== 'preview_ready' && isMarketingSuppressedFn && (await isMarketingSuppressedFn(order.email))) {
    return { ok: false, reason: 'skipped_unsubscribed' };
  }
  // EMAIL MARKETING OPT-OUT (2026-09-25, corectie PECR soft opt-in) — reverificare LIVE, la
  // trimitere, a alegerii facute la colectarea emailului (vezi db.findDueRecoveryCandidates,
  // acelasi predicat `=== false`, verificat DIN NOU aici pentru orice comanda ajunsa la trimitere
  // pe o alta cale decat scanarea normala). `!== false` respinge ATAT true (a refuzat explicit)
  // CAT SI null/undefined (comanda veche, dinainte de acest mecanism, niciodata intrebata) — o
  // singura conditie, acelasi comportament forward-only cerut explicit (cerinta 7). STRICT pentru
  // reminderele de marketing — 'preview_ready' (operational) nu e afectat, identic cu gate-ul de
  // mai sus.
  if (notificationType !== 'preview_ready' && order.emailMarketingOptOut !== false) {
    return { ok: false, reason: 'skipped_opted_out' };
  }
  return { ok: true };
}

// Cooldown per client — TRUE daca ultima trimitere de recovery (tip 2 SAU 3) a fost mai recenta
// decat fereastra (ore). null/lipsa => niciodata trimis inainte => nu e in cooldown.
function isWithinCooldown(lastRecoverySentAt, cooldownHours, now = new Date()) {
  if (!lastRecoverySentAt) return false;
  const elapsedMs = now.getTime() - new Date(lastRecoverySentAt).getTime();
  return elapsedMs < cooldownHours * 60 * 60 * 1000;
}

module.exports = { RECOVERY_TYPES, TYPE_PRIORITY, pickWinnersPerClient, checkSendEligibility, isWithinCooldown };
