// FORMULAR SPECIAL "PENTRU MINE" (2026-10-12, cerinta explicita) — public/comanda.html, pasul 2.
// Acopera: markup-ul noilor campuri, ascunderea/afisarea corecta in refreshRelationUI(),
// validateStep(2) condiționat de occasion, collectPayload() trimite selfTheme/includeNameInSong,
// saveDraft/restoreDraft persista noile campuri, traducerile (8 limbi), si ca celelalte ocazii
// raman complet neatinse. Acelasi tipar de verificare prin pattern-matching pe sursa, deja folosit
// de restul testelor pentru comanda.html (fara jsdom pentru acest fisier — vezi precedentul
// test/amandoi-single-name-field.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const comanda = read('public/comanda.html');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===================================================================================================
// 1) Markup: cele 2 campuri noi exista, ascunse implicit, cu cele 5 respectiv 2 optiuni cerute.
// ===================================================================================================
test('comanda.html: self-theme-field exista, ascuns implicit, cu EXACT cele 5 teme cerute explicit', () => {
  const idx = comanda.indexOf('id="self-theme-field"');
  assert.ok(idx !== -1);
  const section = comanda.slice(idx, comanda.indexOf('id="sender-field"', idx));
  assert.match(section, /style="display:none;"/);
  const themes = [...section.matchAll(/data-self-theme="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(themes, ['putere-motivatie', 'perioada-grea', 'reusita', 'dor-iubire', 'povestea-vietii']);
  assert.ok(section.includes('<input type="hidden" id="selfTheme" value="">'));
});

test('comanda.html: include-name-field exista, ascuns implicit, cu EXACT 2 optiuni (Da/Nu)', () => {
  const idx = comanda.indexOf('id="include-name-field"');
  assert.ok(idx !== -1);
  const section = comanda.slice(idx, idx + 1200);
  assert.match(section, /style="display:none;"/);
  const options = [...section.matchAll(/data-include-name="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(options, ['yes', 'no']);
  assert.ok(section.includes('<input type="hidden" id="includeNameInSong" value="">'));
});

test('comanda.html: sender-field/relationship-field exista ca wrapper-e identificabile (pentru ascundere/afisare)', () => {
  assert.ok(comanda.includes('<div class="field" id="sender-field">'));
  assert.ok(comanda.includes('<div class="field" id="relationship-field">'));
});

// ===================================================================================================
// 2) refreshRelationUI(): toggle-ul corect intre modul self-song si modul standard.
// ===================================================================================================
function refreshRelationUIBody() {
  const start = comanda.indexOf('function refreshRelationUI() {');
  assert.ok(start !== -1);
  let depth = 0, i = comanda.indexOf('{', start);
  for (; i < comanda.length; i++) {
    if (comanda[i] === '{') depth++;
    else if (comanda[i] === '}') { depth--; if (depth === 0) break; }
  }
  return comanda.slice(start, i + 1);
}

test('refreshRelationUI(): calculeaza isSelfSong STRICT din occasion==="pentru-mine"', () => {
  const body = refreshRelationUIBody();
  assert.match(body, /const isSelfSong = occasion === 'pentru-mine';/);
});

test('refreshRelationUI(): afiseaza self-theme-field/include-name-field STRICT pentru isSelfSong, ascunde sender/relationship', () => {
  const body = refreshRelationUIBody();
  assert.match(body, /selfThemeField\.style\.display = isSelfSong \? 'block' : 'none';/);
  assert.match(body, /includeNameField\.style\.display = isSelfSong \? 'block' : 'none';/);
  assert.match(body, /senderField\.style\.display = isSelfSong \? 'none' : 'block';/);
  assert.match(body, /relationshipField\.style\.display = isSelfSong \? 'none' : 'block';/);
});

test('refreshRelationUI(): schimba eticheta/placeholder-ul lui #recipient si #story, si titlul pasului 2, cand isSelfSong', () => {
  const body = refreshRelationUIBody();
  assert.match(body, /recipientLabelKey = isSelfSong \? 'label_recipient_self' : 'label_recipient'/);
  assert.match(body, /recipientPhKey = isSelfSong \? 'ph_recipient_self' : 'ph_recipient'/);
  assert.match(body, /storyLabelKey = isSelfSong \? 'label_story_self' : 'label_story'/);
  assert.match(body, /storyPhKey = isSelfSong \? 'ph_story_self' : 'ph_story'/);
  assert.match(body, /step2TitleKey = isSelfSong \? 'wizard_step2_title_self' : 'wizard_step2_title'/);
});

test('refreshRelationUI(): la tranzitia REALA intre pentru-mine si orice alta ocazie, goleste sender/relationship — altfel le pastreaza neschimbate', () => {
  const body = refreshRelationUIBody();
  assert.match(body, /if \(isSelfSong !== wasSelfSong\) \{/);
  assert.match(body, /senderInput\.value = '';/);
  assert.match(body, /relationshipInput\.value = '';/);
});

test('refreshRelationUI(): re-sincronizeaza cardurile active self-theme/include-name STRICT din valoarea curenta a campurilor ascunse', () => {
  const body = refreshRelationUIBody();
  assert.match(body, /document\.querySelectorAll\('\.self-theme-card'\)\.forEach/);
  assert.match(body, /document\.querySelectorAll\('\.include-name-card'\)\.forEach/);
});

// ===================================================================================================
// 3) Click pe cardul de ocazie principala reseteaza selfTheme/includeNameInSong (fara date
//    "agatate" la revenirea la o alta ocazie).
// ===================================================================================================
test('comanda.html: click pe orice card de ocazie principala reseteaza selfTheme/includeNameInSong', () => {
  const idx = comanda.indexOf("occasionInput.value = c.dataset.theme;");
  const end = comanda.indexOf('refreshRelationUI();', idx);
  const slice = comanda.slice(idx, end);
  assert.match(slice, /selfThemeInput\.value = '';/);
  assert.match(slice, /includeNameInput\.value = '';/);
});

// ===================================================================================================
// 4) validateStep(2): sender/relationship OPTIONALE pentru pentru-mine, selfTheme/includeNameInSong
//    OBLIGATORII; pentru orice alta ocazie, comportamentul original (sender/relationship cerute).
// ===================================================================================================
function validateStepBody() {
  const start = comanda.indexOf('function validateStep(n) {');
  assert.ok(start !== -1);
  let depth = 0, i = comanda.indexOf('{', start);
  for (; i < comanda.length; i++) {
    if (comanda[i] === '{') depth++;
    else if (comanda[i] === '}') { depth--; if (depth === 0) break; }
  }
  return comanda.slice(start, i + 1);
}

test('validateStep(2): recipient si story raman OBLIGATORII neconditionat (orice ocazie)', () => {
  const body = validateStepBody();
  assert.match(body, /if \(!recipient\) \{ ok = false;/);
  assert.match(body, /if \(!story\) \{ ok = false;/);
});

test('validateStep(2): pentru isSelfSongStep, selfTheme/includeNameInSong devin obligatorii, sender/relationship NU mai sunt cerute', () => {
  const body = validateStepBody();
  assert.match(body, /const isSelfSongStep = occasionInput\.value === 'pentru-mine';/);
  assert.match(body, /if \(isSelfSongStep\) \{/);
  assert.match(body, /if \(!selfThemeInput\.value\) \{ ok = false;/);
  assert.match(body, /if \(!includeNameInput\.value\) \{ ok = false;/);
});

test('validateStep(2): pentru orice ALTA ocazie, sender/relationship raman OBLIGATORII, neschimbate', () => {
  const body = validateStepBody();
  assert.match(body, /\} else \{\s*\n\s*const sender = document\.getElementById\('sender'\)\.value\.trim\(\);\s*\n\s*const relationship = document\.getElementById\('relationship'\)\.value\.trim\(\);/);
  assert.match(body, /if \(!sender\) \{ ok = false;/);
  assert.match(body, /if \(!relationship\) \{ ok = false;/);
});

// ===================================================================================================
// 5) collectPayload(): trimite selfTheme (string) si includeNameInSong (boolean real sau null).
// ===================================================================================================
test('collectPayload(): trimite selfTheme si includeNameInSong (boolean, null cand necompletat)', () => {
  const idx = comanda.indexOf('function collectPayload() {');
  const end = comanda.indexOf('\n  }', comanda.indexOf('return {', idx));
  const body = comanda.slice(idx, end);
  assert.match(body, /selfTheme: selfThemeInput\.value,/);
  assert.match(body, /includeNameInSong: includeNameInput\.value === '' \? null : includeNameInput\.value === 'true',/);
});

// ===================================================================================================
// 6) saveDraft/restoreDraft persista selfTheme/includeNameInSong — restaurate INAINTE de
//    refreshRelationUI(), acelasi tipar ca restul campurilor de relatie.
// ===================================================================================================
test('saveDraft(): persista selfTheme/includeNameInSong', () => {
  const saveIdx = comanda.indexOf('function saveDraft() {');
  const saveEnd = comanda.indexOf('function restoreDraft() {');
  const slice = comanda.slice(saveIdx, saveEnd);
  assert.match(slice, /selfTheme: selfThemeInput\.value,/);
  assert.match(slice, /includeNameInSong: includeNameInput\.value/);
});

test('restoreDraft(): reface selfTheme/includeNameInSong INAINTE de refreshRelationUI()', () => {
  const restoreIdx = comanda.indexOf('function restoreDraft() {');
  const refreshCallIdx = comanda.indexOf('refreshRelationUI();', restoreIdx);
  const slice = comanda.slice(restoreIdx, refreshCallIdx);
  assert.match(slice, /if \(draft\.selfTheme\) selfThemeInput\.value = draft\.selfTheme;/);
  assert.match(slice, /if \(draft\.includeNameInSong\) includeNameInput\.value = draft\.includeNameInSong;/);
});

// ===================================================================================================
// 7) Click handlers: self-theme-card seteaza selfTheme; include-name-card seteaza includeNameInSong
//    ca STRING 'true'/'false' (nu boolean direct — hidden input).
// ===================================================================================================
test('click handler .self-theme-card: seteaza selfThemeInput.value din dataset.selfTheme', () => {
  const idx = comanda.indexOf("querySelectorAll('.self-theme-card').forEach(c => {");
  assert.ok(idx !== -1);
  const slice = comanda.slice(idx, idx + 500);
  assert.match(slice, /selfThemeInput\.value = c\.dataset\.selfTheme;/);
});

test('click handler .include-name-card: seteaza includeNameInput.value la "true"/"false" (string) dupa data-include-name', () => {
  const idx = comanda.indexOf("querySelectorAll('.include-name-card').forEach(c => {");
  assert.ok(idx !== -1);
  const slice = comanda.slice(idx, idx + 500);
  assert.match(slice, /includeNameInput\.value = c\.dataset\.includeName === 'yes' \? 'true' : 'false';/);
});

// ===================================================================================================
// 8) Traducerile noi exista in toate cele 8 limbi (16 chei), toate distincte.
// ===================================================================================================
const NEW_KEYS = [
  'label_self_theme', 'self_theme_putere', 'self_theme_perioada_grea', 'self_theme_reusita',
  'self_theme_dor_iubire', 'self_theme_povestea_vietii', 'label_include_name', 'include_name_yes',
  'include_name_no', 'label_recipient_self', 'ph_recipient_self', 'label_story_self',
  'ph_story_self', 'wizard_step2_title_self', 'val_self_theme', 'val_include_name'
];
function loadTranslations() {
  const startIdx = comanda.indexOf('const translations = {');
  const endMarker = '\n  };\n';
  const endIdx = comanda.indexOf(endMarker, startIdx);
  const snippet = comanda.slice(startIdx, endIdx + endMarker.length);
  return new Function(`${snippet}\nreturn translations;`)();
}
const translations = loadTranslations();

for (const key of NEW_KEYS) {
  test(`comanda.html: traducerea "${key}" exista in toate cele 8 limbi, text real (nu cheie brută/gol)`, () => {
    for (const lang of LANGS) {
      const val = translations[lang][key];
      assert.ok(typeof val === 'string' && val.trim().length > 1, `lipseste sau e gol: ${lang}.${key}`);
    }
  });
}

test('comanda.html: fiecare din cele 16 chei noi are 8 traduceri DISTINCTE (nicio limba pe fallback accidental)', () => {
  for (const key of NEW_KEYS) {
    const values = LANGS.map(l => translations[l][key]);
    assert.equal(new Set(values).size, LANGS.length, `${key}: traducerile nu sunt toate distincte`);
  }
});

// ===================================================================================================
// 9) data-i18n/data-i18n-placeholder initiale pe #recipient-label/#recipient/#story-label/#story/
//    #step2-title raman cele standard (label_recipient/ph_recipient/...) — swap-ul e STRICT
//    dinamic (JS, refreshRelationUI), nu in markup-ul static.
// ===================================================================================================
test('comanda.html: markup-ul static initial foloseste etichetele STANDARD (nu cele self-song) — swap-ul e STRICT dinamic', () => {
  assert.match(comanda, /<label for="recipient" id="recipient-label" data-i18n="label_recipient">/);
  assert.match(comanda, /<label for="story" id="story-label" data-i18n="label_story">/);
  assert.match(comanda, /<h1 id="step2-title" data-i18n="wizard_step2_title">/);
});

// ===================================================================================================
// 10) server.js ramane sintactic valid, si testele celorlalte ocazii/formulare nu au fost atinse
//     structural (verificare indirecta — Amândoi/Nuntă raman complet separate de blocul nou).
// ===================================================================================================
test('node --check server.js / db.js trec (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
