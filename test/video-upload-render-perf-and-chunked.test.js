// Runda 5 (2026-08-14), "cardurile apar greu/inegal, unele goale, interfata raspunde greu, apas
// repetat" — dovada masurata data explicit de client: `xhr.upload.onprogress` apela
// `renderQueueList()` (rebuild COMPLET prin innerHTML + re-instalarea TUTUROR listenerelor) la
// FIECARE eveniment de progres; `xhr.onload` reincarca toata comanda (`lookup()`/`refreshCard()`/
// `refreshOrderMedia()`) dupa FIECARE fisier individual, inclusiv cat timp alte uploaduri
// continua. Acest fisier verifica STRUCTURAL ca:
//   1) primul render al intregii selectii e imediat si complet (renderQueueList apelat o data,
//      sincron, dupa `change`, inainte de orice raspuns de server);
//   2) evenimentele de progres NU mai reconstruiesc lista intreaga — patch direct, throttled
//      prin requestAnimationFrame;
//   3) succesul unui fisier NU mai reincarca toata comanda — o sincronizare "single-flight",
//      debounced, dupa ce coada se goleste (sau se coalesc mai multe finalizari apropiate);
//   4) exista un blocaj impotriva apasarilor duplicate pe selector;
//   5) exista un progres global (batch) afisat deasupra listei, cu textul final STRICT dupa
//      confirmarea serverului;
//   6) uploadul video mare foloseste un traseu fragmentat (chunked), cu retry per fragment,
//      NICIODATA base64/FileReader.readAsDataURL/arrayBuffer() pe fisierul intreg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const PAGES = {
  'melodia-mea.html': read('public/melodia-mea.html'),
  'comanda-mea.html': read('public/comanda-mea.html'),
  'succes.html': read('public/succes.html')
};

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

for (const [name, html] of Object.entries(PAGES)) {
  // -----------------------------------------------------------------------------------------
  // 1. Primul render e imediat si complet — renderQueueList() apelat sincron dupa `change`,
  //    inainte de orice raspuns de retea (nu asteapta thumbnailuri/metadate/server).
  // -----------------------------------------------------------------------------------------
  test(`${name}: dupa 'change', renderQueueList() (rebuild COMPLET al intregii selectii) e apelat SINCRON, inainte de processUploadQueue()`, () => {
    const changeMarker = name === 'melodia-mea.html' ? "memFileInput.addEventListener('change', () => {" : "fileInput.addEventListener('change', () => {";
    const idx = html.indexOf(changeMarker);
    assert.notEqual(idx, -1);
    const renderIdx = html.indexOf('renderQueueList();', idx);
    const processIdx = html.indexOf('processUploadQueue();', idx);
    assert.notEqual(renderIdx, -1);
    assert.notEqual(processIdx, -1);
    assert.ok(renderIdx < processIdx, 'toate cardurile trebuie sa apara INAINTE de a porni uploadul (nu invers)');
  });

  // -----------------------------------------------------------------------------------------
  // 2. Progresul NU mai reconstruieste lista intreaga — xhr.upload.onprogress apeleaza STRICT
  //    scheduleProgressUpdate(entry), niciodata renderQueueList().
  // -----------------------------------------------------------------------------------------
  test(`${name}: startSingleUpload() — xhr.upload.onprogress NU mai apeleaza renderQueueList() (doar scheduleProgressUpdate, throttled)`, () => {
    const src = extractFunction(html, 'function startSingleUpload(entry) {');
    const onprogressIdx = src.indexOf('xhr.upload.onprogress');
    const onprogressEnd = src.indexOf('};', onprogressIdx);
    const onprogressBody = src.slice(onprogressIdx, onprogressEnd);
    assert.ok(onprogressBody.includes('scheduleProgressUpdate(entry)'));
    assert.ok(!onprogressBody.includes('renderQueueList()'), 'un tick de progres nu mai trebuie sa reconstruiasca toata lista');
  });

  test(`${name}: patchQueueRowProgress() actualizeaza DIRECT bara/textul unui singur rand, fara sa reconstruiasca innerHTML-ul randului`, () => {
    const src = extractFunction(html, 'function patchQueueRowProgress(entry) {');
    assert.ok(src.includes("querySelector('.mem-progress-fill')"));
    assert.ok(src.includes("querySelector('.mem-meta')"));
    assert.ok(src.includes('fill.style.width'));
    assert.ok(!/row\.innerHTML\s*=/.test(src), 'patch-ul direct nu trebuie sa reconstruiasca innerHTML-ul randului (doar campurile individuale)');
  });

  test(`${name}: scheduleProgressUpdate() foloseste requestAnimationFrame — maximum un update vizual per frame, indiferent de cate evenimente de progres sosesc`, () => {
    const src = extractFunction(html, 'function scheduleProgressUpdate(entry) {');
    assert.ok(src.includes('requestAnimationFrame('));
    assert.ok(src.includes('progressRafScheduled'), 'trebuie sa existe un flag care previne programarea mai multor frame-uri simultan');
  });

  // -----------------------------------------------------------------------------------------
  // 3. Succesul unui fisier NU mai reincarca toata comanda — sincronizare single-flight,
  //    debounced, dupa ce coada se goleste (nu 8 reincarcari complete pentru 8 materiale).
  // -----------------------------------------------------------------------------------------
  test(`${name}: startSingleUpload() — succesul unui fisier apeleaza scheduleMemSync() (single-flight, debounced), NU o reincarcare completa directa`, () => {
    const src = extractFunction(html, 'function startSingleUpload(entry) {');
    const onloadIdx = src.indexOf('xhr.onload = ');
    const onloadEnd = src.indexOf('xhr.onerror', onloadIdx);
    const onloadBody = src.slice(onloadIdx, onloadEnd);
    assert.ok(onloadBody.includes('scheduleMemSync();'));
    assert.ok(!/await\s+(lookup|refreshCard|refreshOrderMedia)\(/.test(onloadBody), 'nu mai trebuie sa existe o reincarcare completa DIRECTA dupa un singur fisier');
  });

  test(`${name}: scheduleMemSync()/runMemSync() garanteaza STRICT o sincronizare in zbor odata (single-flight) — niciodata doua simultan`, () => {
    const scheduleSrc = extractFunction(html, 'function scheduleMemSync() {');
    assert.ok(scheduleSrc.includes('memSyncTimer || memSyncInFlight'), 'nu trebuie programata o noua sincronizare cat timp una e deja in curs sau programata');
    const runSrc = extractFunction(html, 'async function runMemSync() {');
    assert.ok(runSrc.includes('memSyncInFlight = true;'));
    assert.ok(runSrc.includes('memSyncInFlight = false;'));
    assert.ok(runSrc.includes('if (memSyncAgainNeeded)'), 'daca a mai fost nevoie de o sincronizare cat timp cea curenta rula, trebuie inlantuita una noua DUPA, niciodata in paralel');
  });

  // -----------------------------------------------------------------------------------------
  // 4. Blocaj impotriva apasarilor duplicate pe selector.
  // -----------------------------------------------------------------------------------------
  test(`${name}: prima apasare pe selectorul de fisiere blocheaza apasarile duplicate pana la 'change'/'cancel'/timeout de siguranta`, () => {
    assert.ok(html.includes('let pickerLocked = false;'));
    assert.ok(html.includes('if (pickerLocked) { e.preventDefault(); return; }'));
    assert.ok(html.includes('pickerLocked = true;'));
    // eliberare garantata si fara niciun eveniment (siguranta) — timeout explicit, nu doar 'change'/'cancel'
    assert.ok(/pickerLockTimeoutId\s*=\s*setTimeout\(\s*\(\)\s*=>\s*\{\s*pickerLocked\s*=\s*false;\s*\},\s*20000\)/.test(html));
  });

  // -----------------------------------------------------------------------------------------
  // 5. Progres global (batch), deasupra listei — textul final STRICT dupa confirmarea
  //    serverului (memBatchDoneCount creste NUMAI la succesul confirmat, niciodata la selectia
  //    locala din 'change').
  // -----------------------------------------------------------------------------------------
  test(`${name}: exista elementul #mem-batch-status, plasat DEASUPRA listei de materiale in curs (#mem-staged-list)`, () => {
    const batchIdx = html.indexOf('id="mem-batch-status"');
    const stagedIdx = html.indexOf('id="mem-staged-list"');
    assert.notEqual(batchIdx, -1);
    assert.notEqual(stagedIdx, -1);
    assert.ok(batchIdx < stagedIdx, '#mem-batch-status trebuie sa apara inaintea #mem-staged-list in DOM');
  });

  test(`${name}: memBatchDoneCount creste STRICT la succesul confirmat de server (in xhr.onload / completeRes), niciodata in handler-ul de 'change'`, () => {
    const changeMarker = name === 'melodia-mea.html' ? "memFileInput.addEventListener('change', () => {" : "fileInput.addEventListener('change', () => {";
    const changeIdx = html.indexOf(changeMarker);
    const changeEnd = html.indexOf('\n  });', changeIdx);
    const changeSnippet = html.slice(changeIdx, changeEnd === -1 ? changeIdx + 3000 : changeEnd);
    assert.ok(!changeSnippet.includes('memBatchDoneCount++'), 'selectia locala nu trebuie sa creasca numarul de materiale confirmate');
    assert.ok(changeSnippet.includes('memBatchTotal += files.length;'));
    const startUploadSrc = extractFunction(html, 'function startSingleUpload(entry) {');
    assert.ok(startUploadSrc.includes('memBatchDoneCount++'));
  });

  test(`${name}: renderBatchStatus() afiseaza textul final STRICT cand coada e goala de fisiere active, folosind numarul confirmat de server`, () => {
    const src = extractFunction(html, 'function renderBatchStatus() {');
    assert.ok(src.includes('t.memories_batch_done(memBatchDoneCount)'));
    assert.ok(src.includes('t.memories_batch_progress('));
  });

  for (const key of ['memories_processing', 'memories_uploading_pct', 'memories_batch_progress', 'memories_batch_done', 'memories_auto_upload_hint']) {
    test(`${name}: cheia de traducere "${key}" exista de exact 8 ori (o data per limba)`, () => {
      const occurrences = (html.match(new RegExp(`${key}:`, 'g')) || []).length;
      assert.equal(occurrences, 8, `"${key}" trebuie sa existe in toate cele 8 limbi, gasit de ${occurrences} ori`);
    });
  }

  // -----------------------------------------------------------------------------------------
  // 6. Upload fragmentat (chunked) pentru videoclipuri mari — dispatcher, retry per fragment,
  //    niciodata base64/FileReader/arrayBuffer() pe fisierul intreg.
  // -----------------------------------------------------------------------------------------
  test(`${name}: startUpload() foloseste uploadul fragmentat STRICT pentru videoclipuri peste MEM_CHUNK_THRESHOLD_BYTES, restul prin startSingleUpload`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes('isVideoFile(entry.file) && entry.file.size > MEM_CHUNK_THRESHOLD_BYTES'));
  });

  test(`${name}: MEM_CHUNK_THRESHOLD_BYTES (client) e IDENTIC cu ORDER_MEDIA_CHUNK_THRESHOLD_BYTES (server) — 20MB`, () => {
    assert.ok(html.includes('const MEM_CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
  });

  test(`${name}: startChunkedUpload() foloseste Blob.slice() pentru fragmente — niciodata FileReader.readAsDataURL, niciodata arrayBuffer() pe fisierul intreg, niciodata conversie base64`, () => {
    const src = extractFunction(html, 'async function startChunkedUpload(entry) {');
    assert.ok(src.includes('entry.file.slice('));
    assert.ok(!src.includes('readAsDataURL'));
    assert.ok(!src.includes('.arrayBuffer()'));
    assert.ok(!/btoa\(|base64/i.test(src));
  });

  test(`${name}: fragmentele se trimit SECVENTIAL (offset avanseaza STRICT pe baza raspunsului serverului, receivedBytes) — niciodata retransmise dupa confirmare`, () => {
    const src = extractFunction(html, 'async function startChunkedUpload(entry) {');
    assert.ok(src.includes('offset = await uploadChunkWithRetry(entry, slice, offset, totalBytes);'));
    assert.ok(/while\s*\(\s*offset\s*<\s*totalBytes\s*\)/.test(src));
  });

  test(`${name}: uploadChunkWithRetry() reincearca STRICT fragmentul esuat (acelasi offset), cu limita si backoff — niciodata reluare de la inceputul fisierului`, () => {
    const src = extractFunction(html, 'function uploadChunkWithRetry(entry, blob, offset, totalBytes) {');
    assert.ok(src.includes('MEM_CHUNK_RETRY_LIMIT'));
    assert.ok(src.includes('setTimeout(tryOnce,'));
    assert.ok(!/offset\s*=\s*0/.test(src), 'un fragment esuat nu trebuie sa reseteze offset-ul la 0');
  });

  test(`${name}: finalizarea (complete) e apelata o singura data, dupa ce TOATE fragmentele au fost confirmate (offset >= totalBytes)`, () => {
    const src = extractFunction(html, 'async function startChunkedUpload(entry) {');
    const whileIdx = src.indexOf('while (offset < totalBytes)');
    const completeIdx = src.indexOf('/complete`', whileIdx);
    assert.ok(whileIdx !== -1 && completeIdx !== -1 && completeIdx > whileIdx, 'apelul de finalizare trebuie sa vina STRICT dupa bucla de fragmente');
  });

  test(`${name}: eliminarea unui material din coada in timpul unui upload fragmentat opreste reincercarile (abortRequested), nu doar XHR-ul curent`, () => {
    const wireSrc = extractFunction(html, 'function wireQueueRow(row, entry) {');
    assert.ok(wireSrc.includes('entry.abortRequested = true;'));
    const retrySrc = extractFunction(html, 'function uploadChunkWithRetry(entry, blob, offset, totalBytes) {');
    assert.ok(retrySrc.includes('entry.abortRequested'));
  });
}

// -------------------------------------------------------------------------------------------
// 7. server.js: endpoint-urile de upload fragmentat exista, sunt protejate de token, si
//    finalizarea e idempotenta (o a doua cerere de complete NU re-urca/re-persista).
// -------------------------------------------------------------------------------------------
const server = read('server.js');

test('server.js: cele 4 rute de upload fragmentat exista, toate protejate de requireOrderToken', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/chunked\/init', requireOrderToken/);
  assert.match(server, /app\.put\('\/api\/orders\/:orderId\/media\/chunked\/:sessionId\/chunk', requireOrderToken/);
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/chunked\/:sessionId\/complete', requireOrderToken/);
  assert.match(server, /app\.delete\('\/api\/orders\/:orderId\/media\/chunked\/:sessionId', requireOrderToken/);
});

test('server.js: /complete e idempotent — o sesiune deja finalizata (session.completed) intoarce STRICT acelasi rezultat, fara sa re-urce/re-persiste', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/chunked/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  const idx = src.indexOf('if (session.completed)');
  assert.notEqual(idx, -1);
  assert.ok(src.slice(idx, idx + 60).includes('return res.json(session.result)'));
});

test('server.js: fragmentul e scris la offset-ul exact (nu adaugat la coada) — reincercarea aceluiasi offset e idempotenta (suprascrie, nu duplica)', () => {
  const routeIdx = server.indexOf("app.put('/api/orders/:orderId/media/chunked/:sessionId/chunk'");
  assert.notEqual(routeIdx, -1);
  const nextRouteIdx = server.indexOf("app.post('/api/orders/:orderId/media/chunked/:sessionId/complete'", routeIdx);
  const src = server.slice(routeIdx, nextRouteIdx);
  assert.ok(src.includes("await fh.write(buf, 0, buf.length, offset);"));
  assert.ok(src.includes('session.receivedBytes = Math.max(session.receivedBytes, offset + buf.length);'), 'receivedBytes nu trebuie sa scada niciodata la o reincercare/fragment mai vechi');
});

test('server.js: init valideaza dimensiunea si tipul (STRICT video) inainte de a crea o sesiune', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/chunked/init', requireOrderToken, async (req, res, next) => {");
  assert.ok(src.includes('ORDER_MEDIA_MAX_BYTES'));
  assert.ok(src.includes("inferredForInit.type !== 'video'"));
});

test('server.js: sesiunile abandonate (idle) sunt curatate periodic — fara acumulare nelimitata de fisiere temporare orfane', () => {
  assert.match(server, /CHUNK_SESSION_IDLE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  assert.ok(server.includes('setInterval(() => {') && server.includes('chunkSessions.delete(sessionId)'));
});

// -------------------------------------------------------------------------------------------
// 8. Verificare REALA a algoritmului de scriere pe fragmente la offset exact — reproduce
//    exact operatia server-side (fs.open 'r+' + write la offset), fara sa porneasca serverul:
//    doua fragmente scrise in ordine reconstruiesc exact continutul original; retrimiterea
//    aceluiasi fragment (retry) nu modifica rezultatul final.
// -------------------------------------------------------------------------------------------
test('scriere pe fragmente la offset exact: doua fragmente reconstruiesc EXACT continutul original, iar reincercarea unui fragment nu il duplica', async () => {
  const tmpPath = path.join(os.tmpdir(), `naluna-chunk-test-${Date.now()}.bin`);
  const totalBytes = 20;
  const original = Buffer.from('ABCDEFGHIJKLMNOPQRST'); // 20 bytes
  assert.equal(original.length, totalBytes);
  const chunk1 = original.subarray(0, 10);
  const chunk2 = original.subarray(10, 20);

  fs.closeSync(fs.openSync(tmpPath, 'w'));
  try {
    async function writeAt(offset, buf) {
      const fh = await fs.promises.open(tmpPath, 'r+');
      try { await fh.write(buf, 0, buf.length, offset); } finally { await fh.close(); }
    }
    await writeAt(0, chunk1);
    await writeAt(10, chunk2);
    // reincercare (retry) a primului fragment — trebuie sa suprascrie exact aceiasi octeti, fara sa deplaseze restul
    await writeAt(0, chunk1);

    const result = fs.readFileSync(tmpPath);
    assert.equal(result.length, totalBytes);
    assert.equal(result.toString(), original.toString());
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('server.js, melodia-mea.html, comanda-mea.html, succes.html: raman sintactic valide dupa corectiile Rundei 5', () => {
  assert.doesNotThrow(() => { require('node:child_process').execSync(`node --check "${path.join(__dirname, '..', 'server.js')}"`); });
  for (const [name, html] of Object.entries(PAGES)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  }
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
