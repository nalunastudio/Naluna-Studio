// lib/meta-capi/capi-retry.js
// Logica PURA (fara I/O) de backoff pentru reincercarile Meta CAPI Purchase — acelasi tipar ca
// lib/social/social-retry.js (computeBackoffMs), adaptat la un singur "job" per rand (nu doua
// platforme separate). Extrasa separat pentru testabilitate izolata.

const MAX_ATTEMPTS = 8;

// Backoff exponential, plafonat la 60 minute — attemptCount e numarul de incercari DEJA facute
// (dupa ce a esuat cea curenta). 2^1=2min, 2^2=4min, ..., plafonat de la 2^6=64min in sus.
function computeBackoffMs(attemptCount) {
  const minutes = Math.min(60, 2 ** attemptCount);
  return minutes * 60 * 1000;
}

// null = plafonul de incercari a fost atins — randul devine 'abandoned' (vezi capi-worker.js),
// nu mai e reincercat automat.
function computeNextAttempt(attemptCount, now = new Date()) {
  if (attemptCount >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + computeBackoffMs(attemptCount));
}

module.exports = { MAX_ATTEMPTS, computeBackoffMs, computeNextAttempt };
