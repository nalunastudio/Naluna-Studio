// P4 — "Vocea trebuie sa se muleze pe gen" (runda 2026-09-13).
//
// INVESTIGATIE (ce controla sistemul, gasita prin citirea reala a buildPrompt()/
// buildExactLyricsRequest()/callMusicProvider()): Naluna foloseste SunoAPI (V4_5), care NU expune
// niciun parametru dedicat de "voice id"/"persona"/"timbru" — controlul vocal e STRICT prin
// text descriptiv in campurile `prompt` (customMode:false) sau `style` (customMode:true). Sistemul
// deja combina DOUA surse independente de text, la fiecare cerere:
//   (a) GENRE_STYLE_MAP[genre] — caracterul/tehnica vocala specifica genului (ex. "melismatic
//       lament vocal" pentru manele_jale, "rhythmic clear-diction rap verses" pentru hiphop,
//       "soulful vocal" pentru jazz) — NESCHIMBAT de aceasta runda, cerinta explicita;
//   (b) VOICE_INSTRUCTIONS_FULL/SHORT[voicePreference] — o propozitie SEPARATA, generica, STRICT
//       despre genul vocii (female/male/duet), niciodata despre timbru/tehnica.
// Aceasta runda NU a schimbat acest mecanism (deja corect proiectat sa combine cele doua fara sa
// se contrazica) — a verificat FUNCTIONAL ca (a) si (b) chiar produc combinatii distincte pentru
// aceeasi voce aleasa, la genuri diferite, si ca alegerea clientului (female/male/duet/auto) nu e
// niciodata pierduta. NU exista, si nu a fost adaugat, niciun control real de timbru/persona —
// SunoAPI nu il garanteaza; sistemul nu promite unul.
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

const ALL_16_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop', 'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
const VOICE_PREFS = ['female', 'male', 'duet', 'auto'];
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function baseOrder(lang, genre, voicePreference) {
  return {
    plan: 'standard', occasion: 'altceva', lang, recipient: 'Alex', senderName: '',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre,
    story: 'O poveste scurta si reala despre noi doi.', voicePreference
  };
}

// -----------------------------------------------------------------------------------------------
// Caracterul vocal se schimba cu genul, pentru ACEEASI voce aleasa de client.
// -----------------------------------------------------------------------------------------------
const CONTRASTING_PAIRS = [
  ['jazz', 'hiphop', /soulful vocal/i, /rap verses/i],
  ['populara', 'rock', /folk ornamentation/i, /strong vocal/i],
  // ACTUALIZAT (2026-09-22, runda 3, "sunet inca insuficient de manea" dupa test audio real):
  // manele_suflet a fost re-scris din nou (vezi test/manele-suflet-authentic-sound.test.js) —
  // tiparul de mai jos foloseste fragmentul distinctiv nou, unic fata de manele_jale (neatins).
  ['manele_suflet', 'manele_jale', /oriental melismatic vibrato vocal/i, /melismatic lament vocal, heavier longing mood/i]
];
for (const [genreA, genreB, patternA, patternB] of CONTRASTING_PAIRS) {
  for (const voicePreference of VOICE_PREFS) {
    test(`P4: pentru voce="${voicePreference}", ${genreA} vs ${genreB} produc caracter vocal DIFERIT (styleTags din GENRE_STYLE_MAP), desi instructiunea de gen a vocii ramane identica`, () => {
      const promptA = buildPrompt(baseOrder('ro', genreA, voicePreference), '', undefined);
      const promptB = buildPrompt(baseOrder('ro', genreB, voicePreference), '', undefined);
      assert.match(promptA, patternA, `${genreA}: caracterul vocal specific genului trebuie sa apara`);
      assert.match(promptB, patternB, `${genreB}: caracterul vocal specific genului trebuie sa apara`);
      assert.ok(!promptA.match(patternB) , `${genreA} nu trebuie sa contina caracterul vocal al lui ${genreB}`);
      assert.ok(!promptB.match(patternA), `${genreB} nu trebuie sa contina caracterul vocal al lui ${genreA}`);
    });
  }
}

// -----------------------------------------------------------------------------------------------
// Alegerea de gen a vocii (female/male/duet) NU dispare NICIODATA, indiferent de gen — se pastreaza
// alaturi de caracterul vocal specific genului (cele doua se combina, nu se inlocuiesc).
// -----------------------------------------------------------------------------------------------
for (const genre of ALL_16_GENRES) {
  for (const voicePreference of ['female', 'male', 'duet']) {
    test(`P4: genul "${genre}" + voce="${voicePreference}" — instructiunea de voce a clientului ramane prezenta (forma completa sau scurta, niciodata eliminata) ALATURI de caracterul vocal al genului`, () => {
      const prompt = buildPrompt(baseOrder('ro', genre, voicePreference), '', undefined);
      const expectedVoiceWord = voicePreference === 'duet' ? /duet/i : new RegExp(voicePreference === 'female' ? 'Female vocal|female lead vocal' : 'Male vocal|male lead vocal', 'i');
      assert.match(prompt, expectedVoiceWord, `voce "${voicePreference}" trebuie sa apara pentru genul ${genre} — prompt: ${prompt}`);
    });
  }
}

// -----------------------------------------------------------------------------------------------
// "auto" (Alegem pentru tine) inseamna explicit NICIO instructiune de gen al vocii — lasat liber.
// -----------------------------------------------------------------------------------------------
test('P4: voce="auto" nu adauga nicio instructiune de gen al vocii (Suno alege liber), pentru orice gen', () => {
  for (const genre of ['jazz', 'hiphop', 'manele_jale', 'colind']) {
    const prompt = buildPrompt(baseOrder('ro', genre, 'auto'), '', undefined);
    assert.ok(!/female (lead )?vocal\.|male (lead )?vocal\./i.test(prompt), `genul "${genre}": nicio instructiune fortata de gen al vocii nu trebuie sa apara pentru "auto" — prompt: ${prompt}`);
  }
});

// -----------------------------------------------------------------------------------------------
// Combinatia gen-muzical + voce functioneaza identic in toate cele 8 limbi (limba versurilor nu
// schimba caracterul vocal descris in engleza catre furnizor).
// -----------------------------------------------------------------------------------------------
for (const lang of LANGS) {
  test(`P4/${lang.toUpperCase()}: caracterul vocal al genului "hiphop" (rap verses) SI vocea "male" apar amandoua, indiferent de limba versurilor`, () => {
    const prompt = buildPrompt(baseOrder(lang, 'hiphop', 'male'), '', undefined);
    assert.match(prompt, /rap verses/i, `${lang}: caracterul vocal specific hiphop trebuie sa apara`);
    assert.match(prompt, /male (lead )?vocal/i, `${lang}: vocea masculina aleasa trebuie sa apara`);
    assert.match(prompt, new RegExp(`entirely in `, 'i'), `${lang}: limba versurilor trebuie mentionata`);
  });
}

// -----------------------------------------------------------------------------------------------
// Acelasi comportament pentru versuri exact/locked (buildExactLyricsRequest, campul `style`).
// -----------------------------------------------------------------------------------------------
test('P4: buildExactLyricsRequest() combina identic caracterul vocal al genului cu vocea aleasa (campul style), pentru versuri deja blocate', () => {
  const order = { plan: 'premium', lang: 'ro', voicePreference: 'auto' };
  const result = buildExactLyricsRequest(order, 'Versuri deja scrise.', 'jazz', 'female', '');
  assert.match(result.style, /soulful vocal/i);
  assert.match(result.style, /Female lead vocal/i);
  assert.equal(result.lyrics, 'Versuri deja scrise.');
});

// -----------------------------------------------------------------------------------------------
// SIGURANTA: nicio instructiune de voce (gen SAU caracter) nu foloseste "sing like [artist]" sau
// clonare vocala — vezi si test/genre-differentiation-v2.test.js pentru GENRE_STYLE_MAP insusi.
// -----------------------------------------------------------------------------------------------
test('P4: instructiunile de voce (female/male/duet, full+short) nu contin nicio referinta la un artist real sau la clonare vocala', () => {
  const idx = server.indexOf('const VOICE_INSTRUCTIONS_FULL = {');
  const end = server.indexOf('const requestedVoicePref');
  const body = server.slice(idx, end);
  assert.ok(!/sing like|clone|impersonat/i.test(body), 'nicio instructiune de voce nu trebuie sa ceara imitarea/clonarea unei voci reale');
});
