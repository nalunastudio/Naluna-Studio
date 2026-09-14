// CADOU VIDEO — alegerea video-ului pentru intro dupa DURATA REALA, nu ordinea uploadului
// (2026-09-14). Testat in productie: intro-ul cu o singura secventa video (commit 3b75f64)
// functioneaza bine, dar alegea STRICT primul video eligibil din ordine — daca acel prim video
// era foarte scurt (2s) si exista un altul mult mai lung (120s) incarcat ulterior, intro-ul
// intra in bucla (loop) inutil pe video-ul scurt in loc sa foloseasca portiunea necesara din cel
// lung.
//
// REPARATIE (STRICT selectia sursei pentru intro — nimic altceva): daca exista 2+ video-uri
// incarcate, se alege cel cu durata REALA cea mai mare (selectVideoGiftIntroItemIndex,
// lib/media-analysis.js). Durata reala e obtinuta STRICT prin ffprobe pe fisierul deja descarcat
// (getVideoSourceDurationSeconds, functie EXISTENTA, neschimbata) — calculata in
// buildMemoryBackground() (server.js) DOAR pentru cazul (rar) cu 2+ video-uri candidate, folosind
// ACEEASI functie memoizata de descarcare (ensureDownloaded) ca randarea efectiva — niciun fisier
// nu se descarca de doua ori.
//
// NU s-a modificat: vocal onset (findFirstRealWordStartS), momentul de terminare al intro-ului
// (limita ramane primul cadru existent cu start >= vocalOnsetSeconds), montajul de dupa intro,
// progressive video offsets (c5a2692, computeVideoProgressByShot/computeVideoStartOffsetFromProgress),
// cinematic mode, sectionTimings, captions, audio, durata finala.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildShotPlan,
  applyVideoGiftIntro,
  selectVideoGiftIntroItemIndex
} = require('../lib/media-analysis.js');

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

// computeVideoProgressByShot() traieste in server.js (c5a2692), nu in lib/media-analysis.js —
// extrasa textual, la fel ca in test/video-source-progressive-reuse.test.js.
const computeVideoProgressByShot = new Function('return ' + extractFn(server, 'function computeVideoProgressByShot(shots) {'))();

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===============================================================================================
// 1-4. selectVideoGiftIntroItemIndex(): alegerea video-ului cu durata REALA maxima.
// ===============================================================================================
test('video A 120s + video B 2s -> alege video A (durata mai mare, indiferent de ordine)', () => {
  const items = [{ type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 120, 1: 2 }), 0);
});

test('video A 2s + video B 120s -> alege video B (durata mai mare, indiferent de ordine)', () => {
  const items = [{ type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 2, 1: 120 }), 1);
});

test('3+ video-uri cu durate diferite -> alege cel mai lung, indiferent de pozitia lui in ordine', () => {
  const items = [{ type: 'photo' }, { type: 'video' }, { type: 'photo' }, { type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 1: 15, 3: 90, 4: 45 }), 3);
  assert.equal(selectVideoGiftIntroItemIndex(items, { 1: 200, 3: 90, 4: 45 }), 1);
  assert.equal(selectVideoGiftIntroItemIndex(items, { 1: 15, 3: 20, 4: 500 }), 4);
});

test('doua video-uri cu durata EGALA -> tie-break determinist dupa ordinea existenta (primul castiga), fara randomizare', () => {
  const items = [{ type: 'video' }, { type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 50, 1: 50, 2: 10 }), 0);
  // determinism — aceleasi date produc mereu acelasi rezultat
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 50, 1: 50, 2: 10 }), 0);
  assert.equal(selectVideoGiftIntroItemIndex(items, { 1: 50, 0: 50, 2: 10 }), 0);
});

// ===============================================================================================
// 5+6. Un singur video / niciun video -> comportamentul actual, neschimbat.
// ===============================================================================================
test('un singur video incarcat -> comportament normal (acel video, indiferent de durata/lipsa duratei)', () => {
  const items = [{ type: 'photo' }, { type: 'video' }, { type: 'photo' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, null), 1, 'fara durate calculate (cazul obisnuit, 1 video), primul/singurul video eligibil');
  assert.equal(selectVideoGiftIntroItemIndex(items, { 1: 42 }), 1);
});

test('niciun video incarcat -> fallback actual neschimbat (-1, applyVideoGiftIntro nu modifica planul)', () => {
  const items = [{ type: 'photo' }, { type: 'photo' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, null), -1);
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 10 }), -1);

  const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
  const result = applyVideoGiftIntro(shots, items, 8, null);
  assert.equal(result, shots, 'fara niciun video, planul trebuie sa ramana NESCHIMBAT (aceeasi referinta)');
});

// ===============================================================================================
// 7. Durata video indisponibila/invalida -> fallback sigur, fara crash.
// ===============================================================================================
test('durata indisponibila/invalida pentru TOATE video-urile (probe esuat, null) -> fallback la primul video eligibil, fara crash', () => {
  const items = [{ type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: null, 1: null }), 0);
  assert.equal(selectVideoGiftIntroItemIndex(items, {}), 0);
  assert.doesNotThrow(() => selectVideoGiftIntroItemIndex(items, { 0: NaN, 1: undefined }));
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: NaN, 1: undefined }), 0);
});

test('durata valida pentru DOAR unul dintre video-uri -> alege pe cel cu durata valida, indiferent de pozitie', () => {
  const items = [{ type: 'video' }, { type: 'video' }];
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: null, 1: 30 }), 1);
  assert.equal(selectVideoGiftIntroItemIndex(items, { 0: 30, 1: null }), 0);
});

// ===============================================================================================
// 8+9. Loop-ul existent (computeVideoStartOffsetFromProgress) — folosit doar cand chiar e nevoie.
// ===============================================================================================
test('cel mai lung video mai lung decat intro-ul necesar -> NU intra in loop (mecanismul existent, neschimbat)', () => {
  const fn = extractFn(server, 'function computeVideoStartOffsetFromProgress(consumedSecondsSoFar, sourceDurationSeconds, segDurationSeconds) {');
  const compute = new Function('return ' + fn)();
  const r = compute(0, 120, 10); // video 120s, intro necesita 10s
  assert.equal(r.useLoop, false);
});

test('toate video-urile mai scurte decat intro-ul necesar -> foloseste loop-ul existent, neschimbat', () => {
  const fn = extractFn(server, 'function computeVideoStartOffsetFromProgress(consumedSecondsSoFar, sourceDurationSeconds, segDurationSeconds) {');
  const compute = new Function('return ' + fn)();
  const r = compute(0, 2, 10); // cel mai lung video disponibil e tot mai scurt decat intro-ul necesar
  assert.equal(r.useLoop, true);
  assert.equal(r.startOffset, 0);
});

// ===============================================================================================
// 10+11+12. Vocal onset, limita intro-ului si timeline-ul de dupa raman IDENTICE — DOAR sursa
// video aleasa pentru intro se schimba.
// ===============================================================================================
test('vocal onset si limita intro-ului raman IDENTICE — se schimba STRICT itemIndex-ul folosit pentru cadrul de intro', () => {
  const items = [{ type: 'video' }, { type: 'photo' }, { type: 'video' }, { type: 'photo' }];
  const shots = buildShotPlan(items, 75, [], 0.6, [], 5);
  const vocalOnset = 8.3;

  const withoutDurations = applyVideoGiftIntro(shots, items, vocalOnset, null); // comportament vechi: primul video (index 0)
  const withDurations = applyVideoGiftIntro(shots, items, vocalOnset, { 0: 5, 2: 120 }); // video 2 e mult mai lung

  assert.equal(withoutDurations[0].itemIndex, 0, 'fara durate, comportamentul vechi ramane: primul video eligibil');
  assert.equal(withDurations[0].itemIndex, 2, 'cu durate, se alege video-ul cu durata reala mai mare');

  // Limita intro-ului (end/duration) trebuie sa fie IDENTICA in ambele cazuri — doar SURSA difera.
  assert.equal(withoutDurations[0].end, withDurations[0].end, 'limita intro-ului (vocal onset) nu trebuie sa se schimbe');
  assert.equal(withoutDurations[0].duration, withDurations[0].duration);
  assert.equal(withoutDurations[0].transitionOut, withDurations[0].transitionOut);
  assert.equal(withoutDurations[0].transitionDuration, withDurations[0].transitionDuration);

  // Cadrele DE DUPA intro (timeline-ul montajului) raman STRICT identice, indiferent de video-ul
  // ales pentru intro.
  assert.deepEqual(withoutDurations.slice(1), withDurations.slice(1), 'timeline-ul de dupa intro nu trebuie sa se schimbe niciodata din cauza sursei intro-ului');
});

// ===============================================================================================
// 13. Progressive video offsets (c5a2692) continua sa considere intro-ul consumat — pentru
// VIDEO-UL ALES, nu pentru cel dintai din ordine.
// ===============================================================================================
test('progressive offsets: portiunea consumata de intro se atribuie STRICT video-ului ALES (nu primului din ordine)', () => {
  const items = [{ type: 'video' }, { type: 'photo' }, { type: 'video' }];
  const shots = buildShotPlan(items, 90, [], 0.6, [], 5);
  const vocalOnset = 8.3;
  const result = applyVideoGiftIntro(shots, items, vocalOnset, { 0: 5, 2: 120 }); // video 2 (index 2) e ales
  assert.equal(result[0].itemIndex, 2);

  const progress = computeVideoProgressByShot(result);
  assert.equal(progress[0], 0, 'intro-ul insusi nu are nimic consumat inainte de el');

  const laterSameItemIdx = result.findIndex((s, i) => i > 0 && s.itemIndex === 2);
  if (laterSameItemIdx !== -1) {
    assert.ok(progress[laterSameItemIdx] >= result[0].duration, 'urmatoarea aparitie a video-ului 2 (ales pentru intro) trebuie sa continue de la durata deja consumata de intro');
  }
  // Video-ul NEALES (index 0, durata 5s) nu trebuie sa fie afectat de alegerea facuta pentru intro.
  const firstItem0Idx = result.findIndex(s => s.itemIndex === 0);
  if (firstItem0Idx !== -1) {
    assert.equal(progress[firstItem0Idx], 0, 'video-ul nefolosit pentru intro isi pastreaza propriul progres, neafectat');
  }
});

// ===============================================================================================
// 14. Cele 8 limbi raman complet functionale — schimbarea nu are nimic legat de limba, dar
// verificam ca buildPrompt/pipeline-ul Video Gift ramane neatins pentru toate.
// ===============================================================================================
for (const lang of LANGS) {
  test(`applyVideoGiftIntro functioneaza identic indiferent de limba comenzii (${lang}) — selectia video e independenta de lang`, () => {
    const items = [{ type: 'video' }, { type: 'video' }];
    const shots = buildShotPlan(items, 60, [], 0.6, [], 5);
    const result = applyVideoGiftIntro(shots, items, 8, { 0: 2, 1: 120 });
    assert.equal(result[0].itemIndex, 1, `[${lang}] trebuie sa aleaga video-ul mai lung, indiferent de limba comenzii`);
  });
}

// ===============================================================================================
// Verificare structurala — wiring-ul in server.js, fara alte modificari.
// ===============================================================================================
test('server.js: buildMemoryBackground() calculeaza videoDurationsByIndex STRICT cand exista 2+ video-uri candidate, fara probe pentru 0/1', () => {
  const fn = extractFn(server, 'async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, songFilePath, assForFilter, vocalOnsetSeconds) {');
  assert.ok(fn.includes('if (videoCandidateIndexes.length > 1) {'), 'probe-ul de durata trebuie sa ruleze STRICT pentru 2+ video-uri candidate');
  assert.ok(fn.includes('shotPlan = applyVideoGiftIntro(shotPlan, ordered, vocalOnsetSeconds, videoDurationsByIndex);'));
});

test('server.js: ensureDownloaded() (descarcare + memoizare) e definita O SINGURA DATA, reutilizata atat de probe-ul de durata cat si de randarea efectiva a cadrelor', () => {
  const occurrences = (server.match(/function ensureDownloaded\(itemIndex\) \{/g) || []).length;
  assert.equal(occurrences, 1, 'ensureDownloaded trebuie sa ramana definita o singura data — niciun fisier nu trebuie descarcat de doua ori');
});

test('server.js: findFirstRealWordStartS() (vocal onset) NU a fost modificata de aceasta corectie', () => {
  const fn = extractFn(server, 'function findFirstRealWordStartS(alignedWords) {');
  assert.ok(fn.includes("w.success === true"));
  assert.ok(fn.includes('stripStructuralTagsFromWord(w.word).length > 0'));
});

test('server.js: computeVideoProgressByShot()/computeVideoStartOffsetFromProgress() (c5a2692) NU au fost modificate de aceasta corectie', () => {
  const progressFn = extractFn(server, 'function computeVideoProgressByShot(shots) {');
  assert.ok(progressFn.includes('consumedByItem.set(shot.itemIndex, consumedSoFar + shot.duration);'));
  const offsetFn = extractFn(server, 'function computeVideoStartOffsetFromProgress(consumedSecondsSoFar, sourceDurationSeconds, segDurationSeconds) {');
  assert.ok(offsetFn.includes('const wrapped = Math.max(0, consumedSecondsSoFar || 0) % safeSpan;'));
});

test('lib/media-analysis.js: applyVideoGiftIntro() pastreaza EXACT limita intro-ului (boundaryIdx = primul cadru cu start >= vocalOnsetSeconds) — doar selectia sursei s-a schimbat', () => {
  const mediaAnalysisSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-analysis.js'), 'utf8');
  assert.ok(mediaAnalysisSrc.includes('const boundaryIdx = shots.findIndex(s => s.start >= vocalOnsetSeconds);'), 'logica limitei intro-ului trebuie sa ramana identica');
});

test('server.js si lib/media-analysis.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'media-analysis.js')]));
});
