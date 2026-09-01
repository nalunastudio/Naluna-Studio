// Teste pentru runda curenta (hotfix 2026-08-09), STRICT limitata la doua cerinte:
// (1) "Amândoi" adaugat la Bunică/Bunic (langa Mamă/Tată deja existent la parinti/matusa-unchi/
//     socri) — reutilizeaza EXACT acelasi mecanism generic recipientMode='both'+recipientNames.
// (2) Versurile trebuie sa foloseasca relatia IMPREUNA cu numele (niciodata doar prenumele) la
//     Bunică/Bunic, Mamă/Tată, Mătușă/Unchi, Soacră/Socru — la generare INITIALA SI regenerare.
// Acopera cele 11 teste obligatorii cerute explicit de client (vezi comentariile per test).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// Extrage buildPrompt() (si dependintele ei contigue) direct din server.js si il RULEAZA cu date
// sintetice, exact tiparul stabilit in test/nunta-both-names-no-truncation.test.js. FAMILY_OCCASIONS
// e definit LA LINIA 139 din server.js, in AFARA ferestrei extrase (SUNO_PROMPT_MAX_LEN e mult mai
// jos) — trebuie adaugat manual in preludiul sandbox-ului, la fel ca VOICE_PREFERENCES.
function loadBuildPrompt() {
  const server = read('server.js');
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
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
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}

const buildPrompt = loadBuildPrompt();
const server = read('server.js');
const comanda = read('public/comanda.html');
const melodiaMea = read('public/melodia-mea.html');

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'bunici',
    genre: 'pop',
    lang: 'ro',
    senderName: 'Ana',
    relationship: 'nepoata',
    senderRole: 'granddaughter',
    voicePreference: 'auto',
    story: 'O poveste scurta, obisnuita, despre bunica noastra draga si amintirile frumoase din copilarie.'
  }, overrides);
}

function worstCaseOrder(overrides) {
  return Object.assign({
    genre: 'manele',
    lang: 'ro',
    senderName: 'I'.repeat(100),
    relationship: 'R'.repeat(60),
    voicePreference: 'duet',
    story: 'S'.repeat(2000)
  }, overrides);
}

// ---------------------------------------------------------------------------------------------
// TEST 1: Bunică/Bunic afiseaza si optiunea "Amândoi" (langa Mamă/Tată deja existent).
// ---------------------------------------------------------------------------------------------
test('comanda.html: bunici are acum 3 optiuni de recipientRole, incluzand "grandparents" (Amândoi)', () => {
  const match = comanda.match(/const RECIPIENT_ROLE_OPTIONS = \{[\s\S]*?\n\s*\};/);
  assert.ok(match, 'nu am gasit RECIPIENT_ROLE_OPTIONS');
  assert.match(match[0], /bunici:\s*\[['"]grandmother['"],\s*['"]grandfather['"],\s*['"]grandparents['"]\]/);
});

test('comanda.html: FAMILY_BOTH_ROLES include acum "grandparents" (afiseaza cardul "Amândoi" pentru bunici)', () => {
  assert.match(server, /const FAMILY_OCCASION_RECIPIENT_ROLES = \{[\s\S]*?bunici: \['grandmother', 'grandfather', 'grandparents'\]/);
  assert.match(comanda, /const FAMILY_BOTH_ROLES = \['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'\];/);
});

// ---------------------------------------------------------------------------------------------
// TEST 2: "Amândoi" afiseaza exact doua campuri de nume (Numele bunicii / Numele bunicului).
// ---------------------------------------------------------------------------------------------
test('comanda.html: FAMILY_BOTH_NAME_LABEL_KEYS.grandparents produce exact doua campuri de nume, cu etichete corecte', () => {
  assert.match(comanda, /grandparents:\s*\{\s*female:\s*'name_grandmother_label',\s*male:\s*'name_grandfather_label'\s*\}/);
  assert.match(comanda, /function renderBothNamesField\(labelKeys, targetSlot\)/);
});

test('comanda.html: cheile de traducere name_grandmother_label / name_grandfather_label exista (folosite de cele doua campuri)', () => {
  const g1 = (comanda.match(/name_grandmother_label:/g) || []).length;
  const g2 = (comanda.match(/name_grandfather_label:/g) || []).length;
  assert.equal(g1, 8, 'name_grandmother_label trebuie sa existe o data per limba (8 limbi)');
  assert.equal(g2, 8, 'name_grandfather_label trebuie sa existe o data per limba (8 limbi)');
});

// ---------------------------------------------------------------------------------------------
// TEST 3 (REVIZUIT 2026-08-13, runda "Amândoi" fara campuri duplicate): "Amândoi" nu mai
// afiseaza/cere doua campuri de nume separate pe aceasta pagina — numele (unul sau doua,
// ex. "Maria și Victor") se introduc O SINGURA DATA pe pagina urmatoare, in campul existent
// "Pentru cine e cântecul (nume)". validateStep(1) nu mai valideaza niciun nume pentru "both".
// ---------------------------------------------------------------------------------------------
test('comanda.html: validateStep(1) NU mai cere/valideaza name1/name2 cand recipientMode==="both", pentru nicio ocazie de familie (deci nici bunici)', () => {
  assert.ok(!/if \(!familyName1 \|\| !familyName2\) ok = false;/.test(comanda), 'validateStep(1) nu trebuie sa mai blocheze continuarea din cauza celor doua campuri de nume');
  assert.ok(!/if \(!nuntaName1 \|\| !nuntaName2\) ok = false;/.test(comanda), 'validateStep(1) nu trebuie sa mai blocheze continuarea din cauza celor doua campuri de nume (nunta)');
});

test('server.js: POST /api/orders NU mai cere recipientNames.name1/name2 pentru ocazii de familie cu recipientMode==="both" (grandparents inclus) — recipientNames e optional', () => {
  assert.match(server, /if \(FAMILY_OCCASIONS\.includes\(occasion\)\) \{[\s\S]{0,2200}if \(recipientMode !== 'both'\) \{/);
  assert.match(server, /const isFamilyBothRole = FAMILY_BOTH_ROLES\.includes\(recipientRole\);/);
  // recipientNames ramane STRICT optional — folosit doar daca e prezent si valid, niciodata cerut.
  assert.ok(!/if \(!isValidString\(name1, 1, 60\) \|\| !isValidString\(name2, 1, 60\)\) \{\s*return res\.status\(400\)/.test(server), 'server.js nu mai trebuie sa respinga comanda pentru lipsa name1/name2');
});

// ---------------------------------------------------------------------------------------------
// TEST 4: selectia recipientRole/recipientMode persista dupa refresh (draft in localStorage).
// name1/name2 raman salvate/restaurate in draft doar pentru compatibilitate cu draft-uri vechi
// (campurile nu mai sunt afisate/citite in fluxul curent) — nu mai sunt parte din contractul activ.
// ---------------------------------------------------------------------------------------------
test('comanda.html: saveDraft/restoreDraft salveaza si restaureaza recipientRole/recipientMode generic (nu hardcodat per ocazie)', () => {
  assert.match(comanda, /recipientRole: recipientRoleInput\.value,[\s\S]{0,20}senderRole: senderRoleInput\.value,[\s\S]{0,20}recipientMode: recipientModeInput\.value,/);
  assert.match(comanda, /if \(draft\.recipientRole\) recipientRoleInput\.value = draft\.recipientRole;/);
});

// ---------------------------------------------------------------------------------------------
// TEST 5 (REVIZUIT): recipientNames (structura veche cu doua nume separate) nu mai e construita
// niciodata din formular — recipient (campul unic, de pe pagina urmatoare) e sursa canonica.
// ---------------------------------------------------------------------------------------------
test('comanda.html: collectPayload trimite intotdeauna recipientNames=null (numele vin exclusiv din campul unic "recipient")', () => {
  assert.match(comanda, /recipientNames: null,/);
});

// ---------------------------------------------------------------------------------------------
// TEST 6: generatorul primeste ambele relatii SI ambele nume complete pentru "Amândoi" la bunici.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: pentru bunici + Amândoi, promptul contine ambele nume complete si nu trunchiaza combo-ul', () => {
  const order = typicalOrder({
    recipient: 'Maria și Ion',
    recipientRole: 'grandparents',
    recipientMode: 'both',
    recipientNames: { name1: 'Maria', name2: 'Ion' }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Recipient: Maria și Ion.'), `promptul trebuie sa contina linia Recipient completa, a produs: ${prompt}`);
});

test('buildPrompt: clauza de relatie pentru "Amândoi" la bunici mentioneaza explicit sa nu fie omisa nicio persoana', () => {
  const order = typicalOrder({
    recipient: 'Maria și Ion',
    recipientRole: 'grandparents',
    recipientMode: 'both',
    recipientNames: { name1: 'Maria', name2: 'Ion' }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Never omit either person.'), `promptul trebuie sa includa instructiunea "Never omit either person.", a produs: ${prompt}`);
});

// ---------------------------------------------------------------------------------------------
// TEST 7: versurile folosesc relatie+nume (nu doar prenume) pentru toate cele 4 categorii.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: bunici (rol individual) instruieste explicit sa NU se foloseasca doar prenumele', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'grandmother', recipientMode: 'single', recipientNames: null });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(/never (bare( first)?|by first) name/i.test(prompt), `promptul trebuie sa interzica adresarea prin prenume gol, a produs: ${prompt}`);
  assert.ok(prompt.includes('"grandmother"') || prompt.includes('grandmother'), 'promptul trebuie sa mentioneze relatia "grandmother"');
});

test('buildPrompt: parinti (Mamă/Tată) instruieste relatie+nume, nu doar prenume', () => {
  const order = typicalOrder({ occasion: 'parinti', recipient: 'Elena', recipientRole: 'mother', senderRole: 'daughter', recipientMode: 'single', recipientNames: null });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(/never (bare( first)?|by first) name/i.test(prompt));
  assert.ok(prompt.includes('mother'));
});

test('buildPrompt: matusa-unchi (Mătușă/Unchi) instruieste relatie+nume, nu doar prenume', () => {
  const order = typicalOrder({ occasion: 'matusa-unchi', recipient: 'Ana', recipientRole: 'aunt', senderRole: 'niece', recipientMode: 'single', recipientNames: null });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(/never (bare( first)?|by first) name/i.test(prompt));
  assert.ok(prompt.includes('aunt'));
});

test('buildPrompt: socri (Soacră/Socru) foloseste forma romaneasca exacta "mama-soacră"/"tata-socru" cand versurile sunt in romana', () => {
  const orderMother = typicalOrder({ occasion: 'socri', recipient: 'Elena', recipientRole: 'mother_in_law', senderRole: 'daughter_in_law', recipientMode: 'single', recipientNames: null, lang: 'ro' });
  const promptMother = buildPrompt(orderMother, '', undefined);
  assert.ok(promptMother.includes('mama-soacră'), `promptul RO pentru soacra trebuie sa contina "mama-soacră", a produs: ${promptMother}`);

  const orderFather = typicalOrder({ occasion: 'socri', recipient: 'Victor', recipientRole: 'father_in_law', senderRole: 'son_in_law', recipientMode: 'single', recipientNames: null, lang: 'ro' });
  const promptFather = buildPrompt(orderFather, '', undefined);
  assert.ok(promptFather.includes('tata-socru'), `promptul RO pentru socru trebuie sa contina "tata-socru", a produs: ${promptFather}`);
});

test('buildPrompt: Nuntă/Botez (in afara scopului acestei runde) ramane EXACT neschimbat — fara "never bare name"', () => {
  const order = worstCaseOrder({ occasion: 'nunta', weddingType: 'wedding', recipient: 'Maria', recipientRole: 'bride', senderRole: 'groom', recipientMode: 'single', recipientNames: null, lang: 'ro' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(!/never (bare( first)?|by first) name/i.test(prompt), 'Nuntă/Botez NU trebuie sa capete noua instructiune de adresare — comportament original neschimbat');
  assert.ok(/Mention (naturally, once|once):/i.test(prompt), 'Nuntă/Botez trebuie sa pastreze formularea originala "Mention naturally/once"');
});

// ---------------------------------------------------------------------------------------------
// TEST 8: niciun al doilea nume nu e redus la initiala, in niciun scenariu (inclusiv cel mai rau caz).
// ---------------------------------------------------------------------------------------------
test('buildPrompt: bunici + Amândoi, cel mai rau caz (nume 60 caractere, poveste/relatie/expeditor la maxim) pastreaza ambele nume intregi', () => {
  const name1 = 'A'.repeat(60);
  const name2 = 'B'.repeat(60);
  const order = worstCaseOrder({
    occasion: 'bunici',
    recipient: `${name1} și ${name2}`,
    recipientRole: 'grandparents',
    senderRole: 'granddaughter',
    recipientMode: 'both',
    recipientNames: { name1, name2 }
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(name1), 'primul nume (60 caractere) trebuie sa apara intreg');
  assert.ok(prompt.includes(name2), 'al doilea nume (60 caractere) trebuie sa apara intreg');
  assert.ok(prompt.includes('Recipient:'), 'linia Recipient nu trebuie sa fie taiata complet de limita finala de 500 caractere');
});

['parinti', 'matusa-unchi', 'socri'].forEach(occasion => {
  test(`buildPrompt: ${occasion} + Amândoi, cel mai rau caz pastreaza ambele nume intregi, fara reducere la initiala`, () => {
    const name1 = 'A'.repeat(60);
    const name2 = 'B'.repeat(60);
    const rolesByOccasion = {
      parinti: { recipientRole: 'parents', senderRole: 'daughter' },
      'matusa-unchi': { recipientRole: 'aunt_uncle', senderRole: 'niece' },
      socri: { recipientRole: 'parents_in_law', senderRole: 'daughter_in_law' }
    };
    const order = worstCaseOrder({
      occasion,
      recipient: `${name1} și ${name2}`,
      recipientMode: 'both',
      recipientNames: { name1, name2 },
      ...rolesByOccasion[occasion]
    });
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.includes(name1), `${occasion}: primul nume trebuie sa apara intreg`);
    assert.ok(prompt.includes(name2), `${occasion}: al doilea nume trebuie sa apara intreg`);
    assert.ok(!prompt.includes(`${name1} și A`) || prompt.includes(`${name1} și ${name2}`), `${occasion}: al doilea nume nu trebuie redus la initiala`);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 9: regenerarea/editarea pastreaza aceleasi relatii+nume (aplica noua regula si la editare).
// ---------------------------------------------------------------------------------------------
test('server.js: /api/orders/:orderId/regenerate foloseste order = req.order (din DB), NU accepta recipientRole/senderRole/recipientNames din request body', () => {
  const start = server.indexOf("app.post('/api/orders/:orderId/regenerate'");
  assert.ok(start !== -1, 'nu am gasit endpoint-ul de regenerare');
  const nextRouteIdx = server.indexOf('\napp.', start + 10);
  const routeBody = server.slice(start, nextRouteIdx === -1 ? server.length : nextRouteIdx);
  assert.ok(routeBody.includes('const order = req.order;'), 'regenerarea trebuie sa foloseasca comanda existenta din DB, nu date noi din request');
  assert.ok(!/req\.body\??\.recipientRole/.test(routeBody), 'regenerarea NU trebuie sa accepte recipientRole din request body');
  assert.ok(!/req\.body\??\.recipientNames/.test(routeBody), 'regenerarea NU trebuie sa accepte recipientNames din request body');
  assert.ok(routeBody.includes('runGeneration('), 'regenerarea trebuie sa delege la runGeneration(), care re-citeste comanda din DB');
});

test('server.js: runGeneration() re-citeste comanda din DB (db.getOrderById) inainte de buildPrompt — recipientRole/senderRole/recipientNames vin mereu din DB, nu din requestul de regenerare', () => {
  const start = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  assert.ok(start !== -1, 'nu am gasit runGeneration()');
  const snippet = server.slice(start, start + 400);
  assert.ok(snippet.includes('const order = await db.getOrderById(orderId);'), 'runGeneration trebuie sa citeasca intotdeauna comanda curenta din DB');
  assert.ok(server.slice(start).indexOf('buildPrompt(order,') !== -1, 'runGeneration trebuie sa apeleze buildPrompt() cu comanda citita din DB');
});

test('buildPrompt: acelasi order (relatii+nume nemodificate) produce aceeasi clauza de relatie la a doua rulare (regenerare = generare initiala)', () => {
  const order = typicalOrder({
    recipient: 'Maria și Ion',
    recipientRole: 'grandparents',
    recipientMode: 'both',
    recipientNames: { name1: 'Maria', name2: 'Ion' }
  });
  const promptInitial = buildPrompt(order, '', undefined);
  const promptRegenerated = buildPrompt(order, 'te rog fa versurile mai vesele', undefined);
  assert.ok(promptInitial.includes('Recipient: Maria și Ion.'));
  assert.ok(promptRegenerated.includes('Recipient: Maria și Ion.'));
  assert.ok(promptInitial.includes('Never omit either person.'));
  assert.ok(promptRegenerated.includes('Never omit either person.'));
});

// ---------------------------------------------------------------------------------------------
// TEST 10: textele noi exista in toate cele 8 limbi, fara text romanesc netradus ca fallback vizibil.
// ---------------------------------------------------------------------------------------------
test('comanda.html: name_grandmother_label / name_grandfather_label au valori distincte, netraduse identic intre limbi (nu fallback RO vizibil)', () => {
  const langBlocks = { ro: 'Numele bunicii', en: "Grandmother's name", de: 'Name der Oma', es: 'Nombre de la abuela', it: 'Nome della nonna', fr: 'Prénom de la grand-mère', bg: 'Име на бабата', tr: 'Büyükannenin adı' };
  Object.entries(langBlocks).forEach(([lang, expected]) => {
    assert.ok(comanda.includes(`name_grandmother_label: ${JSON.stringify(expected).replace(/"/g, comanda.includes(`'${expected}'`) ? "'" : '"')}`) || comanda.includes(expected), `limba ${lang}: textul asteptat "${expected}" trebuie sa existe in comanda.html`);
  });
  // niciuna dintre traducerile non-RO nu trebuie sa foloseasca literal textul romanesc
  assert.ok(!comanda.slice(comanda.indexOf('en: {'), comanda.indexOf('de: {')).includes('Numele bunicii'));
});

test('comanda.html: exista exact 8 blocuri de limba (ro/en/de/es/it/fr/bg/tr) in translations', () => {
  const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
  ALLOWED_LANGS.forEach(lang => {
    assert.match(comanda, new RegExp(`\\n\\s*${lang}: \\{`), `blocul de traduceri pentru "${lang}" trebuie sa existe`);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 11: restul paginii si toate pachetele au ramas neschimbate (regresie de scop).
// ---------------------------------------------------------------------------------------------
test('comanda.html: sectiunea "Tu ești: Nepoată/Nepot" (SENDER_ROLE_OPTIONS pentru bunici) nu a fost restructurata, doar extinsa cu grandparents pe aceeasi linie', () => {
  assert.match(comanda, /grandmother: \['granddaughter', 'grandson'\], grandfather: \['granddaughter', 'grandson'\], grandparents: \['granddaughter', 'grandson'\],/);
});

test('server.js: FAMILY_RECIPIENT_TO_SENDER_ROLES pastreaza granddaughter/grandson pentru grandmother/grandfather (neschimbate) si adauga grandparents cu aceleasi valori', () => {
  assert.match(server, /grandmother: \['granddaughter', 'grandson'\],\s*grandfather: \['granddaughter', 'grandson'\],\s*grandparents: \['granddaughter', 'grandson'\],/);
});

test('melodia-mea.html: FAMILY_BOTH_PAIR_KEYS a primit grandparents fara sa modifice parents/aunt_uncle/parents_in_law existente', () => {
  assert.match(melodiaMea, /grandparents: \['grandmother', 'grandfather'\],[\s\S]{0,80}parents: \['mother', 'father'\],/);
});

test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
