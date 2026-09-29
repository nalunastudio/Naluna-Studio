// DIFERENTIERE MUZICALA manele_jale vs manele_suflet — DOUA RUNDE, cerinte explicite.
//
// RUNDA 1 (2026-10-06): clientul a analizat separat 5 referinte audio si a cerut o rescriere a
// GENRE_STYLE_MAP.manele_jale spre lamentatie/durere (minor pronuntat, "crying" vocal, "heavy
// heartbreak"), opusul mood-ului "hopeful devoted" de la manele_suflet. Aprobata si livrata.
//
// RUNDA 2 (2026-10-07): testul REAL de productie al variantei din runda 1 nu a placut — problema
// principala era INTERPRETAREA, nu identitatea de gen. Cerinta noua: voce PUTERNICA, PROIECTATA,
// senzatie de interpretare LIVE (nu moale/intima, nu pop/cinematic ballad, nu dreamy/ambient).
// Text rescris a doua oara, cu accentul mutat de la vocabular "intunecat" (crying/heartbreak) la
// caracterul de interpretare (powerful/projected/live-band).
//
// O varianta alternativa a rundei 2, doar 12 caractere mai lunga (142, cu "live-band performance
// feel" in loc de "live-band feel"), a fost RESPINSA dupa verificare directa prin buildPrompt():
// in scenariul cel mai incarcat deja documentat (nunta, nume compuse maxime, duet, bulgara),
// povestea clientului disparea COMPLET — pragul de rupere masurat e undeva intre 130 si 142
// caractere pentru acest scenariu extrem. Varianta APROBATA (130 caractere) a fost verificata sa
// NU reproduca acest bug.
//
// Scope STRICT: STRICT valoarea string GENRE_STYLE_MAP.manele_jale. manele_suflet, legacy
// `manele`, vocalsEarlyClause, buildPrompt(), limita de 600 caractere, story logic, Short lines,
// dictia, preview-ul de 50s (EXTENDED_PREVIEW_GENRES) si toate celelalte genuri raman neatinse —
// verificat explicit mai jos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const NEW_MANELE_JALE_STYLE = 'Romanian manele de jale, powerful projected live vocal, strong oriental melismatic ornamentation, live-band feel, minor-key melody';
const UNCHANGED_MANELE_SUFLET_STYLE = 'Romanian manele, Balkan oriental, melismatic vocal runs, violin accordion clarinet, hopeful devoted mood, short intro, vocals enter early';
const UNCHANGED_LEGACY_MANELE_STYLE = 'Romanian manele de jale, oriental scale, mournful clarinet, melismatic vocal slides, minor key grief';
// Textele RESPINSE (runda 1 finala, si runda 1 initiala) — verificam explicit ca NU mai apar nicaieri.
const REJECTED_ROUND1_STYLE = 'Romanian manele de jale, deep minor oriental melody, crying melismatic vocal, expressive violin clarinet, oriental synth, heavy heartbreak';
const REJECTED_ROUND1_INITIAL_STYLE = 'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood';
const REJECTED_ROUND2_OVERBUDGET_STYLE = 'Romanian manele de jale, powerful projected live vocal, strong oriental melismatic ornamentation, live-band performance feel, minor-key melody';

// ===============================================================================================
// Extragere buildPrompt() REALA din server.js (acelasi tipar deja folosit in
// test/manele-suflet-short-intro.test.js) — nicio reimplementare paralela.
// ===============================================================================================
function loadBuildPrompt(replacementStyle) {
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
  let snippet = server.slice(startIdx, i + 1);
  if (replacementStyle) {
    const currentLine = `manele_jale: '${NEW_MANELE_JALE_STYLE}',`;
    assert.ok(snippet.includes(currentLine), 'linia curenta manele_jale negasita verbatim — folosita STRICT pentru testul comparativ al variantei respinse, mai jos');
    snippet = snippet.replace(currentLine, `manele_jale: '${replacementStyle}',`);
  }
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

function loadGenreStyleMap() {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('\n};', idx);
  const body = server.slice(idx, end);
  const map = {};
  const ALL_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern',
    'pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
    'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
  for (const g of ALL_GENRES) {
    const m = body.match(new RegExp(`\\n  ${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit GENRE_STYLE_MAP.${g}`);
    map[g] = m[1];
  }
  return map;
}
const GENRE_STYLE_MAP = loadGenreStyleMap();

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'zi_de_nastere', genre: 'manele_jale', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  }, overrides);
}

// Scenariul cel mai incarcat deja documentat in codebase (vezi test/manele-suflet-short-intro.
// test.js) — nunta, nume compuse maxime, duet, limba cu cel mai stramt buget (bulgara).
function heaviestOrder(overrides) {
  return Object.assign({
    occasion: 'nunta', weddingType: 'wedding', genre: 'manele_jale', lang: 'bg', plan: 'premium',
    recipient: 'Alexandra-Gabriela Popescu-Ionescu', senderName: 'Constantin-Ștefan Dumitrescu-Vasilescu',
    relationship: 'sotie', voicePreference: 'duet',
    story: 'Ne-am cunoscut la o nunta a unui prieten comun acum multi ani si de atunci nu ne-am mai despartit niciodata, am trecut prin bune si rele impreuna.'
  }, overrides);
}

// ===============================================================================================
// TEST 1 — noul string exact pentru manele_jale (RUNDA 2).
// ===============================================================================================
test('1) GENRE_STYLE_MAP.manele_jale contine EXACT noul text aprobat, runda 2 (130 caractere, fara "early vocals")', () => {
  assert.equal(GENRE_STYLE_MAP.manele_jale, NEW_MANELE_JALE_STYLE);
  assert.equal(Array.from(GENRE_STYLE_MAP.manele_jale).length, 130);
  assert.ok(!GENRE_STYLE_MAP.manele_jale.toLowerCase().includes('hopeful'), 'nu trebuie sa mai contina caracterul hopeful/devoted al lui manele_suflet');
  assert.ok(!GENRE_STYLE_MAP.manele_jale.toLowerCase().includes('devoted'));
});

test('1b) niciunul din textele RESPINSE (runda 1 initiala, runda 1 finala, varianta supra-buget a rundei 2) nu mai apare', () => {
  assert.notEqual(GENRE_STYLE_MAP.manele_jale, REJECTED_ROUND1_STYLE);
  assert.notEqual(GENRE_STYLE_MAP.manele_jale, REJECTED_ROUND1_INITIAL_STYLE);
  assert.notEqual(GENRE_STYLE_MAP.manele_jale, REJECTED_ROUND2_OVERBUDGET_STYLE);
  assert.ok(!server.includes(REJECTED_ROUND1_STYLE), 'textul respins al rundei 1 (finala) nu mai trebuie sa existe nicaieri in server.js');
});

// ===============================================================================================
// TEST 2 — manele_suflet ramane byte-for-byte neschimbat.
// ===============================================================================================
test('2) GENRE_STYLE_MAP.manele_suflet ramane BYTE-FOR-BYTE neschimbat', () => {
  assert.equal(GENRE_STYLE_MAP.manele_suflet, UNCHANGED_MANELE_SUFLET_STYLE);
});

// ===============================================================================================
// TEST 3 — legacy `manele` ramane neschimbat.
// ===============================================================================================
test('3) GENRE_STYLE_MAP.manele (legacy, folosit STRICT la regenerarea comenzilor vechi) ramane neschimbat', () => {
  assert.equal(GENRE_STYLE_MAP.manele, UNCHANGED_LEGACY_MANELE_STYLE);
});

// ===============================================================================================
// TEST 4 — buildPrompt() pentru manele_jale foloseste noul style.
// ===============================================================================================
test('4) buildPrompt() cu genre=manele_jale foloseste STRICT noul style (nu vreun text vechi, nu manele_suflet)', () => {
  const prompt = buildPrompt(typicalOrder({ genre: 'manele_jale' }), '', undefined);
  assert.ok(prompt.startsWith(NEW_MANELE_JALE_STYLE), 'promptul trebuie sa inceapa cu noul styleTags, neschimbat de restul cascadei');
  assert.ok(!prompt.includes('minor-key oriental colour'), 'textul rundei 1 initiale nu mai trebuie sa apara nicaieri');
  assert.ok(!prompt.includes('crying melismatic vocal'), 'textul rundei 1 finale nu mai trebuie sa apara nicaieri');
  assert.ok(!prompt.includes('hopeful devoted'), 'promptul pentru manele_jale nu trebuie sa contina caracterul lui manele_suflet');
});

test('4b) buildPrompt() cu genreOverride=manele_jale (Premium, a doua melodie) foloseste la fel noul style', () => {
  const order = typicalOrder({ genre: 'pop', plan: 'premium' });
  const prompt = buildPrompt(order, '', 'manele_jale');
  assert.ok(prompt.startsWith(NEW_MANELE_JALE_STYLE));
});

// ===============================================================================================
// TEST 5 — promptul final ramane STRICT <=600 caractere (limita SUNO_PROMPT_MAX_LEN, neschimbata),
// inclusiv in scenariul cel mai incarcat deja documentat.
// ===============================================================================================
test('5) buildPrompt() pentru manele_jale ramane STRICT <=600 caractere, in scenariul tipic SI in cel mai incarcat scenariu documentat (nunta, nume compuse maxime, duet, bulgara)', () => {
  const typicalPrompt = buildPrompt(typicalOrder(), '', undefined);
  assert.ok(typicalPrompt.length <= 600, `scenariul tipic: ${typicalPrompt.length} caractere, peste limita`);

  const heaviestPrompt = buildPrompt(heaviestOrder(), '', undefined);
  assert.ok(heaviestPrompt.length <= 600, `scenariul cel mai incarcat: ${heaviestPrompt.length} caractere, peste limita`);

  const heaviestWithFeedback = buildPrompt(heaviestOrder(), 'Vreau sa fie mult mai emotionanta si mai lenta', undefined);
  assert.ok(heaviestWithFeedback.length <= 600, `scenariul cel mai incarcat + feedback: ${heaviestWithFeedback.length} caractere, peste limita`);
});

// ===============================================================================================
// TEST 6 — povestea continua sa fie prioritizata conform mecanismului EXISTENT (buildPrompt
// neschimbat) — confirmam explicit ca noul style (130 caractere) NU reproduce regresia gasita la
// varianta respinsa de 142 caractere (runda 2), unde povestea disparea COMPLET in scenariul cel
// mai incarcat.
// ===============================================================================================
test('6) In scenariul cel mai incarcat, povestea clientului RAMANE PREZENTA in prompt (fragment, chiar daca trunchiat de mecanismul deja existent) — NU dispare complet, spre deosebire de varianta respinsa de 142 caractere', () => {
  const prompt = buildPrompt(heaviestOrder(), '', undefined);
  assert.ok(prompt.includes('Story'), 'eticheta povestii trebuie sa ramana prezenta');
  assert.ok(prompt.includes('Ne-am'), 'un fragment din poveste trebuie sa ramana prezent, niciodata eliminat complet');
});

test('6b) In scenariul tipic (fara presiune extrema de buget), povestea completa a clientului apare NETRUNCHIATA', () => {
  const order = typicalOrder();
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(order.story), 'povestea completa trebuie sa apara, cuvant cu cuvant, cand exista suficient buget');
});

test('6c) COMPARATIV: varianta respinsa a rundei 2 (142 caractere, "live-band performance feel") ELIMINA COMPLET povestea in scenariul cel mai incarcat — dovada directa a motivului pentru care a fost respinsa', () => {
  const buildPromptRejected = loadBuildPrompt(REJECTED_ROUND2_OVERBUDGET_STYLE);
  const prompt = buildPromptRejected(heaviestOrder(), '', undefined);
  assert.ok(!prompt.includes('Story'), 'varianta respinsa trebuie sa demonstreze eliminarea completa a etichetei povestii in acest scenariu');
});

// ===============================================================================================
// TEST 7 — NU exista redundanta "early vocals"/"live vocal ... enter early" + "Vocals enter
// early." (clauza oportunista existenta, vocalsEarlyClause) — nici in stilul insusi, nici in
// promptul final, in niciun scenariu (inclusiv cel mai usor, unde clauza oportunista are cele mai
// mari sanse sa incapa).
// ===============================================================================================
test('7) GENRE_STYLE_MAP.manele_jale NU contine "early vocals"/"enter early" — vocalsEarlyClause (nemodificata) adauga deja acest indiciu automat, opportunist, pentru orice gen diferit de manele_suflet', () => {
  assert.ok(!GENRE_STYLE_MAP.manele_jale.toLowerCase().includes('early vocals'), 'stilul nu trebuie sa mentioneze "early vocals" — ar deveni redundant cu vocalsEarlyClause');
  assert.ok(!GENRE_STYLE_MAP.manele_jale.toLowerCase().includes('enter early'), 'stilul nu trebuie sa mentioneze "enter early" — ar deveni redundant cu vocalsEarlyClause');
});

test('7b) In cel mai usor scenariu (nume scurte, engleza, fara feedback), promptul final NU repeta ideea "vocea intra devreme" de doua ori', () => {
  const lightOrder = { occasion: 'zi_de_nastere', genre: 'manele_jale', lang: 'en', plan: 'standard', recipient: 'Ann', senderName: 'Sam', relationship: 'friend', voicePreference: 'auto', story: 'We met at work.' };
  const prompt = buildPrompt(lightOrder, '', undefined);
  const earlyVocalsMentions = (prompt.match(/early vocals/gi) || []).length + (prompt.match(/vocals enter early/gi) || []).length;
  assert.ok(earlyVocalsMentions <= 1, `promptul nu trebuie sa mentioneze ideea de "vocals early" de mai multe ori — gasit de ${earlyVocalsMentions} ori`);
});

test('7c) Intr-un scenariu cu buget suficient (comanda minimala, fara expeditor numit), clauza oportunista "Vocals enter early." CONTINUA sa fie adaugata pentru manele_jale prin mecanismul existent (vocalsEarlyClause), neschimbat', () => {
  // Comanda "usoara" folosita la testul 7b (nume scurte) tot nu lasa loc simultan pentru
  // "Target song length" SI "Vocals enter early." la acest style (130 caractere, +7 fata de
  // varianta din runda 1) — un fapt masurat, nu o eroare a mecanismului. Aici demonstram STRICT
  // ca mecanismul insusi (vocalsEarlyClause) ramane functional pentru manele_jale, cu o comanda
  // minimala unde bugetul chiar permite ambele clauze oportuniste simultan.
  const minimalOrder = { occasion: 'altceva', genre: 'manele_jale', lang: 'en', plan: 'standard', recipient: 'Al', senderName: '', senderRole: null, recipientRole: null, recipientMode: 'single', relationship: '', voicePreference: 'auto', story: 'Hi.' };
  const prompt = buildPrompt(minimalOrder, '', undefined);
  assert.ok(prompt.includes('Vocals enter early.'), 'clauza oportunista trebuie sa continue sa se adauge automat pentru manele_jale, exact ca pentru orice alt gen diferit de manele_suflet, cand bugetul permite');
});

test('7d) vocalsEarlyClause (mecanismul deja existent) ramane NESCHIMBAT — se aplica in continuare STRICT genurilor diferite de manele_suflet, inclusiv manele_jale', () => {
  assert.match(server, /const vocalsEarlyClause = \(\(genreOverride \|\| order\.genre\) !== 'manele_suflet'\) \? ' Vocals enter early\.' : '';/);
});

// ===============================================================================================
// TEST 8 — preview-ul pentru manele_jale ramane 50 secunde (EXTENDED_PREVIEW_GENRES neatins).
// ===============================================================================================
test('8) EXTENDED_PREVIEW_GENRES contine in continuare manele_jale (si manele_suflet) — preview 50s, neschimbat', () => {
  assert.match(server, /const EXTENDED_PREVIEW_GENRES = \['manele_suflet', 'manele_jale'\];/);
});

test('8b) resolvePreviewMaxSeconds(\'manele_jale\') ramane STRICT 50 (EXTENDED_PREVIEW_SECONDS), neschimbat', () => {
  function extractFn(source, signature) {
    const idx = source.indexOf(signature);
    assert.ok(idx !== -1);
    let depth = 1, i = idx + signature.length;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) break; }
    }
    return source.slice(idx, i + 1);
  }
  const fn = extractFn(server, 'function resolvePreviewMaxSeconds(genre) {');
  const src = `const EXTENDED_PREVIEW_GENRES = ['manele_suflet', 'manele_jale'];\nconst EXTENDED_PREVIEW_SECONDS = 50;\nconst PREVIEW_SECONDS = 40;\n${fn}\nreturn resolvePreviewMaxSeconds;`;
  const resolvePreviewMaxSeconds = new Function(src)();
  assert.equal(resolvePreviewMaxSeconds('manele_jale'), 50);
  assert.equal(resolvePreviewMaxSeconds('manele_suflet'), 50);
  assert.equal(resolvePreviewMaxSeconds('pop'), 40, 'alte genuri raman STRICT la 40s, neschimbat');
});

// ===============================================================================================
// TEST 9 (SCOPE) — celelalte 21 de genuri (toate NEW_GENRES + LEGACY_ONLY_GENRES in afara de
// manele_jale) raman byte-for-byte neschimbate.
// ===============================================================================================
test('9) toate celelalte genuri din GENRE_STYLE_MAP raman byte-for-byte neschimbate (STRICT manele_jale a fost modificat)', () => {
  const expectedUnchanged = {
    emotional: 'cinematic orchestral ballad, swelling strings and piano, rubato build, breathy vulnerable vocal, tearful climax',
    suflet: 'intimate de suflet ballad, sparse guitar or piano, close warm vocal, quiet confessional unpolished mood',
    acustic: 'unplugged acoustic folk, fingerpicked guitar, light percussion, natural room sound, plain sincere vocal',
    petrecere: 'fast Romanian party beat, 130+bpm, syncopated dance rhythm, horns and synth stabs, shouted chorus, club energy',
    balada: 'slow rubato piano ballad, sustained strings, no beat, dramatic dynamic swells, powerful sustained vocal',
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
    populara: 'Romanian muzica populara, traditional folk ensemble, violin accordion or flute, traditional dance rhythm, folk ornamentation',
    copii: 'cheerful song for children, simple major-key melody, easy sing-along chorus, piano ukulele or bells, bright vocal',
    colind: 'traditional Romanian Christmas carol, warm communal vocal, acoustic instruments, tasteful bells, ceremonial warmth',
    romantic: 'timeless romantic love song, piano or acoustic guitar, optional strings, soft percussion, intimate vocal',
    motivational: 'motivational anthem, builds from moderate to high energy, confident drums, piano or guitar, rising vocal, anthemic chorus'
  };
  for (const [genre, expected] of Object.entries(expectedUnchanged)) {
    assert.equal(GENRE_STYLE_MAP[genre], expected, `GENRE_STYLE_MAP.${genre} nu trebuie atins de aceasta schimbare`);
  }
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
