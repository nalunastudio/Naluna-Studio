// Workerul de scheduling/retry (lib/social/social-worker.js) — foloseste fake-social-db.js
// (replica fidela a contractului atomic claim/recover din db.js) + publishPost mockuit, fara
// Postgres real si fara cereri reale catre Meta. Acopera: nu ruleaza inainte de termen, ruleaza
// dupa termen, doua workers nu publica aceeasi postare, recuperare dupa restart/crash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { makeFakeSocialDb } = require('./helpers/fake-social-db');
const { processDueSocialPosts, runWorkerTick, STALE_PUBLISHING_MINUTES } = require('../lib/social/social-worker');

const getPublicUrl = (key) => `https://media.nalunastudio.com/${key}`;
const getInstagramAccessToken = async () => 'fake-ig-token';

function callCountingPublishPost(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return impl(args);
  };
  fn.calls = calls;
  return fn;
}

async function scheduleFixture(db, { platforms = ['facebook', 'instagram'], nextAttemptAt }) {
  return db.createSocialPostIfNew({
    id: randomUUID(), idempotencyKey: randomUUID(), status: 'scheduled',
    platforms, mediaType: 'image', mediaKey: 'social/x.jpg', caption: 'Test',
    scheduledAt: nextAttemptAt, nextAttemptAt
  });
}

test('processDueSocialPosts: o postare programata pentru VIITOR nu ruleaza inca', async () => {
  const db = makeFakeSocialDb();
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const post = await scheduleFixture(db, { nextAttemptAt: future });
  const publishPost = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'X' }, instagram: { status: 'success', postId: 'Y' } }));

  const processed = await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  assert.equal(processed, 0);
  assert.equal(publishPost.calls.length, 0);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'scheduled', 'postarea trebuie sa ramana neatinsa pana la termen');
});

test('processDueSocialPosts: o postare cu termenul TRECUT ruleaza', async () => {
  const db = makeFakeSocialDb();
  const past = new Date(Date.now() - 1000);
  const post = await scheduleFixture(db, { nextAttemptAt: past });
  const publishPost = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'X' }, instagram: { status: 'success', postId: 'Y' } }));

  const processed = await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  assert.equal(processed, 1);
  assert.equal(publishPost.calls.length, 1);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'published');
});

test('doua "workers" concurenti nu publica ACEEASI postare de doua ori', async () => {
  const db = makeFakeSocialDb();
  const past = new Date(Date.now() - 1000);
  await scheduleFixture(db, { nextAttemptAt: past });
  const publishPost = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'X' }, instagram: { status: 'success', postId: 'Y' } }));

  const [p1, p2] = await Promise.all([
    processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken }),
    processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken })
  ]);

  assert.equal(p1 + p2, 1, 'o singura postare scadenta exista — impreuna, cei doi workeri trebuie sa o proceseze EXACT o singura data');
  assert.equal(publishPost.calls.length, 1, 'publishPost nu trebuie apelat de doua ori pentru aceeasi postare');
});

test('doi workeri impart corect o COADA de mai multe postari scadente — fiecare procesata o singura data', async () => {
  const db = makeFakeSocialDb();
  const past = new Date(Date.now() - 1000);
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const p = await scheduleFixture(db, { nextAttemptAt: past });
    ids.push(p.id);
  }
  const publishPost = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'X' }, instagram: { status: 'success', postId: 'Y' } }));

  const [p1, p2] = await Promise.all([
    processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken }),
    processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken })
  ]);

  assert.equal(p1 + p2, 6);
  assert.equal(publishPost.calls.length, 6);
  for (const id of ids) {
    const fresh = await db.getSocialPostById(id);
    assert.equal(fresh.status, 'published');
  }
});

test('recuperare dupa restart: o postare ramasa "publishing" stale devine din nou eligibila si e procesata', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  // simuleaza un worker anterior care a preluat randul si a picat inainte sa scrie rezultatul
  const claimed = await db.claimDueSocialPost();
  assert.equal(claimed.id, post.id);
  db._posts.get(post.id).publishingClaimedAt = new Date(Date.now() - (STALE_PUBLISHING_MINUTES + 1) * 60 * 1000);

  const publishPost = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'X' }, instagram: { status: 'success', postId: 'Y' } }));

  const result = await runWorkerTick({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  assert.equal(result.recoveredCount, 1);
  assert.equal(result.processed, 1);
  assert.equal(publishPost.calls.length, 1);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'published');
});

test('recuperare: un rand "publishing" INCA in fereastra normala NU e atins (nu e stale)', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  await db.claimDueSocialPost(); // status -> 'publishing', publishingClaimedAt = acum (proaspat)

  const recovered = await db.recoverStalePublishingSocialPosts(STALE_PUBLISHING_MINUTES);

  assert.equal(recovered.length, 0);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'publishing', 'un claim proaspat nu trebuie recuperat — inca se poate procesa legitim');
});

test('Facebook success + Instagram failure la o postare scadenta -> partially_failed, doar Instagram ramane scadent pentru retry', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  const publishPost = callCountingPublishPost(async () => ({
    facebook: { status: 'success', postId: 'FB1' },
    instagram: { status: 'error', message: 'temp failure', apiError: { code: 2 } }
  }));

  await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'partially_failed');
  assert.equal(fresh.facebookStatus, 'success');
  assert.equal(fresh.instagramStatus, 'error');
  assert.ok(fresh.instagramNextAttemptAt);
  assert.equal(fresh.facebookNextAttemptAt, null);
});

test('retry ulterior ataca STRICT Instagram — Facebook NU e republicat (publishPost primeste doar platforms:["instagram"])', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 5000) });
  const firstAttempt = callCountingPublishPost(async () => ({
    facebook: { status: 'success', postId: 'FB1' },
    instagram: { status: 'error', message: 'temp', apiError: { code: 2 } }
  }));
  await processDueSocialPosts({ db, publishPost: firstAttempt, getPublicUrl, getInstagramAccessToken });

  // forteaza retry-ul sa fie scadent ACUM (in loc sa astepte backoff-ul real)
  db._posts.get(post.id).instagramNextAttemptAt = new Date(Date.now() - 1000);
  db._posts.get(post.id).nextAttemptAt = new Date(Date.now() - 1000);

  const retryAttempt = callCountingPublishPost(async () => ({ instagram: { status: 'success', postId: 'IG1', containerId: 'C1' } }));
  await processDueSocialPosts({ db, publishPost: retryAttempt, getPublicUrl, getInstagramAccessToken });

  assert.equal(retryAttempt.calls.length, 1);
  assert.deepEqual(retryAttempt.calls[0].platforms, ['instagram'], 'retry-ul trebuie sa atace STRICT Instagram, niciodata Facebook (deja reusise)');
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'published');
  assert.equal(fresh.facebookPostId, 'FB1', 'ID-ul Facebook din prima incercare ramane neschimbat');
});

test('Instagram success + Facebook failure (simetric) -> retry ulterior ataca STRICT Facebook', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 5000) });
  const firstAttempt = callCountingPublishPost(async () => ({
    facebook: { status: 'error', message: 'temp', apiError: { code: 2 } },
    instagram: { status: 'success', postId: 'IG1', containerId: 'C1' }
  }));
  await processDueSocialPosts({ db, publishPost: firstAttempt, getPublicUrl, getInstagramAccessToken });

  db._posts.get(post.id).facebookNextAttemptAt = new Date(Date.now() - 1000);
  db._posts.get(post.id).nextAttemptAt = new Date(Date.now() - 1000);

  const retryAttempt = callCountingPublishPost(async () => ({ facebook: { status: 'success', postId: 'FB2' } }));
  await processDueSocialPosts({ db, publishPost: retryAttempt, getPublicUrl, getInstagramAccessToken });

  assert.deepEqual(retryAttempt.calls[0].platforms, ['facebook']);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'published');
  assert.equal(fresh.instagramPostId, 'IG1');
});

test('max retries: dupa MAX_PLATFORM_ATTEMPTS esecuri consecutive, postarea nu mai e preluata automat', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { platforms: ['facebook'], nextAttemptAt: new Date(Date.now() - 1000) });
  const failingPublish = callCountingPublishPost(async () => ({ facebook: { status: 'error', message: 'still down', apiError: { code: 2 } } }));

  for (let i = 0; i < 5; i++) {
    await processDueSocialPosts({ db, publishPost: failingPublish, getPublicUrl, getInstagramAccessToken });
    const row = db._posts.get(post.id);
    if (row.facebookNextAttemptAt) row.nextAttemptAt = row.facebookNextAttemptAt = new Date(Date.now() - 1000); // forteaza urmatorul retry sa fie scadent imediat, fara sa astepte backoff-ul real
  }

  assert.equal(failingPublish.calls.length, 5, 'exact MAX_PLATFORM_ATTEMPTS incercari, nu mai multe automat');
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.facebookNextAttemptAt, null);
  assert.equal(fresh.nextAttemptAt, null);

  // un tick suplimentar NU mai gaseste nimic de procesat (plafon atins)
  const processedAfter = await processDueSocialPosts({ db, publishPost: failingPublish, getPublicUrl, getInstagramAccessToken });
  assert.equal(processedAfter, 0);
});

test('backoff: fiecare esec succesiv programeaza urmatoarea incercare tot mai tarziu', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { platforms: ['facebook'], nextAttemptAt: new Date(Date.now() - 1000) });
  const failingPublish = callCountingPublishPost(async () => ({ facebook: { status: 'error', message: 'down', apiError: { code: 2 } } }));

  const delays = [];
  let lastNextAttempt = null;
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    await processDueSocialPosts({ db, publishPost: failingPublish, getPublicUrl, getInstagramAccessToken });
    const row = db._posts.get(post.id);
    delays.push(new Date(row.facebookNextAttemptAt).getTime() - before);
    row.nextAttemptAt = row.facebookNextAttemptAt = new Date(Date.now() - 1000);
  }

  assert.ok(delays[1] > delays[0], 'a doua asteptare trebuie sa fie mai lunga decat prima (backoff exponential)');
  assert.ok(delays[2] > delays[1], 'a treia asteptare trebuie sa fie mai lunga decat a doua');
});

test('anulare scheduled: o postare anulata inainte de termen nu mai e preluata de worker', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  const cancelled = await db.cancelScheduledSocialPost(post.id);
  assert.equal(cancelled.status, 'cancelled');

  const publishPost = callCountingPublishPost(async () => { throw new Error('NU TREBUIE APELAT'); });
  const processed = await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  assert.equal(processed, 0);
  assert.equal(publishPost.calls.length, 0);
});

test('anulare: o postare care deja a inceput publicarea NU mai poate fi anulata', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  await db.claimDueSocialPost(); // status -> 'publishing'

  const result = await db.cancelScheduledSocialPost(post.id);
  assert.equal(result, null, 'nu poate fi anulata dupa ce publicarea a inceput deja');
});

test('retry manual: rearmeaza STRICT platforma ceruta, care avea status error', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  const publishPost = callCountingPublishPost(async () => ({
    facebook: { status: 'success', postId: 'FB1' },
    instagram: { status: 'error', message: 'temp', apiError: { code: 2 } }
  }));
  await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });
  // epuizeaza (simulat) plafonul automat pentru instagram, ca sa confirmam ca retry-ul MANUAL il ocoleste
  db._posts.get(post.id).instagramNextAttemptAt = null;
  db._posts.get(post.id).nextAttemptAt = null;
  db._posts.get(post.id).instagramAttemptCount = 999;

  const rearmed = await db.retrySocialPostPlatform(post.id, 'instagram');
  assert.ok(rearmed, 'retry manual trebuie sa reuseasca desi plafonul automat fusese deja atins');
  assert.ok(rearmed.instagramNextAttemptAt);

  const retryAttempt = callCountingPublishPost(async () => ({ instagram: { status: 'success', postId: 'IG-manual' } }));
  const processed = await processDueSocialPosts({ db, publishPost: retryAttempt, getPublicUrl, getInstagramAccessToken });

  assert.equal(processed, 1);
  assert.deepEqual(retryAttempt.calls[0].platforms, ['instagram']);
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.status, 'published');
});

test('backoff MIXT: Facebook inca in backoff, Instagram rearmat manual pentru acum — postarea e preluata, dar ATACA STRICT Instagram', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 5000) });
  const bothFail = callCountingPublishPost(async () => ({
    facebook: { status: 'error', message: 'temp', apiError: { code: 2 } },
    instagram: { status: 'error', message: 'temp', apiError: { code: 2 } }
  }));
  await processDueSocialPosts({ db, publishPost: bothFail, getPublicUrl, getInstagramAccessToken });

  const row = db._posts.get(post.id);
  assert.ok(row.facebookNextAttemptAt.getTime() > Date.now(), 'backoff-ul Facebook trebuie sa fie inca in viitor');

  // admin rearmeaza MANUAL doar Instagram, imediat — Facebook ramane cu backoff-ul lui neatins
  await db.retrySocialPostPlatform(post.id, 'instagram');
  assert.ok(row.facebookNextAttemptAt.getTime() > Date.now(), 'retrySocialPostPlatform("instagram") nu trebuie sa atinga backoff-ul Facebook');

  const secondAttempt = callCountingPublishPost(async () => ({ instagram: { status: 'success', postId: 'IG-manual' } }));
  const processed = await processDueSocialPosts({ db, publishPost: secondAttempt, getPublicUrl, getInstagramAccessToken });

  assert.equal(processed, 1, 'postarea trebuie preluata (next_attempt_at la nivel de postare era scadent, datorita Instagram)');
  assert.equal(secondAttempt.calls.length, 1);
  assert.deepEqual(secondAttempt.calls[0].platforms, ['instagram'], 'NU trebuie sa atace Facebook — backoff-ul lui inca nu a expirat, desi postarea insasi era "scadenta" datorita Instagram');
  const fresh = await db.getSocialPostById(post.id);
  assert.equal(fresh.facebookAttemptCount, 1, 'Facebook trebuie sa ramana la o singura incercare (prima), neatins de acest retry');
  assert.equal(fresh.instagramStatus, 'success');
});

test('retry manual: cerere pentru o platforma care NU are status error e refuzata (null)', async () => {
  const db = makeFakeSocialDb();
  const post = await scheduleFixture(db, { nextAttemptAt: new Date(Date.now() - 1000) });
  const publishPost = callCountingPublishPost(async () => ({
    facebook: { status: 'success', postId: 'FB1' },
    instagram: { status: 'success', postId: 'IG1', containerId: 'C1' }
  }));
  await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });

  const result = await db.retrySocialPostPlatform(post.id, 'facebook');
  assert.equal(result, null, 'Facebook deja a reusit — nu exista ce sa reincerce');
});
