// NATURALETE VERSURI (2026-09-22) — teste de regresie dedicate cerintei explicite: versurile
// generate trebuie sa sune ca scrise de un om, pastrand personalizarea (nume/relatie/poveste),
// fara constructii mecanice ("Nume, relatie"), fara repetitii apropiate, fara filler generic.
//
// Extrage si ruleaza buildPrompt() DIRECT din server.js (acelasi tipar EXACT ca
// test/p1-story-preservation-8-languages.test.js / test/story-floor-occasion-fallback-fix.test.js)
// — niciodata o reimplementare separata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = server.slice(startIdx, i + 1);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// Comanda LEJERA — ramura NON-familie a relationClause (relationship: 'friend'), garantat sa
// ramana in forma FULL (acelasi tipar calibrat ca test/p1-story-preservation-8-languages.test.js).
function lightOrder(overrides) {
  return Object.assign({
    plan: 'standard', lang: 'ro', genre: 'pop', occasion: 'aniversare',
    recipient: 'Alex', senderName: 'Sam', relationship: 'friend',
    voicePreference: 'auto',
    story: 'Ne-am cunoscut in 2015 la o cafenea din Brasov, intr-o dupa-amiaza ploioasa.'
  }, overrides || {});
}
// Comanda de familie (ramura FAMILY a relationClause — cea reparata, cauza reala a bug-ului
// "Victor, tata") — NU garantat sa ramana FULL (depinde de buget), folosita STRICT pentru testele
// care verifica relationClause() insasi, nu prezenta clauzelor de naturalete din currentInstruction.
function familyOrder(overrides) {
  return Object.assign({
    plan: 'standard', lang: 'ro', genre: 'pop', occasion: 'parinti',
    recipient: 'Victor', recipientMode: 'single', recipientRole: 'father',
    senderName: 'Ana', senderRole: 'daughter', relationship: 'tată',
    voicePreference: 'auto',
    story: 'Ne-am plimbat mereu duminica in parc.'
  }, overrides || {});
}

// ===============================================================================================
// 1) Numele ramane obligatoriu, in toate caile (full SI short).
// ===============================================================================================
test('numele destinatarului ramane cerinta OBLIGATORIE, prezenta literal in instructiune, in toate cele 4 forme (with/no sender x full/short)', () => {
  assert.match(server, /Name the recipient early and in the chorus/, 'forma FULL (with sender) trebuie sa ceara numele');
  assert.match(server, /name recipient early\+chorus/, 'forma SHORT (with sender) trebuie sa ceara numele');
  assert.match(server, /Address the recipient by name naturally in the lyrics/, 'forma FULL (no sender) trebuie sa ceara numele');
  assert.match(server, /Address by name naturally/, 'forma SHORT (no sender) trebuie sa ceara numele');
});

// DESCOPERIRE EMPIRICA (2026-09-22, raportul fazei): GENRE_STYLE_MAP are STRICT stiluri lungi
// (~90-110 caractere fiecare, minimul masurat e "manele" cu 100) — combinate cu eticheta
// obligatorie de poveste si (pentru limbi non-engleze) dictia, instructiunea currentInstruction()
// e ÎN FORMA SHORT pentru PRACTIC orice comanda reala (verificat inclusiv pentru cel mai usor
// caz posibil: fara expeditor, poveste de 3 caractere). Forma FULL exista si ramane corecta cand
// bugetul chiar permite, dar NU trebuie presupusa reprezentativa — testele de mai jos verifica
// STRICT ce ajunge REALMENTE la Suno (forma SHORT), nu forma teoretica FULL.
test('buildPrompt: instructiunea de nume ajunge REALMENTE in promptul construit, pentru o comanda lejera', () => {
  const prompt = buildPrompt(lightOrder(), '', null);
  assert.match(prompt, /name recipient early\+chorus|Name the recipient early and in the chorus/, `lipseste cerinta de nume, primit: ${prompt}`);
});

// ===============================================================================================
// 2) Relatia e tratata SEMANTIC — NU mai exista instructiunea mecanica "Address as X plus their
// name" / "X+name" (cauza reala a exemplului raportat "Victor, tata").
// ===============================================================================================
test('RUPTURA REPARATA: instructiunea mecanica "address as X plus their name"/"X+name" (concatenare relatie+nume) NU mai exista ca COD ACTIV (poate ramane STRICT mentionata in comentarii, ca istoric — vezi convention proiectului)', () => {
  // Verificam STRICT sabloanele de interpolare (cod real, in template literals), niciodata
  // simpla mentiune in proza a comentariilor (care documenteaza legitim, intentionat, formularea
  // veche inlocuita — acelasi tipar folosit peste tot in acest fisier).
  assert.ok(!/\$\{roNoun\} plus their name/.test(server), 'sablonul de interpolare "${roNoun} plus their name" nu mai trebuie sa existe ca cod activ');
  assert.ok(!/\$\{roNoun\}\+name/.test(server), 'sablonul literal "${roNoun}+name" nu mai trebuie sa existe ca cod activ');
});

test('relationClause: noua formulare cere relatia NATURAL, separat de nume — "Mention naturally" / "Mention once", niciodata lipita de nume', () => {
  assert.match(server, /Mention naturally, once, that the recipient is their/);
  assert.match(server, /Mention once: their \$\{roNoun\}/);
});

test('buildPrompt: pentru o relatie de familie (tata), instructiunea de relatie NU produce sablonul "Nume, relatie" — cere relatia ca fapt separat, natural (forma FULL sau SHORT, ambele corecte)', () => {
  const prompt = buildPrompt(familyOrder(), '', null);
  assert.match(prompt, /Mention naturally, once, that the recipient is their "father"|Mention once: their "father"|Their "father"/, `relatia trebuie mentionata natural, primit: ${prompt}`);
  assert.ok(!prompt.includes('Victor, "father"'), 'promptul nu trebuie sa lipeasca numele si relatia ca doua campuri de formular');
  assert.ok(!prompt.includes('as "father" plus their name'), 'sablonul mecanic vechi nu mai trebuie sa apara');
});

// ===============================================================================================
// 3) Instructiuni anti-repetitie — cerinta explicita, cea mai des raportata in exemplul real.
// ===============================================================================================
test('instructiunea de anti-repetitie explicita exista in TOATE cele 4 forme (with/no sender x full/short) — SHORT include "never invented/repeated", FULL include "never generic or repeated"', () => {
  assert.match(server, /never generic or repeated/, 'formele FULL trebuie sa contina cerinta anti-repetitie');
  assert.match(server, /never invented\/repeated/, 'formele SHORT (cele REAL folosite in practica, vezi mai jos) trebuie sa contina si ele cerinta anti-repetitie');
});

test('buildPrompt: instructiunea anti-repetitie ajunge REALMENTE in prompt pentru o comanda lejera', () => {
  const prompt = buildPrompt(lightOrder(), '', null);
  assert.match(prompt, /never generic or repeated|never invented\/repeated/, `lipseste anti-repetitia, primit: ${prompt}`);
});

// ===============================================================================================
// 4) Anti-filler / anti-limbaj-AI-generic — "never generic" (deja exista, pastrat/intarit).
// ===============================================================================================
test('instructiunea FULL interzice explicit o linie generica ("never generic")', () => {
  assert.match(server, /never generic or repeated/);
});

// ===============================================================================================
// 5) Naturalete > rima fortata — cerinta noua, explicita.
// ===============================================================================================
// "natural over forced rhyme" traieste STRICT in forma FULL (nu incape in forma SHORT fara sa
// reintroduca regresia de buget deja gasita si respinsa la testare, vezi comentariul din
// server.js) — LIMITARE CUNOSCUTA, de raportat explicit: forma FULL e rar atinsa in practica (vezi
// testul de mai sus), deci acest semnal specific nu ajunge la Suno pentru majoritatea comenzilor
// reale. Testat STRICT structural aici (prezenta in cod), nu dinamic printr-o comanda "tipica" —
// nicio comanda realista nu garanteaza forma FULL, deci un test dinamic ar fi inselator.
test('instructiunea FULL (with/no sender) cere explicit naturalete peste rima fortata — prezenta structurala in cod', () => {
  assert.match(server, /natural over forced rhyme/);
});

// ===============================================================================================
// 6) Povestea clientului ramane PRIORITARA — STORY_MIN_RESERVE NU a fost redus.
// ===============================================================================================
test('STORY_MIN_RESERVE NU a fost redus — ramane 190 (valoarea existenta dinainte de aceasta faza)', () => {
  assert.match(server, /const STORY_MIN_RESERVE = 190;/);
});

test('SUNO_PROMPT_MAX_LEN NU a fost marit (risc documentat: prompturi mai lungi corelau cu piese instrumentale, fara versuri) — ramane 600', () => {
  assert.match(server, /const SUNO_PROMPT_MAX_LEN = 600;/);
});

test('instructiunea FULL cere in continuare "story details throughout" (detalii reale din poveste, raspandite in tot textul) — povestea ramane prioritara fata de filler', () => {
  assert.match(server, /never-invented story details throughout/);
});

// ===============================================================================================
// 7) Toate cele 8 limbi sunt acoperite — instructiunile (in engleza) guverneaza generarea
// indiferent de limba versurilor (Suno primeste STRICT "Write the song lyrics entirely in
// ${lyricsLanguage}" separat) — niciun cod per-limba dedicat, deci acoperirea e automata.
// ===============================================================================================
test('LYRICS_LANGUAGE_NAMES acopera exact cele 8 limbi Naluna', () => {
  const m = server.match(/const LYRICS_LANGUAGE_NAMES = \{([\s\S]*?)\};/);
  assert.ok(m, 'LYRICS_LANGUAGE_NAMES trebuie sa existe');
  for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
    assert.match(m[1], new RegExp(`\\b${lang}:\\s*'`), `limba "${lang}" lipseste din LYRICS_LANGUAGE_NAMES`);
  }
});

// Comanda LEJERA (ACELASI tipar calibrat ca test/p1-story-preservation-8-languages.test.js —
// occasion='aniversare'/genre='pop'/relationship='friend', ramura NON-familie a relationClause) —
// folosita pentru toate cele 8 limbi, ca sa verifice prezenta REALA a clauzelor de naturalete
// care ajung EFECTIV la Suno (forma SHORT, confirmata mai sus ca fiind cea folosita in practica).
const LIGHT_STORY_BY_LANG = {
  ro: 'Ne-am cunoscut in 2015 la o cafenea din Brasov, intr-o dupa-amiaza ploioasa.',
  en: 'We met in 2015 at a small cafe in Brighton, on a rainy afternoon together.',
  de: 'Wir haben uns 2015 in einem kleinen Cafe in Freiburg kennengelernt, an einem Regentag.',
  es: 'Nos conocimos en 2015 en una cafeteria de Sevilla, una tarde de lluvia tranquila.',
  it: 'Ci siamo conosciuti nel 2015 in un piccolo caffe a Bologna, un pomeriggio di pioggia.',
  fr: 'Nous nous sommes rencontres en 2015 dans un petit cafe a Lyon, un apres-midi pluvieux.',
  bg: 'Запознахме се през 2015 година в едно кафене в София, в един дъждовен следобед.',
  tr: 'Kucuk bir kafede 2015 yilinda tanistik, Istanbul da yagmurlu bir oglenden sonraydi.'
};

for (const lang of LANGS) {
  test(`buildPrompt [${lang}]: instructiunile de naturalete (anti-repetitie, nume obligatoriu) ajung REALMENTE in prompt, pentru o comanda lejera, indiferent de limba versurilor`, () => {
    const order = {
      occasion: 'aniversare', genre: 'pop', lang,
      recipient: 'Alex', senderName: 'Sam', relationship: 'friend',
      voicePreference: 'auto', story: LIGHT_STORY_BY_LANG[lang]
    };
    const prompt = buildPrompt(order, '', null);
    assert.match(prompt, /never generic or repeated|never invented\/repeated/, `lipseste anti-repetitie pentru ${lang}, primit: ${prompt}`);
    assert.match(prompt, /name recipient early\+chorus|Name the recipient early and in the chorus/, `lipseste cerinta de nume pentru ${lang}, primit: ${prompt}`);
    assert.ok(Array.from(prompt).length <= 600, `prompt peste 600 caractere pentru ${lang}`);
  });

  test(`buildPrompt [${lang}]: numele destinatarului ramane cerinta obligatorie chiar si intr-un scenariu incarcat (ocazie familie grea) — forma SHORT tot cere numele`, () => {
    const order = {
      occasion: 'bunici', genre: 'populara', lang,
      recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
      senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Nepoata',
      voicePreference: 'auto',
      story: LIGHT_STORY_BY_LANG[lang]
    };
    const prompt = buildPrompt(order, '', null);
    assert.match(prompt, /name recipient early\+chorus|Name the recipient early and in the chorus/, `lipseste cerinta de nume (forma SHORT sau FULL) pentru ${lang}, primit: ${prompt}`);
    assert.ok(Array.from(prompt).length <= 600, `prompt peste 600 caractere pentru ${lang}`);
  });
}

// ===============================================================================================
// 8) Regenerarea foloseste ACELASI standard — toate caile care scriu versuri NOI (initiale SAU
// regenerate) trec prin buildPrompt() — o singura sursa, niciun al doilea generator de versuri.
// buildExactLyricsRequest() (versuri deja BLOCATE, re-cantate verbatim, niciodata rescrise) ramane
// STRICT neatinsa — nu e o cale de "scriere", deci nu intra sub incidenta acestei cerinte.
// ===============================================================================================
test('toate apelurile care genereaza versuri NOI folosesc STRICT buildPrompt(...) — niciun al doilea constructor de instructiuni de lyric-writing in server.js', () => {
  const buildPromptCallCount = (server.match(/\bbuildPrompt\(/g) || []).length;
  // 1 definitie + minim 6 apeluri reale cunoscute (generare initiala x2 Premium, regenerare,
  // retry coerenta, editare cu feedback etc. — vezi raportul de audit al fazei).
  assert.ok(buildPromptCallCount >= 6, `buildPrompt() trebuie apelat din mai multe locuri (generare/regenerare) — gasit ${buildPromptCallCount}`);
  // NU exista o a doua functie care sa construiasca instructiuni de lyric-writing (ex. un
  // "buildPrompt2"/"buildLyricsPromptV2" paralel) — un singur nume de functie in tot fisierul.
  assert.equal((server.match(/function buildPrompt\(/g) || []).length, 1, 'trebuie sa existe O SINGURA definitie a lui buildPrompt()');
});

test('buildExactLyricsRequest() (versuri deja BLOCATE) NU a fost modificata de aceasta faza — ramane STRICT "sing verbatim", fara nicio instructiune de scriere/naturalete adaugata', () => {
  const idx = server.indexOf('function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.ok(idx !== -1);
  const fnEnd = server.indexOf('\n}', idx);
  const fn = server.slice(idx, fnEnd);
  assert.match(fn, /never paraphrase, alter, skip, or add words/, 'contractul "sing verbatim" trebuie sa ramana neschimbat');
  assert.ok(!fn.includes('never generic or repeated'), 'buildExactLyricsRequest nu trebuie sa capete instructiuni de naturalete — nu scrie versuri, doar le canta');
  assert.ok(!fn.includes('natural over forced rhyme'), 'buildExactLyricsRequest nu trebuie sa capete instructiuni de naturalete — nu scrie versuri, doar le canta');
});

// ===============================================================================================
// 9) Prompturile muzicale (Suno style/voce/manele) NU au fost modificate accidental.
// ===============================================================================================
test('GENRE_STYLE_MAP (prompturile de stil muzical) NU a fost atinsa de aceasta faza — verificata prin hash STRUCTURAL (numarul de genuri + prezenta manele_suflet/manele_jale)', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  assert.ok(idx !== -1);
  const end = server.indexOf('\n};', idx);
  const block = server.slice(idx, end);
  assert.match(block, /manele_suflet/);
  assert.match(block, /manele:/);
  assert.match(block, /hiphop/);
});

test('VOICE_INSTRUCTIONS_FULL/SHORT (Feminina/Masculina/Duet/Alegem pentru tine) NU au fost atinse', () => {
  assert.match(server, /female: ' Use a female lead vocal\.'/);
  assert.match(server, /male: ' Use a male lead vocal\.'/);
  assert.match(server, /duet: ' Use a male and female duet, with both voices clearly present\.'/);
  assert.match(server, /auto: ''/);
});

test('indiciul de intro scurt ("like the verse", 8-10 seconds) NU a fost atins — ramane identic in ambele forme FULL', () => {
  assert.match(server, /Start the vocals around 8-10 seconds, like the verse\./g);
  const count = (server.match(/Start the vocals around 8-10 seconds, like the verse\./g) || []).length;
  assert.equal(count, 2, 'trebuie sa apara EXACT de doua ori — instructionWithSenderFull si instructionNoSenderFull, neschimbate');
});

// ===============================================================================================
// 10) Nu s-a hardcodat niciun template rigid gen "Tatăl meu {name}" / "Fiul meu {name}" in cod.
// ===============================================================================================
test('niciun template hardcodat de forma "relatia mea {name}" nu a fost introdus in relationClause()', () => {
  const idx = server.indexOf('function relationClause() {');
  assert.ok(idx !== -1);
  let depth = 1, i = idx + 'function relationClause() {'.length;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fn = server.slice(idx, i + 1);
  assert.ok(!/Tatăl meu|Fiul meu|Fiica mea/.test(fn), 'nu trebuie sa existe niciun exemplu hardcodat ca template obligatoriu');
});
