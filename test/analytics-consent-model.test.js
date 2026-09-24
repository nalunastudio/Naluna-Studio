// CONSENT MODEL v2 (2026-09-21, Consent + Privacy pentru Meta Ads) — teste dedicate schemei noi
// cu trei categorii (Necessary/Analytics/Marketing) din public/js/analytics.js: migrarea
// TRANSPARENTA a schemei vechi (v1, un singur string 'granted'/'denied', STRICT Analytics),
// independenta AMBELOR categorii noi, valorile implicite sigure, si completitudinea celor 8
// limbi ale bannerului. Acelasi tipar de sandbox (extragere textuala, fara jsdom) ca
// test/analytics-client.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');
const attributionSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'attribution.js'), 'utf8');

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
    getElementById: () => null,
    createElement: () => ({ style: {}, checked: false, disabled: false, addEventListener: () => {}, setAttribute: () => {}, appendChild: () => {} }),
    querySelector: () => null
  };
  const wrapperSrc = `(function (window, document) {\n${analyticsSrc}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow, doc);
  return fakeWindow.NalunaAnalytics;
}

// ================================================================================================
// Vizitator nou — implicit FALSE pentru ambele categorii optionale, niciodata un fallback permisiv.
// ================================================================================================
test('vizitator nou (storage complet gol): isAnalyticsConsentGranted() -> false', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isAnalyticsConsentGranted(), false);
});

test('vizitator nou (storage complet gol): isMarketingConsentGranted() -> false', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isMarketingConsentGranted(), false);
});

test('vizitator nou: bannerul nu e considerat decis (ambele categorii nedecise -> trebuie aratat)', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api._isStateFullyDecided(api._parseConsentState(null)), false);
});

// ================================================================================================
// Accept all / Reject optional — scrise prin API-ul public (aceeasi schema v2, JSON).
// ================================================================================================
test('scriere directa schema v2 (JSON): {analytics:true,marketing:true} -> ambele API-uri true', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: true, marketing: true }));
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isAnalyticsConsentGranted(), true);
  assert.equal(api.isMarketingConsentGranted(), true);
});

test('scriere directa schema v2 (JSON): {analytics:false,marketing:false} -> ambele API-uri false', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: false }));
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isAnalyticsConsentGranted(), false);
  assert.equal(api.isMarketingConsentGranted(), false);
});

test('schema v2: Analytics si Marketing sunt STRICT independente — {analytics:true,marketing:false} nu face Marketing adevarat, si invers', () => {
  const win1 = makeFakeWindow();
  win1.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: true, marketing: false }));
  const api1 = loadAnalyticsIntoSandbox(win1);
  assert.equal(api1.isAnalyticsConsentGranted(), true);
  assert.equal(api1.isMarketingConsentGranted(), false);

  const win2 = makeFakeWindow();
  win2.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const api2 = loadAnalyticsIntoSandbox(win2);
  assert.equal(api2.isAnalyticsConsentGranted(), false);
  assert.equal(api2.isMarketingConsentGranted(), true);
});

// ================================================================================================
// MIGRARE schema veche (v1, string 'granted'/'denied', STRICT Analytics) -> v2. Regula
// OBLIGATORIE: un Analytics vechi acceptat NU devine NICIODATA un Marketing implicit acceptat.
// ================================================================================================
test('migrare: consimtamant vechi "granted" (Analytics accepted) -> Analytics ramane acordat, Marketing ramane FALS (nedecis, niciodata implicit adevarat)', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isAnalyticsConsentGranted(), true, 'Analytics migrat trebuie sa ramana acordat — GA4 continua sa functioneze fara intrerupere');
  assert.equal(api.isMarketingConsentGranted(), false, 'Marketing NU a fost niciodata decis pentru schema veche — trebuie sa ramana neacordat');
});

test('migrare: consimtamant vechi "denied" (Analytics refuzat) -> Analytics ramane refuzat, Marketing ramane FALS', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'denied');
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.isAnalyticsConsentGranted(), false);
  assert.equal(api.isMarketingConsentGranted(), false);
});

test('migrare: un utilizator vechi cu Analytics "granted" NU are bannerul complet decis (Marketing ramane null) — bannerul trebuie sa reapara O SINGURA DATA ca sa i se ceara explicit alegerea de Marketing, fara sa i se resetaze Analytics', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'granted');
  const api = loadAnalyticsIntoSandbox(win);
  const state = api._parseConsentState('granted');
  assert.deepEqual(state, { analytics: true, marketing: null });
  assert.equal(api._isStateFullyDecided(state), false, 'Marketing nedecis -> starea nu e complet decisa -> bannerul reapare');
});

test('migrare: valoare corupta/necunoscuta in storage (nici "granted"/"denied", nici JSON valid) -> tratata ca nedecisa pentru AMBELE categorii, niciodata o eroare', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', 'ceva-necunoscut-#$%');
  const api = loadAnalyticsIntoSandbox(win);
  assert.doesNotThrow(() => {
    assert.equal(api.isAnalyticsConsentGranted(), false);
    assert.equal(api.isMarketingConsentGranted(), false);
  });
});

// ================================================================================================
// GA4 zero regresie (schema v2) — reconfirmate explicit cu noile functii publice.
// ================================================================================================
test('GA4 (schema v2): fara Analytics -> getClientId/getSessionId rezolva null IMEDIAT, fara sa apeleze gtag', async () => {
  let gtagCalled = false;
  const win = makeFakeWindow({ gtag: function () { gtagCalled = true; } });
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const api = loadAnalyticsIntoSandbox(win);
  const clientId = await api.getClientId(30);
  const sessionId = await api.getSessionId(30);
  assert.equal(clientId, null);
  assert.equal(sessionId, null);
  assert.equal(gtagCalled, false, 'Marketing acordat nu trebuie sa aiba niciun efect asupra GA4 — STRICT Analytics controleaza gtag');
});

test('GA4 (schema v2): cu Analytics acordat -> getClientId functioneaza normal', async () => {
  const win = makeFakeWindow({ gtag: undefined });
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: true, marketing: false }));
  const api = loadAnalyticsIntoSandbox(win);
  win.gtag = function (cmd, id, field, cb) { if (cmd === 'get') cb('111.222'); };
  const id = await api.getClientId(5000);
  assert.equal(id, '111.222');
});

test('visitor_id (schema v2): fara Analytics (chiar cu Marketing acordat) -> null STRICT, niciun id creat', () => {
  const win = makeFakeWindow();
  win.localStorage.setItem('naluna_consent', JSON.stringify({ analytics: false, marketing: true }));
  const api = loadAnalyticsIntoSandbox(win);
  assert.equal(api.getOrCreateVisitorId(), null);
  assert.equal(win.localStorage.getItem('naluna_visitor_id'), null);
});

// ================================================================================================
// Cele 8 limbi — completitudine structurala a bannerului (Accept all/Reject optional/Manage
// preferences/panou de preferinte), aceleasi chei in toate limbile, niciun fallback englezesc
// ramas pe o limba suportata.
// ================================================================================================
test('BANNER_COPY: exista exact cele 8 limbi ale site-ului (en/ro/de/es/it/fr/bg/tr)', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  assert.deepEqual(Object.keys(api._BANNER_COPY).sort(), ['bg', 'de', 'en', 'es', 'fr', 'it', 'ro', 'tr']);
});

test('BANNER_COPY: toate cele 8 limbi au TOATE cheile necesare textelor noi (Accept all/Reject optional/Manage preferences/panou), niciun fallback englezesc lasat pe o alta limba', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  const requiredKeys = [
    'text', 'acceptAll', 'rejectOptional', 'managePreferences', 'panelTitle',
    'necessaryLabel', 'necessaryDesc', 'analyticsLabel', 'analyticsDesc',
    'marketingLabel', 'marketingDesc', 'savePreferences', 'settingsLink'
  ];
  for (const [lang, copy] of Object.entries(api._BANNER_COPY)) {
    for (const key of requiredKeys) {
      assert.ok(typeof copy[key] === 'string' && copy[key].trim().length > 0, `limba "${lang}" nu are textul "${key}" (sau e gol)`);
    }
    // Fiecare limba trebuie sa aiba propriul text, nu o copie literala a englezei (cu exceptia
    // engleza insasi) — verificare minima ca traducerea chiar exista, nu doar cheia.
    if (lang !== 'en') {
      assert.notEqual(copy.text, api._BANNER_COPY.en.text, `limba "${lang}": textul principal al bannerului pare identic cu engleza — posibil fallback netraduse`);
      assert.notEqual(copy.marketingDesc, api._BANNER_COPY.en.marketingDesc, `limba "${lang}": descrierea Marketing pare identica cu engleza — posibil fallback netraduse`);
    }
  }
});

test('BANNER_COPY: descrierea Marketing, in toate limbile, NU afirma ca Meta Pixel/CAPI sunt deja active — foloseste STRICT formulari de tip "nu inca activ"/"optional"', () => {
  const win = makeFakeWindow();
  const api = loadAnalyticsIntoSandbox(win);
  for (const [lang, copy] of Object.entries(api._BANNER_COPY)) {
    assert.ok(!/\bCAPI\b/.test(copy.marketingDesc), `limba "${lang}": marketingDesc nu trebuie sa mentioneze CAPI`);
    assert.ok(!/Conversions API/i.test(copy.marketingDesc), `limba "${lang}": marketingDesc nu trebuie sa mentioneze Conversions API`);
  }
});

// ================================================================================================
// Securitate — Meta Pixel (2026-09-24, V1) EXISTA acum in analytics.js, dar STRICT gated pe
// Marketing consent — vezi test/meta-pixel-client.test.js pentru verificarea executabila completa
// a incarcarii/consimtamantului. Testul de aici ramane STRICT structural: cele doua puncte de
// apel ale loadMetaPixelIfNeeded() trebuie sa fie AMBELE in interiorul unei conditii
// isMarketingConsentGranted()/marketingGranted — niciodata neconditionat.
// ================================================================================================
test('SECURITATE: loadMetaPixelIfNeeded() e apelat STRICT din ramuri gated pe consimtamant Marketing (applyStoredConsent + applyConsentDecision), niciodata neconditionat', () => {
  const calls = analyticsSrc.match(/loadMetaPixelIfNeeded\(\);/g) || [];
  assert.equal(calls.length, 2, 'trebuie sa existe EXACT 2 apeluri: applyStoredConsent() si applyConsentDecision()');
  assert.match(analyticsSrc, /if \(isMarketingConsentGranted\(\)\) loadMetaPixelIfNeeded\(\);/);
  assert.match(analyticsSrc, /if \(marketingGranted\) \{\s*loadMetaPixelIfNeeded\(\);/);
});

test('SECURITATE: attribution.js NU contine niciun apel/SDK Meta real — captarea fbclid ramane STRICT un parametru de URL persistat local, niciodata trimis catre Meta din acest fisier', () => {
  assert.ok(!/fbq\(|connect\.facebook\.net|graph\.facebook\.com/i.test(attributionSrc));
});

test('public/js/analytics.js ramane sintactic valid dupa extinderea modelului de consimtamant', () => {
  assert.doesNotThrow(() => new Function(analyticsSrc));
});
