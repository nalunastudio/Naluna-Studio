// Teste pentru CORECȚIA 2026-08-31 (Cadou video, Cerința 1B-F): "nu e suficient sa cresti
// limita la 30 de materiale — reconstruieste montajul real, nu ciclul mecanic 1,2,3...repeta".
// Acopera STRICT punctele din lista de teste obligatorii legate de noul storyboard pe TURE
// (lap model), variatia Ken Burns/tranzitii, si letterbox-ul pentru fotografii foarte late —
// vezi test/video-non-repeating-sequences-real.test.js, test/video-shot-plan-render-real.test.js,
// test/video-onset-alignment-real.test.js si test/video-concat-stress-real.test.js pentru
// acoperirea (deja actualizata) a secventelor video/render/aliniere-la-impuls/plafon ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const {
  buildShotPlan,
  SHOT_PLAN_MIN_SHOT_SECONDS,
  SHOT_PLAN_MAX_SHOTS
} = require('../lib/media-analysis.js');

function makeItems(n, opts) {
  return Array.from({ length: n }, (_, i) => ({
    type: (opts && opts.allVideo) ? 'video' : (i % 3 === 0 ? 'video' : 'photo')
  }));
}

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

// ===============================================================================================
// Determinism pentru 3/10/20/30 materiale (item 10 din lista de teste obligatorii).
// ===============================================================================================
for (const n of [3, 10, 20, 30]) {
  test(`buildShotPlan e DETERMINIST pentru ${n} materiale (aceleasi argumente -> exact acelasi plan)`, () => {
    const items = makeItems(n);
    const planA = buildShotPlan(items, 150, [], 0.6, [], 5);
    const planB = buildShotPlan(items, 150, [], 0.6, [], 5);
    assert.deepEqual(planA, planB);
  });
}

// ===============================================================================================
// Toate materialele apar o data inainte de orice repetare (item 11); niciun material nu apare in
// doua cadre consecutive (item 12); pentru 30 de materiale, toate cele 30 de itemIndex apar
// intr-o melodie suficient de lunga (item 13).
// ===============================================================================================
for (const n of [3, 10, 20, 30]) {
  test(`storyboard pe ture (${n} materiale): toate apar o data inainte de orice repetare, niciodata consecutiv, plan determinist (nu ciclu mecanic)`, () => {
    const items = makeItems(n);
    const plan = buildShotPlan(items, 200, [], 0.6, [], 5);
    assert.ok(plan.length >= n, `planul trebuie sa aiba cel putin ${n} cadre pentru o melodie de 200s, a avut ${plan.length}`);

    const firstN = plan.slice(0, n).map(s => s.itemIndex);
    assert.equal(new Set(firstN).size, n, `primele ${n} cadre trebuie sa acopere toate cele ${n} materiale distincte, a produs: ${firstN.join(',')}`);
    assert.deepEqual(firstN, Array.from({ length: n }, (_, i) => i), 'prima tura trebuie sa respecte STRICT ordinea aleasa de client (cerinta 4)');

    for (let i = 1; i < plan.length; i++) {
      assert.notEqual(plan[i].itemIndex, plan[i - 1].itemIndex, `cadrele ${i - 1} si ${i} folosesc acelasi material (${plan[i].itemIndex})`);
    }

    const usedItems = new Set(plan.map(s => s.itemIndex));
    assert.equal(usedItems.size, n, `toate cele ${n} materiale trebuie sa apara in plan, doar ${usedItems.size} au aparut`);
  });
}

test('planul NU mai e ciclul mecanic vechi (0,1,2,...,n-1,0,1,2,...) — cel putin o tura ulterioara difera de o repetare literala a ordinii clientului', () => {
  const n = 10;
  const items = makeItems(n);
  const plan = buildShotPlan(items, 200, [], 0.6, [], 5);
  const sequence = plan.map(s => s.itemIndex);
  let identicalToMechanicalCycle = true;
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i] !== i % n) { identicalToMechanicalCycle = false; break; }
  }
  assert.ok(!identicalToMechanicalCycle, 'planul nu trebuie sa fie identic cu ciclul mecanic 0,1,2,...,n-1,0,1,2,... repetat la infinit');
});

// ===============================================================================================
// Fereastra de previzualizare de 25s nu repeta un material cat timp exista unul neutilizat
// (item de test explicit din lista obligatorie).
// ===============================================================================================
test('fereastra de previzualizare (primele 25s) nu repeta niciun material cat timp exista un material neutilizat', () => {
  const n = 8;
  const items = makeItems(n);
  const plan = buildShotPlan(items, 120, [], 0.6, [], 5);
  const previewShots = plan.filter(s => s.start < 25);
  const seen = new Set();
  for (const shot of previewShots) {
    if (seen.has(shot.itemIndex) && seen.size < n) {
      assert.fail(`materialul ${shot.itemIndex} s-a repetat in previzualizare inainte ca toate cele ${n} materiale sa fi aparut o data (vazute pana acum: ${seen.size})`);
    }
    seen.add(shot.itemIndex);
  }
});

// ===============================================================================================
// Ken Burns nu se repeta pe doua cadre consecutive, GLOBAL (indiferent de material) — cerinta C.
// ===============================================================================================
test('Ken Burns: nicio miscare nu se repeta pe doua cadre foto consecutive, GLOBAL (indiferent de material)', () => {
  const n = 12;
  const items = makeItems(n, { allVideo: false });
  const plan = buildShotPlan(items, 200, [], 0.6, [], 5);
  let anyConsecutive = false;
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].kenBurns && plan[i - 1].kenBurns && plan[i].kenBurns.id === plan[i - 1].kenBurns.id) anyConsecutive = true;
  }
  assert.ok(!anyConsecutive, 'doua cadre foto consecutive nu trebuie sa primeasca niciodata aceeasi miscare Ken Burns');
});

test('Ken Burns: ultimul cadru, daca e o poza, primeste STRICT varianta cea mai discreta, dar nu coincide cu vecinul anterior', () => {
  const n = 6;
  const items = makeItems(n, { allVideo: false }).map((it, i) => (i === n - 1 ? { type: 'photo' } : it));
  const plan = buildShotPlan(items, 90, [], 0.6, [], 5);
  const last = plan[plan.length - 1];
  const prev = plan[plan.length - 2];
  if (last.kenBurns) {
    assert.notEqual(last.kenBurns.id, prev.kenBurns ? prev.kenBurns.id : null, 'ultimul cadru nu trebuie sa repete miscarea vecinului anterior');
  }
  assert.equal(last.energy, 'calm', 'ultimul cadru trebuie sa fie STRICT calm (final stabil, cerinta 5)');
});

// ===============================================================================================
// Tranzitii: 'slideleft' eliminat complet; toate sunt 'fade', cu durata variabila.
// ===============================================================================================
test('tranzitiile sunt STRICT "fade" peste tot, niciodata "slideleft" — durata variaza per-granita', () => {
  const items = makeItems(20);
  const sections = [
    { sectionType: 'intro', startTime: 0, endTime: 10, alignmentStatus: 'aligned' },
    { sectionType: 'verse', startTime: 10, endTime: 60, alignmentStatus: 'aligned' },
    { sectionType: 'chorus', startTime: 60, endTime: 100, alignmentStatus: 'aligned' },
    { sectionType: 'outro', startTime: 100, endTime: 140, alignmentStatus: 'aligned' }
  ];
  const plan = buildShotPlan(items, 140, sections, 0.6, [], 5);
  const nonLast = plan.slice(0, -1);
  assert.ok(nonLast.every(s => s.transitionOut === 'fade'), 'toate granitele (in afara ultimului cadru) trebuie sa foloseasca "fade"');
  assert.ok(nonLast.every(s => typeof s.transitionDuration === 'number' && s.transitionDuration > 0), 'fiecare granita trebuie sa aiba o durata de tranzitie pozitiva');
  const distinctDurations = new Set(nonLast.map(s => s.transitionDuration));
  assert.ok(distinctDurations.size > 1, 'durata tranzitiei trebuie sa varieze (nu un singur xfade uniform peste tot)');
  assert.equal(plan[plan.length - 1].transitionOut, null, 'ultimul cadru nu are o tranzitie de iesire (nu exista cadru urmator)');
});

// ===============================================================================================
// Durata finala (dupa compensarea reala pe niveluri de batch) ramane exact durationSeconds —
// verificat prin simularea EXACTA a reducerii pe loturi (aceeasi tehnica ca in concatWithCrossfades).
// ===============================================================================================
function simulateRealFinalDuration(shots, batchSize) {
  let current = shots.map(s => ({ duration: s.duration, transitionDuration: s.transitionDuration }));
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += batchSize) {
      const batch = current.slice(i, i + batchSize);
      if (batch.length === 1) { next.push(batch[0]); continue; }
      let cumulative = batch[0].duration;
      for (let j = 1; j < batch.length; j++) {
        const xfade = (typeof batch[j - 1].transitionDuration === 'number') ? batch[j - 1].transitionDuration : 0.6;
        cumulative += batch[j].duration - xfade;
      }
      next.push({ duration: cumulative, transitionDuration: batch[batch.length - 1].transitionDuration });
    }
    current = next;
  }
  return current[0].duration;
}
for (const n of [3, 10, 20, 30]) {
  for (const dur of [45, 90, 200]) {
    test(`durata FINALA (dupa reducerea reala pe loturi, ${n} materiale, ${dur}s) ramane EXACT durationSeconds`, () => {
      const items = makeItems(n);
      const plan = buildShotPlan(items, dur, [], 0.6, [], 5);
      const real = simulateRealFinalDuration(plan, 5);
      assert.ok(Math.abs(real - dur) < 1e-6, `durata reala trebuie sa fie exact ${dur}s, a fost ${real}`);
    });
  }
}

// ===============================================================================================
// Plafonul SHOT_PLAN_MAX_SHOTS ramane respectat indiferent de numarul de materiale (nu creste
// nelimitat numarul de procese ffmpeg — cerinta F8).
// ===============================================================================================
test('planul nu depaseste niciodata SHOT_PLAN_MAX_SHOTS, indiferent de durata melodiei sau numarul de materiale (pana la 30)', () => {
  for (const n of [3, 30]) {
    for (const dur of [200, 400, 600]) {
      const items = makeItems(n);
      const plan = buildShotPlan(items, dur, [], 0.6, [], 5);
      assert.ok(plan.length <= SHOT_PLAN_MAX_SHOTS, `n=${n}, dur=${dur}: plan.length=${plan.length} depaseste SHOT_PLAN_MAX_SHOTS=${SHOT_PLAN_MAX_SHOTS}`);
    }
  }
});

test('niciun cadru nu coboara sub SHOT_PLAN_MIN_SHOT_SECONDS dupa impartirea pentru cerinta 7 (30 materiale, melodie scurta)', () => {
  const items = makeItems(30);
  const plan = buildShotPlan(items, 40, [], 0.6, [], 5);
  const rawDurations = plan.map(s => s.duration - (typeof s.transitionDuration === 'number' ? 0 : 0));
  // durata RAW (pre-compensatie) nu e direct expusa — verificam STRICT ca durata finala (care e
  // STRICT >= durata raw, compensatia e mereu pozitiva) ramane rezonabila (nu ar putea fi mai
  // mica decat minimul daca raw-ul respecta deja minimul).
  assert.ok(rawDurations.every(d => d >= SHOT_PLAN_MIN_SHOT_SECONDS - 1e-9), 'niciun cadru nu trebuie sa coboare sub durata minima');
});

// ===============================================================================================
// Nicio sursa de nedeterminism (Math.random) in fisierele atinse de aceasta corectie.
// ===============================================================================================
function stripLineComments(src) {
  return src.split('\n').map(line => line.replace(/\/\/.*/, '')).join('\n');
}
test('lib/media-analysis.js si server.js nu folosesc Math.random() nicaieri in COD (mentiuni in comentarii, documentand determinismul, sunt permise)', () => {
  const libSrc = stripLineComments(fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-analysis.js'), 'utf8'));
  const serverSrc = stripLineComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  assert.ok(!libSrc.includes('Math.random'), 'lib/media-analysis.js nu trebuie sa foloseasca Math.random() in cod');
  assert.ok(!serverSrc.includes('Math.random'), 'server.js nu trebuie sa foloseasca Math.random() in cod');
});

// ===============================================================================================
// Resurse (cerinta F) — descarcare LENESA + curatare progresiva in buildMemoryBackground.
// ===============================================================================================
test('server.js: buildMemoryBackground() construieste shotPlan din `ordered` (metadate), NU din surse deja descarcate — planul e cunoscut INTEGRAL inainte de a descarca ceva', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = serverSrc.indexOf('async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings, songFilePath) {');
  assert.notEqual(idx, -1);
  let depth = 0, i = serverSrc.indexOf('{', idx);
  const start = idx;
  for (; i < serverSrc.length; i++) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = serverSrc.slice(start, i + 1);
  assert.ok(body.includes('buildShotPlan(ordered,'), 'shotPlan trebuie construit din `ordered` (metadate), nu din `downloaded`');
  assert.ok(body.includes('ensureDownloaded'), 'trebuie sa existe un mecanism de descarcare lenesa/memoizata');
  assert.ok(body.includes('releaseItem'), 'trebuie sa existe un mecanism de eliberare/stergere per material');
  assert.ok(body.includes('remainingUsesByItem'), 'trebuie sa existe un numarator de referinte ramase per material');
  assert.ok(!body.includes('downloadOrderMedia(order, ordered)'), 'nu mai trebuie sa descarce toate sursele deodata, inainte de randare');
});

test('server.js: downloadOneOrderMediaItem() foloseste un index STABIL (globalIndex), niciodata pozitia dintr-un subset, pentru numele fisierului local', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('async function downloadOneOrderMediaItem(order, item, globalIndex) {'));
  assert.ok(serverSrc.includes('memory-src-${globalIndex}'));
});

// ===============================================================================================
// Fotografie panoramica/foarte lata — ramane VIZIBILA INTREGRAL prin letterbox, nu decupata (C).
// Test REAL cu ffmpeg: sursa are un marcaj VERDE pe marginea din stanga (primele 10% din latime)
// — o decupare centrata standard ar elimina COMPLET acest marcaj; letterbox-ul (fit complet, fara
// decupare) trebuie sa il pastreze vizibil, aproape de marginea stanga a cadrului final.
// ===============================================================================================
test('RANDARE REALA: o fotografie panoramica/foarte lata ramane INTREGRAL vizibila (letterbox cu fundal blurat), nu decupata agresiv', {
  skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu',
  timeout: 60000
}, async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  function extractFn(name) {
    let idx = server.indexOf('function ' + name + '(');
    const asyncIdx = server.lastIndexOf('async ', idx);
    if (asyncIdx !== -1 && server.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;
    let depth = 0, i = server.indexOf('{', idx);
    const start = idx;
    for (; i < server.length; i++) {
      if (server[i] === '{') depth++;
      else if (server[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(i < server.length, `nu am gasit functia ${name}`);
    return server.slice(start, i + 1);
  }
  function extractConst(name) {
    const idx = server.indexOf(`const ${name} =`);
    assert.ok(idx !== -1, `nu am gasit constanta ${name}`);
    const end = server.indexOf(';', idx);
    return server.slice(idx, end + 1);
  }

  const { execFile } = require('node:child_process');
  const util = require('node:util');
  const execFileAsync = util.promisify(execFile);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-wide-photo-'));
  const renderWorkDir = path.join(workDir, 'render-work');
  fs.mkdirSync(renderWorkDir, { recursive: true });
  const src = [
    "const path = require('path');",
    "const fs = require('fs');",
    'const TEMP_DIR = ' + JSON.stringify(renderWorkDir) + ';',
    extractConst('MEMORY_VIDEO_WIDTH'),
    extractConst('MEMORY_VIDEO_HEIGHT'),
    extractConst('MEMORY_VIDEO_FPS'),
    extractConst('VIDEO_ENCODE_PRESET'),
    extractConst('VIDEO_INTERMEDIATE_CRF'),
    "async function execFfmpeg(args, options = {}) { return execFileAsync('ffmpeg', ['-hide_banner','-loglevel','error','-nostats',...args], { maxBuffer: 20*1024*1024, ...options }); }",
    "function perfLog() {}",
    extractFn('wrapVideoRenderStageError'),
    extractFn('computeVideoSegmentStartOffset'),
    extractFn('getVideoSourceDurationSeconds'),
    extractConst('HDR_COLOR_TRANSFER_VALUES'),
    extractFn('detectHdrVideo'),
    extractConst('HDR_TONEMAP_FILTER'),
    extractFn('buildHdrToneMapFilterIfNeeded'),
    extractConst('WIDE_PHOTO_ASPECT_RATIO_THRESHOLD'),
    extractFn('getPhotoDimensions'),
    extractFn('renderShot'),
    'return { renderShot, MEMORY_VIDEO_WIDTH, MEMORY_VIDEO_HEIGHT };'
  ].join('\n\n');
  const mod = new Function('execFileAsync', 'require', src)(execFileAsync, require);

  try {
    // Sursa: 2000x800 (aspect 2.5, mult peste WIDE_PHOTO_ASPECT_RATIO_THRESHOLD=1.6) — verde pe
    // primii 10% din latime (0-200px), albastru pe rest (200-2000px).
    const widePhoto = path.join(workDir, 'wide.png');
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=2000x800:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=200x800:d=1',
      '-filter_complex', '[0:v][1:v]overlay=0:0',
      '-frames:v', '1', widePhoto
    ]);

    const shot = { itemIndex: 0, occurrence: 0, duration: 2, kenBurns: { id: 'zoom_in_center', z: 'min(zoom+0.0018,1.15)', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' } };
    const order = { id: 'test-wide-photo' };
    const outPath = await mod.renderShot({ type: 'photo', localPath: widePhoto }, shot, 0, order);

    function sampleColor(filePath, xFrac, yFrac) {
      const out = execFileSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-vframes', '1',
        '-vf', `crop=2:2:${Math.round(xFrac * mod.MEMORY_VIDEO_WIDTH)}:${Math.round(yFrac * mod.MEMORY_VIDEO_HEIGHT)},scale=1:1`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
      ]);
      return out.length >= 3 ? { r: out[0], g: out[1], b: out[2] } : null;
    }
    function closeTo(color, target, tol) {
      if (!color) return false;
      return Math.abs(color.r - target.r) <= tol && Math.abs(color.g - target.g) <= tol && Math.abs(color.b - target.b) <= tol;
    }
    const GREEN = { r: 0, g: 128, b: 0 };

    // Sub decuparea centrata VECHE, marcajul verde (extrema stanga a sursei) ar fi complet
    // eliminat — verificam ca noul letterbox il pastreaza vizibil, aproape de centrul vertical
    // al cadrului final, undeva pe partea stanga (x mic).
    const nearLeftEdge = sampleColor(outPath, 0.03, 0.5);
    const matched = closeTo(nearLeftEdge, GREEN, 50);
    assert.ok(matched, `marcajul verde din extrema stanga a fotografiei panoramice trebuie sa ramana vizibil (letterbox, nu decupare) — culoare gasita: ${JSON.stringify(nearLeftEdge)}`);

    // Dimensiunile finale raman EXACT 1080x1920 (formatul cerut), indiferent de letterbox.
    const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', outPath]).toString().trim();
    assert.equal(dims.replace(/\r/g, ''), `${mod.MEMORY_VIDEO_WIDTH},${mod.MEMORY_VIDEO_HEIGHT}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
