// CADOU VIDEO — limita intro-ului trebuie sa fie PRIMA STROFA REALA, nu primul cuvant cantat
// (2026-09-14, corectie root-cause dovedita pe comanda reala 88d1486e: sectiunea [Introducere]
// contine ea insasi un vers cantat complet — "Maria, asculta-ma o clipa, / Azi iti spun ce port
// in mine." — intre 5.98s si 14.86s; [Strofa 1] ("Maria, sotia mea iubita,") incepe abia la
// 14.87s. findFirstRealWordStartS() gasea 5.98s (primul cuvant real, din interiorul intro-ului),
// terminand intro-ul Cadou Video cu aproape 9 secunde mai devreme decat prima strofa reala).
//
// findFirstVerseStartS() (server.js) reutilizeaza STRICT sectionTimings deja calculat
// (deriveSectionTimings, lib/media-analysis.js, din ACELASI alignedWords) — niciun parser
// paralel. Testele de mai jos verifica DOAR aceasta functie noua si integrarea ei — comportamentul
// existent al applyVideoGiftIntro()/findFirstRealWordStartS()/selectVideoGiftIntroItemIndex()
// (loop, longest-video, progressive offsets, timeline dupa boundary) e verificat separat si
// NESCHIMBAT — vezi video-gift-vocal-onset-intro.test.js si video-gift-intro-longest-video.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveSectionTimings, applyVideoGiftIntro, buildShotPlan } = require('../lib/media-analysis.js');

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

function loadServerPureFns() {
  const stripFn = extractFn(server, 'function stripStructuralTagsFromWord(word) {');
  const findFirstFn = extractFn(server, 'function findFirstRealWordStartS(alignedWords) {');
  const findVerseFn = extractFn(server, 'function findFirstVerseStartS(sectionTimings, alignedWords) {');
  const sandboxSrc = `
    ${stripFn}
    ${findFirstFn}
    ${findVerseFn}
    return { findFirstRealWordStartS, findFirstVerseStartS };
  `;
  return new Function(sandboxSrc)();
}
const { findFirstRealWordStartS, findFirstVerseStartS } = loadServerPureFns();

function makeItems(spec) {
  return spec.map(type => ({ type }));
}

// Reconstruieste alignedWords realiste: o sectiune [Introducere] cu vers cantat, urmata de
// [Strofa 1] — exact forma reala confirmata pe comanda 88d1486e.
function realOrderLikeAlignedWords() {
  return [
    { word: '[Introducere]\nMaria, ', success: true, startS: 5.984, endS: 8.497 },
    { word: 'asculta-ma ', success: true, startS: 8.537, endS: 9.096 },
    { word: 'o ', success: true, startS: 9.255, endS: 9.255 },
    { word: 'clipa,\n', success: true, startS: 9.315, endS: 12.367 },
    { word: 'Azi ', success: true, startS: 12.447, endS: 12.527 },
    { word: 'iti ', success: true, startS: 12.606, endS: 12.766 },
    { word: 'spun ', success: true, startS: 12.86575, endS: 13.803 },
    { word: 'ce ', success: true, startS: 13.923, endS: 14.043 },
    { word: 'port ', success: true, startS: 14.10275, endS: 14.282 },
    { word: 'in ', success: true, startS: 14.3615, endS: 14.441 },
    { word: 'mine.\n\n', success: true, startS: 14.54075, endS: 14.86 },
    { word: '[Strofa 1]\nMaria, ', success: true, startS: 14.87, endS: 15.26567 },
    { word: 'sotia ', success: true, startS: 15.29233, endS: 15.479 },
    { word: 'mea ', success: true, startS: 15.532, endS: 15.638 },
    { word: 'iubita,\n', success: true, startS: 15.66467, endS: 15.98433 }
  ];
}

// ===============================================================================================
// TEST 7 — intro cu [Verse]/[Strofa] -> boundary la primul vers real (nu la primul cuvant,
// chiar daca acesta apare mai devreme, in interiorul sectiunii de intro).
// ===============================================================================================
test('TEST 7: findFirstVerseStartS gaseste startul PRIMEI STROFE reale (14.87s), nu primul cuvant cantat (5.984s, in interiorul [Introducere])', () => {
  const words = realOrderLikeAlignedWords();
  const sectionTimings = deriveSectionTimings(words, 60, 'cbd93efb');

  // demonstratie root-cause: cele doua functii NU dau acelasi rezultat pe acest caz real.
  assert.equal(findFirstRealWordStartS(words), 5.984, 'primul cuvant real ramane 5.984s (comportament neschimbat)');
  assert.equal(findFirstVerseStartS(sectionTimings, words), 14.87, 'limita intro-ului trebuie sa fie inceputul primei strofe reale, 14.87s');
});

// ===============================================================================================
// TEST 8 — etichete structurale ([Verse]/[Chorus]/[Intro] etc.) INAINTE de vers -> ignorate ca
// si continut cantat (deja garantat de deriveSectionTimings/stripStructuralTagsFromWord), nu
// influenteaza limita gasita.
// ===============================================================================================
test('TEST 8: etichetele structurale dinaintea versului real nu influenteaza limita (raman ignorate ca "text cantat")', () => {
  const words = [
    { word: '[Intro]', success: true, startS: 0 },
    { word: '[Verse]\nHello ', success: true, startS: 10 },
    { word: 'world', success: true, startS: 10.5 }
  ];
  const sectionTimings = deriveSectionTimings(words, 40, 'v1');
  assert.equal(findFirstVerseStartS(sectionTimings, words), 10, 'limita trebuie sa fie startul sectiunii [Verse] (10s), nu 0 (eticheta [Intro] singura)');
});

// ===============================================================================================
// TEST 9 — ad-lib/cuvant izolat INAINTE de prima strofa -> NU termina intro-ul prematur.
// ===============================================================================================
test('TEST 9: un ad-lib/cuvant izolat inainte de [Verse] nu termina intro-ul prematur', () => {
  const words = [
    { word: '[Intro]\nOoh', success: true, startS: 3.2, endS: 3.9 }, // ad-lib izolat, INAINTE de vers
    { word: '[Verse]\nHello ', success: true, startS: 12.1 },
    { word: 'there', success: true, startS: 12.6 }
  ];
  const sectionTimings = deriveSectionTimings(words, 50, 'v1');

  assert.equal(findFirstRealWordStartS(words), 3.2, 'primul cuvant real ramane ad-libul de la 3.2s (comportament existent, neschimbat)');
  assert.equal(findFirstVerseStartS(sectionTimings, words), 12.1, 'limita intro-ului trebuie sa sara peste ad-lib si sa foloseasca inceputul versului real, 12.1s');
});

// ===============================================================================================
// TEST 10 — melodie FARA section labels -> fallback sigur, bazat pe primul cuvant real (
// comportamentul ACTUAL, dovedit).
// ===============================================================================================
test('TEST 10: melodie FARA nicio eticheta de sectiune -> fallback la findFirstRealWordStartS (primul cuvant real)', () => {
  const words = [
    { word: 'Hello ', success: true, startS: 6.5, endS: 7 },
    { word: 'world', success: true, startS: 7.2, endS: 7.6 }
  ];
  // niciun marker -> deriveSectionTimings intra pe fallback 'full_song' (source='fallback_equal')
  const sectionTimings = deriveSectionTimings(words, 40, 'v1');
  assert.equal(sectionTimings[0].source, 'fallback_equal', 'premisa testului: fara etichete, sectionTimings trebuie sa fie fallback');
  assert.equal(findFirstVerseStartS(sectionTimings, words), 6.5, 'fara sectiuni reale, trebuie sa revina la primul cuvant real (6.5s)');
});

test('TEST 10b: melodie cu etichete de sectiune, dar NICIUNA de tip vers (ex. doar [Chorus]/[Bridge]) -> fallback la primul cuvant real', () => {
  const words = [
    { word: '[Chorus]\nHey ', success: true, startS: 8, endS: 8.4 },
    { word: 'hey', success: true, startS: 8.5, endS: 8.8 },
    { word: '[Bridge]\nOh', success: true, startS: 20, endS: 20.4 }
  ];
  const sectionTimings = deriveSectionTimings(words, 40, 'v1');
  assert.ok(!sectionTimings.some(s => s.sectionType === 'verse'), 'premisa testului: nicio sectiune de tip vers');
  assert.equal(findFirstVerseStartS(sectionTimings, words), 8, 'fara nicio sectiune de tip vers, trebuie sa revina la primul cuvant real (8s)');
});

// ===============================================================================================
// TEST 11 — niciun alignment sigur (alignedWords fara cuvinte success:true) -> fallback actual
// (null), FARA crash — applyVideoGiftIntro trateaza deja null identic cu inainte.
// ===============================================================================================
test('TEST 11: niciun cuvant cu success:true -> findFirstVerseStartS returneaza null, fara crash', () => {
  const words = [
    { word: 'Hello', success: false, startS: 5 },
    { word: 'world', success: false, startS: 5.5 }
  ];
  const sectionTimings = deriveSectionTimings(words, 40, 'v1');
  assert.equal(findFirstVerseStartS(sectionTimings, words), null);

  // applyVideoGiftIntro trebuie sa ramana neschimbat (planul original) cand limita e null.
  const items = makeItems(['video', 'photo', 'photo']);
  const shots = buildShotPlan(items, 40, sectionTimings, 0.6, [], 5);
  assert.equal(applyVideoGiftIntro(shots, items, findFirstVerseStartS(sectionTimings, words)), shots);
});

test('TEST 11b: alignedWords complet gol -> findFirstVerseStartS returneaza null, fara crash', () => {
  const sectionTimings = deriveSectionTimings([], 40, 'v1');
  assert.equal(findFirstVerseStartS(sectionTimings, []), null);
  assert.equal(findFirstVerseStartS(sectionTimings, null), null);
});

// ===============================================================================================
// TEST 12/13/14/15 — integrare end-to-end cu applyVideoGiftIntro: longest-video selection,
// loop-ul existent, progressive offsets si timeline-ul dupa intro raman NESCHIMBATE — aceasta
// functie noua schimba STRICT valoarea limitei transmise, niciodata mecanismul din
// applyVideoGiftIntro/buildMemoryBackground (deja acoperite separat, aici verificam doar ca
// noua limita se integreaza corect, fara sa strice planul).
// ===============================================================================================
test('TEST 12: applyVideoGiftIntro cu limita derivata din findFirstVerseStartS -> tot alege cel mai lung video (mecanism neschimbat)', () => {
  const items = makeItems(['photo', 'video', 'video', 'photo']);
  const words = realOrderLikeAlignedWords();
  const sectionTimings = deriveSectionTimings(words, 60, 'v1');
  const boundary = findFirstVerseStartS(sectionTimings, words);
  assert.equal(boundary, 14.87);

  const shots = buildShotPlan(items, 60, sectionTimings, 0.6, [], 5);
  // al doilea video (index 2) e "mai lung" -> selectVideoGiftIntroItemIndex trebuie sa il aleaga.
  const videoDurationsByIndex = { 1: 3.5, 2: 27.6 };
  const result = applyVideoGiftIntro(shots, items, boundary, videoDurationsByIndex);
  assert.equal(result[0].itemIndex, 2, 'trebuie ales video-ul cu durata reala mai mare (index 2), indiferent de noua limita');
  assert.ok(result[0].duration >= boundary);
});

test('TEST 13/14/15: cadrele DUPA noua limita (prima strofa reala) raman byte-identice cu planul original — loop/progressive-offsets/timeline neatinse', () => {
  const items = makeItems(['video', 'photo', 'video', 'photo', 'photo']);
  const words = realOrderLikeAlignedWords();
  const sectionTimings = deriveSectionTimings(words, 60, 'v1');
  const boundary = findFirstVerseStartS(sectionTimings, words);

  const shots = buildShotPlan(items, 60, sectionTimings, 0.6, [], 5);
  const totalBefore = shots.reduce((s, x) => s + x.duration, 0);
  const result = applyVideoGiftIntro(shots, items, boundary);

  const boundaryIdx = shots.findIndex(s => s.start >= boundary);
  const originalTail = shots.slice(boundaryIdx);
  const resultTail = result.slice(1);
  assert.deepEqual(resultTail, originalTail, 'timeline-ul dupa limita trebuie sa ramana STRICT identic (durata/tranzitii/Ken Burns/item/occurrence) — nicio schimbare la loop sau progressive offsets');

  const totalAfter = result.reduce((s, x) => s + x.duration, 0);
  assert.ok(Math.abs(totalAfter - totalBefore) < 1e-6, 'durata totala a planului trebuie sa ramana neschimbata');
});

// ===============================================================================================
// Verificare structurala: generateLyricVideo() foloseste findFirstVerseStartS (nou), NU mai
// findFirstRealWordStartS direct, pentru limita intro-ului Cadou Video.
// ===============================================================================================
test('server.js: generateLyricVideo() calculeaza vocalOnsetSeconds cu findFirstVerseStartS(sectionTimings, ...), dupa ce sectionTimings e deja calculat', () => {
  const fn = extractFn(server, 'async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  assert.ok(fn.includes('const vocalOnsetSeconds = findFirstVerseStartS(sectionTimings, body.data.alignedWords);'));
  const idxSection = fn.indexOf('const sectionTimings =');
  const idxOnset = fn.indexOf('const vocalOnsetSeconds =');
  assert.ok(idxSection !== -1 && idxOnset !== -1 && idxSection < idxOnset, 'sectionTimings trebuie calculat INAINTE de vocalOnsetSeconds, ca findFirstVerseStartS sa il poata refolosi');
});

test('server.js: getPreviewStartFromLyrics() (previzualizarea gratuita) ramane NESCHIMBATA — foloseste in continuare findFirstRealWordStartS, nu findFirstVerseStartS', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.ok(fn.includes('findFirstRealWordStartS(words)'), 'pozitionarea preview-ului ramane STRICT pe conceptul "prim cuvant real" — neschimbata de aceasta corectie');
  assert.ok(!fn.includes('findFirstVerseStartS'), 'preview-ul nu trebuie sa foloseasca deloc noul concept de "prima strofa"');
});

test('server.js si lib/media-analysis.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'media-analysis.js')]));
});
