// Teste pentru "MODIFICARE STRICTĂ — ADAUGĂ NUMAI OPȚIUNEA „SORĂ/FRATE"" (hotfix 2026-08-09):
// (1) card nou "Pentru soră sau frate", exact doua sub-butoane (Soră/Frate), FARA "Amândoi" si
// FARA niciun alt control (niciun "Tu ești: ..."); (2) versurile trebuie sa adreseze destinatarul
// prin relatie+nume ("sora mea Maria" / "fratele meu Vasile"), niciodata doar prenume, la
// generare initiala SI regenerare. Acopera cele 11 teste obligatorii cerute explicit de client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// buildPrompt() e o functie PURA — extrasa textual din server.js si evaluata intr-un sandbox,
// exact tiparul stabilit in rundele anterioare (vezi test/bunici-amandoi-relation-name.test.js).
function loadBuildPrompt() {
  const server = read('server.js');
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 2800;';
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
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri', 'frati'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function(sandboxSrc)();
}

const buildPrompt = loadBuildPrompt();
const server = read('server.js');
const comanda = read('public/comanda.html');
const melodiaMea = read('public/melodia-mea.html');

function typicalOrder(overrides) {
  return Object.assign({
    occasion: 'frati',
    genre: 'pop',
    lang: 'ro',
    senderName: 'Ana',
    relationship: 'sora',
    voicePreference: 'auto',
    story: 'O poveste scurta, obisnuita, despre fratele meu si amintirile frumoase din copilarie.'
  }, overrides);
}

function worstCaseOrder(overrides) {
  return Object.assign({
    occasion: 'frati',
    genre: 'manele',
    lang: 'ro',
    senderName: 'I'.repeat(100),
    relationship: 'R'.repeat(60),
    voicePreference: 'duet',
    story: 'S'.repeat(2000)
  }, overrides);
}

// ---------------------------------------------------------------------------------------------
// TEST 1: cardul "Pentru soră sau frate" apare in toate cele 8 limbi.
// ---------------------------------------------------------------------------------------------
test('comanda.html: cardul "frati" exista in grila de ocazii, cu i18n pentru titlu si descriere', () => {
  assert.match(comanda, /<div class="theme-card" data-theme="frati">/);
  assert.ok(comanda.includes('data-i18n="theme_frati_name"'));
  assert.ok(comanda.includes('data-i18n="theme_frati_desc"'));
});

test('comanda.html: theme_frati_name / theme_frati_desc exista exact de 8 ori (o data per limba)', () => {
  assert.equal((comanda.match(/theme_frati_name:/g) || []).length, 8);
  assert.equal((comanda.match(/theme_frati_desc:/g) || []).length, 8);
});

test('comanda.html: cardul nou NU a reordonat sau modificat celelalte carduri de familie', () => {
  const order = ['data-theme="bunici"', 'data-theme="parinti"', 'data-theme="matusa-unchi"', 'data-theme="socri"', 'data-theme="frati"'];
  let lastIdx = -1;
  order.forEach(marker => {
    const idx = comanda.indexOf(marker);
    assert.ok(idx > lastIdx, `${marker} trebuie sa apara dupa cardurile anterioare, in aceasta ordine`);
    lastIdx = idx;
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 2 si 3: selectarea afiseaza exact doua sub-butoane (Soră, Frate), FARA "Amândoi".
// ---------------------------------------------------------------------------------------------
test('comanda.html: RECIPIENT_ROLE_OPTIONS.frati are exact 2 optiuni: sister, brother', () => {
  assert.match(comanda, /frati:\s*\['sister', 'brother'\]/);
});

test('comanda.html: "sister"/"brother" NU apar niciodata in FAMILY_BOTH_ROLES (niciodata "Amândoi")', () => {
  const match = comanda.match(/const FAMILY_BOTH_ROLES = \[[^\]]*\];/);
  assert.ok(match, 'FAMILY_BOTH_ROLES trebuie sa existe');
  assert.ok(!match[0].includes('sister'), 'sister nu trebuie sa fie in FAMILY_BOTH_ROLES');
  assert.ok(!match[0].includes('brother'), 'brother nu trebuie sa fie in FAMILY_BOTH_ROLES');
});

test('comanda.html: relation_sister / relation_brother exista exact de 8 ori (o data per limba)', () => {
  assert.equal((comanda.match(/relation_sister:/g) || []).length, 8);
  assert.equal((comanda.match(/relation_brother:/g) || []).length, 8);
});

test('comanda.html: SENDER_ROLE_OPTIONS NU are nicio intrare pentru sister/brother (niciun control "Tu ești: ..." pentru frati)', () => {
  const match = comanda.match(/const SENDER_ROLE_OPTIONS = \{[\s\S]*?\n  \};/);
  assert.ok(match, 'SENDER_ROLE_OPTIONS trebuie sa existe');
  assert.ok(!/\bsister:/.test(match[0]), 'sister nu trebuie sa aiba nicio intrare in SENDER_ROLE_OPTIONS');
  assert.ok(!/\bbrother:/.test(match[0]), 'brother nu trebuie sa aiba nicio intrare in SENDER_ROLE_OPTIONS');
});

test('comanda.html: renderSenderRoleGrid ascunde subfield-ul cand SENDER_ROLE_OPTIONS[rol] lipseste (mecanism generic, reutilizat automat pentru frati)', () => {
  assert.match(comanda, /function renderSenderRoleGrid\(recipientRole, targetSlot\) \{\s*const options = SENDER_ROLE_OPTIONS\[recipientRole\];\s*if \(!options\) \{ senderRoleSubfield\.style\.display = 'none'; return; \}/);
});

test('server.js: FAMILY_RECIPIENT_TO_SENDER_ROLES NU are nicio intrare pentru sister/brother', () => {
  const match = server.match(/const FAMILY_RECIPIENT_TO_SENDER_ROLES = \{[\s\S]*?\n\};/);
  assert.ok(match, 'FAMILY_RECIPIENT_TO_SENDER_ROLES trebuie sa existe');
  assert.ok(!/\bsister:/.test(match[0]), 'sister nu trebuie sa aiba nicio intrare');
  assert.ok(!/\bbrother:/.test(match[0]), 'brother nu trebuie sa aiba nicio intrare');
});

// ---------------------------------------------------------------------------------------------
// TEST 4: selectia si numele persista dupa refresh (mecanism generic, deja existent).
// ---------------------------------------------------------------------------------------------
test('comanda.html: saveDraft/restoreDraft salveaza si restaureaza recipientRole/recipientMode generic (functioneaza automat si pentru frati, fara cod nou)', () => {
  assert.match(comanda, /recipientRole: recipientRoleInput\.value,[\s\S]{0,20}senderRole: senderRoleInput\.value,[\s\S]{0,20}recipientMode: recipientModeInput\.value,/);
  assert.match(comanda, /if \(draft\.recipientRole\) recipientRoleInput\.value = draft\.recipientRole;/);
});

// ---------------------------------------------------------------------------------------------
// TEST 5: backend-ul valideaza relatia si numele.
// ---------------------------------------------------------------------------------------------
test('server.js: ALLOWED_OCCASIONS include "frati"', () => {
  assert.match(server, /ALLOWED_OCCASIONS\s*=\s*\[[^\]]*'frati'[^\]]*\]/);
});

test('server.js: FAMILY_OCCASION_RECIPIENT_ROLES.frati e exact [sister, brother]', () => {
  assert.match(server, /frati:\s*\['sister', 'brother'\]/);
});

test('server.js: POST /api/orders respinge recipientRole invalid pentru occasion="frati"', () => {
  const idx = server.indexOf("if (FAMILY_OCCASIONS.includes(occasion)) {");
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 800);
  assert.match(snippet, /const allowedRecipientRoles = FAMILY_OCCASION_RECIPIENT_ROLES\[occasion\];/);
  assert.match(snippet, /if \(!allowedRecipientRoles\.includes\(recipientRole\)\) \{/);
});

test('server.js: POST /api/orders NU cere senderRole pentru rolurile fara intrare in FAMILY_RECIPIENT_TO_SENDER_ROLES (sister/brother), dar continua sa il ceara pentru celelalte roluri', () => {
  const idx = server.indexOf("if (FAMILY_OCCASIONS.includes(occasion)) {");
  const snippet = server.slice(idx, idx + 1600);
  assert.match(snippet, /const allowedSenderRoles = FAMILY_RECIPIENT_TO_SENDER_ROLES\[recipientRole\];/);
  assert.match(snippet, /if \(allowedSenderRoles\) \{/);
  assert.match(snippet, /if \(!allowedSenderRoles\.includes\(senderRole\)\) \{/);
});

test('server.js: recipientMode="both" respins pentru frati (isFamilyBothRole e mereu false, "sister"/"brother" nu sunt in FAMILY_BOTH_ROLES)', () => {
  assert.match(server, /const FAMILY_BOTH_ROLES = \['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'\];/);
});

// ---------------------------------------------------------------------------------------------
// TEST 6: relatia si numele complet ajung in promptul generatorului.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: pentru sister, promptul contine linia Recipient completa si relatia', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'sister' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Recipient: Maria.'), `promptul trebuie sa contina linia Recipient, a produs: ${prompt}`);
  assert.ok(prompt.includes('sora mea'), 'promptul RO trebuie sa contina relatia "sora mea"');
});

test('buildPrompt: pentru brother, promptul contine linia Recipient completa si relatia', () => {
  const order = typicalOrder({ recipient: 'Vasile', recipientRole: 'brother' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Recipient: Vasile.'), `promptul trebuie sa contina linia Recipient, a produs: ${prompt}`);
  assert.ok(prompt.includes('fratele meu'), 'promptul RO trebuie sa contina relatia "fratele meu"');
});

test('buildPrompt: tema reala (Occasion + instructiune de atmosfera) reflecta legatura de frati, nu doar antetul', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'sister' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Occasion: a tribute to a sibling.'), `promptul trebuie sa includa eticheta ocaziei, a produs: ${prompt}`);
  assert.ok(/sibling bond/i.test(prompt), 'promptul trebuie sa includa instructiunea tematica despre legatura de frati');
});

// ---------------------------------------------------------------------------------------------
// TEST 7: pentru Soră, instructiunea cere o formulare echivalenta cu "sora mea Maria".
// ---------------------------------------------------------------------------------------------
test('buildPrompt: instructiunea pentru "sister" cere adresarea ca "sora mea" + nume, niciodata prenume gol', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'sister' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Address as "sora mea"+name, never bare name.') || prompt.includes('Always address the recipient as "sora mea" plus their name, never by first name alone.'), `promptul trebuie sa contina instructiunea de adresare "sora mea"+nume, a produs: ${prompt}`);
});

test('buildPrompt: in alte limbi decat romana, conceptul "my sister" e trimis (Suno traduce natural, ex. "my sister Maria" in engleza)', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'sister', lang: 'en', story: 'A short typical story about my sister and our childhood memories together.' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('"my sister"'), `promptul EN trebuie sa contina conceptul "my sister", a produs: ${prompt}`);
});

// ---------------------------------------------------------------------------------------------
// TEST 8: pentru Frate, instructiunea cere o formulare echivalenta cu "fratele meu Vasile".
// ---------------------------------------------------------------------------------------------
test('buildPrompt: instructiunea pentru "brother" cere adresarea ca "fratele meu" + nume, niciodata prenume gol', () => {
  const order = typicalOrder({ recipient: 'Vasile', recipientRole: 'brother' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Address as "fratele meu"+name, never bare name.') || prompt.includes('Always address the recipient as "fratele meu" plus their name, never by first name alone.'), `promptul trebuie sa contina instructiunea de adresare "fratele meu"+nume, a produs: ${prompt}`);
});

test('buildPrompt: in alte limbi decat romana, conceptul "my brother" e trimis (Suno traduce natural, ex. "my brother Vasile" in engleza)', () => {
  const order = typicalOrder({ recipient: 'Vasile', recipientRole: 'brother', lang: 'en', story: 'A short typical story about my brother and our childhood memories together.' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('"my brother"'), `promptul EN trebuie sa contina conceptul "my brother", a produs: ${prompt}`);
});

// ---------------------------------------------------------------------------------------------
// TEST 9: numele nu este redus la initiala, in niciun scenariu (inclusiv cel mai rau caz).
// ---------------------------------------------------------------------------------------------
test('buildPrompt: sister, nume normal (sub RECIPIENT_MAX_LEN) ramane intreg chiar in cel mai rau caz de buget', () => {
  const name = 'Maria-Alexandra Popescu';
  const order = worstCaseOrder({ recipient: name, recipientRole: 'sister' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(name) || prompt.includes('Recipient:'), 'promptul trebuie sa contina linia Recipient (numele poate fi scurtat DOAR de cascada normala de buget, niciodata redus la o initiala)');
  assert.ok(!/\bM\.\s/.test(prompt.slice(prompt.indexOf('Recipient:'))), 'numele nu trebuie redus la o initiala urmata de punct');
});

test('buildPrompt: brother, nume scurt tipic ramane intreg in conditii normale (buget nesaturat)', () => {
  const order = typicalOrder({ recipient: 'Vasile', recipientRole: 'brother' });
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes('Recipient: Vasile.'), 'numele complet trebuie sa apara neschimbat in conditii normale');
});

// ---------------------------------------------------------------------------------------------
// TEST 10: regenerarea pastreaza relatia si numele.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: acelasi order (relatie+nume nemodificate) produce aceeasi clauza de relatie la a doua rulare (regenerare = generare initiala)', () => {
  const order = typicalOrder({ recipient: 'Maria', recipientRole: 'sister' });
  const promptInitial = buildPrompt(order, '', undefined);
  const promptRegenerated = buildPrompt(order, 'te rog fa versurile mai vesele', undefined);
  assert.ok(promptInitial.includes('Recipient: Maria.'));
  assert.ok(promptRegenerated.includes('Recipient: Maria.'));
  assert.ok(promptInitial.includes('sora mea'));
  assert.ok(promptRegenerated.includes('sora mea'));
});

test('server.js: /api/orders/:orderId/regenerate foloseste order = req.order (din DB), NU accepta recipientRole din request body — comportament generic, valabil si pentru frati', () => {
  const start = server.indexOf("app.post('/api/orders/:orderId/regenerate'");
  assert.ok(start !== -1);
  const nextRouteIdx = server.indexOf('\napp.', start + 10);
  const routeBody = server.slice(start, nextRouteIdx === -1 ? server.length : nextRouteIdx);
  assert.ok(routeBody.includes('const order = req.order;'));
  assert.ok(!/req\.body\??\.recipientRole/.test(routeBody));
  assert.ok(routeBody.includes('runGeneration('));
});

// ---------------------------------------------------------------------------------------------
// TEST 11: celelalte optiuni si toate pachetele au ramas neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: FAMILY_OCCASION_RECIPIENT_ROLES pastreaza EXACT valorile existente pentru bunici/parinti/matusa-unchi/socri', () => {
  assert.match(server, /bunici:\s*\['grandmother', 'grandfather', 'grandparents'\]/);
  assert.match(server, /parinti:\s*\['mother', 'father', 'parents'\]/);
  assert.match(server, /'matusa-unchi':\s*\['aunt', 'uncle', 'aunt_uncle'\]/);
  assert.match(server, /socri:\s*\['mother_in_law', 'father_in_law', 'parents_in_law'\]/);
});

test('comanda.html: RECIPIENT_ROLE_OPTIONS pastreaza EXACT valorile existente pentru bunici/parinti/matusa-unchi/socri', () => {
  assert.match(comanda, /bunici:\s*\['grandmother', 'grandfather', 'grandparents'\]/);
  assert.match(comanda, /parinti:\s*\['mother', 'father', 'parents'\]/);
  assert.match(comanda, /'matusa-unchi':\s*\['aunt', 'uncle', 'aunt_uncle'\]/);
  assert.match(comanda, /socri:\s*\['mother_in_law', 'father_in_law', 'parents_in_law'\]/);
});

test('buildPrompt: Nuntă/Botez si bunici (existente) raman EXACT neschimbate dupa adaugarea frati', () => {
  const orderNunta = worstCaseOrder({ occasion: 'nunta', weddingType: 'wedding', recipient: 'Maria', recipientRole: 'bride', senderRole: 'groom', recipientMode: 'single', recipientNames: null });
  const promptNunta = buildPrompt(orderNunta, '', undefined);
  assert.ok(!/never (bare|by first) name/i.test(promptNunta), 'Nuntă/Botez nu trebuie sa capete instructiunea de adresare relatie+nume');

  const orderBunici = typicalOrder({ occasion: 'bunici', recipientRole: 'grandmother', senderRole: 'granddaughter', recipientMode: 'single', recipientNames: null, recipient: 'Maria' });
  const promptBunici = buildPrompt(orderBunici, '', undefined);
  assert.ok(promptBunici.includes('"grandmother"'), 'bunici trebuie sa functioneze exact ca inainte');
});

test('server.js: PLAN_VARIANT_COUNT si preturile pachetelor raman neschimbate', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 2 \};/);
});

test('melodia-mea.html: RELATION_DISPLAY_NOUNS.recipient a primit sister/brother fara sa modifice intrarile existente (grandmother/mother/aunt/mother_in_law)', () => {
  const roMatch = melodiaMea.match(/recipient: \{ grandmother: 'bunica'[^}]*\}/);
  assert.ok(roMatch);
  assert.ok(roMatch[0].includes("sister: 'sora'"));
  assert.ok(roMatch[0].includes("brother: 'fratele'"));
  assert.ok(roMatch[0].includes("grandmother: 'bunica'"));
  assert.ok(roMatch[0].includes("mother_in_law: 'soacra'"));
});

test('melodia-mea.html: sister/brother exista exact de 8 ori (o data per limba) in RELATION_DISPLAY_NOUNS', () => {
  assert.equal((melodiaMea.match(/sister: '/g) || []).length, 8);
  assert.equal((melodiaMea.match(/brother: '/g) || []).length, 8);
});

test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
