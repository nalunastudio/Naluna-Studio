// ANALYTICS (2026-09-14) — teste pentru public/js/analytics.js. Fara jsdom (nicio dependinta
// noua, cerinta explicita) — logica PURA (consimtamant, construirea payload-ului de eveniment)
// e extrasa textual si testata direct; interactiunile cu DOM/gtag (onFormStarted, track,
// getClientId) sunt testate cu stub-uri minimale, scrise de mana (obiecte simple cu
// addEventListener/removeEventListener/querySelector) — suficiente pentru comportamentul real
// folosit de acest fisier, acelasi tipar de extragere+sandbox folosit deja pentru server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

// Construieste un "window" minimal, izolat per test — localStorage/gtag/document sunt stub-uri
// controlate explicit de fiecare test, niciodata un browser real.
function makeFakeWindow(overrides) {
  const store = {};
  const fakeWindow = Object.assign({
    NALUNA_GA_MEASUREMENT_ID: 'G-TEST123',
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    dataLayer: undefined,
    gtag: undefined
  }, overrides);
  return fakeWindow;
}

function loadAnalyticsIntoSandbox(fakeWindow, fakeDocument) {
  // document minimal — STRICT ce foloseste analytics.js: readyState, addEventListener,
  // createElement, head.appendChild, body.appendChild, getElementById, querySelector,
  // documentElement.getAttribute.
  const doc = Object.assign({
    readyState: 'complete', // sarim peste asteptarea DOMContentLoaded in teste — init ruleaza imediat
    addEventListener: () => {},
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, addEventListener: () => {}, setAttribute: () => {} }),
    querySelector: () => null
  }, fakeDocument);

  // analytics.js e deja el insusi un IIFE de forma "(function (global) { ... })(window);" —
  // il invelim STRICT intr-o functie cu parametrii (window, document), ca identificatorii
  // liberi "window"/"document" din fisierul real sa se rezolve la fake-urile noastre prin
  // scoping lexical normal — niciun regex/decupare a sursei, deci niciun risc sa rupem codul
  // real testat.
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return fakeWindow.NalunaAnalytics;
}

// ===============================================================================================
// LOGICA PURA — consimtamant.
// ===============================================================================================
test('_isConsentGranted: STRICT "granted" -> true, orice altceva (null/denied/gunoi) -> false', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api._isConsentGranted('granted'), true);
  assert.equal(api._isConsentGranted('denied'), false);
  assert.equal(api._isConsentGranted(null), false);
  assert.equal(api._isConsentGranted(undefined), false);
  assert.equal(api._isConsentGranted(''), false);
  assert.equal(api._isConsentGranted('GRANTED'), false, 'case-sensitiv, niciun fallback permisiv');
});

test('_isConsentDecided: "granted"/"denied" -> true (bannerul nu mai apare), orice altceva -> false (bannerul apare)', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api._isConsentDecided('granted'), true);
  assert.equal(api._isConsentDecided('denied'), true);
  assert.equal(api._isConsentDecided(null), false);
  assert.equal(api._isConsentDecided(undefined), false);
  assert.equal(api._isConsentDecided(''), false);
});

// ===============================================================================================
// LOGICA PURA — payload de eveniment: NICIUN camp PII, doar ce a fost explicit trimis.
// ===============================================================================================
test('_buildEventParams: copiaza STRICT campurile primite, fara sa adauge ceva in plus', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  const out = api._buildEventParams({ currency: 'GBP', value: 25, package: 'standard' });
  assert.deepEqual(out, { currency: 'GBP', value: 25, package: 'standard' });
});

test('_buildEventParams: fara parametri -> obiect gol, niciodata eroare', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.deepEqual(api._buildEventParams(undefined), {});
  assert.deepEqual(api._buildEventParams(null), {});
});

test('CONFIRMARE STRUCTURALA: niciun camp PII (name/email/story/lyrics/recipient/sender) nu apare NICAIERI in analytics.js', () => {
  const forbidden = /\b(name|email|story|lyrics|recipient|senderName|poveste)\s*:/i;
  // excludem comentariile (unde PII e mentionat STRICT descriptiv, ca exemplu de ce NU trebuie
  // trimis) — verificam doar codul executabil.
  const codeOnly = analyticsSrc.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, forbidden, 'niciun camp cu nume PII nu trebuie construit ca parametru de eveniment');
});

// ===============================================================================================
// track(): respecta STRICT consimtamantul.
// ===============================================================================================
test('track(): consimtamant NEACORDAT -> gtag NU e apelat niciodata', () => {
  let gtagCalls = 0;
  const win = makeFakeWindow({ gtag: () => { gtagCalls++; } });
  const api = loadAnalyticsIntoSandbox(win);
  win.localStorage.setItem('naluna_consent', 'denied');
  api.track('start_order');
  assert.equal(gtagCalls, 0);
});

test('track(): consimtamant ACORDAT + gtag disponibil -> evenimentul e trimis cu parametrii corecti', () => {
  const calls = [];
  const win = makeFakeWindow({ gtag: function () { calls.push(Array.from(arguments)); } });
  const api = loadAnalyticsIntoSandbox(win);
  win.localStorage.setItem('naluna_consent', 'granted');
  api.track('begin_checkout', { currency: 'GBP', value: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'event');
  assert.equal(calls[0][1], 'begin_checkout');
  assert.deepEqual(calls[0][2], { currency: 'GBP', value: 25 });
});

test('track(): consimtamant ACORDAT dar gtag INDISPONIBIL (blocat de ad-blocker) -> nicio eroare aruncata', () => {
  const win = makeFakeWindow({ gtag: undefined });
  const api = loadAnalyticsIntoSandbox(win);
  win.localStorage.setItem('naluna_consent', 'granted');
  assert.doesNotThrow(() => api.track('start_order'));
});

// ===============================================================================================
// onFormStarted(): trimite o SINGURA DATA, la prima interactie reala — niciodata la fiecare
// field/tasta.
// ===============================================================================================
test('onFormStarted: trimite evenimentul o SINGURA DATA, la primul "input", ignora orice interactie ulterioara', () => {
  const calls = [];
  // Consimtamantul e setat DUPA incarcarea modulului (nu la construirea window-ului) — daca ar
  // fi setat inainte, initConsentUi() (rulat automat la incarcare) ar declansa loadGtagIfNeeded(),
  // care INLOCUIESTE window.gtag cu propriul stub de coada (comportamentul real, corect, al
  // incarcatorului GA4) — exact ca intr-un browser real, unde gtag() e o coada pana cand scriptul
  // real se incarca. Testul de aici verifica STRICT track()/onFormStarted(), nu incarcarea gtag.
  const win = makeFakeWindow({ gtag: undefined });

  let inputHandler = null;
  const fakeForm = {
    addEventListener: (evt, handler) => { if (evt === 'input' && !inputHandler) inputHandler = handler; },
    removeEventListener: () => {}
  };
  const api = loadAnalyticsIntoSandbox(win, { querySelector: () => fakeForm });

  win.localStorage.setItem('naluna_consent', 'granted');
  win.gtag = function () { calls.push(Array.from(arguments)); };

  api.onFormStarted('#order-form');
  assert.ok(inputHandler, 'trebuie sa fi atasat un handler de input');

  inputHandler(); // prima interactie reala
  inputHandler(); // a doua — NU trebuie sa mai trimita nimic
  inputHandler(); // a treia — la fel

  const formStartedCalls = calls.filter(c => c[0] === 'event' && c[1] === 'form_started');
  assert.equal(formStartedCalls.length, 1, 'form_started trebuie trimis EXACT o data, indiferent de cate interactii urmeaza');
});

test('onFormStarted: formularul nu exista in DOM (selector gresit) -> nicio eroare, niciun listener orfan', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win, { querySelector: () => null });
  assert.doesNotThrow(() => api.onFormStarted('#nu-exista'));
});

// ===============================================================================================
// getClientId(): NICIODATA nu blocheaza checkout-ul — rezolva null la timeout, niciodata nu
// arunca/atarna.
// ===============================================================================================
test('getClientId: gtag NU raspunde niciodata (simuleaza blocare/lentoare) -> rezolva null dupa timeout, nu ramane blocat', async () => {
  const win = makeFakeWindow({ gtag: function () { /* nu apeleaza niciodata callback-ul */ } });
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  const id = await api.getClientId(30); // timeout scurt, pentru un test rapid
  assert.equal(id, null);
});

test('getClientId: gtag raspunde normal -> rezolva client_id-ul real, imediat (fara sa astepte timeout-ul)', async () => {
  // Vezi comentariul din testul onFormStarted de mai sus — consimtamantul/stub-ul gtag se
  // seteaza DUPA incarcarea modulului, ca sa nu fie inlocuite de loadGtagIfNeeded() (comportament
  // corect, real, al incarcatorului GA4).
  const win = makeFakeWindow({ gtag: undefined });
  const api = loadAnalyticsIntoSandbox(win);
  win.localStorage.setItem('naluna_consent', 'granted');
  win.gtag = function (cmd, id, field, cb) {
    if (cmd === 'get') cb('123456789.987654321');
  };
  const id = await api.getClientId(5000);
  assert.equal(id, '123456789.987654321');
});

test('getClientId: consimtamant NEACORDAT -> rezolva null IMEDIAT, fara sa apeleze gtag deloc', async () => {
  let gtagCalled = false;
  const win = makeFakeWindow({ gtag: function () { gtagCalled = true; } });
  win.localStorage.setItem('naluna_consent', 'denied');
  const api = loadAnalyticsIntoSandbox(win);
  const id = await api.getClientId(30);
  assert.equal(id, null);
  assert.equal(gtagCalled, false);
});

test('getClientId: gtag lipseste complet (ad-blocker) -> rezolva null, fara eroare', async () => {
  const win = makeFakeWindow({ gtag: undefined });
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  const id = await api.getClientId(30);
  assert.equal(id, null);
});

test('public/js/analytics.js ramane sintactic valid', () => {
  assert.doesNotThrow(() => new Function(analyticsSrc));
});
