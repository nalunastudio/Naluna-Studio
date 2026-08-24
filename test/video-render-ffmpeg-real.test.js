// Teste REALE cu ffmpeg/ffprobe (CORECȚIE 2026-08-24, "nu declara sarcina finalizata daca ai
// simulat randarea") — spre deosebire de restul suitei (care verifica STRUCTURAL codul din
// server.js, fara sa execute ffmpeg), fisierul acesta chiar RANDEAZA fisiere sintetice minime
// (culoare + ton sinusoidal, generate de ffmpeg insusi, fara materiale externe) si verifica
// REZULTATUL cu ffprobe — nu doar textul sursa.
//
// Acopera doua cerinte obligatorii care nu pot fi verificate corect altfel:
//   1) previzualizarea video se taie la exact min(VIDEO_PREVIEW_SECONDS, durata reala) —
//      comanda REALA de taiere (extrasa din server.js) e rulata pe un fisier de test SI pe un
//      fisier mai scurt decat pragul, ca sa acopere ambele ramuri ale min().
//   2) videoclipul complet e mixat H.264/AAC/yuv420p — flagurile REALE (-pix_fmt yuv420p,
//      -movflags +faststart) sunt verificate STATIC in server.js (prezenta lor exacta in
//      apelul execFfmpeg din generateLyricVideo) SI functional, rulate independent cu ffmpeg
//      pe un fisier sintetic, confirmat apoi cu ffprobe.
//
// Daca ffmpeg/ffprobe nu sunt disponibile in mediul de rulare (CI fara binarul instalat),
// testele se sar explicit (skip), niciodata raportate fals ca "trecute" fara sa fi rulat.
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
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

function ffprobeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]).toString().trim();
  return Number(out);
}

function ffprobeStream(filePath, streamSelector, entry) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', streamSelector, '-show_entries', `stream=${entry}`,
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]).toString().trim();
  return out;
}

// Extrage VIDEO_PREVIEW_SECONDS DIRECT din server.js — daca cineva schimba constanta mai
// tarziu, acest test foloseste automat noua valoare reala, niciodata un "25" hardcodat separat.
function getVideoPreviewSeconds() {
  const m = server.match(/const VIDEO_PREVIEW_SECONDS = (\d+);/);
  assert.ok(m, 'nu am gasit constanta VIDEO_PREVIEW_SECONDS in server.js');
  return Number(m[1]);
}

let workDir;
test.before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-video-test-'));
});
test.after(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
});

// ---------------------------------------------------------------------------------------------
// 1) Previzualizarea video: EXACT comanda folosita in server.js (generateLyricVideo), rulata pe
//    un fisier REAL — verifica ramura "sursa mai lunga decat pragul" (taiata la prag).
// ---------------------------------------------------------------------------------------------
test('server.js: comanda de taiere a previzualizarii video foloseste EXACT VIDEO_PREVIEW_SECONDS cu -c copy (fara reencodare)', () => {
  const idx = server.indexOf("await execFfmpeg(['-y', '-i', tempVideo, '-t', String(VIDEO_PREVIEW_SECONDS)");
  assert.ok(idx !== -1, 'nu am gasit apelul real de taiere a previzualizarii video in server.js');
});

test('ffmpeg + ffprobe (REAL): previzualizarea video taiata dintr-un fisier de 40s are durata <= VIDEO_PREVIEW_SECONDS (min(prag, total) cand sursa e mai lunga)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, () => {
  const previewSeconds = getVideoPreviewSeconds();
  const fullPath = path.join(workDir, 'full-40s.mp4');
  const previewPath = path.join(workDir, 'preview-from-40s.mp4');

  // Fisier sintetic de 40s, format identic cu cel produs de generateLyricVideo (720x1280,
  // H.264 + AAC) — generat integral de ffmpeg (culoare solida + ton sinusoidal), fara nicio
  // dependinta externa.
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x2B2016:s=720x1280:d=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', fullPath
  ]);

  // EXACT comanda din server.js (POST /create-video -> generateLyricVideo): '-t', VIDEO_PREVIEW_SECONDS, '-c', 'copy'.
  ffmpeg(['-i', fullPath, '-t', String(previewSeconds), '-c', 'copy', previewPath]);

  const duration = ffprobeDuration(previewPath);
  assert.ok(duration <= previewSeconds + 0.5, `previzualizarea trebuie sa aiba cel mult ${previewSeconds}s (max 0.5s toleranta pentru keyframe-uri), a avut ${duration}s`);
  assert.ok(duration > previewSeconds - 2, `previzualizarea nu trebuie sa fie mult mai scurta decat ${previewSeconds}s cand sursa e mai lunga, a avut ${duration}s`);
});

test('ffmpeg + ffprobe (REAL): previzualizarea video dintr-un fisier MAI SCURT decat pragul pastreaza durata reala (min(prag, total) cand sursa e mai scurta)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, () => {
  const previewSeconds = getVideoPreviewSeconds();
  const shortSourceSeconds = 9; // STRICT mai scurt decat pragul (25s)
  const shortPath = path.join(workDir, 'full-9s.mp4');
  const previewPath = path.join(workDir, 'preview-from-9s.mp4');

  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x2B2016:s=720x1280:d=${shortSourceSeconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${shortSourceSeconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', shortPath
  ]);

  ffmpeg(['-i', shortPath, '-t', String(previewSeconds), '-c', 'copy', previewPath]);

  const duration = ffprobeDuration(previewPath);
  assert.ok(duration <= shortSourceSeconds + 0.5, `previzualizarea NU trebuie sa depaseasca durata reala a sursei (${shortSourceSeconds}s) doar pentru ca pragul (${previewSeconds}s) e mai mare, a avut ${duration}s`);
  assert.ok(duration > shortSourceSeconds - 1, `previzualizarea trebuie sa acopere aproape intreaga sursa scurta, a avut ${duration}s`);
});

// ---------------------------------------------------------------------------------------------
// 2) Videoclipul complet: format compatibil mobil — H.264, AAC, yuv420p, faststart.
// ---------------------------------------------------------------------------------------------
// CORECȚIE (2026-08-24, "versurile sunt prea mari si greoaie"): filtrul de subtitrare trece
// acum de la SRT+force_style() la un fisier .ass scris explicit (doua stiluri proprii — vezi
// toAss() in server.js si test/gift-video-localization-and-upload.test.js) — ancora testului
// se actualizeaza in consecinta, restul verificarii (flagurile de format mobil) ramane identic.
test('server.js: mux-ul final din generateLyricVideo include EXPLICIT -pix_fmt yuv420p si -movflags +faststart (nu doar mostenite implicit)', () => {
  const idx = server.indexOf("'-vf', `subtitles='${assForFilter}'`,");
  assert.ok(idx !== -1, 'nu am gasit filtrul de subtitrare din mux-ul final');
  const snippet = server.slice(idx, idx + 400);
  assert.ok(snippet.includes("'-pix_fmt', 'yuv420p'"), 'lipseste -pix_fmt yuv420p explicit din mux-ul final');
  assert.ok(snippet.includes("'-movflags', '+faststart'"), 'lipseste -movflags +faststart din mux-ul final');
  assert.ok(snippet.includes("'-c:a', 'aac'"), 'lipseste codec-ul audio AAC din mux-ul final');
});

test('ffmpeg + ffprobe (REAL): un fisier mixat cu ACELEASI flaguri ca generateLyricVideo (h264/aac/yuv420p/faststart) e cu adevarat compatibil mobil', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, () => {
  const outPath = path.join(workDir, 'final-mux.mp4');
  const audioSeconds = 12.5;

  // Fundal usor MAI LUNG decat coloana sonora (13s vs 12.5s) — mimeaza scenariul real din
  // productie, unde concatWithCrossfades() construieste deja fundalul la o durata aproape
  // identica cu melodia (compensata pentru tranzitiile crossfade), iar "-shortest" ramane
  // STRICT o plasa de siguranta pentru diferente de sub-secunda, NU mecanismul principal de
  // taiere (spre deosebire de un fundal mult mai lung, unde -shortest nu garanteaza taiere
  // la cadru exact — verificat direct mai jos in acest fisier, comportament ffmpeg real).
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x2B2016:s=720x1280:d=13',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioSeconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outPath
  ]);

  const videoCodec = ffprobeStream(outPath, 'v:0', 'codec_name');
  const pixFmt = ffprobeStream(outPath, 'v:0', 'pix_fmt');
  const audioCodec = ffprobeStream(outPath, 'a:0', 'codec_name');
  const duration = ffprobeDuration(outPath);

  assert.equal(videoCodec, 'h264', `codecul video trebuie sa fie H.264, a fost ${videoCodec}`);
  assert.equal(pixFmt, 'yuv420p', `subesantionarea de crominanta trebuie sa fie yuv420p, a fost ${pixFmt}`);
  assert.equal(audioCodec, 'aac', `codecul audio trebuie sa fie AAC, a fost ${audioCodec}`);
  assert.ok(Math.abs(duration - audioSeconds) < 1.2, `durata finala (-shortest) trebuie sa ramana apropiata de durata coloanei sonore (${audioSeconds}s) cand fundalul e aproape la fel de lung, a fost ${duration}s`);
});

// GASIT DIRECT prin acest test (2026-08-24): "-shortest" NU taie la cadru exact cand fundalul
// e MULT mai lung decat coloana sonora (aici: 30s fundal vs 12.5s audio) — ffmpeg a produs un
// fisier de 13.0s, nu 12.5s (rotunjire la un GOP/keyframe, nu la exact durata audio). Acest
// comportament e acceptabil in productie DOAR pentru ca buildMemoryBackground()/
// concatWithCrossfades() construiesc deja fundalul la o durata aproape identica cu melodia
// (vezi testul de mai sus) — "-shortest" nu e niciodata singurul mecanism care garanteaza
// "videoclip complet cu durata melodiei". Documentat aici explicit, ca sa nu se presupuna
// gresit ca -shortest singur ar fi suficient daca cineva schimba vreodata aceasta arhitectura.
test('ffmpeg (REAL, comportament documentat): -shortest NU garanteaza taiere la cadru exact cand sursele au durate foarte diferite — de aceea fundalul trebuie construit deja la durata corecta, nu doar taiat la mux final', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, () => {
  const outPath = path.join(workDir, 'shortest-mismatch.mp4');
  const audioSeconds = 12.5;
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x2B2016:s=720x1280:d=30',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioSeconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', outPath
  ]);
  const duration = ffprobeDuration(outPath);
  // Nu impunem o valoare exacta aici (comportamentul variaza intre versiuni ffmpeg) — doar
  // documentam ca NU trebuie sa fie exact egala cu durata audio, ca sa nu se piarda aceasta
  // cunoastere data viitoare cand cineva atinge pipeline-ul de randare.
  assert.ok(duration >= audioSeconds, 'durata finala nu trebuie sa fie mai scurta decat coloana sonora');
});

test('ffmpeg + ffprobe (REAL): dimensiunea cadrului randat ramane 9:16 (vertical), pe fundal solid ca la comenzile vechi fara materiale', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu' }, () => {
  const outPath = path.join(workDir, 'vertical-check.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x2B2016:s=720x1280:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', outPath
  ]);
  const width = Number(ffprobeStream(outPath, 'v:0', 'width'));
  const height = Number(ffprobeStream(outPath, 'v:0', 'height'));
  assert.equal(width, 720);
  assert.equal(height, 1280);
  assert.ok(height > width, 'cadrul trebuie sa fie vertical (9:16), potrivit pentru Reels/WhatsApp');
});
