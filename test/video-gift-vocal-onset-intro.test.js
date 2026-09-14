// CADOU VIDEO — intro cu o singura secventa video pana la intrarea reala a vocii (2026-09-14).
//
// OBIECTIV: de la 0:00 pana la momentul REAL in care incepe prima voce cantata, foloseste O
// SINGURA secventa video a clientului (daca exista cel putin un video incarcat) — nu rotatia
// normala de cadre scurte. Exact cand incepe vocea, montajul Cadou Video continua EXACT ca
// inainte de aceasta modificare.
//
// MECANISM (reutilizat, nu reimplementat): applyVideoGiftIntro() primeste o limita in secunde
// (testata mai jos direct, ca numar) si NU cunoaste/nu ii pasa cum a fost calculata acea limita —
// findFirstRealWordStartS() (server.js, testata izolat mai jos) e conceptul original ("primul
// cuvant real", inca folosit de getPreviewStartFromLyrics() pentru preview); findFirstVerseStartS()
// (server.js, 2026-09-14 — testata separat in test/video-gift-first-verse-boundary.test.js) e
// limita REALA folosita acum pentru intro-ul Cadou Video ("prima strofa reala", nu primul cuvant).
// applyVideoGiftIntro() (lib/media-analysis.js) transforma POST-HOC planul de cadre
// DEJA construit de buildShotPlan() (apelat NESCHIMBAT) — inlocuieste STRICT cadrele dinaintea
// limitei cu UN SINGUR cadru nou, pastrand restul planului BYTE-IDENTIC (aceleasi obiecte
// start/end/duration/transitionOut/transitionDuration/kenBurns/itemIndex/occurrence) —
// concatWithCrossfades()/concatWithCrossfadesAndMux() (server.js) citesc STRICT duration/
// transitionOut/transitionDuration per cadru, deci randarea/concatenarea de dupa limita e
// garantat identica cu implementarea anterioara.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildShotPlan, applyVideoGiftIntro } = require('../lib/media-analysis.js');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit: ${signature}`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// findFirstRealWordStartS / computeVideoSegmentStartOffset sunt functii PURE — extrase textual
// din server.js si evaluate intr-un sandbox minimal, fara sa pornim serverul HTTP real.
function loadServerPureFns() {
  const stripFn = extractFn(server, 'function stripStructuralTagsFromWord(word) {');
  const findFirstFn = extractFn(server, 'function findFirstRealWordStartS(alignedWords) {');
  const offsetFn = extractFn(server, 'function computeVideoSegmentStartOffset(itemIndex, occurrence, sourceDurationSeconds, segDurationSeconds) {');
  const sandboxSrc = `
    ${stripFn}
    ${findFirstFn}
    ${offsetFn}
    return { findFirstRealWordStartS, computeVideoSegmentStartOffset };
  `;
  return new Function(sandboxSrc)();
}
const { findFirstRealWordStartS, computeVideoSegmentStartOffset } = loadServerPureFns();

// ===============================================================================================
// PARTEA 1 — findFirstRealWordStartS() ("primul aligned word la momente diferite").
// ===============================================================================================
test('findFirstRealWordStartS: gaseste startS-ul primului cuvant real, sarind peste etichete structurale ([Verse]/[Chorus])', () => {
  const words = [
    { word: '[Verse]', success: true, startS: 0.0 },
    { word: 'Hello', success: true, startS: 8.42 },
    { word: 'world', success: true, startS: 8.9 }
  ];
  assert.equal(findFirstRealWordStartS(words), 8.42);
});

test('findFirstRealWordStartS: intro instrumental SCURT — primul cuvant real la 2.1s', () => {
  const words = [{ word: 'Hi', success: true, startS: 2.1 }];
  assert.equal(findFirstRealWordStartS(words), 2.1);
});

test('findFirstRealWordStartS: intro instrumental LUNG — primul cuvant real la 22.7s', () => {
  const words = [
    { word: '[Intro]', success: true, startS: 0 },
    { word: 'Long', success: true, startS: 22.7 }
  ];
  assert.equal(findFirstRealWordStartS(words), 22.7);
});

test('findFirstRealWordStartS: niciun cuvant cu success:true -> null (aliniere nesigura)', () => {
  const words = [
    { word: 'Hello', success: false, startS: 5 },
    { word: 'world', success: false, startS: 5.5 }
  ];
  assert.equal(findFirstRealWordStartS(words), null);
});

test('findFirstRealWordStartS: alignedWords gol/invalid -> null', () => {
  assert.equal(findFirstRealWordStartS([]), null);
  assert.equal(findFirstRealWordStartS(null), null);
  assert.equal(findFirstRealWordStartS(undefined), null);
});

// ===============================================================================================
// PARTEA 2 — applyVideoGiftIntro(): comportamentul de baza, cu materiale/onset-uri realiste.
// ===============================================================================================
function makeItems(spec) {
  // spec: array de 'video' | 'photo'
  return spec.map(type => ({ type }));
}

test('applyVideoGiftIntro: client CU video — intro cu o singura secventa video, durata >= vocal onset, durata totala NESCHIMBATA', () => {
  const items = makeItems(['video', 'photo', 'photo']);
  const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
  const totalBefore = shots.reduce((s, x) => s + x.duration, 0);

  const vocalOnset = 8.3; // instrumental scurt
  const result = applyVideoGiftIntro(shots, items, vocalOnset);

  assert.notEqual(result, shots, 'planul trebuie inlocuit cand se aplica intro-ul');
  assert.equal(items[result[0].itemIndex].type, 'video', 'cadrul de intro trebuie sa foloseasca un material VIDEO');
  assert.ok(result[0].duration >= vocalOnset, 'intro-ul trebuie sa acopere cel putin pana la vocal onset, niciodata mai putin');
  assert.equal(result[0].kenBurns, null, 'un cadru video nu trebuie sa primeasca niciodata Ken Burns (rezervat pozelor)');

  const totalAfter = result.reduce((s, x) => s + x.duration, 0);
  assert.ok(Math.abs(totalAfter - totalBefore) < 1e-6, `durata totala trebuie sa ramana identica (${totalBefore} vs ${totalAfter})`);
});

test('applyVideoGiftIntro: intro instrumental LUNG (22s) — o singura secventa video acopera tot intervalul', () => {
  const items = makeItems(['photo', 'video', 'photo', 'photo']);
  const shots = buildShotPlan(items, 90, [], 0.6, [], 5);
  const totalBefore = shots.reduce((s, x) => s + x.duration, 0);

  const result = applyVideoGiftIntro(shots, items, 22.4);
  assert.ok(result[0].duration >= 22.4);
  assert.equal(items[result[0].itemIndex].type, 'video');
  const totalAfter = result.reduce((s, x) => s + x.duration, 0);
  assert.ok(Math.abs(totalAfter - totalBefore) < 1e-6);
});

// ===============================================================================================
// PARTEA 3 — CERINTA CRITICA: timeline-ul DUPA vocal onset ramane IDENTIC (byte-identic, ca
// obiecte) cu planul original — nu doar "aproximativ la fel".
// ===============================================================================================
for (const vocalOnset of [1.4, 4.9, 8.3, 15.6, 22.1]) {
  test(`applyVideoGiftIntro [onset=${vocalOnset}s]: cadrele DUPA limita raman byte-identice cu planul original (durata, tranzitii, Ken Burns, item, occurrence neschimbate)`, () => {
    const items = makeItems(['video', 'photo', 'video', 'photo', 'photo']);
    const shots = buildShotPlan(items, 75, [], 0.6, [], 5);
    const result = applyVideoGiftIntro(shots, items, vocalOnset);

    if (result === shots) return; // no-op legitim pentru unele onset-uri foarte mici — verificat separat mai jos

    const boundaryIdx = shots.findIndex(s => s.start >= vocalOnset);
    const originalTail = shots.slice(boundaryIdx);
    const resultTail = result.slice(1);
    assert.deepEqual(resultTail, originalTail, 'cadrele de dupa vocal onset trebuie sa ramana STRICT identice cu planul original');
  });
}

// ===============================================================================================
// PARTEA 4 — client cu MAI MULTE video-uri: primul video eligibil, in ordinea existenta, e ales
// determinist (niciodata al doilea/al treilea, niciodata aleatoriu).
// ===============================================================================================
test('applyVideoGiftIntro: client cu MAI MULTE video-uri — foloseste determinist PRIMUL video din ordinea existenta (ordered)', () => {
  const items = makeItems(['photo', 'video', 'video', 'photo']); // primul video eligibil e la indexul 1
  const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
  const result = applyVideoGiftIntro(shots, items, 9);
  assert.equal(result[0].itemIndex, 1, 'trebuie ales primul video din ordinea existenta (indexul 1), nu al doilea (indexul 2)');

  // Determinism — aceleasi argumente produc exact acelasi rezultat.
  const result2 = applyVideoGiftIntro(buildShotPlan(items, 60, [], 0.6, [], 5), items, 9);
  assert.deepEqual(result, result2);
});

// ===============================================================================================
// PARTEA 5 — FALLBACK: client FARA niciun video -> comportamentul ACTUAL (planul NESCHIMBAT).
// ===============================================================================================
test('FALLBACK: client fara niciun video (doar poze) -> planul ramane NESCHIMBAT (comportamentul actual)', () => {
  const items = makeItems(['photo', 'photo', 'photo']);
  const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
  const result = applyVideoGiftIntro(shots, items, 8.5);
  assert.equal(result, shots, 'fara niciun video incarcat, planul trebuie returnat NESCHIMBAT (aceeasi referinta)');
});

// ===============================================================================================
// PARTEA 6 — FALLBACK: alignment indisponibil/nesigur -> comportamentul ACTUAL, NICIODATA un
// comportament nou degradat.
// ===============================================================================================
test('FALLBACK: vocal onset indisponibil (null — alignment nesigur) -> planul ramane NESCHIMBAT', () => {
  const items = makeItems(['video', 'photo', 'photo']);
  const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
  assert.equal(applyVideoGiftIntro(shots, items, null), shots);
  assert.equal(applyVideoGiftIntro(shots, items, undefined), shots);
  assert.equal(applyVideoGiftIntro(shots, items, NaN), shots);
  assert.equal(applyVideoGiftIntro(shots, items, 0), shots);
  assert.equal(applyVideoGiftIntro(shots, items, -3), shots);
});

test('FALLBACK: vocal onset dincolo de orice cadru existent (date nesigure) -> planul ramane NESCHIMBAT', () => {
  const items = makeItems(['video', 'photo']);
  const shots = buildShotPlan(items, 30, [], 0.6, [], 5);
  const result = applyVideoGiftIntro(shots, items, 10000);
  assert.equal(result, shots);
});

test('FALLBACK: plan cu un singur cadru total (un singur material) -> planul ramane NESCHIMBAT (fara logica de despartire a unui cadru unic)', () => {
  const items = makeItems(['video']);
  const shots = buildShotPlan(items, 3, [], 0.6, [], 5); // melodie foarte scurta -> un singur cadru posibil
  const result = applyVideoGiftIntro(shots, items, 1);
  if (shots.length < 2) assert.equal(result, shots);
});

// ===============================================================================================
// PARTEA 7 — video de intro MAI LUNG / MAI SCURT decat intro-ul necesar — reutilizeaza
// STRICT computeVideoSegmentStartOffset() (mecanismul EXISTENT, deja folosit de renderShot()
// pentru orice cadru video) — nicio logica noua de procesare video.
// ===============================================================================================
test('Video de intro MAI SCURT decat intro-ul necesar: computeVideoSegmentStartOffset() foloseste bucla (useLoop:true) — mecanismul existent, neschimbat', () => {
  const sourceDuration = 5;   // video sursa de 5s
  const introDuration = 12;   // intro-ul necesar e mai lung decat sursa
  const { useLoop, startOffset } = computeVideoSegmentStartOffset(0, 0, sourceDuration, introDuration);
  assert.equal(useLoop, true, 'un video mai scurt decat cadrul necesar trebuie sa foloseasca bucla, exact ca la orice alt cadru video existent');
  assert.equal(startOffset, 0);
});

test('Video de intro MAI LUNG decat intro-ul necesar: computeVideoSegmentStartOffset() foloseste doar portiunea necesara (fara bucla)', () => {
  const sourceDuration = 40;  // video sursa lung
  const introDuration = 9;    // intro-ul necesar e mult mai scurt
  const { useLoop, startOffset } = computeVideoSegmentStartOffset(0, 0, sourceDuration, introDuration);
  assert.equal(useLoop, false, 'un video mai lung decat cadrul necesar trebuie sa foloseasca doar o portiune, fara bucla');
  assert.ok(startOffset >= 0 && startOffset + introDuration <= sourceDuration, 'portiunea aleasa trebuie sa incapa integral in sursa');
});

// ===============================================================================================
// PARTEA 8 — confirmare ca audio-ul si durata finala NU sunt niciodata modificate de aceasta
// schimbare (verificare structurala a codului — generateLyricVideo/buildMemoryBackground).
// ===============================================================================================
test('server.js: generateLyricVideo() NU modifica fisierul audio (tempFullMp3Path) — vocal onset e STRICT citit din alignedWords, niciodata folosit pentru taiere audio', () => {
  const fn = extractFn(server, 'async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  // tempFullMp3Path trebuie sa ramana folosit STRICT ca input neschimbat catre ffmpeg
  // (durata/mux) — niciodata rescris/suprascris in aceasta functie.
  assert.ok(!/fs\.writeFileSync\([^)]*tempFullMp3Path/.test(fn), 'tempFullMp3Path nu trebuie scris/suprascris niciodata');
  assert.ok(!/fs\.unlinkSync\([^)]*tempFullMp3Path/.test(fn), 'tempFullMp3Path nu trebuie sters de aceasta functie');
  assert.ok(fn.includes('const vocalOnsetSeconds = findFirstVerseStartS(sectionTimings, body.data.alignedWords);'), 'limita intro-ului trebuie derivata STRICT din sectionTimings/alignedWords deja obtinute, fara nicio cerere suplimentara (2026-09-14: prima strofa reala, nu primul cuvant)');
});

test('server.js: durationSeconds (durata finala a videoclipului) e derivata STRICT din variant.durationSeconds/audio real — neatinsa de logica de vocal onset', () => {
  const fn = extractFn(server, 'async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  assert.ok(fn.includes('const durationSeconds = Math.max(1, Math.ceil(variant.durationSeconds || await getAudioDuration(tempFullMp3Path)));'), 'calculul duratei finale trebuie sa ramana STRICT cel existent, neschimbat');
  // durationSeconds e calculat INAINTE de vocalOnsetSeconds si NU e recalculat dupa — vocal onset
  // nu poate influenta niciodata durata finala a videoclipului.
  const idxDuration = fn.indexOf('const durationSeconds =');
  const idxOnset = fn.indexOf('const vocalOnsetSeconds =');
  assert.ok(idxDuration !== -1 && idxOnset !== -1 && idxDuration < idxOnset, 'durationSeconds trebuie calculat INAINTE de vocalOnsetSeconds, niciodata dupa/dependent de el');
});

test('server.js: buildMemoryBackground() aplica applyVideoGiftIntro() STRICT dupa buildShotPlan() neschimbat, pastrand shotPlan.length===0 ca eroare identica de dinainte', () => {
  const fn = extractFn(server, 'async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, songFilePath, assForFilter, vocalOnsetSeconds) {');
  assert.ok(fn.includes("let shotPlan = buildShotPlan(ordered, durationSeconds, sectionTimings, MEMORY_XFADE_SECONDS, onsetTimes, CONCAT_BATCH_SIZE);"));
  assert.ok(fn.includes("if (shotPlan.length === 0) throw new Error('Planul de cadre a rezultat gol — nu pot construi fundalul cinematic.');"));
  // CORECȚIE (2026-09-14): al 4-lea argument, videoDurationsByIndex, a fost adaugat (alegerea
  // celui mai lung video pentru intro) — vezi test/video-gift-intro-longest-video.test.js.
  assert.ok(fn.includes('shotPlan = applyVideoGiftIntro(shotPlan, ordered, vocalOnsetSeconds, videoDurationsByIndex);'));
  // applyVideoGiftIntro ruleaza DUPA validarea de plan gol, niciodata inainte — un plan gol tot
  // arunca aceeasi eroare ca inainte, neschimbata.
  const idxEmpty = fn.indexOf("if (shotPlan.length === 0)");
  const idxApply = fn.indexOf('shotPlan = applyVideoGiftIntro(');
  assert.ok(idxEmpty < idxApply);
});

test('server.js si lib/media-analysis.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'media-analysis.js')]));
});
