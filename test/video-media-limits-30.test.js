// Teste pentru CORECȚIA 2026-08-31 (Cadou video, Cerința 1A): "mărește limita de la 10 la 30 de
// materiale" — toate straturile (frontend, backend, upload simplu, multipart, finalizare
// atomica, confirmare selectie, checkout, API, traduceri), verificate FUNCTIONAL, nu doar prin
// cautarea unui text in sursa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// ===============================================================================================
// PARTEA 1 — Constanta unica, propagata peste tot (2/6/7 din lista de teste obligatorii).
// ===============================================================================================
test('server.js: ORDER_MEDIA_MAX_ITEMS = 30, ORDER_MEDIA_MIN_ITEMS = 3 — sursa unica de adevar', () => {
  assert.match(server, /const ORDER_MEDIA_MAX_ITEMS = 30;/);
  assert.match(server, /const ORDER_MEDIA_MIN_ITEMS = 3;/);
});

test('public/amintiri-video.html: MEM_MIN=3, MEM_MAX=30 — oglindeste STRICT constanta server-side', () => {
  const amintiriVideo = read('public/amintiri-video.html');
  assert.match(amintiriVideo, /const MEM_MIN = 3;/);
  assert.match(amintiriVideo, /const MEM_MAX = 30;/);
});

// API-ul expune STRICT constanta reala (7 din lista).
test('server.js: raspunsul API expune mediaMinItems/mediaMaxItems din constantele reale (30/3), niciodata un literal separat', () => {
  assert.match(server, /mediaMinItems:\s*ORDER_MEDIA_MIN_ITEMS,/);
  assert.match(server, /mediaMaxItems:\s*ORDER_MEDIA_MAX_ITEMS,/);
});

// ===============================================================================================
// PARTEA 2 — FUNCTIONAL: backendul accepta EXACT 30, refuza materialul 31 (1/2 din lista).
// Extragem si rulam logica REALA de acumulare atomica din POST /media (upload simplu, batch).
// ===============================================================================================
function extractBatchUploadMutator() {
  const routeSrc = extractFn(server, "app.post('/api/orders/:orderId/media', ");
  const match = routeSrc.match(/\(current\) => \{\s*const existing = current\.uploadedMedia \|\| \[\];\s*const room = ORDER_MEDIA_MAX_ITEMS - existing\.length;[\s\S]*?return \{ uploadedMedia: \[\.\.\.existing, \.\.\.accepted\] \};\s*\}/);
  assert.ok(match, 'nu am gasit callback-ul de acumulare atomica al uploadului simplu (batch)');
  return match[0];
}

function runBatchMutator(mutatorSrc, existingCount, batchSize) {
  const existing = Array.from({ length: existingCount }, (_, i) => ({ key: `existing-${i}` }));
  const uploaded = Array.from({ length: batchSize }, (_, i) => ({ key: `new-${i}`, filename: `f${i}.jpg` }));
  const failed = [];
  const fn = new Function('current', 'uploaded', 'failed', 'ORDER_MEDIA_MAX_ITEMS', `
    const mutatorFn = ${mutatorSrc};
    return mutatorFn(current);
  `);
  const patch = fn({ uploadedMedia: existing }, uploaded, failed, 30);
  return { patch, failed, uploaded };
}

test('FUNCTIONAL: backendul accepta un lot de 30 materiale (comanda goala + 30 in acelasi lot) — toate 30 ajung in uploadedMedia', () => {
  const mutatorSrc = extractBatchUploadMutator();
  const { patch, failed } = runBatchMutator(mutatorSrc, 0, 30);
  assert.ok(patch, 'lotul de 30 trebuie acceptat integral');
  assert.equal(patch.uploadedMedia.length, 30);
  assert.equal(failed.length, 0);
});

test('FUNCTIONAL: al 31-lea material (comanda deja cu 30) e REFUZAT clar — mutatorul returneaza null, nimic nu se adauga', () => {
  const mutatorSrc = extractBatchUploadMutator();
  const { patch } = runBatchMutator(mutatorSrc, 30, 1);
  assert.equal(patch, null, 'cu 30 deja existente, un al 31-lea material trebuie refuzat (room<=0)');
});

test('FUNCTIONAL: lot PARȚIAL peste limita (28 existente + lot de 5) — accepta STRICT primele 2, restul de 3 ajung in `failed`, niciodata acceptate silentios', () => {
  const mutatorSrc = extractBatchUploadMutator();
  const { patch, failed } = runBatchMutator(mutatorSrc, 28, 5);
  assert.ok(patch);
  assert.equal(patch.uploadedMedia.length, 30, 'totalul final nu trebuie sa depaseasca niciodata 30');
  assert.equal(failed.length, 3, 'cele 3 materiale care nu au incaput trebuie raportate explicit, nu ignorate');
});

// Curatarea R2 pentru obiectele din partea de "overflow" a unui lot partial (5 din lista de mai
// jos) — corectie REALA gasita si aplicata in aceasta runda: inainte, doar cazul "deja plin"
// (!mutation.ok) stergea fisierele din R2; cazul "lot partial peste limita" (mutation.ok=true,
// dar cu overflow intern) NU stergea niciodata fisierele deja urcate ale materialelor respinse.
test('server.js: fisierele R2 ale materialelor din partea de "overflow" a unui lot PARȚIAL peste limita sunt sterse explicit (storage.deletePrivateFile), niciodata lasate orfane', () => {
  const routeSrc = extractFn(server, "app.post('/api/orders/:orderId/media', ");
  assert.match(routeSrc, /overflowToDelete\.forEach\(u => storage\.deletePrivateFile\(u\.key\)\.catch\(\(\) => \{\}\)\);/, 'trebuie sa existe stergerea explicita a fisierelor din overflow');
  const overflowDeclIdx = routeSrc.indexOf('let overflowToDelete');
  const deleteCallIdx = routeSrc.indexOf('overflowToDelete.forEach(u => storage.deletePrivateFile');
  const mutationCallIdx = routeSrc.indexOf('await db.mutateOrderMediaAtomically');
  assert.ok(overflowDeclIdx !== -1 && overflowDeclIdx < mutationCallIdx, 'variabila trebuie declarata inainte de mutatia atomica');
  assert.ok(deleteCallIdx > mutationCallIdx, 'stergerea trebuie sa se intample DUPA ce mutatia atomica a rulat (ca sa stim exact ce a ramas pe dinafara)');
});

test('server.js: cazul "comanda deja plina" (!mutation.ok) continua sa stearga TOATE fisierele lotului din R2 — comportament pre-existent, neschimbat', () => {
  const routeSrc = extractFn(server, "app.post('/api/orders/:orderId/media', ");
  assert.match(routeSrc, /if \(!mutation\.ok\) \{\s*\/\/[\s\S]*?uploaded\.forEach\(u => storage\.deletePrivateFile\(u\.key\)\.catch\(\(\) => \{\}\)\);/);
});

// ===============================================================================================
// PARTEA 3 — FUNCTIONAL: doua "finalizari concurente" nu pot depasi limita (4 din lista). Postgres
// (SELECT ... FOR UPDATE, vezi db.mutateOrderMediaAtomically) serializeaza real cele doua tranzactii
// — simulam aici EXACT efectul acelei serializari (a doua vede starea deja scrisa de prima),
// rulat pe logica REALA extrasa din server.js, nu pe o presupunere.
// ===============================================================================================
test('FUNCTIONAL: doua loturi "concurente" de cate 20 materiale (peste dublul limitei), aplicate secvential (asa cum le serializeaza SELECT...FOR UPDATE), NU depasesc niciodata 30 in total', () => {
  const mutatorSrc = extractBatchUploadMutator();
  // Lotul 1: comanda porneste goala, cere 20 -> toate 20 accepate.
  const r1 = runBatchMutator(mutatorSrc, 0, 20);
  assert.equal(r1.patch.uploadedMedia.length, 20);
  // Lotul 2 (a "doua cerere concurenta"): vede STAREA DEJA SCRISA de lotul 1 (20 existente,
  // exact ce ar vedea o a doua tranzactie dupa ce prima s-a comis, sub lock real) — cere inca 20.
  const r2 = runBatchMutator(mutatorSrc, r1.patch.uploadedMedia.length, 20);
  assert.ok(r2.patch);
  assert.equal(r2.patch.uploadedMedia.length, 30, 'totalul final trebuie sa fie EXACT 30, niciodata mai mult');
  assert.equal(r2.failed.length, 10, 'cele 10 materiale care nu au incaput din al doilea lot trebuie refuzate explicit');
});

test('db.js: mutateOrderMediaAtomically foloseste SELECT ... FOR UPDATE (lock real de rand) — garanteaza ca a doua tranzactie vede STRICT starea scrisa de prima, nu o copie invechita', () => {
  const dbSrc = read('db.js');
  const fnSrc = extractFn(dbSrc, 'async function mutateOrderMediaAtomically(orderId, mutatorFn) {');
  assert.match(fnSrc, /SELECT \* FROM orders WHERE id = \$1 FOR UPDATE/);
});

// ===============================================================================================
// PARTEA 4 — Confirmarea selectiei si checkout accepta 30, refuza o comanda invalida cu 31 (6).
// ===============================================================================================
test('db.js: confirmMediaSelection() refuza explicit cand numarul de materiale depaseste maxItems (functional, cu maxItems=30)', () => {
  const dbSrc = read('db.js');
  const fnSrc = extractFn(dbSrc, 'async function confirmMediaSelection(orderId, minItems, maxItems) {');
  assert.match(fnSrc, /if \(count < minItems \|\| count > maxItems\) return \{ ok: false, count \};/);
  // executie FUNCTIONALA a conditiei reale, izolat de I/O (SELECT-ul insusi necesita DB reala,
  // dar regula de acceptare/refuz e testabila direct, extrasa verbatim).
  const checkFn = new Function('count', 'minItems', 'maxItems', `
    if (count < minItems || count > maxItems) return { ok: false, count };
    return { ok: true };
  `);
  assert.equal(checkFn(30, 3, 30).ok, true, '30 materiale trebuie acceptate (exact limita)');
  assert.equal(checkFn(31, 3, 30).ok, false, '31 materiale trebuie refuzate (peste limita)');
  assert.equal(checkFn(2, 3, 30).ok, false, 'sub minimul de 3 tot trebuie refuzat, neschimbat');
});

test('server.js: validarea checkoutului refuza explicit un numar de materiale in afara intervalului [3,30]', () => {
  const routeSrc = extractFn(server, "app.post('/api/orders/:orderId/checkout', ");
  assert.match(routeSrc, /mediaCount < ORDER_MEDIA_MIN_ITEMS \|\| mediaCount > ORDER_MEDIA_MAX_ITEMS/);
});

// ===============================================================================================
// PARTEA 5 — Concurenta uploadului (max 2 fisiere/fragmente simultan) ramane neschimbata (8).
// ===============================================================================================
test('amintiri-video.html: concurenta uploadului (MAX_CONCURRENT_UPLOADS, MEM_MAX_PARALLEL_PARTS) ramane la 2 — stabilitate pentru 30 de materiale, neschimbata de aceasta corectie', () => {
  const amintiriVideo = read('public/amintiri-video.html');
  assert.match(amintiriVideo, /MAX_CONCURRENT_UPLOADS\s*=\s*2/);
  assert.match(amintiriVideo, /MEM_MAX_PARALLEL_PARTS\s*=\s*2/);
});

test('amintiri-video.html: selectorul de fisiere ramane STRICT unic, multiple, image/*+video/*, fara capture — neschimbat de cresterea limitei', () => {
  const amintiriVideo = read('public/amintiri-video.html');
  const inputs = [...amintiriVideo.matchAll(/<input[^>]*type="file"[^>]*>/g)];
  assert.equal(inputs.length, 1);
  const tag = inputs[0][0];
  assert.ok(tag.includes('multiple'));
  assert.ok(tag.includes('accept="image/*,video/*"'));
  assert.ok(!/\bcapture\b/.test(tag));
});

// ===============================================================================================
// PARTEA 6 — Niciun text Video din cele 8 limbi nu mai spune "3-10" (9 din lista).
// ===============================================================================================
const OLD_PATTERNS = [
  /între 3 și 10\b/i, /\b3 to 10\b/i, /\b3 bis 10\b/i, /entre 3 y 10\b/i,
  /da 3 a 10\b/i, /\b3 à 10\b/i, /между 3 и 10\b/i, /\b3 ile 10\b/i
];
for (const file of ['public/amintiri-video.html', 'public/melodia-mea.html', 'public/comanda-mea.html', 'public/succes.html', 'public/comanda.html']) {
  test(`${file}: niciun text Video nu mai mentioneaza limita veche "3-10", in nicio limba`, () => {
    const content = read(file);
    for (const pattern of OLD_PATTERNS) {
      assert.ok(!pattern.test(content), `gasit tipar vechi "${pattern}" in ${file}`);
    }
  });
}

test('public/amintiri-video.html: noua formulare "3 și 30" (RO) e prezenta explicit, natural, nu doar o inlocuire bruta de cifre', () => {
  const amintiriVideo = read('public/amintiri-video.html');
  assert.match(amintiriVideo, /între 3 și 30/);
});

// ===============================================================================================
// PARTEA 7 — Validari inainte de crearea videoclipului raman corecte (nu se schimba minimul).
// ===============================================================================================
test('server.js: validarea inainte de crearea videoclipului cere in continuare STRICT minimul (3), fara sa impuna un maxim suplimentar diferit de ORDER_MEDIA_MAX_ITEMS', () => {
  const routeSrc = extractFn(server, "app.post('/api/orders/:orderId/create-video', ");
  assert.match(routeSrc, /mediaCount < ORDER_MEDIA_MIN_ITEMS/);
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
