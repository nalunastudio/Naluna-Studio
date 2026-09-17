// lib/fetch-with-timeout.js
// Extras din server.js (2026-09-16, integrare Meta social publishing) ca sa poata fi reutilizat
// si de adaptoarele din lib/social/ — un serviciu extern blocat nu trebuie sa blocheze cererea
// la nesfarsit, indiferent daca e Suno, Resend sau Graph API (Facebook/Instagram).

const DEFAULT_TIMEOUT_MS = 25000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
