// CERINTA 2A/B (2026-08-31, "genuri muzicale si pagina separata pentru voce"): 16 genuri noi,
// in ordine fixa, 2 coloane, mapare reala catre furnizor, compatibilitate cu comenzile vechi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
const server = read('server.js');
const comanda = read('public/comanda.html');
const melodia = read('public/melodia-mea.html');

const NEW_GENRES_ORDERED = [
  'pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'
];
const LEGACY_ONLY_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'];
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===============================================================================================
// Test #2 din lista obligatorie — exact 16 genuri, in ordinea ceruta, in doua coloane.
// ===============================================================================================
test('comanda.html: grila principala de gen (#genre-grid) contine EXACT cele 16 genuri, in ordinea ceruta', () => {
  const gridIdx = comanda.indexOf('id="genre-grid"');
  const gridEnd = comanda.indexOf('<input type="hidden" id="genre"', gridIdx);
  const gridHtml = comanda.slice(gridIdx, gridEnd);
  const found = [...gridHtml.matchAll(/data-genre="([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(found, NEW_GENRES_ORDERED, 'ordinea si continutul grilei trebuie sa fie EXACT cele 16 genuri cerute, in aceasta ordine');
});

test('comanda.html: grila genului 2 (#genre2-grid, Premium) contine ACEEASI 16 genuri, in aceeasi ordine', () => {
  const gridIdx = comanda.indexOf('id="genre2-grid"');
  const gridEnd = comanda.indexOf('<input type="hidden" id="genre2"', gridIdx);
  const gridHtml = comanda.slice(gridIdx, gridEnd);
  const found = [...gridHtml.matchAll(/data-genre="([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(found, NEW_GENRES_ORDERED);
});

test('comanda.html: grila de gen ramane STRICT pe 2 coloane — nu se transforma in 3 pe desktop, nici in 1 pe iPhone', () => {
  const cssIdx = comanda.indexOf('.genre-grid{');
  const cssEnd = comanda.indexOf('.plan-list{', cssIdx);
  const cssBlock = comanda.slice(cssIdx, cssEnd);
  assert.match(cssBlock, /\.genre-grid\{[^}]*grid-template-columns:1fr 1fr;/);
  assert.ok(!/1fr 1fr 1fr/.test(cssBlock), 'blocul CSS al grilei de gen nu mai trebuie sa contina o varianta de 3 coloane');
  assert.ok(!/\.genre-grid\{[^{]*grid-template-columns:1fr;/.test(cssBlock), 'blocul CSS al grilei de gen nu mai trebuie sa contina o varianta de 1 coloana');
  assert.match(cssBlock, /@media \(max-width: 340px\)\{\s*\.genre-card\{/, 'ecranele foarte inguste trebuie sa ajusteze STRICT fontul/padding-ul cardului, nu numarul de coloane');
});

test('comanda.html: fiecare genre-card e accesibil prin tastatura (role=radio, tabindex=0, aria-selected)', () => {
  const cards = [...comanda.matchAll(/<div class="genre-card[^"]*" data-genre="[a-z_]+"[^>]*>/g)];
  assert.ok(cards.length >= 32, `asteptate cel putin 32 carduri (16 x 2 grile), gasite ${cards.length}`);
  cards.forEach(m => {
    assert.match(m[0], /role="radio"/);
    assert.match(m[0], /tabindex="0"/);
    assert.match(m[0], /aria-selected="false"/);
  });
});

test('comanda.html: selectarea unui gen functioneaza si prin tastatura (keydown Enter/Space), nu doar click', () => {
  assert.match(comanda, /function selectGenreCard\(c\) \{[\s\S]{0,400}?aria-selected/);
  assert.match(comanda, /genreCards\.forEach\(c => \{\s*c\.addEventListener\('click', \(\) => selectGenreCard\(c\)\);\s*c\.addEventListener\('keydown'/);
});

// ===============================================================================================
// Test #3 — maparea backend reala a fiecarui gen catre furnizor.
// ===============================================================================================
test('server.js: toate cele 16 genuri NOI sunt mapate in GENRE_STYLE_MAP cu descrieri distincte, nu un fallback generic', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const tags = {};
  NEW_GENRES_ORDERED.forEach(g => {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `genul nou "${g}" trebuie mapat in GENRE_STYLE_MAP`);
    tags[g] = m[1];
    assert.ok(m[1].length >= 20, `descrierea pentru "${g}" pare prea scurta/genereica: "${m[1]}"`);
  });
  const uniqueTags = new Set(Object.values(tags));
  assert.equal(uniqueTags.size, NEW_GENRES_ORDERED.length, 'fiecare gen nou trebuie sa aiba o descriere DISTINCTA (fara duplicate/fallback comun)');
});

test('server.js: mapari cheie per gen contin caracteristicile muzicale cerute explicit', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const expectations = {
    pop: [/pop/i],
    ballad_emotional: [/piano/i, /ballad|emotional/i],
    acoustic_folk: [/acoustic/i, /guitar/i],
    rnb: [/r&b/i, /groove|soulful/i],
    country: [/country/i, /guitar/i],
    jazz: [/jazz/i, /piano/i, /bass/i],
    edm_dance: [/edm|dance/i, /synth|drop|build/i],
    manele_suflet: [/manele/i, /clarinet/i],
    manele_jale: [/manele/i, /minor|grief|jale|mournful/i],
    populara: [/populara|folk/i, /violin|accordion/i],
    copii: [/child/i],
    colind: [/carol|christmas/i],
    romantic: [/romantic/i, /intimate|warm/i],
    motivational: [/anthem|inspirational/i]
  };
  Object.entries(expectations).forEach(([genre, patterns]) => {
    const m = body.match(new RegExp(`\\b${genre}: '([^']+)'`));
    patterns.forEach(p => assert.match(m[1], p, `"${genre}" trebuie sa mentioneze ${p} — a produs: ${m[1]}`));
  });
});

// ===============================================================================================
// Test #4 — compatibilitatea comenzilor vechi cu vechile chei de gen.
// ===============================================================================================
test('server.js: ALLOWED_GENRES contine STRICT cele 7 chei vechi + cele 16 noi (23 total, fara duplicate)', () => {
  const idx = server.indexOf('const ALLOWED_GENRES = ');
  const line = server.slice(idx, server.indexOf(';', idx) + 1);
  assert.match(line, /\[\.\.\.LEGACY_ONLY_GENRES, \.\.\.NEW_GENRES\]/);
  const legacyIdx = server.indexOf('const LEGACY_ONLY_GENRES = ');
  const legacyLine = server.slice(legacyIdx, server.indexOf(';', legacyIdx) + 1);
  LEGACY_ONLY_GENRES.forEach(g => assert.ok(legacyLine.includes(`'${g}'`), `cheia veche "${g}" trebuie pastrata in LEGACY_ONLY_GENRES`));
  const newIdx = server.indexOf('const NEW_GENRES = ');
  const newLine = server.slice(newIdx, server.indexOf(';', newIdx) + 1);
  NEW_GENRES_ORDERED.forEach(g => assert.ok(newLine.includes(`'${g}'`), `genul nou "${g}" trebuie sa fie in NEW_GENRES`));
});

test('server.js: GENRE_STYLE_MAP pastreaza toate cele 7 chei vechi, byte-identice, pentru regenerarea comenzilor existente', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const legacyUnchanged = {
    emotional: 'cinematic orchestral ballad, swelling strings and piano, rubato build, breathy vulnerable vocal, tearful climax',
    suflet: 'intimate de suflet ballad, sparse guitar or piano, close warm vocal, quiet confessional unpolished mood',
    acustic: 'unplugged acoustic folk, fingerpicked guitar, light percussion, natural room sound, plain sincere vocal',
    petrecere: 'fast Romanian party beat, 130+bpm, syncopated dance rhythm, horns and synth stabs, shouted chorus, club energy',
    balada: 'slow rubato piano ballad, sustained strings, no beat, dramatic dynamic swells, powerful sustained vocal',
    manele: 'Romanian manele de jale, oriental scale, mournful clarinet, melismatic vocal slides, minor key grief',
    modern: 'sleek modern pop-electronic, deep 808 sub bass, glossy synth pads, vocal chops, minimalist premium production'
  };
  Object.entries(legacyUnchanged).forEach(([genre, tag]) => {
    assert.ok(body.includes(`${genre}: '${tag}'`), `cheia veche "${genre}" trebuie sa ramana byte-identica`);
  });
});

test('FUNCTIONAL: o comanda veche cu genre="suflet" (cheie veche) trece validarea ALLOWED_GENRES.includes()', () => {
  const idx = server.indexOf('const LEGACY_ONLY_GENRES = ');
  const allowedIdx = server.indexOf('const ALLOWED_GENRES = ', idx);
  const allowedEnd = server.indexOf(';', allowedIdx) + 1;
  const code = server.slice(idx, allowedEnd) + '\nmodule.exports = { ALLOWED_GENRES };';
  const scratchPath = path.join(require('node:os').tmpdir(), `_genrecheck_${Date.now()}.js`);
  fs.writeFileSync(scratchPath, code);
  try {
    const { ALLOWED_GENRES } = require(scratchPath);
    LEGACY_ONLY_GENRES.forEach(g => assert.ok(ALLOWED_GENRES.includes(g), `cheia veche "${g}" trebuie sa treaca validarea`));
    NEW_GENRES_ORDERED.forEach(g => assert.ok(ALLOWED_GENRES.includes(g), `genul nou "${g}" trebuie sa treaca validarea`));
    assert.ok(!ALLOWED_GENRES.includes('nu_exista'), 'o cheie inventata nu trebuie sa treaca validarea');
  } finally {
    fs.unlinkSync(scratchPath);
    delete require.cache[require.resolve(scratchPath)];
  }
});

test('melodia-mea.html: EDIT_GENRE_KEYS (selectorul de editare/regenerare) foloseste STRICT cele 16 genuri NOI, niciodata cele vechi', () => {
  const idx = melodia.indexOf('const EDIT_GENRE_KEYS = ');
  const line = melodia.slice(idx, melodia.indexOf(';', idx) + 1);
  NEW_GENRES_ORDERED.forEach(g => assert.ok(line.includes(`'${g}'`), `EDIT_GENRE_KEYS trebuie sa contina "${g}"`));
  LEGACY_ONLY_GENRES.forEach(g => assert.ok(!line.includes(`'${g}'`), `EDIT_GENRE_KEYS nu mai trebuie sa ofere cheia veche "${g}" ca optiune noua`));
});

test('melodia-mea.html: o comanda veche cu gen legacy afiseaza acel gen ca optiune curenta injectata (nu il schimba tacit)', () => {
  assert.match(melodia, /const LEGACY_GENRE_KEYS = \['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'\];/);
  assert.match(melodia, /function buildGenreOptionsHtml\(genreKeys, currentGenre\) \{/);
  const idx = melodia.indexOf('function buildGenreOptionsHtml');
  const snippet = melodia.slice(idx, idx + 700);
  assert.match(snippet, /LEGACY_GENRE_KEYS\.includes\(currentGenre\) && !genreKeys\.includes\(currentGenre\)/, 'trebuie sa injecteze genul vechi curent ca optiune suplimentara, nu sa-l ignore');
});

test('melodia-mea.html: populateGenreSelect si populateGenreOptions (Premium) folosesc AMBELE buildGenreOptionsHtml — acelasi comportament de compatibilitate in ambele locuri', () => {
  assert.match(melodia, /function populateGenreSelect\(order\) \{[\s\S]{0,300}?buildGenreOptionsHtml\(EDIT_GENRE_KEYS, currentGenre\)/);
  assert.match(melodia, /function populateGenreOptions\(selectEl, currentGenre\) \{\s*selectEl\.innerHTML = buildGenreOptionsHtml\(EDIT_GENRE_KEYS, currentGenre\);/);
});

// ===============================================================================================
// Traduceri — toate cele 16 chei noi, in toate cele 8 limbi, in comanda.html si melodia-mea.html.
// ===============================================================================================
for (const file of ['public/comanda.html', 'public/melodia-mea.html']) {
  test(`${file}: toate cele 16 chei de traducere genre_* (noi) exista de exact 8 ori (o data per limba)`, () => {
    const content = read(file);
    NEW_GENRES_ORDERED.forEach(g => {
      const count = (content.match(new RegExp(`genre_${g}: '`, 'g')) || []).length;
      assert.equal(count, 8, `genre_${g} trebuie sa apara de 8 ori (una per limba) in ${file}, gasit ${count}`);
    });
  });
}

test('comanda.html si melodia-mea.html raman sintactic valide dupa aceasta corectie', () => {
  [comanda, melodia].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach(m => assert.doesNotThrow(() => new Function(m[1])));
  });
});

test('node --check server.js trece', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
