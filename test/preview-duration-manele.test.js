// DURATA PREVIEW — exceptie 50s STRICT pentru manele_suflet/manele_jale (2026-09-19, cerinta
// explicita). Genre keys REALE, verificate direct in cod (NEW_GENRES, server.js): 'manele_suflet'
// si 'manele_jale' — niciun genre key nou creat pentru aceasta modificare.
//
// resolvePreviewMaxSeconds(genre) e o functie PURA (fara retea/fisiere/ffmpeg) — extrasa
// TEXTUAL din server.js si rulata intr-un sandbox izolat, acelasi tipar folosit deja in acest
// repo pentru functii pure din server.js (vezi ex. test/attribution-client.test.js pentru
// tehnica, aplicata aici pe server.js in loc de un fisier client). Restul (semnatura
// buildVariantFromTrack, apelul catre trimAudio, punctul de start/vocal onset, ffmpeg fara
// loop/padding) e verificat STATIC, citind direct sursa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// Extrage cele doua constante + functia pura, le evalueaza intr-un sandbox minimal.
function loadResolvePreviewMaxSeconds() {
  const constGenres = server.match(/const EXTENDED_PREVIEW_GENRES = \[[^\]]*\];/)[0];
  const constSeconds = server.match(/const EXTENDED_PREVIEW_SECONDS = \d+;/)[0];
  const constPreview = server.match(/const PREVIEW_SECONDS = \d+;/)[0];
  const fn = extractFn(server, 'function resolvePreviewMaxSeconds(genre) {');
  const src = `${constPreview}\n${constGenres}\n${constSeconds}\n${fn}\nreturn resolvePreviewMaxSeconds;`;
  return new Function(src)();
}

test('genre keys REALE pentru cele doua manele exista deja in NEW_GENRES (nu s-a inventat niciun genre key nou)', () => {
  const newGenresMatch = server.match(/const NEW_GENRES = \[([^\]]*)\];/);
  assert.ok(newGenresMatch);
  assert.match(newGenresMatch[1], /'manele_suflet'/);
  assert.match(newGenresMatch[1], /'manele_jale'/);
});

test('CRITIC — "manea de jale" (genre key: manele_jale) -> maximum 50 secunde', () => {
  const resolvePreviewMaxSeconds = loadResolvePreviewMaxSeconds();
  assert.equal(resolvePreviewMaxSeconds('manele_jale'), 50);
});

test('CRITIC — "manea de suflet" (genre key: manele_suflet) -> maximum 50 secunde', () => {
  const resolvePreviewMaxSeconds = loadResolvePreviewMaxSeconds();
  assert.equal(resolvePreviewMaxSeconds('manele_suflet'), 50);
});

test('CRITIC — fiecare ALT gen ramane la maximum 40 secunde (verificat exhaustiv, toate genurile din NEW_GENRES in afara celor doua manele)', () => {
  const resolvePreviewMaxSeconds = loadResolvePreviewMaxSeconds();
  const newGenresMatch = server.match(/const NEW_GENRES = \[([^\]]*)\];/);
  const allGenres = [...newGenresMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(allGenres.length >= 15, 'lista de genuri trebuie sa contina toate genurile reale');
  const otherGenres = allGenres.filter((g) => g !== 'manele_suflet' && g !== 'manele_jale');
  assert.ok(otherGenres.length >= 13);
  for (const g of otherGenres) {
    assert.equal(resolvePreviewMaxSeconds(g), 40, `genul "${g}" trebuie sa ramana la 40 secunde`);
  }
});

test('gen lipsa/necunoscut (undefined, string gol, gen inventat) -> ramane la 40 secunde (comportamentul implicit, sigur, neschimbat)', () => {
  const resolvePreviewMaxSeconds = loadResolvePreviewMaxSeconds();
  assert.equal(resolvePreviewMaxSeconds(undefined), 40);
  assert.equal(resolvePreviewMaxSeconds(''), 40);
  assert.equal(resolvePreviewMaxSeconds('gen_inexistent'), 40);
});

test('buildVariantFromTrack primeste genre ca parametru NOU, si il transmite catre trimAudio EXCLUSIV prin previewMaxSeconds — restul apelului (previewStart, fisiere) neschimbat', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, genre) {');
  assert.match(fn, /const previewMaxSeconds = resolvePreviewMaxSeconds\(genre\);/);
  assert.match(fn, /trimAudio\(tempFull, tempPreview, previewMaxSeconds, previewStart\)/, 'trimAudio trebuie apelat cu previewMaxSeconds (variabil) si previewStart (neschimbat)');
  assert.doesNotMatch(fn, /trimAudio\(tempFull, tempPreview, PREVIEW_SECONDS,/, 'nu mai trebuie sa ramana vreun apel cu constanta fixa PREVIEW_SECONDS');
});

test('CRITIC — punctul de START al preview-ului (previewStart) e CALCULAT identic, neschimbat: acelasi apel getPreviewStartFromLyrics(taskId, track.id, orderId), inaintea oricarei logici de durata', () => {
  const fn = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, genre) {');
  assert.match(fn, /getPreviewStartFromLyrics\(taskId, track\.id, orderId\)/);
  const idxPreviewStart = fn.indexOf('getPreviewStartFromLyrics(taskId, track.id, orderId)');
  const idxPreviewMax = fn.indexOf('const previewMaxSeconds = resolvePreviewMaxSeconds(genre);');
  assert.ok(idxPreviewStart !== -1 && idxPreviewMax !== -1 && idxPreviewStart < idxPreviewMax, 'previewStart trebuie calculat INAINTE de decizia de durata, complet independent de ea');
});

test('CRITIC — functia de vocal onset (getPreviewStartFromLyrics) nu a fost modificata de aceasta schimbare — semnatura si continutul raman identice', () => {
  const fn = extractFn(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  // nu trebuie sa contina absolut nimic legat de genre/manele/preview extins — functia e complet
  // independenta de genul melodiei.
  assert.doesNotMatch(fn, /genre/i);
  assert.doesNotMatch(fn, /manele/i);
  assert.doesNotMatch(fn, /EXTENDED_PREVIEW/);
});

test('CRITIC — trimAudio() (functia care taie efectiv fisierul, ffmpeg) e complet neschimbata — STRICT "-t <secunde>" (durata maxima), fara loop/concat/padding — un fisier mai scurt decat fereastra se opreste natural la finalul lui real', () => {
  const fn = extractFn(server, 'async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {');
  assert.match(fn, /args\.push\('-i', srcPath, '-t', String\(seconds\), '-af', 'afade=t=in:st=0:d=0\.015', '-c:a', 'libmp3lame', '-q:a', '0', destPath\);/);
  assert.doesNotMatch(fn, /loop|concat|apad|-stream_loop/i, 'trimAudio nu trebuie sa contina niciun mecanism de extindere/loop/padding artificial — capatul preview-ului trebuie sa fie STRICT finalul materialului real, daca acesta e mai scurt decat fereastra ceruta');
});

test('apelul catre buildVariantFromTrack (din attempt(), in interiorul obtainAcceptableVariant) transmite genre-ul REAL al cererii curente — corect si pentru Premium (genre vs genre2, per melodie)', () => {
  const fn = extractFn(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.match(fn, /buildVariantFromTrack\(orderId, randomUUID\(\)\.slice\(0, 8\), track, candidateTaskId, genre\)/);
});

test('nicio alta constanta/logica de preview NEATINSA de aceasta cerinta (VIDEO_PREVIEW_SECONDS, pretul pachetelor, PLAN_PRICES) — verificare structurala ca nimic altceva nu a fost modificat din greseala', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});
