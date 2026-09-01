// Teste REALE pentru obtainAcceptableVariant() / finalizeVariantsIfNeeded (corectie audit
// independent, 2026-08-24, runda 2 — "nu mai livra clientului o varianta care nu trece
// validarea"). Bug-ul REAL gasit: dupa reincercarea de coerenta, codul vechi inlocuia varianta
// chiar daca retryCoherence.ok era false si tot o salva in builtVariants — versuri incoerente
// puteau ajunge la client. obtainAcceptableVariant() e acum SINGURUL punct de decizie: accepta
// si persista STRICT un track cu coherence.ok===true; daca primul track nu poate fi procesat
// TEHNIC, verifica si al doilea; daca nimic din incercarea initiala SAU din reincercare nu e
// coerent, returneaza built:null (apelantul trateaza asta ca esec al cererii, flux existent).
//
// Foloseste orderTracksByCoherence/validateLyricsCoherence/resolveSenderMode REALE (extrase din
// server.js), dar MOCHEAZA buildVariantFromTrack/callMusicProvider/pollForResult/buildPrompt —
// testele controleaza exact ce "raspunde" fiecare piesa/reincercare, ca sa acopere determinist
// toate cele 5 scenarii cerute explicit: ambele trackuri gresite, retry gresit, retry bun, eroare
// tehnica pe primul track + fallback la al doilea.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function sliceFunctionBody(server, fnSignatureEndingInBrace, fromIdx) {
  const start = server.indexOf(fnSignatureEndingInBrace, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignatureEndingInBrace}" in server.js`);
  let depth = 1, i = start + fnSignatureEndingInBrace.length;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return { start, end: i + 1, text: server.slice(start, i + 1) };
}

function loadModule() {
  const server = read('server.js');

  const buildPromptStartIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(buildPromptStartIdx !== -1);
  const buildPromptFuncStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', buildPromptStartIdx);
  let depth = 0, i = server.indexOf('{', buildPromptFuncStart);
  for (; i < server.length; i++) { if (server[i] === '{') depth++; else if (server[i] === '}') { depth--; if (depth === 0) break; } }
  // extragem DOAR partea de coerenta (resolveSenderMode/validateLyricsCoherence si constantele
  // lor), NU si buildPrompt insusi (pe care il mocam mai jos — testele astea nu au nevoie de
  // continutul lui real, doar de faptul ca poate fi apelat).
  const coherenceRegion = server.slice(buildPromptStartIdx, server.indexOf('function buildPrompt(order, feedback, genreOverride) {'));

  const orderTracksSnippet = sliceFunctionBody(server, 'function orderTracksByCoherence(tracks, order, recipientSnapshot) {').text;
  const obtainSnippet = sliceFunctionBody(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {').text;

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const { randomUUID } = require('node:crypto');
    const SUNO_SUCCESS_STATUS = 'SUCCESS';

    // ---- MOCK-uri, controlate per test prin __mock ----
    const __mock = {
      buildVariantFromTrack: null, // (orderId, variantId, track, taskId) => Promise
      callMusicProvider: null,     // (orderId, prompt) => Promise<taskId>
      pollForResult: null,         // (taskId, orderId) => Promise<{status, tracks}>
      buildPrompt: null            // (order, feedback, genre) => string
    };
    async function buildVariantFromTrack(orderId, variantId, track, taskId) {
      return __mock.buildVariantFromTrack(orderId, variantId, track, taskId);
    }
    async function callMusicProvider(orderId, prompt) {
      return __mock.callMusicProvider(orderId, prompt);
    }
    async function pollForResult(taskId, orderId) {
      return __mock.pollForResult(taskId, orderId);
    }
    function buildPrompt(order, feedback, genre) {
      return __mock.buildPrompt(order, feedback, genre);
    }

    ${coherenceRegion}
    ${orderTracksSnippet}
    ${obtainSnippet}

    return { obtainAcceptableVariant, orderTracksByCoherence, validateLyricsCoherence, resolveSenderMode, __mock };
  `;
  return new Function('require', sandboxSrc)(require);
}

function baseOrder() {
  return {
    id: 'order-test-1',
    lang: 'ro',
    plan: 'standard',
    senderName: 'Bunicul Andrei',
    story: 'Te iubesc enorm, draga mea Maria.'
  };
}

test('obtainAcceptableVariant: AMBELE trackuri initiale sunt incoerente si REINCERCAREA produce si ea doar trackuri incoerente -> built:null (nicio varianta incoerenta livrata)', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const badTrackA = { id: 'a', lyrics: 'Sunt Bunicului Andrei, te iubim mult, Maria.' }; // auto-identificare + derapaj
  const badTrackB = { id: 'b', lyrics: 'Noi te iubim, draga Maria, din suflet.' }; // derapaj (fara mesaj singular)
  const retryBadTrackA = { id: 'ra', lyrics: 'Iar aici Sunt Bunicului Andrei, va iubim mult.' };
  const retryBadTrackB = { id: 'rb', lyrics: 'Melodie fara mesajul explicit din poveste.' }; // omisiune

  let buildCalls = 0;
  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => {
    buildCalls++;
    return { id: variantId, originalLyrics: track.lyrics };
  };
  mod.__mock.buildPrompt = () => 'prompt-fals';
  mod.__mock.callMusicProvider = async () => 'retry-task-1';
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [retryBadTrackA, retryBadTrackB] });

  const result = await mod.obtainAcceptableVariant('order-1', [badTrackA, badTrackB], 'task-1', 'pop', order, {}, null);
  assert.equal(result.built, null, 'nicio varianta incoerenta nu trebuie acceptata, nici din incercarea initiala, nici din reincercare');
  assert.equal(buildCalls, 4, 'trebuie incercate exact toate cele 4 trackuri (2 initiale + 2 din reincercare), niciunul sarit');
});

test('obtainAcceptableVariant: AMBELE trackuri initiale incoerente, dar REINCERCAREA produce un track coerent ("retry bun") -> acceptat', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const badTrackA = { id: 'a', lyrics: 'Sunt Bunicului Andrei, te iubim mult, Maria.' };
  const badTrackB = { id: 'b', lyrics: 'Noi te iubim, draga Maria.' };
  const goodRetryTrack = { id: 'good', lyrics: 'Draga mea Maria, te iubesc enorm, esti totul pentru mine.' };

  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => ({ id: variantId, originalLyrics: track.lyrics });
  mod.__mock.buildPrompt = () => 'prompt-fals';
  mod.__mock.callMusicProvider = async () => 'retry-task-2';
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [badTrackA, goodRetryTrack] }); // reincercarea intoarce un track rau si unul bun

  const result = await mod.obtainAcceptableVariant('order-2', [badTrackA, badTrackB], 'task-1', 'pop', order, {}, null);
  assert.ok(result.built, 'un track coerent din reincercare trebuie acceptat');
  assert.equal(result.built.originalLyrics, goodRetryTrack.lyrics, 'trebuie folosit EXACT track-ul coerent, niciodata cel incoerent');
});

test('obtainAcceptableVariant: primul track ESUEAZA TEHNIC (buildVariantFromTrack arunca), al doilea e coerent -> fallback tehnic la al doilea, ACCEPTAT direct (fara reincercare)', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const failingTrack = { id: 'fail', lyrics: 'Draga mea Maria, te iubesc enorm.' }; // continut ar fi coerent, dar esueaza TEHNIC
  const okTrack = { id: 'ok', lyrics: 'Draga mea Maria, te iubesc enorm, azi si mereu.' };

  let retryTriggered = false;
  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => {
    if (track.id === 'fail') throw new Error('esec descarcare/ffmpeg simulat');
    return { id: variantId, originalLyrics: track.lyrics };
  };
  mod.__mock.buildPrompt = () => 'prompt-fals';
  mod.__mock.callMusicProvider = async () => { retryTriggered = true; return 'retry-task-3'; };
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [] });

  // ambele trackuri sunt deja coerente ca text -> orderTracksByCoherence nu le reordoneaza,
  // primul incearca sa se construiasca, esueaza TEHNIC, al doilea reuseste si e coerent.
  const result = await mod.obtainAcceptableVariant('order-3', [failingTrack, okTrack], 'task-1', 'pop', order, {}, null);
  assert.ok(result.built, 'al doilea track (fallback tehnic) trebuie acceptat');
  assert.equal(result.built.originalLyrics, okTrack.lyrics);
  assert.equal(retryTriggered, false, 'daca al doilea track initial reuseste si e coerent, NU trebuie declansata nicio reincercare');
});

test('obtainAcceptableVariant: AMBELE trackuri initiale esueaza TEHNIC -> built:null, lastErr pastrat, FARA reincercare de coerenta (esec pur tehnic)', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const failA = { id: 'fa', lyrics: 'x' };
  const failB = { id: 'fb', lyrics: 'y' };
  let retryTriggered = false;

  mod.__mock.buildVariantFromTrack = async () => { throw new Error('descarcare esuata'); };
  mod.__mock.buildPrompt = () => 'prompt-fals';
  mod.__mock.callMusicProvider = async () => { retryTriggered = true; return 'retry-task-4'; };
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [] });

  const result = await mod.obtainAcceptableVariant('order-4', [failA, failB], 'task-1', 'pop', order, {}, null);
  assert.equal(result.built, null);
  assert.ok(result.lastErr && /descarcare esuata/.test(result.lastErr.message));
  assert.equal(retryTriggered, true, 'chiar un esec tehnic pur initial trebuie sa declanseze reincercarea unica (acelasi tipar ca la versuri goale)');
});

test('obtainAcceptableVariant: versurile EDITATE MANUAL (canonicalLyrics) ocolesc complet validarea de coerenta — accepta primul track TEHNIC reusit, indiferent de continutul lui', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const incoherentButTechnicallyFine = { id: 'x', lyrics: 'Sunt Bunicului Andrei, te iubim, orice text aici.' };
  let retryTriggered = false;

  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => ({ id: variantId, originalLyrics: track.lyrics });
  mod.__mock.callMusicProvider = async () => { retryTriggered = true; return 'x'; };
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [] });

  const result = await mod.obtainAcceptableVariant('order-5', [incoherentButTechnicallyFine], 'task-1', 'pop', order, {}, 'Versuri exacte editate de client, verbatim.');
  assert.ok(result.built, 'canonicalLyrics: succesul TEHNIC e suficient, coerenta nu se verifica niciodata');
  assert.equal(retryTriggered, false, 'canonicalLyrics nu declanseaza NICIODATA reincercarea de coerenta');
});

test('obtainAcceptableVariant: canonicalLyrics + AMBELE trackuri esueaza TEHNIC -> built:null, FARA nicio reincercare (comportament identic cu inainte de aceasta corectie)', async () => {
  const mod = loadModule();
  const order = baseOrder();
  let retryTriggered = false;
  mod.__mock.buildVariantFromTrack = async () => { throw new Error('esec tehnic'); };
  mod.__mock.callMusicProvider = async () => { retryTriggered = true; return 'x'; };
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [] });

  const result = await mod.obtainAcceptableVariant('order-6', [{ id: 'a' }, { id: 'b' }], 'task-1', 'pop', order, {}, 'Versuri exacte.');
  assert.equal(result.built, null);
  assert.equal(retryTriggered, false, 'canonicalLyrics cu esec tehnic pur ramane esec final, fara reincercare — identic cu comportamentul dinainte');
});

test('obtainAcceptableVariant: primul track initial DEJA coerent -> acceptat imediat, niciun apel suplimentar (al doilea track, reincercarea) nu are loc', async () => {
  const mod = loadModule();
  const order = baseOrder();
  const goodTrack = { id: 'g', lyrics: 'Draga mea Maria, te iubesc enorm, azi si mereu.' };
  const secondTrack = { id: 's', lyrics: 'Al doilea track, nu ar trebui folosit.' };
  let secondTrackBuilt = false;
  let retryTriggered = false;

  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => {
    if (track.id === 's') secondTrackBuilt = true;
    return { id: variantId, originalLyrics: track.lyrics };
  };
  mod.__mock.callMusicProvider = async () => { retryTriggered = true; return 'x'; };
  mod.__mock.pollForResult = async () => ({ status: 'SUCCESS', tracks: [] });

  const result = await mod.obtainAcceptableVariant('order-7', [goodTrack, secondTrack], 'task-1', 'pop', order, {}, null);
  assert.ok(result.built);
  assert.equal(result.built.originalLyrics, goodTrack.lyrics);
  assert.equal(secondTrackBuilt, false, 'daca primul track e deja coerent, al doilea nu trebuie procesat deloc');
  assert.equal(retryTriggered, false);
});

test('finalizeVariantsIfNeeded (integrare textuala): bug-ul REAL (varianta incoerenta impinsa necondiţionat) nu mai exista — builtVariants.push(built) ramane STRICT in ramura "if (built)"', () => {
  const server = read('server.js');
  const idx = server.indexOf('const { built, lastErr } = await obtainAcceptableVariant(');
  assert.ok(idx !== -1, 'finalizeVariantsIfNeeded trebuie sa foloseasca obtainAcceptableVariant() ca punct unic de decizie');
  const body = server.slice(idx, idx + 2000);
  assert.ok(body.includes('if (built) {'));
  assert.ok(body.includes('builtVariants.push(built);'));
  assert.ok(body.includes('} else {'));
  assert.ok(body.includes('requestFailures.push('));
  // NU trebuie sa mai existe niciun "built = coherenceRetryBuilt" necondiţionat (bug-ul vechi).
  assert.ok(!server.includes('built = coherenceRetryBuilt;'), 'atribuirea necondiţionata veche, bugata, nu mai trebuie sa existe');
});
