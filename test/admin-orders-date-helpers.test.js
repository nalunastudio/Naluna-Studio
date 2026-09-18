// Admin /admin/orders — helper-e de data client-side (2026-09-18, Funnel Analytics FAZA 2).
// private/admin/orders.js ruleaza STRICT in browser (foloseste `document` la nivelul de sus al
// fisierului) — nu poate fi require()-uit direct in Node. Extragem TEXTUAL doar functiile pure de
// calendar (acelasi tipar ca test/analytics-client.test.js) si le executam intr-un sandbox minimal,
// fara DOM. Acest test exista special ca sa prinda exact clasa de bug gasita manual in aceasta
// sesiune (toDateStr(addDaysLocal(...)) — dublă înfășurare a unui string deja formatat, care ar
// fi aruncat o eroare la incarcarea paginii /admin/orders).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');

function extractHelpers() {
  const fnNames = ['pad2', 'toDateStr', 'addDaysLocal', 'isoMondayOfLocal', 'formatDateShort'];
  const pieces = fnNames.map((name) => {
    const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
    const match = src.match(re);
    assert.ok(match, `functia ${name} lipseste sau s-a schimbat structural in orders.js`);
    return match[0];
  });
  const monthMatch = src.match(/const MONTH_SHORT_RO = \[[\s\S]*?\];/);
  assert.ok(monthMatch);
  const wrapperSrc = `(function () {\n${monthMatch[0]}\n${pieces.join('\n')}\nreturn { pad2, toDateStr, addDaysLocal, isoMondayOfLocal, formatDateShort };\n})`;
  return new Function('return ' + wrapperSrc)()();
}

test('toDateStr: formateaza un obiect Date real ca YYYY-MM-DD', () => {
  const h = extractHelpers();
  assert.equal(h.toDateStr(new Date(2026, 8, 5)), '2026-09-05'); // luna 8 (0-indexat) = Septembrie
});

test('addDaysLocal: returneaza STRICT un string (nu un obiect Date) — regresie directa pentru bug-ul gasit (dubla infasurare toDateStr(addDaysLocal(...)))', () => {
  const h = extractHelpers();
  const result = h.addDaysLocal('2026-09-18', -6);
  assert.equal(typeof result, 'string');
  assert.equal(result, '2026-09-12');
  // apelarea toDateStr PE REZULTATUL lui addDaysLocal (bug-ul real) trebuie sa arunce, ca sa
  // documenteze explicit de ce combinatia era gresita — confirmam ca .getFullYear nu exista pe un string.
  assert.throws(() => h.toDateStr(result), TypeError);
});

test('addDaysLocal: trece corect granita de luna/an (regresie in ambele directii)', () => {
  const h = extractHelpers();
  assert.equal(h.addDaysLocal('2026-01-03', -6), '2025-12-28');
  assert.equal(h.addDaysLocal('2026-12-28', 6), '2027-01-03');
});

test('isoMondayOfLocal: coerenta cu resolvePeriodBounds din lib/funnel-period.js pentru aceeasi saptamana', () => {
  const h = extractHelpers();
  assert.equal(h.isoMondayOfLocal('2026-09-18'), '2026-09-14');
  assert.equal(h.isoMondayOfLocal('2026-09-14'), '2026-09-14');
  assert.equal(h.isoMondayOfLocal('2026-09-20'), '2026-09-14'); // Duminica -> Lunea din ACEEASI saptamana
});

test('formatDateShort: format scurt, lizibil, stabil', () => {
  const h = extractHelpers();
  assert.equal(h.formatDateShort('2026-09-05'), '5 Sep 2026');
});
