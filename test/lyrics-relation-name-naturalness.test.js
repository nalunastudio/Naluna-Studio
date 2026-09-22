// NATURALETE NUME + RELATIE, runda 2 (2026-09-22) — exemplu real NOU raportat de client, dupa
// runda 1 (care elimina "Nume, relatie" mecanic): "Victor, tu ești tata mea" — gramatical gresit
// (dezacord de gen: "tata" masculin + "mea" posesiv feminin; corect ar fi "tatăl meu"). Cauza:
// relationClause() (server.js) foloseste inca o PROPOZITIE COMPLETA in engleza ("that the
// recipient is their {roNoun}") pe care modelul o putea traduce cuvant-cu-cuvant in limba
// versurilor, producand dezacorduri gramaticale in limbi flexionare. Aceasta runda inlocuieste
// acea propozitie cu formatul ETICHETA: VALOARE ("Relation: {roNoun}"), acelasi tipar deja
// folosit si dovedit sigur pentru Recipient:/Sender:/Relationship: — o eticheta e neutra fata de
// gramatica limbii tinta, niciodata o propozitie de tradus literal. Cere explicit "correct
// grammar"/"any line" — acord gramatical corect in limba versurilor, relatia poate aparea in
// orice vers, nu neaparat langa nume.
//
// IMPORTANT: NU hardcodeaza niciun exemplu concret de tip "tatăl meu Victor"/"Maria, mama mea" —
// instructiunea ramane GENERICA, aplicata modelului, nu injectata direct in versuri (verificat
// explicit mai jos, sectiunea 7).
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
const PACKAGES = ['standard', 'premium', 'video'];

// Cele 4 relatii cerute explicit de client: tata, mama, matusa, bunic (echivalente EN).
const RELATIONS = [
  { role: 'father', occasion: 'parinti', senderRole: 'daughter', roNoun: 'father' },
  { role: 'mother', occasion: 'parinti', senderRole: 'son', roNoun: 'mother' },
  { role: 'aunt', occasion: 'matusa-unchi', senderRole: 'niece', roNoun: 'aunt' },
  { role: 'grandfather', occasion: 'bunici', senderRole: 'grandson', roNoun: 'grandfather' }
];

function familyOrder({ lang, plan, relationInfo, recipient, senderName, story }) {
  return {
    plan, lang, genre: 'pop', occasion: relationInfo.occasion,
    recipient, recipientMode: 'single', recipientRole: relationInfo.role,
    senderName, senderRole: relationInfo.senderRole, relationship: relationInfo.role,
    voicePreference: 'auto', story
  };
}

const STORY_BY_LANG = {
  ro: 'Ne-am plimbat mereu duminica in parc si mi-ai citit povesti seara.',
  en: 'We always walked in the park on Sundays and you read me stories at night.',
  de: 'Wir sind sonntags immer im Park spazieren gegangen und du hast mir abends Geschichten vorgelesen.',
  es: 'Siempre caminábamos por el parque los domingos y me leías cuentos por la noche.',
  it: 'Camminavamo sempre al parco la domenica e mi leggevi le storie la sera.',
  fr: 'Nous nous promenions toujours dans le parc le dimanche et tu me lisais des histoires le soir.',
  bg: 'Винаги се разхождахме в парка в неделя и ми четеше приказки вечер.',
  tr: 'Pazar günleri her zaman parkta yürüyüşe çıkardık ve akşamları bana hikayeler okurdun.'
};

// ================================================================================================
// 1) relationClause() foloseste ETICHETA: VALOARE ("Relation: X"), NICIODATA propozitia veche
// "is their X" (predispusa la traducere cuvant-cu-cuvant gresita gramatical).
// ================================================================================================
test('relationClause() (server.js): formele FULL/SHORT folosesc "Relation: ${roNoun}" (eticheta neutra), NU mai exista propozitia copula "is their ${roNoun}"', () => {
  assert.match(server, /` Relation: \$\{roNoun\} — phrase naturally, correct grammar, any line; song from their \$\{senderNoun\}\.`/);
  assert.match(server, /` Relation: \$\{roNoun\} — phrase naturally, correct grammar, any line\.`/);
  assert.match(server, /` Relation: \$\{roNoun\} \(natural; from their \$\{senderNoun\}\)\.`/);
  assert.match(server, /` Relation: \$\{roNoun\} \(natural\)\.`/);
  assert.ok(!/Mention naturally, once, that the recipient is their \$\{roNoun\}/.test(server));
  assert.ok(!/Mention once: their \$\{roNoun\}/.test(server));
});

test('relationClause() cere explicit acord gramatical corect ("correct grammar") in limba versurilor — nu traducere cuvant-cu-cuvant', () => {
  assert.match(server, /correct grammar, any line/);
});

// ================================================================================================
// 2) Pentru cele 4 relatii cerute explicit (tata/mama/matusa/bunic): promptul contine eticheta
// "Relation: X" (sau forma minimal "Their X"), NICIODATA sablonul mecanic "Nume, relatie".
// ================================================================================================
for (const relationInfo of RELATIONS) {
  test(`relatia "${relationInfo.role}": promptul (RO) contine "Relation: "${relationInfo.roNoun}"" sau forma minimal, NICIODATA "Nume, relatie" lipit`, () => {
    const order = familyOrder({ lang: 'ro', plan: 'standard', relationInfo, recipient: 'Victor', senderName: 'Ana', story: STORY_BY_LANG.ro });
    const prompt = buildPrompt(order, '', null);
    assert.match(
      prompt,
      new RegExp(`Relation: "${relationInfo.roNoun}" — phrase naturally, correct grammar, any line|Relation: "${relationInfo.roNoun}" \\(natural|Their "${relationInfo.roNoun}"`),
      `relatia trebuie mentionata prin eticheta, primit: ${prompt}`
    );
    assert.ok(!prompt.includes(`Victor, "${relationInfo.roNoun}"`), `nu trebuie sa lipeasca numele si relatia ca "Nume, relatie", primit: ${prompt}`);
    assert.ok(!new RegExp(`recipient is their "${relationInfo.roNoun}"`).test(prompt), 'copula veche nu mai trebuie sa apara');
  });
}

// ================================================================================================
// 3) Numele destinatarului ramane OBLIGATORIU — neatins de aceasta corectie.
// ================================================================================================
test('numele destinatarului ramane cerinta OBLIGATORIE — currentInstruction() neschimbata de aceasta corectie', () => {
  const order = familyOrder({ lang: 'ro', plan: 'standard', relationInfo: RELATIONS[0], recipient: 'Victor', senderName: 'Ana', story: STORY_BY_LANG.ro });
  const prompt = buildPrompt(order, '', null);
  assert.match(prompt, /name recipient early\+chorus|Name the recipient early and in the chorus/, `numele trebuie sa ramana cerut, primit: ${prompt}`);
  assert.match(prompt, /Recipient: Victor\./, 'numele real trebuie sa apara literal in prompt');
});

// ================================================================================================
// 4) Povestea clientului ramane prioritara — buget <=600, poveste prezenta, pentru toate cele 4
// relatii x toate cele 8 limbi x toate cele 3 pachete.
// ================================================================================================
for (const relationInfo of RELATIONS) {
  for (const lang of LANGS) {
    for (const plan of PACKAGES) {
      test(`buget [relatie=${relationInfo.role}, ${lang}/${plan}]: promptul ramane <=600 caractere SI povestea (fragment semnificativ) ajunge`, () => {
        const order = familyOrder({ lang, plan, relationInfo, recipient: 'Victor', senderName: 'Ana', story: STORY_BY_LANG[lang] });
        const prompt = buildPrompt(order, '', null);
        assert.ok(Array.from(prompt).length <= 600, `prompt peste buget: ${Array.from(prompt).length} caractere, [${relationInfo.role}/${lang}/${plan}]`);
        const firstWord = STORY_BY_LANG[lang].split(/\s+/)[0];
        assert.ok(prompt.includes(firstWord), `povestea lipseste din prompt [${relationInfo.role}/${lang}/${plan}], primit: ${prompt}`);
      });
    }
  }
}

// ================================================================================================
// 5) Premium — genre2/genreOverride foloseste ACELASI mecanism (relationClause e independenta de
// gen, dar verificam ca apelul cu genreOverride nu ocoleste instructiunea de relatie).
// ================================================================================================
test('Premium: buildPrompt cu genreOverride (a doua melodie) foloseste ACEEASI instructiune de relatie, neschimbata de alegerea genului', () => {
  const order = familyOrder({ lang: 'ro', plan: 'premium', relationInfo: RELATIONS[1], recipient: 'Maria', senderName: 'Ion', story: STORY_BY_LANG.ro });
  const promptDefaultGenre = buildPrompt(order, '', null);
  const promptOverride = buildPrompt(order, '', 'jazz');
  for (const prompt of [promptDefaultGenre, promptOverride]) {
    assert.match(prompt, /Relation: "mother"|Their "mother"/, `relatia trebuie sa apara indiferent de gen, primit: ${prompt}`);
  }
});

// ================================================================================================
// 6) Regenerare/editare (buildExactLyricsRequest) — NEATINSA: nu foloseste relationClause()/
// RELATION_NOUNS (versurile sunt deja fixate, doar stilul se recalculeaza).
// ================================================================================================
test('buildExactLyricsRequest() ramane NEATINSA de aceasta corectie — nu foloseste relationClause()/RELATION_NOUNS (versurile sunt deja fixate la regenerare/editare)', () => {
  const idx = server.indexOf('function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.ok(idx !== -1);
  let depth = 0, i = server.indexOf('{', idx);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fn = server.slice(idx, i + 1);
  assert.ok(!fn.includes('relationClause'), 'buildExactLyricsRequest nu trebuie sa foloseasca relationClause()');
  assert.ok(!fn.includes('RELATION_NOUNS'), 'buildExactLyricsRequest nu trebuie sa foloseasca RELATION_NOUNS');
});

// ================================================================================================
// 7) NU hardcodeaza niciunul dintre exemplele de naturalete date de client — instructiunea ramane
// GENERICA, aplicata modelului, niciodata injectata direct in versuri/prompt.
// ================================================================================================
test('CRITIC — niciunul dintre exemplele de naturalete date de client ("tatăl meu Victor", "Maria, mama mea", "Matușea mea Simona", "Adrian, bunicul meu") nu e hardcodat in server.js', () => {
  const forbidden = ['tatăl meu Victor', 'Maria, mama mea', 'Matușea mea Simona', 'matușa mea Simona', 'Adrian, bunicul meu'];
  for (const phrase of forbidden) {
    assert.ok(!server.includes(phrase), `exemplul "${phrase}" nu trebuie sa fie hardcodat in server.js`);
  }
});

// ================================================================================================
// 8) Restul regulilor existente ramane neatins: GENRE_STYLE_MAP, STORY_MIN_RESERVE,
// validateLyricsCoherence, anti-repetitie.
// ================================================================================================
test('STORY_MIN_RESERVE, SUNO_PROMPT_MAX_LEN raman neschimbate de aceasta corectie', () => {
  assert.match(server, /const STORY_MIN_RESERVE = 190;/);
  assert.match(server, /const SUNO_PROMPT_MAX_LEN = 600;/);
});

test('instructiunea anti-repetitie ("never generic or repeated"/"never invented/repeated") ramane neschimbata', () => {
  assert.match(server, /never generic or repeated/);
  assert.match(server, /never invented\/repeated/);
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
