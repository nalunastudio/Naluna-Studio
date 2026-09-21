// server.js — teste STRICT pentru enqueueMetaCapiPurchase() si punctul unde e apelata din
// processConfirmedPayment(). Extrage functiile REALE din server.js (textual, acelasi tipar ca
// test/analytics-server.test.js pentru sendGa4PurchaseEvent), niciodata o reimplementare
// separata. Acopera cerintele explicite: consimtamant granted/denied/lipsa, configuratie
// lipsa -> no-op, eroare/timeout Meta NU rupe Stripe, fara raw PII in orice e logat, ordinea
// fata de gate-urile de deduplicare, si absenta oricarei regresii Meta Pixel client-side.
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

const ENQUEUE_SIGNATURE = 'async function enqueueMetaCapiPurchase({ orderId, email, value, currency, fbp, marketingConsent, paidAt }) {';

function loadEnqueueMetaCapiPurchase(mocks) {
  const snippet = sliceFunctionBody(server, ENQUEUE_SIGNATURE);
  const sandboxSrc = `
    ${snippet}
    return enqueueMetaCapiPurchase;
  `;
  return new Function(
    'process', 'console', 'db', 'buildMetaCapiPurchaseEvent', 'buildMetaCapiEventId', 'metaCapiWorkerHandle', 'DOMAIN',
    'return (function() { ' + sandboxSrc + ' })()'
  )(
    mocks.process, mocks.console || console, mocks.db, mocks.buildMetaCapiPurchaseEvent,
    mocks.buildMetaCapiEventId, mocks.metaCapiWorkerHandle, mocks.DOMAIN || 'https://nalunastudio.com'
  );
}

function baseEnv(overrides) {
  return Object.assign({ env: { META_CAPI_ACCESS_TOKEN: 'fake-token', META_DATASET_ID: 'DATASET123' } }, overrides);
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    async enqueueMetaCapiEvent(args) { calls.push(args); return { id: 'evt-1', ...args }; }
  };
}

const identityBuilders = {
  buildMetaCapiPurchaseEvent: (args) => ({ event_name: 'Purchase', ...args }),
  buildMetaCapiEventId: (orderId) => `purchase_${orderId}`
};

// ===============================================================================================
// Gate-ul de consimtamant — cerinta explicita: trimite Purchase NUMAI daca
// session.metadata.marketingConsent === 'granted' (aici: parametrul marketingConsent).
// ===============================================================================================
test('enqueueMetaCapiPurchase: marketingConsent === "granted" -> enqueueaza in DB', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders });
  await fn({ orderId: 'order-1', email: 'a@b.com', value: 15, currency: 'gbp', fbp: null, marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].orderId, 'order-1');
});

test('enqueueMetaCapiPurchase: marketingConsent === "denied" -> ZERO enqueue, DB niciodata atins', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders });
  await fn({ orderId: 'order-2', email: 'a@b.com', value: 15, currency: 'gbp', fbp: null, marketingConsent: 'denied', paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 0);
});

test('enqueueMetaCapiPurchase: marketingConsent lipsa (null/undefined — comenzi istorice fara acest camp) -> ZERO enqueue', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders });
  await fn({ orderId: 'order-3', email: 'a@b.com', value: 15, currency: 'gbp', fbp: null, marketingConsent: null, paidAt: new Date().toISOString() });
  await fn({ orderId: 'order-4', email: 'a@b.com', value: 15, currency: 'gbp', fbp: null, marketingConsent: undefined, paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 0);
});

test('enqueueMetaCapiPurchase: orice valoare, alta decat exact "granted" (ex. "true", 1, "GRANTED") -> ZERO enqueue', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders });
  for (const bad of ['true', 1, 'GRANTED', 'Granted', {}]) {
    await fn({ orderId: 'order-x', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: bad, paidAt: new Date().toISOString() });
  }
  assert.equal(db.calls.length, 0);
});

// ===============================================================================================
// Gate-ul de configuratie — cerinta explicita: lipsa configuratiei Meta => no-op sigur.
// ===============================================================================================
test('enqueueMetaCapiPurchase: META_CAPI_ACCESS_TOKEN lipsa -> no-op, DB niciodata atins', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv({ env: { META_DATASET_ID: 'DATASET123' } }), db, ...identityBuilders });
  await fn({ orderId: 'order-5', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 0);
});

test('enqueueMetaCapiPurchase: META_DATASET_ID lipsa -> no-op, DB niciodata atins', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv({ env: { META_CAPI_ACCESS_TOKEN: 'fake-token' } }), db, ...identityBuilders });
  await fn({ orderId: 'order-6', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 0);
});

test('enqueueMetaCapiPurchase: ambele variabile lipsa -> no-op', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv({ env: {} }), db, ...identityBuilders });
  await fn({ orderId: 'order-7', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(db.calls.length, 0);
});

// ===============================================================================================
// value/currency/order_id/email — corectitudine, STRICT din parametrii primiti (deja calculati
// de apelant din Stripe, vezi testul de la punctul de apel mai jos).
// ===============================================================================================
test('enqueueMetaCapiPurchase: value/currency/orderId/email trecute STRICT neschimbate catre buildMetaCapiPurchaseEvent', async () => {
  const db = fakeDb();
  let capturedArgs = null;
  const fn = loadEnqueueMetaCapiPurchase({
    process: baseEnv(), db,
    buildMetaCapiPurchaseEvent: (args) => { capturedArgs = args; return { event_name: 'Purchase' }; },
    buildMetaCapiEventId: (orderId) => `purchase_${orderId}`
  });
  await fn({ orderId: 'order-8', email: 'buyer@example.com', value: 42.5, currency: 'usd', fbp: 'fb.1.1.2', marketingConsent: 'granted', paidAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(capturedArgs.orderId, 'order-8');
  assert.equal(capturedArgs.value, 42.5);
  assert.equal(capturedArgs.currency, 'usd');
  assert.equal(capturedArgs.email, 'buyer@example.com');
  assert.equal(capturedArgs.fbp, 'fb.1.1.2');
  assert.equal(capturedArgs.eventTimeSeconds, Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000));
});

test('enqueueMetaCapiPurchase: event_id trimis catre db.enqueueMetaCapiEvent e determinist (buildMetaCapiEventId(orderId))', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders });
  await fn({ orderId: 'order-9', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(db.calls[0].eventId, 'purchase_order-9');
});

test('enqueueMetaCapiPurchase: fbp lipsa -> trecut ca null/absent, NICIODATA inventat', async () => {
  const db = fakeDb();
  let capturedArgs = null;
  const fn = loadEnqueueMetaCapiPurchase({
    process: baseEnv(), db,
    buildMetaCapiPurchaseEvent: (args) => { capturedArgs = args; return {}; },
    buildMetaCapiEventId: (orderId) => `purchase_${orderId}`
  });
  await fn({ orderId: 'order-10', email: 'a@b.com', value: 15, currency: 'gbp', fbp: undefined, marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.equal(capturedArgs.fbp, null);
});

// ===============================================================================================
// Eroare/timeout Meta NU rupe Stripe — try/catch acopera intreg corpul (enqueue DB + declansarea
// worker-ului), orice eroare e prinsa si logata, NICIODATA aruncata mai departe.
// ===============================================================================================
test('enqueueMetaCapiPurchase: db.enqueueMetaCapiEvent arunca (eroare/timeout DB) -> NU propaga eroarea mai departe', async () => {
  const db = { async enqueueMetaCapiEvent() { throw new Error('ECONNRESET simulat'); } };
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders, console: { error: () => {} } });
  await assert.doesNotReject(fn({ orderId: 'order-11', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() }));
});

test('enqueueMetaCapiPurchase: worker.tick() declansat fire-and-forget arunca -> NU propaga eroarea mai departe', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({
    process: baseEnv(), db, ...identityBuilders,
    metaCapiWorkerHandle: { tick: () => Promise.reject(new Error('tick failed')) },
    console: { error: () => {} }
  });
  await assert.doesNotReject(fn({ orderId: 'order-12', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() }));
});

test('enqueueMetaCapiPurchase: metaCapiWorkerHandle absent (null, ex. inainte de boot) -> nu arunca, enqueue tot are loc', async () => {
  const db = fakeDb();
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders, metaCapiWorkerHandle: null });
  await assert.doesNotReject(fn({ orderId: 'order-13', email: 'a@b.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() }));
  assert.equal(db.calls.length, 1);
});

// ===============================================================================================
// Fara raw PII in orice e logat — email-ul NU trebuie sa apara niciodata intr-un console.error.
// ===============================================================================================
test('enqueueMetaCapiPurchase: mesajul de eroare logat la esec NU contine emailul (raw PII)', async () => {
  const db = { async enqueueMetaCapiEvent() { throw new Error('eroare DB simulata'); } };
  const logged = [];
  const fn = loadEnqueueMetaCapiPurchase({ process: baseEnv(), db, ...identityBuilders, console: { error: (...a) => logged.push(a.join(' ')) } });
  await fn({ orderId: 'order-14', email: 'secret-buyer@example.com', value: 15, currency: 'gbp', marketingConsent: 'granted', paidAt: new Date().toISOString() });
  assert.ok(logged.length > 0, 'trebuie logata eroarea (verificare ca testul chiar a exercitat codul)');
  for (const line of logged) {
    assert.ok(!line.includes('secret-buyer@example.com'), `emailul a aparut intr-un mesaj logat: "${line}"`);
  }
});

// ===============================================================================================
// Punctul de apel din processConfirmedPayment() — ordine fata de gate-urile de deduplicare,
// value/currency din Stripe, fbp din order, si invelirea in .catch().
// ===============================================================================================
test('processConfirmedPayment(): enqueueMetaCapiPurchase e apelat STRICT DUPA verificarile isNewEvent/alreadyPaid, alaturi de sendGa4PurchaseEvent', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idxIsNewEvent = fnBody.indexOf('if (!result.isNewEvent)');
  const idxAlreadyPaid = fnBody.indexOf('if (result.alreadyPaid)');
  const idxGa4 = fnBody.indexOf('sendGa4PurchaseEvent({');
  const idxMetaCapi = fnBody.indexOf('enqueueMetaCapiPurchase({');
  assert.ok(idxIsNewEvent !== -1 && idxAlreadyPaid !== -1 && idxGa4 !== -1 && idxMetaCapi !== -1);
  assert.ok(idxIsNewEvent < idxMetaCapi, 'Meta CAPI trebuie enqueueat dupa verificarea isNewEvent');
  assert.ok(idxAlreadyPaid < idxMetaCapi, 'Meta CAPI trebuie enqueueat dupa verificarea alreadyPaid');
  assert.ok(idxGa4 < idxMetaCapi, 'Meta CAPI trebuie enqueueat dupa (sau alaturi de) GA4, niciodata inainte');
});

test('processConfirmedPayment(): value/currency trimise la Meta CAPI vin STRICT din amountTotal/paymentCurrency, identic cu GA4', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idx = fnBody.indexOf('enqueueMetaCapiPurchase({');
  const call = fnBody.slice(idx, fnBody.indexOf(');', idx));
  assert.match(call, /value:\s*amountTotal/);
  assert.match(call, /currency:\s*paymentCurrency/);
});

test('processConfirmedPayment(): marketingConsent trimis catre Meta CAPI vine STRICT din session.metadata.marketingConsent', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idx = fnBody.indexOf('enqueueMetaCapiPurchase({');
  const call = fnBody.slice(idx, fnBody.indexOf(');', idx));
  assert.match(call, /marketingConsent:\s*\(session\.metadata\s*&&\s*session\.metadata\.marketingConsent\)\s*\|\|\s*null/);
});

test('processConfirmedPayment(): fbp trimis catre Meta CAPI vine STRICT din order (updated.fbp), niciodata inventat', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idx = fnBody.indexOf('enqueueMetaCapiPurchase({');
  const call = fnBody.slice(idx, fnBody.indexOf(');', idx));
  assert.match(call, /fbp:\s*updated\.fbp\s*\|\|\s*null/);
});

test('processConfirmedPayment(): apelul catre enqueueMetaCapiPurchase e invelit intr-un .catch() — o eroare acolo nu poate arunca din functie', () => {
  const fnBody = sliceFunctionBody(server, 'async function processConfirmedPayment(event, session) {');
  const idx = fnBody.indexOf('enqueueMetaCapiPurchase({');
  const after = fnBody.slice(idx, idx + 500);
  assert.match(after, /\.catch\(/);
});

// ===============================================================================================
// HARDENING — niciun Meta Pixel client-side adaugat (cerinta explicita: NU adauga Pixel).
// ===============================================================================================
test('nu exista niciun Meta Pixel (fbq/connect.facebook.net) in niciun fisier din public/', () => {
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
  assert.ok(files.length > 10, 'sanity check');
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('connect.facebook.net'), `"${file}" nu trebuie sa incarce Meta Pixel`);
    assert.ok(!/fbq\s*\(\s*['"]init['"]/.test(content), `"${file}" nu trebuie sa initializeze fbq (Meta Pixel)`);
  }
});

test('META_CAPI_ACCESS_TOKEN nu apare NICIODATA in niciun fisier din public/ (client-side)', () => {
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
  for (const file of listFilesRecursive(publicDir)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('META_CAPI_ACCESS_TOKEN'), `"${file}" nu trebuie sa contina niciodata literalul "META_CAPI_ACCESS_TOKEN"`);
  }
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
