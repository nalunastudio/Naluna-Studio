// CORECȚIE (2026-09-25, investigatie separata — fals-pozitive validateLyricsCoherence() dupa
// manele_suflet "Short lines", comenzi reale f76baa46/bf03a964): AUDIT premergator (facut inainte
// de orice modificare) a gasit 4 motive posibile de respingere in validateLyricsCoherence():
//   - empty_lyrics                     — RAMANE blocant (versuri complet goale, defect real).
//   - explicit_message_person_drift    — RAMANE blocant (forma GRESITA prezenta LITERAL, ex. "te
//     iubim" cand expeditorul e singular — eroare gramaticala/logica NEAMBIGUA, verificabila direct
//     in text, indiferent de stilul de formulare).
//   - explicit_message_omitted         — NU mai blocheaza (era: NICIO forma prezenta literal =
//     respins). Absenta unei fraze EXACTE nu dovedeste ca mesajul a fost omis, doar ca a fost
//     reformulat cu alte cuvinte — imposibil de distins fara analiza semantica reala, mai ales cu
//     noua instructiune "Short lines" (manele_suflet), care incurajeaza EXPLICIT reformulari
//     concise. Cauza directa a comenzii reale f76baa46 (povestea continea "te iubesc" — confirmat
//     direct in baza de date — versurile respinse repetat, cu acelasi motiv, in toate cele 6
//     incercari ale ciclului initial de generare).
//   - sender_self_declaration          — ANALIZAT SEPARAT, RAMANE NESCHIMBAT (nicio corectie).
//     "Sunt"/"sono" sunt omografe gramaticale reale (persoana I singular "I am" SAU persoana a
//     III-a plural "they are"/existential "there are") — teoretic, riscul de fals-pozitiv exista.
//     O prima incercare de reparatie (cerinta de pozitie la inceputul propozitiei) A FOST RESPINSA
//     dupa testare directa: rupea un test EXISTENT, deliberat, pentru bug-ul REAL raportat ("Iar
//     aici Sunt Bunicului Andrei" — vezi test/lyrics-obtain-acceptable-variant.test.js). Spre
//     deosebire de explicit_message_omitted, NU exista dovezi DIRECTE (versurile respinse nu sunt
//     niciodata logate/salvate, prin design) ca respingerea reala de pe bf03a964 a fost un
//     fals-pozitiv — comanda s-a recuperat oricum normal, prin mecanismul de reincercare deja
//     existent. Un risc teoretic, neconfirmat, nu justifica sacrificarea unei protectii deja
//     demonstrate — vezi sectiunea 4 mai jos pentru documentarea explicita a acestei decizii.
//   - song_data_mixing                 — RAMANE blocant, neatins (nume-leak intre cele doua melodii
//     Premium — defect NEAMBIGUU, nu depinde de stilul de formulare).
//
// NU s-a atins: manele_suflet "Short lines" (ramane, vezi sectiunea 6 mai jos), manele_jale, orice
// alt gen, MAX_COHERENCE_RETRIES/obtainAcceptableVariant() (vezi test/lyrics-coherence-retry-budget-fix.test.js
// si test/lyrics-obtain-acceptable-variant.test.js), buildExactLyricsRequest() (customMode:true,
// versuri deja fixate), Stripe/checkout/plati/Meta Pixel/CAPI/GA4/consent/funnel/social
// publishing/Meta Ads Faza A/B.
//
// Nu logheaza si nu afiseaza povesti/versuri reale ale clientilor — toate fixture-urile de mai jos
// sunt exemple sintetice, construite STRICT pentru acest test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
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

// Acelasi tipar de extragere ca test/lyrics-coherence.test.js (sandbox fara Postgres real).
function loadModule() {
  const buildPromptStartIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(buildPromptStartIdx !== -1);
  const buildPromptFuncStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', buildPromptStartIdx);
  let depth = 0, i = server.indexOf('{', buildPromptFuncStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const buildPromptRegion = server.slice(buildPromptStartIdx, i + 1);
  const orderTracksByCoherenceSnippet = sliceFunction(server, 'function orderTracksByCoherence(tracks, order, recipientSnapshot) {');

  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${buildPromptRegion}
    ${orderTracksByCoherenceSnippet}
    return { buildPrompt, validateLyricsCoherence, orderTracksByCoherence, NON_BLOCKING_COHERENCE_REASONS };
  `;
  return new Function('require', sandboxSrc)(require);
}
const { buildPrompt, validateLyricsCoherence, orderTracksByCoherence, NON_BLOCKING_COHERENCE_REASONS } = loadModule();

// ===================================================================================================
// 1) Mesaj explicit REFORMULAT NATURAL — cauza directa a comenzii reale f76baa46. Povestea contine
//    "te iubesc", versurile exprima acelasi sentiment cu alte cuvinte -> NU mai e respins.
// ===================================================================================================
test('1) mesaj explicit reformulat natural (poveste "te iubesc", versuri "esti totul pentru mine", fara cele 2 cuvinte exacte) -> ACCEPTAT (nu mai e fals-pozitiv)', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'Draga mea Maria, te iubesc enorm, esti totul pentru mine.' };
  const lyrics = 'Draga mea Maria, esti totul pentru mine, lumina din viata mea.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, true, `versurile reformulate natural nu trebuie respinse, motive: ${JSON.stringify(result.reasons)}`);
  // semnalul ramane CALCULAT (pentru monitorizare in perfLog), doar nu mai blocheaza:
  assert.ok(result.reasons.includes('explicit_message_omitted'), 'semnalul trebuie sa ramana vizibil in reasons, pentru monitorizare');
});

// ===================================================================================================
// 2) Mesaj explicit PREZENT EXACT — comportament neschimbat, trebuie sa ramana ACCEPTAT (regresie
//    directa fata de test/lyrics-coherence.test.js).
// ===================================================================================================
test('2) mesaj explicit prezent EXACT ("te iubesc" literal in versuri) -> ACCEPTAT, fara niciun motiv de coerenta', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'Draga mea Maria, te iubesc enorm, esti totul pentru mine.' };
  const lyrics = 'Draga mea Maria, te iubesc enorm, azi si mereu.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, true);
  assert.ok(!result.reasons.includes('explicit_message_omitted'));
  assert.ok(!result.reasons.includes('explicit_message_person_drift'));
});

// ===================================================================================================
// 3) Mesaj important REALMENTE OMIS — cu aceasta corectie, absenta unei fraze EXACTE nu mai
//    blocheaza NICI cand mesajul chiar lipseste (nu doar cand e reformulat) — tehnic imposibil de
//    distins de cazul (1) prin comparatie de subsiruri, fara analiza semantica reala. Documentam
//    explicit acest compromis asumat (risc rezidual raportat).
// ===================================================================================================
test('3) mesaj important REALMENTE omis (nici forma exacta, nici o reformulare vizibila a sentimentului) -> NU mai e respins (compromis asumat, documentat explicit)', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'Draga mea Maria, te iubesc enorm, esti totul pentru mine.' };
  const lyrics = 'O melodie frumoasa despre Maria, cu multa bucurie si lumina.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, true, 'compromis asumat: fara analiza semantica, omisiunea reala nu poate fi distinsa de reformularea naturala');
  assert.ok(result.reasons.includes('explicit_message_omitted'), 'semnalul ramane calculat, pentru monitorizare/raportare viitoare');
});

// ===================================================================================================
// 4) sender_self_declaration — ANALIZAT SEPARAT, DECIZIE: NESCHIMBAT. Documentam explicit riscul
//    teoretic gasit (omograf "sunt"/"sono") SI motivul pentru care nu a fost corectat acum: o
//    incercare de reparatie (cerinta de pozitie la inceputul propozitiei) a fost testata si RESPINSA
//    pentru ca rupea protectia deja demonstrata pentru bug-ul real raportat ("Iar aici Sunt X",
//    vezi test/lyrics-obtain-acceptable-variant.test.js) — fara dovezi DIRECTE ca respingerea reala
//    (bf03a964) a fost intr-adevar un fals-pozitiv (versurile respinse nu sunt niciodata logate),
//    riscul teoretic NU justifica sacrificarea unei protectii confirmate.
// ===================================================================================================
test('4) sender_self_declaration: riscul TEORETIC ramane prezent, neschimbat — "sunt" mid-propozitie (persoana a III-a plural, "Prietenii mei sunt Andrei si Maria") tot RESPINGE, comportament NESCHIMBAT fata de inainte (risc rezidual, documentat explicit — vezi raportul)', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'O poveste calda despre prietenie.' };
  const lyrics = 'Prietenii mei sunt Andrei si Maria, doi oameni minunati langa mine.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, false, 'comportament NESCHIMBAT — decizia a fost sa NU se corecteze acest risc teoretic acum, vezi comentariul de mai sus');
  assert.ok(result.reasons.includes('sender_self_declaration'));
});

test('4b) sender_self_declaration: bug-ul REAL raportat, cu formulare introductiva ("Iar aici Sunt X") — RAMANE detectat identic, protectia demonstrata NU a fost sacrificata', () => {
  const order = { lang: 'ro', senderName: 'Bunicul Andrei', story: 'x' };
  const lyrics = 'Iar aici Sunt Bunicului Andrei, va iubim mult.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('sender_self_declaration'));
});

// ===================================================================================================
// 5) CAZ REAL INVALID — trebuie sa ramana RESPINS (protectiile reale raman intacte).
// ===================================================================================================
test('5a) caz invalid real, RAMANE RESPINS: derapaj de persoana/numar LITERAL prezent ("te iubim" cand expeditorul e singular)', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'Draga mea, te iubesc, esti totul pentru mine.' };
  const lyrics = 'O melodie frumoasa, te iubim, pentru totdeauna.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, false, 'derapajul GRAMATICAL literal ramane un defect real, neambiguu');
  assert.ok(result.reasons.includes('explicit_message_person_drift'));
});

test('5b) caz invalid real, RAMANE RESPINS: auto-identificare gresita LA INCEPUTUL liniei ("Sunt Bunicul Andrei...") — bug-ul original raportat, neschimbat', () => {
  const order = { lang: 'ro', senderName: 'Bunicul Andrei', story: 'O poveste calda.' };
  const lyrics = 'Sunt Bunicul Andrei si te iubesc mult, draga Maria.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('sender_self_declaration'));
});

test('5d) caz invalid real, RAMANE RESPINS: versuri complet goale', () => {
  const result = validateLyricsCoherence({ lang: 'ro' }, {}, '');
  assert.equal(result.ok, true, 'versurile goale sunt tratate separat (reincercarea pentru versuri goale), nu de acest test — vezi lyrics-coherence.test.js');
});

test('5e) caz invalid real, RAMANE RESPINS: amestecarea datelor Premium intre cele doua melodii', () => {
  const order = { lang: 'ro', plan: 'premium', song2Target: 'other', occasion2: 'parinti', recipient: 'Maria', recipient2: 'Ionut' };
  const result = validateLyricsCoherence(order, { recipient: 'Maria' }, 'O melodie calda pentru Ionut, cu multa iubire.');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('song_data_mixing'));
});

// ===================================================================================================
// 6) manele_suflet PASTREAZA instructiunea "Short lines" — neatinsa de aceasta corectie.
// ===================================================================================================
test('6) manele_suflet: buildPrompt() contine in continuare instructiunea de linii scurte, neatinsa de corectia de coerenta', () => {
  const order = {
    occasion: 'zi_de_nastere', genre: 'manele_suflet', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Short lines;'), `instructiunea de linii scurte trebuie sa ramana, a produs: ${prompt}`);
});

// ===================================================================================================
// 7) Celelalte genuri NU sunt afectate — validateLyricsCoherence() e complet independenta de gen
//    (nu primeste/nu foloseste order.genre in nicio verificare), deci corectia se aplica identic
//    TUTUROR genurilor; verificam explicit ca "Short lines" ramane STRICT manele_suflet si ca
//    coerenta functioneaza identic pentru un gen oarecare.
// ===================================================================================================
test('7a) validateLyricsCoherence() nu foloseste order.genre in nicio verificare (functia ramane complet independenta de gen)', () => {
  const fn = sliceFunction(server, 'function validateLyricsCoherence(order, recipientSnapshot, lyricsText) {');
  assert.ok(!/order\.genre/.test(fn), 'validateLyricsCoherence() nu trebuie sa depinda de genul comenzii');
});

test('7b) alt gen (pop): reformularea naturala e ACCEPTATA identic cu manele_suflet — corectia nu e specifica unui gen', () => {
  const order = { lang: 'ro', senderName: 'Andrei', story: 'Draga mea, te iubesc mult.' };
  const lyrics = 'O melodie pop, esti totul pentru mine, azi si mereu.';
  const result = validateLyricsCoherence(order, {}, lyrics);
  assert.equal(result.ok, true);
});

// CORECTIE (2026-09-26, "randuri scurte" extins la TOATE genurile — cerinta explicita): manele_jale
// primeste acum SI el "Short lines", ca orice alt gen — vezi
// test/lyrics-short-lines-all-genres.test.js pentru mecanismul complet al acestei extinderi.
test('7c) manele_jale primeste ACUM instructiunea de linii scurte (extindere deliberata la toate genurile) — identitatea lui (GENRE_STYLE_MAP) ramane neatinsa', () => {
  const order = {
    occasion: 'zi_de_nastere', genre: 'manele_jale', lang: 'ro', plan: 'standard',
    recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Short lines;'));
  assert.ok(!prompt.includes('Verse intro'));
});

// ===================================================================================================
// Structura NON_BLOCKING_COHERENCE_REASONS — confirmare exacta a ce a fost relaxat.
// ===================================================================================================
test('NON_BLOCKING_COHERENCE_REASONS contine STRICT explicit_message_omitted — nimic altceva', () => {
  assert.ok(NON_BLOCKING_COHERENCE_REASONS instanceof Set);
  assert.deepEqual([...NON_BLOCKING_COHERENCE_REASONS], ['explicit_message_omitted']);
});

test('server.js: explicit_message_person_drift, sender_self_declaration, song_data_mixing raman motive BLOCANTE (nu apar in NON_BLOCKING_COHERENCE_REASONS)', () => {
  const setIdx = server.indexOf("const NON_BLOCKING_COHERENCE_REASONS = new Set(['explicit_message_omitted']);");
  assert.ok(setIdx !== -1, 'setul trebuie sa contina STRICT explicit_message_omitted, text exact neschimbat');
});

test('server.js si toate fisierele modificate raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
