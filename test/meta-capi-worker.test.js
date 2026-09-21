// lib/meta-capi/capi-worker.js — foloseste fake-meta-capi-db.js (replica fidela a contractului
// atomic claim/recover din db.js) + sendPurchaseEvent mockuit, fara Postgres real si fara
// cereri reale catre Meta. Acopera: retry functioneaza (backoff creste, se opreste la
// MAX_ATTEMPTS -> 'abandoned'), doi workeri nu trimit acelasi eveniment de doua ori (retry-ul
// unui webhook Stripe duplicat nu produce un Purchase Meta duplicat), recuperare dupa crash,
// config lipsa la momentul trimiterii nu consuma o incercare reala.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeMetaCapiDb } = require('./helpers/fake-meta-capi-db');
const { processDueMetaCapiEvents, runWorkerTick, STALE_CLAIM_MINUTES } = require('../lib/meta-capi/capi-worker');
const { MAX_ATTEMPTS } = require('../lib/meta-capi/capi-retry');

const validConfig = () => ({ accessToken: 'fake-token', datasetId: 'DATASET123', testEventCode: null });

function callCountingSend(impl) {
  const calls = [];
  const fn = async (event, opts) => { calls.push({ event, opts }); return impl(event, opts); };
  fn.calls = calls;
  return fn;
}

async function enqueueFixture(db, orderId = 'order-1') {
  return db.enqueueMetaCapiEvent({ orderId, eventId: `purchase_${orderId}`, payload: { event_name: 'Purchase', event_id: `purchase_${orderId}` } });
}

test('processDueMetaCapiEvents: eveniment scadent (next_attempt_at <= acum) -> trimis, marcat "sent"', async () => {
  const db = makeFakeMetaCapiDb();
  await enqueueFixture(db);
  const send = callCountingSend(async () => ({ events_received: 1 }));

  const processed = await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: send });

  assert.equal(processed, 1);
  assert.equal(send.calls.length, 1);
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'sent');
  assert.equal(fresh.attempts, 1);
  assert.ok(fresh.sentAt);
});

test('processDueMetaCapiEvents: esec Meta -> ramane "pending", next_attempt_at programat in viitor (retry functioneaza)', async () => {
  const db = makeFakeMetaCapiDb();
  await enqueueFixture(db);
  const send = callCountingSend(async () => { throw new Error('Meta indisponibil (simulat)'); });

  const processed = await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: send });

  assert.equal(processed, 1);
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.attempts, 1);
  assert.ok(new Date(fresh.nextAttemptAt).getTime() > Date.now(), 'urmatoarea incercare trebuie programata in viitor, niciodata imediat');
  assert.match(fresh.lastError, /Meta indisponibil/);
});

test('un eveniment cu next_attempt_at in VIITOR nu e preluat inca', async () => {
  const db = makeFakeMetaCapiDb();
  const row = await enqueueFixture(db);
  db._events.get(row.id).nextAttemptAt = new Date(Date.now() + 60 * 60 * 1000);
  const send = callCountingSend(async () => ({ events_received: 1 }));

  const processed = await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: send });

  assert.equal(processed, 0);
  assert.equal(send.calls.length, 0);
});

test('retry: fiecare esec succesiv programeaza urmatoarea incercare tot mai tarziu (backoff creste)', async () => {
  const db = makeFakeMetaCapiDb();
  const row = await enqueueFixture(db);
  const failing = callCountingSend(async () => { throw new Error('down'); });

  const delays = [];
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: failing });
    const fresh = db._events.get(row.id);
    delays.push(new Date(fresh.nextAttemptAt).getTime() - before);
    fresh.nextAttemptAt = new Date(Date.now() - 1000); // forteaza urmatorul retry sa fie scadent imediat, fara sa astepte backoff-ul real
  }

  assert.ok(delays[1] > delays[0], 'a doua asteptare trebuie sa fie mai lunga decat prima');
  assert.ok(delays[2] > delays[1], 'a treia asteptare trebuie sa fie mai lunga decat a doua');
});

test('dupa MAX_ATTEMPTS esecuri consecutive -> "abandoned", nu mai e reincercat automat', async () => {
  const db = makeFakeMetaCapiDb();
  const row = await enqueueFixture(db);
  const failing = callCountingSend(async () => { throw new Error('still down'); });

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: failing });
    const fresh = db._events.get(row.id);
    if (fresh.status === 'pending') fresh.nextAttemptAt = new Date(Date.now() - 1000);
  }

  assert.equal(failing.calls.length, MAX_ATTEMPTS);
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'abandoned');

  const processedAfter = await processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: failing });
  assert.equal(processedAfter, 0, 'un rand abandoned nu mai trebuie preluat de worker');
});

test('doi "workeri" concurenti nu trimit ACELASI eveniment de doua ori (webhook Stripe duplicat -> fara Purchase Meta duplicat)', async () => {
  const db = makeFakeMetaCapiDb();
  await enqueueFixture(db);
  const send = callCountingSend(async () => ({ events_received: 1 }));

  const [p1, p2] = await Promise.all([
    processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: send }),
    processDueMetaCapiEvents({ db, getConfig: validConfig, sendPurchaseEventFn: send })
  ]);

  assert.equal(p1 + p2, 1, 'un singur eveniment scadent exista — impreuna, cei doi workeri trebuie sa il proceseze EXACT o singura data');
  assert.equal(send.calls.length, 1);
});

test('enqueueMetaCapiEvent: a doua comanda cu ACELASI orderId (retry improbabil) -> returneaza null, niciun al doilea rand creat', async () => {
  const db = makeFakeMetaCapiDb();
  const first = await enqueueFixture(db, 'order-dup');
  assert.ok(first);
  const second = await enqueueFixture(db, 'order-dup');
  assert.equal(second, null);
  assert.equal(db._events.size, 1);
});

test('recuperare dupa crash: un eveniment ramas "sending" stale devine din nou eligibil si e procesat', async () => {
  const db = makeFakeMetaCapiDb();
  const row = await enqueueFixture(db);
  const claimed = await db.claimDueMetaCapiEvent();
  assert.equal(claimed.id, row.id);
  db._events.get(row.id).claimedAt = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60 * 1000);

  const send = callCountingSend(async () => ({ events_received: 1 }));
  const result = await runWorkerTick({ db, getConfig: validConfig, sendPurchaseEventFn: send });

  assert.equal(result.recoveredCount, 1);
  assert.equal(result.processed, 1);
  assert.equal(send.calls.length, 1);
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'sent');
});

test('recuperare: un rand "sending" INCA in fereastra normala NU e atins (nu e stale)', async () => {
  const db = makeFakeMetaCapiDb();
  await enqueueFixture(db);
  await db.claimDueMetaCapiEvent(); // status -> 'sending', claimedAt = acum (proaspat)

  const recovered = await db.recoverStaleMetaCapiEvents(STALE_CLAIM_MINUTES);

  assert.equal(recovered.length, 0);
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'sending', 'un claim proaspat nu trebuie recuperat — inca se poate procesa legitim');
});

test('config Meta lipsa la momentul trimiterii -> randul e eliberat FARA sa consume o incercare reala, sendPurchaseEvent NICIODATA apelat', async () => {
  const db = makeFakeMetaCapiDb();
  await enqueueFixture(db);
  const send = callCountingSend(async () => ({ events_received: 1 }));
  const missingConfig = () => ({ accessToken: '', datasetId: '', testEventCode: null });

  const processed = await processDueMetaCapiEvents({ db, getConfig: missingConfig, sendPurchaseEventFn: send });

  assert.equal(processed, 1, 'randul e "procesat" in sensul ca a fost preluat si eliberat, dar fara sa fi fost trimis');
  assert.equal(send.calls.length, 0, 'fara configuratie, Meta NU trebuie contactat niciodata');
  const fresh = await db.getMetaCapiEventByOrderId('order-1');
  assert.equal(fresh.status, 'pending', 'ramane pending — reincercabil cand configuratia revine');
  assert.equal(fresh.attempts, 0, 'lipsa configuratiei NU trebuie sa consume o incercare reala (nu e o eroare Meta)');
});
