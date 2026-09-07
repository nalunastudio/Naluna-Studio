// TASK 1 (2026-09-07, "selector iOS -> Naluna", ~2:17 masurat real intre confirmarea selectiei
// pe iPhone si revenirea efectiva pe pagina): verifica STRUCTURAL ca instrumentarea de timing
// (markTiming/timingNow/mediaTimingT0/beacon) e cablata corect in amintiri-video.html si ca
// endpoint-ul minimal server-side exista si logheaza fara date personale/secrete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'amintiri-video.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('amintiri-video.html: markTiming() foloseste STRICT timingNow() (cu fallback la Date.now() daca performance.now nu exista), niciodata performance.now() direct fara fallback', () => {
  assert.match(html, /function timingNow\(\) \{\s*return \(typeof performance !== 'undefined' && typeof performance\.now === 'function'\) \? performance\.now\(\) : Date\.now\(\);/);
  assert.match(html, /function markTiming\(event\) \{/);
  // Comentariile pot mentiona "performance.now()" ca documentatie a API-ului folosit — verificam
  // STRICT ca niciun COD REAL (in afara corpului timingNow()) nu il apeleaza direct.
  const codeWithoutComments = html.replace(/\/\/.*$/gm, '');
  const fnStart = codeWithoutComments.indexOf('function timingNow() {');
  const fnEnd = codeWithoutComments.indexOf('}', fnStart) + 1;
  const codeOutsideTimingNow = codeWithoutComments.slice(0, fnStart) + codeWithoutComments.slice(fnEnd);
  assert.doesNotMatch(codeOutsideTimingNow, /performance\.now\(\)/, 'niciun apel direct la performance.now() in afara corpului timingNow()');
});

test('amintiri-video.html: T0-ul de timing e resetat la FIECARE incercare reala de deschidere a selectorului (handlePickerOpenAttempt), niciodata mostenit de la o incercare anterioara', () => {
  const idx = html.indexOf('function handlePickerOpenAttempt() {');
  assert.notEqual(idx, -1);
  const body = html.slice(idx, idx + 500);
  assert.match(body, /mediaTimingT0 = timingNow\(\);/);
  assert.match(body, /mediaTimingEvents = \[\];/);
  assert.match(body, /mediaTimingSent = false;/);
  assert.match(body, /markTiming\('picker_open_attempt'\);/);
});

test('amintiri-video.html: toate checkpoint-urile cerute pentru diagnosticul TASK 1 exista (ordinea REALA de executie e verificata separat, per functie, in testele de mai jos — declararea functiilor in sursa NU reflecta ordinea lor de executie)', () => {
  const markers = ['picker_open_attempt', 'change_event_start', 'files_copied', 'handle_files_received_start', 'render_queue_list_done', 'raf_fired', 'first_upload_start'];
  for (const marker of markers) {
    assert.notEqual(html.indexOf(`markTiming('${marker}')`), -1, `checkpoint-ul '${marker}' trebuie sa existe`);
  }
});

test('amintiri-video.html: ordinea REALA de executie in interiorul handlerului "change" e change_event_start -> files_copied -> (apel handleFilesReceived)', () => {
  const changeHandlerIdx = html.indexOf("memFileInput.addEventListener('change', () => {");
  const handleFilesCallIdx = html.indexOf('handleFilesReceived(files);', changeHandlerIdx);
  const changeStartIdx = html.indexOf("markTiming('change_event_start')", changeHandlerIdx);
  const filesCopiedIdx = html.indexOf("markTiming('files_copied')", changeHandlerIdx);
  assert.ok(changeStartIdx > changeHandlerIdx && changeStartIdx < filesCopiedIdx, 'change_event_start trebuie sa fie PRIMUL checkpoint din handler');
  assert.ok(filesCopiedIdx < handleFilesCallIdx, 'files_copied trebuie marcat INAINTE de apelul handleFilesReceived()');
});

test('amintiri-video.html: ordinea REALA de executie in interiorul handleFilesReceived() e handle_files_received_start -> render_queue_list_done -> raf_fired', () => {
  const fnIdx = html.indexOf('function handleFilesReceived(files) {');
  const startIdx = html.indexOf("markTiming('handle_files_received_start')", fnIdx);
  const renderDoneIdx = html.indexOf("markTiming('render_queue_list_done')", fnIdx);
  const rafIdx = html.indexOf("markTiming('raf_fired')", fnIdx);
  assert.ok(fnIdx < startIdx && startIdx < renderDoneIdx && renderDoneIdx < rafIdx, 'ordinea trebuie sa fie STRICT: start -> render done -> raf fired');
});

test('amintiri-video.html: markTiming("files_copied") NU sta intre copierea FileList-ului si resetarea memFileInput.value (respecta fix-ul real anti-pierdere-selectie de pe iPhone)', () => {
  const arrayFromIdx = html.indexOf('const files = Array.from(memFileInput.files);');
  const valueResetIdx = html.indexOf("memFileInput.value = '';", arrayFromIdx);
  const filesCopiedMarkerIdx = html.indexOf("markTiming('files_copied')", arrayFromIdx);
  assert.ok(valueResetIdx < filesCopiedMarkerIdx, 'markTiming trebuie sa vina DUPA resetarea memFileInput.value, niciodata intre copiere si resetare');
});

test('amintiri-video.html: beacon-ul de timing e trimis O SINGURA DATA per lot (guardat de mediaTimingSent), fire-and-forget (keepalive), fara sa blocheze startUpload()', () => {
  const idx = html.indexOf('function sendMediaTimingBeacon(fileCount) {');
  assert.notEqual(idx, -1);
  const body = html.slice(idx, idx + 700);
  assert.match(body, /if \(mediaTimingSent \|\| mediaTimingEvents\.length === 0\) return;/);
  assert.match(body, /mediaTimingSent = true;/);
  assert.match(body, /keepalive: true/);
  assert.doesNotMatch(body, /await fetch/, 'beacon-ul nu trebuie asteptat (await) — nu trebuie sa intarzie startUpload()');

  const startUploadIdx = html.indexOf('function startUpload(entry) {');
  const startUploadBody = html.slice(startUploadIdx, startUploadIdx + 300);
  assert.match(startUploadBody, /if \(!mediaTimingSent\) \{/);
  assert.match(startUploadBody, /sendMediaTimingBeacon\(uploadQueue\.length\);/);
});

test('amintiri-video.html: beacon-ul NU trimite niciodata nume de fisier/continut — STRICT evenimente+timpi+numar de fisiere+flag iOS', () => {
  const idx = html.indexOf('function sendMediaTimingBeacon(fileCount) {');
  const body = html.slice(idx, idx + 500);
  assert.match(body, /body: JSON\.stringify\(\{ events: mediaTimingEvents, ios: memIsIOS, fileCount \}\)/);
  assert.doesNotMatch(body, /\.name|\.file\b/, 'niciun camp de fisier/nume nu trebuie inclus in payload-ul beacon-ului');
});

test('server.js: endpoint-ul POST .../media/client-timing exista, cere requireOrderToken si limiteaza numarul de evenimente acceptate', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/client-timing', requireOrderToken, \(req, res\) => \{/);
  assert.match(server, /const CLIENT_TIMING_MAX_EVENTS = 40;/);
  const idx = server.indexOf("app.post('/api/orders/:orderId/media/client-timing'");
  const body = server.slice(idx, idx + 800);
  assert.match(body, /\.slice\(0, CLIENT_TIMING_MAX_EVENTS\)/, 'numarul de evenimente acceptate trebuie plafonat, ca sa nu poata fi folosit ca vector de abuz');
  assert.match(body, /perfLog\(req\.order\.id, 'client_media_picker_timing'/);
});

test('server.js: endpoint-ul de timing NU persista/logheaza niciodata nume de fisier sau alt continut liber de la client — STRICT nume de eveniment (string) + numar (t)', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/media/client-timing'");
  const body = server.slice(idx, idx + 800);
  assert.match(body, /typeof e\.event === 'string' && Number\.isFinite\(e\.t\)/, 'fiecare eveniment trebuie validat STRICT ca {event: string, t: number} inainte de a fi logat');
});
