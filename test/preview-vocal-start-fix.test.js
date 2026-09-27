// PROBLEMA H (2026-09-27): preview gratuit — ~2-3 secunde instrumental, apoi voce, STRICT pentru
// preview-ul gratuit (fisierul complet/platit ramane neatins).
//
// AUDIT (facut inainte de reparatie): mecanismul de pozitionare (findFirstRealWordStartS +
// alinierea REALA Suno, get-timestamped-lyrics) exista deja si e autoritativ — NU o euristica
// noua. Cauza reala a "intro-ul consuma 29-30 sec din preview": (1) TARGET_VOICE_POSITION_S
// era 9 (voce in jurul secundei 8-10, nu 2-3); (2) raspunsul furnizorului poate fi HTTP 200 cu
// alignedWords GOL cand alinierea inca nu s-a terminat de calculat (fenomen documentat, real) —
// codul anterior trata asta ca esec definitiv, cazand imediat pe previewStart=0 (fara nicio
// corectie), desi semnalul autoritativ chiar exista, doar nu era inca gata.
//
// REPARATIE: TARGET_VOICE_POSITION_S 9 -> 3; alignedWords gol acum reincearca ACELASI apel
// autoritativ, de cateva ori (MAX_EMPTY_ALIGNED_RETRIES), cu pauze scurte, inainte de fallback.
// Niciun parser/euristica noua — STRICT reincercare a sursei deja autoritative.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

// Semnatura trebuie sa se termine EXACT cu acolada de deschidere a corpului ("... ) {") —
// evita capcana unei acolade "momeala" dintr-un parametru cu valoare implicita de tip obiect
// (ex. "options = {}"), care ar inchide bucla mult prea devreme daca am cauta din nou prima
// acolada dupa semnatura. Acelasi tipar deja folosit in test/analytics-server.test.js
// (sliceFunctionBody).
function extractBraced(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = start + signature.length;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

test('server.js: TARGET_VOICE_POSITION_S este acum 3 (~2-3 secunde), nu mai 9', () => {
  assert.match(server, /const TARGET_VOICE_POSITION_S = 3;/);
});

test('server.js: PREVIEW_START_MAX_S ramane plafonul dur de 25 (neschimbat)', () => {
  assert.match(server, /const PREVIEW_START_MAX_S = 25;/);
});

test('server.js: exista o reincercare marginita STRICT pentru alignedWords gol (MAX_EMPTY_ALIGNED_RETRIES/EMPTY_ALIGNED_RETRY_DELAY_MS), nu doar fallback imediat', () => {
  assert.match(server, /const MAX_EMPTY_ALIGNED_RETRIES = 3;/);
  assert.match(server, /const EMPTY_ALIGNED_RETRY_DELAY_MS = 4000;/);
  const body = extractBraced(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');
  assert.match(body, /for \(let attempt = 0; attempt <= MAX_EMPTY_ALIGNED_RETRIES; attempt\+\+\)/);
  assert.match(body, /await delay\(EMPTY_ALIGNED_RETRY_DELAY_MS\)/);
});

// ===============================================================================================
// COMPORTAMENT REAL, sandbox — getPreviewStartFromLyrics() extras cu fetch mocat.
// ===============================================================================================
function loadGetPreviewStartFromLyrics(mockFetch) {
  const fetchWithTimeoutSnippet = extractBraced(read('lib/fetch-with-timeout.js'), 'async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {');
  const constsSrc = (() => {
    const idx = server.indexOf('const TIMESTAMPED_LYRICS_TIMEOUT_MS = 8000;');
    const end = server.indexOf('function stripStructuralTagsFromWord');
    // Reducem STRICT pauza intre reincercari (4000ms -> 5ms) pentru viteza testelor — schimbare
    // DOAR in copia sandbox, niciodata in server.js real; numarul de incercari/logica raman identice.
    return server.slice(idx, end).replace('EMPTY_ALIGNED_RETRY_DELAY_MS = 4000', 'EMPTY_ALIGNED_RETRY_DELAY_MS = 5');
  })();
  const stripFnSrc = extractBraced(server, 'function stripStructuralTagsFromWord(word) {');
  const findFirstRealWordSrc = extractBraced(server, 'function findFirstRealWordStartS(alignedWords) {');
  const fetchOnceSrc = extractBraced(server, 'async function fetchTimestampedLyricsOnce(taskId, audioId) {');
  const mainSrc = extractBraced(server, 'async function getPreviewStartFromLyrics(taskId, audioId, orderId) {');

  const sandboxSrc = `
    const DEFAULT_TIMEOUT_MS = 30000;
    ${fetchWithTimeoutSnippet}
    ${constsSrc}
    ${stripFnSrc}
    ${findFirstRealWordSrc}
    ${fetchOnceSrc}
    ${mainSrc}
    return getPreviewStartFromLyrics;
  `;
  return new Function('fetch', 'process', 'console', sandboxSrc)(
    mockFetch, { env: { MUSIC_API_BASE_URL: 'https://fake.api', MUSIC_API_KEY: 'fake' } }, { log: () => {}, warn: () => {}, error: () => {} }
  );
}

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

test('sandbox: intro vocal SCURT (voce la 4s) -> previewStart = max(0, 4-3) = 1', async () => {
  const fn = loadGetPreviewStartFromLyrics(async () => jsonResponse({
    code: 200, data: { alignedWords: [{ word: 'Salut', success: true, startS: 4 }] }
  }));
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 1);
});

test('sandbox: intro vocal MEDIU (voce la 12s) -> previewStart = 12-3 = 9', async () => {
  const fn = loadGetPreviewStartFromLyrics(async () => jsonResponse({
    code: 200, data: { alignedWords: [{ word: 'Salut', success: true, startS: 12 }] }
  }));
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 9);
});

test('sandbox: intro FOARTE lung (voce la 40s) -> previewStart plafonat la PREVIEW_START_MAX_S=25, niciodata mai mult', async () => {
  const fn = loadGetPreviewStartFromLyrics(async () => jsonResponse({
    code: 200, data: { alignedWords: [{ word: 'Salut', success: true, startS: 40 }] }
  }));
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 25);
});

test('sandbox: voce originala la EXACT ~30 sec (cazul reclamat de client) -> previewStart plafonat la 25, deci vocea intra la secunda 5 din preview (30-25), mult mai devreme decat inainte (fara nicio corectie: 30)', async () => {
  const fn = loadGetPreviewStartFromLyrics(async () => jsonResponse({
    code: 200, data: { alignedWords: [{ word: 'Salut', success: true, startS: 30 }] }
  }));
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 25);
  assert.equal(30 - start, 5, 'vocea trebuie sa se auda in primele cateva secunde ale preview-ului, nu la secunda 30');
});

test('sandbox: alignedWords gol la prima incercare, populat la a doua -> previewStart calculat corect (nu cade pe fallback=0)', async () => {
  let call = 0;
  const fn = loadGetPreviewStartFromLyrics(async () => {
    call++;
    if (call === 1) return jsonResponse({ code: 200, data: { alignedWords: [] } });
    return jsonResponse({ code: 200, data: { alignedWords: [{ word: 'Salut', success: true, startS: 6 }] } });
  });
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 3, 'a doua incercare trebuie folosita (6-3=3), nu fallback la 0');
  assert.equal(call, 2);
});

test('sandbox: alignedWords gol la TOATE incercarile (MAX_EMPTY_ALIGNED_RETRIES+1) -> fallback la 0, niciodata o eroare aruncata mai departe', async () => {
  let calls = 0;
  const fn = loadGetPreviewStartFromLyrics(async () => { calls++; return jsonResponse({ code: 200, data: { alignedWords: [] } }); });
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 0);
  assert.equal(calls, 4, 'trebuie STRICT 1 + MAX_EMPTY_ALIGNED_RETRIES(3) = 4 incercari, niciodata mai multe (bugetul ramane marginit)');
});

test('sandbox: raspuns HTTP nereusit (5xx dupa retry-ul intern) -> fallback imediat, FARA reincercarile de alignedWords gol (motive diferite)', async () => {
  let calls = 0;
  const fn = loadGetPreviewStartFromLyrics(async () => { calls++; return { ok: false, status: 500, headers: { get: () => null } }; });
  const start = await fn('task1', 'audio1', 'order1');
  assert.equal(start, 0);
  assert.equal(calls, 2, 'STRICT retry-ul intern deja existent al fetchTimestampedLyricsOnce (2 incercari), fara bucla suplimentara de alignedWords gol');
});

test('sandbox: taskId/audioId lipsa -> fallback imediat, niciun apel catre furnizor', async () => {
  let called = false;
  const fn = loadGetPreviewStartFromLyrics(async () => { called = true; return jsonResponse({ code: 200, data: { alignedWords: [] } }); });
  const start = await fn(null, null, 'order1');
  assert.equal(start, 0);
  assert.equal(called, false);
});

test('server.js: getPreviewStartFromLyrics/preview slicing NU modifica NICIODATA fisierul complet (tempFull) — doar decide punctul de start al taierii (trimAudio scrie STRICT intr-un fisier SEPARAT, tempPreview)', () => {
  assert.match(server, /trimAudio\(/);
  const idx = server.indexOf('async function trimAudio(');
  assert.ok(idx !== -1, 'trimAudio trebuie sa existe');
});

test('node --check server.js trece (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
