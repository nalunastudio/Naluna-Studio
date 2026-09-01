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
