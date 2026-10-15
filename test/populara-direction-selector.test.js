// MUZICA POPULARA (2026-10-13) — directie UNICA aprobata ("sentimentala", customMode:true).
//
// O a doua directie "vesela si ritmata", cu selectie automata dupa ocazie/poveste, a fost
// investigata si testata pe parcursul mai multor runde (chiuituri literale in versuri, persona
// audio, control numeric de tempo) dar NU a fost aprobata dupa ascultare repetata — clientul a
// cerut explicit eliminarea completa a acelui mecanism (resolvePopularaDirection,
// injectPopularaChiuituri, POPULARA_RITMATA_*). Acest fisier acopera STRICT ce a ramas:
// buildPopularaLyricsPrompt() (buget STRICT 200 caractere, verificat direct impotriva API-ului
// real — SunoAPI respinge orice peste 200 cu HTTP 400) si forma requestInput intoarsa de
// buildPopularaCustomRequest() (prin mock-uirea fetchWithTimeout — niciun apel real de retea).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8').replace(/\r\n/g, '\n');
}
const server = read('server.js');

function sliceFunction(src, fnSignature, fromIdx) {
  const start = src.indexOf(fnSignature, fromIdx || 0);
  assert.ok(start !== -1, `nu am gasit "${fnSignature}"`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function loadModule() {
  const startIdx = server.indexOf('// MUZICA POPULARA (2026-10-13): directie unica APROBATA');
  assert.ok(startIdx !== -1, 'nu am gasit blocul MUZICA POPULARA');
  const endIdx = server.indexOf('async function callMusicProvider(orderId, requestInput, genre, voicePreference) {');
  assert.ok(endIdx !== -1 && endIdx > startIdx);
  const snippet = server.slice(startIdx, endIdx);

  const composeSongTitleSnippet = sliceFunction(server, 'function composeSongTitle(order) {');
  const resolveTitleCategorySnippet = sliceFunction(server, 'function resolveTitleCategory(order) {');
  const hashFnSnippet = sliceFunction(server, 'function hashStringToIndex(str, mod) {');
  const titleTemplatesStart = server.indexOf('const TITLE_TEMPLATES = {');
  const titleTemplatesEnd = server.indexOf('\n};', titleTemplatesStart) + 3;
  const titleTemplatesSnippet = server.slice(titleTemplatesStart, titleTemplatesEnd);
  const parentRoleStart = server.indexOf('const PARENT_ROLE_OCCASION_INSTRUCTIONS = {');
  const parentRoleEnd = server.indexOf('\n};', parentRoleStart) + 3;
  const parentRoleSnippet = server.slice(parentRoleStart, parentRoleEnd);
  const wedNoncoupleStart = server.indexOf('const WEDDING_NONCOUPLE_ROLES = [');
  const wedNoncoupleEnd = server.indexOf(';', wedNoncoupleStart) + 1;
  const wedNoncoupleSnippet = server.slice(wedNoncoupleStart, wedNoncoupleEnd);
  const truncateSafelySnippet = sliceFunction(server, 'function truncateSafely(str, maxLen) {');
  const lyricsLangStart = server.indexOf('const LYRICS_LANGUAGE_NAMES = {');
  const lyricsLangEnd = server.indexOf('\n};', lyricsLangStart) + 3;
  const lyricsLangSnippet = server.slice(lyricsLangStart, lyricsLangEnd);
  const occasionLabelsStart = server.indexOf('const OCCASION_LABELS = {');
  const occasionLabelsEnd = server.indexOf('\n};', occasionLabelsStart) + 3;
  const occasionLabelsSnippet = server.slice(occasionLabelsStart, occasionLabelsEnd);

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const DOMAIN = 'https://naluna.test';
    ${lyricsLangSnippet}
    ${occasionLabelsSnippet}
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    let __fetchImpl = null;
    function fetchWithTimeout(url, options, timeoutMs) { return __fetchImpl(url, options, timeoutMs); }
    function perfLog() {}
    ${truncateSafelySnippet}
    ${wedNoncoupleSnippet}
    ${hashFnSnippet}
    ${titleTemplatesSnippet}
    ${parentRoleSnippet}
    ${resolveTitleCategorySnippet}
    ${composeSongTitleSnippet}
    ${snippet}
    return {
      buildPopularaLyricsPrompt, requestPopularaLyrics, buildPopularaCustomRequest,
      POPULARA_SENTIMENTALA_STYLE, POPULARA_SENTIMENTALA_NEGATIVE_TAGS,
      setFetchImpl: (fn) => { __fetchImpl = fn; }
    };
  `;
  return new Function('require', sandboxSrc)(require);
}

const mod = loadModule();

function baseOrder(overrides) {
  return Object.assign({
    lang: 'ro', occasion: 'declaratie', recipient: 'Maria', senderName: 'Andrei',
    relationship: 'sotie', genre: 'populara', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum multi ani si suntem impreuna de atunci.'
  }, overrides);
}

// ===================================================================================================
// 1) Stilul aprobat (V3 sentimentala): fara nume de artist, fara cuvinte de doliu/colind,
//    caracteristici corecte. NU modifica fara aprobare explicita noua.
// ===================================================================================================
test('POPULARA_SENTIMENTALA_STYLE: fara nume de artist, fara colind/doliu, caracter acustic/expresiv', () => {
  const style = mod.POPULARA_SENTIMENTALA_STYLE;
  assert.ok(!/cuciuc|clejani|vicoveanca|berbec|paladi|botosani|lautarii|lavric/i.test(style));
  assert.ok(!/christmas|carol|funeral|mourning|grief/i.test(style));
  assert.match(style, /violin/i);
  assert.match(style, /never robotic/i);
});
test('POPULARA_SENTIMENTALA_NEGATIVE_TAGS exclude explicit autotune/voce robotica/sintetizator', () => {
  assert.match(mod.POPULARA_SENTIMENTALA_NEGATIVE_TAGS, /autotune/i);
  assert.match(mod.POPULARA_SENTIMENTALA_NEGATIVE_TAGS, /robotic vocal/i);
  assert.match(mod.POPULARA_SENTIMENTALA_NEGATIVE_TAGS, /synthetic vocal/i);
});

// ===================================================================================================
// 2) buildPopularaLyricsPrompt: buget STRICT <= 200 caractere (verificat direct impotriva
//    API-ului real — orice peste 200 e respins cu HTTP 400), inclusiv worst-case (nume+poveste
//    foarte lungi, toate cele 8 limbi).
// ===================================================================================================
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
for (const lang of LANGS) {
  test(`buildPopularaLyricsPrompt [${lang}]: worst-case (nume+poveste foarte lungi) ramane <= 200 caractere`, () => {
    const order = baseOrder({
      lang, recipient: 'Alexandra-Gabriela-Theodorescu-Popescu',
      story: 'O poveste foarte lunga, cu multe detalii importante despre viata noastra impreuna, toate momentele frumoase si grele prin care am trecut de-a lungul anilor petrecuti unul langa celalalt.'
    });
    const prompt = mod.buildPopularaLyricsPrompt(order);
    assert.ok(Array.from(prompt).length <= 200, `lungime: ${Array.from(prompt).length}: ${prompt}`);
  });
}
test('buildPopularaLyricsPrompt: poveste/nume complet absente nu arunca, ramane <= 200', () => {
  const order = baseOrder({ recipient: '', story: '' });
  assert.doesNotThrow(() => mod.buildPopularaLyricsPrompt(order));
  assert.ok(Array.from(mod.buildPopularaLyricsPrompt(order)).length <= 200);
});

// ===================================================================================================
// 3) buildPopularaCustomRequest: forma intoarsa (lyrics/style/title/negativeTags/vocalGender),
//    folosind un fetchWithTimeout MOCK — niciun apel real de retea. Directie UNICA — sentimentala,
//    indiferent de ocazie/poveste/selfTheme (fara ramificare, fara chiuituri injectate).
// ===================================================================================================
function mockFetchSequence(lyricsApiResponses) {
  let call = 0;
  return async (url) => {
    const step = lyricsApiResponses[Math.min(call, lyricsApiResponses.length - 1)];
    call++;
    return { ok: true, json: async () => step };
  };
}

test('buildPopularaCustomRequest: returneaza STRICT {lyrics, style, title, negativeTags} = directia sentimentala, indiferent de ocazie', async () => {
  mod.setFetchImpl(mockFetchSequence([
    { code: 200, data: { taskId: 'abc123' } },
    { code: 200, data: { response: { data: [{ text: '[Verse 1]\nVersuri de test\n[Chorus]\nRefren de test' }] } } }
  ]));
  const order = baseOrder({ occasion: 'aniversare', story: 'Implinesti 30 de ani!' });
  const result = await mod.buildPopularaCustomRequest('order-1', order);
  // Versurile raman EXACT cele primite de la /api/v1/lyrics — nicio injectie/alterare.
  assert.equal(result.lyrics, '[Verse 1]\nVersuri de test\n[Chorus]\nRefren de test');
  assert.equal(result.style, mod.POPULARA_SENTIMENTALA_STYLE);
  assert.equal(result.negativeTags, mod.POPULARA_SENTIMENTALA_NEGATIVE_TAGS);
  assert.ok(result.title);
});

test('buildPopularaCustomRequest: directia sentimentala ramane aceeasi si pentru ocazie "dor" (fara ramificare de directie)', async () => {
  mod.setFetchImpl(mockFetchSequence([
    { code: 200, data: { taskId: 'abc123' } },
    { code: 200, data: { response: { data: [{ text: 'versuri de dor' }] } } }
  ]));
  const result = await mod.buildPopularaCustomRequest('order-dor', baseOrder({ occasion: 'dor', story: 'Mi-e dor de tine.' }));
  assert.equal(result.style, mod.POPULARA_SENTIMENTALA_STYLE);
  assert.equal(result.negativeTags, mod.POPULARA_SENTIMENTALA_NEGATIVE_TAGS);
});

test('buildPopularaCustomRequest: NU adauga styleWeight/weirdnessConstraint/variety (mecanism ritmata eliminat complet)', async () => {
  mod.setFetchImpl(mockFetchSequence([
    { code: 200, data: { taskId: 'abc123' } },
    { code: 200, data: { response: { data: [{ text: 'versuri' }] } } }
  ]));
  const result = await mod.buildPopularaCustomRequest('order-2', baseOrder());
  assert.equal(result.styleWeight, undefined);
  assert.equal(result.weirdnessConstraint, undefined);
  assert.equal(result.variety, undefined);
});

test('buildPopularaCustomRequest: vocalGender "f"/"m" pentru female/male, absent pentru duet/auto', async () => {
  const freshLyricsMock = () => mockFetchSequence([
    { code: 200, data: { taskId: 'abc123' } },
    { code: 200, data: { response: { data: [{ text: 'versuri' }] } } }
  ]);
  mod.setFetchImpl(freshLyricsMock());
  const female = await mod.buildPopularaCustomRequest('o1', baseOrder({ voicePreference: 'female' }));
  assert.equal(female.vocalGender, 'f');
  mod.setFetchImpl(freshLyricsMock());
  const male = await mod.buildPopularaCustomRequest('o2', baseOrder({ voicePreference: 'male' }));
  assert.equal(male.vocalGender, 'm');
  mod.setFetchImpl(freshLyricsMock());
  const duet = await mod.buildPopularaCustomRequest('o3', baseOrder({ voicePreference: 'duet' }));
  assert.equal(duet.vocalGender, undefined);
});

test('requestPopularaLyrics: arunca o eroare clara la HTTP non-ok (fail LOUD, nu silentios)', async () => {
  mod.setFetchImpl(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await assert.rejects(() => mod.requestPopularaLyrics('o1', baseOrder()));
});

test('requestPopularaLyrics: arunca eroare clara daca raspunsul nu contine taskId', async () => {
  mod.setFetchImpl(async () => ({ ok: true, json: async () => ({ code: 200, data: {} }) }));
  await assert.rejects(() => mod.requestPopularaLyrics('o1', baseOrder()));
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
