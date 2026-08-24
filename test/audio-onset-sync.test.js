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

test('snapShotBoundariesToOnsets: granitele INTERIOARE se muta la cel mai apropiat impuls aflat in raza permisa; prima/ultima granita raman FIXE', () => {
  const shots = [
    { start: 0, end: 3, duration: 3 },
    { start: 3, end: 6, duration: 3 },
    { start: 6, end: 9, duration: 3 },
    { start: 9, end: 12, duration: 3 }
  ];
  // impuls real la 6.2s, foarte aproape de granita 6 (a doua granita interioara)
  const onsets = [6.2];
  snapShotBoundariesToOnsets(shots, onsets);
  assert.equal(shots[0].start, 0, 'inceputul primului cadru trebuie sa ramana 0');
  assert.equal(shots[3].end, 12, 'finalul ultimului cadru trebuie sa ramana neschimbat');
  assert.ok(Math.abs(shots[1].end - 6.2) < 1e-9, `granita 3->6 trebuie mutata la impuls (6.2), a ramas la ${shots[1].end}`);
  assert.equal(shots[1].end, shots[2].start, 'granitele consecutive trebuie sa ramana lipite (fara goluri/suprapuneri)');
  const totalDuration = shots[shots.length - 1].end - shots[0].start;
  assert.ok(Math.abs(totalDuration - 12) < 1e-9, 'durata totala trebuie sa ramana EXACT neschimbata');
});

test('snapShotBoundariesToOnsets: un impuls prea departe (peste SHOT_PLAN_ONSET_MAX_SNAP_SECONDS) NU muta granita', () => {
  const shots = [
    { start: 0, end: 3, duration: 3 },
    { start: 3, end: 6, duration: 3 }
  ];
  const farOnset = 3 + SHOT_PLAN_ONSET_MAX_SNAP_SECONDS + 0.2;
  snapShotBoundariesToOnsets(shots, [farOnset]);
  assert.equal(shots[0].end, 3, 'un impuls prea indepartat nu trebuie sa mute granita');
});

test('snapShotBoundariesToOnsets: fara impulsuri -> planul ramane STRICT neschimbat (fallback explicit)', () => {
  const shots = [{ start: 0, end: 3, duration: 3 }, { start: 3, end: 6, duration: 3 }];
  const before = JSON.stringify(shots);
  snapShotBoundariesToOnsets(shots, []);
  assert.equal(JSON.stringify(shots), before);
  snapShotBoundariesToOnsets(shots, null);
  assert.equal(JSON.stringify(shots), before);
});

test('buildShotPlan: cu onsetTimes reale (click-track sintetic), granitele cadrelor sunt MASURABIL mai aproape de impulsuri decat fara analiza audio', () => {
  const durationSeconds = 40;
  const media = fakeMediaItems(3);
  const sectionTimings = [{ sectionType: 'full_song', sectionIndex: 0, startTime: 0, endTime: durationSeconds, source: 'fallback' }];
  const xfade = 0.6;

  const planWithoutAudio = buildShotPlan(media, durationSeconds, sectionTimings, xfade);
  // impulsuri sintetice, plasate DELIBERAT langa cateva din granitele existente fara analiza
  // audio, dar NU exact pe ele (simuleaza un "beat" real, usor deplasat fata de durata fixa).
  const boundariesWithoutAudio = planWithoutAudio.slice(0, -1).map(s => s.end);
  const syntheticOnsets = boundariesWithoutAudio
    .filter((_, i) => i % 2 === 0) // doar jumatate din granite au un impuls "real" apropiat
    .map(b => b + 0.15); // impuls la +0.15s fata de granita bazata pe durata fixa

  const planWithAudio = buildShotPlan(media, durationSeconds, sectionTimings, xfade, syntheticOnsets);

  assert.equal(planWithAudio.length, planWithoutAudio.length, 'numarul de cadre trebuie sa ramana IDENTIC — doar pozitia taieturii se ajusteaza, cerinta explicita');
  const totalWithout = planWithoutAudio[planWithoutAudio.length - 1].end;
  const totalWith = planWithAudio[planWithAudio.length - 1].end;
  assert.ok(Math.abs(totalWith - totalWithout) < 1e-6, 'durata totala trebuie sa ramana identica cu/fara analiza audio');

  // masurare directa: pentru fiecare impuls sintetic, distanta pana la CEA MAI APROPIATA granita
  // interioara trebuie sa fie strict mai mica in planul CU analiza audio decat in cel FARA.
  function nearestBoundaryDistance(plan, t) {
    const boundaries = plan.slice(0, -1).map(s => s.end);
    return Math.min(...boundaries.map(b => Math.abs(b - t)));
  }
  let improved = 0;
  for (const onset of syntheticOnsets) {
    const distWithout = nearestBoundaryDistance(planWithoutAudio, onset);
    const distWith = nearestBoundaryDistance(planWithAudio, onset);
    assert.ok(distWith <= distWithout + 1e-9, `impulsul la ${onset}s trebuie sa fie la fel de aproape sau mai aproape de o granita in planul cu analiza audio (fara=${distWithout}, cu=${distWith})`);
    if (distWith < distWithout - 1e-6) improved++;
  }
  assert.ok(improved > 0, 'cel putin o granita trebuie MASURABIL mutata mai aproape de un impuls real — nu doar acelasi numar de cadre');
});
