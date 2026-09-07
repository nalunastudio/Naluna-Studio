// PUNCT (2026-09-07, cauza demonstrata a incarcarii NECOMPRIMATE a unui video de 841MB):
// maybeCompressVideo() decidea daca un fisier e "video" STRICT dupa file.type.indexOf('video'),
// spre deosebire de isVideoFile() (deja folosit in amintiri-video.html/comanda-mea.html/
// succes.html pentru afisarea iconitei), care are o rezerva pe EXTENSIA fisierului cand
// file.type e gol — comportament documentat al Safari/iOS pentru anumite fisiere .mov. Un
// fisier asa nu ajungea NICIODATA la verificarea de beneficiu/WebCodecs, indiferent cat de mare
// era. Acest fisier verifica STRICT ca looksLikeVideoFile() e acum aliniata la aceeasi logica.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'media-compress.js'), 'utf8');
  const fakeWindow = { document: { createElement: () => ({ addEventListener() {} }) }, URL: {} };
  const fn = new Function('window', 'globalThis', 'document', 'URL', src + '\nreturn window.NalunaMediaCompress;');
  return fn(fakeWindow, fakeWindow, fakeWindow.document, fakeWindow.URL);
}

const mod = loadModule();

test('looksLikeVideoFile: este exportata pe global.NalunaMediaCompress', () => {
  assert.equal(typeof mod.looksLikeVideoFile, 'function');
});

test('looksLikeVideoFile: file.type = "video/mp4" -> true (calea normala, marea majoritate a cazurilor)', () => {
  assert.equal(mod.looksLikeVideoFile({ type: 'video/mp4', name: 'clip.mp4' }), true);
});

test('looksLikeVideoFile: file.type = "image/jpeg" -> false, INDIFERENT de extensia numelui (type-ul e sursa de adevar cand exista)', () => {
  assert.equal(mod.looksLikeVideoFile({ type: 'image/jpeg', name: 'poza.mov' }), false);
});

test('looksLikeVideoFile: file.type GOL + extensie .mov -> true (EXACT cazul real, documentat, al fisierului de 841MB de pe iPhone care nu ajungea niciodata la compresie)', () => {
  assert.equal(mod.looksLikeVideoFile({ type: '', name: 'IMG_1234.MOV' }), true);
});

test('looksLikeVideoFile: file.type GOL + extensie necunoscuta -> false (nu presupune orice fisier fara type e video)', () => {
  assert.equal(mod.looksLikeVideoFile({ type: '', name: 'document.pdf' }), false);
});

test('looksLikeVideoFile: file.type GOL + fara nume -> false, fara sa arunce', () => {
  assert.doesNotThrow(() => assert.equal(mod.looksLikeVideoFile({ type: '', name: '' }), false));
});

test('looksLikeVideoFile: acopera exact extensiile deja folosite de isVideoFile() in cele 3 pagini (.mp4, .m4v, .mov, .webm)', () => {
  for (const ext of ['.mp4', '.m4v', '.mov', '.webm']) {
    assert.equal(mod.looksLikeVideoFile({ type: '', name: `fisier${ext.toUpperCase()}` }), true, `extensia ${ext} trebuie recunoscuta indiferent de majuscule`);
  }
});

test('maybeCompressVideo: fisier cu type gol si extensie .mov ajunge acum la verificarea WebCodecs (nu mai cade imediat pe "nu_e_video")', async () => {
  const result = await mod.maybeCompressVideo({ type: '', name: 'IMG_9999.mov', size: 500 * 1024 * 1024 }, {});
  assert.notEqual(result.reason, 'nu_e_video');
});

test('maybeCompressVideo: fiecare ramura de intoarcere include acum durationMs (numeric) — instrumentare ceruta pentru diagnosticul de compresie', async () => {
  const notVideo = await mod.maybeCompressVideo({ type: 'image/jpeg', name: 'poza.jpg', size: 1000 }, {});
  assert.equal(typeof notVideo.durationMs, 'number');
});
