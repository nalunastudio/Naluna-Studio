// Test de regresie pentru doua corectii urgente (2026-08-14), exclusiv pachetul "Cadou video":
//
// 1) Descrierea pachetului Cadou video nu mai mentioneaza pachetul Standard ("exact ca la
//    Standard") — propozitia ramane despre editarea gratuita, fara nicio comparatie cu alt
//    pachet. Toate celelalte aparitii legitime ale cuvantului "Standard" (pachetul Standard
//    insusi, alte texte) raman neschimbate.
//
// 2) Bifa albastra de confirmare a selectorului nativ de fotografii/videoclipuri pe iPhone nu
//    continua fluxul. Cauza cea mai probabila, demonstrata in cod: renderQueueList() construia,
//    pentru FIECARE videoclip din coada (inainte de orice upload), un element <video
//    src="blob:..." preload="metadata"> legat de fisierul local — Safari/iOS trebuie sa
//    decodeze imediat metadata containerului/codecului pentru toate videoclipurile selectate
//    simultan, ceea ce poate bloca vizibil firul principal chiar in momentul confirmarii
//    selectiei. In plus, handler-ul de `change` construia toate intrarile din coada intr-un
//    forEach fara nicio protectie — o exceptie la construirea UNEI SINGURE intrari oprea
//    intregul handler INAINTE sa ajunga la renderQueueList()/processUploadQueue(), lasand
//    pagina complet neschimbata vizual ("nu se intampla nimic"). Corectia: elimina elementul
//    <video> local din coada de asteptare (foloseste STRICT iconita statica pentru videoclipuri,
//    ca imaginile raman pe <img>, ieftin de randat) si izoleaza fiecare intrare cu try/catch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const comanda = read('public/comanda.html');
const melodiaMea = read('public/melodia-mea.html');

// ---------------------------------------------------------------------------------------------
// 1. Descrierea Cadou video nu mai contine "Standard"/"Standart", in nicio limba.
// ---------------------------------------------------------------------------------------------
test('comanda.html: benefits_video (toate cele 8 limbi) nu mai contine nicio referinta la pachetul Standard', () => {
  let idx = 0;
  let blocksChecked = 0;
  while (true) {
    idx = comanda.indexOf('benefits_video: [', idx);
    if (idx === -1) break;
    const end = comanda.indexOf('],', idx);
    const block = comanda.slice(idx, end);
    assert.ok(!/Standard|Standart/.test(block), `benefits_video nu mai trebuie sa mentioneze Standard — gasit in: ${block}`);
    blocksChecked++;
    idx = end;
  }
  assert.equal(blocksChecked, 8, 'trebuie sa existe exact 8 blocuri benefits_video');
});

test('comanda.html: benefits_video pastreaza mentiunea editarii gratuite (versuri/voce/gen), doar fara comparatia cu Standard', () => {
  const idx = comanda.indexOf('benefits_video: [');
  const end = comanda.indexOf('],', idx);
  const block = comanda.slice(idx, end);
  assert.ok(block.includes("'Ai dreptul la o singură editare gratuită — poți schimba versurile, vocea sau genul',"));
});

test('comanda.html: pachetul Standard (benefits_standard) ramane complet neschimbat, in toate cele 8 limbi', () => {
  const occurrences = (comanda.match(/benefits_standard: \[/g) || []).length;
  assert.equal(occurrences, 8);
  const idx = comanda.indexOf('benefits_standard: [');
  const end = comanda.indexOf('],', idx);
  const block = comanda.slice(idx, end);
  assert.ok(block.includes('Ai dreptul la o editare gratuită, dacă nu e exact cum vrei'), 'textul propriu al pachetului Standard nu trebuie atins');
});

test('comanda.html: alte referinte legitime la "Standard" (numele pachetului, plan_standard_*) raman neschimbate', () => {
  assert.ok(comanda.includes("plan_standard_name"));
  assert.ok(/data-plan="standard"/.test(comanda));
});

test('melodia-mea.html: nicio schimbare a textelor proprii pachetului Standard (checkout_btn_standard, standard_choice_*)', () => {
  assert.ok(melodiaMea.includes('checkout_btn_standard'));
  assert.ok(melodiaMea.includes('standard_choice_title'));
});

// ---------------------------------------------------------------------------------------------
// 2. Selectorul foto/video pe iPhone: elimina decodarea locala de metadata video (cauza reala)
//    si protejeaza fiecare fisier izolat, ca o singura exceptie sa nu blocheze tot batch-ul.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: renderQueueList() NU mai construieste niciun element <video> local (blob) pentru videoclipurile din coada de asteptare', () => {
  const idx = melodiaMea.indexOf('function renderQueueList() {');
  const end = melodiaMea.indexOf('el.querySelectorAll', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(!snippet.includes('<video'), 'coada de asteptare (inainte de upload) nu mai trebuie sa randeze niciun <video src="blob:...">');
  assert.ok(snippet.includes("isVideoFile(q.file) ? '🎬'"), 'videoclipurile din coada trebuie sa foloseasca STRICT iconita statica (isVideoFile — vezi test/video-media-limits.test.js pentru fallback-ul pe extensie cand MIME e gol)');
});

test('melodia-mea.html: fotografiile din coada de asteptare raman randate ca <img> din blob local, neschimbat', () => {
  const idx = melodiaMea.indexOf('function renderQueueList() {');
  const end = melodiaMea.indexOf('el.querySelectorAll', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes('<img src="${q.thumbUrl}" alt="">'));
});

test('melodia-mea.html: thumbUrl se creeaza STRICT pentru fotografii — niciun URL.createObjectURL nu mai e legat de un videoclip din coada', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change'");
  const end = melodiaMea.indexOf('renderQueueList();\n    processUploadQueue();', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes('thumbUrl: /^image\\//.test(file.type) ? URL.createObjectURL(file) : null,'));
  assert.ok(!snippet.includes('/^(image|video)\\/'), 'regexul vechi care includea si videoclipurile nu mai trebuie sa existe');
});

test('melodia-mea.html: fiecare fisier din selectie e adaugat in coada intr-un try/catch — o exceptie la un singur fisier nu mai opreste tot handler-ul de change', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change'");
  assert.notEqual(idx, -1);
  const end = melodiaMea.indexOf('renderQueueList();\n    processUploadQueue();', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes('files.forEach(file => {'));
  assert.ok(snippet.includes('try {'));
  assert.ok(snippet.includes('} catch (err) {'));
  assert.ok(snippet.includes("status: 'error'"), 'un fisier care esueaza la construire trebuie marcat vizibil ca eroare, nu ignorat tacit');
});

test('melodia-mea.html: renderQueueList() si processUploadQueue() se apeleaza necondiționat dupa forEach, indiferent daca vreun fisier a esuat la construire', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change'");
  const forEachEnd = melodiaMea.indexOf('});\n    renderQueueList();', idx);
  assert.notEqual(forEachEnd, -1, 'renderQueueList() trebuie apelat imediat dupa inchiderea forEach, in afara oricarui try/catch per-fisier');
  const snippet = melodiaMea.slice(forEachEnd, forEachEnd + 300);
  assert.ok(snippet.includes('renderQueueList();'));
  assert.ok(snippet.includes('processUploadQueue();'));
  assert.ok(snippet.includes('updateMemoriesCountAndGates(memOrderRef)'));
});

test('melodia-mea.html: FileList e citit SINCRON, imediat la inceputul handler-ului de change (niciun await inainte) — previne pierderea selectiei pe iOS', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change', () => {");
  assert.notEqual(idx, -1, 'handler-ul trebuie sa ramana sincron (fara async), ca Array.from(...) sa citeasca FileList-ul imediat');
  const snippet = melodiaMea.slice(idx, idx + 120);
  assert.ok(snippet.includes('const files = Array.from(memFileInput.files);'));
});

test('melodia-mea.html: mesajul existent memories_no_files_selected ramane reutilizat (niciun mesaj/modal nou adaugat)', () => {
  const occurrences = (melodiaMea.match(/memories_no_files_selected:/g) || []).length;
  assert.equal(occurrences, 8, 'cheia trebuie sa ramana definita in toate cele 8 limbi, neschimbata');
});

test('melodia-mea.html: mesajul memories_upload_error (reutilizat pentru intrarile esuate la construire) ramane definit in toate cele 8 limbi', () => {
  const occurrences = (melodiaMea.match(/memories_upload_error:/g) || []).length;
  assert.equal(occurrences, 8);
});

// ---------------------------------------------------------------------------------------------
// 3. Limitele si mecanismul de concurenta raman neschimbate.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: MEM_MIN=3 si MEM_MAX=10 raman neschimbate', () => {
  assert.match(melodiaMea, /const MEM_MIN = 3;/);
  assert.match(melodiaMea, /const MEM_MAX = 10;/);
});

// REVIZUIT (2026-08-14, "elimină plafonul artificial de 150MB"): UPLOAD_TIMEOUT_MS marit de la
// 2 la 15 minute — vezi test/video-media-limits.test.js pentru testul dedicat noii valori.
test('melodia-mea.html: MAX_CONCURRENT_UPLOADS ramane neschimbat (mecanismul de coada de la hotfixul anterior)', () => {
  assert.match(melodiaMea, /const MAX_CONCURRENT_UPLOADS = 2;/);
});

// REVIZUIT (2026-08-14, "Articolele nu pot fi încărcate" pe iPhone): acceptul explicit,
// listand MIME-uri individuale (inclusiv "image/x-adobe-dng", nestandard), a fost inlocuit cu
// wildcard-uri simple — vezi test/video-ios-multi-select-upload.test.js pentru testele dedicate
// noii corectii. Validarea reala de continut (magic bytes + ffprobe) ramane STRICT server-side,
// neschimbata — vezi ORDER_MEDIA_MIME_TYPES in server.js.
test('melodia-mea.html: acceptul de fisiere foloseste wildcard-uri simple (image/*,video/*), compatibile cu selectorul nativ iOS', () => {
  assert.ok(melodiaMea.includes('accept="image/*,video/*"'));
});

test('melodia-mea.html: inputul de fisiere ramane un singur element static in HTML (id="mem-file-input"), niciodata reconstruit dintr-un template — listenerul nu se poate pierde la re-randare', () => {
  const occurrences = (melodiaMea.match(/id="mem-file-input"/g) || []).length;
  assert.equal(occurrences, 1, 'trebuie sa existe exact un singur element cu acest id, definit static in HTML');
  assert.ok(!melodiaMea.includes('mem-file-input"></input>') , 'inputul nu trebuie generat dintr-un string de template JS');
});

test('melodia-mea.html: renderMemories()/renderAwaitingMedia() nu ating/recreaza #mem-file-input — doar reparenteaza #memories-section (mutare, nu recreare)', () => {
  const idx = melodiaMea.indexOf('function renderMemories(order) {');
  const end = melodiaMea.indexOf('\n  }', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(!snippet.includes('mem-file-input'), 'renderMemories() nu trebuie sa recreeze/atinga inputul de fisiere');
});

// ---------------------------------------------------------------------------------------------
// 4. Sintaxa ramane valida.
// ---------------------------------------------------------------------------------------------
test('public/comanda.html si public/melodia-mea.html: scriptul inline ramane sintactic valid', () => {
  [comanda, melodiaMea].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 1);
    scripts.forEach(m => { new Function(m[1]); });
  });
});
