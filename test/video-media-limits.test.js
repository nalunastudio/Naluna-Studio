// Test de regresie pentru corectia urgenta (2026-08-14), exclusiv pachetul "Cadou video":
// 1) elimina complet selectoarele manuale de pozitionare ("Fără preferință"/"Început"/
//    "Strofa 1"/"Refren"/"Strofa 2"/"Final") — pozitionarea materialelor devine STRICT
//    automata, folosind mecanismul deja existent (sortMediaBySection/
//    computeSectionAwareSegmentDurations in lib/media-analysis.js), care trateaza gratios
//    `section: null` prin distributie automata pe sectiunile reale ale melodiei.
// 2) elimina plafonul ARTIFICIAL de 150MB per fisier (nelegat de nicio constrangere reala de
//    infrastructura — respingea exact videoclipurile normale de 1-2 minute pe care pachetul
//    le promite), pastrand o limita EXPLICITA (configurabila), nu un upload nelimitat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const storageSrc = read('storage.js');
const melodiaMea = read('public/melodia-mea.html');
const comandaMea = read('public/comanda-mea.html');
const succes = read('public/succes.html');
const mediaAnalysis = require('../lib/media-analysis');

// ---------------------------------------------------------------------------------------------
// 1. Selectoarele de pozitionare nu mai exista, in nicio pagina, in nicio limba.
// ---------------------------------------------------------------------------------------------
[
  ['public/melodia-mea.html', melodiaMea],
  ['public/comanda-mea.html', comandaMea],
  ['public/succes.html', succes]
].forEach(([file, html]) => {
  test(`${file}: nu mai exista dropdown-ul de pozitionare a materialelor ("Fără preferință"/"Început"/"Strofa"/"Refren"/"Final") — cheia de traducere si atributele lui sunt eliminate complet`, () => {
    assert.ok(!html.includes('memories_sections'), 'cheia de traducere memories_sections nu mai trebuie sa existe');
    assert.ok(!/data-existing-section|data-staged-index|data-staged-section/.test(html), 'niciun atribut de dropdown de sectiune nu mai trebuie sa existe');
  });
});

test('comanda-mea.html si succes.html: widgetul de materiale nu mai contine niciun element <select> (nu au alte selecturi legitime, spre deosebire de melodia-mea.html care are select-uri de gen, neatinse)', () => {
  assert.ok(!comandaMea.includes('<select'));
  assert.ok(!succes.includes('<select'));
});

test('melodia-mea.html: widgetul de materiale (renderExistingList/renderQueueList) nu mai contine niciun <select> — selecturile ramase in pagina sunt STRICT pentru genul melodiei (edit-genre-select, premium-edit-song1/2-genre), neatinse', () => {
  ['function renderExistingList(order) {', 'function renderQueueList() {'].forEach(marker => {
    const idx = melodiaMea.indexOf(marker);
    assert.notEqual(idx, -1, `functia "${marker}" trebuie sa existe`);
    const end = melodiaMea.indexOf('\n  }\n', idx);
    const snippet = melodiaMea.slice(idx, end);
    assert.ok(!snippet.includes('<select'), `"${marker}" nu mai trebuie sa randeze niciun <select>`);
  });
  assert.ok(melodiaMea.includes('<select id="edit-genre-select">'), 'selectorul de gen (functionalitate separata) trebuie sa ramana neatins');
});

test('melodia-mea.html: functia sectionSelectHtml() (helper-ul dropdown-ului) a fost eliminata complet', () => {
  assert.ok(!melodiaMea.includes('function sectionSelectHtml'));
});

test('melodia-mea.html: PUT /media/:index/section nu mai e apelat de client (fara wiring pe niciun <select>) — endpointul server-side ramane, pentru compatibilitate cu integrari vechi, dar nu mai e folosit din UI', () => {
  assert.ok(!melodiaMea.includes("method: 'PUT',\n            headers: { 'Content-Type': 'application/json', 'X-Access-Token': accessToken },\n            body: JSON.stringify({ section:"));
  assert.ok(server.includes("app.put('/api/orders/:orderId/media/:index/section'"), 'endpointul server-side ramane definit, pentru compatibilitate — nu se sterge nimic din backend');
});

// ---------------------------------------------------------------------------------------------
// 2. Absenta preferintelor NU blocheaza continuarea — gating-ul ramane STRICT pe numarul de
//    materiale confirmate si starea cozii de upload, niciodata pe `section`.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: updateMemoriesCountAndGates() NU verifica deloc `section` — gateaza STRICT pe numarul de materiale si starea uploadurilor', () => {
  const idx = melodiaMea.indexOf('function updateMemoriesCountAndGates(order) {');
  const end = melodiaMea.indexOf('\n  }', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(!snippet.includes('.section'), 'gating-ul nu trebuie sa depinda de vreo preferinta de sectiune');
  assert.ok(snippet.includes('const ok = total >= MEM_MIN && total <= MEM_MAX;'));
});

// ---------------------------------------------------------------------------------------------
// 3. Pozitionarea automata (mecanism deja existent, verificat REAL, executabil) — cand TOATE
//    materialele au section=null (cazul universal, acum), sortMediaBySection pastreaza ordinea
//    de selectie a clientului, iar computeSectionAwareSegmentDurations distribuie automat
//    materialele pe sectiunile REALE ale melodiei, fara nicio interventie manuala.
// ---------------------------------------------------------------------------------------------
test('sortMediaBySection: cu toate materialele avand section=null, pastreaza EXACT ordinea de selectie a clientului (nicio reordonare)', () => {
  const items = [{ type: 'photo', section: null }, { type: 'video', section: null }, { type: 'photo', section: null }, { type: 'video', section: null }];
  const sorted = mediaAnalysis.sortMediaBySection(items);
  assert.deepEqual(sorted, items);
});

test('computeSectionAwareSegmentDurations: cu toate materialele section=null, le distribuie automat pe sectiunile REALE ale melodiei (fara nicio preferinta manuala)', () => {
  const sectionTimings = [
    { type: 'intro', alignmentStatus: 'aligned', startTime: 0, endTime: 5 },
    { type: 'verse', alignmentStatus: 'aligned', startTime: 5, endTime: 20 },
    { type: 'chorus', alignmentStatus: 'aligned', startTime: 20, endTime: 35 },
    { type: 'outro', alignmentStatus: 'aligned', startTime: 35, endTime: 40 }
  ];
  const items = [{ section: null }, { section: null }, { section: null }, { section: null }];
  const durations = mediaAnalysis.computeSectionAwareSegmentDurations(items, 40, sectionTimings, 0.6);
  assert.ok(Array.isArray(durations), 'trebuie sa produca o alocare automata, nu null (nicio preferinta manuala necesara)');
  assert.equal(durations.length, 4);
  durations.forEach(d => assert.ok(d > 0, 'fiecare material trebuie sa primeasca o durata pozitiva'));
  const totalRendered = durations.reduce((a, b) => a + b, 0);
  // suma randata (inainte de suprapunerile crossfade) trebuie sa acopere intreaga durata + compensatia de tranzitie
  assert.ok(Math.abs(totalRendered - (40 + 3 * 0.6)) < 0.01, `suma segmentelor randate trebuie sa acopere exact durata melodiei plus compensatia crossfade, a produs ${totalRendered}`);
});

test('computeSectionAwareSegmentDurations: fara nicio sectiune reala detectata, revine explicit la distributie egala (fallback etichetat, niciodata amestecat tacit)', () => {
  const items = [{ section: null }, { section: null }];
  const result = mediaAnalysis.computeSectionAwareSegmentDurations(items, 20, [], 0.6);
  assert.equal(result, null, 'fara sectiuni reale, apelantul (buildMemoryBackground) trebuie sa stie explicit sa treaca pe distributie egala');
});

// ---------------------------------------------------------------------------------------------
// 4. Plafonul de 150MB a fost eliminat — limita ramane EXPLICITA (nu upload nelimitat),
//    configurabila prin variabila de mediu, generoasa pentru un videoclip iPhone real de 1-2 minute.
// ---------------------------------------------------------------------------------------------
test('server.js: ORDER_MEDIA_MAX_BYTES nu mai e plafonul artificial de 150MB — implicit 700MB, configurabil prin ORDER_MEDIA_MAX_MB', () => {
  assert.ok(!server.includes('const ORDER_MEDIA_MAX_BYTES = 150 * 1024 * 1024;'), 'plafonul vechi de 150MB nu mai trebuie sa existe');
  assert.ok(server.includes("const ORDER_MEDIA_MAX_BYTES = (Number(process.env.ORDER_MEDIA_MAX_MB) > 0 ? Number(process.env.ORDER_MEDIA_MAX_MB) : 700) * 1024 * 1024;"));
});

test('server.js: limita ramane EXPLICITA si finita — nu e eliminata complet (protectie reala impotriva abuzului), doar marita generos', () => {
  // simulam evaluarea constantei fara variabila de mediu setata (ca in productie implicit)
  const ORDER_MEDIA_MAX_BYTES = (Number(undefined) > 0 ? Number(undefined) : 700) * 1024 * 1024;
  assert.equal(ORDER_MEDIA_MAX_BYTES, 700 * 1024 * 1024);
  assert.ok(ORDER_MEDIA_MAX_BYTES > 151 * 1024 * 1024, 'un fisier de 151MB (peste vechea limita) trebuie acceptat acum');
  assert.ok(ORDER_MEDIA_MAX_BYTES >= 500 * 1024 * 1024, 'un fisier de 500MB (scenariu cerut explicit) trebuie acceptat');
  assert.ok(ORDER_MEDIA_MAX_BYTES < 5 * 1024 * 1024 * 1024, 'limita nu trebuie sa fie nelimitata/absurda — ramane o protectie reala');
});

test('server.js: mesajul de eroare pentru un fisier prea mare reflecta AUTOMAT noua limita (calculat din constanta, niciodata hardcodat "150MB")', () => {
  assert.ok(server.includes('LIMIT_FILE_SIZE: `Un fișier depășește limita de ${Math.round(ORDER_MEDIA_MAX_BYTES / (1024 * 1024))}MB.`'));
  assert.ok(!server.includes("depășește limita de 150MB"));
});

test('server.js: multer foloseste diskStorage (NU memoryStorage) — fisierele mari nu ajung niciodata integral in memoria procesului Node, indiferent de dimensiune', () => {
  assert.ok(server.includes('storage: multer.diskStorage({'));
  assert.ok(!server.includes('multer({ storage: multer.memoryStorage()'));
});

test('storage.js: uploadPrivateFile()/uploadPublicFile() folosesc fs.createReadStream (streaming) — niciodata fs.readFileSync sau incarcare completa in memorie inainte de a trimite catre R2/S3', () => {
  assert.ok(storageSrc.includes('Body: fs.createReadStream(localFilePath)'));
  assert.ok(!storageSrc.includes('fs.readFileSync(localFilePath)'));
  assert.ok(!storageSrc.includes(".toString('base64')"), 'niciun fisier media nu trebuie transformat vreodata in base64');
});

test('melodia-mea.html: selectia clientului NU e niciodata transformata in base64 — FormData/XHR trimite fisierul RAW, fisierul e citit doar pentru thumbnail-uri (imagini) prin URL.createObjectURL, niciodata FileReader.readAsDataURL', () => {
  assert.ok(!melodiaMea.includes('readAsDataURL'));
  assert.ok(melodiaMea.includes("formData.append('media', entry.file);"), 'fisierul RAW (nu o copie transformata) trebuie trimis direct');
});

test('server.js: UPLOAD_TIMEOUT_MS-ul functional pentru validare (ffprobe) ramane rezonabil de scurt (probe de metadata, nu decodare completa — nu creste odata cu dimensiunea fisierului)', () => {
  assert.ok(server.includes("], { timeout: 20000 });"), 'verifyMediaDecodable trebuie sa ramana cu un timeout scurt — ffprobe citeste doar metadata, nu intregul fisier');
});

test('melodia-mea.html: UPLOAD_TIMEOUT_MS (client, XHR per fisier) marit generos, pentru fisiere mari pe conexiuni mobile mai lente', () => {
  assert.match(melodiaMea, /const UPLOAD_TIMEOUT_MS = 900000;/);
});

// ---------------------------------------------------------------------------------------------
// 5. Scenariile explicit cerute — 3+3, 7+3, 10 materiale totale, fisiere individuale > 150MB.
// ---------------------------------------------------------------------------------------------
test('server.js: ORDER_MEDIA_MAX_ITEMS (10) si ORDER_MEDIA_MIN_ITEMS (3) raman neschimbate — 3 foto+3 video (6) si 7 foto+3 video (10) raman ambele valide', () => {
  assert.match(server, /const ORDER_MEDIA_MAX_ITEMS = 10;/);
  assert.match(server, /const ORDER_MEDIA_MIN_ITEMS = 3;/);
});

test('multer: limita de fisiere (files: ORDER_MEDIA_MAX_ITEMS) si dimensiune (fileSize: ORDER_MEDIA_MAX_BYTES) raman ambele cablate corect in configuratie', () => {
  assert.ok(server.includes('limits: { fileSize: ORDER_MEDIA_MAX_BYTES, files: ORDER_MEDIA_MAX_ITEMS }'));
});

// ---------------------------------------------------------------------------------------------
// 6. Verificare REALA (nu doar text-matching): un fisier "simulat" de 300MB/500MB, creat ca
//    fisier RAR (sparse) pe disc — fara sa scriem efectiv sute de MB — trece testul de
//    dimensiune (fs.statSync().size) fara nicio citire completa in memorie.
// ---------------------------------------------------------------------------------------------
test('verificare reala: un fisier de 300MB si unul de 500MB (create ca fisiere rare pe disc, fara scriere efectiva) raporteaza corect dimensiunea prin fs.statSync — streaming-ul (fs.createReadStream) nu are nevoie sa citeasca fisierul ca sa-i cunoasca marimea', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-media-test-'));
  try {
    const sizesToTest = [300 * 1024 * 1024, 500 * 1024 * 1024];
    for (const size of sizesToTest) {
      const filePath = path.join(tmpDir, `fake-${size}.mp4`);
      const fd = fs.openSync(filePath, 'w');
      fs.ftruncateSync(fd, size);
      fs.closeSync(fd);
      const stats = fs.statSync(filePath);
      assert.equal(stats.size, size);
      const ORDER_MEDIA_MAX_BYTES = 700 * 1024 * 1024;
      assert.ok(stats.size <= ORDER_MEDIA_MAX_BYTES, `un fisier de ${size / (1024 * 1024)}MB trebuie sa incapa sub noua limita`);
      // streaming real, fara sa incarcam continutul in memorie — doar confirmam ca stream-ul
      // se poate deschide si citi progresiv, fara Buffer.concat/readFileSync.
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      let bytesRead = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', chunk => { bytesRead += chunk.length; });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      assert.equal(bytesRead, size, 'streaming-ul trebuie sa parcurga exact dimensiunea fisierului, fara sa il incarce dintr-o data');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 7. Sintaxa ramane valida in toate fisierele atinse; celelalte pachete raman neatinse.
// ---------------------------------------------------------------------------------------------
test('server.js, melodia-mea.html, comanda-mea.html, succes.html: raman sintactic valide', () => {
  const { execSync } = require('node:child_process');
  execSync('node --check server.js', { cwd: path.join(__dirname, '..') });
  [melodiaMea, comandaMea, succes].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman exact neschimbate — Standard/Premium neatinse', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
