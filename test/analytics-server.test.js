// ANALYTICS (2026-09-14) — teste server-side: evenimentul GA4 "purchase" (Measurement Protocol),
// validarea gaClientId la checkout, ruta GET /js/config.js. Extrage functiile REALE din
// server.js (textual, acelasi tipar folosit deja in toata suita), niciodata o reimplementare
// separata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function sliceFunctionBody(src, fnSignature, fromIdx) {
  const start = src.indexOf(fnSignature, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignature}"`);
  let depth = 1, i = start + fnSignature.length;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ===============================================================================================
// sendGa4PurchaseEvent() — extras real, cu fetch/console mocate.
// ===============================================================================================
function loadSendGa4PurchaseEvent(mocks) {
  const snippet = sliceFunctionBody(server, 'async function sendGa4PurchaseEvent({ orderId, plan, value, currency, gaClientId, gaSessionId }) {');
  const fetchWithTimeoutSnippet = sliceFunctionBody(server, 'async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {');
  const sandboxSrc = `
    const FETCH_TIMEOUT_MS = 30000;
    ${fetchWithTimeoutSnippet}
    ${snippet}
    return sendGa4PurchaseEvent;
  `;
  return new Function('fetch', 'console', 'process', 'return (function() { ' + sandboxSrc + ' })()')(
    mocks.fetch, mocks.console || console, mocks.process
  );
}

function baseEnv(overrides) {
  return Object.assign({ env: { GA_MEASUREMENT_ID: 'G-TEST123', GA_API_SECRET: 'secret-abc' } }, overrides);
}

test('sendGa4PurchaseEvent: GA_MEASUREMENT_ID/GA_API_SECRET lipsa -> no-op silentios, fetch NICIODATA apelat', async () => {
  let fetchCalled = false;
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { fetchCalled = true; return { ok: true }; },
    process: baseEnv({ env: {} })
  });
  await fn({ orderId: 'order-1', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '123.456' });
  assert.equal(fetchCalled, false);
});

test('sendGa4PurchaseEvent: gaClientId lipsa -> no-op silentios (fara client_id, MP nu poate atribui evenimentul), fetch NICIODATA apelat', async () => {
  let fetchCalled = false;
  const warnings = [];
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { fetchCalled = true; return { ok: true }; },
    process: baseEnv(),
    console: { warn: (...args) => warnings.push(args.join(' ')), error: () => {} }
  });
  await fn({ orderId: 'order-2', plan: 'premium', value: 25, currency: 'gbp', gaClientId: null });
  assert.equal(fetchCalled, false);
  assert.ok(warnings.some(w => w.includes('order-2')), 'trebuie logat, dar niciodata aruncat mai departe');
});

test('sendGa4PurchaseEvent: configurat complet + gaClientId SI gaSessionId prezente -> trimite EXACT payload-ul asteptat (INCLUSIV session_id), fara PII', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const fn = loadSendGa4PurchaseEvent({
    fetch: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return { ok: true };
    },
    process: baseEnv()
  });
  await fn({ orderId: 'order-3', plan: 'video', value: 35, currency: 'gbp', gaClientId: '111.222', gaSessionId: '1694712345' });

  assert.ok(capturedUrl.startsWith('https://www.google-analytics.com/mp/collect?'));
  assert.match(capturedUrl, /measurement_id=G-TEST123/);
  assert.match(capturedUrl, /api_secret=secret-abc/);

  assert.equal(capturedBody.client_id, '111.222');
  assert.equal(capturedBody.events.length, 1);
  const ev = capturedBody.events[0];
  assert.equal(ev.name, 'purchase');
  assert.equal(ev.params.transaction_id, 'order-3');
  assert.equal(ev.params.value, 35);
  assert.equal(ev.params.currency, 'GBP', 'currency trebuie normalizata la majuscule (GA4 cere ISO 4217 majuscul)');
  assert.equal(ev.params.session_id, '1694712345', 'session_id trebuie inclus in params, ca sa lege evenimentul de sesiunea reala GA4');
  assert.deepEqual(ev.params.items, [{ item_id: 'video', item_name: 'video', price: 35, quantity: 1 }]);

  // NICIUN camp PII in payload-ul REAL trimis — verificare structurala directa pe obiectul construit.
  const serialized = JSON.stringify(capturedBody).toLowerCase();
  for (const forbidden of ['email', 'story', 'lyrics', 'poveste', 'recipient', 'sender', '@']) {
    assert.ok(!serialized.includes(forbidden), `payload-ul GA4 nu trebuie sa contina "${forbidden}"`);
  }
});

test('sendGa4PurchaseEvent: gaSessionId ABSENT dar gaClientId prezent -> evenimentul TOT se trimite (client_id ramane suficient pentru API), STRICT fara campul session_id in params, cu un avertisment logat', async () => {
  let capturedBody = null;
  let fetchCalled = false;
  const warnings = [];
  const fn = loadSendGa4PurchaseEvent({
    fetch: async (url, options) => { fetchCalled = true; capturedBody = JSON.parse(options.body); return { ok: true }; },
    process: baseEnv(),
    console: { warn: (...args) => warnings.push(args.join(' ')), error: () => {} }
  });
  await fn({ orderId: 'order-6', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '111.222', gaSessionId: null });

  assert.equal(fetchCalled, true, 'session_id lipsa NU trebuie sa blocheze evenimentul (spre deosebire de client_id, care e strict necesar)');
  assert.ok(!Object.prototype.hasOwnProperty.call(capturedBody.events[0].params, 'session_id'), 'params nu trebuie sa contina session_id daca nu a fost capturat');
  assert.ok(warnings.some(w => w.includes('order-6')), 'trebuie logat un avertisment ca atribuirea de sesiune poate fi incompleta');
});

test('sendGa4PurchaseEvent: fetch arunca (retea indisponibila) -> NU propaga eroarea mai departe (analytics nu poate bloca livrarea)', async () => {
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { throw new Error('ECONNRESET simulat'); },
    process: baseEnv(),
    console: { warn: () => {}, error: () => {} }
  });
  await assert.doesNotReject(fn({ orderId: 'order-4', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2' }));
});

test('sendGa4PurchaseEvent: GA4 raspunde cu eroare HTTP -> logat, dar NU propaga eroarea mai departe', async () => {
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => ({ ok: false, status: 500 }),
    process: baseEnv(),
    console: { warn: () => {}, error: () => {} }
  });
  await assert.doesNotReject(fn({ orderId: 'order-5', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2' }));
});

// ===============================================================================================
// PROTECTIE — sendGa4PurchaseEvent() e apelat STRICT dupa gate-ul deja existent de deduplicare
// (isNewEvent / alreadyPaid), niciodata inainte — acelasi punct care garanteaza deja trimiterea
// o singura data a emailului de livrare.
// ===============================================================================================
test('processConfirmedPayment(): sendGa4PurchaseEvent e apelat STRICT DUPA verificarile isNewEvent/order/alreadyPaid (acelasi punct ca sendDeliveryEmail)', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idxIsNewEvent = fnBody.indexOf('if (!result.isNewEvent)');
  const idxAlreadyPaid = fnBody.indexOf('if (result.alreadyPaid)');
  const idxSendEmail = fnBody.indexOf('sendDeliveryEmail(updated)');
  const idxGa4Purchase = fnBody.indexOf('sendGa4PurchaseEvent({');
  assert.ok(idxIsNewEvent !== -1 && idxAlreadyPaid !== -1 && idxSendEmail !== -1 && idxGa4Purchase !== -1);
  assert.ok(idxIsNewEvent < idxGa4Purchase, 'purchase trebuie trimis dupa verificarea isNewEvent');
  assert.ok(idxAlreadyPaid < idxGa4Purchase, 'purchase trebuie trimis dupa verificarea alreadyPaid');
  assert.ok(idxSendEmail < idxGa4Purchase, 'purchase trebuie trimis dupa (sau alaturi de) trimiterea emailului de livrare, niciodata inainte de gate-urile de mai sus');
});

test('processConfirmedPayment(): value/currency trimise la GA4 vin STRICT din amountTotal/paymentCurrency (calculate din session Stripe), niciodata recalculate separat', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  assert.match(fnBody, /value:\s*amountTotal/);
  assert.match(fnBody, /currency:\s*paymentCurrency/);
});

test('processConfirmedPayment(): apelul catre sendGa4PurchaseEvent e invelit intr-un .catch() — o eroare acolo nu poate arunca din functie', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idx = fnBody.indexOf('sendGa4PurchaseEvent({');
  const after = fnBody.slice(idx, idx + 400);
  assert.match(after, /\.catch\(/);
});

// ===============================================================================================
// Checkout — validarea gaClientId primit de la client (format GA4 real: "numar.numar").
// ===============================================================================================
function loadGaClientIdValidator() {
  const routeBody = sliceFunctionBody(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  const idx = routeBody.indexOf('const rawGaClientId');
  const end = routeBody.indexOf(';', routeBody.indexOf(';', idx) + 1) + 1;
  const snippet = routeBody.slice(idx, end);
  const sandboxSrc = `
    function validate(req) {
      ${snippet}
      return gaClientId;
    }
    return validate;
  `;
  return new Function('return (function() { ' + sandboxSrc + ' })()')();
}

test('checkout: gaClientId valid (format GA4 real "numar.numar") -> acceptat neschimbat', () => {
  const validate = loadGaClientIdValidator();
  assert.equal(validate({ body: { gaClientId: '1234567890.9876543210' } }), '1234567890.9876543210');
});

test('checkout: gaClientId lipsa/invalid/garbage/injectie -> ignorat silentios, string gol (niciodata o eroare, niciodata trimis mai departe catre Stripe)', () => {
  const validate = loadGaClientIdValidator();
  assert.equal(validate({ body: {} }), '');
  assert.equal(validate({ body: { gaClientId: null } }), '');
  assert.equal(validate({ body: { gaClientId: undefined } }), '');
  assert.equal(validate({ body: { gaClientId: 'not-a-client-id' } }), '');
  assert.equal(validate({ body: { gaClientId: '<script>alert(1)</script>' } }), '');
  assert.equal(validate({ body: { gaClientId: 123 } }), '', 'non-string trebuie ignorat, niciodata coercizat');
  assert.equal(validate({ body: null }), '', 'req.body absent -> nu trebuie sa arunce');
  assert.equal(validate({}), '', 'req.body undefined -> nu trebuie sa arunce');
});

test('checkout: metadata Stripe include gaClientId (pass-through, fara coloana noua in DB)', () => {
  const routeBody = sliceFunctionBody(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(routeBody, /metadata:\s*\{[\s\S]*?gaClientId[\s\S]*?\}/);
});

// ===============================================================================================
// Checkout — validarea gaSessionId primit de la client (format GA4 real: STRICT numeric).
// ===============================================================================================
function loadGaSessionIdValidator() {
  const routeBody = sliceFunctionBody(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  const idx = routeBody.indexOf('const rawGaSessionId');
  const end = routeBody.indexOf(';', routeBody.indexOf(';', idx) + 1) + 1;
  const snippet = routeBody.slice(idx, end);
  const sandboxSrc = `
    function validate(req) {
      ${snippet}
      return gaSessionId;
    }
    return validate;
  `;
  return new Function('return (function() { ' + sandboxSrc + ' })()')();
}

test('checkout: gaSessionId valid (format GA4 real, STRICT numeric — timestamp Unix) -> acceptat neschimbat', () => {
  const validate = loadGaSessionIdValidator();
  assert.equal(validate({ body: { gaSessionId: '1694712345' } }), '1694712345');
});

test('checkout: gaSessionId lipsa/invalid/garbage/injectie -> ignorat silentios, string gol (niciodata o eroare, niciodata trimis mai departe catre Stripe)', () => {
  const validate = loadGaSessionIdValidator();
  assert.equal(validate({ body: {} }), '');
  assert.equal(validate({ body: { gaSessionId: null } }), '');
  assert.equal(validate({ body: { gaSessionId: undefined } }), '');
  assert.equal(validate({ body: { gaSessionId: 'not-numeric' } }), '');
  assert.equal(validate({ body: { gaSessionId: '123.456' } }), '', 'session_id GA4 nu are punct (spre deosebire de client_id) — trebuie respins');
  assert.equal(validate({ body: { gaSessionId: '<script>alert(1)</script>' } }), '');
  assert.equal(validate({ body: { gaSessionId: 123 } }), '', 'non-string trebuie ignorat, niciodata coercizat');
  assert.equal(validate({ body: null }), '', 'req.body absent -> nu trebuie sa arunce');
  assert.equal(validate({}), '', 'req.body undefined -> nu trebuie sa arunce');
});

test('checkout: metadata Stripe include gaSessionId (pass-through, fara coloana noua in DB), alaturi de gaClientId', () => {
  const routeBody = sliceFunctionBody(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(routeBody, /metadata:\s*\{[\s\S]*?gaClientId[\s\S]*?gaSessionId[\s\S]*?\}/);
});

test('processConfirmedPayment(): sendGa4PurchaseEvent primeste gaSessionId din session.metadata.gaSessionId, la fel ca gaClientId', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  assert.match(fnBody, /gaSessionId:\s*\(session\.metadata\s*&&\s*session\.metadata\.gaSessionId\)\s*\|\|\s*null/);
});

// ===============================================================================================
// GET /js/config.js — expune STRICT Measurement ID-ul (public), NICIODATA GA_API_SECRET.
// ===============================================================================================
test("GET /js/config.js: raspunsul construit expune STRICT GA_MEASUREMENT_ID, niciodata GA_API_SECRET", () => {
  const idx = server.indexOf("app.get('/js/config.js'");
  assert.ok(idx !== -1, 'ruta /js/config.js trebuie sa existe');
  const routeEnd = server.indexOf('\n});', idx) + 4;
  const routeBody = server.slice(idx, routeEnd);
  assert.match(routeBody, /GA_MEASUREMENT_ID/);
  assert.doesNotMatch(routeBody, /GA_API_SECRET/, 'ruta publica NU trebuie sa citeasca/expuna niciodata secretul server-side');
});

test('GET /js/config.js: raspunsul e NECACHE-uit (Cache-Control: no-store) — o schimbare de mediu trebuie sa ajunga imediat', () => {
  const idx = server.indexOf("app.get('/js/config.js'");
  const routeEnd = server.indexOf('\n});', idx) + 4;
  const routeBody = server.slice(idx, routeEnd);
  assert.match(routeBody, /no-store/);
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
