// checkLyricsSemanticCoherence() — verificare SEMANTICA reala a versurilor (2026-10-12, cerinta
// explicita: "Aprob pregatirea unui sistem AI dedicat verificarii semantice a versurilor Naluna").
// AL DOILEA filtru, DOAR pe piese care au trecut deja de validateLyricsCoherence() (regex,
// gratuit) — vezi test/lyrics-obtain-acceptable-variant.test.js / lyrics-coherence-retry-budget-fix
// pentru felul in care e cablata in attempt().
//
// Fail-OPEN prin design, in FIECARE punct posibil de esec (lipsa cheie, HTTP non-ok, JSON invalid,
// camp `ok` nebooleean, exceptie la fetch) — o defectiune a acestui serviciu extern NOU, platit
// separat, NU trebuie sa poata bloca livrarea unei comenzi deja platite. Niciun apel real de retea
// in aceste teste — `fetchImpl` e injectabil STRICT pentru testare (acelasi tipar deja folosit in
// tot fisierul pentru alte integrari externe).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function sliceFunction(server, fnSignature, fromIdx) {
  const start = server.indexOf(fnSignature, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignature}" in server.js`);
  let depth = 0, i = server.indexOf('{', start);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}

function loadCheckLyricsSemanticCoherence() {
  const server = read('server.js');
  const constIdx = server.indexOf("const SEMANTIC_CHECK_MODEL = 'claude-haiku-4-5-20251001';");
  assert.ok(constIdx !== -1, 'nu am gasit constantele SEMANTIC_CHECK_* in server.js');
  const fnSnippet = sliceFunction(server, 'async function checkLyricsSemanticCoherence(order, recipientSnapshot, lyricsText, fetchImpl) {', constIdx);
  const constSnippet = server.slice(constIdx, server.indexOf('async function checkLyricsSemanticCoherence'));

  const sandboxSrc = `
    ${constSnippet}
    ${fnSnippet}
    return { checkLyricsSemanticCoherence };
  `;
  return new Function(sandboxSrc)();
}
const { checkLyricsSemanticCoherence } = loadCheckLyricsSemanticCoherence();

function baseOrder(overrides) {
  return Object.assign({
    lang: 'ro',
    story: 'Ne-am cunoscut la facultate si de atunci suntem nedespartiti.',
    recipient: 'Maria',
    senderName: 'Andrei',
    occasion: 'declaratie'
  }, overrides);
}

function withApiKey(fn) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-fake';
  return fn().finally(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });
}

function anthropicResponse(bodyObj, { httpOk = true, status = 200 } = {}) {
  return {
    ok: httpOk,
    status,
    json: async () => ({ content: [{ text: JSON.stringify(bodyObj) }] })
  };
}

// ===================================================================================================
// 1) FARA ANTHROPIC_API_KEY (cazul implicit, azi) -> no-op garantat, NICIUN apel de retea.
// ===================================================================================================
test('checkLyricsSemanticCoherence: FARA ANTHROPIC_API_KEY -> {ok:true, reasons:[]}, fara niciun apel fetch (no-op garantat, cazul implicit azi)', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let fetchCalled = false;
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri aici.', async () => { fetchCalled = true; });
  assert.deepEqual(result, { ok: true, reasons: [] });
  assert.equal(fetchCalled, false, 'serviciul neconfigurat nu trebuie sa declanseze niciun apel de retea');
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
});

// ===================================================================================================
// 2) Versuri ACCEPTATE de AI (ok:true, issues:[]) -> rezultatul e propagat corect.
// ===================================================================================================
test('checkLyricsSemanticCoherence: AI accepta versurile (ok:true) -> {ok:true, reasons:[]}', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({ ok: true, issues: [] });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Draga Maria, te iubesc enorm, esti totul pentru mine.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 3) Versuri RESPINSE de AI (ok:false, issues:[...]) -> motivele sunt prefixate 'ai_semantic:'.
// ===================================================================================================
test('checkLyricsSemanticCoherence: AI respinge versurile (ok:false, issues) -> {ok:false, reasons: ["ai_semantic: ..."]}', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({ ok: false, issues: ['menioneaza un eveniment care nu apare in poveste'] });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Versuri incoerente cu povestea.', fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ['ai_semantic: menioneaza un eveniment care nu apare in poveste']);
}));

// ===================================================================================================
// 4) FAIL-OPEN: raspuns HTTP non-ok (ex. 500/429 de la Anthropic) -> tratat ca acceptat.
// ===================================================================================================
test('checkLyricsSemanticCoherence: raspuns HTTP non-ok (500) -> FAIL-OPEN, {ok:true, reasons:[]}', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({}, { httpOk: false, status: 500 });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 5) FAIL-OPEN: raspunsul nu contine deloc text (structura neasteptata) -> acceptat.
// ===================================================================================================
test('checkLyricsSemanticCoherence: raspuns fara camp text (structura neasteptata) -> FAIL-OPEN', () => withApiKey(async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [] }) });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 6) FAIL-OPEN: textul AI nu contine deloc JSON valid -> acceptat.
// ===================================================================================================
test('checkLyricsSemanticCoherence: textul AI nu contine JSON (raspuns malformat) -> FAIL-OPEN', () => withApiKey(async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: 'nu stiu, raspuns liber fara json' }] }) });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 7) FAIL-OPEN: JSON valid sintactic, dar campul `ok` nu e boolean -> acceptat.
// ===================================================================================================
test('checkLyricsSemanticCoherence: campul "ok" din JSON nu e boolean -> FAIL-OPEN', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({ ok: 'maybe', issues: [] });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 8) FAIL-OPEN: fetchImpl arunca (eroare de retea/timeout) -> acceptat, nicio exceptie propagata.
// ===================================================================================================
test('checkLyricsSemanticCoherence: fetchImpl arunca (eroare de retea/timeout) -> FAIL-OPEN, nicio exceptie propagata', () => withApiKey(async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET simulat'); };
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 9) issues absent din raspunsul JSON (doar {ok:false}) -> reasons ramane array gol, nu arunca.
// ===================================================================================================
test('checkLyricsSemanticCoherence: {ok:false} fara camp "issues" -> reasons: [] (nu arunca)', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({ ok: false });
  const result = await checkLyricsSemanticCoherence(baseOrder(), {}, 'Orice versuri.', fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, []);
}));

// ===================================================================================================
// 10) Nu arunca pentru nicio limba din cele 8 — promptul se construieste corect indiferent de lang.
// ===================================================================================================
for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
  test(`checkLyricsSemanticCoherence [${lang}]: nu arunca si returneaza un rezultat valid indiferent de limba`, () => withApiKey(async () => {
    const fetchImpl = async () => anthropicResponse({ ok: true, issues: [] });
    const result = await checkLyricsSemanticCoherence(baseOrder({ lang }), {}, 'Versuri de test.', fetchImpl);
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.reasons));
  }));
}

// ===================================================================================================
// 11) recipientSnapshot are prioritate fata de order pentru story/senderName (acelasi tipar ca
//     validateLyricsCoherence/buildPrompt — "datele EFECTIVE ale acestei melodii").
// ===================================================================================================
test('checkLyricsSemanticCoherence: foloseste story/senderName/occasion din recipientSnapshot cand sunt prezente (prioritate fata de order)', () => withApiKey(async () => {
  let capturedBody = null;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return anthropicResponse({ ok: true, issues: [] });
  };
  const order = baseOrder({ story: 'povestea veche din order', senderName: 'Ion' });
  const recipientSnapshot = { story: 'povestea EFECTIVA a acestei melodii', senderName: 'Vlad', occasion: 'pentru-mama' };
  await checkLyricsSemanticCoherence(order, recipientSnapshot, 'Versuri.', fetchImpl);
  const promptText = capturedBody.messages[0].content;
  assert.ok(promptText.includes('povestea EFECTIVA a acestei melodii'), 'trebuie folosita povestea din recipientSnapshot, nu din order');
  assert.ok(promptText.includes('Vlad'), 'trebuie folosit senderName din recipientSnapshot, nu din order');
  assert.ok(!promptText.includes('povestea veche din order'));
}));

// ===================================================================================================
// 12) Cerinta explicita: testeaza si cazul in care AI-ul ar putea respinge gresit versuri CORECTE —
//     documenteaza ca functia INSASI nu are nicio logica care sa forteze respingerea; decizia vine
//     STRICT din raspunsul modelului. Promptul instruieste explicit modelul sa NU respinga metafore/
//     limbaj artistic si sa accepte cand e in dubiu (vezi server.js) — aici verificam ca un raspuns
//     "ok:true" de la model e propagat FARA nicio suprascriere locala, chiar pentru versuri cu
//     limbaj emotional intens (cazul tipic unde un filtru naiv ar respinge gresit).
// ===================================================================================================
test('checkLyricsSemanticCoherence: versuri cu limbaj emotional intens/metaforic, AI raspunde ok:true -> ACCEPTAT fara nicio suprascriere locala', () => withApiKey(async () => {
  const fetchImpl = async () => anthropicResponse({ ok: true, issues: [] });
  const result = await checkLyricsSemanticCoherence(
    baseOrder({ occasion: 'dor' }),
    {},
    'Mi s-a rupt inima cand ai plecat, mor de dor dupa tine in fiecare zi.',
    fetchImpl
  );
  assert.deepEqual(result, { ok: true, reasons: [] });
}));

// ===================================================================================================
// 13) Promptul instruieste explicit modelul sa NU respinga metafore/limbaj artistic (verificare
//     textuala directa a instructiunii trimise catre AI, nu doar a comportamentului function-ului).
// ===================================================================================================
test('checkLyricsSemanticCoherence: promptul trimis catre AI instruieste explicit sa NU respinga metafore/limbaj poetic', () => withApiKey(async () => {
  let capturedBody = null;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return anthropicResponse({ ok: true, issues: [] });
  };
  await checkLyricsSemanticCoherence(baseOrder(), {}, 'Versuri.', fetchImpl);
  const promptText = capturedBody.messages[0].content;
  assert.match(promptText, /DO NOT flag:.*metaphors/i);
  assert.match(promptText, /When in doubt, ACCEPT/i);
}));
