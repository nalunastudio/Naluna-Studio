// lib/social/social-retry.js
// Logica PURA (fara I/O) de retry/backoff per platforma si de calcul al statusului general al
// unei postari — extrasa separat ca sa fie testabila izolat (acelasi motiv ca lib/entitlements.js)
// si REUTILIZATA identic de publicarea manuala instant (social-post-service.js) SI de worker-ul
// de scheduling/retry (social-worker.js). O singura sursa a regulii "cate incercari, cat de des,
// cand ne oprim" — nu exista o a doua implementare in vreunul din cele doua fluxuri.

const MAX_PLATFORM_ATTEMPTS = 5;

// Coduri de eroare Meta documentate explicit ca fiind PERMANENTE (parametri/continut invalid,
// permisiuni lipsa) — o reincercare identica NU are cum sa reuseasca fara o schimbare reala
// (alt fisier, alta permisiune). Lista e un best-effort bazat pe codurile cel mai des intalnite
// in documentatia Graph API — Meta nu publica o taxonomie completa si exhaustiva a tuturor
// codurilor posibile (vezi raportul de etapa, sectiunea riscuri).
const PERMANENT_ERROR_CODES = new Set([
  100,  // Invalid parameter — folosit de Meta pentru cerere/continut malformat, format nesuportat
  190,  // OAuth — token invalid/revocat (retry orb nu ajuta; un refresh reusit al tokenului
        // Instagram intre timp e ce poate repara situatia la o incercare ULTERIOARA, dar aceea
        // vine printr-un retry MANUAL sau o noua postare, nu print-o reincercare automata oarba)
  200,  // Permissions error
  10,   // Permission denied
  9004  // Instagram: crearea containerului media a esuat (de obicei continut/format invalid)
]);

// Coduri documentate explicit de Meta ca temporare — rate limiting sau probleme de serviciu.
const RETRYABLE_ERROR_CODES = new Set([1, 2, 4, 17, 32, 613]);

// Clasifica o eroare Meta (obiectul brut `error` din raspunsul Graph API, niciodata tokenul)
// ca 'permanent' sau 'retryable'. Fara informatie structurata (ex. eroare de retea/timeout,
// fara raspuns JSON de la Meta), presupunem 'retryable' — mai sigur sa mai incercam o data
// decat sa abandonam prematur o problema posibil tranzitorie.
function classifyMetaError(apiError) {
  if (!apiError) return 'retryable';
  if (apiError.is_transient === true) return 'retryable';
  if (PERMANENT_ERROR_CODES.has(apiError.code)) return 'permanent';
  if (RETRYABLE_ERROR_CODES.has(apiError.code)) return 'retryable';
  return 'retryable';
}

// Backoff exponential, plafonat la 60 minute — attemptCount e numarul de incercari DEJA facute
// (dupa ce a esuat cea curenta). 2^1=2min, 2^2=4min, 2^3=8min, 2^4=16min, 2^5=32min.
function computeBackoffMs(attemptCount) {
  const minutes = Math.min(60, 2 ** attemptCount);
  return minutes * 60 * 1000;
}

// null = nu se mai reincearca automat (fie plafonul de incercari a fost atins, fie eroarea
// e permanenta) — postarea ramane in starea ei finala pana la un retry MANUAL explicit
// (vezi db.retrySocialPostPlatform, care ocoleste intentionat aceasta limita).
function computeNextAttempt({ attemptCount, apiError, now = new Date() }) {
  if (attemptCount >= MAX_PLATFORM_ATTEMPTS) return null;
  if (classifyMetaError(apiError) === 'permanent') return null;
  return new Date(now.getTime() + computeBackoffMs(attemptCount));
}

// Statusul general al postarii, derivat STRICT din statusurile per-platforma ale platformelor
// SELECTATE pentru ea (nu toate platformele suportate — o postare doar-Facebook nu e niciodata
// "partially_failed" din cauza Instagram, pentru ca Instagram nici nu a fost cerut).
// Toate null (nicio platforma atinsa inca) -> 'scheduled': folosit STRICT de recuperarea la
// restart (db.recoverStalePublishingSocialPosts), cand un crash a intrerupt procesarea inainte
// sa apuce sa scrie vreun rezultat.
function computeOverallStatus({ platforms, facebookStatus, instagramStatus }) {
  const relevant = platforms.map((p) => (p === 'facebook' ? facebookStatus : instagramStatus));
  if (relevant.every((s) => s == null)) return 'scheduled';
  if (relevant.every((s) => s === 'success')) return 'published';
  if (relevant.some((s) => s === 'success')) return 'partially_failed';
  return 'failed';
}

// Calculeaza patch-ul complet de persistat (db.finalizeSocialPost) dupa o incercare de
// publicare — initiala (attemptedPlatforms = toate platformele postarii, ca la publicarea
// manuala instant) SAU retry (attemptedPlatforms = STRICT platformele care mai aveau nevoie
// de o incercare, ca la worker). Platformele NEATINSE de aceasta incercare (deja reusite
// anterior, sau pur si simplu nu erau scadente acum) raman EXACT cum erau — aceasta functie nu
// le modifica in niciun fel, cerinta explicita "NU republica platforma care a reusit deja".
//
// `post`: randul curent din DB (camelCase, vezi db.rowToSocialPost) — sursa valorilor "vechi"
// pentru platformele neatinse. `results`: obiectul intors de publishPost() — STRICT pentru
// platformele din attemptedPlatforms (celelalte chei, daca exista, sunt ignorate).
function computeAttemptPatch({ post, attemptedPlatforms, results, now = new Date() }) {
  const patch = {};

  for (const platform of ['facebook', 'instagram']) {
    const cap = (s) => platform + s; // 'facebook' + 'Status' -> 'facebookStatus', etc.

    if (!post.platforms.includes(platform)) {
      // platforma nici nu a fost aleasa pentru aceasta postare — patch-ul trebuie sa ramana
      // EXPLICIT null pentru ea (nu doar "cheie lipsa"), ca finalizeSocialPost sa scrie
      // consecvent null indiferent de ce continea randul inainte.
      patch[cap('Status')] = null;
      patch[cap('PostId')] = null;
      patch[cap('Error')] = null;
      patch[cap('AttemptCount')] = 0;
      patch[cap('LastAttemptAt')] = null;
      patch[cap('NextAttemptAt')] = null;
      if (platform === 'instagram') patch.instagramContainerId = null;
      continue;
    }

    const wasAttempted = attemptedPlatforms.includes(platform);
    const prevStatus = post[cap('Status')] || null;
    const prevAttemptCount = post[cap('AttemptCount')] || 0;

    if (!wasAttempted) {
      // neschimbat — fie deja 'success' dintr-o incercare anterioara, fie pur si simplu nu
      // era inca momentul ei (cealalta platforma avea backoff mai scurt)
      patch[cap('Status')] = prevStatus;
      patch[cap('PostId')] = post[cap('PostId')] || null;
      patch[cap('Error')] = post[cap('Error')] || null;
      patch[cap('AttemptCount')] = prevAttemptCount;
      patch[cap('LastAttemptAt')] = post[cap('LastAttemptAt')] || null;
      patch[cap('NextAttemptAt')] = post[cap('NextAttemptAt')] || null;
      if (platform === 'instagram') patch.instagramContainerId = post.instagramContainerId || null;
      continue;
    }

    const result = results[platform];
    const newAttemptCount = prevAttemptCount + 1;
    patch[cap('AttemptCount')] = newAttemptCount;
    patch[cap('LastAttemptAt')] = now;

    if (result && result.status === 'success') {
      patch[cap('Status')] = 'success';
      patch[cap('PostId')] = result.postId || null;
      patch[cap('Error')] = null;
      patch[cap('NextAttemptAt')] = null;
      if (platform === 'instagram') patch.instagramContainerId = result.containerId || null;
    } else {
      patch[cap('Status')] = 'error';
      patch[cap('PostId')] = post[cap('PostId')] || null; // pastreaza orice ID vechi (de obicei null — o platforma esuata n-a avut niciodata unul)
      patch[cap('Error')] = (result && result.message) || 'Eroare necunoscuta la publicare.';
      patch[cap('NextAttemptAt')] = computeNextAttempt({ attemptCount: newAttemptCount, apiError: result && result.apiError, now });
      if (platform === 'instagram') patch.instagramContainerId = post.instagramContainerId || null;
    }
  }

  patch.status = computeOverallStatus({
    platforms: post.platforms,
    facebookStatus: patch.facebookStatus !== undefined ? patch.facebookStatus : (post.facebookStatus || null),
    instagramStatus: patch.instagramStatus !== undefined ? patch.instagramStatus : (post.instagramStatus || null)
  });

  // publishedAt: primul moment in care postarea a avut MACAR un succes (partial sau total) —
  // pastrat neschimbat la retry-uri ulterioare, niciodata rescris.
  patch.publishedAt = (patch.status === 'published' || patch.status === 'partially_failed')
    ? (post.publishedAt || now)
    : (post.publishedAt || null);

  // next_attempt_at la nivel de postare = cel mai apropiat moment de retry dintre platformele
  // care mai au unul programat; null daca niciuna nu mai are (toate au reusit sau si-au epuizat
  // incercarile / au eroare permanenta) — postarea nu mai e preluata automat de worker.
  const candidates = ['facebookNextAttemptAt', 'instagramNextAttemptAt']
    .map((k) => patch[k])
    .filter((v) => v instanceof Date);
  patch.nextAttemptAt = candidates.length > 0
    ? new Date(Math.min(...candidates.map((d) => d.getTime())))
    : null;

  return patch;
}

module.exports = {
  MAX_PLATFORM_ATTEMPTS,
  classifyMetaError,
  computeBackoffMs,
  computeNextAttempt,
  computeOverallStatus,
  computeAttemptPatch
};
