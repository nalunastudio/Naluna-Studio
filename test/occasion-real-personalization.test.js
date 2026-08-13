// Teste de acceptare pentru "CONTINUĂ PROIECTUL EXISTENT NALUNA STUDIO — PERSONALIZAREA
// MELODIEI DUPĂ OCAZIE" (hotfix 2026-08-08): (1) ocazia influenteaza real tema/mesajul/
// refrenul versurilor, cu instructiuni distincte per ocazie si Nuntă vs Botez explicit
// separate; (2) "Amândoi" adaugat pentru mama/tata, matusa/unchi, soacra/socru (NU bunici);
// (3) numele complete, niciodata prescurtate, ajung in prompt si antet. Foloseste MOCKURI
// (executie reala a buildPrompt() cu date sintetice, fara Suno real) — acopera cele 18 teste
// de acceptare explicite din cererea de corectie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// buildPrompt() e o functie PURA — extrasa textual din server.js si evaluata intr-un sandbox,
// fara sa importam server.js intreg (care ar porni serverul HTTP real si ar cere DATABASE_URL).
function loadBuildPrompt() {
  const server = read('server.js');
  const startIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
  let depth = 0, i = server.indexOf('{', funcStart), bodyStart = i;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const funcEnd = i + 1;
  const snippet = server.slice(startIdx, funcEnd);
  const sandboxSrc = `
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function(sandboxSrc)();
}

const buildPrompt = loadBuildPrompt();

function baseOrder(overrides) {
  return Object.assign({
    recipient: 'Maria',
    genre: 'emotional',
    lang: 'ro',
    senderName: 'Andrei',
    relationship: 'prieteni',
    voicePreference: 'auto',
    story: 'O poveste normala, de lungime obisnuita.'
  }, overrides);
}

// -------------------------------------------------------------------------------------------
// 1. Fiecare ocazie existenta are o tema distincta si nevida.
// -------------------------------------------------------------------------------------------
test('buildPrompt: fiecare ocazie produce o instructiune de tema DISTINCTA si NEVIDA in prompt', () => {
  const occasions = ['dor', 'onomastica', 'aniversare', 'declaratie', 'pierdere', 'pentru-mine', 'altceva'];
  const prompts = occasions.map(occasion => buildPrompt(baseOrder({ occasion }), '', undefined));
  const unique = new Set(prompts);
  assert.equal(unique.size, occasions.length, 'fiecare ocazie trebuie sa produca un prompt de ocazie DISTINCT (nicio suprapunere)');
  prompts.forEach((p, i) => assert.ok(p.includes('Occasion:'), `promptul pentru ${occasions[i]} trebuie sa contina eticheta ocaziei`));
});

// -------------------------------------------------------------------------------------------
// 2. Ocazia este salvata si ajunge pana in promptul generatorului.
// -------------------------------------------------------------------------------------------
test('buildPrompt: occasion se regaseste explicit in promptul trimis generatorului', () => {
  const prompt = buildPrompt(baseOrder({ occasion: 'dor' }), '', undefined);
  assert.ok(prompt.includes('Occasion: missing someone'));
});

test('server.js: POST /api/orders salveaza occasion, ajunge in db.createOrder', () => {
  const server = read('server.js');
  assert.ok(server.includes("occasion, recipient: recipient.trim()"));
});

test('db.js: coloana occasion e NOT NULL — nicio comanda nu poate exista fara ocazie', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('occasion TEXT NOT NULL'));
});

// -------------------------------------------------------------------------------------------
// 3. Ziua numelui NU este tratata ca zi de nastere.
// -------------------------------------------------------------------------------------------
test('buildPrompt: "onomastica" (ziua numelui) e distincta de "aniversare" — eticheta ocaziei e "name day", nu "birthday"', () => {
  const prompt = buildPrompt(baseOrder({ occasion: 'onomastica' }), '', undefined);
  assert.ok(prompt.includes('Occasion: name day'), 'eticheta ocaziei trebuie sa fie explicit "name day"');
  assert.ok(!prompt.includes('Occasion: birthday'), 'eticheta ocaziei NU trebuie sa fie "birthday" pentru onomastica');
  // instructiunea contine interzicerea explicita a confuziei cu ziua de nastere — in forma
  // completa SAU scurta (cascada de scurtare poate comprima instructiunea daca restul
  // campurilor sunt lungi; ambele forme pastreaza garantia esentiala).
  assert.ok(prompt.includes('Never treat this as a birthday') || prompt.includes('not a birthday'));
});

test('server.js: instructiunea "onomastica" interzice explicit confuzia cu ziua de nastere si varsta', () => {
  const server = read('server.js');
  const idx = server.indexOf('onomastica: {');
  const slice = server.slice(idx, idx + 400);
  assert.ok(slice.includes('Never treat this as a birthday'));
  assert.ok(slice.includes('never invent or imply their age'));
});

// -------------------------------------------------------------------------------------------
// 4. "Mi-e dor de cineva" nu presupune ca persoana a murit.
// -------------------------------------------------------------------------------------------
test('buildPrompt: "dor" e distinct de "In memoria cuiva" — eticheta ocaziei e "missing someone", nu moarte/pierdere', () => {
  const prompt = buildPrompt(baseOrder({ occasion: 'dor' }), '', undefined);
  assert.ok(prompt.includes('Occasion: missing someone'), 'eticheta ocaziei trebuie sa fie explicit "missing someone"');
  assert.ok(!prompt.includes('Occasion: in loving memory'), 'eticheta ocaziei NU trebuie sa fie cea de la "In memoria cuiva"');
  // interzicerea explicita a sugerarii mortii — in forma completa SAU scurta (cascada de
  // scurtare poate comprima instructiunea; ambele forme pastreaza garantia esentiala).
  assert.ok(prompt.includes('Never imply the person has died') || prompt.includes('never implies death'));
});

test('server.js: instructiunea "dor" interzice explicit sugerarea mortii', () => {
  const server = read('server.js');
  const idx = server.indexOf('dor: {');
  const slice = server.slice(idx, idx + 500);
  assert.ok(slice.includes('Never imply the person has died'));
});

// -------------------------------------------------------------------------------------------
// 5. "In memoria cuiva" e tratata respectuos, fara limbaj festiv.
// -------------------------------------------------------------------------------------------
test('buildPrompt: "pierdere" (in memoria cuiva) interzice explicit limbajul festiv', () => {
  const prompt = buildPrompt(baseOrder({ occasion: 'pierdere' }), '', undefined);
  assert.ok(!/\bcelebrat/i.test(prompt) && !/\bfestive\b/i.test(prompt) === false || prompt.includes('never'), 'instructiunea trebuie sa interzica explicit tonul festiv');
  assert.ok(/never (cheerful|festive|celebratory|upbeat)/i.test(prompt));
});

// -------------------------------------------------------------------------------------------
// 6-7. Nunta si botezul au instructiuni tematice diferite; sub-butoanele sunt obligatorii.
// -------------------------------------------------------------------------------------------
test('buildPrompt: "Nuntă" si "Botez" produc instructiuni COMPLET DIFERITE, niciodata amestecate', () => {
  const weddingPrompt = buildPrompt(baseOrder({ occasion: 'nunta', weddingType: 'wedding', recipientRole: 'bride', recipientMode: 'single' }), '', undefined);
  const baptismPrompt = buildPrompt(baseOrder({ occasion: 'nunta', weddingType: 'baptism', recipientRole: 'goddaughter', recipientMode: 'single' }), '', undefined);
  assert.ok(weddingPrompt.includes('Occasion: wedding.'), 'eticheta ocaziei trebuie sa fie explicit "wedding" (nu ambigua "wedding or christening")');
  assert.ok(weddingPrompt.includes('"today is your wedding day"'));
  assert.ok(baptismPrompt.includes('Occasion: christening/baptism.'), 'eticheta ocaziei trebuie sa fie explicit botez');
  assert.ok(baptismPrompt.includes('"today is your baptism day"'));
  // interzicerile explicite ("never baptism" / "never wedding") contin legitim cuvantul opus,
  // ca parte a negatiei — verificam ca fiecare instructiune NU contine o AFIRMATIE pozitiva a
  // celeilalte teme (fara "never" imediat inainte).
  assert.ok(!/(?<!never )baptism day/i.test(weddingPrompt.replace('never baptism', '')));
  assert.ok(!/(?<!never )wedding day/i.test(baptismPrompt.replace('never wedding', '')));
});

test('comanda.html: sub-butoanele Nuntă/Botez exista, plasate imediat dupa cardul "Nuntă/Botez"', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('id="nunta-panel"');
  const slice = html.slice(idx, idx + 600);
  assert.ok(slice.includes('data-i18n="label_nunta_type"'));
  assert.ok(slice.includes('<div class="theme-card theme-subcard nunta-type-card" data-type="wedding">'));
  assert.ok(slice.includes('<div class="theme-card theme-subcard nunta-type-card" data-type="baptism">'));
});

test('comanda.html: alegerea rolului filtreaza dupa weddingType (Miri doar la nunta, Fini doar la botez, Nași la ambele)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("wedding: ['miri', 'nasi'],"));
  assert.ok(html.includes("baptism: ['fini', 'nasi']"));
});

test('server.js: weddingType e OBLIGATORIU si validat strict server-side pentru occasion="nunta"', () => {
  const server = read('server.js');
  assert.ok(server.includes("if (weddingType !== 'wedding' && weddingType !== 'baptism') {"));
  assert.ok(server.includes('const allowedRolesForType = WEDDING_TYPE_ALLOWED_ROLES[weddingType];'));
});

test('server.js: rolul "Miri" nu e acceptat cand weddingType="baptism" si invers (client nu poate amesteca temele)', () => {
  const server = read('server.js');
  assert.ok(server.includes('wedding: [\'groom\', \'bride\', \'couple\', \'godfather\', \'godmother\', \'godparents\'],'));
  assert.ok(server.includes('baptism: [\'godson\', \'goddaughter\', \'godchildren\', \'godfather\', \'godmother\', \'godparents\']'));
  assert.ok(!/wedding:\s*\[[^\]]*godson/.test(server), '"godson" (Fini) nu trebuie sa fie permis la weddingType=wedding');
  assert.ok(!/baptism:\s*\[[^\]]*'groom'/.test(server), '"groom" (Miri) nu trebuie sa fie permis la weddingType=baptism');
});

// -------------------------------------------------------------------------------------------
// 8. Mamă/Tată, Mătușă/Unchi, Soacră/Socru afiseaza fiecare trei optiuni, inclusiv "Amândoi".
// -------------------------------------------------------------------------------------------
// NOTA (CONTINUARE, hotfix 2026-08-09): bunici a primit ulterior si el a treia optiune
// "Amândoi" (test/bunici-amandoi-relation-name.test.js) — toate cele 4 ocazii de familie
// au acum exact 3 optiuni fiecare, acelasi tipar generic.
test('comanda.html: parinti/matusa-unchi/socri/bunici au fiecare 3 optiuni (inclusiv Amândoi)', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("parinti: ['mother', 'father', 'parents'],"));
  assert.ok(html.includes("'matusa-unchi': ['aunt', 'uncle', 'aunt_uncle'],"));
  assert.ok(html.includes("socri: ['mother_in_law', 'father_in_law', 'parents_in_law']"));
  assert.ok(html.includes("bunici: ['grandmother', 'grandfather', 'grandparents'],"), 'bunici a primit si el Amândoi (hotfix 2026-08-09)');
});

test('server.js: FAMILY_BOTH_ROLES contine grandparents/parents/aunt_uncle/parents_in_law', () => {
  const server = read('server.js');
  assert.ok(server.includes("const FAMILY_BOTH_ROLES = ['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'];"));
});

// -------------------------------------------------------------------------------------------
// 9 (REVIZUIT 2026-08-13, runda "Amândoi" fara campuri duplicate): "Amândoi" NU mai solicita
// doua nume separate pe aceasta pagina — numele (unul sau doua, ex. "Maria și Ion") se introduc
// O SINGURA DATA pe pagina urmatoare, in campul existent "Pentru cine e cântecul (nume)".
// -------------------------------------------------------------------------------------------
test('comanda.html: validateStep(1) NU mai cere doua nume separate la "Amândoi" pentru ocaziile de familie', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('if (FAMILY_OCCASIONS.includes(occasionVal)) {');
  const slice = html.slice(idx, idx + 1600);
  assert.ok(!slice.includes('if (!familyName1 || !familyName2) ok = false;'), 'validateStep(1) nu mai trebuie sa blocheze continuarea din cauza a doua nume separate');
});

test('server.js: "Amândoi" de familie NU mai cere ambele nume separate — recipientNames ramane STRICT optional (acelasi mecanism relaxat ca Nuntă/Botez)', () => {
  const server = read('server.js');
  const idx = server.indexOf('if (isFamilyBothRole) {');
  const slice = server.slice(idx, idx + 700);
  assert.ok(!/if \(!isValidString\(name1, 1, 60\) \|\| !isValidString\(name2, 1, 60\)\) \{\s*return res\.status\(400\)/.test(slice), 'server.js nu mai trebuie sa respinga comanda pentru lipsa name1/name2 la ocaziile de familie');
  assert.ok(slice.includes("if (recipientMode !== 'both') {"));
});

// -------------------------------------------------------------------------------------------
// 10-11. Ambele nume complete si ambele relatii ajung in prompt si antet; NICIUN nume redus la
// initiala — executie REALA (nu doar text-matching), pentru toate categoriile noi.
// -------------------------------------------------------------------------------------------
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

test('buildPrompt: "Amândoi" la mama/tata pastreaza AMBELE nume complete, chiar si sub buget extrem', () => {
  const order = worstCaseOrder({
    occasion: 'parinti', recipient: 'Maria și Ion',
    recipientRole: 'parents', recipientMode: 'both', recipientNames: { name1: 'Maria', name2: 'Ion' },
    senderRole: 'daughter'
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Maria și Ion'), `promptul trebuie sa contina "Maria și Ion" intreg, a produs: ${prompt.slice(0, 200)}`);
});

test('buildPrompt: "Amândoi" la matusa/unchi pastreaza AMBELE nume complete, cu nume de 60 caractere', () => {
  const name1 = 'C'.repeat(60);
  const name2 = 'D'.repeat(60);
  const order = worstCaseOrder({
    occasion: 'matusa-unchi', recipient: `${name1} și ${name2}`,
    recipientRole: 'aunt_uncle', recipientMode: 'both', recipientNames: { name1, name2 },
    senderRole: 'niece'
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(name1) && prompt.includes(name2), 'ambele nume de 60 caractere trebuie sa apara intregi');
});

test('buildPrompt: "Amândoi" la soacra/socru pastreaza AMBELE nume complete', () => {
  const order = worstCaseOrder({
    occasion: 'socri', recipient: 'Elena și Mihai',
    recipientRole: 'parents_in_law', recipientMode: 'both', recipientNames: { name1: 'Elena', name2: 'Mihai' },
    senderRole: 'daughter_in_law'
  });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Elena și Mihai'));
});

test('buildPrompt: relatia (recipientRole) SI numele complet ajung amandoua in prompt', () => {
  const order = baseOrder({ occasion: 'parinti', recipient: 'Maria', recipientRole: 'mother', senderRole: 'daughter', recipientMode: 'single' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Recipient: Maria.'), 'numele complet trebuie sa apara');
  assert.ok(prompt.includes('mother'), 'relatia trebuie mentionata in instructiune');
});

// -------------------------------------------------------------------------------------------
// 12 (REVIZUIT 2026-08-13): campurile name1/name2 separate nu mai sunt afisate/citite in niciun
// mod, deci nu mai e nevoie sa fie golite explicit la comutare — nu exista "nume ascuns" de
// eliminat, pentru ca sursa canonica e acum campul unic de pe pagina urmatoare.
// -------------------------------------------------------------------------------------------
test('comanda.html: click pe un card de familie seteaza recipientMode corect si reface UI-ul via refreshRelationUI()', () => {
  const html = read('public/comanda.html');
  const idx = html.indexOf('familyRelationGrid.querySelectorAll(\'.family-relation-card\')');
  const slice = html.slice(idx, idx + 500);
  assert.ok(slice.includes("recipientModeInput.value = FAMILY_BOTH_ROLES.includes(c.dataset.role) ? 'both' : 'single';"));
  assert.ok(slice.includes('refreshRelationUI();'));
});

test('comanda.html: schimbarea grupului Nuntă/Botez sau a tipului goleste numele vechi (nu ramane ascuns un nume dintr-un grup anterior)', () => {
  const html = read('public/comanda.html');
  const typeClickIdx = html.indexOf("document.querySelectorAll('.nunta-type-card').forEach(c => {");
  const typeClickSlice = html.slice(typeClickIdx, typeClickIdx + 650);
  assert.ok(typeClickSlice.includes("name1Input.value = '';") && typeClickSlice.includes("name2Input.value = '';"));
  // A doua aparitie e handler-ul de click (prima, in refreshRelationUI, e doar filtrarea de
  // vizibilitate dupa weddingType, testata separat mai sus).
  const groupClickIdx = html.indexOf("document.querySelectorAll('.nunta-group-card').forEach(c => {", typeClickIdx);
  const groupClickSlice = html.slice(groupClickIdx, groupClickIdx + 550);
  assert.ok(groupClickSlice.includes("name1Input.value = '';") && groupClickSlice.includes("name2Input.value = '';"));
});

// -------------------------------------------------------------------------------------------
// 13. Selectia persista la refresh.
// -------------------------------------------------------------------------------------------
test('comanda.html: saveDraft/restoreDraft persista weddingType, nuntaType, nuntaGroup si numele', () => {
  const html = read('public/comanda.html');
  const saveIdx = html.indexOf('function saveDraft()');
  const saveEndIdx = html.indexOf('function restoreDraft()');
  const saveSlice = html.slice(saveIdx, saveEndIdx);
  assert.ok(saveSlice.includes('weddingType: weddingTypeInput.value,'));
  assert.ok(saveSlice.includes('nuntaType: nuntaType,'));
  assert.ok(saveSlice.includes('name1: name1Input.value,'));

  const restoreSlice = html.slice(saveEndIdx, saveEndIdx + 1500);
  assert.ok(restoreSlice.includes('if (draft.weddingType) weddingTypeInput.value = draft.weddingType;'));
  assert.ok(restoreSlice.includes('if (draft.nuntaType) nuntaType = draft.nuntaType;'));
  assert.ok(restoreSlice.includes('refreshRelationUI();'));
});

// -------------------------------------------------------------------------------------------
// 14. Regenerarea pastreaza ocazia, relatia si numele.
// -------------------------------------------------------------------------------------------
test('server.js: POST /regenerate NU accepta/modifica occasion, recipientRole, senderRole, recipientMode, recipientNames sau weddingType', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/orders/:orderId/regenerate'");
  const endIdx = server.indexOf("app.post(", idx + 10);
  const slice = server.slice(idx, endIdx);
  assert.ok(!slice.includes('req.body?.occasion'));
  assert.ok(!slice.includes('req.body?.recipientRole'));
  assert.ok(!slice.includes('req.body?.weddingType'));
  assert.ok(!slice.includes('req.body?.recipientNames'));
});

test('server.js: buildPrompt citeste occasion/recipientRole/weddingType/recipientNames DIRECT din order (re-fetch din DB), niciodata din request-ul de regenerare', () => {
  const server = read('server.js');
  assert.ok(server.includes('order.occasion === \'nunta\' && WEDDING_TYPE_INSTRUCTIONS[order.weddingType]'));
  assert.ok(server.includes('RELATION_NOUNS[effectiveRecipientRole]'));
});

// -------------------------------------------------------------------------------------------
// 15. Toate textele noi exista in toate cele 8 limbi.
// -------------------------------------------------------------------------------------------
test('comanda.html: toate cheile noi (weddingType, Amândoi, etichete de nume) exista exact de 8 ori', () => {
  const html = read('public/comanda.html');
  const keys = [
    'label_nunta_type:', 'nunta_type_wedding:', 'nunta_type_baptism:', 'val_nunta_type:',
    'name_mother_label:', 'name_father_label:', 'name_aunt_label:', 'name_uncle_label:',
    'name_mother_in_law_label:', 'name_father_in_law_label:'
  ];
  keys.forEach(key => {
    const count = html.split(key).length - 1;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori, a aparut de ${count} ori`);
  });
});

test('server.js: mesajul de validare weddingType exista in toate cele 8 limbi', () => {
  const server = read('server.js');
  const match = server.match(/weddingType:\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'weddingType trebuie sa existe in MISSING_FIELD_MESSAGES');
  ['ro:', 'en:', 'de:', 'es:', 'it:', 'fr:', 'bg:', 'tr:'].forEach(langKey => {
    assert.ok(match[1].includes(langKey), `lipseste limba ${langKey}`);
  });
});

test('melodia-mea.html: WEDDING_TYPE_HEADING_TEMPLATE si HEADING_PERSONALIZED_DUAL_TEMPLATE acopera toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  ['const WEDDING_TYPE_HEADING_TEMPLATE = {', 'const HEADING_PERSONALIZED_DUAL_TEMPLATE = {'].forEach(marker => {
    const idx = html.indexOf(marker);
    assert.ok(idx !== -1, `lipseste ${marker}`);
    const endIdx = html.indexOf('};', idx);
    const slice = html.slice(idx, endIdx);
    ['ro:', 'en:', 'de:', 'es:', 'it:', 'fr:', 'bg:', 'tr:'].forEach(langKey => {
      assert.ok(slice.includes(langKey), `${marker} lipseste limba ${langKey}`);
    });
  });
});

// -------------------------------------------------------------------------------------------
// 16-17. Standard, Premium si Cadou video au ramas neschimbate (regresie).
// -------------------------------------------------------------------------------------------
test('server.js: PLAN_VARIANT_COUNT si preturile pachetelor raman neschimbate', () => {
  const server = read('server.js');
  assert.match(server, /PLAN_VARIANT_COUNT\s*=\s*\{\s*standard:\s*1,\s*premium:\s*2,\s*video:\s*2\s*\}/);
});

test('melodia-mea.html: mecanismele Standard (plata directa, meniu pliabil, alegere variante) raman neatinse', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="standard-preedit-checkout-slot-collapsed"'));
  assert.ok(html.includes('function updateStandardEditMenuVisibility('));
});

// -------------------------------------------------------------------------------------------
// 18. Comenzile vechi continua sa functioneze.
// -------------------------------------------------------------------------------------------
test('db.js: wedding_type e coloana NULLABLE, aditiva (ADD COLUMN IF NOT EXISTS, fara NOT NULL)', () => {
  const dbjs = read('db.js');
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS wedding_type TEXT;'));
  assert.ok(!dbjs.includes('wedding_type TEXT NOT NULL'));
});

test('buildPrompt: comanda VECHE de nunta fara weddingType foloseste fallback-ul generic, nu blocheaza generarea', () => {
  const order = baseOrder({ occasion: 'nunta', recipientRole: 'couple', recipientMode: 'both', recipientNames: { name1: 'Ana', name2: 'Bogdan' }, recipient: 'Ana și Bogdan' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Occasion: wedding or christening'), 'fallback-ul generic "nunta" trebuie folosit cand weddingType lipseste');
  assert.ok(prompt.includes('Ana și Bogdan'), 'numele trebuie sa ramana intacte chiar si pentru comenzi vechi');
});

test('server.js: GET /api/orders/:orderId expune weddingType/recipientMode/recipientNames (altfel antetul nu primeste niciodata datele)', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.get('/api/orders/:orderId'");
  const endIdx = server.indexOf('app.post', idx);
  const slice = server.slice(idx, endIdx);
  assert.ok(slice.includes('recipientMode: order.recipientMode || null,'));
  assert.ok(slice.includes('recipientNames: order.recipientNames || null,'));
  assert.ok(slice.includes('weddingType: order.weddingType || null,'));
});

test('melodia-mea.html: composePersonalizedHeading foloseste fallback-ul VECHI (mirii/finii/nasii) pentru comenzi de nunta fara weddingType', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes("if (order.occasion === 'nunta' && (order.weddingType === 'wedding' || order.weddingType === 'baptism')) {"));
  assert.ok(html.includes('const recipientNoun = order.recipientRole && nouns.recipient[order.recipientRole];'), 'ramura finala (fallback) ramane neschimbata pentru comenzi vechi');
});
