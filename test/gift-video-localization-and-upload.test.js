// Teste pentru CORECȚIA 2026-08-24 — (1) fluidizarea selectiei/uploadului de materiale pe
// iPhone (thumbnailuri mici in loc de fisiere originale, pickerLocked care nu mai blocheaza 5
// minute fara feedback) — SI CORECȚIA 2026-08-29 — (2) eliminarea COMPLETA a cue-ului
// introductiv "Pentru Maria"/"For Maria" si sincronizarea reala a versurilor cu cuvintele
// aliniate (alignedWords), fara preroll/postroll/limite arbitrare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const melodia = read('public/melodia-mea.html');
const storageJs = read('storage.js');
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): coada de
// upload/thumbnailuri locale/picker-lock (sectiunile 5-6 de mai jos) au fost MUTATE din
// melodia-mea.html in public/amintiri-video.html — retargetat STRICT aceasta pagina.
const amintiriVideo = read('public/amintiri-video.html');

function extractFn(name) {
  let idx = server.indexOf('function ' + name + '(');
  const asyncIdx = server.lastIndexOf('async ', idx);
  if (asyncIdx !== -1 && server.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;
  assert.ok(idx !== -1, `nu am gasit functia ${name} in server.js`);
  let depth = 0, i = server.indexOf('{', idx);
  const start = idx;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}
function extractConst(name) {
  const idx = server.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `nu am gasit constanta ${name} in server.js`);
  const end = server.indexOf(';', idx);
  return server.slice(idx, end + 1);
}

function loadCaptionHelpers() {
  const src = [
    extractFn('stripSpanningNotes'),
    extractConst('MAX_SINGLE_WORD_HOLD_SECONDS'),
    extractConst('CAPTION_PAUSE_SPLIT_SECONDS'),
    extractFn('buildCaptionLines'),
    extractFn('escapeAssText'),
    'const ASS_MAX_CHARS_PER_LINE = 30;',
    extractFn('wrapAssTextTwoLines'),
    extractFn('assTimestamp'),
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('ASS_STYLE_REFERENCE_WIDTH'),
    extractConst('ASS_STYLE_SCALE'),
    extractFn('scaledAssStyleValue'),
    extractFn('toAss'),
    'return { buildCaptionLines, escapeAssText, wrapAssTextTwoLines, assTimestamp, toAss, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT };'
  ].join('\n\n');
  return new Function(src)();
}
const { buildCaptionLines, escapeAssText, toAss, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT } = loadCaptionHelpers();

// ---------------------------------------------------------------------------------------------
// 1) Eliminarea COMPLETA a introului "Pentru Maria"/"For Maria" — nu doar ascuns, nu inlocuit.
// ---------------------------------------------------------------------------------------------
test('server.js: INTRO_CAPTION_BY_LANG/buildIntroCaptionText/isIntro nu mai exista NICAIERI ca DECLARATII/APELURI reale — cod mort eliminat complet, nu doar ascuns (un comentariu istoric poate mentiona numele, dar nu declarat/apelat)', () => {
  assert.ok(!server.includes('const INTRO_CAPTION_BY_LANG ='), 'constanta nu mai trebuie declarata');
  assert.ok(!server.includes('function buildIntroCaptionText'), 'functia nu mai trebuie declarata');
  assert.ok(!server.includes('buildIntroCaptionText('), 'functia nu mai trebuie apelata de nicaieri');
  assert.ok(!server.includes('isIntro:'), 'niciun obiect nu mai trebuie sa seteze proprietatea isIntro');
  assert.ok(!server.includes('.isIntro'), 'niciun cod nu mai trebuie sa citeasca proprietatea isIntro');
  assert.ok(!server.includes("Style: Title,"), 'stilul ASS "Title", folosit STRICT de introul eliminat, nu mai trebuie sa existe');
});

test('server.js: buildCaptionLines() nu mai primeste recipient/lang (parametrii erau folositi STRICT pentru introul eliminat)', () => {
  assert.match(server, /function buildCaptionLines\(rawAlignedWords\) \{/);
  const idx = server.indexOf('const captionLines = buildCaptionLines(');
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 100);
  assert.match(snippet, /buildCaptionLines\(body\.data\.alignedWords\)/);
});

function w(word, startS, endS, success = true) {
  return { word, startS, endS, success };
}

test('buildCaptionLines: NICIUN cue introductiv — prima linie incepe EXACT la startS-ul primului cuvant cantat, niciodata la 0', () => {
  const aligned = [w('Draga ', 3.2, 3.6), w('mea\n', 3.6, 4.0)];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].start, 3.2, 'cue-ul trebuie sa inceapa EXACT la startS-ul primului cuvant, fara preroll');
  assert.ok(!/pentru|for /i.test(lines[0].text), 'niciun text introductiv nu trebuie sa apara');
});

test('buildCaptionLines: un cue se termina EXACT la endS-ul ultimului cuvant cantat — fara postroll', () => {
  const aligned = [w('Ultimul ', 5.0, 5.4), w('cuvant', 5.4, 5.9)];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].end, 5.9, 'cue-ul trebuie sa se termine EXACT la endS-ul ultimului cuvant, fara postroll');
});

test('buildCaptionLines: o pauza mare INTRE doua cuvinte (peste CAPTION_PAUSE_SPLIT_SECONDS), chiar fara salt de linie explicit, desparte cue-ul in doua — nu tine propozitia pe ecran peste o pauza instrumentala', () => {
  // "Primul vers " la 2.0-2.6, apoi o pauza instrumentala de 3s, apoi "al doilea vers" la 5.6-6.2
  // — TOATE pe acelasi "rand" logic (fara \n intre ele) — trebuie despartite oricum.
  const aligned = [
    w('Primul ', 2.0, 2.3), w('vers ', 2.3, 2.6),
    w('al ', 5.6, 5.8), w('doilea ', 5.8, 6.0), w('vers', 6.0, 6.2)
  ];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 2, 'trebuie sa rezulte doua cue-uri separate, nu unul singur care sa acopere si pauza');
  assert.equal(lines[0].start, 2.0);
  assert.equal(lines[0].end, 2.6, 'primul cue nu trebuie sa se intinda peste pauza');
  assert.equal(lines[1].start, 5.6, 'al doilea cue nu trebuie sa inceapa mai devreme de propriul prim cuvant');
  assert.equal(lines[1].end, 6.2);
});

test('buildCaptionLines: o pauza MICA intre cuvinte (sub prag) NU desparte cue-ul — ramane un singur vers natural', () => {
  const aligned = [w('Cuvinte ', 1.0, 1.4), w('apropiate', 1.7, 2.1)]; // gap 0.3s, sub prag
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1, 'un gol mic (respiratie normala intre cuvinte) nu trebuie sa desparta cue-ul');
});

test('buildCaptionLines: o anomalie de aliniere PE UN SINGUR CUVANT (durata proprie aberanta) e clampata STRICT pe acel cuvant, niciodata lasata sa produca un cue de 10+ secunde', () => {
  // cuvant cu o durata proprie aberanta (real, gasit in date Suno: startS=0.58, endS=14.04) —
  // fara clamp per-cuvant, cue-ul ar dura >13s pentru un singur cuvant afisat.
  const aligned = [w('Cuvant', 0.58, 14.04)];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].end - lines[0].start <= 4, `cuvantul anomal trebuie clampat la MAX_SINGLE_WORD_HOLD_SECONDS, a rezultat o durata de ${lines[0].end - lines[0].start}s`);
  assert.equal(lines[0].end, 0.58 + 4, 'end-ul trebuie sa fie EXACT startS + MAX_SINGLE_WORD_HOLD_SECONDS');
});

test('buildCaptionLines: dupa o anomalie clampata, urmatorul cuvant real (departe in timp) porneste un cue NOU, separat — anomalia nu "trage" restul versului dupa ea', () => {
  const aligned = [w('Cuvant', 0.58, 14.04), w(' normal', 14.5, 15.0)];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 2, 'gap-ul mare (dupa clamp) fata de urmatorul cuvant trebuie sa desparta cue-urile');
  assert.equal(lines[0].end, 4.58);
  assert.equal(lines[1].start, 14.5);
});

test('buildCaptionLines: un vers legitim, LUNG (multe cuvinte, fiecare cu durata normala) NU mai e taiat de limita veche arbitrara de 7 secunde', () => {
  // 10 cuvinte a cate 1s fiecare = 10s total, fiecare cuvant cu o durata normala (fara anomalie).
  const aligned = [];
  for (let i = 0; i < 10; i++) aligned.push(w(`cuvant${i} `, i * 1.0, i * 1.0 + 0.9));
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1, 'toate cuvintele, fara pauze mari intre ele, trebuie sa ramana intr-un singur cue');
  assert.equal(lines[0].start, 0);
  assert.equal(lines[0].end, 9.9, `versul legitim de ${9.9}s NU trebuie taiat la vechea limita de 7s`);
});

test('buildCaptionLines: cuvinte fara success:true sau fara startS/endS numeric sunt ignorate complet (niciodata folosite pentru a construi un cue)', () => {
  const aligned = [
    { word: '[Chorus]', startS: 0, endS: 0, success: false },
    w('Cuvant ', 2.0, 2.4),
    { word: 'ignorat', success: true }, // fara startS/endS numeric
    w('real', 2.4, 2.8)
  ];
  const lines = buildCaptionLines(aligned);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Cuvant real');
});

// ---------------------------------------------------------------------------------------------
// 2) Escapare sigura ASS — nume/text cu apostrof, doua puncte, procent, backslash, newline.
// ---------------------------------------------------------------------------------------------
test('escapeAssText: pastreaza apostroful, doua puncte si procentul (nu sunt speciale in ASS) — elimina STRICT backslash-uri, linii noi si acolade (coduri de control/override reale)', () => {
  assert.equal(escapeAssText("O'Brien: 100%"), "O'Brien: 100%");
  assert.equal(escapeAssText('nume\\cu\\backslash'), 'numecubackslash');
  assert.equal(escapeAssText('linie unu\nlinie doi'), 'linie unu linie doi');
  assert.equal(escapeAssText('linie unu\r\nlinie doi'), 'linie unu linie doi');
  assert.equal(escapeAssText('text {override} periculos'), 'text (override) periculos');
  assert.equal(escapeAssText(null), '');
  assert.equal(escapeAssText(undefined), '');
});

test('toAss: un text cu toate caracterele periculoase simultan produce un fisier .ass valid, fara sa injecteze coduri de control/override — foloseste STRICT stilul Lyrics (singurul ramas dupa eliminarea introului)', () => {
  const dangerousText = "O'Brien: 100% \\{override}\ndanger";
  const ass = toAss([{ start: 0, end: 3, text: dangerousText }]);
  assert.ok(!ass.includes('\\{'), 'nu trebuie sa apara acolade de override in text');
  assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:03.00,Lyrics,,0,0,0,,'), 'evenimentul Dialogue trebuie construit corect, cu stilul Lyrics');
  // Backslash-ul din text a fost eliminat — singurele backslash-uri ramase in fisier sunt
  // codurile REALE \N (rand nou) introduse explicit de wrapAssTextTwoLines(), niciodata altele.
  const textLine = ass.split('\n').find(l => l.startsWith('Dialogue:'));
  const afterLastComma = textLine.slice(textLine.lastIndexOf(',,') + 2);
  assert.ok(!/\\[^N]/.test(afterLastComma.replace(/\\N/g, '')), 'niciun backslash neasteptat nu trebuie sa ramana in textul evenimentului');
});

// ---------------------------------------------------------------------------------------------
// 3) Font/UTF-8 — fisierul .ass e scris explicit ca UTF-8, PlayRes potrivit rezolutiei reale.
// ---------------------------------------------------------------------------------------------
test('server.js: fisierul .ass e scris explicit ca UTF-8', () => {
  assert.match(server, /fs\.writeFileSync\(assPath, toAss\(captionLines\), 'utf8'\);/);
});
test('toAss: PlayResX/PlayResY corespund EXACT rezolutiei REALE curente a videoclipului (extrase dinamic din MEMORY_VIDEO_WIDTH/HEIGHT — niciodata hardcodate in test, ca sa ramana corect si dupa o schimbare de rezolutie a pipeline-ului)', () => {
  const ass = toAss([{ start: 0, end: 1, text: 'test' }]);
  assert.match(ass, new RegExp(`PlayResX: ${MEMORY_VIDEO_WIDTH}(?!\\d)`));
  assert.match(ass, new RegExp(`PlayResY: ${MEMORY_VIDEO_HEIGHT}(?!\\d)`));
});

// ---------------------------------------------------------------------------------------------
// 4) Comenzi vechi raman compatibile — order.lang absent nu blocheaza randarea (buildCaptionLines
// nici nu mai foloseste order.lang, de cand introul care il consuma a fost eliminat complet).
// ---------------------------------------------------------------------------------------------
test('server.js: generateLyricVideo() nu impune ca order.lang sa existe — randarea continua indiferent', () => {
  const idx = server.indexOf('async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 3000);
  assert.ok(!snippet.includes("if (!order.lang)"), 'nu trebuie sa existe nicio verificare care sa blocheze randarea la lipsa lui order.lang');
});

// ---------------------------------------------------------------------------------------------
// 5) iPhone — thumbnailuri mici server-side (nu mai serveste fisierul original ca preview).
// ---------------------------------------------------------------------------------------------
test('server.js: ensureMediaThumbnail() exista si genereaza un thumbnail MIC, cache-uit, in loc sa semneze direct fisierul original', () => {
  assert.match(server, /async function ensureMediaThumbnail\(item\) \{/);
  assert.match(server, /const MEDIA_THUMB_MAX_DIM = 480;/);
});

test('server.js: GET /media/:index/preview-url foloseste thumbKey (ensureMediaThumbnail), cu fallback SIGUR pe fisierul original doar daca generarea esueaza', () => {
  const idx = server.indexOf("app.get('/api/orders/:orderId/media/:index/preview-url'");
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 1200);
  assert.match(snippet, /thumbKey = await ensureMediaThumbnail\(item\);/);
  assert.match(snippet, /const url = await storage\.getSignedDownloadUrl\(thumbKey \|\| item\.key, 300\);/);
});

test('storage.js: privateFileExists() foloseste STRICT HEAD (nu descarca fisierul) pentru verificarea existentei unui thumbnail cache-uit', () => {
  assert.match(storageJs, /async function privateFileExists\(key\) \{/);
  assert.match(storageJs, /new HeadObjectCommand\(\{ Bucket: PRIVATE_BUCKET, Key: key \}\)/);
});

test('server.js: thumbnailul e generat citind DIRECT din URL-ul semnat (ffmpeg suporta HTTP) — nu descarca intreg fisierul original pe disc doar pentru un cadru mic', () => {
  const idx = server.indexOf('async function ensureMediaThumbnail(item) {');
  const snippet = server.slice(idx, idx + 1400);
  assert.match(snippet, /const sourceUrl = await storage\.getSignedDownloadUrl\(item\.key, 120\);/);
  assert.ok(!snippet.includes('downloadFile('), 'nu trebuie sa descarce fisierul original pe disc pentru thumbnail');
});

test('amintiri-video.html: coada locala de materiale NU mai foloseste URL.createObjectURL(file) direct pe fisierul original ca thumbnail — genereaza un thumbnail MIC client-side (createImageBitmap + canvas)', () => {
  const idx = amintiriVideo.indexOf("memFileInput.addEventListener('change'");
  assert.ok(idx !== -1);
  const snippet = amintiriVideo.slice(idx, idx + 4600);
  assert.ok(!snippet.includes('thumbUrl: URL.createObjectURL(file)'), 'construirea intrarii NU mai trebuie sa atribuie thumbUrl direct din fisierul original (vechiul tipar)');
  assert.match(snippet, /thumbUrl: null,/);
  assert.match(snippet, /scheduleLocalThumbnail\(entry\)/);
});

test('amintiri-video.html: generateLocalThumbnail() foloseste createImageBitmap cu resizeWidth (decodare la rezolutie MICA, nu decodarea completa a fotografiei originale doar pentru afisare)', () => {
  assert.match(amintiriVideo, /createImageBitmap\(entry\.file, \{ resizeWidth: LOCAL_THUMB_MAX_DIM, resizeQuality: 'medium' \}\)/);
  assert.match(amintiriVideo, /const LOCAL_THUMB_MAX_DIM = 240;/);
});

test('amintiri-video.html: generarea thumbnailurilor locale ruleaza cu CONCURENTA LIMITATA (1 deodata), niciodata toate simultan', () => {
  assert.match(amintiriVideo, /const LOCAL_THUMB_CONCURRENCY = 1;/);
  assert.match(amintiriVideo, /function pumpLocalThumbQueue\(\) \{/);
});

test('amintiri-video.html: nu instantiaza niciodata FileReader() sau apeleaza file.arrayBuffer() pe fisierul complet in fluxul de materiale (doar mentionat in comentarii ca exemplu de EVITAT)', () => {
  assert.ok(!amintiriVideo.includes('new FileReader('), 'nu trebuie instantiat niciun FileReader() — ar decodifica fisierul complet in memorie');
  const memSection = amintiriVideo.slice(amintiriVideo.indexOf('let uploadQueue = []'), amintiriVideo.indexOf('const memFileInput = document.getElementById'));
  assert.ok(!memSection.includes('.arrayBuffer()'), 'nu trebuie folosit file.arrayBuffer() pe fisierul complet');
});

test('amintiri-video.html: lista materialelor se randeaza IMEDIAT, sincron, inainte de orice operatiune costisitoare (thumbnailuri/upload pornesc DUPA)', () => {
  const idx = amintiriVideo.indexOf("memFileInput.addEventListener('change'");
  const snippet = amintiriVideo.slice(idx, idx + 4600);
  const renderIdx = snippet.indexOf('renderQueueList();');
  const uploadIdx = snippet.indexOf('processUploadQueue();');
  const thumbIdx = snippet.indexOf('newEntries.forEach(entry =>');
  assert.ok(renderIdx !== -1 && uploadIdx !== -1 && thumbIdx !== -1);
  assert.ok(renderIdx < uploadIdx, 'lista trebuie randata inainte de a porni uploadul');
  assert.ok(renderIdx < thumbIdx, 'lista trebuie randata inainte de a porni generarea thumbnailurilor');
});

// ---------------------------------------------------------------------------------------------
// 6) iPhone — pickerLocked nu mai blocheaza 5 minute fara feedback vizibil.
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: plafonul AUTOMAT de recuperare a selectorului a fost redus semnificativ fata de 5 minute (afordanta explicita devine calea normala de recuperare, nu plafonul orb)', () => {
  assert.match(amintiriVideo, /const PICKER_MANUAL_RECOVERY_MS = 90 \* 1000;/);
  assert.ok(!amintiriVideo.includes('const PICKER_MANUAL_RECOVERY_MS = 5 * 60 * 1000;'), 'vechiul plafon de 5 minute nu mai trebuie sa existe');
});

test('amintiri-video.html: visibilitychange/focus/pageshow declanseaza o afordanta EXPLICITA de renuntare ("Renunță și încearcă din nou"), NU deblocheaza automat si NU redeschid galeria', () => {
  assert.match(amintiriVideo, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) handlePickerPossibleReturn\(\); \}\);/);
  assert.match(amintiriVideo, /window\.addEventListener\('focus', handlePickerPossibleReturn\);/);
  assert.match(amintiriVideo, /window\.addEventListener\('pageshow', \(event\) => \{ if \(event\.persisted\) handlePickerPossibleReturn\(\); \}\);/);
  const idx = amintiriVideo.indexOf('function showPickerWaitingMessage() {');
  const snippet = amintiriVideo.slice(idx, idx + 700);
  assert.ok(!snippet.includes('.click()'), 'afordanta NU trebuie sa redeschida automat selectorul (niciun .click() programatic)');
  assert.ok(!snippet.includes('memFileInput.click'));
  assert.match(snippet, /retryBtn\.addEventListener\('click', \(\) => \{\s*pickerLocked = false;/, 'deblocarea ramane STRICT la apasarea explicita a utilizatorului');
});

test('amintiri-video.html: change/cancel raman sursa AUTORITATIVA de deblocare (neschimbate) — o selectie reala sau o anulare reala tot deblocheaza imediat, independent de afordanta explicita', () => {
  const changeIdx = amintiriVideo.indexOf("memFileInput.addEventListener('change', () => {");
  assert.match(amintiriVideo.slice(changeIdx, changeIdx + 150), /pickerLocked = false;/);
  const cancelIdx = amintiriVideo.indexOf("memFileInput.addEventListener('cancel', () => {");
  assert.match(amintiriVideo.slice(cancelIdx, cancelIdx + 150), /pickerLocked = false;/);
});

['memories_picker_waiting', 'memories_picker_retry'].forEach(key => {
  test(`melodia-mea.html: cheia de traducere "${key}" exista in toate cele 8 limbi`, () => {
    const re = new RegExp(`[{,]\\s*${key}:`, 'g');
    const count = (melodia.match(re) || []).length;
    assert.equal(count, 8, `"${key}" trebuie sa existe o data per limba, gasita de ${count} ori`);
  });
});

test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
test('storage.js: node --check storage.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'storage.js')]));
});
