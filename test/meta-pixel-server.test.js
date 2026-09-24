// META PIXEL V1 (2026-09-24) — teste server-side: GET /js/config.js expune META_PIXEL_ID (public
// prin design), NICIODATA vreun secret; POST /api/orders valideaza STRICT formatul _fbp inainte
// de persistare (orders.fbp, coloana existenta deja).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

// ================================================================================================
// GET /js/config.js — META_PIXEL_ID.
// ================================================================================================
test('GET /js/config.js: expune window.NALUNA_META_PIXEL_ID, citit STRICT din process.env.META_PIXEL_ID', () => {
  const idx = server.indexOf("app.get('/js/config.js'");
  assert.ok(idx !== -1);
  const routeEnd = server.indexOf('\n});', idx) + 4;
  const routeBody = server.slice(idx, routeEnd);
  assert.match(routeBody, /const metaPixelId = \(process\.env\.META_PIXEL_ID \|\| ''\)\.trim\(\);/);
  assert.match(routeBody, /window\.NALUNA_META_PIXEL_ID = \$\{JSON\.stringify\(metaPixelId\)\}/);
});

test('GET /js/config.js: raspunsul NU expune NICIODATA META_CAPI_ACCESS_TOKEN sau META_DATASET_ID (STRICT server-side, folosite doar de Meta CAPI)', () => {
  const idx = server.indexOf("app.get('/js/config.js'");
  const routeEnd = server.indexOf('\n});', idx) + 4;
  const routeBody = server.slice(idx, routeEnd);
  assert.doesNotMatch(routeBody, /META_CAPI_ACCESS_TOKEN/);
  assert.doesNotMatch(routeBody, /META_DATASET_ID/);
});

test('GET /js/config.js: raspunsul ramane NECACHE-uit (Cache-Control: no-store)', () => {
  const idx = server.indexOf("app.get('/js/config.js'");
  const routeEnd = server.indexOf('\n});', idx) + 4;
  const routeBody = server.slice(idx, routeEnd);
  assert.match(routeBody, /no-store/);
});

// ================================================================================================
// POST /api/orders — validare format _fbp (executabila, nu doar text-matching).
// ================================================================================================
function extractSafeFbp() {
  const idx = server.indexOf('const FBP_FORMAT_RE = ');
  assert.ok(idx !== -1, 'validarea FBP_FORMAT_RE trebuie sa existe in server.js');
  const end = server.indexOf(';', server.indexOf('const safeFbp =', idx)) + 1;
  const snippet = server.slice(idx, end);
  const factory = new Function('fbp', `${snippet}\nreturn safeFbp;`);
  return (fbp) => factory(fbp);
}

test('safeFbp: valoare REALA, format Meta documentat (fb.<index>.<timestamp>.<random>) -> pastrata neschimbata', () => {
  const safeFbp = extractSafeFbp();
  assert.equal(safeFbp('fb.1.1596403881668.1116446470'), 'fb.1.1596403881668.1116446470');
});

test('safeFbp: lipsa/null/undefined -> null, fara nicio eroare', () => {
  const safeFbp = extractSafeFbp();
  assert.equal(safeFbp(undefined), null);
  assert.equal(safeFbp(null), null);
  assert.equal(safeFbp(''), null);
});

test('safeFbp: format INVALID (text liber, cookie strain, fbclid confundat cu fbp) -> respins, null', () => {
  const safeFbp = extractSafeFbp();
  assert.equal(safeFbp('not-a-valid-fbp'), null);
  assert.equal(safeFbp('fb.1.abc.123'), null, 'timestamp non-numeric trebuie respins');
  assert.equal(safeFbp('fb..123.456'), null, 'index lipsa trebuie respins');
  assert.equal(safeFbp('IwAR1234567890'), null, 'un fbclid brut nu trebuie acceptat ca fbp');
  assert.equal(safeFbp('<script>alert(1)</script>'), null, 'input malitios trebuie respins sigur');
});

test('safeFbp: tip non-string (numar, obiect, array) -> null, fara sa arunce', () => {
  const safeFbp = extractSafeFbp();
  assert.equal(safeFbp(12345), null);
  assert.equal(safeFbp({ a: 1 }), null);
  assert.equal(safeFbp(['fb.1.1.1']), null);
});

test('safeFbp: valoare excesiv de lunga (peste 100 caractere) -> respinsa, chiar daca prefixul e valid', () => {
  const safeFbp = extractSafeFbp();
  const tooLong = 'fb.1.1596403881668.' + '1'.repeat(90);
  assert.ok(tooLong.length > 100);
  assert.equal(safeFbp(tooLong), null);
});

test('POST /api/orders: destructureaza "fbp" din req.body (neschimbat) SI foloseste STRICT safeFbp (nu safeAttr generic) la createOrder', () => {
  const idx = server.indexOf("app.post('/api/orders', orderCreationLimiter");
  const routeStart = server.slice(idx, idx + 1500);
  assert.match(routeStart, /utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid, fbp/);
  const createOrderIdx = server.indexOf('fbp: safeFbp,', idx);
  assert.ok(createOrderIdx !== -1, 'db.createOrder trebuie sa primeasca STRICT fbp: safeFbp (nu safeAttr(fbp))');
});

// ================================================================================================
// comanda.html — trimite fbp STRICT prin getFbpForOrder() (NalunaAnalytics), niciodata citit
// direct din document.cookie in pagina (sursa unica ramane analytics.js).
// ================================================================================================
test('comanda.html: collectPayload() trimite fbp STRICT prin window.NalunaAnalytics.getFbpForOrder(), niciodata document.cookie citit direct in pagina', () => {
  const comanda = read('public/comanda.html');
  assert.match(comanda, /fbp:\s*\(typeof window !== 'undefined' && window\.NalunaAnalytics\) \? window\.NalunaAnalytics\.getFbpForOrder\(\) : null,/);
  assert.doesNotMatch(comanda, /document\.cookie/, 'comanda.html nu trebuie sa citeasca vreodata cookie-uri direct — STRICT prin API-ul din analytics.js');
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
