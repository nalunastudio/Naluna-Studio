// lib/recovery-emails/eligibility.js — logica pura de selectie/deduplicare per client si de
// verificare a starii inainte de trimitere. Fara Postgres/Resend — fixtures simple.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickWinnersPerClient, checkSendEligibility, isWithinCooldown } = require('../lib/recovery-emails/eligibility');

// ---- pickWinnersPerClient (cerinta 5 — dedup per client, regula deterministica) ----

test('pickWinnersPerClient: checkout_recovery castiga INTOTDEAUNA fata de preview_recovery pentru acelasi client, indiferent de ordinea in array', () => {
  const candidates = [
    { emailKey: 'a@x.com', orderId: 'o1', notificationType: 'preview_recovery', qualifyingAt: '2026-09-25T12:00:00Z' },
    { emailKey: 'a@x.com', orderId: 'o2', notificationType: 'checkout_recovery', qualifyingAt: '2026-09-25T08:00:00Z' }
  ];
  const winners = pickWinnersPerClient(candidates);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].orderId, 'o2');
  assert.equal(winners[0].notificationType, 'checkout_recovery');
});

test('pickWinnersPerClient: la ACELASI tip, castiga qualifyingAt cel mai RECENT', () => {
  const candidates = [
    { emailKey: 'a@x.com', orderId: 'older', notificationType: 'preview_recovery', qualifyingAt: '2026-09-20T00:00:00Z' },
    { emailKey: 'a@x.com', orderId: 'newer', notificationType: 'preview_recovery', qualifyingAt: '2026-09-24T00:00:00Z' }
  ];
  const winners = pickWinnersPerClient(candidates);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].orderId, 'newer');
});

test('pickWinnersPerClient: clienti DIFERITI -> cate un castigator FIECARE, niciun amestec intre clienti', () => {
  const candidates = [
    { emailKey: 'a@x.com', orderId: 'o1', notificationType: 'preview_recovery', qualifyingAt: '2026-09-25T00:00:00Z' },
    { emailKey: 'b@x.com', orderId: 'o2', notificationType: 'checkout_recovery', qualifyingAt: '2026-09-25T00:00:00Z' }
  ];
  const winners = pickWinnersPerClient(candidates);
  assert.equal(winners.length, 2);
  const ids = winners.map((w) => w.orderId).sort();
  assert.deepEqual(ids, ['o1', 'o2']);
});

test('pickWinnersPerClient: client cu 4 comenzi candidate (acelasi tip) -> STRICT UN castigator (nu 4 remindere aproape simultan)', () => {
  const candidates = ['o1', 'o2', 'o3', 'o4'].map((id, i) => ({
    emailKey: 'a@x.com', orderId: id, notificationType: 'preview_recovery',
    qualifyingAt: new Date(Date.now() - i * 3600 * 1000).toISOString()
  }));
  const winners = pickWinnersPerClient(candidates);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].orderId, 'o1', 'cel mai recent (i=0) trebuie sa castige');
});

test('pickWinnersPerClient: array gol -> array gol', () => {
  assert.deepEqual(pickWinnersPerClient([]), []);
});

// ---- checkSendEligibility (cerinta 4 — reverifica starea REALA inainte de trimitere) ----

const noopFalse = async () => false;
const noopTrue = async () => true;

test('checkSendEligibility: comanda PLATITA -> skipped_paid, INDIFERENT de tipul notificarii', async () => {
  const order = { paidAt: new Date(), status: 'ready', email: 'a@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'checkout_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'skipped_paid');
});

test('checkSendEligibility: comanda ANONIMIZATA -> skipped_not_eligible', async () => {
  const order = { paidAt: null, anonymizedAt: new Date(), email: 'deleted@x.invalid', status: 'ready' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.reason, 'skipped_not_eligible');
});

test('checkSendEligibility: status generation_failed -> skipped_not_eligible', async () => {
  const order = { paidAt: null, status: 'generation_failed', email: 'a@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.reason, 'skipped_not_eligible');
});

test('checkSendEligibility: email de test (echipa) -> skipped_test', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'team@naluna.dev' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopTrue, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.reason, 'skipped_test');
});

test('checkSendEligibility: email suprimat (bounce/complaint) -> skipped_suppressed, pentru ORICE tip (inclusiv preview_ready operational)', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'bounced@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_ready', isTestEmailFn: noopFalse, isSuppressedFn: noopTrue, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.reason, 'skipped_suppressed');
});

test('checkSendEligibility: dezabonat de la marketing -> skipped_unsubscribed STRICT pentru preview_recovery/checkout_recovery', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'unsub@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopTrue });
  assert.equal(result.reason, 'skipped_unsubscribed');
});

test('checkSendEligibility: dezabonarea de marketing NU afecteaza preview_ready (operational, livrare de acces)', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'unsub@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'preview_ready', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopTrue });
  assert.equal(result.ok, true, 'preview_ready nu trebuie NICIODATA blocat de suppression-ul de marketing');
});

test('checkSendEligibility: comanda eligibila reala (client NU a refuzat, soft opt-in) -> ok:true', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'ok@x.com', emailMarketingOptOut: false };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, true);
});

// ---- PECR soft opt-in (2026-09-25, corectie) — emailMarketingOptOut ----

test('checkSendEligibility: client a REFUZAT explicit la colectarea emailului (emailMarketingOptOut=true) -> skipped_opted_out, pentru preview_recovery/checkout_recovery', async () => {
  for (const notificationType of ['preview_recovery', 'checkout_recovery']) {
    const order = { paidAt: null, status: 'preview_ready', checkoutCreatedAt: new Date(), email: 'refused@x.com', emailMarketingOptOut: true };
    const result = await checkSendEligibility({ order, notificationType, isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'skipped_opted_out');
  }
});

test('checkSendEligibility: comanda ISTORICA (emailMarketingOptOut=null, dinainte de mecanismul de opt-out) -> skipped_opted_out, NICIODATA tratata ca "nu a refuzat"', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'old@x.com', emailMarketingOptOut: null };
  const result = await checkSendEligibility({ order, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'skipped_opted_out');
});

test('checkSendEligibility: comanda cu emailMarketingOptOut UNDEFINED (camp lipsa din payload, acelasi caz ca null) -> skipped_opted_out', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'missing@x.com' };
  const result = await checkSendEligibility({ order, notificationType: 'checkout_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'skipped_opted_out');
});

test('checkSendEligibility: emailMarketingOptOut=true NU afecteaza deloc emailul OPERATIONAL preview_ready — livrarea de acces ramane neschimbata', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'refused@x.com', emailMarketingOptOut: true };
  const result = await checkSendEligibility({ order, notificationType: 'preview_ready', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, true, 'preview_ready trebuie sa ramana STRICT operational, independent de preferinta de marketing');
});

test('checkSendEligibility: emailMarketingOptOut=null (comanda istorica) NU afecteaza deloc emailul OPERATIONAL preview_ready', async () => {
  const order = { paidAt: null, status: 'preview_ready', email: 'old@x.com', emailMarketingOptOut: null };
  const result = await checkSendEligibility({ order, notificationType: 'preview_ready', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.ok, true);
});

test('checkSendEligibility: comanda inexistenta (null, ex. stearsa) -> skipped_not_eligible, fara sa arunce', async () => {
  const result = await checkSendEligibility({ order: null, notificationType: 'preview_recovery', isTestEmailFn: noopFalse, isSuppressedFn: noopFalse, isMarketingSuppressedFn: noopFalse });
  assert.equal(result.reason, 'skipped_not_eligible');
});

// ---- isWithinCooldown ----

test('isWithinCooldown: fara trimitere anterioara -> false (niciodata in cooldown)', () => {
  assert.equal(isWithinCooldown(null, 24), false);
});

test('isWithinCooldown: trimitere acum 1h, cooldown 24h -> true', () => {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000);
  assert.equal(isWithinCooldown(oneHourAgo, 24), true);
});

test('isWithinCooldown: trimitere acum 25h, cooldown 24h -> false (fereastra a trecut)', () => {
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  assert.equal(isWithinCooldown(past, 24), false);
});
