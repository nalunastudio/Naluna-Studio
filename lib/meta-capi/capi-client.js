// lib/meta-capi/capi-client.js
// Trimiterea REALA catre Meta Conversions API — un singur apel HTTP, catre dataset-ul
// configurat (META_DATASET_ID), autentificat STRICT prin header Authorization: Bearer
// (NICIODATA access_token in query string/URL) — asa incat URL-ul apelului sa poata fi logat
// in siguranta oricand, fara nicio sanitizare suplimentara, si tokenul sa nu ajunga niciodata
// in istoricul de request-uri/loguri de acces. Acelasi host/versiune Graph API ca integrarea
// Facebook/Instagram existenta (lib/social/facebook-adapter.js) — NU e create/modificate
// niciun alt Graph API app/dataset, STRICT reutilizat ce exista deja.

const { fetchWithTimeout } = require('../fetch-with-timeout');

const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

class MetaCapiError extends Error {
  constructor(message, apiError) {
    super(message);
    this.name = 'MetaCapiError';
    this.apiError = apiError || null;
  }
}

// Trimite UN SINGUR eveniment Purchase (deja construit, vezi capi-payload.js) catre Meta.
// Arunca MetaCapiError la orice raspuns non-ok/eroare Meta SAU la orice eroare de retea/timeout
// (fetchWithTimeout) — apelantul (capi-worker.js) decide reincercarea, aceasta functie STRICT
// incearca o data si raporteaza rezultatul.
//
// IMPORTANT: mesajul de eroare provine STRICT din raspunsul Meta (body.error.message) sau din
// err.message (Node/undici, ex. AbortError) — niciodata din url/options, care ar putea (teoretic,
// daca implementarea s-ar schimba vreodata) contine date sensibile. accessToken NU apare
// NICIODATA in vreo valoare intoarsa/aruncata de aceasta functie.
async function sendPurchaseEvent(event, { accessToken, datasetId, testEventCode } = {}) {
  if (!accessToken) throw new Error('sendPurchaseEvent: accessToken lipseste');
  if (!datasetId) throw new Error('sendPurchaseEvent: datasetId lipseste');

  const url = `${BASE_URL}/${datasetId}/events`;
  const body = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, 10000);

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok || responseBody.error) {
    throw new MetaCapiError(
      (responseBody.error && responseBody.error.message) || `Meta Conversions API a raspuns cu status ${res.status}`,
      responseBody.error || null
    );
  }
  return responseBody;
}

module.exports = { API_VERSION, BASE_URL, MetaCapiError, sendPurchaseEvent };
