// Teste de regresie STATICE (citesc direct sursa, fara server/DB) pentru "MODIFICARE STRICTĂ —
// PAGINA PENTRU CE MOMENT VREI CÂNTECUL?" (hotfix 2026-08-08): relatii de familie noi
// (mama/tata, matusa/unchi, soacra/socru), aceeasi relatie pentru "E ziua lui/ei", "Nuntă/Botez"
// cu structura Miri/Fini/Nași, si antetul personalizat al rezultatului. Acopera cele 17 cerinte
// de test explicite din cererea utilizatorului.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// -------------------------------------------------------------------------------------------
// 1-4: Bunică/Bunic, Mamă/Tată, Mătușă/Unchi, Soacră/Socru apar direct sub cardul selectat.
// -------------------------------------------------------------------------------------------
test('comanda.html: panoul de relatie de familie e REPOZITIONAT dinamic imediat dupa cardul activ (nu la finalul intregii grile)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("const activeCard = document.querySelector(`.theme-card[data-theme=\"${occasion}\"]`);"));
  assert.ok(html.includes('activeCard.insertAdjacentElement(\'afterend\', familyRelationPanel);'));
  assert.ok(html.includes(".theme-subpanel{"), 'panoul trebuie sa fie element al aceluiasi grid CSS (grid-column:1/-1)');
  assert.ok(html.includes('grid-column:1/-1'));
});

// NOTA (CONTINUARE — personalizarea reala a versurilor, hotfix 2026-08-08): parinti/matusa-unchi/
// socri au acum 3 optiuni (a treia fiind "Amândoi") — vezi test/occasion-real-personalization.test.js.
test('comanda.html: RECIPIENT_ROLE_OPTIONS acopera toate cele 4 ocazii de familie, toate cu 3 optiuni (Amândoi inclus, si la bunici din hotfix 2026-08-09)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("bunici: ['grandmother', 'grandfather', 'grandparents'],"));
  assert.ok(html.includes("parinti: ['mother', 'father', 'parents'],"));
  assert.ok(html.includes("'matusa-unchi': ['aunt', 'uncle', 'aunt_uncle'],"));
  assert.ok(html.includes("socri: ['mother_in_law', 'father_in_law', 'parents_in_law']"));
});

test('comanda.html: cardurile noi "Pentru mama sau tata"/"mătușă sau unchi"/"soacră sau socru" exista, in acelasi stil ca bunici', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('<div class="theme-card" data-theme="parinti">'));
  assert.ok(html.includes('<div class="theme-card" data-theme="matusa-unchi">'));
  assert.ok(html.includes('<div class="theme-card" data-theme="socri">'));
  assert.ok(html.includes('data-i18n="theme_parinti_name"'));
  assert.ok(html.includes('data-i18n="theme_matusaunchi_name"'));
  assert.ok(html.includes('data-i18n="theme_socri_name"'));
});

test('comanda.html: sub-alegerea expeditorului ("Tu ești: Nepoată/Nepot" etc.) e reutilizata (nu duplicata) intre bunici si matusa-unchi', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('grandmother: [\'granddaughter\', \'grandson\'], grandfather: [\'granddaughter\', \'grandson\'],'));
  assert.ok(html.includes('aunt: [\'niece\', \'nephew\'], uncle: [\'niece\', \'nephew\']'));
  assert.ok(html.includes("targetSlot.appendChild(senderRoleSubfield);"), 'un singur element reparentat, niciodata duplicat');
});

// -------------------------------------------------------------------------------------------
// 5 (SUPERSEDAT de CORECȚIA STRICTĂ, hotfix 2026-08-08, punctul 1): submeniul de relatie de la
// "E ziua lui/ei" a fost ELIMINAT COMPLET — vezi test/occasion-relation-cleanup.test.js pentru
// acoperirea completa a eliminarii (12 teste de acceptare din cererea de corectie).
// -------------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------------
// 6: Schimbarea cardului elimina valorile ascunse incompatibile.
// -------------------------------------------------------------------------------------------
test('comanda.html: click pe orice card de ocazie principala reseteaza TOATE campurile de relatie', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('themeCards.forEach(c => {');
  const slice = html.slice(idx, idx + 900);
  assert.ok(slice.includes("recipientRoleInput.value = '';"));
  assert.ok(slice.includes("senderRoleInput.value = '';"));
  assert.ok(slice.includes("recipientModeInput.value = '';"));
  assert.ok(slice.includes("nuntaGroup = '';"));
  assert.ok(slice.includes("name1Input.value = '';"));
  assert.ok(slice.includes("name2Input.value = '';"));
});

// -------------------------------------------------------------------------------------------
// 7: Refresh-ul pastreaza alegerea corecta.
// -------------------------------------------------------------------------------------------
test('comanda.html: restoreDraft() reface recipientRole/senderRole/recipientMode/nuntaGroup/nume INAINTE de refreshRelationUI()', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('if (draft.recipientRole) recipientRoleInput.value = draft.recipientRole;');
  assert.ok(idx !== -1);
  const slice = html.slice(idx, idx + 750);
  assert.ok(slice.includes('if (draft.senderRole) senderRoleInput.value = draft.senderRole;'));
  assert.ok(slice.includes('if (draft.recipientMode) recipientModeInput.value = draft.recipientMode;'));
  assert.ok(slice.includes('if (draft.nuntaGroup) nuntaGroup = draft.nuntaGroup;'));
  assert.ok(slice.includes('if (draft.name1) name1Input.value = draft.name1;'));
  assert.ok(slice.includes('if (draft.name2) name2Input.value = draft.name2;'));
  assert.ok(slice.includes('refreshRelationUI();'));
});

test('comanda.html: saveDraft() persista recipientRole/senderRole/recipientMode/nuntaGroup/nume', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('function saveDraft()');
  const slice = html.slice(idx, idx + 1200);
  assert.ok(slice.includes('recipientRole: recipientRoleInput.value,'));
  assert.ok(slice.includes('senderRole: senderRoleInput.value,'));
  assert.ok(slice.includes('recipientMode: recipientModeInput.value,'));
  assert.ok(slice.includes('nuntaGroup: nuntaGroup,'));
});

// -------------------------------------------------------------------------------------------
// 8-9: "Nuntă/Botez" afiseaza Miri/Fini/Nași, fiecare grup cu alegere singulara si "Amândoi".
// -------------------------------------------------------------------------------------------
test('comanda.html: "Nuntă/Botez" afiseaza cele trei grupuri Miri/Fini/Nași', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="miri">'));
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="fini">'));
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="nasi">'));
});

test('comanda.html: fiecare grup de nunta ofera rol individual (feminin, masculin) SAU "Amândoi"', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("miri: ['bride', 'groom', 'couple'],"));
  assert.ok(html.includes("fini: ['goddaughter', 'godson', 'godchildren'],"));
  assert.ok(html.includes("nasi: ['godmother', 'godfather', 'godparents']"));
  assert.ok(html.includes("const NUNTA_BOTH_ROLES = ['couple', 'godchildren', 'godparents'];"));
});

test('comanda.html: eticheta "Nuntă/Botez" a inlocuit cardul "Nunta" in toate cele 8 limbi', () => {
  const html = read('public/comanda.html');
  const forms = ['Nuntă/Botez', 'Wedding/Christening', 'Hochzeit/Taufe', 'Boda/Bautizo', 'Matrimonio/Battesimo', 'Mariage/Baptême', 'Сватба/Кръщене', 'Düğün/Vaftiz'];
  forms.forEach(f => assert.ok(html.includes(`theme_nunta_name: '${f}'`), `lipseste forma "${f}" pentru theme_nunta_name`));
  assert.ok(!html.includes("theme_nunta_name: 'Nunta'"), 'vechea eticheta "Nunta" (fara /Botez) nu trebuie sa mai existe');
});

// -------------------------------------------------------------------------------------------
// 10: "Amândoi" solicita si salveaza doua nume distincte.
// -------------------------------------------------------------------------------------------
// NOTA (CONTINUARE — personalizarea reala a versurilor, hotfix 2026-08-08): campurile de nume
// (#nunta-name1/#nunta-name2) au fost GENERALIZATE intr-un element unic reutilizabil
// (#name1/#name2, id="both-names-field") reparentat intre Nuntă/Botez si cele 3 ocazii de
// familie cu "Amândoi" — "reutilizeaza, nu paralel", cerinta explicita a corectiei.
test('comanda.html: alegerea "Amândoi" arata doua campuri de nume distincte si seteaza recipientMode="both"', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("recipientModeInput.value = NUNTA_BOTH_ROLES.includes(c.dataset.role) ? 'both' : 'single';"));
  assert.ok(html.includes('id="name1"') && html.includes('id="name2"'));
  assert.ok(html.includes('id="both-names-field"'));
  assert.ok(html.includes("bothNamesField.style.display = 'block';"));
});

test('comanda.html: validateStep(1) blocheaza continuarea daca lipseste oricare din cele doua nume la "Amândoi"', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("if (recipientModeInput.value === 'both') {"));
  assert.ok(html.includes('const nuntaName1 = name1Input.value.trim();'));
  assert.ok(html.includes('const nuntaName2 = name2Input.value.trim();'));
  assert.ok(html.includes("if (!nuntaName1 || !nuntaName2) ok = false;"));
});

test('comanda.html: numele NU sunt combinate intr-un singur camp de INTRODUCERE — doua input-uri separate, cu etichete distincte per grup', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('<input type="text" id="name1" maxlength="60">'));
  assert.ok(html.includes('<input type="text" id="name2" maxlength="60">'));
  assert.ok(html.includes("nunta_name_bride_label: 'Numele miresei', nunta_name_groom_label: 'Numele mirelui',"));
});

test('server.js: "Amândoi" cere ambele nume, validate ca stringuri nevide, salvate structurat in recipient_names', () => {
  const server = read('server.js');
  assert.ok(server.includes("if (expectedMode === 'both') {"));
  assert.ok(server.includes("if (!isValidString(name1, 1, 60) || !isValidString(name2, 1, 60)) {"));
  assert.ok(server.includes('safeRecipientNames = { name1, name2 };'));
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_names JSONB;'));
});

// -------------------------------------------------------------------------------------------
// 11: Backend-ul respinge combinatiile incomplete sau imposibile.
// -------------------------------------------------------------------------------------------
test('server.js: ocaziile de familie resping recipientRole/senderRole invalide sau incompatibile', () => {
  const server = read('server.js');
  assert.ok(server.includes('if (FAMILY_OCCASIONS.includes(occasion)) {'));
  assert.ok(server.includes('const allowedRecipientRoles = FAMILY_OCCASION_RECIPIENT_ROLES[occasion];'));
  assert.ok(server.includes('if (!allowedRecipientRoles.includes(recipientRole)) {'));
  assert.ok(server.includes('const allowedSenderRoles = FAMILY_RECIPIENT_TO_SENDER_ROLES[recipientRole];'));
  assert.ok(server.includes('if (!allowedSenderRoles.includes(senderRole)) {'));
});

test('server.js: "nunta" respinge recipientMode incompatibil cu recipientRole (rol individual cu mode="both" sau invers)', () => {
  const server = read('server.js');
  assert.ok(server.includes('const expectedMode = isBothRole ? \'both\' : \'single\';'));
  assert.ok(server.includes('if (recipientMode !== expectedMode) {'));
});

test('server.js: client-ul NU poate forta o combinatie recipientRole/occasion incompatibila (ex. rol de nunta pentru occasion="bunici")', () => {
  const server = read('server.js');
  // FAMILY_OCCASION_RECIPIENT_ROLES[occasion] e o lista FIXA per ocazie — un rol de nunta
  // (ex. 'groom') nu apare in nicio lista de familie, deci .includes() il respinge automat.
  assert.ok(!/bunici:\s*\[[^\]]*groom/.test(server));
  assert.ok(server.includes("bunici: ['grandmother', 'grandfather', 'grandparents'],"));
});

// -------------------------------------------------------------------------------------------
// 12: Headerul romanesc foloseste formele gramaticale corecte.
// -------------------------------------------------------------------------------------------
test('melodia-mea.html: antetul RO foloseste formele corecte pentru destinatar (bunica/bunicul/mama/tatăl/...)', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('const RELATION_DISPLAY_NOUNS = {');
  const slice = html.slice(idx, idx + 900);
  assert.ok(slice.includes("grandmother: 'bunica', grandfather: 'bunicul', mother: 'mama', father: 'tatăl'"));
  assert.ok(slice.includes("aunt: 'mătușa', uncle: 'unchiul', mother_in_law: 'soacra', father_in_law: 'socrul'"));
});

test('melodia-mea.html: antetul RO foloseste genitivul corect pentru expeditor (nepotului/nepoatei/fiicei/fiului/nurorii/ginerelui)', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('const RELATION_DISPLAY_NOUNS = {');
  const slice = html.slice(idx, idx + 900);
  assert.ok(slice.includes("daughter: 'fiicei', son: 'fiului', granddaughter: 'nepoatei', grandson: 'nepotului'"));
  assert.ok(slice.includes("daughter_in_law: 'nurorii', son_in_law: 'ginerelui'"), 'norei -> nurorii si ginerelui sunt forme irregulate obligatorii');
});

test('melodia-mea.html: antetul personalizat compune "Melodia pentru {relatie} {nume}" si "Din partea {relatie-genitiv} {nume}"', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('ro: (rn, name) => `Melodia pentru ${rn} ${name}`,'));
  assert.ok(html.includes('ro: (sn, name) => `Din partea ${sn} ${name}`,'));
});

test('melodia-mea.html: renderContent() foloseste antetul personalizat DOAR cand order.recipientRole exista, altfel EXACT antetul generic vechi', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('const personalized = composePersonalizedHeading(order, lang);'));
  assert.ok(html.includes("document.getElementById('song-heading').textContent = t.heading(order.recipient || '');"), 'fallback-ul generic vechi trebuie sa ramana neschimbat');
});

// -------------------------------------------------------------------------------------------
// 13: Payloadul generatorului contine relatiile si numele selectate.
// -------------------------------------------------------------------------------------------
test('comanda.html: collectPayload() trimite recipientRole/senderRole/recipientMode/recipientNames catre server', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('function collectPayload()');
  const endIdx = html.indexOf('function saveDraft()');
  const slice = html.slice(idx, endIdx);
  assert.ok(slice.includes('recipientRole: recipientRoleInput.value,'));
  assert.ok(slice.includes('senderRole: senderRoleInput.value,'));
  assert.ok(slice.includes('recipientMode: recipientModeInput.value,'));
  assert.ok(slice.includes('? { name1: name1Input.value.trim(), name2: name2Input.value.trim() }'));
});

test('server.js: GET /api/orders/:orderId expune occasion/recipientRole/senderRole (altfel antetul personalizat nu primeste niciodata datele)', () => {
  // Gasit direct la testarea live pe staging: whitelist-ul explicit de raspuns (fara spread pe
  // `order`, ca sa nu se scurga accessToken/email) omitea aceste 3 campuri — composePersonalizedHeading
  // din melodia-mea.html primea mereu order.recipientRole undefined, desi era salvat corect in DB.
  const server = read('server.js');
  const idx = server.indexOf("app.get('/api/orders/:orderId'");
  const endIdx = server.indexOf('app.post', idx);
  const slice = server.slice(idx, endIdx);
  assert.ok(slice.includes('occasion: order.occasion || null,'));
  assert.ok(slice.includes('recipientRole: order.recipientRole || null,'));
  assert.ok(slice.includes('senderRole: order.senderRole || null,'));
});

test('server.js: db.createOrder primeste recipientRole/senderRole/recipientMode/recipientNames validate', () => {
  const server = read('server.js');
  assert.ok(server.includes('recipientRole: safeRecipientRole,'));
  assert.ok(server.includes('senderRole: safeSenderRole,'));
  assert.ok(server.includes('recipientMode: safeRecipientMode,'));
  assert.ok(server.includes('recipientNames: safeRecipientNames'));
});

// -------------------------------------------------------------------------------------------
// 14: Versurile folosesc relatia fara sa o inventeze.
// -------------------------------------------------------------------------------------------
test('server.js: buildPrompt mentioneaza relatia DOAR daca order.recipientRole exista, NICIODATA inventata/dedusa', () => {
  const server = read('server.js');
  assert.ok(server.includes('const recipientNoun = RELATION_NOUNS[effectiveRecipientRole];'));
  assert.ok(server.includes('if (!recipientNoun) return \'\';'));
  assert.ok(server.includes('const senderNoun = SENDER_RELATION_NOUNS[order.senderRole];'));
});

test('server.js: relatia se mentioneaza O SINGURA DATA, fara repetitie fortata, folosind cuvantul natural al limbii versurilor', () => {
  const server = read('server.js');
  assert.ok(server.includes('Mention naturally, once, that the recipient is their'));
  assert.ok(server.includes('Mention naturally, once, that this song is dedicated to the recipient as their'));
});

// NOTA (CONTINUARE — personalizarea reala a versurilor, hotfix 2026-08-08): urarea de "La mulți
// ani" nu mai depinde de o relatie aleasa (submeniul de relatie de la aniversare a fost eliminat
// intre timp) — e acum parte NECONDITIONATA din OCCASION_INSTRUCTIONS.aniversare, aplicata la
// ORICE comanda aniversare, cu sau fara relatie de familie. Vezi test/occasion-real-personalization.test.js.
test('server.js: "E ziua lui/ei" include urarea de "La mulți ani" neconditionat, in orice comanda aniversare', () => {
  const server = read('server.js');
  const idx = server.indexOf('aniversare: {');
  const slice = server.slice(idx, idx + 500);
  assert.ok(slice.includes('birthday wish'));
});

// -------------------------------------------------------------------------------------------
// 15: Toate cheile exista in cele 8 limbi.
// -------------------------------------------------------------------------------------------
test('comanda.html: toate cheile noi de traducere exista exact de 8 ori (o data per limba)', () => {
  const html = read('public/comanda.html');
  const keys = [
    'theme_parinti_name:', 'theme_matusaunchi_name:', 'theme_socri_name:',
    'relation_grandmother:', 'relation_other:', 'nunta_both:',
    'sender_relation_daughter:', 'label_recipient_role:', 'label_sender_role:',
    'label_aniversare_relation:', 'label_nunta_group:', 'label_nunta_subrole:', 'label_nunta_sender:',
    'nunta_group_miri:', 'nunta_name_bride_label:', 'and_conjunction:',
    'val_recipient_role:', 'val_sender_role:', 'val_nunta_names:'
  ];
  keys.forEach(key => {
    const count = html.split(key).length - 1;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori, a aparut de ${count} ori`);
  });
});

test('melodia-mea.html: RELATION_DISPLAY_NOUNS acopera toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('const RELATION_DISPLAY_NOUNS = {');
  const endIdx = html.indexOf('const HEADING_PERSONALIZED_TEMPLATE', idx);
  const slice = html.slice(idx, endIdx);
  ['ro:', 'en:', 'de:', 'es:', 'it:', 'fr:', 'bg:', 'tr:'].forEach(langKey => {
    assert.ok(slice.includes(langKey), `lipseste limba ${langKey} din RELATION_DISPLAY_NOUNS`);
  });
});

// -------------------------------------------------------------------------------------------
// 16: Comenzile vechi fara noile campuri functioneaza in continuare.
// -------------------------------------------------------------------------------------------
test('db.js: coloanele noi sunt NULLABLE si aditive (ADD COLUMN IF NOT EXISTS, fara NOT NULL)', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_role TEXT;'));
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_role TEXT;'));
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_mode TEXT;'));
  assert.ok(!dbjs.includes('recipient_role TEXT NOT NULL'));
});

test('server.js: buildPrompt trateaza order.recipientRole lipsa ca "fara personalizare de relatie" (comenzi vechi nu blocheaza generarea)', () => {
  const server = read('server.js');
  assert.ok(server.includes('const effectiveRecipientRole = order.recipientRole'));
  assert.ok(server.includes("|| (order.occasion === 'bunici' ? (order.grandparentType === 'grandfather' ? 'grandfather' : 'grandmother') : null);"));
});

test('melodia-mea.html: composePersonalizedHeading intoarce null pentru comenzi fara recipientRole (fallback la antetul generic, neschimbat)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('const recipientNoun = order.recipientRole && nouns.recipient[order.recipientRole];'));
  assert.ok(html.includes('if (!recipientNoun) return null;'));
});

// -------------------------------------------------------------------------------------------
// 17: Pachetul Standard pastreaza exact comportamentul actual (nicio regresie).
// -------------------------------------------------------------------------------------------
test('melodia-mea.html: mecanismul de plata directa, meniul pliabil si alegerea intre variante (rundele anterioare) raman neatinse', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("id=\"standard-preedit-checkout-slot-collapsed\""));
  assert.ok(html.includes("id=\"standard-preedit-checkout-slot-expanded\""));
  assert.ok(html.includes('function updateStandardEditMenuVisibility('));
});

test('server.js: PLAN_VARIANT_COUNT si preturile pachetelor raman neschimbate', () => {
  const server = read('server.js');
  assert.match(server, /PLAN_VARIANT_COUNT\s*=\s*\{\s*standard:\s*1,\s*premium:\s*2,\s*video:\s*2\s*\}/);
});
