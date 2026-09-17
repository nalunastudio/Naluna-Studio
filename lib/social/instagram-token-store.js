// lib/social/instagram-token-store.js
// Rezolvarea si reinnoirea tokenului Instagram long-lived, persistente in Postgres
// (instagram_token_state — vezi schema in db.js) astfel incat sa supravietuiasca restarturilor
// Railway. META_INSTAGRAM_ACCESS_TOKEN din variabilele de mediu ramane STRICT bootstrap/fallback
// initial — folosit doar cat timp niciun refresh nu a reusit inca sa scrie un token in DB.
//
// REGULA DE SECURITATE valabila in tot acest fisier: tokenul NU e niciodata logat, NU apare
// niciodata intr-un mesaj de eroare, NU e niciodata intors printr-un API. Erorile persistate
// (db.recordInstagramTokenRefreshFailure) contin STRICT err.message — mesajul de eroare al
// Graph API-ului Meta insusi (vezi InstagramApiError in instagram-adapter.js), care descrie
// PROBLEMA API-ului, niciodata nu contine sau ecoueaza tokenul folosit in cerere.

const { refreshInstagramAccessToken } = require('./instagram-adapter');

// Un refresh normal e UN SINGUR apel HTTP catre Meta — 5 minute e o plasa de siguranta
// generoasa impotriva unui crash la mijlocul unui refresh, nu o durata asteptata reala.
const REFRESH_LOCK_MINUTES = 5;

// Tokenul CURENT de folosit pentru orice apel catre graph.instagram.com — DB are prioritate
// (e mai proaspat dupa cel putin un refresh reusit), env e folosit STRICT ca bootstrap inainte
// de primul refresh reusit vreodata.
async function getCurrentInstagramAccessToken(db) {
  const state = await db.getInstagramTokenState();
  if (state && state.accessToken) return state.accessToken;
  return process.env.META_INSTAGRAM_ACCESS_TOKEN || null;
}

// Reinnoieste tokenul curent (DB daca exista deja unul, altfel bootstrap din env) si persista
// rezultatul. Protejat impotriva a doua reinnoiri concurente prin lock cu expirare (vezi
// db.claimInstagramTokenRefresh) — daca alt proces/instanta a castigat deja cursa, aceasta
// functie NU incearca nimic, intoarce { skipped: true }.
//
// La esec: tokenul valid existent NU e atins (db.recordInstagramTokenRefreshFailure nu scrie
// niciodata coloana access_token) — automatizarea continua sa functioneze cu tokenul vechi
// pana la urmatoarea incercare reusita sau pana expira efectiv.
async function refreshAndPersistInstagramToken(db) {
  const claimed = await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  if (!claimed) return { skipped: true, reason: 'refresh_already_in_progress' };

  const currentToken = claimed.accessToken || process.env.META_INSTAGRAM_ACCESS_TOKEN || null;
  if (!currentToken) {
    await db.recordInstagramTokenRefreshFailure('Niciun token Instagram disponibil (nici in DB, nici in META_INSTAGRAM_ACCESS_TOKEN) — nimic de reinnoit.');
    return { ok: false, skipped: true, reason: 'no_token_configured' };
  }

  try {
    const refreshed = await refreshInstagramAccessToken({ accessToken: currentToken });
    const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db.recordInstagramTokenRefreshSuccess(refreshed.accessToken, expiresAt);
    return { ok: true, expiresAt };
  } catch (err) {
    await db.recordInstagramTokenRefreshFailure(err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getCurrentInstagramAccessToken, refreshAndPersistInstagramToken, REFRESH_LOCK_MINUTES };
