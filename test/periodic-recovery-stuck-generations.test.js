// INCIDENT PRODUCTIE ("stuck la 80%", 2026-10-05): resumeStuckGenerationsOnBoot (vezi
// test/boot-recovery-stuck-generations.test.js) reia automat comenzile ramase 'generating'/
// 'processing_provider_result' STRICT la pornirea procesului. Intre doua restart-uri/redeploy-uri,
// un task Suno care depaseste bugetul local de polling (LOCAL_POLL_TIMEOUT, ~15 minute, vezi
// pollForResult) ramanea blocat definitiv, fara nicio reluare automata, cat timp serverul rula
// neintrerupt. Acest fisier verifica STRUCTURAL noul strat suplimentar: un job periodic (la
// fiecare 5 minute) care reutilizeaza STRICT aceleasi functii de reluare (resumeExistingTaskPolling/
// resumeDualTaskPolling) — niciun task Suno nou, nicio logica noua de polling.
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

// -------- db.js: interogarea cu prag de varsta --------

test('db.js: getStuckInFlightOrdersOlderThan() pastreaza ACEEASI conditie de baza ca getStuckInFlightOrders (status in-flight + music_task_id real)', () => {
  const fn = extractFn(dbSrc, 'async function getStuckInFlightOrdersOlderThan(cutoffDate) {');
  assert.match(fn, /status IN \('generating', 'processing_provider_result'\)/);
  assert.match(fn, /music_task_id IS NOT NULL/);
});

test('db.js: getStuckInFlightOrdersOlderThan() filtreaza dupa varsta — comanda normala, recenta, NU trebuie selectata', () => {
  const fn = extractFn(dbSrc, 'async function getStuckInFlightOrdersOlderThan(cutoffDate) {');
  // COALESCE(generation_phase_updated_at, created_at) < $1 (cutoff) — orice comanda mai noua
  // decat cutoff-ul e exclusa de conditia SQL insasi, nu de logica JS ulterioara.
  assert.match(fn, /COALESCE\(generation_phase_updated_at,\s*created_at\)\s*<\s*\$1/);
  assert.match(fn, /\[cutoffDate\]/);
});

test('db.js: getStuckInFlightOrdersOlderThan este exportata', () => {
  assert.match(dbSrc, /module\.exports = \{[\s\S]*getStuckInFlightOrdersOlderThan/);
});

// -------- server.js: pragul si intervalul --------

test('server.js: pragul de varsta e conservator (20 minute, STRICT peste LOCAL_POLL_TIMEOUT-ul de ~15 minute din pollForResult) si intervalul job-ului e 5 minute', () => {
  assert.match(serverSrc, /STUCK_GENERATION_RECOVERY_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(serverSrc, /STUCK_GENERATION_MIN_AGE_MS\s*=\s*20\s*\*\s*60\s*\*\s*1000/);
});

test('server.js: recoverStuckGenerationsPeriodic() calculeaza cutoff-ul din STUCK_GENERATION_MIN_AGE_MS si il paseaza catre db.getStuckInFlightOrdersOlderThan', () => {
  const fn = extractFn(serverSrc, 'async function recoverStuckGenerationsPeriodic() {');
  assert.match(fn, /new Date\(Date\.now\(\)\s*-\s*STUCK_GENERATION_MIN_AGE_MS\)/);
  assert.match(fn, /db\.getStuckInFlightOrdersOlderThan\(cutoff\)/);
});

// -------- server.js: recoverSingleStuckGeneration — scenarii de skip --------

test('server.js: recoverSingleStuckGeneration ignora o comanda deja finalizata (preview_ready/ready/generation_failed) — reverificare "proaspata" inainte de reluare', () => {
  const fn = extractFn(serverSrc, 'async function recoverSingleStuckGeneration(candidateOrderId) {');
  assert.match(fn, /db\.getOrderById\(candidateOrderId\)/);
  assert.match(fn, /\['preview_ready',\s*'ready',\s*'generation_failed'\]\.includes\(fresh\.status\)/);
});

test('server.js: recoverSingleStuckGeneration ignora o comanda fara music_task_id', () => {
  const fn = extractFn(serverSrc, 'async function recoverSingleStuckGeneration(candidateOrderId) {');
  assert.match(fn, /if\s*\(!fresh\.musicTaskId\)/);
});

// -------- server.js: dual vs single dispatch --------

test('server.js: recoverSingleStuckGeneration foloseste EXACT logica dual/single existenta (musicTaskId2 -> resumeDualTaskPolling, altfel -> resumeExistingTaskPolling) — NU creeaza un task Suno nou si NU apeleaza pollForResult/finalizeVariantsIfNeeded direct', () => {
  const fn = extractFn(serverSrc, 'async function recoverSingleStuckGeneration(candidateOrderId) {');
  assert.match(fn, /resumeDualTaskPolling\(fresh\.id\)/);
  assert.match(fn, /resumeExistingTaskPolling\(fresh\.id, fresh\.musicTaskId\)/);
  assert.doesNotMatch(fn, /callMusicProvider/);
  assert.doesNotMatch(fn, /pollForResult\(/);
  assert.doesNotMatch(fn, /finalizeVariantsIfNeeded\(/);
});

// -------- concurrency / idempotency: mostenita din functiile reutilizate --------

test('concurrency: resumeExistingTaskPolling si resumeDualTaskPolling (reutilizate neschimbate de recovery periodic) folosesc garda in-memory activePollResumptions impotriva reluarii duble', () => {
  const single = extractFn(serverSrc, 'async function resumeExistingTaskPolling(orderId, taskId) {');
  const dual = extractFn(serverSrc, 'async function resumeDualTaskPolling(orderId) {');
  assert.match(single, /activePollResumptions\.has\(orderId\)/);
  assert.match(dual, /activePollResumptions\.has\(orderId\)/);
});

test('concurrency: finalizeVariantsIfNeeded (neatinsa) foloseste preluare atomica din DB (claimOrderForProviderFinalization) — previne finalizarea dubla intre callback si recovery periodic', () => {
  const fn = extractFn(serverSrc, 'async function finalizeVariantsIfNeeded(orderId, requestsInfo, options = {}) {');
  assert.match(fn, /db\.claimOrderForProviderFinalization\(orderId\)/);
});

// -------- job-ul continua dupa o eroare izolata (requirement: eroare temporara la recovery) --------

test('server.js: recoverStuckGenerationsPeriodic porneste recuperarea per-comanda fire-and-forget (.catch izolat) — o eroare la o comanda NU opreste restul lotului', () => {
  const fn = extractFn(serverSrc, 'async function recoverStuckGenerationsPeriodic() {');
  assert.match(fn, /for\s*\(const order of stuck\)\s*\{/);
  assert.match(fn, /recoverSingleStuckGeneration\(order\.id\)\.catch\(/);
});

test('server.js: recoverStuckGenerationsPeriodic are propriul try/catch in jurul interogarii DB — o eroare tranzitorie la citire nu opreste procesul, doar scanarea curenta', () => {
  const fn = extractFn(serverSrc, 'async function recoverStuckGenerationsPeriodic() {');
  assert.match(fn, /try\s*\{[\s\S]*catch\s*\(err\)\s*\{[\s\S]*return;/);
});

// -------- job-ul nu blocheaza shutdown-ul --------

test('server.js: startPeriodicStuckGenerationRecovery foloseste setInterval(...).unref() — nu tine procesul in viata si nu blocheaza shutdown-ul normal', () => {
  const fn = extractFn(serverSrc, 'function startPeriodicStuckGenerationRecovery() {');
  assert.match(fn, /setInterval\(/);
  assert.match(fn, /\.unref\(\)/);
  assert.match(fn, /STUCK_GENERATION_RECOVERY_INTERVAL_MS/);
});

// -------- boot: strat suplimentar, nu inlocuitor --------

test('server.js: startPeriodicStuckGenerationRecovery e pornit la boot ALATURI de (nu in locul) resumeStuckGenerationsOnBoot', () => {
  const start = serverSrc.indexOf('db.initDb()');
  assert.notEqual(start, -1);
  const bootBlock = serverSrc.slice(start, start + 1600);
  assert.match(bootBlock, /resumeStuckGenerationsOnBoot\(\);/);
  assert.match(bootBlock, /startPeriodicStuckGenerationRecovery\(\);/);
});

// -------- loguri: fara date personale --------

test('server.js: logurile de recovery periodic contin STRICT order id (nu email/alte date personale) si acopera toate etapele cerute', () => {
  const scanFn = extractFn(serverSrc, 'async function recoverStuckGenerationsPeriodic() {');
  assert.match(scanFn, /\[stuck-recovery\] recovery scan started: \$\{stuck\.length\}/);

  const singleFn = extractFn(serverSrc, 'async function recoverSingleStuckGeneration(candidateOrderId) {');
  assert.match(singleFn, /\[stuck-recovery\] skipped order=\$\{candidateOrderId\} motiv=/);
  assert.match(singleFn, /\[stuck-recovery\] recovery attempted order=\$\{candidateOrderId\}/);
  assert.match(singleFn, /\[stuck-recovery\] recovered order=\$\{candidateOrderId\}/);
  assert.doesNotMatch(singleFn, /\.email/);

  const periodicFn = extractFn(serverSrc, 'async function recoverStuckGenerationsPeriodic() {');
  assert.match(periodicFn, /\[stuck-recovery\] failed order=\$\{order\.id\} motiv=\$\{err\.message\}/);
});
