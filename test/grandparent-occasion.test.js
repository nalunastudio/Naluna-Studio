// Teste de regresie STATICE (citesc direct sursa, fara server/DB) pentru ocazia noua "Pentru
// bunica sau bunicul" (ULTIMELE MODIFICĂRI STRICTE, hotfix 2026-08-08) — alegerea
// grandmother/grandfather e OBLIGATORIE, salvata separat in backend si folosita REAL in
// promptul de versuri (nu doar un cosmetic frontend).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('server.js: ALLOWED_OCCASIONS include "bunici"', () => {
  const server = read('server.js');
  assert.match(server, /ALLOWED_OCCASIONS\s*=\s*\[[^\]]*'bunici'[^\]]*\]/);
});

// NOTA (MODIFICARE STRICTĂ — pagina de ocazie, hotfix 2026-08-08): validarea ingusta, specifica
// doar lui 'bunici', a fost GENERALIZATA intr-un bloc unic care acopera si parinti/matusa-unchi/
// socri — vezi test/occasion-family-relations.test.js pentru acoperirea completa a noului bloc.
test('server.js: POST /api/orders valideaza strict recipientRole/senderRole pentru occasion="bunici" (acum parte din blocul generalizat de familie)', () => {
  const server = read('server.js');
  assert.ok(server.includes("bunici: ['grandmother', 'grandfather'],"), 'bunici trebuie sa ramana in FAMILY_OCCASION_RECIPIENT_ROLES, cu exact aceleasi 2 valori ca inainte');
  assert.ok(server.includes('if (occasion === \'bunici\') safeGrandparentType = recipientRole;'), 'grandparent_type (coloana originala) ramane oglindita pentru compatibilitate');
});

test('server.js: grandparentTypeRequiredMessage acopera toate cele 8 limbi', () => {
  const server = read('server.js');
  const match = server.match(/GRANDPARENT_TYPE_REQUIRED_MESSAGES\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(match, 'GRANDPARENT_TYPE_REQUIRED_MESSAGES trebuie sa existe');
  const body = match[1];
  ['ro:', 'en:', 'de:', 'es:', 'it:', 'fr:', 'bg:', 'tr:'].forEach(langKey => {
    assert.ok(body.includes(langKey), `lipseste mesajul pentru limba ${langKey}`);
  });
});

// NOTA: GRANDPARENT_OCCASION_LABELS/GRANDPARENT_OCCASION_INSTRUCTIONS (specifice doar lui
// 'bunici') au fost inlocuite de sistemul generalizat RELATION_NOUNS/SENDER_RELATION_NOUNS +
// relationClause(), care acopera acum toate ocaziile de familie SI nunta/botez — vezi
// test/occasion-family-relations.test.js pentru acoperirea completa.
test('server.js: buildPrompt deriva relatia din order.recipientRole (fallback grandparentType pentru comenzi vechi), NICIODATA din nume/voce', () => {
  const server = read('server.js');
  assert.ok(server.includes('const effectiveRecipientRole = order.recipientRole'));
  assert.ok(
    server.includes("|| (order.occasion === 'bunici' ? (order.grandparentType === 'grandfather' ? 'grandfather' : 'grandmother') : null);"),
    'fallback-ul pentru comenzi vechi/corupte trebuie sa fie grandmother, niciodata dedus din alte campuri'
  );
  assert.ok(server.includes('RELATION_NOUNS[effectiveRecipientRole]'));
});

test('server.js: instructiunea pentru bunica/bunicul cere mentionarea NATURALA a relatiei in versuri, o singura data', () => {
  const server = read('server.js');
  assert.ok(server.includes("grandmother: 'grandmother', grandfather: 'grandfather',"), 'RELATION_NOUNS trebuie sa acopere grandmother/grandfather');
  assert.ok(server.includes('Mention naturally, once, that the recipient is their'));
  assert.ok(server.includes('Mention naturally, once, that this song is dedicated to the recipient as their'));
});

test('db.js: migrarea grandparent_type e aditiva (ADD COLUMN IF NOT EXISTS)', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS grandparent_type TEXT;'));
});

test('db.js: createOrder salveaza grandparent_type (acum urmat de recipient_role/sender_role/recipient_mode/recipient_names), rowToOrder il expune ca grandparentType', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('grandparent_type, recipient_role, sender_role, recipient_mode, recipient_names)'), 'INSERT-ul trebuie sa includa toate cele 5 coloane, in aceasta ordine');
  assert.ok(dbjs.includes('$21,$22,$23,$24)'), 'coloanele noi trebuie sa fie ultimii 4 parametri ($21-$24)');
  assert.ok(dbjs.includes('order.grandparentType || null'), 'valoarea trebuie sa vina din order.grandparentType, cu fallback null');
  assert.ok(dbjs.includes('grandparentType: row.grandparent_type,'), 'rowToOrder trebuie sa expuna coloana catre restul aplicatiei');
});

test('db.js: grandparentType NU e in COLUMN_MAP (set o singura data la creare, ca relationship/senderName)', () => {
  const dbjs = read('db.js');
  const match = dbjs.match(/const COLUMN_MAP\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(match, 'COLUMN_MAP trebuie sa existe');
  assert.ok(!/grandparentType\s*:/.test(match[1]), 'grandparentType nu trebuie sa fie editabil via db.updateOrder — e imutabil dupa creare');
});

test('comanda.html: cardul "Pentru bunica sau bunicul" exista in grila de ocazii', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('<div class="theme-card" data-theme="bunici">'));
  assert.ok(html.includes('data-i18n="theme_bunici_name"'));
  assert.ok(html.includes('data-i18n="theme_bunici_desc"'));
});

test('comanda.html: sub-alegerea bunica/bunicul exista, ascunsa implicit, cu doua carduri obligatorii (acum panou generalizat de familie)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('id="family-relation-panel" style="display:none;'), 'campul trebuie ascuns implicit');
  assert.ok(html.includes("bunici: ['grandmother', 'grandfather'],"), 'cele doua optiuni obligatorii pentru bunici raman exact grandmother/grandfather');
  assert.ok(html.includes('id="recipientRole"'));
  assert.ok(html.includes('id="err-recipientRoleFamily"'));
});

test('comanda.html: handler-ul generic de ocazii exclude .theme-subcard (evita bug-ul occasionInput.value = undefined)', () => {
  const html = read('public/comanda.html');
  assert.ok(
    html.includes("document.querySelectorAll('.theme-card:not(.theme-subcard)')"),
    'fara aceasta excludere, click pe orice sub-alegere de relatie ar seta occasionInput.value = undefined'
  );
});

test('comanda.html: validateStep(1) blocheaza continuarea pana la alegerea bunicii/bunicului (acum parte din validarea generalizata FAMILY_OCCASIONS)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('if (FAMILY_OCCASIONS.includes(occasionVal)) {'));
  assert.ok(html.includes("setFieldError('recipientRoleFamily', recipientRoleInput.value ? '' : t('val_recipient_role'));"));
  assert.ok(html.includes("if (!recipientRoleInput.value || !senderRoleInput.value) ok = false;"));
});

// NOTA (MODIFICARE STRICTĂ — pagina de ocazie, hotfix 2026-08-08): campul ingust
// grandparentType/grandparentTypeInput/updateGrandparentTypeVisibility() a fost GENERALIZAT
// intr-un sistem unificat de relatii (recipientRole/senderRole), reutilizat acum si pentru
// parinti/matusa-unchi/socri/aniversare/nunta — vezi test/occasion-family-relations.test.js
// pentru acoperirea completa a noului sistem (collectPayload, saveDraft/restoreDraft,
// refreshRelationUI). Testele de mai jos raman doar pentru partea inca valabila (traducerile
// existente, pastrate neutilizate direct dar nesterse, pentru compatibilitate).
test('comanda.html: collectPayload trimite recipientRole catre server (grandparentType generalizat)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('recipientRole: recipientRoleInput.value,'));
});

test('comanda.html: cele 6 chei noi de traducere exista pentru toate cele 8 limbi', () => {
  const html = read('public/comanda.html');
  const keys = [
    'theme_bunici_name:', 'theme_bunici_desc:', 'label_grandparent_type:',
    'grandparent_grandmother_name:', 'grandparent_grandfather_name:', 'val_grandparent_type:'
  ];
  keys.forEach(key => {
    const count = html.split(key).length - 1;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori (o data per limba), a aparut de ${count} ori`);
  });
});

test('comanda.html: label-urile de sub-alegere folosesc data-i18n, nu text hardcodat (sistem generalizat)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('data-i18n="label_recipient_role"'));
  assert.ok(html.includes('data-i18n="relation_grandmother"'));
  assert.ok(html.includes('data-i18n="relation_grandfather"'));
});
