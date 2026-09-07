// PUNCT (2026-09-07, Task 3 "Upload" — instrumentare ceruta pentru maybeCompressVideo(): compresie
// incercata; WebCodecs disponibil; cod de motiv succes/fallback; octeti originali; octeti
// rezultati; durata compresiei; durata upload-ului): verifica STRUCTURAL, in cele 3 pagini cu
// coada proprie de upload (amintiri-video.html, comanda-mea.html, succes.html), ca
// entry.compressInfo e populat dupa maybeCompressVideo() si ca sendCompressUploadBeacon()
// trimite EXACT campurile cerute, STRICT dupa un upload reusit, fara nume de fisier sau continut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = ['amintiri-video.html', 'comanda-mea.html', 'succes.html'];
function read(page) { return fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8'); }

for (const page of PAGES) {
  test(`${page}: startOptimize() populeaza entry.compressInfo cu STRICT flag-uri/coduri/octeti/durate, niciodata nume de fisier sau continut`, () => {
    const html = read(page);
    const idx = html.indexOf('async function startOptimize(entry) {');
    assert.notEqual(idx, -1);
    const body = html.slice(idx, idx + 2000);
    assert.match(body, /entry\.compressInfo = \{/);
    assert.match(body, /webCodecsAvailable: true/);
    assert.match(body, /reason: result && result\.reason/);
    assert.match(body, /compressed: !!\(result && result\.compressed\)/);
    assert.match(body, /originalBytes: entry\.file\.size/);
    assert.match(body, /resultingBytes: \(result && result\.compressedSize\) \|\| null/);
    assert.match(body, /durationMs: result && result\.durationMs/);
  });

  test(`${page}: startUpload() marcheaza entry.uploadStartedAt INAINTE de a porni efectiv uploadul (single sau multipart)`, () => {
    const html = read(page);
    const idx = html.indexOf('function startUpload(entry) {');
    assert.notEqual(idx, -1);
    const body = html.slice(idx, idx + 400);
    const markIdx = body.indexOf('entry.uploadStartedAt = Date.now();');
    const branchIdx = body.search(/startMultipartUpload\(entry\)|startSingleUpload\(entry\)/);
    assert.notEqual(markIdx, -1, `${page}: uploadStartedAt trebuie setat in startUpload()`);
    assert.ok(markIdx < branchIdx, `${page}: uploadStartedAt trebuie marcat INAINTE de a alege calea de upload`);
  });

  test(`${page}: sendCompressUploadBeacon() exista, e no-op fara compressInfo, si trimite STRICT evenimente tehnice (fara nume de fisier/continut) catre /media/client-timing cu flow "media_compress"`, () => {
    const html = read(page);
    const idx = html.indexOf('function sendCompressUploadBeacon(entry) {');
    assert.notEqual(idx, -1, `${page}: sendCompressUploadBeacon lipseste`);
    const body = html.slice(idx, idx + 1200);
    assert.match(body, /if \(!entry\.compressInfo/, `${page}: trebuie sa fie no-op fara compressInfo`);
    assert.match(body, /flow: 'media_compress'/);
    assert.match(body, /event: 'webcodecs_available'/);
    assert.match(body, /event: `reason_\$\{entry\.compressInfo\.reason\}`/);
    assert.match(body, /event: 'compressed'/);
    assert.match(body, /event: 'original_bytes'/);
    assert.match(body, /event: 'resulting_bytes'/);
    assert.match(body, /event: 'compress_duration_ms'/);
    assert.match(body, /event: 'upload_duration_ms'/);
    assert.match(body, /keepalive: true/);
    assert.doesNotMatch(body, /entry\.file\.name|\.originalname\b/, `${page}: beaconul nu trebuie sa trimita niciodata numele fisierului`);
  });

  test(`${page}: sendCompressUploadBeacon(entry) e apelat STRICT dupa un raspuns de succes, atat pe calea de upload single cat si pe cea multipart`, () => {
    const html = read(page);
    const singleIdx = html.indexOf('function startSingleUpload(entry) {');
    assert.notEqual(singleIdx, -1);
    const singleEndIdx = html.indexOf('function startMultipartUpload', singleIdx);
    const singleBody = html.slice(singleIdx, singleEndIdx === -1 ? singleIdx + 3000 : singleEndIdx);
    const singleSuccessIdx = singleBody.search(/if \(xhr\.status >= 200 && xhr\.status < 300 && succeeded\) \{/);
    assert.notEqual(singleSuccessIdx, -1, `${page}: blocul de succes single-upload lipseste`);
    const singleSuccessBody = singleBody.slice(singleSuccessIdx, singleSuccessIdx + 150);
    assert.match(singleSuccessBody, /sendCompressUploadBeacon\(entry\);/, `${page}: succesul single-upload trebuie sa trimita beaconul`);

    const multipartIdx = html.indexOf('startMultipartUpload(entry) {');
    assert.notEqual(multipartIdx, -1);
    const multipartBody = html.slice(multipartIdx, multipartIdx + 4000);
    const multipartSuccessIdx = multipartBody.search(/if \(completeRes\.ok && succeeded\) \{/);
    assert.notEqual(multipartSuccessIdx, -1, `${page}: blocul de succes multipart lipseste`);
    const multipartSuccessBody = multipartBody.slice(multipartSuccessIdx, multipartSuccessIdx + 150);
    assert.match(multipartSuccessBody, /sendCompressUploadBeacon\(entry\);/, `${page}: succesul multipart trebuie sa trimita beaconul`);
  });

  test(`${page}: progresul de upload single NU mai poate atinge literal 100 inainte de confirmarea serverului (plafonat la 99, aliniat la calea multipart care era deja corecta)`, () => {
    const html = read(page);
    const idx = html.indexOf('function startSingleUpload(entry) {');
    assert.notEqual(idx, -1);
    const body = html.slice(idx, idx + 1500);
    assert.match(body, /entry\.progress = Math\.min\(99, pct\);/, `${page}: progresul trebuie plafonat la 99`);
  });

  test(`${page}: ramane sintactic valid dupa instrumentarea de upload/compresie`, () => {
    const html = read(page);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach(m => assert.doesNotThrow(() => new Function(m[1])));
  });
}
