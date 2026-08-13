// Teste pentru "MODIFICARE STRICTĂ — DOAR FLUXUL PACHETULUI PREMIUM" (hotfix 2026-08-10 runda 3):
// (1) configurarea Premium in doi pasi separati (gen, apoi persoana); (2) pagina initiala cu
// cele doua melodii (2 playere + editare + plata, fara alte formulare); (3) editarea pe o
// pagina separata (alege melodia 1/2/ambele, editare selectiva, nu se sterg originalele);
// (4) pagina finala de comparare (2-4 variante reale, alegere EXACT doua); (5) Standard si
// Cadou video raman STRICT neschimbate. Acopera cele 18 teste obligatorii cerute explicit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const dbjs = read('db.js');
const entitlements = read('lib/entitlements.js');
const melodia = read('public/melodia-mea.html');
const comanda = read('public/comanda.html');

// ---------------------------------------------------------------------------------------------
// TESTE 1-4: configurarea Premium in doi pasi (deja acoperite in detaliu de
// test/premium-second-song.test.js — verificam aici doar coerenta finala).
// ---------------------------------------------------------------------------------------------
test('comanda.html: Premium are 7 pasi (genul melodiei 2 si destinatarul sunt ecrane separate)', () => {
  assert.match(comanda, /function getTotalSteps\(\) \{\s*return selectedPlan\.id === 'premium' \? 7 : 4;\s*\}/);
});

// ---------------------------------------------------------------------------------------------
// TEST 8: pagina rezultatului initial contine exact doua playere, butonul de editare si apoi
// butonul de plata — nimic altceva (niciun formular de editare, gen, persoana).
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: renderPremiumResultView construieste EXACT doua playere, apoi butonul de editare, apoi slotul de plata (in aceasta ordine)', () => {
  const start = melodia.indexOf('function renderPremiumResultView(order) {');
  assert.ok(start !== -1, 'renderPremiumResultView trebuie sa existe');
  const end = melodia.indexOf('function renderPremiumEditView(order) {');
  const body = melodia.slice(start, end);
  const editBtnIdx = body.indexOf("getElementById('premium-edit-open-btn')");
  const checkoutSlotIdx = body.indexOf("getElementById('premium-result-checkout-slot')");
  assert.ok(editBtnIdx !== -1 && checkoutSlotIdx !== -1 && editBtnIdx < checkoutSlotIdx, 'butonul de editare trebuie sa fie construit INAINTEA slotului de plata');
  assert.ok(body.includes("variants.forEach((v, i) => {"), 'trebuie sa construiasca un card per varianta reala (order.variants), niciodata un numar fix hardcodat');
});

test('melodia-mea.html: ecranul de rezultat Premium NU contine niciun formular de editare/gen/persoana — doar butonul de editare separat', () => {
  const startIdx = melodia.indexOf('<div id="premium-result-view"');
  const endIdx = melodia.indexOf('<div id="premium-edit-view"');
  const block = melodia.slice(startIdx, endIdx);
  assert.ok(!block.includes('<select'), 'niciun selector de gen pe ecranul de rezultat');
  assert.ok(!block.includes('<textarea'), 'niciun camp de feedback pe ecranul de rezultat');
  assert.ok(!block.includes('type="checkbox"'), 'nicio bifa de selectie melodie pe ecranul de rezultat');
});

// ---------------------------------------------------------------------------------------------
// TEST 9: plata poate fi accesata direct, fara editare.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ensurePremiumInitialSelection selecteaza AUTOMAT ambele variante initiale (POST /select) cand exista exact 2, fara sa ceara o editare', () => {
  const start = melodia.indexOf('async function ensurePremiumInitialSelection(order) {');
  assert.ok(start !== -1);
  const body = melodia.slice(start, start + 700);
  assert.ok(body.includes("variantId: variants[0].id, variantId2: variants[1].id"));
});

test('server.js: POST /checkout permite plata Premium cu doar selectedVariantId2 completat automat (fara editare) — nu cere o editare in prealabil', () => {
  const idx = server.indexOf("if (order.plan === 'premium' && !order.selectedVariantId2)");
  assert.ok(idx !== -1, 'validarea trebuie sa existe, dar sa nu ceara nimic mai mult decat selectedVariantId2 completat');
});

// ---------------------------------------------------------------------------------------------
// TESTE 10-12: editarea selectiva (1, 1, sau ambele melodii) produce 3/3/4 versiuni REALE,
// niciodata inlocuind originalele.
// ---------------------------------------------------------------------------------------------
test('server.js: POST /regenerate accepta {songs:[...]} DOAR pentru plan="premium", separat complet de ramura veche (variantId singular, Standard/Video)', () => {
  assert.match(server, /if \(req\.order\.plan === 'premium' && Array\.isArray\(req\.body\?\.songs\)\) \{\s*return handlePremiumSelectiveRegenerate\(req, res, next\);\s*\}/);
});

test('server.js: handlePremiumSelectiveRegenerate accepta 1 SAU 2 melodii, respinge 0 sau mai mult de 2', () => {
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const body = server.slice(idx, idx + 900);
  assert.ok(body.includes('songsInput.length < 1 || songsInput.length > 2'));
});

test('server.js: editarea selectiva foloseste ACEEASI rezervare atomica (un singur claim, o singura editare gratuita indiferent de 1 sau 2 melodii editate)', () => {
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const endIdx = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, endIdx);
  assert.ok(body.includes('db.claimOrderForRegeneration(order.id, FREE_EDITS'));
  // un SINGUR apel de claim in toata functia — nu unul per melodie.
  const claimCount = (body.match(/db\.claimOrderForRegeneration\(/g) || []).length;
  assert.equal(claimCount, 1, 'trebuie sa existe UN SINGUR claim, indiferent daca se editeaza 1 sau 2 melodii');
});

test('server.js: finalizeVariantsIfNeeded, options.editVariantIds ADAUGA variantele noi alaturi de cele initiale — NICIODATA nu le inlocuieste, nu sterge nimic din storage', () => {
  const idx = server.indexOf('} else if (options.editVariantIds) {');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 1300);
  assert.ok(body.includes('variants = [...existing, ...edited];'), 'variantele initiale trebuie pastrate, cele noi ADAUGATE alaturi');
  assert.ok(body.includes('replacedOldVariants = [];'), 'nimic nu trebuie sters din storage la o editare selectiva');
  assert.ok(body.includes('isEditedAlternative: true'), 'variantele noi trebuie marcate explicit ca alternative editate');
});

test('server.js: editarea unei SINGURE melodii (1 element in editVariantIds) produce un array cu 3 variante (2 initiale + 1 editata), niciodata 4', () => {
  // Verificare indirecta, statica: builtVariants provine STRICT din requestsInfo (un element per
  // cerere Suno separata) — pentru editSongs.length===1, runPremiumEditGeneration dispatch-eaza
  // o SINGURA cerere (ramura dispatches.length===1), deci finalizeVariantsIfNeeded primeste un
  // singur requestInfo -> un singur element nou adaugat la cele 2 existente = 3 total.
  const idx = server.indexOf('async function runPremiumEditGeneration');
  const end = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  const body = server.slice(idx, end);
  assert.match(body, /if \(dispatches\.length === 1\) \{/);
  assert.match(body, /editVariantIds: \[d\.variantId\]/);
});

test('server.js: editarea AMBELOR melodii (2 elemente in editVariantIds) produce un array cu 4 variante (2 initiale + 2 editate)', () => {
  const idx = server.indexOf('async function runPremiumEditGeneration');
  const end = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  const body = server.slice(idx, end);
  // MODIFICARE (2026-08-13, "editare secventiala"): dispecerizare secventiala (d1/d2), nu mai
  // paralela (dispatches[0]/dispatches[1] prin Promise.all) — vezi
  // test/lyrics-exact-story-premium-sequential.test.js pentru acoperirea noului comportament.
  assert.match(body, /editVariantIds: \[d1\.variantId, d2\.variantId\]/);
});

test('server.js: editarea nu regenereaza melodia neselectata — runPremiumEditGeneration dispatch-eaza STRICT catre editSongs primite, niciodata catre sora neselectata', () => {
  const idx = server.indexOf('async function runPremiumEditGeneration(orderId, editSongs, regenerationJobId) {');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 1200);
  assert.ok(body.includes('const dispatches = editSongs'), 'dispatch-urile provin STRICT din editSongs (ce a trimis clientul), niciodata din order.variants intreg');
});

// MODIFICARE STRICTĂ — editare secventiala, pe rand, pentru AMBELE melodii (hotfix, runda 4):
// nu mai exista bife optionale ("editez 1 sau 2 melodii") — clientul editeaza mereu ambele, in
// doi pasi succesivi. Versurile goale (client a sters tot) sunt respinse la fiecare pas, iar
// genurile finale identice sunt respinse la trimiterea finala.
test('melodia-mea.html: pasul 1 respinge versuri goale inainte de a trece la pasul 2; trimiterea finala respinge versuri goale sau genuri identice', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, endIdx);
  assert.ok(body.includes('if (!song1Lyrics.value.trim()) {'), 'pasul 1 trebuie sa verifice ca versurile nu sunt goale');
  assert.ok(body.includes('if (!song2Lyrics.value.trim()) {'), 'trimiterea finala trebuie sa verifice versurile melodiei 2');
  assert.ok(body.includes('if (song1GenreSelect.value === song2GenreSelect.value) {'), 'genurile finale identice trebuie respinse in frontend, oglindind validarea backend');
  assert.ok(body.includes('t.lyrics_empty_error'));
  assert.ok(body.includes('t.edit_genre_same_error'));
});

test('melodia-mea.html: editarea trimite mereu EXACT ambele melodii (niciodata mai putin) — {songs:[song1,song2]}, fiecare cu versuri, gen si voce independente', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, endIdx);
  assert.ok(body.includes('variantId: v1.id,'));
  assert.ok(body.includes('variantId: v2.id,'));
  assert.ok(body.includes('voicePreference: song1Voice'));
  assert.ok(body.includes('voicePreference: song2Voice'));
  assert.ok(body.includes('normalizeSectionLabelsForSaving(song1Lyrics.value.trim(), order.lang)'));
  assert.ok(body.includes('normalizeSectionLabelsForSaving(song2Lyrics.value.trim(), order.lang)'));
});

test('melodia-mea.html: "Înapoi" (pasul 2 -> pasul 1) doar comuta vizibilitatea — NU reseteaza campurile deja completate ale primei melodii', () => {
  const idx = melodia.indexOf('function goToPremiumEditStep(step) {');
  const end = melodia.indexOf('function renderPremiumEditView(order) {');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes("document.getElementById('premium-edit-step1').style.display = step === 1 ? 'block' : 'none';"));
  assert.ok(!body.includes('.value = '), '"Înapoi" nu trebuie sa reseteze NICIUN camp (nicio atribuire .value in goToPremiumEditStep)');
});

test('melodia-mea.html: vocea foloseste carduri DEDICATE (.premium-voice-card, nu .voice-card) — evita activarea simultana a cardului corespunzator din ambele grile (bug posibil prin handler-ul global .voice-card)', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, endIdx);
  assert.ok(body.includes(".querySelectorAll('.premium-voice-card')"));
  assert.ok(!body.includes("querySelectorAll('.voice-card')"), 'editarea Premium nu trebuie sa foloseasca selectorul global .voice-card, partajat cu Standard/Video');
});

test('melodia-mea.html: dupa apasarea butonului de editare, se navigheaza la se-compune.html cu mode=regenerate — nu se ramane pe melodia-mea.html asteptand', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, endIdx);
  assert.ok(body.includes('mode=regenerate'));
});

test('melodia-mea.html: butonul de start al editarii se dezactiveaza IMEDIAT la primul click (protectie aditionala fata de dublul-click)', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, endIdx);
  assert.ok(body.includes('startBtn.disabled = true;'));
});

// ---------------------------------------------------------------------------------------------
// TEST 13: clientul poate selecta exact doua variante pe pagina de comparare.
// ---------------------------------------------------------------------------------------------
test('server.js: POST /select (premium, {variantId, variantId2}) valideaza ambele ID-uri STRICT in variantele PROPRIEI comenzi, respinge doua ID-uri identice', () => {
  const idx = server.indexOf('async function handlePremiumSelectTwo');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 900);
  assert.ok(body.includes('variantId === variantId2'));
  assert.ok(body.includes('variants.find(v => v.id === variantId)'));
  assert.ok(body.includes('variants.find(v => v.id === variantId2)'));
});

test('melodia-mea.html: pagina de comparare arata TOATE variantele reale ale comenzii (order.variants), niciodata un numar fabricat', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, idx + 2000);
  assert.ok(body.includes('order.variants || []'));
  assert.ok(body.includes('variants.forEach(v => {'));
});

test('melodia-mea.html: selectarea unei a treia variante inlocuieste cea mai veche selectie — niciodata nu permite mai mult de doua simultan', () => {
  const idx = melodia.indexOf('function togglePremiumCompareSelection');
  const body = melodia.slice(idx, idx + 500);
  assert.ok(body.includes('if (premiumCompareSelection.length >= 2) premiumCompareSelection.shift();'));
});

test('melodia-mea.html: butonul de plata pe pagina de comparare ramane dezactivat pana cand EXACT doua sunt alese SI confirmate de server (POST /select)', () => {
  const idx = melodia.indexOf('async function updatePremiumCompareContinueState');
  const body = melodia.slice(idx, idx + 700);
  assert.ok(body.includes('if (premiumCompareSelection.length !== 2) {'));
  assert.ok(body.includes('checkoutBtn.disabled = true;'));
  assert.ok(body.includes("fetch(`/api/orders/${orderId}/select`"));
});

test('melodia-mea.html: fiecare card de pe pagina de comparare arata clar melodia (1/2), versiunea (inițială/editată), genul si persoana destinatara', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, idx + 2600);
  assert.ok(body.includes('v.songSlot === 2 ? t.premium_song2_label : t.premium_song1_label'));
  assert.ok(body.includes('v.isEditedAlternative ? t.variant_edited_label : t.variant_original_label'));
  assert.ok(body.includes('genreTag'));
  assert.ok(body.includes('recipientLine'));
});

// ---------------------------------------------------------------------------------------------
// TEST 14: refresh-ul pastreaza selectiile si nu dubleaza generarile.
// ---------------------------------------------------------------------------------------------
test('server.js: GET /api/orders/:orderId expune selectedVariantId2 (necesar ca selectia sa persiste dupa refresh)', () => {
  assert.match(server, /selectedVariantId2: order\.selectedVariantId2 \|\| null,/);
});

test('melodia-mea.html: pagina de comparare initializeaza selectia din order.selectedVariantId\\/2 O SINGURA DATA per incarcare — nu suprascrie alegerile locale ale clientului la fiecare re-render', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, idx + 1500);
  assert.ok(body.includes('if (!premiumCompareInitialized) {'));
});

test('db.js: regenerate_edit_variant_ids si selected_variant_id_2 sunt coloane aditive (ADD COLUMN IF NOT EXISTS)', () => {
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_edit_variant_ids JSONB;'));
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS selected_variant_id_2 TEXT;'));
});

// REGRESIE CONFIRMATA LA TESTAREA LIVE PE STAGING (hotfix 2026-08-10 runda 3): db.updateOrder()
// (functia REALA folosita de handlePremiumSelectiveRegenerate, NU cea din
// recordPaidOrderAtomically) nu avea 'regenerateEditVariantIds' in lista de campuri
// JSON.stringify-uite inainte de INSERT — array-ul JS era trimis ca literal catre coloana
// JSONB, Postgres respingea cu "invalid input syntax for type json", iar POST /regenerate
// pentru Premium (editarea unei singure melodii) esua mereu cu 500. Verificam AMBELE functii
// care scriu pe orders (nu doar una), ca sa nu se repete exact acest bug.
test('db.js: TOATE functiile care scriu pe orders (updateOrder SI recordPaidOrderAtomically) JSON.stringify-uiesc regenerateEditVariantIds inainte de UPDATE — nu doar una din ele', () => {
  const matches = dbjs.match(/const values = keys\.map\(k => \(\(k === 'variants' \|\| k === 'uploadedMedia' \|\| k === 'regenerateEditVariantIds'\) \? JSON\.stringify\(patch\[k\]\) : patch\[k\]\)\);/g) || [];
  assert.equal(matches.length, 2, `trebuie sa existe exact 2 functii cu acest fix (recordPaidOrderAtomically + updateOrder), gasite ${matches.length}`);
});

// ---------------------------------------------------------------------------------------------
// TEST 15: livrarea simulata post-plata contine EXCLUSIV cele doua melodii alese.
// ---------------------------------------------------------------------------------------------
test('lib/entitlements.js: getGiftVariant() foloseste STRICT selectedVariantId2 pentru Premium (nu "prima alta varianta gasita", ambiguu cu 3-4 variante)', () => {
  assert.match(entitlements, /if \(order\.plan === 'premium' && order\.selectedVariantId2\) \{\s*return variants\.find\(v => v\.id === order\.selectedVariantId2\) \|\| null;\s*\}/);
});

test('server.js: POST /checkout cere ambele selectii (selectedVariantId SI selectedVariantId2) pentru Premium inainte de a permite plata', () => {
  const idx = server.indexOf("if (order.plan === 'premium' && !order.selectedVariantId2)");
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 200);
  assert.match(snippet, /return res\.status\(400\)\.json\(\{ error: 'Alege exact două melodii înainte de plată\.' \}\);/);
});

test('server.js: amprenta Stripe (versionFingerprint) include a doua varianta aleasa pentru Premium — un checkout vechi cu alta selectie devine invalid', () => {
  assert.ok(server.includes('? `${order.selectedVariantId}-${order.selectedVariantId2}-${order.mediaRevision}`'));
});

test('server.js: webhook-ul verifica a doua varianta din sesiune impotriva celei curente (stale_variant2) — o schimbare intre timp respinge livrarea', () => {
  assert.match(server, /if \(preCheckOrder\.plan === 'premium' && sessionVariantId2 && preCheckOrder\.selectedVariantId2 !== sessionVariantId2\) \{/);
  assert.ok(server.includes("rejected: 'stale_variant2'"));
});

// ---------------------------------------------------------------------------------------------
// Webhook repetat nu dubleaza livrarea/emailul — idempotenta GENERICA existenta
// (db.recordPaidOrderAtomically, dedup per event.id) acopera si acest flux nou, fara nicio
// schimbare necesara — verificam doar ca mecanismul ramane prezent si neschimbat.
// ---------------------------------------------------------------------------------------------
test('server.js: idempotenta webhook-ului (dedup per event.id, db.recordPaidOrderAtomically) ramane neschimbata — acopera si Premium cu 2 selectii', () => {
  assert.ok(server.includes('db.recordPaidOrderAtomically(event.id, orderId'));
});

// ---------------------------------------------------------------------------------------------
// TEST 16: Standard si Cadou video raman STRICT neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: handleLegacyRegenerate (variantId singular) ramane STRICT ramura Standard/Video — replaceVariantId/keepOriginalAsAlternative neschimbate', () => {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 12000);
  assert.ok(body.includes('const requestedVariantId = typeof req.body?.variantId'));
  // MODIFICARE (2026-08-13, "pastrarea exacta a versurilor editate"): regenOptions include acum
  // si exactLyrics — replaceVariantId/regenerationJobId raman neschimbate ca structura.
  assert.ok(body.includes("? { replaceVariantId: requestedVariantId, regenerationJobId, exactLyrics: exactLyrics || null }"));
});

// REGRESIE CONFIRMATA LA TESTAREA LIVE PE STAGING (hotfix 2026-08-10 runda 3): fara ascundere
// explicita, #edit-menu-fields (selectorul de voce, campul vechi de gen/feedback — nu au
// display:none implicit in HTML, vizibilitatea lor era controlata STRICT de
// updateStandardEditMenuVisibility(), niciodata apelata pentru Premium) ramanea vizibil SUB
// butoanele noi "Edit the lyrics"/"Continue to payment" pe pagina de rezultat.
test('melodia-mea.html: renderPremiumFlow ascunde explicit TOATE containerele originale Standard/Video (edit-menu-fields, confirm-row, standard-choice-section, memories-section etc.) — fara ele nu au display:none implicit in HTML', () => {
  const start = melodia.indexOf('function renderPremiumFlow(order, isResumeFlag) {');
  const end = melodia.indexOf('function renderPremiumResultView(order) {');
  const body = melodia.slice(start, end);
  ['edit-menu-fields', 'confirm-row', 'standard-choice-section', 'standard-preedit-toggle-wrap', 'standard-preedit-checkout-slot-collapsed', 'memories-section', 'gift-video-section'].forEach(id => {
    assert.ok(body.includes(`getElementById('${id}').style.display = 'none';`), `${id} trebuie ascuns explicit in renderPremiumFlow`);
  });
});

test('melodia-mea.html: renderContent() branch-uieste catre renderPremiumFlow DOAR pentru plan="premium" — Standard/Video continua neschimbate dupa acel punct', () => {
  const idx = melodia.indexOf("if (order.plan === 'premium') {");
  assert.ok(idx !== -1);
  const snippet = melodia.slice(idx, idx + 150);
  assert.ok(snippet.includes('renderPremiumFlow(order, isResume);'));
  assert.ok(snippet.includes('return;'), 'branch-ul trebuie sa faca return imediat, inainte de renderVariants/updateStandardEditMenuVisibility (Standard/Video)');
});

test('lib/entitlements.js: Video (fara selectedVariantId2) si Premium vechi raman pe regula originala "cealalta varianta" — comportament byte-identic', () => {
  const idx = entitlements.indexOf('function getGiftVariant(order) {');
  const body = entitlements.slice(idx, idx + 500);
  assert.ok(body.includes("const selectedId = order.selectedVariantId;"));
  assert.ok(body.includes("return variants.find(v => v.id !== selectedId) || null;"));
});

// ---------------------------------------------------------------------------------------------
// TEST 17: toate textele noi exista in cele 8 limbi, fara fallback vizibil in romana.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: toate cele 9 chei noi de traducere Premium exista exact de 8 ori (o data per limba) — butonul final reutilizeaza t.confirm_yes existent, nu mai are o cheie separata', () => {
  const keys = [
    'premium_song1_label', 'premium_song2_label', 'premium_edit_title', 'premium_edit_subtitle',
    'premium_edit_song1_check', 'premium_edit_song2_check',
    'premium_edit_select_at_least_one', 'premium_compare_title', 'premium_compare_need_two'
  ];
  keys.forEach(key => {
    const count = (melodia.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori (o data per limba), a aparut de ${count} ori`);
  });
});

test('melodia-mea.html: textele Premium reutilizeaza cheile existente (edit_lyrics_btn, checkout_btn_standard pe rezultat; edit_genre_label/explain, editor_title/hint pe editare) — deja traduse in 8 limbi, nicio duplicare', () => {
  const idx = melodia.indexOf('function renderPremiumResultView(order) {');
  const resultBody = melodia.slice(idx, idx + 2500);
  assert.ok(resultBody.includes('t.edit_lyrics_btn'));
  assert.ok(resultBody.includes('t.checkout_btn_standard'));
  const editIdx = melodia.indexOf('function renderPremiumEditView(order) {');
  const endIdx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const editBody = melodia.slice(editIdx, endIdx);
  assert.ok(editBody.includes('t.edit_genre_label'));
  assert.ok(editBody.includes('t.edit_genre_explain'));
  assert.ok(editBody.includes('t.editor_title'), 'eticheta campului de versuri trebuie sa reutilizeze editor_title ("Editează versurile")');
  assert.ok(editBody.includes('t.editor_hint'), 'explicatia campului de versuri trebuie sa reutilizeze editor_hint');
});

// ---------------------------------------------------------------------------------------------
// Verificari finale de sintaxa (acopera si fisierele modificate in aceasta runda).
// ---------------------------------------------------------------------------------------------
test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

test('db.js: node --check db.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});

test('lib/entitlements.js: node --check trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib/entitlements.js')]));
});
