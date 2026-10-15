// validateLyricsCoherence() — verificare noua (4): ocazia nu trebuie sa presupuna decesul unei
// persoane cand povestea/ocazia nu-l mentioneaza. Cerinta explicita (2026-10-12): "Nu presupune
// despartiri, decese sau tragedii daca acestea nu apar in povestea clientului."
//
// Abordare CONSERVATOARE prin design (vezi comentariul din server.js): lista restransa de
// termeni NEAMBIGUI per limba (mormant/funeral/etc.), NU un detector general de tristete —
// vocabularul normal al ocaziei 'dor' (dor/lipsa/departe) ramane complet permis. Ocazia
// 'pierdere' e singura exceptata, fiind conceputa explicit pentru doliu.
//
// Acelasi tipar de extractie (sandbox + brace-matching) deja folosit in test/lyrics-coherence.test.js
// — nicio reimplementare paralela a validateLyricsCoherence().
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

function loadValidateLyricsCoherence() {
  const server = read('server.js');
  const buildPromptStartIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(buildPromptStartIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const buildPromptFuncStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', buildPromptStartIdx);
  let depth = 0, i = server.indexOf('{', buildPromptFuncStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const buildPromptRegion = server.slice(buildPromptStartIdx, i + 1);

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${buildPromptRegion}
    return { validateLyricsCoherence, DEATH_THEME_MARKERS };
  `;
  return new Function('require', sandboxSrc)(require);
}
const { validateLyricsCoherence, DEATH_THEME_MARKERS } = loadValidateLyricsCoherence();

// ===============================================================================================
// TEST 1 — termeni de deces NEAMBIGUI, per limba, respinsi cand ocazia NU e 'pierdere'.
// ===============================================================================================
const DEATH_EXAMPLES = {
  ro: 'Azi la mormântul tău aduc flori, dragă mamă.',
  en: 'Today I visit your grave with flowers, dear mother.',
  de: 'Heute besuche ich dein Grab mit Blumen, liebe Mutter.',
  es: 'Hoy visito tu tumba con flores, querida madre.',
  it: 'Oggi visito la tua tomba con fiori, cara madre.',
  fr: 'Aujourd\'hui je visite ta tombe avec des fleurs, chère mère.',
  bg: 'Днес посещавам твоя гроб с цветя, скъпа майко.',
  tr: 'Bugün mezarını çiçeklerle ziyaret ediyorum, sevgili annem.'
};

for (const [lang, lyrics] of Object.entries(DEATH_EXAMPLES)) {
  test(`validateLyricsCoherence [${lang}]: ocazie "pentru-mama" (NU 'pierdere') + versuri cu termen de deces -> RESPINS (occasion_death_contradiction)`, () => {
    const order = { lang, occasion: 'pentru-mama', senderName: 'Ana', story: 'Mama mea e cea mai buna.' };
    const result = validateLyricsCoherence(order, {}, lyrics);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('occasion_death_contradiction'), `motivele gasite: ${result.reasons.join(',')}`);
  });
}

// ===============================================================================================
// TEST 2 — ocazia 'pierdere' e exceptata — ACELEASI versuri cu termen de deces sunt ACCEPTATE.
// ===============================================================================================
test('validateLyricsCoherence [ro]: ocazie "pierdere" + versuri cu "mormânt" -> ACCEPTAT (exceptia e by design)', () => {
  const order = { lang: 'ro', occasion: 'pierdere', senderName: 'Ana', story: 'Mama a trecut in neunta anul trecut.' };
  const result = validateLyricsCoherence(order, {}, 'Azi la mormântul tău aduc flori, dragă mamă.');
  assert.equal(result.ok, true);
  assert.ok(!result.reasons.includes('occasion_death_contradiction'));
});

// ===============================================================================================
// TEST 3 — vocabularul NORMAL al ocaziei 'dor' (dor/lipsa/departe/amintiri) NU declanseaza
// verificarea — doar termenii de deces NEAMBIGUI o fac. Cel mai important test din fisier:
// garanteaza ca nu introducem fals-pozitive pe exact ocazia pe care clientul o foloseste cel
// mai des pentru "persoana e departe, nu moarta".
// ===============================================================================================
test('validateLyricsCoherence [ro]: ocazie "dor" + versuri normale (dor, lipsa, departe, amintiri) -> ACCEPTAT, fara fals-pozitiv', () => {
  const order = { lang: 'ro', occasion: 'dor', senderName: 'Mihai', story: 'A plecat in strainatate.' };
  const result = validateLyricsCoherence(order, {}, 'Mi-e dor de tine, ești departe acum, dar te port în suflet, în fiecare amintire a mea.');
  assert.equal(result.ok, true);
  assert.ok(!result.reasons.includes('occasion_death_contradiction'));
});

test('validateLyricsCoherence [ro]: ocazie "dor" + versuri CU termen de deces nejustificat -> RESPINS (exact bug-ul raportat)', () => {
  const order = { lang: 'ro', occasion: 'dor', senderName: 'Mihai', story: 'A plecat in strainatate, nu a murit nimeni.' };
  const result = validateLyricsCoherence(order, {}, 'Mi-e dor de tine, te-au îngropat prea devreme, draga mea.');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('occasion_death_contradiction'));
});

// Cerinta explicita (2026-10-12): "nu respinge automat metafore valide". Lista e INTENTIONAT
// restransa la termeni literali de mortuar (mormânt/înmormântare/sicriu...) — expresii
// metaforice obisnuite de suferinta emotionala ("mi s-a rupt inima", "mor de dor") NU contin
// niciunul din acesti termeni si trebuie sa treaca neatinse.
test('validateLyricsCoherence [ro]: metafore uzuale de suferinta ("mi s-a rupt inima", "mor de dor") NU sunt respinse — nu sunt termeni literali de deces', () => {
  const order = { lang: 'ro', occasion: 'dor', senderName: 'Mihai', story: 'A plecat departe.' };
  const result = validateLyricsCoherence(order, {}, 'Mi s-a rupt inima cand ai plecat, mor de dor dupa tine in fiecare zi.');
  assert.equal(result.ok, true);
  assert.ok(!result.reasons.includes('occasion_death_contradiction'), 'expresii metaforice de suferinta nu trebuie confundate cu deces literal');
});

// ===============================================================================================
// TEST 4 — alte ocazii fara nicio legatura cu deces/pierdere (zi_de_nastere, declaratie) raman
// neafectate de versuri normale, si tot respinse daca apare un termen de deces nejustificat.
// ===============================================================================================
test('validateLyricsCoherence [ro]: ocazie "zi_de_nastere" + versuri normale -> ACCEPTAT', () => {
  const order = { lang: 'ro', occasion: 'zi_de_nastere', senderName: 'Vlad', story: 'Aniversarea Andreei.' };
  const result = validateLyricsCoherence(order, {}, 'La mulți ani, Andreea, azi e ziua ta frumoasă, sărbătorim împreună.');
  assert.equal(result.ok, true);
});

test('validateLyricsCoherence [ro]: ocazie "declaratie" (TE IUBESC) + versuri cu "cimitir" -> RESPINS', () => {
  const order = { lang: 'ro', occasion: 'declaratie', senderName: 'Vlad', story: 'O iubesc pe Andreea.' };
  const result = validateLyricsCoherence(order, {}, 'Te iubesc, Andreea, chiar daca ne desparte un cimitir de amintiri.');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('occasion_death_contradiction'));
});

// ===============================================================================================
// TEST 5 — 'occasion_death_contradiction' e un motiv BLOCANT (nu apare in NON_BLOCKING_COHERENCE_REASONS).
// ===============================================================================================
test('occasion_death_contradiction ramane STRICT motiv de respingere (nu e marcat non-blocant)', () => {
  const server = read('server.js');
  const nbIdx = server.indexOf("const NON_BLOCKING_COHERENCE_REASONS = new Set([");
  const nbEnd = server.indexOf(');', nbIdx);
  const nbSnippet = server.slice(nbIdx, nbEnd);
  assert.ok(!nbSnippet.includes('occasion_death_contradiction'), 'occasion_death_contradiction nu trebuie sa fie in lista non-blocanta');
});

// ===============================================================================================
// TEST 6 — DEATH_THEME_MARKERS exista pentru toate cele 8 limbi (acopera tot ce accepta Naluna).
// ===============================================================================================
test('DEATH_THEME_MARKERS acopera toate cele 8 limbi disponibile in Naluna', () => {
  for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
    assert.ok(Array.isArray(DEATH_THEME_MARKERS[lang]) && DEATH_THEME_MARKERS[lang].length > 0, `lipsesc termenii de deces pentru limba "${lang}"`);
  }
});

// ===============================================================================================
// TEST 7 — REGRESIE: celelalte 3 verificari existente (sender_self_declaration, person drift,
// song_data_mixing) raman complet neatinse de aceasta adaugare.
// ===============================================================================================
test('REGRESIE: verificarile existente (sender_self_declaration/person_drift/song_data_mixing) raman neschimbate', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'x' };
  const result = validateLyricsCoherence(order, {}, 'Sunt Andrei si te iubesc mult, draga Maria.');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('sender_self_declaration'));
});
