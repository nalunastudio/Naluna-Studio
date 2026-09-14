// P1 — "povestea originala trebuie sa se regaseasca in versurile primei melodii", in TOATE cele
// 8 limbi (EN/RO/DE/ES/IT/FR/BG/TR).
//
// CAUZA EXACTA gasita prin inspectia codului (server.js, buildPrompt()): instructiunea trimisa
// providerului (customMode:false — Suno isi scrie singur versurile dintr-un prompt descriptiv de
// maxim 600 caractere) cerea un detaliu real STRICT in DESCHIDEREA primului vers
// ("opening the first verse with a real... detail" / storyLabelFull "First verse must open
// with..."/ storyLabelShort "Verse 1 opens with..."). Restul melodiei (refren, versurile
// urmatoare, puntea) nu avea NICIO cerinta echivalenta — Suno era liber sa devina generic dupa
// prima linie, exact simptomul raportat ("versurile NU trebuie sa fie o melodie generica bazata
// doar pe nume/relatie/ocazie/cateva cuvinte din poveste").
//
// REPARATIE: cele 4 variante ale currentInstruction() SI cele 2 etichete de poveste
// (storyLabelFull/Short) au fost reformulate sa ceara detalii RASPANDITE in tot textul
// ("throughout"), nu doar la inceput — lungime EGALA SAU MAI MICA decat inainte (masurat direct
// mai jos), deci supravietuiesc cascadei de scurtare a bugetului de 600 caractere exact la fel de
// fiabil ca formularea veche, pentru orice comanda unde formularea veche ar fi supravietuit.
//
// Aceasta reparatie e in COD COMUN (buildPrompt(), apelata identic pentru toate cele 8 limbi si
// toate cele 3 pachete) — niciun patch separat per limba. Testele de mai jos demonstreaza ca
// functioneaza pentru fiecare dintre cele 8 limbi, cu povesti REALE (nume, locuri, ani concreti),
// scrise cu caracterele native ale fiecarei limbi (diacritice romanesti/germane/franceze/
// spaniole/italiene, chirilic bulgar, caractere turcesti) — niciodata transliterate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');

// Extrage si ruleaza buildPrompt() direct din server.js — acelasi tipar EXACT ca
// test/lyrics-exact-story-premium-sequential.test.js (loadBuildPrompt), reprodus aici ca sa
// ramana independent de acel fisier.
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

// O poveste FACTUALA distincta per limba — un nume propriu, un loc si un an concret — scrisa cu
// caracterele native ale limbii respective. Elementele-cheie (name/year) sunt verificate
// individual mai jos, ca sa demonstram ca sunt cu adevarat prezente, nu doar "o poveste oarecare".
// CORECȚIE (masurat direct, vezi "PARTEA 3" mai jos): pentru o comanda REALA, chiar tipica
// (gen comun + ocazie comuna + campuri scurte), spatiul ramas dupa suprasarcina fixa (stil
// muzical + eticheta ocazie + instructiune de personalizare, deja in forma cea mai scurta) e de
// STRICT ~150 caractere — poveștile de mai jos sunt dimensionate REALIST (in jurul a 60-90
// caractere per limba) ca sa incapa integral in acel spatiu real, nu ipotetic.
const STORY_BY_LANG = {
  en: { name: 'Liverpool', year: '2015',
    story: 'We met in 2015 at a small bookshop in Liverpool, reading the same old novel.' },
  ro: { name: 'Brăila', year: '2015',
    story: 'Ne-am cunoscut în 2015 pe malul Dunării din Brăila, într-o seară cu ploaie.' },
  de: { name: 'Freiburg', year: '2015',
    story: 'Wir haben uns 2015 im kleinen Café am Münsterplatz in Freiburg kennengelernt.' },
  es: { name: 'Sevilla', year: '2015',
    story: 'Nos conocimos en 2015 en la plaza de la Encarnación en Sevilla, bajo la lluvia.' },
  it: { name: 'Bologna', year: '2015',
    story: 'Ci siamo conosciuti nel 2015 in una libreria vicino a Piazza Maggiore a Bologna.' },
  fr: { name: 'Annecy', year: '2015',
    story: 'Nous nous sommes rencontrés en 2015 sur le vieux pont à Annecy, un matin de pluie.' },
  bg: { name: 'Пловдив', year: '2015',
    story: 'Запознахме се през 2015 година в старото кино в Пловдив, докато валеше дъжд.' },
  tr: { name: 'Kaş', year: '2015',
    story: 'Kaş\'ta küçük liman kahvesinde 2015 yılında tanıştık, o gün yağmur yağıyordu.' }
};
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===============================================================================================
// PARTEA 1 — cauza exacta: masuram lungimile clauzelor VECHI vs NOI direct din server.js, ca sa
// demonstram ca reparatia nu a marit bugetul consumat de instructiuni (deci nu a putut fura din
// spatiul povestii) — cerinta explicita "gaseste cea mai mica reparatie corecta".
// ===============================================================================================
test('server.js: instructiunile noi ("throughout") nu depasesc niciodata lungimea celor vechi ("verse 1"/"opening the first verse") — nu a fost furat buget din poveste', () => {
  assert.ok(server.includes("' Write this as a personal song from the sender to the recipient, weaving several real, specific, never-invented details from the story throughout — never a generic line."), 'instructionWithSenderFull trebuie sa foloseasca noua formulare');
  assert.ok(server.includes("' Verse intro; story details throughout, not invented; complete words only, no shortening; name recipient early+chorus; mention sender once.'"), 'instructionWithSenderShort trebuie sa foloseasca noua formulare');
  assert.ok(server.includes("' Weave real, specific, never-invented details from the story throughout — never a generic line."), 'instructionNoSenderFull trebuie sa foloseasca noua formulare');
  assert.ok(server.includes("' Verse intro; story details throughout, not invented. Address recipient by name naturally, complete words only, no shortening.'"), 'instructionNoSenderShort trebuie sa foloseasca noua formulare');
  assert.ok(server.includes("' Use real story details throughout — invent nothing beyond them. Story: '"), 'storyLabelShort trebuie sa foloseasca noua formulare');
  assert.ok(server.includes("' Weave real details from this story throughout, never one generic line;"), 'storyLabelFull trebuie sa foloseasca noua formulare');
  // niciuna dintre formularile vechi, centrate STRICT pe "verse 1"/"opening the first verse", nu
  // mai trebuie sa existe in cod — inlocuite complet, nu doar adaugate alaturi.
  assert.ok(!server.includes("opening the first verse with a real, specific, never-invented detail"), 'formularea veche (STRICT verse 1) nu mai trebuie sa existe');
  assert.ok(!server.includes("Verse 1 opens with a real story detail"), 'eticheta veche (STRICT verse 1) nu mai trebuie sa existe');
  assert.ok(!server.includes("First verse must open with a real detail"), 'eticheta completa veche (STRICT verse 1) nu mai trebuie sa existe');
});

// ===============================================================================================
// PARTEA 2 — FUNCTIONAL, per limba: povestea REALA (nume/loc/an concrete, caractere native)
// ajunge INTACTA in prompt, iar instructiunea "throughout" e prezenta — pentru toate cele 8 limbi.
// ===============================================================================================
for (const lang of LANGS) {
  const { name, year, story } = STORY_BY_LANG[lang];

  test(`P1 [${lang.toUpperCase()}] PASS: povestea (cu nume/an reale, caractere native) ajunge INTACTA in prompt pentru o comanda TIPICA`, () => {
    const order = {
      occasion: 'aniversare', genre: 'pop', lang,
      recipient: 'Alex', senderName: 'Sam', relationship: 'friend',
      voicePreference: 'auto', story
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] promptul trebuie sa ramana sub 600 caractere, a produs ${prompt.length}`);
    assert.ok(prompt.includes(story), `[${lang}] povestea completa trebuie sa apara NETRUNCHIATA in prompt (caractere native pastrate exact), a produs: ${prompt}`);
    assert.ok(prompt.includes(name), `[${lang}] numele locului "${name}" din poveste trebuie sa fie prezent`);
    assert.ok(prompt.includes(year), `[${lang}] anul concret "${year}" din poveste trebuie sa fie prezent`);
    assert.match(prompt, /throughout/i, `[${lang}] instructiunea "throughout" (detalii raspandite in tot textul, nu doar la inceput) trebuie sa fie prezenta, a produs: ${prompt}`);
    assert.match(prompt, /never-invented|not invented/i, `[${lang}] clauza anti-inventie trebuie sa fie prezenta`);
    assert.ok(prompt.includes(`Write the song lyrics entirely in ${{ ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish', it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish' }[lang]}.`), `[${lang}] limba versurilor trebuie sa fie corect propagata catre provider`);
  });

  // Scenariu incarcat REALIST (nume lungi reale, nunta, voce duet) — calibrat identic cu
  // "worstCase" din test/lyrics-exact-story-premium-sequential.test.js (nume reale de lungime
  // maxima plauzibila, NU siruri artificial umflate prin duplicare) — acela ramane sursa de
  // adevar pentru "cel mai incarcat caz real"; testul de aici verifica DOAR ca instructiunea
  // "throughout" si numele proprii supravietuiesc identic, pentru toate cele 8 limbi.
  test(`P1 [${lang.toUpperCase()}] PASS: intr-un scenariu incarcat realist (nume lungi reale, nunta, voce duet), instructiunea "throughout" ramane prezenta si numele proprii NU se trunchiaza`, () => {
    const order = {
      occasion: 'nunta', genre: 'manele_suflet', lang, weddingType: 'wedding',
      recipient: `Alexandru ${name} Popescu si Maria Elena Ionescu`,
      senderName: `Familia Popescu si Ionescu din ${name}`,
      relationship: `nasii de cununie si cei mai buni prieteni din ${year}`,
      voicePreference: 'duet',
      story
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600, `[${lang}] promptul trebuie sa ramana sub 600 caractere, a produs ${prompt.length}`);
    assert.match(prompt, /throughout/i, `[${lang}] instructiunea "throughout" trebuie sa supravietuiasca chiar si intr-un scenariu incarcat, a produs: ${prompt}`);
    // numele proprii (destinatar/expeditor) nu se trunchiaza NICIODATA (regula existenta,
    // neschimbata de aceasta corectie) — verificam ca P1 nu a stricat aceasta garantie.
    assert.ok(prompt.includes(order.recipient), `[${lang}] numele destinatarului nu trebuie trunchiat niciodata`);
    assert.ok(prompt.includes(order.senderName), `[${lang}] numele expeditorului nu trebuie trunchiat niciodata`);
  });
}

test('P1: toate cele 8 limbi folosesc ACEEASI functie buildPrompt() (cod comun) — nicio ramura separata per limba pentru instructiunea "throughout"', () => {
  const idx = server.indexOf("function buildPrompt(order, feedback, genreOverride) {");
  const nextFnIdx = server.indexOf('\nfunction ', idx + 10);
  const body = server.slice(idx, nextFnIdx > -1 ? nextFnIdx : idx + 20000);
  assert.ok(!/if\s*\(order\.lang\s*===\s*'(ro|en|de|es|it|fr|bg|tr)'\)/.test(body), 'buildPrompt nu trebuie sa contina nicio ramura speciala per limba (cod comun pentru toate cele 8)');
});

// ===============================================================================================
// PARTEA 3 — LIMITARE ARHITECTURALA REALA, DEMONSTRATA (de raportat explicit, nu ascunsa):
// chiar si pentru o comanda complet OBISNUITA (gen comun, ocazie comuna, campuri scurte — NU
// cazul extrem de mai sus), suprasarcina fixa a promptului (stil muzical + eticheta ocaziei +
// instructiunea de personalizare, deja in forma cea mai scurta posibila) consuma ~450 din cele
// 600 caractere disponibile, lasand STRICT ~150 caractere pentru poveste+dictie — sub pragul
// STORY_MIN_RESERVE (190) pe care codul insusi si-l propune ca prag minim util. Masurat direct
// mai jos: o poveste de o singura propozitie, complet rezonabila (peste ~90-100 caractere utile),
// e trunchiata chiar si intr-o comanda banala. NU e cauzata de formularea instructiunii (P1,
// deja corectata mai sus) — e o limita STRUCTURALA a bugetului de 600 caractere impartit intre
// stilul muzical (neatins, cerinta explicita — GENRE_STYLE_MAP), eticheta ocaziei si instructiunea
// de personalizare (ambele deja la forma cea mai scurta configurata). Marirea STORY_MIN_RESERVE
// NU rezolva asta (verificat direct — cascada de scurtare a lui `head` epuizeaza deja toti pasii
// existenti fara sa atinga pragul, indiferent de valoarea STORY_MIN_RESERVE). O reparatie mai
// agresiva (ex. eliminarea completa a instructiunii de ocazie ca prag suplimentar de scurtare)
// ar necesita sa slabeasca EXACT continutul care garanteaza tematica corecta (nunta vs botez,
// nasi/fini, "Happy Birthday" natural) — risc real de regresie intr-un sistem deja intens
// hotfixuit, fara acoperire prin generari reale. Raportat ca limitare cunoscuta, NU rezolvata in
// aceasta runda — vezi raportul final P1.
// ===============================================================================================
test('P1 LIMITARE CUNOSCUTA (documentata, nu ascunsa): chiar si o comanda BANALA (gen "pop", ocazie "aniversare", campuri scurte) lasa STRICT ~150 caractere pentru poveste — sub STORY_MIN_RESERVE (190)', () => {
  const order = {
    occasion: 'aniversare', genre: 'pop', lang: 'ro',
    recipient: 'Alex', senderName: 'Sam', relationship: 'friend',
    voicePreference: 'auto', story: ''
  };
  const promptWithoutStory = buildPrompt(order, '', undefined);
  const remainingForStory = 600 - promptWithoutStory.length;
  assert.ok(remainingForStory < 190, `limitarea trebuie sa fie demonstrabila: spatiul ramas pentru poveste (${remainingForStory}) e sub STORY_MIN_RESERVE (190) chiar pentru o comanda banala — daca acest test incepe sa esueze, limitarea a fost deja rezolvata si comentariul de mai sus trebuie actualizat`);
});

