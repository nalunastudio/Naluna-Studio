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
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): coada de
// materiale (sectiunile 2-3 de mai jos) a fost MUTATA din melodia-mea.html in
// public/amintiri-video.html — retargetat STRICT aceasta pagina.
const amintiriVideo = read('public/amintiri-video.html');

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
// RELANSARE (2026-08-14, "cardurile apar greu/inegal"): continutul per-material (iconita,
// nume, stare) a fost extras din renderQueueList() (acum STRICT rebuild complet, la schimbari
// structurale) intr-o functie dedicata renderQueueRowInner(q), refolosita si de patch-ul direct
// de progres — vezi test/video-comanda-succes-upload-queue.test.js pentru acoperirea completa
// a noii arhitecturi (throttling, single-flight sync, upload fragmentat).
test('amintiri-video.html: renderQueueRowInner() NU mai construieste niciun element <video> local (blob) pentru videoclipurile din coada de asteptare', () => {
  const idx = amintiriVideo.indexOf('function renderQueueRowInner(q) {');
  assert.notEqual(idx, -1);
  const end = amintiriVideo.indexOf('\n  }', idx);
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(!snippet.includes('<video'), 'coada de asteptare (inainte de upload) nu mai trebuie sa randeze niciun <video src="blob:...">');
  assert.ok(snippet.includes("isVideoFile(q.file) ? '🎬'"), 'videoclipurile din coada trebuie sa foloseasca STRICT iconita statica (isVideoFile — vezi test/video-media-limits.test.js pentru fallback-ul pe extensie cand MIME e gol)');
});

test('amintiri-video.html: fotografiile din coada de asteptare raman randate ca <img> din blob local, neschimbat', () => {
  const idx = amintiriVideo.indexOf('function renderQueueRowInner(q) {');
  const end = amintiriVideo.indexOf('\n  }', idx);
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(snippet.includes('<img src="${q.thumbUrl}" alt="" loading="lazy" decoding="async">'));
});

// CORECȚIE (2026-08-24, "iPhone: pagina se blocheaza/raspunde greu"): thumbUrl NU se mai
// atribuie SINCRON din fisierul original (URL.createObjectURL(file) forta Safari sa decodeze
// o fotografie originala la rezolutie completa doar pentru un thumbnail mic) — porneste gol
// si e populat ASINCRON, controlat, cu un thumbnail MIC (createImageBitmap + canvas), STRICT
// pentru fotografii (videoclipurile raman pe iconita, niciodata trimise la generarea de
// thumbnail — vezi scheduleLocalThumbnail, apelat doar cand !isVideoFile(entry.file)).
// CORECȚIE (2026-08-30/31, Cerintele 4/5): logica de constructie a cozii (thumbUrl, try/catch
// per fisier, forEach, randare) a fost mutata din handler-ul de 'change' in functia comuna
// handleFilesReceived(files) — folosita acum de AMBELE selectoare (principal + fallback "Alege
// din Fisiere"). Verificam functia comuna, nu handler-ul de 'change' (care doar copiaza FileList
// sincron si deleaga).
test('amintiri-video.html: thumbUrl porneste gol si e populat asincron STRICT pentru fotografii (scheduleLocalThumbnail) — niciun videoclip din coada nu e trimis la generarea de thumbnail', () => {
  const idx = amintiriVideo.indexOf('function handleFilesReceived(files) {');
  assert.notEqual(idx, -1);
  const end = amintiriVideo.indexOf('newEntries.forEach(entry =>', idx) + 200;
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(snippet.includes('thumbUrl: null,'));
  assert.ok(snippet.includes('newEntries.forEach(entry => { if (!isVideoFile(entry.file)) scheduleLocalThumbnail(entry); });'));
});

test('amintiri-video.html: fiecare fisier din selectie e adaugat in coada intr-un try/catch — o exceptie la un singur fisier nu mai opreste tot handler-ul de change', () => {
  const idx = amintiriVideo.indexOf('function handleFilesReceived(files) {');
  assert.notEqual(idx, -1);
  const end = amintiriVideo.indexOf('renderQueueList();', idx);
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(snippet.includes('files.forEach(file => {'));
  assert.ok(snippet.includes('try {'));
  assert.ok(snippet.includes('} catch (err) {'));
  assert.ok(snippet.includes("status: 'error'"), 'un fisier care esueaza la construire trebuie marcat vizibil ca eroare, nu ignorat tacit');
});

test('amintiri-video.html: renderQueueList() se apeleaza necondiționat dupa forEach, indiferent daca vreun fisier a esuat la construire', () => {
  const idx = amintiriVideo.indexOf('function handleFilesReceived(files) {');
  const forEachStart = amintiriVideo.indexOf('files.forEach(file => {', idx);
  assert.notEqual(forEachStart, -1);
  const forEachEnd = amintiriVideo.indexOf('});', forEachStart) + 3;
  const snippet = amintiriVideo.slice(forEachEnd, forEachEnd + 600);
  assert.ok(snippet.includes('renderQueueList();'), 'renderQueueList() trebuie apelat neconditionat dupa forEach, in afara oricarui try/catch per-fisier');
  // updateMemoriesCountAndGates() nu mai e apelat separat aici — RELANSARE 2026-08-14, mutat
  // ca parte STRUCTURALA a renderQueueList() insusi (se apeleaza de fiecare data cand coada e
  // rebuilduita complet, deci si aici, si de la orice alt apel al renderQueueList()).
  const renderQueueListIdx = amintiriVideo.indexOf('function renderQueueList() {');
  const renderQueueListEnd = amintiriVideo.indexOf('\n  }', renderQueueListIdx);
  assert.ok(amintiriVideo.slice(renderQueueListIdx, renderQueueListEnd).includes('updateMemoriesCountAndGates(memOrderRef)'));
});

test('amintiri-video.html: FileList e citit SINCRON, imediat la inceputul handler-ului de change (niciun await inainte) — previne pierderea selectiei pe iOS', () => {
  const idx = amintiriVideo.indexOf("memFileInput.addEventListener('change', () => {");
  assert.notEqual(idx, -1, 'handler-ul trebuie sa ramana sincron (fara async), ca Array.from(...) sa citeasca FileList-ul imediat');
  const snippet = amintiriVideo.slice(idx, idx + 250);
  assert.ok(snippet.includes('const files = Array.from(memFileInput.files);'));
  assert.ok(!/\basync\s*\(\s*\)\s*=>/.test(amintiriVideo.slice(idx, idx + 55)), 'handler-ul nu trebuie sa devina async');
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
// 3. Limita minima si mecanismul de concurenta raman neschimbate; maximul a fost ridicat explicit
//    (2026-08-31, "mărește limita de la 10 la 30 de materiale").
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: MEM_MIN=3, MEM_MAX=30', () => {
  assert.match(amintiriVideo, /const MEM_MIN = 3;/);
  assert.match(amintiriVideo, /const MEM_MAX = 30;/);
});

// REVIZUIT (2026-08-14, "elimină plafonul artificial de 150MB"): UPLOAD_TIMEOUT_MS marit de la
// 2 la 15 minute — vezi test/video-media-limits.test.js pentru testul dedicat noii valori.
test('amintiri-video.html: MAX_CONCURRENT_UPLOADS ramane neschimbat (mecanismul de coada de la hotfixul anterior)', () => {
  assert.match(amintiriVideo, /const MAX_CONCURRENT_UPLOADS = 2;/);
});

// REVIZUIT (2026-08-14, "Articolele nu pot fi încărcate" pe iPhone): acceptul explicit,
// listand MIME-uri individuale (inclusiv "image/x-adobe-dng", nestandard), a fost inlocuit cu
// wildcard-uri simple — vezi test/video-ios-multi-select-upload.test.js pentru testele dedicate
// noii corectii. Validarea reala de continut (magic bytes + ffprobe) ramane STRICT server-side,
// neschimbata — vezi ORDER_MEDIA_MIME_TYPES in server.js.
test('amintiri-video.html: acceptul de fisiere foloseste wildcard-uri simple (image/*,video/*), compatibile cu selectorul nativ iOS', () => {
  assert.ok(amintiriVideo.includes('accept="image/*,video/*"'));
});

test('amintiri-video.html: inputul de fisiere ramane un singur element static in HTML (id="mem-file-input"), niciodata reconstruit dintr-un template — listenerul nu se poate pierde la re-randare', () => {
  const occurrences = (amintiriVideo.match(/id="mem-file-input"/g) || []).length;
  assert.equal(occurrences, 1, 'trebuie sa existe exact un singur element cu acest id, definit static in HTML');
  assert.ok(!amintiriVideo.includes('mem-file-input"></input>') , 'inputul nu trebuie generat dintr-un string de template JS');
});

test('amintiri-video.html: renderMemories() nu atinge/recreaza #mem-file-input — doar randeaza listele de materiale (mutare, nu recreare)', () => {
  const idx = amintiriVideo.indexOf('function renderMemories(order) {');
  assert.notEqual(idx, -1);
  const end = amintiriVideo.indexOf('\n  }', idx);
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(!snippet.includes('mem-file-input'), 'renderMemories() nu trebuie sa recreeze/atinga inputul de fisiere');
});

// ---------------------------------------------------------------------------------------------
// 4. Sintaxa ramane valida.
// ---------------------------------------------------------------------------------------------
test('public/comanda.html, public/melodia-mea.html si public/amintiri-video.html: scriptul inline ramane sintactic valid', () => {
  [comanda, melodiaMea, amintiriVideo].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 1);
    scripts.forEach(m => { new Function(m[1]); });
  });
});
