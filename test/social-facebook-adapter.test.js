// Adaptorul Facebook (lib/social/facebook-adapter.js) — teste STRICT cu fetch mockuit prin
// t.mock (node:test), niciodata cereri reale catre Graph API. Fiecare test seteaza propriul
// mock, restaurat automat de node:test la finalul testului.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFacebookPageId,
  publishToFacebookPage,
  FacebookApiError,
  BASE_URL
} = require('../lib/social/facebook-adapter');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('getFacebookPageId: intoarce id + name din /me', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(url.startsWith(`${BASE_URL}/me?`));
    assert.ok(url.includes('access_token=fake-page-token'));
    return jsonResponse(200, { id: 'PAGE123', name: 'Naluna Studio' });
  });
  const result = await getFacebookPageId({ accessToken: 'fake-page-token' });
  assert.deepEqual(result, { pageId: 'PAGE123', name: 'Naluna Studio' });
});

test('getFacebookPageId: arunca FacebookApiError cu mesajul Meta cand raspunsul contine error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'Invalid OAuth access token', code: 190 } }));
  await assert.rejects(
    () => getFacebookPageId({ accessToken: 'expired-token' }),
    (err) => {
      assert.ok(err instanceof FacebookApiError);
      assert.equal(err.message, 'Invalid OAuth access token');
      assert.equal(err.apiError.code, 190);
      return true;
    }
  );
});

test('getFacebookPageId: fara accessToken arunca imediat, fara sa apeleze fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}));
  await assert.rejects(() => getFacebookPageId({}), /accessToken lipseste/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('publishToFacebookPage: imagine — POST catre /{pageId}/photos cu url + caption', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${BASE_URL}/PAGE123/photos`);
    assert.equal(options.method, 'POST');
    const params = Object.fromEntries(options.body);
    assert.equal(params.url, 'https://media.nalunastudio.com/preview.jpg');
    assert.equal(params.caption, 'Melodie noua pe Naluna!');
    assert.equal(params.access_token, 'fake-page-token');
    return jsonResponse(200, { id: 'PHOTO1', post_id: 'PAGE123_POST1' });
  });
  const result = await publishToFacebookPage({
    accessToken: 'fake-page-token',
    pageId: 'PAGE123',
    mediaType: 'image',
    mediaUrl: 'https://media.nalunastudio.com/preview.jpg',
    caption: 'Melodie noua pe Naluna!'
  });
  assert.equal(result.postId, 'PAGE123_POST1');
});

test('publishToFacebookPage: video — POST catre /{pageId}/videos cu file_url + description', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${BASE_URL}/PAGE123/videos`);
    const params = Object.fromEntries(options.body);
    assert.equal(params.file_url, 'https://media.nalunastudio.com/clip.mp4');
    assert.equal(params.description, 'Cadou video Naluna');
    assert.equal(params.url, undefined);
    return jsonResponse(200, { id: 'VIDEO1' });
  });
  const result = await publishToFacebookPage({
    accessToken: 'fake-page-token',
    pageId: 'PAGE123',
    mediaType: 'video',
    mediaUrl: 'https://media.nalunastudio.com/clip.mp4',
    caption: 'Cadou video Naluna'
  });
  assert.equal(result.postId, 'VIDEO1');
});

test('publishToFacebookPage: mediaType necunoscut arunca fara sa apeleze fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}));
  await assert.rejects(
    () => publishToFacebookPage({ accessToken: 'x', pageId: 'PAGE123', mediaType: 'carousel', mediaUrl: 'https://x/y' }),
    /mediaType necunoscut/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('publishToFacebookPage: eroare Graph API pastreaza detaliile in apiError, niciodata tokenul', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: { message: 'Unsupported post request', code: 100 } }));
  await assert.rejects(
    () => publishToFacebookPage({ accessToken: 'fake-page-token', pageId: 'PAGE123', mediaType: 'image', mediaUrl: 'https://x/y' }),
    (err) => {
      assert.ok(err instanceof FacebookApiError);
      assert.equal(err.apiError.code, 100);
      assert.ok(!String(err.message).includes('fake-page-token'));
      return true;
    }
  );
});
