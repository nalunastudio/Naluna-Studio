// Test de regresie EXECUTABIL (nu doar text-matching) pentru CORECȚIA STRICTĂ (hotfix
// 2026-08-08, punctul 3): "Alina și Andrei" nu mai devine niciodata "Alina și A." in promptul
// trimis catre generatorul de versuri, INDIFERENT cat de strans e bugetul de 500 caractere.
// Extrage buildPrompt() (si tot ce ii e necesar) direct din server.js si il RULEAZA cu date
// sintetice de tip "cel mai rau caz" (poveste/relatie/expeditor la lungime maxima), exact
// scenariul care declanseaza cascada de scurtare unde bug-ul original ar fi aparut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// buildPrompt() e o functie PURA (nu atinge db/retea) — dependintele ei (SUNO_PROMPT_MAX_LEN,
// truncateSafely, OCCASION_LABELS, RELATION_NOUNS, SENDER_RELATION_NOUNS, OCCASION_INSTRUCTIONS,
// OCCASION_INSTRUCTION_FALLBACK, RECIPIENT_MAX_LEN, SENDER_MAX_LEN, RELATIONSHIP_MAX_LEN,
// STORY_MIN_RESERVE) sunt toate definite CONTIGUU intre SUNO_PROMPT_MAX_LEN si sfarsitul functiei
// — extrase textual si evaluate intr-un sandbox, fara sa importam server.js intreg (care ar porni
// serverul HTTP real si ar cere DATABASE_URL).
function loadBuildPrompt() {
  const server = read('server.js');
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
  // gaseste acolada de inchidere corespunzatoare, numarand echilibrat de la funcStart
  let depth = 0, i = server.indexOf('{', funcStart), bodyStart = i;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const funcEnd = i + 1;
  const snippet = server.slice(startIdx, funcEnd);
  const sandboxSrc = `
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function(sandboxSrc)();
}

const buildPrompt = loadBuildPrompt();

function worstCaseOrder(overrides) {
  return Object.assign({
    occasion: 'nunta',
    genre: 'manele', // una din cele mai lungi descrieri de stil
    lang: 'ro',
    senderName: 'I'.repeat(100),
    relationship: 'R'.repeat(60),
    voicePreference: 'duet',
    story: 'S'.repeat(2000) // forteaza cascada de scurtare sa se declanseze pana la capat
  }, overrides);
}

test('buildPrompt: "Amândoi" pastreaza AMBELE nume complete in prompt, chiar si sub bugetul cel mai strans (poveste/relatie/expeditor la maxim)', () => {
  const order = worstCaseOrder({
    recipient: 'Alina și Andrei',
    recipientMode: 'both',
    recipientNames: { name1: 'Alina', name2: 'Andrei' }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Alina și Andrei'), `promptul trebuie sa contina "Alina și Andrei" intreg, a produs: ${prompt.slice(0, 200)}`);
  assert.ok(!prompt.includes('Alina și A.'), 'al doilea nume NU trebuie redus la o initiala');
  assert.ok(!/Alina și A\b(?!ndrei)/.test(prompt), 'al doilea nume nu trebuie trunchiat in nicio forma');
});

test('buildPrompt: numele complete de 60 de caractere (maximul permis) raman intregi in prompt', () => {
  const name1 = 'A'.repeat(60);
  const name2 = 'B'.repeat(60);
  const order = worstCaseOrder({
    recipient: `${name1} și ${name2}`,
    recipientMode: 'both',
    recipientNames: { name1, name2 }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(name1), 'primul nume (60 caractere) trebuie sa apara intreg');
  assert.ok(prompt.includes(name2), 'al doilea nume (60 caractere) trebuie sa apara intreg');
});

test('buildPrompt: functioneaza identic pentru Fini si Nași (nu doar Miri) cu "Amândoi"', () => {
  ['Fina și Finul', 'Nașa și Nașul'].forEach(recipient => {
    const [name1, name2] = recipient.split(' și ');
    const order = worstCaseOrder({ recipient, recipientMode: 'both', recipientNames: { name1, name2 } });
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.includes(recipient), `promptul trebuie sa contina "${recipient}" intreg`);
  });
});

test('buildPrompt: nume cu spatii, cratima si diacritice raman EXACT neschimbate (nicio normalizare)', () => {
  const name1 = 'Ana-Maria Popescu';
  const name2 = 'Ștefan-Cristian Ionescu';
  const order = worstCaseOrder({
    recipient: `${name1} și ${name2}`,
    recipientMode: 'both',
    recipientNames: { name1, name2 }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(name1), 'numele cu cratima si spatiu trebuie pastrat exact');
  assert.ok(prompt.includes(name2), 'numele cu diacritice trebuie pastrat exact, fara normalizare');
});

test('buildPrompt: un rol individual de nunta (nu "Amândoi") ramane un nume normal, supus cascadei ca oricare altul (fara regresie)', () => {
  // Un nume normal, foarte lung (peste RECIPIENT_MAX_LEN=60), TREBUIE sa poata fi trunchiat in
  // continuare sub buget extrem — doar combo-ul "Amândoi" e protejat, nu orice recipient.
  const order = worstCaseOrder({
    recipient: 'M'.repeat(200),
    recipientMode: 'single',
    recipientNames: null
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, 'promptul trebuie sa ramana sub limita de 600 caractere pentru un nume individual, netprotejat');
  assert.ok(!prompt.includes('M'.repeat(200)), 'numele individual foarte lung (200 caractere) trebuie totusi trunchiat de cascada, spre deosebire de combo-ul protejat "Amândoi"');
});

// REVIZUIT (2026-08-13, runda "Amândoi" fara campuri duplicate): recipientNames (structura
// separata name1/name2) a devenit optionala si nu mai e colectata din formular — protectia
// "Amândoi" foloseste acum EXCLUSIV recipientMode === 'both' ca semnal, fara sa mai depinda
// de prezenta recipientNames.name1/name2 (care ar fi mereu null pentru comenzi noi).
test('server.js: protectia "Amândoi" foloseste EXCLUSIV recipientMode STRICT === "both" (nu doar occasion="nunta", nu mai depinde de recipientNames)', () => {
  const server = read('server.js');
  assert.ok(server.includes("const recipientIsProtectedCombo = order.recipientMode === 'both';"));
});

// CORECȚIE (2026-08-13, runda 6, "numele proprii sunt imuabile" — ex. real, raportat live:
// numele expeditorului "Alexandru" aparea in versuri ca "Alexandr"): protectia "niciodata
// trunchiat", care se aplica inainte DOAR la recipient in cazul "Amândoi" (combo), a fost extinsa
// la TOATE numele (recipient SI sender, in toate cazurile) — cascada de scurtare nu mai contine
// NICIUN pas care sa trunchieze `sender`/`recipient`, indiferent de recipientIsProtectedCombo.
test('server.js: cascada de scurtare NU mai contine niciun pas care sa trunchieze sender/recipient — numele proprii nu se trunchiaza NICIODATA, in niciun caz (nu doar combo protejat)', () => {
  const server = read('server.js');
  const idx = server.indexOf('const shrinkSteps = [');
  const end = server.indexOf('];', idx);
  const body = server.slice(idx, end);
  assert.ok(!/truncateSafely\(sender,/.test(body), 'niciun pas din cascada nu trebuie sa trunchieze sender');
  assert.ok(!/truncateSafely\(recipient,/.test(body), 'niciun pas din cascada nu trebuie sa trunchieze recipient');
  // relatia (text liber, NU nume propriu) ramane STRICT supusa cascadei, ca inainte.
  assert.ok(/truncateSafely\(relationship,/.test(body), 'relatia (text liber) trebuie sa ramana in cascada de scurtare');
});
