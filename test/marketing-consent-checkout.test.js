// MARKETING CONSENT — infrastructura pentru Meta Ads (2026-09-21). Acest fisier verifica STRICT
// ca semnalul de consimtamant de marketing e capturat corect la checkout (acelasi tipar ca
// gaClientId/gaSessionId, transportat prin metadata Stripe, fara nicio coloana noua in DB), cu
// default sigur ("denied") pentru orice comanda care nu trimite explicit true.
//
// CORECTIE (2026-09-21, runda 2 — Meta CAPI Purchase implementat): Meta Conversions API a fost
// implementat in aceasta faza (vezi lib/meta-capi/, enqueueMetaCapiPurchase in server.js) —
// testul care afirma explicit ca processConfirmedPayment "nu citeste inca marketingConsent" a
// fost INLOCUIT mai jos cu opusul sau (acum CHIAR il citeste, gate obligatoriu). Testele complete
// pentru Meta CAPI (consimtamant/configuratie/retry/fara PII) traiesc in
// test/meta-capi-server-wiring.test.js, test/meta-capi-payload.test.js, test/meta-capi-client.test.js,
// test/meta-capi-retry.test.js, test/meta-capi-worker.test.js — acest fisier ramane STRICT
// pentru capturarea la checkout (neschimbata) si pentru confirmarea explicita ca NICIUN Meta
// Pixel/SDK client-side a fost adaugat (server.js contine STRICT trimiterea server-side, in
// lib/meta-capi/, niciodata cod care ar rula in browser-ul clientului).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

const server = read('server.js');
const db = read('db.js');
const checkoutFn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");

test('server.js: checkout citeste marketingConsent din body STRICT ca boolean — orice altceva (lipsa, string, numar, obiect) devine "denied", NICIODATA "granted" implicit', () => {
  assert.match(checkoutFn, /req\.body\.marketingConsent === true/, 'trebuie sa verifice STRICT egalitatea cu true, niciun fallback permisiv (ex. truthy check)');
  assert.match(checkoutFn, /\?\s*'granted'\s*:\s*'denied'/, 'valoarea implicita/de fallback trebuie sa fie STRICT "denied"');
});

test('server.js: marketingConsent e transportat catre Stripe prin metadata sesiunii (acelasi tipar ca gaClientId/gaSessionId)', () => {
  const metadataIdx = checkoutFn.indexOf('metadata: {');
  const metadataBlock = checkoutFn.slice(metadataIdx, checkoutFn.indexOf('}', metadataIdx) + 1);
  assert.match(metadataBlock, /gaClientId,\s*\n\s*gaSessionId,\s*\n\s*marketingConsent/, 'marketingConsent trebuie sa fie in acelasi obiect metadata, langa gaClientId/gaSessionId');
});

// CORECTIE (2026-09-21, runda 2): server.js NU trebuie sa contina niciun cod care ar rula in
// browser-ul clientului pentru Meta (Pixel/SDK) — STRICT trimiterea server-side (Conversions
// API), gazduita in lib/meta-capi/ (vezi acele fisiere pentru apelurile reale catre
// graph.facebook.com, verificate acolo, nu aici). server.js insusi importa doar functii PURE
// (buildPurchaseEvent/buildEventId din capi-payload.js, startMetaCapiWorker din capi-worker.js)
// — niciun hostname/apel fbq direct.
test('server.js: NICIUN Meta Pixel/SDK client-side (fbq, connect.facebook.net) si niciun hostname Graph API direct in acest fisier', () => {
  assert.ok(!/connect\.facebook\.net|fbq\(/i.test(server), 'server.js nu trebuie sa contina niciun Pixel/SDK client-side Meta');
  assert.ok(!/graph\.facebook\.com/i.test(server), 'server.js nu trebuie sa contina hostname-ul Graph API direct — apelul real traieste STRICT in lib/meta-capi/capi-client.js (si lib/social/, integrare existenta, neschimbata)');
});

// CORECTIE (2026-09-21, runda 2 — Meta CAPI Purchase implementat): opusul exact al testului
// anterior ("NICIUN cod nu citeste inca marketingConsent") — acum, in aceasta faza, gate-ul
// obligatoriu chiar exista. Acoperire completa (consimtamant granted/denied/lipsa, configuratie,
// retry, fara PII) in test/meta-capi-server-wiring.test.js — acest test ramane STRICT ca
// sentinela structurala minima, in continuarea directa a testului pe care il inlocuieste.
test('server.js: processConfirmedPayment CITESTE session.metadata.marketingConsent la confirmarea platii, ca gate obligatoriu pentru Meta CAPI Purchase', () => {
  const paymentFn = extractFn(server, 'async function processConfirmedPayment(event, session) {');
  assert.ok(paymentFn.includes('marketingConsent'), 'processConfirmedPayment trebuie sa citeasca marketingConsent — gate obligatoriu pentru Meta CAPI Purchase (vezi enqueueMetaCapiPurchase)');
  assert.match(paymentFn, /marketingConsent:\s*\(session\.metadata\s*&&\s*session\.metadata\.marketingConsent\)\s*\|\|\s*null/, 'trebuie citit STRICT din session.metadata (sursa confirmata la checkout), niciodata presupus/implicit "granted"');
});

test('db.js: NICIO coloana noua de marketing consent nu a fost adaugata — persistenta minimala, prin metadata Stripe (efemera, STRICT pentru fereastra checkout->webhook), nu prin schema orders', () => {
  assert.ok(!/marketing_consent/i.test(db), 'db.js nu trebuie sa contina nicio coloana marketing_consent — nejustificata arhitectural in aceasta faza (vezi comentariul din server.js#POST /checkout)');
});

test('server.js: comanda istorica (creata inainte de aceasta faza, fara marketingConsent trimis) ar primi implicit "denied" — verificat structural: valoarea calculata e STRICT derivata din req.body, niciodata dintr-o valoare implicita "granted" sau dintr-un istoric al comenzii', () => {
  // Comanda insasi (order) nu are niciun camp de marketing consent citit aici — STRICT req.body,
  // proaspat la fiecare cerere de checkout, deci o comanda veche/reluata nu poate "mosteni" un
  // consimtamant care nu a fost niciodata dat explicit la ACEASTA cerere.
  assert.ok(!/order\.marketingConsent|order\.marketing_consent/.test(checkoutFn), 'marketingConsent nu trebuie citit niciodata de pe obiectul order (nu exista, nu ar trebui sa existe)');
});
