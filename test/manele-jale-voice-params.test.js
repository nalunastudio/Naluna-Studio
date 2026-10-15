// manele_jale — parametri structurati reali (model V6, vocalGender, negativeTags) catre SunoAPI.
//
// CONTEXT: test real (SunoAPI, 2026-10-11) a demonstrat ca vocea manele_jale e aproape absenta
// din mix (sub 9% din energia audio, masurat cu Demucs) cand genul/vocea sunt comunicate STRICT
// prin text descriptiv, pe modelul V4_5ALL implicit, fara vocalGender/negativeTags trimise catre
// Suno. Trecerea la customMode:true + parametri structurati + model V6 a adus vocea la 41-42%,
// prezenta in toate ferestrele de 10s, inclusiv la final.
//
// CORECTIE 2026-10-12 (verificat direct in documentatia oficiala SunoAPI): vocalGender si
// negativeTags sunt valabile STRICT la customMode:true ("Do not pass this field when customMode
// is false") — la customMode:false (fluxul standard, majoritatea comenzilor), STRICT modelul
// (V6) e aplicat; vocalGender/negativeTags raman neatinse/absente, ca sa nu incalcam contractul
// API. Instructiunea textuala de voce din buildPrompt() ramane singurul mecanism la customMode:false.
//
// Acest test verifica STRICT applySunoVoiceOverrides() din server.js — extrasa direct din sursa
// reala, acelasi tipar de extractie deja folosit in test/manele-jale-style-differentiation.test.js.
//
// Scope STRICT: applySunoVoiceOverrides() si semnatura callMusicProvider(). buildPrompt(),
// buildExactLyricsRequest(), GENRE_STYLE_MAP, povestea/ocazia/preview-ul de 50s, instructiunea
// textuala de voce din prompt, modelul celorlalte 22 de genuri (V4_5ALL) — toate NEATINSE,
// verificat explicit mai jos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

function extractConst(marker, terminator) {
  const start = server.indexOf(marker);
  assert.ok(start !== -1, `${marker} negasita in server.js`);
  const end = server.indexOf(terminator, start) + terminator.length;
  return server.slice(start, end);
}

// Extragem STRICT applySunoVoiceOverrides() (si constantele de care depinde) din server.js real —
// acelasi tipar de extractie (markeri + brace-matching) deja folosit in
// test/manele-jale-style-differentiation.test.js (loadBuildPrompt).
function loadApplySunoVoiceOverrides() {
  const negTagsSnippet = extractConst("const MANELE_JALE_NEGATIVE_TAGS = '", "';");
  const modelSnippet = extractConst("const MANELE_JALE_MODEL = '", "';");

  const fnMarker = 'function applySunoVoiceOverrides(requestBody, genre, voicePreference) {';
  const fnStart = server.indexOf(fnMarker);
  assert.ok(fnStart !== -1, 'applySunoVoiceOverrides negasita in server.js');
  let depth = 0, i = server.indexOf('{', fnStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnSnippet = server.slice(fnStart, i + 1);

  const sandboxSrc = `${negTagsSnippet}\n${modelSnippet}\n${fnSnippet}\nreturn applySunoVoiceOverrides;`;
  return new Function(sandboxSrc)();
}
const applySunoVoiceOverrides = loadApplySunoVoiceOverrides();

function loadMusicProviderSignature() {
  const marker = 'async function callMusicProvider(orderId, requestInput, genre, voicePreference) {';
  return server.includes(marker);
}

const MANELE_JALE_NEGATIVE_TAGS = 'harmonica, accordion, church organ, drums, choir, backing vocals, crowd noise, applause, EDM, trap, electronic beat';
const MANELE_JALE_MODEL = 'V6';

function customBody(overrides) {
  return Object.assign({ prompt: 'x', customMode: false, instrumental: false, model: 'V4_5ALL', callBackUrl: 'y' }, overrides);
}

// ===============================================================================================
// TEST 1 — callMusicProvider() accepta acum genre/voicePreference ca parametri expliciti.
// ===============================================================================================
test('1) callMusicProvider() are STRICT semnatura noua (orderId, requestInput, genre, voicePreference)', () => {
  assert.ok(loadMusicProviderSignature(), 'semnatura callMusicProvider nu a fost gasita verbatim — asteptata (orderId, requestInput, genre, voicePreference)');
});

// ===============================================================================================
// TEST 2 — manele_jale + customMode:FALSE (fluxul standard): STRICT modelul trece la V6;
// vocalGender/negativeTags raman absente (interzise de API la customMode:false).
// ===============================================================================================
test('2a) manele_jale + customMode:false + voce=female -> model:"V6", FARA vocalGender, FARA negativeTags', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: false }), 'manele_jale', 'female');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, undefined, 'vocalGender NU trebuie trimis la customMode:false (interzis de API)');
  assert.equal(result.negativeTags, undefined, 'negativeTags NU trebuie trimis la customMode:false (interzis de API)');
});

test('2b) manele_jale + customMode:false + voce=male -> model:"V6", FARA vocalGender, FARA negativeTags', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: false }), 'manele_jale', 'male');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, undefined);
  assert.equal(result.negativeTags, undefined);
});

test('2c) manele_jale + customMode:false + voce=duet -> model:"V6", FARA vocalGender, FARA negativeTags', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: false }), 'manele_jale', 'duet');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, undefined);
  assert.equal(result.negativeTags, undefined);
});

// ===============================================================================================
// TEST 3 — manele_jale + customMode:TRUE (versuri exacte editate de client): model V6 +
// vocalGender + negativeTags, toate permise si aplicate.
// ===============================================================================================
test('3a) manele_jale + customMode:true + voce=female -> model:"V6", vocalGender:"f", negativeTags prezent', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: true }), 'manele_jale', 'female');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, 'f');
  assert.equal(result.negativeTags, MANELE_JALE_NEGATIVE_TAGS);
});

test('3b) manele_jale + customMode:true + voce=male -> model:"V6", vocalGender:"m", negativeTags prezent', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: true }), 'manele_jale', 'male');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, 'm');
  assert.equal(result.negativeTags, MANELE_JALE_NEGATIVE_TAGS);
});

// Suno nu are o valoare vocalGender pentru duet — chiar la customMode:true, nu setam vocalGender
// pentru duet/auto; instructiunea textuala existenta din buildPrompt()/buildExactLyricsRequest()
// ramane singurul mecanism pentru duet, neschimbata.
test('3c) manele_jale + customMode:true + voce=duet -> model:"V6", FARA vocalGender (API nu are valoare pentru duet), negativeTags prezent', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: true }), 'manele_jale', 'duet');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, undefined, 'Suno nu are valoare vocalGender pentru duet — nu trebuie setata, nici la customMode:true');
  assert.equal(result.negativeTags, MANELE_JALE_NEGATIVE_TAGS);
});

test('3d) manele_jale + customMode:true + voce=auto -> model:"V6", FARA vocalGender, negativeTags prezent', () => {
  const result = applySunoVoiceOverrides(customBody({ customMode: true }), 'manele_jale', 'auto');
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, undefined);
  assert.equal(result.negativeTags, MANELE_JALE_NEGATIVE_TAGS);
});

// ===============================================================================================
// TEST 4 — REGRESIE: orice alt gen ramane BYTE-FOR-BYTE neschimbat (model ramane V4_5ALL din
// requestBody original), indiferent de voicePreference sau customMode. Cel mai important test
// din acest fisier — garanteaza ca cele 22 de genuri ramase si modelul lor NU sunt atinse.
// ===============================================================================================
const OTHER_GENRES = ['emotional', 'suflet', 'acustic', 'petrecere', 'balada', 'manele', 'modern',
  'pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop',
  'edm_dance', 'manele_suflet', 'populara', 'copii', 'colind', 'romantic', 'motivational', undefined, null, ''];

test('4) pentru orice gen diferit de manele_jale, requestBody ramane BYTE-FOR-BYTE neschimbat (model ramane V4_5ALL, toate cele 3 voci, ambele customMode)', () => {
  for (const genre of OTHER_GENRES) {
    for (const voicePreference of ['female', 'male', 'duet', 'auto', undefined]) {
      for (const customMode of [true, false]) {
        const body = customBody({ customMode });
        const result = applySunoVoiceOverrides(body, genre, voicePreference);
        assert.deepEqual(result, body, `gen "${genre}" + voce "${voicePreference}" + customMode=${customMode}: requestBody a fost modificat, nu ar fi trebuit`);
        assert.equal(result, body, `gen "${genre}": trebuie returnat STRICT acelasi obiect (referinta), nicio copie`);
        assert.equal(result.model, 'V4_5ALL', `gen "${genre}": modelul trebuie sa ramana V4_5ALL, neschimbat`);
      }
    }
  }
});

// ===============================================================================================
// TEST 5 — campurile EXISTENTE din requestBody (prompt/style/title/instrumental/callBackUrl)
// raman complet neatinse pentru manele_jale — doar model/vocalGender/negativeTags sunt adaugate
// sau schimbate, nimic altceva nu e sters sau suprascris.
// ===============================================================================================
test('5) manele_jale: campurile existente din requestBody raman neatinse (in afara de model)', () => {
  const body = customBody({ prompt: 'povestea completa aici', customMode: false, callBackUrl: 'https://x/callback' });
  const result = applySunoVoiceOverrides(body, 'manele_jale', 'female');
  assert.equal(result.prompt, body.prompt);
  assert.equal(result.customMode, body.customMode);
  assert.equal(result.instrumental, body.instrumental);
  assert.equal(result.callBackUrl, body.callBackUrl);
});

test('5b) manele_jale + customMode:true (versuri exacte editate manual): style/title/lyrics raman neatinse', () => {
  const body = { prompt: 'versuri exacte', style: 'Romanian manele de jale, powerful projected live vocal, strong oriental melismatic ornamentation, live-band feel, minor-key melody', title: 'Comanda X', customMode: true, instrumental: false, model: 'V4_5ALL', callBackUrl: 'https://x/callback' };
  const result = applySunoVoiceOverrides(body, 'manele_jale', 'male');
  assert.equal(result.prompt, body.prompt);
  assert.equal(result.style, body.style);
  assert.equal(result.title, body.title);
  assert.equal(result.customMode, true);
  assert.equal(result.model, MANELE_JALE_MODEL);
  assert.equal(result.vocalGender, 'm');
  assert.equal(result.negativeTags, MANELE_JALE_NEGATIVE_TAGS);
});

// ===============================================================================================
// TEST 6 — buildPrompt()/GENRE_STYLE_MAP/preview-ul de 50s raman STRICT neatinse de aceasta
// schimbare (verificare directa in sursa, nu presupunere).
// ===============================================================================================
test('6) GENRE_STYLE_MAP.manele_jale ramane STRICT textul deja aprobat (neatins de aceasta schimbare)', () => {
  assert.match(server, /manele_jale: 'Romanian manele de jale, powerful projected live vocal, strong oriental melismatic ornamentation, live-band feel, minor-key melody',/);
});

test('6b) EXTENDED_PREVIEW_GENRES contine in continuare manele_jale (preview 50s, neatins)', () => {
  assert.match(server, /const EXTENDED_PREVIEW_GENRES = \['manele_suflet', 'manele_jale'\];/);
});

test('6c) applySunoVoiceOverrides() e apelata DUPA construirea requestBody (prin finalRequestBody), nu inlocuieste constructia existenta', () => {
  assert.match(server, /const finalRequestBody = applySunoVoiceOverrides\(requestBody, genre, voicePreference\);/);
  assert.match(server, /body: JSON\.stringify\(finalRequestBody\)/);
});

test('6d) musicModel (variabila de mediu MUSIC_MODEL, V4_5ALL implicit) ramane neschimbat pentru celelalte genuri — doar manele_jale e suprascris, dupa constructia requestBody', () => {
  // REVIZUIT (2026-10-13, "muzica populara — doua directii"): un ternar STRICT pentru
  // genre==='populara' precede acum acest fallback (neatins) — vezi
  // test/populara-direction-selector.test.js pentru verificarea dedicata a acelei ramuri noi;
  // manele_jale ramane suprascris EXCLUSIV via applySunoVoiceOverrides, dupa constructia
  // requestBody, neschimbat.
  assert.match(server, /\(process\.env\.MUSIC_MODEL && process\.env\.MUSIC_MODEL\.trim\(\)\) \|\| 'V4_5ALL';/);
  assert.match(server, /genre === 'populara'\s*\n\s*\? POPULARA_MODEL/);
});
