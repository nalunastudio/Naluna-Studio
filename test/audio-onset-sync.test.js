// Teste pentru "REEL DINAMIC SINCRONIZAT CU MELODIA" (2026-08-24) — pana acum, ritmul taieturilor
// video folosea STRICT tipul de sectiune (refren/strofa) si durate fixe, fara nicio analiza a
// semnalului audio REAL al melodiei. Acest fisier verifica adaugarea unei analize audio usoare,
// LOCALE, DETERMINISTE (energie RMS + flux + alegere de maxime locale — "onset detection"), FARA
// niciun serviciu extern platit — vezi lib/media-analysis.js (detectOnsets, snapShotBoundariesToOnsets)
// si server.js (extractAudioOnsets, care decodeaza fisierul audio REAL al comenzii prin ffmpeg,
// deja o dependinta a proiectului).
//
// CERINTA EXPLICITA: "un test sintetic audio/click-track care demonstreaza MASURABIL alinierea
// taieturilor la impulsuri (nu doar numarul de cadre)" — testele de mai jos genereaza un fisier
// WAV real (impulsuri scurte la momente STIINTE dinainte), il decodeaza prin ffmpeg REAL (acelasi
// cod folosit in productie) si masoara distanta dintre impulsurile detectate/granitele planului
// de cadre si momentele reale ale click-urilor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const {
  detectOnsets,
  snapShotBoundariesToOnsets,
  buildShotPlan,
  computeRealBoundaryPositions,
  SHOT_PLAN_ONSET_MAX_SNAP_SECONDS
} = require('../lib/media-analysis');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// Generator PSEUDO-ALEATOR DETERMINIST (LCG, seed fix — NICIODATA Math.random(), ca sa ramana
// reproductibil identic la fiecare rulare) — folosit STRICT pentru "zgomot de fundal" in fixturi
// de test, cu energie aproape constanta in timp si fara periodicitate proprie (spre deosebire de
// o suma mica de sinusoide, care poate produce interferente/batai proprii, detectate gresit ca
// impulsuri de un detector de energie).
function makeDeterministicNoise(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1; // interval [-1, 1)
  };
}

// extractAudioOnsets() e o functie mica, auto-continuta (foloseste doar execFfmpeg + detectOnsets
// + perfLog) — extrasa textual din server.js si evaluata intr-un sandbox cu child_process REAL,
// fara sa importe server.js intreg (ar porni serverul HTTP real si ar cere DATABASE_URL).
// IMPORTANT: cauta acoladele de inchidere pornind DE LA SFARSITUL semnaturii cunoscute (care se
// termina deja cu '{', acolada de deschidere a corpului) — niciodata cu server.indexOf('{', ...),
// care ar gasi gresit prima acolada dintr-un parametru cu valoare implicita obiect (ex.
// `options = {}` la execFfmpeg), inainte de acolada reala a corpului functiei.
function sliceFunctionBody(server, fnSignatureEndingInBrace, fromIdx) {
  const start = server.indexOf(fnSignatureEndingInBrace, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignatureEndingInBrace}" in server.js`);
  let depth = 1, i = start + fnSignatureEndingInBrace.length; // acolada de deschidere deja numarata
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return { start, end: i + 1, text: server.slice(start, i + 1) };
}

function loadExtractAudioOnsets() {
  const server = read('server.js');
  const execFfmpegSnippet = sliceFunctionBody(server, 'async function execFfmpeg(args, options = {}) {').text;

  const onsetStart = server.indexOf('const ONSET_ANALYSIS_SAMPLE_RATE = 8000;');
  assert.ok(onsetStart !== -1, 'nu am gasit blocul extractAudioOnsets in server.js');
  const onsetFn = sliceFunctionBody(server, 'async function extractAudioOnsets(audioFilePath, orderId) {', onsetStart);
  const onsetSnippet = server.slice(onsetStart, onsetFn.end);

  const sandboxSrc = `
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const execFileAsync = promisify(execFile);
    const { detectOnsets } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'media-analysis.js'))});
    function perfLog() {}
    ${execFfmpegSnippet}
    ${onsetSnippet}
    return extractAudioOnsets;
  `;
  return new Function('require', sandboxSrc)(require);
}

const extractAudioOnsets = loadExtractAudioOnsets();

// Scrie un fisier WAV PCM 16-bit MONO real (header WAV minimal, scris manual — fara nicio
// biblioteca noua) — folosit ca fixtura de test, decodat apoi prin ffmpeg REAL (acelasi cod de
// productie), niciodata doar simulat in memorie.
function writeWavClickTrack(filePath, { sampleRate, durationSeconds, clickTimes, clickDurationSeconds }) {
  const totalSamples = Math.round(sampleRate * durationSeconds);
  const data = Buffer.alloc(totalSamples * 2);
  const bgNoise = makeDeterministicNoise(12345);
  for (let i = 0; i < totalSamples; i++) {
    // fundal foarte silentios, cu energie aproape constanta (zgomot pseudo-aleator determinist —
    // vezi makeDeterministicNoise mai sus).
    const bg = Math.round(bgNoise() * 40);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, bg)), i * 2);
  }
  const clickSamples = Math.round(sampleRate * clickDurationSeconds);
  for (const ct of clickTimes) {
    const start = Math.round(ct * sampleRate);
    for (let i = 0; i < clickSamples && (start + i) < totalSamples; i++) {
      const v = Math.round(Math.sin(i * 2.2) * 24000);
      data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), (start + i) * 2);
    }
  }
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `naluna-onset-test-${process.pid}-${name}`);
}

test('detectOnsets: click-track sintetic PUR (fara ffmpeg) — impulsurile detectate cad EXACT pe momentele stiute dinainte', () => {
  const sampleRate = 8000;
  const durationSec = 12;
  const n = sampleRate * durationSec;
  const samples = new Int16Array(n);
  const bgNoise1 = makeDeterministicNoise(777);
  for (let i = 0; i < n; i++) samples[i] = Math.round(bgNoise1() * 40);
  const clickTimes = [1.0, 2.6, 4.9, 7.3, 10.1];
  for (const ct of clickTimes) {
    const start = Math.round(ct * sampleRate);
    for (let i = 0; i < Math.round(0.03 * sampleRate); i++) {
      samples[start + i] = Math.round(Math.sin(i * 2.2) * 24000);
    }
  }
  const onsets = detectOnsets(samples, sampleRate);
  assert.equal(onsets.length, clickTimes.length, `trebuie detectate exact ${clickTimes.length} impulsuri, gasit ${onsets.length}: ${JSON.stringify(onsets)}`);
  clickTimes.forEach((ct, i) => {
    assert.ok(Math.abs(onsets[i] - ct) < 0.05, `impulsul ${i} trebuie sa fie la ~${ct}s, a fost detectat la ${onsets[i]}s`);
  });
});

test('detectOnsets: fara impulsuri reale (doar zgomot de fundal cu energie constanta) -> nicio detectie fals-pozitiva', () => {
  const sampleRate = 8000;
  const n = sampleRate * 5;
  const samples = new Int16Array(n);
  // zgomot de fundal cu energie aproape constanta in timp (pseudo-aleator determinist — vezi
  // makeDeterministicNoise mai sus; spre deosebire de un sinusoid pur, care are el insusi o
  // anvelopa RMS lent-variabila si ar declansa fals-pozitive la propriile lui cresteri naturale).
  const bgNoise2 = makeDeterministicNoise(999);
  for (let i = 0; i < n; i++) {
    samples[i] = Math.round(bgNoise2() * 40);
  }
  const onsets = detectOnsets(samples, sampleRate);
  assert.equal(onsets.length, 0, `zgomot cu energie constanta nu trebuie sa produca impulsuri false, gasit: ${JSON.stringify(onsets)}`);
});

test('detectOnsets: date insuficiente/invalide -> [] fara eroare', () => {
  assert.deepEqual(detectOnsets([], 8000), []);
  assert.deepEqual(detectOnsets(null, 8000), []);
  assert.deepEqual(detectOnsets(new Int16Array(5), 8000), []); // prea putine cadre
  assert.deepEqual(detectOnsets(new Int16Array(1000), 0), []);
});

test('extractAudioOnsets (ffmpeg REAL): decodeaza un WAV real cu click-uri la momente stiute si detecteaza impulsurile corecte', async () => {
  const wavPath = tmpFile('clicktrack.wav');
  const clickTimes = [0.8, 2.4, 5.0, 7.7, 9.3];
  writeWavClickTrack(wavPath, { sampleRate: 44100, durationSeconds: 11, clickTimes, clickDurationSeconds: 0.03 });
  try {
    const onsets = await extractAudioOnsets(wavPath, 'test-order-onset');
    assert.equal(onsets.length, clickTimes.length, `trebuie detectate exact ${clickTimes.length} impulsuri prin ffmpeg real, gasit ${onsets.length}: ${JSON.stringify(onsets)}`);
    clickTimes.forEach((ct, i) => {
      assert.ok(Math.abs(onsets[i] - ct) < 0.08, `impulsul ${i} trebuie sa fie la ~${ct}s, a fost detectat la ${onsets[i]}s (decodat prin ffmpeg real)`);
    });
  } finally {
    fs.unlinkSync(wavPath);
  }
});

test('extractAudioOnsets (ffmpeg REAL): fisier audio inexistent/corupt -> [] controlat, niciodata o exceptie care sa opreasca randarea', async () => {
  const onsets = await extractAudioOnsets(tmpFile('nu-exista.mp3'), 'test-order-missing');
  assert.deepEqual(onsets, []);
});

// ---------------------------------------------------------------------------------------------
// ALINIEREA TAIETURILOR — nu doar ca se detecteaza impulsuri, ci ca buildShotPlan() chiar
// MUTA granitele cadrelor mai aproape de impulsuri fata de planul fara analiza audio.
// ---------------------------------------------------------------------------------------------

function fakeMediaItems(count) {
  return new Array(count).fill(0).map((_, i) => ({ itemIndex: i, mediaType: 'photo', section: null }));
}

test('snapShotBoundariesToOnsets: granitele INTERIOARE se muta la cel mai apropiat impuls aflat in raza permisa (masurat prin pozitia REALA post-xfade, nu suma cumulativa naiva); prima/ultima granita raman FIXE', () => {
  const shots = [
    { start: 0, end: 3, duration: 3 },
    { start: 3, end: 6, duration: 3 },
    { start: 6, end: 9, duration: 3 },
    { start: 9, end: 12, duration: 3 }
  ];
  const xfade = 0.6;
  // CORECȚIE (audit independent, runda 2): granita REALA (dupa comprimarea xfade) intre cadrul 1
  // si 2 NU e suma cumulativa naiva (6) — e computeRealBoundaryPositions()[1]. Impulsul e plasat
  // langa ACEA pozitie reala, nu langa suma naiva.
  const realBefore = computeRealBoundaryPositions(shots, xfade, 5);
  const target = realBefore[1] + 0.2; // in raza de 0.35s
  snapShotBoundariesToOnsets(shots, [target], xfade, 5);
  assert.equal(shots[0].start, 0, 'inceputul primului cadru trebuie sa ramana 0');
  assert.equal(shots[3].end, 12, 'finalul ultimului cadru trebuie sa ramana neschimbat');
  const realAfter = computeRealBoundaryPositions(shots, xfade, 5);
  assert.ok(Math.abs(realAfter[1] - target) < 1e-9, `granita reala 1 trebuie mutata la impulsul tinta (${target}), a ramas la ${realAfter[1]}`);
  assert.ok(Math.abs(realAfter[0] - realBefore[0]) < 1e-9, 'granita reala 0 (neafectata) trebuie sa ramana neschimbata');
  assert.ok(Math.abs(realAfter[2] - realBefore[2]) < 1e-9, 'granita reala 2 (neafectata) trebuie sa ramana neschimbata');
  assert.equal(shots[1].end, shots[2].start, 'granitele consecutive trebuie sa ramana lipite (fara goluri/suprapuneri)');
  const totalDuration = shots.reduce((s, sh) => s + sh.duration, 0);
  assert.ok(Math.abs(totalDuration - 12) < 1e-9, 'durata totala trebuie sa ramana EXACT neschimbata');
});

test('snapShotBoundariesToOnsets: un impuls prea departe (peste SHOT_PLAN_ONSET_MAX_SNAP_SECONDS) de pozitia REALA NU muta granita', () => {
  const shots = [
    { start: 0, end: 3, duration: 3 },
    { start: 3, end: 6, duration: 3 }
  ];
  const xfade = 0.6;
  const realBefore = computeRealBoundaryPositions(shots, xfade, 5);
  const farOnset = realBefore[0] + SHOT_PLAN_ONSET_MAX_SNAP_SECONDS + 0.2;
  snapShotBoundariesToOnsets(shots, [farOnset], xfade, 5);
  const realAfter = computeRealBoundaryPositions(shots, xfade, 5);
  assert.ok(Math.abs(realAfter[0] - realBefore[0]) < 1e-9, 'un impuls prea indepartat de pozitia reala nu trebuie sa mute granita');
});

test('snapShotBoundariesToOnsets: fara impulsuri -> planul ramane STRICT neschimbat (fallback explicit)', () => {
  const shots = [{ start: 0, end: 3, duration: 3 }, { start: 3, end: 6, duration: 3 }];
  const before = JSON.stringify(shots);
  snapShotBoundariesToOnsets(shots, []);
  assert.equal(JSON.stringify(shots), before);
  snapShotBoundariesToOnsets(shots, null);
  assert.equal(JSON.stringify(shots), before);
});

test('computeRealBoundaryPositions: la 50 de cadre, diferenta fata de suma cumulativa naiva (shots[i].end) e de ordinul zecilor de secunde — motivul EXACT al corectiei (audit independent, runda 2)', () => {
  const durationSeconds = 200;
  const media = fakeMediaItems(5);
  const sectionTimings = [{ sectionType: 'full_song', sectionIndex: 0, startTime: 0, endTime: durationSeconds, source: 'fallback' }];
  const xfade = 0.6;
  const plan = buildShotPlan(media, durationSeconds, sectionTimings, xfade); // fara onsets — planul de baza
  assert.ok(plan.length >= 45, `testul are nevoie de un plan cu multe cadre (~50), a obtinut ${plan.length}`);
  const naive = plan.slice(0, -1).map(s => s.end);
  const real = computeRealBoundaryPositions(plan, xfade, 5);
  const lastDiff = naive[naive.length - 1] - real[real.length - 1];
  assert.ok(lastDiff > 15, `diferenta la ultima granita trebuie sa fie mare (cauza reala a bug-ului) — a fost doar ${lastDiff.toFixed(2)}s`);
  // granita 0 (primul boundary, in acelasi lot — nicio compunere pe niveluri inca) trebuie sa
  // ramana aproape neschimbata — confirma ca diferenta CRESTE odata cu adancimea in ierarhie,
  // nu e un offset constant aplicat peste tot.
  assert.ok(Math.abs(naive[0] - real[0]) < 1, 'prima granita (fara compunere pe niveluri) trebuie sa fie aproape neschimbata');
});

// NOTA: testul care compara STRICT granitele naive (shots[i].end) inainte/dupa aliniere la
// impuls a fost ELIMINAT (audit independent, runda 2 — era "circular", compara logica interna
// cu ea insasi, fara nicio dovada ca alinierea corespunde REALITATII din fisierul video randat).
// Inlocuit de test/video-onset-alignment-real.test.js — randeaza EFECTIV un fundal complet (pana
// la 50 de cadre), extrage impulsuri REALE dintr-un fisier audio real (click-track WAV) prin
// ffmpeg, si masoara DIRECT, in MP4-ul rezultat, cat de aproape ajung schimbarile vizuale
// detectate de click-urile audio cunoscute.
