// Teste de acceptare pentru CORECȚIE STRICTĂ — PAGINA "PENTRU CE MOMENT VREI CÂNTECUL?"
// (hotfix 2026-08-08): (1) elimina complet submeniul de relatie de la "E ziua lui/ei",
// (2) elimina "Din partea cui este melodia?" de la Nuntă/Botez, (3) foloseste ambele nume
// complete pentru "Amândoi" (vezi test/nunta-both-names-no-truncation.test.js pentru
// verificarea EXECUTABILA a acestui punct), (4) elimina "Cu drag, Finilor" din antet pentru
// comenzile noi. Acopera cele 12 teste de acceptare explicite din cererea de corectie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// 1. "E ziua lui/ei" nu mai afiseaza niciun submeniu.
test('comanda.html: NU mai exista niciun panou/submeniu de relatie pentru "E ziua lui/ei"', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('aniversare-relation-panel'), 'panoul de relatie de la aniversare trebuie eliminat complet din HTML');
  assert.ok(!html.includes('aniversare-relation-card'), 'cardurile de sub-alegere trebuie eliminate complet');
  assert.ok(!html.includes('label_aniversare_relation') === false || !html.includes('data-i18n="label_aniversare_relation"'), 'eticheta submeniului nu mai trebuie sa apara in HTML');
});

// NOTA (CONTINUARE — personalizarea reala a versurilor, hotfix 2026-08-08): parinti/matusa-unchi/
// socri au primit a treia optiune "Amândoi" (cerinta explicita a rundei curente) — DOAR bunici
// ramane la exact 2 optiuni, neschimbat. Vezi test/occasion-real-personalization.test.js.
test('comanda.html: cardurile Bunică/Bunic, Mamă/Tată, Mătușă/Unchi, Soacră/Socru exista, cu optiunile corecte (bunici: 2, celelalte 3)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("bunici: ['grandmother', 'grandfather'],"));
  assert.ok(html.includes("parinti: ['mother', 'father', 'parents'],"));
  assert.ok(html.includes("'matusa-unchi': ['aunt', 'uncle', 'aunt_uncle'],"));
  assert.ok(html.includes("socri: ['mother_in_law', 'father_in_law', 'parents_in_law']"));
  assert.ok(html.includes('<div class="theme-card" data-theme="bunici">'));
  assert.ok(html.includes('<div class="theme-card" data-theme="parinti">'));
  assert.ok(html.includes('<div class="theme-card" data-theme="matusa-unchi">'));
  assert.ok(html.includes('<div class="theme-card" data-theme="socri">'));
});

// 2. Selectarea acestei ocazii permite continuarea normala.
test('comanda.html: validateStep(1) nu mai are nicio ramura speciala pentru "aniversare" — se comporta ca orice ocazie generica', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes("else if (occasionVal === 'aniversare'"), 'nu mai trebuie sa existe nicio ramura conditionala speciala pentru aniversare in validateStep');
  const idx = html.indexOf('if (n === 1) {');
  const endIdx = html.indexOf('if (!ok && firstInvalid)');
  const slice = html.slice(idx, endIdx);
  assert.ok(slice.includes('if (FAMILY_OCCASIONS.includes(occasionVal)) {'), 'doar cele 4 ocazii de familie mai au validare de relatie');
  assert.ok(!/\}\s*else\s*if/.test(slice), 'blocul de relatie nu mai trebuie sa aiba ramuri else-if (era nevoie doar pentru aniversare, acum eliminata)');
});

test('server.js: occasion="aniversare" nu mai are nicio ramura de validare — recipientRole/senderRole raman null ca la orice ocazie generica', () => {
  const server = read('server.js');
  assert.ok(!server.includes("} else if (occasion === 'aniversare') {"), 'ramura speciala pentru aniversare trebuie eliminata din POST /api/orders');
  assert.ok(!server.includes('ALL_FAMILY_RECIPIENT_ROLES ='), 'constanta folosita doar de ramura eliminata trebuie sa dispara si ea');
});

// 3. Valorile vechi ale relatiei sunt eliminate din payload.
test('comanda.html: click pe orice card de ocazie principala reseteaza recipientRole/senderRole (nu ramane nimic agatat de la o ocazie anterioara)', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('themeCards.forEach(c => {');
  const slice = html.slice(idx, idx + 900);
  assert.ok(slice.includes("recipientRoleInput.value = '';"));
  assert.ok(slice.includes("senderRoleInput.value = '';"));
});

test('comanda.html: alegerea "E ziua lui/ei" nu mai poate SETA recipientRole/senderRole in acest sesiune (niciun handler ramas pentru aniversare)', () => {
  const html = read('public/comanda.html');
  assert.ok(!/aniversare.*recipientRoleInput\.value\s*=/.test(html), 'nu mai trebuie sa existe niciun cod care seteaza recipientRole pe baza selectiei aniversare');
});

// 4. "Nuntă/Botez" pastreaza Miri/Fini/Nași si optiunile lor.
test('comanda.html: "Nuntă/Botez" pastreaza NESCHIMBAT Miri/Fini/Nași, rolurile individuale si "Amândoi"', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="miri">'));
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="fini">'));
  assert.ok(html.includes('<div class="theme-card theme-subcard nunta-group-card" data-group="nasi">'));
  assert.ok(html.includes("miri: ['bride', 'groom', 'couple'],"));
  assert.ok(html.includes("fini: ['goddaughter', 'godson', 'godchildren'],"));
  assert.ok(html.includes("nasi: ['godmother', 'godfather', 'godparents']"));
  assert.ok(html.includes('id="name1"') && html.includes('id="name2"'), 'campurile pentru nume raman functional neschimbate (generalizate/reutilizate, nu duplicate)');
});

// NOTA: isSingleRole/isBothRole au primit in plus filtrarea dupa weddingType (Nuntă/Botez,
// cerinta noua a acestei runde) — logica de baza (Amândoi -> recipientMode='both' + doua nume)
// ramane neschimbata.
test('server.js: validarea Miri/Fini/Nași si "Amândoi" pentru nunta ramane functional neschimbata (acum filtrata si dupa weddingType)', () => {
  const server = read('server.js');
  assert.ok(server.includes("const isSingleRole = WEDDING_RECIPIENT_ROLES_SINGLE.includes(recipientRole) && allowedRolesForType.includes(recipientRole);"));
  assert.ok(server.includes("const isBothRole = WEDDING_RECIPIENT_ROLES_BOTH.includes(recipientRole) && allowedRolesForType.includes(recipientRole);"));
  assert.ok(server.includes("if (expectedMode === 'both') {"));
  assert.ok(server.includes('safeRecipientNames = { name1, name2 };'));
});

// 5. "Din partea cui este melodia?" nu mai apare si nu mai este obligatorie.
test('comanda.html: "Din partea cui este melodia?" a fost eliminat complet — niciun element, niciun handler', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('nunta-sender-field'), 'campul trebuie eliminat complet din HTML');
  assert.ok(!html.includes('nunta-sender-select'), 'selectorul trebuie eliminat complet din HTML/JS');
  assert.ok(!html.includes('NUNTA_SENDER_ROLES'), 'lista de roluri pentru selector trebuie eliminata');
  assert.ok(!html.includes("label_nunta_sender\">Din partea"), 'textul nu mai trebuie sa fie folosit ca eticheta vizibila');
});

test('server.js: "Din partea cui este melodia?" nu mai e cerut/salvat pentru comenzile NOI Nuntă/Botez', () => {
  const server = read('server.js');
  assert.ok(!server.includes('WEDDING_SENDER_ROLES'), 'lista de roluri de expeditor pentru nunta trebuie eliminata complet');
  const idx = server.indexOf("} else if (occasion === 'nunta') {");
  const endIdx = server.indexOf('if (!isValidString(recipient, 1, 60))', idx);
  const nuntaBlock = server.slice(idx, endIdx);
  assert.ok(!nuntaBlock.includes('if (!WEDDING_SENDER_ROLES.includes(senderRole))'), 'validarea senderRole trebuie eliminata din blocul de nunta');
  assert.ok(!nuntaBlock.includes('safeSenderRole = senderRole;'), 'senderRole nu mai trebuie salvat pentru comenzile noi de nunta');
  assert.ok(nuntaBlock.includes('safeRecipientRole = recipientRole;'));
  assert.ok(nuntaBlock.includes('safeRecipientMode = expectedMode;'));
});

// 6-7. Alegerea "Amândoi" solicita exact doua nume; ambele salvate integral in backend.
test('comanda.html: "Amândoi" solicita exact doua nume, validate ca obligatorii', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("if (recipientModeInput.value === 'both') {"));
  assert.ok(html.includes('const nuntaName1 = name1Input.value.trim();'));
  assert.ok(html.includes('const nuntaName2 = name2Input.value.trim();'));
  assert.ok(html.includes('if (!nuntaName1 || !nuntaName2) ok = false;'));
});

test('server.js si db.js: ambele nume sunt salvate INTEGRAL, structurat, in recipient_names (JSONB)', () => {
  const server = read('server.js');
  assert.ok(server.includes('if (!isValidString(name1, 1, 60) || !isValidString(name2, 1, 60)) {'));
  assert.ok(server.includes('safeRecipientNames = { name1, name2 };'), 'numele salvate NU trebuie modificate/prescurtate fata de ce a trimis clientul');
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('order.recipientNames ? JSON.stringify(order.recipientNames) : null'));
});

// 8-9. Titlul si versurile contin ambele nume complete (vezi si test/nunta-both-names-no-truncation.test.js).
test('comanda.html: collectPayload combina numele fara sa le prescurteze ("Alina și Andrei", nu "Alina și A.")', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("`${name1Input.value.trim()} ${t('and_conjunction')} ${name2Input.value.trim()}`"), 'ambele nume trebuie folosite intregi, fara .slice/.charAt/.substring');
  assert.ok(!/name[12]Input\.value\.(slice|charAt|substring)/.test(html), 'nu trebuie sa existe nicio prescurtare a numelor in frontend');
});

test('melodia-mea.html: antetul foloseste order.recipient COMPLET, fara nicio trunchiere client-side', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('const heading = headingFn(recipientNoun, order.recipient || \'\');'));
  assert.ok(!/order\.recipient\.(slice|charAt|substring)/.test(html), 'antetul nu trebuie sa trunchieze niciodata order.recipient');
});
// Verificarea EXECUTABILA (rulare reala a buildPrompt cu date worst-case) e in
// test/nunta-both-names-no-truncation.test.js — 7 teste dedicate, inclusiv nume de 60 caractere,
// cratima, diacritice si Fini/Nași (nu doar Miri).

// 10. Comenzile noi "Nuntă/Botez" nu mai afiseaza "Cu drag, Finilor" sau echivalentul sau.
test('melodia-mea.html: comenzile NOI nunta cu recipientRole dar FARA senderRole nu mai cad pe formularea generica "Cu drag, X"', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('const personalized = composePersonalizedHeading(order, lang);');
  const slice = html.slice(idx, idx + 1500);
  assert.ok(slice.includes("} else if (order.occasion === 'nunta') {"));
  assert.ok(slice.includes("dedicationEl.style.display = 'none';"));
  // ordinea conteaza: ramura 'nunta' trebuie sa fie INAINTE de fallback-ul generic order.senderName,
  // altfel fallback-ul generic ar prinde-o oricum.
  const nuntaElseIdx = slice.indexOf("order.occasion === 'nunta'");
  const genericElseIdx = slice.indexOf('order.senderName) {');
  assert.ok(nuntaElseIdx !== -1 && genericElseIdx !== -1 && nuntaElseIdx < genericElseIdx, 'ramura nunta trebuie verificata inaintea fallback-ului generic');
});

test('melodia-mea.html: comenzile VECHI Nuntă/Botez cu senderRole deja salvat isi pastreaza dedicatia (compatibilitate)', () => {
  const html = read('public/melodia-mea.html');
  const idx = html.indexOf('const personalized = composePersonalizedHeading(order, lang);');
  const slice = html.slice(idx, idx + 1500);
  assert.ok(slice.includes('if (personalized.dedication) {'));
  assert.ok(slice.includes('dedicationEl.textContent = personalized.dedication;'));
});

// 11. Toate cele 8 limbi functioneaza (traducerile ramase — carduri, Miri/Fini/Nași, nume,
// validari pentru "Amândoi" — nu au fost atinse de aceasta corectie, doar cele eliminate).
test('comanda.html: traducerile ramase (Miri/Fini/Nași, numele "Amândoi", validari) exista in continuare in toate cele 8 limbi', () => {
  const html = read('public/comanda.html');
  const keys = [
    'nunta_group_miri:', 'nunta_group_fini:', 'nunta_group_nasi:', 'nunta_both:',
    'nunta_name_bride_label:', 'nunta_name_groom_label:', 'and_conjunction:', 'val_nunta_names:'
  ];
  keys.forEach(key => {
    const count = html.split(key).length - 1;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori, a aparut de ${count} ori`);
  });
});

test('comanda.html: nu exista chei i18n afisate accidental (nicio referinta ramasa la cheile eliminate din HTML vizibil)', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('data-i18n="label_aniversare_relation"'));
  assert.ok(!html.includes('data-i18n="label_nunta_sender"'));
});

// 12. Pachetul Standard si restul fluxului au ramas neschimbate.
test('melodia-mea.html: mecanismele Standard (plata directa, meniu pliabil, alegere variante) raman neatinse', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="standard-preedit-checkout-slot-collapsed"'));
  assert.ok(html.includes('id="standard-preedit-checkout-slot-expanded"'));
  assert.ok(html.includes('function updateStandardEditMenuVisibility('));
});

test('server.js: PLAN_VARIANT_COUNT si ALLOWED_OCCASIONS raman neschimbate (nicio ocazie eliminata/redenumita la nivel de valoare interna)', () => {
  const server = read('server.js');
  assert.match(server, /PLAN_VARIANT_COUNT\s*=\s*\{\s*standard:\s*1,\s*premium:\s*2,\s*video:\s*2\s*\}/);
  assert.ok(server.includes("const ALLOWED_OCCASIONS = ['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'altceva', 'bunici', 'parinti', 'matusa-unchi', 'socri'];"), 'occasion="nunta" ramane valoarea interna neschimbata, doar eticheta afisata s-a schimbat');
});
