// PUNCT 8 (2026-09-07, "arbore vs single-pass" — vezi raportul de benchmark productie-like:
// 20 materiale mixte, INCLUSIV 3 surse la 4K real, 50 de cadre/49 de tranzitii, aceeasi
// rezolutie/fps/preset/CRF ca productia — single-pass 38-39% mai rapid decat arborele, RAM de
// varf ~2.3GB, iesire valida, sincronizare verificata prin SSIM fata de arbore). Acest fisier
// verifica FUNCTIONAL (executie reala a codului extras, cu ffmpeg MOCKAT — controlat determinist,
// fara randare reala) cele doua ramuri critice de decizie ale concatWithCrossfadesAndMux():
//   1) single-pass reuseste -> arborele NU ruleaza deloc (0 apeluri catre calea de arbore);
//   2) single-pass esueaza -> arborele (NESCHIMBAT) preia AUTOMAT, fara nicio eroare propagata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) { return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'); }
const server = read('server.js');

function sliceFunctionBody(fnSignatureEndingInBrace, fromIdx) {
  const start = server.indexOf(fnSignatureEndingInBrace, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignatureEndingInBrace}" in server.js`);
  let depth = 1, i = start + fnSignatureEndingInBrace.length;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return { start, end: i + 1, text: server.slice(start, i + 1) };
}
function extractConst(name) {
  const idx = server.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `nu am gasit constanta ${name} in server.js`);
  const end = server.indexOf(';', idx);
  return server.slice(idx, end + 1);
}

function loadModule(execFfmpegImpl) {
  const concatBatch = sliceFunctionBody('async function concatBatchWithCrossfades(segmentPaths, shots, order, batchTag) {').text;
  const concatFinal = sliceFunctionBody('async function concatFinalBatchWithMux(segmentPaths, shots, order, audioFilePath, assForFilter) {').text;
  const concatMux = sliceFunctionBody('async function concatWithCrossfadesAndMux(segmentPaths, shots, order, audioFilePath, assForFilter) {').text;
  const wrapErr = sliceFunctionBody('function wrapVideoRenderStageError(orderId, stage, err, context) {').text;

  const src = `
    const path = require('path');
    const fs = { unlinkSync: () => {}, existsSync: () => true };
    const TEMP_DIR = '/tmp/naluna-single-pass-fallback-test';
    ${extractConst('MEMORY_XFADE_SECONDS')}
    ${extractConst('VIDEO_ENCODE_PRESET')}
    ${extractConst('VIDEO_INTERMEDIATE_CRF')}
    ${extractConst('VIDEO_FINAL_CRF')}
    ${extractConst('VIDEO_BT709_TAG_ARGS')}
    ${extractConst('CONCAT_BATCH_SIZE')}
    ${extractConst('CONCAT_BATCH_CONCURRENCY')}
    const __execFfmpegImpl = __execFfmpegImplParam;
    async function execFfmpeg(args, options) { return __execFfmpegImpl(args, options); }
    function perfLog() {}
    async function getVideoSourceDurationSeconds() { return 10; }
    ${wrapErr}
    ${concatBatch}
    ${concatFinal}
    ${concatMux}
    return { concatWithCrossfadesAndMux, CONCAT_BATCH_SIZE };
  `;
  return new Function('__execFfmpegImplParam', 'require', src)(execFfmpegImpl, require);
}

function makeShots(n) {
  return new Array(n).fill(0).map((_, i) => ({
    duration: 10,
    transitionOut: 'fade',
    transitionDuration: 0.6
  }));
}
function makeSegments(n) {
  return new Array(n).fill(0).map((_, i) => `/tmp/seg${i}.mp4`);
}

test('concatWithCrossfadesAndMux: single-pass REUSESTE -> arborele NU ruleaza deloc (0 apeluri fara subtitrari)', async () => {
  const calls = [];
  const mod = loadModule(async (args) => {
    const inputCount = args.filter(a => a === '-i').length;
    const filterIdx = args.indexOf('-filter_complex');
    const hasSubtitles = filterIdx !== -1 && args[filterIdx + 1].includes('subtitles=');
    calls.push({ inputCount, hasSubtitles });
    return { stdout: '', stderr: '' };
  });
  const segments = makeSegments(10);
  const shots = makeShots(10);
  const result = await mod.concatWithCrossfadesAndMux(segments, shots, { id: 'order-single-pass-ok' }, '/tmp/audio.mp3', '/tmp/subs.ass');
  assert.equal(result.muxed, true);
  assert.equal(calls.length, 1, 'single-pass reusit trebuie sa fie SINGURUL apel ffmpeg — arborele nu trebuie sa ruleze deloc');
  assert.equal(calls[0].inputCount, 11); // 10 segmente video + 1 audio
  assert.equal(calls[0].hasSubtitles, true);
});

test('concatWithCrossfadesAndMux: single-pass ESUEAZA -> arborele NESCHIMBAT preia automat, fara nicio eroare propagata catre apelant', async () => {
  const calls = [];
  let singlePassAttempted = false;
  const mod = loadModule(async (args) => {
    const inputCount = args.filter(a => a === '-i').length;
    const filterIdx = args.indexOf('-filter_complex');
    const hasSubtitles = filterIdx !== -1 && args[filterIdx + 1].includes('subtitles=');
    calls.push({ inputCount, hasSubtitles });
    if (hasSubtitles && inputCount === 11) {
      singlePassAttempted = true;
      throw Object.assign(new Error('eroare simulata single-pass'), { code: 1 });
    }
    return { stdout: '', stderr: '' };
  });
  const segments = makeSegments(10);
  const shots = makeShots(10);
  const result = await mod.concatWithCrossfadesAndMux(segments, shots, { id: 'order-single-pass-fail' }, '/tmp/audio.mp3', '/tmp/subs.ass');

  assert.equal(singlePassAttempted, true, 'single-pass trebuie incercat INTAI, chiar daca esueaza');
  assert.equal(result.muxed, true, 'arborele trebuie sa produca in continuare un rezultat fuzionat valid (ultimul nivel foloseste tot concatFinalBatchWithMux)');

  // Arbore REAL: 10 segmente, CONCAT_BATCH_SIZE=8 -> nivel 0 are 2 loturi (8 + 2), fara subtitrari;
  // nivel 1 (ultimul) fuzioneaza cele 2 rezultate intermediare + audio + subtitrari.
  const singlePassCalls = calls.filter(c => c.hasSubtitles && c.inputCount === 11);
  const treeBatchCalls = calls.filter(c => !c.hasSubtitles);
  const treeFinalCalls = calls.filter(c => c.hasSubtitles && c.inputCount === 3);
  assert.equal(singlePassCalls.length, 1, 'single-pass trebuie incercat EXACT o data, niciodata reincercat');
  assert.equal(treeBatchCalls.length, 2, 'arborele trebuie sa proceseze EXACT cele doua loturi de nivel 0 (8 + 2 segmente)');
  assert.equal(treeFinalCalls.length, 1, 'ultimul nivel al arborelui trebuie sa fuzioneze cele 2 rezultate intermediare + audio + subtitrari');
  treeBatchCalls.forEach(c => assert.ok(c.inputCount <= mod.CONCAT_BATCH_SIZE, `niciun apel de arbore nu trebuie sa depaseasca CONCAT_BATCH_SIZE=${mod.CONCAT_BATCH_SIZE} intrari`));
});

test('concatWithCrossfadesAndMux: cazul cu UN SINGUR segment total ramane NESCHIMBAT — single-pass nu se aplica (nimic de comparat), fuzioneaza direct', async () => {
  const calls = [];
  const mod = loadModule(async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '' };
  });
  const result = await mod.concatWithCrossfadesAndMux(['/tmp/only-one.mp4'], makeShots(1), { id: 'order-single-segment' }, '/tmp/audio.mp3', '/tmp/subs.ass');
  assert.equal(result.muxed, true);
  assert.equal(calls.length, 1);
});
