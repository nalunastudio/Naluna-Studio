// Teste pentru "PACHETUL STANDARD — CONȚINUT VIZIBIL DIN PRIMA" (2026-08-29). Cauza reala:
// Standard era deja selectat vizual (.plan.active, aria-selected="true") si in `selectedPlan`
// (id: 'standard', implicit), dar lista de beneficii ramanea ascunsa de un flag separat
// (planExplicitlySelected = false) pana la un al doilea click pe cardul deja activ. Corectia
// elimina complet acel flag — renderBenefits(selectedPlan.id) se apeleaza neconditionat la
// initializare (dupa restoreDraft(), care poate schimba selectedPlan la Premium/Video), si la
// fiecare schimbare de plan (selectPlan(), neschimbat).
//
// Acopera EXPLICIT itemii 1-3 din cerinta:
//  1. Standard vizibil imediat pe acces curat (fara draft).
//  2. Draft Standard/Premium/Video cu beneficiile corecte imediat.
//  3. Schimbarea planului dintr-un singur tap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const comanda = read('public/comanda.html');

// ---------------------------------------------------------------------------------------------
// ITEM 1 — acces curat (fara draft): Standard trebuie sa fie activ, sumarul sa arate
// Standard/£15, iar cele 4 beneficii localizate sa fie deja vizibile, fara niciun click.
// ---------------------------------------------------------------------------------------------
test('ITEM 1: comanda.html — cardul Standard e activ implicit in HTML (fara JS), pret £15', () => {
  assert.match(comanda, /<div class="plan active" data-plan="standard" data-price="15" role="radio" aria-selected="true"[^>]*>/);
});

test('ITEM 1: comanda.html — selectedPlan porneste implicit pe Standard/£15, ACELASI id folosit de renderBenefits()', () => {
  assert.match(comanda, /let selectedPlan = \{ id: 'standard', price: 15, label: 'Standard' \};/);
});

test('ITEM 1: comanda.html — renderBenefits(selectedPlan.id) se apeleaza NECONDIȚIONAT la initializare (nu in spatele niciunui flag de genul planExplicitlySelected)', () => {
  assert.ok(!comanda.includes('planExplicitlySelected'), 'flagul care intarzia afisarea beneficiilor a fost eliminat complet');
  // apelul trebuie sa fie dupa applyLang(currentLang) si dupa restoreDraft() (ambele mai sus in
  // fisier), si INAINTE de showStep() — verificat prin pozitia relativa in text.
  const applyLangIdx = comanda.indexOf('applyLang(currentLang);');
  const restoreDraftCallIdx = comanda.indexOf('restoreDraft();');
  const renderBenefitsCallIdx = comanda.indexOf('renderBenefits(selectedPlan.id);', applyLangIdx);
  const showStepIdx = comanda.indexOf('showStep(restoredStep);');
  assert.ok(restoreDraftCallIdx !== -1 && restoreDraftCallIdx < applyLangIdx, 'restoreDraft() trebuie apelat inaintea acestui bloc de initializare');
  assert.ok(renderBenefitsCallIdx !== -1, 'renderBenefits(selectedPlan.id) trebuie apelat la initializare');
  assert.ok(renderBenefitsCallIdx > applyLangIdx && renderBenefitsCallIdx < showStepIdx, 'ordinea trebuie sa fie: applyLang -> renderBenefits -> showStep');
});

test('ITEM 1: benefits_standard (RO) contine EXACT cele 4 beneficii cerute (preview gratuit, durata, descarcare dupa plata, editare gratuita)', () => {
  const idx = comanda.indexOf('benefits_standard: [');
  assert.ok(idx !== -1);
  const end = comanda.indexOf('],', idx);
  const snippet = comanda.slice(idx, end);
  const items = snippet.match(/'[^']*'/g) || [];
  assert.equal(items.length, 4, `benefits_standard (RO) trebuie sa aiba exact 4 elemente, are ${items.length}`);
  assert.match(snippet, /preview de 40 de secunde/i);
  assert.match(snippet, /2 minute/i);
  assert.match(snippet, /Descarci melodia completă după plată/i);
  assert.match(snippet, /editare gratuită/i);
});

// EXECUTIE REALA (nu doar text-search): extrage renderBenefits() + un obiect minimal de
// traduceri si verifica ca randeaza cele 4 randuri corecte in DOM-ul simulat, pornind de la
// starea implicita (fara nicio interactiune).
function loadRenderBenefitsSandbox() {
  const fnStart = comanda.indexOf('function renderBenefits(planId) {');
  assert.ok(fnStart !== -1);
  let depth = 0, i = comanda.indexOf('{', fnStart);
  for (; i < comanda.length; i++) {
    if (comanda[i] === '{') depth++;
    else if (comanda[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnSrc = comanda.slice(fnStart, i + 1);

  const html = `<div id="benefits-list"></div>`;
  const sandbox = {
    document: null,
    translations: {
      ro: {
        benefits_standard: ['Beneficiu standard 1', 'Beneficiu standard 2', 'Beneficiu standard 3', 'Beneficiu standard 4'],
        benefits_premium: ['Beneficiu premium 1', 'Beneficiu premium 2'],
        benefits_video: ['Beneficiu video 1', 'Beneficiu video 2']
      }
    },
    currentLang: 'ro'
  };
  const context = vm.createContext(sandbox);
  // JSDOM nu e disponibil aici — simulam un element minimal cu innerHTML text-only, suficient
  // pentru a verifica CE text ajunge sa fie randat (scopul testului), fara sa depindem de un
  // parser HTML complet.
  const fakeEl = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  vm.runInContext(`
    const benefitsListEl = __fakeEl;
    ${fnSrc}
  `, Object.assign(context, { __fakeEl: fakeEl }));
  return { renderBenefits: context.renderBenefits, fakeEl };
}

test('ITEM 1 (executie reala): renderBenefits("standard") produce cele 4 randuri de beneficii in element, folosind sursa unica de traduceri', () => {
  const { renderBenefits, fakeEl } = loadRenderBenefitsSandbox();
  renderBenefits('standard');
  const matches = fakeEl.innerHTML.match(/benefit-item/g) || [];
  assert.equal(matches.length, 4, `trebuie randate exact 4 beneficii pentru Standard, au fost randate ${matches.length}`);
  assert.match(fakeEl.innerHTML, /Beneficiu standard 1/);
  assert.match(fakeEl.innerHTML, /Beneficiu standard 4/);
});

// ---------------------------------------------------------------------------------------------
// ITEM 2 — draft salvat cu Premium sau Cadou video: beneficiile ACELUI pachet trebuie sa fie
// vizibile imediat, fara click.
// ---------------------------------------------------------------------------------------------
test('ITEM 2: restoreDraft() seteaza selectedPlan din draft.plan INAINTE de apelul neconditionat de renderBenefits() de la initializare', () => {
  const restoreStart = comanda.indexOf('function restoreDraft() {');
  const restoreEnd = comanda.indexOf('\n  }', comanda.indexOf('updateGenerateButtonLabel();', restoreStart));
  const restoreSnippet = comanda.slice(restoreStart, restoreEnd);
  assert.match(restoreSnippet, /if \(draft\.plan\) \{/);
  assert.match(restoreSnippet, /selectedPlan = \{\s*id: planEl\.dataset\.plan,\s*price: Number\(planEl\.dataset\.price\),\s*label: planEl\.querySelector\('\.plan-name'\)\.textContent\s*\};/);
  // restoreDraft() insusi NU trebuie sa apeleze deja renderBenefits (ar fi redundant) — apelul
  // unic, neconditionat, de la initializare (testat in ITEM 1) se ocupa de asta pentru TOATE
  // cazurile (Standard implicit SAU planul restaurat din draft).
  assert.ok(!restoreSnippet.includes('renderBenefits('), 'restoreDraft() nu trebuie sa apeleze renderBenefits() separat — sursa unica ramane apelul de la initializare');
});

test('ITEM 2: restoreDraft() actualizeaza si cardul activ vizual (.plan.active/aria-selected) pentru planul din draft, consecvent cu beneficiile afisate', () => {
  const restoreStart = comanda.indexOf('function restoreDraft() {');
  const restoreEnd = comanda.indexOf('\n  }', comanda.indexOf('updateGenerateButtonLabel();', restoreStart));
  const restoreSnippet = comanda.slice(restoreStart, restoreEnd);
  assert.match(restoreSnippet, /plans\.forEach\(x => \{ x\.classList\.remove\('active'\); x\.setAttribute\('aria-selected', 'false'\); \}\);/);
  assert.match(restoreSnippet, /planEl\.classList\.add\('active'\);/);
  assert.match(restoreSnippet, /planEl\.setAttribute\('aria-selected', 'true'\);/);
});

// ---------------------------------------------------------------------------------------------
// ITEM 3 — schimbarea intre pachete trebuie sa inlocuiasca beneficiile dintr-un singur
// click/tap (selectPlan(), neschimbat in aceasta corectie, dar verificat explicit aici).
// ---------------------------------------------------------------------------------------------
test('ITEM 3: selectPlan() randeaza beneficiile noului plan SINCRON, in acelasi apel care il activeaza vizual — un singur click/tap e suficient', () => {
  const start = comanda.indexOf('function selectPlan(p) {');
  let depth = 0, i = comanda.indexOf('{', start);
  for (; i < comanda.length; i++) { if (comanda[i] === '{') depth++; else if (comanda[i] === '}') { depth--; if (depth === 0) break; } }
  const snippet = comanda.slice(start, i + 1);
  assert.match(snippet, /p\.classList\.add\('active'\);/);
  assert.match(snippet, /selectedPlan = \{/);
  assert.match(snippet, /renderBenefits\(selectedPlan\.id\);/);
  // ordinea conteaza: selectedPlan trebuie actualizat INAINTE de renderBenefits (altfel ar
  // randa beneficiile planului VECHI).
  const selectedPlanIdx = snippet.indexOf('selectedPlan = {');
  const renderBenefitsIdx = snippet.indexOf('renderBenefits(selectedPlan.id);');
  assert.ok(selectedPlanIdx < renderBenefitsIdx, 'selectedPlan trebuie actualizat inainte de renderBenefits(), altfel s-ar afisa beneficiile planului anterior');
  assert.ok(!snippet.includes('planExplicitlySelected'), 'niciun flag intermediar nu mai trebuie sa existe in selectPlan()');
});

test('ITEM 3 (executie reala): renderBenefits() comuta complet continutul intre doua apeluri succesive (Standard -> Premium), fara reziduuri din planul anterior', () => {
  const { renderBenefits, fakeEl } = loadRenderBenefitsSandbox();
  renderBenefits('standard');
  assert.match(fakeEl.innerHTML, /Beneficiu standard 1/);
  renderBenefits('premium');
  assert.ok(!fakeEl.innerHTML.includes('Beneficiu standard 1'), 'un singur apel (= un singur click) trebuie sa inlocuiasca complet continutul anterior');
  assert.match(fakeEl.innerHTML, /Beneficiu premium 1/);
  const matches = fakeEl.innerHTML.match(/benefit-item/g) || [];
  assert.equal(matches.length, 2, 'numarul de randuri trebuie sa corespunda EXACT noului plan, nu sa se acumuleze');
});

test('comanda.html: node --check nu se aplica (fisier HTML), dar structura <script> ramane sintactic valida dupa aceasta corectie', () => {
  const scriptMatches = comanda.match(/<script>([\s\S]*?)<\/script>/g) || [];
  assert.ok(scriptMatches.length > 0, 'trebuie sa existe cel putin un bloc <script> in pagina');
  for (const block of scriptMatches) {
    const code = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
    assert.doesNotThrow(() => new Function(code), 'fiecare bloc <script> trebuie sa ramana sintactic valid JavaScript');
  }
});
