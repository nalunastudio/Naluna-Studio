// LAUNCH SAFETY (2026-09-01, "risc de pierdere a comenzilor dupa un restart Railway"): pana
// acum, o comanda ramasa 'generating'/'processing_provider_result' dupa o repornire a
// serverului (in mijlocul unui polling Suno) era reluata STRICT reactiv — doar daca clientul
// revenea chiar pe se-compune.html. Daca inchidea tab-ul definitiv, comanda ramanea blocata
// la nesfarsit, indiferent daca era o generare initiala gratuita sau o REGENERARE deja
// PLATITA. Acest fisier verifica STRUCTURAL noul mecanism de reluare automata la pornire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

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

const dbSrc = read('db.js');
const serverSrc = read('server.js');

test('db.js: getStuckInFlightOrders() selecteaza STRICT comenzile generating/processing_provider_result CU un music_task_id real', () => {
  const fn = extractFn(dbSrc, 'async function getStuckInFlightOrders() {');
  assert.match(fn, /status IN \('generating', 'processing_provider_result'\)/);
  assert.match(fn, /music_task_id IS NOT NULL/);
});

test('db.js: getStuckInFlightOrders este exportata', () => {
  assert.match(dbSrc, /module\.exports = \{[\s\S]*getStuckInFlightOrders/);
});

test('server.js: resumeStuckGenerationsOnBoot() foloseste EXACT logica dual/single existenta (musicTaskId2 -> resumeDualTaskPolling, altfel musicTaskId -> resumeExistingTaskPolling)', () => {
  const fn = extractFn(serverSrc, 'async function resumeStuckGenerationsOnBoot() {');
  assert.match(fn, /db\.getStuckInFlightOrders\(\)/);
  assert.match(fn, /if\s*\(order\.musicTaskId2\)\s*\{\s*resumeDualTaskPolling\(order\.id\);/);
  assert.match(fn, /resumeExistingTaskPolling\(order\.id, order\.musicTaskId\);/);
});

test('server.js: resumeStuckGenerationsOnBoot() e apelata la pornirea reala a serverului (in lantul db.initDb().then), fire-and-forget, ca celelalte verificari de boot', () => {
  const start = serverSrc.indexOf('db.initDb()');
  assert.notEqual(start, -1);
  const bootBlock = serverSrc.slice(start, start + 800);
  assert.match(bootBlock, /resumeStuckGenerationsOnBoot\(\);/);
});

test('server.js: erorile la interogarea comenzilor blocate NU opresc pornirea serverului (try/catch propriu, nu propaga catre .catch de initDb)', () => {
  const fn = extractFn(serverSrc, 'async function resumeStuckGenerationsOnBoot() {');
  assert.match(fn, /try\s*\{[\s\S]*catch\s*\(err\)\s*\{/);
});
