// CONSENT REVOCATION (2026-09-18, corectie ceruta explicit) — verifica exact scenariul: un
// vizitator ACCEPTA analytics (primeste visitor_id, gtag.js se incarca), apoi REVOCA din link-ul
// "Cookie settings" (butonul "Refuz" al bannerului, redeschis). Acelasi tipar de sandbox ca
// test/analytics-client.test.js, dar cu un DOM fake mai complet (elemente cu addEventListener/
// click() REALE) — necesar ca sa putem declansa efectiv butoanele bannerului, nu doar sa citim
// textul lor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

function makeFakeElement() {
  const listeners = {};
  return {
    style: {},
    children: [],
    _listeners: listeners,
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener(type, handler) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((h) => h !== handler);
    },
    click() { (listeners.click || []).forEach((h) => h({ preventDefault() {} })); },
    setAttribute() {},
    appendChild(child) { this.children.push(child); },
    get textContent() { return this._text || ''; },
    set textContent(v) { this._text = v; }
  };
}

function makeFakeWindow(overrides) {
  const store = {};
  return Object.assign({
    NALUNA_GA_MEASUREMENT_ID: 'G-TEST123',
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    crypto: { randomUUID: () => 'visitor-uuid-1' },
    dataLayer: undefined,
    gtag: undefined,
    fetch: () => Promise.resolve({})
  }, overrides);
}

function loadAnalyticsIntoSandbox(fakeWindow) {
  const elementsById = {};
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: (id) => elementsById[id] || null,
    createElement: () => {
      const el = makeFakeElement();
      const origAppend = el.appendChild.bind(el);
      return el;
    },
    querySelector: () => null
  };
  // renderBanner() foloseste document.getElementById(BANNER_ID) DOAR ca sa verifice daca deja
  // exista (evita dubla injectare) — nu are nevoie sa gaseasca elementul creat, deci nu simulam
  // inregistrarea in elementsById; testele apeleaza direct butoanele returnate mai jos.
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return fakeWindow.NalunaAnalytics;
}

// Acceseaza direct butoanele bannerului declansand renderBanner() prin banner-ul deja randat la
// incarcarea sandbox-ului (initConsentUi ruleaza automat, doc.readyState='complete') — extragem
// referintele reale la accept/reject simuland document.body.appendChild ca sa le capturam.
function loadWithCapturedBannerButtons(fakeWindow) {
  const captured = { accept: null, reject: null };
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: {
      appendChild: (el) => {
        // bannerul e un <div> cu doi copii: [textEl, btnWrap]; btnWrap are [acceptBtn, rejectBtn]
        if (el.children && el.children.length === 2 && el.children[1].children && el.children[1].children.length === 2) {
          captured.accept = el.children[1].children[0];
          captured.reject = el.children[1].children[1];
        }
      }
    },
    getElementById: () => null, // banner-ul "nu exista inca" -> renderBanner() ruleaza mereu
    createElement: makeFakeElement,
    querySelector: () => null
  };
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return { api: fakeWindow.NalunaAnalytics, buttons: captured };
}

test('flux complet: accept -> visitor_id creat + gtag incarcat -> revocare (Refuz) -> gtag consent update DENIED + visitor_id sters din storage', () => {
  const win = makeFakeWindow();
  const gtagCalls = [];
  // gtag e propriul stub intern (loadGtagIfNeeded il suprascrie) — interceptam prin dataLayer.push,
  // care e ce foloseste stub-ul intern INAINTE ca scriptul real gtag.js sa se incarce (nu se
  // incarca niciodata cu adevarat in acest test, fetch-ul de script e doar un <script> fake).
  const { api, buttons } = loadWithCapturedBannerButtons(win);
  assert.ok(buttons.accept && buttons.reject, 'butoanele Accept/Refuz trebuie sa fi fost create la randarea initiala a bannerului');

  buttons.accept.click();
  assert.equal(win.localStorage.getItem('naluna_consent'), 'granted');
  const visitorIdAfterAccept = api.getOrCreateVisitorId();
  assert.equal(visitorIdAfterAccept, 'visitor-uuid-1', 'visitor_id trebuie creat dupa acceptare');
  assert.equal(win.localStorage.getItem('naluna_visitor_id'), 'visitor-uuid-1');

  // gtag a fost inlocuit de loadGtagIfNeeded cu stub-ul intern (push in dataLayer) — interceptam
  // AICI, dupa accept, ca sa vedem update-ul de consimtamant trimis la revocare.
  const consentUpdateCalls = [];
  const realGtag = win.gtag;
  win.gtag = function () {
    if (arguments[0] === 'consent') consentUpdateCalls.push(Array.from(arguments));
    return realGtag.apply(this, arguments);
  };

  buttons.reject.click();
  assert.equal(win.localStorage.getItem('naluna_consent'), 'denied', 'revocarea trebuie sa scrie "denied"');
  assert.equal(consentUpdateCalls.length, 1, 'gtag("consent","update",...) trebuie trimis catre biblioteca DEJA incarcata la revocare');
  assert.deepEqual(consentUpdateCalls[0], ['consent', 'update', { analytics_storage: 'denied' }]);

  assert.equal(win.localStorage.getItem('naluna_visitor_id'), null, 'visitor_id local trebuie sters la revocare');
});

test('dupa revocare: track() nu mai apeleaza gtag SI nu mai trimite /api/track, pentru NICIUN eveniment', () => {
  const win = makeFakeWindow();
  let fetchCalled = false;
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const { api, buttons } = loadWithCapturedBannerButtons(win);
  buttons.accept.click();

  let gtagEventCalls = 0;
  const realGtag = win.gtag;
  win.gtag = function () { if (arguments[0] === 'event') gtagEventCalls += 1; return realGtag.apply(this, arguments); };

  buttons.reject.click();
  fetchCalled = false; // resetam — orice apel de dupa acest punct e din track(), nu din setup

  api.track('cta_clicked', { location: 'hero' });
  assert.equal(gtagEventCalls, 0, 'niciun eveniment GA4 nu trebuie trimis dupa revocare');
  assert.equal(fetchCalled, false, 'niciun apel /api/track nu trebuie trimis dupa revocare');
});

test('getOrCreateVisitorId dupa revocare: returneaza null, NU mai citeste id-ul (oricum sters) din storage', () => {
  const win = makeFakeWindow();
  const { api, buttons } = loadWithCapturedBannerButtons(win);
  buttons.accept.click();
  api.getOrCreateVisitorId();
  buttons.reject.click();
  assert.equal(api.getOrCreateVisitorId(), null);
});

test('re-acceptare DUPA o revocare, pe aceeasi incarcare de pagina: gtag primeste update GRANTED (nu ramane blocat de revocarea anterioara) SI un visitor_id NOU e creat (nu se reia cel vechi, deja sters)', () => {
  const win = makeFakeWindow();
  let uuidCounter = 0;
  win.crypto = { randomUUID: () => `visitor-${++uuidCounter}` };
  const { api, buttons } = loadWithCapturedBannerButtons(win);

  buttons.accept.click();
  const firstId = api.getOrCreateVisitorId();
  assert.equal(firstId, 'visitor-1');

  buttons.reject.click();

  const consentUpdateCalls = [];
  const realGtag = win.gtag;
  win.gtag = function () { if (arguments[0] === 'consent') consentUpdateCalls.push(Array.from(arguments)); return realGtag.apply(this, arguments); };

  buttons.accept.click();
  assert.equal(win.localStorage.getItem('naluna_consent'), 'granted');
  assert.deepEqual(consentUpdateCalls[0], ['consent', 'update', { analytics_storage: 'granted' }]);

  const secondId = api.getOrCreateVisitorId();
  assert.equal(secondId, 'visitor-2', 'un id NOU trebuie creat, diferit de cel sters la revocare');
});

test('_updateGtagConsent: no-op sigur cand gtag nu a fost niciodata incarcat (consimtamant niciodata acordat)', () => {
  const win = makeFakeWindow({ gtag: undefined });
  const api = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => api._updateGtagConsent(false));
});

test('_clearVisitorId: sters chiar daca nu exista niciun visitor_id in storage (idempotent, fara eroare)', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => api._clearVisitorId());
  assert.equal(win.localStorage.getItem('naluna_visitor_id'), null);
});
