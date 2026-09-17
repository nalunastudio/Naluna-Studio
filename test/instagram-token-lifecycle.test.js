// Decizia de refresh/alerta (lib/social/instagram-token-lifecycle.js) — fake-db + fetch mockuit
// (pentru refresh-ul real din spate) + sendAlertEmail injectat (mock, niciodata Resend real).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeSocialDb } = require('./helpers/fake-social-db');
const {
  shouldRefresh, isDangerouslyCloseToExpiry, shouldSendAlert, checkInstagramTokenLifecycle,
  REFRESH_MARGIN_DAYS, ALERT_THRESHOLD_DAYS, ALERT_RESEND_COOLDOWN_HOURS
} = require('../lib/social/instagram-token-lifecycle');
const { REFRESH_LOCK_MINUTES } = require('../lib/social/instagram-token-store');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ---------------- functii pure ----------------

test('shouldRefresh: fara expiresAt cunoscuta -> true (incearca, Meta decide)', () => {
  assert.equal(shouldRefresh({ expiresAt: null }), true);
  assert.equal(shouldRefresh(null), true);
});

test(`shouldRefresh: expira in mai putin de ${REFRESH_MARGIN_DAYS} zile -> true`, () => {
  assert.equal(shouldRefresh({ expiresAt: daysFromNow(REFRESH_MARGIN_DAYS - 1) }), true);
});

test(`shouldRefresh: expira in mai mult de ${REFRESH_MARGIN_DAYS} zile -> false`, () => {
  assert.equal(shouldRefresh({ expiresAt: daysFromNow(REFRESH_MARGIN_DAYS + 5) }), false);
});

test(`isDangerouslyCloseToExpiry: sub ${ALERT_THRESHOLD_DAYS} zile -> true`, () => {
  assert.equal(isDangerouslyCloseToExpiry({ expiresAt: daysFromNow(ALERT_THRESHOLD_DAYS - 1) }), true);
  assert.equal(isDangerouslyCloseToExpiry({ expiresAt: daysFromNow(ALERT_THRESHOLD_DAYS + 1) }), false);
});

test('shouldSendAlert: aproape de expirare, nicio alerta trimisa inca -> true', () => {
  assert.equal(shouldSendAlert({ expiresAt: daysFromNow(1), lastAlertSentAt: null }), true);
});

test(`shouldSendAlert: alerta deja trimisa recent (< ${ALERT_RESEND_COOLDOWN_HOURS}h) -> false (nu retrimite)`, () => {
  const sentRecently = new Date(Date.now() - (ALERT_RESEND_COOLDOWN_HOURS - 1) * 60 * 60 * 1000);
  assert.equal(shouldSendAlert({ expiresAt: daysFromNow(1), lastAlertSentAt: sentRecently }), false);
});

test('shouldSendAlert: alerta trimisa demult -> true (poate retrimite)', () => {
  const sentLongAgo = new Date(Date.now() - (ALERT_RESEND_COOLDOWN_HOURS + 1) * 60 * 60 * 1000);
  assert.equal(shouldSendAlert({ expiresAt: daysFromNow(1), lastAlertSentAt: sentLongAgo }), true);
});

test('shouldSendAlert: nu e inca aproape de expirare -> false, indiferent de istoricul de alerte', () => {
  assert.equal(shouldSendAlert({ expiresAt: daysFromNow(30), lastAlertSentAt: null }), false);
});

// ---------------- checkInstagramTokenLifecycle (integrare, fetch mockuit) ----------------

test('checkInstagramTokenLifecycle: nu e inca momentul de refresh -> nu atinge fetch, nu alerteaza', async (t) => {
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('valid-token', daysFromNow(REFRESH_MARGIN_DAYS + 10));

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('NU TREBUIE APELAT'); });
  let alertCalls = 0;
  const sendAlertEmail = async () => { alertCalls++; };

  const result = await checkInstagramTokenLifecycle({ db, sendAlertEmail });

  assert.equal(result.refreshed, false);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(alertCalls, 0);
});

test('checkInstagramTokenLifecycle: refresh reusit -> niciо alerta trimisa', async (t) => {
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('old-token', daysFromNow(REFRESH_MARGIN_DAYS - 1)); // in fereastra de refresh

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { access_token: 'new-token', token_type: 'bearer', expires_in: 5184000 }));
  let alertCalls = 0;
  const sendAlertEmail = async () => { alertCalls++; };

  const result = await checkInstagramTokenLifecycle({ db, sendAlertEmail });

  assert.equal(result.ok, true);
  assert.equal(alertCalls, 0);
  const state = await db.getInstagramTokenState();
  assert.equal(state.accessToken, 'new-token');
});

test('checkInstagramTokenLifecycle: refresh esuat SI aproape periculos de expirare -> trimite alerta, FARA tokenul in obiectul transmis', async (t) => {
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('super-secret-current-token', daysFromNow(ALERT_THRESHOLD_DAYS - 1)); // deja periculos de aproape

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'temporary outage', code: 2 } }));
  const alertCalls = [];
  const sendAlertEmail = async (state) => { alertCalls.push(state); };

  const result = await checkInstagramTokenLifecycle({ db, sendAlertEmail });

  assert.equal(result.ok, false);
  assert.equal(alertCalls.length, 1);
  assert.ok(!('accessToken' in alertCalls[0]), 'obiectul trimis catre sendAlertEmail NU trebuie sa contina accessToken');
  assert.match(alertCalls[0].lastRefreshError, /temporary outage/);
  const finalState = await db.getInstagramTokenState();
  assert.equal(finalState.lastAlertSentAt !== null, true);
});

test('checkInstagramTokenLifecycle: refresh esuat dar INCA departe de expirare -> nu alerteaza', async (t) => {
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('token', daysFromNow(REFRESH_MARGIN_DAYS - 1)); // in fereastra de refresh, dar NU aproape de expirare (mai are > ALERT_THRESHOLD_DAYS)

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'temporary', code: 2 } }));
  let alertCalls = 0;
  const sendAlertEmail = async () => { alertCalls++; };

  await checkInstagramTokenLifecycle({ db, sendAlertEmail });

  assert.equal(alertCalls, 0, 'esecul de refresh singur nu justifica o alerta cat timp mai e timp destul pana la expirare');
});

test('checkInstagramTokenLifecycle: alerta NU se retrimite la fiecare tick cat timp cooldown-ul nu a trecut', async (t) => {
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('token', daysFromNow(ALERT_THRESHOLD_DAYS - 1));

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'still down', code: 2 } }));
  let alertCalls = 0;
  const sendAlertEmail = async () => { alertCalls++; };

  await checkInstagramTokenLifecycle({ db, sendAlertEmail }); // primul tick: trimite alerta
  // backdateaza expiresAt inapoi ca refresh-ul sa fie din nou "due" la al doilea tick (nu s-a schimbat, tot esueaza)
  await checkInstagramTokenLifecycle({ db, sendAlertEmail }); // al doilea tick, imediat dupa — cooldown inca activ

  assert.equal(alertCalls, 1, 'a doua verificare, imediat dupa prima, nu trebuie sa retrimita alerta');
});
