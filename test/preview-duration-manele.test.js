// DURATA PREVIEW — reincarcata din nou (2026-09-22, runda 4, SMART PREVIEW "O SINGURA CONSTANTA
// DE LEAD-IN", cerinta explicita: "nu mai vreau NICAIERI regula -9 secunde pentru preview"). Acest
// fisier verifica acum: (1) durata uniforma de 40s pentru toate genurile (neschimbata fata de
// rundele anterioare); (2) previewStart e calculat prin Smart Preview (lib/preview-selection.js —
// scaneaza direct alignedWords pentru primul cuvant real cantat, fara nicio notiune de
// sectiune/linie), NU printr-un apel direct la getPreviewStartFromLyrics() din buildVariantFromTrack;
// (3) trimAudio() ramane structural corect (fara loop/padding), cu fade-in SI fade-out (neschimbate
// fata de rundele anterioare); (4) buildVariantFromTrack are semnatura SIMPLA (orderId, variantId,
// track, taskId) — neschimbata din runda 2; (5) apelul catre selectPreviewStart() nu mai transmite
// captionLines (runda 2, nu mai e nevoie de linii de caption — scanarea e directa pe alignedWords);
// (6) RUNDA 4: computeVocalOnsetPreviewStart() (formula -9s/cap25s) a fost STEARSA din server.js —
// buildVariantFromTrack foloseste acum findFirstRealWordStartS() DIRECT, BRUT, fara nicio ajustare
// — lead-in-ul de 2 secunde se aplica STRICT in lib/preview-selection.js, identic pentru fallback-ul
// A (first_vocal_word) si B (vocal_onset_fallback). getPreviewStartFromLyrics() (formula -9s
// originala) ramane in cod, dar confirmat FARA niciun apelant real — cod complet inert.
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

test('buildVariantFromTrack: semnatura SIMPLA (orderId, variantId, track, taskId)', () => {
  const idx = server.indexOf('async function buildVariantFromTrack(');
  assert.ok(idx !== -1);
  const signatureLine = server.slice(idx, server.indexOf('{', idx));
  assert.match(signatureLine, /async function buildVariantFromTrack\(orderId, variantId, track, taskId\)/);
});

test('buildVariantFromTrack: trimAudio() e apelat cu PREVIEW_SECONDS (constanta fixa, 40) — nicio variabila de durata dependenta de gen', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.match(fn, /trimAudio\(tempFull, tempPreview, PREVIEW_SECONDS, previewDecision\.previewStartSeconds\)/);
});

test('buildVariantFromTrack: previewStart provine din selectPreviewStart() (Smart Preview), niciodata direct din getPreviewStartFromLyrics()', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.match(fn, /selectPreviewStart\(\{/);
  assert.ok(!fn.includes('getPreviewStartFromLyrics('), 'apelul vechi, direct, nu mai trebuie sa existe in buildVariantFromTrack');
});

test('buildVariantFromTrack: apelul catre selectPreviewStart() transmite STRICT alignedWords/durationSeconds/previewMaxSeconds/vocalOnsetStartSeconds — NU captionLines (runda 2), NU onsets/recipient/story/lang (runda 1)', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  const callIdx = fn.indexOf('selectPreviewStart({');
  assert.ok(callIdx !== -1);
  const callEnd = fn.indexOf('});', callIdx);
  const call = fn.slice(callIdx, callEnd);
  assert.match(call, /alignedWords/);
  assert.match(call, /durationSeconds/);
  assert.match(call, /previewMaxSeconds: PREVIEW_SECONDS/);
  assert.match(call, /vocalOnsetStartSeconds/);
  for (const removed of ['captionLines', 'onsets', 'recipient', 'story', 'lang']) {
    assert.ok(!call.includes(removed), `apelul catre selectPreviewStart nu mai trebuie sa transmita "${removed}"`);
  }
});

test('buildVariantFromTrack: NU mai calculeaza captionLines (runda 2) — buildCaptionLines() nu mai e apelata din acest flux', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.ok(!fn.includes('buildCaptionLines('), 'buildCaptionLines nu mai trebuie apelata in buildVariantFromTrack');
});

test('buildVariantFromTrack: NU mai apeleaza extractAudioOnsets() (analiza de energie audio pre-plata, folosita STRICT de scoring-ul vechi, eliminata — cerinta explicita, "nu vreau consum CPU inutil")', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.ok(!fn.includes('extractAudioOnsets('), 'extractAudioOnsets nu mai trebuie apelata in buildVariantFromTrack');
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

// RUNDA 4 (2026-09-22, cerinta explicita: "nu mai vreau NICAIERI regula -9 secunde pentru
// preview"): getPreviewStartFromLyrics() (formula -9s originala) ramane byte-identica ca
// implementare, dar acum are ZERO apelanti reali in server.js — cod complet inert, pastrat STRICT
// pentru cele 5+ fisiere de test care ii pineaza formula istoric (video-gift boundary tests, fara
// nicio legatura cu Smart Preview). Verificat mai jos ca nu are niciun apelant real.
test('getPreviewStartFromLyrics() (functia insasi) ramane byte-identica — pastrata STRICT pentru testele istorice care ii pineaza formula, dar NU mai are niciun apelant real', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.match(fn, /findFirstRealWordStartS\(words\)/);
  assert.match(fn, /firstRealStartS - TARGET_VOICE_POSITION_S/);
  assert.match(fn, /Math\.min\(previewStart, PREVIEW_START_MAX_S\)/);
});

test('CRITIC — getPreviewStartFromLyrics() NU mai e apelata de nicaieri in server.js (cod inert, nu poate afecta niciun preview real)', () => {
  // Exclude liniile de comentariu (mentiuni descriptive legitime, ex. "getPreviewStartFromLyrics()
  // ramane neschimbata") SI linia declaratiei functiei insasi — orice aparitie RAMASA ar fi un
  // apel real.
  const realCodeLines = server.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('async function getPreviewStartFromLyrics(')) return false;
    return true;
  });
  const callSites = realCodeLines.filter((line) => line.includes('getPreviewStartFromLyrics('));
  assert.equal(callSites.length, 0, `getPreviewStartFromLyrics nu trebuie apelata efectiv nicaieri, gasit in: ${JSON.stringify(callSites)}`);
});

// ELIMINATA (2026-09-22, runda 4): computeVocalOnsetPreviewStart() (formula -9s/cap25s) a fost
// STEARSA complet din server.js — avea un singur apelant (buildVariantFromTrack), inlocuit acum cu
// findFirstRealWordStartS() apelata DIRECT, FARA nicio ajustare (vezi lib/preview-selection.js
// pentru unde se aplica acum lead-in-ul de 2s, identic pentru fallback-ul A si B).
test('computeVocalOnsetPreviewStart() NU mai exista in server.js — stearsa complet, fara alta utilizare legitima', () => {
  assert.ok(!server.includes('function computeVocalOnsetPreviewStart'), 'functia nu mai trebuie sa existe in server.js');
});

test('buildVariantFromTrack: vocalOnsetStartSeconds vine STRICT din findFirstRealWordStartS(alignedWords) apelata DIRECT — BRUT, fara nicio ajustare (-9s sau alta) aplicata in server.js', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId) {');
  assert.match(fn, /const vocalOnsetStartSeconds = alignedWords \? findFirstRealWordStartS\(alignedWords\) : null;/);
  assert.ok(!fn.includes('computeVocalOnsetPreviewStart'), 'buildVariantFromTrack nu mai trebuie sa refere computeVocalOnsetPreviewStart (stearsa)');
  assert.ok(!fn.includes('TARGET_VOICE_POSITION_S'), 'buildVariantFromTrack nu mai trebuie sa refere TARGET_VOICE_POSITION_S (formula -9s) — nicio ajustare nu se mai aplica in server.js');
  assert.ok(!fn.includes('PREVIEW_START_MAX_S'), 'buildVariantFromTrack nu mai trebuie sa refere PREVIEW_START_MAX_S (cap 25s din vechea formula)');
});

test('CRITIC — nicio cale EFECTIVA de creare a preview-ului nu mai foloseste lead-in de 9 secunde: STRICT VOCAL_LEAD_IN_SECONDS (2s, lib/preview-selection.js) e folosit, in ambele fallback-uri cu semnal real', () => {
  const { VOCAL_LEAD_IN_SECONDS } = require('../lib/preview-selection');
  assert.equal(VOCAL_LEAD_IN_SECONDS, 2);
  // TARGET_VOICE_POSITION_S (9) mai exista STRICT ca sursa a formulei vechi, folosita DOAR de
  // getPreviewStartFromLyrics() (confirmat mai sus ca inert, fara apelanti reali) — nu de
  // buildVariantFromTrack (confirmat mai sus).
  assert.match(server, /const TARGET_VOICE_POSITION_S = 9;/, 'constanta veche poate ramane declarata (folosita de codul inert), dar niciun preview real nu trebuie sa o mai foloseasca');
});

test('CRITIC — trimAudio() ramane structural corect: fara loop/concat/padding, STRICT "-t <secunde>" ca durata maxima', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.doesNotMatch(fn, /loop|concat|apad|-stream_loop/i, 'trimAudio nu trebuie sa contina niciun mecanism de extindere/loop/padding artificial');
  assert.match(fn, /'-t', String\(safeSeconds\)/);
});

test('trimAudio() pastreaza fade-in-ul existent (15ms) SI fade-out-ul (0.6s) — neatinse de aceasta runda', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.match(fn, /afade=t=in:st=0:d=0\.015/, 'fade-in-ul existent trebuie pastrat neschimbat');
  assert.match(fn, /afade=t=out:st=\$\{fadeOutStart\.toFixed\(3\)\}:d=\$\{FADE_OUT_SECONDS\}/, 'fade-out-ul trebuie pastrat neschimbat');
  assert.match(server, /const FADE_OUT_SECONDS = 0\.6;/);
});

test('fade-out ramane conservator — sub 2 secunde (nu consuma o parte semnificativa din fereastra de 40s)', () => {
  const m = server.match(/const FADE_OUT_SECONDS = ([\d.]+);/);
  assert.ok(m);
  assert.ok(Number(m[1]) > 0 && Number(m[1]) < 2, `FADE_OUT_SECONDS trebuie sa fie conservator, gasit ${m[1]}`);
});

test('fade-in (15ms) ramane sigur mult sub noul lead-in vocal (~2s) — nu poate afecta intrarea vocii, cerinta explicita', () => {
  const { VOCAL_LEAD_IN_SECONDS } = require('../lib/preview-selection');
  const fadeInSeconds = 0.015;
  assert.ok(fadeInSeconds < VOCAL_LEAD_IN_SECONDS, `fade-in (${fadeInSeconds}s) trebuie sa fie STRICT mai scurt decat lead-in-ul vocal (${VOCAL_LEAD_IN_SECONDS}s)`);
  assert.ok(VOCAL_LEAD_IN_SECONDS - fadeInSeconds > 1.5, 'marja dintre sfarsitul fade-in-ului si intrarea vocii trebuie sa ramana confortabila (>1.5s)');
});

test('apelul catre buildVariantFromTrack (din attempt(), in interiorul obtainAcceptableVariant) foloseste semnatura SIMPLA', () => {
  const fn = extractFn(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.match(fn, /buildVariantFromTrack\(orderId, randomUUID\(\)\.slice\(0, 8\), track, candidateTaskId\)/);
  assert.ok(!fn.includes('effectiveOrderForPreview'), 'effectiveOrderForPreview (runda 1, STRICT pentru scoring-ul de personalizare) nu mai trebuie sa existe');
});

test('nicio alta constanta/logica de preview NEATINSA de aceasta cerinta (VIDEO_PREVIEW_SECONDS, pretul pachetelor, PLAN_PRICES)', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});
