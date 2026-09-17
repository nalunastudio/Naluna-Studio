// Adaptorul Instagram (lib/social/instagram-adapter.js) — Instagram API with Instagram Login,
// STRICT pe host graph.instagram.com. Teste cu fetch mockuit prin t.mock (node:test), niciodata
// cereri reale. waitForContainerReady() foloseste sleepFn injectat, ca testele sa nu astepte
// cu adevarat intervalMs intre verificari de status.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getInstagramUserId,
  createMediaContainer,
  getContainerStatus,
  waitForContainerReady,
  publishContainer,
  publishToInstagram,
  refreshInstagramAccessToken,
  InstagramApiError,
  BASE_URL
} = require('../lib/social/instagram-adapter');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const noSleep = async () => {};

test('getInstagramUserId: intoarce user_id + username din /me (host graph.instagram.com)', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(url.startsWith(`${BASE_URL}/me?`));
    assert.ok(url.includes('graph.instagram.com'));
    return jsonResponse(200, { user_id: 'IG123', username: 'nalunastudioofficial' });
  });
  const result = await getInstagramUserId({ accessToken: 'fake-ig-token' });
  assert.deepEqual(result, { igUserId: 'IG123', username: 'nalunastudioofficial' });
});

test('getInstagramUserId: arunca InstagramApiError cand Meta raspunde cu error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(401, { error: { message: 'Token Instagram invalid sau expirat', code: 190 } }));
  await assert.rejects(
    () => getInstagramUserId({ accessToken: 'expired' }),
    (err) => {
      assert.ok(err instanceof InstagramApiError);
      assert.equal(err.apiError.code, 190);
      return true;
    }
  );
});

test('createMediaContainer: imagine — POST /{igUserId}/media cu image_url + caption, fara media_type', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${BASE_URL}/IG123/media`);
    const params = Object.fromEntries(options.body);
    assert.equal(params.image_url, 'https://media.nalunastudio.com/preview.jpg');
    assert.equal(params.caption, 'Melodie noua!');
    assert.equal(params.video_url, undefined);
    assert.equal(params.media_type, undefined);
    return jsonResponse(200, { id: 'CONTAINER1' });
  });
  const result = await createMediaContainer({
    accessToken: 'fake-ig-token', igUserId: 'IG123', mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg', caption: 'Melodie noua!'
  });
  assert.deepEqual(result, { containerId: 'CONTAINER1' });
});

test('createMediaContainer: video — POST /{igUserId}/media cu video_url', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const params = Object.fromEntries(options.body);
    assert.equal(params.video_url, 'https://media.nalunastudio.com/clip.mp4');
    assert.equal(params.image_url, undefined);
    return jsonResponse(200, { id: 'CONTAINER2' });
  });
  const result = await createMediaContainer({
    accessToken: 'fake-ig-token', igUserId: 'IG123', mediaType: 'video',
    mediaUrl: 'https://media.nalunastudio.com/clip.mp4'
  });
  assert.deepEqual(result, { containerId: 'CONTAINER2' });
});

test('createMediaContainer: mediaType necunoscut arunca fara sa apeleze fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}));
  await assert.rejects(
    () => createMediaContainer({ accessToken: 'x', igUserId: 'IG123', mediaType: 'carousel', mediaUrl: 'https://x/y' }),
    /mediaType necunoscut/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('getContainerStatus: citeste status_code din GET /{containerId}?fields=status_code', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${BASE_URL}/CONTAINER1?fields=status_code&access_token=fake-ig-token`);
    return jsonResponse(200, { id: 'CONTAINER1', status_code: 'IN_PROGRESS' });
  });
  const status = await getContainerStatus({ accessToken: 'fake-ig-token', containerId: 'CONTAINER1' });
  assert.equal(status, 'IN_PROGRESS');
});

test('waitForContainerReady: intoarce imediat cand primul status e FINISHED', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { status_code: 'FINISHED' }));
  const status = await waitForContainerReady({ accessToken: 'x', containerId: 'C1', sleepFn: noSleep });
  assert.equal(status, 'FINISHED');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('waitForContainerReady: mai multe IN_PROGRESS inainte de FINISHED, fara asteptare reala', async (t) => {
  let call = 0;
  const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { status_code: statuses[call++] }));
  const status = await waitForContainerReady({ accessToken: 'x', containerId: 'C1', maxAttempts: 5, sleepFn: noSleep });
  assert.equal(status, 'FINISHED');
  assert.equal(call, 3);
});

test('waitForContainerReady: ERROR opreste imediat, fara sa mai reincerce', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { status_code: 'ERROR' }));
  await assert.rejects(
    () => waitForContainerReady({ accessToken: 'x', containerId: 'C1', maxAttempts: 5, sleepFn: noSleep }),
    (err) => {
      assert.ok(err instanceof InstagramApiError);
      assert.match(err.message, /ERROR/);
      return true;
    }
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('waitForContainerReady: EXPIRED opreste imediat', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { status_code: 'EXPIRED' }));
  await assert.rejects(() => waitForContainerReady({ accessToken: 'x', containerId: 'C1', sleepFn: noSleep }), /EXPIRED/);
});

test('waitForContainerReady: ramane IN_PROGRESS peste maxAttempts -> arunca eroare de timeout', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { status_code: 'IN_PROGRESS' }));
  await assert.rejects(
    () => waitForContainerReady({ accessToken: 'x', containerId: 'C1', maxAttempts: 3, sleepFn: noSleep }),
    /timpul alocat/
  );
  assert.equal(fetchMock.mock.callCount(), 3);
});

test('publishContainer: POST /{igUserId}/media_publish cu creation_id', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${BASE_URL}/IG123/media_publish`);
    const params = Object.fromEntries(options.body);
    assert.equal(params.creation_id, 'CONTAINER1');
    return jsonResponse(200, { id: 'IGPOST1' });
  });
  const result = await publishContainer({ accessToken: 'x', igUserId: 'IG123', containerId: 'CONTAINER1' });
  assert.deepEqual(result, { postId: 'IGPOST1' });
});

test('publishToInstagram: orchestreaza container -> asteapta FINISHED -> publish', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === '/v25.0/IG123/media') return jsonResponse(200, { id: 'CONTAINER1' });
    if (u.pathname === '/v25.0/CONTAINER1') return jsonResponse(200, { status_code: 'FINISHED' });
    if (u.pathname === '/v25.0/IG123/media_publish') return jsonResponse(200, { id: 'IGPOST1' });
    throw new Error(`URL neasteptat in test: ${url}`);
  });
  const result = await publishToInstagram({
    accessToken: 'fake-ig-token', igUserId: 'IG123', mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg', caption: 'Salut',
    pollOptions: { sleepFn: noSleep }
  });
  assert.deepEqual(result, { postId: 'IGPOST1', containerId: 'CONTAINER1' });
  assert.deepEqual(calls, ['/v25.0/IG123/media', '/v25.0/CONTAINER1', '/v25.0/IG123/media_publish']);
});

test('refreshInstagramAccessToken: GET refresh_access_token?grant_type=ig_refresh_token', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${BASE_URL}/refresh_access_token?grant_type=ig_refresh_token&access_token=old-long-lived-token`);
    return jsonResponse(200, { access_token: 'new-long-lived-token', token_type: 'bearer', expires_in: 5184000 });
  });
  const result = await refreshInstagramAccessToken({ accessToken: 'old-long-lived-token' });
  assert.deepEqual(result, { accessToken: 'new-long-lived-token', expiresIn: 5184000, tokenType: 'bearer' });
});

test('refreshInstagramAccessToken: token prea nou (< 24h) — Meta raspunde cu eroare, propagata ca InstagramApiError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'This request requires the token to be at least 24 hours old', code: 4901 } }));
  await assert.rejects(
    () => refreshInstagramAccessToken({ accessToken: 'too-fresh-token' }),
    (err) => {
      assert.ok(err instanceof InstagramApiError);
      assert.equal(err.apiError.code, 4901);
      return true;
    }
  );
});
