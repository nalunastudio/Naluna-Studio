// lib/social/instagram-token-lifecycle.js
// Decizia DE CAND reinnoim tokenul Instagram si CAND alertam adminul — logica pura izolata de
// executia efectiva a refresh-ului (instagram-token-store.js) si de trimiterea reala a
// emailului (injectata, vezi checkInstagramTokenLifecycle mai jos), ca sa poata fi testata cu
// mock-uri, fara Postgres si fara Resend real.

const { refreshAndPersistInstagramToken } = require('./instagram-token-store');

// Reinnoim cu 15 zile inainte de expirare (tokenul e valabil 60 de zile) — o marja larga,
// intentionat: daca prima incercare esueaza (Meta temporar indisponibil, sau tokenul are
// inca sub 24h de cand a fost emis/reinnoit — Meta interzice explicit refresh mai devreme),
// mai raman multe tick-uri ale worker-ului (vezi social-worker.js) in care sa reincercam
// inainte sa devina periculos.
const REFRESH_MARGIN_DAYS = 15;

// Praguri sub care trimitem alerta prin email daca refresh-ul TOT esueaza — separat de marja
// de refresh de mai sus (incercam sa reinnoim cu mult inainte de a alerta pe cineva).
const ALERT_THRESHOLD_DAYS = 5;

// Nu retrimitem alerta la fiecare tick cat timp problema persista neschimbata — un email pe zi
// e suficient sa tina adminul informat, fara sa fie spam.
const ALERT_RESEND_COOLDOWN_HOURS = 24;

// CORECTIE (audit pre-deploy, varianta B aprobata explicit): fara nicio expirare cunoscuta
// inca (lifecycle NEINITIALIZAT — DB fara token_state populat, bootstrap din env niciodata
// reinnoit prin DB), NU incercam automat refresh, nici la boot, nici la vreun tick ulterior.
// Varianta anterioara (incearca oricum, lasa Meta sa respinga daca tokenul e prea "tanar")
// insemna un apel LIVE catre graph.instagram.com/refresh_access_token IMEDIAT la primul boot
// dupa fiecare deploy, fara nicio actiune umana — inacceptabil pentru un worker care porneste
// singur in productie. Lifecycle-ul ramane STRICT "neinitializat" (shouldRefresh() = false
// la nesfarsit) pana cand expiresAt devine cunoscut printr-un refresh REUSIT — care, cu aceasta
// corectie, nu se mai poate intampla automat, ci STRICT printr-o initializare separata,
// deliberata (endpoint/actiune admin — NECONSTRUITA inca, vezi raportul de audit). Pana atunci,
// publicarea (scheduling/retry) continua normal — getCurrentInstagramAccessToken() foloseste
// oricum tokenul din DB sau bootstrap-ul din env, independent de aceasta decizie de refresh.
function shouldRefresh(state, now = new Date()) {
  if (!state || !state.expiresAt) return false;
  const msUntilExpiry = new Date(state.expiresAt).getTime() - now.getTime();
  return msUntilExpiry <= REFRESH_MARGIN_DAYS * 24 * 60 * 60 * 1000;
}

function isDangerouslyCloseToExpiry(state, now = new Date()) {
  if (!state || !state.expiresAt) return false;
  const msUntilExpiry = new Date(state.expiresAt).getTime() - now.getTime();
  return msUntilExpiry <= ALERT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

function shouldSendAlert(state, now = new Date()) {
  if (!isDangerouslyCloseToExpiry(state, now)) return false;
  if (!state.lastAlertSentAt) return true;
  return now.getTime() - new Date(state.lastAlertSentAt).getTime() >= ALERT_RESEND_COOLDOWN_HOURS * 60 * 60 * 1000;
}

// Punctul de intrare apelat de worker la fiecare tick (nu la fiecare tick reinnoieste efectiv —
// doar cand shouldRefresh() e adevarat). `sendAlertEmail(state)` e injectat de apelant (server.js
// da implementarea reala prin Resend, testele dau un mock) — aceasta functie NU stie nimic
// despre cum arata un email, doar CAND trebuie trimis unul.
async function checkInstagramTokenLifecycle({ db, sendAlertEmail }) {
  const state = await db.getInstagramTokenState();
  if (!shouldRefresh(state)) return { refreshed: false, reason: 'not_due' };

  const result = await refreshAndPersistInstagramToken(db);

  // result.ok === false STRICT — un refresh SARIT pentru ca alta instanta il are deja in curs
  // (result.skipped, fara result.ok setat) NU e un esec, nu declanseaza nicio alerta aici;
  // instanta care a castigat lock-ul va raporta ea insasi rezultatul real la propriul tick.
  if (result.ok === false) {
    const freshState = await db.getInstagramTokenState();
    if (shouldSendAlert(freshState)) {
      // Aparare suplimentara: sendAlertEmail NU primeste niciodata accessToken, chiar daca
      // db.getInstagramTokenState() il include (necesar pentru refreshAndPersistInstagramToken
      // de mai sus, dar irelevant si periculos pentru un email) — eliminat explicit aici,
      // inainte sa paraseasca acest fisier, indiferent ce face implementarea reala din server.js.
      const { accessToken, ...safeState } = freshState;
      await sendAlertEmail(safeState);
      await db.markInstagramTokenAlertSent();
    }
  }

  return result;
}

module.exports = {
  REFRESH_MARGIN_DAYS,
  ALERT_THRESHOLD_DAYS,
  ALERT_RESEND_COOLDOWN_HOURS,
  shouldRefresh,
  isDangerouslyCloseToExpiry,
  shouldSendAlert,
  checkInstagramTokenLifecycle
};
