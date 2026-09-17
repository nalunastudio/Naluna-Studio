// Serviciul central de social publishing (lib/social/social-publisher.js) — verifica ORCHESTRAREA
// (Facebook + Instagram publicate in paralel, rezultat separat per platforma, un esec pe o
// platforma nu-l afecteaza pe celalalt), nu detaliile fiecarui adaptor (acelea sunt acoperite in
// social-facebook-adapter.test.js / social-instagram-adapter.test.js). fetch mockuit STRICT prin
// t.mock, niciodata cereri reale.
const test = require('node:test');
const assert = require('node:assert/strict');
const { publishPost, SUPPORTED_PLATFORMS } = require('../lib/social/social-publisher');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const noSleep = async () => {};

// Router de fetch fals, care raspunde diferit dupa host+path — simuleaza atat Graph API
// Facebook (graph.facebook.com) cat si Instagram (graph.instagram.com) in acelasi test.
function makeHappyPathFetch() {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname === '/v25.0/me') return jsonResponse(200, { id: 'PAGE123', name: 'Naluna Studio' });
      if (u.pathname === '/v25.0/PAGE123/photos') return jsonResponse(200, { id: 'PHOTO1', post_id: 'PAGE123_POST1' });
    }
    if (u.hostname === 'graph.instagram.com') {
      if (u.pathname === '/v25.0/me') return jsonResponse(200, { user_id: 'IG123', username: 'nalunastudioofficial' });
      if (u.pathname === '/v25.0/IG123/media') return jsonResponse(200, { id: 'CONTAINER1' });
      if (u.pathname === '/v25.0/CONTAINER1') return jsonResponse(200, { status_code: 'FINISHED' });
      if (u.pathname === '/v25.0/IG123/media_publish') return jsonResponse(200, { id: 'IGPOST1' });
    }
    throw new Error(`URL neasteptat in test: ${url}`);
  };
}

// Env-ul de test nu trebuie sa depinda de ce e setat local — izolam explicit cele doua
// variabile in jurul fiecarui test care le foloseste implicit (fara `credentials` explicit).
function withEnvCredentials(t, { facebook, instagram }) {
  const prevFb = process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
  const prevIg = process.env.META_INSTAGRAM_ACCESS_TOKEN;
  if (facebook === undefined) delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
  else process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = facebook;
  if (instagram === undefined) delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
  else process.env.META_INSTAGRAM_ACCESS_TOKEN = instagram;
  t.after(() => {
    if (prevFb === undefined) delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = prevFb;
    if (prevIg === undefined) delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
    else process.env.META_INSTAGRAM_ACCESS_TOKEN = prevIg;
  });
}

test('SUPPORTED_PLATFORMS: exact facebook + instagram (TikTok nu e adaugat inca)', () => {
  assert.deepEqual(SUPPORTED_PLATFORMS, ['facebook', 'instagram']);
});

test('publishPost: platforma necunoscuta arunca fara sa apeleze fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}));
  await assert.rejects(
    () => publishPost({ platforms: ['tiktok'], mediaType: 'image', mediaUrl: 'https://x/y' }),
    /platforma necunoscuta/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('publishPost: mediaType invalid arunca', async () => {
  await assert.rejects(
    () => publishPost({ platforms: ['facebook'], mediaType: 'audio', mediaUrl: 'https://x/y' }),
    /mediaType necunoscut/
  );
});

test('publishPost: mediaUrl lipsa arunca', async () => {
  await assert.rejects(
    () => publishPost({ platforms: ['facebook'], mediaType: 'image' }),
    /mediaUrl lipseste/
  );
});

test('publishPost: platforms gol arunca', async () => {
  await assert.rejects(
    () => publishPost({ platforms: [], mediaType: 'image', mediaUrl: 'https://x/y' }),
    /array nevid/
  );
});

test('publishPost: publica pe Facebook SI Instagram in paralel, rezultat de succes separat pentru fiecare', async (t) => {
  t.mock.method(globalThis, 'fetch', makeHappyPathFetch());
  const results = await publishPost({
    platforms: ['facebook', 'instagram'],
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    caption: 'Melodie noua pe Naluna!',
    credentials: { facebookAccessToken: 'fake-page-token', instagramAccessToken: 'fake-ig-token' },
    instagramPollOptions: { sleepFn: noSleep }
  });
  assert.deepEqual(results.facebook, { status: 'success', platform: 'facebook', postId: 'PAGE123_POST1' });
  assert.deepEqual(results.instagram, { status: 'success', platform: 'instagram', postId: 'IGPOST1', containerId: 'CONTAINER1' });
});

test('publishPost: doar Facebook cerut -> Instagram nu e nici macar apelat', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return makeHappyPathFetch()(url);
  });
  const results = await publishPost({
    platforms: ['facebook'],
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    credentials: { facebookAccessToken: 'fake-page-token' }
  });
  assert.equal(results.facebook.status, 'success');
  assert.equal(results.instagram, undefined);
  assert.ok(calls.every((u) => new URL(u).hostname === 'graph.facebook.com'));
});

test('publishPost: Instagram esueaza, Facebook tot reuseste — esecul unei platforme nu il afecteaza pe celalalt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname === 'graph.instagram.com') {
      return jsonResponse(400, { error: { message: 'Media container creation failed', code: 9004 } });
    }
    return makeHappyPathFetch()(url);
  });
  const results = await publishPost({
    platforms: ['facebook', 'instagram'],
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    credentials: { facebookAccessToken: 'fake-page-token', instagramAccessToken: 'fake-ig-token' },
    instagramPollOptions: { sleepFn: noSleep }
  });
  assert.equal(results.facebook.status, 'success');
  assert.equal(results.instagram.status, 'error');
  assert.equal(results.instagram.apiError.code, 9004);
});

test('publishPost: fara META_FACEBOOK_PAGE_ACCESS_TOKEN in env si fara override -> rezultat error, nu exceptie', async (t) => {
  withEnvCredentials(t, { facebook: undefined, instagram: 'fake-ig-token' });
  t.mock.method(globalThis, 'fetch', makeHappyPathFetch());
  const results = await publishPost({
    platforms: ['facebook', 'instagram'],
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    instagramPollOptions: { sleepFn: noSleep }
  });
  assert.equal(results.facebook.status, 'error');
  assert.match(results.facebook.message, /META_FACEBOOK_PAGE_ACCESS_TOKEN lipseste/);
  assert.equal(results.instagram.status, 'success');
});

test('publishPost: credentials explicit are prioritate fata de variabilele de mediu', async (t) => {
  withEnvCredentials(t, { facebook: 'env-token-nu-trebuie-folosit', instagram: 'env-ig-nu-trebuie-folosit' });
  let usedToken = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com' && u.pathname === '/v25.0/me') {
      usedToken = u.searchParams.get('access_token');
    }
    return makeHappyPathFetch()(url);
  });
  await publishPost({
    platforms: ['facebook'],
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    credentials: { facebookAccessToken: 'token-explicit-din-apel' }
  });
  assert.equal(usedToken, 'token-explicit-din-apel');
});
