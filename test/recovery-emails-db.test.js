// db.js — functiile noi pentru recovery emails (order_notifications/recovery_client_state/
// email_marketing_suppressions). ACELASI tipar de testare ca test/admin-distinct-customer-kpi.test.js
// (2b): pool.query mockuit, se verifica SQL-ul/parametrii construiti, fara Postgres real.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  const calls = [];
  db.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return dispatch(sql, params);
  };
  try {
    return await fn(calls);
  } finally {
    db.pool.query = original;
  }
}

test('enqueueOrderNotification: INSERT cu ON CONFLICT (order_id, notification_type) DO NOTHING — enforcement "un eveniment nu e niciodata renotificat" la nivel de DB', async () => {
  await withMockPool(() => ({ rows: [{ id: 'n1', order_id: 'o1', email_key: 'a@x.com', notification_type: 'preview_ready', lang: 'en', status: 'pending', attempts: 0, max_attempts: 5, next_attempt_at: new Date(), claimed_at: null, last_attempt_at: null, last_error: null, resend_message_id: null, created_at: new Date(), sent_at: null }] }), async (calls) => {
    const row = await db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' });
    assert.match(calls[0].sql, /ON CONFLICT \(order_id, notification_type\) DO NOTHING/);
    assert.equal(row.orderId, 'o1');
    assert.equal(row.notificationType, 'preview_ready');
  });
});

test('enqueueOrderNotification: conflict (no rows returned) -> null, niciodata o eroare', async () => {
  const row = await withMockPool(() => ({ rows: [] }), () => db.enqueueOrderNotification({ orderId: 'o1', emailKey: 'a@x.com', notificationType: 'preview_ready', lang: 'en' }));
  assert.equal(row, null);
});

test('claimDueOrderNotification: FOR UPDATE SKIP LOCKED, filtreaza status=pending, next_attempt_at <= now(), si notification_type = ANY($1)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.claimDueOrderNotification(['preview_ready', 'preview_recovery']);
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[0].sql, /status = 'pending' AND next_attempt_at <= now\(\) AND notification_type = ANY\(\$1::text\[\]\)/);
    assert.match(calls[0].sql, /SET status = 'sending', claimed_at = now\(\)/);
  });
});

test('recoverStaleOrderNotifications: muta randurile "sending" orfane inapoi la "pending", ACELASI tipar ca recoverStaleMetaCapiEvents', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.recoverStaleOrderNotifications(10);
    assert.match(calls[0].sql, /SET status = 'pending', next_attempt_at = now\(\), claimed_at = NULL/);
    assert.match(calls[0].sql, /WHERE status = 'sending'/);
    assert.deepEqual(calls[0].params, [10]);
  });
});

test('findDueRecoveryCandidates: UNION ALL intre preview_recovery (status=preview_ready, fara checkout) si checkout_recovery (checkout_created_at IS NOT NULL)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.findDueRecoveryCandidates({ previewThresholdHours: 24, checkoutThresholdHours: 2, maxLookbackHours: 336, cutoffSince: '2026-01-01', testEmails: [] });
    const sql = calls[0].sql;
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /status = 'preview_ready'[\s\S]*checkout_created_at IS NULL[\s\S]*paid_at IS NULL/);
    assert.match(sql, /checkout_created_at IS NOT NULL[\s\S]*paid_at IS NULL/);
    assert.match(sql, /anonymized_at IS NULL/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM order_notifications n WHERE n\.order_id = orders\.id AND n\.notification_type = 'preview_recovery'\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM order_notifications n WHERE n\.order_id = orders\.id AND n\.notification_type = 'checkout_recovery'\)/);
  });
});

test('findDueRecoveryCandidates: email_marketing_opt_out = false pe AMBELE ramuri (2026-09-25, corectie PECR soft opt-in) — exclude ATAT true (refuz explicit) CAT SI NULL (comanda istorica, niciodata intrebata)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.findDueRecoveryCandidates({ previewThresholdHours: 24, checkoutThresholdHours: 2, maxLookbackHours: 336, cutoffSince: null, testEmails: [] });
    const sql = calls[0].sql;
    const occurrences = (sql.match(/email_marketing_opt_out = false/g) || []).length;
    assert.equal(occurrences, 2, 'gate-ul trebuie aplicat pe AMBELE ramuri ale UNION ALL (preview_recovery SI checkout_recovery)');
  });
});

test('findDueRecoveryCandidates: cutoffSince e trimis ca parametru si aplicat pe AMBELE ramuri (protectie retroactiva)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.findDueRecoveryCandidates({ previewThresholdHours: 24, checkoutThresholdHours: 2, maxLookbackHours: 336, cutoffSince: '2026-09-25T00:00:00Z', testEmails: [] });
    const sql = calls[0].sql;
    const occurrences = (sql.match(/generated_at >= \$3|checkout_created_at >= \$3/g) || []).length;
    assert.equal(occurrences, 2, 'cutoffSince ($3) trebuie aplicat pe AMBELE ramuri ale UNION ALL');
    assert.equal(calls[0].params[2], '2026-09-25T00:00:00Z');
  });
});

test('findDueRecoveryCandidates: testEmails goale -> clauza de excludere e NULL-safe (nu produce o eroare SQL cu array gol)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.findDueRecoveryCandidates({ previewThresholdHours: 24, checkoutThresholdHours: 2, maxLookbackHours: 336, cutoffSince: null, testEmails: [] });
    assert.equal(calls[0].params[3], null);
  });
});

test('getRecoveryClientCooldown / touchRecoveryClientCooldown: SELECT simplu / UPSERT ON CONFLICT (email_key)', async () => {
  await withMockPool((sql) => (sql.includes('SELECT') ? { rows: [{ last_recovery_sent_at: '2026-09-25T00:00:00Z' }] } : { rows: [] }), async (calls) => {
    const cooldown = await db.getRecoveryClientCooldown('a@x.com');
    assert.equal(cooldown, '2026-09-25T00:00:00Z');
    await db.touchRecoveryClientCooldown('a@x.com');
    const upsertCall = calls.find((c) => c.sql.includes('ON CONFLICT (email_key)'));
    assert.ok(upsertCall);
  });
});

test('isEmailMarketingSuppressed / addEmailMarketingSuppression: tabela SEPARATA (email_marketing_suppressions), niciodata email_suppressions (bounce/complaint)', async () => {
  await withMockPool(() => ({ rows: [{ x: 1 }] }), async (calls) => {
    const suppressed = await db.isEmailMarketingSuppressed('A@X.com');
    assert.equal(suppressed, true);
    assert.match(calls[0].sql, /FROM email_marketing_suppressions/);
    assert.equal(calls[0].params[0], 'a@x.com', 'email normalizat lower(trim())');
  });
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.addEmailMarketingSuppression('B@X.com', 'unsubscribed');
    assert.match(calls[0].sql, /INSERT INTO email_marketing_suppressions/);
    assert.doesNotMatch(calls[0].sql, /email_suppressions\s*\(/, 'nu trebuie sa scrie in email_suppressions (bounce/complaint) — tabele complet separate');
  });
});

test('getOrderNotificationSummaries: DISTINCT ON (order_id) ... ORDER BY order_id, created_at DESC — STRICT ultima notificare per comanda', async () => {
  await withMockPool(() => ({ rows: [{ order_id: 'o1', notification_type: 'checkout_recovery', status: 'sent', sent_at: new Date(), created_at: new Date() }] }), async (calls) => {
    const map = await db.getOrderNotificationSummaries(['o1']);
    assert.match(calls[0].sql, /DISTINCT ON \(order_id\)/);
    assert.match(calls[0].sql, /ORDER BY order_id, created_at DESC/);
    assert.equal(map.get('o1').type, 'checkout_recovery');
  });
});

test('getOrderNotificationSummaries: array gol -> Map goala, fara niciun query', async () => {
  const map = await db.getOrderNotificationSummaries([]);
  assert.equal(map.size, 0);
});

// ================================================================================================
// EMAIL MARKETING OPT-OUT (2026-09-25, corectie PECR soft opt-in) — createOrder persista cele 3
// campuri noi, rowToOrder pastreaza distinctia null/false (comanda istorica vs. "nu a refuzat").
// ================================================================================================
test('createOrder: persista email_marketing_opt_out/choice_at/policy_version — coloane noi in INSERT', async () => {
  await withMockPool(() => ({ rows: [{ id: 'o1', email_marketing_opt_out: false, email_marketing_choice_at: new Date(), email_marketing_policy_version: '2026-09-25-softoptin-v1', variants: [] }] }), async (calls) => {
    await db.createOrder({ id: 'o1', accessToken: 'tok', occasion: 'x', recipient: 'r', email: 'a@x.com', story: 's', genre: 'pop', plan: 'standard', price: 10, lang: 'ro', status: 'draft', editsUsed: 0, variants: [], selectedVariantId: null, emailMarketingOptOut: true, emailMarketingChoiceAt: new Date('2026-09-25'), emailMarketingPolicyVersion: '2026-09-25-softoptin-v1' });
    assert.match(calls[0].sql, /email_marketing_opt_out, email_marketing_choice_at, email_marketing_policy_version/);
    assert.equal(calls[0].params[calls[0].params.length - 3], true);
    assert.equal(calls[0].params[calls[0].params.length - 1], '2026-09-25-softoptin-v1');
  });
});

test('createOrder: emailMarketingOptOut absent/undefined -> persistat STRICT ca false (niciodata true implicit)', async () => {
  await withMockPool(() => ({ rows: [{ id: 'o1', variants: [] }] }), async (calls) => {
    await db.createOrder({ id: 'o1', accessToken: 'tok', occasion: 'x', recipient: 'r', email: 'a@x.com', story: 's', genre: 'pop', plan: 'standard', price: 10, lang: 'ro', status: 'draft', editsUsed: 0, variants: [], selectedVariantId: null });
    assert.equal(calls[0].params[calls[0].params.length - 3], false);
  });
});

test('rowToOrder (prin getOrderById): email_marketing_opt_out NULL in DB -> emailMarketingOptOut ramane null, NICIODATA coercizat la false', async () => {
  const order = await withMockPool(() => ({ rows: [{ id: 'o1', email_marketing_opt_out: null, variants: [] }] }), () => db.getOrderById('o1'));
  assert.equal(order.emailMarketingOptOut, null, 'o comanda istorica trebuie sa ramana distincta de "false" (nu a refuzat)');
});

test('rowToOrder: email_marketing_opt_out = false in DB -> emailMarketingOptOut === false (nu null, nu undefined)', async () => {
  const order = await withMockPool(() => ({ rows: [{ id: 'o1', email_marketing_opt_out: false, variants: [] }] }), () => db.getOrderById('o1'));
  assert.strictEqual(order.emailMarketingOptOut, false);
});
