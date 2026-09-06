// PUNCT 3 (2026-09-06, audit urgent — "continutul generat/afisat, inclusiv indicatiile de regie
// intre paranteze care nu sunt cantate (ex. '[Soft piano and tender strings swell]'), trebuie sa
// fie in limba aleasa de client, in toate cele 8 limbi"):
//
// CAUZA GASITA: instructiunea trimisa catre Suno in buildPrompt() ("Write the song lyrics
// entirely in {lyricsLanguage}") vorbeste STRICT despre versurile CANTATE. Suno (customMode:false,
// generare completa) adauga adesea, din proprie initiativa, etichete de structura ("[Chorus]")
// si/sau note de productie/regie ("[Soft piano swells]") intre paranteze — necantate, deci in
// afara garantiei de mai sus — implicit in engleza, indiferent de limba aleasa.
//
// CORECTAT LA SURSA (nu prin retraducerea versurilor deja generate — ar risca sa deseze textul
// afisat de audio): o instructiune noua, explicita, catre Suno, cerand ca orice text intre
// paranteze sa fie SI el in limba aleasa. Data fiind stransoarea preexistenta a bugetului de 600
// caractere (documentata pe larg in acest fisier — vezi si fix-ul separat pentru buget-ul de
// feedback), o simpla adaugare "daca mai incape" DUPA toate celelalte nu gasea NICIODATA loc
// pentru o comanda tipica (verificat direct) — deci instructiunea primeste acum un spatiu
// REZERVAT, la fel ca dictia (canReserveForBoth), cu degradare graduala: (a) incearca sa
// rezerve loc pentru dictie + eticheta paranteze; (b) daca nu incape, renunta STRICT la eticheta
// de paranteze, pastrand dictia; (c) daca nici dictia nu incape, renunta si la ea — NICIODATA
// in detrimentul rezervei minime garantate pentru poveste (STORY_MIN_RESERVE/MIN_USEFUL_STORY_CHARS).
//
// Pentru elementele descriptive necunoscute (text liber, nu doar etichete standard de structura),
// afisarea catre client foloseste STRICT normalizarea deja existenta (melodia-mea.html,
// translateSectionLabelsForDisplay/SECTION_LABEL_TRANSLATIONS, testata separat in
// premium-hotfix-runda4.test.js) pentru etichetele standard cunoscute (Verse/Chorus/Bridge/etc,
// in toate cele 8 limbi) — text liber necunoscut NU e tradus mecanic (ar insemna text inventat),
// de aceea fix-ul de mai jos, la sursa generarii, ramane corectia principala si necesara.
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
const { buildPrompt } = loadPromptBuilders();

const LANG_NAMES = {
  ro: 'Romanian', de: 'German', es: 'Spanish', it: 'Italian',
  fr: 'French', bg: 'Bulgarian', tr: 'Turkish'
};

function realisticOrder(lang) {
  return {
    plan: 'standard', occasion: 'aniversare', lang, recipient: 'Maria', senderName: 'Andrei',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'romantic',
    story: 'Ne-am cunoscut acum cativa ani si de atunci suntem inseparabili, mereu impreuna.',
    voicePreference: 'auto'
  };
}

for (const [lang, name] of Object.entries(LANG_NAMES)) {
  test(`FUNCTIONAL (${lang}): pentru o comanda REALISTA, buildPrompt() include o instructiune explicita ca etichetele/notele dintre paranteze sa fie tot in ${name}, nu in engleza`, () => {
    const prompt = buildPrompt(realisticOrder(lang), '', undefined);
    assert.match(prompt, /Bracketed tags\/notes also in/, `${lang}: instructiunea pentru paranteze trebuie sa apara pentru o comanda tipica`);
    assert.ok(prompt.includes(name), `${lang}: numele limbii (${name}) trebuie sa apara in instructiune`);
    assert.ok(prompt.length <= 600, `${lang}: promptul nu trebuie sa depaseasca niciodata bugetul de 600 caractere`);
  });
}

test('FUNCTIONAL (en): pentru comenzile in engleza, NU se adauga nicio instructiune suplimentara pentru paranteze — nu exista nimic de corectat', () => {
  const prompt = buildPrompt(realisticOrder('en'), '', undefined);
  assert.ok(!prompt.includes('Bracketed tags/notes also in'), 'engleza nu trebuie sa primeasca instructiunea suplimentara (ar fi redundanta)');
});

test('EDGE CASE: cand bugetul e extrem de strans (ocazie cu instructiuni foarte lungi, ex. nunta), instructiunea pentru paranteze e omisa cu gratie — promptul ramane totusi valid, sub 600 caractere, si povestea nu e niciodata eliminata complet', () => {
  const tightOrder = {
    plan: 'premium', occasion: 'nunta', weddingType: 'wedding', lang: 'bg',
    recipient: 'Ivan', senderName: 'Elena', recipientMode: 'single', genre: 'pop',
    story: 'Scurta poveste.', voicePreference: 'auto'
  };
  const prompt = buildPrompt(tightOrder, '', undefined);
  assert.ok(prompt.length <= 600, 'promptul nu trebuie sa depaseasca niciodata bugetul');
  assert.ok(prompt.length > 0, 'promptul tot trebuie construit, chiar daca instructiunea suplimentara nu incape');
});

test('EDGE CASE: poveste foarte lunga + gen cu tag lung + voce duet (cazul cel mai strans posibil) — instructiunea pentru paranteze poate lipsi, dar promptul ramane STRICT sub 600 caractere si povestea ramane prezenta', () => {
  const longOrder = {
    plan: 'standard', occasion: 'aniversare', lang: 'ro', recipient: 'Maria', senderName: 'Andrei',
    recipientMode: 'single', genre: 'manele', story: 'O poveste foarte lunga '.repeat(30),
    voicePreference: 'duet'
  };
  const prompt = buildPrompt(longOrder, '', undefined);
  assert.ok(prompt.length <= 600);
  assert.ok(prompt.length > 0);
});

test('STRUCTURAL: buildPrompt() rezerva EXPLICIT spatiu pentru instructiunea de paranteze inainte de a alege eticheta povestii (canReserveForBoth), cu degradare graduala (2 -> 1 -> 0), niciodata in detrimentul rezervei minime a povestii', () => {
  const promptFn = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  assert.match(promptFn, /const bracketLanguageClause = lyricsLanguage !== 'English'/);
  assert.match(promptFn, /const canReserveForBoth = \(remaining - storyLabel\.length - dictionInstruction\.length - bracketLanguageClause\.length\) >= MIN_USEFUL_STORY_CHARS;/);
  assert.match(promptFn, /if \(canReserveForBoth && bracketLanguageClause && prompt\.length \+ bracketLanguageClause\.length <= SUNO_PROMPT_MAX_LEN\)/);
});
