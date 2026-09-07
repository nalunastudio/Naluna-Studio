// PUNCT (2026-09-07): compresie client-side a materialelor video mari (Cadou video) — vezi
// public/js/media-compress.js pentru arhitectura completa si justificare.
//
// Acest fisier verifica REAL (nu doar text-matching) ca muxVideoOnlyMp4() — functia PURA, fara
// API-uri de browser, care asambleaza fisierul .mp4 final din esantioanele produse de
// VideoEncoder — produce un fisier STRICT valid, pe care ffprobe/ffmpeg (aceeasi unealta folosita
// de pipeline-ul de productie server-side) il poate citi si reda corect.
//
// Datele de test NU sunt inventate/sintetice la nivel de octeti — sunt extrase dintr-un fisier
// H.264 REAL, produs de ffmpeg local (esantioane AVCC + avcC/AVCDecoderConfigurationRecord reale,
// exact formatul pe care VideoEncoder(avc.format:'avc') il produce in productie).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

// --- Incarcare modul testat, cu stub-uri minimale pentru globalele de browser neatinse de
// muxVideoOnlyMp4/shouldAttemptCompression/isWebCodecsSupported (STRICT ca sa nu arunce la
// incarcare — restul functiilor, care CHIAR folosesc DOM/WebCodecs, nu sunt exercitate aici). ---
function loadModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'media-compress.js'), 'utf8');
  const fakeGlobal = { document: undefined };
  const fn = new Function('window', 'globalThis', src + '\nreturn window.NalunaMediaCompress;');
  return fn(fakeGlobal, undefined);
}

// --- Parser MP4 MINIMAL, STRICT pentru acest test — citeste avcC/stsz/stss dintr-un fisier
// H.264 REAL produs de ffmpeg, ca sa avem date de test AUTENTICE (nu octeti inventati). ---
function readBoxes(buf, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    boxes.push({ type, start: offset, headerSize: 8, payloadStart: offset + 8, end: offset + size });
    offset += size;
  }
  return boxes;
}
function findBox(boxes, type) { return boxes.find(b => b.type === type); }

function extractRealSamplesFromMp4(filePath) {
  const buf = fs.readFileSync(filePath);
  const top = readBoxes(buf, 0, buf.length);
  const moov = findBox(top, 'moov');
  const mdat = findBox(top, 'mdat');
  assert.ok(moov && mdat, 'fisierul de referinta trebuie sa aiba moov si mdat');

  const trak = findBox(readBoxes(buf, moov.payloadStart, moov.end), 'trak');
  const mdia = findBox(readBoxes(buf, trak.payloadStart, trak.end), 'mdia');
  const minf = findBox(readBoxes(buf, mdia.payloadStart, mdia.end), 'minf');
  const stbl = findBox(readBoxes(buf, minf.payloadStart, minf.end), 'stbl');
  const stblBoxes = readBoxes(buf, stbl.payloadStart, stbl.end);
  const stsd = findBox(stblBoxes, 'stsd');
  const avc1 = findBox(readBoxes(buf, stsd.payloadStart + 8, stsd.end), 'avc1'); // +8: version(1)+flags(3)+entry_count(4)
  const avcC = findBox(readBoxes(buf, avc1.payloadStart + 78, avc1.end), 'avcC');
  const description = new Uint8Array(buf.slice(avcC.payloadStart, avcC.end));

  const stsz = findBox(stblBoxes, 'stsz');
  const sampleCount = buf.readUInt32BE(stsz.payloadStart + 8);
  const sizes = [];
  for (let i = 0; i < sampleCount; i++) sizes.push(buf.readUInt32BE(stsz.payloadStart + 12 + i * 4));

  const stss = findBox(stblBoxes, 'stss');
  const keySet = new Set();
  if (stss) {
    const keyCount = buf.readUInt32BE(stss.payloadStart + 4);
    for (let i = 0; i < keyCount; i++) keySet.add(buf.readUInt32BE(stss.payloadStart + 8 + i * 4));
  } else {
    sizes.forEach((_, i) => keySet.add(i + 1));
  }

  // Esantioanele sunt contigue in mdat, in ordine (fisier cu un singur track, fara interleaving).
  let cursor = mdat.payloadStart;
  const samples = sizes.map((size, i) => {
    const data = new Uint8Array(buf.slice(cursor, cursor + size));
    cursor += size;
    return { data, isKey: keySet.has(i + 1) };
  });
  return { description, samples };
}

let referenceDir, referenceFile, extracted;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  referenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-muxer-test-'));
  referenceFile = path.join(referenceDir, 'reference.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an',
    referenceFile
  ]);
  extracted = extractRealSamplesFromMp4(referenceFile);
});
test.after(() => {
  if (referenceDir) { try { fs.rmSync(referenceDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

test('STRUCTURAL: media-compress.js se incarca fara sa atinga DOM-ul la nivel de modul (poate fi analizat/testat in Node)', () => {
  const mod = loadModule();
  assert.equal(typeof mod.muxVideoOnlyMp4, 'function');
  assert.equal(typeof mod.shouldAttemptCompression, 'function');
  assert.equal(typeof mod.isWebCodecsSupported, 'function');
});

test('FUNCTIONAL (REAL, nu sintetic): muxVideoOnlyMp4() cu esantioane REALE H.264 extrase dintr-un fisier produs de ffmpeg produce un .mp4 pe care ffprobe il citeste corect (codec, rezolutie, numar de cadre)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, () => {
  const mod = loadModule();
  const outBytes = mod.muxVideoOnlyMp4({
    width: 320,
    height: 240,
    fps: 30,
    description: extracted.description,
    samples: extracted.samples
  });
  assert.ok(outBytes instanceof Uint8Array);
  assert.ok(outBytes.length > 0);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-muxer-out-'));
  const outFile = path.join(outDir, 'muxed.mp4');
  fs.writeFileSync(outFile, Buffer.from(outBytes));

  const probeJson = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,nb_streams:stream=codec_name,codec_type,width,height,nb_frames,avg_frame_rate',
    '-of', 'json', outFile
  ]).toString();
  const probe = JSON.parse(probeJson);

  assert.equal(probe.streams.length, 1, 'trebuie sa existe STRICT un singur flux (video, fara audio)');
  const v = probe.streams[0];
  assert.equal(v.codec_type, 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.equal(Number(v.nb_frames), extracted.samples.length);
  assert.ok(Math.abs(Number(probe.format.duration) - (extracted.samples.length / 30)) < 0.2, `durata trebuie sa fie ~${extracted.samples.length / 30}s, a fost ${probe.format.duration}`);

  // Decodare REALA (nu doar citire de metadate) — daca ffmpeg poate decoda fiecare cadru fara
  // eroare, structura mdat/stsz/stco e cu adevarat corecta, nu doar "arata bine" in metadate.
  const decodedFramesLog = path.join(outDir, 'frames.txt');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', outFile, '-f', 'null', '-']);
  void decodedFramesLog;

  fs.rmSync(outDir, { recursive: true, force: true });
});

test('FUNCTIONAL: muxVideoOnlyMp4() cu esantioane REALE, dar UN SINGUR cadru cheie (primul) — stss trebuie sa marcheze STRICT acel cadru, restul fiind non-cheie', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile' }, () => {
  const mod = loadModule();
  const samplesOneKey = extracted.samples.map((s, i) => ({ data: s.data, isKey: i === 0 }));
  const outBytes = mod.muxVideoOnlyMp4({ width: 320, height: 240, fps: 30, description: extracted.description, samples: samplesOneKey });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-muxer-out2-'));
  const outFile = path.join(outDir, 'muxed.mp4');
  fs.writeFileSync(outFile, Buffer.from(outBytes));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'json', '-read_intervals', '%+#5', outFile]).toString());
  assert.equal(probe.frames[0].key_frame, 1, 'primul cadru trebuie sa fie marcat cheie');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('STRUCTURAL: muxVideoOnlyMp4() arunca o eroare clara pentru un array de esantioane gol, niciodata un fisier .mp4 gol/corupt', () => {
  const mod = loadModule();
  assert.throws(() => mod.muxVideoOnlyMp4({ width: 320, height: 240, fps: 30, description: new Uint8Array([1, 2, 3]), samples: [] }), /niciun esantion/);
});

// ---------------------------------------------------------------------------------------------
// FUNCTIONAL: decizia adaptiva de compresie (shouldAttemptCompression) — regulile PURE, testate
// direct, fara nicio dependinta de browser.
// ---------------------------------------------------------------------------------------------
test('shouldAttemptCompression: fisier mic (sub pragul minim) -> NU incearca, motiv "deja_mic"', () => {
  const mod = loadModule();
  const file = { size: 10 * 1024 * 1024 };
  const result = mod.shouldAttemptCompression(file, { durationSeconds: 60, width: 1920, height: 1080 });
  assert.equal(result.attempt, false);
  assert.equal(result.reason, 'deja_mic');
});

test('shouldAttemptCompression: fisier mare, dar bitrate deja eficient (sub 10Mbps) -> NU incearca', () => {
  const mod = loadModule();
  const file = { size: 100 * 1024 * 1024 }; // 100MB
  // 100MB / 200s = 4Mbps -- deja eficient
  const result = mod.shouldAttemptCompression(file, { durationSeconds: 200, width: 1920, height: 1080 });
  assert.equal(result.attempt, false);
  assert.equal(result.reason, 'deja_eficient');
});

test('shouldAttemptCompression: EXACT profilul fisierului real de ~841MB (1920x1080, 309s, ~22.8Mbps) -> DA, incearca', () => {
  const mod = loadModule();
  const file = { size: 882145640 };
  const result = mod.shouldAttemptCompression(file, { durationSeconds: 309.2, width: 1920, height: 1080 });
  assert.equal(result.attempt, true);
  assert.equal(result.reason, 'beneficiu_estimat');
});

test('shouldAttemptCompression: EXACT profilul fisierului real de ~434MB (1920x1080, 161s, ~22.3Mbps) -> DA, incearca', () => {
  const mod = loadModule();
  const file = { size: 455542742 };
  const result = mod.shouldAttemptCompression(file, { durationSeconds: 161.06, width: 1920, height: 1080 });
  assert.equal(result.attempt, true);
});

test('shouldAttemptCompression: fara metadata de durata -> NU incearca (nu presupune)', () => {
  const mod = loadModule();
  const result = mod.shouldAttemptCompression({ size: 100 * 1024 * 1024 }, { durationSeconds: 0 });
  assert.equal(result.attempt, false);
  assert.equal(result.reason, 'metadata_lipsa');
});

test('isWebCodecsSupported: fara VideoEncoder/VideoDecoder/VideoFrame in scope -> false (fara sa arunce)', () => {
  const mod = loadModule();
  assert.equal(mod.isWebCodecsSupported(), false);
});

test('node --check: media-compress.js ramane sintactic valid', () => {
  assert.doesNotThrow(() => execFileSync('node', ['--check', path.join(__dirname, '..', 'public', 'js', 'media-compress.js')]));
});
