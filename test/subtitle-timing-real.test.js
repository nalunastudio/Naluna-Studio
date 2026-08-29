// Test REAL (ffmpeg/libass, nu doar aritmetica interna) pentru CORECȚIA 2026-08-29,
// "eliminarea completa a introului 'Pentru Maria' si sincronizarea versurilor" — cerinta
// explicita: "adauga un test pe MP4 randat care demonstreaza: (1) zero text inainte de primul
// word.startS; (2) text prezent in intervalul unui vers; (3) zero text intr-o pauza
// instrumentala; (4) zero intro 'Pentru/For Maria'."
//
// Metoda: construieste alignedWords sintetice cu doua versuri separate de o pauza
// instrumentala de 4s, ruleaza buildCaptionLines()/toAss() REALE (extrase din server.js),
// randeaza DOUA videoclipuri scurte cu ffmpeg REAL — un fundal simplu FARA subtitrari
// (baseline) si acelasi fundal CU subtitrarile arse (libass, filtrul "subtitles=") — apoi
// esantioneaza REAL, la 4 momente cheie, o zona joasa a cadrului (zona sigura a versurilor,
// MarginV) si compara luminanta medie fata de baseline. Text alb-crem pe fundal aproape negru
// produce un contrast masurabil, robust la anti-aliasing/font fallback.
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

function loadCaptionModule() {
  const src = [
    extractFn('stripSpanningNotes'),
    extractConst('MAX_SINGLE_WORD_HOLD_SECONDS'),
    extractConst('CAPTION_PAUSE_SPLIT_SECONDS'),
    extractFn('buildCaptionLines'),
    extractFn('escapeAssText'),
    'const ASS_MAX_CHARS_PER_LINE = 30;',
    extractFn('wrapAssTextTwoLines'),
    extractFn('assTimestamp'),
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('ASS_STYLE_REFERENCE_WIDTH'),
    extractConst('ASS_STYLE_SCALE'),
    extractFn('scaledAssStyleValue'),
    extractFn('toAss'),
    'return { buildCaptionLines, toAss, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT };'
  ].join('\n\n');
  return new Function(src)();
}

let workDir;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-subtitle-timing-'));
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

function w(word, startS, endS, success = true) {
  return { word, startS, endS, success };
}

// Zona joasa a cadrului (safe-zone a versurilor, jur imprejurul MarginV=150/PlayResY=1280 —
// aprox 83% din inaltime — o banda ingusta, NU redimensionata, ca textul (o mica fractiune din
// suprafata benzii) sa nu fie diluat de niciun downscale). Numara ponderea pixelilor LUMINOSI
// (text alb-crem, luma>100) — pe un fundal aproape-negru uniform, aceasta ponderei e EXACT 0%
// cand nu exista text si sare masurabil la ~1% cand un cuvant e afisat (verificat direct, vezi
// istoricul de investigare — o medie de luminanta pe toata banda dilua semnalul prea mult).
function lyricZoneBrightPixelRatio(videoPath, timeSeconds, width, height) {
  const cropH = Math.round(height * 0.09);
  const cropY = Math.round(height * 0.83);
  const out = execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(timeSeconds), '-i', videoPath, '-frames:v', '1',
    '-vf', `crop=${width}:${cropH}:0:${cropY}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ]);
  let bright = 0;
  const pixelCount = out.length / 3;
  for (let i = 0; i < out.length; i += 3) {
    const luma = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
    if (luma > 100) bright++;
  }
  return bright / pixelCount;
}

test('SINCRONIZARE REALA a subtitrarilor (ffmpeg + libass): zero text inainte de primul cuvant, text prezent in vers, zero text in pauza instrumentala, zero intro "Pentru/For"', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 60000
}, () => {
  const { buildCaptionLines, toAss, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT } = loadCaptionModule();

  // Doua versuri REALE, separate de o pauza instrumentala de 4s (5.8 - 1.8 = 4s, mult peste
  // CAPTION_PAUSE_SPLIT_SECONDS) — exact structura ceruta de test.
  const alignedWords = [
    w('Primul ', 1.0, 1.4), w('vers\n', 1.4, 1.8),
    w('Al ', 5.8, 6.0), w('doilea ', 6.0, 6.3), w('vers', 6.3, 6.7)
  ];
  const lines = buildCaptionLines(alignedWords);
  assert.equal(lines.length, 2, 'trebuie sa rezulte exact doua cue-uri (cate un vers)');
  assert.equal(lines[0].start, 1.0);
  assert.equal(lines[1].end, 6.7);
  // dovada directa, la nivel de date, ca niciun cue introductiv nu a fost adaugat — primul cue
  // ESTE primul vers real, nu un text "Pentru X" plasat la momentul 0.
  assert.ok(!lines.some(l => /pentru|for /i.test(l.text)), 'niciun cue nu trebuie sa contina un text introductiv de tip "Pentru"/"For"');

  const assPath = path.join(workDir, 'captions.ass');
  fs.writeFileSync(assPath, toAss(lines), 'utf8');
  const assForFilter = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const durationSeconds = 8;
  const bgColor = '0x101010'; // aproape negru — contrast puternic fata de text alb-crem
  const baselinePath = path.join(workDir, 'baseline.mp4');
  const captionedPath = path.join(workDir, 'captioned.mp4');

  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${bgColor}:s=${MEMORY_VIDEO_WIDTH}x${MEMORY_VIDEO_HEIGHT}:d=${durationSeconds}:r=25`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', baselinePath
  ]);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${bgColor}:s=${MEMORY_VIDEO_WIDTH}x${MEMORY_VIDEO_HEIGHT}:d=${durationSeconds}:r=25`,
    '-vf', `subtitles='${assForFilter}'`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', captionedPath
  ]);

  // prag de detectie: ponderea pixelilor luminosi din zona versurilor — verificat direct
  // (istoricul de investigare a acestui test): fundalul uniform, fara text, produce EXACT 0%;
  // orice cuvant afisat produce >0.5% (masurat real: ~1.0-1.3%). 0.1% e un prag sigur, mult sub
  // semnalul real dar mult peste zgomotul de compresie al unui fundal solid.
  const BRIGHT_RATIO_THRESHOLD = 0.001;

  const ratioBeforeFirstWord = lyricZoneBrightPixelRatio(captionedPath, 0.3, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);
  const ratioDuringVerse1 = lyricZoneBrightPixelRatio(captionedPath, 1.2, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);
  const ratioDuringInstrumentalGap = lyricZoneBrightPixelRatio(captionedPath, 3.8, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);
  const ratioDuringVerse2 = lyricZoneBrightPixelRatio(captionedPath, 6.2, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);
  const ratioNearZero = lyricZoneBrightPixelRatio(captionedPath, 0.05, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);
  const ratioBaselineNoSubs = lyricZoneBrightPixelRatio(baselinePath, 1.2, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT);

  assert.ok(
    ratioBaselineNoSubs < BRIGHT_RATIO_THRESHOLD,
    `fundalul FARA subtitrari trebuie sa aiba 0 pixeli luminosi in zona versurilor (control) — masurat ${(ratioBaselineNoSubs * 100).toFixed(3)}%`
  );
  assert.ok(
    ratioBeforeFirstWord < BRIGHT_RATIO_THRESHOLD,
    `(1) ZERO text inainte de primul word.startS — la 0.3s (inainte de 1.0s) nu trebuie sa apara text, raport=${(ratioBeforeFirstWord * 100).toFixed(3)}%. O valoare ridicata aici ar demonstra ca introul "Pentru/For" INCA e randat.`
  );
  assert.ok(
    ratioDuringVerse1 >= BRIGHT_RATIO_THRESHOLD,
    `(2) text PREZENT in intervalul unui vers — la 1.2s (in interiorul 1.0-1.8s) trebuie sa apara text, raport=${(ratioDuringVerse1 * 100).toFixed(3)}%`
  );
  assert.ok(
    ratioDuringInstrumentalGap < BRIGHT_RATIO_THRESHOLD,
    `(3) ZERO text intr-o pauza instrumentala — la 3.8s (intre versul 1 si versul 2) nu trebuie sa apara text, raport=${(ratioDuringInstrumentalGap * 100).toFixed(3)}%`
  );
  assert.ok(
    ratioDuringVerse2 >= BRIGHT_RATIO_THRESHOLD,
    `text prezent si in al doilea vers (6.2s, in interiorul 5.8-6.7s), raport=${(ratioDuringVerse2 * 100).toFixed(3)}%`
  );
  // (4) zero intro "Pentru/For Maria": daca introul ar mai exista, ar fi randat EXACT intre 0 si
  // min(introEnd, 5) — adica ar acoperi si momentul 0.3s testat mai sus SI momentul 0.05s, foarte
  // aproape de inceputul absolut al videoclipului, cand primul vers real (1.0s) nu a inceput inca.
  assert.ok(
    ratioNearZero < BRIGHT_RATIO_THRESHOLD,
    `(4) ZERO intro "Pentru/For" — la 0.05s (inceputul absolut al videoclipului) nu trebuie sa apara niciun text, raport=${(ratioNearZero * 100).toFixed(3)}%`
  );
});
