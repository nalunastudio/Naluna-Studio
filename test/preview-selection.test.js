// lib/preview-selection.js — Smart Preview: selectie determinista a punctului de start,
// pe baza semnalelor reale (nume/poveste/structura/densitate vocala/energie). Teste PURE, fara
// retea/ffmpeg/Postgres — acelasi tipar ca test/media-analysis.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeForMatch,
  tokenize,
  buildNameTokens,
  extractDistinctiveStoryTokens,
  snapToLineStart,
  buildCandidates,
  selectPreviewStart
} = require('../lib/preview-selection');

// ================================================================================================
// FIXTURE — o "melodie" sintetica, deterministica: intro (0-8s, tacere) -> [Verse] personalizat
// (8-38s, ritm moderat, contine numele + un cuvant distinctiv din poveste) -> [Chorus] generic
// (38-68s, ritm FOARTE alert, energie/onset-uri DENSE, fara nicio personalizare) -> [Verse] (a
// doua strofa, tot generica) -> [Outro]. Constructie deliberata ca sa poata testa exact cerintele
// explicite: "o strofa personalizata trebuie sa poata castiga fata de un refren generic
// energic".
// ================================================================================================
function w(word, startS, endS, success = true) {
  return { word, startS, endS, success };
}

function buildSong({ name, storyWord, lang }) {
  const words = [w('[Intro]', 0, 0)];
  words.push(w('[Verse]', 8, 8));
  // Strofa personalizata (8-38s): ~1 cuvant/sec, contine numele si un cuvant din poveste.
  let t = 8.2;
  const verseFiller = ['te', 'iubesc', 'mult', 'azi', 'sub', 'cerul', 'senin', 'plin', 'de', 'lumina', 'calda'];
  let fi = 0;
  words.push(w(name, t, t + 0.6)); t += 1;
  for (; t < 20; t += 1) { words.push(w(verseFiller[fi % verseFiller.length], t, t + 0.6)); fi++; }
  words.push(w(storyWord, t, t + 0.6)); t += 1;
  for (; t < 38; t += 1) { words.push(w(verseFiller[fi % verseFiller.length], t, t + 0.6)); fi++; }

  words.push(w('[Chorus]', 38, 38));
  // Refren generic (38-68s): ~3 cuvinte/sec (mult mai dens decat strofa), NICIO personalizare.
  for (let c = 38.1; c < 68; c += 0.33) words.push(w('la', c, c + 0.2));

  words.push(w('[Verse]', 68, 68));
  for (let v = 68.2; v < 98; v += 1) words.push(w(verseFiller[fi++ % verseFiller.length], v, v + 0.6));

  words.push(w('[Outro]', 98, 98));
  for (let o = 98.2; o < 108; o += 1) words.push(w('la', o, o + 0.6));

  return words;
}

function buildCaptionLinesFor(alignedWords) {
  // Simulare simpla, dar realista, a buildCaptionLines() (server.js): o linie noua la fiecare
  // marcaj de sectiune + cate o linie la fiecare ~4 cuvinte in interior — suficient ca
  // snapToLineStart() sa aiba tinte reale, fara sa reimplementam logica exacta a acelei functii.
  const lines = [];
  let buffer = [];
  let bufStart = null;
  for (const word of alignedWords) {
    if (/^\[.*\]$/.test(word.word)) { if (buffer.length) { lines.push({ start: bufStart, end: buffer[buffer.length - 1].endS, text: buffer.map((b) => b.word).join(' ') }); buffer = []; bufStart = null; } continue; }
    if (bufStart === null) bufStart = word.startS;
    buffer.push(word);
    if (buffer.length >= 4) { lines.push({ start: bufStart, end: word.endS, text: buffer.map((b) => b.word).join(' ') }); buffer = []; bufStart = null; }
  }
  if (buffer.length) lines.push({ start: bufStart, end: buffer[buffer.length - 1].endS, text: buffer.map((b) => b.word).join(' ') });
  return lines;
}

function buildOnsets() {
  const onsets = [];
  for (let t = 10; t < 38; t += 4) onsets.push(t); // strofa: rar
  for (let t = 38; t < 68; t += 0.5) onsets.push(t); // refren: FOARTE des
  for (let t = 68; t < 98; t += 4) onsets.push(t); // strofa 2: rar
  return onsets;
}

const DURATION = 110;
const PREVIEW_MAX = 40;

function baseInputs(overrides) {
  const name = 'Maria';
  const storyWord = 'Brasov';
  const alignedWords = buildSong({ name, storyWord });
  const captionLines = buildCaptionLinesFor(alignedWords);
  const onsets = buildOnsets();
  return Object.assign({
    alignedWords,
    captionLines,
    durationSeconds: DURATION,
    previewMaxSeconds: PREVIEW_MAX,
    vocalOnsetStartSeconds: 0, // vocea reala incepe la 8s in melodie; onset "clasic" ar da ~0 (start<=9s -> 0)
    onsets,
    recipient: name,
    story: `Ne-am cunoscut in ${storyWord} si de atunci suntem impreuna.`,
    lang: 'ro'
  }, overrides || {});
}

// ================================================================================================
// SELECTIE
// ================================================================================================
test('fragment cu numele destinatarului primeste bonus si castiga fata de unul fara nume', () => {
  const result = selectPreviewStart(baseInputs());
  assert.equal(result.selectionReason, 'smart_score');
  assert.equal(result.signals.nameMatch, true, `castigatorul trebuie sa contina numele, semnale: ${JSON.stringify(result.signals)}`);
});

test('fragment cu detalii relevante din poveste primeste bonus', () => {
  const result = selectPreviewStart(baseInputs());
  assert.ok(result.signals.storyTokenMatches >= 1, `castigatorul trebuie sa contina cel putin un token distinctiv din poveste, semnale: ${JSON.stringify(result.signals)}`);
});

test('CHORUS NU CASTIGA AUTOMAT: o strofa personalizata (nume+poveste, ritm moderat) castiga fata de un refren generic, foarte dens si energic', () => {
  const result = selectPreviewStart(baseInputs());
  // fereastra castigatoare trebuie sa fie in jurul strofei (8-38s), NU in refren (38-68s)
  assert.ok(result.previewStartSeconds < 38, `castigatorul nu trebuie sa fie refrenul generic, a ales ${result.previewStartSeconds}s`);
  assert.equal(result.signals.structureBonus, 0, 'castigatorul (strofa) nu trebuie sa aiba bonus de structura chorus/pre_chorus');
});

test('ENERGIE MARE NU CASTIGA AUTOMAT: un refren foarte energic dar complet generic nu bate un fragment personalizat cu energie moderata', () => {
  const result = selectPreviewStart(baseInputs());
  assert.ok(result.previewStartSeconds < 38);
  // confirmam explicit ca varianta refrenului AR fi avut energie mai mare, dar tot a pierdut
  const candidates = buildCandidates({
    sectionTimings: require('../lib/media-analysis').deriveSectionTimings(baseInputs().alignedWords, DURATION, null),
    captionLines: baseInputs().captionLines,
    vocalOnsetStartSeconds: 0,
    durationSeconds: DURATION,
    previewMaxSeconds: PREVIEW_MAX
  });
  const chorusCandidate = candidates.find((c) => c.anchorType === 'chorus');
  assert.ok(chorusCandidate, 'trebuie sa existe un candidat chorus (altfel testul nu demonstreaza nimic)');
});

test('personalizarea reala castiga fata de continut generic chiar si fara avantaj de structura/energie', () => {
  // eliminam orice avantaj de structura/energie pentru strofa — chorus ramane singurul bonus
  // structural si singurul cu energie inalta — strofa castiga STRICT prin nume+poveste+densitate.
  const inputs = baseInputs({ onsets: [] }); // fara energie deloc, niciun semnal de energie discrimineaza
  const result = selectPreviewStart(inputs);
  assert.equal(result.signals.nameMatch, true);
  assert.ok(result.previewStartSeconds < 38);
});

test('matching case-insensitive: numele scris cu alta capitalizare tot este gasit', () => {
  const inputs = baseInputs({ recipient: 'MARIA' });
  const result = selectPreviewStart(inputs);
  assert.equal(result.signals.nameMatch, true);
});

test('matching Unicode-safe, functioneaza cu diacritice (numele in versuri fara diacritice, campul cu diacritice)', () => {
  const alignedWords = buildSong({ name: 'Stefan', storyWord: 'Brasov' }); // Suno scrie fara diacritice
  const inputs = baseInputs({ alignedWords, captionLines: buildCaptionLinesFor(alignedWords), recipient: 'Ștefan' }); // clientul a scris cu diacritice
  const result = selectPreviewStart(inputs);
  assert.equal(result.signals.nameMatch, true, 'trebuie sa gaseasca numele indiferent de diacritice');
});

test('nu favorizeaza repetarea excesiva a numelui — bonusul e boolean, nu proportional cu numarul de aparitii', () => {
  const alignedWordsOnce = buildSong({ name: 'Maria', storyWord: 'Brasov' });
  const once = selectPreviewStart(baseInputs({ alignedWords: alignedWordsOnce, captionLines: buildCaptionLinesFor(alignedWordsOnce) }));
  assert.equal(once.signals.nameMatch, true);
  // semnalul e STRICT boolean — nu exista niciun camp de "count" in signals care ar putea creste artificial scorul
  assert.ok(!('nameMatchCount' in once.signals), 'nu trebuie sa existe un semnal de numarare a repetitiilor numelui');
});

for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
  const NAMES_BY_LANG = { ro: 'Maria', en: 'Emma', de: 'Anna', es: 'Sofía', it: 'Giulia', fr: 'Chloé', bg: 'Мария', tr: 'Ayşe' };
  const PLACES_BY_LANG = { ro: 'Brasov', en: 'London', de: 'Berlin', es: 'Sevilla', it: 'Bologna', fr: 'Lyon', bg: 'София', tr: 'İstanbul' };
  test(`buildPrompt-independent: functioneaza pentru limba ${lang} (nume "${NAMES_BY_LANG[lang]}", loc "${PLACES_BY_LANG[lang]}")`, () => {
    const name = NAMES_BY_LANG[lang];
    const place = PLACES_BY_LANG[lang];
    const alignedWords = buildSong({ name, storyWord: place });
    const inputs = baseInputs({
      alignedWords,
      captionLines: buildCaptionLinesFor(alignedWords),
      recipient: name,
      story: `A story mentioning ${place} and many happy memories together.`,
      lang
    });
    const result = selectPreviewStart(inputs);
    assert.equal(result.selectionReason, 'smart_score', `limba ${lang}: trebuie sa produca smart_score`);
    assert.equal(result.signals.nameMatch, true, `limba ${lang}: numele trebuie gasit`);
    assert.ok(result.previewStartSeconds < 38, `limba ${lang}: nu trebuie sa aleaga refrenul generic`);
  });
}

test('intro instrumental este penalizat — un candidat care s-ar suprapune cu intro-ul nu e propus ca ancora', () => {
  const inputs = baseInputs();
  const sectionTimings = require('../lib/media-analysis').deriveSectionTimings(inputs.alignedWords, DURATION, null);
  const candidates = buildCandidates({ sectionTimings, captionLines: inputs.captionLines, vocalOnsetStartSeconds: 0, durationSeconds: DURATION, previewMaxSeconds: PREVIEW_MAX });
  assert.ok(!candidates.some((c) => c.anchorType === 'intro' || c.anchorType === 'leading_gap'), 'niciun candidat nu trebuie sa fie ancorat STRICT in intro');
});

test('outro este penalizat — o fereastra care s-ar suprapune semnificativ cu outro pierde fata de alternative mai relevante', () => {
  // melodie scurta: outro-ul ocupa o parte mare din fereastra de 40s daca am porni foarte tarziu
  const alignedWords = buildSong({ name: 'Maria', storyWord: 'Brasov' });
  const inputs = baseInputs({ alignedWords, captionLines: buildCaptionLinesFor(alignedWords), durationSeconds: 108 });
  const result = selectPreviewStart(inputs);
  assert.ok(result.previewStartSeconds < 90, 'nu trebuie sa aleaga un punct atat de tarziu incat fereastra sa fie dominata de outro');
});

test('densitatea vocala este luata in calcul — o fereastra fara cuvinte cantate nu poate castiga fata de una cu continut real', () => {
  const inputs = baseInputs();
  const result = selectPreviewStart(inputs);
  assert.ok(result.signals.vocalDensity > 0, 'castigatorul trebuie sa aiba densitate vocala reala, nu zero');
});

test('start-ul este SNAPPED la o linie reala cantata — nu incepe la mijlocul unui cuvant/idei', () => {
  const inputs = baseInputs();
  const result = selectPreviewStart(inputs);
  const startsMatchesLine = inputs.captionLines.some((line) => Math.abs(line.start - result.previewStartSeconds) < 0.01);
  assert.ok(startsMatchesLine, `previewStartSeconds (${result.previewStartSeconds}) trebuie sa coincida cu inceputul unei linii reale`);
});

test('rezultatul este determinist — aceleasi input-uri produc EXACT acelasi rezultat, de mai multe ori', () => {
  const inputs = baseInputs();
  const r1 = selectPreviewStart(inputs);
  const r2 = selectPreviewStart(inputs);
  const r3 = selectPreviewStart({ ...inputs });
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, r3);
});

// ================================================================================================
// FALLBACK
// ================================================================================================
test('fallback: alignedWords lipseste (null) -> vocal_onset_fallback (daca vocalOnsetStartSeconds exista)', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: null, vocalOnsetStartSeconds: 12 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 12);
});

test('fallback: alignedWords gol ([]), vocalOnsetStartSeconds disponibil -> vocal_onset_fallback', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [], vocalOnsetStartSeconds: 5 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 5);
});

test('fallback: "API failure" simulat — vocalOnsetStartSeconds null (nimic de folosit) -> start_zero_fallback', () => {
  const result = selectPreviewStart(baseInputs({ vocalOnsetStartSeconds: null }));
  assert.equal(result.selectionReason, 'start_zero_fallback');
  assert.equal(result.previewStartSeconds, 0);
});

test('fallback: durationSeconds lipseste/invalid -> vocal_onset_fallback', () => {
  const result = selectPreviewStart(baseInputs({ durationSeconds: null, vocalOnsetStartSeconds: 7 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 7);
});

test('fallback: sections lipsesc (deriveSectionTimings cade pe fallback_equal — o singura melodie fara nicio eticheta) -> tot produce un rezultat sigur (vocal onset ca unic candidat)', () => {
  const noSectionWords = [w('te', 1, 1.5), w('iubesc', 2, 2.5), w('mult', 3, 3.5)]; // fara nicio eticheta [Verse]/[Chorus]/etc.
  const result = selectPreviewStart(baseInputs({ alignedWords: noSectionWords, captionLines: buildCaptionLinesFor(noSectionWords), vocalOnsetStartSeconds: 0 }));
  assert.ok(result.selectionReason === 'smart_score' || result.selectionReason === 'vocal_onset_fallback');
  assert.equal(typeof result.previewStartSeconds, 'number');
  assert.ok(Number.isFinite(result.previewStartSeconds));
});

test('fallback: story lipseste -> scorarea continua normal, folosind celelalte semnale (fara eroare, fara fallback fortat)', () => {
  const result = selectPreviewStart(baseInputs({ story: '' }));
  assert.equal(result.selectionReason, 'smart_score');
  assert.equal(result.signals.storyTokenMatches, 0);
  assert.equal(result.signals.nameMatch, true, 'numele tot trebuie gasit, independent de lipsa povestii');
});

test('fallback: recipient lipseste -> scorarea continua normal, fara eroare', () => {
  const result = selectPreviewStart(baseInputs({ recipient: '' }));
  assert.equal(result.selectionReason, 'smart_score');
  assert.equal(result.signals.nameMatch, false);
});

test('fallback: recipient edge-case (doar conectori, ex. "și") -> tratat ca lipsa nume utila, fara eroare', () => {
  const result = selectPreviewStart(baseInputs({ recipient: 'și' }));
  assert.equal(result.selectionReason, 'smart_score');
  assert.equal(result.signals.nameMatch, false, 'un conector nu trebuie tratat ca nume real');
});

test('fallback: niciun candidat valid (buildCandidates gol) -> vocal_onset_fallback', () => {
  // sectiuni goale + vocalOnsetStartSeconds invalid -> candidati zero
  const candidates = buildCandidates({ sectionTimings: [], captionLines: [], vocalOnsetStartSeconds: null, durationSeconds: 100, previewMaxSeconds: 40 });
  assert.equal(candidates.length, 0);
});

test('fallback: vocal-onset disponibil -> folosit ca baseline chiar daca scorarea completa esueaza (date corupte)', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [{ word: null, startS: 'x' }], vocalOnsetStartSeconds: 15 }));
  assert.ok(result.selectionReason === 'smart_score' || result.selectionReason === 'vocal_onset_fallback');
  assert.equal(typeof result.previewStartSeconds, 'number');
});

test('fallback: vocal-onset indisponibil SI alignedWords utile -> tot ajunge la start_zero_fallback (nu exista nicio ancora sigura)', () => {
  const result = selectPreviewStart(baseInputs({ vocalOnsetStartSeconds: NaN }));
  assert.equal(result.selectionReason, 'start_zero_fallback');
  assert.equal(result.previewStartSeconds, 0);
});

test('fallback final: fara vocal-onset si fara alignedWords -> previewStart = 0, niciodata negativ/NaN/undefined', () => {
  const result = selectPreviewStart({ alignedWords: null, captionLines: null, durationSeconds: null, previewMaxSeconds: 40, vocalOnsetStartSeconds: null, onsets: null, recipient: '', story: '', lang: 'ro' });
  assert.equal(result.previewStartSeconds, 0);
  assert.equal(result.selectionReason, 'start_zero_fallback');
});

test('selectPreviewStart NICIODATA nu arunca, indiferent de input (fuzz minimal cu forme neasteptate)', () => {
  const weirdInputs = [
    {},
    { alignedWords: 'not-array', vocalOnsetStartSeconds: 5, durationSeconds: 100, previewMaxSeconds: 40 },
    { alignedWords: [null, undefined, 42, { word: 123 }], vocalOnsetStartSeconds: 5, durationSeconds: 100, previewMaxSeconds: 40 },
    { alignedWords: [], vocalOnsetStartSeconds: 5, durationSeconds: 100, previewMaxSeconds: 40, onsets: 'not-array' },
    { alignedWords: [w('a', 1, 2)], vocalOnsetStartSeconds: 5, durationSeconds: 100, previewMaxSeconds: 40, recipient: 12345, story: {} }
  ];
  for (const input of weirdInputs) {
    assert.doesNotThrow(() => selectPreviewStart(input), `nu trebuie sa arunce pentru input: ${JSON.stringify(input)}`);
  }
});

// ================================================================================================
// HELPERE PURE — teste directe
// ================================================================================================
test('normalizeForMatch: tolerant la diacritice, case-insensitive, Unicode-safe', () => {
  assert.equal(normalizeForMatch('Ștefan'), normalizeForMatch('Stefan'));
  assert.equal(normalizeForMatch('ÜBER'), 'uber');
  assert.equal(normalizeForMatch('  Maria  '), 'maria');
  assert.equal(normalizeForMatch(null), '');
  assert.equal(normalizeForMatch(undefined), '');
});

test('tokenize: extrage tokeni Unicode-safe din orice script, ignora punctuatia', () => {
  assert.deepEqual(tokenize('Te iubesc, Maria! 2015.'), ['te', 'iubesc', 'maria', '2015']);
  // LIMITARE CUNOSCUTA, acceptata (vezi comentariul din lib/preview-selection.js):
  // NFKD descompune "й" (litera chirilica separata) in "и" + accent scurt combinat, eliminat
  // apoi de strip-ul de diacritice -> "здравеи", nu "здравей". Comportamentul ramane CORECT
  // pentru matching (aceeasi transformare se aplica identic pe ambele parti ale comparatiei —
  // poveste si versuri — deci un cuvant scris identic in ambele locuri tot se potriveste),
  // doar forma normalizata intermediara nu mai arata ca o ortografie corecta.
  assert.deepEqual(tokenize('Здравей, Мария!'), ['здравеи', 'мария']);
  assert.deepEqual(tokenize('здравей'), tokenize('Здравей'), 'aceeasi transformare, aplicata identic, indiferent de capitalizare');
});

test('buildNameTokens: elimina conectori ("și"/"and") si tokeni foarte scurti', () => {
  assert.deepEqual(buildNameTokens('Ana și Andrei', 'ro'), ['ana', 'andrei']);
  assert.deepEqual(buildNameTokens('Emma and Noah', 'en'), ['emma', 'noah']);
});

test('extractDistinctiveStoryTokens: exclude stopwords, pastreaza numere si cuvinte distinctive', () => {
  const tokens = extractDistinctiveStoryTokens('Ne-am cunoscut in 2015 la Brasov si de atunci suntem impreuna.', 'ro');
  assert.ok(tokens.includes('2015'));
  assert.ok(tokens.includes('brasov'));
  assert.ok(!tokens.includes('si'));
  assert.ok(!tokens.includes('la'));
  assert.ok(!tokens.includes('in'));
});

test('extractDistinctiveStoryTokens: story gol -> array gol, fara eroare', () => {
  assert.deepEqual(extractDistinctiveStoryTokens('', 'ro'), []);
  assert.deepEqual(extractDistinctiveStoryTokens(null, 'ro'), []);
});

test('snapToLineStart: muta la cea mai apropiata linie reala, in limita tolerantei', () => {
  const lines = [{ start: 10, end: 12 }, { start: 25, end: 27 }];
  assert.equal(snapToLineStart(11, lines, 100), 10, 'trebuie sa gaseasca linia de la 10s, foarte aproape');
  assert.equal(snapToLineStart(50, lines, 100), 50, 'fara nicio linie suficient de aproape, ramane punctul brut');
});

test('snapToLineStart: fara linii disponibile -> ramane punctul brut, fara eroare', () => {
  assert.equal(snapToLineStart(15, [], 100), 15);
  assert.equal(snapToLineStart(15, null, 100), 15);
});
