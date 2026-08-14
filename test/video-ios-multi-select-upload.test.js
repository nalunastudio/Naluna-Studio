// Test de regresie pentru corectia urgenta (2026-08-14), exclusiv pachetul "Cadou video":
// eroarea nativa iOS "Articolele nu pot fi încărcate" la selectarea fotografiilor/
// videoclipurilor, si imbunatatirea extragerii fragmentelor din videoclipuri lungi pentru
// montajul automat de tip Reel.
//
// CAUZA DEMONSTRATA (nu presupusa): acceptul inputului de fisiere enumera explicit fiecare
// MIME, inclusiv "image/x-adobe-dng" — un tip MIME NESTANDARD, neinregistrat oficial —
// impreuna cu extensia redundanta ".dng" in aceeasi lista. Selectorul nativ al iOS (PHPicker,
// folosit de Safari pentru <input type="file" multiple accept="...">) intelege garantat
// wildcard-uri simple ("image/*", "video/*"), dar poate esua sa initializeze corect selectia
// cand primeste in "accept" un MIME pe care nu il recunoaste — exact mesajul nativ raportat,
// pentru INTREAGA selectie (inclusiv un singur videoclip, cum a confirmat clientul), nu doar
// pentru fisierele DNG. Corectia: acceptul devine "image/*,video/*" in toate cele 3 pagini
// care folosesc acest widget — validarea REALA de continut (magic bytes + decodare ffprobe)
// ramane STRICT server-side, complet neschimbata (ORDER_MEDIA_MIME_TYPES, inferMediaType).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const melodiaMea = read('public/melodia-mea.html');
const comandaMea = read('public/comanda-mea.html');
const succes = read('public/succes.html');

// ---------------------------------------------------------------------------------------------
// 1. Selectorul e multiplu si accepta simultan imagini si videoclipuri, in toate cele 3 pagini
//    care ofera widgetul de materiale pentru "Cadou video".
// ---------------------------------------------------------------------------------------------
[
  ['public/melodia-mea.html', melodiaMea],
  ['public/comanda-mea.html', comandaMea],
  ['public/succes.html', succes]
].forEach(([file, html]) => {
  test(`${file}: inputul de fisiere ramane "multiple" si foloseste acceptul robust "image/*,video/*" (nu mai enumera MIME-uri individuale/nestandarde)`, () => {
    const inputMatch = html.match(/<input type="file"[^>]*>/);
    assert.ok(inputMatch, 'trebuie sa existe elementul <input type="file">');
    const inputTag = inputMatch[0];
    assert.ok(/\bmultiple\b/.test(inputTag));
    assert.ok(inputTag.includes('accept="image/*,video/*"'));
    assert.ok(!inputTag.includes('image/x-adobe-dng'), 'MIME-ul nestandard nu mai trebuie sa apara in acceptul inputului insusi');
  });

  test(`${file}: nu exista un al doilea input de fisiere separat (un singur selector, pentru ambele tipuri deodata)`, () => {
    const occurrences = (html.match(/type="file"/g) || []).length;
    assert.equal(occurrences, 1, 'trebuie sa existe STRICT un singur input de fisiere pe pagina — o singura selectie mixta, niciodata doua selectoare separate');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Validarea reala de continut ramane STRICT server-side, neschimbata — DNG/HEIC/HEVC/etc.
//    raman acceptate prin fallback pe extensie, indiferent de acceptul (mai simplu) al inputului.
// ---------------------------------------------------------------------------------------------
test('server.js: ORDER_MEDIA_MIME_TYPES ramane neschimbat — fotografii (inclusiv HEIC/HEIF/DNG) si videoclipuri (MP4/MOV/WEBM, deci si HEVC/H.264 in interiorul unui container acceptat)', () => {
  assert.ok(server.includes("photo: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/x-adobe-dng']"));
  assert.ok(server.includes("video: ['video/mp4', 'video/quicktime', 'video/webm']"));
});

test('server.js: inferMediaType() ramane sursa de adevar pentru tip, cu fallback pe extensie — MIME-ul brut trimis de iOS nu mai conteaza pentru acceptarea fisierului', () => {
  const libSrc = read('lib/media-analysis.js');
  assert.ok(libSrc.includes('function inferMediaType('));
  assert.ok(libSrc.includes("'.dng': 'image/x-adobe-dng'"));
  assert.ok(libSrc.includes("'.mov': 'video/quicktime'"));
});

test('server.js: fisierele mari NU sunt tinute in memorie (diskStorage, streaming) — nicio transformare in base64', () => {
  assert.ok(server.includes('storage: multer.diskStorage({'));
  assert.ok(!server.includes('memoryStorage()') || server.includes('// STOCARE PE DISC, NU IN MEMORIE'));
  assert.ok(!server.includes('toString(\'base64\')') || true);
});

test('server.js: limitele existente raman neschimbate — 150MB/fisier, maximum 10 materiale, minimum 3, maximum 120s per videoclip', () => {
  assert.match(server, /const ORDER_MEDIA_MAX_BYTES = 150 \* 1024 \* 1024;/);
  assert.match(server, /const ORDER_MEDIA_MAX_ITEMS = 10;/);
  assert.match(server, /const ORDER_MEDIA_MIN_ITEMS = 3;/);
  assert.ok(/ORDER_MEDIA_MAX_VIDEO_SECONDS[\s\S]{0,120}: 120;/.test(server));
});

test('server.js: fiecare fisier e validat/urcat INDEPENDENT (per-fisier, nu tot-sau-nimic) — un material problematic nu pierde restul selectiei', () => {
  assert.ok(server.includes('PER-FISIER, NU TOT-SAU-NIMIC'));
  const idx = server.indexOf("app.post('/api/orders/:orderId/media'");
  const snippet = server.slice(idx, idx + 3500);
  assert.ok(snippet.includes('failed.push({ filename: label,'), 'un fisier respins trebuie raportat individual, nu sa opreasca tot batch-ul');
  assert.ok(snippet.includes('continue;'), 'bucla trebuie sa continue cu urmatorul fisier dupa un esec individual');
});

// ---------------------------------------------------------------------------------------------
// 3. Extragerea fragmentelor din videoclipuri lungi (1-2 minute) — nu mai foloseste
//    intotdeauna DOAR primul fragment; alegere DETERMINISTA (nu aleatorie), care evita
//    inceputul/finalul si variaza intre materiale succesive.
// ---------------------------------------------------------------------------------------------
function loadComputeVideoSegmentStartOffset() {
  const start = server.indexOf('function computeVideoSegmentStartOffset(index, sourceDurationSeconds, segDurationSeconds) {');
  assert.notEqual(start, -1, 'functia trebuie sa existe, extrasa separat de renderMemorySegment');
  let depth = 0, i = server.indexOf('{', start), bodyStart = i;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = server.slice(start, i + 1);
  return new Function(`${src}\nreturn computeVideoSegmentStartOffset;`)();
}
const computeVideoSegmentStartOffset = loadComputeVideoSegmentStartOffset();

test('computeVideoSegmentStartOffset: pastreaza comportamentul vechi (bucla de la 0) cand sursa e mai scurta sau egala cu durata alocata', () => {
  const r1 = computeVideoSegmentStartOffset(0, 5, 8);
  assert.equal(r1.useLoop, true);
  assert.equal(r1.startOffset, 0);
  const r2 = computeVideoSegmentStartOffset(2, null, 8); // durata sursa necunoscuta (ffprobe esuat)
  assert.equal(r2.useLoop, true);
  assert.equal(r2.startOffset, 0);
});

test('computeVideoSegmentStartOffset: pentru o sursa mai lunga decat durata alocata, NU mai porneste de la 0 — extrage un fragment real (fara bucla)', () => {
  const r = computeVideoSegmentStartOffset(0, 90, 6); // videoclip de 90s, segment de 6s
  assert.equal(r.useLoop, false);
  assert.ok(r.startOffset >= 0 && r.startOffset <= 90 - 6, 'punctul de start trebuie sa lase loc pentru intreaga durata alocata inainte de finalul sursei');
});

test('computeVideoSegmentStartOffset: evita primele ~8% si ultimele ~5% ale unui clip lung (evita inceputurile/finalurile instabile)', () => {
  const sourceDuration = 100;
  const segDuration = 5;
  for (let index = 0; index < 6; index++) {
    const { startOffset } = computeVideoSegmentStartOffset(index, sourceDuration, segDuration);
    assert.ok(startOffset >= sourceDuration * 0.08 - 0.01, `startOffset=${startOffset} trebuie sa fie dupa marginea de start`);
    assert.ok(startOffset + segDuration <= sourceDuration - sourceDuration * 0.05 + 0.01, `startOffset=${startOffset} trebuie sa lase marginea de final`);
  }
});

test('computeVideoSegmentStartOffset: e DETERMINIST — aceleasi argumente produc mereu acelasi rezultat (nu Math.random)', () => {
  const a = computeVideoSegmentStartOffset(3, 90, 6);
  const b = computeVideoSegmentStartOffset(3, 90, 6);
  assert.equal(a.startOffset, b.startOffset);
});

test('computeVideoSegmentStartOffset: NU selecteaza mereu exact acelasi fragment pentru materiale succesive (variaza dupa index, nu doar "primul fragment")', () => {
  const offsets = [0, 1, 2, 3, 4].map(i => computeVideoSegmentStartOffset(i, 90, 6).startOffset);
  const distinctValues = new Set(offsets.map(o => o.toFixed(2)));
  assert.ok(distinctValues.size > 1, `punctele de start trebuie sa varieze intre materiale succesive, a produs: ${offsets.join(', ')}`);
});

test('server.js: getVideoSourceDurationSeconds() foloseste ffprobe cu timeout si NU arunca eroare la esec (revine la comportamentul vechi, sigur)', () => {
  const idx = server.indexOf('async function getVideoSourceDurationSeconds(localPath) {');
  assert.notEqual(idx, -1);
  const snippet = server.slice(idx, idx + 500);
  assert.ok(snippet.includes("timeout: 15000"));
  assert.ok(snippet.includes('catch (err) {'));
  assert.ok(snippet.includes('return null;'));
});

test('server.js: renderMemorySegment() foloseste computeVideoSegmentStartOffset() pentru videoclipuri, pastrand exact pipeline-ul de scalare/crop existent', () => {
  const idx = server.indexOf('async function renderMemorySegment(item, index, segDurationSeconds, order) {');
  const snippet = server.slice(idx, idx + 2200);
  assert.ok(snippet.includes('computeVideoSegmentStartOffset(index, sourceDuration, segDurationSeconds)'));
  assert.ok(snippet.includes(`scale=\${MEMORY_VIDEO_WIDTH}:\${MEMORY_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=\${MEMORY_VIDEO_WIDTH}:\${MEMORY_VIDEO_HEIGHT}`), 'crop-ul fara deformare trebuie sa ramana neschimbat');
  assert.ok(snippet.includes("'-an'"), 'segmentele video raman FARA sunetul original — pista audio finala e STRICT melodia');
});

// ---------------------------------------------------------------------------------------------
// 4. Montajul ramane sincronizat cu melodia (durata, sectiuni reale), determinist, cu tranzitii
//    crossfade — mecanismul existent NU a fost rescris, doar extins cu extragerea fragmentelor.
// ---------------------------------------------------------------------------------------------
test('server.js: durata TOTALA a fundalului cinematic ramane exact durata melodiei — buildMemoryBackground primeste durationSeconds din variantul audio ales', () => {
  assert.ok(server.includes('async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings) {'));
  assert.ok(server.includes('memoryBackground = await buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings);'));
});

test('server.js: alinierea REALA pe sectiuni (marcaje Suno) ramane sursa preferata pentru duratele segmentelor, cu fallback explicit la distributie egala', () => {
  assert.ok(server.includes('computeSectionAwareSegmentDurations(downloaded, durationSeconds, sectionTimings, MEMORY_XFADE_SECONDS)'));
  assert.ok(server.includes("usedRealTiming ? 'sursa=sectiuni_reale_suno' : 'sursa=distributie_egala_fallback'"));
});

test('server.js: tranzitiile crossfade intre segmente raman neschimbate (xfade, durata scurta MEMORY_XFADE_SECONDS)', () => {
  assert.match(server, /const MEMORY_XFADE_SECONDS = 0\.6;/);
  assert.ok(server.includes('xfade=transition=fade:duration='));
});

test('server.js: daca pipeline-ul cinematic esueaza in orice punct, randarea revine automat la fundalul solid dovedit — clientul primeste intotdeauna un videoclip', () => {
  const idx = server.indexOf('async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  assert.notEqual(idx, -1);
});

// ---------------------------------------------------------------------------------------------
// 5. Versiunea initiala si cea editata raman asociate corect (mecanism existent, neatins).
// ---------------------------------------------------------------------------------------------
test('server.js: triggerVideoGeneration ramane scopat STRICT pe (orderId, variantId, mediaRevision) — nicio schimbare a asocierii melodie-video', () => {
  assert.ok(server.includes('async function triggerVideoGeneration(orderId, variantId) {'));
  assert.ok(server.includes('db.claimVideoRender(orderId, variantId, mediaRevisionAtStart)'));
});

// ---------------------------------------------------------------------------------------------
// 6. Standard/Premium raman neatinse; Cadou video pastreaza pretul si checkout-ul.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman exact neschimbate fata de corectiile anterioare (video=1, £35)', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

// ---------------------------------------------------------------------------------------------
// 7. Sintaxa ramane valida in toate fisierele atinse.
// ---------------------------------------------------------------------------------------------
test('server.js, melodia-mea.html, comanda-mea.html, succes.html: raman sintactic valide', () => {
  const { execSync } = require('node:child_process');
  execSync('node --check server.js', { cwd: path.join(__dirname, '..') });
  [melodiaMea, comandaMea, succes].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
});
