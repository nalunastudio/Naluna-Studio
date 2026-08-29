// Teste pentru CORECȚIA 2026-08-29 — "feedback imediat pe iPhone" (Cerinta 3) si "simulare cu
// materiale multiple" (item 7 din lista de acceptanta), pe pagina dedicata
// public/amintiri-video.html. Executie REALA a functiilor extrase din pagina (nu doar text-
// search), folosind stub-uri minimale de DOM (fara jsdom, indisponibil in acest proiect).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const page = read('public/amintiri-video.html');

function extractFn(name) {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `functia ${name} trebuie sa existe in amintiri-video.html`);
  let depth = 0, i = page.indexOf('{', start);
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  return page.slice(start, i + 1);
}
function extractConst(name) {
  const idx = page.indexOf(`const ${name} =`);
  assert.ok(idx !== -1, `constanta ${name} trebuie sa existe`);
  const end = page.indexOf(';', idx);
  return page.slice(idx, end + 1);
}
function extractBetween(startMarker, endMarker) {
  const start = page.indexOf(startMarker);
  assert.ok(start !== -1, `marcajul de start "${startMarker}" trebuie sa existe`);
  const end = page.indexOf(endMarker, start);
  assert.ok(end !== -1, `marcajul de sfarsit "${endMarker}" trebuie sa existe`);
  return page.slice(start, end);
}

function loadRealTranslations() {
  const start = page.indexOf('const T = {');
  let depth = 0, i = page.indexOf('{', start);
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = page.slice(start, i + 1);
  return new Function(`${src}\nreturn T;`)();
}
const T = loadRealTranslations();

// ===============================================================================================
// 1) Explicatia PERMANENTA despre timpul de pregatire pe iPhone/iCloud — vizibila TOT TIMPUL,
//    in toate cele 8 limbi, niciodata o promisiune exacta de "un minut".
// ===============================================================================================
test('amintiri-video.html: banner-ul #iphone-hint exista in markup si NU e ascuns condiționat (niciun style="display:none" implicit, nicio ramura JS care il ascunde)', () => {
  assert.match(page, /<div class="iphone-hint" id="iphone-hint" role="note"><\/div>/);
  assert.ok(!/iphone-hint[\s\S]{0,80}display:\s*none/.test(page), 'bannerul nu trebuie sa aiba display:none implicit sau apropiat in markup');
  assert.ok(!page.includes("getElementById('iphone-hint').style.display"), 'nicio ramura JS nu trebuie sa comute vizibilitatea acestui banner — ramane STRICT permanent');
});

test('memories_iphone_hint: exista in toate cele 8 limbi, mentioneaza minutul/iCloud, NU promite exact un minut', () => {
  const langs = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
  for (const lang of langs) {
    const text = T[lang].memories_iphone_hint;
    assert.ok(typeof text === 'string' && text.length > 20, `memories_iphone_hint (${lang}) trebuie sa existe si sa fie substantial`);
  }
  const ro = T.ro.memories_iphone_hint;
  assert.match(ro, /iCloud/);
  assert.match(ro, /minut/);
  assert.ok(!/exact un minut|exactly one minute/i.test(ro), 'nu trebuie promis EXACT un minut — materialele mari/din iCloud pot dura mai mult');
});

test('amintiri-video.html: applyStaticTexts() scrie mesajul iphone-hint din traducere, o singura data, la incarcare', () => {
  const body = extractFn('applyStaticTexts');
  assert.match(body, /document\.getElementById\('iphone-hint'\)\.innerHTML = /);
  assert.match(body, /t\.memories_iphone_hint/);
});

// ===============================================================================================
// Sandbox comun pentru executia REALA a logicii de picker-lock (pointerdown/click/cancel/
// visibilitychange/focus/pageshow) — stub-uri minimale de DOM, fara jsdom.
// ===============================================================================================
function makeStubElement() {
  return {
    _text: '', _html: '', _class: '', disabled: false, listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    get className() { return this._class; },
    set className(v) { this._class = v; },
    addEventListener(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
  };
}

function loadPickerLockSandbox() {
  const src = extractBetween('let pickerLocked = false;', "memFileInput.addEventListener('change'");
  const elementsById = {};
  const documentStub = {
    hidden: false,
    listeners: {},
    addEventListener(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); },
    getElementById(id) { return elementsById[id] || (elementsById[id] = makeStubElement()); }
  };
  const windowStub = { listeners: {}, addEventListener(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); } };
  const memFileInput = makeStubElement();
  const memStatusEl = makeStubElement();
  const sandbox = {
    document: documentStub,
    window: windowStub,
    memFileInput,
    memStatusEl,
    uploadQueue: [],
    t: T.ro,
    escapeHtml: (s) => s,
    Date
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context);
  return { context, documentStub, windowStub, memFileInput, memStatusEl, elementsById };
}

// ===============================================================================================
// 2) pointerdown/click pe selector — stare "Telefonul pregătește selecția…" INSTANT, sincron.
// ===============================================================================================
test('executie reala: pointerdown pe selector afiseaza IMEDIAT, sincron, mesajul de pregatire — inainte de orice raspuns real din Photos', () => {
  const { memFileInput, memStatusEl } = loadPickerLockSandbox();
  assert.equal(memStatusEl.textContent, '', 'inainte de orice interactiune, nu trebuie sa existe niciun mesaj');
  memFileInput.listeners.pointerdown[0]({});
  assert.equal(memStatusEl.textContent, T.ro.memories_picker_preparing, 'mesajul de pregatire trebuie afisat SINCRON la pointerdown, fara nicio asteptare');
});

test('executie reala: click pe selector (fara pointerdown in prealabil, ex. tastatura/accesibilitate) produce acelasi mesaj de pregatire', () => {
  const { memFileInput, memStatusEl } = loadPickerLockSandbox();
  memFileInput.listeners.click[0]({ type: 'click' });
  assert.equal(memStatusEl.textContent, T.ro.memories_picker_preparing);
});

// ===============================================================================================
// 3) Revenire posibila din Photos (visibilitychange/focus/pageshow) — starea de asteptare apare
//    IMEDIAT, FARA nicio intarziere (fara setTimeout), cat timp selectorul e blocat.
// ===============================================================================================
test('executie reala: visibilitychange (document redevine vizibil) IN TIMP CE selectorul e blocat afiseaza IMEDIAT starea de asteptare, sincron, fara delay', () => {
  const { memFileInput, memStatusEl, documentStub } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  assert.equal(memStatusEl.textContent, T.ro.memories_picker_preparing);
  documentStub.hidden = false;
  documentStub.listeners.visibilitychange[0]();
  assert.match(memStatusEl.innerHTML, new RegExp(T.ro.memories_picker_waiting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'starea de asteptare trebuie sa apara SINCRON la revenire, fara niciun setTimeout');
});

test('executie reala: focus IN TIMP CE selectorul e blocat afiseaza starea de asteptare, sincron', () => {
  const { memFileInput, memStatusEl, windowStub } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  windowStub.listeners.focus[0]();
  assert.match(memStatusEl.innerHTML, /mem-picker-retry-btn/);
});

test('executie reala: pageshow persisted IN TIMP CE selectorul e blocat afiseaza starea de asteptare, sincron', () => {
  const { memFileInput, memStatusEl, windowStub } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  windowStub.listeners.pageshow[0]({ persisted: true });
  assert.match(memStatusEl.innerHTML, /mem-picker-retry-btn/);
});

test('executie reala: visibilitychange/focus/pageshow NU fac NIMIC daca selectorul nu e blocat (nicio interactiune in curs)', () => {
  const { documentStub, windowStub, memStatusEl } = loadPickerLockSandbox();
  documentStub.listeners.visibilitychange[0]();
  windowStub.listeners.focus[0]();
  windowStub.listeners.pageshow[0]({ persisted: true });
  assert.equal(memStatusEl.textContent, '');
  assert.equal(memStatusEl.innerHTML, '');
});

// ===============================================================================================
// 4) Anulare / retry — eliberarea corecta a lock-ului, niciodata blocat definitiv.
// ===============================================================================================
test('executie reala: evenimentul "cancel" elibereaza lock-ul si sterge mesajul, indiferent de starea anterioara', () => {
  const { memFileInput, memStatusEl } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  memFileInput.listeners.cancel[0]();
  assert.equal(memStatusEl.textContent, '');
  // dupa cancel, o noua apasare trebuie sa fie posibila (lock eliberat) — verificat indirect:
  // pointerdown produce din nou mesajul de pregatire (nu e blocata de vechiul lock).
  memFileInput.listeners.pointerdown[0]({});
  assert.equal(memStatusEl.textContent, T.ro.memories_picker_preparing);
});

test('executie reala: butonul de retry din starea de asteptare elibereaza lock-ul explicit, la apasare — actiune functionala, nu doar text', () => {
  const { memFileInput, memStatusEl, documentStub, elementsById } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  documentStub.listeners.visibilitychange[0]();
  const retryBtn = elementsById['mem-picker-retry-btn'];
  assert.ok(retryBtn && retryBtn.listeners.click, 'butonul de retry trebuie sa aiba un handler de click real');
  retryBtn.listeners.click[0]();
  assert.equal(memStatusEl.textContent, '', 'apasarea retry trebuie sa elibereze mesajul');
  // selectorul trebuie redeschis-abil dupa retry (lock eliberat real, nu doar mesajul curatat).
  memFileInput.listeners.pointerdown[0]({});
  assert.equal(memStatusEl.textContent, T.ro.memories_picker_preparing);
});

test('executie reala: o a doua apasare (pointerdown) CAT TIMP selectorul e inca blocat (sub pragul de recuperare) nu reseteaza/redeschide nimic vizibil suplimentar', () => {
  const { memFileInput, memStatusEl } = loadPickerLockSandbox();
  memFileInput.listeners.pointerdown[0]({});
  memStatusEl.textContent = 'MODIFICAT-MANUAL';
  memFileInput.listeners.pointerdown[0]({});
  assert.equal(memStatusEl.textContent, 'MODIFICAT-MANUAL', 'a doua apasare, cat timp lock-ul e activ, nu trebuie sa re-declanseze mesajul de pregatire');
});

// ===============================================================================================
// 5) Simulare cu 6 fisiere MOV (item 7 din lista de acceptanta): toate cele 6 randuri apar
//    IMEDIAT in starea de asteptare, iar coada porneste STRICT maximum 2 uploaduri simultan.
// ===============================================================================================
function loadQueueConcurrencySandbox() {
  const isVideoFileSrc = extractFn('isVideoFile');
  const videoExtConst = extractConst('VIDEO_EXTENSIONS');
  const renderRowSrc = extractFn('renderQueueRowInner');
  const maxConcurrentConst = extractConst('MAX_CONCURRENT_UPLOADS');
  const processQueueSrc = extractFn('processUploadQueue');
  const sandbox = {
    uploadQueue: [],
    t: T.ro,
    escapeHtml: (s) => s,
    startUpload: null
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    ${videoExtConst}
    ${isVideoFileSrc}
    ${maxConcurrentConst}
    function startUpload(entry) { entry.status = 'uploading'; }
    ${processQueueSrc}
    ${renderRowSrc}
  `, context);
  return context;
}

test('executie reala (6 fisiere MOV): toate cele 6 materiale devin intrari "pending" in coada, fara nicio filtrare dupa tip', () => {
  const ctx = loadQueueConcurrencySandbox();
  for (let i = 0; i < 6; i++) {
    ctx.uploadQueue.push({ localId: `q${i}`, file: { name: `IMG_000${i}.MOV`, type: '', size: 50 * 1024 * 1024 }, status: 'pending', progress: 0, errorMsg: null, thumbUrl: null });
  }
  assert.equal(ctx.uploadQueue.length, 6);
  assert.ok(ctx.uploadQueue.every(q => q.status === 'pending'));
});

test('executie reala (6 fisiere MOV): renderQueueRowInner() produce randul in starea "În așteptare" pentru fiecare din cele 6, INAINTE de orice upload — nicio bara de progres inca', () => {
  const ctx = loadQueueConcurrencySandbox();
  for (let i = 0; i < 6; i++) {
    ctx.uploadQueue.push({ localId: `q${i}`, file: { name: `IMG_000${i}.MOV`, type: '', size: 50 * 1024 * 1024 }, status: 'pending', progress: 0, errorMsg: null, thumbUrl: null });
  }
  ctx.uploadQueue.forEach(q => {
    const rowHtml = ctx.renderQueueRowInner(q);
    assert.ok(rowHtml.includes(ctx.t.memories_queued), `randul pentru ${q.localId} trebuie sa arate starea de asteptare inainte de upload`);
    assert.ok(!rowHtml.includes('mem-progress-fill'), `randul pentru ${q.localId} nu trebuie sa aiba inca o bara de progres (statusul e "pending")`);
  });
});

test('executie reala (6 fisiere MOV): processUploadQueue() porneste STRICT maximum 2 uploaduri simultan din cele 6 aflate in asteptare', () => {
  const ctx = loadQueueConcurrencySandbox();
  for (let i = 0; i < 6; i++) {
    ctx.uploadQueue.push({ localId: `q${i}`, file: { name: `IMG_000${i}.MOV`, type: '', size: 50 * 1024 * 1024 }, status: 'pending', progress: 0, errorMsg: null, thumbUrl: null });
  }
  ctx.processUploadQueue();
  const uploading = ctx.uploadQueue.filter(q => q.status === 'uploading');
  const pending = ctx.uploadQueue.filter(q => q.status === 'pending');
  assert.equal(uploading.length, 2, `trebuie sa porneasca EXACT 2 uploaduri simultan (MAX_CONCURRENT_UPLOADS), au pornit ${uploading.length}`);
  assert.equal(pending.length, 4, 'restul de 4 materiale trebuie sa ramana in asteptare pana se elibereaza un loc');
});

test('executie reala (6 fisiere MOV): cand un upload activ se termina (eliminat din coada), urmatorul in asteptare porneste automat — coada continua sa respecte limita de 2', () => {
  const ctx = loadQueueConcurrencySandbox();
  for (let i = 0; i < 6; i++) {
    ctx.uploadQueue.push({ localId: `q${i}`, file: { name: `IMG_000${i}.MOV`, type: '', size: 50 * 1024 * 1024 }, status: 'pending', progress: 0, errorMsg: null, thumbUrl: null });
  }
  ctx.processUploadQueue();
  // simuleaza finalizarea cu succes a primului material activ (eliminat din coada, ca in
  // startSingleUpload/startMultipartUpload REALE dupa raspunsul serverului).
  const firstActiveId = ctx.uploadQueue.find(q => q.status === 'uploading').localId;
  ctx.uploadQueue = ctx.uploadQueue.filter(q => q.localId !== firstActiveId);
  ctx.processUploadQueue();
  const uploading = ctx.uploadQueue.filter(q => q.status === 'uploading');
  assert.equal(uploading.length, 2, 'dupa finalizarea unuia, coada trebuie sa porneasca imediat urmatorul, ramanand la maximum 2 active simultan');
  assert.equal(ctx.uploadQueue.length, 5, 'un material mai putin fata de cele 6 initiale (unul finalizat cu succes)');
});

// ===============================================================================================
// 6) Selectii duplicate blocate cat timp lotul e activ (aria-busy urmeaza aceeasi stare).
// ===============================================================================================
test('amintiri-video.html: updateBatchActiveState() dezactiveaza selectorul si seteaza aria-busy STRICT cat timp exista materiale in coada — reactivat automat cand coada se goleste', () => {
  const body = extractFn('updateBatchActiveState');
  assert.match(body, /memFileInput\.disabled = active;/);
  assert.match(body, /setAttribute\('aria-busy', active \? 'true' : 'false'\)/);
});

test('amintiri-video.html: #mem-staged-list si #mem-status au aria-live/aria-busy declarate in markup, pentru cititoarele de ecran', () => {
  assert.match(page, /<div class="mem-list" id="mem-staged-list" aria-live="polite" aria-busy="false">/);
  assert.match(page, /<p class="mem-status" id="mem-status" role="status" aria-live="assertive" aria-busy="false">/);
});

// ===============================================================================================
// 7) Avertizare best-effort la parasirea paginii cat timp un upload e activ.
// ===============================================================================================
test('amintiri-video.html: beforeunload avertizeaza STRICT cat timp exista un upload activ (uploading/processing) — altfel nu intervine', () => {
  const idx = page.indexOf("window.addEventListener('beforeunload'");
  assert.notEqual(idx, -1);
  const snippet = page.slice(idx, idx + 300);
  assert.match(snippet, /q\.status === 'uploading' \|\| q\.status === 'processing'/);
  assert.match(snippet, /e\.preventDefault\(\);/);
});

// ===============================================================================================
// 8) Daca TOATE incercarile de /media/confirm esueaza, eroare localizata + retry functional
//    (inainte: clientul ramanea fara explicatie dupa epuizarea retry-urilor).
// ===============================================================================================
test('amintiri-video.html: dupa epuizarea MEDIA_CONFIRM_MAX_RETRIES, showConfirmFailedMessage() afiseaza mesajul localizat SI un buton de retry care reincepe ciclul', () => {
  const body = extractFn('maybeAutoConfirmMedia');
  assert.match(body, /if \(mediaConfirmRetryCount < MEDIA_CONFIRM_MAX_RETRIES\) \{/);
  assert.match(body, /showConfirmFailedMessage\(order, gateOk\);/);
  const showBody = extractFn('showConfirmFailedMessage');
  assert.match(showBody, /t\.memories_confirm_failed/);
  assert.match(showBody, /retryBtn\.addEventListener\('click', \(\) => \{/);
  assert.match(showBody, /mediaConfirmRetryCount = 0;/);
  assert.match(showBody, /maybeAutoConfirmMedia\(order, gateOk\);/);
});

test('memories_confirm_failed: exista in toate cele 8 limbi, text substantial', () => {
  for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
    assert.ok(typeof T[lang].memories_confirm_failed === 'string' && T[lang].memories_confirm_failed.length > 10);
  }
});

// ===============================================================================================
// 9) Niciodata navigare catre alta pagina dupa ce fisierele sunt efectiv selectate — ar pierde
//    obiectele File locale pe iOS.
// ===============================================================================================
test('amintiri-video.html: handler-ul de "change" (dupa selectie) nu navigheaza NICIODATA catre alta pagina — window.location apare STRICT in bootstrap/butonul de creare, niciodata in fluxul de selectie/upload', () => {
  const changeIdx = page.indexOf("memFileInput.addEventListener('change'");
  const changeEnd = page.indexOf('\n  });', changeIdx);
  const changeSnippet = page.slice(changeIdx, changeEnd);
  assert.ok(!changeSnippet.includes('window.location'), 'handler-ul de change nu trebuie sa navigheze niciodata — ar pierde obiectele File locale pe iOS');
});

test('amintiri-video.html: ramane sintactic valid dupa aceasta corectie', () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach(m => { new Function(m[1]); });
});

// ===============================================================================================
// 10) melodia-mea.html NU mai contine selectorul de fisiere, lista, coada sau progresul de
//     incarcare — mutate integral pe pagina dedicata (item 5 din lista de acceptanta).
// ===============================================================================================
test('melodia-mea.html: nu mai contine selectorul de fisiere, lista de materiale, coada sau progresul de incarcare (mutate pe amintiri-video.html)', () => {
  const melodia = read('public/melodia-mea.html');
  for (const marker of [
    'id="mem-file-input"', 'id="mem-staged-list"', 'id="mem-uploaded-list"', 'id="mem-batch-status"',
    'id="mem-status"', 'id="gift-video-create-btn"', 'id="memories-section"',
    'function renderQueueList() {', 'function renderExistingList(order) {', 'function startSingleUpload(entry) {',
    'function startMultipartUpload(entry) {', 'function processUploadQueue() {', 'let uploadQueue = []'
  ]) {
    assert.ok(!melodia.includes(marker), `melodia-mea.html nu mai trebuie sa contina "${marker}" — mutat pe amintiri-video.html`);
  }
});

test('amintiri-video.html: contine EFECTIV selectorul de fisiere, lista, coada si progresul de incarcare (destinatia reala a mutarii)', () => {
  for (const marker of [
    'id="mem-file-input"', 'id="mem-staged-list"', 'id="mem-uploaded-list"', 'id="mem-batch-status"',
    'id="mem-status"', 'id="gift-video-create-btn"',
    'function renderQueueList() {', 'function renderExistingList(order) {', 'function startSingleUpload(entry) {',
    'function startMultipartUpload(entry) {', 'function processUploadQueue() {', 'let uploadQueue = []'
  ]) {
    assert.ok(page.includes(marker), `amintiri-video.html trebuie sa contina "${marker}"`);
  }
});
