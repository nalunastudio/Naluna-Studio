// PUNCT (2026-09-07): verifica STRUCTURAL ca cele 3 pagini cu coada proprie de upload media
// (amintiri-video.html, comanda-mea.html, succes.html) incarca modulul de compresie si
// orchestreaza corect compresia video INDEPENDENT de bugetul de upload — vezi public/js/
// media-compress.js pentru logica propriu-zisa (deja testata separat, real, in celelalte
// fisiere din aceasta runda).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = ['amintiri-video.html', 'comanda-mea.html', 'succes.html'];
function read(page) { return fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8'); }

for (const page of PAGES) {
  test(`${page}: incarca public/js/media-compress.js INAINTE de scriptul principal inline`, () => {
    const html = read(page);
    const scriptTagIdx = html.indexOf('<script src="/js/media-compress.js"></script>');
    const inlineScriptIdx = html.indexOf('<script>');
    assert.notEqual(scriptTagIdx, -1, `${page} trebuie sa incarce media-compress.js`);
    assert.ok(scriptTagIdx < inlineScriptIdx, `${page}: media-compress.js trebuie incarcat INAINTE de scriptul inline care il foloseste`);
  });

  test(`${page}: are logica de compresie INDEPENDENTA de bugetul de upload (nu consuma un slot din concurenta de upload) si limitata la o singura compresie simultana`, () => {
    const html = read(page);
    assert.match(html, /const MAX_CONCURRENT_OPTIMIZATIONS = 1;/);
    assert.match(html, /function maybeStartOptimizing\(\) \{/);
    assert.match(html, /async function startOptimize\(entry\) \{/);
    assert.match(html, /window\.NalunaMediaCompress && window\.NalunaMediaCompress\.isWebCodecsSupported\(\)/);
    assert.match(html, /await window\.NalunaMediaCompress\.maybeCompressVideo\(entry\.file/);
  });

  test(`${page}: processUploadQueue() apeleaza maybeStartOptimizing() la FIECARE reevaluare a cozii — compresia porneste STRICT cand exista un candidat, niciodata blocand uploadurile deja pornite`, () => {
    const html = read(page);
    const idx = html.indexOf('function processUploadQueue() {');
    assert.notEqual(idx, -1);
    const body = html.slice(idx, idx + 300);
    assert.match(body, /maybeStartOptimizing\(\);/);
  });

  test(`${page}: startOptimize() NU arunca niciodata mai departe — orice eroare e prinsa, comanda revine la 'pending' (fisierul original, daca nu s-a compresat) si coada continua`, () => {
    const html = read(page);
    const idx = html.indexOf('async function startOptimize(entry) {');
    assert.notEqual(idx, -1);
    // fereastra marita (2026-09-07, instrumentarea compressInfo pentru diagnosticul de
    // compresie video — vezi media-picker-timing-diagnostic.test.js).
    const body = html.slice(idx, idx + 2000);
    assert.match(body, /catch \(e\) \{/);
    assert.match(body, /entry\.status = 'pending';/);
    assert.match(body, /processUploadQueue\(\);/);
  });

  test(`${page}: cheia de traducere "memories_optimizing_pct" exista de exact 8 ori (o data per limba)`, () => {
    const html = read(page);
    const occurrences = (html.match(/memories_optimizing_pct:/g) || []).length;
    assert.equal(occurrences, 8, `${page}: asteptat 8 aparitii, gasit ${occurrences}`);
  });

  test(`${page}: randul din coada afiseaza starea 'optimizing' distinct (text propriu) si dezactiveaza butonul de stergere cat timp optimizarea e in curs`, () => {
    const html = read(page);
    assert.match(html, /q\.status === 'optimizing' \? t\.memories_optimizing_pct\(q\.progress\)/);
    assert.match(html, /q\.status === 'uploading' \|\| q\.status === 'processing' \|\| q\.status === 'optimizing'/);
  });

  test(`${page}: ramane sintactic valid dupa cablarea compresiei`, () => {
    const html = read(page);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach(m => assert.doesNotThrow(() => new Function(m[1])));
  });
}

// ---------------------------------------------------------------------------------------------
// DECIZIE DELIBERATA (punctul 4 al cerintei, "paralelism upload"): concurenta de upload/parti NU
// a fost crescuta — nicio dovada reala (dispozitiv/retea mobila reala) nu justifica o schimbare,
// iar castigul principal vine deja din compresie (reduce octetii de transmis, nu numarul de
// conexiuni simultane). Test de regresie STRICT ca aceasta decizie sa ramana intentionata, nu
// modificata accidental fara discutie.
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: MAX_CONCURRENT_UPLOADS si MEM_MAX_PARALLEL_PARTS raman NESCHIMBATE (2, respectiv 2) — decizie deliberata, fara dovezi reale de dispozitiv care sa justifice cresterea', () => {
  const html = read('amintiri-video.html');
  assert.match(html, /const MAX_CONCURRENT_UPLOADS = 2;/);
  assert.match(html, /const MEM_MAX_PARALLEL_PARTS = 2;/);
});
test('comanda-mea.html/succes.html: MEM_MAX_CONCURRENT_UPLOADS si MEM_MAX_PARALLEL_PARTS raman NESCHIMBATE (2, respectiv 2)', () => {
  for (const page of ['comanda-mea.html', 'succes.html']) {
    const html = read(page);
    assert.match(html, /const MEM_MAX_CONCURRENT_UPLOADS = 2;/, `${page}: MEM_MAX_CONCURRENT_UPLOADS`);
    assert.match(html, /const MEM_MAX_PARALLEL_PARTS = 2;/, `${page}: MEM_MAX_PARALLEL_PARTS`);
  }
});

test('public/js/media-compress.js: fisierul exista si e servit ca STATIC (nu necesita nicio schimbare de CSP — script-src "self" acopera deja fisiere same-origin cu src=)', () => {
  const filePath = path.join(__dirname, '..', 'public', 'js', 'media-compress.js');
  assert.ok(fs.existsSync(filePath));
  const csp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'csp.js'), 'utf8');
  assert.match(csp, /scriptSrc: \["'self'"/);
});
