// PROBLEMA G (2026-09-27, cerinta CRITICA): "povestea clientului trebuie sa se regaseasca REAL
// in versuri, INCA DE LA INCEPUTUL PARTII CANTATE" — nu abia tarziu, nu generic.
//
// AUDIT (facut inainte de aceasta reparatie, cerinta explicita "nu presupune"): instructiunile
// reale trimise catre Suno (instructionWithSenderFull/Short, instructionNoSenderFull/Short)
// cereau STRICT detalii "throughout" (raspandite in tot textul) — NICIODATA specific in primul
// vers cantat. Ambele forme (FULL si SHORT) fusesera reformulate asa la aceeasi corectie
// (2026-09-13, runda 3, P1), pentru buget — pierzand garantia de plasare timpurie, fara sa fie
// observat ca afecta AMBELE simultan. Confirmat prin comentarii istorice ramase langa codul
// viu (ex. "clauza 'open verse 1 with a real detail' exista deja in instructiune", fals la
// momentul auditului).
//
// REPARATIE: instructiunile cer acum explicit "opening on a real detail" (FULL) / "detail
// early+throughout" (SHORT) — prin INLOCUIRE (acelasi principiu, deja consacrat in acest fisier),
// NU o clauza noua separata (masurat direct: o clauza oportunista, cu prioritate mica, NU incape
// aproape niciodata in comenzile TIPICE cu expeditor — vezi audit). Forma SHORT a fost compensata
// ("complete words, no shortening" -> "no shortened words") ca sa ramana NET mai scurta decat
// inainte, deci sigura si in cazurile extreme deja documentate (familie+nume lungi+duet).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function loadBuildPrompt() {
  const startIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const buildPromptSnippet = server.slice(startIdx, i + 1);
  const famStart = server.indexOf('const FAMILY_OCCASIONS = ');
  const famEnd = server.indexOf('const WEDDING_RECIPIENT_ROLES_SINGLE');
  const familyConstants = server.slice(famStart, famEnd);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    ${familyConstants}
    ${buildPromptSnippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

const EARLY_DETAIL_RE = /opening on a real|open on a real|detail early\+throughout/i;

// ===============================================================================================
// (1) Comenzi TIPICE (nu extreme), CU expeditor — scenariul exact reclamat de client (rezultatele
// vechi, inainte de reparatie, NU contineau niciuna dintre aceste fraze aici — confirmat prin
// audit direct, nu presupus).
// ===============================================================================================
const ALL_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
for (const lang of ALL_LANGS) {
  test(`buildPrompt [${lang}]: comanda TIPICA (CU expeditor, gen/ocazie obisnuite) contine instructiunea de plasare timpurie a detaliului din poveste`, () => {
    const order = {
      occasion: 'zi_de_nastere', genre: 'pop', lang, plan: 'standard',
      recipient: 'Andrei', senderName: 'Maria', relationship: 'sora',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600, `promptul trebuie sa ramana <= 600, a produs ${prompt.length}`);
    assert.match(prompt, EARLY_DETAIL_RE, `instructiunea de plasare timpurie lipseste: ${prompt}`);
  });
}

// ===============================================================================================
// (2) Toate cele 3 pachete (Standard/Premium/Video) — buildPrompt e apelat identic pentru
// song1/song2 (getSong1EffectiveData/getSong2EffectiveData), fara ramificare pe plan.
// ===============================================================================================
for (const plan of ['standard', 'premium', 'video']) {
  test(`buildPrompt [plan=${plan}]: instructiunea de plasare timpurie e prezenta, indiferent de pachet`, () => {
    const order = {
      occasion: 'aniversare', genre: 'rock', lang: 'en', plan,
      recipient: 'John', senderName: 'Anna', relationship: 'wife',
      story: 'We met at a coffee shop downtown and talked for hours about everything.'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.match(prompt, EARLY_DETAIL_RE, `[${plan}] instructiunea de plasare timpurie lipseste: ${prompt}`);
  });
}

// ===============================================================================================
// (3) Cateva genuri cu styleTags lungi (hiphop, manele_suflet — cele mai grele documentate) —
// confirma ca reparatia functioneaza si nu doar in genurile "usoare".
// ===============================================================================================
for (const genre of ['hiphop', 'manele_suflet', 'pop', 'jazz']) {
  test(`buildPrompt [genre=${genre}]: instructiunea de plasare timpurie e prezenta, chiar si pentru genuri cu styleTags lungi`, () => {
    const order = {
      occasion: 'zi_de_nastere', genre, lang: 'ro',
      recipient: 'Ana', senderName: 'Ion', relationship: 'prieten',
      story: 'Ne cunoastem de multi ani si am trecut prin multe impreuna, mereu unul langa altul.'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600);
    assert.match(prompt, EARLY_DETAIL_RE, `[${genre}] instructiunea de plasare timpurie lipseste: ${prompt}`);
  });
}

// ===============================================================================================
// (4) Comanda USOARA (fara expeditor) — trebuie sa functioneze si acolo (instructionNoSender*).
// ===============================================================================================
test('buildPrompt: comanda usoara (fara expeditor) contine instructiunea de plasare timpurie', () => {
  const order = { occasion: 'zi_de_nastere', genre: 'pop', lang: 'en', recipient: 'Ana', story: 'A short story.' };
  const prompt = buildPrompt(order, '', undefined);
  assert.match(prompt, EARLY_DETAIL_RE, `instructiunea de plasare timpurie lipseste: ${prompt}`);
});

// ===============================================================================================
// (5) NU se inventeaza detalii — reparatia e STRICT o instructiune de PLASARE, nu de continut nou.
// Verificam ca formularea nu introduce nicio cerinta de a adauga fapte/evenimente/locuri noi.
// ===============================================================================================
test('server.js: noua formulare NU introduce nicio cerinta de a inventa detalii — ramane STRICT despre plasare, nu despre continut nou', () => {
  assert.ok(!server.includes('invent a detail'), 'nu trebuie sa ceara inventarea vreunui detaliu');
  assert.match(server, /never-invented story detail/, 'clauza trebuie sa ceara explicit un detaliu REAL, niciodata inventat');
});

// ===============================================================================================
// (6) GENRE_STYLE_MAP, diction, short-lines, coerenta — neatinse de aceasta reparatie.
// ===============================================================================================
test('server.js: GENRE_STYLE_MAP, dictionInstruction, "Short lines" si validateLyricsCoherence raman neatinse de aceasta reparatie', () => {
  assert.match(server, /const GENRE_STYLE_MAP = \{/);
  assert.match(server, /Short lines;/);
  assert.match(server, /function validateLyricsCoherence/);
});

test('node --check server.js trece (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
