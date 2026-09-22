// lib/preview-selection.js — Smart Preview: DECIZIE FINALA (2026-09-22, runda 2) — previewul
// incepe STRICT de la PRIMA STROFA (Verse 1) a melodiei, la inceputul primei ei linii efectiv
// cantate — NU mai exista scoring intre Chorus/Pre-Chorus/Verse/energie/personalizare (versiunea
// anterioara alegea prea des refrenul, comportament respins explicit de client). Teste PURE, fara
// retea/ffmpeg/Postgres — acelasi tipar ca test/media-analysis.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  snapToLineStart,
  findFirstVerseSection,
  firstCaptionLineStartInWindow,
  firstRealWordStartInWindow,
  selectPreviewStart
} = require('../lib/preview-selection');
const { deriveSectionTimings } = require('../lib/media-analysis');

// ================================================================================================
// FIXTURE — helpers pentru a construi "melodii" sintetice, deterministice.
// ================================================================================================
function w(word, startS, endS, success = true) {
  return { word, startS, endS, success };
}

// Grupeaza cuvintele intre marcaje de sectiune in linii de cate 4 cuvinte — simulare simpla, dar
// realista, a buildCaptionLines() (server.js), suficienta ca sa testam snap-ul la o linie reala
// fara sa reimplementam logica ei exacta.
function buildCaptionLinesFor(alignedWords) {
  const lines = [];
  let buffer = [];
  let bufStart = null;
  for (const word of alignedWords) {
    if (/^\[.*\]$/.test(word.word)) {
      if (buffer.length) { lines.push({ start: bufStart, end: buffer[buffer.length - 1].endS, text: buffer.map((b) => b.word).join(' ') }); buffer = []; bufStart = null; }
      continue;
    }
    if (bufStart === null) bufStart = word.startS;
    buffer.push(word);
    if (buffer.length >= 4) { lines.push({ start: bufStart, end: word.endS, text: buffer.map((b) => b.word).join(' ') }); buffer = []; bufStart = null; }
  }
  if (buffer.length) lines.push({ start: bufStart, end: buffer[buffer.length - 1].endS, text: buffer.map((b) => b.word).join(' ') });
  return lines;
}

// Melodie STANDARD: [Intro] 0-8 (tacere) -> [Verse] 8-38 (prima strofa, cuvinte reale de la 8.2)
// -> [Chorus] 38-68 -> [Verse] 68-98 (a doua strofa) -> [Outro] 98-108.
function buildStandardSong() {
  const words = [w('[Intro]', 0, 0)];
  words.push(w('[Verse]', 8, 8));
  let t = 8.2;
  for (; t < 38; t += 1) words.push(w('la', t, t + 0.6));
  words.push(w('[Chorus]', 38, 38));
  for (let c = 38.2; c < 68; c += 0.5) words.push(w('na', c, c + 0.3));
  words.push(w('[Verse]', 68, 68));
  for (let v = 68.2; v < 98; v += 1) words.push(w('la', v, v + 0.6));
  words.push(w('[Outro]', 98, 98));
  for (let o = 98.2; o < 108; o += 1) words.push(w('la', o, o + 0.6));
  return words;
}

// Melodie cu CHORUS INAINTE de Verse: [Intro] 0-8 -> [Chorus] 8-38 -> [Verse] 38-68 -> [Outro] 68-78.
function buildChorusFirstSong() {
  const words = [w('[Intro]', 0, 0)];
  words.push(w('[Chorus]', 8, 8));
  for (let c = 8.2; c < 38; c += 0.5) words.push(w('na', c, c + 0.3));
  words.push(w('[Verse]', 38, 38));
  let t = 38.2;
  for (; t < 68; t += 1) words.push(w('la', t, t + 0.6));
  words.push(w('[Outro]', 68, 68));
  for (let o = 68.2; o < 78; o += 1) words.push(w('la', o, o + 0.6));
  return words;
}

// Melodie FARA niciun Verse (doar Chorus/Bridge/Outro) — findFirstVerseSection trebuie sa esueze.
function buildNoVerseSong() {
  const words = [w('[Intro]', 0, 0)];
  words.push(w('[Chorus]', 5, 5));
  for (let c = 5.2; c < 30; c += 0.5) words.push(w('na', c, c + 0.3));
  words.push(w('[Bridge]', 30, 30));
  for (let b = 30.2; b < 50; b += 1) words.push(w('la', b, b + 0.6));
  words.push(w('[Outro]', 50, 50));
  for (let o = 50.2; o < 60; o += 1) words.push(w('la', o, o + 0.6));
  return words;
}

// Melodie FARA marcaje de structura deloc (< 2 marcaje -> deriveSectionTimings cade pe fallback
// 'full_song'/alignmentStatus='fallback') — dar CU cuvinte reale cantate.
function buildUnstructuredSong() {
  const words = [];
  for (let t = 3; t < 40; t += 1) words.push(w('la', t, t + 0.6));
  return words;
}

const DURATION = 110;
const PREVIEW_MAX = 40;

function baseInputs(overrides) {
  const alignedWords = buildStandardSong();
  const captionLines = buildCaptionLinesFor(alignedWords);
  return Object.assign({
    alignedWords,
    captionLines,
    durationSeconds: DURATION,
    previewMaxSeconds: PREVIEW_MAX,
    vocalOnsetStartSeconds: 0
  }, overrides || {});
}

// ================================================================================================
// SELECTIE — PRIMA STROFA
// ================================================================================================
test('Verse 1 disponibil -> previewul incepe din prima strofa (8-38s), NU din refren (38-68s)', () => {
  const result = selectPreviewStart(baseInputs());
  assert.equal(result.selectionReason, 'first_verse');
  assert.ok(result.previewStartSeconds >= 8 && result.previewStartSeconds < 38, `trebuie sa fie in fereastra primei strofe, a ales ${result.previewStartSeconds}s`);
});

test('Chorus apare INAINTE de Verse -> e ignorat complet, previewul tot incepe din Verse', () => {
  const inputs = baseInputs();
  inputs.alignedWords = buildChorusFirstSong();
  inputs.captionLines = buildCaptionLinesFor(inputs.alignedWords);
  const result = selectPreviewStart(inputs);
  assert.equal(result.selectionReason, 'first_verse');
  assert.ok(result.previewStartSeconds >= 38 && result.previewStartSeconds < 68, `nu trebuie sa aleaga refrenul (8-38s), trebuie sa aleaga strofa (38-68s), a ales ${result.previewStartSeconds}s`);
});

test('mai multe Verse-uri -> se alege STRICT primul (8-38s), niciodata al doilea (68-98s)', () => {
  const result = selectPreviewStart(baseInputs());
  assert.ok(result.previewStartSeconds < 68, `nu trebuie sa aleaga a doua strofa, a ales ${result.previewStartSeconds}s`);
});

test('previewStart incepe la inceputul unei linii REALE cantate — valoare exacta, nu aproximata', () => {
  const inputs = baseInputs();
  const result = selectPreviewStart(inputs);
  const matchingLine = inputs.captionLines.find((l) => Math.abs(l.start - result.previewStartSeconds) < 0.001);
  assert.ok(matchingLine, `previewStartSeconds (${result.previewStartSeconds}) trebuie sa coincida EXACT cu inceputul unei linii din captionLines`);
});

test('previewStart NU incepe niciodata mid-word: valoarea returnata coincide cu startS-ul unui cuvant real din alignedWords', () => {
  const inputs = baseInputs();
  const result = selectPreviewStart(inputs);
  const matchingWord = inputs.alignedWords.find((word) => word.success === true && Math.abs(word.startS - result.previewStartSeconds) < 0.001);
  assert.ok(matchingWord, `previewStartSeconds (${result.previewStartSeconds}) trebuie sa coincida cu startS-ul unui cuvant real cantat`);
});

test('previewStart NU incepe la marcajul textual [Verse] insusi (startS=8), ci la primul cuvant cantat DUPA marcaj (startS=8.2)', () => {
  const result = selectPreviewStart(baseInputs());
  assert.ok(Math.abs(result.previewStartSeconds - 8.2) < 0.5, `trebuie sa fie langa 8.2s (primul cuvant real), nu 8s (marcajul), a ales ${result.previewStartSeconds}s`);
});

// ================================================================================================
// FALLBACK — lantul exact cerut: first_verse -> first_vocal_line_fallback -> vocal_onset_fallback
// -> start_zero_fallback
// ================================================================================================
test('fallback 1: lipsa Verse (doar Chorus/Bridge/Outro) -> first_vocal_line_fallback, prima linie cantata din tot cantecul', () => {
  const inputs = baseInputs();
  inputs.alignedWords = buildNoVerseSong();
  inputs.captionLines = buildCaptionLinesFor(inputs.alignedWords);
  const result = selectPreviewStart(inputs);
  assert.equal(result.selectionReason, 'first_vocal_line_fallback');
  assert.ok(Math.abs(result.previewStartSeconds - 5.2) < 0.5, `trebuie sa fie prima linie reala cantata (~5.2s), a ales ${result.previewStartSeconds}s`);
});

test('fallback 2: lipsa oricarui marcaj de structura (sectiuni in fallback) -> first_vocal_line_fallback, prima linie reala', () => {
  const inputs = baseInputs();
  inputs.alignedWords = buildUnstructuredSong();
  inputs.captionLines = buildCaptionLinesFor(inputs.alignedWords);
  const sections = deriveSectionTimings(inputs.alignedWords, inputs.durationSeconds, null);
  assert.equal(sections[0].alignmentStatus, 'fallback', 'fixture-ul trebuie sa produca sectiuni fallback, ca sa testeze cazul real');
  const result = selectPreviewStart(inputs);
  assert.equal(result.selectionReason, 'first_vocal_line_fallback');
  assert.ok(Math.abs(result.previewStartSeconds - 3) < 0.5, `trebuie sa fie primul cuvant real (~3s), a ales ${result.previewStartSeconds}s`);
});

test('fallback 3: alignedWords LIPSA (undefined) -> vocal_onset_fallback, foloseste vocalOnsetStartSeconds', () => {
  const inputs = baseInputs({ alignedWords: undefined, vocalOnsetStartSeconds: 12.5 });
  const result = selectPreviewStart(inputs);
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 12.5);
});

test('fallback 3b: alignedWords GOL ([]) -> vocal_onset_fallback', () => {
  const inputs = baseInputs({ alignedWords: [], vocalOnsetStartSeconds: 7 });
  const result = selectPreviewStart(inputs);
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 7);
});

test('fallback 3c: durationSeconds invalid -> vocal_onset_fallback', () => {
  const result = selectPreviewStart(baseInputs({ durationSeconds: NaN, vocalOnsetStartSeconds: 4 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 4);
});

test('fallback 4: vocal-onset INDISPONIBIL (null/NaN) -> start_zero_fallback, previewStart = 0, indiferent de restul datelor', () => {
  for (const bad of [null, undefined, NaN, 'x']) {
    const result = selectPreviewStart(baseInputs({ vocalOnsetStartSeconds: bad }));
    assert.equal(result.selectionReason, 'start_zero_fallback');
    assert.equal(result.previewStartSeconds, 0);
  }
});

test('selectPreviewStart NICIODATA nu arunca, indiferent de input (fuzz minimal cu forme neasteptate)', () => {
  const weird = [
    {},
    { alignedWords: 'nu-e-array' },
    { alignedWords: [null, {}, { word: 5 }], vocalOnsetStartSeconds: 3, durationSeconds: 100, previewMaxSeconds: 40 },
    { alignedWords: [], captionLines: 'nu-e-array', vocalOnsetStartSeconds: 3, durationSeconds: 100, previewMaxSeconds: 40 }
  ];
  for (const input of weird) {
    assert.doesNotThrow(() => selectPreviewStart(input));
  }
});

test('selectPreviewStart e determinist — acelasi input produce STRICT acelasi rezultat', () => {
  const inputs = baseInputs();
  const r1 = selectPreviewStart(inputs);
  const r2 = selectPreviewStart(inputs);
  assert.deepEqual(r1, r2);
});

// ================================================================================================
// DURATA — clamp aproape de finalul piesei, tot reancorat la o linie reala
// ================================================================================================
test('strofa foarte aproape de finalul piesei -> previewStart e clampat sa incapa in durationSeconds, dar tot pe o granita reala de linie', () => {
  const alignedWords = buildStandardSong(); // a doua strofa: 68.2-98s, piesa dureaza 110s
  const captionLines = buildCaptionLinesFor(alignedWords);
  // fortam findFirstVerseSection sa gaseasca STRICT a doua "strofa" facand-o singura, ca sa
  // testam clamp-ul aproape de capat: durata redusa la 100s (previewMax 40s -> maxStart = 60s),
  // deci un candidat brut la 68.2s trebuie clampat la 60s si reancorat la o linie reala <= 60s.
  const inputs = { alignedWords, captionLines, durationSeconds: 100, previewMaxSeconds: 40, vocalOnsetStartSeconds: 0 };
  const result = selectPreviewStart(inputs);
  assert.ok(result.previewStartSeconds <= 60 + 0.001, `previewStart nu trebuie sa depaseasca maxStart (60s), a ales ${result.previewStartSeconds}s`);
  const matchingLine = captionLines.find((l) => Math.abs(l.start - result.previewStartSeconds) < 0.001);
  assert.ok(matchingLine, 'chiar si dupa clamp, previewStart trebuie sa coincida cu inceputul unei linii reale');
});

// ================================================================================================
// HELPERS PURE — testate direct
// ================================================================================================
test('findFirstVerseSection: gaseste STRICT primul verse ALIGNED, ignora chorus/bridge/intro/outro', () => {
  const sections = deriveSectionTimings(buildStandardSong(), DURATION, null);
  const verse = findFirstVerseSection(sections);
  assert.ok(verse);
  assert.equal(verse.sectionType, 'verse');
  assert.equal(verse.startTime, 8);
});

test('findFirstVerseSection: fara niciun verse -> null', () => {
  const sections = deriveSectionTimings(buildNoVerseSong(), 60, null);
  assert.equal(findFirstVerseSection(sections), null);
});

test('findFirstVerseSection: sectiuni fallback (alignmentStatus="fallback") -> null, niciodata acceptat ca "verse" real', () => {
  const sections = deriveSectionTimings(buildUnstructuredSong(), 40, null);
  assert.equal(findFirstVerseSection(sections), null);
});

test('firstCaptionLineStartInWindow: gaseste prima linie cu start in fereastra, respecta limita superioara', () => {
  const lines = [{ start: 5, end: 8 }, { start: 10, end: 13 }, { start: 40, end: 43 }];
  assert.equal(firstCaptionLineStartInWindow(lines, 6, 41), 10);
  assert.equal(firstCaptionLineStartInWindow(lines, 0, null), 5);
  assert.equal(firstCaptionLineStartInWindow(lines, 41, null), null);
});

test('firstRealWordStartInWindow: ignora cuvintele success=false si pe cele in afara ferestrei', () => {
  const words = [w('a', 1, 1.5, false), w('b', 2, 2.5, true), w('c', 10, 10.5, true)];
  assert.equal(firstRealWordStartInWindow(words, 0, 5), 2);
  assert.equal(firstRealWordStartInWindow(words, 0, null), 2);
  assert.equal(firstRealWordStartInWindow(words, 5, null), 10);
});

test('snapToLineStart: muta la cea mai apropiata linie reala, in limita tolerantei', () => {
  const lines = [{ start: 10 }, { start: 20 }];
  assert.equal(snapToLineStart(10.5, lines, 100), 10);
  assert.equal(snapToLineStart(50, lines, 100), 50, 'fara nicio linie in toleranta, pastreaza punctul brut');
});

test('snapToLineStart: fara linii disponibile -> ramane punctul brut, fara eroare', () => {
  assert.equal(snapToLineStart(15, [], 100), 15);
  assert.equal(snapToLineStart(15, null, 100), 15);
});
