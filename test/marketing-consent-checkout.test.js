// MARKETING CONSENT — infrastructura pregatitoare pentru Meta Ads (2026-09-21). NICIUN Meta
// Pixel/CAPI exista inca in cod — acest fisier verifica STRICT ca semnalul de consimtamant de
// marketing e capturat corect la checkout (acelasi tipar ca gaClientId/gaSessionId, transportat
// prin metadata Stripe, fara nicio coloana noua in DB), cu default sigur ("denied") pentru orice
// comanda care nu trimite explicit true.
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

test('server.js: marketingConsent e transportat catre Stripe prin metadata sesiunii (acelasi tipar ca gaClientId/gaSessionId) — NICIUN Meta Pixel/CAPI/request catre Meta in acest cod', () => {
  const metadataIdx = checkoutFn.indexOf('metadata: {');
  const metadataBlock = checkoutFn.slice(metadataIdx, checkoutFn.indexOf('}', metadataIdx) + 1);
  assert.match(metadataBlock, /gaClientId,\s*\n\s*gaSessionId,\s*\n\s*marketingConsent/, 'marketingConsent trebuie sa fie in acelasi obiect metadata, langa gaClientId/gaSessionId');
  // Verificam STRICT semnale de cod REAL (hostname-uri, apeluri fbq/SDK) — nu simpla mentiune in
  // comentarii a conceptului "Meta Pixel/CAPI" (folosita legitim mai sus, pentru a documenta
  // explicit ca NU e inca implementat).
  assert.ok(!/facebook\.com|connect\.facebook|graph\.facebook|fbq\(/i.test(server), 'server.js nu trebuie sa contina niciun request/SDK real catre Meta (hostname sau apel fbq)');
});

test('server.js: NICIUN cod nu citeste inca session.metadata.marketingConsent la confirmarea platii (webhook) — infrastructura e pregatita, dar Meta CAPI NU e implementat in aceasta faza', () => {
  const paymentFn = extractFn(server, 'async function processConfirmedPayment(event, session) {');
  assert.ok(!paymentFn.includes('marketingConsent'), 'processConfirmedPayment nu trebuie sa citeasca inca marketingConsent — rezervat explicit pentru o faza viitoare (Meta CAPI)');
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
