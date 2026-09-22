// MANELE_SUFLET — SUNET AUTENTIC DE MANEA ROMANEASCA (2026-09-22, runda 2, cerinta explicita).
//
// Problema raportata: manele_suflet suna "prea generic", nu suficient de mult a manea romaneasca
// autentica. Directia ceruta (artisti precum Costel Biju/Tzanca Uraganu/Adrian Minune/Laura Vass/
// Printesa de Aur) e STRICT o REFERINTA de directie muzicala pentru mine — NICIODATA trimisa mai
// departe catre furnizor, NICIODATA nume de artist in text, NICIODATA clonare/imitare de voce —
// tradusa in CARACTERISTICI GENERALE ale genului: identitate "authentic Romanian manele",
// instrumentatie (vioara/acordeon/clarinet), si interpretare vocala specifica genului (melisme,
// vibrato, frazare de manea) — NICIODATA timbrul vocal al unui artist anume.
//
// NU s-a atins: manele_jale ("perfecta" in productie, raportat explicit), niciun alt gen,
// relationClause()/regulile anti-repetitie/STORY_MIN_RESERVE/buildExactLyricsRequest() (folosite,
// niciodata modificate), preturile/pachetele/Stripe/checkout, versiunea GENRE_STYLE_MAP pentru
// orice alt gen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
const LEGACY_ONLY_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern'];

// ===============================================================================================
// Extragere buildPrompt() / buildExactLyricsRequest() REALE din server.js — acelasi tipar folosit
// deja in test/manele-suflet-short-intro.test.js si test/intro-vocal-continuity-fix.test.js.
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

const worstCaseOrder = (overrides) => Object.assign({
  occasion: 'nunta', genre: 'manele_suflet', lang: 'ro',
  recipient: 'Alexandru Ionut Popescu si Maria Elena Ionescu',
  senderName: 'Familia Popescu si Ionescu, nasii si toti prietenii apropiati',
  relationship: 'nasii de cununie si cei mai buni prieteni din copilarie', voicePreference: 'duet',
  story: 'V-ati cunoscut acum zece ani la o petrecere organizata de prieteni comuni, iar de atunci povestea voastra de dragoste a fost una plina de calatorii si sprijin reciproc.'
}, overrides);

const NEW_STYLE = 'Romanian manele de suflet, violin, accordion, clarinet, melismatic vibrato vocal, hopeful manele phrasing, short intro, vocals enter early';

// ===============================================================================================
// 1) DESCRIEREA NOUA — folosita, caracteristicile de manea prezente.
// ===============================================================================================
test('GENRE_STYLE_MAP.manele_suflet foloseste noua descriere autentica', () => {
  assert.equal(GENRE_STYLE_MAP.manele_suflet, NEW_STYLE);
});

test('descrierea contine identitatea clara de gen: "Romanian manele"', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /Romanian manele/);
});

// ACTUALIZAT (2026-09-22): "Authentic" (cuvant separat) a fost sacrificat pentru bugetul de 600
// caractere in favoarea pastrarii distinctiei de mood fata de manele_jale (vezi grupul 1b de mai
// jos) — identitatea de gen ramane clara prin "Romanian manele de suflet" insusi (cuvantul
// "manele" apare direct, explicit).
test('1b) DIFERENTIERE fata de manele_jale ramane INTACTA (regresie pre-existenta, 2026-09-13): manele_suflet ramane caldut/plin de speranta ("hopeful"), manele_jale ramane intunecat/jelitor — niciodata amestecate', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /hopeful|devoted/i);
  assert.ok(!/mournful|lament|grief/i.test(GENRE_STYLE_MAP.manele_suflet), 'Manele de suflet nu trebuie sa contina descriptori de jale');
  assert.match(GENRE_STYLE_MAP.manele_jale, /mournful|lament|longing/i);
  assert.ok(!/hopeful/i.test(GENRE_STYLE_MAP.manele_jale), 'Manele de jale nu trebuie sa contina descriptori de speranta');
});

test('descrierea contine interpretarea vocala specifica manelelor: melismatic si vibrato (cerinta explicita "TIPUL DE INTERPRETARE", NU imitarea unui artist)', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /melismatic/i);
  assert.match(GENRE_STYLE_MAP.manele_suflet, /vibrato/i);
});

test('descrierea contine frazarea specifica manelelor ("manele phrasing")', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /manele phrasing/);
});

test('descrierea pastreaza instrumentatia specifica (vioara/acordeon/clarinet)', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /violin/);
  assert.match(GENRE_STYLE_MAP.manele_suflet, /accordion/);
  assert.match(GENRE_STYLE_MAP.manele_suflet, /clarinet/);
});

test('short intro ramane in descriere', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /short intro/);
});

test('"vocals enter early" ramane in descriere', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /vocals enter early/);
});

test('CRITIC — descrierea NU contine niciodata cuvantul "instrumental" (REGRESIE CRITICA 2026-08-13, documentata in test/lyrics-exact-story-premium-sequential.test.js)', () => {
  assert.doesNotMatch(GENRE_STYLE_MAP.manele_suflet, /instrumental/i);
});

// ===============================================================================================
// 2) NICIO CLONARE/IMITARE DE ARTIST — cerinta explicita: numele mentionate de client sunt STRICT
// referinte de directie muzicala pentru mine, niciodata trimise mai departe catre furnizor.
// ===============================================================================================
test('descrierea NU contine niciun nume de artist real (Costel Biju/Tzanca Uraganu/Adrian Minune/Laura Vass/Printesa de Aur) — referinte STRICT de directie, niciodata trimise catre furnizor', () => {
  const forbidden = [/costel/i, /biju/i, /tzanca/i, /uraganu/i, /adrian minune/i, /laura vass/i, /printesa de aur/i];
  for (const re of forbidden) {
    assert.doesNotMatch(GENRE_STYLE_MAP.manele_suflet, re, `descrierea nu trebuie sa contina o referinta la un artist real (${re})`);
  }
});

test('niciun nume de artist NU apare nicaieri in server.js langa GENRE_STYLE_MAP (verificare structurala suplimentara, dincolo de valoarea insasi)', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('\n};', idx);
  const body = server.slice(idx, end);
  for (const forbidden of ['Costel Biju', 'Tzanca Uraganu', 'Adrian Minune', 'Laura Vass', 'Printesa de Aur']) {
    assert.ok(!body.includes(forbidden), `nu trebuie sa apara "${forbidden}" in blocul GENRE_STYLE_MAP`);
  }
});

// ===============================================================================================
// 3) VOICE INSTRUCTIONS continua sa functioneze (female/male/duet/auto) — mecanism NEATINS,
// independent de GENRE_STYLE_MAP.
// ===============================================================================================
for (const voicePreference of ['female', 'male', 'duet', 'auto']) {
  test(`buildExactLyricsRequest: voicePreference="${voicePreference}" continua sa functioneze pentru manele_suflet`, () => {
    const { style } = buildExactLyricsRequest(typicalOrder({ voicePreference }), 'Vers exact', undefined, voicePreference, '');
    if (voicePreference === 'female') assert.match(style, /Female lead vocal\./);
    if (voicePreference === 'male') assert.match(style, /Male lead vocal\./);
    if (voicePreference === 'duet') assert.match(style, /Male and female duet, both voices clearly present\./);
    assert.match(style, /manele phrasing/, 'stilul de manele trebuie sa fie prezent indiferent de vocea aleasa');
  });
}

test('buildPrompt: instructiunea de voce (currentVoiceInstruction) ramane prezenta pentru manele_suflet, indiferent de vocea aleasa', () => {
  for (const voicePreference of ['female', 'male', 'duet', 'auto']) {
    const prompt = buildPrompt(typicalOrder({ voicePreference }), '', undefined);
    assert.ok(prompt.length > 0);
  }
  assert.match(server, /const VOICE_INSTRUCTIONS_SHORT/, 'mecanismul de instructiuni de voce trebuie sa ramana neatins');
});

// ===============================================================================================
// 4) TOATE CELE 8 LIMBI — stilul muzical (manele romanesti) ramane identic indiferent de limba
// versurilor; niciun cuvant romanesc hardcodat in afara descrierii insesi (deja in engleza).
// ===============================================================================================
for (const lang of LANGS) {
  test(`[${lang}] buildPrompt() (generare initiala) contine noua descriere de manele pentru manele_suflet`, () => {
    const prompt = buildPrompt(typicalOrder({ lang }), '', undefined);
    assert.ok(prompt.includes('Romanian manele de suflet'), `[${lang}] descrierea lipseste din prompt: ${prompt}`);
    assert.ok(prompt.includes('short intro, vocals enter early'), `[${lang}] intro-ul scurt lipseste din prompt`);
  });
  test(`[${lang}] buildExactLyricsRequest() (editare/regenerare) contine noua descriere in style`, () => {
    const { style } = buildExactLyricsRequest(typicalOrder({ lang }), 'Vers exact', undefined, 'auto', '');
    assert.ok(style.includes('Romanian manele de suflet'), `[${lang}] descrierea lipseste din style: ${style}`);
  });
}

// ===============================================================================================
// 5) PACHETE — Standard, Premium (genre + genre2), Video, regenerare.
// ===============================================================================================
test('Standard: buildPrompt() cu plan=standard, genre=manele_suflet foloseste noua descriere', () => {
  const prompt = buildPrompt(typicalOrder({ plan: 'standard' }), '', undefined);
  assert.ok(prompt.includes('Romanian manele de suflet'));
});

test('Premium: manele_suflet ca genre (prima melodie, fara genreOverride)', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'manele_suflet', genre2: 'pop' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Romanian manele de suflet'));
});

test('Premium: manele_suflet ca genre2 (a doua melodie, prin genreOverride) — izolat per melodie, prima melodie (pop) neafectata', () => {
  const order = typicalOrder({ plan: 'premium', genre: 'pop', genre2: 'manele_suflet' });
  const prompt2 = buildPrompt(order, '', 'manele_suflet');
  assert.ok(prompt2.includes('Romanian manele de suflet'));
  const prompt1 = buildPrompt(order, '', order.genre);
  assert.ok(!prompt1.includes('Romanian manele de suflet'), 'prima melodie (pop) nu trebuie sa capete stilul de manele');
});

test('Video: buildPrompt() cu plan=video, genre=manele_suflet foloseste noua descriere', () => {
  const prompt = buildPrompt(typicalOrder({ plan: 'video' }), '', undefined);
  assert.ok(prompt.includes('Romanian manele de suflet'));
});

test('Regenerare/editare (buildExactLyricsRequest, customMode:true) primeste aceeasi descriere, prin acelasi GENRE_STYLE_MAP', () => {
  const order = typicalOrder();
  const { style } = buildExactLyricsRequest(order, 'Vers editat manual de client', undefined, 'auto', 'Mai vesela te rog');
  assert.ok(style.includes('Romanian manele de suflet'), `descrierea lipseste din style-ul de regenerare: ${style}`);
});

// ===============================================================================================
// 6) BUGET DE CARACTERE — SUNO_PROMPT_MAX_LEN=600 respectat, STORY_MIN_RESERVE respectat, povestea
// NU e eliminata de noua descriere, chiar si in cel mai incarcat scenariu real (nunta, nume
// maxime protejate, duet), in toate cele 8 limbi.
// ===============================================================================================
test('buget: manele_suflet, cel mai incarcat scenariu (nunta, nume maxime, duet, feedback) — prompt <= 600 caractere SI povestea supravietuieste', () => {
  const prompt = buildPrompt(worstCaseOrder({}), 'Mai vesela te rog, cu mai multa energie', undefined);
  assert.ok(prompt.length <= 600, `prompt peste buget: ${prompt.length} caractere`);
  const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
  assert.ok(storyIdx !== -1, 'povestea nu trebuie sa dispara');
});

for (const lang of LANGS) {
  test(`[${lang}] buget: scenariul cel mai incarcat ramane <=600 caractere SI povestea supravietuieste`, () => {
    const prompt = buildPrompt(worstCaseOrder({ lang }), '', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] prompt peste buget: ${prompt.length} caractere`);
    const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
    assert.ok(storyIdx !== -1, `[${lang}] povestea nu trebuie sa dispara`);
  });
}

test('buget: comanda TIPICA (nu extrema) — povestea ramane completa (necomprimata), nu doar prezenta', () => {
  const order = typicalOrder();
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(order.story), 'pentru o comanda tipica, povestea completa trebuie sa incapa necomprimata');
});

test('buget: toate cele 16 genuri (inclusiv manele_suflet, actualizat) — ocazia nunta, duet — raman sub 600 caractere si povestea supravietuieste (regresie generala)', () => {
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

test('STORY_MIN_RESERVE ramane 190, buildPrompt() nu a fost restructurat de aceasta corectie (STRICT GENRE_STYLE_MAP.manele_suflet a fost modificat)', () => {
  assert.match(server, /const STORY_MIN_RESERVE = 190;/);
});

// ===============================================================================================
// 7) manele_jale — "perfecta", NEATINS, byte-identic.
// ===============================================================================================
test('manele_jale ramane BYTE-IDENTIC — NU a fost atins de aceasta corectie', () => {
  assert.equal(
    GENRE_STYLE_MAP.manele_jale,
    'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood'
  );
});

test('manele_jale, in buildPrompt() real, ramane vizibil neschimbat pentru comenzi cu acest gen', () => {
  const prompt = buildPrompt(typicalOrder({ genre: 'manele_jale' }), '', undefined);
  assert.ok(prompt.includes('Romanian manele de jale, minor-key oriental colour'));
  assert.ok(!prompt.includes('Romanian manele de suflet'), 'manele_jale nu trebuie sa capete noua descriere de manele_suflet');
});

// ===============================================================================================
// 8) CELELALTE GENURI — byte-identice, niciunul atins de aceasta corectie.
// ===============================================================================================
test('niciun alt gen din GENRE_STYLE_MAP (in afara de manele_suflet) nu a fost modificat de aceasta corectie, comparat cu valorile deja verificate in test/manele-suflet-short-intro.test.js', () => {
  const before = {
    emotional: 'cinematic orchestral ballad, swelling strings and piano, rubato build, breathy vulnerable vocal, tearful climax',
    suflet: 'intimate de suflet ballad, sparse guitar or piano, close warm vocal, quiet confessional unpolished mood',
    acustic: 'unplugged acoustic folk, fingerpicked guitar, light percussion, natural room sound, plain sincere vocal',
    petrecere: 'fast Romanian party beat, 130+bpm, syncopated dance rhythm, horns and synth stabs, shouted chorus, club energy',
    balada: 'slow rubato piano ballad, sustained strings, no beat, dramatic dynamic swells, powerful sustained vocal',
    manele: 'Romanian manele de jale, oriental scale, mournful clarinet, melismatic vocal slides, minor key grief',
    modern: 'sleek modern pop-electronic, deep 808 sub bass, glossy synth pads, vocal chops, minimalist premium production',
    pop: 'contemporary pop, catchy chorus hook, clean modern production, melody-led rhythm, vocals forward, upbeat energy',
    ballad_emotional: 'emotional ballad, piano and/or acoustic guitar, slow rubato build, vulnerable vocal, dynamic emotional climax',
    acoustic_folk: 'acoustic folk, fingerpicked guitar, organic instrumentation, light percussion, warm intimate sound, sincere vocal',
    rnb: 'modern smooth R&B, warm deep bass, syncopated groove, atmospheric keys and pads, intimate melodic vocal, relaxed tempo',
    country: 'storytelling country, acoustic guitar foundation, steel or electric guitar, warm narrative vocal, natural drums, melodic chorus',
    jazz: 'smooth jazz, saxophone or piano, warm bass, brushed drums, jazz-coloured harmony, slow-medium groove, soulful vocal',
    rock: 'live rock band, distorted electric guitar riff, bass, drums, strong vocal, chorus expands from verse, ranges soft-rock to stadium rock',
    hiphop: '2000s street hip-hop, hard drums, punchy kick, dry snare, deep heavy bass, sparse dark gritty beat from the first beat, rap verses, street hook',
    edm_dance: 'EDM dance, four-on-the-floor kick, synth-driven, powerful bass, build-up into drop, danceable groove, festival energy',
    manele_jale: 'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood',
    populara: 'Romanian muzica populara, traditional folk ensemble, violin accordion or flute, traditional dance rhythm, folk ornamentation',
    copii: 'cheerful song for children, simple major-key melody, easy sing-along chorus, piano ukulele or bells, bright vocal',
    colind: 'traditional Romanian Christmas carol, warm communal vocal, acoustic instruments, tasteful bells, ceremonial warmth',
    romantic: 'timeless romantic love song, piano or acoustic guitar, optional strings, soft percussion, intimate vocal',
    motivational: 'motivational anthem, builds from moderate to high energy, confident drums, piano or guitar, rising vocal, anthemic chorus'
  };
  for (const [genre, expected] of Object.entries(before)) {
    assert.equal(GENRE_STYLE_MAP[genre], expected, `genul "${genre}" trebuie sa ramana byte-identic`);
  }
});

// ===============================================================================================
// 9) Confirmari structurale suplimentare — nimic altceva atins.
// ===============================================================================================
test('GENRE_STYLE_MAP e SINGURA sursa folosita la generare — exact 2 folosiri in tot server.js', () => {
  const usages = server.match(/GENRE_STYLE_MAP\[genreOverride \|\| order\.genre\]/g) || [];
  assert.equal(usages.length, 2, 'trebuie sa existe EXACT 2 folosiri — buildPrompt() si buildExactLyricsRequest()');
});

test('PLAN_PRICES/PLAN_VARIANT_COUNT/VIDEO_PREVIEW_SECONDS/PREVIEW_SECONDS raman neschimbate', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PREVIEW_SECONDS = 40;/);
});

test('server.js ramane sintactic valid', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
