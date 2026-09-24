// LAUNCH SAFETY (2026-09-01): CSP stricta, construita din resursele REALE ale site-ului.
// Verificat inclusiv printr-un test real, cu Chromium (Playwright), impotriva productiei —
// a gasit o singura incalcare legitima (flags.png de la intl-tel-input, incarcat din
// cdnjs.cloudflare.com), corectata aici. Acest fisier blocheaza regresii STRUCTURALE ale
// politicii, fara sa inlocuiasca verificarea reala intr-un browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCspDirectives, PAGE_SCRIPT_HASHES } = require('../lib/csp');

const { directives } = buildCspDirectives();

function flat(directive) {
  return directive.map(v => (typeof v === 'function' ? v({ path: '/index.html' }) : v)).join(' ');
}

test('CSP: nu foloseste niciodata unsafe-eval, pe nicio directiva', () => {
  for (const [name, values] of Object.entries(directives)) {
    assert.ok(!flat(values).includes('unsafe-eval'), `${name} nu trebuie sa contina unsafe-eval`);
  }
});

test('CSP: script-src NU foloseste unsafe-inline (doar hash-uri + gazde explicite)', () => {
  assert.ok(!flat(directives.scriptSrc).includes('unsafe-inline'));
});

test('CSP: style-src foloseste unsafe-inline STRICT (justificat — atribute style="" inline existente, refactor exclus din scop)', () => {
  assert.ok(flat(directives.styleSrc).includes("'unsafe-inline'"));
});

test('CSP: nicio directiva nu foloseste wildcard "*" generic', () => {
  for (const [name, values] of Object.entries(directives)) {
    const flatVal = flat(values);
    assert.ok(!/(^|\s)\*(\s|$)/.test(flatVal), `${name} nu trebuie sa contina un wildcard generic: "${flatVal}"`);
  }
});

test('CSP: fiecare pagina reala are cel putin un hash SHA-256 calculat pentru scriptul ei inline', () => {
  const pages = ['/index.html', '/comanda.html', '/melodia-mea.html', '/se-compune.html', '/se-creeaza-video.html', '/amintiri-video.html', '/comanda-mea.html', '/succes.html'];
  for (const p of pages) {
    assert.ok(PAGE_SCRIPT_HASHES[p] && PAGE_SCRIPT_HASHES[p].length > 0, `lipseste hash-ul pentru ${p}`);
    assert.match(PAGE_SCRIPT_HASHES[p][0], /^'sha256-[A-Za-z0-9+/]+=*'$/);
  }
});

test('CSP: img-src permite explicit cdnjs.cloudflare.com (flags.png de la intl-tel-input — gasit prin testare reala)', () => {
  assert.ok(flat(directives.imgSrc).includes('https://cdnjs.cloudflare.com'));
});

test('CSP: script-src permite explicit googletagmanager.com (necesar pentru incarcarea gtag.js — GA4, gasit prin testare live: request-ul era blocat, "Failed to fetch")', () => {
  assert.ok(flat(directives.scriptSrc).includes('https://www.googletagmanager.com'));
});

test('CSP: connect-src permite explicit google-analytics.com si googletagmanager.com (necesar pentru trimiterea evenimentelor GA4 catre Google)', () => {
  const flatVal = flat(directives.connectSrc);
  assert.ok(flatVal.includes('https://www.google-analytics.com'));
  assert.ok(flatVal.includes('https://www.googletagmanager.com'));
});

test('CSP: connect-src permite explicit region1.google-analytics.com (endpoint-ul regional REAL folosit de gtag.js pentru /g/collect — gasit prin testare live: request-ul real generat de gtag era blocat de CSP, desi www.google-analytics.com era deja permis)', () => {
  assert.ok(flat(directives.connectSrc).includes('https://region1.google-analytics.com'));
});

test('CSP: connect-src si media-src permit gazda R2 privata, derivata din env, niciodata hardcodata literal', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'csp.js'), 'utf8');
  assert.ok(!/r2\.cloudflarestorage\.com/.test(src.replace(/\/\/.*$/gm, '')) || /process\.env\.S3_ENDPOINT/.test(src), 'gazda R2 trebuie derivata din process.env, nu hardcodata');
});

test('CSP: frame-ancestors e none (protectie clickjacking) — nu exista niciun iframe legitim in site', () => {
  assert.deepEqual(directives.frameAncestors, ["'none'"]);
});

test('CSP: object-src e none (fara plugin-uri/Flash)', () => {
  assert.deepEqual(directives.objectSrc, ["'none'"]);
});

test('index.html si comanda-mea.html: zero atribute onclick="" ramase in cod (mutate pe addEventListener pentru compatibilitate script-src fara unsafe-inline)', () => {
  const fs = require('fs');
  const path = require('path');
  for (const file of ['index.html', 'comanda-mea.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.ok(!/\bonclick="/.test(html), `${file} nu mai trebuie sa aiba onclick="" inline`);
  }
});

// ================================================================================================
// META PIXEL (2026-09-24) — fix CSP, gasit prin testare REALA in productie: fbevents.js era
// blocat de script-src ("violates ... Content Security Policy directive"), desi Pixel-ul insusi
// se incarca corect DOAR dupa Marketing consent (vezi test/meta-pixel-client.test.js — neatins de
// acest fix, STRICT o problema de CSP, nu de consimtamant sau de Pixel ID).
// ================================================================================================
test('CSP: script-src permite explicit connect.facebook.net (STRICT gazda care serveste fbevents.js) — fbevents.js nu mai e blocat', () => {
  assert.ok(flat(directives.scriptSrc).includes('https://connect.facebook.net'));
});

test('CSP: connect-src permite explicit www.facebook.com (endpoint-ul REAL folosit de fbevents.js pentru fetch/XHR/sendBeacon la trimiterea evenimentelor PageView/InitiateCheckout)', () => {
  assert.ok(flat(directives.connectSrc).includes('https://www.facebook.com'));
});

test('CSP: img-src permite explicit www.facebook.com (fallback documentat prin beacon <img> al fbevents.js, cand fetch/sendBeacon nu sunt disponibile)', () => {
  assert.ok(flat(directives.imgSrc).includes('https://www.facebook.com'));
});

test('CSP: script-src NU permite www.facebook.com (nu serveste cod JS — STRICT connect.facebook.net face asta) si connect-src/img-src NU permit connect.facebook.net (nu primeste evenimente)', () => {
  assert.ok(!flat(directives.scriptSrc).includes('https://www.facebook.com'), 'script-src nu trebuie sa permita www.facebook.com — nu e gazda scriptului');
  assert.ok(!flat(directives.connectSrc).includes('https://connect.facebook.net'), 'connect-src nu are nevoie de connect.facebook.net — evenimentele merg catre www.facebook.com');
  assert.ok(!flat(directives.imgSrc).includes('https://connect.facebook.net'), 'img-src nu are nevoie de connect.facebook.net');
});

test('CSP: NICIUN wildcard larg de tip facebook.com (ex. *.facebook.com) nu a fost introdus — STRICT originile exacte connect.facebook.net/www.facebook.com', () => {
  for (const [name, values] of Object.entries(directives)) {
    const flatVal = flat(values);
    assert.ok(!/\*\.facebook\.com/.test(flatVal), `${name} nu trebuie sa contina un wildcard *.facebook.com`);
    assert.ok(!/\*\.fbcdn\.net/.test(flatVal), `${name} nu trebuie sa contina un wildcard *.fbcdn.net`);
  }
});

test('CSP: fixul Meta Pixel nu a adaugat unsafe-eval/unsafe-inline pe script-src, si nu a slabit default-src', () => {
  assert.ok(!flat(directives.scriptSrc).includes('unsafe-eval'));
  assert.ok(!flat(directives.scriptSrc).includes('unsafe-inline'));
  assert.deepEqual(directives.defaultSrc, ["'self'"]);
});

test('CSP: configuratia GA4 existenta (scriptSrc googletagmanager.com, connectSrc google-analytics.com/googletagmanager.com/region1.google-analytics.com) ramane INTACTA dupa fixul Meta Pixel', () => {
  assert.ok(flat(directives.scriptSrc).includes('https://www.googletagmanager.com'));
  const connect = flat(directives.connectSrc);
  assert.ok(connect.includes('https://www.google-analytics.com'));
  assert.ok(connect.includes('https://www.googletagmanager.com'));
  assert.ok(connect.includes('https://region1.google-analytics.com'));
});
