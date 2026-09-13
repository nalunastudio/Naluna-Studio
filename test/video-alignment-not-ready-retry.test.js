// FIX URGENT (2026-09-13) — esec real de productie confirmat: comanda reala "Cadou video"
// (plan="video", inainte de plata) a ajuns la etapa de randare video, dar joburi succesive au
// esuat repetat cu: "Raspunsul cu versuri sincronizate e gol sau are o structura neasteptata."
//
// ROOT CAUSE (confirmat prin interogare DIRECTA a bazei de date de productie SI cereri de
// diagnostic READ-ONLY, directe, catre furnizor, cu EXACT acelasi taskId/audioId care esuase):
// perechea taskId/audioId era CORECTA (variant.musicTaskId == order.musicTaskId, nicio
// regenerare implicata — NU e bug-ul din 61cb645f/2026-09-07, deja acoperit separat in
// test/video-music-task-id-per-variant.test.js). O cerere facuta manual, separat, cu ACEEASI
// pereche taskId/audioId, a returnat de fiecare data alinierea COMPLETA — deci NU o eroare
// permanenta, ci o conditie tranzitorie la furnizor (piesa avea 248 secunde).
//
// IMPORTANT — gasit chiar in timpul recuperarii comenzii reale: raspunsul "nu inca gata" al
// furnizorului nu ia mereu aceeasi forma. Uneori alignedWords e un array gol (structura
// corecta), alteori raspunsul are o structura complet diferita/lipsa (ex. fara `data`) — AMBELE
// forme s-au dovedit tranzitorii pentru ACEEASI pereche taskId/audioId care functiona corect la
// o interogare ulterioara. De aceea reparatia trateaza ORICE raspuns fara alignedWords
// utilizabil identic, nu doar cazul "array gol".
//
// CAUZA REALA A EȘECULUI PERMANENT: generateLyricVideo() trata orice raspuns fara alignedWords
// utilizabil ca eroare fara niciun semnal de retry, deci job-ul epuiza cele 3 incercari
// (max_attempts, neschimbat) intr-un interval de backoff prea scurt pentru o piesa mai lunga.
//
// REPARATIE MINIMA: orice raspuns fara alignedWords utilizabil primeste acum
// err.retryAfterSeconds = EMPTY_ALIGNED_WORDS_RETRY_SECONDS (45) — acelasi mecanism deja
// existent si folosit pentru semnalele explicite de rate-limit (429/430/405) ale furnizorului,
// respectat de computeBackoffSeconds in worker.js — NICIO schimbare de arhitectura, NICIO
// schimbare a max_attempts/MAX_REPLICAS/autoscaler, NICIO schimbare a mesajului generic afisat
// clientului (videoFailedReason nu e niciodata expus in HTML — verificat explicit mai jos).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

function extractFn(name) {
  let idx = server.indexOf('function ' + name + '(');
  const asyncIdx = server.lastIndexOf('async ', idx);
  if (asyncIdx !== -1 && server.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;
  assert.ok(idx !== -1, `nu am gasit functia ${name} in server.js`);
  let depth = 0, i = server.indexOf('{', idx);
  const start = idx;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}

// ---------------------------------------------------------------------------------------------
// STRUCTURAL
// ---------------------------------------------------------------------------------------------
test('STRUCTURAL: EMPTY_ALIGNED_WORDS_RETRY_SECONDS exista ca o constanta reala, folosita in generateLyricVideo()', () => {
  assert.match(server, /const EMPTY_ALIGNED_WORDS_RETRY_SECONDS = 45;/);
  const fn = extractFn('generateLyricVideo');
  assert.match(fn, /err\.retryAfterSeconds = EMPTY_ALIGNED_WORDS_RETRY_SECONDS;/);
});

test('STRUCTURAL: orice raspuns fara alignedWords utilizabil (structura neasteptata SAU gol) primeste ACELASI semnal retryAfterSeconds — o singura ramura, nu doua', () => {
  const fn = extractFn('generateLyricVideo');
  assert.match(fn, /if \(!alignedWords \|\| alignedWords\.length === 0\) \{/, 'cele doua cazuri trebuie unificate intr-o singura conditie, dupa dovada ca ambele sunt tranzitorii');
});

test('STRUCTURAL: videoFailedReason NU e niciodata expus in vreo pagina HTML — clientul vede STRICT mesajul generic existent, neschimbat de aceasta corectie', () => {
  const htmlFiles = ['melodia-mea.html', 'se-creeaza-video.html', 'succes.html', 'comanda-mea.html'];
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.ok(!html.includes('videoFailedReason'), `${f} nu trebuie sa expuna niciodata videoFailedReason`);
  }
});

// ---------------------------------------------------------------------------------------------
// FUNCTIONAL — executie reala a generateLyricVideo(), retea mockata (fetchTimestampedLyricsOnce),
// exact tiparul din test/video-music-task-id-per-variant.test.js.
// ---------------------------------------------------------------------------------------------
function loadSandbox(mockResponse) {
  const generateLyricVideoSrc = extractFn('generateLyricVideo');
  const sandboxSrc = `
    const EMPTY_ALIGNED_WORDS_RETRY_SECONDS = 45;
    async function fetchTimestampedLyricsOnce(taskId, audioId) {
      return __mockResponse;
    }
    function buildCaptionLines() { return [{ start: 0, end: 0.5, text: 'Test' }]; }
    function toAss() { return 'fake-ass-content'; }

    ${generateLyricVideoSrc}

    return { generateLyricVideo };
  `;
  return new Function('__mockResponse', 'require', 'fs', 'path', 'TEMP_DIR', sandboxSrc)(
    mockResponse, require, require('fs'), require('path'), require('os').tmpdir()
  );
}

function fakeVariant() {
  return { id: 'v1', sunoTrackId: 'audio-A1', musicTaskId: 'task-A', originalLyrics: 'Fake lyrics', durationSeconds: 248 };
}

test('FUNCTIONAL (scenariul EXACT raportat): HTTP 200, structura corecta, alignedWords GOL -> eroare cu retryAfterSeconds=45 (nu o eroare permanenta)', async () => {
  const mod = loadSandbox({ ok: true, res: { json: async () => ({ code: 200, data: { alignedWords: [] } }) } });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.equal(err.retryAfterSeconds, 45, 'trebuie sa semnalizeze explicit un retry mai lung (45s), nu o eroare fara niciun semnal');
      return true;
    }
  );
});

test('FUNCTIONAL (a doua forma tranzitorie, gasita in timpul recuperarii reale): structura fara `data` -> ACELASI retryAfterSeconds=45, nu o eroare permanenta', async () => {
  const mod = loadSandbox({ ok: true, res: { json: async () => ({ code: 200 }) } });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.equal(err.retryAfterSeconds, 45, 'aceasta forma s-a dovedit la fel de tranzitorie ca "alignedWords gol" pentru aceeasi pereche taskId/audioId — trebuie tratata identic');
      assert.match(err.message, /Raspunsul cu versuri sincronizate e gol sau are o structura neasteptata/);
      return true;
    }
  );
});

test('FUNCTIONAL: code !== 200 -> ACELASI retryAfterSeconds=45 (tratat identic cu celelalte forme tranzitorii)', async () => {
  const mod = loadSandbox({ ok: true, res: { json: async () => ({ code: 400, data: { alignedWords: [] } }) } });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.equal(err.retryAfterSeconds, 45);
      return true;
    }
  );
});

test('FUNCTIONAL: alignedWords NEGOL -> generateLyricVideo NU arunca la acest pas (continua normal spre constructia caption-urilor)', async () => {
  const mod = loadSandbox({
    ok: true,
    res: { json: async () => ({ code: 200, data: { alignedWords: [{ word: 'Test ', startS: 0, endS: 0.5, success: true }] } }) }
  });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  // Nu asertam succes complet (pasii ulteriori — ffmpeg real — nu sunt extrasi in acest sandbox
  // minim si vor arunca separat, testati in alta parte) — asertam STRICT ca NU arunca eroarea
  // "gol"/structura neasteptata testata mai sus.
  try {
    await mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3');
  } catch (err) {
    assert.ok(
      !/Raspunsul cu versuri sincronizate e gol/.test(err.message),
      `nu trebuie sa esueze la verificarea alignedWords cand acesta e negol, a esuat cu: ${err.message}`
    );
  }
});

test('FUNCTIONAL: outcome.ok===false (eroare de retea/HTTP la nivel de request) ramane pe calea VECHE, neschimbata — nu foloseste noul EMPTY_ALIGNED_WORDS_RETRY_SECONDS', async () => {
  const mod = loadSandbox({ ok: false, reason: 'HTTP 503', httpStatus: 503 });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.match(err.message, /Nu am putut obtine versurile cu marcaj de timp/, 'calea outcome.ok===false ramane neschimbata de aceasta corectie');
      assert.equal(err.retryAfterSeconds, undefined, 'fara retryAfterSeconds explicit din outcome, nu trebuie inventat unul nou aici');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------------------------
// worker.js — confirmam ca mecanismul de respectare a retryAfterSeconds e cel deja existent,
// neatins (nicio schimbare de arhitectura/max_attempts/MAX_REPLICAS).
// ---------------------------------------------------------------------------------------------
test('worker.js: computeBackoffSeconds() ramane NESCHIMBAT — respecta in continuare err.retryAfterSeconds daca e mai mare decat backoff-ul calculat, fara nicio modificare de max_attempts/backoff de baza', () => {
  assert.match(worker, /const BACKOFF_BASE_SECONDS = 10;/);
  assert.match(worker, /const BACKOFF_MAX_SECONDS = 120;/);
  assert.match(worker, /const providerHint = \(err && typeof err\.retryAfterSeconds === 'number'\) \? err\.retryAfterSeconds : 0;/);
  assert.match(worker, /return Math\.round\(Math\.max\(computed, providerHint\)\);/);
});

test('db.js: max_attempts implicit al job-ului video ramane 3 (neschimbat) — fixul foloseste STRICT semnalul retryAfterSeconds existent, nu o crestere a numarului de incercari', () => {
  assert.match(dbjs, /CREATE TABLE IF NOT EXISTS video_render_jobs[\s\S]*?max_attempts INTEGER NOT NULL DEFAULT 3,/);
});

test('server.js si worker.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'worker.js')]));
});
