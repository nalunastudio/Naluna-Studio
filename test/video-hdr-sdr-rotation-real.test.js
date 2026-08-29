// Teste REALE (ffmpeg/ffprobe) pentru CORECȚIA 2026-08-29, "verifica prin ffprobe daca
// materialele iPhone de test sunt SDR sau HDR" — cerinta explicita: "fixture SDR si HDR,
// rotatie iPhone si culori corecte".
//
// BUG REAL GASIT SI CORECTAT in timpul scrierii acestui test: ffprobe cu
// "-of default=noprint_wrappers=1:nokey=1" ignora COMPLET ordinea campurilor cerute in
// -show_entries si le intoarce in ordinea sa INTERNA CANONICA — verificat direct, pentru
// "stream=color_transfer,color_primaries,color_space" (exact campurile cerute de
// detectHdrVideo()), ffprobe intoarce efectiv color_space/color_transfer/color_primaries (alta
// ordine). Varianta initiala a detectHdrVideo() (destructurare pozitionala) ar fi citit
// valorile GRESIT — un fisier HDR real ar fi fost clasificat SDR, niciodata tonemapat, exact
// opusul cerintei. Corectat prin parsare "cheie=valoare" (-of default=noprint_wrappers=1),
// imuna la orice ordine — testele de mai jos verifica REZULTATUL final, nu doar codul sursa.
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

function loadModule() {
  const src = [
    "const { execFile } = require('node:child_process');",
    "const { promisify } = require('node:util');",
    "const execFileAsync = promisify(execFile);",
    extractConst('HDR_COLOR_TRANSFER_VALUES'),
    extractFn('detectHdrVideo'),
    extractConst('HDR_TONEMAP_FILTER'),
    "function perfLog() {}",
    extractFn('buildHdrToneMapFilterIfNeeded'),
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    extractConst('VIDEO_BT709_TAG_ARGS'),
    "async function execFfmpeg(args, options = {}) { return execFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 20*1024*1024, ...options }); }",
    extractFn('computeVideoSegmentStartOffset'),
    extractFn('getVideoSourceDurationSeconds'),
    'return { detectHdrVideo, buildHdrToneMapFilterIfNeeded, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT, VIDEO_BT709_TAG_ARGS };'
  ].join('\n\n');
  return new Function('require', src)(require);
}

let workDir;
let mod;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-hdr-sdr-'));
  mod = loadModule();
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

function ffprobeStreamFields(filePath, fields) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', `stream=${fields.join(',')}`,
    '-of', 'default=noprint_wrappers=1', filePath
  ]).toString();
  const result = {};
  out.trim().split('\n').forEach(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return;
    result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// FIXTURE SDR — marea majoritate a materialelor reale. Nu trebuie NICIODATA tonemapat.
// ---------------------------------------------------------------------------------------------
test('FIXTURA SDR: detectHdrVideo() intoarce isHdr=false, buildHdrToneMapFilterIfNeeded() nu aplica NICIUN filtru', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu'
}, async () => {
  const sdrPath = path.join(workDir, 'sdr.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:duration=1:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sdrPath
  ]);
  const info = await mod.detectHdrVideo(sdrPath);
  assert.equal(info.isHdr, false, `un material SDR normal nu trebuie clasificat HDR — info=${JSON.stringify(info)}`);
  const filter = await mod.buildHdrToneMapFilterIfNeeded(sdrPath, 'test-order-sdr', 0);
  assert.equal(filter, null, 'niciun tonemapping nu trebuie aplicat unui material SDR');
});

// ---------------------------------------------------------------------------------------------
// FIXTURE HDR (BT.2020 + PQ, semnalat de Dolby Vision/HDR10) — detectat REAL prin ffprobe pe
// fisierul REZULTAT, nu presupus din cum a fost construit fixture-ul.
// ---------------------------------------------------------------------------------------------
test('FIXTURA HDR (BT.2020/PQ): detectHdrVideo() intoarce isHdr=true; buildHdrToneMapFilterIfNeeded() aplica filtrul de tonemapping; renderShot()-ul REAL produce o iesire etichetata BT.709', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 30000
}, async () => {
  const hdrPath = path.join(workDir, 'hdr.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:duration=1:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    hdrPath
  ]);

  // verificare DIRECTA, independenta, ca fixture-ul chiar e HDR (nu doar presupus) — aceleasi
  // campuri, citite corect (dupa nume, imun la ordinea interna a ffprobe — vezi comentariul de
  // la inceputul fisierului).
  const rawFields = ffprobeStreamFields(hdrPath, ['color_transfer', 'color_primaries', 'color_space']);
  assert.equal(rawFields.color_transfer, 'smpte2084', 'fixture-ul de test trebuie sa fie cu adevarat marcat PQ');
  assert.equal(rawFields.color_primaries, 'bt2020', 'fixture-ul de test trebuie sa fie cu adevarat marcat BT.2020');

  const info = await mod.detectHdrVideo(hdrPath);
  assert.equal(info.isHdr, true, `un material HDR real (BT.2020+PQ) TREBUIE clasificat HDR — info=${JSON.stringify(info)}`);
  assert.equal(info.colorTransfer, 'smpte2084');
  assert.equal(info.colorPrimaries, 'bt2020');

  const filter = await mod.buildHdrToneMapFilterIfNeeded(hdrPath, 'test-order-hdr', 0);
  assert.ok(filter && filter.includes('tonemap='), 'filtrul de tonemapping trebuie aplicat pentru un material HDR real');

  // Randare REALA prin exact lantul de filtre folosit de renderShot() pentru materiale video —
  // confirma ca fisierul REZULTAT e cu adevarat etichetat BT.709 dupa tonemapping.
  const scaleFilter = `scale=${mod.MEMORY_VIDEO_WIDTH}:${mod.MEMORY_VIDEO_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${mod.MEMORY_VIDEO_WIDTH}:${mod.MEMORY_VIDEO_HEIGHT},fps=30`;
  const outPath = path.join(workDir, 'hdr-tonemapped-output.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', hdrPath, '-t', '1',
    '-vf', `${filter},${scaleFilter},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-an',
    ...mod.VIDEO_BT709_TAG_ARGS,
    outPath
  ]);
  const outFields = ffprobeStreamFields(outPath, ['color_transfer', 'color_primaries', 'color_space', 'width', 'height']);
  assert.equal(outFields.color_transfer, 'bt709', 'iesirea tonemapata trebuie etichetata EXPLICIT BT.709, niciodata lasata cu tag-urile HDR vechi');
  assert.equal(outFields.color_primaries, 'bt709');
  assert.equal(Number(outFields.width), mod.MEMORY_VIDEO_WIDTH);
  assert.equal(Number(outFields.height), mod.MEMORY_VIDEO_HEIGHT);
});

// ---------------------------------------------------------------------------------------------
// ROTATIE iPhone — clipurile filmate "portret" pe iPhone sunt stocate adesea cu pixeli in
// orientare landscape + metadata/matrice de afisare pentru rotatie; DECODORUL ffmpeg (nu codul
// nostru) respecta aceasta metadata si livreaza filtrelor un cadru DEJA orientat corect —
// comportament standard, documentat al libavformat/libavcodec, independent de pipeline-ul
// nostru. Ce testam AICI, cu adevarat relevant pentru codul propriu: ca lantul de filtre
// scale+crop din renderShot() NU introduce el insusi vreo rotatie/oglindire — un cadru PORTRET
// deja corect (asa cum il livreaza decodorul dupa auto-rotate) trebuie sa RAMANA cu aceeasi
// orientare dupa scale+crop, culorile pastrandu-si pozitiile relative (sus ramane sus).
// ---------------------------------------------------------------------------------------------
test('ROTATIE iPhone: un cadru PORTRET deja corect orientat (asa cum il livreaza decodorul dupa auto-rotate) isi pastreaza orientarea si culorile dupa scale+crop din renderShot()', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 30000
}, () => {
  // sursa: deja PORTRET (480x854, aproape 9:16) — jumatatea de SUS albastra, jumatatea de JOS
  // rosie (simuleaza exact ce livreaza decodorul ffmpeg dupa ce a aplicat auto-rotate pe un clip
  // filmat vertical pe iPhone, stocat cu pixeli landscape + matrice de rotatie).
  const portraitSource = path.join(workDir, 'portrait-source.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=480x427:d=1:rate=30',
    '-f', 'lavfi', '-i', 'color=c=red:s=480x427:d=1:rate=30',
    '-filter_complex', '[0:v][1:v]vstack=inputs=2[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    portraitSource
  ]);
  const srcFields = ffprobeStreamFields(portraitSource, ['width', 'height']);
  assert.ok(Number(srcFields.height) > Number(srcFields.width), 'fixture-ul de control trebuie sa fie deja portret (ca dupa auto-rotate real)');

  const scaleFilter = `scale=${mod.MEMORY_VIDEO_WIDTH}:${mod.MEMORY_VIDEO_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${mod.MEMORY_VIDEO_WIDTH}:${mod.MEMORY_VIDEO_HEIGHT},fps=30`;
  const outPath = path.join(workDir, 'portrait-output.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', portraitSource, '-t', '1',
    '-vf', `${scaleFilter},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-an',
    outPath
  ]);

  const outFields = ffprobeStreamFields(outPath, ['width', 'height']);
  assert.equal(Number(outFields.width), mod.MEMORY_VIDEO_WIDTH);
  assert.equal(Number(outFields.height), mod.MEMORY_VIDEO_HEIGHT, 'iesirea trebuie sa ramana portret (9:16)');

  function sampleAvgColor(videoPath, cropExpr) {
    const out = execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-frames:v', '1',
      '-vf', `${cropExpr},scale=8:8:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ]);
    let r = 0, g = 0, b = 0;
    const n = out.length / 3;
    for (let i = 0; i < out.length; i += 3) { r += out[i]; g += out[i + 1]; b += out[i + 2]; }
    return { r: r / n, g: g / n, b: b / n };
  }
  const topColor = sampleAvgColor(outPath, `crop=iw:ih*0.3:0:0`);
  const bottomColor = sampleAvgColor(outPath, `crop=iw:ih*0.3:0:ih*0.7`);
  assert.ok(topColor.b > topColor.r, `sus TREBUIE sa ramana albastru (nicio rotatie introdusa de scale+crop) — masurat ${JSON.stringify(topColor)}`);
  assert.ok(bottomColor.r > bottomColor.b, `jos TREBUIE sa ramana rosu (nicio rotatie introdusa de scale+crop) — masurat ${JSON.stringify(bottomColor)}`);
});
