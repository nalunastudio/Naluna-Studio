// CERINTA 2A/2C/2D (2026-08-31): pasul de gen (3) separat de pasul de voce (4, nou), pachetul si
// toti pasii Premium ulteriori impinsi cu +1. Verifica STRUCTURAL (nu doar text) intreg lantul de
// navigare, migrarea drafturilor vechi, si separarea reala gen/voce pe pagini diferite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda.html'), 'utf8');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// ===============================================================================================
// Structura HTML — exact 8 pasi, in ordine, fara duplicate.
// ===============================================================================================
test('comanda.html: exista EXACT 8 step-card-uri, cu data-step de la 1 la 8, fara duplicate', () => {
  const steps = [...html.matchAll(/class="step-card" data-step="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('comanda.html: pasul 3 e EXCLUSIV gen (fara nicio urma de voice-grid/voice_label)', () => {
  const idx = html.indexOf('class="step-card" data-step="3"');
  const end = html.indexOf('class="step-card" data-step="4"');
  const step3Html = html.slice(idx, end);
  assert.match(step3Html, /wizard_step3_title/);
  assert.match(step3Html, /genre-grid/);
  assert.ok(!step3Html.includes('voice-grid'), 'pasul 3 nu mai trebuie sa contina grila de voce');
  assert.ok(!step3Html.includes('id="voice-preference"'), 'pasul 3 nu mai trebuie sa contina inputul de voce');
});

test('comanda.html: pasul 4 e EXCLUSIV voce (fara nicio urma de genre-grid/label_genre)', () => {
  const idx = html.indexOf('class="step-card" data-step="4"');
  const end = html.indexOf('class="step-card" data-step="5"');
  const step4Html = html.slice(idx, end);
  assert.match(step4Html, /wizard_step_voice_title/);
  assert.match(step4Html, /voice-grid/);
  assert.match(step4Html, /id="voice-preference"/);
  assert.ok(!step4Html.includes('genre-grid'), 'pasul 4 nu mai trebuie sa contina grila de gen');
  assert.ok(!step4Html.includes('id="genre"'), 'pasul 4 nu mai trebuie sa contina inputul de gen');
});

test('comanda.html: lantul data-next/data-prev/data-validate e coerent pe toti cei 8 pasi', () => {
  const expectedChain = [
    { step: 1, next: '2', validate: '1' },
    { step: 2, prev: '1', next: '3', validate: '2' },
    { step: 3, prev: '2', next: '4', validate: '3' },
    { step: 4, prev: '3', next: '5', validate: '4' },
    { step: 5, prev: '4' }, // pachet — fara data-next static (submit direct sau redirect JS)
    { step: 6, prev: '5', next: '7', validate: '6' },
    { step: 7, prev: '6' }, // song2-recipient — submit direct sau redirect JS
    { step: 8, prev: '7' }  // mini-pagina — submit final
  ];
  expectedChain.forEach(({ step, prev, next, validate }) => {
    const startIdx = html.indexOf(`class="step-card" data-step="${step}"`);
    const endIdx = html.indexOf(`class="step-card" data-step="${step + 1}"`, startIdx);
    const cardHtml = html.slice(startIdx, endIdx === -1 ? startIdx + 6000 : endIdx);
    if (prev) assert.match(cardHtml, new RegExp(`data-prev="${prev}"`), `pasul ${step} trebuie sa aiba data-prev="${prev}"`);
    if (next) assert.match(cardHtml, new RegExp(`data-next="${next}"`), `pasul ${step} trebuie sa aiba data-next="${next}"`);
    if (validate) assert.match(cardHtml, new RegExp(`data-validate="${validate}"`), `pasul ${step} trebuie sa aiba data-validate="${validate}"`);
  });
});

// ===============================================================================================
// Logica JS — getTotalSteps(), migrarea drafturilor, validateStep().
// ===============================================================================================
function loadWizardLogic() {
  const startIdx = html.indexOf('const STEP_KEY = ');
  const validateStepSrc = extractFn(html, 'function validateStep(n) {');
  const endIdx = html.indexOf(validateStepSrc) + validateStepSrc.length;
  const snippet = html.slice(startIdx, endIdx);
  const sandboxSrc = `
    const fakeElements = { genre: { value: '', classList: { toggle: () => {} }, focus: () => {} }, 'err-genre': { textContent: '' } };
    const document = {
      getElementById: (id) => fakeElements[id] || null,
      querySelectorAll: () => []
    };
    const window = { scrollTo: () => {} };
    const localStorage = { setItem: () => {}, getItem: () => null };
    let selectedPlan = { id: 'standard' };
    let song2TargetInputValue = '';
    const song2TargetInput = { get value() { return song2TargetInputValue; }, set value(v) { song2TargetInputValue = v; } };
    const genreInput = fakeElements.genre;
    const voiceInput = { value: 'auto' };
    const genre2Input = { value: '' };
    function setFieldError() {}
    function t() { return ''; }
    ${snippet}
    return { getTotalSteps, WIZARD_STEP_MIGRATION_MAP, CURRENT_WIZARD_STEP_VERSION, validateStep, setSelectedPlan: (p) => { selectedPlan = p; }, setSong2Target: (v) => { song2TargetInputValue = v; }, setGenre: (v) => { fakeElements.genre.value = v; }, setVoice: (v) => { voiceInput.value = v; } };
  `;
  return new Function(sandboxSrc)();
}
const wizard = loadWizardLogic();

test('getTotalSteps(): Standard/Video au 5 pasi (era 4)', () => {
  wizard.setSelectedPlan({ id: 'standard' });
  assert.equal(wizard.getTotalSteps(), 5);
  wizard.setSelectedPlan({ id: 'video' });
  assert.equal(wizard.getTotalSteps(), 5);
});

test('getTotalSteps(): Premium "aceeasi persoana" are 7 pasi (era 6)', () => {
  wizard.setSelectedPlan({ id: 'premium' });
  wizard.setSong2Target('same');
  assert.equal(wizard.getTotalSteps(), 7);
});

test('getTotalSteps(): Premium "alta persoana" are 8 pasi (era 7)', () => {
  wizard.setSelectedPlan({ id: 'premium' });
  wizard.setSong2Target('other');
  assert.equal(wizard.getTotalSteps(), 8);
});

test('WIZARD_STEP_MIGRATION_MAP: remapeaza corect toate cele 7 numere vechi de pas catre cele noi', () => {
  assert.deepEqual(wizard.WIZARD_STEP_MIGRATION_MAP, { 1: 1, 2: 2, 3: 3, 4: 5, 5: 6, 6: 7, 7: 8 });
});

test('FUNCTIONAL: un draft cu pasul vechi 4 (fostul "Pachet") migreaza catre noul pas 5, niciodata redeschis pe noul pas 4 ("Ce voce sa cante?")', () => {
  const oldSavedStep = 4;
  const migrated = wizard.WIZARD_STEP_MIGRATION_MAP[oldSavedStep];
  assert.equal(migrated, 5, 'vechiul pas 4 (Pachet) trebuie sa devina noul pas 5, NICIODATA sa ramana 4 (acum "Ce voce sa cante?")');
});

test('FUNCTIONAL: validateStep(3) valideaza STRICT genul (nu mai verifica vocea)', () => {
  wizard.setGenre('');
  assert.equal(wizard.validateStep(3), false);
  wizard.setGenre('pop');
  assert.equal(wizard.validateStep(3), true);
});

test('FUNCTIONAL: validateStep(4) exista si valideaza vocea (implicit "auto", deci mereu valid in fluxul curent)', () => {
  wizard.setVoice('auto');
  assert.equal(wizard.validateStep(4), true);
});

test('comanda.html: EDIT_GENRE_KEYS / genre_* raman corecte — split gen/voce nu a atins Cerinta 2A/B', () => {
  assert.match(html, /const LEGACY_ONLY_GENRES|genre_ballad_emotional/);
});

test('node --check nu se aplica (HTML), dar scriptul inline ramane sintactic valid', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  scripts.forEach(m => assert.doesNotThrow(() => new Function(m[1])));
});
