// CORECȚIE (2026-09-14, comanda reala 5f4b1e2f-bc97-47af-9d98-5cccc8db632f, Premium, editare
// selectiva, genul "jazz"): ROOT CAUSE demonstrat direct din loguri de productie — 4 din 4 piese
// (2 initiale + 2 de la singura reincercare permisa pana acum) respinse de
// validateLyricsCoherence (motiv: sender_self_declaration), inainte ca cererea sa fie declarata
// esuata ("Nu am putut finaliza melodia de aceasta data..."). Validarea insasi a functionat
// CORECT (nicio varianta incoerenta salvata) — cauza reala e STRICT bugetul de reincercari (1),
// insuficient impotriva variabilitatii furnizorului. Fixul (MAX_COHERENCE_RETRIES: 1 -> 2, vezi
// server.js langa obtainAcceptableVariant) NU schimba validateLyricsCoherence()/pragurile ei, NU
// schimba buildPrompt()/buildExactLyricsRequest()/stilul/genul/vocea — STRICT numarul de
// incercari inauntrul unui singur apel obtainAcceptableVariant(), inainte de a declara cererea
// esuata. Generic pentru orice gen/limba/pachet — funcția e SINGURUL punct folosit atat pentru
// generarea initiala cat si pentru regenerare/editare (customMode:false).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function sliceFunctionBody(src, fnSignature, fromIdx) {
  const start = src.indexOf(fnSignature, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignature}"`);
  let depth = 1, i = start + fnSignature.length;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function loadModule() {
  const buildPromptStartIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  const coherenceRegion = server.slice(buildPromptStartIdx, server.indexOf('function buildPrompt(order, feedback, genreOverride) {'));
  const orderTracksSnippet = sliceFunctionBody(server, 'function orderTracksByCoherence(tracks, order, recipientSnapshot) {');
  const maxRetriesIdx = server.indexOf('const MAX_COHERENCE_RETRIES = ');
  assert.ok(maxRetriesIdx !== -1, 'nu am gasit MAX_COHERENCE_RETRIES in server.js');
  const maxRetriesSnippet = server.slice(maxRetriesIdx, server.indexOf(';', maxRetriesIdx) + 1);
  const obtainSnippet = sliceFunctionBody(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const { randomUUID } = require('node:crypto');
    const SUNO_SUCCESS_STATUS = 'SUCCESS';
    const __mock = { buildVariantFromTrack: null, callMusicProvider: null, pollForResult: null, buildPrompt: null };
    function perfLog() {}
    async function buildVariantFromTrack(orderId, variantId, track, taskId) { return __mock.buildVariantFromTrack(orderId, variantId, track, taskId); }
    async function callMusicProvider(orderId, prompt) { return __mock.callMusicProvider(orderId, prompt); }
    async function pollForResult(taskId, orderId) { return __mock.pollForResult(taskId, orderId); }
    function buildPrompt(order, feedback, genre) { return __mock.buildPrompt(order, feedback, genre); }
    ${coherenceRegion}
    ${orderTracksSnippet}
    ${maxRetriesSnippet}
    ${obtainSnippet}
    return { obtainAcceptableVariant, MAX_COHERENCE_RETRIES, __mock };
  `;
  return new Function('require', sandboxSrc)(require);
}

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PLANS = ['standard', 'premium', 'video'];
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];

function orderFor(lang, plan) {
  return { id: 'order-x', lang, plan, senderName: 'Andrei', relationship: 'Soț', story: 'Te iubesc viața mea' };
}

// Simuleaza EXACT tiparul real al comenzii 5f4b1e2f: ambele trackuri initiale respinse de
// validateLyricsCoherence, ȘI ambele trackuri din reincercarea #1 respinse la fel — sub vechiul
// buget (1 reincercare), cererea era declarata esuata AICI. Sub noul buget (2 reincercari),
// reincercarea #2 trebuie sa mai aiba o sansa.
function makeAlwaysBadThenGoodMock({ badRounds }) {
  const badTrack = () => ({ id: 'bad', lyrics: 'Sunt Andrei, soțul tău, te iubim mult, Maria.' }); // sender_self_declaration
  const goodTrack = () => ({ id: 'good', lyrics: 'Draga mea Maria, te iubesc enorm, azi si mereu.' });
  let round = 0;
  return {
    buildVariantFromTrack: async (orderId, variantId, track) => ({ id: variantId, originalLyrics: track.lyrics }),
    buildPrompt: () => 'prompt-fals',
    callMusicProvider: async () => 'retry-task',
    pollForResult: async () => {
      round++;
      if (round <= badRounds) return { status: 'SUCCESS', tracks: [badTrack(), badTrack()] };
      return { status: 'SUCCESS', tracks: [badTrack(), goodTrack()] };
    }
  };
}

// ===============================================================================================
// TEST — reproduce EXACT tiparul comenzii reale 5f4b1e2f: 2 trackuri initiale rele + 1 reincercare
// rea (4 respinse total) — sub vechiul buget (MAX_COHERENCE_RETRIES=1) asta era esec final.
// ===============================================================================================
test('REPRODUCERE REGRESIE (comanda reala 5f4b1e2f): 2 trackuri initiale + 1 reincercare, toate respinse de sender_self_declaration -> cu vechiul buget (1 reincercare) ar fi fost esec final', () => {
  const mod = loadModule();
  assert.ok(mod.MAX_COHERENCE_RETRIES >= 2, 'fixul trebuie sa fi marit bugetul de reincercari la cel putin 2');
});

test('DUPA FIX: a 2-a reincercare (posibila doar cu MAX_COHERENCE_RETRIES>=2) recupereaza cererea care ar fi esuat cu bugetul vechi de 1 reincercare', async () => {
  const mod = loadModule();
  const order = orderFor('ro', 'premium');
  // badRounds=2: initial (round nu se numara ca "round" de poll — vezi mai jos) + reincercare 1
  // sunt REA, reincercarea 2 e BUNA. Cu vechiul buget (1 reincercare), procesul s-ar fi oprit
  // dupa reincercarea 1 (rea) -> built:null. Cu noul buget (2), reincercarea 2 (buna) salveaza
  // cererea.
  mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => ({ id: variantId, originalLyrics: track.lyrics });
  mod.__mock.buildPrompt = () => 'prompt-fals';
  mod.__mock.callMusicProvider = async () => 'retry-task';
  let pollCalls = 0;
  const badTrack = { id: 'bad', lyrics: 'Sunt Andrei, soțul tău, te iubim mult, Maria.' };
  const goodTrack = { id: 'good', lyrics: 'Draga mea Maria, te iubesc enorm, azi si mereu.' };
  mod.__mock.pollForResult = async () => {
    pollCalls++;
    if (pollCalls === 1) return { status: 'SUCCESS', tracks: [badTrack, badTrack] }; // reincercare 1: rea
    return { status: 'SUCCESS', tracks: [badTrack, goodTrack] }; // reincercare 2: buna
  };
  const initialBadTracks = [badTrack, badTrack];
  const result = await mod.obtainAcceptableVariant('order-5f4b1e2f-like', initialBadTracks, 'task-1', 'jazz', order, {}, null);
  assert.ok(result.built, 'cu MAX_COHERENCE_RETRIES=2, a doua reincercare trebuie sa recupereze cererea');
  assert.equal(result.built.originalLyrics, goodTrack.lyrics);
  assert.equal(pollCalls, 2, 'trebuie folosite ambele reincercari permise pentru a ajunge la track-ul bun');
});

test('DACA TOATE reincercarile permise esueaza (tipar identic cu 5f4b1e2f, dar fara nicio recuperare) -> tot built:null, nicio varianta incoerenta salvata', async () => {
  const mod = loadModule();
  const order = orderFor('ro', 'premium');
  Object.assign(mod.__mock, makeAlwaysBadThenGoodMock({ badRounds: 999 })); // niciodata bun
  const badTrack = { id: 'bad', lyrics: 'Sunt Andrei, soțul tău, te iubim mult, Maria.' };
  const result = await mod.obtainAcceptableVariant('order-x', [badTrack, badTrack], 'task-1', 'jazz', order, {}, null);
  assert.equal(result.built, null, 'daca chiar toate incercarile permise esueaza, cererea tot ramane esuata — comportamentul de siguranta neschimbat');
});

// ===============================================================================================
// ACOPERIRE: 8 limbi x 3 pachete — obtainAcceptableVariant() nu ramifica dupa lang/plan, deci
// mecanismul de reincercare se aplica identic pentru toate combinatiile.
// ===============================================================================================
for (const lang of LANGS) {
  for (const plan of PLANS) {
    test(`ACOPERIRE [${lang}/${plan}]: mecanismul de reincercare (MAX_COHERENCE_RETRIES=2) recupereaza cererea identic, indiferent de limba/pachet`, async () => {
      const mod = loadModule();
      const order = orderFor(lang, plan);
      let pollCalls = 0;
      const badTrack = { id: 'bad', lyrics: 'Sunt Andrei, soțul tău, te iubim mult, Maria.' };
      const goodTrack = { id: 'good', lyrics: 'Draga mea Maria, te iubesc enorm.' };
      mod.__mock.buildVariantFromTrack = async (orderId, variantId, track) => ({ id: variantId, originalLyrics: track.lyrics });
      mod.__mock.buildPrompt = () => 'prompt-fals';
      mod.__mock.callMusicProvider = async () => 'retry-task';
      mod.__mock.pollForResult = async () => {
        pollCalls++;
        if (pollCalls === 1) return { status: 'SUCCESS', tracks: [badTrack, badTrack] };
        return { status: 'SUCCESS', tracks: [badTrack, goodTrack] };
      };
      const result = await mod.obtainAcceptableVariant('order-x', [badTrack, badTrack], 'task-1', 'pop', order, {}, null);
      assert.ok(result.built, `[${lang}/${plan}] a doua reincercare trebuie sa recupereze cererea`);
    });
  }
}

// ===============================================================================================
// PROTECTIE (istoric, 2026-09-14): la momentul corectiei de buget de reincercari testate in acest
// fisier, validateLyricsCoherence() a ramas byte-identica — asertiunea originala compara STRICT
// impotriva HEAD (deci ar fi picat pentru ORICE modificare ulterioara legitima a functiei, nu doar
// pentru una accidentala din aceasta corectie de buget).
//
// SUPERSEDAT (2026-09-25, investigatie separata, aprobata explicit — fals-pozitive
// validateLyricsCoherence() dupa manele_suflet "Short lines"): validateLyricsCoherence() A FOST
// modificata deliberat, de aceasta data — 'explicit_message_omitted' nu mai blocheaza (absenta unei
// fraze exacte nu dovedeste omiterea mesajului, doar reformulare), iar sender_self_declaration
// cere acum pozitie de inceput de propozitie (elimina un omograf gramatical real — "sunt"/"sono" pot
// insemna si "sunt/are" la persoana a III-a plural, nu doar "I am"). MAX_COHERENCE_RETRIES si
// mecanismul de reincercare testate mai sus in acest fisier raman COMPLET neatinse — vezi
// test/lyrics-coherence-false-positive-fix.test.js pentru verificarea dedicata, exhaustiva a noii
// logici (ce ramane blocant, ce nu, si de ce).
test('PROTECTIE: MAX_COHERENCE_RETRIES si structura obtainAcceptableVariant() raman neatinse de corectia din 2026-09-25 (STRICT validateLyricsCoherence() a fost modificata, cu aprobare explicita)', () => {
  assert.match(server, /const MAX_COHERENCE_RETRIES = 2;/);
  assert.match(server, /async function obtainAcceptableVariant\(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics\) \{/);
});

// ===============================================================================================
// PROTECTIE: GENRE_STYLE_MAP / VOICE_INSTRUCTIONS / buildPrompt / buildExactLyricsRequest raman
// neatinse — fixul e STRICT in obtainAcceptableVariant() (numarul de reincercari).
// ===============================================================================================
// CORECȚIE (2026-09-14, "instrumentalul de dinainte de voce suna a manea, nu a Hip Hop" —
// aprobata explicit, ULTERIOARA corectiei de buget de reincercari testata in acest fisier):
// hiphop a fost EXCLUS din aceasta verificare — e singurul gen modificat intentionat de acea
// corectie ulterioara, neatinsa fata de commit-ul 57e37db la momentul CORECTIEI DE FATA (buget
// reincercari). Vezi test/hiphop-genre-redefinition.test.js pentru verificarea dedicata a
// schimbarii de hiphop.
test('PROTECTIE: GENRE_STYLE_MAP (15 din cele 16 genuri, hiphop exclus) ramane BYTE-IDENTIC fata de commit-ul 57e37db', () => {
  const { execSync } = require('node:child_process');
  const beforeSrc = execSync('git show 57e37db:server.js', { cwd: path.join(__dirname, '..'), maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  function loadGenreStyleMap(src) {
    const idx = src.indexOf('const GENRE_STYLE_MAP = {');
    const end = src.indexOf('};', idx);
    const body = src.slice(idx, end);
    const map = {};
    for (const g of NEW_GENRES) {
      const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
      if (m) map[g] = m[1];
    }
    return map;
  }
  const before = loadGenreStyleMap(beforeSrc);
  const after = loadGenreStyleMap(server);
  // manele_suflet EXCLUS aici (2026-09-19, corectie separata si ulterioara — "intro scurt",
  // aprobata explicit, scop STRICT limitat la acea valoare) — vezi
  // test/manele-suflet-short-intro.test.js pentru verificarea dedicata a acelei modificari.
  for (const g of NEW_GENRES.filter(g => g !== 'hiphop' && g !== 'manele_suflet')) assert.equal(after[g], before[g], `genul "${g}" trebuie sa ramana byte-identic`);
});

test('PROTECTIE: VOICE_INSTRUCTIONS_FULL/SHORT raman prezente si neatinse (fixul nu le-a modificat)', () => {
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_FULL = {\n    female: ' Use a female lead vocal.',\n    male: ' Use a male lead vocal.',\n    duet: ' Use a male and female duet, with both voices clearly present.',\n    auto: ''\n  };"));
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_SHORT = {\n    female: ' Female vocal.',\n    male: ' Male vocal.',\n    duet: ' Male-female duet.',\n    auto: ''\n  };"));
});

// ===============================================================================================
// ACOPERIRE: initial generation + edit/regenerare folosesc ACEEASI functie (deja confirmat prin
// cautare in cod) — fixul se aplica automat la ambele cai.
// ===============================================================================================
test('ACOPERIRE: obtainAcceptableVariant() e apelata din finalizeVariantsIfNeeded() — SINGURUL punct de decizie, folosit atat de generarea initiala cat si de regenerare/editare', () => {
  const idx = server.indexOf('const { built, lastErr } = await obtainAcceptableVariant(');
  assert.ok(idx !== -1, 'finalizeVariantsIfNeeded trebuie sa foloseasca obtainAcceptableVariant() ca punct unic de decizie');
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
