// Teste de regresie STATICE (citesc direct sursa, fara server/DB) pentru hotfixul urgent
// 2026-08-08: bucla infinita care distrugea playerele audio + "Page Unresponsive" pe TOATE
// pachetele, taierea preview-urilor audio (stream copy -> reincodare), si schimbarea genului
// muzical la editare (Standard + Premium/Video, cu doua genuri distincte per comanda).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('melodia-mea.html: renderContent NU mai apeleaza selectVariant() direct (cauza buclei infinite)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('syncSelectedVariantUI(selectedVariantIndex);'),
    'renderContent trebuie sa foloseasca varianta STRICT vizuala (fara retea/reload)'
  );
  assert.ok(html.includes('function renderContent(order)'), 'functia renderContent trebuie sa existe');
  // linia veche, bugata, care declansa bucla infinita (renderContent -> selectVariant ->
  // loadOrder -> renderContent -> ...) nu mai trebuie sa existe deloc in fisier.
  assert.ok(
    !html.includes('    selectVariant(selectedVariantIndex);'),
    'nu mai trebuie sa existe niciun apel automat la selectVariant() (cu efecte de retea + reload) in afara click handler-ului real'
  );
});

test('melodia-mea.html: selectVariant() ramane rezervat click-ului real al clientului pe un card', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('async function selectVariant(index)'), 'selectVariant trebuie sa existe in continuare, pentru selectia manuala reala');
  assert.ok(html.includes('selectVariant(i);'), 'click handler-ul cardului trebuie sa apeleze in continuare selectVariant');
});

test('melodia-mea.html: playerele audio nu mai folosesc crossOrigin (inutil pentru redare simpla, putea doar strica)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(!html.includes("audioEl.crossOrigin"), 'crossOrigin a fost eliminat din mountAudio dupa ce clientul a confirmat ca playback-ul tot nu functiona cu el activ');
});

test('succes.html: playerele audio/video nu mai folosesc crossOrigin', () => {
  const html = read('public/succes.html');
  assert.ok(!html.includes('el.crossOrigin'), 'crossOrigin eliminat si din mountMedia (succes.html)');
});

test('server.js: trimAudio reincodeaza (libmp3lame), nu mai foloseste "-acodec copy"', () => {
  const server = read('server.js');
  assert.ok(server.includes('async function trimAudio(srcPath, destPath, seconds, startSeconds = 0)'), 'functia trimAudio trebuie sa existe');
  assert.ok(!server.includes("'-acodec', 'copy'"), 'nu mai trebuie folosit stream-copy pentru taierea preview-ului');
  assert.ok(server.includes("'-c:a', 'libmp3lame'"), 'trimAudio trebuie sa reincodeze explicit cu libmp3lame');
});

test('server.js: trimAudio foloseste VBR calitate maxima, fara reesantionare fortata (fix distorsiune la inceput)', () => {
  const server = read('server.js');
  assert.ok(server.includes("'-q:a', '0'"), 'trimAudio trebuie sa foloseasca VBR calitate maxima (-q:a 0) — CBR redus (128k) produce artefacte pe tranziente bruste, exact unde incep preview-urile');
  assert.ok(!server.includes("'-b:a', '128k'"), 'nu mai trebuie folosit un bitrate fix redus, care sacrifica exact calitatea la tranziente');
  assert.ok(!server.includes("'-ar', '44100'"), 'nu mai trebuie fortata reesantionarea — pastram sample rate-ul nativ al sursei (48000Hz de la Suno), un pas de procesare inutil eliminat');
});

test('server.js: trimAudio aplica un fade-in de 15ms (doar clickuri de taiere, nu mascheaza distorsiune)', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("'afade=t=in:st=0:d=0.015'"),
    'trebuie sa existe un fade-in FOARTE scurt (15ms) care elimina doar un eventual click de esantion la taietura, fara sa ascunda o distorsiune mai lunga'
  );
});

test('server.js: /media/video/:orderId ramane strict blocat inainte de plata (fara preview video)', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("if (order.status !== 'ready') return res.status(403).send('Videoclipul se deblochează după plată');"),
    'ruta video trebuie sa refuze STRICT orice acces inainte de status=ready (fara URL semnat, fara redirect, fara fragment)'
  );
});

test('melodia-mea.html: videoclipul cadou e afisat ca coperta STATICA blocata, fara element <video> sau cerere de retea', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('gift-video-locked'), 'trebuie sa existe coperta statica cu lacat');
  assert.ok(!html.includes('function mountGiftVideo'), 'nu mai trebuie sa existe cod care construieste un <video> real pre-plata');
  assert.ok(!html.includes("videoEl.src = `/media/video/"), 'nu mai trebuie sa existe nicio cerere de retea catre /media/video inainte de plata');
});

test('server.js: POST /api/orders/:orderId/regenerate accepta si valideaza schimbarea genului', () => {
  const server = read('server.js');
  assert.ok(server.includes('const requestedGenre = typeof req.body?.genre'), 'regenerate trebuie sa citeasca genre din body');
  assert.ok(server.includes('invalidGenreMessage(order.lang)'), 'un gen invalid trebuie respins cu mesaj tradus');
  assert.ok(
    server.includes('if (otherGenre && requestedGenre === otherGenre)'),
    'Premium/Video: noul gen nu poate coincide cu genul CELEILALTE variante (neatinse)'
  );
});

test('server.js: schimbarea genului la regenerare e inclusa in editarea gratuita existenta, nu una suplimentara (ramura veche, Standard/Video)', () => {
  const server = read('server.js');
  // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): ramura
  // veche (variantId singular, Standard/Video) a fost mutata intr-o functie dedicata
  // (handleLegacyRegenerate), separata de noua ramura Premium (handlePremiumSelectiveRegenerate,
  // care apare INAINTEA ei in fisier si are propriul claim) — cautam DOAR in interiorul
  // ramurii vechi, nu in tot fisierul.
  const legacyStart = server.indexOf('async function handleLegacyRegenerate');
  assert.ok(legacyStart > -1, 'handleLegacyRegenerate trebuie sa existe');
  const legacyBody = server.slice(legacyStart);
  // genre se citeste si valideaza INAINTE de claimOrderForRegeneration (rezervarea editarii
  // gratuite) — nu exista o a doua rezervare/limita separata doar pentru schimbarea genului.
  const genreIdx = legacyBody.indexOf('const requestedGenre = typeof req.body?.genre');
  const claimIdx = legacyBody.indexOf('db.claimOrderForRegeneration(order.id, FREE_EDITS');
  assert.ok(genreIdx > -1 && claimIdx > -1 && genreIdx < claimIdx, 'genul trebuie citit/validat inainte de rezervarea (unica) a editarii gratuite');
});

test('db.js: COLUMN_MAP include "genre" (nu doar "genre2") — altfel db.updateOrder(id, {genre}) e un no-op TACUT', () => {
  const dbSrc = read('db.js');
  // gasit direct la testare reala: schimbarea genului la regenerare "reusea" (raspuns
  // started:true, regenerare reala pornita), dar genul ramanea cel vechi peste tot — COLUMN_MAP
  // nu avea deloc cheia "genre" (doar "genre2"), iar db.updateOrder filtreaza silentios orice
  // cheie absenta din harta, fara nicio eroare.
  assert.match(
    dbSrc,
    /genre:\s*'genre',/,
    'COLUMN_MAP trebuie sa mapeze explicit genre -> genre, altfel schimbarea genului la editare e un no-op tacut'
  );
});

test('server.js: genul se actualizeaza pe coloana corecta (genre sau genre2) inainte de regenerare', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("editingGenre2Slot ? { genre2: requestedGenre } : { genre: requestedGenre }"),
    'trebuie sa scrie explicit in coloana corecta (genre1 sau genre2) inainte de a porni regenerarea'
  );
});

test('server.js: runGeneration/reluari NU mai citesc genul din varianta VECHE (sourceVariant.genre) la regenerare partiala', () => {
  const server = read('server.js');
  // vechiul tipar bugat, eliminat complet
  assert.ok(
    !server.includes('const genreToUse = (sourceVariant && sourceVariant.genre) || order.genre;'),
    'tiparul vechi (citea genul STALE al variantei inainte de editare, ignorand o schimbare de gen) trebuie eliminat complet'
  );
  // noul tipar, corect: gasit prin eliminare, folosind varianta SORA (neatinsa, deci actuala)
  const occurrences = (server.match(/siblingGenre && siblingGenre === order\.genre\)/g) || []).length;
  assert.ok(occurrences >= 3, `genul trebuie aflat prin eliminare (folosind varianta sora) in toate cele 3 locuri (runGeneration, resumeExistingTaskPolling, callback) — gasite ${occurrences}`);
});

// CORECȚIE (2026-08-31, "16 genuri, pagina de gen separata"): EDIT_GENRE_KEYS a trecut de la
// 15 chei vechi la cele 16 noi (pop/ballad_emotional/acoustic_folk/rnb/country/jazz/rock/
// hiphop/edm_dance/manele_suflet/manele_jale/populara/copii/colind/romantic/motivational) —
// vezi test/genre-16-new-list.test.js pentru suita completa dedicata acestei corectii.
test('melodia-mea.html: selectorul de gen la editare exista, populat cu cele 16 genuri NOI ale formularului', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('id="edit-genre-select"'), 'selectorul de gen trebuie sa existe in zona de editare');
  assert.ok(html.includes("EDIT_GENRE_KEYS = ['pop', 'ballad_emotional', 'acoustic_folk'"), 'trebuie sa foloseasca cele 16 genuri noi ale formularului de comanda');
  assert.ok(html.includes('function populateGenreSelect'), 'selectorul trebuie populat dinamic cu genul curent al variantei editate');
});

test('melodia-mea.html: genul selectat e trimis efectiv la regenerare', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(
    html.includes('body: JSON.stringify({ feedback, variantId: sourceVariantId, voicePreference: selectedVoicePreference, genre: requestedGenre })'),
    'cererea de regenerare trebuie sa includa genul ales de client'
  );
});

test('melodia-mea.html: validare client-side ca cele doua genuri raman diferite (Premium/Video)', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('t.edit_genre_same_error'), 'trebuie sa existe un mesaj de eroare tradus pentru genuri identice la editare');
  assert.ok(html.includes("otherVariant.genre === requestedGenre"), 'validarea trebuie sa compare cu genul CELEILALTE variante');
});

test('traduceri: cheile noi (edit_genre_label, edit_genre_same_error, video_song_label) exista in toate cele 8 limbi', () => {
  const html = read('public/melodia-mea.html');
  // RELANSARE (2026-08-14, "previzualizare gratuita de 30s"): gift_video_title/
  // gift_video_locked_msg (cardul "blocat", fara player) au fost inlocuite de
  // gift_video_preview_title/gift_video_preview_text (cardul cu playerul real) — vezi
  // testul dedicat din video-gift-preview-and-creation.test.js.
  ['edit_genre_label', 'edit_genre_same_error', 'video_song_label', 'video_gift_song_label'].forEach(key => {
    const count = (html.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(count, 8, `cheia "${key}" trebuie sa apara exact 8 ori (cate una per limba), gasita de ${count} ori`);
  });
});
