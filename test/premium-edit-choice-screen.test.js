// Teste pentru runda 2, 2026-08-13 ("ecran de alegere a melodiei care va fi editată — DOAR
// Premium"): apasarea "Editează versurile" nu mai deschide direct editorul primei melodii —
// deschide un ecran intermediar cu trei butoane (melodia 1 / melodia 2 / amândouă), fiecare
// deschizand STRICT editorul relevant si trimitand STRICT melodia/melodiile alese la server.
// Butonul negru de plata trebuie sa ramana vizibil in toate ecranele Premium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const melodia = read('public/melodia-mea.html');

test('melodia-mea.html: "Editează versurile" deschide ecranul de alegere (premiumEditChoiceOpen), NU direct editorul primei melodii', () => {
  const idx = melodia.indexOf("editBtn.onclick = () => {");
  assert.ok(idx !== -1);
  const body = melodia.slice(idx, idx + 200);
  assert.ok(body.includes('premiumEditChoiceOpen = true;'), 'trebuie sa deschida ecranul de alegere');
  assert.ok(!body.includes('premiumEditViewOpen = true;'), 'NU trebuie sa deschida direct editorul (fara alegere explicita)');
});

test('melodia-mea.html: ecranul de alegere reutilizeaza EXACT .standard-choice-box (chenar/culori identice cu Standard)', () => {
  const viewIdx = melodia.indexOf('id="premium-edit-choice-view"');
  assert.ok(viewIdx !== -1);
  const block = melodia.slice(viewIdx, viewIdx + 500);
  assert.ok(block.includes('class="standard-choice-box"'), 'caseta trebuie sa reutilizeze EXACT clasa Standard');
});

test('melodia-mea.html: titlul ecranului de alegere foloseste cheia de traducere premium_edit_choice_title (textul exact cerut, tradus in 8 limbi)', () => {
  assert.ok(melodia.includes("document.getElementById('premium-edit-choice-title').textContent = t.premium_edit_choice_title;"));
  assert.match(melodia, /premium_edit_choice_title: 'Nu este exact ce îți dorești\? Spune-ne ce melodie ți-ar plăcea să editezi'/);
});

test('renderPremiumEditChoiceView: construieste EXACT trei butoane — melodia 1, melodia 2, amândouă — in aceasta ordine', () => {
  const idx = melodia.indexOf('function renderPremiumEditChoiceView(order) {');
  const end = melodia.indexOf('function goToPremiumEditStep', 0) > idx ? melodia.indexOf('function goToPremiumEditStep') : melodia.length;
  assert.ok(idx !== -1);
  const body = melodia.slice(idx, idx + 1600);
  const song1Idx = body.indexOf("'song1'");
  const song2Idx = body.indexOf("'song2'");
  const bothIdx = body.indexOf("t.premium_edit_choice_both, 'both'");
  assert.ok(song1Idx !== -1 && song2Idx !== -1 && bothIdx !== -1, 'toate cele trei butoane trebuie construite');
  assert.ok(song1Idx < song2Idx && song2Idx < bothIdx, 'ordinea EXACTA ceruta: melodia 1, melodia 2, amândouă');
  assert.ok(body.includes("btn.className = 'standard-genre-choice-btn';"), 'butoanele trebuie sa reutilizeze EXACT clasa Standard');
});

test('renderPremiumEditChoiceView: eticheta fiecarui buton foloseste genul REAL al melodiei respective (v1.genre / v2.genre), niciodata un gen fabricat', () => {
  const idx = melodia.indexOf('function renderPremiumEditChoiceView(order) {');
  const end = melodia.indexOf('function goToPremiumEditStep');
  const body = melodia.slice(idx, end);
  assert.match(body, /const genre1Label = \(v1\.genre && t\['genre_' \+ v1\.genre\]\) \|\| v1\.genre \|\| '';/);
  assert.match(body, /const genre2Label = \(v2\.genre && t\['genre_' \+ v2\.genre\]\) \|\| v2\.genre \|\| '';/);
});

test('renderPremiumEditChoiceView: apasarea unui buton seteaza premiumEditChoice si deschide editorul (premiumEditViewOpen), niciodata invers', () => {
  const idx = melodia.indexOf('function renderPremiumEditChoiceView(order) {');
  const end = melodia.indexOf('function goToPremiumEditStep');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('premiumEditChoice = choice;'));
  assert.ok(body.includes('premiumEditChoiceOpen = false;'));
  assert.ok(body.includes('premiumEditViewOpen = true;'));
});

test('renderPremiumEditChoiceView: butonul negru de plata (checkoutBtn) e reparentat in slotul dedicat — ramane vizibil pe ecranul de alegere', () => {
  const idx = melodia.indexOf('function renderPremiumEditChoiceView(order) {');
  const end = melodia.indexOf('function goToPremiumEditStep');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes("document.getElementById('premium-edit-choice-checkout-slot');"));
  assert.ok(body.includes('slot.appendChild(checkoutBtn);'));
});

test('renderPremiumEditView: modul "song1" arata STRICT pasul 1 (pasul 2 ascuns) si trimite STRICT melodia 1', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  const branchIdx = body.indexOf("if (premiumEditChoice === 'song1') {");
  const branchEnd = body.indexOf("} else if (premiumEditChoice === 'song2') {");
  assert.ok(branchIdx !== -1 && branchEnd !== -1);
  const branch = body.slice(branchIdx, branchEnd);
  assert.ok(branch.includes("document.getElementById('premium-edit-step2').style.display = 'none';"), 'pasul 2 trebuie ascuns complet in modul "doar melodia 1"');
  assert.ok(branch.includes('submitSongs([songPayload(v1, song1Lyrics, song1GenreSelect, song1Voice, song1Feedback)], continueBtn);'));
});

test('renderPremiumEditView: modul "song2" arata STRICT pasul 2 (pasul 1 sarit complet) si trimite STRICT melodia 2', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  const branchIdx = body.indexOf("} else if (premiumEditChoice === 'song2') {");
  const branchEnd = body.indexOf('} else {', branchIdx);
  assert.ok(branchIdx !== -1 && branchEnd !== -1);
  const branch = body.slice(branchIdx, branchEnd);
  assert.ok(branch.includes("document.getElementById('premium-edit-step1').style.display = 'none';"), 'pasul 1 trebuie sarit complet in modul "doar melodia 2"');
  assert.ok(branch.includes('submitSongs([songPayload(v2, song2Lyrics, song2GenreSelect, song2Voice, song2Feedback)], startBtn);'));
});

test('renderPremiumEditView: modul "both" pastreaza comportamentul original — pasul 1, apoi pasul 2, ambele melodii trimise impreuna, cu verificarea genurilor diferite', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  const elseIdx = body.lastIndexOf('} else {');
  const branch = body.slice(elseIdx, body.length);
  assert.ok(branch.includes('goToPremiumEditStep(1);'));
  assert.ok(branch.includes('if (song1GenreSelect.value === song2GenreSelect.value) {'));
  assert.ok(branch.includes('songPayload(v1, song1Lyrics, song1GenreSelect, song1Voice, song1Feedback),'));
  assert.ok(branch.includes('songPayload(v2, song2Lyrics, song2GenreSelect, song2Voice, song2Feedback)'));
});

test('renderPremiumEditView: "Înapoi" duce la ecranul de alegere in modurile "song1"/"song2" (backToPremiumEditChoice), niciodata direct la rezultat', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('step1BackBtn.onclick = () => backToPremiumEditChoice(order);'));
  assert.ok(body.includes('backBtn.onclick = () => backToPremiumEditChoice(order);'));
});

test('backToPremiumEditChoice: reseteaza corect starea (editorul se inchide, ecranul de alegere se deschide)', () => {
  const idx = melodia.indexOf('function backToPremiumEditChoice(order) {');
  assert.ok(idx !== -1);
  const body = melodia.slice(idx, idx + 250);
  assert.ok(body.includes('premiumEditViewOpen = false;'));
  assert.ok(body.includes('premiumEditChoiceOpen = true;'));
});

test('renderPremiumEditView: butonul negru de plata (checkoutBtn) e reparentat DUPA editorul activ (#premium-edit-view-checkout-slot) — ramane vizibil in toate cele trei moduri', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  const slotIdx = body.indexOf("document.getElementById('premium-edit-view-checkout-slot');");
  const modeIdx = body.indexOf("if (premiumEditChoice === 'song1')");
  assert.ok(slotIdx !== -1 && modeIdx !== -1);
  assert.ok(slotIdx < modeIdx, 'checkoutBtn trebuie reparentat INAINTE de ramificarea pe mod, deci vizibil indiferent de mod');
  assert.ok(body.includes('editCheckoutSlot.appendChild(checkoutBtn);'));
});

test('melodia-mea.html: #premium-edit-view-checkout-slot e pozitionat DUPA editorul de versuri (pasul 2), nu inaintea lui, in markup', () => {
  const viewStart = melodia.indexOf('id="premium-edit-view"');
  const viewEnd = melodia.indexOf('<!-- CORECȚIE (2026-08-13, "muta caseta de selecție Premium', viewStart);
  const block = melodia.slice(viewStart, viewEnd);
  const step2LyricsIdx = block.indexOf('id="premium-edit-song2-lyrics"');
  const checkoutSlotIdx = block.indexOf('id="premium-edit-view-checkout-slot"');
  assert.ok(step2LyricsIdx !== -1 && checkoutSlotIdx !== -1);
  assert.ok(step2LyricsIdx < checkoutSlotIdx, 'butonul de plata trebuie sa apara DUPA editorul de versuri, nu inainte');
});

test('melodia-mea.html: toate cele trei chei noi de traducere (premium_edit_choice_title/both/song_btn) exista exact de 8 ori (o data per limba)', () => {
  ['premium_edit_choice_title', 'premium_edit_choice_both', 'premium_edit_choice_song_btn'].forEach(key => {
    const count = (melodia.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori, a aparut de ${count} ori`);
  });
});

// Confirmare (nu duplicare): backend-ul deja accepta/valideaza 1 SAU 2 melodii si NU creeaza
// o varianta falsa pentru cea neselectata — acoperit exhaustiv de teste EXISTENTE, nemodificate
// de aceasta runda: test/premium-selective-edit-and-compare.test.js ("accepta 1 SAU 2 melodii,
// respinge 0 sau mai mult de 2"; "editarea unei SINGURE melodii ... produce un array cu 3
// variante ... niciodata 4"). Ceea ce lipsea, si a fost adaugat in aceasta runda, era STRICT
// partea de frontend — clientul nu putea niciodata sa aleaga sa editeze o singura melodie.
test('server.js: validarea 1-2 melodii (songsInput.length < 1 || songsInput.length > 2) exista si ramane neschimbata — backend-ul suporta deja editarea unei singure melodii', () => {
  const server = read('server.js');
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 900);
  assert.ok(body.includes('songsInput.length < 1 || songsInput.length > 2'));
});
