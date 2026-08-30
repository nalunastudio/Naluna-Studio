// Teste REALE de sincronizare video/audio pentru CORECȚIA (audit independent, 2026-08-24, runda
// 2, "sincronizarea video cu audio"). Bug REAL gasit: snapShotBoundariesToOnsets folosea
// shots[i].end (suma cumulativa NAIVA a duratelor de intrare, DUPA compensarea xfade) ca
// "pozitie reala" — dar aceea NU e timpul real din fisierul video FINAL, unde fiecare tranzitie
// xfade "fura" MEMORY_XFADE_SECONDS din pozitia vizibila, iar in arhitectura pe LOTURI
// (concatWithCrossfades, CONCAT_BATCH_SIZE) aceasta pierdere se COMPUNE ierarhic — la 50 de
// cadre, diferenta ajunge la aproape 30 de secunde (vezi test/audio-onset-sync.test.js pentru
// dovada matematica directa). lib/media-analysis.js a primit computeRealBoundaryPositions(),
// care simuleaza EXACT aceeasi reducere pe loturi ca randarea reala, si snapShotBoundariesToOnsets
// foloseste acum acele pozitii REALE.
//
// Acest fisier NU se opreste la aritmetica interna (asta ar fi tot "circular") — RANDEAZA EFECTIV
// un fundal cinematic complet (pana la 50 de cadre, exact plafonul SHOT_PLAN_MAX_SHOTS, cerinta
// explicita), pornind de la un fisier audio WAV REAL cu click-uri la momente STIUTE dinainte,
// decodat prin acelasi extractAudioOnsets() folosit in productie, apoi DETECTEAZA schimbarile
// VIZUALE reale din MP4-ul rezultat (esantionare de culoare la rezolutie joasa, printr-un singur
// apel ffmpeg, cu alegere de maxime locale — aceeasi tehnica de "peak picking" ca detectOnsets,
// aplicata pe semnalul video) si MASOARA distanta lor fata de click-urile audio cunoscute.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const util = require('node:util');
const realExecFileAsync = util.promisify(execFile);

const { buildShotPlan, computeRealBoundaryPositions } = require('../lib/media-analysis.js');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

function sliceFunctionBody(fnSignatureEndingInBrace, fromIdx) {
  const start = server.indexOf(fnSignatureEndingInBrace, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignatureEndingInBrace}" in server.js`);
  let depth = 1, i = start + fnSignatureEndingInBrace.length;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}
function extractFn(name) {
  let idx = server.indexOf('function ' + name + '(');
  const asyncIdx = server.lastIndexOf('async ', idx);
  if (asyncIdx !== -1 && server.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;
  assert.ok(idx !== -1, `nu am gasit functia ${name} in server.js`);
  let depth = 0, i = server.indexOf('{', idx);
  const start = idx;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}
function extractConst(name) {
  const idx = server.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `nu am gasit constanta ${name} in server.js`);
  const end = server.indexOf(';', idx);
  return server.slice(idx, end + 1);
}

let workDir;
let mod;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-onset-align-'));
  const renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });

  // extractAudioOnsets e extras SEPARAT (bloc const + functie), ca sa poata fi combinat curat cu
  // restul dependintelor mai jos.
  const onsetStart = server.indexOf('const ONSET_ANALYSIS_SAMPLE_RATE = 8000;');
  assert.ok(onsetStart !== -1);
  const onsetFnEnd = sliceFunctionBody('async function extractAudioOnsets(audioFilePath, orderId) {', onsetStart);
  const onsetSnippet = server.slice(onsetStart, server.indexOf(onsetFnEnd) + onsetFnEnd.length);

  const finalSrc = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    // CORECȚIE (2026-08-29): rezolutia/fps/preset/CRF sunt extrase DINAMIC din server.js (nu mai
    // hardcodate la vechea rezolutie 720x1280/25fps).
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('MEMORY_XFADE_SECONDS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    extractConst('CONCAT_BATCH_SIZE'),
    extractConst('CONCAT_BATCH_CONCURRENCY'),
    "async function execFfmpeg(args, options = {}) { return realExecFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 40*1024*1024, ...options }); }",
    "function perfLog() {}",
    "const { detectOnsets } = require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'media-analysis.js')) + ");",
    onsetSnippet,
    extractFn('wrapVideoRenderStageError'),
    extractFn('computeVideoSegmentStartOffset'),
    extractFn('getVideoSourceDurationSeconds'),
    extractConst('HDR_COLOR_TRANSFER_VALUES'),
    extractFn('detectHdrVideo'),
    extractConst('HDR_TONEMAP_FILTER'),
    extractFn('buildHdrToneMapFilterIfNeeded'),
    extractFn('renderShot'),
    extractFn('concatBatchWithCrossfades'),
    extractFn('concatWithCrossfades'),
    'return { renderShot, concatWithCrossfades, extractAudioOnsets, CONCAT_BATCH_SIZE, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT, MEMORY_VIDEO_FPS };'
  ].join('\n\n');

  mod = new Function('realExecFileAsync', 'require', finalSrc)(realExecFileAsync, require);
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

// Fixturi REALE: culori saturate, larg separate (distanta RGB mare intre oricare doua), ca o
// schimbare de material sa fie MASURABIL detectabila chiar si dupa un blend crossfade de 0.6s.
function buildColorfulFixtures(dir, videoCount) {
  fs.mkdirSync(dir, { recursive: true });
  const colors = ['red', 'lime', 'blue', 'yellow', 'magenta'];
  const photoCount = 5 - videoCount;
  const photos = [];
  for (let i = 0; i < photoCount; i++) {
    const p = path.join(dir, `photo${i}.jpg`);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=${900 + i * 20}x${1200 + i * 20}:d=1`, '-frames:v', '1', p]);
    photos.push({ type: 'photo', localPath: p });
  }
  const videos = [];
  for (let i = 0; i < videoCount; i++) {
    const v = path.join(dir, `video${i}.mp4`);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${colors[(i + photoCount) % colors.length]}:s=640x480:d=8`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', v]);
    videos.push({ type: 'video', localPath: v });
  }
  return [...photos, ...videos];
}

// Scrie un WAV PCM 16-bit MONO REAL cu click-uri scurte la momente STIUTE dinainte — fundal
// pseudo-aleator determinist (nu Math.random(), energie aproape constanta — vezi
// test/audio-onset-sync.test.js pentru motivul exact al acestei alegeri).
function makeDeterministicNoise(seed) {
  let s = seed >>> 0;
  return function next() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}
function writeWavClickTrack(filePath, { sampleRate, durationSeconds, clickTimes, clickDurationSeconds }) {
  const totalSamples = Math.round(sampleRate * durationSeconds);
  const data = Buffer.alloc(totalSamples * 2);
  const noise = makeDeterministicNoise(4242);
  for (let i = 0; i < totalSamples; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(noise() * 40))), i * 2);
  const clickSamples = Math.round(sampleRate * clickDurationSeconds);
  for (const ct of clickTimes) {
    const start = Math.round(ct * sampleRate);
    for (let i = 0; i < clickSamples && (start + i) < totalSamples; i++) {
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(i * 2.2) * 24000))), (start + i) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

// Detecteaza schimbari VIZUALE reale intr-un MP4: extrage o secventa de cadre la rezolutie joasa
// (medie de culoare, 8x8) prin UN SINGUR apel ffmpeg (ieftin — nu un proces per esantion),
// calculeaza distanta de culoare intre cadre consecutive si alege maximele locale peste un prag
// statistic — exact aceeasi tehnica ("peak picking" pe un semnal de energie/flux) ca detectOnsets,
// aplicata aici pe semnalul VIZUAL in loc de cel audio.
async function detectVisualChanges(videoPath, fps, gridSize) {
  const { stdout } = await realExecFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-vf', `fps=${fps},scale=${gridSize}:${gridSize}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 });
  const buf = stdout;
  const frameBytes = gridSize * gridSize * 3;
  const frameCount = Math.floor(buf.length / frameBytes);
  const dist = new Array(frameCount).fill(0);
  for (let f = 1; f < frameCount; f++) {
    let sum = 0;
    const baseA = f * frameBytes, baseB = (f - 1) * frameBytes;
    for (let i = 0; i < frameBytes; i++) {
      const d = buf[baseA + i] - buf[baseB + i];
      sum += d * d;
    }
    dist[f] = Math.sqrt(sum / frameBytes);
  }
  const mean = dist.reduce((a, b) => a + b, 0) / frameCount;
  const variance = dist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / frameCount;
  const threshold = mean + 1.3 * Math.sqrt(variance);
  const minIntervalFrames = Math.max(1, Math.round(0.5 * fps));
  const changes = [];
  let lastFrame = -Infinity;
  for (let f = 1; f < frameCount - 1; f++) {
    if (dist[f] <= threshold) continue;
    if (dist[f] < dist[f - 1] || dist[f] < dist[f + 1]) continue;
    if (f - lastFrame < minIntervalFrames) continue;
    changes.push(f / fps);
    lastFrame = f;
  }
  return changes;
}

async function renderFullBackground(items, durationSeconds, sectionTimings, onsetTimes, order) {
  const shotPlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6, onsetTimes, mod.CONCAT_BATCH_SIZE);
  const SHOT_RENDER_CONCURRENCY = 3;
  const segments = new Array(shotPlan.length);
  let cursor = 0;
  async function renderNextShot() {
    while (cursor < shotPlan.length) {
      const i = cursor++;
      const shot = shotPlan[i];
      segments[i] = await mod.renderShot(items[shot.itemIndex], shot, i, order);
    }
  }
  await Promise.all(new Array(Math.min(SHOT_RENDER_CONCURRENCY, shotPlan.length)).fill(0).map(renderNextShot));
  const bg = await mod.concatWithCrossfades(segments, shotPlan, order);
  return { bg, shotPlan };
}

// ---------------------------------------------------------------------------------------------
// TEST OBLIGATORIU: cazul de 50 de cadre (SHOT_PLAN_MAX_SHOTS) — melodie de 200s, 5 materiale (3
// poze + 2 videoclipuri, aceeasi compozitie ca ordinea reala esuata b091655e-...), click-track
// audio REAL cu momente stiute, randare COMPLETA prin pipeline-ul real, apoi masurare DIRECTA a
// distantei dintre schimbarile vizuale detectate in MP4-ul rezultat si click-urile cunoscute.
// ---------------------------------------------------------------------------------------------
test('SINCRONIZARE REALA (50 de cadre, 200s, 5 materiale): schimbarile vizuale din MP4-ul randat cad MASURABIL aproape de click-urile audio cunoscute', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 240000
}, async () => {
  const dir = path.join(workDir, 'case-50-shots');
  const items = buildColorfulFixtures(dir, 2); // 3 poze + 2 videoclipuri
  const durationSeconds = 200;
  const sectionTimings = [{ sectionType: 'full_song', startTime: 0, endTime: durationSeconds, alignmentStatus: 'fallback' }];
  const order = { id: 'onset-align-50' };

  // 1) planul de BAZA (fara analiza audio) — folosit STRICT ca sa alegem pozitii REALE de
  // granita, langa care plasam click-urile cunoscute (simuleaza un "beat" real, usor deplasat).
  const basePlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6, null, mod.CONCAT_BATCH_SIZE);
  assert.ok(basePlan.length >= 45, `testul are nevoie de un plan cu aproape de 50 de cadre, a obtinut ${basePlan.length}`);
  const baseRealBoundaries = computeRealBoundaryPositions(basePlan, 0.6, mod.CONCAT_BATCH_SIZE);
  // alegem O TREIME din granitele reale (nu toate — click-urile prea dese ar interfera unele cu
  // altele in detectorul de impulsuri), fiecare cu un mic decalaj deterministic (+0.15s).
  const groundTruthClicks = baseRealBoundaries.filter((_, i) => i % 3 === 0).map(b => b + 0.15).filter(t => t > 1 && t < durationSeconds - 1);
  assert.ok(groundTruthClicks.length >= 8, `trebuie sa existe suficiente click-uri de test, a obtinut ${groundTruthClicks.length}`);

  // 2) fisier audio WAV REAL, cu click-uri EXACT la aceste momente.
  const wavPath = path.join(dir, 'clicktrack.wav');
  writeWavClickTrack(wavPath, { sampleRate: 44100, durationSeconds, clickTimes: groundTruthClicks, clickDurationSeconds: 0.03 });

  // 3) analiza audio REALA (acelasi cod ca in productie) — extrage impulsurile din WAV.
  const onsets = await mod.extractAudioOnsets(wavPath, order.id);
  assert.ok(onsets.length >= groundTruthClicks.length * 0.7, `majoritatea click-urilor injectate trebuie detectate ca impulsuri reale, a detectat ${onsets.length} din ${groundTruthClicks.length}`);

  // 4) randare COMPLETA, REALA (renderShot x pana la 50 + concatWithCrossfades pe loturi),
  // folosind impulsurile REAL detectate mai sus.
  const { bg, shotPlan } = await renderFullBackground(items, durationSeconds, sectionTimings, onsets, order);
  assert.equal(shotPlan.length, basePlan.length, 'numarul de cadre trebuie sa ramana neschimbat de alinierea la impuls');

  // 5) detectie VIZUALA reala in MP4-ul rezultat.
  const visualChanges = await detectVisualChanges(bg, 10, 8);
  assert.ok(visualChanges.length >= 10, `trebuie detectate suficiente schimbari vizuale reale in MP4, a gasit ${visualChanges.length}`);

  // 6) masurare DIRECTA: pentru fiecare click cunoscut, distanta pana la cea mai apropiata
  // schimbare vizuala DETECTATA trebuie sa fie mica pentru MAJORITATEA click-urilor (nu neaparat
  // toate — unele granite pot fi blocate de limita minima de durata a unui cadru, sau doua
  // materiale pot avea culori accidental apropiate la esantionarea 8x8).
  const TOLERANCE_SECONDS = 1.0;
  let matched = 0;
  const distances = [];
  for (const click of groundTruthClicks) {
    const nearest = visualChanges.reduce((best, v) => (Math.abs(v - click) < Math.abs(best - click) ? v : best), visualChanges[0]);
    const dist = Math.abs(nearest - click);
    distances.push(dist);
    if (dist <= TOLERANCE_SECONDS) matched++;
  }
  const matchRatio = matched / groundTruthClicks.length;
  assert.ok(matchRatio >= 0.7, `cel putin 70% din click-urile cunoscute trebuie sa aiba o schimbare vizuala REALA in raza de ${TOLERANCE_SECONDS}s in MP4-ul randat — raport masurat: ${(matchRatio * 100).toFixed(0)}% (distante: ${distances.map(d => d.toFixed(2)).join(', ')})`);

  fs.unlinkSync(bg);
});
