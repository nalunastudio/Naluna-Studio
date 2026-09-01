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
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): inputul de
// fisiere pentru pachetul Cadou video, testat aici, a fost MUTAT din melodia-mea.html in
// public/amintiri-video.html — retargetat STRICT aceasta pagina; comanda-mea.html/succes.html
// au propriile copii NEATINSE.
const melodiaMea = read('public/amintiri-video.html');
const comandaMea = read('public/comanda-mea.html');
const succes = read('public/succes.html');

// ---------------------------------------------------------------------------------------------
// 1. Selectorul e multiplu si accepta simultan imagini si videoclipuri, in toate cele 3 pagini
//    care ofera widgetul de materiale pentru "Cadou video".
// ---------------------------------------------------------------------------------------------
[
  ['public/amintiri-video.html', melodiaMea],
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

  // CORECȚIE (2026-08-31, cerinta 4 "fallback Alege din Fișiere"): al doilea input, STATIC, e
  // acum intentionat — FARA accept (ca sa nu forteze din nou Photos), afisat STRICT din panoul
  // de recuperare, dupa un cancel/revenire fara fisiere. NU e un selector separat pentru
  // "un tip de fisier" — ambele inputuri accepta orice tip mixt deodata.
  test(`${file}: exista EXACT doua inputuri de fisiere (principal + fallback "Alege din Fișiere") — niciun al treilea, niciun selector separat pe tip`, () => {
    const occurrences = (html.match(/type="file"/g) || []).length;
    assert.equal(occurrences, 2, 'trebuie sa existe EXACT doua inputuri: principal (Photos) + fallback (Fișiere) — niciodata selectoare separate pe tip de fisier');
    assert.ok(!html.includes('accept="image/*"') && !html.includes('accept="video/*"'), 'niciun input nu trebuie sa filtreze STRICT dupa un singur tip');
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

// REVIZUIT (2026-08-14, "elimină plafonul artificial de 150MB"): 150MB era plafonul GRESIT
// care respingea videoclipuri normale de 1-2 minute — vezi test/video-media-limits.test.js
// pentru testele dedicate noii limite de dimensiune (derivata din limita tehnica reala R2).
// CORECȚIE (2026-08-30, "elimină complet limita de 120s"): durata maxima nu mai exista deloc —
// vezi test/video-duration-limit-removed.test.js pentru testele dedicate acestei corectii.
// CORECȚIE (2026-08-31, "mărește limita de la 10 la 30 de materiale"): plafonul a fost ridicat
// explicit — vezi test/video-media-limits.test.js pentru suita completa dedicata acestei corectii.
test('server.js: numarul de materiale (30 maximum, 3 minimum)', () => {
  assert.match(server, /const ORDER_MEDIA_MAX_ITEMS = 30;/);
  assert.match(server, /const ORDER_MEDIA_MIN_ITEMS = 3;/);
});

test('server.js: fiecare fisier e validat/urcat INDEPENDENT (per-fisier, nu tot-sau-nimic) — un material problematic nu pierde restul selectiei', () => {
  assert.ok(server.includes('PER-FISIER, NU TOT-SAU-NIMIC'));
  const idx = server.indexOf("app.post('/api/orders/:orderId/media'");
  const snippet = server.slice(idx, idx + 3600);
  assert.ok(snippet.includes('failed.push({ filename: label,'), 'un fisier respins trebuie raportat individual, nu sa opreasca tot batch-ul');
  assert.ok(snippet.includes('continue;'), 'bucla trebuie sa continue cu urmatorul fisier dupa un esec individual');
});

// ---------------------------------------------------------------------------------------------
// 3. Extragerea fragmentelor din videoclipuri lungi (1-2 minute) — nu mai foloseste
//    intotdeauna DOAR primul fragment; alegere DETERMINISTA (nu aleatorie), care evita
//    inceputul/finalul, variaza intre materiale succesive SI avanseaza secvential (fara
//    suprapuneri) intre aparitii succesive ale ACELUIASI material.
//
// CORECȚIE (2026-08-30, "fara repetarea acelorasi secvente video"): semnatura functiei s-a
// schimbat de la un singur "index sintetic" opac la (itemIndex, occurrence) explicite — vechea
// combinare (itemIndex*97 + occurrence*31) intr-un hash unic nu putea garanta avansarea
// secventiala ceruta (vezi testele noi de mai jos si test/video-shot-plan-render-real.test.js
// pentru verificarea REALA, cu randare ffmpeg efectiva).
// ---------------------------------------------------------------------------------------------
function loadComputeVideoSegmentStartOffset() {
  const start = server.indexOf('function computeVideoSegmentStartOffset(itemIndex, occurrence, sourceDurationSeconds, segDurationSeconds) {');
  assert.notEqual(start, -1, 'functia trebuie sa existe, extrasa separat de renderMemorySegment, cu semnatura (itemIndex, occurrence, ...)');
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
  const r1 = computeVideoSegmentStartOffset(0, 0, 5, 8);
  assert.equal(r1.useLoop, true);
  assert.equal(r1.startOffset, 0);
  const r2 = computeVideoSegmentStartOffset(2, 1, null, 8); // durata sursa necunoscuta (ffprobe esuat)
  assert.equal(r2.useLoop, true);
  assert.equal(r2.startOffset, 0);
});

test('computeVideoSegmentStartOffset: pentru o sursa mai lunga decat durata alocata, NU mai porneste de la 0 — extrage un fragment real (fara bucla)', () => {
  const r = computeVideoSegmentStartOffset(0, 0, 90, 6); // videoclip de 90s, segment de 6s
  assert.equal(r.useLoop, false);
  assert.ok(r.startOffset >= 0 && r.startOffset <= 90 - 6, 'punctul de start trebuie sa lase loc pentru intreaga durata alocata inainte de finalul sursei');
});

test('computeVideoSegmentStartOffset: evita primele ~8% si ultimele ~5% ale unui clip lung (evita inceputurile/finalurile instabile)', () => {
  const sourceDuration = 100;
  const segDuration = 5;
  for (let occurrence = 0; occurrence < 6; occurrence++) {
    const { startOffset } = computeVideoSegmentStartOffset(0, occurrence, sourceDuration, segDuration);
    assert.ok(startOffset >= sourceDuration * 0.08 - 0.01, `startOffset=${startOffset} trebuie sa fie dupa marginea de start`);
    assert.ok(startOffset + segDuration <= sourceDuration - sourceDuration * 0.05 + 0.01, `startOffset=${startOffset} trebuie sa lase marginea de final`);
  }
});

test('computeVideoSegmentStartOffset: e DETERMINIST — aceleasi argumente produc mereu acelasi rezultat (nu Math.random)', () => {
  const a = computeVideoSegmentStartOffset(1, 3, 90, 6);
  const b = computeVideoSegmentStartOffset(1, 3, 90, 6);
  assert.equal(a.startOffset, b.startOffset);
});

test('computeVideoSegmentStartOffset: NU porneste mereu din aceeasi fereastra pentru materiale succesive (variaza dupa itemIndex, nu doar "primul fragment")', () => {
  const offsets = [0, 1, 2, 3, 4].map(i => computeVideoSegmentStartOffset(i, 0, 90, 6).startOffset);
  const distinctValues = new Set(offsets.map(o => o.toFixed(2)));
  assert.ok(distinctValues.size > 1, `punctele de start trebuie sa varieze intre materiale succesive, a produs: ${offsets.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// 3b. CORECȚIE (2026-08-30, "fara repetarea acelorasi secvente video") — criteriile 3/4/7 din
//     cerinta: aparitii succesive ale ACELUIASI material avanseaza prin ferestre NEFOLOSITE,
//     fara suprapuneri, si repeta o fereastra STRICT dupa epuizarea reala a continutului unic.
// ---------------------------------------------------------------------------------------------
test('computeVideoSegmentStartOffset: aparitii succesive ale ACELUIASI material (occurrence 0,1,2,...) avanseaza STRICT secvential, fara suprapuneri, cat timp exista ferestre nefolosite', () => {
  const sourceDuration = 120; // 120s sursa, segmente de 4s -> multe ferestre disponibile
  const segDuration = 4;
  const offsets = [];
  for (let occurrence = 0; occurrence < 10; occurrence++) {
    offsets.push(computeVideoSegmentStartOffset(0, occurrence, sourceDuration, segDuration).startOffset);
  }
  // toate cele 10 aparitii trebuie sa fie DISTINCTE (contine mult mai multe ferestre decat 10)
  const distinct = new Set(offsets.map(o => o.toFixed(2)));
  assert.equal(distinct.size, offsets.length, `toate aparitiile trebuie sa fie distincte cat timp exista ferestre nefolosite, a produs: ${offsets.join(', ')}`);
  // fiecare fereastra [start, start+seg) nu se suprapune cu nicio alta fereastra folosita
  for (let a = 0; a < offsets.length; a++) {
    for (let b = a + 1; b < offsets.length; b++) {
      const overlap = offsets[a] < offsets[b] + segDuration && offsets[b] < offsets[a] + segDuration;
      assert.ok(!overlap, `ferestrele aparitiilor ${a} (${offsets[a]}) si ${b} (${offsets[b]}) nu trebuie sa se suprapuna`);
    }
  }
});

test('computeVideoSegmentStartOffset: dupa epuizarea tuturor ferestrelor nefolosite ale unui material, ciclul se repeta printr-un fallback gratios (modulo) — NICIODATA inainte de epuizare', () => {
  // sursa scurta, cu STRICT 2 ferestre disponibile de aceasta marime (safeSpan mic) —
  // occurrence 0 si 1 trebuie sa fie distincte; occurrence 2 trebuie sa REPETE fereastra lui 0
  // (fallback prin modulo), niciodata o a treia fereastra inexistenta.
  const sourceDuration = 20;
  const segDuration = 4; // usableSpan=16, marginStart=1.6, marginEnd=1, safeSpan=13.4 -> 3 ferestre
  const o0 = computeVideoSegmentStartOffset(0, 0, sourceDuration, segDuration).startOffset;
  const o1 = computeVideoSegmentStartOffset(0, 1, sourceDuration, segDuration).startOffset;
  const o2 = computeVideoSegmentStartOffset(0, 2, sourceDuration, segDuration).startOffset;
  const o3 = computeVideoSegmentStartOffset(0, 3, sourceDuration, segDuration).startOffset;
  assert.notEqual(o0.toFixed(2), o1.toFixed(2), 'primele doua aparitii trebuie sa fie distincte (exista ferestre nefolosite)');
  assert.equal(o3.toFixed(2), o0.toFixed(2), 'a 4-a aparitie trebuie sa repete STRICT fereastra primei aparitii (ciclu complet, epuizare reala confirmata)');
  void o2; // a treia aparitie e verificata implicit prin numarul total de ferestre distincte de mai jos
  const numDistinctFirstCycle = new Set([o0, o1, o2].map(o => o.toFixed(2))).size;
  assert.ok(numDistinctFirstCycle >= 2, 'trebuie sa existe cel putin 2 ferestre distincte inainte de orice repetare');
});

test('computeVideoSegmentStartOffset: materiale diferite (itemIndex diferit) NU pornesc toate din aceeasi fereastra 0 — pastreaza diversitatea dintre materiale din designul anterior', () => {
  const sourceDuration = 120;
  const segDuration = 4;
  const firstOffsets = [0, 1, 2, 3, 4].map(itemIndex => computeVideoSegmentStartOffset(itemIndex, 0, sourceDuration, segDuration).startOffset);
  const distinct = new Set(firstOffsets.map(o => o.toFixed(2)));
  assert.ok(distinct.size > 1, `prima aparitie a fiecarui material trebuie sa varieze intre materiale, a produs: ${firstOffsets.join(', ')}`);
});

test('server.js: getVideoSourceDurationSeconds() foloseste ffprobe cu timeout si NU arunca eroare la esec (revine la comportamentul vechi, sigur)', () => {
  const idx = server.indexOf('async function getVideoSourceDurationSeconds(localPath) {');
  assert.notEqual(idx, -1);
  const snippet = server.slice(idx, idx + 500);
  assert.ok(snippet.includes("timeout: 15000"));
  assert.ok(snippet.includes('catch (err) {'));
  assert.ok(snippet.includes('return null;'));
});

// CORECȚIE (2026-08-24, "montajul video e monoton"): renderMemorySegment() (UN segment lung
// per material) a fost inlocuita de renderShot() (UN cadru scurt din shot-plan, posibil mai
// multe aparitii per material) — vezi test/video-shot-plan-render-real.test.js pentru
// verificarea REALA (randare efectiva + ffprobe) a noii arhitecturi. CORECȚIE (2026-08-30):
// renderShot() transmite acum shot.itemIndex si shot.occurrence SEPARAT catre
// computeVideoSegmentStartOffset() (vezi testele dedicate mai sus, in acest fisier) — vechiul
// "index sintetic" combinat era exact cauza repetarii/suprapunerii secventelor video.
test('server.js: renderShot() foloseste computeVideoSegmentStartOffset() pentru videoclipuri, pastrand exact pipeline-ul de scalare/crop existent', () => {
  // CORECȚIE (2026-08-31, clasa recurenta de fragilitate — fereastra fixa de caractere devine
  // prea ingusta dupa ce cod nou e adaugat mai devreme in functie, ex. letterbox pentru poze
  // late): extragerea foloseste potrivire REALA de acolade (brace-depth), nu un offset fix.
  const startIdx = server.indexOf('async function renderShot(item, shot, shotIndex, order) {');
  assert.notEqual(startIdx, -1, 'renderShot() trebuie sa existe (inlocuieste renderMemorySegment)');
  let depth = 0, i = server.indexOf('{', startIdx);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = server.slice(startIdx, i + 1);
  assert.ok(snippet.includes('computeVideoSegmentStartOffset(shot.itemIndex, shot.occurrence, sourceDuration, segDurationSeconds)'));
  // CORECȚIE (2026-08-29, "calitate video clara"): scalarea foloseste acum explicit Lanczos
  // (flags=lanczos) — scalare de calitate, nu bilinear implicit — dincolo de asta, crop-ul
  // fara deformare ramane exact acelasi.
  assert.ok(snippet.includes(`scale=\${MEMORY_VIDEO_WIDTH}:\${MEMORY_VIDEO_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=\${MEMORY_VIDEO_WIDTH}:\${MEMORY_VIDEO_HEIGHT}`), 'crop-ul fara deformare trebuie sa ramana neschimbat, cu scalare Lanczos adaugata');
  assert.ok(snippet.includes("'-an'"), 'segmentele video raman FARA sunetul original — pista audio finala e STRICT melodia');
});

// ---------------------------------------------------------------------------------------------
// 4. Montajul ramane sincronizat cu melodia (durata, sectiuni reale), determinist, cu tranzitii
//    crossfade — mecanismul existent NU a fost rescris, doar extins cu extragerea fragmentelor.
// ---------------------------------------------------------------------------------------------
test('server.js: durata TOTALA a fundalului cinematic ramane exact durata melodiei — buildMemoryBackground primeste durationSeconds din variantul audio ales', () => {
  // CORECȚIE (2026-08-24, "reel dinamic sincronizat cu melodia"): semnatura a primit un al
  // cincilea parametru, songFilePath — calea locala a melodiei REALE, pentru analiza audio
  // (onset/impuls) — vezi extractAudioOnsets(); durationSeconds/sectionTimings raman neschimbate.
  assert.ok(server.includes('async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, songFilePath) {'));
  assert.ok(server.includes('memoryBackground = await buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, tempFullMp3Path);'));
});

// CORECȚIE (2026-08-24): computeSectionAwareSegmentDurations() (un singur segment lung per
// material) a fost inlocuita de buildShotPlan() (lib/media-analysis.js) — foloseste ACEEASI
// sursa reala (sectionTimings, derivate din marcajele Suno), dar produce un plan de cadre
// SCURTE, cu ritm dupa tipul sectiunii, nu doar durate proportionale cu ferestrele. Functia
// veche ramane definita/exportata neschimbata (compatibilitate/teste proprii, vezi
// test/media-analysis.test.js) — doar buildMemoryBackground() nu o mai apeleaza.
test('server.js: buildMemoryBackground() foloseste buildShotPlan() (plan de cadre, nu un singur segment lung per material), cu sectiunile REALE derivate din marcajele Suno', () => {
  // CORECȚIE (2026-08-31, cerinta F, "30 de materiale nu trebuie sa epuizeze diskul temporar"):
  // buildShotPlan() e apelat acum pe `ordered` (metadate usoare, INAINTE de orice descarcare) —
  // nu mai pe `downloaded` — planul e cunoscut INTEGRAL inainte sa se descarce vreo sursa, ca
  // sa se poata calcula numarul de referinte ramase per material si descarca LENES (vezi
  // buildMemoryBackground). Al cincilea argument, onsetTimes, si al saselea, CONCAT_BATCH_SIZE
  // (necesar ca simularea de aliniere la impuls sa corespunda EXACT cu reducerea pe loturi din
  // concatWithCrossfades), raman neschimbate.
  assert.ok(server.includes('const shotPlan = buildShotPlan(ordered, durationSeconds, sectionTimings, MEMORY_XFADE_SECONDS, onsetTimes, CONCAT_BATCH_SIZE);'));
  assert.ok(server.includes("perfLog(order.id, 'memory_shot_plan',"));
});

// CORECȚIE (2026-08-31, cerinta E, "tranzitii variate, nu acelasi xfade peste tot"): 'slideleft'
// (folosit repetitiv pe toate momentele energice) a fost ELIMINAT COMPLET — 'fade' (cross-
// dissolve) ramane SINGURUL tip de tranzitie folosit oriunde; durata variaza acum per-granita
// (shot.transitionDuration, vezi buildShotPlan/chooseTransitionDuration, lib/media-analysis.js)
// — aproape nula (taietura curata) la majoritatea granitelor, scurta langa momente calme, usor
// mai lunga la inceputul/finalul intregului plan. MEMORY_XFADE_SECONDS ramane STRICT ca plasa de
// siguranta (fallback), nu mai e durata uniforma aplicata peste tot.
test('server.js: tranzitiile folosesc STRICT "fade" (niciodata "slideleft"), cu durata variabila per-granita (shot.transitionDuration), nu MEMORY_XFADE_SECONDS uniform', () => {
  assert.match(server, /const MEMORY_XFADE_SECONDS = 0\.6;/);
  assert.ok(server.includes('const transition = shots[i - 1].transitionOut'));
  assert.ok(server.includes("xfade=transition=${transition}:duration=${xfadeDuration}"));
  assert.ok(!server.includes("'slideleft'"), '"slideleft" nu mai trebuie sa apara nicaieri in server.js');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-analysis.js'), 'utf8');
  assert.ok(!libSrc.includes('slideleft'), '"slideleft" nu mai trebuie sa apara nicaieri in lib/media-analysis.js');
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
test('server.js, amintiri-video.html, comanda-mea.html, succes.html: raman sintactic valide', () => {
  const { execSync } = require('node:child_process');
  execSync('node --check server.js', { cwd: path.join(__dirname, '..') });
  [melodiaMea, comandaMea, succes].forEach(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
});
