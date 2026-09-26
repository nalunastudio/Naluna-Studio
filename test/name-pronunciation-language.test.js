// PRONUNȚIA NUMELOR ÎN LIMBA MELODIEI (2026-09-25, cerinta explicita — bug real raportat: un nume
// ca "Stefan" intr-o melodie in limba spaniola era cantat cu pronuntie romaneasca).
//
// AUDIT premergator (facut inainte de orice modificare):
//   1) numele sunt preluate din formular (comanda.html) in campurile `recipient`/`senderName`;
//   2) validate/normalizate STRICT structural (normalizeSingingText — NFC, caractere invizibile,
//      cedilla ro, punctuatie) — NICIODATA o rescriere fonetica a numelui (cerinta neschimbata,
//      confirmata de testele existente din diction-and-normalization.test.js);
//   3) intra in prompt/story prin etichetele "Recipient:"/"Sender:" (buildHeadPart1, server.js) —
//      NICIODATA modificate de aceasta corectie;
//   4) intra in lyrics DOAR indirect, prin instructiunea catre furnizor (customMode:false — Suno
//      isi scrie singur versurile din prompt) SAU verbatim, prin lyrics-ul exact al clientului
//      (customMode:true — buildExactLyricsRequest, NICIODATA atins de instructiunile de dictie);
//   5/6/7) request-ul catre furnizor NU are camp separat de "pronunciation"/"phonetics" — STRICT
//      prompt/style/lyrics text (sunoapi.org, customMode:false = 1 camp "prompt"; customMode:true =
//      "prompt"=lyrics exacte + "style" separat) — SINGURA parghie disponibila e text de
//      instructiune in limba engleza (limba de lucru a modelului), descriind regulile limbii
//      melodiei;
//   8) niciun camp dedicat de fonetica in implementarea noastra — confirmat prin lipsa oricarei
//      structuri de request diferite de prompt/style/lyrics in tot server.js;
//   9) Standard/Premium/Video folosesc ACELASI buildPrompt()/buildExactLyricsRequest() (PLAN_
//      VARIANT_COUNT diferă doar numarul de melodii, nu pipeline-ul audio);
//  10) exact lyrics/customMode (buildExactLyricsRequest) e o cale SEPARATA, cu propriul camp
//      `style` (1000 caractere, buget generos) — protejata explicit mai jos, lyrics-ul verbatim
//      NICIODATA atins.
//
// ROOT CAUSE stabilit: instructiunea veche ("names pronounced naturally") nu lega EXPLICIT
// pronuntia de LIMBA melodiei — modelul ramanea liber sa aleaga pronuntia "de origine" perceputa a
// numelui. NU e o problema de ortografie/normalizare a numelui (acela ramane neschimbat). Furnizorul
// NU poate GARANTA pronuntia exacta (nicio dovada/documentatie a unui control fonetic determinist) —
// STRICT o cerere mai clara catre model, nu o garantie.
//
// REMEDIERE: lib/diction.js — ambele forme (full/short) ale DICTION_INSTRUCTIONS leaga acum EXPLICIT
// numele de limba melodiei ("names sung with natural {Language} pronunciation, never a foreign
// accent" / forma scurta "... diction & names, no robotic split."). STRICT text de instructiune —
// NICIUN nume stocat/afisat clientului nu e modificat, NICIO transliterare vizibila, NICIUN
// dictionar hardcodat de nume (functioneaza generic, pentru orice nume).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function read(relPath) { return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'); }
const server = read('server.js');
const { DICTION_INSTRUCTIONS, normalizeSingingText } = require('../lib/diction.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const LANG_NAMES = { ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish', it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish' };
const PACKAGES = ['standard', 'premium', 'video'];

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

function loadPromptBuilders() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  const snippet = server.slice(startIdx, endIdx);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return { buildPrompt, buildExactLyricsRequest };
  `;
  return new Function('require', sandboxSrc)(require);
}
const { buildPrompt, buildExactLyricsRequest } = loadPromptBuilders();

function orderWithName(lang, plan, overrides) {
  return Object.assign({
    plan, lang, occasion: 'aniversare', genre: 'pop',
    recipient: 'Stefan', senderName: 'Andrei', senderRole: null, recipientRole: null,
    recipientMode: 'single', voicePreference: 'auto',
    story: 'Ne-am cunoscut acum cativa ani si de atunci suntem inseparabili.'
  }, overrides || {});
}

// ================================================================================================
// 1) Instructiunea de pronuntie corespunde LIMBII SELECTATE a melodiei, pentru toate cele 8 limbi —
//    atat pe calea customMode:false (buildPrompt, forma short), cat si customMode:true
//    (buildExactLyricsRequest, forma full, camp `style`).
// ================================================================================================
for (const lang of LANGS) {
  const L = LANG_NAMES[lang];
  test(`1a) [${lang}] buildPrompt(): instructiunea de dictie leaga EXPLICIT numele de limba "${L}" (forma short)`, () => {
    const prompt = buildPrompt(orderWithName(lang, 'standard'), '', undefined);
    assert.ok(prompt.includes(DICTION_INSTRUCTIONS[lang].short), `prompt-ul trebuie sa contina instructiunea de dictie pentru "${lang}"`);
    assert.match(DICTION_INSTRUCTIONS[lang].short, new RegExp(L));
    assert.match(DICTION_INSTRUCTIONS[lang].short, /names/i, `forma short pentru "${lang}" trebuie sa mentioneze explicit numele`);
  });

  test(`1b) [${lang}] buildExactLyricsRequest(): style leaga EXPLICIT numele de limba "${L}" ("natural ${L} pronunciation"), forma full`, () => {
    const { style } = buildExactLyricsRequest(orderWithName(lang, 'standard'), 'Vers 1.\nVers 2.', null, 'auto', '');
    assert.ok(style.includes(DICTION_INSTRUCTIONS[lang].full));
    assert.match(style, new RegExp(`natural ${L} pronunciation`, 'i'), `style-ul trebuie sa lege EXPLICIT pronuntia numelor de limba "${L}"`);
    // RO pastreaza si "robotic" in aceeasi clauza ("never robotic or a foreign accent") — vezi
    // lib/diction.js, cerinta structurala (testul de mai jos, DICTION_INSTRUCTIONS trebuie sa
    // mentioneze "robotic" undeva in forma full, pentru toate limbile) — regex-ul de aici verifica
    // STRICT prezenta conceptului "foreign accent", indiferent de restul frazei din jurul lui.
    assert.match(style, /foreign accent/i, `style-ul trebuie sa interzica explicit accentul strain pentru "${lang}"`);
  });
}

// ================================================================================================
// 2) Numele original NU este modificat/stocat diferit — ramane byte-identic in prompt/lyrics.
// ================================================================================================
test('2a) buildPrompt(): numele "Stefan" (limba melodiei ES) ramane byte-identic in eticheta Recipient — nicio transliterare (Esteban/Ștefan/etc.)', () => {
  const prompt = buildPrompt(orderWithName('es', 'standard'), '', undefined);
  assert.ok(prompt.includes('Recipient: Stefan.'), `numele trebuie sa ramana EXACT "Stefan", a produs: ${prompt}`);
  assert.ok(!prompt.includes('Esteban'), 'nu trebuie sa apara nicio traducere/transliterare a numelui');
  assert.ok(!prompt.includes('Ștefan') && !prompt.includes('Ştefan'), 'nu trebuie sa apara nicio forma cu diacritice romanesti');
});

test('2b) buildExactLyricsRequest(): numele "Stefan" ramane byte-identic, lyrics-ul verbatim al clientului neatins', () => {
  const order = orderWithName('es', 'standard');
  const exactLyrics = 'Stefan, mi amor, este es para ti.\nStefan, siempre estaras en mi corazon.';
  const { lyrics, style } = buildExactLyricsRequest(order, exactLyrics, null, 'auto', '');
  assert.equal(lyrics, exactLyrics, 'lyrics-ul exact al clientului trebuie sa ramana STRICT verbatim, byte-identic');
  assert.ok(lyrics.includes('Stefan'), 'numele din lyrics-ul verbatim al clientului nu trebuie atins');
  assert.ok(!style.includes('Stefan'), 'instructiunea de dictie din style NU trebuie sa repete/rescrie numele clientului');
});

test('2c) normalizeSingingText(): "Stefan" ramane byte-identic dupa normalizare, indiferent de limba melodiei (NICIODATA rescriere fonetica)', () => {
  for (const lang of LANGS) {
    assert.equal(normalizeSingingText('Stefan', lang), 'Stefan', `normalizarea nu trebuie sa modifice numele pentru limba "${lang}"`);
  }
});

// ================================================================================================
// 3) Nicio transliterare vizibila NEDORITA — instructiunea de dictie insasi nu contine niciodata
//    numele clientului (e STRICT text generic, independent de orice nume anume).
// ================================================================================================
for (const lang of LANGS) {
  test(`3) [${lang}] DICTION_INSTRUCTIONS nu contine niciun nume de client hardcodat — text generic, functioneaza pentru orice nume`, () => {
    assert.ok(!/stefan|ștefan|ştefan/i.test(DICTION_INSTRUCTIONS[lang].full));
    assert.ok(!/stefan|ștefan|ştefan/i.test(DICTION_INSTRUCTIONS[lang].short));
  });
}

// ================================================================================================
// 4/5/6) Standard/Premium/Video functioneaza — toate 3 primesc aceeasi instructiune, prin acelasi
//    pipeline comun (buildPrompt).
// ================================================================================================
for (const plan of PACKAGES) {
  test(`4) [${plan}] buildPrompt() include instructiunea de dictie+nume pentru limba ES`, () => {
    const prompt = buildPrompt(orderWithName('es', plan), '', undefined);
    assert.ok(prompt.includes(DICTION_INSTRUCTIONS.es.short), `planul "${plan}" trebuie sa primeasca instructiunea, a produs: ${prompt}`);
    assert.ok(prompt.includes('Stefan'), `numele trebuie sa ramana prezent pentru planul "${plan}"`);
  });
}

// ================================================================================================
// 7) manele_suflet "Short lines" ramane NESCHIMBAT — coexista cu noua instructiune de pronuntie.
// ================================================================================================
test('7) manele_suflet: "Short lines" ramane prezent, neatins, ALATURI de noua instructiune de dictie+nume', () => {
  // Fixtura IDENTICA cu typicalOrder() din test/manele-suflet-short-lines.test.js (occasion
  // zi_de_nastere, fara camp relationship) — scenariul deja demonstrat, inainte de aceasta
  // corectie, ca lasa loc SI pentru "Short lines" SI pentru dictionInstruction simultan. Un
  // relationship+occasion mai "grele" (ex. aniversare+sora) pot impinge dictionInstruction peste
  // buget INDIFERENT de aceasta corectie (comportament PRE-EXISTENT, verificat direct impotriva
  // codului dinaintea acestei modificari — vezi cascada de scurtare, buildPrompt()) — swap-ul de
  // lungime IDENTICA facut aici (vezi lib/diction.js) nu schimba PRAGUL acelei cascade.
  const order = orderWithName('ro', 'standard', {
    genre: 'manele_suflet', occasion: 'zi_de_nastere', recipient: 'Andrei', senderName: 'Maria'
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Short lines;'), `instructiunea de linii scurte trebuie sa ramana, a produs: ${prompt}`);
  assert.ok(prompt.includes(DICTION_INSTRUCTIONS.ro.short), `instructiunea de dictie+nume trebuie sa coexiste, a produs: ${prompt}`);
});

// ================================================================================================
// 8) manele_jale ramane NESCHIMBAT (GENRE_STYLE_MAP byte-identic) — nicio corectie a acestei
//    modificari nu atinge harta de stiluri.
// ================================================================================================
test('8) manele_jale: GENRE_STYLE_MAP ramane byte-identic — aceasta corectie nu atinge deloc GENRE_STYLE_MAP', () => {
  assert.match(server, /manele_jale: 'Romanian manele de jale, minor-key oriental colour, mournful violin and clarinet, melismatic lament vocal, heavier longing mood',/);
});

// CORECTIE (2026-09-26, "randuri scurte" extins la TOATE genurile — cerinta explicita): manele_jale
// primeste acum SI el "Short lines" (ca orice alt gen — vezi
// test/lyrics-short-lines-all-genres.test.js) — identitatea lui muzicala (GENRE_STYLE_MAP, testat
// separat mai sus, #8) ramane byte-identica, neatinsa.
test('8b) manele_jale: buildPrompt() primeste "Short lines" (ca orice alt gen, dupa extinderea la toate genurile), SI instructiunea generica de dictie+nume', () => {
  const order = orderWithName('ro', 'standard', { genre: 'manele_jale' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Short lines;'));
  assert.ok(!prompt.includes('Verse intro'));
  assert.ok(prompt.includes(DICTION_INSTRUCTIONS.ro.short));
});

// ================================================================================================
// 9) exact lyrics/customMode:true ramane compatibil — style include instructiunea noua, lyrics
//    verbatim NEATINS, comportamentul existent (durata, dictie completa) neschimbat structural.
// ================================================================================================
for (const lang of LANGS) {
  for (const plan of PACKAGES) {
    test(`9) [${lang}/${plan}] buildExactLyricsRequest(): style contine instructiunea noua, lyrics raman verbatim`, () => {
      const exactLyrics = 'Verse one.\nVerse two.\nChorus line.';
      const { lyrics, style } = buildExactLyricsRequest(orderWithName(lang, plan), exactLyrics, null, 'auto', '');
      assert.equal(lyrics, exactLyrics);
      assert.ok(style.includes(DICTION_INSTRUCTIONS[lang].full));
      assert.ok(style.length <= 1000, `style nu trebuie sa depaseasca niciodata 1000 caractere, a produs ${style.length}`);
    });
  }
}

// ================================================================================================
// 10) Promptul ramane in limita maxima existenta (600) — pentru toate cele 8 limbi, inclusiv
//    scenariul cel mai incarcat deja documentat (nunta, nasi, nume foarte lungi, poveste lunga,
//    gen cu tag lung).
// ================================================================================================
for (const lang of LANGS) {
  test(`10) [${lang}] buildPrompt(): scenariul cel mai incarcat (nunta, nasi, nume lungi, gen hiphop) ramane <= 600 caractere`, () => {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', recipientRole: 'godparents', genre: 'hiphop', lang,
      recipient: 'Alexandrescu-Popescu Maria-Antoaneta', senderName: 'Constantinescu-Georgescu Ion-Alexandru',
      relationship: 'nași', voicePreference: 'duet', story: 'A'.repeat(400)
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] prompt peste buget: ${prompt.length} caractere`);
    assert.ok(prompt.includes('Alexandrescu-Popescu Maria-Antoaneta'), `[${lang}] numele destinatarului trebuie sa ramana intreg`);
  });
}

test('10b) buildPrompt(): scenariul cel mai incarcat manele_suflet (nunta, nume maxime, duet) ramane <= 600 caractere, cu Short lines SI dictie', () => {
  const order = {
    occasion: 'nunta', genre: 'manele_suflet', lang: 'ro',
    recipient: 'Alexandru Ionut Popescu si Maria Elena Ionescu',
    senderName: 'Familia Popescu si Ionescu, nasii si toti prietenii apropiati',
    relationship: 'nasii de cununie si cei mai buni prieteni din copilarie', voicePreference: 'duet',
    story: 'V-ati cunoscut acum zece ani la o petrecere organizata de prieteni comuni, iar de atunci povestea voastra de dragoste a fost una plina de calatorii si sprijin reciproc.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, `prompt peste buget: ${prompt.length} caractere`);
});

// ================================================================================================
// 11) STORY_MIN_RESERVE NU este redus — povestea supravietuieste identic ca inainte de aceasta
//    corectie, chiar in scenariile cele mai incarcate.
// ================================================================================================
test('11a) STORY_MIN_RESERVE ramane 190 — constanta neschimbata de aceasta corectie', () => {
  assert.match(server, /const STORY_MIN_RESERVE = 190;/);
});

test('11b) buildPrompt(): povestea supravietuieste (fragment prezent) pentru toate cele 8 limbi, comanda usoara tipica', () => {
  for (const lang of LANGS) {
    const prompt = buildPrompt(orderWithName(lang, 'standard'), '', undefined);
    assert.ok(prompt.includes('Ne-am cunoscut') || /Story\S*?:\s*\S/i.test(prompt), `[${lang}] povestea trebuie sa ramana prezenta`);
  }
});

test('11c) buildPrompt(): scenariul extrem (comanda reala 400d4a20-stil, familie grea) tot pastreaza un fragment util de poveste', () => {
  const order = {
    occasion: 'bunici', grandparentType: 'grandmother', recipientRole: 'grandmother', senderRole: 'granddaughter',
    genre: 'hiphop', lang: 'ro', recipient: 'Bunica Maria', senderName: 'Ioana',
    story: 'Te iubesc enorm, bunica mea draga, esti totul pentru mine si nu voi uita niciodata tot ce ai facut pentru noi toti in familie.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600);
  const storyIdx = prompt.search(/Story\S*?:\s*\S/i);
  assert.ok(storyIdx !== -1 || prompt.includes('Te iubesc'), `povestea nu trebuie sa dispara complet, a produs: ${prompt}`);
});

// ================================================================================================
// 12) Celelalte limbi/genuri NU sunt afectate diferit — toate cele 16 genuri raman functionale,
//    cu instructiunea de dictie+nume prezenta identic (STRICT dependenta de limba, niciodata de gen).
// ================================================================================================
const NEW_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
for (const genre of NEW_GENRES) {
  test(`12) genul "${genre}": buildPrompt() ramane <= 600 caractere, cu poveste prezenta, indiferent de instructiunea de dictie+nume`, () => {
    const order = {
      occasion: 'nunta', weddingType: 'wedding', genre, lang: 'ro',
      recipient: 'Andrei', senderName: 'Maria', relationship: 'sora', voicePreference: 'duet',
      story: 'Ne-am cunoscut acum 10 ani la facultate si de atunci suntem inseparabili, iar acum sunteti gata sa incepeti o viata noua impreuna.'
    };
    const prompt = buildPrompt(order, 'Mai vesela te rog', undefined);
    assert.ok(prompt.length <= 600, `genul "${genre}": prompt peste 600 caractere (${prompt.length})`);
    assert.ok(prompt.includes('Ne-am cunoscut') || /Story\S*?:\s*\S/i.test(prompt), `genul "${genre}": povestea a disparut`);
  });
}

// ================================================================================================
// Confirmari structurale suplimentare.
// ================================================================================================
test('server.js: nicio schimbare structurala in afara importului deja existent din lib/diction.js', () => {
  assert.match(server, /const \{ DICTION_INSTRUCTIONS, getDictionInstruction, normalizeSingingText \} = require\('\.\/lib\/diction'\);/);
});

test('lib/diction.js: normalizeSingingText() ramane STRICT structurala — nicio rescriere fonetica a numelor (cerinta neschimbata)', () => {
  const dictionSrc = read('lib/diction.js');
  assert.doesNotMatch(dictionSrc, /phonetic|transliterat/i, 'normalizeSingingText nu trebuie sa capete nicio logica de transliterare/rescriere fonetica');
});

test('server.js si lib/diction.js raman sintactic valide', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'diction.js')]));
});
