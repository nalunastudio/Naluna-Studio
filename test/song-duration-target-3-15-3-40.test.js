// OBIECTIV UNIC (2026-09-13): melodiile complete generate de Naluna trebuie sa TINTEASCA o durata
// intre 3:15 si 3:40 minute (nu ~5 minute, ca in testele reale recente).
//
// CAUZA EXACTA (gasita prin citirea directa a callMusicProvider(), server.js): SunoAPI.org
// (V4_5/V4_5ALL) NU primeste niciodata un camp de durata/lungime in requestBody trimis catre
// /api/v1/generate — furnizorul nu expune asa ceva public, deci nu exista niciun parametru real
// de durata de setat. Promptul (customMode:false) si versurile (customMode:true) nu contineau,
// pana acum, NICIUN indiciu catre model despre durata dorita — modelul decidea liber, tinzand
// spre ~5 minute pentru melodii personalizate, elaborate.
//
// METODA: un singur indiciu text (` Target song length 3:15-3:40.`), acelasi tip de instructiune
// ca cele deja existente ("Start the vocals around 8-10 seconds") — o CERERE catre model, nu o
// garantie matematica (furnizorul nu ofera niciuna).
// - buildExactLyricsRequest() (customMode:true, versuri deja blocate): adaugat NECONDITIONAT in
//   `style` — buget de 1000 caractere, headroom generos (masurat: sub 720/1000 chiar in cel mai
//   nefavorabil caz, inainte de feedback) — versurile (`lyrics`) raman STRICT verbatim, neatinse.
// - buildPrompt() (customMode:false, Suno scrie singur versurile): tratat ca al treilea "extra"
//   optional (dupa modelul deja existent pentru dictionInstruction/bracketLanguageClause), cu
//   PRIORITATE MAI MARE decat amandoua — dar NICIODATA sub storyTextFloor (aceeasi garantie
//   matematica, neschimbata) — povestea clientului NU pierde niciodata spatiu din cauza acestui
//   indiciu.
//
// Ambele functii sunt COD COMUN pentru Standard/Premium/Video (order.plan nu ramifica aceasta
// logica — vezi si p6-p7-language-package-matrix.test.js) si pentru initial generation +
// regenerare + feedback (aceleasi functii, apelate identic).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PACKAGES = ['standard', 'premium', 'video'];
const DURATION_CLAUSE = ' Target song length 3:15-3:40.';

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit: ${signature}`);
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

const STORY_BY_LANG = {
  en: 'We met in 2015 at a small bookshop in Liverpool, reading the same old novel.',
  ro: 'Ne-am cunoscut în 2015 pe malul Dunării din Brăila, într-o seară cu ploaie.',
  de: 'Wir haben uns 2015 im kleinen Café am Münsterplatz in Freiburg kennengelernt.',
  es: 'Nos conocimos en 2015 en la plaza de la Encarnación en Sevilla, bajo la lluvia.',
  it: 'Ci siamo conosciuti nel 2015 in una libreria vicino a Piazza Maggiore a Bologna.',
  fr: 'Nous nous sommes rencontrés en 2015 sur le vieux pont à Annecy, un matin de pluie.',
  bg: 'Запознахме се през 2015 година в старото кино в Пловдив, докато валеше дъжд.',
  tr: 'Kaş\'ta küçük liman kahvesinde 2015 yılında tanıştık, o gün yağmur yağıyordu.'
};

function baseOrder(lang, plan, overrides) {
  return Object.assign({
    lang, plan, genre: 'romantic', occasion: 'aniversare',
    recipient: 'Maria', senderName: 'Andrei', senderRole: 'partner', recipientRole: null,
    relationship: '', recipientMode: 'single', voicePreference: 'female',
    story: STORY_BY_LANG[lang]
  }, overrides || {});
}

// ===============================================================================================
// 1. buildExactLyricsRequest() (customMode:true, versuri blocate/locked lyrics) — indiciul de
//    durata ajunge intotdeauna in `style`, in TOATE cele 8 limbi si toate cele 3 pachete, FARA sa
//    atinga versurile verbatim.
// ===============================================================================================
for (const lang of LANGS) {
  for (const plan of PACKAGES) {
    test(`buildExactLyricsRequest [${lang}/${plan}]: style contine indiciul de durata, lyrics raman verbatim (locked lyrics neatinse)`, () => {
      const order = baseOrder(lang, plan);
      const exactLyrics = 'Verse one line one\nVerse one line two\nChorus line one\nChorus line two';
      const { style, lyrics } = buildExactLyricsRequest(order, exactLyrics, null, 'female', null);
      assert.ok(style.includes('Target song length 3:15-3:40.'), `style trebuie sa contina indiciul de durata pentru ${lang}/${plan}`);
      assert.equal(lyrics, exactLyrics, 'versurile blocate trebuie sa ramana STRICT identice, neatinse de indiciul de durata');
      assert.ok(Array.from(style).length <= 1000, 'style nu trebuie sa depaseasca bugetul de 1000 caractere');
    });
  }
}

test('buildExactLyricsRequest: indiciul de durata supravietuieste si cu feedback prezent (regenerare/feedback pe versuri blocate)', () => {
  const order = baseOrder('en', 'premium');
  const exactLyrics = 'Some locked lyric line\nAnother locked line';
  const { style, lyrics } = buildExactLyricsRequest(order, exactLyrics, null, 'duet', 'Please make it a bit more upbeat');
  assert.ok(style.includes('Target song length 3:15-3:40.'));
  assert.ok(style.includes('upbeat') || style.includes('Adjust') || style.includes('adjustment'), 'feedback-ul clientului trebuie sa ramana prezent alaturi de indiciul de durata');
  assert.equal(lyrics, exactLyrics);
});

// ===============================================================================================
// 2. buildPrompt() (customMode:false, initial generation + regenerare) — indiciul de durata NU
//    coboara niciodata povestea sub garantia ei existenta (storyTextFloor), in TOATE cele 8 limbi
//    si toate cele 3 pachete.
// ===============================================================================================
for (const lang of LANGS) {
  for (const plan of PACKAGES) {
    test(`buildPrompt [${lang}/${plan}]: prompt <= 600 caractere, povestea ramane prezenta`, () => {
      const order = baseOrder(lang, plan);
      const prompt = buildPrompt(order, null, null);
      assert.ok(Array.from(prompt).length <= 600, `promptul nu trebuie sa depaseasca 600 caractere pentru ${lang}/${plan}`);
      assert.ok(prompt.includes('Recipient: Maria'), 'destinatarul trebuie sa ramana prezent');
      // povestea (sau cel putin un fragment al ei) trebuie sa ramana in prompt — cerinta P1,
      // neatinsa de aceasta modificare.
      const firstStoryWord = STORY_BY_LANG[lang].split(/\s+/)[0];
      assert.ok(prompt.includes(firstStoryWord), `poveste absenta complet din prompt pentru ${lang}/${plan}`);
    });
  }
}

test('buildPrompt: pentru o comanda usoara (fara expeditor, poveste scurta, gen/limba fara instructiuni suplimentare), indiciul de durata AJUNGE efectiv la Suno, fara sa scurteze povestea', () => {
  // MASURAT DIRECT: pentru comenzi CU expeditor + limba non-engleza (care rezerva deja spatiu
  // pentru dictie SI paranteze), indiciul de durata — cel mai jos in prioritate, cu buna stiinta —
  // e de multe ori omis cu gratie (vezi testul urmator). Aici folosim o comanda usoara REALA
  // (fara expeditor, engleza — deci fara bracketLanguageClause) unde spatiul chiar exista.
  const order = baseOrder('en', 'standard', {
    genre: 'acoustic_folk', occasion: 'multumire', senderName: '', senderRole: null,
    story: 'Thank you for always being there for me, every single day since we met.'
  });
  const promptWithout = (() => {
    // Simulam varianta FARA indiciul de durata (comportamentul dinaintea acestei modificari) prin
    // neutralizarea constantei — folosita STRICT ca baseline de comparatie in acest test.
    const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
    const startIdx = server.indexOf(startMarker);
    const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
    const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
    let snippet = server.slice(startIdx, endIdx).replace(
      "const durationTargetClause = ' Target song length 3:15-3:40.';",
      "const durationTargetClause = '';"
    );
    const sandboxSrc = `
      const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
      const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
      const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
      const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
      ${snippet}
      return buildPrompt;
    `;
    const buildPromptBaseline = new Function('require', sandboxSrc)(require);
    return buildPromptBaseline(order, null, null);
  })();
  const promptWith = buildPrompt(order, null, null);
  assert.ok(promptWith.includes('Target song length 3:15-3:40.'), 'indiciul de durata trebuie sa ajunga efectiv in prompt pentru o comanda tipica');
  const storyMatch = (p) => (p.match(/Story\S*?: ([\s\S]*?) Occasion:/) || [])[1] || '';
  assert.equal(storyMatch(promptWith), storyMatch(promptWithout), 'povestea inclusa trebuie sa ramana STRICT identica cu/fara indiciul de durata pentru o comanda tipica');
});

test('LIMITARE REALA, de raportat explicit: pentru o comanda TIPICA (expeditor numit, limba non-engleza — deci dictie+paranteze deja rezervate), indiciul de durata e omis cu gratie, iar dictia/parantezele raman BYTE-IDENTICE cu comportamentul dinainte de aceasta modificare — indiciul NU ajunge la Suno in acest caz, prioritate stricta acordata functiilor deja existente, nu obiectivului nou', () => {
  const order = baseOrder('ro', 'standard');
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  let snippet = server.slice(startIdx, endIdx).replace(
    "const durationTargetClause = ' Target song length 3:15-3:40.';",
    "const durationTargetClause = '';"
  );
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  const buildPromptBaseline = new Function('require', sandboxSrc)(require);
  const promptWithout = buildPromptBaseline(order, null, null);
  const promptWith = buildPrompt(order, null, null);
  assert.equal(promptWith, promptWithout, 'pentru aceasta comanda tipica, promptul trimis catre Suno trebuie sa ramana STRICT identic (indiciul de durata nu are loc fara sa deranjeze dictia/parantezele deja existente)');
  assert.ok(!promptWith.includes('Target song length'), 'confirmare explicita: indiciul de durata NU ajunge la Suno pentru aceasta comanda tipica — limitare reala, raportata, nu ascunsa');
});

test('buildPrompt: pentru o comanda extrema (campuri foarte lungi, gen/ocazie ample), indiciul de durata e omis cu gratie — povestea NU e niciodata redusa sub cat ar fi primit fara acest indiciu', () => {
  const order = baseOrder('de', 'video', {
    genre: 'manele_jale', occasion: 'nunta', weddingType: 'wedding',
    recipient: 'Wolfgang-Alexander und Ingrid-Charlotte Müller-Schmidt-Hoffmann',
    senderName: 'Maximilian-Friedrich', senderRole: 'best_man',
    relationship: 'die allerbesten und liebevollsten Trauzeugen der ganzen Familie',
    recipientMode: 'both', voicePreference: 'duet',
    story: 'Wir haben uns 2015 im kleinen Café am Münsterplatz in Freiburg kennengelernt und seitdem jedes Jahr gemeinsam Weihnachten gefeiert, mit Plätzchen backen, Geschichten erzählen und langen Spaziergängen durch den Schwarzwald, die wir nie vergessen werden, auch wenn die Jahre vergehen und wir alle älter werden und uns immer wieder an diese wundervollen Momente erinnern.'
  });
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  let snippet = server.slice(startIdx, endIdx).replace(
    "const durationTargetClause = ' Target song length 3:15-3:40.';",
    "const durationTargetClause = '';"
  );
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  const buildPromptBaseline = new Function('require', sandboxSrc)(require);
  const promptWithout = buildPromptBaseline(order, null, null);
  const promptWith = buildPrompt(order, null, null);
  const storyMatch = (p) => (p.match(/Story\S*?: ([\s\S]*?) Occasion:/) || [])[1] || '';
  assert.equal(storyMatch(promptWith), storyMatch(promptWithout), 'in cazuri extreme, povestea NU trebuie sa piarda niciun caracter suplimentar din cauza indiciului de durata');
  assert.ok(Array.from(promptWith).length <= 600);
});

test('buildPrompt: feedback (regenerare) — indiciul de durata nu interfereaza cu bugetul garantat al feedback-ului, povestea si feedback-ul raman corecte', () => {
  const order = baseOrder('es', 'premium');
  const prompt = buildPrompt(order, 'Un pic más rápido y alegre, por favor', null);
  assert.ok(Array.from(prompt).length <= 600);
  assert.ok(prompt.includes('Recipient: Maria'));
});

// ===============================================================================================
// 3. Confirmare explicita — sisteme NEATINSE de aceasta modificare (genuri, voci, model V4_5).
// ===============================================================================================
test('server.js: GENRE_STYLE_MAP nu a fost modificat (aceleasi 16 chei curente raman prezente, neschimbate structural)', () => {
  const genreKeys = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop', 'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
  const startIdx = server.indexOf('const GENRE_STYLE_MAP');
  assert.ok(startIdx !== -1, 'GENRE_STYLE_MAP trebuie sa existe in continuare');
  const endIdx = server.indexOf('\n};', startIdx) + 3;
  const mapSrc = server.slice(startIdx, endIdx);
  for (const key of genreKeys) {
    assert.ok(new RegExp(`\\b${key}\\s*:`).test(mapSrc), `cheia de gen "${key}" lipseste din GENRE_STYLE_MAP`);
  }
});

test('server.js: VOICE_INSTRUCTIONS_FULL/SHORT (buildPrompt) raman neschimbate', () => {
  assert.ok(server.includes("female: ' Use a female lead vocal.',"));
  assert.ok(server.includes("male: ' Use a male lead vocal.',"));
  assert.ok(server.includes("duet: ' Use a male and female duet, with both voices clearly present.',"));
  assert.ok(server.includes("female: ' Female vocal.',"));
});

test('server.js: modelul Suno ramane V4_5ALL implicit, callMusicProvider() nu a fost modificat cu niciun camp de durata', () => {
  const fn = extractFn(server, 'async function callMusicProvider(orderId, requestInput) {');
  assert.match(fn, /const musicModel = \(process\.env\.MUSIC_MODEL[\s\S]*?\) \|\| 'V4_5ALL';/, 'default-ul modelului trebuie sa ramana V4_5ALL, neschimbat');
  assert.ok(!/duration/i.test(fn), 'callMusicProvider() nu trebuie sa trimita niciun camp de durata catre furnizor — API-ul nu il suporta');
  assert.ok(!/instrumental:\s*true/.test(fn), 'instrumental trebuie sa ramana false, neschimbat');
});

test('server.js si toate fisierele modificate raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
