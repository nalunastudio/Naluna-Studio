// FORMULAR SPECIAL "PENTRU MINE" (2026-10-12) — validarea server-side (POST /api/orders) si
// schema DB (db.js). Acelasi tipar de verificare prin pattern-matching pe sursa, deja folosit de
// test/order-validation-i18n.test.js (nu exista o baza de date reala in acest mediu de teste —
// vezi comentariul din acel fisier).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function ordersHandlerBody() {
  const idx = server.indexOf("app.post('/api/orders', orderCreationLimiter");
  const end = server.indexOf("app.post('/api/orders/:orderId/generate'");
  assert.ok(idx !== -1 && end !== -1 && end > idx);
  return server.slice(idx, end);
}

// ===================================================================================================
// 1) senderName/relationship devin OPTIONALE STRICT pentru occasion==='pentru-mine' — pentru orice
//    alta ocazie, validarea ramane NESCHIMBATA (ambele raman obligatorii).
// ===================================================================================================
test('POST /api/orders: senderName/relationship sunt OPTIONALE STRICT pentru occasion===\'pentru-mine\' (isSelfSong), neschimbate pentru restul ocaziilor', () => {
  const body = ordersHandlerBody();
  assert.match(body, /const isSelfSong = occasion === 'pentru-mine';/);
  assert.match(body, /if \(!isSelfSong\) \{\s*\n\s*if \(!isValidString\(senderName, 1, 100\)\)/);
  assert.match(body, /if \(!isValidString\(relationship, 1, 60\)\)/);
});

// ===================================================================================================
// 2) selfTheme — OBLIGATORIU si validat impotriva SELF_THEME_VALUES STRICT pentru 'pentru-mine'.
// ===================================================================================================
test('POST /api/orders: selfTheme e validat impotriva SELF_THEME_VALUES, OBLIGATORIU STRICT pentru pentru-mine', () => {
  const body = ordersHandlerBody();
  assert.match(body, /const safeSelfTheme = isSelfSong && SELF_THEME_VALUES\.includes\(selfTheme\) \? selfTheme : null;/);
  assert.match(body, /if \(isSelfSong && !safeSelfTheme\)/);
});

test('SELF_THEME_VALUES contine EXACT cele 5 teme cerute explicit, niciuna in plus/lipsa', () => {
  const idx = server.indexOf('const SELF_THEME_VALUES = [');
  assert.ok(idx !== -1);
  const end = server.indexOf(';', idx);
  const arr = new Function(`${server.slice(idx, end + 1)}\nreturn SELF_THEME_VALUES;`)();
  assert.deepEqual(arr, ['putere-motivatie', 'perioada-grea', 'reusita', 'dor-iubire', 'povestea-vietii']);
});

// ===================================================================================================
// 3) includeNameInSong — STRICT boolean, OBLIGATORIU pentru 'pentru-mine' (niciodata presupus).
// ===================================================================================================
test('POST /api/orders: includeNameInSong e STRICT boolean, OBLIGATORIU pentru pentru-mine, niciodata presupus', () => {
  const body = ordersHandlerBody();
  assert.match(body, /const safeIncludeNameInSong = isSelfSong \? \(includeNameInSong === true \|\| includeNameInSong === false \? includeNameInSong : null\) : null;/);
  assert.match(body, /if \(isSelfSong && safeIncludeNameInSong === null\)/);
});

// ===================================================================================================
// 4) recipient ramane OBLIGATORIU (neschimbat) — campul "Cum te cheama?" e reutilizat ca atare.
// ===================================================================================================
test('POST /api/orders: recipient ramane OBLIGATORIU neschimbat (reutilizat pentru "Cum te cheama?")', () => {
  const body = ordersHandlerBody();
  assert.match(body, /if \(!isValidString\(recipient, 1, 60\)\)/);
});

// ===================================================================================================
// 5) senderName/relationship trimise la db.createOrder raman null pentru isSelfSong — niciodata
//    '.trim()' pe o valoare care poate fi absenta (ar arunca TypeError).
// ===================================================================================================
test('POST /api/orders: senderName/relationship trimise la db.createOrder raman null pentru isSelfSong (niciun .trim() pe valoare absenta)', () => {
  const body = ordersHandlerBody();
  assert.match(body, /senderName: isSelfSong \? null : senderName\.trim\(\),/);
  assert.match(body, /relationship: isSelfSong \? null : relationship\.trim\(\),/);
});

// ===================================================================================================
// 6) selfTheme/includeNameInSong ajung in obiectul trimis la db.createOrder.
// ===================================================================================================
test('POST /api/orders: selfTheme/includeNameInSong ajung la db.createOrder', () => {
  const body = ordersHandlerBody();
  assert.match(body, /selfTheme: safeSelfTheme,/);
  assert.match(body, /includeNameInSong: safeIncludeNameInSong/);
});

// ===================================================================================================
// 7) MISSING_FIELD_MESSAGES.selfTheme / .includeNameInSong — traduceri REALE in toate cele 8 limbi,
//    toate distincte (nicio limba pe fallback accidental).
// ===================================================================================================
for (const key of ['selfTheme', 'includeNameInSong']) {
  test(`MISSING_FIELD_MESSAGES.${key}: traducere reala in toate cele 8 limbi, toate distincte`, () => {
    const idx = server.indexOf('const MISSING_FIELD_MESSAGES = {');
    assert.ok(idx !== -1);
    const end = server.indexOf('\n};', idx) + 3;
    const map = new Function(`${server.slice(idx, end)}\nreturn MISSING_FIELD_MESSAGES;`)();
    assert.ok(map[key], `${key} trebuie sa existe in MISSING_FIELD_MESSAGES`);
    for (const lang of ALLOWED_LANGS) {
      assert.ok(typeof map[key][lang] === 'string' && map[key][lang].length > 3, `${key}.${lang} trebuie sa existe si sa fie un text real`);
    }
    const uniqueValues = new Set(Object.values(map[key]));
    assert.equal(uniqueValues.size, ALLOWED_LANGS.length, `${key}: toate cele 8 traduceri trebuie sa fie distincte`);
  });
}

// ===================================================================================================
// 8) db.js: coloanele noi (self_theme/include_name_in_song) exista in migrare, createOrder, si
//    rowToOrder — acelasi tipar ca restul campurilor opționale (null pentru comenzi vechi).
// ===================================================================================================
test('db.js: migrarea ALTER TABLE adauga self_theme (TEXT) si include_name_in_song (BOOLEAN)', () => {
  assert.match(dbSrc, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS self_theme TEXT;/);
  assert.match(dbSrc, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS include_name_in_song BOOLEAN;/);
});

test('db.js: createOrder() insereaza self_theme/include_name_in_song (49 de parametri, $48/$49)', () => {
  assert.match(dbSrc, /self_theme, include_name_in_song\)/);
  assert.match(dbSrc, /\$48,\$49\)/);
  assert.match(dbSrc, /order\.selfTheme \|\| null,/);
  assert.match(dbSrc, /order\.includeNameInSong === null \|\| order\.includeNameInSong === undefined \? null : order\.includeNameInSong === true/);
});

test('db.js: rowToOrder() expune selfTheme/includeNameInSong (null pentru comenzi vechi, boolean pastrat corect pentru includeNameInSong)', () => {
  assert.match(dbSrc, /selfTheme: row\.self_theme \|\| null,/);
  assert.match(dbSrc, /includeNameInSong: row\.include_name_in_song === null \|\| row\.include_name_in_song === undefined\s*\n\s*\? null\s*\n\s*: !!row\.include_name_in_song,/);
});

test('node --check server.js / db.js trec (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
