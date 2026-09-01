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

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): coada de
// upload/progres/sincronizare testata aici pentru pachetul Cadou video a fost MUTATA din
// melodia-mea.html in public/amintiri-video.html — retargetat STRICT aceasta pagina;
// comanda-mea.html/succes.html au propriile copii NEATINSE, folosite de fluxuri distincte.
const PAGES = {
  'amintiri-video.html': read('public/amintiri-video.html'),
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
    // CORECȚIE (2026-08-29/30, "pagina de recuperare Photos si loader unic" — Cerintele 4/5):
    // change-handler-ul acum copiaza sincron FileList-ul si preda fisierele catre
    // handleFilesReceived(files) (comuna cu fallback-ul "Alege din Fisiere"), care e cea care
    // efectiv randeaza coada si porneste uploadul — verificam ordinea ACOLO, nu direct in
    // handler-ul de 'change'.
    const changeMarker = name === 'amintiri-video.html' ? "memFileInput.addEventListener('change', () => {" : "fileInput.addEventListener('change', () => {";
    const changeIdx = html.indexOf(changeMarker);
    assert.notEqual(changeIdx, -1);
    const handOffIdx = html.indexOf('handleFilesReceived(files)', changeIdx);
    assert.notEqual(handOffIdx, -1, 'change trebuie sa predea fisierele catre handleFilesReceived');

    const fnStart = html.indexOf('function handleFilesReceived(files) {');
    assert.notEqual(fnStart, -1);
    const renderIdx = html.indexOf('renderQueueList();', fnStart);
    const processIdx = html.indexOf('processUploadQueue();', fnStart);
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

  // CORECȚIE (2026-08-31, cerinta 5 "un singur loader mare"): randul individual NU mai are bara
  // proprie de progres (".mem-progress-fill" a fost eliminata) — patch-ul direct actualizeaza
  // STRICT textul (".mem-meta"), progresul vizual fiind reprezentat exclusiv de loaderul agregat.
  test(`${name}: patchQueueRowProgress() actualizeaza DIRECT textul unui singur rand (fara bara individuala, eliminata), fara sa reconstruiasca innerHTML-ul randului`, () => {
    const src = extractFunction(html, 'function patchQueueRowProgress(entry) {');
    assert.ok(!src.includes('.mem-progress-fill'), 'bara individuala de progres a fost eliminata (cerinta 5) — nu mai trebuie referita aici');
    assert.ok(src.includes("querySelector('.mem-meta')"));
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
  // 4. Blocaj impotriva apasarilor duplicate pe selector — RELANSARE 2026-08-14 ("starea de
  //    asteptare dupa selectarea videoclipurilor iPhone"): eliminat timeout-ul orb de 20s care
  //    debloca automat selectorul (iPhone Photos/iCloud poate avea nevoie de 2-3 minute inainte
  //    de 'change', interval in care acel timeout debloca eronat selectorul). Eliberare STRICT
  //    la 'change'/'cancel' real, sau la o apasare manuala explicita dupa un prag rezonabil.
  // -----------------------------------------------------------------------------------------
  // CORECȚIE (2026-08-24, "selectorul ramane blocat pana la 5 minute pe iPhone, fara niciun
  // feedback"): plafonul orb a fost redus (90s, de la 5 minute) — recuperarea normala devine
  // acum o AFORDANTA EXPLICITA ("Renunță și încearcă din nou"), surfacing mult mai devreme
  // prin visibilitychange/focus/pageshow, niciodata un deblocaj automat/tacut.
  if (name === 'amintiri-video.html') {
    // CORECȚIE (2026-08-29, runda 2 — "selectorul nu se mai deschide deloc pe iPhone"):
    // PICKER_MANUAL_RECOVERY_MS/pickerLocked erau EXACT cauza blocajului (pointerdown seta
    // lock-ul, click-ul legitim care urma il gasea activ si isi anula singur deschiderea
    // nativa) — eliminate complet. Blocarea reala a selectiilor duplicate ramane STRICT legata
    // de un lot REAL activ (memFileInput.disabled, vezi updateBatchActiveState), niciodata de
    // un prag temporal dupa o simpla apasare.
    test(`${name}: nu mai exista niciun prag/lock temporal (PICKER_MANUAL_RECOVERY_MS/pickerLocked) — selectiile duplicate raman prevenite STRICT prin dezactivarea inputului cat timp un lot e activ`, () => {
      assert.ok(!html.includes('PICKER_MANUAL_RECOVERY_MS'));
      assert.ok(!html.includes('let pickerLocked'));
      assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*\{\s*pickerPending\s*=\s*false;/.test(html), 'nu trebuie sa existe niciun timeout care deblocheaza singur selectorul, fara actiune a utilizatorului');
      assert.ok(!html.includes('pickerLockTimeoutId'));
      assert.match(html, /function handlePickerOpenAttempt\(\) \{\s*if \(memFileInput\.disabled\) return;/, 'handlePickerOpenAttempt() nu mai trebuie sa primeasca/anuleze evenimentul — doar sa verifice starea reala a lotului');
    });
  } else {
    test(`${name}: prima apasare pe selectorul de fisiere blocheaza apasarile duplicate — eliberata STRICT prin actiune (change/cancel/afordanta explicita), niciodata printr-un timeout orb care deblocheaza singur`, () => {
      assert.ok(html.includes('let pickerLocked = false;'));
      assert.ok(html.includes('pickerLocked = true;'));
      assert.ok(html.includes('const PICKER_MANUAL_RECOVERY_MS = 90 * 1000;'), 'plafonul de recuperare manuala trebuie sa fie 90s (redus fata de vechile 5 minute)');
      assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*\{\s*pickerLocked\s*=\s*false;/.test(html), 'nu mai trebuie sa existe niciun timeout care deblocheaza singur selectorul, fara actiune a utilizatorului');
      assert.ok(!html.includes('pickerLockTimeoutId'), 'variabila timeout-ului orb eliminat nu mai trebuie sa existe');
    });
  }

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

  // CORECȚIE (2026-08-31, cerinta 5 — extragerea handleFilesReceived()): construirea/numararea
  // lotului s-a mutat in functia comuna handleFilesReceived(), apelata de handler-ul de 'change'
  // (si de fallback-ul cerintei 4) — memBatchDoneCount ramane STRICT crescut doar la succesul
  // confirmat de server, niciodata la selectia locala.
  test(`${name}: memBatchDoneCount creste STRICT la succesul confirmat de server (in xhr.onload / completeRes), niciodata la selectia locala (handleFilesReceived)`, () => {
    const handleSrc = extractFunction(html, 'function handleFilesReceived(files) {');
    assert.ok(!handleSrc.includes('memBatchDoneCount++'), 'selectia locala nu trebuie sa creasca numarul de materiale confirmate');
    assert.ok(handleSrc.includes('memBatchTotal += files.length;'));
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

}

// Rundele 6+ (upload multipart direct catre R2) au propriul fisier de teste dedicat —
// vezi test/video-multipart-direct-to-r2.test.js.

const server = read('server.js');

test('server.js, amintiri-video.html, comanda-mea.html, succes.html: raman sintactic valide dupa corectiile Rundei 5', () => {
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
