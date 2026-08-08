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

test('server.js: POST /api/orders cere si valideaza strict grandparentType cand occasion="bunici"', () => {
  const server = read('server.js');
  assert.ok(server.includes("if (occasion === 'bunici') {"), 'validarea trebuie sa fie conditionata de occasion === bunici');
  assert.ok(
    server.includes("if (grandparentType !== 'grandmother' && grandparentType !== 'grandfather') {"),
    'trebuie acceptate DOAR valorile grandmother/grandfather, nimic altceva'
  );
  assert.ok(server.includes('grandparentTypeRequiredMessage(safeLang)'), 'eroarea trebuie sa foloseasca mesajul tradus');
  assert.ok(server.includes('safeGrandparentType = grandparentType;'));
  assert.ok(server.includes('grandparentType: safeGrandparentType'), 'valoarea validata trebuie trimisa catre db.createOrder');
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

test('server.js: buildPrompt deriva eticheta/instructiunea din grandparentType, NICIODATA din nume/voce', () => {
  const server = read('server.js');
  assert.ok(server.includes("const isGrandparentOccasion = order.occasion === 'bunici';"));
  assert.ok(
    server.includes("const grandparentType = (order.grandparentType === 'grandfather') ? 'grandfather' : 'grandmother';"),
    'fallback-ul pentru comenzi vechi/corupte trebuie sa fie grandmother, niciodata dedus din alte campuri'
  );
  assert.ok(server.includes('GRANDPARENT_OCCASION_LABELS[grandparentType]'));
  assert.ok(server.includes('GRANDPARENT_OCCASION_INSTRUCTIONS[grandparentType]'));
});

test('server.js: instructiunea pentru bunica/bunicul cere mentionarea NATURALA a relatiei in versuri', () => {
  const server = read('server.js');
  const match = server.match(/GRANDPARENT_OCCASION_INSTRUCTIONS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(match, 'GRANDPARENT_OCCASION_INSTRUCTIONS trebuie sa existe');
  const body = match[1];
  assert.ok(/grandmother[\s\S]*?full:[\s\S]*?naturally mention/.test(body), 'instructiunea pentru bunica trebuie sa ceara mentionare naturala');
  assert.ok(/grandfather[\s\S]*?full:[\s\S]*?naturally mention/.test(body), 'instructiunea pentru bunicul trebuie sa ceara mentionare naturala');
  assert.ok(body.includes('never a forced repetition'), 'relatia nu trebuie repetata fortat');
});

test('db.js: migrarea grandparent_type e aditiva (ADD COLUMN IF NOT EXISTS)', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS grandparent_type TEXT;'));
});

test('db.js: createOrder salveaza grandparent_type, rowToOrder il expune ca grandparentType', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('grandparent_type)') && dbjs.includes('$20)'), 'INSERT-ul trebuie sa includa coloana grandparent_type ca al 20-lea parametru');
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

test('comanda.html: sub-alegerea bunica/bunicul exista, ascunsa implicit, cu doua carduri obligatorii', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('id="grandparent-type-field" style="display:none;'), 'campul trebuie ascuns implicit');
  assert.ok(html.includes('<div class="theme-card grandparent-type-card" data-grandparent="grandmother">'));
  assert.ok(html.includes('<div class="theme-card grandparent-type-card" data-grandparent="grandfather">'));
  assert.ok(html.includes('id="grandparentType"'));
  assert.ok(html.includes('id="err-grandparentType"'));
});

test('comanda.html: handler-ul generic de ocazii exclude .grandparent-type-card (evita bug-ul occasionInput.value = undefined)', () => {
  const html = read('public/comanda.html');
  assert.ok(
    html.includes("document.querySelectorAll('.theme-card:not(.grandparent-type-card)')"),
    'fara aceasta excludere, click pe "Pentru bunica"/"Pentru bunicul" ar seta occasionInput.value = undefined'
  );
});

test('comanda.html: validateStep(1) blocheaza continuarea pana la alegerea bunicii/bunicului', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("if (occasionVal === 'bunici') {"));
  assert.ok(html.includes("const grandparentTypeVal = document.getElementById('grandparentType').value;"));
  assert.ok(html.includes("if (!grandparentTypeVal) ok = false;"));
});

test('comanda.html: collectPayload trimite grandparentType catre server', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('grandparentType: grandparentTypeInput.value'));
});

test('comanda.html: saveDraft/restoreDraft persista grandparentType si re-afiseaza campul la restaurare', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('function saveDraft()');
  assert.ok(idx !== -1);
  const saveDraftSlice = html.slice(idx, idx + 800);
  assert.ok(saveDraftSlice.includes('grandparentType: grandparentTypeInput.value'));

  const restoreIdx = html.indexOf('function restoreDraft()');
  assert.ok(restoreIdx !== -1);
  const restoreSlice = html.slice(restoreIdx, restoreIdx + 2500);
  assert.ok(restoreSlice.includes('updateGrandparentTypeVisibility();'), 'trebuie apelata dupa restaurarea occasion, ca sa re-afiseze campul daca e "bunici"');
  assert.ok(restoreSlice.includes('if (draft.grandparentType) {'));
  assert.ok(restoreSlice.includes("grandparentTypeInput.value = draft.grandparentType;"));
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

test('comanda.html: label-urile de sub-alegere folosesc data-i18n, nu text hardcodat', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('data-i18n="label_grandparent_type"'));
  assert.ok(html.includes('data-i18n="grandparent_grandmother_name"'));
  assert.ok(html.includes('data-i18n="grandparent_grandfather_name"'));
});
