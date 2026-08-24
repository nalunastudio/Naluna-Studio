// Teste pentru "COERENȚA GRAMATICALĂ/NARATIVĂ A VERSURILOR" (2026-08-24) — cauza reala raportata:
// comanda cu UN SINGUR expeditor ("bunicul Andrei"), mesaj explicit la persoana I singular
// ("te iubesc"), dar refrenul generat de Suno (customMode:false) trecea la plural ("te iubim") si
// construia o auto-identificare gresita gramatical ("Sunt Bunicului Andrei"). Acopera cele 3
// piese ale corectiei:
//  (1) resolveSenderMode() — sursa unica de adevar pentru persoana/numarul expeditorului, NICIODATA
//      dedusa din recipientMode sau din vocePreference 'duet';
//  (2) buildPrompt() — indiciul compact de persoana/numar, protejat de trunchiere;
//  (3) validateLyricsCoherence() + orderTracksByCoherence() — verificarea semantica REALA a
//      versurilor primite, cu fixtura EXACTA Maria/bunicul Andrei/"te iubesc" cerută explicit,
//      care demonstreaza ca REZULTATUL EFECTIV ACCEPTAT e coerent, nu doar ca promptul contine
//      o instructiune.
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

// Extrage functiile PURE relevante din server.js si le evalueaza intr-un sandbox, fara sa
// importe server.js intreg (ar porni serverul HTTP real si ar cere DATABASE_URL) — acelasi
// tipar folosit deja in test/occasion-real-personalization.test.js si altele.
function loadLyricsCoherenceModule() {
  const server = read('server.js');

  const orderTracksByCoherenceSnippet = sliceFunction(server, 'function orderTracksByCoherence(tracks, order, recipientSnapshot) {');

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
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${buildPromptRegion}
    ${orderTracksByCoherenceSnippet}
    return { buildPrompt, resolveSenderMode, validateLyricsCoherence, orderTracksByCoherence };
  `;
  return new Function(sandboxSrc)();
}

const { buildPrompt, resolveSenderMode, validateLyricsCoherence, orderTracksByCoherence } = loadLyricsCoherenceModule();

// ---------------------------------------------------------------------------------------------
// (1) resolveSenderMode — sursa unica de adevar, NICIODATA recipientMode/duet.
// ---------------------------------------------------------------------------------------------

test('resolveSenderMode: implicit singular pentru nume simplu sau text compus fara conector cunoscut', () => {
  assert.equal(resolveSenderMode('Andrei', 'ro'), 'singular');
  assert.equal(resolveSenderMode('Bunicul Andrei', 'ro'), 'singular');
  assert.equal(resolveSenderMode('Bunicului Andrei', 'ro'), 'singular');
  assert.equal(resolveSenderMode('', 'ro'), 'singular');
  assert.equal(resolveSenderMode(null, 'ro'), 'singular');
  assert.equal(resolveSenderMode(undefined, 'ro'), 'singular');
});

test('resolveSenderMode: detecteaza plural STRICT din tiparul "Nume <conector> Nume" al limbii comenzii', () => {
  assert.equal(resolveSenderMode('Maria si Alexandra', 'ro'), 'plural');
  assert.equal(resolveSenderMode('Maria și Alexandra', 'ro'), 'plural');
  assert.equal(resolveSenderMode('John and Mary', 'en'), 'plural');
  assert.equal(resolveSenderMode('Hans und Greta', 'de'), 'plural');
  assert.equal(resolveSenderMode('Juan y Maria', 'es'), 'plural');
  assert.equal(resolveSenderMode('Marco e Giulia', 'it'), 'plural');
  assert.equal(resolveSenderMode('Jean et Marie', 'fr'), 'plural');
  assert.equal(resolveSenderMode('Иван и Мария', 'bg'), 'plural');
  assert.equal(resolveSenderMode('Ahmet ve Ayşe', 'tr'), 'plural');
});

test('resolveSenderMode: conectorul unei ALTE limbi decat order.lang nu declanseaza fals-pozitiv', () => {
  // "and" e conectorul englez — pentru o comanda RO, nu trebuie folosit ca semnal de plural.
  assert.equal(resolveSenderMode('Bunicul and Andrei', 'ro'), 'singular');
});

test('resolveSenderMode: NU foloseste recipientMode sau voicePreference ca sursa — semnatura functiei nici nu le primeste', () => {
  assert.equal(resolveSenderMode.length, 2, 'resolveSenderMode(senderName, lang) — doar doi parametri, niciun recipientMode/voicePreference');
});

// ---------------------------------------------------------------------------------------------
// (2) buildPrompt — indiciul de persoana/numar, protejat de trunchiere.
// ---------------------------------------------------------------------------------------------

test('buildPrompt: comanda cu expeditor singular primeste indiciul "(I, not we)" langa Sender', () => {
  const prompt = buildPrompt({
    lang: 'ro', genre: 'pop', recipient: 'Maria', senderName: 'Bunicul Andrei',
    relationship: 'bunic', story: 'Te iubesc enorm, esti totul pentru mine.'
  }, '', 'pop');
  assert.ok(prompt.includes('(I, not we)'), `promptul trebuie sa contina indiciul de persoana singular, a produs: ${prompt}`);
});

test('buildPrompt: comanda cu expeditor plural detectat (nume+conector) primeste indiciul "(we, not I)"', () => {
  const prompt = buildPrompt({
    lang: 'ro', genre: 'pop', recipient: 'Maria', senderName: 'Maria și Alexandra',
    relationship: 'surori', story: 'Va iubim mult.'
  }, '', 'pop');
  assert.ok(prompt.includes('(we, not I)'), `promptul trebuie sa contina indiciul de persoana plural, a produs: ${prompt}`);
});

test('buildPrompt: indiciul de persoana/numar supravietuieste trunchierii de siguranta chiar si in cel mai incarcat scenariu real (nume maxime, poveste lunga)', () => {
  const order = {
    lang: 'ro', genre: 'pop', occasion: 'bunici', grandparentType: 'grandfather',
    recipientRole: 'grandmother', senderRole: 'granddaughter',
    recipient: 'A'.repeat(60), senderName: 'B'.repeat(100), relationship: 'C'.repeat(60),
    story: 'D'.repeat(1000)
  };
  const prompt = buildPrompt(order, '', 'pop');
  assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca 600 caractere, are ${prompt.length}`);
  assert.ok(prompt.includes('(I, not we)'), `indiciul de persoana/numar trebuie sa supravietuiasca trunchierii, a produs: ${prompt}`);
  // numele expeditorului/destinatarului raman COMPLETE (cerinta preexistenta, neschimbata) — nu
  // trebuie sa fi fost afectate de adaugarea indiciului.
  assert.ok(prompt.includes('A'.repeat(60)), 'numele destinatarului trebuie sa ramana complet');
  assert.ok(prompt.includes('B'.repeat(100)), 'numele expeditorului trebuie sa ramana complet');
});

test('buildPrompt: pentru cele 8 limbi, cu campuri de lungime tipica, promptul incape sub 600 caractere SI pastreaza inceputul povestii reale', () => {
  for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
    const story = 'O poveste reala si frumoasa despre noi doi, cu detalii concrete din viata noastra.';
    const order = { lang, genre: 'pop', recipient: 'Maria', senderName: 'Andrei', relationship: 'prieteni', story };
    const prompt = buildPrompt(order, '', 'pop');
    assert.ok(prompt.length <= 600, `[${lang}] promptul nu trebuie sa depaseasca 600 caractere, are ${prompt.length}`);
    assert.ok(prompt.includes('O poveste reala'), `[${lang}] inceputul povestii reale trebuie sa fie prezent, a produs: ${prompt}`);
    assert.ok(prompt.includes('(I, not we)'), `[${lang}] indiciul de persoana/numar trebuie sa fie prezent`);
  }
});

test('buildPrompt: vocePreference "duet" NU schimba indiciul de persoana/numar — vocea e o preferinta de interpretare, nu de naratiune', () => {
  const base = { lang: 'ro', genre: 'pop', recipient: 'Maria', senderName: 'Bunicul Andrei', relationship: 'bunic', story: 'Te iubesc enorm.' };
  const promptAuto = buildPrompt({ ...base, voicePreference: 'auto' }, '', 'pop');
  const promptDuet = buildPrompt({ ...base, voicePreference: 'duet' }, '', 'pop');
  assert.ok(promptAuto.includes('(I, not we)'));
  assert.ok(promptDuet.includes('(I, not we)'), 'un duet vocal NU trebuie sa transforme un expeditor singular in plural naratologic');
});

// ---------------------------------------------------------------------------------------------
// (3) validateLyricsCoherence — verificarea semantica REALA, cu perechi EXACTE per limba.
// ---------------------------------------------------------------------------------------------

const DRIFT_FIXTURES = {
  ro: { singular: 'te iubesc', plural: 'te iubim' },
  en: { singular: 'i love you', plural: 'we love you' },
  de: { singular: 'ich liebe dich', plural: 'wir lieben dich' },
  es: { singular: 'te quiero', plural: 'te queremos' },
  it: { singular: 'ti amo', plural: 'ti amiamo' },
  fr: { singular: "je t'aime", plural: "nous t'aimons" },
  bg: { singular: 'обичам те', plural: 'обичаме те' },
  tr: { singular: 'seni seviyorum', plural: 'seni seviyoruz' }
};

for (const [lang, { singular, plural }] of Object.entries(DRIFT_FIXTURES)) {
  test(`validateLyricsCoherence [${lang}]: expeditor singular, poveste cu "${singular}" -> versuri cu "${plural}" sunt RESPINSE (derapaj persoana/numar)`, () => {
    const order = { lang, senderName: 'Andrei', story: `Draga mea, ${singular}, esti totul pentru mine.` };
    const badLyrics = `O melodie frumoasa, ${plural}, pentru totdeauna.`;
    const result = validateLyricsCoherence(order, {}, badLyrics);
    assert.equal(result.ok, false, `versurile cu derapaj la plural trebuie respinse, motive: ${JSON.stringify(result.reasons)}`);
    assert.ok(result.reasons.includes('explicit_message_person_drift'));
  });

  test(`validateLyricsCoherence [${lang}]: expeditor singular, poveste cu "${singular}" -> versuri care pastreaza "${singular}" sunt ACCEPTATE`, () => {
    const order = { lang, senderName: 'Andrei', story: `Draga mea, ${singular}, esti totul pentru mine.` };
    const goodLyrics = `O melodie frumoasa, ${singular}, pentru totdeauna.`;
    const result = validateLyricsCoherence(order, {}, goodLyrics);
    assert.equal(result.ok, true, `versurile coerente nu trebuie respinse, motive: ${JSON.stringify(result.reasons)}`);
  });

  test(`validateLyricsCoherence [${lang}]: expeditor PLURAL detectat -> "${plural}" in versuri NU e semnalat ca derapaj (e forma asteptata)`, () => {
    const order = { lang, senderName: (SENDER_MODE_PLURAL_NAME[lang]), story: `Draga mea, ${singular}, esti totul pentru noi.` };
    const lyrics = `O melodie frumoasa, ${plural}, pentru totdeauna.`;
    const result = validateLyricsCoherence(order, {}, lyrics);
    assert.equal(result.reasons.includes('explicit_message_person_drift'), false, `pentru expeditor plural, "${plural}" e forma corecta, nu un derapaj`);
  });
}

// nume-fixture plural per limba (Nume <conector-al-limbii> Nume), pentru testul de mai sus.
const SENDER_MODE_PLURAL_NAME = {
  ro: 'Maria și Alexandra', en: 'John and Mary', de: 'Hans und Greta', es: 'Juan y Maria',
  it: 'Marco e Giulia', fr: 'Jean et Marie', bg: 'Иван и Мария', tr: 'Ahmet ve Ayşe'
};

test('validateLyricsCoherence: detecteaza auto-identificarea gresita "Sunt {nume expeditor}" (RO)', () => {
  const order = { lang: 'ro', senderName: 'Bunicul Andrei', story: 'O poveste calda.' };
  const result = validateLyricsCoherence(order, {}, 'Sunt Bunicul Andrei si te iubesc mult, draga Maria.');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('sender_self_declaration'));
});

test('validateLyricsCoherence: "I am {sender}" (EN), "Ich bin {sender}" (DE) sunt detectate identic', () => {
  const enResult = validateLyricsCoherence({ lang: 'en', senderName: 'Grandpa Andrew', story: 'x' }, {}, "I am Grandpa Andrew, and I love you dearly.");
  assert.equal(enResult.ok, false);
  assert.ok(enResult.reasons.includes('sender_self_declaration'));

  const deResult = validateLyricsCoherence({ lang: 'de', senderName: 'Opa Andreas', story: 'x' }, {}, 'Ich bin Opa Andreas und ich liebe dich sehr.');
  assert.equal(deResult.ok, false);
  assert.ok(deResult.reasons.includes('sender_self_declaration'));
});

test('validateLyricsCoherence: versuri fara nicio problema sunt ACCEPTATE (fara fals-pozitive)', () => {
  const order = { lang: 'ro', senderName: 'Bunicul Andrei', story: 'Te iubesc enorm, esti totul pentru mine.' };
  const result = validateLyricsCoherence(order, {}, 'Cu drag de la Bunicul Andrei, te iubesc din tot sufletul, draga Maria, azi si mereu.');
  assert.equal(result.ok, true, `motive neasteptate: ${JSON.stringify(result.reasons)}`);
});

test('validateLyricsCoherence: versuri goale sau lipsa -> intotdeauna ok (tratate separat de reincercarea pentru versuri goale)', () => {
  assert.equal(validateLyricsCoherence({ lang: 'ro' }, {}, '').ok, true);
  assert.equal(validateLyricsCoherence({ lang: 'ro' }, {}, null).ok, true);
  assert.equal(validateLyricsCoherence({ lang: 'ro' }, {}, undefined).ok, true);
});

test('validateLyricsCoherence: amestecarea datelor Premium (melodia 2 "Pentru altă persoană") — numele destinatarului CELEILALTE melodii nu are ce cauta in versurile acesteia', () => {
  const order = {
    lang: 'ro', plan: 'premium', song2Target: 'other', occasion2: 'parinti',
    recipient: 'Maria', recipient2: 'Ionut'
  };
  // varianta melodiei 1 (recipientSnapshot.recipient === order.recipient) contine gresit numele destinatarului melodiei 2
  const mixedLyrics = 'O melodie calda pentru Ionut, cu multa iubire.';
  const result = validateLyricsCoherence(order, { recipient: 'Maria' }, mixedLyrics);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('song_data_mixing'));

  const cleanLyrics = 'O melodie calda pentru Maria, cu multa iubire.';
  const cleanResult = validateLyricsCoherence(order, { recipient: 'Maria' }, cleanLyrics);
  assert.equal(cleanResult.ok, true, `motive neasteptate: ${JSON.stringify(cleanResult.reasons)}`);
});

test('validateLyricsCoherence: comenzile Standard/Video (plan!=="premium" sau song2Target!=="other") nu declanseaza NICIODATA verificarea de amestecare a datelor', () => {
  const order = { lang: 'ro', plan: 'standard', recipient: 'Maria', recipient2: 'Ionut' };
  const result = validateLyricsCoherence(order, { recipient: 'Maria' }, 'O melodie calda pentru Ionut.');
  assert.equal(result.reasons.includes('song_data_mixing'), false, 'Standard nu are conceptul de a doua melodie — nicio verificare de amestecare');
});

// ---------------------------------------------------------------------------------------------
// FIXTURA EXACTĂ CERUTĂ EXPLICIT — Maria (destinatar) + bunicul Andrei (expeditor unic) +
// mesaj "te iubesc" (persoana I singular): demonstreaza ca REZULTATUL EFECTIV ALES de
// orderTracksByCoherence() (mecanismul folosit real in finalizeVariantsIfNeeded) e coerent —
// nu doar ca promptul contine o instructiune.
// ---------------------------------------------------------------------------------------------

test('FIXTURA REALA Maria/bunicul Andrei/"te iubesc": orderTracksByCoherence() alege piesa coerenta cand furnizorul intoarce o piesa buna si una cu bug-ul raportat', () => {
  const order = {
    lang: 'ro', plan: 'standard', recipient: 'Maria', senderName: 'Bunicul Andrei', relationship: 'bunic',
    story: 'Te iubesc enorm, draga mea Maria, esti totul pentru mine.'
  };
  // piesa 1 (asa cum a fost raportat REAL, in productie): derapaj plural + auto-identificare gresita.
  const trackBad = { lyrics: 'Sunt Bunicului Andrei si te iubim, draga Maria, din tot sufletul nostru.' };
  // piesa 2: coerenta — persoana I singular pastrata, nicio auto-identificare gresita.
  const trackGood = { lyrics: 'Draga mea Maria, te iubesc enorm, esti totul pentru mine, azi si mereu.' };

  // Suno poate intoarce oricare piesa PRIMA — testam ambele ordini de sosire.
  const ordered1 = orderTracksByCoherence([trackBad, trackGood], order, {});
  assert.equal(ordered1[0].lyrics, trackGood.lyrics, 'cand prima piesa primita e incoerenta si a doua e coerenta, cea coerenta trebuie incercata prima');

  const ordered2 = orderTracksByCoherence([trackGood, trackBad], order, {});
  assert.equal(ordered2[0].lyrics, trackGood.lyrics, 'cand prima piesa primita e deja coerenta, ordinea ramane neschimbata');

  // verificare directa, la nivel de continut: rezultatul EFECTIV ALES (primul din lista reordonata)
  // trece validateLyricsCoherence — versurile livrate clientului sunt cu adevarat coerente.
  const chosen = ordered1[0];
  const finalCheck = validateLyricsCoherence(order, {}, chosen.lyrics);
  assert.equal(finalCheck.ok, true, `versurile efectiv alese trebuie sa fie coerente, motive: ${JSON.stringify(finalCheck.reasons)}`);

  // si varianta respinsa, verificata separat, confirma ca ar fi fost intr-adevar incoerenta
  // (proba ca testul chiar discrimina intre bun/rau, nu accepta orice).
  const rejectedCheck = validateLyricsCoherence(order, {}, trackBad.lyrics);
  assert.equal(rejectedCheck.ok, false);
  assert.deepEqual(rejectedCheck.reasons.sort(), ['explicit_message_person_drift', 'sender_self_declaration'].sort());
});

test('FIXTURA REALA: daca AMBELE piese primite sunt incoerente, orderTracksByCoherence() nu le elimina (ramane fallback tehnic) — decizia finala de reincercare e in finalizeVariantsIfNeeded', () => {
  const order = {
    lang: 'ro', plan: 'standard', recipient: 'Maria', senderName: 'Bunicul Andrei', relationship: 'bunic',
    story: 'Te iubesc enorm, draga mea Maria.'
  };
  const trackBad1 = { lyrics: 'Sunt Bunicului Andrei, te iubim mult, Maria.' };
  const trackBad2 = { lyrics: 'Noi te iubim, draga Maria, din suflet.' };
  const ordered = orderTracksByCoherence([trackBad1, trackBad2], order, {});
  assert.equal(ordered.length, 2, 'nicio piesa nu trebuie eliminata — doar reordonare, niciodata reducere');
});
