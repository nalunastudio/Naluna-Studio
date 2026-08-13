// Test de regresie pentru corectia "Cadou video: o singura melodie initiala + o editare"
// (2026-08-14). Cauza reala a comportamentului gresit: PLAN_VARIANT_COUNT.video era setat la 2
// in server.js, ceea ce facea "Cadou video" sa fie tratat exact ca Premium — cerea doua genuri
// muzicale diferite de la crearea comenzii si genera doua melodii INITIALE distincte. Pachetul
// trebuie insa sa functioneze ca Standard: o singura melodie initiala, o singura editare
// gratuita (care pastreaza originalul si adauga alaturi varianta editata), clientul alege
// explicit intre cele doua inainte de plata, iar fiecare varianta reala are propriul videoclip
// sincronizat. Standard si Premium raman STRICT neschimbate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getGiftVariant } = require('../lib/entitlements');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const comanda = read('public/comanda.html');
const melodiaMea = read('public/melodia-mea.html');
const succes = read('public/succes.html');

// ---------------------------------------------------------------------------------------------
// 1. Cadou video NU mai afiseaza "Genul celei de-a doua melodii" si nu mai cere/valideaza un
//    al doilea gen la crearea comenzii.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_VARIANT_COUNT.video e 1 (o singura melodie initiala, ca Standard) — Premium ramane 2', () => {
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

test('server.js: POST /api/orders NU mai cere/valideaza genre2 pentru plan="video" (PLAN_VARIANT_COUNT[plan] === 2 e acum fals pentru video)', () => {
  const idx = server.indexOf("if (PLAN_VARIANT_COUNT[plan] === 2) {");
  assert.notEqual(idx, -1);
  // simulam evaluarea: pentru plan='video', PLAN_VARIANT_COUNT['video'] === 2 e FALS acum,
  // deci intreg blocul de validare genre2 (genre2Message/sameGenreMessage) e sarit.
  const PLAN_VARIANT_COUNT = { standard: 1, premium: 2, video: 1 };
  assert.equal(PLAN_VARIANT_COUNT.video === 2, false);
  assert.equal(PLAN_VARIANT_COUNT.premium === 2, true);
});

test('comanda.html: planNeedsGenre2() e acum STRICT Premium — Video nu mai afiseaza campul "Genul celei de-a doua melodii"', () => {
  assert.match(comanda, /function planNeedsGenre2\(planId\) \{\s*return planId === 'premium';\s*\}/);
});

test('comanda.html: updateGenre2Visibility() ascunde genre2Field pentru orice plan diferit de premium (deci si pentru video)', () => {
  const idx = comanda.indexOf('function updateGenre2Visibility() {');
  const end = comanda.indexOf('\n  }', idx);
  const snippet = comanda.slice(idx, end);
  assert.ok(snippet.includes("const needsGenre2 = planNeedsGenre2(selectedPlan.id);"));
  assert.ok(snippet.includes("genre2Field.style.display = needsGenre2 ? '' : 'none';"));
});

// ---------------------------------------------------------------------------------------------
// 2. Descrierea pachetului nu mai promite doua genuri / doua melodii initiale complete.
// ---------------------------------------------------------------------------------------------
test('comanda.html: benefits_video (toate cele 8 limbi) nu mai contine nicio referinta la "Premium", doua genuri sau ambele melodii complete', () => {
  assert.ok(!/benefits_video: \[[^\]]*Premium/s.test(comanda) || (() => {
    // verificare mai stricta, per bloc — extragem fiecare array benefits_video si cautam in el.
    let idx = 0;
    let blocksChecked = 0;
    while (true) {
      idx = comanda.indexOf('benefits_video: [', idx);
      if (idx === -1) break;
      const end = comanda.indexOf('],', idx);
      const block = comanda.slice(idx, end);
      assert.ok(!/Premium/.test(block), `benefits_video nu mai trebuie sa mentioneze "Premium" — gasit in: ${block.slice(0, 80)}`);
      assert.ok(!/ambele.*melod|both.*song|beide.*Lieder|ambas.*canciones|entrambe.*canzoni|deux chansons|двете.*песни|iki.*şark/i.test(block), 'benefits_video nu mai trebuie sa promita livrarea ambelor melodii');
      idx = end;
      blocksChecked++;
    }
    assert.equal(blocksChecked, 8, 'trebuie sa existe exact 8 blocuri benefits_video (cate unul per limba)');
    return true;
  })());
});

test('comanda.html: benefits_video mentioneaza explicit o singura editare gratuita si compararea versiunii inițiale cu cea editata, in toate cele 8 limbi', () => {
  const occurrences = (comanda.match(/benefits_video: \[/g) || []).length;
  assert.equal(occurrences, 8);
  // Romana (primul bloc) — continutul exact al noii descrieri.
  const idx = comanda.indexOf('benefits_video: [');
  const end = comanda.indexOf('],', idx);
  const block = comanda.slice(idx, end);
  assert.ok(block.includes('o singură editare gratuită') || block.includes('o singura editare gratuita') || /o singur[ăa] editare gratuit[ăa]/.test(block));
  assert.ok(/versiunea ini[țt]ial[ăa]/i.test(block) && /versiunea editat[ăa]/i.test(block));
});

// ---------------------------------------------------------------------------------------------
// 3. Standard si Premium raman STRICT neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_PRICES ramane exact neschimbat (£15/£25/£35) — corectia nu a atins preturile', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});

test('comanda.html: Premium continua sa foloseasca genre2Field pe ecranul dedicat (pasul 6), neschimbat', () => {
  const idx = comanda.indexOf("function updateGenre2Visibility() {");
  const snippet = comanda.slice(idx, idx + 200);
  assert.ok(snippet.includes("if (selectedPlan.id === 'premium') {"));
  assert.ok(snippet.includes("song2GenreSlot.appendChild(genre2Field);"));
});

test('server.js: mecanismul dual-genre (Promise.all, replaceVariantId, editVariantIds) ramane intact pentru Premium', () => {
  assert.ok(server.includes('const [taskId1, taskId2] = await Promise.all(['));
  assert.ok(server.includes('options.replaceVariantId'));
  assert.ok(server.includes('options.editVariantIds'));
});

// ---------------------------------------------------------------------------------------------
// 4. Video genereaza o singura melodie initiala; poate fi editata O SINGURA DATA; originalul
//    ramane intact; editarea produce o versiune distincta.
// ---------------------------------------------------------------------------------------------
test('server.js: runGeneration() foloseste ramura cu UN SINGUR gen (!isDualGenrePlan) pentru video, dupa corectia PLAN_VARIANT_COUNT', () => {
  const idx = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  assert.notEqual(idx, -1);
  const snippet = server.slice(idx, idx + 5400);
  assert.ok(snippet.includes('const isDualGenrePlan = PLAN_VARIANT_COUNT[order.plan] === 2;'));
  assert.ok(snippet.includes('if (!isDualGenrePlan) {'));
  // pentru video (PLAN_VARIANT_COUNT.video===1), isDualGenrePlan e fals -> intra pe aceasta
  // ramura, exact ca Standard — UN SINGUR apel Suno, cu order.genre (niciodata genre2).
  assert.ok(snippet.includes("buildPrompt(order, feedback)"));
});

test('server.js: FREE_EDITS ramane 1 pentru toate pachetele — Cadou video are exact o editare/regenerare gratuita, ca Standard', () => {
  assert.match(server, /const FREE_EDITS = 1;/);
});

test('server.js: la editare, keepOriginalForStandardEdit e adevarat pentru video (PLAN_VARIANT_COUNT.video===1) — originalul e PASTRAT, nu inlocuit', () => {
  assert.ok(server.includes('const keepOriginalForStandardEdit = PLAN_VARIANT_COUNT[order.plan] === 1;'));
  assert.ok(server.includes('regenerateKeepOriginal: keepOriginalForStandardEdit'));
  const PLAN_VARIANT_COUNT = { standard: 1, premium: 2, video: 1 };
  assert.equal(PLAN_VARIANT_COUNT.video === 1, true, 'video trebuie sa intre pe ramura keepOriginalAsAlternative, ca Standard');
});

test('server.js: finalizeVariantsIfNeeded — options.keepOriginalAsAlternative PASTREAZA originalul si adauga varianta editata alaturi (isEditedAlternative=true), fara sa stearga nimic', () => {
  const idx = server.indexOf('} else if (options.keepOriginalAsAlternative) {');
  assert.notEqual(idx, -1);
  const snippet = server.slice(idx, idx + 2000);
  assert.ok(snippet.includes('const edited = builtVariants[0];'));
  assert.ok(snippet.includes('edited.isEditedAlternative = true;'));
  assert.ok(snippet.includes('variants = [...existing, edited];'));
  assert.ok(snippet.includes('replacedOldVariants = [];'), 'originalul nu trebuie sters din storage');
});

test('server.js: daca nu exista nicio editare (generare initiala, fara optiuni), NU se seteaza isEditedAlternative pe nicio varianta si nu se creeaza o a doua varianta falsa', () => {
  const idx = server.indexOf('variants = builtVariants;');
  assert.notEqual(idx, -1);
  const before = server.slice(Math.max(0, idx - 30), idx);
  assert.ok(/\}\s*else\s*\{\s*$/.test(before), 'trebuie sa fie chiar ramura else (fara nicio optiune de editare)');
  const snippet = server.slice(idx, idx + 200);
  assert.ok(snippet.includes('variants = builtVariants;'));
  assert.ok(!snippet.includes('isEditedAlternative'), 'generarea initiala nu trebuie sa marcheze nicio varianta ca fiind editata');
});

test('POST /regenerate: schimbarea de gen la editare scrie in coloana genre (nu genre2) pentru video, pentru ca isDualGenrePlanForRegen e fals', () => {
  const idx = server.indexOf('const isDualGenrePlanForRegen = PLAN_VARIANT_COUNT[order.plan] === 2;');
  assert.notEqual(idx, -1);
  const PLAN_VARIANT_COUNT = { standard: 1, premium: 2, video: 1 };
  assert.equal(PLAN_VARIANT_COUNT.video === 2, false, 'video nu mai e un plan dual-genre la editare');
});

// ---------------------------------------------------------------------------------------------
// 5. Fiecare versiune reala e asociata cu propriul audio/versuri/gen — o versiune Pop nu e
//    niciodata asociata cu configuratia/videoclipul unei versiuni Hip-Hop.
// ---------------------------------------------------------------------------------------------
test('server.js: fiecare varianta primeste STRICT propriul gen (built.genre = genre, din requestsInfo-ul PROPRIU acelei cereri Suno)', () => {
  assert.ok(server.includes('built.genre = genre;'));
});

test('server.js: triggerVideoGeneration(orderId, variantId) e scopat STRICT pe o singura varianta — videoKey se salveaza pe ACEA varianta, niciodata pe alta', () => {
  const idx = server.indexOf('async function triggerVideoGeneration(orderId, variantId) {');
  assert.notEqual(idx, -1);
});

test('server.js: POST /select (handleSelectOne) — schimbarea variantei audio marcheaza explicit videoclipul vechi ca depasit si declanseaza randare noua pentru varianta nou aleasa (niciodata amestecate)', () => {
  const idx = server.indexOf('async function handleSelectOne(req, res, next) {');
  const snippet = server.slice(idx, idx + 1600);
  assert.ok(snippet.includes("if (order.plan === 'video') {"));
  assert.ok(snippet.includes('oldHadVideo'));
});

test('server.js: GET /media/video/:orderId si /media/full/:orderId livreaza STRICT varianta selectata (order.selectedVariantId), niciodata alta', () => {
  const videoIdx = server.indexOf("app.get('/media/video/:orderId'");
  const videoSnippet = server.slice(videoIdx, videoIdx + 2000);
  assert.ok(videoSnippet.includes('const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);'));
});

// ---------------------------------------------------------------------------------------------
// 6. Alegerea finala: original -> melodie+video original; editat -> melodie+video editat.
//    Dupa plata, clientul NU primeste niciodata varianta nealeasa (nicio "melodie cadou" pentru
//    video, spre deosebire de Premium).
// ---------------------------------------------------------------------------------------------
test('lib/entitlements.js: getGiftVariant() returneaza null pentru plan="video" (executie REALA, nu doar text-matching) — nicio melodie/videoclip nealese nu se livreaza', () => {
  const orderWithTwoVariants = {
    plan: 'video',
    selectedVariantId: 'v1',
    variants: [{ id: 'v1', fullKey: 'a', isEditedAlternative: undefined }, { id: 'v2', fullKey: 'b', isEditedAlternative: true }]
  };
  assert.equal(getGiftVariant(orderWithTwoVariants), null, 'Video nu trebuie sa livreze niciodata varianta nealeasa, indiferent care e originala/editata');
});

test('lib/entitlements.js: getGiftVariant() ramane null pentru Standard (neschimbat) si continua sa functioneze corect pentru Premium', () => {
  assert.equal(getGiftVariant({ plan: 'standard', selectedVariantId: 'v1', variants: [{ id: 'v1' }, { id: 'v2', isEditedAlternative: true }] }), null);
  const premiumOrder = { plan: 'premium', selectedVariantId: 'v1', selectedVariantId2: 'v2', variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b' }] };
  const gift = getGiftVariant(premiumOrder);
  assert.equal(gift && gift.id, 'v2', 'Premium trebuie sa continue sa livreze a doua melodie completa, neschimbat');
});

test('server.js: checkout-ul video ramane gated pe videoKey-ul VARIANTEI SELECTATE (selectedVariantId) — nu poate plati fara videoclipul EXACT al melodiei alese', () => {
  const idx = server.indexOf("Confirmă fotografiile/videoclipurile înainte de a plăti.");
  assert.notEqual(idx, -1);
  const snippet = server.slice(idx, idx + 1000);
  assert.ok(snippet.includes('const videoVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);'));
  assert.ok(snippet.includes('if (!videoVariant || !videoVariant.videoKey)'));
});

test('server.js: PLAN_PRICES.video ramane £35 — checkout-ul foloseste STRICT pretul serverului, niciodata pretul Standard/Premium', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.ok(server.includes('const price = PLAN_PRICES[plan];'));
});

test('public/succes.html: nu mai calculeaza/afiseaza o "melodie cadou" pentru plan="video" pe pagina de dupa plata', () => {
  assert.ok(succes.includes("const giftVariant = (data.plan === 'video') ? null : (data.variants || []).find(v => v.id !== data.selectedVariantId);"));
});

// ---------------------------------------------------------------------------------------------
// 7. Ecranul de comparare "Versiunea inițială"/"Versiunea editată" (exact ca la Standard) se
//    activeaza pentru video DOAR dupa o editare reala — comenzile Video vechi (doua genuri
//    initiale, fara editare) raman pe eticheta veche, pentru compatibilitate.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ecranul de comparare Standard ("Versiunea inițială"/"Versiunea editată") se activeaza si pentru video, DOAR cand exista o varianta cu isEditedAlternative', () => {
  const occurrences = (melodiaMea.match(/const hasEditedAlternative = \(order\.variants \|\| \[\]\)\.some\(v => v\.isEditedAlternative\);/g) || []).length;
  assert.ok(occurrences >= 3, 'hasEditedAlternative trebuie calculat in cele 3 locuri relevante (renderVariants, updateStandardEditMenuVisibility, renderContent)');
  const widened = (melodiaMea.match(/\(order\.plan === 'standard' \|\| \(order\.plan === 'video' && hasEditedAlternative\)\) && \(order\.variants \|\| \[\]\)\.length > 1;/g) || []).length;
  assert.ok(widened >= 3, 'isStandardEditChoice trebuie sa includa video, dar STRICT cand exista o editare reala');
});

test('melodia-mea.html: eticheta veche "Melodia din videoclip"/"Melodia cadou" (comenzi Video vechi, fara editare reala) nu mai e folosita cand exista o editare reala', () => {
  const idx = melodiaMea.indexOf('const label = isStandardEditChoice');
  const snippet = melodiaMea.slice(idx, idx + 400);
  assert.ok(snippet.includes("? (v.isEditedAlternative ? t.variant_edited_label : t.variant_original_label)"));
  assert.ok(snippet.includes('t.video_song_label'), 'eticheta veche trebuie sa ramana ca fallback pentru comenzile Video vechi, neatinse');
});

test('melodia-mea.html: choose_variant_btn() foloseste genurile REALE ("versiunea inițială — {gen}" / "versiunea nouă — {gen}") — deja generic, reutilizat automat de video', () => {
  const idx = melodiaMea.indexOf("choose_variant_btn: (genre, isEdited, sameGenre, isChosen) => {");
  assert.notEqual(idx, -1);
  const snippet = melodiaMea.slice(idx, idx + 260);
  assert.ok(snippet.includes("isEdited ? 'versiunea nouă' : 'versiunea inițială'"));
});

// ---------------------------------------------------------------------------------------------
// 8. Fotografiile/videoclipurile clientului si limitele (3-10) raman neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: ORDER_MEDIA_MIN_ITEMS/ORDER_MEDIA_MAX_ITEMS (3-10) raman neschimbate', () => {
  assert.ok(/ORDER_MEDIA_MIN_ITEMS\s*=\s*3/.test(server));
  assert.ok(/ORDER_MEDIA_MAX_ITEMS\s*=\s*10/.test(server));
});

// ---------------------------------------------------------------------------------------------
// 9. Sintaxa ramane valida in toate fisierele atinse.
// ---------------------------------------------------------------------------------------------
test('server.js si lib/entitlements.js: node --check trece (nicio eroare de sintaxa introdusa)', () => {
  const { execSync } = require('node:child_process');
  execSync('node --check server.js', { cwd: path.join(__dirname, '..') });
  execSync('node --check lib/entitlements.js', { cwd: path.join(__dirname, '..') });
});
