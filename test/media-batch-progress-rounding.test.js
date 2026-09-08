// CORECȚIE (2026-09-08, TASK 2 — bug real raportat de client: "UI a aratat global 100% / 29 din
// 30, in timp ce ultimul material era inca activ"): renderBatchStatus() calcula procentul agregat
// prin Math.round(doneBytes/totalBytes*100), care poate rotunji ÎN SUS la 100 chiar daca inca
// exista materiale active (activeEntries.length > 0) — un rest de sub jumatate de procent
// (ponderat pe octeti) e suficient pentru Math.round(). Acest fisier executa REAL
// renderBatchStatus() extras din fiecare din cele 3 pagini cu coada proprie de upload, cu
// exact scenariul reclamat (29 materiale mici deja confirmate + 1 material mare inca 'uploading'
// la un progres care rotunjeste altfel la 100%), si verifica ca procentul afisat ramane STRICT
// sub 100 cat timp lotul nu s-a terminat cu adevarat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) { return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'); }
const PAGES = ['amintiri-video.html', 'comanda-mea.html', 'succes.html'];

function extractFn(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function makeFakeElement() {
  return { style: {}, classList: { toggle() {}, add() {}, remove() {} }, textContent: '', setAttribute() {} };
}

// IMPORTANT: `new Function(...params)(...args)` leaga valorile primitive PRIN VALOARE, o singura
// data, la constructie — mutatiile ulterioare ale obiectului `overrides` NU se mai propaga in
// interiorul functiei intoarse. De aceea starea dorita trebuie transmisa AICI, la constructie,
// niciodata setata dupa aceea pe obiectul de stare.
function loadRenderBatchStatus(html, overrides) {
  const src = extractFn(html, 'function renderBatchStatus() {');
  const elements = new Map();
  function elementFor(id) { if (!elements.has(id)) elements.set(id, makeFakeElement()); return elements.get(id); }
  const t = {
    memories_dont_close: '',
    memories_batch_done: (n) => `${n} gata`,
    memories_batch_errors: (done, total, errs) => `${done}/${total}, ${errs} erori`,
    memories_batch_progress: (done, total, pct) => `${done} din ${total} — ${pct}%`
  };
  const sandbox = Object.assign({
    uploadQueue: [],
    memBatchTotal: 0,
    memBatchDoneCount: 0,
    memBatchBytesDone: 0,
    memBatchTotalBytes: 0,
    t,
    document: { getElementById: (id) => elementFor(id) },
    setLoaderProgressAttrs: (pct) => { elementFor('mem-batch-loader-pct').textContent = pct + '%'; }
  }, overrides);
  const fn = new Function(...Object.keys(sandbox), `${src}\nreturn renderBatchStatus;`)(...Object.values(sandbox));
  return { fn, t, elementFor };
}

for (const page of PAGES) {
  test(`${page}: renderBatchStatus() NU mai poate afisa 100% cat timp un material e inca activ (29 din 30 confirmate, ultimul 'uploading' la un progres care ar rotunji altfel la 100%)`, () => {
    const html = read(path.join('public', page));
    // 29 materiale mici deja confirmate (memBatchBytesDone), + 1 material MARE inca 'uploading',
    // cu progres suficient de aproape de 100% ca ponderea pe octeti sa rotunjeasca la 100 fara
    // plafonare explicita — exact scenariul real raportat.
    const smallDoneBytes = 29 * 1024 * 1024; // 29 poze mici, deja confirmate
    const bigFileSize = 800 * 1024 * 1024; // ultimul, mare (.mov)
    const { fn, elementFor } = loadRenderBatchStatus(html, {
      memBatchTotal: 30,
      memBatchDoneCount: 29,
      memBatchBytesDone: smallDoneBytes,
      memBatchTotalBytes: smallDoneBytes + bigFileSize,
      uploadQueue: [
        { localId: 'q-last', status: 'uploading', progress: 99.94, file: { size: bigFileSize } }
      ]
    });

    fn();

    const statusEl = elementFor('mem-batch-status');
    const fillEl = elementFor('upload-overall-fill');
    const pctEl = elementFor('mem-batch-loader-pct');

    assert.doesNotMatch(statusEl.textContent, /— 100%$/, `${page}: textul agregat nu trebuie sa arate 100% cat timp mai exista un material activ (29 din 30 nu inseamna gata)`);
    assert.notEqual(fillEl.style.width, '100%', `${page}: bara de progres nu trebuie sa ajunga la 100% latime cat timp lotul nu s-a terminat`);
    assert.notEqual(pctEl.textContent, '100%', `${page}: procentul decorativ nu trebuie sa arate 100% cat timp lotul nu s-a terminat`);
  });

  test(`${page}: renderBatchStatus() arata textul de finalizare (nu procentul agregat) cand coada s-a golit complet (toate confirmate, eliminate din coada la succes) — ramura reala de finalizare ramane neschimbata de aceasta corectie`, () => {
    const html = read(path.join('public', page));
    const { fn, t, elementFor } = loadRenderBatchStatus(html, {
      memBatchTotal: 30,
      memBatchDoneCount: 30,
      memBatchBytesDone: 30 * 1024 * 1024,
      memBatchTotalBytes: 30 * 1024 * 1024,
      uploadQueue: [] // coada goala — totul confirmat, eliminat din coada la succes (comportament existent, neatins)
    });

    fn();

    const statusEl = elementFor('mem-batch-status');
    assert.equal(statusEl.textContent, t.memories_batch_done(30), `${page}: la finalizare completa, textul trebuie sa confirme cele 30 de materiale`);
  });
}
