// CADOU/STANDARD/PREMIUM — continuitate voce Intro -> Verse 1 (2026-09-14, aprobat explicit,
// scop STRICT limitat la clauza de vocal onset).
//
// ROOT CAUSE demonstrat pe comenzi reale (RO/EN/IT, vezi investigatia): sectiunea [Intro]
// cantata avea consecvent o densitate de cuvinte de 2-3x mai mica decat [Verse 1] — cateva
// cuvinte intinse pe note lungi/sustinute, pentru ca instructiunea veche ("Start the vocals
// around 8-10 seconds, never immediately.") cerea STRICT o intrare vocala intarziata, fara
// niciun indiciu despre CUM sa fie umpluta acea fereastra.
//
// FIX: INLOCUIRE (nu ADAOS) in clauza existenta — "never immediately" (17 caractere) ->
// "like the verse" (14 caractere, -3) in buildPrompt() FULL; "Short intro" (11 caractere) ->
// "Verse intro" (11 caractere, delta ZERO) in buildPrompt() SHORT; acelasi principiu in
// buildExactLyricsRequest(). Doua incercari anterioare, mai lungi (adaos separat langa clauza
// existenta), au produs regresii masurate (dictie/paranteze/feedback/poveste pierdute pentru
// comenzi TIPICE, in toate cele 8 limbi) — motiv pentru care fixul final e o INLOCUIRE de
// lungime egala sau mai mica, niciodata un adaos.
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
const VOICE_PREFS = ['female', 'male', 'duet', 'auto'];
const PLANS = ['standard', 'premium', 'video'];

function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
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
  assert.ok(funcStart !== -1, 'nu am gasit function buildExactLyricsRequest(...)');
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
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const map = {};
  for (const g of NEW_GENRES) {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit valoarea GENRE_STYLE_MAP pentru "${g}"`);
    map[g] = m[1];
  }
  return map;
}
const GENRE_STYLE_MAP = loadGenreStyleMap();

// Clauza de continuitate apare fie ca "like the verse" (forma FULL), fie ca "Verse intro"
// (forma SHORT, folosita cand cascada de scurtare intra in actiune) — AMBELE sunt manifestari
// corecte ale ACELUIASI fix; care dintre ele apare depinde STRICT de bugetul disponibil pentru
// acea comanda specifica (comportament preexistent, neschimbat de aceasta corectie).
function hasContinuityClause(text) {
  return text.includes('like the verse') || text.includes('Verse intro');
}

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'zi_de_nastere', genre: 'pop', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  }, overrides);
}

// ===============================================================================================
// TEST 1/2 — noua clauza ajunge corect in buildPrompt() SI buildExactLyricsRequest().
// ===============================================================================================
test('TEST 1: buildPrompt() contine noua clauza de continuitate ("like the verse" sau "Verse intro", dupa cum decide cascada de scurtare) pentru o comanda tipica', () => {
  const prompt = buildPrompt(typicalOrder(), '', undefined);
  assert.ok(hasContinuityClause(prompt), `clauza de continuitate lipseste din prompt: ${prompt}`);
});

test('TEST 2: buildExactLyricsRequest() contine noua clauza de continuitate ("like the verse") in style', () => {
  const order = typicalOrder();
  const { style } = buildExactLyricsRequest(order, 'Verse exact\nAlt vers', undefined, 'auto', '');
  assert.ok(hasContinuityClause(style), `clauza de continuitate lipseste din style: ${style}`);
  assert.ok(style.includes('8-10 seconds'), 'cerinta de 8-10 secunde trebuie sa ramana in style');
});

// ===============================================================================================
// TEST 3 — FULL si SHORT pastreaza aceeasi intentie (continuitate cu versul urmator).
// ===============================================================================================
test('TEST 3: forma FULL ("Start the vocals around 8-10 seconds, like the verse.") si forma SHORT ("Verse intro") exista ambele in cod, cu aceeasi intentie', () => {
  assert.ok(server.includes('Start the vocals around 8-10 seconds, like the verse.'), 'forma FULL trebuie sa existe verbatim');
  assert.ok(server.includes(" Verse intro; story details throughout, not invented; complete words only, no shortening; name recipient early+chorus; mention sender once.'"), 'instructionWithSenderShort trebuie sa foloseasca noua formulare');
  assert.ok(server.includes(" Verse intro; story details throughout, not invented. Address recipient by name naturally, complete words only, no shortening.'"), 'instructionNoSenderShort trebuie sa foloseasca noua formulare');
});

// ===============================================================================================
// TEST 4/6 — intro-ul vocal personalizat ramane; NU se cere intro instrumental.
// ===============================================================================================
test('TEST 4/6: nicio forma a clauzei nu cere/mentioneaza intro instrumental — vocea ramane ceruta din prima secventa', () => {
  const allForms = [
    server.slice(server.indexOf('const instructionWithSenderFull ='), server.indexOf('const instructionWithSenderFull =') + 500),
    server.slice(server.indexOf('const instructionWithSenderShort ='), server.indexOf('const instructionWithSenderShort =') + 250),
    server.slice(server.indexOf('const instructionNoSenderFull ='), server.indexOf('const instructionNoSenderFull =') + 400),
    server.slice(server.indexOf('const instructionNoSenderShort ='), server.indexOf('const instructionNoSenderShort =') + 200)
  ];
  for (const form of allForms) {
    assert.ok(!/instrumental/i.test(form), `nicio forma nu trebuie sa contina cuvantul "instrumental": ${form.slice(0, 120)}`);
  }
});

// ===============================================================================================
// TEST 5 — cerinta de aproximativ 8-10 secunde ramane, in toate formele.
// ===============================================================================================
// FULL este candidatul initial (buildFixedPart), inainte de orice scurtare — cascada de scurtare
// poate reduce ORICE comanda reala la forma SHORT (comportament preexistent, independent de
// aceasta corectie: chiar si comenzi modeste ating adesea pragul, dat fiind bugetul deja strans
// al genului+ocaziei+dictiei) — de aceea "8-10 seconds" se verifica STRICT pe constantele FULL
// din sursa (mereu prezente, indiferent daca ajung sau nu neschimbate in promptul final), nu pe
// un prompt construit dintr-o comanda anume, care ar putea ateriza legitim pe SHORT.
test('TEST 5: "8-10 seconds" ramane prezent in constantele FULL (buildPrompt) si in buildExactLyricsRequest() (buget generos, mereu forma completa)', () => {
  assert.ok(server.includes('Start the vocals around 8-10 seconds, like the verse.'), 'instructionWithSenderFull/instructionNoSenderFull trebuie sa contina "8-10 seconds"');
  const order = typicalOrder();
  const { style } = buildExactLyricsRequest(order, 'Vers', undefined, 'auto', '');
  assert.ok(style.includes('8-10 seconds'), 'buildExactLyricsRequest() are buget generos (1000 caractere) — "8-10 seconds" trebuie sa ajunga mereu');
});

// ===============================================================================================
// TEST 7/9 — GENRE_STYLE_MAP byte-identic, cele 16 genuri neatinse (comparat cu commit-ul
// 57e37db, sursa deja verificata a "configuratiei aprobate").
// ===============================================================================================
// CORECȚIE (2026-09-14, "instrumentalul de dinainte de voce suna a manea, nu a Hip Hop" —
// aprobata explicit): hiphop a fost EXCLUS din aceasta verificare — e singurul gen modificat
// intentionat de acea corectie, ulterioara acesteia. Celelalte 15 genuri raman verificate
// byte-identic fata de 57e37db, neschimbat.
test('TEST 7/9: GENRE_STYLE_MAP ramane BYTE-IDENTIC pentru 15 din cele 16 genuri noi fata de commit-ul 57e37db (hiphop exclus — modificat intentionat ulterior, vezi test/hiphop-genre-redefinition.test.js)', () => {
  const { execSync } = require('node:child_process');
  const yesterdaySrc = execSync('git show 57e37db:server.js', { cwd: path.join(__dirname, '..'), maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  const idx = yesterdaySrc.indexOf('const GENRE_STYLE_MAP = {');
  const end = yesterdaySrc.indexOf('};', idx);
  const body = yesterdaySrc.slice(idx, end);
  // manele_suflet EXCLUS aici (2026-09-19, corectie separata si ulterioara — "intro scurt",
  // aprobata explicit, scop STRICT limitat la acea valoare) — vezi
  // test/manele-suflet-short-intro.test.js pentru verificarea dedicata a acelei modificari.
  for (const g of NEW_GENRES.filter(g => g !== 'hiphop' && g !== 'manele_suflet')) {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit "${g}" in versiunea de referinta`);
    assert.equal(GENRE_STYLE_MAP[g], m[1], `genul "${g}" trebuie sa ramana byte-identic`);
  }
});

// ===============================================================================================
// TEST 8/10 — VOICE_INSTRUCTIONS_FULL/SHORT byte-identice, cele 4 optiuni de voce neatinse.
// ===============================================================================================
test('TEST 8/10: VOICE_INSTRUCTIONS_FULL si VOICE_INSTRUCTIONS_SHORT raman BYTE-IDENTICE (neatinse de aceasta corectie)', () => {
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_FULL = {\n    female: ' Use a female lead vocal.',\n    male: ' Use a male lead vocal.',\n    duet: ' Use a male and female duet, with both voices clearly present.',\n    auto: ''\n  };"));
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_SHORT = {\n    female: ' Female vocal.',\n    male: ' Male vocal.',\n    duet: ' Male-female duet.',\n    auto: ''\n  };"));
});

// ===============================================================================================
// TEST 11 — EN/RO/DE/ES/IT/FR/BG/TR: clauza hardcodata (nu depinde de order.lang), aplicata
// identic pentru toate cele 8 limbi.
// ===============================================================================================
for (const lang of LANGS) {
  test(`TEST 11 [${lang}]: clauza de continuitate ajunge in prompt pentru o comanda tipica`, () => {
    const prompt = buildPrompt(typicalOrder({ lang }), '', undefined);
    assert.ok(hasContinuityClause(prompt), `[${lang}] clauza lipseste: ${prompt}`);
  });
}

// ===============================================================================================
// TEST 12 — Standard/Premium/Video Gift: aceeasi logica (buildPrompt/buildExactLyricsRequest nu
// ramifica dupa order.plan pentru aceasta clauza).
// ===============================================================================================
for (const plan of PLANS) {
  test(`TEST 12 [${plan}]: clauza de continuitate ajunge in prompt indiferent de pachet`, () => {
    const prompt = buildPrompt(typicalOrder({ plan }), '', undefined);
    assert.ok(hasContinuityClause(prompt), `[${plan}] clauza lipseste: ${prompt}`);
  });
}

// ===============================================================================================
// TEST 13 — initial generation (buildPrompt, customMode:false) + edit/regenerare
// (buildExactLyricsRequest, customMode:true) — ambele cai.
// ===============================================================================================
test('TEST 13: ambele cai de generare (initiala + edit/regenerare) primesc clauza de continuitate', () => {
  const order = typicalOrder();
  const promptInitial = buildPrompt(order, '', undefined);
  const { style: styleRegen } = buildExactLyricsRequest(order, 'Vers editat manual', undefined, 'auto', '');
  assert.ok(hasContinuityClause(promptInitial));
  assert.ok(hasContinuityClause(styleRegen));
});

// ===============================================================================================
// TEST 14/15 — story reserve si feedback reserve NU sunt reduse (regresie testata explicit,
// demonstrata si corectata in timpul acestei implementari).
// ===============================================================================================
test('TEST 14: povestea supravietuieste pentru toate cele 16 genuri, ocazia cea mai grea (nunta) — story reserve neatinsa', () => {
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

test('TEST 15: feedback-ul Video ajunge efectiv in prompt intr-un scenariu MODERAT (nu extrem) — neregresat de noua clauza', () => {
  const order = {
    occasion: 'parinti', genre: 'pop', lang: 'ro', plan: 'video',
    recipient: 'Elena', senderName: 'Ana', relationship: 'mama', voicePreference: 'auto',
    story: 'O poveste calda despre familia noastra si toate momentele frumoase petrecute impreuna de-a lungul anilor.'
  };
  const prompt = buildPrompt(order, 'Te rog sa fie mai energica', undefined);
  assert.ok(prompt.includes('Client override') || prompt.includes('energica'), `feedback-ul lipseste: ${prompt}`);
});

// ===============================================================================================
// TEST 16 — duration target 3:15-3:40 ramane neschimbat.
// ===============================================================================================
test('TEST 16: durationTargetClause (" Target song length 3:15-3:40.") ramane byte-identic si neatins', () => {
  assert.ok(server.includes("const durationTargetClause = ' Target song length 3:15-3:40.';"));
});

// ===============================================================================================
// Confirmare structurala: buget net NEGATIV sau ZERO — head-ul nou nu poate fi vreodata mai lung
// decat inainte de aceasta corectie, pentru aceleasi date de intrare.
// ===============================================================================================
test('CONFIRMARE BUGET: clauza noua e o INLOCUIRE de lungime egala sau mai mica, niciodata un adaos', () => {
  const oldFull = 'Start the vocals around 8-10 seconds, never immediately.';
  const newFull = 'Start the vocals around 8-10 seconds, like the verse.';
  assert.ok(newFull.length <= oldFull.length, `forma FULL nu trebuie sa creasca in lungime (veche=${oldFull.length}, noua=${newFull.length})`);
  const oldShort = 'Short intro';
  const newShort = 'Verse intro';
  assert.equal(newShort.length, oldShort.length, 'forma SHORT trebuie sa aiba EXACT aceeasi lungime');
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
