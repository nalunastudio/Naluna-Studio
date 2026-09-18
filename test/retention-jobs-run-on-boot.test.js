// AUDIT PRE-LAUNCH (2026-09-13, Faza A3 — retentie 30 zile): cele 3 joburi de curatare
// (purgeStaleSourceMedia, expireStaleFinalMedia, anonymizeStaleStories) porneau STRICT printr-un
// setInterval(24h) — daca serverul repornea mai des decat o data pe zi, prima curatare reala se
// putea amana nedefinit (timer-ul se reseteaza la fiecare pornire), desi Privacy Policy promite
// public "30 days from delivery". Adaugata o rulare IMEDIATA, o singura data la pornire, inainte
// de a porni fiecare timer periodic.
//
// ACTUALIZAT (2026-09-18, corectie ordine de boot — incident productie): cele 4 joburi (adaugat
// si purgeStaleFunnelEvents, al 4-lea job de retentie) nu mai pornesc la evaluarea de nivel-modul
// a fisierului — au fost mutate in interiorul db.initDb().then(() => {...}), ca sa nu mai poata
// ajunge la Postgres inaintea schemei (vezi test/boot-order-retention.test.js pentru verificarea
// completa a acestei garantii). Invarianta verificata AICI ramane aceeasi (apelul imediat direct
// inaintea propriului setInterval) — doar indentarea s-a schimbat (6 spatii, un nivel de nesting
// in plus fata de vechea pozitie cu 2 spatii).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

for (const fnName of ['purgeStaleSourceMedia', 'expireStaleFinalMedia', 'anonymizeStaleStories', 'purgeStaleFunnelEvents']) {
  test(`server.js: ${fnName}() ruleaza IMEDIAT la pornire (in interiorul db.initDb().then(...)), NU doar prin setInterval(24h)`, () => {
    const guardIdx = server.indexOf(`${fnName}().catch(() => {});\n      setInterval(() => { ${fnName}().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();`);
    assert.ok(guardIdx !== -1, `${fnName} trebuie sa fie apelata o data imediat, direct inaintea propriului setInterval — nu doar in interval`);
  });
}

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
