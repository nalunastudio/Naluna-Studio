// Teste de regresie STATICE pentru fluxul de editare Standard cu alegere (Partea 2, hotfix
// 2026-08-08): editarea Standard NU mai inlocuieste varianta initiala — o PASTREAZA, adauga
// varianta editata alaturi, si cere clientului sa aleaga explicit intre ele inainte de plata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('db.js: coloana regenerate_keep_original exista (migrare aditiva)', () => {
  const dbSrc = read('db.js');
  assert.ok(
    dbSrc.includes("ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_keep_original BOOLEAN NOT NULL DEFAULT false;"),
    'trebuie sa existe migrarea aditiva pentru regenerate_keep_original'
  );
});

test('db.js: COLUMN_MAP include regenerateKeepOriginal — altfel db.updateOrder(id, {regenerateKeepOriginal}) e no-op tacut', () => {
  const dbSrc = read('db.js');
  assert.match(
    dbSrc,
    /regenerateKeepOriginal:\s*'regenerate_keep_original',/,
    'COLUMN_MAP trebuie sa mapeze explicit regenerateKeepOriginal -> regenerate_keep_original (vezi bugul identic gasit la "genre")'
  );
});

test('db.js: randul citit din DB expune regenerateKeepOriginal', () => {
  const dbSrc = read('db.js');
  assert.ok(dbSrc.includes('regenerateKeepOriginal: !!row.regenerate_keep_original,'), 'maparea row->order trebuie sa citeasca noua coloana');
});

test('server.js: POST /regenerate seteaza regenerateKeepOriginal=true DOAR pentru Standard (o singura varianta)', () => {
  const server = read('server.js');
  assert.ok(
    server.includes('const keepOriginalForStandardEdit = PLAN_VARIANT_COUNT[order.plan] === 1;'),
    'trebuie derivat explicit daca pachetul e Standard (o singura varianta)'
  );
  assert.ok(
    server.includes('regenerateKeepOriginal: keepOriginalForStandardEdit'),
    'valoarea trebuie persistata in DB, pentru reluarile asincrone de polling'
  );
});

test('server.js: regenerarea Standard trece keepOriginalAsAlternative catre runGeneration', () => {
  const server = read('server.js');
  assert.ok(
    server.includes(': { keepOriginalAsAlternative: true };'),
    'ramura non-Premium/Video a regenOptions trebuie sa fie keepOriginalAsAlternative, nu {} (inlocuire completa)'
  );
});

test('finalizeVariantsIfNeeded: options.keepOriginalAsAlternative pastreaza originalul si ADAUGA varianta editata, nu o inlocuieste', () => {
  const server = read('server.js');
  assert.ok(server.includes('variants = [...existing, edited];'), 'trebuie sa adauge varianta noua ALATURI de cele existente, niciodata sa le inlocuiasca');
  assert.ok(server.includes('edited.isEditedAlternative = true;'), 'varianta noua trebuie marcata explicit ca alternativa editata (pentru etichetarea in UI)');
});

test('finalizeVariantsIfNeeded: dupa o editare Standard, selectedVariantId ramane NULL (clientul trebuie sa aleaga explicit)', () => {
  const server = read('server.js');
  const idx = server.indexOf('options.keepOriginalAsAlternative) {');
  assert.ok(idx > -1, 'ramura keepOriginalAsAlternative trebuie sa existe');
  const branch = server.slice(idx, idx + 1200);
  assert.ok(branch.includes('newSelectedVariantId = null;'), 'niciuna din cele doua variante nu trebuie preselectata automat — POST /checkout respinge deja o cerere fara selectedVariantId');
});

test('finalizeVariantsIfNeeded: editarea Standard NU sterge niciun fisier din storage (originalul trebuie sa ramana livrabil)', () => {
  const server = read('server.js');
  const idx = server.indexOf('options.keepOriginalAsAlternative) {');
  const branch = server.slice(idx, idx + 1200);
  assert.ok(branch.includes('replacedOldVariants = [];'), 'nimic nu trebuie sters din storage la editarea Standard cu pastrarea originalului');
});

test('resumeExistingTaskPolling si callback-ul SunoAPI citesc regenerateKeepOriginal din DB pentru Standard (nu doar din optiunile locale ale cererii HTTP originale)', () => {
  const server = read('server.js');
  const occurrences = (server.match(/order\.regenerateKeepOriginal \? \{ keepOriginalAsAlternative: true \} : \{\}/g) || []).length;
  assert.ok(
    occurrences >= 2,
    `reluarea polling-ului si callback-ul SunoAPI trebuie sa foloseasca AMANDOUA regenerateKeepOriginal persistat, gasite ${occurrences}`
  );
});

test('markGenerationFailed: revine la preview_ready (nu generation_failed) cand exista deja variante vandabile', () => {
  const server = read('server.js');
  assert.ok(server.includes('async function markGenerationFailed(orderId, errMessage, knownVariants)'), 'functia trebuie sa existe');
  assert.ok(
    server.includes("await db.updateOrder(orderId, { status: 'preview_ready', error: safeError });"),
    'daca hasSellableVariants, comanda trebuie sa revina la preview_ready, NU generation_failed — cerinta explicita: "daca regenerarea esueaza, versiunea initiala ramane disponibila/selectabila"'
  );
});

test('markGenerationFailed: e folosit consistent in toate punctele de esec ale generarii (nu doar status scris direct)', () => {
  const server = read('server.js');
  const directWrites = (server.match(/status: 'generation_failed'/g) || []).length;
  // singura scriere directa ramasa trebuie sa fie CHIAR in interiorul markGenerationFailed
  assert.equal(directWrites, 1, `toate punctele de esec trebuie sa foloseasca markGenerationFailed, nu sa scrie direct status: 'generation_failed' (gasite ${directWrites} scrieri directe)`);
});

test('POST /checkout ramane blocat fara selectedVariantId (deja acopera gating-ul editarii Standard cu alegere)', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("error: 'Alege o variantă înainte de plată.'"),
    'checkout trebuie sa ramana respins explicit fara o varianta selectata'
  );
});

// ==========================================================================================
// Frontend (melodia-mea.html): cele doua carduri "Versiunea inițială"/"Versiunea editată",
// selectie obligatorie, buton de plata dezactivat pana la alegere.
// ==========================================================================================

test('melodia-mea.html: selectedVariantIndex ramane -1 (niciun card evidentiat) cand exista alegere in asteptare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('const pendingVariantChoice = !order.selectedVariantId && (order.variants || []).length > 1;'),
    'trebuie detectat explicit cazul "editare Standard terminata, nimic ales inca"'
  );
  assert.ok(html.includes('selectedVariantIndex = pendingVariantChoice ? -1 : 0;'), 'fara alegere, niciun card nu trebuie preselectat automat');
});

test('melodia-mea.html: checkoutBtn ramane dezactivat pana la alegerea explicita a unei variante', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('checkoutBtn.disabled = pendingVariantChoice;'), 'butonul de plata trebuie dezactivat exact cat timp alegerea e in asteptare');
});

test('melodia-mea.html: mesajul "alege o versiune" e afisat cand alegerea e in asteptare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("id=\"choose-variant-msg\""), 'elementul de prompt trebuie sa existe in pagina');
  assert.ok(html.includes('chooseVariantMsgEl.textContent = t.choose_variant_msg;'), 'trebuie populat cu mesajul tradus cand alegerea e in asteptare');
});

test('melodia-mea.html: cardurile Standard cu alegere sunt etichetate "Versiunea inițială"/"Versiunea editată", NU "cadou"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("const isStandardEditChoice = order.plan === 'standard' && (order.variants || []).length > 1;"),
    'trebuie detectat explicit cazul Standard cu 2 variante (original+editat)'
  );
  assert.ok(
    html.includes('v.isEditedAlternative ? t.variant_edited_label : t.variant_original_label'),
    'eticheta trebuie sa depinda de flagul isEditedAlternative, niciodata de selectie (care e -1 pana la alegere)'
  );
  assert.ok(
    html.includes('${(!isStandardEditChoice && !isSelected && !hasGenreTag)'),
    'nota "melodie cadou" nu trebuie sa apara niciodata pe cardurile Standard cu alegere — sunt alternative ALE ACELEIASI melodii, nu doua melodii'
  );
});

test('melodia-mea.html: eticheta butonului de plata omite numarul de varianta cat timp alegerea e in asteptare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('const variantSuffixHtml = pendingVariantChoice') && html.includes("? ''"),
    'butonul nu trebuie sa afiseze "Varianta 0" sau orice numar inainte de alegerea reala'
  );
});

test('melodia-mea.html: o editare esuata (dar cu varianta existenta pastrata) arata un banner, NU pagina completa de eroare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('if (order.error) {') && html.includes('statusMsgEl.textContent = t.regen_failed_recovered_msg;'),
    'daca backend-ul a revenit la preview_ready dupa un esec de regenerare (vezi markGenerationFailed), clientul trebuie informat, nu blocat'
  );
});

test('GET /api/orders/:orderId expune isEditedAlternative pentru fiecare varianta (altfel frontend-ul nu poate distinge original de editat)', () => {
  const server = read('server.js');
  // gasit direct la testarea reala pe staging: campul era scris corect in DB
  // (finalizeVariantsIfNeeded), dar lipsea din whitelist-ul safeVariants — ambele carduri
  // aparea etichetate "Versiunea inițială", niciodata "Versiunea editată".
  assert.ok(
    server.includes('isEditedAlternative: !!v.isEditedAlternative'),
    'safeVariants trebuie sa expuna explicit isEditedAlternative catre client'
  );
});

test('traduceri: cheile noi ale fluxului de alegere Standard exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  ['variant_original_label', 'variant_edited_label', 'choose_variant_msg', 'regen_failed_recovered_msg'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});
