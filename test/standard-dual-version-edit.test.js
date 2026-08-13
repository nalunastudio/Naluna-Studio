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
  // MODIFICARE (2026-08-13, "pastrarea exacta a versurilor editate"): regenOptions include acum
  // si exactLyrics — keepOriginalAsAlternative/regenerationJobId raman neschimbate ca structura.
  assert.ok(
    server.includes(': { keepOriginalAsAlternative: true, regenerationJobId, exactLyrics: exactLyrics || null };'),
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
  // fereastra marita (2026-08-13): vezi comentariul de la testul de mai jos (aceeasi cauza).
  const branch = server.slice(idx, idx + 1600);
  assert.ok(branch.includes('newSelectedVariantId = null;'), 'niciuna din cele doua variante nu trebuie preselectata automat — POST /checkout respinge deja o cerere fara selectedVariantId');
});

test('finalizeVariantsIfNeeded: editarea Standard NU sterge niciun fisier din storage (originalul trebuie sa ramana livrabil)', () => {
  const server = read('server.js');
  const idx = server.indexOf('options.keepOriginalAsAlternative) {');
  // fereastra marita (2026-08-13): comentariul + codul care goleste editedLyrics pe varianta
  // sursa (fix pentru "versiunea inițială și editată afișează aceleași versuri") au impins
  // "replacedOldVariants = [];" dincolo de fereastra veche de 1200 caractere.
  const branch = server.slice(idx, idx + 1600);
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
  assert.ok(server.includes('async function markGenerationFailed(orderId, errMessage, knownVariants, regenerationJobId)'), 'functia trebuie sa existe');
  assert.ok(
    server.includes("await db.updateOrder(orderId, { status: 'preview_ready', error: safeError, regenerateEditVariantIds: null });"),
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

test('melodia-mea.html: sectiunea de alegere are titlu + subtext dedicate, afisate cand exista o alegere Standard de facut', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="standard-choice-title"'), 'elementul de titlu trebuie sa existe in pagina');
  assert.ok(html.includes('id="standard-choice-subtitle"'), 'elementul de subtext trebuie sa existe in pagina');
  assert.ok(
    html.includes("document.getElementById('standard-choice-title').textContent = `🎵 ${t.standard_choice_title}`;"),
    'titlul trebuie populat cu textul tradus (+ iconita discreta de nota muzicala)'
  );
  assert.ok(
    html.includes("document.getElementById('standard-choice-subtitle').textContent = t.standard_choice_subtitle;"),
    'subtextul trebuie populat cu textul tradus'
  );
});

test('melodia-mea.html: cardurile Standard cu alegere sunt etichetate "Versiunea inițială"/"Versiunea editată", NU "cadou"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("(order.plan === 'standard' || (order.plan === 'video' && hasEditedAlternative)) && (order.variants || []).length > 1;"),
    'trebuie detectat explicit cazul Standard (sau Video cu o editare reala) cu 2 variante (original+editat)'
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
  ['variant_original_label', 'variant_edited_label', 'regen_failed_recovered_msg'].forEach(key => {
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

// REVIZUIT (2026-08-14): Video foloseste acum acelasi mesaj ca Standard ("o singura versiune"),
// nu mai mesajul generic "2 variante noi" — vezi test/video-single-song-edit.test.js.
test('melodia-mea.html: mesajul de regenerare pentru Standard SI Video e corect ("o singura versiune"), nu mesajul generic "2 variante noi" (ramas STRICT pentru Premium)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("statusMsgEl.textContent = (currentOrder.plan === 'standard' || currentOrder.plan === 'video') ? t.msg_regenerating_standard : t.msg_regenerating;"),
    'mesajul trebuie ales in functie de pachet — Standard si Video produc o singura varianta editata, Premium doua'
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
    html.includes('editMenuFields.hidden = true;'),
    'containerul intreg trebuie scos din DOM/tastatura ([hidden]) cand exista deja o alegere Standard de facut'
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

test('melodia-mea.html: sectiunea de alegere afiseaza doua butoane late, etichetate cu genurile reale ale celor doua melodii', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('function renderStandardChoiceButtons(order)'), 'trebuie sa existe o functie dedicata pentru cele doua butoane de alegere');
  assert.ok(html.includes("id=\"standard-genre-choice-buttons\""), 'containerul celor doua butoane trebuie sa existe in pagina');
  assert.ok(
    html.includes('const sameGenre = !!(variants[0].genre && variants[1].genre && variants[0].genre === variants[1].genre);'),
    'cand ambele variante au acelasi gen, ordinea cuvintelor trebuie sa se schimbe ca sa ramana clar diferentiate'
  );
  assert.ok(
    html.includes('btn.textContent = t.choose_variant_btn(genreLabel, isEdited, sameGenre, isChosen);'),
    'eticheta butonului (ambele stari) trebuie construita printr-o singura functie, cu isChosen ca parametru explicit'
  );
});

// ==========================================================================================
// DOUĂ FINISAJE VIZUALE (hotfix 2026-08-08): butonul variantei ALESE trebuie sa PASTREZE
// denumirea genului vizibila, niciodata inlocuita complet cu "Aleasă ✓" — clientul trebuie sa
// vada permanent ce melodie a ales (ex. "Emoțional — Aleasă ✓", nu doar "Aleasă ✓").
// ==========================================================================================

test('melodia-mea.html: butonul variantei ALESE pastreaza genul vizibil, nu il inlocuieste complet cu "Aleasă ✓"', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf("choose_variant_btn: (genre, isEdited, sameGenre, isChosen) => { const v = isEdited ? 'versiunea nouă' : 'versiunea inițială';");
  assert.ok(idx > -1, 'functia RO choose_variant_btn cu semnatura noua (isChosen) trebuie sa existe');
  const block = html.slice(idx, idx + 250);
  assert.ok(
    block.includes('if (isChosen) return sameGenre ? `${v} — ${genre} — Aleasă ✓` : `${genre} — Aleasă ✓`;'),
    'starea aleasa trebuie sa contina genul REAL, nu doar bifa/textul "Aleasă ✓" singur'
  );
});

test('traduceri: eticheta "PASUL URMĂTOR" exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  const count = (html.match(new RegExp('standard_choice_eyebrow:', 'g')) || []).length;
  assert.equal(count, 8, `cheia "standard_choice_eyebrow" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
});

test('melodia-mea.html: sectiunea de alegere e evidentiata vizual — fundal cald, chenar portocaliu, titlu mare/bold', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('border:2px solid var(--orange); border-radius:20px;'), 'chenarul portocaliu vizibil trebuie sa existe');
  assert.ok(html.includes('font-weight:700; font-size:24px;'), 'titlul trebuie sa fie mare si bold');
  assert.ok(html.includes('id="standard-choice-eyebrow"'), 'eticheta mica "PASUL URMĂTOR" trebuie sa existe in pagina');
  assert.ok(html.includes('🎵'), 'iconita discreta de nota muzicala trebuie sa existe');
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
  ['confirm_yes_loading', 'checkout_btn_standard', 'msg_regenerating_standard',
    'standard_choice_title', 'standard_choice_subtitle', 'standard_choice_eyebrow', 'choose_variant_btn'].forEach(key => {
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

// MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda 3):
// amprenta versiunii ramane legata direct de selectedVariantId pentru orice pachet — pentru
// Premium, INCLUDE acum si a doua selectie (selectedVariantId2), fara sa schimbe formula
// originala pentru Standard/Video (ramura else, byte-identica).
test('POST /checkout foloseste exact order.selectedVariantId (amprenta sesiunii Stripe + metadata)', () => {
  const server = read('server.js');
  assert.ok(server.includes('? `${order.selectedVariantId}-${order.selectedVariantId2}-${order.mediaRevision}`'), 'amprenta Premium trebuie sa includa si a doua selectie');
  assert.ok(server.includes(': `${order.selectedVariantId}-${order.mediaRevision}`;'), 'amprenta Standard/Video trebuie sa ramana legata direct de selectedVariantId, neschimbata');
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
  assert.ok(entitlements.includes("if (!order || order.plan === 'standard' || order.plan === 'video') return null;"), 'getGiftVariant trebuie sa refuze explicit Standard (si acum Video, corectie 2026-08-14)');
  assert.ok(
    server.includes("const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);"),
    'livrarea principala (email/descarcare) trebuie sa foloseasca exact selectedVariantId, niciodata prima varianta din array sau alta presupunere'
  );
});

// ==========================================================================================
// FINISAJ FINAL PACHET STANDARD (hotfix 2026-08-08): elimina pasul intermediar "Editează
// cântecul" — butonul portocaliu apare direct, pentru Standard, ÎNAINTE de editare. Premium/
// Video raman neschimbate (2 pasi, regenerateBtn -> confirmRow).
// ==========================================================================================

test('melodia-mea.html: Standard (inainte de editare) foloseste modul direct — regenerateBtn ramane ascuns intotdeauna', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("const standardDirectEditMode = order.plan === 'standard' && !isStandardEditChoice;"),
    'trebuie detectat explicit modul direct — DOAR Standard, DOAR inainte de a folosi editarea gratuita'
  );
  assert.ok(html.includes("regenerateBtn.style.display = 'none';") , 'butonul "Editează cântecul" trebuie ascuns in acest mod (inlocuit de meniul pliabil)');
});

test('melodia-mea.html: Premium/Video NU sunt afectate de eliminarea pasului intermediar (raman cu 2 pasi)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("const standardDirectEditMode = order.plan === 'standard' && !isStandardEditChoice;"),
    'conditia trebuie scopata explicit la plan==="standard" — Premium/Video nu trebuie sa intre niciodata pe aceasta ramura'
  );
  assert.ok(
    html.includes('standardPreeditToggleWrap.style.display = \'none\';') && html.includes('editMenuFields.hidden = false;'),
    'Premium/Video trebuie sa aiba mereu meniul de editare vizibil, fara butonul pliabil Standard'
  );
});

// ==========================================================================================
// ULTIMUL FINISAJ PENTRU STANDARD (hotfix 2026-08-08): meniul de editare Standard (voce/gen/
// instructiuni/buton portocaliu), INAINTE de prima regenerare, e acum PLIABIL — inchis
// implicit. Butonul "✏️ Editează versurile" il deschide/inchide; "Renunță" il inchide SI
// anuleaza modificarile nesalvate.
// ==========================================================================================

test('melodia-mea.html: meniul pliabil Standard e INCHIS implicit (menuExpanded=false)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('let menuExpanded = false;'), 'starea initiala trebuie sa fie inchisa');
});

test('melodia-mea.html: [hidden] scoate meniul din navigarea cu tastatura, nu doar vizual (cerinta explicita)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('editMenuFields.hidden = !menuExpanded;'),
    'trebuie folosit atributul nativ [hidden] (scoate din arborele de accesibilitate SI din tab-order), nu doar opacity/visibility'
  );
});

test('melodia-mea.html: butonul de deschidere/inchidere reutilizeaza textul "Editează versurile" existent, cu iconita de creion', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="edit-menu-toggle-btn"'), 'butonul trebuie sa existe');
  assert.ok(html.includes('>✏️<'), 'iconita de creion trebuie sa existe');
  assert.ok(
    html.includes('editMenuToggleLabel.textContent = menuExpanded ? t.edit_menu_close_btn : t.edit_lyrics_btn;'),
    'eticheta trebuie sa alterneze intre "Editează versurile" (inchis) si "Închide editarea" (deschis), reutilizand cheia existenta'
  );
  assert.ok(html.includes('aria-expanded="false"') && html.includes("aria-controls=\"edit-menu-fields\""), 'aria-expanded/aria-controls trebuie sa existe pentru accesibilitate');
});

test('melodia-mea.html: butonul de deschidere/inchidere e mare/portocaliu deschis/centrat, minimum 52px', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('.btn-toggle-orange{'), 'clasa CSS dedicata trebuie sa existe');
  assert.ok(html.includes('min-height:52px'), 'inaltimea minima ceruta trebuie respectata');
  assert.ok(html.includes('max-width:420px; margin:0 auto;'), 'trebuie centrat, aproape toata latimea pe mobil');
});

test('melodia-mea.html: deschiderea meniului e o schimbare STRICT locala, fara renderContent complet si fara cerere de retea', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf("editMenuToggleBtn.addEventListener('click'");
  assert.ok(idx > -1, 'click handler-ul trebuie sa existe');
  const block = html.slice(idx, idx + 500);
  assert.ok(block.includes('updateStandardEditMenuVisibility(currentOrder, pendingVariantChoiceNow);'), 'trebuie apelata DOAR functia locala de vizibilitate, niciodata renderContent/loadOrder (ar re-construi inutil playerele audio sau ar face o cerere de retea)');
  assert.ok(!block.includes('fetch('), 'deschiderea/inchiderea meniului nu trebuie sa faca nicio cerere de retea');
});

test('melodia-mea.html: la deschidere, pagina deruleaza lin catre inceputul meniului', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("editMenuFields.scrollIntoView({ behavior: 'smooth', block: 'start' });"), 'trebuie sa deruleze lin catre meniu dupa deschidere, util mai ales pe mobil');
});

test('melodia-mea.html: "Renunță" e vizibil DOAR cand meniul e deschis, si inchide meniul + anuleaza modificarile nesalvate', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes("confirmCancelBtn.style.display = menuExpanded ? '' : 'none';"),
    'Renunță trebuie sa fie vizibil DOAR cat timp meniul e deschis — are acum un pas de reveal real de anulat'
  );
  const idx = html.indexOf("confirmCancelBtn.addEventListener('click'");
  const block = html.slice(idx, idx + 700);
  assert.ok(block.includes("currentOrder.plan === 'standard'"), 'handler-ul trebuie sa distinga explicit Standard de Premium/Video');
  assert.ok(block.includes('feedbackEl.value = \'\';'), 'textul de feedback nesalvat trebuie golit la Renunță');
  assert.ok(block.includes('populateGenreSelect(currentOrder);'), 'selectorul de gen trebuie resetat la valoarea reala a comenzii');
  assert.ok(block.includes('menuExpanded = false;'), 'Renunță trebuie sa inchida meniul');
});

test('melodia-mea.html: dupa editare, meniul pliabil (buton + hint) dispare complet, la fel ca inainte', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('if (isStandardEditChoice) {');
  const block = html.slice(idx, idx + 400);
  assert.ok(block.includes("standardPreeditToggleWrap.style.display = 'none';"), 'butonul pliabil nu mai trebuie sa existe dupa editare — editarea gratuita a fost deja folosita');
});

test('traduceri: cheile noi ale meniului pliabil exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  ['edit_menu_close_btn', 'edit_menu_toggle_hint'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});

// ==========================================================================================
// FINISAJ FINAL PACHET STANDARD: se-compune.html — pagina/progresul de REGENERARE, complet
// separate de pagina/progresul generarii initiale.
// ==========================================================================================

test('se-compune.html: mode=regenerate schimba titlul/subtitlul, separat de generarea initiala', () => {
  const html = read('public/se-compune.html');
  assert.ok(html.includes("const isRegenMode = params.get('mode') === 'regenerate';"), 'modul de regenerare trebuie detectat explicit din URL');
  assert.ok(
    html.includes("document.getElementById('p-title').textContent = isRegenMode ? t.regenTitle : t.title;"),
    'titlul trebuie sa difere in modul de regenerare'
  );
  assert.ok(html.includes("regenTitle: 'Lucrăm la noua versiune',"), 'titlul RO exact cerut trebuie sa existe');
  assert.ok(
    html.includes("regenSubtitle: 'Aplicăm modificările tale. Când este gata, vei putea compara ambele versiuni.',"),
    'subtitlul RO exact cerut trebuie sa existe'
  );
});

test('se-compune.html: progresul de regenerare vine STRICT din regenerationProgress, niciodata din generationPhasePercent', () => {
  const html = read('public/se-compune.html');
  assert.ok(
    html.includes('const percent = isRegenMode ? order.regenerationProgress : order.generationPhasePercent;'),
    'cele doua surse de progres trebuie sa ramana complet separate'
  );
});

test('se-compune.html: succesul/esecul unei regenerari se decid prin regenerationStatus, nu prin order.status (identic in ambele cazuri)', () => {
  const html = read('public/se-compune.html');
  assert.ok(html.includes("const regenSucceeded = isRegenMode && order.regenerationStatus === 'ready';"), 'succesul regenerarii trebuie sa foloseasca regenerationStatus');
  assert.ok(html.includes("const regenFailed = isRegenMode && order.regenerationStatus === 'failed';"), 'esecul regenerarii trebuie sa foloseasca regenerationStatus');
});

test('se-compune.html: retry-ul unei regenerari esuate navigheaza inapoi la melodia-mea.html, NU apeleaza /generate', () => {
  const html = read('public/se-compune.html');
  const idx = html.indexOf("retryBtn.addEventListener('click'");
  const block = html.slice(idx, idx + 700);
  assert.ok(
    block.includes('if (isRegenMode) {') && block.includes('/melodia-mea.html?id='),
    'in modul de regenerare, retry trebuie sa navigheze la formularul de editare, nu sa porneasca o generare initiala (semantic gresit)'
  );
});

test('melodia-mea.html: redirectul dupa o regenerare reusita trece mode=regenerate catre se-compune.html', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('/se-compune.html?id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(accessToken)}&mode=regenerate'),
    'redirectul din confirmYesBtn (regenerare) trebuie sa marcheze explicit modul de regenerare'
  );
});

test('traduceri: regenTitle/regenSubtitle exista in toate cele 8 limbi din se-compune.html', () => {
  const html = read('public/se-compune.html');
  ['regenTitle', 'regenSubtitle'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});

// ==========================================================================================
// DOUĂ FINISAJE VIZUALE (hotfix 2026-08-08), Partea 1: ordinea butoanelor in meniul de editare
// Standard — portocaliu "Creează noua versiune" INTOTDEAUNA inaintea celui de plata (vizual,
// DOM, tastatura), "Renunță" ultimul. checkoutBtn (mutat in standard-preedit-checkout-slot)
// nu mai sta inaintea intregului confirm-row — sta ACUM intre confirm-yes si confirm-cancel.
// ==========================================================================================

test('melodia-mea.html: butonul portocaliu "Creează noua versiune" apare INAINTEA celui de plata in DOM (ordinea ceruta)', () => {
  const html = read('public/melodia-mea.html');
  const confirmYesIdx = html.indexOf('id="confirm-yes"');
  const checkoutSlotIdx = html.indexOf('id="standard-preedit-checkout-slot-expanded"');
  const confirmCancelIdx = html.indexOf('id="confirm-cancel"');
  assert.ok(confirmYesIdx > -1 && checkoutSlotIdx > -1 && confirmCancelIdx > -1, 'toate cele 3 elemente trebuie sa existe');
  assert.ok(
    confirmYesIdx < checkoutSlotIdx && checkoutSlotIdx < confirmCancelIdx,
    `ordinea DOM trebuie sa fie: portocaliu (${confirmYesIdx}) -> plata (${checkoutSlotIdx}) -> Renunță (${confirmCancelIdx})`
  );
});

test('melodia-mea.html: checkoutBtn (Standard, inainte de editare) e mutat ACUM intre confirm-yes si confirm-cancel, nu inaintea intregului confirm-row', () => {
  const html = read('public/melodia-mea.html');
  const confirmRowIdx = html.indexOf('id="confirm-row"');
  const confirmRowBlock = html.slice(confirmRowIdx, confirmRowIdx + 650);
  assert.ok(
    confirmRowBlock.includes('id="confirm-yes"') &&
    confirmRowBlock.includes('id="standard-preedit-checkout-slot-expanded"') &&
    confirmRowBlock.includes('id="confirm-cancel"'),
    'toate 3 trebuie sa fie in interiorul aceluiasi confirm-row, in aceasta ordine'
  );
});

test('melodia-mea.html: la apasarea butonului portocaliu, plata se dezactiveaza temporar (Standard) — nu se poate plati cat timp noua versiune se genereaza', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf("confirmYesBtn.addEventListener('click'");
  const block = html.slice(idx, idx + 2500);
  assert.ok(
    block.includes("if (currentOrder.plan === 'standard') {") && block.includes('checkoutBtn.disabled = true;'),
    'checkoutBtn trebuie dezactivat explicit la pornirea regenerarii, DOAR pentru Standard (Premium/Video neatinse)'
  );
});

test('melodia-mea.html: daca cererea de regenerare esueaza, plata se reactiveaza (Standard)', () => {
  const html = read('public/melodia-mea.html');
  const occurrences = (html.match(/if \(currentOrder\.plan === 'standard'\) checkoutBtn\.disabled = false;/g) || []).length;
  assert.ok(occurrences >= 2, `plata trebuie reactivata in AMBELE ramuri de esec (raspuns cu eroare + eroare de retea), gasite ${occurrences}`);
});

test('melodia-mea.html: textul de incarcare e "Se creează noua versiune...", nu genericul "Se creează..."', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("confirm_yes_loading: 'Se creează noua versiune...'"), 'textul RO exact cerut trebuie sa existe');
  assert.ok(!html.includes("confirm_yes_loading: 'Se creează...'"), 'textul vechi, mai generic, nu mai trebuie sa existe');
});

// ==========================================================================================
// ULTIMELE MODIFICĂRI STRICTE (hotfix 2026-08-08), Partea 1 (continuare): REGRESIE REALA
// reparata — checkoutBtn traia DOAR in interiorul confirm-row (ascuns cat timp meniul e
// inchis), facand plata invizibila exact in starea implicita a paginii. checkoutBtn e ACUM
// UN SINGUR element logic, reparentat intre DOUA sloturi posibile in functie de menuExpanded.
// ==========================================================================================

test('melodia-mea.html: exista DOUA sloturi pentru checkoutBtn (inchis/deschis) — un singur buton logic, niciodata duplicat', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="standard-preedit-checkout-slot-collapsed"'), 'slotul pentru meniul INCHIS trebuie sa existe, in afara confirm-row');
  assert.ok(html.includes('id="standard-preedit-checkout-slot-expanded"'), 'slotul pentru meniul DESCHIS trebuie sa existe, in interiorul confirm-row');
});

test('melodia-mea.html: cand meniul e INCHIS, plata e reparentata in slotul de langa butonul de editare, NU in cel din confirm-row (ascuns)', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('standardPreeditCheckoutSlotExpanded.appendChild(checkoutBtn);');
  assert.ok(idx > -1, 'ramura if/else de reparentare trebuie sa existe');
  const block = html.slice(idx - 250, idx + 350);
  assert.ok(block.includes('standardPreeditCheckoutSlotCollapsed.appendChild(checkoutBtn);'), 'meniu inchis -> checkoutBtn trebuie mutat in slotul vizibil de langa butonul de editare');
  assert.ok(block.includes('standardPreeditCheckoutSlotExpanded.appendChild(checkoutBtn);'), 'meniu deschis -> checkoutBtn trebuie mutat in slotul din confirm-row (intre portocaliu si Renunță)');
});

test('melodia-mea.html: slotul de plata (meniu inchis) e imediat dupa butonul de editare, fara alt continut intre ele', () => {
  const html = read('public/melodia-mea.html');
  const toggleWrapIdx = html.indexOf('id="standard-preedit-toggle-wrap"');
  const collapsedSlotIdx = html.indexOf('id="standard-preedit-checkout-slot-collapsed"');
  const editMenuFieldsIdx = html.indexOf('id="edit-menu-fields"');
  assert.ok(
    toggleWrapIdx < collapsedSlotIdx && collapsedSlotIdx < editMenuFieldsIdx,
    'ordinea DOM trebuie sa fie: buton editare -> plata -> (meniul propriu-zis, ascuns cat timp e inchis)'
  );
});

test('melodia-mea.html: explicatia butonului de editare e MUTATA deasupra butonului, nu intre buton si plata', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('id="standard-preedit-toggle-wrap"');
  const block = html.slice(idx, idx + 400);
  const hintIdx = block.indexOf('id="edit-menu-toggle-hint"');
  const btnIdx = block.indexOf('id="edit-menu-toggle-btn"');
  assert.ok(hintIdx > -1 && btnIdx > -1 && hintIdx < btnIdx, 'explicatia trebuie sa apara INAINTE de buton in DOM');
});

// ==========================================================================================
// ULTIMELE MODIFICĂRI STRICTE, Partea 2: cele doua zone evidentiate din meniul de editare.
// ==========================================================================================

test('melodia-mea.html: zona de schimbare a genului e evidentiata, cu titlu + explicatie noi', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="edit-genre-explain"'), 'elementul de explicatie trebuie sa existe');
  assert.ok(html.includes("edit_genre_label: '🎵 Schimbă genul muzical'"), 'titlul RO trebuie sa includa iconita si textul exact cerut');
  assert.ok(html.includes(".edit-zone{"), 'clasa CSS de evidentiere trebuie sa existe');
});

test('melodia-mea.html: zona de feedback e evidentiata, cu titlu nou + eticheta "Opțional" vizibila', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="feedback-explain"'), 'elementul de explicatie trebuie sa existe');
  assert.ok(html.includes('id="feedback-optional-badge"'), 'eticheta "Opțional" trebuie sa existe ca element vizibil separat');
  assert.ok(html.includes("feedback_label: '✏️ Nu este exact cum îți dorești? Spune-ne ce să schimbăm'"), 'titlul RO trebuie sa fie exact cel cerut');
});

test('melodia-mea.html: textarea de feedback ramane STRICT optionala — fara atributul required', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('<textarea id="feedback"');
  const tag = html.slice(idx, idx + 200).split('>')[0];
  assert.ok(!tag.includes('required'), 'textarea nu trebuie sa aiba niciodata atributul required — clientul trebuie sa poata regenera cu campul gol');
});

test('server.js: feedback ramane optional in backend (fara validare de tip "camp obligatoriu")', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;"),
    'feedback trebuie sa ramana strict optional in ruta de regenerare (null daca lipseste, niciodata respins)'
  );
});

test('traduceri: edit_genre_explain, feedback_explain, feedback_optional_badge exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  ['edit_genre_explain', 'feedback_explain', 'feedback_optional_badge'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});
