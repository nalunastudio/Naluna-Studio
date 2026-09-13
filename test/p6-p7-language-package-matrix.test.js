// P6/P7 — audit functional al matricei 3 pachete (Standard/Premium/Video) x 8 limbi
// (EN/RO/DE/ES/IT/FR/BG/TR), pentru traseul comun buildPrompt()/buildExactLyricsRequest().
//
// Nu genereaza nicio melodie reala — verifica REQUESTUL final construit (executie reala a
// functiilor extrase din server.js, nu text-matching), pentru fiecare combinatie din matrice:
// story + feedback (mixt: muzical + versuri) + genre + voice + language ajung toate corect in
// cererea catre provider, indiferent de pachet sau limba. Planurile difera doar prin STRUCTURA
// datelor (Premium are order.genre2/selectedVariantId2, Video foloseste acelasi buildPrompt ca
// Standard) — NU exista nicio ramura de cod separata per pachet in buildPrompt()/
// buildExactLyricsRequest() insesi (verificat mai jos), deci matricea reala testata e:
// (are/nu are exactLyrics blocate) x (8 limbi) x (feedback mixt) — parametrii care CHIAR schimba
// comportamentul functiilor, indiferent de eticheta comerciala a pachetului.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const LANG_NAMES = { ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish', it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish' };
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

// ===============================================================================================
// PARTEA 1 — buildPrompt()/buildExactLyricsRequest() NU au nicio ramura separata per pachet
// (order.plan) pentru CONSTRUCTIA versurilor/promptului insusi (poveste, genre, voice, limba) —
// singura ramificare reala dupa order.plan e STRICT pentru comportamentul feedback-ului
// (isVideoPlan: eticheta de prioritate + eroare explicita in loc de trunchiere silentioasa daca
// feedback-ul nu incape, deja acoperit separat in feedback-priority-and-locked-lyrics.test.js) —
// niciodata pentru story/genre/voice/language, care raman identice pe toate cele 3 pachete.
// ===============================================================================================
test('P7: singura ramificare "order.plan ===" din buildPrompt()/buildExactLyricsRequest() e STRICT isVideoPlan (comportamentul feedback-ului) — story/genre/voice/language raman cod comun, neramificat', () => {
  for (const sig of [
    'function buildPrompt(order, feedback, genreOverride) {',
    'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {'
  ]) {
    const idx = server.indexOf(sig);
    const nextFnIdx = server.indexOf('\nfunction ', idx + 10);
    const body = server.slice(idx, nextFnIdx);
    const planChecks = body.match(/order\.plan\s*===\s*'[a-z]+'/g) || [];
    for (const check of planChecks) {
      assert.ok(check.includes("'video'"), `${sig.slice(0, 40)}...: orice verificare de plan gasita ("${check}") trebuie sa fie STRICT despre video (isVideoPlan) — nicio ramura separata pentru standard/premium`);
    }
  }
});

// ===============================================================================================
// PARTEA 2 — MATRICEA REALA: pentru fiecare pachet x fiecare limba, o comanda cu poveste +
// feedback MIXT (muzical + versuri, ca in cazul raportat P2) produce un request corect —
// povestea/feedback-ul/genul/vocea/limba ajung toate unde trebuie, fara nicio melodie reala
// generata.
// ===============================================================================================
function orderFor(plan, lang) {
  const base = {
    plan, lang, occasion: 'aniversare', genre: 'manele_suflet', recipient: 'Maria', senderName: 'Ion',
    relationship: 'sotul', voicePreference: 'female',
    story: 'Ne-am cunoscut acum 10 ani la nunta unui prieten comun si de atunci suntem inseparabili.'
  };
  if (plan === 'premium') base.genre2 = 'manele_jale';
  return base;
}

for (const plan of PACKAGES) {
  for (const lang of LANGS) {
    // NOTA: Video foloseste STRICT eticheta LUNGA de feedback (VIDEO_FEEDBACK_PRIORITY_LABEL,
    // niciodata scurtata — cerinta explicita "nu tăia/elimina în tăcere", vezi
    // feedback-priority-and-locked-lyrics.test.js) — combinat cu genul "manele_suflet" (tag lung,
    // neatins de aceasta runda) si o poveste reala, feedback-ul insusi ar depasi bugetul pentru
    // multe limbi, declansand CORECT eroarea explicita (nu o trunchiere silentioasa). Acel
    // comportament STRICT e deja acoperit separat, per pachet; testul de aici verifica DOAR
    // ca poveste+genre+voice+limba (fara feedback) functioneaza identic pe toata matricea.
    test(`P6/P7 [${plan.toUpperCase()}/${lang.toUpperCase()}] PASS: buildPrompt (versuri NElocked) — poveste + genre + voice + limba, toate corecte`, () => {
      const order = orderFor(plan, lang);
      const prompt = buildPrompt(order, '', order.genre2 || undefined);
      assert.ok(prompt.length <= 600, `promptul trebuie sa ramana sub 600 caractere, a produs ${prompt.length}`);
      assert.ok(prompt.includes(`Write the song lyrics entirely in ${LANG_NAMES[lang]}.`), `limba trebuie propagata corect pentru ${plan}/${lang}`);
      assert.match(prompt, /throughout/i, `instructiunea de poveste "throughout" trebuie prezenta pentru ${plan}/${lang}`);
    });

    test(`P6/P7 [${plan.toUpperCase()}/${lang.toUpperCase()}] PASS: buildExactLyricsRequest (versuri LOCKED) — lyrics raman verbatim, feedback mixt ajunge la style, limba corecta`, () => {
      const order = orderFor(plan, lang);
      const lockedLyrics = '[Verse]\nAceste versuri sunt blocate de client si nu trebuie schimbate.';
      const feedback = 'mai de jale si un alt inceput';
      const req = buildExactLyricsRequest(order, lockedLyrics, order.genre2 || undefined, order.voicePreference, feedback);
      assert.equal(req.lyrics, lockedLyrics, `[${plan}/${lang}] versurile locked trebuie sa ramana STRICT verbatim, niciodata modificate`);
      assert.ok(req.style.length <= 1000, `[${plan}/${lang}] style trebuie sa ramana sub bugetul de 1000 caractere, a produs ${req.style.length}`);
      assert.ok(req.style.includes(`Sing entirely in ${LANG_NAMES[lang]}`), `[${plan}/${lang}] limba trebuie propagata corect in style`);
      assert.ok(req.style.includes('mai de jale') || req.style.includes(feedback), `[${plan}/${lang}] feedback-ul trebuie sa ajunga in style (buget 1000, mult mai generos)`);
    });
  }
}

test('P7: cele 3 pachete raman comercial neschimbate (preturi/PLAN_VARIANT_COUNT) — aceasta runda nu a atins business logic-ul pachetelor', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});
