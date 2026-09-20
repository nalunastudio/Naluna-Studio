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
  // fetchWithTimeout traieste acum in lib/fetch-with-timeout.js (extras din server.js separat,
  // ca sa poata fi reutilizat si de adaptoarele Facebook/Instagram din lib/social/ — vezi
  // acel fisier) — server.js il importa cu require(), nu mai il defineste inline, deci extragerea
  // textuala trebuie sa citeasca din locatia lui reala, nu din server.js.
  const fetchWithTimeoutSnippet = sliceFunctionBody(read('lib/fetch-with-timeout.js'), 'async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {');
  const sandboxSrc = `
    const DEFAULT_TIMEOUT_MS = 30000;
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

// CORECȚIE/HARDENING (2026-09-20, FAZA GA4 Purchase) — cele doua teste de mai jos acopera STRICT
// scenariul asimetric care lipsea: DOAR unul dintre cele doua e lipsa, niciodata testat separat
// pana acum. Primul e EXACT starea actuala de productie (confirmat prin `railway variables`,
// citit READ-ONLY: GA_MEASUREMENT_ID PREZENT, GA_API_SECRET ABSENT) — motivul pentru care GA4
// Purchase e in prezent un no-op in productie.
test('sendGa4PurchaseEvent: GA_MEASUREMENT_ID prezent dar GA_API_SECRET LIPSA (scenariul REAL, curent, de productie) -> no-op silentios, fetch NICIODATA apelat', async () => {
  let fetchCalled = false;
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { fetchCalled = true; return { ok: true }; },
    process: baseEnv({ env: { GA_MEASUREMENT_ID: 'G-TEST123' } }) // GA_API_SECRET absent
  });
  await fn({ orderId: 'order-1b', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '123.456' });
  assert.equal(fetchCalled, false);
});

test('sendGa4PurchaseEvent: GA_API_SECRET prezent dar GA_MEASUREMENT_ID LIPSA -> no-op silentios, fetch NICIODATA apelat', async () => {
  let fetchCalled = false;
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { fetchCalled = true; return { ok: true }; },
    process: baseEnv({ env: { GA_API_SECRET: 'secret-abc' } }) // GA_MEASUREMENT_ID absent
  });
  await fn({ orderId: 'order-1c', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '123.456' });
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

// HARDENING (2026-09-20, FAZA GA4 Purchase) — timeout REAL (AbortController), nu doar un fetch()
// care arunca orice eroare. Forma exacta a erorii (name/message) confirmata empiric (node -e,
// impotriva unui socket local care nu raspunde niciodata si a unui port inchis) — vezi raportul
// acestei faze pentru detaliu — Node/undici NU include niciodata URL-ul (deci nici api_secret din
// query string) in AbortError.message.
test('sendGa4PurchaseEvent: timeout (AbortError, exact forma reala Node/undici) -> NU propaga eroarea, livrarea/plata NU sunt blocate', async () => {
  const fn = loadSendGa4PurchaseEvent({
    fetch: async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; },
    process: baseEnv(),
    console: { warn: () => {}, error: () => {} }
  });
  await assert.doesNotReject(fn({ orderId: 'order-7', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2' }));
});

// HARDENING — SECRETUL nu apare NICIODATA in vreun mesaj logat, pe NICIUNA dintre caile de esec
// posibile (client_id lipsa, session_id lipsa, fetch arunca reteaua/timeout, HTTP non-ok). Testat
// cu o valoare de secret distincta, usor de cautat, ca sa nu ramana nicio ambiguitate.
test('sendGa4PurchaseEvent: SECRETUL (GA_API_SECRET) nu apare NICIODATA in vreun mesaj console.warn/console.error, pe toate caile de esec', async () => {
  const FAKE_SECRET = 'SECRET_MUST_NEVER_LEAK_9f8e7d';
  const logged = [];
  const mockConsole = { warn: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' ')) };
  const envWithSecret = baseEnv({ env: { GA_MEASUREMENT_ID: 'G-TEST123', GA_API_SECRET: FAKE_SECRET } });

  // (a) client_id lipsa
  const fn1 = loadSendGa4PurchaseEvent({ fetch: async () => ({ ok: true }), process: envWithSecret, console: mockConsole });
  await fn1({ orderId: 'order-8a', plan: 'standard', value: 15, currency: 'gbp', gaClientId: null });

  // (b) session_id lipsa (client_id prezent -> avertisment separat, dar TOT trimite request-ul)
  const fn2 = loadSendGa4PurchaseEvent({ fetch: async () => ({ ok: true }), process: envWithSecret, console: mockConsole });
  await fn2({ orderId: 'order-8b', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2', gaSessionId: null });

  // (c) fetch arunca (retea/timeout)
  const fn3 = loadSendGa4PurchaseEvent({ fetch: async () => { throw new Error('ECONNRESET simulat'); }, process: envWithSecret, console: mockConsole });
  await fn3({ orderId: 'order-8c', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2' });

  // (d) HTTP non-ok
  const fn4 = loadSendGa4PurchaseEvent({ fetch: async () => ({ ok: false, status: 500 }), process: envWithSecret, console: mockConsole });
  await fn4({ orderId: 'order-8d', plan: 'standard', value: 15, currency: 'gbp', gaClientId: '1.2' });

  assert.ok(logged.length >= 4, 'toate cele 4 cai de esec trebuie sa fi logat ceva (verificare ca testul chiar a exercitat codul)');
  for (const line of logged) {
    assert.ok(!line.includes(FAKE_SECRET), `secretul a aparut intr-un mesaj logat: "${line}"`);
    assert.ok(!line.includes('mp/collect'), `URL-ul (care contine api_secret in query string) nu trebuie sa apara in loguri: "${line}"`);
  }
});

// HARDENING — timeout-ul folosit e EXPLICIT si rezonabil (8 secunde), niciodata fetch() brut fara
// nicio limita (care ar putea bloca la nesfarsit request-ul HTTP catre Google, chiar daca funcția
// e fire-and-forget — un handle de retea agatat inutil de mult timp tot costa resurse).
test('sendGa4PurchaseEvent: foloseste fetchWithTimeout cu un timeout EXPLICIT, rezonabil (8000ms) — nu fetch() brut, fara limita', () => {
  const snippet = sliceFunctionBody(server, 'async function sendGa4PurchaseEvent({ orderId, plan, value, currency, gaClientId, gaSessionId }) {');
  assert.match(snippet, /fetchWithTimeout\(url,\s*\{[\s\S]*?\},\s*8000\)/, 'trebuie apelat cu un al treilea parametru explicit de timeout (8000ms)');
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

// ===============================================================================================
// HARDENING (2026-09-20, FAZA GA4 Purchase) — scanare STRUCTURALA a intregului cod client-side:
// literalul "GA_API_SECRET" nu trebuie sa apara NICIODATA sub public/ — regresie mai larga decat
// testul dedicat /js/config.js de mai sus (acopera si eventuale fisiere viitoare, nu doar ruta
// actuala).
// ===============================================================================================
test('GA_API_SECRET nu apare NICIODATA in niciun fisier din public/ (client-side) — scanare recursiva completa', () => {
  function listFilesRecursive(dir) {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(listFilesRecursive(full));
      else out.push(full);
    }
    return out;
  }
  const publicDir = path.join(__dirname, '..', 'public');
  const files = listFilesRecursive(publicDir);
  assert.ok(files.length > 10, 'sanity check — trebuie sa gaseasca un numar rezonabil de fisiere in public/');
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('GA_API_SECRET'), `"${file}" nu trebuie sa contina niciodata literalul "GA_API_SECRET"`);
  }
});

// ===============================================================================================
// HARDENING — retry real de webhook Stripe NU produce a doua procesare financiara/GA4. Testat la
// nivelul mecanismului REAL de deduplicare (db.js#recordPaidOrderAtomically), cu un pool Postgres
// mocat care simuleaza exact comportamentul `INSERT ... ON CONFLICT (event_id) DO NOTHING` — a
// doua livrare a ACELUIASI event.id Stripe intoarce 0 randuri (conflict), deci isNewEvent=false,
// care (vezi testul structural de mai sus, "sendGa4PurchaseEvent e apelat STRICT DUPA...") opreste
// executia lui processConfirmedPayment() INAINTE de a ajunge la sendGa4PurchaseEvent — retry-ul nu
// poate niciodata trimite Purchase de doua ori.
// ===============================================================================================
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';
const db = require('../db.js');

async function withMockDbClient(rowsQueue, fn) {
  const originalConnect = db.pool.connect.bind(db.pool);
  const calls = [];
  db.pool.connect = async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
      return rowsQueue.shift() || { rows: [] };
    },
    release: () => {}
  });
  try {
    return await fn(calls);
  } finally {
    db.pool.connect = originalConnect;
  }
}

test('recordPaidOrderAtomically: acelasi event.id Stripe (retry webhook) -> a doua incercare NU insereaza (ON CONFLICT DO NOTHING), isNewEvent=false — nicio a doua procesare financiara/GA4 posibila', async () => {
  // Prima livrare: INSERT reuseste (1 rand), apoi SELECT ... FOR UPDATE gaseste comanda (status != 'ready')
  await withMockDbClient(
    [
      { rows: [{ event_id: 'evt_123' }] }, // dedup INSERT reuseste
      { rows: [{ id: 'order-9', status: 'preview_ready', plan: 'standard', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }] }, // SELECT FOR UPDATE
      { rows: [{ id: 'order-9', status: 'ready', plan: 'standard', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }] } // UPDATE RETURNING
    ],
    async () => {
      const result = await db.recordPaidOrderAtomically('evt_123', 'order-9', { status: 'ready' });
      assert.equal(result.isNewEvent, true, 'prima livrare trebuie sa fie procesata (isNewEvent=true)');
    }
  );

  // A doua livrare (retry Stripe, ACELASI event.id): dedup INSERT gaseste conflictul -> 0 randuri
  await withMockDbClient(
    [{ rows: [] }], // ON CONFLICT (event_id) DO NOTHING -> RETURNING nu produce niciun rand
    async (calls) => {
      const result = await db.recordPaidOrderAtomically('evt_123', 'order-9', { status: 'ready' });
      assert.equal(result.isNewEvent, false, 'retry-ul cu ACELASI event.id NU trebuie sa fie procesat a doua oara');
      assert.equal(result.order, undefined, 'retry-ul nu trebuie sa returneze/atinga vreun rand de comanda');
      // confirmam ca dedup query-ul e chiar cel asteptat (ON CONFLICT DO NOTHING), nu o alta logica
      const dedupCall = calls.find((c) => c.sql.includes('processed_stripe_events'));
      assert.ok(dedupCall);
      assert.match(dedupCall.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
      assert.deepEqual(dedupCall.params, ['evt_123', 'order-9']);
      // NICIO alta interogare (SELECT FOR UPDATE / UPDATE) nu trebuie sa se fi executat dupa dedup
      assert.equal(calls.filter((c) => c.sql.includes('FOR UPDATE') || c.sql.startsWith('UPDATE orders')).length, 0, 'retry-ul respins la dedup nu trebuie sa mai atinga deloc randul comenzii');
    }
  );
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
