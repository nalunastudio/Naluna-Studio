// LINII SCURTE — STRICT pentru genul real "manele_suflet" (2026-09-25, cerinta explicita, urmare a
// comparatiei directe intre doua generari reale ale aceluiasi client: versiunea PLACUTA avea linii
// scurte, naturale, usor de cantat — ex. reale "Sotia mea, te iubesc, / In fiecare zi te doresc."
// (4-5 cuvinte/linie); versiunea NEPLACUTA a produs linii vizibil mai lungi, descriptive — ex.
// reale "Maria, dorul meu te cauta in fiecare clipa" (8 cuvinte/linie)).
//
// AUDIT premergator (facut INAINTE de orice modificare, cerinta explicita "nu presupune cauza"):
// buildPrompt() foloseste customMode:false — Suno isi scrie SINGUR versurile dintr-un singur camp
// text descriptiv ("prompt"); acel prompt nu continea NICIUN indiciu despre lungimea liniei, pentru
// niciun gen — nu exista nicio regresie de cod care sa fi ALUNGIT liniile, doar absenta completa a
// unei instructiuni. Root cause: absenta instructiunii, nu un bug.
//
// DOUA INCERCARI RESPINSE, gasite prin masurare directa (nu presupunere) — vezi comentariul din
// server.js (langa `const isManeleSufletGenre`) pentru raportul complet:
//   1. Adaugarea instructiunii in styleTags (GENRE_STYLE_MAP.manele_suflet, parte NICIODATA
//      scurtata a promptului) — chiar si 5 caractere in plus acolo impingeau cel mai strans
//      scenariu deja documentat (nunta, nume maxime, duet) peste marginea unde povestea clientului
//      DISPARE COMPLET din prompt (marja reala masurata: doar 4 caractere).
//   2. O clauza NOUA, adaugata fie la finalul promptului, fie ca pas suplimentar in cascada de
//      scurtare — pentru manele_suflet, chiar o comanda TIPICA are nevoie sa treaca prin pasii de
//      scurtare ai instructiunii (head porneste la ~700+ caractere, mult peste bugetul de 410
//      pentru partea fixa), deci orice piesa NOUA de buget era eliminata aproape mereu, nu doar in
//      cazuri extreme.
//
// FIX REAL (INLOCUIRE, NICIODATA ADAOS — principiu deja stabilit in acest fisier, pentru exact
// acest motiv): formele SCURTE ale instructiunii de personalizare (instructionWith/NoSenderShort) —
// cele care, masurat direct, ajung EFECTIV la Suno pentru aproape orice comanda manele_suflet reala
// (formele FULL nu incap niciodata langa un styleTags de 137 caractere) — inlocuiesc STRICT pentru
// manele_suflet fragmentul "Verse intro" (11 caractere) cu "Short lines" (11 caractere): swap de
// lungime IDENTICA, zero impact asupra bugetului. "Verse intro" (timing-ul intrarii vocale) ramane
// oricum reinforced separat pentru manele_suflet prin "short intro, vocals enter early" din
// styleTags — nu se pierde nicio garantie.
//
// NU s-a atins: manele_jale (byte-identic, vezi test/manele-suflet-short-intro.test.js #2), niciun
// alt gen, GENRE_STYLE_MAP (byte-identica pentru manele_suflet), buildExactLyricsRequest()
// (customMode:true — versurile sunt deja fixate/exacte), durata preview, previewStart, vocea,
// API-ul/modelul muzical, mecanismul de preview.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];

const SHORT_LINES_MARKER = 'Short lines;';

// ===============================================================================================
// Extragere buildPrompt() / buildExactLyricsRequest() REALE din server.js (acelasi tipar exact ca
// test/manele-suflet-short-intro.test.js).
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

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'zi_de_nastere', genre: 'manele_suflet', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  }, overrides);
}

// ===============================================================================================
// 1) Instructiunea de linii scurte ajunge in promptul final, pentru TOATE cele 8 limbi — comanda
//    TIPICA (nu extrema), exact scenariul real raportat de client, CU si FARA expeditor numit.
// ===============================================================================================
for (const lang of LANGS) {
  test(`1) [${lang}] buildPrompt() (comanda tipica, cu expeditor) contine instructiunea de linii scurte pentru manele_suflet`, () => {
    const prompt = buildPrompt(typicalOrder({ lang }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `[${lang}] instructiunea lipseste din prompt: ${prompt}`);
  });
  test(`1b) [${lang}] buildPrompt() (comanda tipica, FARA expeditor) contine instructiunea de linii scurte pentru manele_suflet`, () => {
    const prompt = buildPrompt(typicalOrder({ lang, senderName: '' }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `[${lang}] instructiunea lipseste din prompt (fara expeditor): ${prompt}`);
  });
}

// ===============================================================================================
// 2) manele_jale NU primeste niciodata instructiunea — genul "perfect", neatins.
// ===============================================================================================
test('2) manele_jale NU primeste instructiunea de linii scurte (comportament neschimbat)', () => {
  const prompt = buildPrompt(typicalOrder({ genre: 'manele_jale' }), '', undefined);
  assert.ok(!prompt.includes(SHORT_LINES_MARKER));
  assert.ok(prompt.includes('Verse intro'), 'manele_jale trebuie sa pastreze STRICT formularea originala "Verse intro"');
});

// ===============================================================================================
// 3) Niciun alt gen nu primeste instructiunea — STRICT manele_suflet.
// ===============================================================================================
for (const genre of NEW_GENRES.filter(g => g !== 'manele_suflet')) {
  test(`3) genul "${genre}" NU primeste instructiunea de linii scurte (STRICT manele_suflet)`, () => {
    const prompt = buildPrompt(typicalOrder({ genre }), '', undefined);
    assert.ok(!prompt.includes(SHORT_LINES_MARKER), `genul "${genre}" a primit gresit instructiunea`);
  });
}

// ===============================================================================================
// 4) Povestea clientului ramane inclusa — fix-ul e un swap de lungime IDENTICA, deci nu poate
//    niciodata reduce bugetul povestii fata de inainte.
// ===============================================================================================
test('4) povestea clientului ramane prezenta (comanda tipica, manele_suflet)', () => {
  const prompt = buildPrompt(typicalOrder(), '', undefined);
  assert.ok(prompt.includes('Ne-am cunoscut'), 'un fragment din povestea reala trebuie sa fie prezent');
});

test('4b) povestea supravietuieste chiar si in cel mai incarcat scenariu manele_suflet (nunta, nume lungi, duet) — identic cu comportamentul dinainte de fix (swap de lungime egala)', () => {
  const worstCase = {
    occasion: 'nunta', genre: 'manele_suflet', lang: 'ro',
    recipient: 'Alexandru Ionut Popescu si Maria Elena Ionescu',
    senderName: 'Familia Popescu si Ionescu, nasii si toti prietenii apropiati',
    relationship: 'nasii de cununie si cei mai buni prieteni din copilarie', voicePreference: 'duet',
    story: 'V-ati cunoscut acum zece ani la o petrecere organizata de prieteni comuni, iar de atunci povestea voastra de dragoste a fost una plina de calatorii si sprijin reciproc.'
  };
  const prompt = buildPrompt(worstCase, '', undefined);
  const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
  assert.ok(storyIdx !== -1, `povestea trebuie sa fie prezenta, a produs: ${prompt}`);
  assert.ok(prompt.length <= 600, `prompt peste buget: ${prompt.length} caractere`);
});

// ===============================================================================================
// 5) Nume/relatie continua sa fie mentionate natural — swap-ul nu atinge nicio alta parte a
//    instructiunii (name recipient early+chorus/sender once raman byte-identice).
// ===============================================================================================
test('5) numele destinatarului si expeditorului raman prezente in promptul cu manele_suflet + swap-ul de linii scurte', () => {
  const order = typicalOrder({ recipient: 'Elena', senderName: 'Radu', relationship: 'frate' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Elena'), 'numele destinatarului trebuie sa ramana in prompt');
  assert.ok(prompt.includes('Radu'), 'numele expeditorului trebuie sa ramana in prompt');
});

// ===============================================================================================
// 6) Premium (genre + genre2 via genreOverride), Video, Standard — acelasi mecanism, gatat pe
//    (genreOverride || order.genre).
// ===============================================================================================
test('6a) Premium: manele_suflet ca genre (prima melodie) primeste instructiunea', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'manele_suflet', genre2: 'pop' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
});

test('6b) Premium: manele_suflet ca genre2 (a doua melodie, prin genreOverride) primeste instructiunea; prima melodie (pop) NU', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'pop', genre2: 'manele_suflet' });
  const promptGenre2 = buildPrompt(order, '', 'manele_suflet');
  assert.ok(promptGenre2.includes(SHORT_LINES_MARKER));
  const promptGenre1 = buildPrompt(order, '', order.genre);
  assert.ok(!promptGenre1.includes(SHORT_LINES_MARKER));
});

test('6c) Video: manele_suflet primeste instructiunea', () => {
  const prompt = buildPrompt(typicalOrder({ plan: 'video' }), '', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
});

test('6d) Standard: manele_suflet primeste instructiunea', () => {
  const prompt = buildPrompt(typicalOrder({ plan: 'standard' }), '', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
});

// ===============================================================================================
// 7) buildExactLyricsRequest (customMode:true, versuri deja fixate/exacte) NU e afectata — foloseste
//    GENRE_STYLE_MAP direct (byte-identic), nu currentInstruction() — nicio schimbare de comportament.
// ===============================================================================================
test('7) buildExactLyricsRequest (regenerare cu versuri exacte) ramane neschimbata pentru manele_suflet (style include tot "short intro, vocals enter early", ca inainte de fix)', () => {
  const order = typicalOrder();
  const { style } = buildExactLyricsRequest(order, 'Vers exact editat de client', undefined, 'auto', '');
  assert.ok(style.includes('short intro, vocals enter early'));
});

// ===============================================================================================
// 8) Limita de caractere existenta (SUNO_PROMPT_MAX_LEN=600) NU e niciodata depasita, pentru toate
//    cele 8 limbi, in scenariul cel mai incarcat pentru manele_suflet (identic cu comportamentul
//    dinainte de fix, dat fiind swap-ul de lungime egala).
// ===============================================================================================
for (const lang of LANGS) {
  test(`8) [${lang}] buget: manele_suflet, scenariu incarcat (nunta, nume maxime, duet, feedback) — prompt <= 600 caractere`, () => {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre: 'manele_suflet', lang,
      recipient: 'Alexandru-Gheorghe-Constantin', senderName: 'Ecaterina-Anastasia-Elisabeta',
      relationship: 'sora', voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog, cu mai multa energie', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] prompt peste buget: ${prompt.length} caractere`);
  });
}

// ===============================================================================================
// Confirmari structurale — sursa exacta a fix-ului, izolare, swap de lungime identica.
// ===============================================================================================
test('server.js: instructionWithSenderShortManeleSuflet e byte-lungime IDENTICA cu instructionWithSenderShort (swap, niciodata adaos)', () => {
  const m1 = server.match(/const instructionWithSenderShort = '([^']*)';/);
  const m2 = server.match(/const instructionWithSenderShortManeleSuflet = '([^']*)';/);
  assert.ok(m1 && m2, 'ambele constante trebuie sa existe');
  assert.equal(m1[1].length, m2[1].length, 'lungimea trebuie sa fie IDENTICA — niciun buget suplimentar');
  assert.equal(m1[1].replace('Verse intro', 'Short lines'), m2[1], 'singura diferenta trebuie sa fie "Verse intro" -> "Short lines"');
});

test('server.js: instructionNoSenderShortManeleSuflet e byte-lungime IDENTICA cu instructionNoSenderShort (swap, niciodata adaos)', () => {
  const m1 = server.match(/const instructionNoSenderShort = '([^']*)';/);
  const m2 = server.match(/const instructionNoSenderShortManeleSuflet = '([^']*)';/);
  assert.ok(m1 && m2, 'ambele constante trebuie sa existe');
  assert.equal(m1[1].length, m2[1].length, 'lungimea trebuie sa fie IDENTICA — niciun buget suplimentar');
  assert.equal(m1[1].replace('Verse intro', 'Short lines'), m2[1], 'singura diferenta trebuie sa fie "Verse intro" -> "Short lines"');
});

test('server.js: currentInstruction() foloseste formele ManeleSuflet STRICT cand isManeleSufletGenre', () => {
  const idx = server.indexOf('function currentInstruction() {');
  const end = server.indexOf('\n  }', idx);
  const block = server.slice(idx, end);
  assert.match(block, /isManeleSufletGenre \? instructionWithSenderShortManeleSuflet : instructionWithSenderShort/);
  assert.match(block, /isManeleSufletGenre \? instructionNoSenderShortManeleSuflet : instructionNoSenderShort/);
});

test('server.js: GENRE_STYLE_MAP.manele_suflet ramane neschimbata de aceasta corectie (fix-ul e STRICT in currentInstruction(), nu in harta de stiluri)', () => {
  assert.match(server, /manele_suflet: 'Romanian manele, Balkan oriental, melismatic vocal runs, violin accordion clarinet, hopeful devoted mood, short intro, vocals enter early',/);
});

test('server.js: formele FULL (instructionWithSenderFull/instructionNoSenderFull) raman neatinse — fix-ul e STRICT pe formele SHORT', () => {
  assert.match(server, /const instructionWithSenderFull = ' Write this as a personal song from the sender to the recipient/);
  assert.match(server, /const instructionNoSenderFull = ' Weave real, specific, never-invented story details throughout/);
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
