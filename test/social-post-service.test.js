// Orchestrarea publicarii manuale (lib/social/social-post-service.js) — Etapa 2. db si
// publishPost sunt INJECTATE, deci testele folosesc mock-uri proprii (un "db" fals, in memorie,
// fara Postgres) pentru executeSocialPublish(), si fetch mockuit prin t.mock pentru testele care
// folosesc publishPost REAL (lib/social/social-publisher.js) — niciodata cereri reale catre Meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validatePublishRequest, validateScheduleRequest, executeSocialPublish, createScheduledPost } = require('../lib/social/social-post-service');
const { makeFakeSocialDb } = require('./helpers/fake-social-db');
const { publishPost } = require('../lib/social/social-publisher');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// "db" fals, in memorie — implementeaza STRICT cele 3 functii de care are nevoie
// executeSocialPublish(), cu acelasi contract (async, aceleasi forme de retur) ca db.js real.
function makeFakeDb() {
  const byIdempotencyKey = new Map();
  const byId = new Map();
  return {
    async getSocialPostByIdempotencyKey(key) {
      return byIdempotencyKey.get(key) || null;
    },
    async createSocialPostIfNew(post) {
      if (byIdempotencyKey.has(post.idempotencyKey)) return null;
      const row = { ...post, createdAt: new Date(), updatedAt: new Date(), publishedAt: null };
      byIdempotencyKey.set(post.idempotencyKey, row);
      byId.set(post.id, row);
      return row;
    },
    async finalizeSocialPost(id, patch) {
      const existing = byId.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: new Date() };
      byId.set(id, updated);
      byIdempotencyKey.set(existing.idempotencyKey, updated);
      return updated;
    },
    _byId: byId
  };
}

function callCountingPublishPost(impl) {
  let callCount = 0;
  const fn = async (...args) => {
    callCount++;
    return impl(...args);
  };
  fn.callCount = () => callCount;
  return fn;
}

const getPublicUrl = (key) => `https://media.nalunastudio.com/${key}`;

// ---------------- validatePublishRequest (sincron, fara I/O) ----------------

test('validatePublishRequest: cerere valida (fisier nou) -> null', () => {
  const err = validatePublishRequest({
    platforms: ['facebook'], mediaType: 'image', caption: 'Salut', idempotencyKey: 'a-valid-key-123', hasFile: true, mediaKey: undefined
  });
  assert.equal(err, null);
});

test('validatePublishRequest: cerere valida (mediaKey existent, fara fisier) -> null', () => {
  const err = validatePublishRequest({
    platforms: ['instagram'], mediaType: 'video', caption: undefined, idempotencyKey: 'a-valid-key-123', hasFile: false, mediaKey: 'social/existing.mp4'
  });
  assert.equal(err, null);
});

test('validatePublishRequest: platforma necunoscuta', () => {
  const err = validatePublishRequest({ platforms: ['tiktok'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true });
  assert.match(err, /Platforme invalide/);
});

test('validatePublishRequest: platforms gol', () => {
  const err = validatePublishRequest({ platforms: [], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true });
  assert.match(err, /Platforme invalide/);
});

test('validatePublishRequest: mediaType invalid', () => {
  const err = validatePublishRequest({ platforms: ['facebook'], mediaType: 'audio', idempotencyKey: 'a-valid-key-123', hasFile: true });
  assert.match(err, /mediaType/);
});

test('validatePublishRequest: idempotencyKey lipsa', () => {
  const err = validatePublishRequest({ platforms: ['facebook'], mediaType: 'image', idempotencyKey: undefined, hasFile: true });
  assert.match(err, /idempotencyKey/);
});

test('validatePublishRequest: idempotencyKey prea scurt', () => {
  const err = validatePublishRequest({ platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'short', hasFile: true });
  assert.match(err, /idempotencyKey/);
});

test('validatePublishRequest: caption prea lung (peste 2200)', () => {
  const err = validatePublishRequest({
    platforms: ['facebook'], mediaType: 'image', caption: 'x'.repeat(2201), idempotencyKey: 'a-valid-key-123', hasFile: true
  });
  assert.match(err, /Caption/);
});

test('validatePublishRequest: fara fisier SI fara mediaKey', () => {
  const err = validatePublishRequest({
    platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: false, mediaKey: undefined
  });
  assert.match(err, /media/);
});

// ---------------- executeSocialPublish — orchestrare, cu db fals + publishPost mockuit ----------------

test('executeSocialPublish: Facebook SI Instagram reusesc -> status published, ambele statusuri "success"', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async ({ platforms }) => {
    const results = {};
    if (platforms.includes('facebook')) results.facebook = { status: 'success', platform: 'facebook', postId: 'FBPOST1' };
    if (platforms.includes('instagram')) results.instagram = { status: 'success', platform: 'instagram', postId: 'IGPOST1', containerId: 'C1' };
    return results;
  });

  const { duplicate, post } = await executeSocialPublish({
    platforms: ['facebook', 'instagram'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: 'Salut',
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(duplicate, false);
  assert.equal(post.status, 'published');
  assert.equal(post.facebookStatus, 'success');
  assert.equal(post.facebookPostId, 'FBPOST1');
  assert.equal(post.instagramStatus, 'success');
  assert.equal(post.instagramPostId, 'IGPOST1');
  assert.equal(post.instagramContainerId, 'C1');
  assert.ok(post.publishedAt);
  assert.equal(publishPostMock.callCount(), 1);
});

test('executeSocialPublish: doar Instagram cerut -> facebookStatus ramane null', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async () => ({
    instagram: { status: 'success', platform: 'instagram', postId: 'IGPOST2', containerId: 'C2' }
  }));

  const { post } = await executeSocialPublish({
    platforms: ['instagram'], mediaType: 'video', mediaKey: 'social/x.mp4', caption: null,
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(post.status, 'published');
  assert.equal(post.facebookStatus, null);
  assert.equal(post.facebookPostId, null);
  assert.equal(post.instagramStatus, 'success');
});

test('executeSocialPublish: succes partial — Facebook reuseste, Instagram esueaza -> partially_failed', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async () => ({
    facebook: { status: 'success', platform: 'facebook', postId: 'FBPOST3' },
    instagram: { status: 'error', platform: 'instagram', message: 'Media container creation failed', apiError: { code: 9004 } }
  }));

  const { post } = await executeSocialPublish({
    platforms: ['facebook', 'instagram'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: 'Test',
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(post.status, 'partially_failed');
  assert.equal(post.facebookStatus, 'success');
  assert.equal(post.facebookError, null);
  assert.equal(post.instagramStatus, 'error');
  assert.equal(post.instagramError, 'Media container creation failed');
  assert.ok(post.publishedAt, 'publishedAt trebuie setat — a existat cel putin o reusita');
});

test('executeSocialPublish: esec total pe ambele platforme -> status failed, publishedAt ramane null', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async () => ({
    facebook: { status: 'error', platform: 'facebook', message: 'Invalid OAuth access token' },
    instagram: { status: 'error', platform: 'instagram', message: 'Token Instagram invalid' }
  }));

  const { post } = await executeSocialPublish({
    platforms: ['facebook', 'instagram'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: null,
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(post.status, 'failed');
  assert.equal(post.facebookError, 'Invalid OAuth access token');
  assert.equal(post.instagramError, 'Token Instagram invalid');
  assert.equal(post.publishedAt, null);
});

test('executeSocialPublish: idempotencyKey repetat -> a doua chemare NU republica (publishPost apelat o singura data)', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async () => ({
    facebook: { status: 'success', platform: 'facebook', postId: 'FBPOST4' }
  }));
  const idempotencyKey = randomUUID();
  const params = {
    platforms: ['facebook'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: 'Salut',
    idempotencyKey, db, publishPost: publishPostMock, getPublicUrl
  };

  const first = await executeSocialPublish(params);
  const second = await executeSocialPublish(params);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.post.id, first.post.id);
  assert.equal(second.post.facebookPostId, 'FBPOST4');
  assert.equal(publishPostMock.callCount(), 1, 'publishPost trebuie apelat STRICT o singura data pentru aceeasi idempotencyKey');
});

test('executeSocialPublish: doua idempotencyKey DIFERITE publica de fiecare data (nu blocheaza postari legitime noi)', async () => {
  const db = makeFakeDb();
  const publishPostMock = callCountingPublishPost(async () => ({
    facebook: { status: 'success', platform: 'facebook', postId: 'FBPOSTX' }
  }));

  await executeSocialPublish({
    platforms: ['facebook'], mediaType: 'image', mediaKey: 'social/a.jpg', caption: 'Unu',
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });
  await executeSocialPublish({
    platforms: ['facebook'], mediaType: 'image', mediaKey: 'social/b.jpg', caption: 'Doi',
    idempotencyKey: randomUUID(), db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(publishPostMock.callCount(), 2);
});

test('executeSocialPublish: cursa pierduta la INSERT (createSocialPostIfNew intoarce null desi verificarea rapida nu gasise nimic) -> nu republica', async () => {
  const idempotencyKey = randomUUID();
  const winningRow = {
    id: randomUUID(), idempotencyKey, status: 'published', platforms: ['facebook'],
    mediaType: 'image', mediaKey: 'social/x.jpg', caption: null,
    facebookStatus: 'success', facebookPostId: 'FBWINNER', facebookError: null,
    instagramStatus: null, instagramPostId: null, instagramContainerId: null, instagramError: null,
    publishedAt: new Date()
  };
  let earlyCheckDone = false;
  const db = {
    async getSocialPostByIdempotencyKey() {
      // prima verificare (inainte de INSERT) nu gaseste nimic inca — a doua (dupa conflict)
      // gaseste randul "castigator" al cererii concurente.
      if (!earlyCheckDone) { earlyCheckDone = true; return null; }
      return winningRow;
    },
    async createSocialPostIfNew() {
      return null; // conflict — alta cerere concurenta a castigat cursa
    },
    async finalizeSocialPost() {
      throw new Error('NU trebuie apelat — nu am castigat cursa, nimic de finalizat aici');
    }
  };
  const publishPostMock = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'NU-AR-TREBUI-FOLOSIT' } }));

  const { duplicate, post } = await executeSocialPublish({
    platforms: ['facebook'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: null,
    idempotencyKey, db, publishPost: publishPostMock, getPublicUrl
  });

  assert.equal(duplicate, true);
  assert.equal(post.facebookPostId, 'FBWINNER');
  assert.equal(publishPostMock.callCount(), 0, 'cererea care a pierdut cursa nu trebuie sa mai publice deloc');
});

// ---------------- integrare cu publishPost REAL (lib/social/social-publisher.js), fetch mockuit ----------------

test('executeSocialPublish + publishPost real: lant complet Facebook+Instagram cu fetch mockuit, persistenta corecta', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname === '/v25.0/me') return jsonResponse(200, { id: 'PAGE1', name: 'Naluna Studio' });
      if (u.pathname === '/v25.0/PAGE1/photos') return jsonResponse(200, { id: 'P1', post_id: 'PAGE1_POST1' });
    }
    if (u.hostname === 'graph.instagram.com') {
      if (u.pathname === '/v25.0/me') return jsonResponse(200, { user_id: 'IG1', username: 'nalunastudioofficial' });
      if (u.pathname === '/v25.0/IG1/media') return jsonResponse(200, { id: 'CONT1' });
      if (u.pathname === '/v25.0/CONT1') return jsonResponse(200, { status_code: 'FINISHED' });
      if (u.pathname === '/v25.0/IG1/media_publish') return jsonResponse(200, { id: 'IGPOST9' });
    }
    throw new Error(`URL neasteptat: ${url}`);
  });

  const db = makeFakeDb();
  const { post } = await executeSocialPublish({
    platforms: ['facebook', 'instagram'], mediaType: 'image', mediaKey: 'social/real-chain.jpg', caption: 'Lansare Naluna!',
    idempotencyKey: randomUUID(), db, publishPost,
    getPublicUrl: (key) => `https://media.nalunastudio.com/${key}`,
    credentials: { facebookAccessToken: 'fake-page-token', instagramAccessToken: 'fake-ig-token' }
  });

  assert.equal(post.status, 'published');
  assert.equal(post.facebookPostId, 'PAGE1_POST1');
  assert.equal(post.instagramPostId, 'IGPOST9');
  assert.equal(post.instagramContainerId, 'CONT1');
});

// ---------------- validateScheduleRequest (Etapa 3) ----------------

test('validateScheduleRequest: cerere valida, scheduledAt in viitor -> null', () => {
  const err = validateScheduleRequest({
    platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true,
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  assert.equal(err, null);
});

test('validateScheduleRequest: mosteneste toate validarile comune (platforme invalide)', () => {
  const err = validateScheduleRequest({
    platforms: ['tiktok'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true,
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  assert.match(err, /Platforme invalide/);
});

test('validateScheduleRequest: scheduledAt lipsa', () => {
  const err = validateScheduleRequest({
    platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true, scheduledAt: null
  });
  assert.match(err, /scheduledAt/);
});

test('validateScheduleRequest: scheduledAt invalid (data nevalida)', () => {
  const err = validateScheduleRequest({
    platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true, scheduledAt: new Date('not-a-date')
  });
  assert.match(err, /scheduledAt/);
});

test('validateScheduleRequest: scheduledAt in TRECUT e respins', () => {
  const err = validateScheduleRequest({
    platforms: ['facebook'], mediaType: 'image', idempotencyKey: 'a-valid-key-123', hasFile: true,
    scheduledAt: new Date(Date.now() - 60 * 1000)
  });
  assert.match(err, /viitor/);
});

// ---------------- createScheduledPost (Etapa 3) ----------------

test('createScheduledPost: creeaza randul cu status "scheduled" si nextAttemptAt = scheduledAt, fara sa publice nimic', async () => {
  const db = makeFakeSocialDb();
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);

  const { duplicate, post } = await createScheduledPost({
    platforms: ['facebook', 'instagram'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: 'Salut',
    idempotencyKey: randomUUID(), scheduledAt, db
  });

  assert.equal(duplicate, false);
  assert.equal(post.status, 'scheduled');
  assert.equal(post.scheduledAt.getTime(), scheduledAt.getTime());
  assert.equal(post.nextAttemptAt.getTime(), scheduledAt.getTime());
  assert.equal(post.facebookStatus, null);
  assert.equal(post.instagramStatus, null);
});

test('createScheduledPost: idempotencyKey repetat -> NU creeaza o a doua programare', async () => {
  const db = makeFakeSocialDb();
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
  const idempotencyKey = randomUUID();
  const params = { platforms: ['facebook'], mediaType: 'image', mediaKey: 'social/x.jpg', caption: null, idempotencyKey, scheduledAt, db };

  const first = await createScheduledPost(params);
  const second = await createScheduledPost(params);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.post.id, first.post.id);
});
