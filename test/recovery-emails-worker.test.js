// lib/recovery-emails/worker.js — foloseste fake-recovery-db.js (replica fidela a contractului
// atomic claim/recover + scan din db.js) + sendFn mockuit, fara Postgres real si fara Resend
// real. Acopera: scanare+enqueue (dedup per client), reverificare inainte de trimitere (plata
// intervenita intre timp), retry/backoff, SAFE DISABLE (config.enabled=false -> no-op complet),
// idempotenta la restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeRecoveryDb } = require('./helpers/fake-recovery-db');
const {
  scanAndEnqueueDueRecoveryCandidates, processDueOrderNotifications, runWorkerTick, ALL_TYPES
} = require('../lib/recovery-emails/worker');
const { MAX_ATTEMPTS } = require('../lib/recovery-emails/retry');

const baseConfig = () => ({
  enabled: true,
  previewRecoveryThresholdHours: 24,
  checkoutRecoveryThresholdHours: 2,
  maxLookbackHours: 24 * 14,
  clientCooldownHours: 24,
  cutoffSince: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(), // "de mult activat" — nu blocheaza fixtures din teste
  testEmails: []
});

function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }

function callCountingSend(impl) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return impl(args); };
  fn.calls = calls;
  return fn;
}
const noSuppression = { isTestEmailFn: async () => false, isSuppressedFn: async () => false, isMarketingSuppressedFn: async () => false };

// ---- scanAndEnqueueDueRecoveryCandidates ----

test('scan: comanda preview_ready neplatita, fara checkout, depasind pragul -> enqueued ca preview_recovery', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', lang: 'en', status: 'preview_ready', generatedAt: hoursAgo(30) });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 1);
  const n = [...db._notifications.values()][0];
  assert.equal(n.notificationType, 'preview_recovery');
  assert.equal(n.orderId, 'o1');
});

test('scan: comanda cu checkout_created_at neplatita, depasind pragul -> enqueued ca checkout_recovery', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', lang: 'en', status: 'preview_ready', checkoutCreatedAt: hoursAgo(5) });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 1);
  assert.equal([...db._notifications.values()][0].notificationType, 'checkout_recovery');
});

test('scan: pragul INCA neatins (comanda prea recenta) -> nimic enqueued', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(1) });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 0);
});

test('scan: client cu 2 comenzi candidate simultan -> STRICT o notificare enqueued (dedup per client)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  db.seedOrder({ id: 'o2', email: 'a@x.com', status: 'preview_ready', checkoutCreatedAt: hoursAgo(5) });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 1);
  assert.equal([...db._notifications.values()][0].orderId, 'o2', 'checkout_recovery (o2) trebuie sa castige fata de preview_recovery (o1)');
});

test('scan: clientul e in cooldown (a primit deja un recovery recent) -> nimic enqueued pentru el', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  await db.touchRecoveryClientCooldown('a@x.com');
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 0);
});

test('scan: comanda mai veche decat cutoffSince (dinainte de prima activare) -> NICIODATA candidat, chiar daca altfel eligibila (protectie retroactiva, cerinta 10)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  const cfg = { ...baseConfig(), cutoffSince: new Date().toISOString() }; // "activat chiar acum" — orice fixture mai veche e exclusa
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: cfg });
  assert.equal(result.enqueued, 0);
});

test('scan: email de test (echipa) -> exclus din scanare, niciodata enqueued', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'team@naluna.dev', status: 'preview_ready', generatedAt: hoursAgo(30) });
  const cfg = { ...baseConfig(), testEmails: ['team@naluna.dev'] };
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: cfg });
  assert.equal(result.enqueued, 0);
});

// ---- PECR soft opt-in (2026-09-25, corectie) ----

test('scan: client care NU a refuzat (emailMarketingOptOut=false, soft opt-in) -> ramane eligibil, enqueued normal', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30), emailMarketingOptOut: false });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 1);
});

test('scan: client care a REFUZAT la colectarea emailului (emailMarketingOptOut=true) -> ZERO recovery, niciodata enqueued', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'refused@x.com', status: 'preview_ready', generatedAt: hoursAgo(30), emailMarketingOptOut: true });
  db.seedOrder({ id: 'o2', email: 'refused@x.com', status: 'preview_ready', checkoutCreatedAt: hoursAgo(5), emailMarketingOptOut: true });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 0, 'niciuna din cele doua comenzi ale clientului nu trebuie enqueued');
});

test('scan: comanda ISTORICA (creata inainte de mecanismul de opt-out, emailMarketingOptOut=null) -> ZERO recovery, forward-only pastrat', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'old@x.com', status: 'preview_ready', generatedAt: hoursAgo(30), emailMarketingOptOut: null });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 0);
});

test('scan: unsubscribe ULTERIOR (client care initial nu refuzase, dar s-a dezabonat intre timp) -> ZERO recovery din acel moment', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30), emailMarketingOptOut: false });
  await db.addEmailMarketingSuppression('a@x.com');
  // scanarea NU verifica suppression-ul (verificat la trimitere, checkSendEligibility) — dar
  // procesarea finala trebuie sa opreasca trimiterea efectiva.
  const scanResult = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(scanResult.enqueued, 1, 'poate fi enqueued (suppression e verificat la trimitere, nu la scanare)');
  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));
  const processed = await processDueOrderNotifications({ db, sendFn: send, ...noSuppression, isMarketingSuppressedFn: async () => true });
  assert.equal(processed, 1);
  assert.equal(send.calls.length, 0, 'Resend NU trebuie contactat — clientul s-a dezabonat');
  assert.equal([...db._notifications.values()][0].status, 'skipped_unsubscribed');
});

test('scan: comanda deja notificata (are un rand order_notifications pentru acel tip) -> nu e re-enqueued', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_recovery', lang: 'en' });
  const result = await scanAndEnqueueDueRecoveryCandidates({ db, config: baseConfig() });
  assert.equal(result.enqueued, 0);
  assert.equal(db._notifications.size, 1);
});

// ---- processDueOrderNotifications (reverificare inainte de trimitere, cerinta 4) ----

test('process: notificare eligibila -> trimisa cu succes, marcata "sent"', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  const send = callCountingSend(async () => ({ resendMessageId: 'msg-1' }));

  const processed = await processDueOrderNotifications({ db, sendFn: send, ...noSuppression });

  assert.equal(processed, 1);
  assert.equal(send.calls.length, 1);
  const n = [...db._notifications.values()][0];
  assert.equal(n.status, 'sent');
  assert.equal(n.resendMessageId, 'msg-1');
});

test('process: PLATA a intervenit intre enqueue si trimitere -> NU trimite, marcheaza skipped_paid (reverifica starea reala din DB)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_recovery', lang: 'en' });
  db._orders.get('o1').paidAt = new Date(); // plata "a intervenit" chiar inainte de tick-ul workerului

  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));
  const processed = await processDueOrderNotifications({ db, sendFn: send, ...noSuppression });

  assert.equal(processed, 1);
  assert.equal(send.calls.length, 0, 'Resend NU trebuie contactat pentru o comanda deja platita');
  assert.equal([...db._notifications.values()][0].status, 'skipped_paid');
});

test('process: email suprimat (bounce/complaint) -> skipped_suppressed, fara sa trimita', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'bounced@x.com', status: 'preview_ready' });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'bounced@x.com', notificationType: 'preview_ready', lang: 'en' });
  const send = callCountingSend(async () => ({}));
  const processed = await processDueOrderNotifications({ db, sendFn: send, isTestEmailFn: async () => false, isSuppressedFn: async () => true, isMarketingSuppressedFn: async () => false });
  assert.equal(send.calls.length, 0);
  assert.equal([...db._notifications.values()][0].status, 'skipped_suppressed');
});

test('process: esec Resend -> ramane pending, reincercabil (retry functioneaza, ACELASI tipar ca meta-capi)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  const send = callCountingSend(async () => { throw new Error('Resend indisponibil'); });

  await processDueOrderNotifications({ db, sendFn: send, ...noSuppression });

  const n = [...db._notifications.values()][0];
  assert.equal(n.status, 'pending');
  assert.equal(n.attempts, 1);
  assert.ok(new Date(n.nextAttemptAt).getTime() > Date.now());
  assert.match(n.lastError, /Resend indisponibil/);
});

test('process: dupa MAX_ATTEMPTS esecuri -> abandoned, nu mai e reincercat automat', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  const row = await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  const send = callCountingSend(async () => { throw new Error('down'); });

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await processDueOrderNotifications({ db, sendFn: send, ...noSuppression });
    const fresh = db._notifications.get(row.id);
    if (fresh.status === 'pending') fresh.nextAttemptAt = new Date(Date.now() - 1000);
  }
  assert.equal(send.calls.length, MAX_ATTEMPTS);
  assert.equal(db._notifications.get(row.id).status, 'abandoned');
});

test('process: doi workeri concurenti nu trimit ACELASI rand de doua ori', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));

  const [p1, p2] = await Promise.all([
    processDueOrderNotifications({ db, sendFn: send, ...noSuppression }),
    processDueOrderNotifications({ db, sendFn: send, ...noSuppression })
  ]);
  assert.equal(p1 + p2, 1);
  assert.equal(send.calls.length, 1);
});

// ---- SAFE DISABLE (cerinta 10) ----

test('runWorkerTick: config.enabled=false -> NU scaneaza, NU trimite, singurul efect e recuperarea randurilor "sending" orfane (inofensiv)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));

  const result = await runWorkerTick({ db, sendFn: send, getConfig: () => ({ ...baseConfig(), enabled: false }), ...noSuppression });

  assert.equal(result.enabled, false);
  assert.equal(db._notifications.size, 0, 'nimic nu trebuie enqueued cat timp flag-ul e oprit');
  assert.equal(send.calls.length, 0, 'Resend NICIODATA contactat cat timp flag-ul e oprit');
});

test('runWorkerTick: config.enabled=true -> scaneaza SI trimite intr-un singur tick', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready', generatedAt: hoursAgo(30) });
  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));

  const result = await runWorkerTick({ db, sendFn: send, getConfig: baseConfig, ...noSuppression });

  assert.equal(result.enabled, true);
  assert.equal(result.enqueued, 1);
  assert.equal(result.processed, 1);
  assert.equal(send.calls.length, 1);
});

// ---- recuperare dupa restart (idempotenta) ----

test('recuperare: un rand ramas "sending" dupa un crash devine din nou eligibil la urmatorul tick', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  const row = await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  await db.claimDueOrderNotification(ALL_TYPES);
  db._notifications.get(row.id).claimedAt = new Date(Date.now() - 60 * 60 * 1000); // "crash" acum o ora

  const send = callCountingSend(async () => ({ resendMessageId: 'x' }));
  const result = await runWorkerTick({ db, sendFn: send, getConfig: baseConfig, ...noSuppression });

  assert.equal(result.recoveredCount, 1);
  assert.equal(send.calls.length, 1);
  assert.equal(db._notifications.get(row.id).status, 'sent');
});

test('idempotenta: acelasi tip de notificare pentru aceeasi comanda NU poate fi enqueued a doua oara, chiar dupa ce prima a fost trimisa (restart nu retrimite)', async () => {
  const db = makeFakeRecoveryDb();
  db.seedOrder({ id: 'o1', email: 'a@x.com', status: 'preview_ready' });
  const first = await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  assert.ok(first);
  const second = await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
  assert.equal(second, null, 'UNIQUE(order_id, notification_type) trebuie sa opreasca al doilea enqueue');
  assert.equal(db._notifications.size, 1);
});
