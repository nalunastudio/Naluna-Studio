// FIX (incident real, 8 oct 2026 — reprodus direct intr-un browser real, nu presupus):
// lib/csp.js hash-uia bytes-ii BRUTI de pe disc pentru hash-ul CSP al <script>-urilor inline.
// Browserul normalizeaza \r\n si \r izolat la \n INAINTE de a calcula propriul hash (spec HTML5,
// "preprocessing the input stream") — daca fisierul de pe disc are CRLF (ex. deploy facut dintr-un
// working tree Windows, nu dintr-un checkout git curat pe Linux), cele doua hash-uri NU coincid,
// iar browserul blocheaza STRICT si SILENTIOS intregul <script> inline. Fix: hashInlineScripts()
// normalizeaza ACUM identic cu browserul, inainte de orice calcul de hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashInlineScripts, normalizeNewlinesLikeBrowser } = require('../lib/csp.js');

// Exact ce calculeaza un browser real pentru hash-ul CSP al unui <script> inline — folosit STRICT
// ca oracol independent in aceste teste (nu reutilizeaza implementarea din lib/csp.js).
function browserHash(scriptContent) {
  const normalized = scriptContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `'sha256-${crypto.createHash('sha256').update(normalized, 'utf8').digest('base64')}'`;
}

test('normalizeNewlinesLikeBrowser: LF ramane neschimbat', () => {
  assert.equal(normalizeNewlinesLikeBrowser('a\nb\nc'), 'a\nb\nc');
});

test('normalizeNewlinesLikeBrowser: CRLF devine LF (perechi normale de checkout Windows)', () => {
  assert.equal(normalizeNewlinesLikeBrowser('a\r\nb\r\nc'), 'a\nb\nc');
});

test('normalizeNewlinesLikeBrowser: CR izolat (neurmat de LF) devine LF', () => {
  assert.equal(normalizeNewlinesLikeBrowser('a\rb\rc'), 'a\nb\nc');
});

test('normalizeNewlinesLikeBrowser: mix CRLF + CR izolat, in acelasi text', () => {
  assert.equal(normalizeNewlinesLikeBrowser('a\r\nb\rc\r\nd'), 'a\nb\nc\nd');
});

for (const [label, content] of [
  ['LF', 'const x = 1;\nconsole.log(x);\n'],
  ['CRLF', 'const x = 1;\r\nconsole.log(x);\r\n'],
  ['CR izolat', 'const x = 1;\rconsole.log(x);\r'],
  ['mix CRLF+CR', 'const x = 1;\r\nif (x) {\rconsole.log(x);\r\n}\r'],
]) {
  test(`hashInlineScripts(): pentru line-ending-ul ${label}, hash-ul CSP calculat coincide EXACT cu ce ar calcula un browser real`, () => {
    const html = `<!DOCTYPE html><html><body><script>${content}</script></body></html>`;
    const [hash] = hashInlineScripts(html);
    assert.equal(hash, browserHash(content), `hash-ul pentru varianta ${label} trebuie sa coincida cu oracolul browserului`);
  });
}

test('hashInlineScripts(): doua fisiere cu CONTINUT identic dar line-ending diferit (LF vs CRLF) produc EXACT acelasi hash CSP', () => {
  const lf = `<script>const a = 1;\nconst b = 2;\n</script>`;
  const crlf = `<script>const a = 1;\r\nconst b = 2;\r\n</script>`;
  assert.deepEqual(hashInlineScripts(lf), hashInlineScripts(crlf));
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AFFECTED_PAGES = ['se-compune.html', 'melodia-mea.html', 'succes.html', 'se-creeaza-video.html'];

AFFECTED_PAGES.forEach((file) => {
  test(`public/${file}: hash-ul CSP calculat de lib/csp.js coincide cu ce ar calcula un browser real, INDIFERENT de line-ending-ul fisierului de pe disc`, () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    const expected = [];
    let m;
    while ((m = re.exec(html))) {
      if (!m[1].trim()) continue;
      expected.push(browserHash(m[1]));
    }
    assert.deepEqual(hashInlineScripts(html), expected, `public/${file} trebuie sa produca hash-uri CSP identice cu oracolul browserului`);
  });
});

test('fix-ul NU dezactiveaza si NU slabeste CSP: hashInlineScripts() produce in continuare un hash SHA-256 real per <script> inline, nu un wildcard/unsafe-inline', () => {
  const html = `<!DOCTYPE html><html><body><script>console.log(1);</script></body></html>`;
  const hashes = hashInlineScripts(html);
  assert.equal(hashes.length, 1);
  assert.match(hashes[0], /^'sha256-[A-Za-z0-9+/]+=*'$/);
  assert.ok(!hashes.includes("'unsafe-inline'"));
});
