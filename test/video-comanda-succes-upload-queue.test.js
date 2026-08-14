// Runda 4 (2026-08-14), "OPREȘTE orice modificare speculativă" — dovada live aratata de client:
// comanda-mea.html si succes.html (fluxul de adaugare/inlocuire materiale DUPA plata, pentru
// pachetul "Cadou video") foloseau inca mecanismul VECHI, monolitic: `stagedFiles` copiat din
// FileList, apoi un SINGUR FormData cu TOATE fisierele, trimis intr-un SINGUR POST catre
// /api/orders/:orderId/media — o cerere esuata pierdea tot lotul deodata, fara nicio izolare per
// fisier, exact descrierea data explicit de client. melodia-mea.html (fluxul PRE-plata) avea deja,
// din rundele anterioare, o coada per-fisier robusta (uploadQueue/processUploadQueue/startUpload,
// XMLHttpRequest individual per fisier, retry individual, izolare completa la eroare) — niciodata
// portata insa si catre aceste doua pagini. Acest fisier verifica STRUCTURAL ca ambele pagini
// folosesc acum acelasi mecanism dovedit, ca fiecare fisier are propriul request, si ca eroarea
// unui singur fisier nu mai poate afecta restul lotului.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const PAGES = {
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
  // 1. Mecanismul VECHI (stagedFiles + un singur POST cu toate fisierele) nu mai exista.
  // -----------------------------------------------------------------------------------------
  test(`${name}: mecanismul vechi "stagedFiles" (variabila de cod, nu comentariul istoric) nu mai exista`, () => {
    assert.ok(!/\blet stagedFiles\b/.test(html), 'nu mai trebuie sa existe o declaratie "let stagedFiles"');
    assert.ok(!html.includes('stagedFiles.push('));
    assert.ok(!html.includes('stagedFiles.concat('));
    assert.ok(!html.includes('stagedFiles.forEach('));
  });

  test(`${name}: foloseste acum uploadQueue (coada per-fisier, identic cu melodia-mea.html)`, () => {
    assert.ok(html.includes('let uploadQueue = []'));
    assert.ok(html.includes('function processUploadQueue()'));
    assert.ok(html.includes('function startUpload(entry)'));
  });

  test(`${name}: startUpload() trimite UN SINGUR fisier per request (formData.append('media', entry.file), nicio bucla peste un lot)`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes("formData.append('media', entry.file);"));
    assert.ok(!/forEach\(\s*sf\s*=>\s*formData\.append/.test(src), 'nu mai trebuie sa existe un forEach care adauga mai multe fisiere in acelasi FormData');
  });

  test(`${name}: fiecare fisier foloseste propriul XMLHttpRequest (nu fetch cu un FormData combinat)`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes('new XMLHttpRequest()'));
    assert.ok(src.includes('xhr.send(formData)'));
  });

  // -----------------------------------------------------------------------------------------
  // 2. Un fisier care esueaza NU afecteaza restul lotului: eroarea seteaza DOAR intrarea proprie
  //    ('entry.status = "error"'), fara sa goleasca sau sa resetaze uploadQueue.
  // -----------------------------------------------------------------------------------------
  test(`${name}: eroarea unui fisier (onerror/ontimeout) marcheaza DOAR intrarea proprie, restul cozii ramane intact`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes("entry.status = 'error';"));
    assert.ok(!/uploadQueue\s*=\s*\[\]/.test(src), 'nicio eroare nu trebuie sa goleasca intreaga coada');
  });

  test(`${name}: succesul unui fisier elimina STRICT propria intrare din coada (filter dupa localId), nu toata coada`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes('uploadQueue = uploadQueue.filter(q => q.localId !== entry.localId);'));
  });

  // -----------------------------------------------------------------------------------------
  // 3. Retry-ul unui fisier esuat NU creeaza o intrare noua/duplicat — doar schimba starea
  //    intrarii existente inapoi la 'pending' si reintra in coada cu concurenta limitata.
  // -----------------------------------------------------------------------------------------
  test(`${name}: butonul de retry reactiveaza intrarea existenta (fara push nou, deci fara duplicat)`, () => {
    const idx = html.indexOf("el.querySelectorAll('[data-retry-id]')");
    assert.notEqual(idx, -1);
    const snippet = html.slice(idx, idx + 500);
    assert.ok(snippet.includes("entry.status = 'pending';"));
    assert.ok(!snippet.includes('uploadQueue.push('), 'retry nu trebuie sa adauge o intrare noua in coada');
  });

  // -----------------------------------------------------------------------------------------
  // 4. Capturarea FileList: sincron, fara filtrare dupa tip, try/catch per fisier, input resetat
  //    DUPA copiere — identic cu verificarile deja facute pentru melodia-mea.html.
  // -----------------------------------------------------------------------------------------
  test(`${name}: handler-ul de change captureaza intregul FileList SINCRON (Array.from), inainte de resetarea inputului`, () => {
    const idx = html.indexOf("fileInput.addEventListener('change', () => {");
    assert.notEqual(idx, -1, 'handler-ul trebuie sa ramana sincron');
    const filesIdx = html.indexOf('const files = Array.from(fileInput.files);', idx);
    const resetIdx = html.indexOf("fileInput.value = '';", idx);
    assert.ok(filesIdx > idx && filesIdx - idx < 150);
    assert.ok(resetIdx > filesIdx && resetIdx - filesIdx < 60, 'resetarea trebuie sa vina imediat DUPA copiere, nu inainte');
  });

  test(`${name}: fiecare fisier din selectie e adaugat necondiționat in coada (files.forEach, fara .filter, fara conditie dupa file.type)`, () => {
    const idx = html.indexOf("fileInput.addEventListener('change', () => {");
    const end = html.indexOf('renderQueueList();\n      processUploadQueue();', idx);
    const snippet = html.slice(idx, end);
    assert.ok(snippet.includes('files.forEach(file => {'));
    assert.ok(!snippet.includes('.filter('));
    assert.ok(!/if\s*\(\s*file\.type/.test(snippet));
  });

  test(`${name}: eroarea la construirea unei intrari (try/catch) NU scoate fisierul din lot — ramane vizibil, cu status "error"`, () => {
    const idx = html.indexOf("fileInput.addEventListener('change', () => {");
    const end = html.indexOf('renderQueueList();\n      processUploadQueue();', idx);
    const snippet = html.slice(idx, end);
    assert.ok(snippet.includes('} catch (err) {'));
    const catchBlock = snippet.slice(snippet.indexOf('} catch (err) {'));
    assert.ok(catchBlock.includes('uploadQueue.push('));
    assert.ok(catchBlock.includes("status: 'error'"));
  });

  // -----------------------------------------------------------------------------------------
  // 5. Eliminarea unei intrari din coada (butonul ✕) sterge STRICT intrarea proprie.
  // -----------------------------------------------------------------------------------------
  test(`${name}: butonul de eliminare dintr-o intrare a cozii sterge DOAR acea intrare (splice pe index gasit prin localId)`, () => {
    const idx = html.indexOf("el.querySelectorAll('[data-queue-remove]')");
    assert.notEqual(idx, -1);
    const snippet = html.slice(idx, idx + 400);
    assert.ok(snippet.includes('uploadQueue.splice(idx, 1);'));
    assert.ok(!/uploadQueue\s*=\s*\[\]/.test(snippet));
  });

  // -----------------------------------------------------------------------------------------
  // 6. Un singur input, "multiple", accepta simultan image/* si video/*, fara capture.
  // -----------------------------------------------------------------------------------------
  test(`${name}: inputul ramane unic, "multiple", accept="image/*,video/*", fara atributul capture (neschimbat fata de runda anterioara)`, () => {
    const inputMatch = html.match(/<input type="file"[^>]*>/);
    assert.ok(inputMatch);
    const tag = inputMatch[0];
    assert.ok(/\bmultiple\b/.test(tag));
    assert.ok(tag.includes('accept="image/*,video/*"'));
    assert.ok(!tag.includes('capture'));
    const allInputs = (html.match(/<input type="file"/g) || []).length;
    assert.equal(allInputs, 1);
  });

  // -----------------------------------------------------------------------------------------
  // 7. Nicio iconita locala de tip <video src="blob:..."> pentru materialele din coada — doar
  //    iconita statica (decodarea simultana a metadatelor bloca vizibil iPhone-ul).
  // -----------------------------------------------------------------------------------------
  test(`${name}: renderQueueList() nu construieste niciodata un <video src="blob:..."> pentru materialele din coada`, () => {
    const src = extractFunction(html, 'function renderQueueList() {');
    assert.ok(!src.includes('<video'));
  });

  test(`${name}: renderQueueList() foloseste isVideoFile() (nu file.type.startsWith direct)`, () => {
    const src = extractFunction(html, 'function renderQueueList() {');
    assert.ok(src.includes('isVideoFile(q.file)'));
  });

  // -----------------------------------------------------------------------------------------
  // 8. isVideoFile(): executie REALA, identica logic cu melodia-mea.html.
  // -----------------------------------------------------------------------------------------
  function loadIsVideoFile() {
    const src = extractFunction(html, 'function isVideoFile(file) {');
    const constIdx = html.indexOf('const VIDEO_EXTENSIONS = ');
    const constEnd = html.indexOf(';', constIdx) + 1;
    const constSrc = html.slice(constIdx, constEnd);
    return new Function(`${constSrc}\n${src}\nreturn isVideoFile;`)();
  }
  const isVideoFile = loadIsVideoFile();

  test(`${name}: isVideoFile() — MIME gol, extensia .MOV (majuscule) e recunoscut ca videoclip prin fallback`, () => {
    assert.equal(isVideoFile({ type: '', name: 'IMG_5678.MOV' }), true);
  });
  test(`${name}: isVideoFile() — MIME gol, extensia .heic ramane fotografie`, () => {
    assert.equal(isVideoFile({ type: '', name: 'IMG_0001.HEIC' }), false);
  });
  test(`${name}: isVideoFile() — MIME explicit "video/quicktime" (MOV real de pe iPhone) e recunoscut`, () => {
    assert.equal(isVideoFile({ type: 'video/quicktime', name: 'IMG_1234.MOV' }), true);
  });

  // -----------------------------------------------------------------------------------------
  // 9. Detectia best-effort "iOS nu a predat fisierele" — heuristica exista, mesajul e afisat
  //    doar pe iOS, doar dupa revenirea la pagina fara "change".
  // -----------------------------------------------------------------------------------------
  test(`${name}: exista o detectie a cazului "picker deschis, dar niciun change" (click -> asteptare -> verificare la focus/visibilitychange)`, () => {
    assert.ok(html.includes("fileInput.addEventListener('click', () => {"));
    assert.ok(html.includes('pickerAwaitingChange = true;'));
    assert.ok(html.includes("document.addEventListener('visibilitychange'"));
    assert.ok(html.includes("window.addEventListener('focus', checkPickerDelivery);"));
  });

  test(`${name}: mesajul de recuperare iOS e afisat STRICT cand memIsIOS e adevarat, niciodata neconditionat`, () => {
    const idx = html.indexOf('function checkPickerDelivery() {');
    const snippet = html.slice(idx, idx + 600);
    assert.ok(snippet.includes('if (memIsIOS) {'));
    assert.ok(snippet.includes('t.memories_ios_recovery'));
  });

  test(`${name}: "change" reseteaza flagul de asteptare a picker-ului (pickerAwaitingChange = false), ca sa nu declanseze fals mesajul de recuperare dupa o selectie reusita`, () => {
    const idx = html.indexOf("fileInput.addEventListener('change', () => {");
    const snippet = html.slice(idx, idx + 150);
    assert.ok(snippet.includes('pickerAwaitingChange = false;'));
  });

  // -----------------------------------------------------------------------------------------
  // 10. Diagnostic privacy-safe: NICIODATA nume de fisier in memLog().
  // -----------------------------------------------------------------------------------------
  test(`${name}: memLog() nu primeste niciodata file.name sau continut de fisier — doar tip general si dimensiune`, () => {
    const idx = html.indexOf("memLog(orderId, 'change'") !== -1 ? html.indexOf("memLog(orderId, 'change'") : html.indexOf("memLog('change'");
    assert.notEqual(idx, -1);
    const snippet = html.slice(idx, idx + 300);
    assert.ok(!snippet.includes('f.name'), 'diagnosticul nu trebuie sa includa niciodata numele fisierului');
    assert.ok(snippet.includes('sizeMb'));
  });

  // -----------------------------------------------------------------------------------------
  // 11. Cele 6 chei noi de traducere (5 portate + memories_ios_recovery) exista in toate cele
  //     8 limbi.
  // -----------------------------------------------------------------------------------------
  for (const key of ['memories_queued', 'memories_uploaded', 'memories_retry', 'memories_upload_timeout', 'memories_no_files_selected', 'memories_ios_recovery']) {
    test(`${name}: cheia de traducere "${key}" exista de exact 8 ori (o data per limba)`, () => {
      const occurrences = (html.match(new RegExp(`${key}:`, 'g')) || []).length;
      assert.equal(occurrences, 8, `"${key}" trebuie sa existe in toate cele 8 limbi, gasit de ${occurrences} ori`);
    });
  }

  test(`${name}: niciun text vizibil nu mai contine "150MB"`, () => {
    assert.ok(!/150\s*MB/i.test(html));
  });

  // -----------------------------------------------------------------------------------------
  // 12. Coliziunea de clasa CSS ".mem-actions" (buton de continuare pagina vs. butoane mici per
  //     material din coada) e rezolvata explicit — wrapper-ul de pagina foloseste acum
  //     ".mem-page-actions", separat de ".mem-actions" (compact, per intrare din coada).
  // -----------------------------------------------------------------------------------------
  test(`${name}: butonul de creare a videoclipului foloseste wrapper-ul de pagina ".mem-page-actions", NU ".mem-actions" (evita stilul compact de icon din coada)`, () => {
    assert.ok(html.includes('class="mem-page-actions"'));
    assert.ok(html.includes('.mem-page-actions{'));
    const createBtnWrapIdx = html.indexOf('id="mem-create-btn"');
    const before = html.slice(Math.max(0, createBtnWrapIdx - 200), createBtnWrapIdx);
    assert.ok(before.includes('mem-page-actions'), 'butonul de creare trebuie sa fie in interiorul wrapper-ului .mem-page-actions');
  });

  // -----------------------------------------------------------------------------------------
  // 13. Butonul de creare e dezactivat cat timp mai exista fisiere in curs de incarcare/asteptare.
  // -----------------------------------------------------------------------------------------
  test(`${name}: updateMemActionGates() dezactiveaza butonul de creare cat timp exista fisiere in curs (uploading/pending)`, () => {
    const src = extractFunction(html, 'function updateMemActionGates() {');
    assert.ok(src.includes("q.status === 'uploading' || q.status === 'pending'"));
    assert.ok(src.includes('createBtn.disabled = busy;'));
  });

  // -----------------------------------------------------------------------------------------
  // 14. Sintaxa ramane valida.
  // -----------------------------------------------------------------------------------------
  test(`${name}: ramane sintactic valid`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
}

// -------------------------------------------------------------------------------------------
// 15. Server: limita reala de 10 materiale ramane neschimbata (protectia exista deja server-side,
//     independent de UI — nu era nevoie de o limita noua client-side pentru aceste doua pagini).
// -------------------------------------------------------------------------------------------
test('server.js: ORDER_MEDIA_MAX_ITEMS ramane 10, neschimbat', () => {
  const server = read('server.js');
  assert.match(server, /const ORDER_MEDIA_MAX_ITEMS\s*=\s*10;/);
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  const server = read('server.js');
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
