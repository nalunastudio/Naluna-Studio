// DURATA PREVIEW — reincarcata complet (2026-09-22, SMART PREVIEW, cerinta explicita): fostul
// fisier proteja exceptia EXTENDED_PREVIEW_SECONDS=50 pentru manele_suflet/manele_jale
// (2026-09-19) — eliminata acum intentionat, nu o regresie. Motivul original (intro instrumental
// mai lung la aceste doua genuri, care putea consuma o parte mare din fereastra fixa) e rezolvat
// altfel acum: Smart Preview (lib/preview-selection.js) muta START-ul catre o parte relevanta a
// melodiei, in loc sa mareasca DURATA ferestrei — nu mai e nevoie de nicio exceptie per-gen.
//
// Acest fisier verifica acum: (1) durata uniforma de 40s pentru toate genurile; (2) previewStart
// e calculat prin Smart Preview (lib/preview-selection.js), NU mai printr-un apel direct la
// getPreviewStartFromLyrics() din buildVariantFromTrack (acel apel a fost inlocuit — vezi
// test/preview-selection.test.js pentru acoperirea completa a noii selectii); (3) trimAudio()
// ramane structural corect (fara loop/padding), cu fade-in SI acum fade-out (nou, cerinta
// explicita); (4) apelul catre buildVariantFromTrack transmite datele corecte (recipient/story/
// lang), inclusiv pentru Premium (genre vs genre2, per melodie).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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

test('PREVIEW_SECONDS = 40, unica constanta de durata — nicio exceptie per-gen ramasa', () => {
  assert.match(server, /const PREVIEW_SECONDS = 40;/);
  assert.ok(!/const EXTENDED_PREVIEW_GENRES\s*=/.test(server));
  assert.ok(!/const EXTENDED_PREVIEW_SECONDS\s*=/.test(server));
  assert.ok(!/function resolvePreviewMaxSeconds/.test(server));
});

test('buildVariantFromTrack: semnatura noua (recipient, story, lang in loc de genre) — genre nu mai e parametru, nu mai e folosit pentru durata', () => {
  const idx = server.indexOf('async function buildVariantFromTrack(');
  assert.ok(idx !== -1);
  const signatureLine = server.slice(idx, server.indexOf('{', idx));
  assert.match(signatureLine, /async function buildVariantFromTrack\(orderId, variantId, track, taskId, recipient, story, lang\)/);
});

test('buildVariantFromTrack: trimAudio() e apelat cu PREVIEW_SECONDS (constanta fixa, 40) — nicio variabila de durata dependenta de gen', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, recipient, story, lang) {');
  assert.match(fn, /trimAudio\(tempFull, tempPreview, PREVIEW_SECONDS, previewDecision\.previewStartSeconds\)/);
});

test('buildVariantFromTrack: previewStart provine din selectPreviewStart() (Smart Preview), niciodata direct din getPreviewStartFromLyrics()', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, recipient, story, lang) {');
  assert.match(fn, /selectPreviewStart\(\{/);
  assert.ok(!fn.includes('getPreviewStartFromLyrics('), 'apelul vechi, direct, nu mai trebuie sa existe in buildVariantFromTrack');
});

test('buildVariantFromTrack: STRICT UN SINGUR apel de retea catre timestamped-lyrics (fetchAlignedWordsForSmartPreview), nu doua', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, recipient, story, lang) {');
  const matches = fn.match(/fetchTimestampedLyricsOnce\(|fetchAlignedWordsForSmartPreview\(|getPreviewStartFromLyrics\(/g) || [];
  assert.equal(matches.length, 1, `trebuie sa existe STRICT un singur apel de fetch de date temporale in buildVariantFromTrack, gasit: ${JSON.stringify(matches)}`);
});

test('getPreviewStartFromLyrics() (functia insasi) ramane byte-identica — implementarea vocal-onset nu a fost modificata, doar orchestrarea apelului s-a mutat', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.match(fn, /findFirstRealWordStartS\(words\)/);
  assert.match(fn, /firstRealStartS - TARGET_VOICE_POSITION_S/);
  assert.match(fn, /Math\.min\(previewStart, PREVIEW_START_MAX_S\)/);
});

test('computeVocalOnsetPreviewStart() (noua functie, folosita de Smart Preview) foloseste ACEEASI formula (findFirstRealWordStartS + TARGET_VOICE_POSITION_S/PREVIEW_START_MAX_S)', () => {
  const fn = extractFn(server, 'function computeVocalOnsetPreviewStart(alignedWords) {');
  assert.match(fn, /findFirstRealWordStartS\(alignedWords\)/);
  assert.match(fn, /firstRealStartS - TARGET_VOICE_POSITION_S/);
  assert.match(fn, /Math\.min\(previewStart, PREVIEW_START_MAX_S\)/);
});

test('CRITIC — trimAudio() ramane structural corect: fara loop/concat/padding, STRICT "-t <secunde>" ca durata maxima', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.doesNotMatch(fn, /loop|concat|apad|-stream_loop/i, 'trimAudio nu trebuie sa contina niciun mecanism de extindere/loop/padding artificial');
  assert.match(fn, /'-t', String\(safeSeconds\)/);
});

test('NOU — trimAudio() adauga fade-out scurt la final, pastrand fade-in-ul existent', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.match(fn, /afade=t=in:st=0:d=0\.015/, 'fade-in-ul existent trebuie pastrat neschimbat');
  assert.match(fn, /afade=t=out:st=\$\{fadeOutStart\.toFixed\(3\)\}:d=\$\{FADE_OUT_SECONDS\}/, 'fade-out-ul nou trebuie adaugat');
  assert.match(server, /const FADE_OUT_SECONDS = 0\.6;/);
});

test('fade-out ramane conservator — sub 2 secunde (nu consuma o parte semnificativa din fereastra de 40s)', () => {
  const m = server.match(/const FADE_OUT_SECONDS = ([\d.]+);/);
  assert.ok(m);
  assert.ok(Number(m[1]) > 0 && Number(m[1]) < 2, `FADE_OUT_SECONDS trebuie sa fie conservator, gasit ${m[1]}`);
});

test('apelul catre buildVariantFromTrack (din attempt(), in interiorul obtainAcceptableVariant) transmite recipient/story/lang EFECTIVE (recipientSnapshot suprascrie order, pentru Premium melodia 2)', () => {
  const fn = extractFn(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.match(fn, /const effectiveOrderForPreview = recipientSnapshot \? \{ \.\.\.order, \.\.\.recipientSnapshot \} : order;/);
  assert.match(fn, /buildVariantFromTrack\(orderId, randomUUID\(\)\.slice\(0, 8\), track, candidateTaskId, effectiveOrderForPreview\.recipient, effectiveOrderForPreview\.story, effectiveOrderForPreview\.lang\)/);
});

test('nicio alta constanta/logica de preview NEATINSA de aceasta cerinta (VIDEO_PREVIEW_SECONDS, pretul pachetelor, PLAN_PRICES)', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});
