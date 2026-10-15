// MUZICA POPULARA AUTENTICA — RUNDA 1 (2026-10-12, cerinta explicita — "suna prea mult a colind,
// nu colinde si nu muzica religioasa"). GENRE_STYLE_MAP.populara rescris cu instrumente CONCRETE,
// identitate lautareasca explicit numita, fara nicio mentiune de artist.
//
// RUNDA 2 (2026-10-12, respins dupa ascultare — "nu suna a muzica populara in genul pe care il
// vreau"): clientul a dat 3 referinte audio OFICIALE (Olguța Berbec — Măriuță, Măriuță; Ion
// Paladi / Orchestra Lăutarii; Fetele din Botoșani — Așa-s Moldovencele). Analiza acustica REALA
// (librosa, descarcate STRICT pentru masurare locala, STERSE dupa — niciodata redistribuite):
// tempo 108-162 BPM, energie percusiva FOARTE SCAZUTA (16-29% — ritm din interactiunea
// instrumentelor melodice, nu dintr-o baterie), centroid spectral luminos (1700-2300Hz),
// densitate mare de onset-uri (4.3-5.2/sec — frazare ornamentata, trilluri, note de trecere).
// Descrierea rescrisa a doua oara sa reflecte exact aceste caracteristici: vioara CONDUCATOARE,
// acordeon+clarinet, frazare ornamentata explicit numita — vezi server.js pentru detalii complete
// (ce s-a masurat, ce s-a inferat prin conventia genului, ce nu s-a putut determina cu
// certitudine STRICT din semnal). Nicio melodie/versuri/identitate vocala a celor 3 referinte nu
// a fost reprodusa — STRICT caracteristici muzicale generale ale genului.
//
// O clauza condiționala "not a Christmas carol" e adaugata INLINE in buildPrompt()/
// buildExactLyricsRequest() (nu printr-un helper top-level — zeci de teste existente sandbox-eaza
// aceste functii printr-o lista curatata de fragmente; un helper nou extern le-ar fi rupt pe
// toate, gasit prin testare directa), omisa STRICT cand povestea clientului mentioneaza explicit
// Craciunul (cerinta #7) — acelasi tipar deja aprobat/testat ca DEATH_THEME_MARKERS.
//
// Celelalte 22 de genuri si configuratia manele_jale raman complet neatinse — vezi
// test/manele-jale-style-differentiation.test.js (lista byte-for-byte) si
// test/manele-jale-voice-params.test.js. Bugetul buildPrompt() (600 caractere, zero-slack) e
// verificat direct mai jos, impotriva EXACT celui mai incarcat scenariu deja documentat in
// test/story-floor-occasion-fallback-fix.test.js (care foloseste chiar genul populara ca
// stress-test — "bunici", expeditor/relatie lungi, duet).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8').replace(/\r\n/g, '\n');
}

function extractFn(source, signature, fromIdx) {
  const idx = source.indexOf(signature, fromIdx || 0);
  assert.ok(idx !== -1, `nu am gasit: ${signature}`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

function sliceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `nu am gasit: ${startMarker}`);
  const end = source.indexOf(endMarker, start) + endMarker.length;
  return source.slice(start, end);
}

const server = read('server.js');

function loadBuildPrompt() {
  const startIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(startIdx !== -1);
  const fnSrc = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  const endIdx = server.indexOf(fnSrc) + fnSrc.length;
  const snippet = server.slice(startIdx, endIdx);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return { buildPrompt, GENRE_STYLE_MAP };
  `;
  return new Function('require', sandboxSrc)(require);
}
const { buildPrompt, GENRE_STYLE_MAP } = loadBuildPrompt();

function order(overrides) {
  return Object.assign({
    plan: 'standard', lang: 'ro', genre: 'populara', occasion: 'declaratie',
    recipient: 'Maria', senderName: 'Andrei', relationship: 'sotie',
    voicePreference: 'auto', story: 'Ne-am cunoscut acum multi ani si te iubesc enorm.'
  }, overrides);
}

// ===================================================================================================
// 1) Descrierea de baza — instrumente CONCRETE, identitate lautareasca, fara colind/religios/artisti.
// ===================================================================================================
test('GENRE_STYLE_MAP.populara: vioara CONDUCATOARE + acordeon/clarinet, frazare ornamentata, identitate lautareasca, fara colind/religios/artisti', () => {
  const style = GENRE_STYLE_MAP.populara;
  assert.match(style, /lautaresc/i);
  assert.match(style, /lead violin/i, 'vioara trebuie sa fie melodia CONDUCATOARE, nu doar enumerata alaturi de alte instrumente');
  assert.match(style, /accordion/i);
  assert.match(style, /clarinet/i);
  assert.match(style, /ornamented/i, 'frazarea ornamentata trebuie numita explicit (densitatea mare de onset-uri masurata in referinte)');
  assert.ok(!/christmas|carol|church|bell|choir|religious/i.test(style), 'descrierea de baza nu trebuie sa mentioneze deloc colind/biserica/clopote/religie');
  // Fara nume de artisti — nici cele din runda 1 (referinte generice de stil), nici cele din
  // runda 2 (cele 3 referinte oficiale date de client).
  assert.ok(!/cuciuc|clejani|vicoveanca|berbec|paladi|botosani|lautarii/i.test(style), 'nu trebuie mentionat niciun nume de artist/formatie');
});

test('GENRE_STYLE_MAP.populara: lungimea (95 caractere) e STRICT mai scurta decat varianta respinsa (142 caractere, cu clarinet+cimbalom+double bass+studio recording) — buget verificat direct, nu presupus', () => {
  const style = GENRE_STYLE_MAP.populara;
  assert.equal(Array.from(style).length, 95, `lungime neasteptata: ${Array.from(style).length}`);
});

// ===================================================================================================
// 2) Promptul final (populara, fara mentiune de Craciun) contine "not a Christmas carol".
// ===================================================================================================
test('buildPrompt [populara]: poveste FARA mentiune de Craciun -> promptul contine "not a Christmas carol"', () => {
  const prompt = buildPrompt(order(), '', null);
  assert.ok(prompt.includes('not a Christmas carol'), prompt);
  assert.ok(Array.from(prompt).length <= 600);
});

// ===================================================================================================
// 3) Alt gen (ex. pop) NU primeste niciodata clauza "not a Christmas carol".
// ===================================================================================================
test('buildPrompt [pop]: nu contine niciodata "not a Christmas carol" (STRICT populara)', () => {
  const prompt = buildPrompt(order({ genre: 'pop', story: 'De Craciun ne vedem cu toata familia.' }), '', null);
  assert.ok(!prompt.includes('not a Christmas carol'), prompt);
});

// ===================================================================================================
// 4) Poveste cu mentiune EXPLICITA de Craciun, in toate cele 8 limbi -> clauza e OMISA (cerinta #7).
// ===================================================================================================
const CHRISTMAS_STORIES = {
  ro: 'De Craciun ne adunam cu toata familia la masa, dragul meu sot.',
  en: 'Every Christmas we gather with the whole family, my dear husband.',
  de: 'Jedes Weihnachten kommen wir als ganze Familie zusammen, mein lieber Mann.',
  es: 'Cada Navidad nos reunimos con toda la familia, mi querido esposo.',
  it: 'Ogni Natale ci riuniamo con tutta la famiglia, mio caro marito.',
  fr: 'Chaque Noël, nous nous réunissons en famille, mon cher mari.',
  bg: 'Всяка Коледа се събираме с цялото семейство, скъпи ми съпруже.',
  tr: 'Her Noel tüm aileyle bir araya geliriz, sevgili kocam.'
};
for (const [lang, story] of Object.entries(CHRISTMAS_STORIES)) {
  test(`buildPrompt [populara/${lang}]: poveste CU mentiune explicita de Craciun -> "not a Christmas carol" e OMIS (cerinta #7)`, () => {
    const prompt = buildPrompt(order({ lang, story }), '', null);
    assert.ok(!prompt.includes('not a Christmas carol'), prompt);
    assert.ok(Array.from(prompt).length <= 600);
  });
}

// ===================================================================================================
// 5) PLASA DE SIGURANTA / BUGET: EXACT scenariile cele mai incarcate deja documentate in
//    test/story-floor-occasion-fallback-fix.test.js (genul populara, folosit acolo ca stress-test)
//    — verificate direct aici (acel fisier are o problema PRE-EXISTENTA, neinrudita, de incarcare
//    CRLF/LF la boundary-ul sau de extractie, care il face sa arunce la nivel de modul inainte sa
//    ruleze vreun test — vezi server.js, comentariul din GENRE_STYLE_MAP.populara).
// ===================================================================================================
test('PLASA DE SIGURANTA: comanda reala 400d4a20 (populara/bunici, "Te iubesc") — mesajul explicit ajunge, relatia ramane identificabila, prompt <= 600', () => {
  const realOrder = {
    plan: 'video', lang: 'ro', genre: 'populara', occasion: 'bunici',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
    senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Nepoata',
    voicePreference: 'auto',
    story: 'Te iubesc bunica mea mai mult ca orice pe lume , multumesc ca mai crescut'
  };
  const prompt = buildPrompt(realOrder, '', null);
  assert.ok(Array.from(prompt).length <= 600, `lungime: ${Array.from(prompt).length}`);
  assert.ok(prompt.toLowerCase().includes('te iubesc'), prompt);
  assert.ok(prompt.includes('"grandmother"'), prompt);
});

test('PLASA DE SIGURANTA: comanda SI MAI incarcata (populara/bunici, grandparents+expeditor/relatie lungi+duet) — povestea NU dispare, prompt <= 600', () => {
  const heavierOrder = {
    plan: 'video', lang: 'ro', genre: 'populara', occasion: 'bunici',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandparents',
    senderName: 'Ana-Maria-Elisabeta', senderRole: 'granddaughter',
    relationship: 'Nepoata draga si iubita din tot sufletul',
    voicePreference: 'duet',
    story: 'Te iubesc bunica mea mai mult ca orice pe lume , multumesc ca mai crescut'
  };
  const prompt = buildPrompt(heavierOrder, '', null);
  assert.ok(Array.from(prompt).length <= 600, `lungime: ${Array.from(prompt).length}`);
  assert.ok(prompt.includes('Story/details to include:'), prompt);
});

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PACKAGES = ['standard', 'premium', 'video'];
const SHORT_STORY_BY_LANG = {
  ro: 'Te iubesc mult, multumesc pentru tot ce ai facut pentru mine.',
  en: 'I love you so much, thank you for everything you have done for me.',
  de: 'Ich liebe dich so sehr, danke fur alles, was du fur mich getan hast.',
  es: 'Te quiero mucho, gracias por todo lo que has hecho por mi.',
  it: 'Ti voglio tanto bene, grazie per tutto quello che hai fatto per me.',
  fr: "Je t'aime tellement, merci pour tout ce que tu as fait pour moi.",
  bg: 'Obicham te mnogo, blagodaria ti za vsichko, koeto napravi za men.',
  tr: 'Seni cok seviyorum, benim icin yaptigin her sey icin tesekkur ederim.'
};
for (const lang of LANGS) {
  for (const plan of PACKAGES) {
    test(`PLASA DE SIGURANTA [populara/${lang}/${plan}]: promptul ramane <= 600, povestea ajunge`, () => {
      const familyOrder = {
        plan, lang, genre: 'populara', occasion: 'bunici',
        recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
        senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Nepoata',
        voicePreference: 'auto', story: SHORT_STORY_BY_LANG[lang]
      };
      const prompt = buildPrompt(familyOrder, '', null);
      assert.ok(Array.from(prompt).length <= 600, `prompt depaseste 600 pentru ${lang}/${plan}`);
      const firstWord = SHORT_STORY_BY_LANG[lang].split(/\s+/)[0];
      assert.ok(prompt.includes(firstWord), `povestea lipseste complet din prompt pentru ${lang}/${plan}, primit: ${prompt}`);
    });
  }
}
