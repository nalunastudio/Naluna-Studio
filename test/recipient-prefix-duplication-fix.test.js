// PROBLEMA 2 (2026-09-27, bug REAL raportat dupa testare in productie): "Pentru: Pentru sotia
// mea" (email) / "Pentru Pentru sotia mea" (pagina comenzii) — campul liber "recipient" poate
// contine deja, scris de client, un prefix natural echivalent cu eticheta afisata ("Pentru"/
// "For"/etc.), iar eticheta era adaugata DIN NOU la afisare, dublandu-l vizibil.
//
// REPARATIE: STRICT o normalizare de PREZENTARE (stripRedundantForPrefix), aplicata identic in
// toate cele 5 locuri identificate prin audit (sendDeliveryEmail, sendAccessRecoveryEmail,
// comanda-mea.html, comenzile-mele.html, melodia-mea.html) — NICIODATA nu modifica valoarea din
// DB. O valoare care NU incepe cu cuvantul-eticheta (ex. "Maria") ramane complet neatinsa.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const comandaMea = read('public/comanda-mea.html');
const comenzileMele = read('public/comenzile-mele.html');
const melodiaMea = read('public/melodia-mea.html');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractBraced(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = start + signature.length;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function findStripFnSignature(src) {
  const match = src.match(/function stripRedundantForPrefix\(value, \w+\) \{/);
  assert.ok(match, 'nu am gasit definitia stripRedundantForPrefix');
  return match[0];
}

function loadStripFn(src) {
  const signature = findStripFnSignature(src);
  const body = extractBraced(src, signature);
  const wordsIdx = src.lastIndexOf('const FOR_WORD_BY_LANG', src.indexOf(body));
  const wordsLine = src.slice(wordsIdx, src.indexOf('\n', wordsIdx) + 1);
  return new Function(wordsLine + 'function stripRedundantForPrefix' + body.slice(body.indexOf('(')) + '\nreturn stripRedundantForPrefix;')();
}

// ===============================================================================================
// (1) Existenta si comportamentul functiei — o data pentru server.js, o data per pagina HTML
// (verificare ca fiecare copie e independent corecta, desi codul e duplicat intre fisiere,
// consecvent cu restul acestui proiect, care nu are module JS partajate intre pagini).
// ===============================================================================================
for (const [label, src] of [['server.js', server], ['comanda-mea.html', comandaMea], ['comenzile-mele.html', comenzileMele], ['melodia-mea.html', melodiaMea]]) {
  test(`${label}: stripRedundantForPrefix exista si acopera toate cele 8 limbi in FOR_WORD_BY_LANG`, () => {
    assert.match(src, /function stripRedundantForPrefix\(value, \w+\) \{/);
    for (const lang of ALLOWED_LANGS) {
      assert.match(src, new RegExp(`${lang}: '[^']+'`), `[${label}] limba ${lang} lipseste din FOR_WORD_BY_LANG`);
    }
  });

  test(`${label}: stripRedundantForPrefix — "Pentru sotia mea" (RO) devine "sotia mea" (prefixul e eliminat o singura data)`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('Pentru sotia mea', 'ro'), 'sotia mea');
  });

  test(`${label}: stripRedundantForPrefix — "Maria" (fara prefix) ramane NEATINS`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('Maria', 'ro'), 'Maria');
  });

  test(`${label}: stripRedundantForPrefix — insensibil la majuscule ("PENTRU sotia mea", "pentru sotia mea")`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('PENTRU sotia mea', 'ro'), 'sotia mea');
    assert.equal(fn('pentru sotia mea', 'ro'), 'sotia mea');
  });

  test(`${label}: stripRedundantForPrefix — NU elimina "pentru" din interiorul unui nume legitim (ex. "Anda pentru totdeauna" ramane neschimbat — doar prefixul de INCEPUT conteaza)`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('Anda pentru totdeauna', 'ro'), 'Anda pentru totdeauna');
  });

  test(`${label}: stripRedundantForPrefix — un nume care e chiar cuvantul-eticheta izolat (foarte rar) nu arunca eroare, produce string gol`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('Pentru', 'ro'), '');
  });

  test(`${label}: stripRedundantForPrefix — gol/null/undefined nu arunca eroare`, () => {
    const fn = loadStripFn(src);
    assert.equal(fn('', 'ro'), '');
    assert.equal(fn(null, 'ro'), '');
    assert.equal(fn(undefined, 'ro'), '');
  });

  for (const lang of ALLOWED_LANGS) {
    test(`${label}: stripRedundantForPrefix functioneaza pentru limba ${lang} (word cade pe fallback ro daca lipseste)`, () => {
      const fn = loadStripFn(src);
      assert.doesNotThrow(() => fn('Maria', lang));
    });
  }
}

// ===============================================================================================
// (2) server.js — sendDeliveryEmail: subject SI body folosesc displayRecipient (nu order.recipient
// brut), in toate cele 8 sabloane.
// ===============================================================================================
test('server.js: sendDeliveryEmail() calculeaza displayRecipient = stripRedundantForPrefix(order.recipient, order.lang) INAINTE de a construi safeRecipient/subiectele', () => {
  const body = extractBraced(server, 'async function sendDeliveryEmail(order) {');
  assert.match(body, /const displayRecipient = stripRedundantForPrefix\(order\.recipient, order\.lang\);/);
  assert.match(body, /const safeRecipient = escapeHtmlForEmail\(displayRecipient\);/);
});

test('server.js: toate cele 8 subiecte ale emailului de livrare folosesc ${displayRecipient}, niciodata ${order.recipient} brut', () => {
  const body = extractBraced(server, 'async function sendDeliveryEmail(order) {');
  const subjectMatches = body.match(/subject: `[^`]*`/g) || [];
  assert.equal(subjectMatches.length, 8, 'trebuie sa existe exact 8 subiecte (cate unul per limba)');
  for (const s of subjectMatches) {
    assert.ok(!/\$\{order\.recipient\}/.test(s), `subiectul nu trebuie sa foloseasca order.recipient brut: ${s}`);
  }
});

// ===============================================================================================
// (3) server.js — sendAccessRecoveryEmail: cardurile folosesc stripRedundantForPrefix(..., safeLang).
// ===============================================================================================
test('server.js: sendAccessRecoveryEmail() aplica stripRedundantForPrefix(order.recipient, safeLang) inainte de escapeHtmlForEmail, per comanda din lista', () => {
  const body = extractBraced(server, 'async function sendAccessRecoveryEmail({ email, lang, orders }) {');
  assert.match(body, /escapeHtmlForEmail\(stripRedundantForPrefix\(order\.recipient \|\| '', safeLang\)\)/);
});

// ===============================================================================================
// (4) comanda-mea.html / comenzile-mele.html — recipient afisat prin stripRedundantForPrefix(..., lang).
// ===============================================================================================
test('comanda-mea.html: randul "Pentru X" foloseste stripRedundantForPrefix(o.recipient, lang)', () => {
  assert.match(comandaMea, /\$\{t\.for_label\} \$\{escapeHtml\(stripRedundantForPrefix\(o\.recipient, lang\)\)\}/);
});

test('comenzile-mele.html: randul "Pentru: X" foloseste stripRedundantForPrefix(order.recipient, lang)', () => {
  assert.match(comenzileMele, /\$\{escapeHtml\(t\.for_label\)\}: \$\{escapeHtml\(stripRedundantForPrefix\(order\.recipient, lang\)\)\}/);
});

// ===============================================================================================
// (5) melodia-mea.html — composePersonalizedHeading + fallback folosesc recipientForHeading /
// stripRedundantForPrefix, in toate ramurile (nunta/botez, familie individuala, fallback generic).
// ===============================================================================================
test('melodia-mea.html: composePersonalizedHeading() calculeaza recipientForHeading = stripRedundantForPrefix(order.recipient, activeLang) si il foloseste in toate ramurile (nunta/botez + familie individuala)', () => {
  const body = extractBraced(melodiaMea, 'function composePersonalizedHeading(order, activeLang) {');
  assert.match(body, /const recipientForHeading = stripRedundantForPrefix\(order\.recipient, activeLang\);/);
  assert.match(body, /templates\[order\.weddingType\]\(recipientForHeading\)/);
  assert.match(body, /headingFn\(recipientNoun, recipientForHeading\)/);
  assert.ok(!/order\.recipient \|\| ''/.test(body), 'nicio ramura nu mai trebuie sa foloseasca order.recipient brut');
});

test('melodia-mea.html: antetul FALLBACK (comenzi fara recipientRole) foloseste t.heading(stripRedundantForPrefix(order.recipient, lang))', () => {
  assert.match(melodiaMea, /t\.heading\(stripRedundantForPrefix\(order\.recipient, lang\)\)/);
});

// ===============================================================================================
// (6) Exemplele EXACTE cerute — valoare care deja incepe cu eticheta vs. nume legitim.
// ===============================================================================================
test('exemplu cerut explicit: valoarea "Pentru sotia mea" produce afisare naturala o singura data (nu "Pentru: Pentru sotia mea")', () => {
  const fn = loadStripFn(server);
  const displayValue = fn('Pentru sotia mea', 'ro');
  const finalLine = `Pentru: ${displayValue}`;
  assert.equal(finalLine, 'Pentru: sotia mea');
  assert.ok(!/Pentru:\s*Pentru/i.test(finalLine));
});

test('exemplu cerut explicit: valoarea "Maria" ramane "Pentru: Maria", conform designului existent', () => {
  const fn = loadStripFn(server);
  const displayValue = fn('Maria', 'ro');
  assert.equal(`Pentru: ${displayValue}`, 'Pentru: Maria');
});

// ===============================================================================================
// (7) Confirmare — NU se modifica NICIODATA date in DB (fix STRICT de prezentare).
// ===============================================================================================
test('db.js: nicio modificare — normalizarea NU atinge db.js (fix STRICT client-side/email, niciodata scriere in DB)', () => {
  const dbSrc = read('db.js');
  assert.ok(!dbSrc.includes('stripRedundantForPrefix'));
});

test('node --check server.js trece (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
