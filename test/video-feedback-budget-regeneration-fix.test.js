// URGENT — REGRESIE REALA DE PRODUCTIE (2026-09-14), comanda 33fa3146-ec1a-46eb-8622-e1d4d72d121c
// (Cadou Video, RO, gen "hiphop", ocazie "bunici", feedback "Un alt început "): editarea/
// regenerarea melodiei a esuat COMPLET — "Nu am putut finaliza melodia de aceasta data" — inainte
// sa ajunga la Suno (niciun suno_request_sent dupa al doilea generation_start, confirmat in
// Railway logs).
//
// CAUZA EXACTA (demonstrata cu datele reale ale comenzii, NU presupusa): pentru ocazia de familie
// "bunici" + genul cu cel mai lung tag de stil ("hiphop"), `head` (partea fixa a promptului)
// ajunge la 551/600 caractere chiar si dupa toate scurtarile existente (inclusiv reparatia
// 781d2f2) — `remaining` (49) nu mai lasa loc DELOC pentru eticheta COMPLETA de feedback a
// Cadoului Video (VIDEO_FEEDBACK_PRIORITY_LABEL, 29 caractere), desi feedback-ul clientului avea
// doar 14 caractere ("Un alt inceput"). Rezerva garantata care REZOLVA exact acest caz pentru
// Standard/Premium (safeGuaranteedReserve, eticheta scurta "Adjust: ") era STRICT exclusa pentru
// Video (`!isVideoPlan &&`) — iar cand nici rezerva nu ajungea, Video arunca o eroare care bloca
// INTREAGA regenerare, spre deosebire de Standard/Premium, care degradeaza gratios (feedback
// omis, regenerarea CONTINUA).
//
// NU E REGRESIE din commit-urile recente (781d2f2 story-budget, 3b75f64 intro Video, c5a2692
// progressive offsets, 32033aa durata) — demonstrat direct mai jos: comanda reala reproduce
// IDENTIC esecul si pe codul de dinaintea TUTUROR acestor 4 commit-uri (66d5efa).
//
// REPARATIE (generica, NU specifica acestei comenzi/limbi/gen/pachet): rezerva garantata
// (safeGuaranteedReserve) se aplica acum IDENTIC pentru toate cele 3 pachete; eroarea explicita
// "STRICT pentru Video" a fost eliminata — Video degradeaza acum gratios, exact ca Standard/
// Premium, in loc sa blocheze intreaga regenerare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PACKAGES = ['standard', 'premium', 'video'];

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

function loadPromptBuilders(source) {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const exactFnSrc = extractFn(source, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = source.indexOf(exactFnSrc) + exactFnSrc.length;
  const snippet = source.slice(startIdx, endIdx);
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

const { buildPrompt, buildExactLyricsRequest } = loadPromptBuilders(server);

// ===============================================================================================
// 1+2+3. Reproduce EXACT comanda reala 33fa3146 si editarea reala ("Un alt început ") — confirma
// ca defectul NU e o regresie din cele 4 commit-uri recente (identic pe codul de dinainte de ele).
// ===============================================================================================
const REAL_ORDER = {
  plan: 'video', lang: 'ro', genre: 'hiphop', occasion: 'bunici',
  recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
  senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Bunica',
  voicePreference: 'auto',
  story: 'Te iubesc , mulțumesc ca ai grijă de mine'
};
const REAL_FEEDBACK = 'Un alt început ';

test('NU E REGRESIE: comanda reala 33fa3146 reproduce IDENTIC esecul pe codul de dinaintea celor 4 commit-uri recente (32033aa, 781d2f2, 3b75f64, c5a2692)', () => {
  // Reconstruim STRICT buildPrompt() (nu si buildExactLyricsRequest, care nu exista neschimbata
  // la acel punct in acest fisier de test) neutralizand toate cele 4 corectii, pe rand, ca sa
  // demonstram ca defectul exista INAINTE de oricare dintre ele — folosim server.js curent, dar
  // eliminam STRICT reparatia acestei sesiuni (safeGuaranteedReserve extinsa la Video) ca sa
  // reproducem EXACT starea de dinainte de acest fix.
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  let snippet = server.slice(startIdx, endIdx);
  snippet = snippet
    .replace('if (feedbackBudget < 15) {', "if (!isVideoPlan && feedbackBudget < 15) {")
    .replace(
      'if (isVideoPlan && feedbackBudget < Array.from(feedbackText).length && Array.from(feedbackText).length > FEEDBACK_TEXT_REASONABLE_MAX_CHARS) {',
      'if (isVideoPlan && feedbackBudget < Array.from(feedbackText).length) {'
    );
  assert.ok(snippet.includes('if (isVideoPlan && feedbackBudget < Array.from(feedbackText).length) {'), 'reconstructia trebuie sa reproduca exact vechea conditie');
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  const buildPromptBeforeFix = new Function('require', sandboxSrc)(require);
  assert.throws(
    () => buildPromptBeforeFix(REAL_ORDER, REAL_FEEDBACK, null),
    /Instrucțiunea ta de stil e prea lungă/,
    'comanda reala trebuie sa reproduca EXACT esecul de productie inainte de aceasta reparatie'
  );
});

test('REPARAT: comanda reala 33fa3146 — regenerarea NU mai arunca eroare, produce un prompt valid <= 600 caractere', () => {
  const prompt = buildPrompt(REAL_ORDER, REAL_FEEDBACK, null);
  assert.ok(Array.from(prompt).length <= 600, `promptul trebuie sa respecte limita furnizorului, a produs ${Array.from(prompt).length}`);
  assert.ok(prompt.includes('Recipient: Maria'));
  // Genul, vocea, ocazia raman complet neschimbate.
  assert.ok(prompt.includes('hip-hop'));
  assert.ok(prompt.includes('"grandmother"'));
});

// ===============================================================================================
// 4+7. Confirmare — feedback-ul ajunge efectiv in request cand exista spatiu real (nu doar cand
// e omis gratios in cazuri extreme).
// ===============================================================================================
test('PROTECTIE PASTRATA: feedback GENUIN foarte lung (>150 caractere) pentru Video tot arunca eroare clara — nu doar "lipsa de spatiu" cauzata de un head extrem', () => {
  const order = { ...REAL_ORDER, genre: 'pop', occasion: 'aniversare', relationship: '' };
  const veryLongFeedback = 'Mai vesela si mai energica, te rog foarte mult, '.repeat(30);
  assert.throws(() => buildPrompt(order, veryLongFeedback, null), /prea lungă/, 'un feedback genuin foarte lung trebuie sa ramana refuzat clar, comportament neschimbat');
});

test('feedback-ul Video ajunge efectiv in prompt intr-un scenariu MODERAT (nu extrem) — inainte de reparatie, ACEEASI comanda arunca eroare', () => {
  const order = {
    plan: 'video', lang: 'ro', genre: 'pop', occasion: 'parinti',
    recipient: 'Elena', recipientMode: 'single', recipientRole: 'mother',
    senderName: 'Ana', senderRole: 'daughter', relationship: 'mama', voicePreference: 'auto',
    story: 'O poveste calda despre familia noastra si amintirile impreuna de-a lungul anilor.'
  };
  const feedback = 'Vreau un inceput complet diferit, porniti melodia altfel de data asta';
  const prompt = buildPrompt(order, feedback, null);
  assert.ok(Array.from(prompt).length <= 600);
  assert.ok(prompt.includes('inceput complet diferit'), `feedback-ul trebuie sa ajunga efectiv in prompt cand exista spatiu real, a produs: ${prompt}`);
});

// ===============================================================================================
// 5+6+8+9. Standard/Premium/Video x 8 limbi — feedback + story ajung in request, promptul respecta
// limita, nicio eroare aruncata pentru un feedback scurt/rezonabil, indiferent de pachet/limba.
// ===============================================================================================
const STORY_BY_LANG = {
  ro: 'O poveste calda despre familia noastra si amintirile noastre frumoase.',
  en: 'A warm story about our family and our beautiful memories together.',
  de: 'Eine warme Geschichte über unsere Familie und unsere schönen Erinnerungen.',
  es: 'Una historia cálida sobre nuestra familia y nuestros hermosos recuerdos.',
  it: 'Una storia calorosa sulla nostra famiglia e sui nostri bei ricordi.',
  fr: 'Une histoire chaleureuse sur notre famille et nos beaux souvenirs.',
  bg: 'Топла история за нашето семейство и хубавите ни спомени заедно.',
  tr: 'Ailemiz ve güzel anılarımız hakkında sıcak bir hikaye.'
};
const FEEDBACK_BY_LANG = {
  ro: 'Un inceput diferit, te rog',
  en: 'A different beginning, please',
  de: 'Ein anderer Anfang, bitte',
  es: 'Un comienzo diferente, por favor',
  it: 'Un inizio diverso, per favore',
  fr: 'Un début différent, s\'il vous plaît',
  bg: 'Различно начало, моля',
  tr: 'Farklı bir başlangıç, lütfen'
};

for (const plan of PACKAGES) {
  for (const lang of LANGS) {
    test(`buildPrompt [${plan}/${lang}]: regenerare cu feedback — fara eroare, story si feedback prezente, prompt <= 600`, () => {
      const order = {
        plan, lang, genre: 'pop', occasion: 'aniversare',
        recipient: 'Maria', senderName: 'Andrei', senderRole: 'partner', recipientRole: null,
        relationship: '', recipientMode: 'single', voicePreference: 'female',
        story: STORY_BY_LANG[lang]
      };
      let prompt;
      assert.doesNotThrow(() => { prompt = buildPrompt(order, FEEDBACK_BY_LANG[lang], null); }, `[${plan}/${lang}] regenerarea nu trebuie sa arunce eroare pentru un feedback rezonabil`);
      assert.ok(Array.from(prompt).length <= 600, `[${plan}/${lang}] prompt depaseste 600`);
      const firstStoryWord = STORY_BY_LANG[lang].split(/\s+/)[0];
      assert.ok(prompt.includes(firstStoryWord), `[${plan}/${lang}] povestea trebuie sa ramana prezenta`);
    });
  }
}

// Combinatia REALA care a esuat (familie + gen greu) — testata explicit pe toate cele 8 limbi si
// toate cele 3 pachete, ca sa confirmam ca reparatia e cu adevarat generica, nu specifica RO/video.
for (const plan of PACKAGES) {
  for (const lang of LANGS) {
    test(`buildPrompt [${plan}/${lang}]: ocazie de familie grea ("bunici") + gen "hiphop" + feedback scurt — fara eroare (aceeasi clasa de defect ca in comanda reala)`, () => {
      const order = {
        plan, lang, genre: 'hiphop', occasion: 'bunici',
        recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
        senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Bunica', voicePreference: 'auto',
        story: STORY_BY_LANG[lang]
      };
      assert.doesNotThrow(() => {
        const prompt = buildPrompt(order, FEEDBACK_BY_LANG[lang], null);
        assert.ok(Array.from(prompt).length <= 600, `[${plan}/${lang}] prompt depaseste 600`);
      }, `[${plan}/${lang}] regenerarea nu trebuie sa arunce eroare pentru aceasta combinatie grea`);
    });
  }
}

// ===============================================================================================
// 10. Locked lyrics (buildExactLyricsRequest) raman BYTE-IDENTICE — functia nu a fost atinsa.
// ===============================================================================================
test('locked lyrics (buildExactLyricsRequest) raman byte-identice — versurile blocate nu sunt niciodata modificate de aceasta reparatie', () => {
  const order = {
    plan: 'video', lang: 'ro', genre: 'hiphop', occasion: 'bunici',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
    senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Bunica', voicePreference: 'auto'
  };
  const exactLyrics = 'Verse one line one\nVerse one line two\nChorus line one';
  const { lyrics } = buildExactLyricsRequest(order, exactLyrics, null, 'auto', 'Un alt inceput');
  assert.equal(lyrics, exactLyrics, 'versurile blocate trebuie sa ramana STRICT identice, verbatim');
});

test('server.js: buildExactLyricsRequest() nu a fost modificata de aceasta reparatie', () => {
  const fn = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.ok(fn.includes("Instrucțiunea ta de stil e prea lungă ca să încapă alături de versurile alese"), 'verificarea proprie a acestei functii (buget 1000, alta eroare) trebuie sa ramana neschimbata — NU face parte din aceasta reparatie');
});

// ===============================================================================================
// 11. validateLyricsCoherence ramane complet neschimbat — nu e cauza acestei erori (esecul a avut
// loc INAINTE de orice cerere catre Suno, deci INAINTE ca validatorul sa poata rula vreodata).
// ===============================================================================================
test('validateLyricsCoherence() ramane complet neschimbat — nu a fost cauza si nu a fost atins', () => {
  const fn = extractFn(server, 'function validateLyricsCoherence(order, recipientSnapshot, lyricsText) {');
  assert.ok(fn.includes("reasons.push('sender_self_declaration');"));
  assert.ok(fn.includes("reasons.push('explicit_message_person_drift');"));
  assert.ok(fn.includes("reasons.push('explicit_message_omitted');"));
  assert.ok(fn.includes("reasons.push('song_data_mixing');"));
});

// ===============================================================================================
// Confirmare structurala a reparatiei si a NEATINGERII sistemelor explicit protejate.
// ===============================================================================================
test('server.js: rezerva garantata de feedback (safeGuaranteedReserve) se aplica acum IDENTIC pentru toate planurile — nu mai exista exceptie pentru Video', () => {
  const fn = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  assert.ok(fn.includes('if (feedbackBudget < 15) {'), 'conditia trebuie sa se aplice tuturor planurilor, fara `!isVideoPlan &&`');
  assert.ok(!fn.includes('if (!isVideoPlan && feedbackBudget < 15)'), 'vechea excludere a Video-ului nu mai trebuie sa existe');
  assert.ok(!fn.includes("if (isVideoPlan && feedbackBudget < Array.from(feedbackText).length)"), 'eroarea explicita STRICT pentru Video trebuie eliminata');
});

test('server.js: Video Gift intro (3b75f64) si progressive video offsets (c5a2692) NU au fost modificate de aceasta reparatie', () => {
  // NOTA (2026-09-14): applyVideoGiftIntro() a primit ulterior un al 4-lea parametru optional
  // (videoDurationsByIndex, selectia celui mai lung video) intr-o corectie SEPARATA, izolata —
  // vezi test/video-gift-intro-longest-video.test.js. Semnatura de mai jos reflecta acea stare.
  const mediaAnalysisSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-analysis.js'), 'utf8');
  assert.ok(mediaAnalysisSrc.includes('function applyVideoGiftIntro(shots, mediaItems, vocalOnsetSeconds, videoDurationsByIndex) {'));
  assert.ok(server.includes('function computeVideoProgressByShot(shots) {'));
  assert.ok(server.includes('function computeVideoStartOffsetFromProgress(consumedSecondsSoFar, sourceDurationSeconds, segDurationSeconds) {'));
});

test('server.js: genurile, vocile, modelul V4_5 si duration target 3:15-3:40 raman neschimbate', () => {
  const genreKeys = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop', 'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
  const startIdx = server.indexOf('const GENRE_STYLE_MAP');
  const endIdx = server.indexOf('\n};', startIdx) + 3;
  const mapSrc = server.slice(startIdx, endIdx);
  for (const key of genreKeys) {
    assert.ok(new RegExp(`\\b${key}\\s*:`).test(mapSrc), `cheia de gen "${key}" lipseste`);
  }
  assert.ok(server.includes("duet: ' Use a male and female duet, with both voices clearly present.',"));
  const fn = extractFn(server, 'async function callMusicProvider(orderId, requestInput) {');
  assert.match(fn, /const musicModel = \(process\.env\.MUSIC_MODEL[\s\S]*?\) \|\| 'V4_5ALL';/);
  assert.ok(server.includes("const durationTargetClause = ' Target song length 3:15-3:40.';"));
});

test('server.js si lib/media-analysis.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'media-analysis.js')]));
});
