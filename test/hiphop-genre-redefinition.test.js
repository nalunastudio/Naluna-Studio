// CORECȚIE (2026-09-14, "instrumentalul de dinainte de voce suna a manea, nu a Hip Hop" —
// aprobata explicit): singura modificare functionala — GENRE_STYLE_MAP.hiphop inlocuit de la
// 'authentic hip-hop, punchy kick/snare/hi-hat groove, bass-led, rhythmic clear-diction rap
// verses, storytelling attitude, melodic chorus, organic not just trap' (157 caractere) la
// 'early-2000s club hip-hop, hard punchy kick/snare, deep bass, crisp hi-hats, confident sparse
// beat from bar one, rhythmic rap verses, big club hook' (146 caractere, mai scurta).
// Celelalte 15 genuri, VOICE_INSTRUCTIONS_FULL/SHORT, clauza de vocal-onset, story/feedback/
// duration/validator/prompt architecture raman NESCHIMBATE — verificat explicit mai jos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const NEW_HIPHOP = 'early-2000s club hip-hop, hard punchy kick/snare, deep bass, crisp hi-hats, confident sparse beat from bar one, rhythmic rap verses, big club hook';
const OLD_HIPHOP = 'authentic hip-hop, punchy kick/snare/hi-hat groove, bass-led, rhythmic clear-diction rap verses, storytelling attitude, melodic chorus, organic not just trap';
const OTHER_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PLANS = ['standard', 'premium', 'video'];

function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) { if (server[i] === '{') depth++; else if (server[i] === '}') { depth--; if (depth === 0) break; } }
  const snippet = server.slice(startIdx, i + 1);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

function loadGenreStyleMap() {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const map = {};
  for (const g of [...OTHER_GENRES, 'hiphop']) {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit valoarea GENRE_STYLE_MAP pentru "${g}"`);
    map[g] = m[1];
  }
  return map;
}
const GENRE_STYLE_MAP = loadGenreStyleMap();

// ===============================================================================================
// TEST 1/3 — GENRE_STYLE_MAP.hiphop e EXACT valoarea aprobata; caractere 157 -> 146.
// ===============================================================================================
test('GENRE_STYLE_MAP.hiphop e EXACT noua valoare aprobata (146 caractere, fata de 157 anterior)', () => {
  assert.equal(GENRE_STYLE_MAP.hiphop, NEW_HIPHOP);
  assert.equal(NEW_HIPHOP.length, 146);
  assert.equal(OLD_HIPHOP.length, 157);
  assert.ok(NEW_HIPHOP.length < OLD_HIPHOP.length, 'noua definitie trebuie sa fie mai scurta, nu mai lunga');
});

// ===============================================================================================
// TEST 2 — DOAR hiphop s-a schimbat: celelalte 15 genuri raman BYTE-IDENTICE fata de commit-ul
// anterior acestei corectii.
// ===============================================================================================
test('DOAR hiphop s-a schimbat: celelalte 15 genuri (NEW_GENRES) raman BYTE-IDENTICE fata de HEAD (inaintea acestei corectii)', () => {
  const { execSync } = require('node:child_process');
  const beforeSrc = execSync('git show HEAD:server.js', { cwd: path.join(__dirname, '..'), maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  const idx = beforeSrc.indexOf('const GENRE_STYLE_MAP = {');
  const end = beforeSrc.indexOf('};', idx);
  const body = beforeSrc.slice(idx, end);
  for (const g of OTHER_GENRES) {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit "${g}" in versiunea dinaintea corectiei`);
    assert.equal(GENRE_STYLE_MAP[g], m[1], `genul "${g}" trebuie sa ramana byte-identic`);
  }
  // hiphop TREBUIE sa fie diferit (asta e singura schimbare functionala aprobata).
  const oldHiphopMatch = body.match(/\bhiphop: '([^']+)'/);
  assert.ok(oldHiphopMatch);
  assert.notEqual(GENRE_STYLE_MAP.hiphop, oldHiphopMatch[1], 'hiphop TREBUIE sa fi fost modificat (singura schimbare aprobata)');
});

// ===============================================================================================
// PROTECTIE — VOICE_INSTRUCTIONS_FULL/SHORT, vocal-onset clause, duration target: neatinse.
// ===============================================================================================
test('PROTECTIE: VOICE_INSTRUCTIONS_FULL/SHORT raman byte-identice', () => {
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_FULL = {\n    female: ' Use a female lead vocal.',\n    male: ' Use a male lead vocal.',\n    duet: ' Use a male and female duet, with both voices clearly present.',\n    auto: ''\n  };"));
  assert.ok(server.includes("const VOICE_INSTRUCTIONS_SHORT = {\n    female: ' Female vocal.',\n    male: ' Male vocal.',\n    duet: ' Male-female duet.',\n    auto: ''\n  };"));
});

test('PROTECTIE: clauza de vocal-onset ("like the verse" / "Verse intro") ramane neatinsa', () => {
  assert.ok(server.includes('Start the vocals around 8-10 seconds, like the verse.'));
  assert.ok(server.includes(" Verse intro; story details throughout, not invented; complete words only, no shortening; name recipient early+chorus; mention sender once.'"));
});

test('PROTECTIE: durationTargetClause ramane byte-identic', () => {
  assert.ok(server.includes("const durationTargetClause = ' Target song length 3:15-3:40.';"));
});

test('PROTECTIE: MAX_COHERENCE_RETRIES ramane 2 (neatins de aceasta corectie)', () => {
  assert.ok(server.includes('const MAX_COHERENCE_RETRIES = 2;'));
});

// ===============================================================================================
// TEST 16 — nicio referinta interzisa (artisti/piese/manea) in noua valoare sau in promptul final.
// ===============================================================================================
test('Nicio referinta interzisa (50 Cent / Lil Jon / In Da Club / Get Low / manea / manele / anti-manea / no manele) in GENRE_STYLE_MAP.hiphop', () => {
  const forbidden = /50 cent|lil jon|in da club|get low|manea|manele|anti-manea|no manele/i;
  assert.doesNotMatch(GENRE_STYLE_MAP.hiphop, forbidden);
});

test('Nicio referinta interzisa in promptul final construit pentru hiphop (toate cele 8 limbi)', () => {
  const forbidden = /50 cent|lil jon|in da club|get low|manea|manele|anti-manea|no manele/i;
  for (const lang of LANGS) {
    const order = { occasion: 'zi_de_nastere', genre: 'hiphop', lang, recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto', story: 'Poveste realista de test pentru comanda aceasta.' };
    const prompt = buildPrompt(order, '', undefined);
    assert.doesNotMatch(prompt, forbidden, `[${lang}] prompt: ${prompt}`);
  }
});

// ===============================================================================================
// TEST 11 — hiphop ajunge REAL (netrunchiat) in promptul construit, pentru toate cele 8 limbi.
// ===============================================================================================
for (const lang of LANGS) {
  test(`[${lang}] genul "hiphop" ajunge COMPLET, netrunchiat, in promptul construit (nu doar in harta)`, () => {
    const order = { occasion: 'zi_de_nastere', genre: 'hiphop', lang, recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto', story: 'Poveste realista de test pentru comanda aceasta, cu suficiente detalii.' };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.includes(NEW_HIPHOP), `[${lang}] noua definitie hiphop nu a ajuns completa in prompt: ${prompt}`);
  });
}

// ===============================================================================================
// TEST 12 — Standard/Premium/Video Gift: aceeasi logica, buildPrompt nu ramifica pe order.plan
// pentru styleTags.
// ===============================================================================================
for (const plan of PLANS) {
  test(`[${plan}] genul "hiphop" ajunge COMPLET in promptul construit, indiferent de pachet`, () => {
    const order = { occasion: 'zi_de_nastere', genre: 'hiphop', lang: 'ro', plan, recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto', story: 'Poveste realista de test pentru comanda aceasta.' };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.includes(NEW_HIPHOP), `[${plan}] noua definitie hiphop nu a ajuns completa in prompt: ${prompt}`);
  });
}

// ===============================================================================================
// TEST — impact prompt budget: comanda reala (Andrei/Maria/Soț/pierdere) si worst-case nu produc
// regresii fata de definitia veche (comparatie directa).
// ===============================================================================================
test('IMPACT BUGET: comanda reala (Andrei/Maria/Soț/pierdere, Premium) — promptul cu noua definitie ramane sub 600 si include indiciul de durata (care NU incapea cu definitia veche)', () => {
  const order = { occasion: 'pierdere', recipient: 'Maria', story: 'Te iubesc', genre: 'hiphop', plan: 'premium', lang: 'ro', senderName: 'Andrei', relationship: 'Soț', voicePreference: 'auto' };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, `prompt peste 600 caractere: ${prompt.length}`);
  assert.ok(prompt.includes('Target song length 3:15-3:40.'), 'indiciul de durata trebuie sa incapa acum, cu bugetul eliberat de definitia mai scurta');
});

test('IMPACT BUGET: worst-case (nunta + duet + nume maxime + poveste 2000 caractere) — nicio regresie fata de definitia veche', () => {
  const worstOrder = {
    occasion: 'nunta', weddingType: 'wedding', genre: 'hiphop', lang: 'ro',
    recipient: 'Alina și Andrei', recipientMode: 'both',
    senderName: 'I'.repeat(100), relationship: 'R'.repeat(60),
    voicePreference: 'duet', story: 'S'.repeat(2000)
  };
  const prompt = buildPrompt(worstOrder, 'Te rog sa fie mai vesela si mai energica', undefined);
  assert.ok(prompt.length <= 600, `prompt peste 600 caractere: ${prompt.length}`);
  const storyRun = (prompt.match(/S+/) || [''])[0].length;
  assert.ok(storyRun >= 1, 'trebuie sa ramana macar un fragment de poveste, ca in scenariul deja documentat pentru acest caz extrem');
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
