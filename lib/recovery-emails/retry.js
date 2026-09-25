// lib/recovery-emails/retry.js
// Backoff PUR (fara I/O) pentru reincercarile de trimitere a notificarilor de recovery —
// ACELASI tipar exact ca lib/meta-capi/capi-retry.js. Extras separat pentru testabilitate
// izolata.

const MAX_ATTEMPTS = 5;

// Backoff exponential, plafonat la 30 minute — attemptCount e numarul de incercari DEJA facute
// (dupa ce a esuat cea curenta). 2^1=2min, 2^2=4min, 2^3=8min, 2^4=16min, plafonat la 30 de la
// 2^5 in sus. Plafon mai mic decat Meta CAPI (60min) — un esec Resend e tipic tranzitoriu
// (rate-limit/retea), nu are sens sa astepte ore intregi pentru un email, si oricum
// MAX_ATTEMPTS mai mic (5, nu 8) inseamna ca planul complet de reincercare dureaza sub o ora.
function computeBackoffMs(attemptCount) {
  const minutes = Math.min(30, 2 ** attemptCount);
  return minutes * 60 * 1000;
}

// null = plafonul de incercari a fost atins — randul devine 'abandoned', nu mai e reincercat
// automat (ramane vizibil in DB pentru audit/tracking, vezi cerinta 8).
function computeNextAttempt(attemptCount, now = new Date()) {
  if (attemptCount >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + computeBackoffMs(attemptCount));
}

module.exports = { MAX_ATTEMPTS, computeBackoffMs, computeNextAttempt };
