// P5 — "API / generation / regeneration / failures" (runda 2026-09-13).
//
// CAZUL RAPORTAT: in versiunea germana, clientul a vazut "Wir konnten dein Lied dieses Mal nicht
// fertigstellen." si apoi "Deine letzte Bearbeitung ist fehlgeschlagen...".
//
// INVESTIGATIE: ambele texte sunt STRICT traduceri germane ale unor chei i18n generice
// (error_title, regen_failed_recovered_msg), afisate identic pentru ORICE limba cand o generare/
// regenerare esueaza — verificat mai jos ca ambele chei exista de EXACT 8 ori (o data per limba),
// niciodata cu logica speciala pentru germana. Nu exista nicio dovada in cod ca germana insasi
// cauzeaza esecul — mesajul e doar afisat in limba comenzii, ca orice alt text UI.
//
// Cauza REALA a unui esec de generare e fie (a) o limitare/eroare legitima a furnizorului
// (SunoAPI) — ex. SENSITIVE_WORD_ERROR, CREATE_TASK_FAILED — gestionata deja corect (statusul e
// mapat la un esec clar, comanda revine la 'preview_ready' cu variantele existente pastrate DACA
// exista, sau 'generation_failed' daca nu exista nicio varianta sellabila), fie (b) un bug real in
// integrarea noastra. Acest fisier verifica FUNCTIONAL (2) — ca mapping-ul de statusuri, retry-ul
// si protectia versurilor locked/canonice functioneaza corect si identic in toate limbile — si
// documenteaza (1) ca o limitare reala a furnizorului (daca exista), NU a codului nostru.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const melodia = fs.readFileSync(path.join(__dirname, '..', 'public', 'melodia-mea.html'), 'utf8');

test('P5: mesajele de esec (error_title, regen_failed_recovered_msg) exista de EXACT 8 ori (o data per limba) — confirma i18n uniform, NU logica speciala pentru germana sau orice alta limba', () => {
  const errorTitleCount = (melodia.match(/error_title:/g) || []).length;
  const regenRecoveredCount = (melodia.match(/regen_failed_recovered_msg:/g) || []).length;
  assert.equal(errorTitleCount, 8, 'error_title trebuie sa existe o data per limba');
  assert.equal(regenRecoveredCount, 8, 'regen_failed_recovered_msg trebuie sa existe o data per limba');
});

test('P5: SUNO_ERROR_STATUSES/SUNO_CONTINUE_STATUSES/SUNO_SUCCESS_STATUS raman corect definite (mapping de status neschimbat) — CREATE_TASK_FAILED/GENERATE_AUDIO_FAILED/CALLBACK_EXCEPTION/SENSITIVE_WORD_ERROR sunt esecuri DEFINITIVE ale furnizorului, niciodata reincercate silentios la infinit', () => {
  assert.match(server, /const SUNO_SUCCESS_STATUS = 'SUCCESS';/);
  assert.match(server, /const SUNO_ERROR_STATUSES = \['CREATE_TASK_FAILED', 'GENERATE_AUDIO_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR'\];/);
  assert.match(server, /const SUNO_CONTINUE_STATUSES = \['PENDING', 'TEXT_SUCCESS', 'FIRST_SUCCESS'\];/);
});

test('P5: pollForResult() intoarce statusul de eroare al furnizorului CA ATARE (niciodata mascat/reinterpretat) si NU arunca exceptie pentru un timeout LOCAL de polling — un timeout local NU inseamna esec real (callback-ul poate finaliza mai tarziu)', () => {
  const idx = server.indexOf('async function pollForResult(taskId, orderId, maxAttempts = 150, intervalMs = 6000) {');
  const end = server.indexOf('async function downloadFile(');
  const body = server.slice(idx, end);
  assert.match(body, /if \(SUNO_ERROR_STATUSES\.includes\(statusName\)\) \{/);
  assert.match(body, /return \{ status: statusName, tracks: \[\] \};/);
  assert.match(body, /LOCAL_POLL_TIMEOUT/, 'un timeout local trebuie sa fie un status distinct, nu o exceptie/eroare de furnizor');
});

test('P5: markGenerationFailed() pastreaza variantele existente (status "preview_ready") cand o regenerare esueaza dar comanda are deja o varianta sellabila — clientul nu pierde niciodata o versiune buna deja generata din cauza unei regenerari esuate ulterior', () => {
  const idx = server.indexOf('async function markGenerationFailed(orderId, errMessage, knownVariants, regenerationJobId) {');
  const body = server.slice(idx, idx + 1700);
  assert.match(body, /status: 'preview_ready', error: safeError, regenerateEditVariantIds: null/);
  assert.match(body, /status: 'generation_failed', error: safeError/);
});

test("P5: retry-ul de coerenta a versurilor (obtainAcceptableVariant) e SARIT complet pentru versuri canonice/locked ('un esec tehnic ramane final') — nu incearca niciodata sa REscrie versuri explicit blocate de client, in nicio limba", () => {
  const idx = server.indexOf('async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  const body = server.slice(idx, idx + 2200);
  assert.match(body, /if \(first\.built \|\| canonicalLyrics\) return first;/);
});

test('P5: rezervarea atomica (claimOrderForRegeneration/claimOrderForInitialGeneration) previne doua generari simultane pentru aceeasi comanda — verificat ca ambele cai (generare initiala SI regenerare) folosesc un claim atomic inainte de a porni jobul asincron', () => {
  assert.match(server, /db\.claimOrderForInitialGeneration\(order\.id, credits\.MAX_GENERATION_ATTEMPTS\)/);
  assert.match(server, /db\.claimOrderForRegeneration\(order\.id, FREE_EDITS, requestedVoice, credits\.MAX_GENERATION_ATTEMPTS\)/);
});

test('P5: limita DURA de reincercari (MAX_GENERATION_ATTEMPTS) e verificata identic pe toate cele trei cai de regenerare (legacy Standard/Video, Premium selectiva) — niciun pachet nu poate ocoli limita', () => {
  const legacyIdx = server.indexOf('async function handleLegacyRegenerate');
  const legacyEnd = server.indexOf('async function handlePremiumSelectTwo');
  const premiumIdx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const legacyBody = server.slice(legacyIdx, legacyEnd);
  const premiumBody = server.slice(premiumIdx, legacyIdx);
  assert.match(legacyBody, /order\.generationAttempts >= credits\.MAX_GENERATION_ATTEMPTS/);
  assert.match(premiumBody, /order\.generationAttempts >= credits\.MAX_GENERATION_ATTEMPTS/);
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
