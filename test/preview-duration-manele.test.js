// DURATA PREVIEW — reincarcata din nou (2026-09-22, runda 2, SMART PREVIEW "PRIMA STROFA",
// cerinta explicita a clientului: scoring-ul vechi alegea prea des refrenul, respins). Acest
// fisier verifica acum: (1) durata uniforma de 40s pentru toate genurile (neschimbata fata de
// runda 1); (2) previewStart e calculat prin Smart Preview (lib/preview-selection.js), NU printr-un
// apel direct la getPreviewStartFromLyrics() din buildVariantFromTrack; (3) trimAudio() ramane
// structural corect (fara loop/padding), cu fade-in SI fade-out (neschimbate fata de runda 1);
// (4) buildVariantFromTrack a revenit la semnatura SIMPLA (orderId, variantId, track, taskId) —
// parametrii recipient/story/lang, adaugati in runda 1 STRICT pentru scoring-ul de personalizare,
// au fost eliminati odata cu acel scoring (nu mai sunt folositi de nimic in interiorul functiei).
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

test('buildVariantFromTrack: semnatura SIMPLA (orderId, variantId, track, taskId) — recipient/story/lang eliminate odata cu scoring-ul de personalizare (runda 2)', () => {
  const idx = server.indexOf('async function buildVariantFromTrack(');
  assert.ok(idx !== -1);
  const signatureLine = server.slice(idx, server.indexOf('{', idx));
  assert.match(signatureLine, /async function buildVariantFromTrack\(orderId, variantId, track, taskId\)/);
});

test('buildVariantFromTrack: trimAudio() e apelat cu PREVIEW_SECONDS (constanta fixa, 40) — nicio variabila de durata dependenta de gen', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.match(fn, /trimAudio\(tempFull, tempPreview, PREVIEW_SECONDS, previewDecision\.previewStartSeconds\)/);
});

test('buildVariantFromTrack: previewStart provine din selectPreviewStart() (Smart Preview — prima strofa), niciodata direct din getPreviewStartFromLyrics()', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.match(fn, /selectPreviewStart\(\{/);
  assert.ok(!fn.includes('getPreviewStartFromLyrics('), 'apelul vechi, direct, nu mai trebuie sa existe in buildVariantFromTrack');
});

test('buildVariantFromTrack: apelul catre selectPreviewStart() NU mai transmite onsets/recipient/story/lang (scoring-ul de personalizare/energie a fost eliminat complet, runda 2)', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  const callIdx = fn.indexOf('selectPreviewStart({');
  assert.ok(callIdx !== -1);
  const callEnd = fn.indexOf('});', callIdx);
  const call = fn.slice(callIdx, callEnd);
  assert.match(call, /alignedWords/);
  assert.match(call, /captionLines/);
  assert.match(call, /durationSeconds/);
  assert.match(call, /previewMaxSeconds: PREVIEW_SECONDS/);
  assert.match(call, /vocalOnsetStartSeconds/);
  for (const removed of ['onsets', 'recipient', 'story', 'lang']) {
    assert.ok(!call.includes(removed), `apelul catre selectPreviewStart nu mai trebuie sa transmita "${removed}"`);
  }
});

test('buildVariantFromTrack: NU mai apeleaza extractAudioOnsets() (analiza de energie audio pre-plata, folosita STRICT de scoring-ul vechi, eliminata — cerinta explicita, "nu vreau consum CPU inutil")', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.ok(!fn.includes('extractAudioOnsets('), 'extractAudioOnsets nu mai trebuie apelata in buildVariantFromTrack (pre-plata)');
});

test('extractAudioOnsets() ramane NEATINSA si continua sa fie folosita post-plata pentru pachetul Video (buildShotPlan) — eliminarea din Smart Preview nu trebuie sa strice pipeline-ul video', () => {
  const idx = server.indexOf('async function extractAudioOnsets(audioFilePath, orderId) {');
  assert.ok(idx !== -1, 'functia trebuie sa existe neschimbata');
  const otherCallers = (server.match(/extractAudioOnsets\(/g) || []).length;
  // exact 2 aparitii: definitia functiei insasi + STRICT un singur apelant ramas (pipeline-ul video)
  assert.equal(otherCallers, 2, `extractAudioOnsets trebuie apelata dintr-un SINGUR loc (video), gasit ${otherCallers} aparitii totale`);
});

test('buildVariantFromTrack: STRICT UN SINGUR apel de retea catre timestamped-lyrics (fetchAlignedWordsForSmartPreview), nu doua', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  const matches = fn.match(/fetchTimestampedLyricsOnce\(|fetchAlignedWordsForSmartPreview\(|getPreviewStartFromLyrics\(/g) || [];
  assert.equal(matches.length, 1, `trebuie sa existe STRICT un singur apel de fetch de date temporale in buildVariantFromTrack, gasit: ${JSON.stringify(matches)}`);
});

test('getPreviewStartFromLyrics() (functia insasi) ramane byte-identica — implementarea vocal-onset nu a fost modificata, doar orchestrarea apelului s-a mutat', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.match(fn, /findFirstRealWordStartS\(words\)/);
  assert.match(fn, /firstRealStartS - TARGET_VOICE_POSITION_S/);
  assert.match(fn, /Math\.min\(previewStart, PREVIEW_START_MAX_S\)/);
});

test('computeVocalOnsetPreviewStart() (folosita de Smart Preview ca fallback) foloseste ACEEASI formula (findFirstRealWordStartS + TARGET_VOICE_POSITION_S/PREVIEW_START_MAX_S)', () => {
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

test('trimAudio() pastreaza fade-in-ul existent SI fade-out-ul (neschimbate fata de runda 1 — aceasta runda nu atinge trimAudio())', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.match(fn, /afade=t=in:st=0:d=0\.015/, 'fade-in-ul existent trebuie pastrat neschimbat');
  assert.match(fn, /afade=t=out:st=\$\{fadeOutStart\.toFixed\(3\)\}:d=\$\{FADE_OUT_SECONDS\}/, 'fade-out-ul (runda 1) trebuie pastrat neschimbat');
  assert.match(server, /const FADE_OUT_SECONDS = 0\.6;/);
});

test('fade-out ramane conservator — sub 2 secunde (nu consuma o parte semnificativa din fereastra de 40s)', () => {
  const m = server.match(/const FADE_OUT_SECONDS = ([\d.]+);/);
  assert.ok(m);
  assert.ok(Number(m[1]) > 0 && Number(m[1]) < 2, `FADE_OUT_SECONDS trebuie sa fie conservator, gasit ${m[1]}`);
});

test('apelul catre buildVariantFromTrack (din attempt(), in interiorul obtainAcceptableVariant) foloseste semnatura SIMPLA — effectiveOrderForPreview (runda 1) a fost eliminat, nu mai e nimic de calculat pentru fiecare varianta Premium', () => {
  const fn = extractFn(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.match(fn, /buildVariantFromTrack\(orderId, randomUUID\(\)\.slice\(0, 8\), track, candidateTaskId\)/);
  assert.ok(!fn.includes('effectiveOrderForPreview'), 'effectiveOrderForPreview (runda 1, STRICT pentru scoring-ul de personalizare) nu mai trebuie sa existe');
});

test('nicio alta constanta/logica de preview NEATINSA de aceasta cerinta (VIDEO_PREVIEW_SECONDS, pretul pachetelor, PLAN_PRICES)', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});
