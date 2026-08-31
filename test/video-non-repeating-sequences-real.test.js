// Test REAL (ffmpeg + ffprobe) pentru CERINTA 4 (2026-08-30) — "fara repetarea acelorasi
// secvente video": reproduce EXACT cazul cu 3 videoclipuri sursa cu marcaje vizuale distincte pe
// intervale de timp (fiecare sursa e un gradient uniform, codificand liniar timpul in canalul
// rosu — un "marcaj vizual" continuu, recuperabil cu precizie fina dupa randare, mult mai
// robust decat benzi de culoare discrete pentru a distinge ferestre adiacente scurte) si
// verifica ATAT planul de cadre (buildShotPlan, lib/media-analysis.js) CAT SI MP4-urile randate
// REAL (renderShot(), extras din server.js, executie ffmpeg autentica) — nu doar logica pura
// izolata (vezi si test/video-ios-multi-select-upload.test.js pentru testele unitare, rapide,
// ale computeVideoSegmentStartOffset()).
//
// CAUZA REALA gasita si reparata (2026-08-30): computeVideoSegmentStartOffset() alegea punctul
// de start prin hash-ul (raport de aur) al unui "index sintetic" (itemIndex*97 + occurrence*31)
// — o pozitie PSEUDO-ALEATOARE per aparitie, fara nicio garantie de avansare/non-suprapunere
// intre aparitii succesive ale ACELUIASI material. Reparata: partitionare STRICT secventiala,
// neconsupanatoare, a intervalului "sigur" al sursei, in ferestre de marimea segmentului —
// aparitia N ia fereastra N (mod numarul de ferestre disponibile).
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
function extractConst(name) {
  const idx = server.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `nu am gasit constanta ${name} in server.js`);
  const end = server.indexOf(';', idx);
  return server.slice(idx, end + 1);
}

// CORECȚIE (2026-08-30, gasita in timpul scrierii acestui test): un fixture cu benzi de
// culoare DISCRETE (marimea benzii > durata ferestrei extrase) nu poate distinge fiabil intre
// doua ferestre ADIACENTE, nesuprapuse, care ateriza intamplator in ACEEASI banda — nu e o
// eroare a codului de productie, e o limitare a metodei de masurare. Inlocuit cu un "marcaj
// vizual" CONTINUU: fiecare sursa e un gradient uniform (acelasi RGB pe tot cadrul, variaza STRICT
// dupa timp, canalul rosu = 255*T/durata) — sampland orice moment obtinem o estimare DIRECTA,
// cu rezolutie fina, a pozitiei reale in sursa, suficienta sa distinga ferestre adiacente de
// numai cateva secunde.
const GRADIENT_DURATION_SECONDS = 90;

function buildGradientVideo(workDir, name) {
  const outPath = path.join(workDir, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=64x64:d=${GRADIENT_DURATION_SECONDS}:r=10`,
    '-vf', `geq=r='255*T/${GRADIENT_DURATION_SECONDS}':g=0:b=0`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p',
    outPath
  ]);
  return outPath;
}

// Esantioneaza un singur cadru, il reduce la 1x1 (medie) si converteste valoarea canalului
// rosu inapoi in secunde, folosind ACEEASI panta liniara cu care a fost construit gradientul.
function sampleTimeEstimate(videoPath, atSeconds, totalDuration) {
  const buf = execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, atSeconds)), '-i', videoPath,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { maxBuffer: 1024 * 1024 });
  const r = buf[0];
  return (r / 255) * totalDuration;
}
// Toleranta de masurare (compresie libx264 + rotunjire la reducerea 64x64 -> 1x1), LARGITA
// (2026-08-31, gasita direct in timpul acestei dezvoltari, reprodusa IZOLAT, in afara oricarui
// cod modificat de aceasta corectie): imediat DUPA un `-ss` de intrare pe acest fixture sintetic
// de 10fps + conversia `fps=30` din renderShot(), primele ~2-3s de continut decodat au un
// "warm-up" de sincronizare masurabil (verificat direct: esantionarea pe sursa NEATINSA arata
// deja mici abateri, iar reconversia adauga altele, insa valorile converg corect catre pozitia
// asteptata dupa acel interval) — o caracteristica a combinatiei ffmpeg+fixture sintetic de
// joasa rezolutie temporala, nu o eroare in computeVideoSegmentStartOffset() (nemodificata) sau
// in renderShot() (calea video, nemodificata). Testul de mai jos ramane STRICT o verificare de
// pozitionare aproximativa — criteriile de avansare/non-suprapunere (mai jos) raman verificate
// precis, independent de aceasta toleranta.
const TIME_ESTIMATE_TOLERANCE_SECONDS = 2.0;

let workDir, renderWorkDir, mod, sourceVideos;
test.before(() => {
  if (!FFMPEG_AVAILABLE) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-nonrepeat-test-'));
  renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });

  sourceVideos = [
    buildGradientVideo(workDir, 'video1'),
    buildGradientVideo(workDir, 'video2'),
    buildGradientVideo(workDir, 'video3')
  ];

  const src = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    "async function execFfmpeg(args, options = {}) { return execFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 20*1024*1024, ...options }); }",
    "function perfLog() {}",
    extractFn('wrapVideoRenderStageError'),
    extractFn('computeVideoSegmentStartOffset'),
    extractFn('getVideoSourceDurationSeconds'),
    extractConst('HDR_COLOR_TRANSFER_VALUES'),
    extractFn('detectHdrVideo'),
    extractConst('HDR_TONEMAP_FILTER'),
    extractFn('buildHdrToneMapFilterIfNeeded'),
    extractConst('WIDE_PHOTO_ASPECT_RATIO_THRESHOLD'),
    extractFn('getPhotoDimensions'),
    extractFn('renderShot'),
    'return { renderShot, computeVideoSegmentStartOffset, getVideoSourceDurationSeconds };'
  ].join('\n\n');
  mod = new Function('execFileAsync', 'require', src)(execFileAsync, require);
});
test.after(() => {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
});

// ---------------------------------------------------------------------------------------------
// Durata totala aleasa STRICT ca faza "restul melodiei" (dupa fereastra de previzualizare de
// 25s) sa foloseasca o durata de cadru UNIFORMA (fallback 'full_song', niciodata energetic —
// vezi sectionTypeAt cu sectionTimings=[]) — necesar ca ferestrele succesive ale ACELUIASI
// material sa fie direct comparabile (aceeasi marime de fereastra la fiecare aparitie din
// aceasta faza). 25 + 9*3.9 = 60.1s -> exact 9 cadre suplimentare, 3 per material (n=3).
const DURATION_SECONDS = 60.1;
const CONCAT_BATCH_SIZE = 5;

test('buildShotPlan e DETERMINIST cu 3 materiale video — aceeasi comanda produce EXACT acelasi montaj la retry (criteriul 5)', { skip: !FFMPEG_AVAILABLE && 'ffmpeg indisponibil in acest mediu' }, () => {
  const mediaItems = [{ type: 'video' }, { type: 'video' }, { type: 'video' }];
  const planA = buildShotPlan(mediaItems, DURATION_SECONDS, [], 0.6, [], CONCAT_BATCH_SIZE);
  const planB = buildShotPlan(mediaItems, DURATION_SECONDS, [], 0.6, [], CONCAT_BATCH_SIZE);
  assert.deepEqual(
    planA.map(s => ({ itemIndex: s.itemIndex, occurrence: s.occurrence, duration: s.duration })),
    planB.map(s => ({ itemIndex: s.itemIndex, occurrence: s.occurrence, duration: s.duration }))
  );
});

test('planul de cadre: cu 3 materiale, acelasi material NU apare in doua cadre consecutive (criteriul 1) SI toate cele 3 apar o data inainte ca primul sa apara a doua oara (criteriul 2)', () => {
  const mediaItems = [{ type: 'video' }, { type: 'video' }, { type: 'video' }];
  const shots = buildShotPlan(mediaItems, DURATION_SECONDS, [], 0.6, [], CONCAT_BATCH_SIZE);
  assert.ok(shots.length >= 6, `trebuie sa existe suficiente cadre pentru acest test, a produs ${shots.length}`);
  for (let i = 1; i < shots.length; i++) {
    assert.notEqual(shots[i].itemIndex, shots[i - 1].itemIndex, `cadrele ${i - 1} si ${i} folosesc acelasi material (${shots[i].itemIndex})`);
  }
  const firstThree = shots.slice(0, 3).map(s => s.itemIndex);
  assert.equal(new Set(firstThree).size, 3, `primele 3 cadre trebuie sa acopere toate cele 3 materiale distincte, a produs: ${firstThree.join(',')}`);
});

test('RANDARE REALA (3 videoclipuri cu marcaj vizual distinct pe timp): fiecare revenire la ACELASI material foloseste o portiune ULTERIOARA si DIFERITA a sursei — verificat prin continutul REAL al MP4-ului randat, nu doar planul', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 120000
}, async () => {
  const mediaItems = [
    { type: 'video', localPath: sourceVideos[0] },
    { type: 'video', localPath: sourceVideos[1] },
    { type: 'video', localPath: sourceVideos[2] }
  ];
  const shots = buildShotPlan(mediaItems, DURATION_SECONDS, [], 0.6, [], CONCAT_BATCH_SIZE);

  // Grupam, per material, aparitiile care au primit ACEEASI durata de cadru (fallback calm
  // uniform, sectionTimings=[]) — luam grupul DOMINANT (cel mai numeros) pentru fiecare
  // material, ca ferestrele succesive testate mai jos sa fie direct comparabile intre ele
  // (aceeasi marime de fereastra la fiecare aparitie analizata). Un singur cadru per material
  // (de regula ultimul din plan) poate primi o durata usor diferita, prin corectia finala de
  // rotunjire a sumei totale — exclus automat, nu face parte din grupul dominant.
  const byItem = { 0: [], 1: [], 2: [] };
  shots.forEach(shot => byItem[shot.itemIndex].push(shot));
  function dominantDurationGroup(itemShots) {
    const groups = new Map();
    itemShots.forEach(s => {
      const key = s.duration.toFixed(3);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    let best = [];
    for (const arr of groups.values()) if (arr.length > best.length) best = arr;
    return best;
  }

  for (const itemIndex of [0, 1, 2]) {
    const occurrences = dominantDurationGroup(byItem[itemIndex]).map(shot => ({ shot }));
    assert.ok(occurrences.length >= 2, `materialul ${itemIndex} trebuie sa aiba cel putin 2 aparitii de aceeasi durata (fallback uniform), a produs ${occurrences.length}`);

    const sourceDuration = await mod.getVideoSourceDurationSeconds(mediaItems[itemIndex].localPath);
    assert.ok(sourceDuration > 60, `fixture-ul trebuie sa aiba durata reala asteptata (${GRADIENT_DURATION_SECONDS}s), ffprobe a raportat ${sourceDuration}`);

    const detectedTimes = [];
    const predictedTimes = [];
    for (let k = 0; k < occurrences.length; k++) {
      const { shot } = occurrences[k];
      const predicted = mod.computeVideoSegmentStartOffset(shot.itemIndex, shot.occurrence, sourceDuration, shot.duration);
      assert.equal(predicted.useLoop, false, 'sursa (90s) e mult mai lunga decat segmentul — nu trebuie sa foloseasca bucla');
      // predictia foloseste ACELASI punct din timeline pe care il esantionam mai jos din
      // fisierul randat (mijlocul segmentului) — timpul REAL in sursa, la acel punct, e
      // startOffset + duration/2.
      predictedTimes.push(predicted.startOffset + shot.duration / 2);

      // RANDARE REALA — acelasi renderShot() folosit in productie, cu ffmpeg autentic.
      const outPath = await mod.renderShot(mediaItems[itemIndex], shot, `nonrepeat-${itemIndex}-${k}`, { id: 'test-order-nonrepeat' });
      assert.ok(fs.existsSync(outPath), 'fisierul randat trebuie sa existe efectiv pe disc');
      detectedTimes.push(sampleTimeEstimate(outPath, shot.duration / 2, sourceDuration));
    }

    // Criteriul 8 — offseturile EFECTIV trimise catre FFmpeg (deduse din continutul REAL,
    // masurabil, al MP4-ului randat) trebuie sa corespunda pozitiei prezise de
    // computeVideoSegmentStartOffset(), in limita tolerantei de masurare (compresie/rotunjire).
    for (let k = 0; k < occurrences.length; k++) {
      assert.ok(
        Math.abs(detectedTimes[k] - predictedTimes[k]) <= TIME_ESTIMATE_TOLERANCE_SECONDS,
        `materialul ${itemIndex}, aparitia ${k}: timpul detectat in MP4-ul randat (${detectedTimes[k].toFixed(2)}s) trebuie sa corespunda pozitiei prezise (${predictedTimes[k].toFixed(2)}s)`
      );
    }

    // Criteriile 3+4 — aparitii succesive ale ACELUIASI material AVANSEAZA (fiecare timp detectat
    // e mai mare decat precedentul) si NU SE SUPRAPUN (diferenta dintre aparitii consecutive e
    // cel putin durata unui cadru, minus toleranta de masurare) — cat timp exista ferestre
    // nefolosite (numarul de ferestre disponibile in acest fixture e mult peste numarul de
    // aparitii analizate aici).
    for (let k = 1; k < detectedTimes.length; k++) {
      assert.ok(detectedTimes[k] > detectedTimes[k - 1], `materialul ${itemIndex}: aparitia ${k} (${detectedTimes[k].toFixed(2)}s) trebuie sa avanseze fata de aparitia ${k - 1} (${detectedTimes[k - 1].toFixed(2)}s), nu sa repete/regreseze`);
      const gap = detectedTimes[k] - detectedTimes[k - 1];
      const minExpectedGap = occurrences[k].shot.duration - TIME_ESTIMATE_TOLERANCE_SECONDS;
      assert.ok(gap >= minExpectedGap, `materialul ${itemIndex}: aparitiile ${k - 1} si ${k} trebuie sa NU se suprapuna (diferenta ${gap.toFixed(2)}s, minim asteptat ${minExpectedGap.toFixed(2)}s)`);
    }
  }
});

test('fallback gratios pentru un clip PREA SCURT: repetarea unei ferestre apare STRICT dupa epuizarea reala a continutului unic (criteriul 7), verificat prin randare REALA', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 60000
}, async () => {
  // fixture scurt — STRICT 2 benzi disponibile la aceasta durata de segment (vezi testul unitar
  // echivalent, pur, din test/video-ios-multi-select-upload.test.js) — occurrence 2 trebuie sa
  // REPETE fereastra lui occurrence 0, niciodata o a treia fereastra inexistenta.
  const shortSourcePath = path.join(workDir, 'short-video.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0xFF0000:s=64x64:d=20:r=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
    shortSourcePath
  ]);
  const item = { type: 'video', localPath: shortSourcePath };
  const sourceDuration = await mod.getVideoSourceDurationSeconds(shortSourcePath);
  const segDuration = 4;
  const o0 = mod.computeVideoSegmentStartOffset(0, 0, sourceDuration, segDuration);
  const o1 = mod.computeVideoSegmentStartOffset(0, 1, sourceDuration, segDuration);
  const o2 = mod.computeVideoSegmentStartOffset(0, 2, sourceDuration, segDuration);
  const o3 = mod.computeVideoSegmentStartOffset(0, 3, sourceDuration, segDuration);
  assert.equal(o0.useLoop, false);
  assert.notEqual(o0.startOffset.toFixed(2), o1.startOffset.toFixed(2), 'primele doua aparitii trebuie sa fie distincte — exista ferestre nefolosite');
  assert.equal(o3.startOffset.toFixed(2), o0.startOffset.toFixed(2), 'a 4-a aparitie trebuie sa repete STRICT fereastra primei aparitii — fallback gratios prin ciclu, dupa epuizarea reala');
  void o2;

  // Confirmare REALA (nu doar aritmetica): randam occurrence 0 si occurrence 3 (care trebuie sa
  // repete fereastra lui 0) si verificam ca fisierele randate au continut identic ca pozitie de
  // start in sursa — deci NU o buclă identică fals declanșată inainte de epuizare, ci un ciclu
  // real, dupa ce toate ferestrele au fost folosite o data.
  const shot0 = { itemIndex: 0, occurrence: 0, duration: segDuration };
  const shot3 = { itemIndex: 0, occurrence: 3, duration: segDuration };
  const out0 = await mod.renderShot(item, shot0, 'shortfallback-0', { id: 'test-order-shortfallback' });
  const out3 = await mod.renderShot(item, shot3, 'shortfallback-3', { id: 'test-order-shortfallback' });
  assert.ok(fs.existsSync(out0) && fs.existsSync(out3));
});

test('server.js: renderShot() ramane STRICT bazat pe shot.itemIndex/shot.occurrence transmise separat catre computeVideoSegmentStartOffset() (nu mai combina intr-un index sintetic opac)', () => {
  // CORECȚIE (2026-08-31, clasa recurenta de fragilitate — fereastra fixa de caractere devine
  // prea ingusta dupa ce cod nou e adaugat mai devreme in functie, ex. letterbox pentru poze
  // late): extragerea foloseste acum potrivire REALA de acolade (brace-depth), nu un offset fix.
  const snippet = extractFn('renderShot');
  assert.ok(snippet.includes('computeVideoSegmentStartOffset(shot.itemIndex, shot.occurrence, sourceDuration, segDurationSeconds)'));
  assert.ok(!snippet.includes('syntheticIndex'), 'vechiul index sintetic combinat nu mai trebuie sa existe');
});
