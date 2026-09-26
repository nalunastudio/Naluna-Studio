// LINII SCURTE — EXTINSE LA TOATE GENURILE (2026-09-26, cerinta explicita). Inlocuieste
// test/manele-suflet-short-lines.test.js (STERS — premisa lui, "STRICT manele_suflet", nu mai e
// adevarata dupa aceasta extindere; aproape fiecare asertie ar fi trebuit inversata).
//
// AUDIT premergator (facut inainte de aceasta modificare, cerinta explicita "nu presupune"):
// mecanismul REAL era `isManeleSufletGenre` (server.js) — un gate STRICT pe genul 'manele_suflet'
// care alegea intre formele SHORT normale ale currentInstruction() ("Verse intro", folosite pentru
// orice alt gen) si variante byte-lungime-IDENTICA ("Short lines" in loc de "Verse intro",
// ...ManeleSuflet) — un swap descoperit, dupa doua incercari respinse (adaos in styleTags; clauza
// noua in cascada), ca fiind singura solutie care nu fura buget din poveste (bugetul de 600
// caractere, SUNO_PROMPT_MAX_LEN, e extrem de strans pentru orice gen cu styleTags lung — hiphop,
// 143 caractere, e chiar mai lung decat manele_suflet, 137).
//
// EXTINDERE (aceasta modificare): `isManeleSufletGenre` a fost ELIMINAT — formele SHORT
// (instructionWithSenderShort/instructionNoSenderShort) contin acum STRICT "Short lines" pentru
// ORICE gen (fostele variante ...ManeleSuflet au devenit chiar formele SHORT de baza — nu mai
// exista duplicare). Formele FULL raman NEATINSE (nicio mentiune de linii, ca inainte).
//
// NU s-a atins: GENRE_STYLE_MAP (byte-identic pentru toate cele 23 de genuri — identitatea
// muzicala/instrumentatia/mood-ul fiecarui gen), buildExactLyricsRequest() (customMode:true,
// versuri deja fixate/exacte — foloseste GENRE_STYLE_MAP direct, nu currentInstruction()), durata/
// startul preview-ului, dictia/pronuntia numelor, checkout/funnel/Stripe/Admin/recovery/Meta Ads.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
// Toate cele 23 de genuri REALE din cod (server.js: LEGACY_ONLY_GENRES + NEW_GENRES) — vezi audit,
// ALLOWED_GENRES = [...LEGACY_ONLY_GENRES, ...NEW_GENRES].
const LEGACY_ONLY_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'];
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
const ALL_GENRES = [...LEGACY_ONLY_GENRES, ...NEW_GENRES];
assert.equal(ALL_GENRES.length, 23);

const SHORT_LINES_MARKER = 'Short lines;';

// ===============================================================================================
// Extragere buildPrompt() / buildExactLyricsRequest() REALE din server.js (acelasi tipar exact ca
// restul suitei — vezi test/manele-suflet-short-intro.test.js pentru precedent).
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
    occasion: 'zi_de_nastere', genre: 'pop', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  }, overrides);
}

// ===============================================================================================
// 1) TOATE cele 23 de genuri primesc "Short lines" — comanda tipica, cu SI fara expeditor.
// ===============================================================================================
for (const genre of ALL_GENRES) {
  test(`1) genul "${genre}" primeste instructiunea de linii scurte (cu expeditor)`, () => {
    const prompt = buildPrompt(typicalOrder({ genre }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `genul "${genre}" nu a primit instructiunea: ${prompt}`);
  });
  test(`1b) genul "${genre}" primeste instructiunea de linii scurte (FARA expeditor)`, () => {
    const prompt = buildPrompt(typicalOrder({ genre, senderName: '' }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `genul "${genre}" nu a primit instructiunea (fara expeditor): ${prompt}`);
  });
}

// ===============================================================================================
// 2) manele_suflet continua sa functioneze CEL PUTIN la fel ca inainte (regresie directa) —
//    manele_jale (fostul gen exclus) primeste ACUM instructiunea, ca orice alt gen.
// ===============================================================================================
test('2a) manele_suflet: continua sa primeasca "Short lines" (regresie fata de fix-ul initial, 2026-09-25)', () => {
  const prompt = buildPrompt(typicalOrder({ genre: 'manele_suflet' }), '', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
});

test('2b) manele_jale: primeste ACUM "Short lines" (schimbare deliberata, cerinta explicita "toate genurile") — NU e deteriorat (povestea/numele raman prezente)', () => {
  const order = typicalOrder({ genre: 'manele_jale', recipient: 'Elena', senderName: 'Radu' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
  assert.ok(!prompt.includes('Verse intro'));
  assert.ok(prompt.includes('Elena') && prompt.includes('Radu'), 'numele trebuie sa ramana prezente');
  assert.ok(prompt.includes('Ne-am cunoscut'), 'povestea trebuie sa ramana prezenta');
  assert.ok(prompt.length <= 600, `prompt peste buget: ${prompt.length}`);
});

// ===============================================================================================
// 3) TOATE cele 8 limbi primesc instructiunea corecta — verificat pe un gen non-manele (jazz,
//    numit explicit de client ca exemplu de gen care NU trebuie transformat in manele) SI pe
//    manele_suflet/manele_jale (istoric speciale).
// ===============================================================================================
for (const lang of LANGS) {
  test(`3) [${lang}] jazz primeste "Short lines"`, () => {
    const prompt = buildPrompt(typicalOrder({ genre: 'jazz', lang }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `[${lang}]: ${prompt}`);
  });
  test(`3b) [${lang}] manele_suflet primeste "Short lines"`, () => {
    const prompt = buildPrompt(typicalOrder({ genre: 'manele_suflet', lang }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `[${lang}]: ${prompt}`);
  });
  test(`3c) [${lang}] manele_jale primeste "Short lines"`, () => {
    const prompt = buildPrompt(typicalOrder({ genre: 'manele_jale', lang }), '', undefined);
    assert.ok(prompt.includes(SHORT_LINES_MARKER), `[${lang}]: ${prompt}`);
  });
}

// ===============================================================================================
// 4) Identitatea/stilul fiecarui gen NU a fost modificata — GENRE_STYLE_MAP byte-identic (verificat
//    STRUCTURAL, textul exact ramane in server.js), pentru genurile numite explicit de client
//    (Jazz, Pop, Romantic, Hip-hop) SI pentru toate celelalte.
// ===============================================================================================
const EXPECTED_GENRE_STYLES = {
  pop: 'contemporary pop, catchy chorus hook, clean modern production, melody-led rhythm, vocals forward, upbeat energy',
  jazz: 'smooth jazz, saxophone or piano, warm bass, brushed drums, jazz-coloured harmony, slow-medium groove, soulful vocal',
  romantic: 'timeless romantic love song, piano or acoustic guitar, optional strings, soft percussion, intimate vocal',
  hiphop: '2000s street hip-hop, hard drums, punchy kick, dry snare, deep heavy bass, sparse dark gritty beat from the first beat, rap verses, street hook',
  rock: 'live rock band, distorted electric guitar riff, bass, drums, strong vocal, chorus expands from verse, ranges soft-rock to stadium rock',
  manele_suflet: 'Romanian manele, Balkan oriental, melismatic vocal runs, violin accordion clarinet, hopeful devoted mood, short intro, vocals enter early',
  manele_jale: 'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood'
};
for (const [genre, expected] of Object.entries(EXPECTED_GENRE_STYLES)) {
  test(`4) GENRE_STYLE_MAP.${genre} ramane byte-identic (identitatea/instrumentatia genului NU a fost atinsa)`, () => {
    assert.match(server, new RegExp(`${genre}: '${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',`));
  });
}

test('4b) GENRE_STYLE_MAP nu a fost modificat structural — aceeasi declaratie, acelasi numar de chei (23)', () => {
  const start = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', start) + 2;
  const snippet = server.slice(start, end);
  const map = new Function(`${snippet}; return GENRE_STYLE_MAP;`)();
  assert.equal(Object.keys(map).length, 23);
});

// ===============================================================================================
// 5) Povestea clientului ramane inclusa — comanda tipica SI cel mai incarcat scenariu real
//    (nunta, nume lungi, duet) — pentru genul cu cel mai lung styleTags (hiphop, 143 caractere,
//    mai lung decat manele_suflet) — swap de lungime IDENTICA, deci acelasi comportament ca inainte.
// ===============================================================================================
test('5a) povestea clientului ramane prezenta (comanda tipica, pop)', () => {
  const prompt = buildPrompt(typicalOrder(), '', undefined);
  assert.ok(prompt.includes('Ne-am cunoscut'));
});

// NOTA (gasita prin testare directa in timpul acestei sarcini, nu presupunere): o combinatie SI
// MAI extrema decat cea de mai jos (nume "Amandoi" concatenate cu "si" PE AMBELE parti, recipient
// SI sender, plus fraza lunga de relatie "nasii de cununie...") produce pierderea completa a
// povestii — verificat ca acest lucru se intampla IDENTIC pe codul dinaintea acestei sarcini,
// pentru ORICE gen (inclusiv manele_suflet insusi) — vezi comentariul din server.js, langa
// shrinkSteps: "Singurul caz ramas neacoperit... o combinatie extrema, preexistenta acestei
// corectii". Nefiind cauzat de aceasta sarcina (swap de lungime IDENTICA, zero impact asupra
// oricarui buget), NU e in scope sa il reparam aici — testul de mai jos foloseste STRICT
// combinatia deja verificata sigura (nume individuale, nu "Amandoi" pe ambele parti), acum extinsa
// la genul cu styleTags cel mai lung (hiphop, 143 caractere) si toate cele 8 limbi.
for (const lang of LANGS) {
  test(`5b) [${lang}] povestea supravietuieste in cel mai incarcat scenariu REALIST, pentru cel mai lung gen (hiphop, 143 caractere styleTags) — nunta, nume maxime, duet, feedback, sub buget (600)`, () => {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre: 'hiphop', lang,
      recipient: 'Alexandru-Gheorghe-Constantin', senderName: 'Ecaterina-Anastasia-Elisabeta',
      relationship: 'sora', voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog, cu mai multa energie', undefined);
    const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
    assert.ok(storyIdx !== -1, `povestea trebuie sa fie prezenta, a produs: ${prompt}`);
    assert.ok(prompt.length <= 600, `[${lang}] prompt peste buget: ${prompt.length} caractere`);
  });
}

// ===============================================================================================
// 6) Nume/relatie continua sa fie mentionate natural, pentru un gen oarecare (nu doar manele_suflet).
// ===============================================================================================
test('6) numele destinatarului si expeditorului raman prezente (romantic + linii scurte)', () => {
  const order = typicalOrder({ genre: 'romantic', recipient: 'Elena', senderName: 'Radu', relationship: 'frate' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Elena'));
  assert.ok(prompt.includes('Radu'));
});

// ===============================================================================================
// 7) Standard / Premium (genre + genre2 via genreOverride) / Video — acelasi mecanism universal,
//    fara niciun gating pe plan sau pe gen.
// ===============================================================================================
test('7a) Standard: primeste instructiunea (orice gen)', () => {
  assert.ok(buildPrompt(typicalOrder({ plan: 'standard', genre: 'country' }), '', undefined).includes(SHORT_LINES_MARKER));
});
test('7b) Premium: prima melodie (genre) primeste instructiunea', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'jazz', genre2: 'rock' });
  assert.ok(buildPrompt(order, '', undefined).includes(SHORT_LINES_MARKER));
});
test('7c) Premium: a doua melodie (genre2, prin genreOverride) primeste instructiunea', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'jazz', genre2: 'rock' });
  assert.ok(buildPrompt(order, '', 'rock').includes(SHORT_LINES_MARKER));
});
test('7d) Video: primeste instructiunea (orice gen)', () => {
  assert.ok(buildPrompt(typicalOrder({ plan: 'video', genre: 'edm_dance' }), '', undefined).includes(SHORT_LINES_MARKER));
});

// ===============================================================================================
// 8) Editarea/regenerarea care foloseste ACELASI pipeline (generare initiala prin buildPrompt,
//    ex. /api/orders/:id/regenerate cu feedback text, fara versuri exacte) e acoperita automat —
//    currentInstruction() nu face nicio distinctie intre generarea initiala si regenerare.
// ===============================================================================================
test('8) regenerare (feedback text, fara versuri exacte) foloseste ACELASI buildPrompt() -> currentInstruction() -> "Short lines"', () => {
  const prompt = buildPrompt(typicalOrder({ genre: 'acoustic_folk' }), 'Mai vesela te rog', undefined);
  assert.ok(prompt.includes(SHORT_LINES_MARKER));
});

// ===============================================================================================
// 9) buildExactLyricsRequest() (customMode:true, versuri deja fixate/exacte — editare cu versuri
//    exacte) NU e afectata — foloseste GENRE_STYLE_MAP direct, nu currentInstruction(); "Short
//    lines" nu trebuie sa apara NICIODATA in `style` (ar fi un semnal fals catre Suno, care aici
//    NU mai scrie versurile — ele sunt deja date, verbatim, in `prompt`).
// ===============================================================================================
for (const genre of ['jazz', 'manele_suflet', 'manele_jale', 'hiphop', 'pop']) {
  test(`9) buildExactLyricsRequest (${genre}): style NU contine "Short lines" — mecanismul de linii scurte nu se aplica la versuri deja exacte`, () => {
    const order = typicalOrder({ genre });
    const { style } = buildExactLyricsRequest(order, 'Vers exact editat de client', undefined, 'auto', '');
    assert.ok(!style.includes('Short lines'));
  });
}
test('9b) buildExactLyricsRequest (manele_suflet): style include tot "short intro, vocals enter early" (GENRE_STYLE_MAP, neatins de aceasta corectie)', () => {
  const order = typicalOrder({ genre: 'manele_suflet' });
  const { style } = buildExactLyricsRequest(order, 'Vers exact editat de client', undefined, 'auto', '');
  assert.ok(style.includes('short intro, vocals enter early'));
});

// ===============================================================================================
// 10) Confirmari structurale — mecanismul vechi (isManeleSufletGenre + variante ...ManeleSuflet)
//     a fost complet eliminat (nu doar dezactivat/dublat); formele FULL raman NEATINSE.
// ===============================================================================================
test('server.js: isManeleSufletGenre NU mai exista ca variabila (mecanismul e acum universal, fara gating pe gen)', () => {
  assert.ok(!server.includes('const isManeleSufletGenre'));
});

test('server.js: variantele ...ManeleSuflet (duplicate) NU mai exista — "Short lines" e acum parte din formele SHORT de baza, fara duplicare', () => {
  assert.ok(!server.includes('instructionWithSenderShortManeleSuflet'));
  assert.ok(!server.includes('instructionNoSenderShortManeleSuflet'));
});

test('server.js: instructionWithSenderShort/instructionNoSenderShort contin STRICT "Short lines" (nu mai "Verse intro")', () => {
  const m1 = server.match(/const instructionWithSenderShort = '([^']*)';/);
  const m2 = server.match(/const instructionNoSenderShort = '([^']*)';/);
  assert.ok(m1 && m2);
  assert.ok(m1[1].startsWith(' Short lines;'));
  assert.ok(m2[1].startsWith(' Short lines;'));
  assert.ok(!m1[1].includes('Verse intro'));
  assert.ok(!m2[1].includes('Verse intro'));
});

test('server.js: formele FULL (instructionWithSenderFull/instructionNoSenderFull) raman BYTE-IDENTICE — neatinse de aceasta extindere', () => {
  assert.match(server, /const instructionWithSenderFull = ' Write this as a personal song from the sender to the recipient, weaving real, specific, never-invented story details throughout — never generic or repeated, natural over forced rhyme\. Use only complete, grammatically correct words — never shortened\. Start the vocals around 8-10 seconds, like the verse\. Name the recipient early and in the chorus; mention the sender once\.';/);
  assert.match(server, /const instructionNoSenderFull = ' Weave real, specific, never-invented story details throughout — never generic or repeated, natural over forced rhyme\. Use only complete, grammatically correct words — never shortened\. Start the vocals around 8-10 seconds, like the verse\. Address the recipient by name naturally in the lyrics\.';/);
});

test('server.js: currentInstruction() nu mai face NICIO ramificare pe gen — STRICT pe hasSender/useShortInstruction', () => {
  const idx = server.indexOf('function currentInstruction() {');
  const end = server.indexOf('\n  }', idx);
  const block = server.slice(idx, end);
  assert.doesNotMatch(block, /isManeleSufletGenre/);
  assert.doesNotMatch(block, /genre/i);
  assert.match(block, /return useShortInstruction \? instructionWithSenderShort : instructionWithSenderFull;/);
  assert.match(block, /return useShortInstruction \? instructionNoSenderShort : instructionNoSenderFull;/);
});

// ===============================================================================================
// 11) Limita de buget existenta (SUNO_PROMPT_MAX_LEN=600) NU s-a schimbat si NU e niciodata
//     depasita, pentru genul cu styleTags cel mai lung dintre toate (hiphop, 143 caractere) —
//     inlocuieste testul #8 din vechiul fisier (care verifica DOAR manele_suflet, 137 caractere,
//     nu si genul chiar mai lung).
// ===============================================================================================
test('server.js: SUNO_PROMPT_MAX_LEN ramane 600 (limita existenta, neschimbata)', () => {
  assert.match(server, /const SUNO_PROMPT_MAX_LEN = 600;/);
});

// ===============================================================================================
// Izolare — dictie/pronuntie, preview, checkout/funnel/Admin/recovery/Meta Ads.
// ===============================================================================================
test('server.js: normalizeSingingText/getDictionInstruction (dictie/pronuntie) raman apelate exact ca inainte in buildPrompt — nicio schimbare de import/apel', () => {
  const idx = server.indexOf('function buildPrompt(order, feedback, genreOverride) {');
  const end = server.indexOf('\nfunction ', idx + 10);
  const block = server.slice(idx, end);
  assert.match(block, /normalizeSingingText\(/);
  assert.match(block, /getDictionInstruction\(/);
});

test('aceasta corectie nu introduce niciun require nou catre Admin/recovery-emails/meta-ads/Stripe', () => {
  const idx = server.indexOf('const instructionWithSenderShort =');
  const end = server.indexOf('function currentInstruction() {', idx) + 400;
  const block = server.slice(idx, end);
  assert.ok(!block.includes('recovery-emails'));
  assert.ok(!block.includes('meta-ads'));
  assert.ok(!block.includes('stripe'));
});

// ===============================================================================================
// 12) VOCALS ENTER EARLY — clauza oportunista, generica (2026-09-26, gasita si aprobata explicit
//     in timpul acestei sarcini): "Verse intro" (eliminat din formele SHORT, inlocuit cu "Short
//     lines") reintarea si o corectie ANTERIOARA, separata (2026-09-14, intro-vocal-continuity-fix)
//     — fara nicio compensare, celelalte 22 de genuri ar pierde acel indiciu in forma SHORT
//     (dominanta). Adaugarea GARANTATA in GENRE_STYLE_MAP a fost respinsa dupa masurare directa
//     (marja libera in scenariul cel mai incarcat: DOAR 1-7 caractere, pentru orice gen) — solutia
//     aprobata: o clauza GENERICA, STRICT oportunista (aceeasi prioritate/mecanism ca
//     durationTargetClause), niciodata pe seama povestii/dictiei/numelor.
// ===============================================================================================
test('12a) vocalsEarlyClause: apare pentru comenzi USOARE (poveste scurta, fara expeditor), pentru un gen non-manele_suflet', () => {
  const light = { occasion: 'zi_de_nastere', genre: 'jazz', lang: 'ro', recipient: 'Ana', story: 'O poveste scurta.' };
  const prompt = buildPrompt(light, '', undefined);
  assert.ok(prompt.includes('Vocals enter early.'), `clauza ar trebui sa incapa pentru o comanda usoara: ${prompt}`);
});

test('12b) vocalsEarlyClause: NU apare NICIODATA pentru manele_suflet (deja compensat separat in GENRE_STYLE_MAP — evita o mentiune redundanta)', () => {
  const light = { occasion: 'zi_de_nastere', genre: 'manele_suflet', lang: 'ro', recipient: 'Ana', story: 'O poveste scurta.' };
  const prompt = buildPrompt(light, '', undefined);
  assert.ok(!prompt.includes('Vocals enter early.'));
  assert.ok(prompt.includes('vocals enter early'), 'GENRE_STYLE_MAP.manele_suflet trebuie sa ramana sursa unica a acestui indiciu pentru acest gen');
});

test('12c) vocalsEarlyClause: NICIODATA nu impinge promptul peste 600 caractere (STRICT oportunista) — scenariul cel mai incarcat, toate cele 8 limbi, pentru genul cu styleTags cel mai lung (hiphop)', () => {
  const LANGS_ALL = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
  for (const lang of LANGS_ALL) {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre: 'hiphop', lang,
      recipient: 'Alexandru-Gheorghe-Constantin', senderName: 'Ecaterina-Anastasia-Elisabeta',
      relationship: 'sora', voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog, cu mai multa energie', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] prompt peste buget: ${prompt.length}`);
  }
});

test('12d) vocalsEarlyClause: NICIODATA nu coboara povestea sub prag (prioritate STRICT mai mica decat dictie/durata/paranteze/poveste) — scenariul cel mai incarcat tot pastreaza povestea', () => {
  const order = {
    occasion: 'nunta', weddingType: 'wedding', genre: 'hiphop', lang: 'bg',
    recipient: 'Alexandru-Gheorghe-Constantin', senderName: 'Ecaterina-Anastasia-Elisabeta',
    relationship: 'sora', voicePreference: 'duet',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
  };
  const prompt = buildPrompt(order, 'Mai vesela te rog, cu mai multa energie', undefined);
  assert.ok(/Story[^:]*:\s*\S/i.test(prompt), `povestea trebuie sa ramana prezenta: ${prompt}`);
});

test('12e) vocalsEarlyClause: text generic, identic pentru orice gen (nu per-gen, nu in GENRE_STYLE_MAP)', () => {
  const idx = server.indexOf("const vocalsEarlyClause = ((genreOverride || order.genre) !== 'manele_suflet') ? ' Vocals enter early.' : '';");
  assert.ok(idx !== -1, 'declaratia trebuie sa fie STRICT genrica (o singura constanta, nu una per gen)');
});

test('12f) vocalsEarlyClause: e adaugata STRICT dupa dictie/durata/paranteze (aceeasi prioritate/pozitie ca durationTargetClause), niciodata inaintea lor', () => {
  const dictionIdx = server.indexOf('if (canReserveForDiction && prompt.length + dictionInstruction.length <= SUNO_PROMPT_MAX_LEN) {');
  const durationIdx = server.indexOf('if (canReserveForDuration && prompt.length + durationTargetClause.length <= SUNO_PROMPT_MAX_LEN) {');
  const bracketIdx = server.indexOf('if (canReserveForBoth && bracketLanguageClause && prompt.length + bracketLanguageClause.length <= SUNO_PROMPT_MAX_LEN) {');
  const vocalsIdx = server.indexOf('if (vocalsEarlyClause && prompt.length + vocalsEarlyClause.length <= SUNO_PROMPT_MAX_LEN) {');
  assert.ok(dictionIdx !== -1 && durationIdx !== -1 && bracketIdx !== -1 && vocalsIdx !== -1);
  assert.ok(dictionIdx < durationIdx && durationIdx < bracketIdx && bracketIdx < vocalsIdx, 'ordinea trebuie sa fie: dictie -> durata -> paranteze -> vocals-early (STRICT ultima prioritate)');
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
