// Teste REALE de stres pentru CORECȚIA 2026-08-24 ("randarea videoclipului esueaza in
// productie — comanda b091655e-2c9e-4cba-a633-8bf5a4b2b4a8, 5 materiale, 50 de cadre"):
// cauza EXACTA, confirmata direct in logurile Railway ale acelei comenzi — concatWithCrossfades()
// dadea unui SINGUR proces ffmpeg pana la 50 de fisiere de intrare simultan, cu un
// filter_complex continand pana la 49 de noduri xfade deodata. Randarea cadrelor individuale
// reusea de fiecare data; eroarea aparea STRICT la concatenare, inainte de memory_background_ready.
//
// Acest fisier RANDEAZA EFECTIV (nu doar verifica text) un fundal complet, la scara reala de
// productie (o melodie de peste 144s, care atinge plafonul de 50 de cadre — SHOT_PLAN_MAX_SHOTS
// — exact ca in comanda esuata), cu ACEEASI concurenta de randare a cadrelor ca in productie
// (SHOT_RENDER_CONCURRENCY=3), si INSTRUMENTEAZA fiecare apel ffmpeg real ca sa dovedeasca
// masurabil ca NICIUN proces nu mai primeste vreodata mai mult de CONCAT_BATCH_SIZE intrari
// simultan — nu doar ca randarea "a produs un fisier", ci ca arhitectura noua chiar respecta
// plafonul care lipsea inainte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const util = require('node:util');
const realExecFileAsync = util.promisify(execFile);

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const { buildShotPlan } = require('../lib/media-analysis.js');

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

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
let ffmpegCalls; // instrumentare — un rand per invocare REALA a ffmpeg din pipeline-ul testat
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-concat-stress-'));
  const renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });

  const src = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    // CORECȚIE (2026-08-29): rezolutia/fps/preset/CRF sunt extrase DINAMIC din server.js (nu mai
    // hardcodate la vechea rezolutie 720x1280/25fps) — testul de stres ramane valid la orice
    // rezolutie/calitate curenta a pipeline-ului, fara sa mai trebuiasca actualizat manual.
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('MEMORY_XFADE_SECONDS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    extractConst('CONCAT_BATCH_SIZE'),
    extractConst('CONCAT_BATCH_CONCURRENCY'),
    // execFfmpeg INSTRUMENTAT — executa REAL ffmpeg (aceeasi cale ca in productie), dar
    // inregistreaza si numarul de "-i" (intrari) per apel, ca testul sa poata dovedi masurabil
    // ca plafonul e respectat, nu doar sa presupuna asta din faptul ca randarea a reusit.
    "async function execFfmpeg(args, options = {}) { const inputCount = args.filter(a => a === '-i').length; __recordFfmpegCall(inputCount, args); return realExecFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 20*1024*1024, ...options }); }",
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
    "function perfLog() {}",
    'return { renderShot, concatWithCrossfades, CONCAT_BATCH_SIZE, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT, MEMORY_VIDEO_FPS };'
  ].join('\n\n');

  ffmpegCalls = [];
  mod = new Function('realExecFileAsync', 'require', '__recordFfmpegCall', src)(
    realExecFileAsync,
    require,
    (inputCount, args) => { ffmpegCalls.push({ inputCount, hasFilterComplex: args.includes('-filter_complex') }); }
  );
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}
function ffprobeDuration(filePath) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).toString().trim());
}
function ffprobeStream(filePath, sel, entry) {
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', `stream=${entry}`, '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).toString().trim();
}

function buildPhotoVideoFixtures(dir, videoCount) {
  fs.mkdirSync(dir, { recursive: true });
  const photos = [];
  const colors = ['red', 'green', 'blue', 'orange', 'purple'];
  const photoCount = 5 - videoCount;
  for (let i = 0; i < photoCount; i++) {
    const p = path.join(dir, `photo${i}.jpg`);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=${900 + i * 40}x${1200 + i * 30}:d=1`, '-frames:v', '1', p]);
    photos.push({ type: 'photo', localPath: p });
  }
  const videos = [];
  for (let i = 0; i < videoCount; i++) {
    const v = path.join(dir, `video${i}.mp4`);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${colors[(i + 2) % colors.length]}:s=640x480:d=6`, '-vf', `drawbox=x='mod(t*70,640)':y=180:w=50:h=50:color=black:t=fill`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', v]);
    videos.push({ type: 'video', localPath: v });
  }
  return [...photos, ...videos];
}

async function renderFullBackground(items, durationSeconds, sectionTimings, order) {
  const shotPlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6);
  const SHOT_RENDER_CONCURRENCY = 3; // ACEEASI concurenta ca in productie (server.js)
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
// STRES REAL — melodie de 200s (peste minimul de 144s cerut, atinge plafonul de 50 de cadre —
// exact scenariul comenzii esuate: SHOT_PLAN_MAX_SHOTS), 3 fotografii + 1 videoclip scurt.
// ---------------------------------------------------------------------------------------------
test('STRES REAL (200s, ~50 cadre, 3 poze + 1 video): randarea completa reuseste, NICIUN proces ffmpeg de concatenare nu primeste vreodata mai mult de CONCAT_BATCH_SIZE intrari', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 180000 }, async () => {
  const dir = path.join(workDir, 'case-4-materials');
  const items = buildPhotoVideoFixtures(dir, 1); // 3 poze + 1 video
  const durationSeconds = 200;
  const sectionTimings = [{ sectionType: 'full_song', startTime: 0, endTime: durationSeconds, alignmentStatus: 'fallback' }];
  const order = { id: 'stress-4-materials' };

  ffmpegCalls.length = 0;
  const t0 = Date.now();
  const { bg, shotPlan } = await renderFullBackground(items, durationSeconds, sectionTimings, order);
  const elapsedMs = Date.now() - t0;

  console.log(`[STRES 200s/4 materiale] cadre=${shotPlan.length}, apeluri ffmpeg=${ffmpegCalls.length}, timp real=${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);

  assert.ok(shotPlan.length >= 45, `planul trebuie sa se apropie de plafonul de 50 de cadre pentru o melodie de ${durationSeconds}s, a avut ${shotPlan.length}`);
  assert.ok(shotPlan.length <= 50, `planul nu trebuie sa depaseasca NICIODATA plafonul SHOT_PLAN_MAX_SHOTS=50, a avut ${shotPlan.length}`);

  // Dovada MASURABILA a corectiei — cauza reala a esecurilor din productie.
  const concatCalls = ffmpegCalls.filter(c => c.hasFilterComplex);
  assert.ok(concatCalls.length > 1, `cu ${shotPlan.length} cadre trebuie sa existe MAI MULTE apeluri de concatenare (pe niveluri), nu unul singur monolitic — au fost ${concatCalls.length}`);
  const maxInputsInAnyConcatCall = Math.max(...concatCalls.map(c => c.inputCount));
  assert.ok(maxInputsInAnyConcatCall <= mod.CONCAT_BATCH_SIZE, `NICIUN proces ffmpeg de concatenare nu trebuie sa primeasca mai mult de CONCAT_BATCH_SIZE=${mod.CONCAT_BATCH_SIZE} intrari — cel mai mare apel real a avut ${maxInputsInAnyConcatCall} (cauza EXACTA a esecurilor din productie: un singur apel cu pana la 50)`);

  const duration = ffprobeDuration(bg);
  assert.ok(Math.abs(duration - durationSeconds) < 1.0, `durata finala trebuie sa fie ~${durationSeconds}s (compensata corect prin reducerea pe niveluri), a fost ${duration}s`);
  assert.equal(ffprobeStream(bg, 'v:0', 'width'), String(mod.MEMORY_VIDEO_WIDTH));
  assert.equal(ffprobeStream(bg, 'v:0', 'height'), String(mod.MEMORY_VIDEO_HEIGHT));

  // CERINTA 10 (acceptance): randarea (fundal, 50 cadre, 1080x1920) trebuie sa se incadreze
  // CONFORTABIL in lock-ul de randare video de 20 minute (db.claimVideoRender) — masuram REAL,
  // nu presupunem. Aceasta masuratoare acopera shot-render + concat pe loturi (partea dominanta
  // ca numar de procese ffmpeg); mux-ul final (fundal+audio+subtitrari) e benchmark-uit separat.
  const VIDEO_RENDER_LOCK_MS = 20 * 60 * 1000;
  assert.ok(elapsedMs < VIDEO_RENDER_LOCK_MS * 0.5, `randarea (fundal, ${shotPlan.length} cadre, ${mod.MEMORY_VIDEO_WIDTH}x${mod.MEMORY_VIDEO_HEIGHT}) trebuie sa lase o marja larga fata de lock-ul de 20 minute — a durat ${(elapsedMs / 1000).toFixed(1)}s`);
});

// ---------------------------------------------------------------------------------------------
// STRES REAL — cazul EXACT raportat: 5 materiale (3 poze + 2 videoclipuri), melodie lunga.
// ---------------------------------------------------------------------------------------------
test('STRES REAL (200s, 5 materiale — 3 poze + 2 video, ca in comanda esuata reala): randarea completa reuseste cu acelasi plafon respectat', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 180000 }, async () => {
  const dir = path.join(workDir, 'case-5-materials');
  const items = buildPhotoVideoFixtures(dir, 2); // 3 poze + 2 video = 5 materiale, ca in comanda reala
  const durationSeconds = 200;
  const sectionTimings = [
    { sectionType: 'intro', startTime: 0, endTime: 15, alignmentStatus: 'aligned' },
    { sectionType: 'verse', startTime: 15, endTime: 70, alignmentStatus: 'aligned' },
    { sectionType: 'chorus', startTime: 70, endTime: 110, alignmentStatus: 'aligned' },
    { sectionType: 'verse', startTime: 110, endTime: 160, alignmentStatus: 'aligned' },
    { sectionType: 'outro', startTime: 160, endTime: 200, alignmentStatus: 'aligned' }
  ];
  const order = { id: 'stress-5-materials' };

  ffmpegCalls.length = 0;
  const t0 = Date.now();
  const { bg, shotPlan } = await renderFullBackground(items, durationSeconds, sectionTimings, order);
  const elapsedMs = Date.now() - t0;

  console.log(`[STRES 200s/5 materiale, sectiuni reale] cadre=${shotPlan.length}, apeluri ffmpeg=${ffmpegCalls.length}, timp real=${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);

  assert.ok(shotPlan.length >= 5, 'planul trebuie sa contina cadre');
  const concatCalls = ffmpegCalls.filter(c => c.hasFilterComplex);
  const maxInputsInAnyConcatCall = concatCalls.length > 0 ? Math.max(...concatCalls.map(c => c.inputCount)) : 0;
  assert.ok(maxInputsInAnyConcatCall <= mod.CONCAT_BATCH_SIZE, `plafonul CONCAT_BATCH_SIZE=${mod.CONCAT_BATCH_SIZE} trebuie respectat si pentru 5 materiale — cel mai mare apel a avut ${maxInputsInAnyConcatCall}`);

  const duration = ffprobeDuration(bg);
  assert.ok(Math.abs(duration - durationSeconds) < 1.0, `durata finala trebuie sa fie ~${durationSeconds}s, a fost ${duration}s`);
  assert.equal(ffprobeStream(bg, 'v:0', 'codec_name'), 'h264');

  // Toate cele 5 materiale trebuie sa fi fost folosite macar o data — nu doar o parte a lor.
  const usedItems = new Set(shotPlan.map(s => s.itemIndex));
  assert.equal(usedItems.size, 5, `toate cele 5 materiale trebuie folosite in plan, doar ${usedItems.size} au aparut`);

  const VIDEO_RENDER_LOCK_MS = 20 * 60 * 1000;
  assert.ok(elapsedMs < VIDEO_RENDER_LOCK_MS * 0.5, `randarea (fundal, ${shotPlan.length} cadre, ${mod.MEMORY_VIDEO_WIDTH}x${mod.MEMORY_VIDEO_HEIGHT}, 5 materiale) trebuie sa lase o marja larga fata de lock-ul de 20 minute — a durat ${(elapsedMs / 1000).toFixed(1)}s`);
});

// ---------------------------------------------------------------------------------------------
// Logare sigura — eroarea unui cadru/lot esuat nu trebuie sa expuna caile locale de pe disc.
// ---------------------------------------------------------------------------------------------
test('wrapVideoRenderStageError: eroarea CURATA nu contine cai de fisier locale sau comanda ffmpeg completa', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, async () => {
  const dir = path.join(workDir, 'case-bad-file');
  fs.mkdirSync(dir, { recursive: true });
  const badFile = path.join(dir, 'not-a-real-video.mp4');
  fs.writeFileSync(badFile, 'not actually a video file');
  const order = { id: 'stress-bad-file' };
  const shot = { itemIndex: 0, occurrence: 0, duration: 2, kenBurns: null };
  await assert.rejects(
    () => mod.renderShot({ type: 'video', localPath: badFile }, shot, 0, order),
    (err) => {
      assert.ok(!err.message.includes(dir), 'mesajul CURAT nu trebuie sa contina calea locala a fisierului temporar');
      assert.ok(!err.message.includes('ffmpeg'), 'mesajul CURAT nu trebuie sa contina comanda ffmpeg');
      assert.ok(err.message.includes('etapa'), 'mesajul CURAT trebuie sa mentioneze STRICT etapa, generic');
      assert.equal(err.stage, 'shot_render_video');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------------------------
// CORECȚIE (audit independent, 2026-08-24, runda 2, "curata fisierele intermediare si cand
// concatWithCrossfades esueaza, nu doar la succes") — bug real: fisierele intermediare create la
// niveluri ANTERIOARE unui esec ramaneau orfane pe disc, pentru ca vechea curatare se executa
// DOAR pe calea de succes (dupa `while`), niciodata intr-un `finally`. Testul de mai jos
// construieste REAL 7 segmente video (peste CONCAT_BATCH_SIZE=5 — garanteaza 2 loturi la nivelul
// 0), face lotul AL DOILEA sa esueze REAL (fisier corupt), si verifica ca fisierul intermediar
// creat cu succes de PRIMUL lot (deja pe disc in momentul esecului) e sters, nu doar ca functia
// arunca eroarea asteptata.
test('concatWithCrossfades: fisierele intermediare create la un nivel ANTERIOR unui esec sunt curatate si la eroare, nu doar la succes', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 60000 }, async () => {
  const dir = path.join(workDir, 'case-cleanup-on-failure');
  fs.mkdirSync(dir, { recursive: true });
  const order = { id: 'stress-cleanup-on-failure' };

  // 7 segmente reale scurte (2s fiecare) — primele 5 formeaza lotul 1 (nivel 0), reusit; ultimele
  // 2 formeaza lotul 2, care va contine un fisier corupt si va esua REAL la concatenare.
  const segmentPaths = [];
  for (let i = 0; i < 7; i++) {
    const p = path.join(dir, `seg${i}.mp4`);
    if (i === 5) {
      fs.writeFileSync(p, 'not actually a video file');
    } else {
      execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${['red', 'green', 'blue'][i % 3]}:s=320x240:d=2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p]);
    }
    segmentPaths.push(p);
  }
  const shots = segmentPaths.map(() => ({ duration: 2, transitionOut: 'fade' }));

  await assert.rejects(
    () => mod.concatWithCrossfades(segmentPaths, shots, order),
    (err) => {
      assert.ok(err.stage, 'eroarea trebuie sa fie una CURATA, cu stage setat (wrapVideoRenderStageError)');
      return true;
    }
  );

  // fisierul intermediar al PRIMULUI lot (5 segmente reale, reusit) trebuie sa fi existat la un
  // moment dat (verificam indirect: niciun fisier "L0-0" ramas dupa apel) — verificam DIRECT ca
  // niciun fisier de forma `${order.id}-memory-batch-*` nu mai exista in TEMP_DIR dupa esec.
  const leftover = fs.readdirSync(path.join(workDir, 'render-work')).filter(f => f.includes(order.id) && f.includes('memory-batch'));
  assert.equal(leftover.length, 0, `niciun fisier intermediar nu trebuie sa ramana pe disc dupa un esec — gasit: ${JSON.stringify(leftover)}`);
});
