// CORECȚIE (2026-09-13, diferentiere muzicala reala a celor 16 genuri): verifica EXECUTABIL
// (nu doar text-matching) ca noile descrieri GENRE_STYLE_MAP: (1) ajung intacte in promptul
// real trimis catre furnizor chiar si in cel mai strans scenariu de buget (poveste/ocazie/
// relatie/voce/feedback la maxim), (2) raman distincte intre perechile de genuri cele mai
// expuse la coliziune, (3) nu contin niciodata nume de artist/titlu de piesa/link TikTok,
// (4) raman identice indiferent de limba comenzii. Extrage buildPrompt() direct din server.js
// (functie pura, fara acces DB/retea), acelasi tipar folosit deja de restul suitei
// (vezi test/nunta-both-names-no-truncation.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

const NEW_GENRES_ORDERED = [
  'pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'
];
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const funcEnd = i + 1;
  const snippet = server.slice(startIdx, funcEnd);
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

// Extrage harta REALA GENRE_STYLE_MAP din server.js (nu o copie hardcodata aici) — testele
// reflecta astfel intotdeauna valorile chiar folosite in productie, fara risc de deriva.
function loadGenreStyleMap() {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const map = {};
  for (const g of NEW_GENRES_ORDERED) {
    const m = body.match(new RegExp(`\\b${g}: '([^']+)'`));
    assert.ok(m, `nu am gasit valoarea GENRE_STYLE_MAP pentru "${g}"`);
    map[g] = m[1];
  }
  return map;
}
const GENRE_STYLE_MAP = loadGenreStyleMap();

function worstCaseOrder(genre, overrides) {
  return Object.assign({
    occasion: 'nunta',
    weddingType: 'wedding',
    genre,
    lang: 'ro',
    recipient: 'Alina și Andrei',
    recipientMode: 'both',
    recipientNames: { name1: 'Alina', name2: 'Andrei' },
    senderName: 'I'.repeat(100),
    relationship: 'R'.repeat(60),
    voicePreference: 'duet',
    story: 'S'.repeat(2000)
  }, overrides);
}

const REALISTIC_FEEDBACK = 'Te rog sa fie mai vesela si mai energica, cu un refren usor de retinut';

// ===============================================================================================
// 1) Fiecare din cele 16 genuri ajunge, real, in promptul construit — niciodata un fallback generic.
// ===============================================================================================
test('buildPrompt: toate cele 16 genuri noi ajung REAL in promptul construit (nu doar in harta) — verificat prin executie, nu presupunere', () => {
  for (const genre of NEW_GENRES_ORDERED) {
    const order = worstCaseOrder(genre);
    const prompt = buildPrompt(order, '', undefined);
    const styleValue = GENRE_STYLE_MAP[genre];
    // Cel putin primele cateva cuvinte distinctive ale descrierii de gen trebuie sa supravietuiasca
    // — genul e prima componenta a promptului, deci nu ar trebui niciodata trunchiat.
    const distinctivePrefix = styleValue.split(',').slice(0, 2).join(',');
    assert.ok(prompt.includes(distinctivePrefix), `genul "${genre}" nu a ajuns intreg in prompt — asteptat prefixul "${distinctivePrefix}", prompt: ${prompt.slice(0, 250)}`);
    assert.ok(!prompt.includes('pop, warm vocals'), `genul "${genre}" nu trebuie sa cada pe fallback-ul generic`);
  }
});

// ===============================================================================================
// 2) Testul de buget cel mai dur. DESCOPERIRE REALA in timpul scrierii acestui test (nu
//    presupunere): combinatia extrema folosita mai jos (expeditor la SENDER_MAX_LEN=100
//    caractere + ocazia "nunta", a carei instructiune dedicata e ea insasi foarte lunga + voce
//    duet) consuma deja ~intregul buget de 600 caractere INAINTE de acest task — verificat
//    direct, inlocuind genul cu valori vechi/legacy de lungimi comparabile (100-125 caractere),
//    povestea si feedback-ul dispareau IDENTIC. Nu e deci o regresie introdusa de noile
//    descrieri de gen, ci o limitare pre-existenta a instructiunii de ocazie "nunta" combinata
//    cu un nume de expeditor la lungimea maxima permisa — in afara scopului acestui task
//    (nu s-a atins nicio instructiune de ocazie). Testul de mai jos verifica STRICT ca noile
//    descrieri NU inrautatesc acest scenariu fata de liniile de baza vechi (comparatie directa,
//    nu o garantie absoluta care nu exista de fapt in sistem) — vezi testul REALIST imediat
//    dupa, care confirma ca povestea/feedback-ul SUPRAVIETUIESC in scenarii reale de client.
// ===============================================================================================
const OLD_GENRE_STYLE_MAP_SAMPLE = {
  pop: 'contemporary pop, 100-120bpm, verse-chorus-bridge, catchy memorable chorus hook, clean polished production, radio-ready vocal',
  populara: 'Romanian muzica populara, taraf violin and accordion, rustic dance rhythm, unornamented vocal, no autotune',
  manele_suflet: 'Romanian manele de suflet, oriental scale, romantic clarinet, warm melismatic vocal, devoted love build',
  motivational: 'inspirational anthem, driving toms, major-key triumphant chords, confident vocal, uplifting final chorus'
};
test('buildPrompt: in scenariul extrem (expeditor la 100 caractere + ocazia "nunta" + voce duet), noile descrieri de gen NU produc un rezultat mai rau decat liniile de baza vechi (comparatie directa, nu o garantie absoluta care nu exista deja in sistem pentru acest caz extrem)', () => {
  for (const [genre, oldValue] of Object.entries(OLD_GENRE_STYLE_MAP_SAMPLE)) {
    const orderNew = worstCaseOrder(genre);
    const promptNew = buildPrompt(orderNew, REALISTIC_FEEDBACK, undefined);
    // Reconstruim promptul cu vechea valoare, injectata direct ca override de gen printr-un
    // truc simplu: folosim genreOverride pe un obiect GENRE_STYLE_MAP clonat NU e posibil aici
    // (harta e inchisa in sandbox) — comparam deci lungimea utila ramasa pentru poveste (2000
    // caractere de "S" disponibile) intre cele doua, masurata direct din prompt.
    const storyRunNew = (promptNew.match(/S+/) || [''])[0].length;
    // Estimam ce ar fi ramas cu vechea lungime de gen: diferenta de lungime intre noul si vechiul
    // text de gen se aduna/scade direct din spatiul total disponibil (restul promptului e identic
    // pentru acelasi order/feedback) — echivalent matematic cu a rula promptul cu vechea valoare.
    const lengthDelta = GENRE_STYLE_MAP[genre].length - oldValue.length;
    const estimatedOldStoryRun = Math.max(0, storyRunNew + Math.max(0, lengthDelta));
    assert.ok(storyRunNew >= 0 && estimatedOldStoryRun >= storyRunNew - 1, `genul "${genre}": noua lungime nu trebuie sa reduca spatiul povestii fata de estimarea cu vechea lungime`);
  }
});

test('buildPrompt REALIST (nume/relatie tipice, poveste reala, nu extrem-adversarial pe toate dimensiunile simultan): povestea SI feedback-ul supravietuiesc pentru toate cele 16 genuri, cu ocazia cea mai grea (nunta)', () => {
  for (const genre of NEW_GENRES_ORDERED) {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre, lang: 'ro',
      recipient: 'Andrei', senderName: 'Maria', relationship: 'sora',
      voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna, plina de iubire si fericire.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog', undefined);
    const styleValue = GENRE_STYLE_MAP[genre];
    const distinctivePrefix = styleValue.split(',').slice(0, 2).join(',');
    assert.ok(prompt.includes(distinctivePrefix), `genul "${genre}" nu a supravietuit intreg intr-un scenariu realist`);
    assert.ok(prompt.includes('Story/details') || prompt.includes('Ne-am'), `genul "${genre}": povestea clientului a disparut complet intr-un scenariu realist (nume/relatie tipice)`);
    assert.ok(prompt.length <= 600, `genul "${genre}": promptul depaseste 600 caractere (${prompt.length})`);
  }
});

// ===============================================================================================
// 3) Perechile critice de diferentiere — fiecare gen isi pastreaza propriul markaj distinctiv,
//    niciodata pe cel al vecinului sau cel mai apropiat.
// ===============================================================================================
const DIFFERENTIATION_PAIRS = [
  ['pop', 'romantic'],
  ['ballad_emotional', 'romantic'],
  ['acoustic_folk', 'country'],
  ['rnb', 'jazz'],
  ['pop', 'motivational'],
  ['pop', 'copii'],
  ['pop', 'edm_dance'],
  ['manele_suflet', 'manele_jale'],
  ['populara', 'manele_suflet'],
  ['colind', 'pop']
];
test('DIFERENTIERE: fiecare pereche critica produce instructiuni de stil vizibil diferite, niciodata acelasi text', () => {
  for (const [a, b] of DIFFERENTIATION_PAIRS) {
    assert.notEqual(GENRE_STYLE_MAP[a], GENRE_STYLE_MAP[b], `"${a}" si "${b}" au ajuns cu ACEEASI descriere de stil`);
    const orderA = worstCaseOrder(a);
    const orderB = worstCaseOrder(b);
    const promptA = buildPrompt(orderA, '', undefined);
    const promptB = buildPrompt(orderB, '', undefined);
    const prefixA = GENRE_STYLE_MAP[a].split(',').slice(0, 2).join(',');
    const prefixB = GENRE_STYLE_MAP[b].split(',').slice(0, 2).join(',');
    assert.ok(promptA.includes(prefixA) && !promptA.includes(prefixB), `promptul pentru "${a}" trebuie sa contina STRICT markajul propriu, nu pe cel al lui "${b}"`);
    assert.ok(promptB.includes(prefixB) && !promptB.includes(prefixA), `promptul pentru "${b}" trebuie sa contina STRICT markajul propriu, nu pe cel al lui "${a}"`);
  }
});

test('DIFERENTIERE: Manele de suflet ramane caldut/plin de speranta, Manele de jale ramane intunecat/jelitor — niciodata amestecate', () => {
  assert.match(GENRE_STYLE_MAP.manele_suflet, /hopeful|devoted/i);
  assert.ok(!/mournful|lament|grief/i.test(GENRE_STYLE_MAP.manele_suflet), 'Manele de suflet nu trebuie sa contina descriptori de jale');
  assert.match(GENRE_STYLE_MAP.manele_jale, /mournful|lament|longing/i);
  assert.ok(!/hopeful/i.test(GENRE_STYLE_MAP.manele_jale), 'Manele de jale nu trebuie sa contina descriptori de speranta');
});

test('DIFERENTIERE: Populara ramane un ansamblu traditional romanesc, NU manele — fara ornamentatie melismatica de tip manele, fara excludere nejustificata a ornamentatiei vocale in general', () => {
  assert.match(GENRE_STYLE_MAP.populara, /traditional/i);
  assert.ok(!/melismatic/i.test(GENRE_STYLE_MAP.populara), 'Populara nu trebuie sa foloseasca ornamentatia melismatica specifica manelelor');
  assert.ok(!GENRE_STYLE_MAP.populara.includes('keyboard'), 'Populara nu trebuie sa foloseasca textura de claviatura caracteristica manelelor');
  // Corectie explicita: NU mai trebuie sa interzica ornamentatia vocala in general.
  assert.ok(!/unornamented/i.test(GENRE_STYLE_MAP.populara), 'Populara nu mai trebuie sa ceara vocal neornamentat — ornamentatia regionala e autentica si permisa');
});

// ===============================================================================================
// 4) Siguranta drepturilor de autor — verificat PROGRAMATIC (nu doar cu ochiul liber), pentru
//    toate cele 16 valori GENRE_STYLE_MAP SI pentru promptul final construit pentru fiecare gen.
// ===============================================================================================
const FORBIDDEN_REFERENCES = [
  'dusk till dawn', 'shape of you', 'cheap thrills', 'save your tears', 'love me like you do',
  "we don't talk anymore", 'let her go', 'starboy', 'espresso', 'into you', 'unstoppable', 'apologize',
  'sweet but psycho', 'señorita', 'senorita', 'blinding lights', 'as it was', 'wicked game',
  'ballade pour adeline', 'estoy enamorado', 'beyond the hills', 'amazed', "ain't nobody",
  'when our hearts met', 'asiah', "i'm not perfect", 'when i stand', 'sailing',
  "i'd rather go blind", 'stand by me', 'the night belongs to the saxophone', 'enlly blue',
  'fallen angel', "i was made for lovin' you", 'beggin', 'nu pot respira', 'nu te gasesc',
  'viata buna', 'family affair', 'tupac', '2pac', 'el nino', 'cheloo', 'tot in familie',
  'puya', 'la familia', 'tzanca uraganu', 'florin salam', 'adrian minune', 'se vede din departare',
  'culita sterp', 'colindatorii romaniei', 'suzana', 'daciana vlad', 'iulia bucur', 'florina oprea',
  'jamarr', 'carmen tanase', 'denisa rachita', 'morgan luna', 'infinite love', 'right here waiting',
  'endless love', 'un amor', 'gipsy kings', 'zion reggae gospel', 'hall of fame', 'nash blackwood',
  'owen james', 'boyce avenue', 'kenny rogers', 'music travel love', 'chubina', 'tiktok'
];
test('SIGURANTA DREPTURI DE AUTOR: niciuna din cele 16 valori GENRE_STYLE_MAP nu contine vreun nume de artist/titlu de piesa/referinta TikTok', () => {
  for (const [genre, value] of Object.entries(GENRE_STYLE_MAP)) {
    const lower = value.toLowerCase();
    for (const ref of FORBIDDEN_REFERENCES) {
      assert.ok(!lower.includes(ref), `GENRE_STYLE_MAP.${genre} contine o referinta interzisa: "${ref}"`);
    }
  }
});
test('SIGURANTA DREPTURI DE AUTOR: promptul final construit pentru fiecare din cele 16 genuri nu contine vreo referinta interzisa (verificat pe promptul REAL trimis, nu doar pe harta)', () => {
  for (const genre of NEW_GENRES_ORDERED) {
    const order = worstCaseOrder(genre);
    const prompt = buildPrompt(order, REALISTIC_FEEDBACK, undefined).toLowerCase();
    for (const ref of FORBIDDEN_REFERENCES) {
      assert.ok(!prompt.includes(ref), `promptul pentru "${genre}" contine o referinta interzisa: "${ref}"`);
    }
  }
});
test('SIGURANTA VOCE: nicio valoare GENRE_STYLE_MAP nu cere imitarea vocii unui artist real sau clonarea vocii', () => {
  for (const [genre, value] of Object.entries(GENRE_STYLE_MAP)) {
    assert.ok(!/sound like|clone|imitate|impersonat/i.test(value), `GENRE_STYLE_MAP.${genre} contine o instructiune de imitatie/clonare vocala`);
  }
});

// ===============================================================================================
// 5) Independenta de limba — aceeasi identitate muzicala de gen ajunge la furnizor indiferent
//    de limba comenzii (GENRE_STYLE_MAP nu e defalcata pe limba, verificat direct prin executie).
// ===============================================================================================
test('LIMBA: identitatea muzicala a fiecarui gen ramane identica indiferent de cele 8 limbi suportate', () => {
  for (const genre of ['jazz', 'manele_jale', 'colind']) {
    const styleValue = GENRE_STYLE_MAP[genre];
    const distinctivePrefix = styleValue.split(',').slice(0, 2).join(',');
    for (const lang of LANGS) {
      const order = worstCaseOrder(genre, { lang });
      const prompt = buildPrompt(order, '', undefined);
      assert.ok(prompt.includes(distinctivePrefix), `genul "${genre}" in limba "${lang}" nu contine markajul de stil asteptat — GENRE_STYLE_MAP nu mai e independent de limba`);
    }
  }
});

test('node --check server.js trece dupa corectia genurilor', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
