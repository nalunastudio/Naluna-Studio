// AUDIT PRE-LAUNCH (2026-09-13, Faza D1 — "toate cele 8 limbi", validare live): POST /api/orders
// avea deja safeLang/missingFieldMessage/invalidPhoneMessage pentru majoritatea erorilor din
// acelasi bloc de validare, dar 4 verificari ramasesera cu mesaje hardcodate STRICT in romana
// (ocazie, ocazie melodia 2, email, pachet) — confirmat live: un client care completeaza
// comanda in orice alta limba si declanseaza una dintre aceste erori primea mesajul in romana.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

for (const mapName of ['INVALID_OCCASION_MESSAGES', 'INVALID_OCCASION2_MESSAGES', 'INVALID_EMAIL_MESSAGES', 'INVALID_PLAN_MESSAGES']) {
  test(`server.js: ${mapName} contine cate o traducere pentru fiecare din cele 8 limbi, toate distincte de varianta romana (nicio limba nu ramane pe fallback englez/roman accidental)`, () => {
    const idx = server.indexOf(`const ${mapName} = {`);
    assert.ok(idx !== -1, `${mapName} trebuie sa existe`);
    const end = server.indexOf('};', idx) + 2;
    const mapSrc = server.slice(idx, end);
    const map = new Function(mapSrc + `\nreturn ${mapName};`)();
    for (const lang of ALLOWED_LANGS) {
      assert.ok(typeof map[lang] === 'string' && map[lang].length > 3, `${mapName}.${lang} trebuie sa existe si sa fie un text real`);
    }
    const uniqueValues = new Set(Object.values(map));
    assert.equal(uniqueValues.size, ALLOWED_LANGS.length, `${mapName}: toate cele 8 traduceri trebuie sa fie distincte (nicio limba nu ramane pe fallback-ul altei limbi)`);
  });
}

test('server.js: cele 4 verificari de validare (ocazie, ocazie melodia 2, email, pachet) folosesc acum functiile localizate, NU mai returneaza text hardcodat in romana', () => {
  const idx = server.indexOf("app.post('/api/orders', orderCreationLimiter");
  const end = server.indexOf("app.post('/api/orders/:orderId/generate'");
  const body = server.slice(idx, end);
  assert.ok(!/error: 'Ocazie invalidă\.'/.test(body), 'ocazia nu mai trebuie sa foloseasca textul hardcodat');
  assert.ok(!/error: 'Ocazie invalidă pentru a doua melodie\.'/.test(body), 'ocazia melodiei 2 nu mai trebuie sa foloseasca textul hardcodat');
  assert.ok(!/error: 'Adresa de email nu este validă\.'/.test(body), 'email-ul nu mai trebuie sa foloseasca textul hardcodat');
  assert.ok(!/error: 'Gen muzical invalid\.'/.test(body), 'genul nu mai trebuie sa foloseasca textul hardcodat (trebuie sa refoloseasca invalidGenreMessage, deja existent)');
  assert.ok(!/error: 'Pachet invalid\.'/.test(body), 'pachetul nu mai trebuie sa foloseasca textul hardcodat');
  assert.match(body, /error: invalidOccasionMessage\(safeLang\)/);
  assert.match(body, /error: invalidOccasion2Message\(safeLang\)/);
  assert.match(body, /error: invalidEmailMessage\(safeLang\)/);
  assert.match(body, /error: invalidGenreMessage\(safeLang\)/);
  assert.match(body, /error: invalidPlanMessage\(safeLang\)/);
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
