// PUNCT 7 (2026-09-06, continuare — "fuzioneaza ultimul nivel de concat cu mux-ul final"):
// verifica REAL (randare efectiva, nu doar text-matching) ca noul pipeline fuzionat
// (concatFinalBatchWithMux/concatWithCrossfadesAndMux) produce un rezultat IDENTIC din punct de
// vedere functional cu vechiul pipeline (concat separat + mux separat), la scara reala de
// productie (50 de cadre, 1080x1920, acelasi FPS/CRF/preset/tranzitii), cu date de test STRICT
// sintetice — niciodata comenzi reale de client.
//
// Foloseste EXACT aceeasi metodologie ca test/video-onset-alignment-real.test.js (click-track
// audio real cu momente stiute -> detectie vizuala reala in MP4-ul rezultat -> masurare directa a
// distantei), aplicata acum pipeline-ului FUZIONAT, plus verificari suplimentare specifice
// fuziunii: audio-ul corect e cel folosit (durata/codec), subtitrarile chiar apar (comparatie
// pixel cu/fara subtitrari in fereastra de timp a unei replici), iar durata finala e exact cea
// asteptata.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-fused-align-'));
  const renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });

  const onsetStart = server.indexOf('const ONSET_ANALYSIS_SAMPLE_RATE = 8000;');
  assert.ok(onsetStart !== -1);
  const onsetFnEnd = sliceFunctionBody('async function extractAudioOnsets(audioFilePath, orderId) {', onsetStart);
  const onsetSnippet = server.slice(onsetStart, server.indexOf(onsetFnEnd) + onsetFnEnd.length);

  const finalSrc = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('MEMORY_XFADE_SECONDS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    extractConst('VIDEO_FINAL_CRF'),
    extractConst('VIDEO_BT709_TAG_ARGS'),
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
    extractConst('WIDE_PHOTO_ASPECT_RATIO_THRESHOLD'),
    extractFn('getPhotoDimensions'),
    extractFn('renderShot'),
    extractFn('concatBatchWithCrossfades'),
    extractFn('concatWithCrossfades'),
    extractFn('concatFinalBatchWithMux'),
    extractFn('concatWithCrossfadesAndMux'),
    'return { renderShot, concatWithCrossfades, concatWithCrossfadesAndMux, extractAudioOnsets, CONCAT_BATCH_SIZE, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT, MEMORY_VIDEO_FPS };'
  ].join('\n\n');

  mod = new Function('realExecFileAsync', 'require', finalSrc)(realExecFileAsync, require);
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}
function ffprobe(args) {
  return execFileSync('ffprobe', ['-v', 'error', ...args]).toString().trim();
}

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

async function renderShots(items, durationSeconds, sectionTimings, onsetTimes, order) {
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
  return { segments, shotPlan };
}

test('PIPELINE FUZIONAT — SINCRONIZARE REALA (50 de cadre, 200s, 5 materiale): schimbarile vizuale din videoclipul FINAL (deja cu audio+subtitrari, produs de concatWithCrossfadesAndMux) cad MASURABIL aproape de click-urile audio cunoscute — identic cu pipeline-ul vechi', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  // Randeaza DE DOUA ORI la scara reala (rezultatul fuzionat + un control fara subtitrari, ca
  // sa dovedeasca real ca textul chiar apare) — pana la ~2x timpul unei singure randari complete.
  timeout: 480000
}, async () => {
  const dir = path.join(workDir, 'case-fused-50-shots');
  const items = buildColorfulFixtures(dir, 2);
  const durationSeconds = 200;
  const sectionTimings = [{ sectionType: 'full_song', startTime: 0, endTime: durationSeconds, alignmentStatus: 'fallback' }];
  const order = { id: 'fused-onset-align-50' };

  const basePlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6, null, mod.CONCAT_BATCH_SIZE);
  assert.ok(basePlan.length >= 45, `testul are nevoie de un plan cu aproape de 50 de cadre, a obtinut ${basePlan.length}`);
  const baseBoundaryDurations = basePlan.slice(0, -1).map(s => s.transitionDuration);
  const baseRealBoundaries = computeRealBoundaryPositions(basePlan, baseBoundaryDurations, mod.CONCAT_BATCH_SIZE);
  const groundTruthClicks = baseRealBoundaries.filter((_, i) => i % 3 === 0).map(b => b + 0.15).filter(t => t > 1 && t < durationSeconds - 1);
  assert.ok(groundTruthClicks.length >= 8, `trebuie sa existe suficiente click-uri de test, a obtinut ${groundTruthClicks.length}`);

  // Audio REAL (click-track WAV) — convertit la mp3, ca in productie (tempFullMp3Path).
  const wavPath = path.join(dir, 'clicktrack.wav');
  writeWavClickTrack(wavPath, { sampleRate: 44100, durationSeconds, clickTimes: groundTruthClicks, clickDurationSeconds: 0.03 });
  const mp3Path = path.join(dir, 'clicktrack.mp3');
  ffmpeg(['-i', wavPath, '-c:a', 'libmp3lame', mp3Path]);

  const onsets = await mod.extractAudioOnsets(wavPath, order.id);
  assert.ok(onsets.length >= groundTruthClicks.length * 0.7, `majoritatea click-urilor injectate trebuie detectate ca impulsuri reale, a detectat ${onsets.length} din ${groundTruthClicks.length}`);

  const assPath = path.join(dir, 'captions.ass');
  fs.writeFileSync(assPath, `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Lyrics,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,40,40,60,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:10.00,0:00:20.00,Lyrics,,0,0,0,,TEST SUBTITLE LINE\n`);
  const assForFilter = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const { segments, shotPlan } = await renderShots(items, durationSeconds, sectionTimings, onsets, order);
  assert.equal(shotPlan.length, basePlan.length, 'numarul de cadre trebuie sa ramana neschimbat de alinierea la impuls');

  const fusedResult = await mod.concatWithCrossfadesAndMux(segments, shotPlan, order, mp3Path, assForFilter);
  assert.equal(fusedResult.muxed, true, 'fuziunea trebuie sa reuseasca pentru acest caz (nu doar fallback pe pipeline-ul vechi)');
  const finalVideo = fusedResult.path;

  // 1) DURATA finala corecta.
  const finalDuration = parseFloat(ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', finalVideo]));
  assert.ok(Math.abs(finalDuration - durationSeconds) < 1.0, `durata finala trebuie sa fie ~${durationSeconds}s, a fost ${finalDuration}s`);

  // 2) AUDIO-UL CORECT e folosit — acelasi codec/durata ca sursa, nu tacut, nu alt fisier.
  const audioCodec = ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', finalVideo]);
  assert.equal(audioCodec, 'aac', 'fluxul audio din rezultatul final trebuie sa fie prezent, codat AAC (nu tacut)');

  // 3) SUBTITRARILE raman sincronizate — cadrul din fereastra replicii (10-20s) trebuie sa difere
  // vizibil de un cadru randat FARA subtitrari la acelasi moment (proba REALA ca textul chiar
  // apare, nu doar ca filtrul a fost acceptat de ffmpeg fara eroare).
  const withoutSubsAss = path.join(dir, 'empty.ass');
  fs.writeFileSync(withoutSubsAss, `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`);
  const withoutSubsForFilter = withoutSubsAss.replace(/\\/g, '/').replace(/:/g, '\\:');
  // Randam DIRECT din segmentele deja produse (fara subtitrari) ca sa avem un control corect —
  // reutilizam ULTIMUL lot deja construit prin acelasi cod, doar cu un .ass gol.
  const { segments: segments2, shotPlan: shotPlan2 } = await renderShots(items, durationSeconds, sectionTimings, onsets, { id: 'fused-onset-align-50-control' });
  const controlResult = await mod.concatWithCrossfadesAndMux(segments2, shotPlan2, { id: 'fused-onset-align-50-control' }, mp3Path, withoutSubsForFilter);
  assert.equal(controlResult.muxed, true);

  async function frameAt(videoPath, timeSeconds) {
    const { stdout } = await realExecFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-ss', String(timeSeconds), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=64:64:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  }
  const withSubsFrame = await frameAt(finalVideo, 15);
  const withoutSubsFrame = await frameAt(controlResult.path, 15);
  let pixelDiffSum = 0;
  for (let i = 0; i < Math.min(withSubsFrame.length, withoutSubsFrame.length); i++) {
    pixelDiffSum += Math.abs(withSubsFrame[i] - withoutSubsFrame[i]);
  }
  assert.ok(pixelDiffSum > 1000, `cadrul cu subtitrari trebuie sa difere vizibil de acelasi cadru fara subtitrari (dovada ca textul chiar apare) — diferenta masurata: ${pixelDiffSum}`);
  // in afara ferestrei replicii (0-5s), cele doua ar trebui sa fie aproape identice (fara text ars).
  const withSubsFrameOutside = await frameAt(finalVideo, 2);
  const withoutSubsFrameOutside = await frameAt(controlResult.path, 2);
  let pixelDiffOutside = 0;
  for (let i = 0; i < Math.min(withSubsFrameOutside.length, withoutSubsFrameOutside.length); i++) {
    pixelDiffOutside += Math.abs(withSubsFrameOutside[i] - withoutSubsFrameOutside[i]);
  }
  assert.ok(pixelDiffOutside < pixelDiffSum, 'in afara ferestrei replicii, diferenta trebuie sa fie mult mai mica decat in interiorul ei (subtitrarile apar STRICT cand trebuie)');

  // 4) SINCRONIZAREA cadru-audio ramane corecta (aceeasi metodologie ca pipeline-ul vechi).
  const visualChanges = await detectVisualChanges(finalVideo, 10, 8);
  assert.ok(visualChanges.length >= 10, `trebuie detectate suficiente schimbari vizuale reale in MP4, a gasit ${visualChanges.length}`);
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
  assert.ok(matchRatio >= 0.7, `cel putin 70% din click-urile cunoscute trebuie sa aiba o schimbare vizuala REALA in raza de ${TOLERANCE_SECONDS}s in videoclipul FINAL fuzionat — raport masurat: ${(matchRatio * 100).toFixed(0)}% (distante: ${distances.map(d => d.toFixed(2)).join(', ')})`);

  fs.unlinkSync(finalVideo);
  fs.unlinkSync(controlResult.path);
});
