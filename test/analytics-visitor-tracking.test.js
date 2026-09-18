// FUNNEL ANALYTICS — visitor_id + POST /api/track din client (2026-09-18, FAZA 2). Acelasi tipar
// de sandbox ca test/analytics-client.test.js (extragere textuala, fara jsdom) — testeaza
// getOrCreateVisitorId (consimtamant, persistenta) si postTrackEvent/track (payload trimis catre
// /api/track, separare stricta fata de evenimentele doar-GA4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

function makeFakeWindow(overrides) {
  const store = {};
  const fakeWindow = Object.assign({
    NALUNA_GA_MEASUREMENT_ID: 'G-TEST123',
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    crypto: { randomUUID: () => '11111111-1111-1111-1111-111111111111' },
    dataLayer: undefined,
    gtag: undefined,
    fetch: undefined,
    NalunaAttribution: undefined
  }, overrides);
  return fakeWindow;
}

function loadAnalyticsIntoSandbox(fakeWindow, fakeDocument) {
  const doc = Object.assign({
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, addEventListener: () => {}, setAttribute: () => {} }),
    querySelector: () => null
  }, fakeDocument);
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return fakeWindow.NalunaAnalytics;
}

test('getOrCreateVisitorId: fara consimtamant -> null STRICT, NICIODATA un id creat/persistat', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.getOrCreateVisitorId(), null);
  assert.equal(win.localStorage.getItem('naluna_visitor_id'), null, 'nu trebuie scris niciun id in storage fara consimtamant');
});

test('getOrCreateVisitorId: consimtamant acordat -> creeaza un UUID (crypto.randomUUID) si il persista', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  const id = api.getOrCreateVisitorId();
  assert.equal(id, '11111111-1111-1111-1111-111111111111');
  assert.equal(win.localStorage.getItem('naluna_visitor_id'), id);
});

test('getOrCreateVisitorId: apeluri repetate returneaza ACELASI id (persistat, nu regenerat de fiecare data)', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  let calls = 0;
  win.crypto = { randomUUID: () => { calls += 1; return `id-${calls}`; } };
  const api = loadAnalyticsIntoSandbox(win);
  const first = api.getOrCreateVisitorId();
  const second = api.getOrCreateVisitorId();
  assert.equal(first, second);
  assert.equal(calls, 1, 'randomUUID trebuie apelat o singura data, nu la fiecare citire');
});

test('getOrCreateVisitorId: consimtamant refuzat DUPA ce un id fusese deja creat (schimbare de alegere) -> tot null, nu mai citeste id-ul vechi din storage', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  api.getOrCreateVisitorId(); // creeaza si persista un id
  win.localStorage.setItem('naluna_consent', 'denied');
  assert.equal(api.getOrCreateVisitorId(), null);
});

test('getOrCreateVisitorId: crypto.randomUUID absent (browser vechi/blocat) -> null, fara nicio eroare aruncata', () => {
  const win = makeFakeWindow({ crypto: undefined });
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => assert.equal(api.getOrCreateVisitorId(), null));
});

test('_postTrackEvent: fara consimtamant (deci fara visitorId) -> NU apeleaza fetch deloc', () => {
  const win = makeFakeWindow();
  let fetchCalled = false;
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  api._postTrackEvent('cta_clicked', { location: 'hero' });
  assert.equal(fetchCalled, false);
});

test('_postTrackEvent: cu consimtamant -> POST /api/track cu visitorId, eventName, si UTM din NalunaAttribution (mapate snake_case -> camelCase)', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  win.NalunaAttribution = { getStoredAttribution: () => ({ utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'launch_post_1', fbclid: 'abc123' }) };
  let capturedUrl, capturedOpts;
  win.fetch = (url, opts) => { capturedUrl = url; capturedOpts = opts; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  api._postTrackEvent('cta_clicked', { location: 'hero' });

  assert.equal(capturedUrl, '/api/track');
  assert.equal(capturedOpts.method, 'POST');
  assert.equal(capturedOpts.keepalive, true);
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.eventName, 'cta_clicked');
  assert.equal(body.visitorId, '11111111-1111-1111-1111-111111111111');
  assert.equal(body.utmSource, 'facebook');
  assert.equal(body.utmMedium, 'social');
  assert.equal(body.utmCampaign, 'launch_post_1');
  assert.equal(body.fbclid, 'abc123');
  assert.deepEqual(body.meta, { location: 'hero' });
  assert.equal(body.orderId, null);
});

test('_postTrackEvent: cheia rezervata "orderId" din extraParams merge in campul dedicat, NICIODATA in meta', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  let capturedOpts;
  win.fetch = (url, opts) => { capturedOpts = opts; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  api._postTrackEvent('form_completed', { plan: 'premium', orderId: 'order-123' });
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.orderId, 'order-123');
  assert.deepEqual(body.meta, { plan: 'premium' });
  assert.ok(!('orderId' in body.meta));
});

test('_postTrackEvent: NalunaAttribution absent (script lipseste/esueaza) -> body cu UTM-uri null, fara nicio eroare', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  let capturedOpts;
  win.fetch = (url, opts) => { capturedOpts = opts; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => api._postTrackEvent('cta_clicked', {}));
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.utmSource, null);
});

test('track(): un eveniment din FUNNEL_TRACKABLE_EVENTS declanseaza SI gtag SI fetch (/api/track) — ambele, independent', () => {
  // Consimtamantul se seteaza DUPA incarcarea sandbox-ului (nu la construirea window-ului) —
  // altfel initConsentUi() (rulat automat la incarcare, doc.readyState='complete') ar declansa
  // loadGtagIfNeeded(), care INLOCUIESTE window.gtag cu propriul stub de coada, mascand stub-ul
  // nostru de test (acelasi tipar ca test/analytics-client.test.js, onFormStarted).
  const win = makeFakeWindow();
  let fetchCalled = false;
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  const gtagCalls = [];
  win.gtag = () => { gtagCalls.push(1); };
  win.localStorage.setItem('naluna_consent', 'granted');
  api.track('cta_clicked', { location: 'hero' });
  assert.equal(gtagCalls.length, 1);
  assert.equal(fetchCalled, true);
});

test('track(): un eveniment care NU e in FUNNEL_TRACKABLE_EVENTS (ex. eveniment doar-GA4, precum "begin_checkout") declanseaza STRICT gtag, NICIODATA fetch (/api/track) — fara cerere HTTP suplimentara inutila', () => {
  const win = makeFakeWindow();
  let fetchCalled = false;
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  const gtagCalls = [];
  win.gtag = () => { gtagCalls.push(1); };
  win.localStorage.setItem('naluna_consent', 'granted');
  api.track('begin_checkout', { value: 15 });
  assert.equal(gtagCalls.length, 1);
  assert.equal(fetchCalled, false);
});

test('track(): "purchase" NU e niciodata in FUNNEL_TRACKABLE_EVENTS (server-side only, Measurement Protocol) — apelul client, daca ar exista vreodata, tot nu ar atinge /api/track', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  assert.ok(!api._FUNNEL_TRACKABLE_EVENTS.includes('purchase'));
});

test('track(): consimtamant refuzat -> NICIUN apel, nici gtag, nici fetch, pentru niciun eveniment', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'denied');
  let gtagCalled = false, fetchCalled = false;
  win.gtag = () => { gtagCalled = true; };
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const api = loadAnalyticsIntoSandbox(win);
  api.track('cta_clicked', { location: 'hero' });
  assert.equal(gtagCalled, false);
  assert.equal(fetchCalled, false);
});
