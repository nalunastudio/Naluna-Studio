// Adaugă un mesaj static, permanent vizibil, strict lângă selectorul de materiale al
// pachetului "Cadou video" — reutilizează designul existent (.memories-hint), fără să modifice
// uploadul, R2, CORS sau logica de selecție (neatinse in acest fisier de teste).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const PAGES = {
  'melodia-mea.html': read('public/melodia-mea.html'),
  'comanda-mea.html': read('public/comanda-mea.html'),
  'succes.html': read('public/succes.html')
};

const EXACT_RO_TEXT = 'După ce apeși bifa albastră, iPhone poate avea nevoie de puțin timp pentru a pregăti videoclipurile mari sau păstrate în iCloud. Nu apăsa din nou și nu închide fereastra — încărcarea începe automat.';

for (const [name, html] of Object.entries(PAGES)) {
  test(`${name}: mesajul nou e plasat STRICT langa #mem-file-input (imediat dupa el, inainte de orice alt element)`, () => {
    const inputIdx = html.indexOf('id="mem-file-input"');
    assert.notEqual(inputIdx, -1);
    const after = html.slice(inputIdx, inputIdx + 250);
    assert.ok(/memories_ios_wait_hint|memories-ios-wait-hint/.test(after), `mesajul trebuie sa apara imediat dupa selector in ${name}`);
  });

  test(`${name}: mesajul foloseste designul EXISTENT (.memories-hint), nicio clasa/stil noua`, () => {
    const inputIdx = html.indexOf('id="mem-file-input"');
    const after = html.slice(inputIdx, inputIdx + 250);
    assert.ok(after.includes('class="memories-hint"'));
  });

  test(`${name}: textul romana e exact cel cerut`, () => {
    assert.ok(html.includes(EXACT_RO_TEXT));
  });

  test(`${name}: cheia memories_ios_wait_hint exista in toate cele 8 limbi`, () => {
    const occurrences = (html.match(/memories_ios_wait_hint:/g) || []).length;
    assert.equal(occurrences, 8);
  });
}

// -------------------------------------------------------------------------------------------
// Uploadul direct catre R2, CORS-ul si logica de selectie (picker lock/change/cancel) raman
// STRICT neschimbate de aceasta corectie — verificare de regresie.
// -------------------------------------------------------------------------------------------
for (const [name, html] of Object.entries(PAGES)) {
  test(`${name}: uploadul multipart direct catre R2 ramane neschimbat`, () => {
    assert.ok(html.includes('async function startMultipartUpload(entry) {'));
    assert.ok(html.includes('function uploadOnePart('));
    assert.ok(html.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
  });

  test(`${name}: logica de blocare/deblocare a selectorului (picker lock) ramane neschimbata`, () => {
    assert.ok(html.includes('const PICKER_MANUAL_RECOVERY_MS = 5 * 60 * 1000;'));
    assert.ok(!html.includes('pickerLockTimeoutId'));
  });
}

test('storage.js: functiile multipart/CORS raman neschimbate', () => {
  const storage = read('storage.js');
  assert.ok(storage.includes('async function createPrivateMultipartUpload('));
  assert.ok(storage.includes('async function checkUploadCors('));
});

test('toate paginile raman sintactic valide dupa adaugarea mesajului', () => {
  for (const html of Object.values(PAGES)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  }
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  const server = read('server.js');
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
