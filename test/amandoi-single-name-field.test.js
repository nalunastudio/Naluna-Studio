// Test de regresie pentru runda "Amândoi fara campuri duplicate de nume" (2026-08-13).
// Cerinta: pe pagina "Pentru ce moment vrei cântecul?", butonul "Amândoi" ramane selectabil, dar
// NU mai deschide doua campuri separate de nume — numele (unul sau doua, ex. "Maria și Victor")
// se introduc O SINGURA DATA pe pagina urmatoare, in campul existent "Pentru cine e cântecul
// (nume)" (id="recipient" pentru melodia 1, id="song2-recipient-name" pentru melodia 2/Premium).
// Se aplica TUTUROR ramurilor reale unde optiunea interna echivalenta cu both/couple exista:
// FAMILY_BOTH_ROLES (bunici, parinti, matusa/unchi, socri) si NUNTA_BOTH_ROLES (miri, fini, nasi).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const comanda = read('public/comanda.html');
const server = read('server.js');

// ---------------------------------------------------------------------------------------------
// 1. "Amândoi" ramane vizibil/selectabil, in toate cele 8 limbi, si butonul in sine NU a fost sters.
// ---------------------------------------------------------------------------------------------
test('comanda.html: butonul "Amândoi" (nunta_both) ramane definit in toate cele 8 limbi, nesters', () => {
  const occurrences = (comanda.match(/nunta_both: '[^']+'/g) || []).length;
  assert.equal(occurrences, 8, 'trebuie sa existe exact 8 traduceri pentru "Amândoi" (ro/en/de/es/it/fr/bg/tr)');
});

test('comanda.html: FAMILY_BOTH_ROLES si NUNTA_BOTH_ROLES raman definite, neschimbate ca lista de valori', () => {
  assert.ok(comanda.includes("const FAMILY_BOTH_ROLES = ['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'];"));
  assert.ok(comanda.includes("const NUNTA_BOTH_ROLES = ['couple', 'godchildren', 'godparents'];"));
});

test('comanda.html: cardurile de rol ("Amândoi" inclus) raman generate — niciun rol individual (Bunica, Bunic, Mamă, Tată, Mătușă, Unchi, Soacră, Socru, Nașă, Naș) nu a fost eliminat', () => {
  ['grandmother', 'grandfather', 'mother', 'father', 'aunt', 'uncle', 'mother_in_law', 'father_in_law', 'godmother', 'godfather'].forEach(role => {
    assert.ok(comanda.includes(`relation_${role}:`), `cheia relation_${role} trebuie sa existe in continuare`);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Selectarea "Amândoi" NU mai afiseaza cele doua campuri de nume separate — pentru NICIUNA
//    dintre ramurile reale (nu doar exemplele romanesti explicit mentionate de utilizator).
// ---------------------------------------------------------------------------------------------
test('comanda.html: refreshRelationUI() ascunde explicit bothNamesField (nu-l mai afiseaza niciodata) atat pentru ocaziile de familie cat si pentru nunta', () => {
  const start = comanda.indexOf('function refreshRelationUI() {');
  const end = comanda.indexOf('\n  document.querySelectorAll(\'.nunta-type-card\')', start);
  const snippet = comanda.slice(start, end);
  const hideCount = (snippet.match(/bothNamesField\.style\.display = 'none';/g) || []).length;
  assert.ok(hideCount >= 3, 'bothNamesField trebuie ascuns explicit pentru: ocazii de familie, nunta fara subrol ales, nunta cu subrol ales');
  assert.ok(!snippet.includes('renderBothNamesField('), 'refreshRelationUI() nu mai trebuie sa apeleze renderBothNamesField() (care afisa campurile)');
});

test('comanda.html: renderBothNamesField() (functia care afisa cele doua campuri) nu mai este apelata de niciun handler activ din fluxul melodiei 1', () => {
  // functia poate ramane definita (vestigial, minimal-diff), dar NU mai trebuie invocata — cautam
  // apeluri reale (linie fara "function " si fara "//" inaintea numelui, adica nu comentariu).
  const callLines = comanda.split('\n').filter(line => line.includes('renderBothNamesField(') && !line.trim().startsWith('//') && !line.includes('function renderBothNamesField'));
  assert.equal(callLines.length, 0, `renderBothNamesField() nu mai trebuie apelata nicaieri in fluxul melodiei 1, gasit: ${JSON.stringify(callLines)}`);
});

// Bunica+Bunicul, Mama+Tata, Matusa+Unchiul, Soacra+Socrul -> toate trec prin refreshRelationUI(),
// deja verificat generic mai sus (nu exista ramuri per-ocazie separate — mecanismul e comun).
test('comanda.html: RECIPIENT_ROLE_OPTIONS pentru bunici/parinti/matusa-unchi/socri includ rolul "both" corespunzator, randat prin acelasi refreshRelationUI() generic', () => {
  assert.ok(comanda.includes("bunici: ['grandmother', 'grandfather', 'grandparents']") || /bunici:\s*\[[^\]]*grandparents/.test(comanda));
  assert.ok(/parinti:\s*\[[^\]]*parents/.test(comanda));
  assert.ok(/'matusa-unchi':\s*\[[^\]]*aunt_uncle/.test(comanda));
  assert.ok(/socri:\s*\[[^\]]*parents_in_law/.test(comanda));
});

// Miri/fini/nasi (Nuntă/Botez) -> renderNuntaSubroles() + refreshRelationUI(), verificate explicit.
test('comanda.html: renderNuntaSubroles() (Miri/Fini/Nași) seteaza recipientMode dar nu afiseaza campuri de nume separate', () => {
  const start = comanda.indexOf('function renderNuntaSubroles() {');
  const end = comanda.indexOf('function refreshRelationUI()', start);
  const snippet = comanda.slice(start, end);
  assert.ok(snippet.includes("recipientModeInput.value = NUNTA_BOTH_ROLES.includes(c.dataset.role) ? 'both' : 'single';"));
  assert.ok(!snippet.includes('renderBothNamesField('));
});

// ---------------------------------------------------------------------------------------------
// 3. Continuarea NU mai e blocata de validari pentru campurile eliminate — nici pe pasul 1,
//    nici pe pasul 7/8 (melodia 2, Premium).
// ---------------------------------------------------------------------------------------------
test('comanda.html: validateStep(1) nu mai contine nicio referinta la familyName1/familyName2/nuntaName1/nuntaName2 (variabile ale vechii validari cu doua nume)', () => {
  const start = comanda.indexOf('function validateStep(step)');
  const end = comanda.indexOf('function updateStep1ContinueState', start);
  const snippet = start !== -1 && end !== -1 ? comanda.slice(start, end) : comanda;
  assert.ok(!/familyName1|familyName2|nuntaName1|nuntaName2/.test(snippet), 'validateStep(1) nu mai trebuie sa citeasca/valideze cele doua nume separate');
});

test('comanda.html: song2AllValid() si song2DetailsAllValid() nu mai fac referire la song2Name1Input/song2Name2Input', () => {
  const startAllValid = comanda.indexOf('function song2AllValid() {');
  const endAllValid = comanda.indexOf('function updateSong2ContinueState');
  const snippetAllValid = comanda.slice(startAllValid, endAllValid);
  assert.ok(!snippetAllValid.includes('song2Name1Input.value.trim()'));
  assert.ok(!snippetAllValid.includes('song2Name2Input.value.trim()'));

  const startDetails = comanda.indexOf('function song2DetailsAllValid() {');
  const endDetails = comanda.indexOf('function updateSong2DetailsContinueState');
  const snippetDetails = comanda.slice(startDetails, endDetails);
  assert.ok(!snippetDetails.includes('song2Name1Input'));
  assert.ok(!snippetDetails.includes('song2Name2Input'));
  assert.ok(snippetDetails.includes('if (!song2RecipientNameInput.value.trim()) return false;'), 'numele (unic) ramane obligatoriu necondiționat');
});

test('comanda.html: validarea finala din form submit (currentStep===getTotalSteps()) nu mai face referire la song2Name1Input/song2Name2Input/song2BothNamesField pentru numele persoanei 2', () => {
  const idx = comanda.indexOf("if (song2TargetInput.value === 'other') {");
  const endIdx = comanda.indexOf('// ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2', idx);
  const snippet = comanda.slice(idx, endIdx);
  assert.ok(!snippet.includes('song2Name1Input.value.trim()'));
  assert.ok(!snippet.includes('song2Name2Input.value.trim()'));
  assert.ok(!snippet.includes('song2BothNamesField.scrollIntoView'));
  assert.ok(snippet.includes("if (!song2RecipientNameInput.value.trim()) {"), 'validarea finala trebuie sa verifice DOAR campul unic de nume');
});

// ---------------------------------------------------------------------------------------------
// 4. Pagina urmatoare ramane sursa unica a numelui — campul unic accepta unul SAU doua nume.
// ---------------------------------------------------------------------------------------------
test('comanda.html: campul unic "recipient" (melodia 1) si "song2-recipient-name" (melodia 2) raman NEMODIFICATE ca markup — nu s-au adaugat campuri noi, nu s-a schimbat maxlength', () => {
  assert.ok(comanda.includes('<input type="text" id="recipient" placeholder="ex: Maria" data-i18n-placeholder="ph_recipient" maxlength="60">'));
  assert.ok(comanda.includes('<input type="text" id="song2-recipient-name" maxlength="60">'));
});

test('comanda.html: collectPayload() trimite recipient/recipient2 EXACT ce a scris clientul in campul unic, fara sa mai combine name1+name2', () => {
  const idx = comanda.indexOf('function collectPayload()');
  const endIdx = comanda.indexOf('function saveDraft()');
  const slice = comanda.slice(idx, endIdx);
  assert.ok(slice.includes("const recipientVal = document.getElementById('recipient').value;") && slice.includes('recipient: recipientVal,'), 'recipient trebuie sa vina direct din campul unic #recipient, fara combinare de doua nume');
  assert.ok(/recipient2: \(selectedPlan\.id === 'premium' && song2TargetInput\.value === 'other'\)\s*\?\s*song2RecipientNameInput\.value\.trim\(\)/.test(slice), 'recipient2 trebuie sa vina direct din campul unic song2-recipient-name, fara combinare de doua nume');
  assert.ok(!/name1Input\.value/.test(slice));
  assert.ok(!/name2Input\.value/.test(slice));
  assert.ok(!/song2Name1Input\.value/.test(slice));
  assert.ok(!/song2Name2Input\.value/.test(slice));
});

// ---------------------------------------------------------------------------------------------
// 5. Backend: recipientMode/recipientMode2 raman "both" cand rolul e "both"; recipientNames
//    (structura veche cu doua nume) e STRICT optionala — server NU o cere niciodata.
// ---------------------------------------------------------------------------------------------
test('server.js: recipientMode/recipientMode2 raman setate la "both" pentru rolurile din FAMILY_BOTH_ROLES/NUNTA_BOTH_ROLES, indiferent daca recipientNames a fost trimis', () => {
  assert.ok(server.includes("safeRecipientMode = 'both';") || server.includes('safeRecipientMode = expectedMode;'));
  assert.ok(server.includes("safeRecipientMode2 = 'both';") || server.includes('safeRecipientMode2 = expectedMode2;'));
});

test('server.js: nicio ramura de validare (familie/nunta, melodia 1/melodia 2) nu mai respinge comanda din lipsa de recipientNames.name1/name2', () => {
  assert.ok(!/isValidString\(name1, 1, 60\)[\s\S]{0,80}return res\.status\(400\)/.test(server));
  assert.ok(!/isValidString\(name2, 1, 60\)[\s\S]{0,80}return res\.status\(400\)/.test(server));
  assert.ok(!/isValidString\(name1_2, 1, 60\)[\s\S]{0,80}return res\.status\(400\)/.test(server));
  assert.ok(!/isValidString\(name2_2, 1, 60\)[\s\S]{0,80}return res\.status\(400\)/.test(server));
});

test('server.js: recipient/recipient2 (campul unic, pana la 60 caractere) ramane singura validare de nume obligatorie', () => {
  assert.ok(server.includes('isValidString(recipient, 1, 60)'));
});

// ---------------------------------------------------------------------------------------------
// 6. buildPrompt: cand recipientMode==="both", numele complet din campul unic (recipient) ajunge
//    intreg in prompt SI clauza "Never omit either person" ramane activa DOAR pe baza de
//    recipientMode==="both" (nu mai depinde de recipientNames, care acum e frecvent null).
// ---------------------------------------------------------------------------------------------
function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const funcEnd = i + 1;
  const snippet = server.slice(startIdx, funcEnd);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

test('buildPrompt: "Amândoi" (ocazie de familie, ex. parinti) cu recipientNames=null (comportamentul NOU, standard dupa aceasta runda) pastreaza ambele nume intregi in prompt, folosind DOAR campul unic recipient', () => {
  const order = {
    occasion: 'parinti', genre: 'pop', lang: 'ro',
    recipient: 'Maria și Victor',
    recipientRole: 'parents',
    recipientMode: 'both',
    recipientNames: null,
    senderName: 'Ana', relationship: 'fiica', voicePreference: 'duet', story: 'O poveste frumoasa.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Maria și Victor'), `promptul trebuie sa contina "Maria și Victor" intreg, a produs: ${prompt.slice(0, 200)}`);
  assert.ok(prompt.includes('Never omit either person.'), 'clauza "nu omite nicio persoana" trebuie activa doar pe baza recipientMode==="both"');
});

test('buildPrompt: rol individual (recipientMode="single") nu declanseaza clauza "Never omit either person" (fara regresie)', () => {
  const order = {
    occasion: 'parinti', genre: 'pop', lang: 'ro',
    recipient: 'Victor',
    recipientRole: 'father',
    recipientMode: 'single',
    recipientNames: null,
    senderName: 'Ana', relationship: 'fiica', voicePreference: 'female', story: 'O poveste.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(!prompt.includes('Never omit either person.'));
});

// ---------------------------------------------------------------------------------------------
// 7. Navigarea inainte/inapoi intre pasi nu pierde datele deja introduse (draft in localStorage) —
//    recipientRole/recipientMode raman persistate; campul unic de nume nu e curatat de draft.
// ---------------------------------------------------------------------------------------------
test('comanda.html: restoreDraft() nu goleste/suprascrie campul unic "recipient" cu valori din vechile name1/name2', () => {
  const idx = comanda.indexOf('function restoreDraft()');
  const endIdx = comanda.indexOf('const form = document.getElementById(\'order-form\');', idx);
  const snippet = idx !== -1 && endIdx !== -1 ? comanda.slice(idx, endIdx) : '';
  assert.ok(!/recipientInput\.value = `\$\{draft\.name1\}/.test(snippet), 'recipient nu trebuie reconstruit din draft.name1/draft.name2');
});

// ---------------------------------------------------------------------------------------------
// 8. i18n: cheile pentru campurile eliminate nu au fost sterse (compatibilitate), dar nu mai apar
//    ca validari active; textele deja corecte (recipient, nunta_both) raman neschimbate.
// ---------------------------------------------------------------------------------------------
test('comanda.html: cheia val_nunta_names (eroarea vechilor doua campuri) NU mai e folosita in nicio validare activa, dar ramane definita pentru compatibilitate', () => {
  const definitionCount = (comanda.match(/val_nunta_names: '[^']+'/g) || []).length;
  assert.equal(definitionCount, 8, 'cheia trebuie sa ramana definita in toate cele 8 limbi (nu se sterge un i18n key posibil necesar)');
  assert.ok(!comanda.includes("t('val_nunta_names')"), 'val_nunta_names nu mai trebuie apelata efectiv nicaieri in cod');
});

test('comanda.html: campul de nume de pe pagina urmatoare (placeholder-ul "Pentru cine e cântecul") ramane cu textul/traducerea sa originala, neschimbata', () => {
  assert.ok(comanda.includes('ph_recipient'), 'placeholder-ul original al campului recipient trebuie sa ramana referentiat, neschimbat');
});
