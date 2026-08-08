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

// ==========================================================================================
// ÎMBUNĂTĂȚIRE UI (hotfix 2026-08-08): butonul de confirmare a regenerarii, mare/portocaliu/
// centrat; dupa editare, meniul de editare Standard dispare complet si e inlocuit de un
// ecran dedicat de alegere cu buton clar pe fiecare card + un singur buton de plata.
// ==========================================================================================

test('melodia-mea.html: butonul de confirmare a regenerarii foloseste noua clasa CSS mare/portocalie, nu mai e mic si intunecat', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('.btn-cta-orange{'), 'clasa CSS pentru butonul mare portocaliu trebuie sa existe');
  assert.ok(html.includes('min-height:56px'), 'butonul trebuie sa aiba minimum 56px inaltime');
  assert.ok(
    html.includes('<button type="button" class="btn-cta-orange" id="confirm-yes">'),
    'confirm-yes trebuie sa foloseasca noua clasa, nu mai vechea .btn.btn-primary.btn-small'
  );
  assert.ok(!html.includes('class="btn btn-primary btn-small" id="confirm-yes"'), 'stilul vechi (mic, inchis la culoare) nu mai trebuie folosit pentru acest buton');
});

test('melodia-mea.html: textul butonului de confirmare e "Creează noua versiune", nu "Da, regenerează"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("confirm_yes: 'Creează noua versiune'"), 'textul RO trebuie schimbat exact la cel cerut');
  assert.ok(!html.includes("confirm_yes: 'Da, regenerează'"), 'textul vechi nu mai trebuie sa existe');
});

test('melodia-mea.html: mesajul de regenerare pentru Standard e corect ("o singura versiune"), nu mesajul generic "2 variante noi"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("statusMsgEl.textContent = currentOrder.plan === 'standard' ? t.msg_regenerating_standard : t.msg_regenerating;"),
    'mesajul trebuie ales in functie de pachet — Standard produce o singura varianta editata, Premium/Video doua'
  );
});

test('melodia-mea.html: butonul de confirmare arata un text clar de incarcare la apasare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("confirmYesBtn.textContent = t.confirm_yes_loading;"), 'trebuie sa existe o stare vizuala clara de incarcare, nu doar opacitate redusa');
});

test('melodia-mea.html: meniul de editare (voce/gen/feedback/regenerare) e complet ascuns cand exista alegere Standard', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="edit-menu-fields"'), 'meniul de editare trebuie infasurat intr-un singur container, usor de ascuns complet');
  assert.ok(
    html.includes('editMenuFields.style.display = \'none\';'),
    'containerul intreg trebuie ascuns (voce, gen, feedback, butoane) cand exista deja o alegere Standard de facut'
  );
});

test('melodia-mea.html: dupa editare, checkoutBtn e mutat in ecranul dedicat de alegere Standard, cu textul exact cerut', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('standardChoiceCheckoutSlot.appendChild(checkoutBtn);'), 'butonul de plata trebuie mutat fizic in noul container, nu duplicat');
  assert.ok(
    html.includes('checkoutBtn.innerHTML = `${t.checkout_btn_standard} — £${order.price}`;'),
    'textul trebuie sa fie exact "Continuă la plată — £15" (fara "varianta N", fara sageata) in ecranul de alegere Standard'
  );
});

test('melodia-mea.html: fiecare card Standard cu alegere are un buton clar de selectie sau bifa "Versiune selectata"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('variant-choose-btn'), 'trebuie sa existe un buton dedicat de selectie pe fiecare card');
  assert.ok(html.includes('t.choose_edited_btn'), 'butonul cardului editat trebuie etichetat corect');
  assert.ok(html.includes('t.choose_original_btn'), 'butonul cardului initial trebuie etichetat corect');
  assert.ok(html.includes('variant-selected-badge'), 'cardul deja selectat trebuie sa arate bifa "Versiune selectata"');
});

test('melodia-mea.html: cardul selectat Standard primeste chenar portocaliu distinct', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('.variant-card.standard-selected{'), 'trebuie sa existe un stil de chenar portocaliu specific ecranului de alegere Standard');
  assert.ok(html.includes("isStandardChoiceForClass && isSelectedForClass ? ' standard-selected' : ''"), 'clasa trebuie aplicata doar cand cardul e cu adevarat selectat in fluxul Standard');
});

test('melodia-mea.html: "Editează versurile" si celelalte controale de editare nu mai apar pe cardurile Standard cu alegere', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("isStandardEditChoice ? '' : `<button type=\"button\" class=\"btn btn-ghost btn-small edit-lyrics-btn\""),
    'butonul de editare a versurilor trebuie omis complet pe cardurile din ecranul de alegere Standard'
  );
});

test('traduceri: cheile noi ale imbunatatirii UI exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  ['confirm_yes_loading', 'checkout_btn_standard', 'msg_regenerating_standard', 'choose_original_btn', 'choose_edited_btn', 'variant_selected_badge'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});

// ==========================================================================================
// Verificari backend explicite, cerute punctual (imbunatatire UI, hotfix 2026-08-08):
// checkout foloseste exact selectedVariantId; un ID trimis manual nu poate selecta melodia
// altei comenzi; alegerea nu se pierde la refresh; dublul click nu creeaza checkouturi
// duplicate; emailul/descarcarea livreaza exclusiv versiunea selectata.
// ==========================================================================================

test('POST /checkout foloseste exact order.selectedVariantId (amprenta sesiunii Stripe + metadata)', () => {
  const server = read('server.js');
  assert.ok(server.includes('const versionFingerprint = `${order.selectedVariantId}-${order.mediaRevision}`;'), 'amprenta versiunii aprobate trebuie legata direct de selectedVariantId');
  assert.ok(server.includes('selectedVariantId: order.selectedVariantId,'), 'metadata sesiunii Stripe trebuie sa contina selectedVariantId, verificabil la webhook');
  assert.ok(server.includes('checkoutVariantId: order.selectedVariantId,'), 'checkoutVariantId salvat in DB trebuie sa fie exact varianta selectata, folosit pentru validare la webhook');
});

test('POST /select cauta variantId STRICT in variantele PROPRIEI comenzi — un ID din alta comanda nu poate fi selectat', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("const newVariant = (order.variants || []).find(v => v.id === variantId);"),
    'cautarea trebuie sa fie scopata la order.variants (comanda autentificata prin token), niciodata globala'
  );
  assert.ok(
    server.includes("if (!newVariant) return res.status(400).json({ error: 'Varianta nu există.' });"),
    'un variantId care nu apartine comenzii curente trebuie respins cu 400, nu acceptat tacit'
  );
});

test('selectedVariantId persista la refresh — GET /api/orders/:orderId il returneaza direct din DB', () => {
  const server = read('server.js');
  assert.ok(server.includes('selectedVariantId: order.selectedVariantId || null,'), 'raspunsul GET trebuie sa reflecte exact valoarea persistata, nu o stare doar in memoria clientului');
});

test('dublul click pe plata nu creeaza checkouturi Stripe duplicate (idempotencyKey legata de versiune)', () => {
  const server = read('server.js');
  assert.ok(
    server.includes('idempotencyKey: `checkout-${order.id}-${versionFingerprint}`'),
    'aceeasi comanda + aceeasi varianta selectata trebuie sa returneze mereu ACEEASI sesiune Stripe, niciodata una noua la un al doilea click rapid'
  );
});

test('emailul si descarcarea dupa plata livreaza EXCLUSIV versiunea selectata pentru Standard (fara "melodie cadou")', () => {
  const server = read('server.js');
  const entitlements = read('lib/entitlements.js');
  // deja verificat separat (getGiftVariant), reconfirmat aici in contextul explicit al cerintei:
  // Standard NU mai livreaza niciodata a doua varianta, indiferent de ce alta varianta exista.
  assert.ok(entitlements.includes("if (!order || order.plan === 'standard') return null;"), 'getGiftVariant trebuie sa refuze explicit Standard');
  assert.ok(
    server.includes("const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);"),
    'livrarea principala (email/descarcare) trebuie sa foloseasca exact selectedVariantId, niciodata prima varianta din array sau alta presupunere'
  );
});
