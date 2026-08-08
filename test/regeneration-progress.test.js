// Teste de regresie STATICE pentru progresul de REGENERARE, SEPARAT complet de progresul
// generarii initiale (hotfix 2026-08-08, "FINISAJ FINAL PACHET STANDARD"). Bug real gasit:
// cele doua foloseau aceeasi coloana (generation_phase_percent) — o comanda ajunsa deja 100%
// (generare initiala) facea ca milestone-ul "submitted"=10% al unei regenerari sa fie respins
// tacit (10 < 100), lasand procentul afisat inghetat la 100% pe tot parcursul regenerarii.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('db.js: cele 5 coloane de regenerare exista (migrare aditiva, complet separate de generation_phase*)', () => {
  const dbSrc = read('db.js');
  ['regeneration_job_id TEXT', 'regeneration_status TEXT', 'regeneration_phase TEXT',
    'regeneration_progress INTEGER', 'regeneration_updated_at TIMESTAMPTZ'].forEach(col => {
    assert.ok(dbSrc.includes(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col};`), `coloana "${col}" trebuie sa existe`);
  });
});

test('db.js: startRegenerationJob reseteaza explicit progresul la 10% la fiecare job nou', () => {
  const dbSrc = read('db.js');
  assert.ok(dbSrc.includes('async function startRegenerationJob(orderId, jobId)'), 'functia trebuie sa existe');
  assert.ok(
    dbSrc.includes("regeneration_phase = 'submitted', regeneration_progress = 10"),
    'un job nou trebuie sa porneasca STRICT de la 10%, niciodata mostenind un procent vechi'
  );
});

test('db.js: updateRegenerationPhaseIfLater valideaza jobId-ul curent (raspunsuri intarziate ale unui job vechi nu pot modifica noul progres)', () => {
  const dbSrc = read('db.js');
  assert.ok(dbSrc.includes('async function updateRegenerationPhaseIfLater(orderId, jobId, phase, percent)'), 'functia trebuie sa existe');
  assert.ok(dbSrc.includes('WHERE id = $1 AND regeneration_job_id = $2'), 'scrierea trebuie sa fie scopata strict la jobId-ul curent al comenzii');
  assert.ok(dbSrc.includes('regeneration_progress IS NULL OR regeneration_progress < $4'), 'progresul nu trebuie sa regreseze niciodata vizual');
});

test('db.js: markRegenerationStatus exista si e scopat la jobId', () => {
  const dbSrc = read('db.js');
  assert.ok(dbSrc.includes('async function markRegenerationStatus(orderId, jobId, status)'), 'functia trebuie sa existe');
});

test('db.js: randul citit din DB expune toate cele 5 campuri de regenerare catre server.js', () => {
  const dbSrc = read('db.js');
  ['regenerationJobId: row.regeneration_job_id', 'regenerationStatus: row.regeneration_status',
    'regenerationPhase: row.regeneration_phase', 'regenerationProgress: row.regeneration_progress',
    'regenerationUpdatedAt: row.regeneration_updated_at'].forEach(mapping => {
    assert.ok(dbSrc.includes(mapping), `maparea "${mapping}" trebuie sa existe`);
  });
});

test('server.js: REGENERATION_PHASE_PERCENT contine cele 7 milestone-uri exacte cerute', () => {
  const server = read('server.js');
  assert.ok(server.includes('const REGENERATION_PHASE_PERCENT = {'), 'harta de milestone-uri trebuie sa existe, separata de GENERATION_PHASE_PERCENT');
  const idx = server.indexOf('const REGENERATION_PHASE_PERCENT = {');
  const block = server.slice(idx, idx + 650);
  assert.ok(block.includes('submitted: 10'), '10% — cererea a fost salvata si jobul creat');
  assert.ok(block.includes('prepared: 25'), '25% — instructiunile si genul pregatite');
  assert.ok(block.includes('dispatched: 40'), '40% — trimis furnizorului');
  assert.ok(block.includes('processing: 60'), '60% — furnizorul proceseaza');
  assert.ok(block.includes('audio_ready: 80'), '80% — fisierul audio disponibil');
  assert.ok(block.includes('preview_saved: 90'), '90% — previewul procesat si salvat');
  assert.ok(block.includes('ready: 100'), '100% — previewul verificat, redabil');
});

test('server.js: recordRegenerationProgress refuza sa scrie fara jobId (nu afecteaza generarea initiala)', () => {
  const server = read('server.js');
  const idx = server.indexOf('async function recordRegenerationProgress');
  assert.ok(idx > -1, 'functia trebuie sa existe');
  const block = server.slice(idx, idx + 300);
  assert.ok(block.includes('if (!jobId) return;'), 'fara jobId, functia trebuie sa fie un no-op sigur');
  assert.ok(block.includes('db.updateRegenerationPhaseIfLater'), 'trebuie sa foloseasca functia DB dedicata, cu garda de jobId');
});

test('POST /regenerate: creeaza un regenerationJobId nou si porneste jobul explicit (db.startRegenerationJob)', () => {
  const server = read('server.js');
  assert.ok(server.includes('const regenerationJobId = randomUUID();'), 'trebuie generat un jobId nou la fiecare cerere de regenerare');
  assert.ok(server.includes('await db.startRegenerationJob(order.id, regenerationJobId);'), 'jobul trebuie pornit explicit (reseteaza progresul la 10%)');
});

test('runGeneration: ambele ramuri (Premium/Video partial + Standard) inregistreaza milestone-urile de regenerare in ordine', () => {
  const server = read('server.js');
  const occurrences = (server.match(/recordRegenerationProgress\(orderId, options\.regenerationJobId, '(prepared|dispatched|processing|audio_ready)'\)/g) || []).length;
  // 4 milestone-uri x 2 ramuri (dual-genre partial-replace + Standard) = 8 apeluri
  assert.equal(occurrences, 8, `trebuie sa existe cate un apel pentru fiecare din cele 4 milestone-uri intermediare, in ambele ramuri (gasite ${occurrences})`);
});

test('finalizeVariantsIfNeeded: inregistreaza 90% dupa procesare si 100% + regenerationStatus=ready dupa scrierea in DB', () => {
  const server = read('server.js');
  assert.ok(server.includes("recordRegenerationProgress(orderId, options.regenerationJobId, 'preview_saved')"), '90% trebuie inregistrat dupa ce toate piesele au fost procesate/verificate');
  assert.ok(server.includes("recordRegenerationProgress(orderId, options.regenerationJobId, 'ready')"), '100% trebuie inregistrat DOAR dupa ce scrierea finala in DB a reusit');
  assert.ok(server.includes("db.markRegenerationStatus(orderId, options.regenerationJobId, 'ready')"), 'regenerationStatus trebuie marcat explicit "ready", singurul semnal fiabil de succes pentru se-compune.html');
});

test('markGenerationFailed: marcheaza regenerationStatus=failed cand esecul e intr-un context de regenerare', () => {
  const server = read('server.js');
  assert.ok(server.includes("db.markRegenerationStatus(orderId, regenerationJobId, 'failed')"), 'un esec de regenerare trebuie marcat explicit, de vreme ce order.status revine la preview_ready in ambele cazuri (succes/esec)');
});

test('GET /api/orders/:orderId expune regenerationStatus/regenerationPhase/regenerationProgress, separate de generationPhase*', () => {
  const server = read('server.js');
  assert.ok(server.includes('regenerationStatus: order.regenerationStatus || null,'), 'trebuie expus catre client');
  assert.ok(server.includes('regenerationPhase: order.regenerationPhase || null,'), 'trebuie expus catre client');
  assert.ok(server.includes('regenerationProgress: order.regenerationProgress != null ? order.regenerationProgress : null,'), 'trebuie expus catre client');
});
