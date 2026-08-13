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

// NOTA (CONTINUARE — personalizarea reala a versurilor, hotfix 2026-08-08 si 2026-08-09):
// parinti/matusa-unchi/socri au primit a treia optiune "Amândoi"; bunici a primit-o si el,
// intr-o runda ulterioara (2026-08-09) — toate cele 4 ocazii de familie au acum 3 optiuni.
// Vezi test/occasion-real-personalization.test.js si test/bunici-amandoi-relation-name.test.js.
test('comanda.html: cardurile Bunică/Bunic, Mamă/Tată, Mătușă/Unchi, Soacră/Socru exista, cu optiunile corecte (toate cu 3 optiuni, Amândoi inclus)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("bunici: ['grandmother', 'grandfather', 'grandparents'],"));
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
// cerinta noua a acestei runde) — logica de baza (Amândoi -> recipientMode='both') ramane
// neschimbata; DAR (2026-08-13, runda "Amândoi" fara campuri duplicate) recipientNames a devenit
// STRICT optional — nu mai e cerut, numele vin din campul unic recipient.
test('server.js: validarea Miri/Fini/Nași si "Amândoi" pentru nunta ramane functional neschimbata (acum filtrata si dupa weddingType), recipientNames optional', () => {
  const server = read('server.js');
  assert.ok(server.includes("const isSingleRole = WEDDING_RECIPIENT_ROLES_SINGLE.includes(recipientRole) && allowedRolesForType.includes(recipientRole);"));
  assert.ok(server.includes("const isBothRole = WEDDING_RECIPIENT_ROLES_BOTH.includes(recipientRole) && allowedRolesForType.includes(recipientRole);"));
  assert.ok(server.includes("if (expectedMode === 'both' && recipientNames && typeof recipientNames === 'object') {"));
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

// 6-7 (REVIZUIT 2026-08-13, runda "Amândoi" fara campuri duplicate): "Amândoi" NU mai solicita
// doua campuri de nume separate pe aceasta pagina — un singur nume (sau doua, ex.
// "Maria și Ion") se introduce pe pagina urmatoare, in campul existent "recipient".
test('comanda.html: "Amândoi" NU mai solicita doua campuri de nume separate pe aceasta pagina', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('if (!nuntaName1 || !nuntaName2) ok = false;'), 'validateStep(1) nu mai trebuie sa ceara doua nume separate la "Amândoi"');
});

test('server.js si db.js: recipient_names (JSONB) ramane optional, folosit doar daca clientul il trimite — coloana pastrata pentru compatibilitate', () => {
  const server = read('server.js');
  assert.ok(!/if \(!isValidString\(name1, 1, 60\) \|\| !isValidString\(name2, 1, 60\)\) \{\s*return res\.status\(400\)/.test(server), 'server.js nu mai trebuie sa respinga comanda pentru lipsa name1/name2');
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('order.recipientNames ? JSON.stringify(order.recipientNames) : null'));
});

// 8-9. Numele complete (recipient, campul unic) ajung intregi in prompt/antet — vezi
// test/nunta-both-names-no-truncation.test.js pentru executia reala a buildPrompt.
test('comanda.html: collectPayload trimite recipient exact cum l-a introdus clientul, fara nicio prescurtare (recipientNames=null, sursa unica e campul recipient)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('recipientNames: null,'));
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

// NOTA (CONTINUARE, hotfix 2026-08-09, "Soră/Frate"): 'frati' a fost adaugat ca ocazie noua —
// nicio ocazie EXISTENTA nu a fost eliminata sau redenumita, doar extinsa lista cu una noua.
// REVIZUIT (2026-08-14): PLAN_VARIANT_COUNT.video a fost corectat intentionat de la 2 la 1
// ("Cadou video: o singura melodie initiala + o editare") — regula ramane neschimbata pentru
// standard/premium, verificata mai jos alaturi de ALLOWED_OCCASIONS.
test('server.js: PLAN_VARIANT_COUNT.standard/premium si ALLOWED_OCCASIONS raman neschimbate (nicio ocazie eliminata/redenumita la nivel de valoare interna)', () => {
  const server = read('server.js');
  assert.match(server, /PLAN_VARIANT_COUNT\s*=\s*\{\s*standard:\s*1,\s*premium:\s*2,\s*video:\s*1\s*\}/);
  assert.ok(server.includes("const ALLOWED_OCCASIONS = ['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'altceva', 'bunici', 'parinti', 'matusa-unchi', 'socri', 'frati'];"), 'occasion="nunta" ramane valoarea interna neschimbata, doar eticheta afisata s-a schimbat; "frati" e o adaugare noua, nu o redenumire');
});
