// Test REAL (ffmpeg SSIM/PSNR) pentru CORECȚIA 2026-08-29, "calitate video clara, potrivita
// pentru iPhone/Reels" — cerinta explicita: "fixture cu detalii fine si comparatie SSIM/PSNR
// fata de sursa/baseline". Demonstreaza MASURABIL ca noile setari (VIDEO_INTERMEDIATE_CRF=18 +
// scalare Lanczos) produc o calitate vizuala superioara vechilor setari (CRF 28, scalare
// implicita/bilinear), fata de o referinta de calitate foarte ridicata (CRF 0, acelasi lant de
// filtre) — izoleaza STRICT variabila sub test (CRF/scalare), pastrand identic restul lantului
// (acelasi Ken Burns, aceeasi rezolutie/fps reale, extrase din server.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

function extractConst(name) {
  const idx = server.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `nu am gasit constanta ${name} in server.js`);
  const end = server.indexOf(';', idx);
  const literal = server.slice(idx, end + 1);
  return new Function(`${literal}\nreturn ${name};`)();
}

const MEMORY_VIDEO_WIDTH = extractConst('MEMORY_VIDEO_WIDTH');
const MEMORY_VIDEO_HEIGHT = extractConst('MEMORY_VIDEO_HEIGHT');
const MEMORY_VIDEO_FPS_FOR_TEST = extractConst('MEMORY_VIDEO_FPS');
const VIDEO_INTERMEDIATE_CRF = extractConst('VIDEO_INTERMEDIATE_CRF');

let workDir;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-ssim-psnr-'));
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

// Acelasi Ken Burns folosit real de renderShot() (vezi KEN_BURNS_VARIANTS.zoom_in_center in
// lib/media-analysis.js) — izoleaza STRICT variabila sub test (CRF/scalare), pastrand identic
// miscarea de zoom pentru toate cele 3 variante randate mai jos (referinta, vechi, nou).
const KB = { z: 'min(zoom+0.0018,1.15)', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
const CLIP_SECONDS = 0.4; // scurt — un singur cadru extras conteaza, restul e doar pentru zoompan

function renderPhotoVariant(sourcePath, outPath, { scaleFlags, preset, crf }) {
  const frames = Math.round(CLIP_SECONDS * MEMORY_VIDEO_FPS_FOR_TEST);
  const scaleFilter = scaleFlags
    ? `scale=${MEMORY_VIDEO_WIDTH * 2}:${MEMORY_VIDEO_HEIGHT * 2}:force_original_aspect_ratio=increase:flags=${scaleFlags}`
    : `scale=${MEMORY_VIDEO_WIDTH * 2}:${MEMORY_VIDEO_HEIGHT * 2}:force_original_aspect_ratio=increase`;
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-i', sourcePath, '-t', String(CLIP_SECONDS),
    '-vf', `${scaleFilter},crop=${MEMORY_VIDEO_WIDTH * 2}:${MEMORY_VIDEO_HEIGHT * 2},zoompan=z='${KB.z}':x='${KB.x}':y='${KB.y}':d=${frames}:s=${MEMORY_VIDEO_WIDTH}x${MEMORY_VIDEO_HEIGHT}:fps=${MEMORY_VIDEO_FPS_FOR_TEST},format=yuv420p`,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-an',
    outPath
  ]);
}

function extractFirstFrame(videoPath, framePath) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-frames:v', '1', framePath]);
}

function measureSsimPsnr(candidateFramePath, referenceFramePath) {
  const { execFileSync: exec } = require('node:child_process');
  const out = exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'info',
    '-i', candidateFramePath, '-i', referenceFramePath,
    '-lavfi', '[0:v][1:v]ssim=stats_file=-;[0:v][1:v]psnr=stats_file=-',
    '-f', 'null', '-'
  ], { encoding: 'utf8' }).toString();
  const ssimMatch = out.match(/All:([\d.]+)/);
  const psnrMatch = out.match(/psnr_avg:([\d.]+)/);
  assert.ok(ssimMatch, `nu am putut extrage scorul SSIM din output-ul ffmpeg: ${out}`);
  assert.ok(psnrMatch, `nu am putut extrage scorul PSNR din output-ul ffmpeg: ${out}`);
  return { ssim: Number(ssimMatch[1]), psnr: Number(psnrMatch[1]) };
}

test('SSIM/PSNR REAL: noile setari (CRF intermediar + scalare Lanczos) produc o calitate MASURABIL mai buna decat vechile setari (CRF 28, scalare implicita), fata de o referinta de calitate foarte ridicata', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 30000
}, () => {
  // Fixture cu DETALII FINE — testsrc2 contine gradiente, texte si tipare cu frecventa spatiala
  // ridicata, mult mai sensibile la compresie/scalare de proasta calitate decat o poza simpla.
  const sourcePath = path.join(workDir, 'fine-detail-source.jpg');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1200x1600:duration=1`,
    '-frames:v', '1', sourcePath
  ]);

  const referenceVideo = path.join(workDir, 'reference.mp4');
  const oldVideo = path.join(workDir, 'old-settings.mp4');
  const newVideo = path.join(workDir, 'new-settings.mp4');

  // REFERINTA — acelasi lant de filtre (scalare+crop+zoompan), calitate foarte ridicata
  // (CRF 0, aproape lossless) — punctul de comparatie pentru ambele variante de mai jos.
  renderPhotoVariant(sourcePath, referenceVideo, { scaleFlags: 'lanczos', preset: 'veryslow', crf: 0 });
  // VECHI — setarile de INAINTE de aceasta corectie (CRF 28, scalare implicita/bilinear).
  renderPhotoVariant(sourcePath, oldVideo, { scaleFlags: null, preset: 'ultrafast', crf: 28 });
  // NOU — setarile REALE curente (VIDEO_INTERMEDIATE_CRF, extras din server.js) + Lanczos.
  renderPhotoVariant(sourcePath, newVideo, { scaleFlags: 'lanczos', preset: 'ultrafast', crf: VIDEO_INTERMEDIATE_CRF });

  const referenceFrame = path.join(workDir, 'reference-frame.png');
  const oldFrame = path.join(workDir, 'old-frame.png');
  const newFrame = path.join(workDir, 'new-frame.png');
  extractFirstFrame(referenceVideo, referenceFrame);
  extractFirstFrame(oldVideo, oldFrame);
  extractFirstFrame(newVideo, newFrame);

  const oldScore = measureSsimPsnr(oldFrame, referenceFrame);
  const newScore = measureSsimPsnr(newFrame, referenceFrame);

  console.log(`[SSIM/PSNR] vechi(CRF28,bilinear): SSIM=${oldScore.ssim} PSNR=${oldScore.psnr}dB | nou(CRF${VIDEO_INTERMEDIATE_CRF},lanczos): SSIM=${newScore.ssim} PSNR=${newScore.psnr}dB`);

  assert.ok(newScore.ssim > oldScore.ssim, `SSIM trebuie sa fie MASURABIL mai mare cu noile setari fata de vechile setari — vechi=${oldScore.ssim}, nou=${newScore.ssim}`);
  assert.ok(newScore.psnr > oldScore.psnr, `PSNR trebuie sa fie MASURABIL mai mare cu noile setari fata de vechile setari — vechi=${oldScore.psnr}dB, nou=${newScore.psnr}dB`);
  assert.ok(newScore.ssim > 0.9, `noile setari trebuie sa produca o calitate apropiata de referinta (SSIM > 0.9), a fost ${newScore.ssim}`);
});
