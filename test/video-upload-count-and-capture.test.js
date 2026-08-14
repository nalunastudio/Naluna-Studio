// Test de regresie pentru corectia urgenta (2026-08-14, runda 2, "corectia anterioara nu e
// finalizata"), exclusiv pachetul "Cadou video":
//
// 1) Textul static "max. 150MB per fișier" (memories_meta) fusese UITAT in runda anterioara —
//    corectasem STRICT plafonul real (ORDER_MEDIA_MAX_BYTES) si mesajul DINAMIC de eroare, dar
//    acest hint STATIC, afisat mereu langa widget, inca mentiona textual limita veche — exact
//    dovada aratata live ("Interfața afișează în continuare: 'max. 150MB per fișier'").
//
// 2) Numărul de materiale afisat clientului ("2 materiale" cand selectase 5) conta STRICT
//    materialele deja CONFIRMATE de server (order.uploadedMedia) — cat timp restul selectiei
//    era inca in coada/se incarca (normal pentru videoclipuri mari, acum cu upload-uri de pana
//    la 15 minute), numarul vizibil ramanea mai mic decat selectia reala, dand impresia ca
//    materiale au "disparut". Corectat sa arate explicit si cate materiale sunt inca in curs.
//
// 3) Iconita locala a unui videoclip cu MIME gol (posibil pe iOS, pentru fisiere inca
//    nematerializate din iCloud) aparea gresit ca fotografie — corectat cu fallback pe extensie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const melodiaMea = read('public/melodia-mea.html');

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ---------------------------------------------------------------------------------------------
// 1. Niciun text vizibil nu mai mentioneaza 150MB, in nicio limba — verificat STRICT pe
//    memories_meta (hint-ul static), care fusese uitat in runda anterioara.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: memories_meta (hint-ul static "Între 3 și 10 materiale...") nu mai contine "150MB" in nicio limba', () => {
  const occurrences = (melodiaMea.match(/memories_meta: \(min, max\) => `[^`]*`/g) || []);
  assert.equal(occurrences.length, 8, 'trebuie sa existe exact 8 definitii memories_meta (una per limba)');
  occurrences.forEach(block => {
    assert.ok(!/150\s*MB/i.test(block), `memories_meta nu mai trebuie sa mentioneze 150MB — gasit in: ${block}`);
  });
});

test('melodia-mea.html: memories_meta (RO) foloseste exact formatul cerut, fara nicio limita arbitrara noua', () => {
  const idx = melodiaMea.indexOf('memories_meta: (min, max) => `Între');
  const end = melodiaMea.indexOf('`,', idx);
  const text = melodiaMea.slice(idx, end + 1);
  assert.ok(text.includes('Între ${min} și ${max} materiale'));
  assert.ok(text.includes('JPG, PNG, HEIC, DNG, MP4, MOV, WebM'));
  assert.ok(text.includes('orice combinație de poze și videoclipuri'));
  assert.ok(!/\d+\s*(MB|Mo|GB)/i.test(text), 'nu trebuie adaugata nicio alta limita de dimensiune in text');
});

test('nicio urma activa a plafonului de 150MB nu mai exista in codul activ (server.js, melodia-mea.html) — doar in comentarii istorice care documenteaza corectia', () => {
  const server = read('server.js');
  // "150 * 1024 * 1024" (constanta veche) nu mai trebuie sa existe deloc, nici in comentarii.
  assert.ok(!server.includes('150 * 1024 * 1024'));
  assert.ok(!melodiaMea.includes('150 * 1024 * 1024'));
  // "150MB"/"150 MB" ramane STRICT in comentarii care documenteaza explicit corectia (marcate
  // cu "elimină plafonul artificial") — niciodata in text afisat clientului (verificat separat,
  // mai sus, prin memories_meta) sau in vreo validare activa.
  const activeCodeLines = (server + '\n' + melodiaMea).split('\n').filter(line => /150\s*MB/i.test(line));
  activeCodeLines.forEach(line => {
    assert.ok(line.trim().startsWith('//') || line.includes('elimină plafonul artificial'), `linia trebuie sa fie STRICT comentariu istoric, gasit: ${line}`);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Numarul afisat include explicit materialele inca in curs de incarcare — executie REALA.
// ---------------------------------------------------------------------------------------------
function loadMemoriesCountRo() {
  const idx = melodiaMea.indexOf('memories_count: (n, min, max, pending) =>');
  const end = melodiaMea.indexOf('),', idx) + 1;
  const src = melodiaMea.slice(idx, end).replace(/^memories_count: /, '');
  return new Function(`return ${src};`)();
}
const memoriesCountRo = loadMemoriesCountRo();

test('memories_count (RO): cu materiale inca in curs de incarcare, textul mentioneaza explicit cate — numarul vizibil nu mai pare "mai mic decat selectia"', () => {
  const textWithPending = memoriesCountRo(2, 3, 10, 3);
  assert.ok(textWithPending.includes('2'), 'trebuie sa arate numarul confirmat');
  assert.ok(textWithPending.includes('3'), 'trebuie sa arate si numarul in curs de incarcare');
  assert.ok(/în curs de încărcare/.test(textWithPending));
});

test('memories_count (RO): fara materiale in curs (pending=0), textul ramane EXACT ca inainte — niciun sufix inutil', () => {
  const text = memoriesCountRo(5, 3, 10, 0);
  assert.equal(text, '5 materiale — gata de continuare');
});

test('memories_count: functia primeste acum 4 parametri (n, min, max, pending), in toate cele 8 limbi', () => {
  const occurrences = (melodiaMea.match(/memories_count: \(n, min, max, pending\) =>/g) || []).length;
  assert.equal(occurrences, 8, 'toate cele 8 limbi trebuie sa accepte parametrul "pending"');
});

test('melodia-mea.html: updateMemoriesCountAndGates() calculeaza si transmite numarul de materiale in curs (uploading/pending) catre memories_count()', () => {
  const idx = melodiaMea.indexOf('function updateMemoriesCountAndGates(order) {');
  const end = melodiaMea.indexOf('\n  }', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes("const pendingCount = uploadQueue.filter(q => q.status === 'uploading' || q.status === 'pending' || q.status === 'processing').length;"));
  assert.ok(snippet.includes('t.memories_count(total, MEM_MIN, MEM_MAX, pendingCount)'));
});

// ---------------------------------------------------------------------------------------------
// 3. isVideoFile(): un MIME gol nu mai face ca un videoclip sa fie tratat ca fotografie —
//    executie REALA a functiei extrase din sursa.
// ---------------------------------------------------------------------------------------------
function loadIsVideoFile() {
  const src = extractFunction(melodiaMea, 'function isVideoFile(file) {');
  const constIdx = melodiaMea.indexOf("const VIDEO_EXTENSIONS = ");
  const constEnd = melodiaMea.indexOf(';', constIdx) + 1;
  const constSrc = melodiaMea.slice(constIdx, constEnd);
  return new Function(`${constSrc}\n${src}\nreturn isVideoFile;`)();
}
const isVideoFile = loadIsVideoFile();

test('isVideoFile(): fisier cu MIME "video/quicktime" (MOV real de pe iPhone) e recunoscut ca videoclip', () => {
  assert.equal(isVideoFile({ type: 'video/quicktime', name: 'IMG_1234.MOV' }), true);
});

test('isVideoFile(): fisier cu MIME "video/mp4" e recunoscut ca videoclip', () => {
  assert.equal(isVideoFile({ type: 'video/mp4', name: 'clip.mp4' }), true);
});

test('isVideoFile(): fisier cu MIME GOL, dar cu extensia .MOV (majuscule, tipic iPhone) e recunoscut ca videoclip prin fallback pe extensie', () => {
  assert.equal(isVideoFile({ type: '', name: 'IMG_5678.MOV' }), true);
});

test('isVideoFile(): fisier cu MIME GOL, extensia .mp4, e recunoscut ca videoclip', () => {
  assert.equal(isVideoFile({ type: '', name: 'video.mp4' }), true);
});

test('isVideoFile(): fisier cu MIME GOL, extensia .heic (fotografie), NU e tratat gresit ca videoclip', () => {
  assert.equal(isVideoFile({ type: '', name: 'IMG_0001.HEIC' }), false);
});

test('isVideoFile(): fisier cu MIME explicit "image/heic" ramane fotografie, indiferent de extensie', () => {
  assert.equal(isVideoFile({ type: 'image/heic', name: 'poza.heic' }), false);
});

test('melodia-mea.html: renderQueueRowInner() foloseste isVideoFile() (nu file.type.startsWith direct) pentru iconita din coada', () => {
  const idx = melodiaMea.indexOf('function renderQueueRowInner(q) {');
  assert.notEqual(idx, -1);
  const snippet = melodiaMea.slice(idx, idx + 500);
  assert.ok(snippet.includes('isVideoFile(q.file)'));
  assert.ok(!snippet.includes("q.file.type.startsWith('video')"));
});

// ---------------------------------------------------------------------------------------------
// 4. Capturarea intregii selectii — verificare structurala a handler-ului de `change`:
//    fiecare fisier din FileList e adaugat necondiționat in coada, indiferent de tip.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: handler-ul de change NU filtreaza dupa tip (photo/video) — fiecare fisier din FileList primeste o intrare in coada, fara exceptie', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change'");
  const end = melodiaMea.indexOf('processUploadQueue();', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes('files.forEach(file => {'), 'TOATE fisierele din FileList trebuie parcurse, nu doar files[0]');
  assert.ok(!snippet.includes('.filter('), 'niciun filtru care ar putea elimina videoclipuri sau fotografii din selectie');
  assert.ok(!/if\s*\(\s*file\.type/.test(snippet), 'nu trebuie sa existe nicio conditie care exclude fisiere dupa tip inainte de a le adauga in coada');
});

test('melodia-mea.html: FileList e copiat SINCRON intr-un array stabil (Array.from), inainte de orice alta operatie — nicio referinta pastrata la FileList-ul original peste operatii asincrone', () => {
  const idx = melodiaMea.indexOf("memFileInput.addEventListener('change', () => {");
  assert.notEqual(idx, -1, 'handler-ul trebuie sa ramana sincron (nu async), garantand ca Array.from ruleaza imediat, in acelasi tick cu evenimentul');
  const snippet = melodiaMea.slice(idx, idx + 250);
  assert.ok(snippet.includes('const files = Array.from(memFileInput.files);'));
});

test('melodia-mea.html: inputul e resetat DUPA copierea completa a FileList-ului (memFileInput.value dupa Array.from), niciodata inainte', () => {
  const idx = melodiaMea.indexOf('const files = Array.from(memFileInput.files);');
  const resetIdx = melodiaMea.indexOf("memFileInput.value = '';", idx);
  const between = melodiaMea.slice(idx, resetIdx);
  assert.ok(resetIdx > idx && resetIdx - idx < 250, 'resetarea trebuie sa vina la scurt timp dupa copiere, nu inainte');
  // STRICT diagnostic (no-op fara ?mediaDebug=1) poate aparea intre ele — nicio alta logica.
  assert.ok(!/if\s*\(|for\s*\(|files\.forEach|\.push\(/.test(between.replace(/mediaDebugLog\([^)]*\)/g, '')), 'intre copiere si resetare nu trebuie sa existe alta logica decat diagnosticul');
});

test('melodia-mea.html: eroarea la construirea unei intrari (try/catch per fisier) NU scoate fisierul din lot — e adaugat in coada cu status "error", vizibil, cu retry', () => {
  const idx = melodiaMea.indexOf('files.forEach(file => {');
  const end = melodiaMea.indexOf('processUploadQueue();', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes('} catch (err) {'));
  const catchIdx = snippet.indexOf('} catch (err) {');
  const catchBlock = snippet.slice(catchIdx, catchIdx + 300);
  assert.ok(catchBlock.includes('uploadQueue.push('), 'fisierul care esueaza la construire tot trebuie adaugat in coada, vizibil, nu ignorat');
  assert.ok(catchBlock.includes("status: 'error'"));
});

// ---------------------------------------------------------------------------------------------
// 5. Un singur input, un singur eveniment de confirmare — fara selectoare separate pentru
//    fotografii/videoclipuri, fara `capture`.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: inputul ramane unic, "multiple", accepta simultan image/* si video/*, fara atributul capture', () => {
  const inputMatch = melodiaMea.match(/<input type="file"[^>]*>/);
  assert.ok(inputMatch);
  const tag = inputMatch[0];
  assert.ok(/\bmultiple\b/.test(tag));
  assert.ok(tag.includes('accept="image/*,video/*"'));
  assert.ok(!tag.includes('capture'), 'atributul capture ar forta camera, blocand selectia din galerie — nu trebuie sa existe');
  const allInputs = (melodiaMea.match(/<input type="file"/g) || []).length;
  assert.equal(allInputs, 1, 'trebuie sa existe STRICT un singur input de fisiere pentru materiale');
});

// ---------------------------------------------------------------------------------------------
// 6. Sintaxa ramane valida; Standard/Premium neatinse.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ramane sintactic valid', () => {
  const scripts = [...melodiaMea.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach(m => { new Function(m[1]); });
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  const server = read('server.js');
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
