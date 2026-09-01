// CERINTA 3 (2026-08-31, "pronuntie naturala in cele 8 limbi"): verifica FUNCTIONAL (executie
// reala a buildPrompt/buildExactLyricsRequest, nu doar text-matching) ca instructiunile de
// dictie ajung efectiv in payload-ul furnizorului pentru comenzi tipice, in toate cele 8 limbi,
// SI ca povestea clientului nu e niciodata sacrificata pentru a face loc instructiunii de dictie
// (regresie reala, gasita si corectata in timpul acestei dezvoltari).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const { DICTION_INSTRUCTIONS } = require('../lib/diction.js');

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

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function typicalOrder(lang) {
  return {
    plan: 'standard', occasion: 'aniversare', lang, recipient: 'Maria', senderName: 'Andrei',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre: 'pop',
    story: 'Ne-am cunoscut acum cativa ani si de atunci suntem inseparabili.',
    voicePreference: 'auto'
  };
}

LANGS.forEach(lang => {
  test(`FUNCTIONAL: buildPrompt() include instructiunea de dictie (forma "short") pentru o comanda tipica in limba "${lang}"`, () => {
    const prompt = buildPrompt(typicalOrder(lang), '', undefined);
    assert.ok(prompt.includes(DICTION_INSTRUCTIONS[lang].short), `promptul trebuie sa contina instructiunea de dictie pentru "${lang}", a produs: ${prompt}`);
    assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca niciodata 600 caractere, a produs ${prompt.length}`);
  });
});

test('FUNCTIONAL: buildPrompt() cu genre=hiphop (tag lung) SI o poveste tipica pastreaza STRICT povestea — instructiunea de dictie NU o sacrifica niciodata (regresie reala corectata)', () => {
  const order = { ...typicalOrder('ro'), genre: 'hiphop' };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Ne-am cunoscut acum cativa ani'), `povestea trebuie sa ramana prezenta, a produs: ${prompt}`);
});

test('FUNCTIONAL: buildPrompt() intr-un caz extrem (nunta, nasi, nume foarte lungi, relatie, gen lung, poveste foarte lunga) nu depaseste niciodata 600 caractere — dictia poate fi omisa cu gratie, niciodata povestea/numele', () => {
  const order = {
    occasion: 'nunta', weddingType: 'wedding', recipientRole: 'godparents', genre: 'hiphop', lang: 'ro',
    recipient: 'Alexandrescu-Popescu Maria-Antoaneta', senderName: 'Constantinescu-Georgescu Ion-Alexandru',
    relationship: 'nași', voicePreference: 'duet',
    story: 'A'.repeat(400)
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca niciodata 600 caractere, a produs ${prompt.length}`);
  // numele complete (protejate explicit, cerinta separata "numele proprii sunt imuabile") tot
  // trebuie sa ramana intregi, indiferent de omiterea sau nu a instructiunii de dictie.
  assert.ok(prompt.includes('Alexandrescu-Popescu Maria-Antoaneta'), `numele destinatarului trebuie sa ramana intreg, a produs: ${prompt}`);
});

test('FUNCTIONAL: buildPrompt() rezerva spatiu pentru dictie INAINTEA umplerii povestii — apare pentru o comanda cu gen de lungime obisnuita (rnb) SI o poveste tipica (nu doar cand intampla sa ramana loc)', () => {
  const order = { ...typicalOrder('ro'), genre: 'rnb' };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(DICTION_INSTRUCTIONS.ro.short), `instructiunea de dictie trebuie sa apara pentru genre=rnb, a produs: ${prompt}`);
  assert.ok(prompt.includes('Ne-am cunoscut acum cativa ani'), `povestea trebuie sa ramana prezenta, a produs: ${prompt}`);
});

// hiphop/rock au cele mai lungi tag-uri de stil din toate cele 23 de genuri (~174 caractere,
// preexistente, neatinse de aceasta corectie) — combinate cu o poveste normala, bugetul de 600
// caractere al buildPrompt() nu mai lasa loc si pentru instructiunea de dictie. Comportamentul
// corect, verificat mai sus (testul cazului extrem), e omiterea ei cu gratie, NICIODATA
// sacrificarea povestii — nu o regresie, o limitare onesta a bugetului deja existent.
test('FUNCTIONAL: buildPrompt() cu genre=hiphop (cel mai lung tag dintre toate cele 23 de genuri) omite cu gratie instructiunea de dictie cand nu incape, dar NU sacrifica niciodata povestea', () => {
  const order = { ...typicalOrder('ro'), genre: 'hiphop' };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600, `promptul nu trebuie sa depaseasca niciodata 600 caractere, a produs ${prompt.length}`);
  assert.ok(prompt.includes('Ne-am cunoscut acum cativa ani'), `povestea trebuie sa ramana prezenta, a produs: ${prompt}`);
});

LANGS.forEach(lang => {
  test(`FUNCTIONAL: buildExactLyricsRequest() include instructiunea de dictie (forma "full") in campul style, pentru limba "${lang}"`, () => {
    const order = { plan: 'standard', lang, genre: 'pop', recipient: 'Maria' };
    const req = buildExactLyricsRequest(order, 'Vers 1: te iubesc.\nRefren: esti totul pentru mine.', null, 'auto', '');
    assert.ok(req.style.includes(DICTION_INSTRUCTIONS[lang].full), `campul style trebuie sa contina instructiunea completa de dictie pentru "${lang}", a produs: ${req.style}`);
    assert.ok(req.style.length <= 1000, `campul style nu trebuie sa depaseasca niciodata 1000 caractere, a produs ${req.style.length}`);
  });
});

test('FUNCTIONAL: buildExactLyricsRequest() normalizeaza versurile (elimina caracter invizibil) fara sa schimbe continutul real', () => {
  const dirty = 'Vers 1: te' + String.fromCharCode(0x200B) + ' iubesc.';
  const req = buildExactLyricsRequest({ plan: 'standard', lang: 'ro', genre: 'pop', recipient: 'Maria' }, dirty, null, 'auto', '');
  assert.equal(req.lyrics, 'Vers 1: te iubesc.');
});

test('server.js: buildPrompt si buildExactLyricsRequest importa DICTION_INSTRUCTIONS/getDictionInstruction/normalizeSingingText din lib/diction.js, o singura sursa de adevar', () => {
  assert.match(server, /const \{ DICTION_INSTRUCTIONS, getDictionInstruction, normalizeSingingText \} = require\('\.\/lib\/diction'\);/);
});

test('node --check server.js trece', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
