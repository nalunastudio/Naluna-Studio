// CONSENT REVOCATION (2026-09-18, corectie ceruta explicit; extins 2026-09-21 pentru bannerul cu
// trei categorii — Necessary/Analytics/Marketing, Consent + Privacy pentru Meta Ads) — verifica
// exact scenariul: un vizitator ACCEPTA totul (Accept all: gtag.js se incarca, primeste
// visitor_id), apoi REVOCA din link-ul "Cookie settings" (redeschide bannerul, apasa "Reject
// optional"). Acelasi tipar de sandbox ca test/analytics-client.test.js, dar cu un DOM fake mai
// complet (elemente cu addEventListener/click()/checked REALE) — necesar ca sa putem declansa
// efectiv controalele bannerului (butoane + checkbox-uri), nu doar sa citim textul lor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

function makeFakeElement() {
  const listeners = {};
  const el = {
    style: {},
    children: [],
    checked: false,
    disabled: false,
    _listeners: listeners,
    _idsMap: null, // injectat de loadWithCapturedBannerControls, pentru auto-inregistrare pe id
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener(type, handler) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((h) => h !== handler);
    },
    click() { (listeners.click || []).forEach((h) => h({ preventDefault() {} })); },
    setAttribute() {},
    appendChild(child) { this.children.push(child); return child; },
    get textContent() { return this._text || ''; },
    set textContent(v) { this._text = v; }
  };
  return el;
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
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: (id) => elementsById[id] || null,
    createElement: () => makeFakeElement(),
    querySelector: () => null
  };
  const elementsById = {};
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return fakeWindow.NalunaAnalytics;
}

// Randeaza bannerul real (renderBanner()) si captureaza controalele reale prin id — createElement
// atribuie fiecarui element un setter pe `.id` care se auto-inregistreaza intr-un registru,
// exact ca document.getElementById intr-un browser real. Robust la orice reordonare interna a
// DOM-ului bannerului (nu depinde de pozitii/indici de copii, spre deosebire de varianta veche).
function loadWithCapturedBannerControls(fakeWindow) {
  const elementsById = {};
  function createElement() {
    const el = makeFakeElement();
    let _id = '';
    Object.defineProperty(el, 'id', {
      get() { return _id; },
      set(v) { _id = v; if (v) elementsById[v] = el; }
    });
    return el;
  }
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: (id) => elementsById[id] || null,
    createElement: createElement,
    querySelector: () => null
  };
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return {
    api: fakeWindow.NalunaAnalytics,
    controls: {
      acceptAll: elementsById['naluna-consent-accept-all'],
      rejectOptional: elementsById['naluna-consent-reject-optional'],
      manage: elementsById['naluna-consent-manage'],
      analyticsToggle: elementsById['naluna-consent-analytics-toggle'],
      marketingToggle: elementsById['naluna-consent-marketing-toggle'],
      save: elementsById['naluna-consent-save']
    }
  };
}

test('flux complet: Accept all -> visitor_id creat + gtag incarcat -> revocare (Reject optional) -> gtag consent update DENIED + visitor_id sters din storage', () => {
  const win = makeFakeWindow();
  const { api, controls } = loadWithCapturedBannerControls(win);
  assert.ok(controls.acceptAll && controls.rejectOptional && controls.manage, 'butoanele Accept all/Reject optional/Manage preferences trebuie sa fi fost create la randarea initiala a bannerului');

  controls.acceptAll.click();
  const stateAfterAccept = JSON.parse(win.localStorage.getItem('naluna_consent'));
  assert.deepEqual(stateAfterAccept, { analytics: true, marketing: true }, 'Accept all trebuie sa acorde AMBELE categorii');
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

  controls.rejectOptional.click();
  const stateAfterReject = JSON.parse(win.localStorage.getItem('naluna_consent'));
  assert.deepEqual(stateAfterReject, { analytics: false, marketing: false }, 'Reject optional trebuie sa refuze AMBELE categorii');
  assert.equal(consentUpdateCalls.length, 1, 'gtag("consent","update",...) trebuie trimis catre biblioteca DEJA incarcata la revocare');
  assert.deepEqual(consentUpdateCalls[0], ['consent', 'update', { analytics_storage: 'denied' }]);

  assert.equal(win.localStorage.getItem('naluna_visitor_id'), null, 'visitor_id local trebuie sters la revocare');
});

test('dupa revocare (Reject optional): track() nu mai apeleaza gtag SI nu mai trimite /api/track, pentru NICIUN eveniment', () => {
  const win = makeFakeWindow();
  let fetchCalled = false;
  win.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const { api, controls } = loadWithCapturedBannerControls(win);
  controls.acceptAll.click();

  let gtagEventCalls = 0;
  const realGtag = win.gtag;
  win.gtag = function () { if (arguments[0] === 'event') gtagEventCalls += 1; return realGtag.apply(this, arguments); };

  controls.rejectOptional.click();
  fetchCalled = false; // resetam — orice apel de dupa acest punct e din track(), nu din setup

  api.track('cta_clicked', { location: 'hero' });
  assert.equal(gtagEventCalls, 0, 'niciun eveniment GA4 nu trebuie trimis dupa revocare');
  assert.equal(fetchCalled, false, 'niciun apel /api/track nu trebuie trimis dupa revocare');
});

test('getOrCreateVisitorId dupa revocare (Reject optional): returneaza null, NU mai citeste id-ul (oricum sters) din storage', () => {
  const win = makeFakeWindow();
  const { api, controls } = loadWithCapturedBannerControls(win);
  controls.acceptAll.click();
  api.getOrCreateVisitorId();
  controls.rejectOptional.click();
  assert.equal(api.getOrCreateVisitorId(), null);
});

test('re-acceptare (Accept all) DUPA o revocare, pe aceeasi incarcare de pagina: gtag primeste update GRANTED (nu ramane blocat de revocarea anterioara) SI un visitor_id NOU e creat (nu se reia cel vechi, deja sters)', () => {
  const win = makeFakeWindow();
  let uuidCounter = 0;
  win.crypto = { randomUUID: () => `visitor-${++uuidCounter}` };
  const { api, controls } = loadWithCapturedBannerControls(win);

  controls.acceptAll.click();
  const firstId = api.getOrCreateVisitorId();
  assert.equal(firstId, 'visitor-1');

  controls.rejectOptional.click();

  const consentUpdateCalls = [];
  const realGtag = win.gtag;
  win.gtag = function () { if (arguments[0] === 'consent') consentUpdateCalls.push(Array.from(arguments)); return realGtag.apply(this, arguments); };

  controls.acceptAll.click();
  assert.deepEqual(JSON.parse(win.localStorage.getItem('naluna_consent')), { analytics: true, marketing: true });
  assert.deepEqual(consentUpdateCalls[0], ['consent', 'update', { analytics_storage: 'granted' }]);

  const secondId = api.getOrCreateVisitorId();
  assert.equal(secondId, 'visitor-2', 'un id NOU trebuie creat, diferit de cel sters la revocare');
});

// ================================================================================================
// "Manage preferences" — Analytics si Marketing sunt independente (2026-09-21).
// ================================================================================================
test('Manage preferences: Analytics ON / Marketing OFF -> salvat exact asa, GA4 functioneaza, isMarketingConsentGranted() ramane fals', () => {
  const win = makeFakeWindow();
  const { api, controls } = loadWithCapturedBannerControls(win);
  controls.manage.click();
  controls.analyticsToggle.checked = true;
  controls.marketingToggle.checked = false;
  controls.save.click();

  assert.deepEqual(JSON.parse(win.localStorage.getItem('naluna_consent')), { analytics: true, marketing: false });
  assert.equal(api.isAnalyticsConsentGranted(), true);
  assert.equal(api.isMarketingConsentGranted(), false);
  assert.equal(api.getOrCreateVisitorId(), 'visitor-uuid-1', 'Analytics acordat -> visitor_id creat');
});

test('Manage preferences: Analytics OFF / Marketing ON -> salvat exact asa (categorii independente), GA4/visitor_id raman oprite', () => {
  const win = makeFakeWindow();
  const { api, controls } = loadWithCapturedBannerControls(win);
  controls.manage.click();
  controls.analyticsToggle.checked = false;
  controls.marketingToggle.checked = true;
  controls.save.click();

  assert.deepEqual(JSON.parse(win.localStorage.getItem('naluna_consent')), { analytics: false, marketing: true });
  assert.equal(api.isAnalyticsConsentGranted(), false);
  assert.equal(api.isMarketingConsentGranted(), true);
  assert.equal(api.getOrCreateVisitorId(), null, 'Analytics refuzat -> niciun visitor_id, indiferent de Marketing');
});

test('Manage preferences: Marketing NU e niciodata prebifat implicit pentru un vizitator nou (toggle-ul porneste neselectat)', () => {
  const win = makeFakeWindow();
  const { controls } = loadWithCapturedBannerControls(win);
  controls.manage.click();
  assert.equal(controls.marketingToggle.checked, false, 'Marketing nu trebuie preselectat niciodata');
  assert.equal(controls.analyticsToggle.checked, false, 'Analytics nu trebuie preselectat niciodata pentru un vizitator nou');
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
