// Teste de regresie pentru formatRomanianDedication (hotfix 2026-08-08, "FINISAJ FINAL PACHET
// STANDARD") — EXECUTA efectiv logica reala (extrasa din melodia-mea.html si evaluata izolat
// via vm), nu doar verificari de text — cerinta explicita: teste pentru nume masculine,
// feminine, straine, compuse si cu cratima, cu rezultate EXACTE asteptate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFormatRomanianDedication() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/melodia-mea.html'), 'utf8');
  const startMarker = "const RO_MASCULINE_NAMES = new Set([";
  const endMarker = "\n  const T = {";
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker, startIdx);
  assert.ok(startIdx > -1 && endIdx > -1, 'nu am gasit blocul formatRomanianDedication in melodia-mea.html — a fost mutat/redenumit?');
  const code = html.slice(startIdx, endIdx) + '\nthis.formatRomanianDedication = formatRomanianDedication;';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.formatRomanianDedication;
}

const formatRomanianDedication = loadFormatRomanianDedication();

test('nume masculine: "Din partea lui X"', () => {
  assert.equal(formatRomanianDedication('Andrei'), 'Din partea lui Andrei');
  assert.equal(formatRomanianDedication('Mihai'), 'Din partea lui Mihai');
  assert.equal(formatRomanianDedication('Alexandru'), 'Din partea lui Alexandru');
  assert.equal(formatRomanianDedication('gheorghe'), 'Din partea lui gheorghe'); // case-insensitive lookup, litere originale pastrate
});

test('nume feminine din exemplele explicite ale clientului', () => {
  assert.equal(formatRomanianDedication('Maria'), 'Din partea Mariei');
  assert.equal(formatRomanianDedication('Andreea'), 'Din partea Andreei');
  assert.equal(formatRomanianDedication('Andreia'), 'Din partea Andreiei');
  assert.equal(formatRomanianDedication('Georgiana'), 'Din partea Georgianei');
  assert.equal(formatRomanianDedication('Karla'), 'Din partea Karlei');
  assert.equal(formatRomanianDedication('Jessica'), 'Din partea Jessicăi');
});

test('nume feminine comune, neincluse in cele 6 exemple, prin dictionar sau regula de rezerva', () => {
  assert.equal(formatRomanianDedication('Ana'), 'Din partea Anei');
  assert.equal(formatRomanianDedication('Elena'), 'Din partea Elenei');
  assert.equal(formatRomanianDedication('Diana'), 'Din partea Dianei');
  assert.equal(formatRomanianDedication('Monica'), 'Din partea Monicăi');
  assert.equal(formatRomanianDedication('Bianca'), 'Din partea Biancăi');
});

test('nume feminine NECUNOSCUTE (nu in dictionar) care se termina in "a" folosesc regula de rezerva', () => {
  // nu sunt in RO_FEMININE_GENITIVE, dar regula generala trebuie sa produca o forma plauzibila
  assert.equal(formatRomanianDedication('Renata'), 'Din partea Renatei');
  assert.equal(formatRomanianDedication('Petronela'.slice(0)), 'Din partea Petronelei');
});

test('nume straine/ambigue fara terminatie clara -> formulare neutra "Din partea: X"', () => {
  // formatRomanianDedication insusi returneaza null pentru acestea — fallback-ul neutru
  // (dedication: (s) => formatRomanianDedication(s) || `Din partea: ${s}`) e aplicat de apelant.
  // CORECȚIE (2026-08-24): fallback-ul era anterior "Cu drag, X" — gresit gramatical pentru
  // text compus nume+rol introdus la genitiv/dativ (ex. real, raportat live: "Cu drag,
  // Bunicului Andrei"). "Din partea: X" e o eticheta neutra, corecta indiferent de forma exacta.
  assert.equal(formatRomanianDedication('Kate'), null);
  assert.equal(formatRomanianDedication('Jennifer'), null);
  assert.equal(formatRomanianDedication('Alex Smith'), null); // spatiu -> ambiguu
});

test('nume compuse si cu cratima -> intotdeauna null (formulare neutra), niciodata flexiune ghicita', () => {
  assert.equal(formatRomanianDedication('Ana-Maria'), null);
  assert.equal(formatRomanianDedication('Maria-Elena'), null);
  assert.equal(formatRomanianDedication('Jean-Pierre'), null);
  assert.equal(formatRomanianDedication('Maria si Alexandra'), null); // continut multiplu introdus explicit (vezi comanda.html)
});

test('nume gol sau nedefinit -> null, fara eroare', () => {
  assert.equal(formatRomanianDedication(''), null);
  assert.equal(formatRomanianDedication('   '), null);
  assert.equal(formatRomanianDedication(undefined), null);
  assert.equal(formatRomanianDedication(null), null);
});

test('numele original NU e modificat de functie — doar textul afisat difera', () => {
  const original = 'Maria';
  const result = formatRomanianDedication(original);
  assert.equal(original, 'Maria', 'variabila de intrare trebuie sa ramana neschimbata');
  assert.ok(result.includes('Mariei'), 'doar rezultatul returnat contine forma flexionata');
});

test('melodia-mea.html: dedication (RO) foloseste helper-ul + fallback neutru; celelalte 7 limbi raman simple, neschimbate', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/melodia-mea.html'), 'utf8');
  assert.ok(
    html.includes('dedication: (s) => formatRomanianDedication(s) || `Din partea: ${s}`,'),
    'RO trebuie sa foloseasca helper-ul gramatical, cu fallback neutru "Din partea: X" (niciodata "Cu drag, X", gresit gramatical pentru text la genitiv/dativ)'
  );
  assert.ok(!html.includes('formatRomanianDedication(s) || `Cu drag,'), 'fallback-ul vechi, gresit gramatical, nu mai trebuie sa existe');
  // celelalte 7 limbi raman EXACT formularea lor simpla dinainte — nicio regula romaneasca
  // nu trebuie sa se fi scurs in alta limba.
  assert.ok(html.includes('dedication: (s) => `From ${s}`,'), 'EN neschimbat');
  assert.ok(html.includes('dedication: (s) => `Von ${s}`,'), 'DE neschimbat');
  assert.ok(html.includes('dedication: (s) => `De parte de ${s}`,'), 'ES neschimbat');
  assert.ok(html.includes('dedication: (s) => `Da parte di ${s}`,'), 'IT neschimbat');
  assert.ok(html.includes('dedication: (s) => `De la part de ${s}`,'), 'FR neschimbat');
  assert.ok(html.includes('dedication: (s) => `От ${s}`,'), 'BG neschimbat');
  assert.ok(html.includes('dedication: (s) => `${s} tarafından`,'), 'TR neschimbat');
});
