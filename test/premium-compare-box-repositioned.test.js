// Teste pentru runda 2026-08-13 (a doua cerinta a rundei): caseta de selecție Premium
// ("PASUL URMĂTOR" / cele 4 butoane / plata) trebuie MUTATA dupa cele 4 carduri de melodii
// (nu inaintea lor, cum era), reutilizand EXACT stilul .standard-choice-box/.standard-choice-eyebrow
// si .standard-genre-choice-btn deja folosite de Standard, cu patru butoane care arata genul REAL
// al fiecarei variante, in formatul exact cerut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const melodia = read('public/melodia-mea.html');

test('melodia-mea.html: in markup, #premium-compare-cards apare INAINTEA casetei de selecție (.standard-choice-box) in interiorul #premium-compare-view — cele 4 melodii, apoi caseta', () => {
  const viewStart = melodia.indexOf('id="premium-compare-view"');
  assert.ok(viewStart !== -1, 'trebuie sa existe #premium-compare-view');
  const viewEnd = melodia.indexOf('<!-- Fluxul de editare Standard cu alegere', viewStart);
  assert.ok(viewEnd !== -1);
  const block = melodia.slice(viewStart, viewEnd);
  const cardsIdx = block.indexOf('id="premium-compare-cards"');
  const boxIdx = block.indexOf('class="standard-choice-box"');
  assert.ok(cardsIdx !== -1 && boxIdx !== -1, 'trebuie sa existe atat cardurile cat si caseta de selectie in acest bloc');
  assert.ok(cardsIdx < boxIdx, 'cardurile (#premium-compare-cards) trebuie sa apara INAINTEA casetei de selectie in DOM');
});

test('melodia-mea.html: caseta de selecție Premium reutilizeaza EXACT clasa .standard-choice-box (chenar portocaliu, fundal cald) — nu e o componenta noua/diferita', () => {
  const viewStart = melodia.indexOf('id="premium-compare-view"');
  const viewEnd = melodia.indexOf('<!-- Fluxul de editare Standard cu alegere', viewStart);
  const block = melodia.slice(viewStart, viewEnd);
  assert.ok(block.includes('class="standard-choice-box"'), 'caseta trebuie sa foloseasca EXACT clasa .standard-choice-box (Standard)');
  assert.ok(block.includes('class="standard-choice-eyebrow" id="premium-compare-eyebrow"'), 'eticheta "PASUL URMĂTOR" trebuie sa reutilizeze EXACT clasa .standard-choice-eyebrow (Standard)');
});

test('melodia-mea.html: sectiunea Standard (#standard-choice-section/.standard-choice-box existent) ramane STRICT neschimbata — nicio modificare la markup-ul ei', () => {
  assert.match(melodia, /<div id="standard-choice-section" style="display:none;">\s*<div class="standard-choice-box">\s*<span class="standard-choice-eyebrow" id="standard-choice-eyebrow"><\/span>\s*<h2 id="standard-choice-title"><\/h2>\s*<p id="standard-choice-subtitle"><\/p>\s*<div id="standard-genre-choice-buttons"><\/div>\s*<div id="standard-choice-checkout-slot" style="display:flex; justify-content:center;"><\/div>\s*<\/div>\s*<\/div>/);
});

test('renderPremiumCompareView: construieste EXACT patru butoane (.standard-genre-choice-btn), cate unul per varianta, DUPA bucla cardurilor', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const end = melodia.indexOf('function togglePremiumCompareSelection', idx);
  assert.ok(idx !== -1 && end !== -1);
  const body = melodia.slice(idx, end);
  const cardsLoopIdx = body.indexOf('cardsWrap.appendChild(card)');
  const buttonsLoopIdx = body.indexOf("buttonsWrap.appendChild(btn)");
  assert.ok(cardsLoopIdx !== -1 && buttonsLoopIdx !== -1);
  assert.ok(cardsLoopIdx < buttonsLoopIdx, 'bucla cardurilor trebuie sa ruleze inaintea buclei butoanelor (in cod, reflectand ordinea DOM ceruta)');
  assert.ok(body.includes("btn.className = 'standard-genre-choice-btn'"), 'butoanele trebuie sa reutilizeze EXACT clasa .standard-genre-choice-btn (Standard)');
});

test('renderPremiumCompareView: eticheta fiecarui buton foloseste formatul exact "Melodia N — versiunea X: {gen real}", niciodata un gen fabricat/mostenit de la alta varianta', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const end = melodia.indexOf('function togglePremiumCompareSelection', idx);
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('btn.textContent = `${songLabel} — ${versionLabel}: ${genreLabel}`'));
  // genreLabel trebuie sa vina din genul REAL al variantei (v.genre), niciodata dintr-o
  // varianta fixa/hardcodata sau din genul altei variante.
  assert.match(body, /const genreLabel = \(v\.genre && t\['genre_' \+ v\.genre\]\) \|\| v\.genre \|\| '';/);
});

test('renderPremiumCompareView: click pe buton apeleaza EXACT aceeasi functie de comutare a selectiei ca si click pe card (togglePremiumCompareSelection(v.id, order)) — un singur mecanism de selectie, sincronizat', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const end = melodia.indexOf('function togglePremiumCompareSelection', idx);
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('togglePremiumCompareSelection(v.id, order)'));
  const occurrences = (body.match(/togglePremiumCompareSelection\(v\.id, order\)/g) || []).length;
  assert.equal(occurrences, 2, 'trebuie apelata o data din click pe card SI o data din click pe buton');
});

test('renderPremiumCompareView: butonul apasat curent (buton pentru varianta selectata) primeste clasa "chosen" (aceeasi conventie vizuala ca la Standard)', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const end = melodia.indexOf('function togglePremiumCompareSelection', idx);
  const body = melodia.slice(idx, end);
  assert.ok(body.includes("'standard-genre-choice-btn' + (isChosen ? ' chosen' : '')"));
  assert.ok(body.includes('const isChosen = premiumCompareSelection.includes(v.id);'));
});

test('melodia-mea.html: nu exista un al doilea/duplicat container de butoane pentru comparare Premium — un singur #premium-compare-buttons in tot fisierul', () => {
  const count = (melodia.match(/id="premium-compare-buttons"/g) || []).length;
  assert.equal(count, 1);
});
