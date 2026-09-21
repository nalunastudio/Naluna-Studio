// lib/meta-capi/capi-client.js — teste STRICT cu fetch mockuit (t.mock, node:test), niciodata
// cereri reale catre Meta. Acopera: token trimis STRICT prin header Authorization (NICIODATA in
// URL/query string — sigur de logat oricand), test_event_code optional, erori Meta/HTTP/retea
// devin MetaCapiError cu mesaj sanitizat (niciodata tokenul).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendPurchaseEvent, MetaCapiError, BASE_URL } = require('../lib/meta-capi/capi-client');

const FAKE_TOKEN = 'EAAG_FAKE_TOKEN_MUST_NEVER_LEAK_9f8e7d';
const sampleEvent = { event_name: 'Purchase', event_time: 1700000000, event_id: 'purchase_o1' };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('sendPurchaseEvent: POST catre /{datasetId}/events, token STRICT in header Authorization, NICIODATA in URL', async (t) => {
  let capturedUrl = null, capturedOptions = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse(200, { events_received: 1 });
  });

  await sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' });

  assert.equal(capturedUrl, `${BASE_URL}/DATASET123/events`);
  assert.ok(!capturedUrl.includes(FAKE_TOKEN), 'URL-ul nu trebuie sa contina NICIODATA tokenul');
  assert.equal(capturedOptions.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(!JSON.stringify(capturedOptions.headers).includes(FAKE_TOKEN) || capturedOptions.headers.Authorization.includes(FAKE_TOKEN), 'tokenul poate aparea STRICT in header-ul Authorization, nicaieri altundeva');
});

test('sendPurchaseEvent: body-ul trimis contine evenimentul in data[], fara test_event_code cand nu e furnizat', async (t) => {
  let capturedBody = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return jsonResponse(200, { events_received: 1 });
  });
  await sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' });
  assert.deepEqual(capturedBody.data, [sampleEvent]);
  assert.ok(!Object.prototype.hasOwnProperty.call(capturedBody, 'test_event_code'));
});

test('sendPurchaseEvent: testEventCode furnizat -> inclus in body ca test_event_code', async (t) => {
  let capturedBody = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return jsonResponse(200, { events_received: 1 });
  });
  await sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123', testEventCode: 'TEST1234' });
  assert.equal(capturedBody.test_event_code, 'TEST1234');
});

test('sendPurchaseEvent: raspuns Meta cu error -> arunca MetaCapiError cu mesajul Meta, apiError populat', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'Invalid parameter', code: 100 } }));
  await assert.rejects(
    () => sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' }),
    (err) => {
      assert.ok(err instanceof MetaCapiError);
      assert.equal(err.message, 'Invalid parameter');
      assert.equal(err.apiError.code, 100);
      return true;
    }
  );
});

test('sendPurchaseEvent: raspuns HTTP non-ok fara body error -> MetaCapiError cu mesaj generic (status inclus)', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(500, {}));
  await assert.rejects(
    () => sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' }),
    /500/
  );
});

test('sendPurchaseEvent: fetch arunca (retea/timeout) -> eroarea propaga neschimbata catre apelant (worker-ul decide retry)', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' }), /aborted/);
});

test('sendPurchaseEvent: NICIUN mesaj de eroare (pe toate caile) nu contine tokenul', async (t) => {
  const cases = [
    async () => jsonResponse(400, { error: { message: 'Invalid parameter', code: 100 } }),
    async () => jsonResponse(500, {}),
    async () => { throw new Error('ECONNRESET simulat'); }
  ];
  for (const impl of cases) {
    t.mock.method(globalThis, 'fetch', impl);
    try {
      await sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN, datasetId: 'DATASET123' });
    } catch (err) {
      assert.ok(!err.message.includes(FAKE_TOKEN), `mesajul de eroare a continut tokenul: "${err.message}"`);
      assert.ok(!String(err.stack || '').includes(FAKE_TOKEN), 'stack-ul erorii nu trebuie sa contina tokenul');
    }
    t.mock.reset();
  }
});

test('sendPurchaseEvent: accessToken/datasetId lipsa -> arunca imediat, fara sa apeleze fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}));
  await assert.rejects(() => sendPurchaseEvent(sampleEvent, { datasetId: 'DATASET123' }), /accessToken lipseste/);
  await assert.rejects(() => sendPurchaseEvent(sampleEvent, { accessToken: FAKE_TOKEN }), /datasetId lipseste/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('sendPurchaseEvent: foloseste un timeout EXPLICIT (10000ms), nu fetch() brut fara limita', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meta-capi', 'capi-client.js'), 'utf8');
  assert.match(src, /fetchWithTimeout\(url,\s*\{[\s\S]*?\},\s*10000\)/);
});
