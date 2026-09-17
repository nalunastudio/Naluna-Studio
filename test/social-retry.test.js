// Logica pura de retry/backoff (lib/social/social-retry.js) — sursa unica a regulilor de
// clasificare eroare, backoff, plafon de incercari si calcul de status, folosita IDENTIC de
// publicarea manuala si de worker. Fara I/O, fara mock-uri de fetch/DB necesare.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PLATFORM_ATTEMPTS,
  classifyMetaError,
  computeBackoffMs,
  computeNextAttempt,
  computeOverallStatus,
  computeAttemptPatch
} = require('../lib/social/social-retry');

function freshPost(platforms) {
  return {
    platforms,
    facebookStatus: null, facebookPostId: null, facebookError: null, facebookAttemptCount: 0, facebookLastAttemptAt: null, facebookNextAttemptAt: null,
    instagramStatus: null, instagramPostId: null, instagramContainerId: null, instagramError: null, instagramAttemptCount: 0, instagramLastAttemptAt: null, instagramNextAttemptAt: null,
    publishedAt: null
  };
}

// ---------------- classifyMetaError ----------------

test('classifyMetaError: fara raspuns structurat (eroare de retea) -> retryable', () => {
  assert.equal(classifyMetaError(null), 'retryable');
  assert.equal(classifyMetaError(undefined), 'retryable');
});

test('classifyMetaError: is_transient=true -> retryable indiferent de cod', () => {
  assert.equal(classifyMetaError({ code: 999, is_transient: true }), 'retryable');
});

test('classifyMetaError: coduri documentate ca permanente (100, 190, 200, 10, 9004)', () => {
  assert.equal(classifyMetaError({ code: 100 }), 'permanent');
  assert.equal(classifyMetaError({ code: 190 }), 'permanent');
  assert.equal(classifyMetaError({ code: 200 }), 'permanent');
  assert.equal(classifyMetaError({ code: 10 }), 'permanent');
  assert.equal(classifyMetaError({ code: 9004 }), 'permanent');
});

test('classifyMetaError: coduri documentate ca temporare (rate limiting)', () => {
  for (const code of [1, 2, 4, 17, 32, 613]) {
    assert.equal(classifyMetaError({ code }), 'retryable');
  }
});

test('classifyMetaError: cod necunoscut -> implicit retryable (mai sigur decat abandon prematur)', () => {
  assert.equal(classifyMetaError({ code: 424242 }), 'retryable');
});

// ---------------- computeBackoffMs / computeNextAttempt ----------------

test('computeBackoffMs: creste exponential, plafonat la 60 minute', () => {
  assert.equal(computeBackoffMs(1), 2 * 60 * 1000);
  assert.equal(computeBackoffMs(2), 4 * 60 * 1000);
  assert.equal(computeBackoffMs(3), 8 * 60 * 1000);
  assert.equal(computeBackoffMs(4), 16 * 60 * 1000);
  assert.equal(computeBackoffMs(5), 32 * 60 * 1000);
  assert.equal(computeBackoffMs(10), 60 * 60 * 1000, 'plafonat la 60 minute, nu creste nelimitat');
});

test('computeNextAttempt: eroare retryable, sub plafon -> data viitoare calculata din backoff', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  const next = computeNextAttempt({ attemptCount: 1, apiError: { code: 4 }, now });
  assert.equal(next.getTime(), now.getTime() + computeBackoffMs(1));
});

test('computeNextAttempt: eroare permanenta -> null, indiferent de attemptCount', () => {
  assert.equal(computeNextAttempt({ attemptCount: 1, apiError: { code: 100 } }), null);
});

test('computeNextAttempt: attemptCount >= MAX_PLATFORM_ATTEMPTS -> null, nu se mai reincearca automat', () => {
  assert.equal(computeNextAttempt({ attemptCount: MAX_PLATFORM_ATTEMPTS, apiError: { code: 4 } }), null);
  assert.equal(computeNextAttempt({ attemptCount: MAX_PLATFORM_ATTEMPTS + 3, apiError: null }), null);
});

// ---------------- computeOverallStatus ----------------

test('computeOverallStatus: toate null (nicio incercare inca) -> scheduled', () => {
  assert.equal(computeOverallStatus({ platforms: ['facebook', 'instagram'], facebookStatus: null, instagramStatus: null }), 'scheduled');
});

test('computeOverallStatus: toate success -> published', () => {
  assert.equal(computeOverallStatus({ platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'success' }), 'published');
});

test('computeOverallStatus: un succes, un esec -> partially_failed', () => {
  assert.equal(computeOverallStatus({ platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'error' }), 'partially_failed');
  assert.equal(computeOverallStatus({ platforms: ['facebook', 'instagram'], facebookStatus: 'error', instagramStatus: 'success' }), 'partially_failed');
});

test('computeOverallStatus: toate esec -> failed', () => {
  assert.equal(computeOverallStatus({ platforms: ['facebook', 'instagram'], facebookStatus: 'error', instagramStatus: 'error' }), 'failed');
});

test('computeOverallStatus: o singura platforma ceruta (Instagram) — Facebook irelevant pentru decizie', () => {
  assert.equal(computeOverallStatus({ platforms: ['instagram'], facebookStatus: null, instagramStatus: 'success' }), 'published');
  assert.equal(computeOverallStatus({ platforms: ['instagram'], facebookStatus: null, instagramStatus: 'error' }), 'failed');
});

// ---------------- computeAttemptPatch ----------------

test('computeAttemptPatch: Facebook reuseste, Instagram esueaza (ambele atacate) -> partially_failed, doar Instagram capata next_attempt', () => {
  const post = freshPost(['facebook', 'instagram']);
  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['facebook', 'instagram'],
    results: {
      facebook: { status: 'success', postId: 'FB1' },
      instagram: { status: 'error', message: 'Media container creation failed', apiError: { code: 4 } }
    }
  });
  assert.equal(patch.status, 'partially_failed');
  assert.equal(patch.facebookStatus, 'success');
  assert.equal(patch.facebookPostId, 'FB1');
  assert.equal(patch.facebookNextAttemptAt, null, 'Facebook a reusit, NU trebuie reincercat');
  assert.equal(patch.instagramStatus, 'error');
  assert.ok(patch.instagramNextAttemptAt instanceof Date, 'Instagram a esuat cu eroare retryable, trebuie programat pentru retry');
  assert.equal(patch.instagramAttemptCount, 1);
  assert.ok(patch.publishedAt, 'a existat un succes partial, publishedAt trebuie setat');
});

test('computeAttemptPatch: retry ulterior ataca STRICT Instagram (Facebook deja success, neatins)', () => {
  const post = freshPost(['facebook', 'instagram']);
  post.facebookStatus = 'success';
  post.facebookPostId = 'FB1';
  post.facebookAttemptCount = 1;
  post.instagramStatus = 'error';
  post.instagramAttemptCount = 1;

  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['instagram'], // worker-ul NU mai ataca facebook, deja reusise
    results: { instagram: { status: 'success', postId: 'IG1', containerId: 'C1' } }
  });

  assert.equal(patch.facebookStatus, 'success');
  assert.equal(patch.facebookPostId, 'FB1');
  assert.equal(patch.facebookAttemptCount, 1, 'neschimbat — Facebook nu a fost atins de acest retry');
  assert.equal(patch.instagramStatus, 'success');
  assert.equal(patch.instagramPostId, 'IG1');
  assert.equal(patch.instagramAttemptCount, 2);
  assert.equal(patch.status, 'published');
});

test('computeAttemptPatch: Instagram reuseste, Facebook esueaza (simetric)', () => {
  const post = freshPost(['facebook', 'instagram']);
  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['facebook', 'instagram'],
    results: {
      facebook: { status: 'error', message: 'Invalid OAuth access token', apiError: { code: 190 } },
      instagram: { status: 'success', postId: 'IG2', containerId: 'C2' }
    }
  });
  assert.equal(patch.status, 'partially_failed');
  assert.equal(patch.instagramStatus, 'success');
  assert.equal(patch.instagramNextAttemptAt, null);
  assert.equal(patch.facebookStatus, 'error');
  assert.equal(patch.facebookNextAttemptAt, null, 'cod 190 e clasificat permanent — nu se reincearca automat');
});

test('computeAttemptPatch: retry ulterior ataca STRICT Facebook (Instagram deja success, neatins)', () => {
  const post = freshPost(['facebook', 'instagram']);
  post.instagramStatus = 'success';
  post.instagramPostId = 'IG2';
  post.instagramContainerId = 'C2';
  post.facebookStatus = 'error';
  post.facebookAttemptCount = 1;

  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['facebook'],
    results: { facebook: { status: 'success', postId: 'FB3' } }
  });

  assert.equal(patch.instagramStatus, 'success');
  assert.equal(patch.instagramPostId, 'IG2');
  assert.equal(patch.instagramContainerId, 'C2');
  assert.equal(patch.instagramAttemptCount, 0, 'neschimbat — Instagram nu a fost atins de acest retry');
  assert.equal(patch.facebookStatus, 'success');
  assert.equal(patch.status, 'published');
});

test('computeAttemptPatch: esec total, eroare retryable -> failed, ambele programate pentru retry', () => {
  const post = freshPost(['facebook', 'instagram']);
  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['facebook', 'instagram'],
    results: {
      facebook: { status: 'error', message: 'temporary service issue', apiError: { code: 2 } },
      instagram: { status: 'error', message: 'temporary service issue', apiError: { code: 2 } }
    }
  });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.publishedAt, null, 'niciun succes, publishedAt ramane null');
  assert.ok(patch.facebookNextAttemptAt instanceof Date);
  assert.ok(patch.instagramNextAttemptAt instanceof Date);
  assert.ok(patch.nextAttemptAt instanceof Date, 'nivelul postarii ia cel mai apropiat retry dintre cele doua');
});

test('computeAttemptPatch: MAX_PLATFORM_ATTEMPTS atins -> nextAttemptAt null, nu se mai reincearca automat', () => {
  const post = freshPost(['facebook']);
  post.facebookStatus = 'error';
  post.facebookAttemptCount = MAX_PLATFORM_ATTEMPTS - 1; // urmeaza sa devina a 5-a incercare

  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['facebook'],
    results: { facebook: { status: 'error', message: 'still failing', apiError: { code: 2 } } }
  });

  assert.equal(patch.facebookAttemptCount, MAX_PLATFORM_ATTEMPTS);
  assert.equal(patch.facebookNextAttemptAt, null);
  assert.equal(patch.nextAttemptAt, null, 'nicio platforma mai are retry programat -> postarea nu mai e preluata automat');
  assert.equal(patch.status, 'failed');
});

test('computeAttemptPatch: platforma neselectata pentru aceasta postare ramane explicit null in patch', () => {
  const post = freshPost(['instagram']);
  const patch = computeAttemptPatch({
    post, attemptedPlatforms: ['instagram'],
    results: { instagram: { status: 'success', postId: 'IG9' } }
  });
  assert.equal(patch.facebookStatus, null);
  assert.equal(patch.facebookPostId, null);
  assert.equal(patch.facebookAttemptCount, 0);
  assert.equal(patch.facebookNextAttemptAt, null);
});
