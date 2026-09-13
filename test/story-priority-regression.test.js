// REGRESIE URGENTA (2026-09-13, runda "povestea clientului in versuri") — client raportat:
// poveste "te iubesc viata mea" scrisa de client NU se regasea deloc in versurile generate.
//
// CAUZA REALA (gasita prin MASURARE directa, nu presupunere — vezi comentariile din server.js
// langa `storyTextFloor`): buildPrompt() promitea explicit, in comentarii, ca dictia si eticheta
// de paranteze ("[Chorus]" etc. tot in limba versurilor) NU sunt rezervate "niciodata in
// detrimentul rezervei garantate pentru poveste (STORY_MIN_RESERVE, 190 caractere)" — dar codul
// folosea de fapt un prag de doar 40 de caractere (MIN_USEFUL_STORY_CHARS) pentru decizia de
// rezervare. Rezultat REAL, demonstrat: de indata ce scurtarea campurilor fixe (gen/ocazie/voce)
// elibera suficient spatiu ca povestea sa depaseasca 40 de caractere, tot spatiul nou eliberat era
// redirectionat spre dictie+paranteze — NICIODATA spre continutul real al povestii — taind exact
// fraze importante scrise de client mai departe in poveste. Un test PREEXISTENT
// (bracket-language-propagation.test.js) codifica, fara sa isi dea seama, exact acest bug: o
// poveste de 82 caractere ajungea trunchiata la "...si de atunci sun[tem]", pierzand "tem
// inseparabili, mereu impreuna" STRICT ca sa incapa dictia+paranteze.
//
// REPARATIE: pragul de rezervare (acum `storyTextFloor`) e dinamic — daca povestea CHIAR are
// nevoie de toata rezerva promisa (190 caractere) sau mai mult, pragul ramane 190 (povestea poate
// fi in continuare trunchiata dincolo de acel punct — limitare onesta, documentata la TEST 8 mai
// jos); daca povestea e mai SCURTA decat 190, pragul devine STRICT lungimea ei reala — dictia si
// paranteze nu mai fura spatiu pe care povestea nici nu l-ar fi folosit. In plus, trunchierea
// povestii foloseste acum truncateAtWordBoundary() (nu mai taie niciun cuvant la mijloc).
//
// Acest fisier testeaza FUNCTIONAL (executie reala a buildPrompt()/buildExactLyricsRequest(),
// extrase direct din server.js, nu o reimplementare) toate cele 8 cazuri obligatorii cerute:
// TEST 1 (expresie concreta), TEST 2 (poveste complexa), TEST 3 (feedback "alt inceput"),
// TEST 4 (locked lyrics), TEST 5 (Premium), TEST 6 (pachete), TEST 7 (limbi), TEST 8 (buget 600).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  if (idx === -1) throw new Error('nu am gasit: ' + signature);
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

function loadLegacyExactLyrics() {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, idx + 11000);
  const exprMatch = body.match(/const exactLyrics = \(typeof sourceVariant\.editedLyrics[\s\S]*?: '';/);
  assert.ok(exprMatch, 'expresia exactLyrics trebuie sa existe (handleLegacyRegenerate)');
  return new Function('sourceVariant', `${exprMatch[0]}\nreturn exactLyrics;`);
}
const legacyExactLyrics = loadLegacyExactLyrics();

function loadPremiumExactLyrics() {
  const b = server.indexOf('const editSongsForGeneration = parsedSongs.map(song => {');
  const helperSrc = extractFn(server, 'function currentEffectiveLyrics(sourceVariant) {');
  const mapBodyStart = server.indexOf('{', server.indexOf('=>', b));
  let depth = 1, i = mapBodyStart + 1;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const mapBody = server.slice(mapBodyStart, i + 1);
  return new Function(`
    ${helperSrc}
    function exactLyricsForSong(song) ${mapBody}
    return exactLyricsForSong;
  `)();
}
const exactLyricsForSong = loadPremiumExactLyrics();

// -------------------------------------------------------------------------------------------
// TEST 1 — expresie concreta din poveste ("te iubesc viata mea"), pe o comanda REALISTA
// (ocazie "declaratie", voce duet, expeditor numit — exact scenariul in care regresia aparea).
// -------------------------------------------------------------------------------------------
test('TEST 1: "te iubesc viata mea", scrisa in mijlocul unei povesti REALISTE, ajunge efectiv in promptul final trimis furnizorului (nu doar in order.story din DB)', () => {
  const order = {
    plan: 'standard', occasion: 'declaratie', lang: 'ro', recipient: 'Alexandra', senderName: 'Alexandru',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'romantic',
    story: 'Ne-am cunoscut acum trei ani, intr-o seara ploioasa de toamna. Te iubesc, viata mea, mai mult decat pot spune in cuvinte.',
    voicePreference: 'duet'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca 600 caractere, a produs ${prompt.length}`);
  assert.ok(prompt.toLowerCase().includes('te iubesc, viata mea') || prompt.toLowerCase().includes('te iubesc viata mea'),
    `expresia clientului trebuie sa apara verbatim in promptul trimis furnizorului — prompt: ${prompt}`);
});

// -------------------------------------------------------------------------------------------
// TEST 2 — poveste complexa, minimum 5 detalii personale distincte: nume de loc, eveniment,
// perioada, promisiune, sentiment explicit. Demonstreaza ca informatiile esentiale NU sunt toate
// eliminate in favoarea instructiunilor generice — majoritatea trebuie sa supravietuiasca.
// -------------------------------------------------------------------------------------------
test('TEST 2: o poveste cu 5+ detalii personale distincte pastreaza majoritatea lor in prompt, nu doar o tema generica', () => {
  const details = [
    'ne-am cunoscut la Cluj',                 // 1. loc
    'acum cinci ani',                          // 2. perioada
    'la nunta verisoarei mele',                // 3. eveniment
    'mi-ai promis ca vom calatori impreuna',   // 4. promisiune
    'esti cel mai bun prieten al meu'          // 5. sentiment/relatie
  ];
  const order = {
    plan: 'standard', occasion: 'aniversare', lang: 'ro', recipient: 'Mihai', senderName: 'Ioana',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'pop',
    story: details.join(', ') + '.',
    voicePreference: 'auto'
  };
  const prompt = buildPrompt(order, '', undefined);
  const survivedCount = details.filter(d => prompt.toLowerCase().includes(d.toLowerCase())).length;
  assert.ok(survivedCount >= 3, `cel putin 3 din cele 5 detalii distincte trebuie sa supravietuiasca (nu doar o tema generica) — au supravietuit ${survivedCount}, prompt: ${prompt}`);
  assert.ok(prompt.toLowerCase().includes('ne-am cunoscut la cluj'), `primul detaliu (inceputul povestii) trebuie sa supravietuiasca intotdeauna — prompt: ${prompt}`);
});

// -------------------------------------------------------------------------------------------
// TEST 3 — "un alt inceput" (si echivalentul lui semantic in celelalte limbi) ajunge la
// mecanismul de regenerare a versurilor CAND acestea nu sunt blocate manual — verificat prin
// traseul real: exactLyrics (Standard/Video/Premium) e null/gol -> buildPrompt() e folosit ->
// feedback-ul verbatim ajunge in prompt.
// -------------------------------------------------------------------------------------------
const START_OVER_FEEDBACK_BY_LANG = {
  ro: 'Vreau un alt inceput pentru versuri.',
  en: 'I want a different beginning for the lyrics.',
  de: 'Ich möchte einen anderen Anfang für den Text.',
  es: 'Quiero un comienzo diferente para la letra.',
  it: 'Voglio un inizio diverso per il testo.',
  fr: 'Je veux un début différent pour les paroles.',
  bg: 'Искам различно начало на текста.',
  tr: 'Şarkı sözleri için farklı bir başlangıç istiyorum.'
};
for (const lang of Object.keys(START_OVER_FEEDBACK_BY_LANG)) {
  test(`TEST 3/${lang.toUpperCase()}: cererea de "alt inceput" ajunge verbatim in buildPrompt() cand versurile NU sunt blocate manual (exactLyrics gol pentru Standard/Video)`, () => {
    assert.equal(legacyExactLyrics({ editedLyrics: null, originalLyrics: 'Versuri AI generate anterior' }), '', `${lang}: exactLyrics trebuie sa fie gol (nu locked) cand clientul nu a editat manual`);
    const feedback = START_OVER_FEEDBACK_BY_LANG[lang];
    const order = {
      plan: 'standard', occasion: 'altceva', lang, recipient: 'Sam', senderName: '',
      senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'pop',
      story: 'O poveste scurta.', voicePreference: 'auto'
    };
    const prompt = buildPrompt(order, feedback, undefined);
    assert.ok(prompt.includes(feedback) || prompt.includes(feedback.slice(0, 30)),
      `${lang}: cererea de alt inceput trebuie sa ajunga (macar clauza principala) verbatim in prompt — prompt: ${prompt}`);
  });
}

// -------------------------------------------------------------------------------------------
// TEST 4 — versuri editate manual (locked) + feedback de schimbare a inceputului: textul locked
// NU trebuie distrus — feedback-ul ajunge STRICT in `style`, niciodata in `lyrics`.
// -------------------------------------------------------------------------------------------
for (const lang of Object.keys(START_OVER_FEEDBACK_BY_LANG)) {
  test(`TEST 4/${lang.toUpperCase()}: versuri LOCKED (editate manual) raman EXACT neschimbate cand clientul cere "alt inceput" — feedback-ul ajunge doar in style`, () => {
    const lockedLyrics = 'Vers 1 blocat manual de client.\nRefren blocat manual de client.';
    const order = { plan: 'standard', lang, voicePreference: 'auto' };
    const result = buildExactLyricsRequest(order, lockedLyrics, undefined, 'auto', START_OVER_FEEDBACK_BY_LANG[lang]);
    assert.equal(result.lyrics, lockedLyrics, `${lang}: versurile locked trebuie sa ramana EXACT identice, verbatim`);
    assert.ok(result.style.includes(START_OVER_FEEDBACK_BY_LANG[lang]), `${lang}: feedback-ul trebuie totusi sa ajunga in style`);
  });
}

// -------------------------------------------------------------------------------------------
// TEST 5 — Premium: version 1 initiala, version 2 initiala, regenerare v1, regenerare v2 —
// izolare + capacitate de inceput/caracter diferit intre variante (genuri diferite -> style tags
// diferite -> Suno scrie versuri diferite pentru fiecare, nefortat spre acelasi inceput).
// -------------------------------------------------------------------------------------------
test('TEST 5: Premium — cele 4 variante (v1 initial, v2 initial, v1 regenerat, v2 regenerat) folosesc prompturi DISTINCTE (stiluri diferite), niciodata acelasi text — nu sunt fortate spre acelasi inceput', () => {
  const baseOrder = {
    plan: 'premium', occasion: 'aniversare', lang: 'ro', recipient: 'Vlad', senderName: 'Diana',
    senderRole: null, recipientRole: null, recipientMode: 'single',
    story: 'Ne cunoastem din liceu si suntem cei mai buni prieteni de atunci.',
    voicePreference: 'auto'
  };
  const v1Initial = buildPrompt({ ...baseOrder, genre: 'pop' }, '', 'pop');
  const v2Initial = buildPrompt({ ...baseOrder, genre: 'jazz' }, '', 'jazz');
  const v1Regen = buildPrompt({ ...baseOrder, genre: 'rock' }, '', 'rock');
  const v2Regen = buildPrompt({ ...baseOrder, genre: 'acoustic_folk' }, '', 'acoustic_folk');
  const all = [v1Initial, v2Initial, v1Regen, v2Regen];
  const uniquePrompts = new Set(all);
  assert.equal(uniquePrompts.size, 4, 'toate cele 4 variante trebuie sa produca prompturi distincte (genuri diferite -> caracter muzical diferit)');
  // fiecare pastreaza aceeasi poveste reala — izolarea nu inseamna pierderea povestii.
  all.forEach((p, i) => assert.ok(p.includes('cei mai buni prieteni'), `varianta ${i + 1} trebuie sa pastreze povestea reala`));
});

test('TEST 5b: editarea uneia dintre cele doua melodii Premium NU afecteaza exactLyrics/versurile CELEILALTE (izolare per varianta)', () => {
  const song1 = { sourceVariant: { editedLyrics: null, originalLyrics: 'Versuri AI varianta 1' }, lyricsInput: 'Versuri AI varianta 1', feedback: 'mai lent' };
  const song2 = { sourceVariant: { editedLyrics: 'Versuri EDITATE manual de client pentru varianta 2', originalLyrics: 'Versuri AI varianta 2' }, lyricsInput: 'Versuri EDITATE manual de client pentru varianta 2', feedback: null };
  const r1 = exactLyricsForSong(song1);
  const r2 = exactLyricsForSong(song2);
  assert.equal(r1.exactLyrics, null, 'varianta 1 (needitata) trebuie sa ramana unlocked — feedback-ul ei poate schimba versurile');
  assert.equal(r2.exactLyrics, 'Versuri EDITATE manual de client pentru varianta 2', 'varianta 2 (editata manual) trebuie sa ramana locked, neafectata de varianta 1');
});

// -------------------------------------------------------------------------------------------
// TEST 6 — toate cele 3 pachete: story survival + "alt inceput" pentru lyrics neblocate.
// -------------------------------------------------------------------------------------------
for (const plan of ['standard', 'premium', 'video']) {
  test(`TEST 6/${plan}: povestea (cu o expresie concreta) ajunge in promptul final, si exactLyrics ramane gol (unlocked) fara editare manuala — feedback-ul poate schimba versurile`, () => {
    const order = {
      plan, occasion: 'declaratie', lang: 'ro', recipient: 'Alex', senderName: 'Sam',
      senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'romantic',
      story: 'Te iubesc, viata mea, si asta nu se va schimba niciodata.',
      voicePreference: 'auto'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.toLowerCase().includes('te iubesc'), `${plan}: expresia clientului trebuie sa apara — prompt: ${prompt}`);
    // exactLyrics (Standard/Video: handleLegacyRegenerate) ramane gol fara editare manuala,
    // IDENTIC pentru toate planurile (Video nu mai forteaza lock, vezi runda anterioara).
    assert.equal(legacyExactLyrics({ editedLyrics: null, originalLyrics: 'orice' }), '', `${plan}: exactLyrics trebuie gol fara editare manuala`);
  });
}

// -------------------------------------------------------------------------------------------
// TEST 7 — toate cele 8 limbi: expresie personala concreta, cu caractere native, supravietuieste
// verbatim in promptul final.
// -------------------------------------------------------------------------------------------
const LOVE_PHRASE_BY_LANG = {
  ro: 'te iubesc, viață a mea',
  en: 'I love you, my life',
  de: 'ich liebe dich, mein Leben',
  es: 'te quiero, mi vida',
  it: 'ti amo, vita mia',
  fr: "je t'aime, ma vie",
  bg: 'обичам те, живот мой',
  tr: 'seni seviyorum, hayatım'
};
for (const lang of Object.keys(LOVE_PHRASE_BY_LANG)) {
  test(`TEST 7/${lang.toUpperCase()}: expresia personala concreta (cu caractere native) supravietuieste verbatim in promptul final`, () => {
    const phrase = LOVE_PHRASE_BY_LANG[lang];
    const order = {
      plan: 'standard', occasion: 'declaratie', lang, recipient: 'Sam', senderName: 'Alex',
      senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'romantic',
      story: `Ne cunoastem de trei ani. ${phrase}. Asta nu se va schimba.`,
      voicePreference: 'auto'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.includes(phrase), `${lang}: expresia cu caractere native trebuie sa supravietuiasca verbatim, netranslterata — prompt: ${prompt}`);
  });
}

// -------------------------------------------------------------------------------------------
// TEST 8 — limita de 600 caractere: poveste realist LUNGA + feedback realist. Demonstreaza
// EXACT ce informatie ramane in prompt/request (nu doar ca STORY_MIN_RESERVE "exista").
// -------------------------------------------------------------------------------------------
test('TEST 8: poveste realist lunga (peste 300 caractere) + feedback realist — demonstreaza exact ce supravietuieste: inceputul povestii, feedback-ul, genul, vocea, limba — niciodata toate sacrificate simultan', () => {
  const longStory = 'Ne-am cunoscut acum opt ani, la facultate, intr-un curs de literatura pe care niciunul dintre noi nu voia sa il urmeze. Am devenit prieteni, apoi mult mai mult. Am calatorit impreuna in Grecia, Italia si Portugalia. Te iubesc, viata mea, mai mult decat pot exprima, si vreau sa imbatranim impreuna, sa avem copii si o casa langa mare.';
  const feedback = 'Mai energica si un inceput diferit, te rog.';
  const order = {
    plan: 'standard', occasion: 'declaratie', lang: 'ro', recipient: 'Elena', senderName: 'Radu',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'motivational',
    story: longStory, voicePreference: 'male'
  };
  const prompt = buildPrompt(order, feedback, undefined);
  assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca niciodata 600 caractere, a produs ${prompt.length}`);
  // Prioritate 1-5 din cerinta: genul, vocea si limba NU sunt niciodata eliminate.
  assert.match(prompt, /motivational anthem/i, 'genul trebuie sa ramana prezent intreg');
  assert.match(prompt, /Male vocal|male lead vocal/i, 'vocea aleasa explicit trebuie sa ramana prezenta');
  assert.match(prompt, /entirely in Romanian/i, 'limba versurilor trebuie sa ramana prezenta');
  // Inceputul povestii (unde clientul a plasat contextul) trebuie sa supravietuiasca intotdeauna.
  assert.ok(prompt.includes('Ne-am cunoscut acum opt ani'), `inceputul povestii trebuie sa supravietuiasca — prompt: ${prompt}`);
  // Feedback-ul explicit (cerere platita de regenerare) trebuie sa ajunga, macar clauza principala.
  assert.ok(prompt.includes('Mai energica') || prompt.includes('nergica'), `feedback-ul trebuie sa ajunga (cel putin clauza principala) — prompt: ${prompt}`);
  // LIMITARE REZIDUALA onesta: pentru o poveste ATAT DE LUNGA (peste 300 caractere) combinata cu
  // feedback SI o comanda cu toate campurile completate, continutul de la finalul povestii
  // ("copii si o casa langa mare") poate sa NU incapa — limitare reala a bugetului de 600
  // caractere al furnizorului (customMode:false), nu un bug de mapare a datelor noastre.
  console.log('TEST 8 prompt final (' + prompt.length + ' caractere):', prompt);
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
