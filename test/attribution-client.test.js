// ATRIBUIRE MARKETING (2026-09-18) — teste pentru public/js/attribution.js. Acelasi tipar ca
// test/analytics-client.test.js: fara jsdom, fisierul real e incarcat VERBATIM intr-un wrapper
// (window, ...) -> identificatorii liberi "window" din sursa reala se leaga prin scoping lexical
// normal de fake-urile noastre, fara niciun regex/decupare a codului testat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'attribution.js'), 'utf8');

function makeFakeWindow(overrides) {
  const store = {};
  return Object.assign({
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: { search: '' },
    URLSearchParams: URLSearchParams
  }, overrides);
}

function loadIntoSandbox(fakeWindow) {
  const wrapperSrc = `(function (window) {\n${src}\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  factory(fakeWindow);
  return fakeWindow.NalunaAttribution;
}

// ============================================================================
// parseAttributionParams — functie pura
// ============================================================================
test('parseAttributionParams: extrage STRICT campurile UTM + fbclid cunoscute, ignora restul', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  const result = api._parseAttributionParams({ utm_source: 'facebook', utm_medium: 'paid_social', random_param: 'ignorat' });
  assert.deepEqual(result, { utm_source: 'facebook', utm_medium: 'paid_social' });
});

test('parseAttributionParams: niciun parametru relevant -> null (nu obiect gol)', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  assert.equal(api._parseAttributionParams({ foo: 'bar' }), null);
  assert.equal(api._parseAttributionParams({}), null);
});

test('parseAttributionParams: fbclid singur (fara UTM) tot conteaza ca atribuire reala', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  assert.deepEqual(api._parseAttributionParams({ fbclid: 'IwAR123abc' }), { fbclid: 'IwAR123abc' });
});

test('parseAttributionParams: taie valorile la 300 caractere (aparare impotriva unui URL manipulat)', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  const long = 'x'.repeat(500);
  const result = api._parseAttributionParams({ utm_campaign: long });
  assert.equal(result.utm_campaign.length, 300);
});

test('parseAttributionParams: string gol/whitespace nu conteaza ca valoare reala', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  assert.equal(api._parseAttributionParams({ utm_source: '   ' }), null);
});

// ============================================================================
// isStoredValueValid — expirare la 30 de zile
// ============================================================================
test('isStoredValueValid: o valoare recenta e valida', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  const now = Date.now();
  assert.equal(api._isStoredValueValid({ capturedAt: now - 1000 }, now), true);
});

test('isStoredValueValid: o valoare de peste 30 de zile NU mai e valida', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  const now = Date.now();
  const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
  assert.equal(api._isStoredValueValid({ capturedAt: now - THIRTY_ONE_DAYS }, now), false);
});

test('isStoredValueValid: lipsa/corupta -> invalida, fara sa arunce', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  assert.equal(api._isStoredValueValid(null, Date.now()), false);
  assert.equal(api._isStoredValueValid(undefined, Date.now()), false);
  assert.equal(api._isStoredValueValid({}, Date.now()), false);
  assert.equal(api._isStoredValueValid('nu e obiect', Date.now()), false);
});

// ============================================================================
// Captare + citire — integrare cu storage stub (captureFromCurrentUrl ruleaza deja o data la
// incarcarea modulului, folosind location.search de la momentul acela).
// ============================================================================
test('la incarcare, un URL cu UTM reale se regaseste la citire', () => {
  const api = loadIntoSandbox(makeFakeWindow({ location: { search: '?utm_source=facebook&utm_medium=paid_social&utm_campaign=launch_ads_1&fbclid=IwAR999' } }));
  assert.deepEqual(api.getStoredAttribution(), {
    utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'launch_ads_1', fbclid: 'IwAR999'
  });
});

test('getStoredAttribution: fara niciun parametru la incarcare -> obiect gol, nu null/eroare', () => {
  const api = loadIntoSandbox(makeFakeWindow());
  assert.deepEqual(api.getStoredAttribution(), {});
});

test('O a doua vizita FARA parametri UTM in URL nu sterge atribuirea deja salvata', () => {
  const win = makeFakeWindow({ location: { search: '?utm_source=facebook&utm_campaign=launch_ads_1' } });
  const api = loadIntoSandbox(win);
  win.location.search = ''; // a doua vizita, navigare interna, fara parametri
  api._captureFromCurrentUrl();
  assert.deepEqual(api.getStoredAttribution(), { utm_source: 'facebook', utm_campaign: 'launch_ads_1' });
});

test('O a doua vizita CU parametri UTM noi suprascrie atribuirea veche (ultima atingere reala)', () => {
  const win = makeFakeWindow({ location: { search: '?utm_source=facebook&utm_campaign=old' } });
  const api = loadIntoSandbox(win);
  win.location.search = '?utm_source=instagram&utm_campaign=new';
  api._captureFromCurrentUrl();
  assert.deepEqual(api.getStoredAttribution(), { utm_source: 'instagram', utm_campaign: 'new' });
});

// ============================================================================
// Securitate — nicio scurgere de PII, nicio dependinta de campuri necunoscute
// ============================================================================
test('SECURITATE: attribution.js nu citeste/trimite niciodata email/nume/poveste', () => {
  // Exclude liniile de comentariu — codul sursa MENTIONEAZA in proza ce NU trimite, ceea ce ar
  // da un fals-pozitiv daca am cauta substringul brut peste tot (vezi test similar din
  // social-admin-ui.test.js).
  const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/\bemail\b/i.test(codeOnly));
  assert.ok(!/\bstory\b/i.test(codeOnly));
  assert.ok(!/\brecipient\b/i.test(codeOnly));
});
