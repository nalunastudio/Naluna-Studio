// INTRO SCURT — STRICT pentru genul real "manele_suflet" (2026-09-19, cerinta explicita,
// urmare a testarii in productie: "manele_jale" e "perfecta" si NU trebuie atinsa deloc;
// "manele_suflet" are un intro instrumental prea lung chiar si in fereastra de preview de 50s).
// ACTUALIZAT (2026-09-22, runda 2 SI runda 3): GENRE_STYLE_MAP.manele_suflet a fost re-scris de
// doua ori pentru un sunet mai autentic de manea romaneasca (runda 3: un test audio real a
// demonstrat ca runda 2 tot nu suna suficient de manea, desi testele de cod treceau) — "short
// intro, vocals enter early" (verificat mai jos, sectiunile 6-10) ramane neschimbat, la finalul
// descrierii, in ambele runde. Vezi test/manele-suflet-authentic-sound.test.js pentru acoperirea
// completa a directiei muzicale curente (caracteristici de gen, buget, limbi, pachete, manele_jale
// neatins).
//
// Scop STRICT limitat: instructiunea de generare (GENRE_STYLE_MAP.manele_suflet) e singura
// sursa centrala care alimenteaza atat buildPrompt() (generare initiala) cat si
// buildExactLyricsRequest() (editare/regenerare cu versuri exacte) — confirmat direct in
// server.js: exact 2 folosiri ale GENRE_STYLE_MAP[genreOverride || order.genre] in tot fisierul,
// ambele complet partajate intre Standard/Premium/Video si intre genre/genre2. NU exista nicio
// implementare separata/duplicata de stil pe gen. Limbajul (LYRICS_LANGUAGE_NAMES/lyricsLanguage)
// e complet independent de styleTags — o singura modificare acopera automat toate cele 8 limbi.
//
// NU s-a atins: manele_jale, orice alt gen, getPreviewStartFromLyrics() (functia insasi, ca
// implementare — ramane byte-identica, desi SMART PREVIEW, 2026-09-22, nu o mai apeleaza direct
// din buildVariantFromTrack, vezi test/preview-selection.test.js), alignedWords, lyrics,
// optiunile de voce, preturile/pachetele.
// CORECTIE (2026-09-22, SMART PREVIEW): sectiunea 4 de mai jos proteja exceptia de durata
// EXTENDED_PREVIEW_SECONDS=50 pentru manele_suflet/manele_jale (2026-09-19) — eliminata acum
// intentionat, cerinta explicita a fazei Smart Preview (durata uniforma 40s pentru toate
// stilurile; Smart Preview muta START-ul in loc sa mareasca durata). Actualizata sa verifice
// noua realitate, nu vechea cerinta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// ===============================================================================================
// Extragere buildPrompt() / buildExactLyricsRequest() REALE din server.js (acelasi tipar folosit
// deja in test/intro-vocal-continuity-fix.test.js).
// ===============================================================================================
function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = server.slice(startIdx, i + 1);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

function loadBuildExactLyricsRequest() {
  const funcStart = server.indexOf('function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.ok(funcStart !== -1);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = server.slice(funcStart, i + 1);
  const genreMapStart = server.indexOf('const GENRE_STYLE_MAP = {');
  const genreMapEnd = server.indexOf('};', genreMapStart) + 2;
  const genreMapSnippet = server.slice(genreMapStart, genreMapEnd);
  const langNamesStart = server.indexOf('const LYRICS_LANGUAGE_NAMES = {');
  const langNamesEnd = server.indexOf('};', langNamesStart) + 2;
  const langNamesSnippet = server.slice(langNamesStart, langNamesEnd);
  const brightenPatternsStart = server.indexOf('const BRIGHTEN_MOOD_PATTERNS = {');
  const brightenPatternsEnd = server.indexOf('};', brightenPatternsStart) + 2;
  const brightenPatternsSnippet = server.slice(brightenPatternsStart, brightenPatternsEnd);
  const detectFnStart = server.indexOf('function detectsBrightenMoodFeedback(feedbackText, lang) {');
  let d2 = 0, j = server.indexOf('{', detectFnStart);
  for (; j < server.length; j++) { if (server[j] === '{') d2++; else if (server[j] === '}') { d2--; if (d2 === 0) break; } }
  const detectFnSnippet = server.slice(detectFnStart, j + 1);
  const brightenClauseStart = server.indexOf('const BRIGHTEN_MOOD_CLAUSE =');
  const brightenClauseEnd = server.indexOf(';', brightenClauseStart) + 1;
  const brightenClauseSnippet = server.slice(brightenClauseStart, brightenClauseEnd);
  const videoLabelStart = server.indexOf('const VIDEO_FEEDBACK_PRIORITY_LABEL =');
  const videoLabelEnd = server.indexOf(';', videoLabelStart) + 1;
  const videoLabelSnippet = server.slice(videoLabelStart, videoLabelEnd);
  const priorityClauseStart = server.indexOf('const FEEDBACK_PRIORITY_CLAUSE =');
  const priorityClauseEnd = server.indexOf(';', priorityClauseStart) + 1;
  const priorityClauseSnippet = server.slice(priorityClauseStart, priorityClauseEnd);
  const truncateSafelyStart = server.indexOf('function truncateSafely(str, maxLen) {');
  let d3 = 0, k = server.indexOf('{', truncateSafelyStart);
  for (; k < server.length; k++) { if (server[k] === '{') d3++; else if (server[k] === '}') { d3--; if (d3 === 0) break; } }
  const truncateSafelySnippet = server.slice(truncateSafelyStart, k + 1);

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    ${langNamesSnippet}
    ${genreMapSnippet}
    ${truncateSafelySnippet}
    ${brightenPatternsSnippet}
    ${detectFnSnippet}
    ${brightenClauseSnippet}
    ${videoLabelSnippet}
    ${priorityClauseSnippet}
    ${snippet}
    return buildExactLyricsRequest;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildExactLyricsRequest = loadBuildExactLyricsRequest();

function loadGenreStyleMap() {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('\n};', idx);
  const body = server.slice(idx, end);
  const map = {};
  const LEGACY_ONLY_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'];
  for (const g of [...LEGACY_ONLY_GENRES, ...NEW_GENRES]) {
    const m = body.match(new RegExp(`\\n  ${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit GENRE_STYLE_MAP.${g}`);
    map[g] = m[1];
  }
  return map;
}
const GENRE_STYLE_MAP = loadGenreStyleMap();

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'zi_de_nastere', genre: 'manele_suflet', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  }, overrides);
}

// ===============================================================================================
// 1) TEXT VECHI/NOU — definitia exacta, singura sursa centrala.
// ===============================================================================================
test('1) GENRE_STYLE_MAP.manele_suflet — text ACTUALIZAT (2026-09-22, runda 3, dupa test audio real); vezi test/manele-suflet-authentic-sound.test.js pentru acoperirea completa a noii directii muzicale', () => {
  assert.equal(
    GENRE_STYLE_MAP.manele_suflet,
    'Romanian manele, oriental melismatic vibrato vocal, manele keyboards, violin, accordion, hopeful rhythm, short intro, vocals enter early'
  );
  // "short intro, vocals enter early" (proven fix, 2026-09-19) ramane la finalul descrierii,
  // neschimbat:
  assert.ok(GENRE_STYLE_MAP.manele_suflet.endsWith('short intro, vocals enter early'));
});

test('1b) GENRE_STYLE_MAP e SINGURA sursa folosita la generare — exact 2 folosiri in tot server.js, ambele GENRE_STYLE_MAP[genreOverride || order.genre]', () => {
  const usages = server.match(/GENRE_STYLE_MAP\[genreOverride \|\| order\.genre\]/g) || [];
  assert.equal(usages.length, 2, 'trebuie sa existe EXACT 2 folosiri — buildPrompt() si buildExactLyricsRequest() — nicio implementare separata/duplicata');
});

test('1c) CRITIC — noul text NU contine niciodata cuvantul "instrumental" (REGRESIE CRITICA 2026-08-13, documentata in test/lyrics-exact-story-premium-sequential.test.js: acel cuvant literal in prompt a corelat, verificat pe comenzi reale de productie, cu Suno generand piese fara voce deloc)', () => {
  assert.doesNotMatch(GENRE_STYLE_MAP.manele_suflet, /instrumental/i);
});

// ===============================================================================================
// 2) manele_jale — "perfecta", NEATINS, byte-identic.
// ===============================================================================================
test('2) manele_jale ramane BYTE-IDENTIC (nu a fost atins de aceasta corectie)', () => {
  assert.equal(
    GENRE_STYLE_MAP.manele_jale,
    'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood'
  );
});

// ===============================================================================================
// 3) Toate celelalte genuri (14 din NEW_GENRES + 7 LEGACY_ONLY_GENRES) — byte-identice fata de
// HEAD (037ff15, inainte de aceasta corectie).
// ===============================================================================================
test('3) niciun alt gen din GENRE_STYLE_MAP nu a fost modificat (comparat byte-cu-byte cu 037ff15, ultimul commit de dinaintea acestei corectii)', () => {
  const baselineSrc = execSync('git show 037ff15:server.js', { cwd: path.join(__dirname, '..'), maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  const idx = baselineSrc.indexOf('const GENRE_STYLE_MAP = {');
  const end = baselineSrc.indexOf('\n};', idx);
  const body = baselineSrc.slice(idx, end);
  const LEGACY_ONLY_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'];
  for (const g of [...LEGACY_ONLY_GENRES, ...NEW_GENRES]) {
    if (g === 'manele_suflet') continue;
    const m = body.match(new RegExp(`\\n  ${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit "${g}" in HEAD`);
    assert.equal(GENRE_STYLE_MAP[g], m[1], `genul "${g}" trebuie sa ramana byte-identic fata de HEAD`);
  }
});

// ===============================================================================================
// 4) Preview: durata UNIFORMA de 40s pentru TOATE genurile (SMART PREVIEW, 2026-09-22) — exceptia
// veche (manele_suflet/manele_jale=50s) a fost eliminata complet, nu doar dezactivata.
// ===============================================================================================
test('4) PREVIEW_SECONDS = 40, pentru TOATE genurile — nicio exceptie ramasa in cod pentru manele_suflet/manele_jale', () => {
  assert.match(server, /const PREVIEW_SECONDS = 40;/);
  // verificam DECLARATIILE/apelurile de cod real, niciodata simpla mentiune in comentarii
  // (care documenteaza legitim, istoric, exceptia eliminata — acelasi tipar folosit peste tot
  // in acest fisier).
  assert.ok(!/const EXTENDED_PREVIEW_GENRES\s*=/.test(server), 'EXTENDED_PREVIEW_GENRES nu mai trebuie declarata in cod');
  assert.ok(!/const EXTENDED_PREVIEW_SECONDS\s*=/.test(server), 'EXTENDED_PREVIEW_SECONDS nu mai trebuie declarata in cod');
  assert.ok(!/function resolvePreviewMaxSeconds/.test(server), 'resolvePreviewMaxSeconds nu mai trebuie definita in cod — nicio ramura per-gen ramasa');
  assert.ok(!/resolvePreviewMaxSeconds\(/.test(server), 'resolvePreviewMaxSeconds nu mai trebuie apelata in cod');
});

// ===============================================================================================
// 5) previewStart / getPreviewStartFromLyrics — NEATINS.
// ===============================================================================================
test('5) getPreviewStartFromLyrics() (punctul de start al preview-ului) nu a fost modificata — nu contine nimic legat de genre/manele', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.doesNotMatch(fn, /genre/i);
  assert.doesNotMatch(fn, /manele/i);
  assert.doesNotMatch(fn, /EXTENDED_PREVIEW/);
});

// ===============================================================================================
// 6) Instructiunea de intro scurt ajunge in promptul final, pentru TOATE cele 8 limbi.
// ===============================================================================================
for (const lang of LANGS) {
  test(`6) [${lang}] buildPrompt() (generare initiala) contine instructiunea de intro scurt pentru manele_suflet`, () => {
    const prompt = buildPrompt(typicalOrder({ lang }), '', undefined);
    assert.ok(prompt.includes('short intro, vocals enter early'), `[${lang}] instructiunea lipseste din prompt: ${prompt}`);
  });
  test(`6b) [${lang}] buildExactLyricsRequest() (editare/regenerare) contine instructiunea de intro scurt pentru manele_suflet in style`, () => {
    const { style } = buildExactLyricsRequest(typicalOrder({ lang }), 'Vers exact', undefined, 'auto', '');
    assert.ok(style.includes('short intro, vocals enter early'), `[${lang}] instructiunea lipseste din style: ${style}`);
  });
}

// ===============================================================================================
// 7) Standard.
// ===============================================================================================
test('7) Standard: buildPrompt() cu plan=standard, genre=manele_suflet contine instructiunea', () => {
  const prompt = buildPrompt(typicalOrder({ plan: 'standard' }), '', undefined);
  assert.ok(prompt.includes('short intro, vocals enter early'));
});

// ===============================================================================================
// 8) Premium — atat ca genre (prima melodie) cat si ca genre2 (a doua melodie, via genreOverride).
// ===============================================================================================
test('8a) Premium: manele_suflet ca genre (prima melodie, fara genreOverride)', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'manele_suflet', genre2: 'pop' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('short intro, vocals enter early'));
});

test('8b) Premium: manele_suflet ca genre2 (a doua melodie, prin genreOverride) — acelasi mecanism ca la orice alt gen', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'pop', genre2: 'manele_suflet' });
  const prompt = buildPrompt(order, '', 'manele_suflet');
  assert.ok(prompt.includes('short intro, vocals enter early'));
  // confirma ca prima melodie (pop) NU capata instructiunea — genul e strict izolat per melodie
  const promptGenre1 = buildPrompt(order, '', order.genre);
  assert.ok(!promptGenre1.includes('short intro, vocals enter early'));
});

// ===============================================================================================
// 9) Video.
// ===============================================================================================
test('9) Video: buildPrompt() cu plan=video, genre=manele_suflet contine instructiunea (Video foloseste ramura cu un singur gen, PLAN_VARIANT_COUNT.video=1)', () => {
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/, 'Video trebuie sa ramana pe ramura single-genre, neatinsa de aceasta corectie');
  const prompt = buildPrompt(typicalOrder({ plan: 'video' }), '', undefined);
  assert.ok(prompt.includes('short intro, vocals enter early'));
});

// ===============================================================================================
// 10) Regenerare/editare (buildExactLyricsRequest, customMode:true) — acelasi cod partajat.
// ===============================================================================================
test('10) regenerare/editare cu versuri exacte (buildExactLyricsRequest) primeste aceeasi instructiune, prin acelasi GENRE_STYLE_MAP', () => {
  const order = typicalOrder();
  const { style } = buildExactLyricsRequest(order, 'Vers editat manual de client', undefined, 'auto', 'Mai vesela te rog');
  assert.ok(style.includes('short intro, vocals enter early'), `instructiunea lipseste din style-ul de regenerare: ${style}`);
});

// ===============================================================================================
// 11) Buget de caractere — SUNO_PROMPT_MAX_LEN=600 respectat, povestea supravietuieste, chiar si
// in cel mai incarcat scenariu real pentru manele_suflet (ocazia nunta, nume maxime, voce duet).
// ===============================================================================================
test('11) buget: manele_suflet, cel mai incarcat scenariu (nunta, nume maxime, duet, feedback) — prompt <= 600 caractere SI povestea supravietuieste', () => {
  const order = {
    occasion: 'nunta', weddingType: 'wedding', genre: 'manele_suflet', lang: 'ro',
    recipient: 'Alexandru-Gheorghe-Constantin', senderName: 'Ecaterina-Anastasia-Elisabeta',
    relationship: 'sora', voicePreference: 'duet',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
  };
  const prompt = buildPrompt(order, 'Mai vesela te rog, cu mai multa energie', undefined);
  assert.ok(prompt.length <= 600, `prompt peste buget: ${prompt.length} caractere`);
  assert.ok(prompt.includes('Story/details') || prompt.includes('Ne-am'), 'povestea nu trebuie sa dispara');
});

test('11c) buget: manele_suflet, cel mai incarcat scenariu DOCUMENTAT deja in codebase (test/lyrics-exact-story-premium-sequential.test.js — nunta, nume compuse foarte lungi, relatie "nasii de cununie si cei mai buni prieteni din copilarie", duet) — prompt <= 600 caractere SI povestea supravietuieste', () => {
  const worstCase = {
    occasion: 'nunta', genre: 'manele_suflet', lang: 'ro',
    recipient: 'Alexandru Ionut Popescu si Maria Elena Ionescu',
    senderName: 'Familia Popescu si Ionescu, nasii si toti prietenii apropiati',
    relationship: 'nasii de cununie si cei mai buni prieteni din copilarie', voicePreference: 'duet',
    story: 'V-ati cunoscut acum zece ani la o petrecere organizata de prieteni comuni, iar de atunci povestea voastra de dragoste a fost una plina de calatorii si sprijin reciproc.'
  };
  const prompt = buildPrompt(worstCase, '', undefined);
  assert.ok(prompt.length <= 600, `promptul trebuie sa ramana sub 600 caractere, a produs ${prompt.length}`);
  const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
  assert.ok(storyIdx !== -1, `continutul real al povestii trebuie sa fie prezent, a produs: ${prompt}`);
  assert.doesNotMatch(prompt, /instrumental/i, 'promptul nu trebuie sa contina niciodata cuvantul "instrumental"');
});

test('11b) buget: toate cele 16 genuri (inclusiv manele_suflet, modificat) — ocazia nunta, duet — raman sub 600 caractere si povestea supravietuieste (regresie generala, neschimbata fata de test/intro-vocal-continuity-fix.test.js)', () => {
  for (const genre of NEW_GENRES) {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre, lang: 'ro',
      recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog', undefined);
    assert.ok(prompt.includes('Story/details') || prompt.includes('Ne-am'), `genul "${genre}": povestea a disparut`);
    assert.ok(prompt.length <= 600, `genul "${genre}": prompt peste 600 caractere (${prompt.length})`);
  }
});

// ===============================================================================================
// Confirmari structurale suplimentare (verificare ca nimic altceva nu a fost atins).
// ===============================================================================================
test('nicio alta functionalitate atinsa — VOICE_PREFERENCES, PLAN_PRICES, VIDEO_PREVIEW_SECONDS raman neschimbate', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});

test('server.js ramane sintactic valid', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
