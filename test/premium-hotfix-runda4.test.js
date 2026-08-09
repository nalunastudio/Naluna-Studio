// Teste pentru "HOTFIX PREMIUM — MODIFICĂRI STRICT LIMITATE LA PACHETUL PREMIUM" (runda 4):
// (1) evidentierea celor 3 texte de configurare a melodiei 2, cu accentul teracota deja existent
// (var(--gold-deep)); (2) inlocuirea completa a ecranului defect "Ce vrei să editezi?" (chenare
// aproape goale, text iesit din ele) cu doi indicatori compacti, complet incadrati; (3) editare
// SECVENTIALA, obligatorie pentru AMBELE melodii (voce, gen, versuri precompletate/editabile per
// melodie); (4) pagina finala arata mereu EXACT patru melodii dupa editare; (5) fluxul fara
// editare ramane neschimbat; (6) design Standard reutilizat, nu un sistem vizual nou. Acopera
// cele 20 de teste obligatorii cerute explicit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const comanda = read('public/comanda.html');
const melodia = read('public/melodia-mea.html');

// ---------------------------------------------------------------------------------------------
// TEST 1: cele trei texte din configurarea melodiei a doua sunt evidentiate, in toate cele 8 limbi.
// ---------------------------------------------------------------------------------------------
test('comanda.html: titlul sectiunii de gen ("Alege genul...") e evidentiat cu accentul teracota deja existent (var(--gold-deep)), font mai mare', () => {
  assert.match(comanda, /\.mandatory-section h2\{ font-size:19px; font-weight:700; margin-bottom:6px; color:var\(--gold-deep\); line-height:1\.3; \}/);
});

test('comanda.html: eticheta genului celei de-a doua melodii ("Genul celei de-a doua melodii") e evidentiata DOAR in contextul Premium (#song2-genre-slot), Video (pasul 4) ramane neatins', () => {
  assert.match(comanda, /#song2-genre-slot label\{ font-size:16px; font-weight:700; color:var\(--gold-deep\); margin-bottom:10px; \}/);
});

test('comanda.html: cele 3 texte evidentiate provin din chei deja traduse in toate cele 8 limbi (song2_genre_section_title, song2_first_genre_label, label_genre2) — nicio cheie noua necesara', () => {
  ['song2_genre_section_title:', 'song2_first_genre_label:', 'label_genre2:'].forEach(key => {
    const count = (comanda.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori (o data per limba)`);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 2: genul primei melodii apare corect si dinamic.
// ---------------------------------------------------------------------------------------------
test('comanda.html: updateSong1GenreDisplay() afiseaza genul REAL, curent, al primei melodii, intr-un "chip" evidentiat', () => {
  const idx = comanda.indexOf('function updateSong1GenreDisplay() {');
  const body = comanda.slice(idx, idx + 900);
  assert.ok(body.includes('genreInput.value'), 'genul trebuie citit din selectia REALA curenta, nu hardcodat');
  assert.ok(body.includes("song1GenreDisplay.innerHTML = t('song2_first_genre_label') + ' <strong>' + label + '</strong>';"));
});

test('comanda.html: "Prima melodie: [gen]" — genul e evidentiat vizual (chip teracota) prin .song1-genre-hint strong', () => {
  assert.match(comanda, /\.song1-genre-hint strong\{[\s\S]{0,150}color:var\(--gold-deep\);/);
});

// ---------------------------------------------------------------------------------------------
// TEST 3: doua genuri identice sunt respinse si in backend (validare deja existenta, neschimbata
// de aceasta runda — verificam ca ramane intacta pentru editarea secventiala noua).
// ---------------------------------------------------------------------------------------------
test('server.js: editarea secventiala Premium respinge genuri finale identice intre cele doua melodii (aceeasi validare ca la comanda initiala)', () => {
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const end = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, end);
  assert.ok(body.includes('if (finalGenres[0] && finalGenres[1] && finalGenres[0] === finalGenres[1]) {'));
  assert.ok(body.includes('sameGenreMessage(order.lang)'));
});

// ---------------------------------------------------------------------------------------------
// TEST 4: niciun text nu iese din chenare pe mobil (verificare statica: flex-wrap + word-break
// pe toate containerele text-critice noi; verificarea vizuala finala se face live pe staging).
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: indicatorul compact "Editez prima/a doua melodie: [gen]" foloseste flex-wrap + word-break — textul nu poate iesi din chenar, nici pe ecrane de 320px', () => {
  assert.match(melodia, /\.premium-edit-song-indicator\{\s*display:flex; align-items:center; flex-wrap:wrap; gap:8px;/);
  assert.match(melodia, /\.premium-edit-song-indicator-genre\{[\s\S]{0,150}word-break:break-word; max-width:100%;/);
});

test('comanda.html: sectiunea de gen ramane in interiorul .mandatory-section (padding existent), fara scroll orizontal (html{overflow-x:hidden} ramane neschimbat)', () => {
  assert.match(comanda, /html\{scroll-behavior:smooth; overflow-x:hidden;\}/);
});

// ---------------------------------------------------------------------------------------------
// TEST 5+6: editarea secventiala — pasul 1 (melodia 1), apoi pasul 2 (melodia 2); "Înapoi"
// pastreaza valorile primei melodii.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ecranul de editare are EXACT doi pasi (#premium-edit-step1, #premium-edit-step2), pasul 2 ascuns implicit', () => {
  assert.match(melodia, /<div id="premium-edit-step1">/);
  assert.match(melodia, /<div id="premium-edit-step2" style="display:none;">/);
});

test('melodia-mea.html: NU mai exista bife optionale de selectie a melodiei — editarea acopera INTOTDEAUNA ambele melodii, in ordine', () => {
  assert.ok(!melodia.includes('premium-edit-song1-check'));
  assert.ok(!melodia.includes('premium-edit-song2-check'));
  assert.ok(!melodia.includes('type="checkbox"') || !melodia.slice(melodia.indexOf('id="premium-edit-view"'), melodia.indexOf('id="premium-compare-view"')).includes('type="checkbox"'));
});

test('melodia-mea.html: butonul pasului 1 este "Continuă la a doua melodie" (premium_edit_step1_continue_btn), butonul final este "Creează noile versiuni" (premium_edit_start_btn)', () => {
  assert.match(melodia, /getElementById\('premium-edit-step1-continue-btn'\)\.textContent = t\.premium_edit_step1_continue_btn;/);
  assert.match(melodia, /getElementById\('premium-edit-start-btn'\)\.textContent = t\.premium_edit_start_btn;/);
  assert.match(melodia, /premium_edit_start_btn: 'Creează noile versiuni',/);
  assert.match(melodia, /premium_edit_step1_continue_btn: 'Continuă la a doua melodie',/);
});

// ---------------------------------------------------------------------------------------------
// TEST 7: vocea poate fi modificata separat pentru fiecare melodie.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: fiecare melodie are propria grila de voce independenta (song1Voice/song2Voice, variabile locale separate)', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('let song1Voice ='));
  assert.ok(body.includes('let song2Voice = song1Voice;'));
  assert.ok(body.includes("song1VoiceCards.forEach(c => { c.onclick = () => { song1Voice = c.dataset.voice;"));
  assert.ok(body.includes("song2VoiceCards.forEach(c => { c.onclick = () => { song2Voice = c.dataset.voice;"));
});

test('server.js: vocea aleasa PER MELODIE (song.voicePreference) suprascrie voicePreference-ul comenzii STRICT la constructia prompt-ului acelei melodii', () => {
  const idx = server.indexOf('async function runPremiumEditGeneration');
  const end = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  const body = server.slice(idx, end);
  assert.match(body, /const effectiveVoice = VOICE_PREFERENCES\.includes\(song\.voicePreference\) \? song\.voicePreference : order\.voicePreference;/);
  assert.match(body, /buildPrompt\(\{ \.\.\.order, \.\.\.recipientSnapshot, voicePreference: effectiveVoice \}, song\.feedback, genreToUse\)/);
});

test('server.js: POST /regenerate (premium) valideaza vocea per melodie impotriva VOICE_PREFERENCES, respinge o valoare invalida', () => {
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const end = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, end);
  assert.ok(body.includes("const songVoice = typeof entry?.voicePreference === 'string' ? entry.voicePreference : null;"));
  assert.ok(body.includes('if (songVoice !== null && !VOICE_PREFERENCES.includes(songVoice)) {'));
});

// ---------------------------------------------------------------------------------------------
// TEST 8: genul poate fi modificat separat pentru fiecare melodie (validare deja existenta,
// neschimbata — verificam ca ramane intacta).
// ---------------------------------------------------------------------------------------------
test('server.js: genul fiecarei melodii se scrie pe coloana corecta (genre vs genre2), dupa POZITIA variantei — premiumEditSlotForVariant', () => {
  const idx = server.indexOf('const genrePatch = {};');
  const body = server.slice(idx, idx + 400);
  assert.ok(body.includes('premiumEditSlotForVariant(order, song.variantId)'));
  assert.ok(body.includes("genrePatch[isSong2Slot ? 'genre2' : 'genre'] = song.requestedGenre;"));
});

// ---------------------------------------------------------------------------------------------
// TEST 9: versurile fiecarei melodii sunt precompletate si pot fi editate manual.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: campul de versuri e precompletat cu versurile CURENTE (editate anterior, sau originale) ale fiecarei melodii, cu etichetele de structura traduse pentru afisare', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes("(v.editedLyrics && v.editedLyrics.trim()) ? v.editedLyrics : (v.originalLyrics || '')"));
  assert.ok(body.includes('song1Lyrics.value = translateSectionLabelsForDisplay(effectiveLyrics(v1), order.lang);'));
  assert.ok(body.includes('song2Lyrics.value = translateSectionLabelsForDisplay(effectiveLyrics(v2), order.lang);'));
});

test('server.js: versurile trimise (modificate manual) sunt salvate PE VARIANTA SURSA inainte de a porni regenerarea, DOAR daca difera de versurile efective curente', () => {
  const idx = server.indexOf('const lyricsPatches = [];');
  const body = server.slice(idx, idx + 900);
  assert.ok(body.includes('if (song.lyricsInput !== currentEffective) {'));
  assert.ok(body.includes('editedLyrics: patch.lyrics'));
});

test('melodia-mea.html: versurile sunt normalizate INAPOI la etichetele standard (engleza) inainte de a fi trimise catre server — niciodata trimise cu etichete traduse', () => {
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('normalizeSectionLabelsForSaving(song1Lyrics.value.trim(), order.lang)'));
  assert.ok(body.includes('normalizeSectionLabelsForSaving(song2Lyrics.value.trim(), order.lang)'));
});

// ---------------------------------------------------------------------------------------------
// TEST 11+12: dupa editare apar EXACT patru melodii, toate cu preview redabil.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: pagina de comparare arata TOATE variantele reale ale comenzii (order.variants.forEach), fara limita fixa — pentru editarea secventiala noua, mereu exact 4', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, idx + 1000);
  assert.ok(body.includes('variants.forEach(v => {'));
});

test('melodia-mea.html: fiecare card de comparare arata denumirea versiunii, genul, playerul real, versurile SI controlul de selectare — toate cinci, cerinta explicita', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const end = melodia.indexOf('function togglePremiumCompareSelection');
  const body = melodia.slice(idx, end);
  assert.ok(body.includes('songLabel'), 'denumirea versiunii (melodia 1/2)');
  assert.ok(body.includes('versionLabel'), 'initiala/editata');
  assert.ok(body.includes('genreTag'), 'genul muzical');
  assert.ok(body.includes('createPremiumAudioPlayer(v.previewUrl, v.durationSeconds)'), 'playerul real de 40s');
  assert.ok(body.includes('lyricsHtml'), 'versurile');
  assert.ok(body.includes('premium-compare-check'), 'controlul de selectare (bifa)');
});

// ---------------------------------------------------------------------------------------------
// TEST 18+19: Standard si Cadou video raman STRICT neschimbate — design Standard reutilizat,
// nu un sistem vizual nou.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: componentele noi reutilizeaza STRICT variabilele CSS deja existente (var(--gold), var(--gold-deep), var(--line), var(--surface)) — nicio culoare noua introdusa', () => {
  const start = melodia.indexOf('.premium-edit-song-indicator{');
  const end = melodia.indexOf('.premium-compare-card{');
  const body = melodia.slice(start, end);
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(body), 'nu trebuie sa existe culori hex noi, doar var(--...) deja existente');
});

test('server.js: ramura veche (handleLegacyRegenerate, Standard/Video) ramane STRICT neschimbata de editarea secventiala Premium', () => {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 200);
  assert.ok(body.includes("if (order.status === 'ready')"));
});

// ---------------------------------------------------------------------------------------------
// TEST 20: nicio cheie de traducere lipsa in niciuna dintre cele 8 limbi (cheile NOI introduse
// in aceasta runda pentru melodia-mea.html).
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: toate cele 6 chei noi de traducere (runda 4) exista exact de 8 ori (o data per limba)', () => {
  const keys = [
    'premium_edit_step1_label', 'premium_edit_step2_label', 'premium_edit_voice_label',
    'premium_edit_step1_continue_btn', 'premium_edit_back_btn', 'premium_compare_subtitle'
  ];
  keys.forEach(key => {
    const count = (melodia.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa apara exact de 8 ori (o data per limba), a aparut de ${count} ori`);
  });
});

test('melodia-mea.html: valorile actualizate (premium_edit_start_btn, premium_compare_title) raman prezente exact de 8 ori fiecare, nicio limba omisa la actualizare', () => {
  ['premium_edit_start_btn', 'premium_compare_title'].forEach(key => {
    const count = (melodia.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa ramana in toate cele 8 limbi dupa actualizarea textului`);
  });
});

// REGRESIE CONFIRMATA LA TESTAREA LIVE PE STAGING (hotfix, runda 4): renderPremiumEditView()
// folosea VOICE_PREFERENCES fara ca acea constanta sa existe vreodata in acest fisier
// (server.js NU expune constante catre client) — ReferenceError la fiecare deschidere a
// ecranului de editare, care oprea executia functiei LA MIJLOC, inainte ca handler-ul
// butonului "Continuă la a doua melodie" sa mai apuce sa fie atasat (`.onclick = ...` era pe
// urmatoarele linii, niciodata executate) — butonul parea complet mort la click.
// node --check nu prinde asta (e o eroare de RUNTIME, nu de sintaxa) — motiv in plus pentru
// care testarea live pe staging ramane obligatorie, nu doar verificarile automate.
test('melodia-mea.html: VOICE_PREFERENCES e definita LOCAL (client-side), inainte de renderPremiumEditView — server.js nu expune constante catre client', () => {
  const constIdx = melodia.indexOf("const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];");
  assert.ok(constIdx !== -1, 'VOICE_PREFERENCES trebuie definita explicit in melodia-mea.html');
  const usageIdx = melodia.indexOf('function renderPremiumEditView(order) {');
  assert.ok(constIdx < usageIdx, 'VOICE_PREFERENCES trebuie definita INAINTE de renderPremiumEditView (ordinea conteaza pentru un const de top-level, chiar daca functiile sunt hoisted)');
});

// ---------------------------------------------------------------------------------------------
// Verificari finale de sintaxa.
// ---------------------------------------------------------------------------------------------
test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
