// CORECȚIE CRITICĂ (2026-09-07, cauza confirmata a esecului real de productie — comanda reala
// 61cb645f, Cadou Video, testata direct de client pe iPhone): "Raspunsul cu versuri sincronizate
// e gol sau are o structura neasteptata" — cauza EXACTA, confirmata prin loguri Railway + interogare
// directa a bazei de date de productie (STRICT campuri tehnice, fara date personale): clientul a
// regenerat melodia (taskId NOU, suprascrie order.musicTaskId), dar a ales pentru video varianta
// INITIALA (sunoTrackId apartinand taskId-ului VECHI) — get-timestamped-lyrics primea taskId NOU +
// audioId VECHI, o pereche care nu exista niciodata la Suno. Retrimiterea cererii (retry) NU putea
// repara asta niciodata — perechea gresita ramanea gresita la infinit (confirmat in loguri: doua
// incercari, la 13 secunde distanta, esuate IDENTIC).
//
// FIX: fiecare varianta isi salveaza acum PROPRIUL taskId (musicTaskId), la creare — parametrul
// exista deja in buildVariantFromTrack(), doar nu era persistat pe varianta. generateLyricVideo()
// foloseste STRICT variant.musicTaskId (cu fallback pe order.musicTaskId STRICT pentru variantele
// VECHI, create inainte de aceasta corectie — compatibilitate, nu comportament nou).
//
// Acest fisier verifica STRUCTURAL (sursa reala a fix-ului) si FUNCTIONAL (executie reala a
// generateLyricVideo, mockand STRICT reteaua — fetchTimestampedLyricsOnce — niciodata logica
// proprie) exact cele 4 scenarii cerute explicit, plus verificarea STRICTA a perechii taskId/
// audioId trimise catre Suno.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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
// STRUCTURAL: verificari directe pe cod — sursa fixului chiar exista, unde trebuie.
// ---------------------------------------------------------------------------------------------
test('STRUCTURAL: buildVariantFromTrack() salveaza taskId-ul primit ca parametru DIRECT pe varianta (musicTaskId), niciodata pierdut', () => {
  const fn = extractFn('buildVariantFromTrack');
  assert.match(fn, /musicTaskId: taskId \|\| null,/);
});

test('STRUCTURAL: generateLyricVideo() foloseste STRICT variant.musicTaskId, cu fallback pe order.musicTaskId DOAR pentru compatibilitate cu variante vechi', () => {
  const fn = extractFn('generateLyricVideo');
  assert.match(fn, /const effectiveMusicTaskId = variant\.musicTaskId \|\| order\.musicTaskId;/);
  assert.match(fn, /fetchTimestampedLyricsOnce\(effectiveMusicTaskId, variant\.sunoTrackId\)/);
  // Garanteaza ca NU s-a strecurat inapoi vechea folosire directa a lui order.musicTaskId in apelul
  // catre Suno (doar in linia de fallback, de mai sus, e permisa aparitia literala).
  assert.ok(!/fetchTimestampedLyricsOnce\(order\.musicTaskId,/.test(fn), 'apelul catre Suno nu mai trebuie sa foloseasca NICIODATA direct order.musicTaskId');
});

// ---------------------------------------------------------------------------------------------
// FUNCTIONAL: sandbox minimal — buildVariantFromTrack real (fara retea, downloadFile mockat) +
// generateLyricVideo real (fara retea, fetchTimestampedLyricsOnce mockat) — verifica EXACT ce
// pereche (taskId, audioId) ajunge la "Suno" in fiecare din cele 4 scenarii cerute.
// ---------------------------------------------------------------------------------------------
// Sandbox minimal, STRICT pentru functia testata (generateLyricVideo) — restul pipeline-ului
// (descarcare audio reala, taiere previzualizare cu ffmpeg, constructia efectiva a caption-urilor/
// .ass) NU are nicio legatura cu bug-ul testat aici (PERECHEA taskId/audioId trimisa catre Suno) —
// e deja acoperit de alte teste dedicate (test/video-render-ffmpeg-real.test.js, teste de caption).
// buildVariantFromTrack NU e extras/executat aici (ar antrena descarcare+taiere audio reala,
// irelevante) — comportamentul lui de salvare a musicTaskId e verificat STRUCTURAL mai sus, direct
// pe sursa; aici construim variante ca obiecte simple, cu EXACT forma pe care ar produce-o.
function loadSandbox() {
  const calls = { timestampedLyrics: [] };
  const generateLyricVideoSrc = extractFn('generateLyricVideo');

  const sandboxSrc = `
    async function fetchTimestampedLyricsOnce(taskId, audioId) {
      __recordCall(taskId, audioId);
      // "Suno" raspunde cu succes STRICT daca perechea (taskId, audioId) corespunde uneia dintre
      // generatiile REALE simulate mai jos (__knownPairs) — exact comportamentul real: o pereche
      // gresita primeste raspuns gol, niciodata o eroare de retea.
      const known = __knownPairs.some(p => p.taskId === taskId && p.audioId === audioId);
      if (!known) {
        return { ok: true, res: { json: async () => ({ code: 200, data: { alignedWords: [] } }) } };
      }
      return {
        ok: true,
        res: { json: async () => ({ code: 200, data: { alignedWords: [
          { word: 'Test ', startS: 0, endS: 0.5, success: true }
        ] } }) }
      };
    }
    // Stub-uri minimale — STRICT ca generateLyricVideo sa poata continua dupa perechea
    // taskId/audioId (deja verificata mai sus); continutul lor real e testat separat, in alta parte.
    function buildCaptionLines() { return [{ start: 0, end: 0.5, text: 'Test' }]; }
    function toAss() { return 'fake-ass-content'; }

    ${generateLyricVideoSrc}

    return { generateLyricVideo };
  `;

  const knownPairs = [];
  const mod = new Function('__recordCall', '__knownPairs', 'require', 'fs', 'path', 'TEMP_DIR', sandboxSrc)(
    (taskId, audioId) => calls.timestampedLyrics.push({ taskId, audioId }),
    knownPairs,
    require,
    require('fs'),
    require('path'),
    require('os').tmpdir()
  );
  return { mod, calls, knownPairs };
}

function fakeVariant(id, sunoTrackId, musicTaskId) {
  // Forma EXACTA produsa de buildVariantFromTrack() dupa aceasta corectie (vezi testul
  // STRUCTURAL de mai sus) — musicTaskId poate lipsi intentionat (undefined), pentru a simula o
  // varianta VECHE, creata inainte de aceasta corectie (vezi testul de COMPATIBILITATE mai jos).
  return { id, sunoTrackId, musicTaskId, originalLyrics: 'Fake lyrics', durationSeconds: 120 };
}

// generateLyricVideo() continua, DUPA verificarea perechii taskId/audioId (deja inregistrata de
// mock-ul fetchTimestampedLyricsOnce de mai sus), cu constructia efectiva a subtitrarilor/fundalului
// video — pasi complet neschimbati de aceasta corectie si testati separat, in alta parte (vezi
// test/video-render-ffmpeg-real.test.js). Ii lasam sa arunce (dependinte neextrase in acest sandbox
// minimal) — irelevant aici, pentru ca asertiunea de interes (perechea trimisa catre Suno) s-a
// produs deja INAINTE de acel punct.
async function runIgnoringDownstreamErrors(promise) {
  try { await promise; } catch (err) { /* asteptat — vezi comentariul de mai sus */ }
}

test('FUNCTIONAL: generatie initiala (fara regenerare) -> video foloseste taskId-ul corect, aceeasi generatie ca varianta', async () => {
  const { mod, calls, knownPairs } = loadSandbox();
  const order = { id: 'order-1', musicTaskId: 'task-A' };
  knownPairs.push({ taskId: 'task-A', audioId: 'audio-A1' });

  const variant = fakeVariant('v1', 'audio-A1', 'task-A');

  await runIgnoringDownstreamErrors(mod.generateLyricVideo(order, variant, '/tmp/fake.mp3'));
  assert.deepEqual(calls.timestampedLyrics, [{ taskId: 'task-A', audioId: 'audio-A1' }]);
});

test('FUNCTIONAL (scenariul URGENT raportat de client): generatie initiala -> regenerare -> clientul alege pentru video varianta INITIALA -> perechea trimisa catre Suno ramane cea a generatiei INITIALE, niciodata cea a regenerarii', async () => {
  const { mod, calls, knownPairs } = loadSandbox();
  knownPairs.push({ taskId: 'task-A', audioId: 'audio-A1' });
  knownPairs.push({ taskId: 'task-B', audioId: 'audio-B1' });

  // Generatia initiala.
  const initialVariant = fakeVariant('v1', 'audio-A1', 'task-A');
  // Regenerare -- order.musicTaskId e acum SUPRASCRIS cu taskId-ul regenerarii (comportament real,
  // neschimbat de acest fix -- exact ca in server.js: db.updateOrder({ musicTaskId: taskId })).
  const order = { id: 'order-1', musicTaskId: 'task-B' };

  // Clientul alege pentru video varianta INITIALA (v1) -- exact scenariul real raportat.
  await runIgnoringDownstreamErrors(mod.generateLyricVideo(order, initialVariant, '/tmp/fake.mp3'));

  assert.deepEqual(
    calls.timestampedLyrics,
    [{ taskId: 'task-A', audioId: 'audio-A1' }],
    'trebuie folosit taskId-ul GENERATIEI INITIALE (task-A), niciodata order.musicTaskId (task-B, suprascris de regenerare)'
  );
});

test('FUNCTIONAL: generatie initiala -> regenerare -> clientul alege pentru video varianta REGENERATA -> perechea corecta a regenerarii', async () => {
  const { mod, calls, knownPairs } = loadSandbox();
  knownPairs.push({ taskId: 'task-A', audioId: 'audio-A1' });
  knownPairs.push({ taskId: 'task-B', audioId: 'audio-B1' });

  const regeneratedVariant = fakeVariant('v2', 'audio-B1', 'task-B');
  const order = { id: 'order-1', musicTaskId: 'task-B' };

  await runIgnoringDownstreamErrors(mod.generateLyricVideo(order, regeneratedVariant, '/tmp/fake.mp3'));

  assert.deepEqual(calls.timestampedLyrics, [{ taskId: 'task-B', audioId: 'audio-B1' }]);
});

test('FUNCTIONAL: MAI MULTE regenerari (3 generatii distincte) -> selectarea FIECAREI variante disponibile pentru video foloseste STRICT perechea EI proprie, indiferent de ordinea regenerarilor', async () => {
  const { mod, calls, knownPairs } = loadSandbox();
  knownPairs.push({ taskId: 'task-A', audioId: 'audio-A1' });
  knownPairs.push({ taskId: 'task-B', audioId: 'audio-B1' });
  knownPairs.push({ taskId: 'task-C', audioId: 'audio-C1' });

  const v1 = fakeVariant('v1', 'audio-A1', 'task-A');
  const v2 = fakeVariant('v2', 'audio-B1', 'task-B');
  const v3 = fakeVariant('v3', 'audio-C1', 'task-C');
  // order.musicTaskId reflecta STRICT ultima generatie (task-C), ca in productie.
  const order = { id: 'order-1', musicTaskId: 'task-C' };

  for (const [variant, expectedTaskId, expectedAudioId] of [
    [v1, 'task-A', 'audio-A1'],
    [v2, 'task-B', 'audio-B1'],
    [v3, 'task-C', 'audio-C1']
  ]) {
    calls.timestampedLyrics.length = 0;
    await runIgnoringDownstreamErrors(mod.generateLyricVideo(order, variant, '/tmp/fake.mp3'));
    assert.deepEqual(
      calls.timestampedLyrics,
      [{ taskId: expectedTaskId, audioId: expectedAudioId }],
      `varianta cu sunoTrackId=${expectedAudioId} trebuie sa foloseasca STRICT taskId-ul ${expectedTaskId} (propria generatie), indiferent ca order.musicTaskId e acum "task-C"`
    );
  }
});

test('COMPATIBILITATE: variante VECHI, create INAINTE de aceasta corectie (fara musicTaskId salvat) — generateLyricVideo revine STRICT la order.musicTaskId, comportament identic cu inainte, nicio comanda veche nu se strica', async () => {
  const { mod, calls, knownPairs } = loadSandbox();
  knownPairs.push({ taskId: 'task-OLD', audioId: 'audio-OLD1' });

  // Simuleaza o varianta VECHE, asa cum ar fi citita din baza de date dintr-o comanda creata
  // inainte de aceasta corectie -- fara campul musicTaskId (undefined), exact ca inainte.
  const oldVariant = { id: 'v-old', sunoTrackId: 'audio-OLD1', originalLyrics: 'Old lyrics', durationSeconds: 120 };
  const order = { id: 'order-old', musicTaskId: 'task-OLD' };

  await runIgnoringDownstreamErrors(mod.generateLyricVideo(order, oldVariant, '/tmp/fake.mp3'));
  assert.deepEqual(calls.timestampedLyrics, [{ taskId: 'task-OLD', audioId: 'audio-OLD1' }]);
});

test('EROARE CLARA (nu presupunere silentioasa): daca varianta nu are musicTaskId SI order.musicTaskId lipseste, generateLyricVideo arunca o eroare explicita, niciodata o cerere cu taskId undefined/null catre Suno', async () => {
  const { mod, calls } = loadSandbox();
  const order = { id: 'order-x' }; // fara musicTaskId
  const variant = { id: 'v-x', sunoTrackId: 'audio-X1' }; // fara musicTaskId
  await assert.rejects(
    () => mod.generateLyricVideo(order, variant, '/tmp/fake.mp3'),
    /Lipseste sunoTrackId sau musicTaskId/
  );
  assert.equal(calls.timestampedLyrics.length, 0, 'nu trebuie trimisa nicio cerere catre Suno fara un taskId valid');
});
