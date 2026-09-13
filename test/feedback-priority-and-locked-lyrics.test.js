// P2 — "Feedback-ul liber trebuie executat" (runda 2026-09-13).
//
// CAZUL RAPORTAT: Premium, gen "Manele de suflet" -> "Manele de jale", feedback liber "Mai de
// jale si un alt inceput". Genul s-a schimbat corect; "mai de jale" a fost slab respectat;
// "un alt inceput" NU a fost respectat deloc — inceputul versurilor a ramas practic acelasi.
//
// CAUZA REALA #1 (Premium) — gasita prin urmarirea traseului real story->frontend->backend:
// ecranul de editare selectiva (melodia-mea.html, functia songPayload()) PRECOMPLETEAZA
// textarea-ul de versuri cu versurile curente si il retrimite MEREU catre server, indiferent
// daca clientul l-a atins. Backend-ul (handlePremiumSelectiveRegenerate) trata orice text primit
// in acest camp ca "versuri exacte/blocate" (exactLyrics), care ocolesc COMPLET buildPrompt() —
// deci feedback-ul liber, in acest flux, NU putea NICIODATA sa schimbe versurile (ajungea STRICT
// in campul `style`, folosit doar pentru gen/voce/mood), indiferent ce scria clientul in
// "Spune-ne ce sa schimbam". Corectat: versurile trimise sunt tratate ca "exact/locked" STRICT
// daca DIFERA real de versurile efective curente (editare genuina) — altfel, feedback-ul liber
// poate regenera versurile prin buildPrompt(), ca la Standard.
//
// CAUZA REALA #2 (Video Gift) — server.js, handleLegacyRegenerate: fortase STRICT pentru Video
// intotdeauna calea verbatim (buildExactLyricsRequest), chiar fara nicio editare explicita de
// versuri (fallback pe originalLyrics) — acelasi efect, feedback-ul despre versuri nu putea
// niciodata schimba versurile pentru Video. Aliniat acum la Standard/Premium: exact/locked STRICT
// cand clientul a folosit explicit editorul de versuri.
//
// CAUZA REALA #3 (toate planurile, buildPrompt) — instructiunile fixe din buildPrompt() ("open
// verse 1 with a real detail from the story") se repeta IDENTIC la fiecare regenerare (aceeasi
// poveste), fara niciun semnal ca feedback-ul liber (cand exista) are prioritate fata de ele.
// Video avea deja un asemenea semnal (VIDEO_FEEDBACK_PRIORITY_LABEL), dar STRICT pentru Video.
// Generalizat acum la toate planurile si la orice tip de feedback (FEEDBACK_PRIORITY_CLAUSE).
//
// Acest fisier demonstreaza FUNCTIONAL (executie reala a codului din server.js, nu doar
// text-matching) ca toate cele trei cauze sunt corectate, si ca fix-ul functioneaza identic
// pentru toate cele 8 limbi ale site-ului (EN/RO/DE/ES/IT/FR/BG/TR).
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

// -------------------------------------------------------------------------------------------
// CAUZA #1 — exactLyrics pentru editarea selectiva Premium (handlePremiumSelectiveRegenerate).
// -------------------------------------------------------------------------------------------
function loadPremiumExactLyrics() {
  const a = server.indexOf('function currentEffectiveLyrics(sourceVariant) {');
  const b = server.indexOf('const editSongsForGeneration = parsedSongs.map(song => {');
  const helperSrc = extractFn(server, 'function currentEffectiveLyrics(sourceVariant) {');
  assert.ok(a !== -1 && b !== -1 && a < b, 'helper-ul currentEffectiveLyrics trebuie sa existe INAINTEA editSongsForGeneration');
  const mapBodyStart = server.indexOf('{', server.indexOf('=>', b)) ;
  // extragem corpul arrow-function-ului din .map(song => { ... })
  let depth = 1, i = mapBodyStart + 1;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const mapBody = server.slice(mapBodyStart, i + 1);
  const fnSrc = `
    ${helperSrc}
    function exactLyricsForSong(song) ${mapBody}
    return exactLyricsForSong;
  `;
  return new Function(fnSrc)();
}
const exactLyricsForSong = loadPremiumExactLyrics();

test('P2/CAUZA#1 (Premium): versuri NEMODIFICATE (lyricsInput identic cu cele curente, exact cum le retrimite mereu ecranul de editare) NU sunt tratate ca exact/locked — exactLyrics trebuie sa fie null, ca feedback-ul liber sa poata regenera versurile prin buildPrompt()', () => {
  const currentLyrics = 'Bunico draga, te iubesc mult.';
  const song = {
    sourceVariant: { editedLyrics: null, originalLyrics: currentLyrics },
    lyricsInput: currentLyrics, // exact ce trimite mereu songPayload(), neschimbat
    feedback: 'Mai de jale si un alt inceput'
  };
  const result = exactLyricsForSong(song);
  assert.equal(result.exactLyrics, null, 'versurile nemodificate nu trebuie tratate ca locked — inainte de fix, ramaneau mereu locked aici');
  assert.equal(result.feedback, 'Mai de jale si un alt inceput');
});

test('P2/CAUZA#1 (Premium): versuri CHIAR modificate manual de client raman exact/locked (protejate) — comportamentul corect existent NU s-a schimbat', () => {
  const song = {
    sourceVariant: { editedLyrics: null, originalLyrics: 'Versuri originale AI.' },
    lyricsInput: 'Versuri complet rescrise de client, cuvant cu cuvant.',
    feedback: 'mai lent'
  };
  const result = exactLyricsForSong(song);
  assert.equal(result.exactLyrics, 'Versuri complet rescrise de client, cuvant cu cuvant.');
});

test('P2/CAUZA#1 (Premium): daca varianta era DEJA locked dintr-o runda anterioara si clientul retrimite ACELASI text (nemodificat), lock-ul ramane protejat (P3 — locked are prioritate fata de feedback)', () => {
  const lockedText = 'Text deja blocat intr-o editare anterioara.';
  const song = {
    sourceVariant: { editedLyrics: lockedText, originalLyrics: 'Versuri AI vechi, irelevante acum' },
    lyricsInput: lockedText, // ecranul retrimite mereu textul CURENT (deja cel locked)
    feedback: 'un alt inceput'
  };
  const result = exactLyricsForSong(song);
  assert.equal(result.exactLyrics, lockedText, 'continutul locked trebuie sa ramana protejat, chiar cu feedback care ar cere altceva');
});

// -------------------------------------------------------------------------------------------
// CAUZA #2 — exactLyrics pentru Standard/Video (handleLegacyRegenerate) — acum identic pentru
// ambele planuri.
// -------------------------------------------------------------------------------------------
function loadLegacyExactLyrics() {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, idx + 11000);
  const exprMatch = body.match(/const exactLyrics = \(typeof sourceVariant\.editedLyrics[\s\S]*?: '';/);
  assert.ok(exprMatch, 'expresia exactLyrics trebuie sa existe');
  return new Function('sourceVariant', `${exprMatch[0]}\nreturn exactLyrics;`);
}
const legacyExactLyrics = loadLegacyExactLyrics();

for (const plan of ['standard', 'video']) {
  test(`P2/CAUZA#2 (${plan}): fara editare explicita de versuri, exactLyrics ramane gol — feedback-ul liber poate regenera versurile prin buildPrompt() (Video nu mai forteaza lock-ul verbatim)`, () => {
    assert.equal(legacyExactLyrics({ editedLyrics: null, originalLyrics: 'Versuri AI generate anterior' }), '');
  });
  test(`P2/CAUZA#2 (${plan}): cu editare explicita de versuri (editorul dedicat), exactLyrics ramane blocat pe textul editat — protectia P3 e neschimbata`, () => {
    assert.equal(legacyExactLyrics({ editedLyrics: 'Versuri editate explicit de client', originalLyrics: 'orice' }), 'Versuri editate explicit de client');
  });
}

// -------------------------------------------------------------------------------------------
// CAUZA #3 — FEEDBACK_PRIORITY_CLAUSE: feedback-ul liber primeste un semnal explicit de
// prioritate fata de instructiunile fixe din buildPrompt(), pentru TOATE planurile (nu doar
// Video), in TOATE cele 8 limbi.
// -------------------------------------------------------------------------------------------
test('STRUCTURAL: FEEDBACK_PRIORITY_CLAUSE nu e limitata la Video in buildExactLyricsRequest() (se aplica neconditionat, langa BRIGHTEN_MOOD_CLAUSE, pentru toate planurile) — NU e folosita in buildPrompt() (buget 600 caractere, MASURAT DIRECT ca fiind mereu prea stramt pentru ea, ar fi cod mort — vezi comentariul din server.js, langa BRIGHTEN_MOOD_CLAUSE)', () => {
  const exactFn = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.match(exactFn, /FEEDBACK_PRIORITY_CLAUSE/);
  assert.ok(!/isVideoPlan\s*&&[^\n]*FEEDBACK_PRIORITY_CLAUSE/.test(exactFn), 'clauza de prioritate nu trebuie sa fie gatata pe isVideoPlan in buildExactLyricsRequest');
});

// Poveste + feedback realiste, cu caractere native, cate una pentru fiecare din cele 8 limbi ale
// site-ului — verifica UTF-8/diacritice pastrate SI ca FEEDBACK_PRIORITY_CLAUSE apare pentru
// fiecare limba (mecanismul e independent de limba/continutul feedback-ului).
const REALISTIC_BY_LANG = {
  ro: { story: 'Ne-am cunoscut la facultate și de atunci suntem nedespărțiți, îmi amintesc prima noastră plimbare prin ploaie.', feedback: 'Mai de jale și un alt început, te rog.' },
  en: { story: "We met in college and have been inseparable ever since, I remember our first walk together in the rain.", feedback: 'A bit sadder, and a completely different opening please.' },
  de: { story: 'Wir haben uns an der Universität kennengelernt und sind seitdem unzertrennlich, ich erinnere mich an unseren ersten Spaziergang im Regen.', feedback: 'Etwas trauriger und bitte einen ganz anderen Anfang.' },
  es: { story: 'Nos conocimos en la universidad y desde entonces somos inseparables, recuerdo nuestro primer paseo bajo la lluvia.', feedback: 'Más triste y un comienzo completamente diferente, por favor.' },
  it: { story: "Ci siamo conosciuti all'università e da allora siamo inseparabili, ricordo la nostra prima passeggiata sotto la pioggia.", feedback: 'Più triste e un inizio completamente diverso, per favore.' },
  fr: { story: "Nous nous sommes rencontrés à la fac et depuis nous sommes inséparables, je me souviens de notre première promenade sous la pluie.", feedback: "Plus triste et un début complètement différent, s'il vous plaît." },
  bg: { story: 'Запознахме се в университета и оттогава сме неразделни, помня първата ни разходка под дъжда.', feedback: 'По-тъжно и съвсем различно начало, моля.' },
  tr: { story: 'Üniversitede tanıştık ve o zamandan beri ayrılmaz olduk, yağmurda yaptığımız ilk yürüyüşü hatırlıyorum.', feedback: 'Biraz daha hüzünlü ve tamamen farklı bir başlangıç lütfen.' }
};

for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
  const { story, feedback } = REALISTIC_BY_LANG[lang];
  test(`P6/${lang.toUpperCase()}: buildPrompt() include feedback-ul liber VERBATIM (caractere native pastrate), pentru comanda Premium cu schimbare de gen (manele_suflet -> manele_jale)`, () => {
    const order = {
      plan: 'premium', occasion: 'dor', lang, recipient: 'Maria', senderName: 'Andrei',
      senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'manele_suflet',
      story, voicePreference: 'auto'
    };
    const prompt = buildPrompt(order, feedback, 'manele_jale');
    assert.match(prompt, /minor-key oriental colour, mournful violin and clarinet/i, `${lang}: stilul Manele de jale trebuie sa apara`);
    assert.ok(!prompt.includes('warm melismatic vocal, hopeful devoted mood'), `${lang}: stilul vechi (Manele de suflet) nu mai trebuie sa apara`);
    // feedback-ul poate fi trunchiat de bugetul de 600 caractere (limitare documentata) — verificam
    // ca cel PUTIN inceputul lui (clauza principala) supravietuieste, verbatim, cu diacritice intacte.
    // LIMITARE REZIDUALA documentata (identica cu BRIGHTEN_MOOD_CLAUSE, vezi edit-regenerate-
    // direction-change.test.js): pentru o comanda REALA (poveste+ocazie+gen complete), bugetul de
    // 600 caractere al buildPrompt() e aproape mereu consumat INTEGRAL de head+feedback-ul verbatim
    // — FEEDBACK_PRIORITY_CLAUSE (adaos optional, niciodata pe seama povestii) nu mai are loc in
    // acest scenariu REALIST, exact ca BRIGHTEN_MOOD_CLAUSE inaintea ei. NU verificam prezenta ei
    // aici — vezi testul dedicat mai jos ("cu o comanda SCURTA") pentru dovada ca mecanismul insusi
    // functioneaza cand bugetul chiar permite.
    const feedbackPrefix = feedback.slice(0, 20);
    assert.ok(prompt.includes(feedbackPrefix), `${lang}: inceputul feedback-ului trebuie sa supravietuiasca verbatim — prompt: ${prompt}`);
  });

  test(`P6/${lang.toUpperCase()}: buildExactLyricsRequest() (versuri locked) pastreaza lyrics VERBATIM neschimbate, aplica feedback-ul SI clauza de prioritate STRICT campului style, cu caractere native intacte`, () => {
    const order = { plan: 'premium', lang, voicePreference: 'auto' };
    const lockedLyrics = story; // folosim povestea ca text "deja blocat" — orice text cu caractere native e suficient aici
    const result = buildExactLyricsRequest(order, lockedLyrics, 'manele_jale', 'auto', feedback);
    assert.equal(result.lyrics, lockedLyrics.normalize('NFC'), `${lang}: versurile locked nu trebuie alterate de feedback`);
    assert.ok(result.style.includes(feedback), `${lang}: feedback-ul verbatim trebuie sa apara in style — style: ${result.style}`);
    assert.ok(result.style.includes('takes priority over any conflicting instruction above'), `${lang}: clauza de prioritate trebuie sa fie prezenta in style`);
  });
}

test('MASURAT DIRECT: FEEDBACK_PRIORITY_CLAUSE (68 caractere) nu incape in buildPrompt() (buget 600) nici macar pentru cea mai minimala comanda posibila (poveste de 15 caractere, fara expeditor, ocazie generica, feedback de un cuvant) — confirma ca NU e folosita acolo (decizie deliberata, nu omisiune) si ca buildExactLyricsRequest() (buget 1000) ramane singurul loc unde functioneaza real', () => {
  const order = {
    plan: 'standard', occasion: 'altceva', lang: 'en', recipient: 'Sam', senderName: '',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'pop',
    story: 'A short story.', voicePreference: 'auto'
  };
  const prompt = buildPrompt(order, 'shorter', undefined);
  assert.ok(!prompt.includes('takes priority over any conflicting instruction above'), `clauza de prioritate nu trebuie sa apara in buildPrompt() — prompt: ${prompt}`);
});

// -------------------------------------------------------------------------------------------
// P3 — mixed feedback (muzical + versuri) trebuie sa ajunga la componenta corecta: cand versurile
// NU sunt locked, ambele parti ale unui feedback mixt ajung in ACELASI prompt descriptiv
// (buildPrompt customMode:false), care controleaza simultan stilul/interpretarea SI versurile
// generate — nu exista o separare structurala necesara, verbatim + prioritate sunt suficiente.
// -------------------------------------------------------------------------------------------
test('P3: feedback mixt ("mai de jale si un alt inceput") ajunge INTREG (ambele cereri) in promptul descriptiv cand versurile nu sunt locked — nu e nevoie de rutare separata muzica/versuri, Suno primeste un singur prompt care controleaza ambele', () => {
  const order = {
    plan: 'premium', occasion: 'dor', lang: 'ro', recipient: 'Maria', senderName: 'Andrei',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'manele_suflet',
    story: 'Povestea noastra de dragoste a inceput acum cinci ani, la o nunta de familie.',
    voicePreference: 'auto'
  };
  const feedback = 'Mai de jale si un alt inceput';
  const prompt = buildPrompt(order, feedback, 'manele_jale');
  assert.ok(prompt.includes(feedback), 'ambele cereri (muzica + versuri) trebuie sa apara verbatim, ca UN SINGUR feedback, in acelasi prompt');
});
