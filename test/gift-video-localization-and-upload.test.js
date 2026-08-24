// Teste pentru CORECȚIA 2026-08-24 — (2) localizarea textului introductiv al videoclipului
// ("For {name}" hardcodat in engleza) si (1) fluidizarea selectiei/uploadului de materiale pe
// iPhone (thumbnailuri mici in loc de fisiere originale, pickerLocked care nu mai blocheaza 5
// minute fara feedback).
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

function loadCaptionHelpers() {
  const introIdx = server.indexOf('const INTRO_CAPTION_BY_LANG');
  const introSrc = server.slice(introIdx, server.indexOf('};', introIdx) + 2);
  const src = [
    introSrc,
    extractFn('buildIntroCaptionText'),
    extractFn('escapeAssText'),
    'const ASS_MAX_CHARS_PER_LINE = 30;',
    extractFn('wrapAssTextTwoLines'),
    extractFn('assTimestamp'),
    'const MEMORY_VIDEO_WIDTH = 720; const MEMORY_VIDEO_HEIGHT = 1280;',
    extractFn('toAss'),
    'return { buildIntroCaptionText, escapeAssText, wrapAssTextTwoLines, assTimestamp, toAss };'
  ].join('\n\n');
  return new Function(src)();
}
const { buildIntroCaptionText, escapeAssText, toAss } = loadCaptionHelpers();

// ---------------------------------------------------------------------------------------------
// 1) Localizare — exact cele 8 forme cerute ale textului "Pentru Maria".
// ---------------------------------------------------------------------------------------------
const EXPECTED_INTRO = {
  ro: 'Pentru Maria',
  en: 'For Maria',
  de: 'Für Maria',
  es: 'Para Maria',
  it: 'Per Maria',
  fr: 'Pour Maria',
  bg: 'За Maria',
  tr: 'Maria için'
};
Object.entries(EXPECTED_INTRO).forEach(([lang, expected]) => {
  test(`buildIntroCaptionText: limba "${lang}" produce exact "${expected}"`, () => {
    assert.equal(buildIntroCaptionText(lang, 'Maria'), expected);
  });
});

test('buildIntroCaptionText: limba lipsa sau invalida cade STRICT pe engleza (fallback explicit, testat, nu o eroare tacuta)', () => {
  assert.equal(buildIntroCaptionText(undefined, 'Maria'), 'For Maria');
  assert.equal(buildIntroCaptionText(null, 'Maria'), 'For Maria');
  assert.equal(buildIntroCaptionText('', 'Maria'), 'For Maria');
  assert.equal(buildIntroCaptionText('xx-not-a-real-lang', 'Maria'), 'For Maria');
});

test('buildIntroCaptionText: numele clientului ramane EXACT cum a fost introdus (diacritice romanesti, chirilic, caractere turcesti)', () => {
  assert.equal(buildIntroCaptionText('ro', 'Ștefănescu Ioană'), 'Pentru Ștefănescu Ioană');
  assert.equal(buildIntroCaptionText('bg', 'Мария Иванова'), 'За Мария Иванова');
  assert.equal(buildIntroCaptionText('tr', 'Şükrü Öztürk'), 'Şükrü Öztürk için');
});

test('server.js: buildCaptionLines() primeste order.lang si il transmite STRICT (nu limba curenta a browserului — server-side nu exista asa ceva) catre buildIntroCaptionText()', () => {
  assert.match(server, /function buildCaptionLines\(rawAlignedWords, recipient, lang\)/);
  assert.match(server, /result\.push\(\{ start: 0, end: Math\.min\(introEnd, 5\), text: buildIntroCaptionText\(lang, recipient\), isIntro: true \}\);/);
  const idx = server.indexOf('const captionLines = buildCaptionLines(');
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 200);
  assert.match(snippet, /buildCaptionLines\(body\.data\.alignedWords, order\.recipient \|\| '', order\.lang\)/);
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

test('toAss: un nume cu toate caracterele periculoase simultan produce un fisier .ass valid, fara sa injecteze coduri de control/override', () => {
  const dangerousName = "O'Brien: 100% \\{override}\ndanger";
  const ass = toAss([{ start: 0, end: 3, text: `Pentru ${dangerousName}`, isIntro: true }]);
  assert.ok(!ass.includes('\\{'), 'nu trebuie sa apara acolade de override in text');
  assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:03.00,Title,,0,0,0,,'), 'evenimentul Dialogue trebuie construit corect');
  // Backslash-ul din nume a fost eliminat — singurele backslash-uri ramase in fisier sunt
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
test('toAss: PlayResX/PlayResY corespund EXACT rezolutiei reale a videoclipului (720x1280) — subtitrarile nu se redimensioneaza gresit', () => {
  const ass = toAss([{ start: 0, end: 1, text: 'test' }]);
  assert.match(ass, /PlayResX: 720/);
  assert.match(ass, /PlayResY: 1280/);
});

// ---------------------------------------------------------------------------------------------
// 4) Comenzi vechi raman compatibile — order.lang absent nu blocheaza randarea.
// ---------------------------------------------------------------------------------------------
test('server.js: generateLyricVideo() nu impune ca order.lang sa existe — buildIntroCaptionText cade pe engleza, randarea continua', () => {
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

test('melodia-mea.html: coada locala de materiale NU mai foloseste URL.createObjectURL(file) direct pe fisierul original ca thumbnail — genereaza un thumbnail MIC client-side (createImageBitmap + canvas)', () => {
  const idx = melodia.indexOf("memFileInput.addEventListener('change'");
  assert.ok(idx !== -1);
  const snippet = melodia.slice(idx, idx + 4600);
  assert.ok(!snippet.includes('thumbUrl: URL.createObjectURL(file)'), 'construirea intrarii NU mai trebuie sa atribuie thumbUrl direct din fisierul original (vechiul tipar)');
  assert.match(snippet, /thumbUrl: null,/);
  assert.match(snippet, /scheduleLocalThumbnail\(entry\)/);
});

test('melodia-mea.html: generateLocalThumbnail() foloseste createImageBitmap cu resizeWidth (decodare la rezolutie MICA, nu decodarea completa a fotografiei originale doar pentru afisare)', () => {
  assert.match(melodia, /createImageBitmap\(entry\.file, \{ resizeWidth: LOCAL_THUMB_MAX_DIM, resizeQuality: 'medium' \}\)/);
  assert.match(melodia, /const LOCAL_THUMB_MAX_DIM = 240;/);
});

test('melodia-mea.html: generarea thumbnailurilor locale ruleaza cu CONCURENTA LIMITATA (1 deodata), niciodata toate simultan', () => {
  assert.match(melodia, /const LOCAL_THUMB_CONCURRENCY = 1;/);
  assert.match(melodia, /function pumpLocalThumbQueue\(\) \{/);
});

test('melodia-mea.html: nu instantiaza niciodata FileReader() sau apeleaza file.arrayBuffer() pe fisierul complet in fluxul de materiale (doar mentionat in comentarii ca exemplu de EVITAT)', () => {
  assert.ok(!melodia.includes('new FileReader('), 'nu trebuie instantiat niciun FileReader() — ar decodifica fisierul complet in memorie');
  const memSection = melodia.slice(melodia.indexOf('let uploadQueue = []'), melodia.indexOf('const memFileInput = document.getElementById'));
  assert.ok(!memSection.includes('.arrayBuffer()'), 'nu trebuie folosit file.arrayBuffer() pe fisierul complet');
});

test('melodia-mea.html: lista materialelor se randeaza IMEDIAT, sincron, inainte de orice operatiune costisitoare (thumbnailuri/upload pornesc DUPA)', () => {
  const idx = melodia.indexOf("memFileInput.addEventListener('change'");
  const snippet = melodia.slice(idx, idx + 4600);
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
test('melodia-mea.html: plafonul AUTOMAT de recuperare a selectorului a fost redus semnificativ fata de 5 minute (afordanta explicita devine calea normala de recuperare, nu plafonul orb)', () => {
  assert.match(melodia, /const PICKER_MANUAL_RECOVERY_MS = 90 \* 1000;/);
  assert.ok(!melodia.includes('const PICKER_MANUAL_RECOVERY_MS = 5 * 60 * 1000;'), 'vechiul plafon de 5 minute nu mai trebuie sa existe');
});

test('melodia-mea.html: visibilitychange/focus/pageshow declanseaza o afordanta EXPLICITA de renuntare ("Renunță și încearcă din nou"), NU deblocheaza automat si NU redeschid galeria', () => {
  assert.match(melodia, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) handlePickerPossibleReturn\(\); \}\);/);
  assert.match(melodia, /window\.addEventListener\('focus', handlePickerPossibleReturn\);/);
  assert.match(melodia, /window\.addEventListener\('pageshow', \(event\) => \{ if \(event\.persisted\) handlePickerPossibleReturn\(\); \}\);/);
  const idx = melodia.indexOf('function showPickerWaitingMessage() {');
  const snippet = melodia.slice(idx, idx + 700);
  assert.ok(!snippet.includes('.click()'), 'afordanta NU trebuie sa redeschida automat selectorul (niciun .click() programatic)');
  assert.ok(!snippet.includes('memFileInput.click'));
  assert.match(snippet, /retryBtn\.addEventListener\('click', \(\) => \{\s*pickerLocked = false;/, 'deblocarea ramane STRICT la apasarea explicita a utilizatorului');
});

test('melodia-mea.html: change/cancel raman sursa AUTORITATIVA de deblocare (neschimbate) — o selectie reala sau o anulare reala tot deblocheaza imediat, independent de afordanta explicita', () => {
  const changeIdx = melodia.indexOf("memFileInput.addEventListener('change', () => {");
  assert.match(melodia.slice(changeIdx, changeIdx + 150), /pickerLocked = false;/);
  const cancelIdx = melodia.indexOf("memFileInput.addEventListener('cancel', () => {");
  assert.match(melodia.slice(cancelIdx, cancelIdx + 150), /pickerLocked = false;/);
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
