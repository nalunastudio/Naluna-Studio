// lib/preview-selection.js — Smart Preview: DECIZIE FINALA (2026-09-22, runda 3, dupa test audio
// real in productie) — previewul incepe STRICT cu ~2 secunde de context muzical inainte de PRIMUL
// CUVANT REAL CANTAT (nu la inceputul sectiunii Verse — runda 2, respinsa: a produs ~30s de
// instrumental intr-un test real, deoarece timestamp-ul unei sectiuni structurale nu garanteaza
// unde incepe efectiv vocea). Teste PURE, fara retea/ffmpeg/Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { VOCAL_LEAD_IN_SECONDS, findFirstRealVocalStart, selectPreviewStart } = require('../lib/preview-selection');

function w(word, startS, success = true) {
  return { word, startS, success };
}

const DURATION = 200;
const PREVIEW_MAX = 40;

function baseInputs(overrides) {
  return Object.assign({
    alignedWords: [w('[Intro]', 0), w('[Verse]', 5), w('Hello', 30), w('world', 30.6)],
    durationSeconds: DURATION,
    previewMaxSeconds: PREVIEW_MAX,
    vocalOnsetStartSeconds: 0
  }, overrides || {});
}

// ================================================================================================
// CONSTANTA — lead-in de 2 secunde, cerinta explicita ("aproximativ 1-2 secunde"), NICIODATA 9s.
// ================================================================================================
test('VOCAL_LEAD_IN_SECONDS = 2 — NICIODATA 9 (vechea formula, prea lunga pentru scopul comercial al preview-ului)', () => {
  assert.equal(VOCAL_LEAD_IN_SECONDS, 2);
});

// ================================================================================================
// FORMULA — firstRealVocalStart -> previewStart = max(0, firstRealVocalStart - 2)
// ================================================================================================
test('firstRealVocalStart = 30 -> previewStart = 28', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [w('[Verse]', 5), w('Hello', 30)] }));
  assert.equal(result.selectionReason, 'first_vocal_word');
  assert.equal(result.previewStartSeconds, 28);
});

test('firstRealVocalStart = 10 -> previewStart = 8', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [w('Hello', 10)] }));
  assert.equal(result.previewStartSeconds, 8);
});

test('firstRealVocalStart = 1 -> previewStart = 0 (max(0, 1-2) = 0, niciodata negativ)', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [w('Hello', 1)] }));
  assert.equal(result.previewStartSeconds, 0);
});

test('firstRealVocalStart = 0 -> previewStart = 0', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [w('Hello', 0)] }));
  assert.equal(result.previewStartSeconds, 0);
});

test('firstRealVocalStart = 2 -> previewStart = 0 (exact la limita)', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [w('Hello', 2)] }));
  assert.equal(result.previewStartSeconds, 0);
});

// ================================================================================================
// MARCAJ [Verse] STRUCTURAL — nu mai e folosit ca ancora. Vocea reala la 30s trebuie sa produca
// previewStart=28, NU 0/5 (fosta ancora pe sectiune, runda 2, respinsa).
// ================================================================================================
test('marker [Verse] la 5s, voce reala la 30s -> previewStart = 28, NU 0 sau 5 (nu se mai ancoreaza pe sectiune)', () => {
  const alignedWords = [w('[Intro]', 0), w('[Verse]', 5), w('Prima', 30), w('linie', 30.5)];
  const result = selectPreviewStart(baseInputs({ alignedWords }));
  assert.equal(result.previewStartSeconds, 28);
  assert.notEqual(result.previewStartSeconds, 0);
  assert.notEqual(result.previewStartSeconds, 5);
});

test('marker [Chorus] inainte de voce -> irelevant, complet ignorat (nu exista nicio logica de sectiune in acest modul)', () => {
  const alignedWords = [w('[Intro]', 0), w('[Chorus]', 3), w('[Verse]', 5), w('Prima', 30)];
  const result = selectPreviewStart(baseInputs({ alignedWords }));
  assert.equal(result.previewStartSeconds, 28);
});

test('alignedWords cu markere structurale multiple ([Intro]/[Verse]/[Chorus]/[Bridge]/[Strofa]/[Refren]) — toate ignorate, STRICT primul cuvant real gaseste vocea', () => {
  const alignedWords = [
    w('[Intro]', 0), w('[Strofa]', 2), w('[Verse]', 4), w('[Chorus]', 6),
    w('[Refren]', 8), w('[Bridge]', 9), w('Vocea', 12), w('reala', 12.4)
  ];
  const result = selectPreviewStart(baseInputs({ alignedWords }));
  assert.equal(result.previewStartSeconds, 10); // 12 - 2
});

// ================================================================================================
// success:false — ignorat complet, STRICT primul success:true real e folosit.
// ================================================================================================
test('cuvinte cu success:false sunt ignorate — STRICT primul success:true e folosit', () => {
  const alignedWords = [w('fals1', 1, false), w('fals2', 3, false), w('real', 20, true), w('altul', 25, false)];
  const result = selectPreviewStart(baseInputs({ alignedWords }));
  assert.equal(result.previewStartSeconds, 18); // 20 - 2
});

test('findFirstRealVocalStart: ignora success:false, gaseste primul success:true', () => {
  const alignedWords = [w('a', 1, false), w('b', 5, true), w('c', 10, true)];
  assert.equal(findFirstRealVocalStart(alignedWords), 5);
});

test('findFirstRealVocalStart: cuvant care e STRICT un marcaj structural (fara text real ramas dupa strip) e ignorat, chiar daca success:true', () => {
  const alignedWords = [w('[Verse]', 5, true), w('Real', 20, true)];
  assert.equal(findFirstRealVocalStart(alignedWords), 20);
});

test('findFirstRealVocalStart: fara niciun cuvant real -> null', () => {
  assert.equal(findFirstRealVocalStart([w('[Intro]', 0, true), w('[Verse]', 5, true)]), null);
  assert.equal(findFirstRealVocalStart([]), null);
  assert.equal(findFirstRealVocalStart(null), null);
});

// ================================================================================================
// FALLBACK — lantul exact cerut: first_vocal_word -> vocal_onset_fallback -> start_zero_fallback
// ================================================================================================
test('fallback B: lipsa alignedWords (undefined) -> vocal_onset_fallback, foloseste vocalOnsetStartSeconds', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: undefined, vocalOnsetStartSeconds: 12.5 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 12.5);
});

test('fallback B: alignedWords GOL ([]) -> vocal_onset_fallback', () => {
  const result = selectPreviewStart(baseInputs({ alignedWords: [], vocalOnsetStartSeconds: 7 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 7);
});

test('fallback B: alignedWords prezente dar FARA niciun cuvant real (STRICT marcaje structurale) -> vocal_onset_fallback', () => {
  const alignedWords = [w('[Intro]', 0, true), w('[Verse]', 5, true), w('[Chorus]', 10, false)];
  const result = selectPreviewStart(baseInputs({ alignedWords, vocalOnsetStartSeconds: 3 }));
  assert.equal(result.selectionReason, 'vocal_onset_fallback');
  assert.equal(result.previewStartSeconds, 3);
});

test('fallback C: nicio informatie utila (alignedWords lipsa SI vocal-onset lipsa) -> previewStart = 0', () => {
  for (const bad of [null, undefined, NaN, 'x']) {
    const result = selectPreviewStart(baseInputs({ alignedWords: undefined, vocalOnsetStartSeconds: bad }));
    assert.equal(result.selectionReason, 'start_zero_fallback');
    assert.equal(result.previewStartSeconds, 0);
  }
});

test('durationSeconds invalid -> tot foloseste first_vocal_word (fara clamp la durata, care nu poate fi calculat), previewStart necolapsat', () => {
  const result = selectPreviewStart(baseInputs({ durationSeconds: NaN, alignedWords: [w('Hello', 30)] }));
  assert.equal(result.selectionReason, 'first_vocal_word');
  assert.equal(result.previewStartSeconds, 28);
});

// ================================================================================================
// CLAMP LA DURATA MELODIEI — vocea foarte aproape de finalul piesei, previewul tot trebuie sa
// incapa in durationSeconds.
// ================================================================================================
test('voce foarte aproape de finalul piesei -> previewStart e clampat sa incapa (maxStart = duration - previewMaxSeconds)', () => {
  const result = selectPreviewStart({
    alignedWords: [w('Hello', 195)], durationSeconds: 200, previewMaxSeconds: 40, vocalOnsetStartSeconds: 0
  });
  assert.equal(result.previewStartSeconds, 160); // 200 - 40 = 160, mai mic decat 195-2=193
});

test('voce devreme, departe de finalul piesei -> NU e afectat de clamp', () => {
  const result = selectPreviewStart({
    alignedWords: [w('Hello', 30)], durationSeconds: 200, previewMaxSeconds: 40, vocalOnsetStartSeconds: 0
  });
  assert.equal(result.previewStartSeconds, 28);
});

// ================================================================================================
// ROBUSTETE — niciodata nu arunca, determinist.
// ================================================================================================
test('selectPreviewStart NICIODATA nu arunca, indiferent de input (fuzz minimal cu forme neasteptate)', () => {
  const weird = [
    {},
    { alignedWords: 'nu-e-array' },
    { alignedWords: [null, {}, { word: 5 }], vocalOnsetStartSeconds: 3, durationSeconds: 100, previewMaxSeconds: 40 },
    { alignedWords: [{ word: 'x', startS: 'nu-e-numar', success: true }], vocalOnsetStartSeconds: 3 }
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

test('modulul NU mai depinde de deriveSectionTimings/media-analysis.js (sectiunile structurale nu mai sunt folosite pentru start)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'preview-selection.js'), 'utf8');
  assert.ok(!src.includes("require('./media-analysis')"), 'nu mai trebuie sa existe nicio dependenta de media-analysis.js — singurul indicator real; mentiunile textuale din comentariul de audit sunt permise (documenteaza legitim de ce a fost eliminat)');
  assert.ok(!src.includes('const { deriveSectionTimings }'), 'nu mai trebuie sa existe importul real al functiei');
});
