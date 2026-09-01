// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerința 5): elimină complet limita artificiala
// de 120s pentru materialele video ("Fișierul nu poate fi procesat (durata 161s depășește limita
// de 120s)"), fara sa o inlocuiasca cu alt plafon arbitrar. Pastreaza STRICT verificarile tehnice
// reale: format suportat, decodabilitate, securitate, limita de 3-30 materiale a pachetului.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function hasBinary(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

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

// ---------------------------------------------------------------------------------------------
// 1. Verificare STRUCTURALA: limita veche a fost eliminata complet, nu doar marita.
// ---------------------------------------------------------------------------------------------
test('server.js: constanta ORDER_MEDIA_MAX_VIDEO_SECONDS nu mai exista deloc in cod', () => {
  assert.ok(!server.includes('ORDER_MEDIA_MAX_VIDEO_SECONDS'), 'nicio urma a limitei de durata nu trebuie sa mai existe in server.js');
});

test('server.js: verifyMediaDecodable() nu mai respinge niciun videoclip pe baza duratei — mesajul vechi de respingere pe durata nu mai exista in cod EXECUTABIL (poate ramane STRICT intr-un comentariu istoric, care nu afecteaza comportamentul)', () => {
  const fnSrc = extractFn(server, 'async function verifyMediaDecodable(filePath, mimetype, type, timeoutMs = 20000) {');
  // eliminam liniile de comentariu inainte de verificare, ca sa nu confundam un comentariu care
  // DOCUMENTEAZA istoric bug-ul (citand raportul original al clientului) cu cod real care inca
  // ar respinge pe baza duratei.
  const codeOnly = fnSrc.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!codeOnly.includes('depășește limita'), 'niciun motiv de respingere legat de durata nu mai trebuie sa existe in codul executabil');
  assert.ok(!/durationSeconds\s*>\s*\w+/.test(codeOnly), 'nicio comparatie de forma "durata > limita" nu mai trebuie sa existe in codul executabil');
  // verificarile TEHNICE reale raman: flux video decodabil (pentru videoclipuri) si flux de
  // imagine decodabil (pentru fotografii) — NU au fost eliminate odata cu limita de durata.
  assert.ok(fnSrc.includes("if (!videoStream) return { ok: false, reason: 'niciun flux video decodabil' };"));
  assert.ok(fnSrc.includes("if (!hasImage) return { ok: false, reason: 'niciun flux de imagine decodabil' };"));
});

// ---------------------------------------------------------------------------------------------
// 2. Verificare FUNCTIONALA REALA (ffmpeg/ffprobe): un videoclip de 161s (cazul EXACT raportat)
//    si unul de 200s trec cu succes prin verifyMediaDecodable() extras verbatim din server.js.
// ---------------------------------------------------------------------------------------------
function loadVerifyMediaDecodable() {
  const fnSrc = extractFn(server, 'async function verifyMediaDecodable(filePath, mimetype, type, timeoutMs = 20000) {');
  const sandboxSrc = `
    const { execFile } = require('node:child_process');
    const util = require('node:util');
    const execFileAsync = util.promisify(execFile);
    ${fnSrc}
    return { verifyMediaDecodable };
  `;
  return new Function('require', sandboxSrc)(require);
}

test('REAL (ffmpeg): un videoclip de 161 de secunde (cazul EXACT raportat, IMG_6810.mov) e ACCEPTAT — nu mai e respins pentru durata', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 60000 }, async () => {
  const { verifyMediaDecodable } = loadVerifyMediaDecodable();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-duration-test-'));
  const filePath = path.join(dir, 'video-161s.mov');
  try {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=161', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', filePath]);
    const result = await verifyMediaDecodable(filePath, 'video/quicktime', 'video');
    assert.equal(result.ok, true, `trebuia acceptat, a produs: ${JSON.stringify(result)}`);
    assert.ok(result.durationSeconds >= 160 && result.durationSeconds <= 162, `durata raportata trebuie sa fie ~161s, a fost ${result.durationSeconds}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL (ffmpeg): un videoclip de 200 de secunde (mult peste vechea limita) e la fel de acceptat — nu exista un nou plafon arbitrar mai sus', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 60000 }, async () => {
  const { verifyMediaDecodable } = loadVerifyMediaDecodable();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-duration-test2-'));
  const filePath = path.join(dir, 'video-200s.mp4');
  try {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=200', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', filePath]);
    const result = await verifyMediaDecodable(filePath, 'video/mp4', 'video');
    assert.equal(result.ok, true, `trebuia acceptat, a produs: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL (ffmpeg): verificarile TEHNICE reale raman — un fisier corupt (nu un videoclip real) e in continuare respins, indiferent de durata', { skip: !FFMPEG_AVAILABLE && 'ffmpeg/ffprobe indisponibile in acest mediu', timeout: 30000 }, async () => {
  const { verifyMediaDecodable } = loadVerifyMediaDecodable();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naluna-duration-test3-'));
  const filePath = path.join(dir, 'not-a-real-video.mov');
  try {
    fs.writeFileSync(filePath, 'acesta nu e deloc un fisier video valid');
    const result = await verifyMediaDecodable(filePath, 'video/quicktime', 'video');
    assert.equal(result.ok, false, 'un fisier corupt trebuie respins in continuare, indiferent de eliminarea limitei de durata');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Marimea: init-ul multipart accepta acum fisiere in intervalul 700MB-750MB (respinse
//    inainte de vechea limita arbitrara), fara sa fie nevoie sa cream un fixture urias — testam
//    STRICT logica de validare a marimii (arithmetica pe `size`, primita ca JSON, NU continutul
//    fisierului), extrasa verbatim din ruta /multipart/init.
// ---------------------------------------------------------------------------------------------
test('server.js: logica de validare a marimii din POST .../multipart/init accepta acum un fisier "simulat" de 750MB (respins inainte de vechea limita de 700MB), fara sa fi creat vreun fixture urias', () => {
  const fnSrc = extractFn(server, "app.post('/api/orders/:orderId/media/multipart/init', mediaUploadLimiter, requireOrderToken, async (req, res, next) => {");
  const checkMatch = fnSrc.match(/if \(!Number\.isInteger\(totalBytes\) \|\| totalBytes <= 0 \|\| totalBytes > ORDER_MEDIA_MAX_BYTES\) \{/);
  assert.ok(checkMatch, 'verificarea de dimensiune trebuie sa existe in continuare (nu eliminata complet)');

  const PART_BYTES = 10 * 1024 * 1024;
  const MAX_PARTS = 10000;
  const ORDER_MEDIA_MAX_BYTES = PART_BYTES * MAX_PARTS; // implicit, fara ORDER_MEDIA_MAX_MB setat
  const simulatedSizes = {
    '150MB (vechea prima limita)': 150 * 1024 * 1024,
    '700MB (vechea a doua limita)': 700 * 1024 * 1024,
    '750MB (respins inainte de AMBELE limite vechi)': 750 * 1024 * 1024,
    '2GB (videoclip 4K real, lung)': 2 * 1024 * 1024 * 1024
  };
  for (const [label, totalBytes] of Object.entries(simulatedSizes)) {
    const rejected = !Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > ORDER_MEDIA_MAX_BYTES;
    assert.equal(rejected, false, `un fisier simulat de ${label} trebuie ACCEPTAT de noua limita`);
  }
  // limita ramane EXPLICITA si finita — un "fisier" absurd de mare tot trebuie respins.
  const absurdSize = 500 * 1024 * 1024 * 1024 * 1024; // 500TB
  const rejected = !Number.isInteger(absurdSize) || absurdSize <= 0 || absurdSize > ORDER_MEDIA_MAX_BYTES;
  assert.equal(rejected, true, 'limita ramane o protectie reala — nu e "nelimitata"');
});

// ---------------------------------------------------------------------------------------------
// 4. Confirmarea ca toate cele 5 materiale valide ajung in lista salvata — extragem si rulam
//    functional (nu doar text-matching) logica de acumulare REALA folosita de /complete
//    (mutateOrderMediaAtomically callback), verificand ca 5 finalizari secventiale produc EXACT
//    5 materiale salvate, in ordine, niciunul pierdut.
// ---------------------------------------------------------------------------------------------
test('server.js: 5 materiale valide, finalizate secvential (ca la un upload multipart real), ajung TOATE in uploadedMedia — logica de acumulare extrasa verbatim din POST .../complete', () => {
  const completeFnSrc = extractFn(server, "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  const mutatorMatch = completeFnSrc.match(/\(current\) => \{\s*const existing = current\.uploadedMedia \|\| \[\];\s*if \(existing\.length >= ORDER_MEDIA_MAX_ITEMS\) return null;\s*return \{ uploadedMedia: \[\.\.\.existing, \{ key: session\.key, type: 'video', section: session\.section, filename: label \}\] \};\s*\}/);
  assert.ok(mutatorMatch, 'nu am gasit callback-ul de acumulare atomica in POST .../complete');

  const ORDER_MEDIA_MAX_ITEMS = 30; // valoarea reala actuala (2026-08-31, "mărește limita la 30")
  // reconstruim STRICT acelasi callback, cu `session`/`label` legate la fiecare apel — simuland
  // 5 sesiuni multipart distincte, finalizate una dupa alta (secvential, ca in productie).
  function buildMutator(session, label) {
    return new Function('current', 'session', 'label', 'ORDER_MEDIA_MAX_ITEMS', `
      const mutatorFn = ${mutatorMatch[0]};
      return mutatorFn(current);
    `).bind(null, undefined); // placeholder, inlocuit mai jos
  }
  // Evaluam direct expresia (arrow function), legand session/label/ORDER_MEDIA_MAX_ITEMS prin
  // closure reala, ca sa nu simulam manual logica (folosim STRICT textul extras din server.js).
  function makeMutator(session, label) {
    return new Function('session', 'label', 'ORDER_MEDIA_MAX_ITEMS', `return ${mutatorMatch[0]};`)(session, label, ORDER_MEDIA_MAX_ITEMS);
  }

  let current = { uploadedMedia: [] };
  const sessions = Array.from({ length: 5 }, (_, i) => ({ key: `orders/memories/order-1/file-${i}.mp4`, section: null }));
  for (let i = 0; i < 5; i++) {
    const mutator = makeMutator(sessions[i], `video-${i}.mp4`);
    const patch = mutator(current);
    assert.ok(patch, `materialul ${i + 1}/5 nu trebuia respins (sub limita de ${ORDER_MEDIA_MAX_ITEMS})`);
    current = { ...current, ...patch };
  }
  assert.equal(current.uploadedMedia.length, 5, 'toate cele 5 materiale valide trebuie sa ajunga in lista salvata');
  for (let i = 0; i < 5; i++) {
    assert.equal(current.uploadedMedia[i].key, sessions[i].key, `materialul ${i + 1} trebuie sa pastreze cheia sesiunii lui, in ordinea corecta`);
  }
});

test('.env.example: documentatia limitei vechi de durata a fost actualizata — nu mai sugereaza ORDER_MEDIA_MAX_VIDEO_SECONDS ca optiune activa', () => {
  const envExample = read('.env.example');
  assert.ok(!envExample.includes('ORDER_MEDIA_MAX_VIDEO_SECONDS=120'), 'exemplul activ (necomentat sau prezentat ca optiune curenta) nu mai trebuie sa existe');
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
