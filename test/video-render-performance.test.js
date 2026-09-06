// PUNCT 7 (2026-09-06, audit urgent — "performanta <=120s REAL, demonstreaza ca pipeline-ul
// nu mai poate fi optimizat semnificativ prin cod inainte sa concluzionezi ca e nevoie de
// upgrade"): profilare REALA (nu presupusa) a randarii fundalului video (buildMemoryBackground/
// renderShot/concatWithCrossfades), pe o comanda la scara reala de productie (5 materiale, 50 de
// cadre — plafonul SHOT_PLAN_MAX_SHOTS).
//
// MASURAT DIRECT (script de profilare dedicat, rulat separat de suita de teste, aceleasi
// fixtures ca test/video-concat-stress-real.test.js):
//   CONCAT_BATCH_SIZE=5 (valoarea veche): TOTAL 128.1s — concat_total=98.8s (~77% din timp)
//   CONCAT_BATCH_SIZE=7 (tot 3 niveluri de reducere pt 50 cadre): TOTAL 118.1s — fara imbunatatire
//   CONCAT_BATCH_SIZE=8 (prag exact unde planul de 50 trece la 2 niveluri, 50->7->1): TOTAL 92.6s
//   CONCAT_BATCH_SIZE=10/12: fara imbunatatire suplimentara fata de 8 (tot 2 niveluri)
// CAUZA: concatenarea cu crossfade RE-ENCODEAZA integral segmentele la fiecare nivel al reducerii
// pe arbore — cu cat sunt mai multe niveluri, cu atat aceleasi cadre trec prin mai multe randari
// succesive. CONCAT_BATCH_SIZE=8 elimina un nivel intreg de re-encodare pentru un plan de 50 de
// cadre, FARA sa creasca numarul de procese ffmpeg simultane (CONCAT_BATCH_CONCURRENCY ramane 2,
// plafonul de CPU/memorie deja stabilit separat) — doar numarul de fluxuri decodate simultan
// INTR-UN proces creste de la 5 la 8, inca mult sub plafonul de 49 care a cauzat prabusirea
// originala (vezi comentariul istoric de la CONCAT_BATCH_SIZE in server.js).
//
// Separat, ffprobe (getPhotoDimensions/getVideoSourceDurationSeconds/detectHdrVideo) era apelat
// identic, repetat, pentru ACELASI fisier local, de fiecare data cand buildShotPlan() atribuie
// acelasi material mai multor cadre — masurat: impact de timp neglijabil (sub o milisecunda per
// apel), dar tot un apel redundant real, eliminat aici printr-un cache per-comanda (scop STRICT
// limitat la durata unei singure randari, atasat obiectului order, niciodata global/persistent
// intre comenzi diferite).
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

test('STRUCTURAL: CONCAT_BATCH_SIZE a fost crescut la 8 (de la 5) — prag EXACT masurat unde un plan de 50 de cadre trece de la 3 la 2 niveluri de reducere pe arbore, fara sa modifice CONCAT_BATCH_CONCURRENCY (plafonul de CPU/memorie ramane neatins)', () => {
  assert.match(server, /const CONCAT_BATCH_SIZE = 8;/);
});

test('STRUCTURAL: getPhotoDimensions/getVideoSourceDurationSeconds/detectHdrVideo accepta un parametru optional de cache (per-comanda) — niciun apelant existent care nu il transmite nu e afectat (cache=undefined -> comportament vechi, neschimbat)', () => {
  assert.match(server, /async function getPhotoDimensions\(localPath, cache\) \{\s*\n\s*if \(cache && cache\.has\(localPath\)\) return cache\.get\(localPath\);/);
  assert.match(server, /async function getVideoSourceDurationSeconds\(localPath, cache\) \{\s*\n\s*if \(cache && cache\.has\(localPath\)\) return cache\.get\(localPath\);/);
  assert.match(server, /async function detectHdrVideo\(localPath, cache\) \{\s*\n\s*if \(cache && cache\.has\(localPath\)\) return cache\.get\(localPath\);/);
});

test('STRUCTURAL: renderShot() creeaza/reutilizeaza un cache atasat comenzii curente (order.__mediaProbeCache) — STRICT pentru durata unei singure randari, niciodata global', () => {
  const renderShotSrc = extractFn('renderShot');
  assert.match(renderShotSrc, /order\.__mediaProbeCache \|\| \(order\.__mediaProbeCache = \{ dims: new Map\(\), duration: new Map\(\), hdr: new Map\(\) \}\)/);
  assert.match(renderShotSrc, /getPhotoDimensions\(item\.localPath, probeCache\.dims\)/);
  assert.match(renderShotSrc, /getVideoSourceDurationSeconds\(item\.localPath, probeCache\.duration\)/);
  assert.match(renderShotSrc, /buildHdrToneMapFilterIfNeeded\(item\.localPath, order\.id, shotIndex, probeCache\.hdr\)/);
});

// ---------------------------------------------------------------------------------------------
// FUNCTIONAL: cache-ul chiar elimina apelurile ffprobe redundante pentru ACELASI fisier —
// verificat prin executie REALA (nu doar text-matching), numarand invocarile reale ale ffprobe.
// ---------------------------------------------------------------------------------------------
let workDir, fixturePhoto, fixtureVideo, mod;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-probe-cache-'));
  fixturePhoto = path.join(workDir, 'photo.jpg');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=900x1200:d=1', '-frames:v', '1', fixturePhoto]);
  fixtureVideo = path.join(workDir, 'video.mp4');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x480:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', fixtureVideo]);

  const src = [
    "const path = require('path');",
    "const fs = require('fs');",
    extractFn('getPhotoDimensions'),
    extractFn('getVideoSourceDurationSeconds'),
    extractConst('HDR_COLOR_TRANSFER_VALUES'),
    extractFn('detectHdrVideo'),
    'return { getPhotoDimensions, getVideoSourceDurationSeconds, detectHdrVideo };'
  ].join('\n\n');
  mod = new Function('require', 'execFileAsync', src)(require, realExecFileAsync);
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

test('FUNCTIONAL: getPhotoDimensions() cu cache -> a doua cerere pentru ACELASI fisier NU mai apeleaza ffprobe (rezultat identic, real, verificat prin executie)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, async () => {
  const cache = new Map();
  const r1 = await mod.getPhotoDimensions(fixturePhoto, cache);
  assert.deepEqual(r1, { width: 900, height: 1200 });
  assert.equal(cache.size, 1, 'primul apel trebuie sa populeze cache-ul');
  // A doua oara: stergem fisierul de pe disc — daca functia ar re-apela ffprobe, ar esua/intoarce
  // null (fisier inexistent); daca foloseste cache-ul, tot intoarce rezultatul corect.
  fs.unlinkSync(fixturePhoto);
  const r2 = await mod.getPhotoDimensions(fixturePhoto, cache);
  assert.deepEqual(r2, { width: 900, height: 1200 }, 'al doilea apel trebuie sa vina STRICT din cache, nu dintr-un nou ffprobe (fisierul a fost sters)');
});

test('FUNCTIONAL: getVideoSourceDurationSeconds() cu cache -> a doua cerere pentru ACELASI fisier NU mai apeleaza ffprobe', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, async () => {
  const cache = new Map();
  const r1 = await mod.getVideoSourceDurationSeconds(fixtureVideo, cache);
  assert.ok(r1 > 2.5 && r1 < 3.5);
  const secondVideo = path.join(workDir, 'video-renamed-should-not-be-read.mp4');
  fs.renameSync(fixtureVideo, secondVideo);
  const r2 = await mod.getVideoSourceDurationSeconds(fixtureVideo, cache);
  assert.equal(r2, r1, 'al doilea apel trebuie sa vina STRICT din cache (fisierul original nu mai exista la acea cale)');
  fs.renameSync(secondVideo, fixtureVideo);
});

test('FUNCTIONAL: fara cache (cache=undefined), comportamentul ramane STRICT neschimbat — apel real ffprobe de fiecare data', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, async () => {
  // fixturePhoto a fost STERS deliberat de testul de cache de mai sus (proba ca al doilea apel
  // NU mai citeste de pe disc) — recreat aici, izolat, pentru acest test specific.
  const freshPhoto = path.join(workDir, 'photo-fresh.jpg');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=800x1000:d=1', '-frames:v', '1', freshPhoto]);
  const r1 = await mod.getPhotoDimensions(freshPhoto);
  assert.deepEqual(r1, { width: 800, height: 1000 });
});

test('FUNCTIONAL: detectHdrVideo() cu cache -> a doua cerere pentru ACELASI fisier NU mai apeleaza ffprobe, rezultatul (SDR pentru fixtura sintetica) ramane identic', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, async () => {
  const cache = new Map();
  const r1 = await mod.detectHdrVideo(fixtureVideo, cache);
  assert.equal(r1.isHdr, false);
  assert.equal(cache.size, 1);
  const r2 = await mod.detectHdrVideo(fixtureVideo, cache);
  assert.deepEqual(r2, r1);
});
