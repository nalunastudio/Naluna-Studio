// FIX URGENT (2026-09-13) — esec real de productie confirmat: comanda reala "Cadou video"
// (plan="video", inainte de plata) a ajuns la etapa de randare video, dar 3 joburi succesive
// (9 incercari in total, cu backoff exponential intre ele) au esuat IDENTIC cu:
// "Raspunsul cu versuri sincronizate e gol sau are o structura neasteptata."
//
// ROOT CAUSE (confirmat prin interogare DIRECTA a bazei de date de productie SI o cerere de
// diagnostic READ-ONLY, directa, catre furnizor, cu EXACT acelasi taskId/audioId care esuase):
// perechea taskId/audioId era CORECTA (variant.musicTaskId == order.musicTaskId, nicio
// regenerare implicata — NU e bug-ul din 61cb645f/2026-09-07, deja acoperit separat in
// test/video-music-task-id-per-variant.test.js). Raspunsul HTTP era 200, cu structura corecta
// (code:200, data prezent), dar alignedWords era GOL — furnizorul inca nu terminase calculul
// alinierii cuvant-cu-cuvant pentru acea piesa (248 secunde) la momentul cererilor. O cerere
// facuta manual, minute mai tarziu, cu ACEEASI pereche taskId/audioId, a returnat alinierea
// COMPLETA — deci NU o eroare permanenta, ci o conditie tranzitorie de timing la furnizor.
//
// CAUZA REALA A EȘECULUI PERMANENT: generateLyricVideo() trata "HTTP 200, structura corecta,
// dar alignedWords gol" identic cu o structura genuin neasteptata/invalida — o eroare fara
// niciun semnal de retry, deci job-ul epuiza cele 3 incercari (max_attempts, neschimbat) intr-un
// interval de backoff prea scurt (~30-90s) pentru o piesa mai lunga.
//
// REPARATIE MINIMA: separat cele doua cazuri. Structura genuin invalida ramane o eroare fara
// niciun semnal special (neschimbat). "HTTP 200, structura corecta, alignedWords gol" primeste
// acum err.retryAfterSeconds = EMPTY_ALIGNED_WORDS_RETRY_SECONDS (45) — acelasi mecanism deja
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

test('STRUCTURAL: cazul "structura genuin invalida" ramane distinct de cazul "alignedWords gol" — nu primeste retryAfterSeconds', () => {
  const fn = extractFn('generateLyricVideo');
  const invalidIdx = fn.indexOf('if (!hasValidStructure) {');
  const invalidBlock = fn.slice(invalidIdx, fn.indexOf('}', invalidIdx) + 1);
  assert.ok(!invalidBlock.includes('retryAfterSeconds'), 'structura genuin invalida nu trebuie sa primeasca semnalul de retry lung — doar cazul "gol" confirmat tranzitoriu');
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

test('FUNCTIONAL: structura genuin invalida (data lipseste) -> eroare FARA retryAfterSeconds (comportament neschimbat, nu o conditie confirmata tranzitorie)', async () => {
  const mod = loadSandbox({ ok: true, res: { json: async () => ({ code: 200 }) } });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.equal(err.retryAfterSeconds, undefined, 'structura genuin invalida nu trebuie sa primeasca semnalul de retry lung');
      assert.match(err.message, /Raspunsul cu versuri sincronizate e gol sau are o structura neasteptata/);
      return true;
    }
  );
});

test('FUNCTIONAL: code !== 200 -> eroare FARA retryAfterSeconds (neschimbat)', async () => {
  const mod = loadSandbox({ ok: true, res: { json: async () => ({ code: 400, data: { alignedWords: [] } }) } });
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  await assert.rejects(
    () => mod.generateLyricVideo(order, fakeVariant(), '/tmp/fake.mp3'),
    (err) => {
      assert.equal(err.retryAfterSeconds, undefined);
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
      !/Raspunsul cu versuri sincronizate e gol|marcaj de timp nu sunt inca disponibile/.test(err.message),
      `nu trebuie sa esueze la verificarea alignedWords cand acesta e negol, a esuat cu: ${err.message}`
    );
  }
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
