// Persistenta/reinnoirea tokenului Instagram (lib/social/instagram-token-store.js) — fake-db
// in memorie (fara Postgres), fetch mockuit prin t.mock (fara cereri reale catre Meta).
// Acopera: bootstrap din env, prioritatea DB fata de env, refresh reusit, refresh esuat
// pastreaza tokenul vechi, protectie impotriva a doua reinnoiri concurente, si — critic —
// ca tokenul nu ajunge NICIODATA in mesajele de eroare persistate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeSocialDb } = require('./helpers/fake-social-db');
const { getCurrentInstagramAccessToken, refreshAndPersistInstagramToken, REFRESH_LOCK_MINUTES } = require('../lib/social/instagram-token-store');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function withEnvToken(t, value) {
  const prev = process.env.META_INSTAGRAM_ACCESS_TOKEN;
  if (value === undefined) delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
  else process.env.META_INSTAGRAM_ACCESS_TOKEN = value;
  t.after(() => {
    if (prev === undefined) delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
    else process.env.META_INSTAGRAM_ACCESS_TOKEN = prev;
  });
}

test('getCurrentInstagramAccessToken: DB gol -> bootstrap din META_INSTAGRAM_ACCESS_TOKEN (env)', async (t) => {
  withEnvToken(t, 'env-bootstrap-token');
  const db = makeFakeSocialDb();
  const token = await getCurrentInstagramAccessToken(db);
  assert.equal(token, 'env-bootstrap-token');
});

test('getCurrentInstagramAccessToken: token existent in DB are PRIORITATE fata de env', async (t) => {
  withEnvToken(t, 'env-bootstrap-token');
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('db-persisted-token', new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));

  const token = await getCurrentInstagramAccessToken(db);
  assert.equal(token, 'db-persisted-token');
});

test('getCurrentInstagramAccessToken: nici DB, nici env -> null (nu arunca)', async (t) => {
  withEnvToken(t, undefined);
  const db = makeFakeSocialDb();
  const token = await getCurrentInstagramAccessToken(db);
  assert.equal(token, null);
});

test('refreshAndPersistInstagramToken: reusit -> token nou persistat, expiresAt calculat corect', async (t) => {
  withEnvToken(t, 'old-bootstrap-token');
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).includes('graph.instagram.com'));
    assert.ok(String(url).includes('grant_type=ig_refresh_token'));
    return jsonResponse(200, { access_token: 'new-refreshed-token', token_type: 'bearer', expires_in: 5184000 });
  });
  const db = makeFakeSocialDb();
  const before = Date.now();

  const result = await refreshAndPersistInstagramToken(db);

  assert.equal(result.ok, true);
  const state = await db.getInstagramTokenState();
  assert.equal(state.accessToken, 'new-refreshed-token');
  assert.ok(state.expiresAt.getTime() > before + 5000 * 1000);
  assert.equal(state.consecutiveRefreshFailures, 0);
  assert.equal(state.lastRefreshError, null);
});

test('refreshAndPersistInstagramToken: esuat -> tokenul VECHI ramane neschimbat, doar eroarea e inregistrata', async (t) => {
  withEnvToken(t, undefined);
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('still-valid-old-token', new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'This request requires the token to be at least 24 hours old', code: 4901 } }));

  const result = await refreshAndPersistInstagramToken(db);

  assert.equal(result.ok, false);
  const state = await db.getInstagramTokenState();
  assert.equal(state.accessToken, 'still-valid-old-token', 'tokenul valid existent NU trebuie atins la un refresh esuat');
  assert.equal(state.consecutiveRefreshFailures, 1);
  assert.match(state.lastRefreshError, /24 hours old/);
});

test('refreshAndPersistInstagramToken: esecuri consecutive incrementeaza corect contorul', async (t) => {
  withEnvToken(t, 'bootstrap-token');
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(500, { error: { message: 'temporary Meta outage', code: 2 } }));
  const db = makeFakeSocialDb();

  await refreshAndPersistInstagramToken(db);
  await refreshAndPersistInstagramToken(db);
  const state = await db.getInstagramTokenState();
  assert.equal(state.consecutiveRefreshFailures, 2);
});

test('doua reinnoiri CONCURENTE — a doua e sarita (lock activ), NU apeleaza fetch a doua oara', async (t) => {
  withEnvToken(t, 'bootstrap-token');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { access_token: 'refreshed-once', token_type: 'bearer', expires_in: 5184000 }));
  const db = makeFakeSocialDb();

  // simuleaza cursa: primul refresh castiga lock-ul dar nu s-a terminat inca (nu apelam finalizarea)
  const claimed1 = await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  assert.ok(claimed1, 'primul apel trebuie sa castige lock-ul');

  const result2 = await refreshAndPersistInstagramToken(db); // incearca sa reinnoiasca cat lock-ul primului e inca activ

  assert.equal(result2.skipped, true);
  assert.equal(fetchMock.mock.callCount(), 0, 'al doilea refresh nu trebuie sa apeleze deloc Graph API cat timp lock-ul e activ');
});

test('lock-ul expirat permite un refresh ulterior (nu ramane blocat permanent dupa un crash)', async (t) => {
  withEnvToken(t, 'bootstrap-token');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { access_token: 'refreshed-after-stale-lock', token_type: 'bearer', expires_in: 5184000 }));
  const db = makeFakeSocialDb();

  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES); // un "worker" anterior preia lock-ul...
  // ...si crapa inainte sa-l elibereze — simulam trecerea timpului, backdatand lock-ul direct
  // in starea fake-ului, dincolo de fereastra REFRESH_LOCK_MINUTES.
  db._tokenState.refreshClaimedAt = new Date(Date.now() - (REFRESH_LOCK_MINUTES + 1) * 60 * 1000);

  const result = await refreshAndPersistInstagramToken(db);

  assert.equal(result.ok, true, 'un lock expirat NU trebuie sa blocheze un refresh ulterior la nesfarsit');
  assert.equal(fetchMock.mock.callCount(), 1);
  const state = await db.getInstagramTokenState();
  assert.equal(state.accessToken, 'refreshed-after-stale-lock');
});

test('SECURITATE: tokenul NU apare niciodata in mesajul de eroare persistat, chiar daca Meta ar ecoua parametri', async (t) => {
  withEnvToken(t, undefined);
  const db = makeFakeSocialDb();
  await db.claimInstagramTokenRefresh(REFRESH_LOCK_MINUTES);
  await db.recordInstagramTokenRefreshSuccess('super-secret-token-should-never-leak', new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'Invalid parameter', code: 100 } }));

  await refreshAndPersistInstagramToken(db);

  const state = await db.getInstagramTokenState();
  assert.ok(!state.lastRefreshError.includes('super-secret-token-should-never-leak'), 'mesajul de eroare NU trebuie sa contina niciodata tokenul folosit in cerere');
});
