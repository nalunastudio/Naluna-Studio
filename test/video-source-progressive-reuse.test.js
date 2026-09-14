// CADOU VIDEO — reutilizare PROGRESIVA a portiunilor unui video sursa (2026-09-14).
//
// PROBLEMA: computeVideoSegmentStartOffset() (NESCHIMBATA, vezi mai jos) recalculeaza
// `numWindows` din segDurationSeconds la FIECARE apel — daca aparitii succesive ale ACELUIASI
// material au durate de cadru DIFERITE (cazul REAL, obisnuit: ~2.2-2.7s in fereastra de
// previzualizare, ~2.6-3.9s dupa aceea), grilele de ferestre NU se aliniaza intre aparitii —
// pot produce start-uri identice/suprapuse, desi exista inca portiuni nefolosite din sursa.
//
// REPARATIE: computeVideoProgressByShot() calculeaza, dintr-o singura trecere peste planul de
// cadre FINAL (deja complet cunoscut inainte de orice randare), suma REALA (secunde) a
// duratelor tuturor cadrelor ANTERIOARE care folosesc ACELASI material. computeVideoStart
// OffsetFromProgress() foloseste aceasta suma (nu occurrence) ca sa avanseze secvential prin
// sursa, cu ACEEASI logica de marje ca inainte — repeta STRICT dupa epuizarea reala.
//
// ARHITECTURA MONTAJULUI NU S-A SCHIMBAT: buildShotPlan()/applyVideoGiftIntro() (ordine,
// frecventa, durate, tranzitii, numar de cadre) raman NEATINSE — se schimba STRICT ce portiune
// temporala a unui video sursa e extrasa la randare.
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

function loadPureFns() {
  const progressFn = extractFn(server, 'function computeVideoProgressByShot(shots) {');
  const offsetFn = extractFn(server, 'function computeVideoStartOffsetFromProgress(consumedSecondsSoFar, sourceDurationSeconds, segDurationSeconds) {');
  const oldOffsetFn = extractFn(server, 'function computeVideoSegmentStartOffset(itemIndex, occurrence, sourceDurationSeconds, segDurationSeconds) {');
  const sandboxSrc = `
    ${progressFn}
    ${offsetFn}
    ${oldOffsetFn}
    return { computeVideoProgressByShot, computeVideoStartOffsetFromProgress, computeVideoSegmentStartOffset };
  `;
  return new Function(sandboxSrc)();
}
const { computeVideoProgressByShot, computeVideoStartOffsetFromProgress, computeVideoSegmentStartOffset } = loadPureFns();

// ===============================================================================================
// PARTEA 1 — exemplul conceptual din cerinta: video de 30s, shot-uri de ~6s, 5 aparitii.
// ===============================================================================================
test('exemplul conceptual: video 30s, shot-uri ~6s — aparitiile avanseaza secvential (0-6, 6-12, 12-18...), fara suprapunere, pana la epuizare', () => {
  const shots = [
    { itemIndex: 0, duration: 6 }, { itemIndex: 0, duration: 6 }, { itemIndex: 0, duration: 6 },
    { itemIndex: 0, duration: 6 }, { itemIndex: 0, duration: 6 }
  ];
  const progress = computeVideoProgressByShot(shots);
  assert.deepEqual(progress, [0, 6, 12, 18, 24]);

  const sourceDuration = 30;
  const offsets = shots.map((s, i) => computeVideoStartOffsetFromProgress(progress[i], sourceDuration, s.duration));
  // Primele 4 aparitii trebuie sa avanseze STRICT secvential, fara suprapunere.
  for (let i = 1; i < 4; i++) {
    assert.ok(offsets[i].startOffset >= offsets[i - 1].startOffset + shots[i - 1].duration - 0.01,
      `aparitia ${i} (${offsets[i].startOffset}) trebuie sa continue dupa aparitia ${i - 1} (${offsets[i - 1].startOffset}+${shots[i - 1].duration})`);
  }
  // A 5-a aparitie a epuizat continutul util (24s cumulate > safeSpan-ul disponibil) — se reia
  // gratios (wrap), niciodata o eroare/cadru lipsa.
  assert.ok(offsets[4].startOffset >= 0 && offsets[4].startOffset + 6 <= sourceDuration + 0.01);
});

// ===============================================================================================
// PARTEA 2 — shot-uri cu durate DIFERITE intre aparitii (cazul real care rupea mecanismul vechi).
// ===============================================================================================
test('shot-uri cu durate DIFERITE (2.2s, apoi 3.9s, apoi 2.6s...) — progresul cumulativ ramane corect, fara suprapunere', () => {
  const shots = [
    { itemIndex: 0, duration: 2.2 },
    { itemIndex: 0, duration: 3.9 },
    { itemIndex: 0, duration: 2.6 },
    { itemIndex: 0, duration: 3.9 }
  ];
  const progress = computeVideoProgressByShot(shots);
  assert.deepEqual(progress, [0, 2.2, 6.1, 8.7]);

  const sourceDuration = 60;
  const offsets = shots.map((s, i) => computeVideoStartOffsetFromProgress(progress[i], sourceDuration, s.duration));
  for (let i = 1; i < offsets.length; i++) {
    const prevEnd = offsets[i - 1].startOffset + shots[i - 1].duration;
    assert.ok(offsets[i].startOffset >= prevEnd - 0.01, `aparitia ${i} (start ${offsets[i].startOffset}) se suprapune cu aparitia precedenta (sfarsit ${prevEnd})`);
  }
});

// ===============================================================================================
// PARTEA 3 — doua video-uri diferite -> progres complet INDEPENDENT (video A nu afecteaza
// offset-ul video B).
// ===============================================================================================
test('doua video-uri diferite: progresul e complet independent — folosirea video A nu afecteaza offset-ul video B', () => {
  const shots = [
    { itemIndex: 0, duration: 5 }, // A
    { itemIndex: 1, duration: 4 }, // B
    { itemIndex: 0, duration: 5 }, // A din nou
    { itemIndex: 1, duration: 4 }, // B din nou
    { itemIndex: 0, duration: 5 }  // A a treia oara
  ];
  const progress = computeVideoProgressByShot(shots);
  assert.deepEqual(progress, [0, 0, 5, 4, 10], 'A: 0,5,10 — B: 0,4 — complet independente, indiferent de ordinea intercalata');
});

test('determinism: aceleasi shot-uri produc EXACT acelasi progres si aceleasi offset-uri (nicio randomizare)', () => {
  const shots = [{ itemIndex: 0, duration: 4 }, { itemIndex: 0, duration: 5 }, { itemIndex: 0, duration: 4 }];
  const p1 = computeVideoProgressByShot(shots);
  const p2 = computeVideoProgressByShot(shots.map(s => ({ ...s })));
  assert.deepEqual(p1, p2);
  const o1 = computeVideoStartOffsetFromProgress(p1[2], 40, 4);
  const o2 = computeVideoStartOffsetFromProgress(p2[2], 40, 4);
  assert.deepEqual(o1, o2);
});

// ===============================================================================================
// PARTEA 4 — video FOARTE SCURT: mecanismul existent de bucla (useLoop) functioneaza neschimbat.
// ===============================================================================================
test('video foarte scurt (sursa < durata cadrului): foloseste bucla existenta (useLoop:true), indiferent de progresul cumulativ', () => {
  const r1 = computeVideoStartOffsetFromProgress(0, 3, 6);
  assert.equal(r1.useLoop, true);
  assert.equal(r1.startOffset, 0);
  const r2 = computeVideoStartOffsetFromProgress(50, 3, 6); // progres mare, tot bucla
  assert.equal(r2.useLoop, true);
  assert.equal(r2.startOffset, 0);
  const r3 = computeVideoStartOffsetFromProgress(0, null, 6); // durata sursa necunoscuta (ffprobe esuat)
  assert.equal(r3.useLoop, true);
});

// ===============================================================================================
// PARTEA 5 — video CONSUMAT COMPLET: comportament SIGUR la reutilizare (wrap gratios, fara cadre
// lipsa, fara eroare).
// ===============================================================================================
test('video consumat complet (progres cumulat >> continutul util disponibil): reutilizeaza gratios, fara eroare, fara cadru lipsa', () => {
  const sourceDuration = 20;
  const segDuration = 4;
  for (const hugeProgress of [16, 50, 200, 10000]) {
    const r = computeVideoStartOffsetFromProgress(hugeProgress, sourceDuration, segDuration);
    assert.equal(r.useLoop, false);
    assert.ok(Number.isFinite(r.startOffset), `startOffset trebuie sa fie un numar valid pentru progres=${hugeProgress}`);
    assert.ok(r.startOffset >= 0 && r.startOffset + segDuration <= sourceDuration + 0.01, `fereastra trebuie sa incapa in sursa pentru progres=${hugeProgress}`);
  }
});

test('video consumat complet: dupa epuizare, urmatoarele aparitii reincep sa se suprapuna gratios cu ferestre deja folosite, niciodata o eroare', () => {
  const sourceDuration = 20;
  const segDuration = 4; // safeSpan ~13.4s -> continutul unic se epuizeaza dupa ~3-4 aparitii de 4s
  const shots = Array.from({ length: 8 }, () => ({ itemIndex: 0, duration: segDuration }));
  const progress = computeVideoProgressByShot(shots);
  const offsets = progress.map(p => computeVideoStartOffsetFromProgress(p, sourceDuration, segDuration).startOffset);
  // Toate ferestrele trebuie sa ramana valide (in interiorul sursei), indiferent de epuizare.
  offsets.forEach(o => assert.ok(Number.isFinite(o) && o >= 0 && o + segDuration <= sourceDuration + 0.01));
  // Primele ferestre (cat timp continutul unic nu s-a epuizat) NU se suprapun.
  for (let i = 1; i < 3; i++) {
    const overlap = offsets[i] < offsets[i - 1] + segDuration;
    assert.ok(!overlap, `aparitiile ${i - 1} si ${i} nu trebuie sa se suprapuna inainte de epuizare`);
  }
  // DUPA epuizarea continutului unic (safeSpan ~13.4s < suma cumulata a mai multor aparitii),
  // cel putin o pereche de ferestre trebuie sa se suprapuna — reutilizare gratioasa, nu o a treia
  // fereastra inexistenta inventata din senin.
  let foundOverlapAfterExhaustion = false;
  for (let a = 0; a < offsets.length && !foundOverlapAfterExhaustion; a++) {
    for (let b = a + 1; b < offsets.length; b++) {
      if (offsets[a] < offsets[b] + segDuration && offsets[b] < offsets[a] + segDuration) {
        foundOverlapAfterExhaustion = true;
        break;
      }
    }
  }
  assert.ok(foundOverlapAfterExhaustion, 'dupa epuizarea reala a continutului unic, reutilizarea trebuie sa se manifeste (suprapunere cu o fereastra anterioara), niciodata o eroare/cadru lipsa');
});

// ===============================================================================================
// PARTEA 6 — interactiunea cu intro-ul Cadou Video (commit 3b75f64): portiunea consumata in
// intro e tratata ca "deja folosita" pentru urmatoarea aparitie a ACELUIASI video, FARA nicio
// modificare a applyVideoGiftIntro().
// ===============================================================================================
test('intro Cadou Video: portiunea consumata de intro e considerata "deja folosita" pentru urmatoarea aparitie a aceluiasi video, fara sa modifice applyVideoGiftIntro()', () => {
  const items = [{ type: 'video' }, { type: 'photo' }, { type: 'photo' }];
  const originalShots = buildShotPlan(items, 60, [], 0.6, [], 5);
  const withIntro = applyVideoGiftIntro(originalShots, items, 8.3);
  assert.notEqual(withIntro, originalShots, 'intro-ul trebuie sa se activeze pentru acest test');

  const progress = computeVideoProgressByShot(withIntro);
  // primul cadru (intro-ul) are progres 0 (nimic consumat inainte de el).
  assert.equal(progress[0], 0);
  // orice aparitie ULTERIOARA a ACELUIASI item (video, itemIndex 0) trebuie sa porneasca de la
  // suma REALA deja consumata (introdusa de intro), niciodata de la 0 din nou.
  const introItemIndex = withIntro[0].itemIndex;
  const laterSameItemIdx = withIntro.findIndex((s, i) => i > 0 && s.itemIndex === introItemIndex);
  if (laterSameItemIdx !== -1) {
    assert.ok(progress[laterSameItemIdx] >= withIntro[0].duration, `aparitia ulterioara a videoclipului de intro trebuie sa continue de la cel putin ${withIntro[0].duration}s (durata intro-ului), a primit ${progress[laterSameItemIdx]}`);
  }
});

test('intro-ul Cadou Video (commit 3b75f64) ramane NESCHIMBAT — applyVideoGiftIntro() nu a fost modificata de aceasta corectie', () => {
  const mediaAnalysisSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-analysis.js'), 'utf8');
  assert.ok(mediaAnalysisSrc.includes('function applyVideoGiftIntro(shots, mediaItems, vocalOnsetSeconds) {'), 'semnatura applyVideoGiftIntro trebuie sa ramana identica');
  assert.ok(mediaAnalysisSrc.includes("kenBurns: null, // video, niciodata Ken Burns (rezervat exclusiv pozelor — vezi renderShot)"), 'corpul functiei nu trebuie modificat');
});

// ===============================================================================================
// PARTEA 7 — video + fotografii: logica fotografiilor ramane complet neschimbata (Ken Burns,
// nu foloseste videoProgressSeconds).
// ===============================================================================================
test('video + fotografii: computeVideoProgressByShot() calculeaza progres si pentru fotografii (inofensiv), dar renderShot() nu il foloseste niciodata pentru poze', () => {
  const fn = extractFn(server, 'async function renderShot(item, shot, shotIndex, order) {');
  const photoBranchEnd = fn.indexOf('} else {');
  const photoBranch = fn.slice(0, photoBranchEnd);
  assert.ok(!photoBranch.includes('videoProgressSeconds'), 'ramura pentru fotografii nu trebuie sa citeasca niciodata videoProgressSeconds');
  assert.ok(photoBranch.includes('shot.kenBurns'), 'fotografiile trebuie sa foloseasca in continuare STRICT Ken Burns, neschimbat');
});

// ===============================================================================================
// PARTEA 8 — ordinea shot-urilor si duration/transitionOut/transitionDuration raman IDENTICE.
// ===============================================================================================
test('ordinea shot-urilor si duration/transitionOut/transitionDuration raman IDENTICE — adaugarea videoProgressSeconds e STRICT aditiva', () => {
  const items = [{ type: 'video' }, { type: 'video' }, { type: 'photo' }, { type: 'photo' }];
  const shots = buildShotPlan(items, 90, [], 0.6, [], 5);
  const before = shots.map(s => ({ itemIndex: s.itemIndex, occurrence: s.occurrence, duration: s.duration, transitionOut: s.transitionOut, transitionDuration: s.transitionDuration, kenBurns: s.kenBurns, start: s.start, end: s.end }));

  const progress = computeVideoProgressByShot(shots);
  shots.forEach((s, i) => { s.videoProgressSeconds = progress[i]; });

  const after = shots.map(s => ({ itemIndex: s.itemIndex, occurrence: s.occurrence, duration: s.duration, transitionOut: s.transitionOut, transitionDuration: s.transitionDuration, kenBurns: s.kenBurns, start: s.start, end: s.end }));
  assert.deepEqual(after, before, 'niciun camp existent al planului nu trebuie modificat de aceasta corectie');
});

// ===============================================================================================
// PARTEA 9 — verificare structurala a wiring-ului in server.js.
// ===============================================================================================
test('server.js: buildMemoryBackground() calculeaza videoProgressSeconds STRICT dupa applyVideoGiftIntro(), fara sa modifice shotPlan.length/ordinea', () => {
  const fn = extractFn(server, 'async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, songFilePath, assForFilter, vocalOnsetSeconds) {');
  const idxApplyIntro = fn.indexOf('shotPlan = applyVideoGiftIntro(');
  const idxProgress = fn.indexOf('const videoProgressByShot = computeVideoProgressByShot(shotPlan);');
  const idxAnnotate = fn.indexOf('shotPlan.forEach((s, i) => { s.videoProgressSeconds = videoProgressByShot[i]; });');
  assert.ok(idxApplyIntro !== -1 && idxProgress !== -1 && idxAnnotate !== -1);
  assert.ok(idxApplyIntro < idxProgress && idxProgress < idxAnnotate, 'progresul trebuie calculat DUPA intro, inainte de folosirea shotPlan pentru descarcare/randare');
});

test('server.js: renderShot() foloseste computeVideoStartOffsetFromProgress() (nu mai computeVideoSegmentStartOffset()) pentru videoclipuri', () => {
  const fn = extractFn(server, 'async function renderShot(item, shot, shotIndex, order) {');
  assert.ok(fn.includes('computeVideoStartOffsetFromProgress(shot.videoProgressSeconds || 0, sourceDuration, segDurationSeconds)'));
  assert.ok(!fn.includes('computeVideoSegmentStartOffset('), 'renderShot() nu mai trebuie sa apeleze vechea functie');
});

test('server.js: computeVideoSegmentStartOffset() ramane definita, NESCHIMBATA (compatibilitate cu testele ei dedicate) — doar nu mai e folosita de renderShot()', () => {
  const fn = extractFn(server, 'function computeVideoSegmentStartOffset(itemIndex, occurrence, sourceDurationSeconds, segDurationSeconds) {');
  assert.ok(fn.includes('GOLDEN_RATIO_CONJUGATE'), 'formula veche trebuie sa ramana intacta, neschimbata');
});

test('server.js si lib/media-analysis.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'media-analysis.js')]));
});
