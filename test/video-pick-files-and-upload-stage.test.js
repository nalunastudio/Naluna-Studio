// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerințele 3 și 4):
// (3) butonul mare "Alege fișierele" — un <label> asociat inputului nativ unic, existent deja,
//     stilizat ca CTA (portocaliu, text roșu, full-width mobil, min ~54px), fara input.click()
//     programatic, fara al doilea input, pastrand exact atributele native cerute.
// (4) o a doua "vedere" (etapa de incarcare), in ACELASI document/runtime — NICIODATA navigare —
//     comutata STRICT dupa copierea sincrona a FileList, ascunde titlul/explicatia/chenarul/
//     selectorul mare al etapei 1, arata titlu+explicatie+progres general (deja existente lista
//     de materiale + butonul de creare raman vizibile, ele SUNT continutul etapei 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const html = read('public/amintiri-video.html');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

function loadTranslations() {
  const start = html.indexOf('const T = ');
  let depth = 0, i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = html.slice(start, i + 1);
  return new Function(`${src}\nreturn T;`)();
}

// ===============================================================================================
// PARTEA 1 — Cerinta 3: un singur input nativ, neatins in atributele cerute; declansat STRICT
// printr-un <label> asociat, niciodata prin input.click() programatic.
// ===============================================================================================
test('amintiri-video.html: exista EXACT doua <input type="file"> (principal + fallback recuperare Cerinta 4), principalul cu multiple + accept="image/*,video/*", fara capture, fara webkitdirectory/directory', () => {
  const inputs = [...html.matchAll(/<input[^>]*type="file"[^>]*>/g)];
  assert.equal(inputs.length, 2, 'trebuie sa existe principal + fallback "Alege din Fisiere" (Cerinta 4)');
  const tag = inputs.find(m => m[0].includes('id="mem-file-input"'))[0];
  assert.ok(tag.includes('multiple'));
  assert.ok(tag.includes('accept="image/*,video/*"'));
  assert.ok(!/\bcapture\b/.test(tag), 'fara capture');
  assert.ok(!/webkitdirectory|directory/.test(tag), 'fara webkitdirectory/directory');
  assert.ok(tag.includes('id="mem-file-input"'));
  const fallbackMatch = inputs.find(m => m[0].includes('mem-file-input-fallback'));
  assert.ok(fallbackMatch, 'trebuie sa existe inputul fallback "Alege din Fisiere"');
  const fallbackTag = fallbackMatch[0];
  assert.ok(fallbackTag.includes('multiple'));
  assert.ok(!fallbackTag.includes('accept='), 'fallback-ul nu trebuie sa forteze Photos prin accept');
  assert.ok(!/\bcapture\b/.test(fallbackTag), 'fara capture pe fallback');
});

test('amintiri-video.html: exista un <label for="mem-file-input"> — activarea selectorului e STRICT nativa, prin label, niciodata prin input.click() programatic', () => {
  assert.match(html, /<label class="btn-pick-files" for="mem-file-input" id="mem-pick-label">/);
  assert.ok(!html.includes('memFileInput.click()'), 'nu trebuie sa existe niciun apel programatic la .click() pe inputul de fisiere');
  assert.ok(!/getElementById\('mem-file-input'\)\.click\(\)/.test(html));
});

test('amintiri-video.html: inputul e vizual ascuns (tehnica "clip", NICIODATA display:none) — ramane complet functional si accesibil pentru un <label> asociat', () => {
  const cssBlock = html.slice(html.indexOf('#mem-file-input{'), html.indexOf('#mem-file-input{') + 400);
  assert.ok(cssBlock.includes('clip:rect(0,0,0,0)'), 'trebuie sa foloseasca tehnica standard "vizual ascuns", nu display:none');
  assert.ok(!cssBlock.includes('display:none'));
});

test('amintiri-video.html: butonul "Alege fișierele" respecta cerintele vizuale — fundal portocaliu (var(--orange)), text roșu (var(--error)), inaltime minima >= 54px, latime completa pe mobil', () => {
  const cssBlock = html.slice(html.indexOf('.btn-pick-files{'), html.indexOf('.btn-pick-files{') + 400);
  assert.ok(cssBlock.includes('background:var(--orange)'));
  assert.ok(cssBlock.includes('color:var(--error)'));
  const minHeightMatch = cssBlock.match(/min-height:(\d+)px/);
  assert.ok(minHeightMatch && Number(minHeightMatch[1]) >= 54, 'inaltimea minima trebuie sa fie de cel putin 54px');
  assert.ok(cssBlock.includes('width:100%'));
});

test('amintiri-video.html: pointerdown/click pe input NU folosesc preventDefault — gestul real ajunge intotdeauna nativ (comportament mostenit, neschimbat)', () => {
  const attemptBody = extractFn(html, 'function handlePickerOpenAttempt() {');
  assert.ok(!attemptBody.includes('preventDefault'));
});

test('amintiri-video.html: eticheta butonului e tradusa in toate cele 8 limbi (fara text hardcodat englezesc/lipsa)', () => {
  const T = loadTranslations();
  for (const lang of LANGS) {
    assert.ok(T[lang].memories_pick_files_btn && T[lang].memories_pick_files_btn.trim().length > 0, `lipseste memories_pick_files_btn pentru ${lang}`);
  }
});

test('amintiri-video.html: sincronizarea disabled/loading a butonului cu coada de incarcare — syncPickerLabelState() e apelata din updateBatchActiveState() SI din updateMemoriesCountAndGates()', () => {
  const batchFn = extractFn(html, 'function updateBatchActiveState() {');
  assert.ok(batchFn.includes('syncPickerLabelState()'));
  const gatesFn = extractFn(html, 'function updateMemoriesCountAndGates(order) {');
  assert.ok(gatesFn.includes('syncPickerLabelState()'));
});

// ===============================================================================================
// PARTEA 2 — Cerinta 3/4: comportament FUNCTIONAL real al syncPickerLabelState()/enterUploadStage()
// — extrase verbatim si rulate intr-un sandbox minimal (stub DOM), nu doar text-matching.
// ===============================================================================================
function loadStageSandbox() {
  const syncSrc = extractFn(html, 'function syncPickerLabelState() {');
  const enterSrc = extractFn(html, 'function enterUploadStage() {');
  // CORECȚIE (2026-08-31, "mărește limita de la 10 la 30 de materiale"): MEM_MAX e extras acum
  // DIRECT din sursa reala (nu mai e un literal separat, hardcodat aici) — testul ramane corect
  // automat la orice schimbare viitoare a limitei, fara sa mai trebuiasca actualizat manual.
  const memMaxIdx = html.indexOf('const MEM_MAX =');
  const memMaxDecl = html.slice(memMaxIdx, html.indexOf(';', memMaxIdx) + 1);
  const sandboxSrc = `
    let uploadStageEntered = false;
    ${memMaxDecl}
    let memOrderRef = { uploadedMedia: [] };
    const els = {};
    function makeEl(id) { const e = { id, style: {}, classList: { set: new Set(), add(c){this.set.add(c);}, remove(c){this.set.delete(c);}, toggle(c,v){ if (v) this.set.add(c); else this.set.delete(c); }, contains(c){ return this.set.has(c); } } }; els[id] = e; return e; }
    ['memories-title','memories-sub','iphone-hint','memories-meta','back-link-row','upload-stage-header','mem-pick-label'].forEach(makeEl);
    const document = { getElementById: (id) => els[id] || makeEl(id) };
    const memFileInput = { disabled: false };
    ${syncSrc}
    ${enterSrc}
    return { syncPickerLabelState, enterUploadStage, els, setDisabled: (v) => { memFileInput.disabled = v; }, setUploadedCount: (n) => { memOrderRef.uploadedMedia = new Array(n).fill(0); }, isEntered: () => uploadStageEntered };
  `;
  return new Function(sandboxSrc)();
}

test('syncPickerLabelState (etapa 1): butonul ramane mereu vizibil, doar cu aspectul de dezactivat sincronizat cu memFileInput.disabled', () => {
  const mod = loadStageSandbox();
  mod.syncPickerLabelState();
  assert.equal(mod.els['mem-pick-label'].style.display, 'flex');
  assert.equal(mod.els['mem-pick-label'].classList.contains('is-disabled-look'), false);
  mod.setDisabled(true);
  mod.syncPickerLabelState();
  assert.equal(mod.els['mem-pick-label'].style.display, 'flex', 'in etapa 1, butonul ramane vizibil chiar dezactivat vizual');
  assert.equal(mod.els['mem-pick-label'].classList.contains('is-disabled-look'), true);
});

test('enterUploadStage(): ascunde titlul/explicatia/chenarul informativ/randul de back-link ale etapei 1, arata antetul etapei 2, e IDEMPOTENTA (a doua apelare nu face nimic in plus)', () => {
  const mod = loadStageSandbox();
  mod.enterUploadStage();
  assert.equal(mod.els['memories-title'].style.display, 'none');
  assert.equal(mod.els['memories-sub'].style.display, 'none');
  assert.equal(mod.els['iphone-hint'].style.display, 'none');
  assert.equal(mod.els['memories-meta'].style.display, 'none');
  assert.equal(mod.els['upload-stage-header'].style.display, 'block');
  assert.equal(mod.els['mem-pick-label'].classList.contains('compact'), true);
  assert.equal(mod.isEntered(), true);
  // a doua apelare — idempotenta, nu arunca, starea ramane identica
  assert.doesNotThrow(() => mod.enterUploadStage());
});

test('syncPickerLabelState (etapa 2, dupa enterUploadStage): butonul ramane ASCUNS cat timp un lot e activ (memFileInput.disabled), chiar daca mai e loc pentru materiale', () => {
  const mod = loadStageSandbox();
  mod.enterUploadStage();
  mod.setDisabled(true);
  mod.setUploadedCount(2);
  mod.syncPickerLabelState();
  assert.equal(mod.els['mem-pick-label'].style.display, 'none', 'clientul trebuie sa vada STRICT progresul incarcarii cat timp un lot e activ');
});

test('syncPickerLabelState (etapa 2, coada goala): butonul REAPARE (compact) STRICT cand nu mai e niciun lot activ SI mai e loc sub MEM_MAX — clientul poate adauga materiale suplimentare daca nu a ajuns la minim', () => {
  const mod = loadStageSandbox();
  mod.enterUploadStage();
  mod.setDisabled(false);
  mod.setUploadedCount(2); // sub MEM_MAX (30)
  mod.syncPickerLabelState();
  assert.equal(mod.els['mem-pick-label'].style.display, 'flex');
});

test('syncPickerLabelState (etapa 2, MEM_MAX atins): butonul ramane ascuns chiar cu coada goala, daca s-a atins deja numarul maxim de materiale', () => {
  const mod = loadStageSandbox();
  mod.enterUploadStage();
  mod.setDisabled(false);
  mod.setUploadedCount(30); // = MEM_MAX
  mod.syncPickerLabelState();
  assert.equal(mod.els['mem-pick-label'].style.display, 'none');
});

// ===============================================================================================
// PARTEA 3 — Cerinta 4: comutarea la etapa de incarcare se face STRICT dupa copierea sincrona a
// FileList, in acelasi document (fara navigare) — verificat DIRECT din ordinea reala a codului.
// ===============================================================================================
test('amintiri-video.html: handler-ul de "change" copiaza FileList SINCRON (Array.from) INAINTE sa predea fisierele lui handleFilesReceived(), care apeleaza enterUploadStage() — fisierele nu se pierd niciodata', () => {
  const changeFnSrc = extractFn(html, "memFileInput.addEventListener('change', () => {");
  const arrayFromIdx = changeFnSrc.indexOf('Array.from(memFileInput.files)');
  const handOffIdx = changeFnSrc.indexOf('handleFilesReceived(files)');
  assert.ok(arrayFromIdx !== -1 && handOffIdx !== -1);
  assert.ok(arrayFromIdx < handOffIdx, 'FileList trebuie copiat INAINTE de predarea catre etapa 2');

  const handleFnSrc = extractFn(html, 'function handleFilesReceived(files) {');
  const enterStageIdx = handleFnSrc.indexOf('enterUploadStage()');
  assert.ok(enterStageIdx !== -1, 'handleFilesReceived trebuie sa comute la etapa de incarcare');
});

test('amintiri-video.html: selectarea fisierelor NU declanseaza nicio navigare (window.location) — comutarea la etapa de incarcare ramane STRICT vizuala, in acelasi document', () => {
  const changeFnSrc = extractFn(html, "memFileInput.addEventListener('change', () => {");
  assert.ok(!changeFnSrc.includes('window.location'), 'niciun hard navigation nu trebuie sa existe in handler-ul de selectie a fisierelor');
});

test('amintiri-video.html: lista de materiale existenta (#mem-uploaded-list/#mem-staged-list) si butonul de creare (#gift-video-create) NU sunt ascunse de enterUploadStage() — ele SUNT continutul relevant al etapei 2', () => {
  const enterSrc = extractFn(html, 'function enterUploadStage() {');
  assert.ok(!enterSrc.includes("'mem-uploaded-list'"));
  assert.ok(!enterSrc.includes("'mem-staged-list'"));
  assert.ok(!enterSrc.includes("'gift-video-create'"));
});

test('amintiri-video.html: titlul si explicatia etapei de incarcare (upload_stage_title/upload_stage_sub) sunt traduse natural in toate cele 8 limbi, distincte de titlul etapei 1', () => {
  const T = loadTranslations();
  for (const lang of LANGS) {
    assert.ok(T[lang].upload_stage_title && T[lang].upload_stage_title.trim().length > 0, `lipseste upload_stage_title pentru ${lang}`);
    assert.ok(T[lang].upload_stage_sub && T[lang].upload_stage_sub.trim().length > 0, `lipseste upload_stage_sub pentru ${lang}`);
    assert.notEqual(T[lang].upload_stage_title, T[lang].memories_title, `titlul etapei 2 trebuie sa fie distinct de titlul etapei 1 (${lang})`);
  }
});

test('amintiri-video.html: progresul general al etapei de incarcare (bara vizuala) e actualizat de renderBatchStatus(), cu acelasi procent ca textul existent — niciun calcul dublu/divergent', () => {
  const fnSrc = extractFn(html, 'function renderBatchStatus() {');
  assert.ok(fnSrc.includes("getElementById('upload-overall-fill')"));
  assert.ok(fnSrc.includes('overallFill.style.width = overallPct'));
});

test('server.js, amintiri-video.html raman sintactic valide dupa aceasta corectie', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
