// Teste REALE cu ffmpeg/ffprobe pentru CORECȚIA 2026-08-24 ("montajul video e monoton") —
// randeaza EFECTIV un fundal cinematic din fixture-uri sintetice (3 fotografii de culori
// distincte + 1 videoclip scurt, generate integral de ffmpeg, fara materiale externe) folosind
// buildShotPlan() (lib/media-analysis.js) + renderShot()/concatWithCrossfades() (extrase din
// server.js, acelasi tipar de sandbox deja folosit in restul suitei) — apoi INSPECTEAZA
// rezultatul REAL cu ffprobe si esantioane de culoare la timpi cheie, nu doar ca "ffmpeg nu a
// crapat". Acopera exact cerintele obligatorii ale clientului pentru cazul testat de el insusi:
// 3 fotografii + un videoclip scurt.
//
// GASIT DIRECT prin acest test, in timpul dezvoltarii: fara compensatia pentru suprapunerea
// tranzitiilor crossfade, un plan de 60s producea un fisier de 47.44s (22 cadre, 21 tranzitii
// de 0.6s necompensate = 12.6s pierdute) — motivul exact pentru care buildShotPlan() primeste
// acum xfadeSeconds si compenseaza explicit fiecare cadru.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const util = require('node:util');
const execFileAsync = util.promisify(execFile);

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
  let depth = 0, i = server.indexOf('{', idx);
  const start = idx;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(i < server.length, `nu am gasit functia ${name} in server.js`);
  return server.slice(start, i + 1);
}

let workDir;
let mod;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-shotplan-test-'));
  const renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });
  const src = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    'const MEMORY_VIDEO_WIDTH = 720; const MEMORY_VIDEO_HEIGHT = 1280; const MEMORY_VIDEO_FPS = 25; const MEMORY_XFADE_SECONDS = 0.6;',
    "async function execFfmpeg(args, options = {}) { return execFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 20*1024*1024, ...options }); }",
    extractFn('computeVideoSegmentStartOffset'),
    extractFn('getVideoSourceDurationSeconds'),
    extractFn('renderShot'),
    extractFn('concatWithCrossfades'),
    'return { renderShot, concatWithCrossfades };'
  ].join('\n\n');
  mod = new Function('execFileAsync', 'require', src)(execFileAsync, require);
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
function sampleColor(filePath, t) {
  const out = execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', filePath, '-vframes', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return out.length >= 3 ? { r: out[0], g: out[1], b: out[2] } : null;
}
function closeTo(color, target, tol) {
  if (!color) return false;
  return Math.abs(color.r - target.r) <= tol && Math.abs(color.g - target.g) <= tol && Math.abs(color.b - target.b) <= tol;
}

// concatWithCrossfades() suprapune fiecare pereche de cadre consecutive pentru xfadeSeconds —
// pozitia REALA (in fisierul de iesire) unde un cadru devine "pur" (fara amestec cu vecinul)
// difera de simpla suma cumulativa a duratelor (shot.start/shot.end, calculate INAINTE de
// randare) — fiecare tranzitie anterioara comprima timeline-ul real cu xfadeSeconds fata de
// suma naiva. Reproduce AICI exact aceeasi aritmetica cumulativa ca in concatWithCrossfades()
// din server.js, ca esantioanele de culoare sa fie luate din zona CU ADEVARAT "pura" a
// fiecarui cadru, nu dintr-o pozitie gresita (motivul exact pentru care esantionarea naiva de
// mai jos ar fi esuat pentru cadrele tarzii dintr-un plan cu multe cadre).
function computeRealPureWindows(shots, xfade) {
  if (shots.length === 1) return [{ pureStart: 0, pureEnd: shots[0].duration }];
  const windows = [];
  let cumulative = shots[0].duration;
  windows.push({ pureStart: 0, pureEnd: cumulative - xfade });
  for (let i = 1; i < shots.length; i++) {
    const pureStart = cumulative;
    cumulative += shots[i].duration - xfade;
    const pureEnd = i === shots.length - 1 ? cumulative : cumulative - xfade;
    windows.push({ pureStart, pureEnd });
  }
  return windows;
}
const RED = { r: 254, g: 0, b: 0 };
const GREEN = { r: 1, g: 129, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
const YELLOW = { r: 255, g: 204, b: 0 };

function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const photo1 = path.join(dir, 'photo1.jpg'); // red, source aspect taller than target
  const photo2 = path.join(dir, 'photo2.jpg'); // green, source aspect wider than target
  const photo3 = path.join(dir, 'photo3.jpg'); // blue, square source
  const video1 = path.join(dir, 'video1.mp4'); // yellow-ish, 8s, with visible motion
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=900x1350:d=1', '-frames:v', '1', photo1]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=1200x900:d=1', '-frames:v', '1', photo2]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1080x1080:d=1', '-frames:v', '1', photo3]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=yellow:s=640x480:d=8', '-vf', "drawbox=x='mod(t*80,640)':y=200:w=60:h=60:color=black:t=fill", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video1]);
  return { photo1, photo2, photo3, video1 };
}

// ---------------------------------------------------------------------------------------------
// Randare REALA — 3 fotografii + un videoclip scurt (cazul testat explicit de client),
// melodie fara marcaje reale de sectiune (fallback).
// ---------------------------------------------------------------------------------------------
test('RANDARE REALA (3 poze + 1 video, fallback fara sectiuni): toate cele 4 materiale apar in primele 12s, minimum 8 schimbari in primele 25s, niciun cadru peste 3.5s in acel interval, fara repetari consecutive, durata finala = durata melodiei', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, async () => {
  const dir = path.join(workDir, 'case-fallback');
  const { photo1, photo2, photo3, video1 } = buildFixtures(dir);
  const items = [
    { type: 'photo', localPath: photo1 },
    { type: 'photo', localPath: photo2 },
    { type: 'photo', localPath: photo3 },
    { type: 'video', localPath: video1 }
  ];
  const durationSeconds = 60;
  const sectionTimings = [{ sectionType: 'full_song', startTime: 0, endTime: 60, alignmentStatus: 'fallback' }];
  const shotPlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6);

  // Verificari STATICE ale planului insusi, inainte de randare (rapide, dar nu suficiente
  // singure — randarea REALA de mai jos confirma ca planul chiar produce ce promite).
  const first25 = shotPlan.filter(s => s.start < 25);
  assert.ok(first25.length >= 8, `trebuie minimum 8 cadre in primele 25s, plan are ${first25.length}`);
  assert.ok(Math.max(...first25.map(s => s.duration)) <= 3.5, 'niciun cadru din primele 25s nu trebuie sa depaseasca 3.5s');
  assert.equal(new Set(shotPlan.filter(s => s.start < 12).map(s => s.itemIndex)).size, 4, 'toate cele 4 materiale trebuie sa apara in primele 12s');
  assert.ok(!shotPlan.some((s, i) => i > 0 && s.itemIndex === shotPlan[i - 1].itemIndex), 'niciun material nu trebuie sa se repete consecutiv');
  const videoFirstShot = shotPlan.find(s => s.itemIndex === 3);
  assert.ok(videoFirstShot.start < 12, `videoclipul trebuie sa apara devreme, nu doar dupa preview — a aparut la ${videoFirstShot.start}s`);

  // Randare REALA — segmentele + fundalul complet, cu ffmpeg.
  const order = { id: 'test-fallback' };
  const segments = [];
  for (let i = 0; i < shotPlan.length; i++) {
    segments.push(await mod.renderShot(items[shotPlan[i].itemIndex], shotPlan[i], i, order));
  }
  const bg = await mod.concatWithCrossfades(segments, shotPlan, order);

  const duration = ffprobeDuration(bg);
  assert.ok(Math.abs(duration - durationSeconds) < 0.5, `durata finala trebuie sa fie ~${durationSeconds}s, a fost ${duration}s`);
  assert.equal(ffprobeStream(bg, 'v:0', 'width'), '720');
  assert.equal(ffprobeStream(bg, 'v:0', 'height'), '1280');

  // Esantioane de culoare REALE — confirma ca materialul CORECT apare la timpul asteptat din
  // plan (nu doar ca planul "spune" asta pe hartie). Esantionate din zona REAL "pura" a
  // fiecarui cadru (vezi computeRealPureWindows) — nu din simpla suma naiva a duratelor.
  const colorByItemIndex = [RED, GREEN, BLUE, YELLOW];
  const pureWindows = computeRealPureWindows(shotPlan, 0.6);
  let sampled = 0;
  let matched = 0;
  shotPlan.forEach((shot, i) => {
    const { pureStart, pureEnd } = pureWindows[i];
    if (pureEnd - pureStart < 0.3) return; // cadru prea scurt sa aiba o zona pura fiabila — sarim
    if (pureEnd >= duration - 0.15) return; // prea aproape de finalul real (rotunjire) — sarim
    const midpoint = (pureStart + pureEnd) / 2;
    sampled++;
    const color = sampleColor(bg, midpoint);
    if (closeTo(color, colorByItemIndex[shot.itemIndex], 40)) matched++;
  });
  assert.ok(sampled >= shotPlan.length * 0.5, `trebuie sa fi putut esantiona majoritatea cadrelor, doar ${sampled}/${shotPlan.length} au avut o zona pura utilizabila`);
  // Prag 75%, nu 100% — cateva cadre scurte au o zona "pura" ingusta unde artefacte de
  // codare la limita ferestrei (bloc-uri x264 la marginea unei tranzitii xfade) pot deplasa
  // usor esantionul de 1x1 pixel; proprietatile STRUCTURALE ale planului (numar de cadre,
  // acoperire in primele 12s, fara repetari consecutive, durata finala) sunt deja verificate
  // separat, mai sus, exact — acest prag verifica STRICT ca marea majoritate a continutului
  // REDAT corespunde planului, nu perfectiunea la nivel de pixel a fiecarui cadru izolat.
  assert.ok(matched >= sampled * 0.75, `marea majoritate a cadrelor esantionate trebuie sa arate culoarea materialului asteptat din plan (${matched}/${sampled})`);
});

// ---------------------------------------------------------------------------------------------
// Randare REALA — melodie CU marcaje reale de sectiune (intro/strofa/refren/final) — verifica
// ritmul diferit (cadre mai scurte in refren, mai lungi in strofa/intro/final).
// ---------------------------------------------------------------------------------------------
test('RANDARE REALA (3 poze + 1 video, sectiuni REALE): cadrele din refren sunt mai scurte decat cele din strofa (taieturi mai dese in sectiunile energice)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, async () => {
  const dir = path.join(workDir, 'case-real-sections');
  const { photo1, photo2, photo3, video1 } = buildFixtures(dir);
  const items = [
    { type: 'photo', localPath: photo1 },
    { type: 'photo', localPath: photo2 },
    { type: 'photo', localPath: photo3 },
    { type: 'video', localPath: video1 }
  ];
  const durationSeconds = 70;
  const sectionTimings = [
    { sectionType: 'intro', startTime: 0, endTime: 8, alignmentStatus: 'aligned' },
    { sectionType: 'verse', startTime: 8, endTime: 30, alignmentStatus: 'aligned' },
    { sectionType: 'chorus', startTime: 30, endTime: 50, alignmentStatus: 'aligned' },
    { sectionType: 'outro', startTime: 50, endTime: 70, alignmentStatus: 'aligned' }
  ];
  const shotPlan = buildShotPlan(items, durationSeconds, sectionTimings, 0.6);

  const chorusShots = shotPlan.filter(s => s.start >= 30 && s.start < 50 && s.energy === 'energetic');
  const verseShots = shotPlan.filter(s => s.start >= 25 && s.start < 30 && s.energy === 'calm');
  assert.ok(chorusShots.length > 0, 'trebuie sa existe cadre energice in refren');

  const order = { id: 'test-real-sections' };
  const segments = [];
  for (let i = 0; i < shotPlan.length; i++) {
    segments.push(await mod.renderShot(items[shotPlan[i].itemIndex], shotPlan[i], i, order));
  }
  const bg = await mod.concatWithCrossfades(segments, shotPlan, order);
  const duration = ffprobeDuration(bg);
  assert.ok(Math.abs(duration - durationSeconds) < 0.6, `durata finala trebuie sa fie ~${durationSeconds}s, a fost ${duration}s`);

  const avgChorus = chorusShots.reduce((s, x) => s + x.duration, 0) / chorusShots.length;
  const avgCalmPostPreview = shotPlan.filter(s => s.energy === 'calm' && s.start >= 25).reduce((s, x, _, a) => s + x.duration / a.length, 0);
  assert.ok(avgChorus < avgCalmPostPreview, `cadrele din refren (${avgChorus.toFixed(2)}s) trebuie sa fie mai scurte decat cele calme (${avgCalmPostPreview.toFixed(2)}s)`);
});

// ---------------------------------------------------------------------------------------------
// Determinism — aceeasi comanda + aceleasi materiale produc EXACT acelasi plan la reincercare.
// ---------------------------------------------------------------------------------------------
test('buildShotPlan e DETERMINIST — aceleasi argumente produc exact acelasi plan (niciun Math.random)', () => {
  const items = [{ type: 'photo' }, { type: 'photo' }, { type: 'photo' }, { type: 'video' }];
  const sections = [
    { sectionType: 'intro', startTime: 0, endTime: 8, alignmentStatus: 'aligned' },
    { sectionType: 'verse', startTime: 8, endTime: 30, alignmentStatus: 'aligned' },
    { sectionType: 'chorus', startTime: 30, endTime: 50, alignmentStatus: 'aligned' },
    { sectionType: 'outro', startTime: 50, endTime: 70, alignmentStatus: 'aligned' }
  ];
  const planA = buildShotPlan(items, 70, sections, 0.6);
  const planB = buildShotPlan(items, 70, sections, 0.6);
  assert.deepEqual(planA, planB);
});

// ---------------------------------------------------------------------------------------------
// Video sursa mai SCURT decat slotul alocat (bucla) vs mai LUNG (extrage un fragment real).
// ---------------------------------------------------------------------------------------------
test('RANDARE REALA: video sursa mai scurt decat slotul foloseste bucla (-stream_loop), video sursa mai lung extrage fragmente reale diferite per aparitie', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, async () => {
  const dir = path.join(workDir, 'case-video-lengths');
  fs.mkdirSync(dir, { recursive: true });
  const shortVideo = path.join(dir, 'short.mp4'); // 1.5s — mai scurt decat orice slot
  const longVideo = path.join(dir, 'long.mp4'); // 20s — mai lung decat sloturile normale
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=cyan:s=640x480:d=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', shortVideo]);
  // 10 BENZI de culoare DISTINCTE, concatenate — continutul depinde de POZITIA ABSOLUTA in
  // fisier (fiecare secunda contine literal cadre de o alta culoare), niciodata de timpul
  // relativ de la un eventual seek. Un filtru bazat pe 't' (ex. hue=h='t*60') NU functioneaza
  // aici — dupa un -ss la nivel de input, 't' repornește de la ~0 pentru filtru, deci doua
  // aparitii cu seek-uri diferite ar arata identic (verificat direct, versiunea initiala a
  // acestui test folosea gresit un asemenea tipar si nu putea niciodata distinge doua aparitii).
  const bandColors = ['0x000033', '0x003300', '0x330000', '0x333300', '0x003333', '0x330033', '0x666666', '0xff8800', '0x8800ff', '0x00ff88'];
  const bandArgs = [];
  bandColors.forEach(c => bandArgs.push('-f', 'lavfi', '-i', `color=c=${c}:s=640x480:d=2`));
  const filterInputs = bandColors.map((_, i) => `[${i}:v]`).join('');
  ffmpeg([...bandArgs, '-filter_complex', `${filterInputs}concat=n=${bandColors.length}:v=1:a=0[outv]`, '-map', '[outv]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', longVideo]);

  const order = { id: 'test-video-lengths' };
  const shotShort = { itemIndex: 0, occurrence: 0, duration: 2.5, kenBurns: null };
  const outShort = await mod.renderShot({ type: 'video', localPath: shortVideo }, shotShort, 0, order);
  assert.ok(Math.abs(ffprobeDuration(outShort) - 2.5) < 0.2, 'segmentul trebuie sa aiba durata alocata (2.5s), chiar daca sursa e mai scurta (bucla)');

  const shotLongA = { itemIndex: 1, occurrence: 0, duration: 3, kenBurns: null };
  const shotLongB = { itemIndex: 1, occurrence: 1, duration: 3, kenBurns: null };
  const outLongA = await mod.renderShot({ type: 'video', localPath: longVideo }, shotLongA, 1, order);
  const outLongB = await mod.renderShot({ type: 'video', localPath: longVideo }, shotLongB, 2, order);
  const colorA = sampleColor(outLongA, 1.5);
  const colorB = sampleColor(outLongB, 1.5);
  assert.ok(colorA && colorB, 'ambele fragmente trebuie sa produca un cadru valid');
  const dist = Math.abs(colorA.r - colorB.r) + Math.abs(colorA.g - colorB.g) + Math.abs(colorA.b - colorB.b);
  assert.ok(dist > 30, `doua aparitii ale ACELUIASI videoclip lung trebuie sa extraga momente vizual diferite (distanta culoare ${dist}, A=${JSON.stringify(colorA)}, B=${JSON.stringify(colorB)})`);
});
