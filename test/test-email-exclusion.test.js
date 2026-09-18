// EXCLUDERE COMENZI DE TEST (2026-09-18, Funnel Analytics FAZA 2) — teste REALE (nu doar
// statice) pentru mecanismul ANALYTICS_EXCLUDED_EMAILS/isTestCustomerEmail din server.js. Extrage
// textul EXACT al celor doua definitii (acelasi tipar de extragere folosit deja in acest repo —
// vezi test/analytics-client.test.js) si il executa intr-un sandbox cu process.env controlat,
// pentru comportament REAL verificat, nu doar prezenta textului in sursa.
//
// CERINTA EXPLICITA a utilizatorului: comparatie EXACTA (case-insensitive), NICIODATA
// pattern/domeniu — o adresa QA care doar "pare" de test (ex. qa-x@example.invalid, x@test.com)
// NU trebuie exclusa automat doar pentru ca "seamana"; trebuie adaugata explicit in variabila.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function buildExclusionModule(envValue) {
  const match = serverSrc.match(/const ANALYTICS_EXCLUDED_EMAILS = \(process\.env\.ANALYTICS_EXCLUDED_EMAILS \|\| ''\)[\s\S]*?\nfunction isTestCustomerEmail\(email\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'blocul ANALYTICS_EXCLUDED_EMAILS + isTestCustomerEmail trebuie sa existe in server.js, neschimbat structural');
  const wrapperSrc = `(function (process) {\n${match[0]}\nreturn { ANALYTICS_EXCLUDED_EMAILS, isTestCustomerEmail };\n})`;
  const factory = new Function('return ' + wrapperSrc)();
  return factory({ env: { ANALYTICS_EXCLUDED_EMAILS: envValue } });
}

test('cele 3 adrese cerute explicit sunt excluse cand sunt configurate exact asa in variabila de mediu', () => {
  const mod = buildExclusionModule('nataliaandoni@yahoo.com,ciortancosmin6@gmail.com,marianataliaandoni@gmail.com');
  assert.equal(mod.isTestCustomerEmail('nataliaandoni@yahoo.com'), true);
  assert.equal(mod.isTestCustomerEmail('ciortancosmin6@gmail.com'), true);
  assert.equal(mod.isTestCustomerEmail('marianataliaandoni@gmail.com'), true);
});

test('comparatie case-insensitive: majuscule/minuscule amestecate tot se potrivesc', () => {
  const mod = buildExclusionModule('Natalia@Yahoo.com');
  assert.equal(mod.isTestCustomerEmail('natalia@yahoo.com'), true);
  assert.equal(mod.isTestCustomerEmail('NATALIA@YAHOO.COM'), true);
});

test('spatii in jurul virgulei din variabila de mediu sunt eliminate (trim)', () => {
  const mod = buildExclusionModule('  a@test.com , b@test.com  ');
  assert.deepEqual(mod.ANALYTICS_EXCLUDED_EMAILS, ['a@test.com', 'b@test.com']);
});

test('variabila LIPSA -> nicio eroare, nicio excludere (comportament identic cu "toate comenzile sunt reale")', () => {
  const mod = buildExclusionModule(undefined);
  assert.deepEqual(mod.ANALYTICS_EXCLUDED_EMAILS, []);
  assert.equal(mod.isTestCustomerEmail('oricine@exemplu.com'), false);
  assert.equal(mod.isTestCustomerEmail(''), false);
  assert.equal(mod.isTestCustomerEmail(null), false);
  assert.equal(mod.isTestCustomerEmail(undefined), false);
});

test('CRITIC — o adresa care "seamana" cu un email de test (pattern qa-*/*@test.com) NU e exclusa automat, NICIODATA prin ghicire de pattern/domeniu — doar comparatie exacta cu lista configurata', () => {
  const mod = buildExclusionModule('nataliaandoni@yahoo.com,ciortancosmin6@gmail.com,marianataliaandoni@gmail.com');
  assert.equal(mod.isTestCustomerEmail('qa-oricine@example.invalid'), false);
  assert.equal(mod.isTestCustomerEmail('cineva@test.com'), false);
  assert.equal(mod.isTestCustomerEmail('test@test.com'), false);
  assert.equal(mod.isTestCustomerEmail('natalia.andoni@yahoo.com'), false, 'un email DIFERIT, chiar similar, nu trebuie sa se potriveasca');
});

test('o singura adresa configurata (fara virgula) functioneaza identic', () => {
  const mod = buildExclusionModule('solo@test.com');
  assert.deepEqual(mod.ANALYTICS_EXCLUDED_EMAILS, ['solo@test.com']);
  assert.equal(mod.isTestCustomerEmail('solo@test.com'), true);
});

test('string gol in variabila de mediu -> echivalent cu lipsa (niciun element in lista, filter(Boolean) elimina string-uri goale)', () => {
  const mod = buildExclusionModule('');
  assert.deepEqual(mod.ANALYTICS_EXCLUDED_EMAILS, []);
});
