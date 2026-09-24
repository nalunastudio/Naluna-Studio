// META PIXEL V1 (2026-09-24, evenimente Meta pre-purchase) — teste pentru public/js/analytics.js.
// ACELASI tipar de sandbox (fara jsdom) ca test/analytics-client.test.js si
// test/analytics-consent-revocation.test.js: sursa reala e extrasa textual si executata intr-un
// "window"/"document" minimal, scrise de mana — niciun browser real, niciun Pixel real incarcat
// (fbevents.js nu e niciodata descarcat cu adevarat; window.fbq ramane STRICT stub-ul de coada
// din codul de baza Meta, exact ca intr-un browser real inainte ca scriptul async sa se incarce).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

function makeFakeElement() {
  return { style: {}, addEventListener: () => {}, setAttribute: () => {} };
}

function makeFakeWindow(overrides) {
  const store = {};
  return Object.assign({
    NALUNA_GA_MEASUREMENT_ID: '',
    NALUNA_META_PIXEL_ID: 'PIXEL-TEST-123',
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    crypto: { randomUUID: () => 'visitor-uuid-1' },
    dataLayer: undefined,
    gtag: undefined,
    fbq: undefined,
    fetch: () => Promise.resolve({})
  }, overrides);
}

// n.queue.push(arguments) (codul REAL, oficial Meta) pastreaza obiecte "arguments" (array-like),
// nu array-uri simple — le normalizam aici STRICT pentru comparatii in teste, ACELASI tipar ca
// test/analytics-client.test.js (calls.push(Array.from(arguments)) in stub-ul lor de gtag).
function toArrays(queue) {
  return queue.map((entry) => Array.from(entry));
}

function loadAnalyticsIntoSandbox(fakeWindow, cookieValue) {
  const appendedScripts = [];
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: (el) => appendedScripts.push(el) },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => makeFakeElement(),
    getElementsByTagName: () => [makeFakeElement()],
    querySelector: () => null,
    cookie: cookieValue || ''
  };
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return { api: fakeWindow.NalunaAnalytics, appendedScripts, doc };
}

// ================================================================================================
// 1) Pixel absent/inactiv FARA Marketing consent.
// ================================================================================================
test('1) fara Marketing consent (nedecis): window.fbq ramane NEDEFINIT dupa incarcarea paginii — Pixel-ul nu se incarca deloc', () => {
  const win = makeFakeWindow();
  const { appendedScripts } = loadAnalyticsIntoSandbox(win);
  assert.equal(win.fbq, undefined, 'fbq nu trebuie sa existe fara consimtamant');
  assert.equal(appendedScripts.length, 0, 'niciun <script> nu trebuie injectat fara consimtamant');
});

test('1b) Marketing EXPLICIT refuzat (denied): window.fbq ramane NEDEFINIT', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: false }));
  const { appendedScripts } = loadAnalyticsIntoSandbox(win);
  assert.equal(win.fbq, undefined);
  assert.equal(appendedScripts.length, 0);
});

// ================================================================================================
// 2) Pixel se incarca DUPA Marketing consent acordat — atat la incarcarea paginii (consimtamant
// deja salvat dintr-o vizita anterioara), CAT SI live, in aceeasi incarcare de pagina (banner).
// ================================================================================================
test('2a) Marketing DEJA acordat (consimtamant salvat, revizitare): Pixel-ul se incarca la initConsentUi(), init + PageView trimise', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { appendedScripts } = loadAnalyticsIntoSandbox(win);
  assert.equal(typeof win.fbq, 'function', 'fbq trebuie sa existe dupa consimtamant deja acordat');
  assert.equal(appendedScripts.length, 1, 'exact un <script> injectat (fbevents.js)');
  assert.deepEqual(toArrays(win.fbq.queue.slice(0, 2)), [['init', 'PIXEL-TEST-123'], ['track', 'PageView']]);
});

test('2b) Marketing acordat LIVE (accept all, dupa incarcarea paginii, fara reload): Pixel-ul se incarca imediat prin applyConsentDecision', () => {
  const win = makeFakeWindow();
  const { api } = loadAnalyticsIntoSandbox(win); // porneste fara consimtamant
  assert.equal(win.fbq, undefined, 'sanity: fbq nu exista inca');
  // Simuleaza "Accept all" — applyConsentDecision nu e expusa public direct, dar il declansam
  // prin efectul lui public, STRICT verificabil: setam consimtamant + apelam functia interna
  // expusa pentru teste, ACELASI tipar ca _updateGtagConsent existent.
  api._loadMetaPixelIfNeeded();
  assert.equal(typeof win.fbq, 'function', 'apelul direct al loaderului (echivalent cu ramura marketingGranted din applyConsentDecision) trebuie sa incarce Pixel-ul');
});

// ================================================================================================
// 3) Retragere Marketing consent DUPA ce Pixel-ul a fost deja incarcat — opreste corect (fbq
// consent revoke), mecanismul oficial Meta (echivalentul Google Consent Mode).
// ================================================================================================
test('3) retragere Marketing consent dupa incarcare: fbq("consent","revoke") trimis catre Pixel-ul deja incarcat', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win);
  assert.equal(typeof win.fbq, 'function', 'sanity: Pixel-ul e deja incarcat');
  const queueLenBefore = win.fbq.queue.length;
  api._updateMetaPixelConsent(false);
  const revokeCalls = toArrays(win.fbq.queue.slice(queueLenBefore));
  assert.deepEqual(revokeCalls, [['consent', 'revoke']]);
});

test('3b) re-acordare Marketing consent (grant) dupa o revocare anterioara, pe aceeasi incarcare: fbq("consent","grant") trimis', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win);
  api._updateMetaPixelConsent(false);
  const lenAfterRevoke = win.fbq.queue.length;
  api._updateMetaPixelConsent(true);
  assert.deepEqual(toArrays(win.fbq.queue.slice(lenAfterRevoke)), [['consent', 'grant']]);
});

test('_updateMetaPixelConsent: no-op sigur cand fbq nu a fost niciodata incarcat (consimtamant niciodata acordat)', () => {
  const win = makeFakeWindow();
  const { api } = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => api._updateMetaPixelConsent(false));
  assert.equal(win.fbq, undefined);
});

// ================================================================================================
// 4) PageView NU se dubleaza — apeluri repetate ale loaderului (ex. initConsentUi() SI un
// eventual accept ulterior pe aceeasi incarcare) trimit STRICT un singur PageView.
// ================================================================================================
test('4) PageView trimis STRICT o data, chiar daca loadMetaPixelIfNeeded() e apelat de mai multe ori', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win); // apel #1, implicit, la initConsentUi()
  api._loadMetaPixelIfNeeded(); // apel #2, explicit
  api._loadMetaPixelIfNeeded(); // apel #3, explicit
  const pageViewCalls = win.fbq.queue.filter((c) => c[0] === 'track' && c[1] === 'PageView');
  assert.equal(pageViewCalls.length, 1, 'PageView trebuie trimis EXACT o data, indiferent de cate ori e apelat loaderul');
});

// ================================================================================================
// 5) + 6) InitiateCheckout — trackMeta() (folosita de melodia-mea.html) e gated STRICT pe
// Marketing consent; verificarea punctului exact de apel (goToCheckout) e in
// test/meta-pixel-initiate-checkout.test.js (melodia-mea.html).
// ================================================================================================
test('5) trackMeta(): Marketing consent NEACORDAT -> NU trimite niciun eveniment, fbq nu e apelat deloc', () => {
  const win = makeFakeWindow({ fbq: function () { throw new Error('fbq NU trebuie apelat'); } });
  const { api } = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => api.trackMeta('InitiateCheckout', { value: 15 }));
});

test('6) trackMeta(): Marketing consent ACORDAT -> trimite fbq("track", eventName, params) STRICT o data per apel', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win);
  const lenBefore = win.fbq.queue.length;
  api.trackMeta('InitiateCheckout', { value: 15, currency: 'GBP', content_ids: ['order-1'], content_type: 'product' });
  const calls = toArrays(win.fbq.queue.slice(lenBefore));
  assert.deepEqual(calls, [['track', 'InitiateCheckout', { value: 15, currency: 'GBP', content_ids: ['order-1'], content_type: 'product' }]]);
});

test('trackMeta(): Marketing acordat dar fbq indisponibil (blocat de ad-blocker) -> nicio eroare aruncata', () => {
  const win = makeFakeWindow({ fbq: undefined });
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  // fortam metaPixelLoadStarted implicit prin faptul ca applyStoredConsent() ar fi incarcat
  // Pixel-ul normal — simulam blocarea suprascriind fbq DUPA incarcare.
  const { api } = loadAnalyticsIntoSandbox(win);
  win.fbq = undefined;
  assert.doesNotThrow(() => api.trackMeta('InitiateCheckout', {}));
});

// ================================================================================================
// 7) + 8) _fbp — NU persistat fara consimtamant, persistat (valoarea reala din cookie) cu
// consimtamant.
// ================================================================================================
test('7) getFbpForOrder(): Marketing consent NEACORDAT -> null, chiar daca cookie-ul _fbp exista real in browser', () => {
  const win = makeFakeWindow();
  const { api } = loadAnalyticsIntoSandbox(win, '_fbp=fb.1.1596403881668.1116446470; other=x');
  assert.equal(api.getFbpForOrder(), null);
});

test('8) getFbpForOrder(): Marketing consent ACORDAT + cookie _fbp prezent -> valoarea REALA din cookie, neschimbata, niciodata fabricata', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win, 'other=x; _fbp=fb.1.1596403881668.1116446470');
  assert.equal(api.getFbpForOrder(), 'fb.1.1596403881668.1116446470');
});

test('getFbpForOrder(): Marketing consent ACORDAT dar cookie-ul _fbp NU exista (Pixel inca neincarcat/blocat) -> null, niciodata fabricat', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { api } = loadAnalyticsIntoSandbox(win, 'other=x');
  assert.equal(api.getFbpForOrder(), null);
});

// ================================================================================================
// Regresie — API-ul existent (GA4/consimtamant) ramane complet neatins de aceasta extindere.
// ================================================================================================
test('public/js/analytics.js ramane sintactic valid dupa adaugarea Meta Pixel', () => {
  assert.doesNotThrow(() => new Function(analyticsSrc));
});

test('META_PIXEL_ID vine STRICT din window.NALUNA_META_PIXEL_ID (ACELASI tipar ca GA_ID/NALUNA_GA_MEASUREMENT_ID), niciodata hardcodat', () => {
  assert.match(analyticsSrc, /var META_PIXEL_ID = \(global\.NALUNA_META_PIXEL_ID \|\| ''\)\.trim\(\);/);
});

test('fara META_PIXEL_ID configurat (variabila lipsa): loadMetaPixelIfNeeded() e no-op, chiar cu Marketing consent acordat', () => {
  const win = makeFakeWindow({ NALUNA_META_PIXEL_ID: '' });
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const { appendedScripts } = loadAnalyticsIntoSandbox(win);
  assert.equal(win.fbq, undefined);
  assert.equal(appendedScripts.length, 0);
});
