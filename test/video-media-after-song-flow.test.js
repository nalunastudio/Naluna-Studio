// Round 10 ("muta complet etapa de incarcare a fotografiilor/videoclipurilor dinaintea
// generarii melodiei la finalul fluxului muzical, dupa ce melodia a fost generata, ascultata,
// editata (daca clientul doreste) si aleasa in versiunea finala"): pachetul "Cadou video" nu
// mai solicita materiale inainte de generare, reutilizeaza EXACT formatul Standard pentru
// afisarea/editarea/compararea melodiei, si arata butonul "Adaugă amintirile pentru
// videoclipul cadou" STRICT dupa ce versiunea finala e stabilita. Standard/Premium raman
// neschimbate. mediaDebug si mesajul tehnic despre bifa albastra/iCloud sunt eliminate complet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const melodiaMea = read('public/melodia-mea.html');
const comanda = read('public/comanda.html');
const comandaMea = read('public/comanda-mea.html');
const succes = read('public/succes.html');
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): meniul de
// materiale (upload/coada/picker-lock) descris in acest fisier a fost MUTAT din melodia-mea.html
// in public/amintiri-video.html — testele care verifica STRICT acest meniu sunt retargetate;
// melodia-mea.html ramane STRICT pentru butonul care navigheaza catre noua pagina.
const amintiriVideo = read('public/amintiri-video.html');

// ---------------------------------------------------------------------------------------------
// 1. Generarea melodiei nu mai e conditionata de materiale — nici server-side, nici in fluxul
//    de creare a comenzii.
// ---------------------------------------------------------------------------------------------
test('server.js: POST /generate NU mai verifica mediaConfirmedAt pentru pachetul video', () => {
  assert.ok(!server.includes("order.plan === 'video' && !order.mediaConfirmedAt"));
  const idx = server.indexOf("app.post('/api/orders/:orderId/generate'");
  const end = server.indexOf("app.post('/api/orders/:orderId/regenerate'");
  const routeSrc = server.slice(idx, end);
  assert.ok(!/order\.mediaConfirmedAt/.test(routeSrc), 'ruta /generate nu mai trebuie sa citeasca deloc order.mediaConfirmedAt din cod');
});

test('comanda.html: pachetul video foloseste EXACT acelasi apel /generate ca Standard/Premium, fara ramura separata catre melodia-mea.html', () => {
  assert.ok(!comanda.includes("if (selectedPlan.id === 'video') {\n        localStorage.removeItem(DRAFT_KEY);"));
  assert.ok(comanda.includes("window.location.href = `/se-compune.html?id=${currentOrderId}&token=${tokenParam}`;"));
  // O singura cale de succes catre se-compune.html, dupa acelasi apel /generate — nu doua rute.
  const successRedirects = (comanda.match(/window\.location\.href = `\/se-compune\.html\?id=/g) || []).length;
  assert.equal(successRedirects, 1);
});

test('comanda.html: butonul de generare foloseste STRICT btn_generate pentru toate planurile (nu mai exista btn_continue_media)', () => {
  assert.ok(!comanda.includes('btn_continue_media'));
  const occurrences = (comanda.match(/btn_generate:/g) || []).length;
  assert.equal(occurrences, 8, 'btn_generate trebuie sa ramana definit in toate cele 8 limbi');
});

// ---------------------------------------------------------------------------------------------
// 2. Ecranul vechi "awaiting-media" (upload inainte de generare) a fost eliminat complet.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ecranul dedicat de asteptare a materialelor INAINTE de generare (awaiting-media-state) nu mai exista', () => {
  assert.ok(!melodiaMea.includes('awaiting-media-state'));
  assert.ok(!melodiaMea.includes('renderAwaitingMedia'));
  assert.ok(!melodiaMea.includes('awaiting-media-continue-btn'));
  assert.ok(!melodiaMea.includes('awaiting_media_title'));
  assert.ok(!melodiaMea.includes('awaiting_media_continue_btn'));
});

test('melodia-mea.html: o comanda video veche, ramasa "draft" (fara mediaConfirmedAt), porneste singura /generate inainte de a redirectiona catre se-compune.html', () => {
  const idx = melodiaMea.indexOf("order.plan === 'video' && order.status === 'draft'");
  assert.notEqual(idx, -1, 'trebuie sa existe o plasa de siguranta pentru comenzile video vechi ramase draft');
  const snippet = melodiaMea.slice(idx, idx + 400);
  assert.ok(snippet.includes('/generate'));
});

// ---------------------------------------------------------------------------------------------
// 3. Cadou video reutilizeaza EXACT formatul Standard pentru afisare/editare/comparare.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: Video foloseste EXACT acelasi meniu de editare pliabil ca Standard (nu mai e "mereu vizibil" ca Premium)', () => {
  assert.ok(melodiaMea.includes("const standardDirectEditMode = (order.plan === 'standard' || order.plan === 'video') && !isStandardEditChoice;"));
});

test('melodia-mea.html: cuvantul "Standard" nu e afisat niciodata clientului in contextul pachetului video', () => {
  const ctaIdx = melodiaMea.indexOf("id=\"memories-cta\"");
  const sectionEnd = melodiaMea.indexOf('<div id="video-status-msg"', ctaIdx);
  const block = melodiaMea.slice(ctaIdx, sectionEnd);
  assert.ok(!/Standard/.test(block));
});

// ---------------------------------------------------------------------------------------------
// 4. Butonul "Adaugă amintirile pentru videoclipul cadou" apare STRICT dupa stabilirea
//    versiunii finale si dezvaluie meniul EXISTENT de upload, neschimbat.
// ---------------------------------------------------------------------------------------------
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): butonul
// ramane in aceeasi pozitie/aspect (STRICT inaintea #video-status-msg, stilul .btn-cta-orange
// neschimbat) — dar nu mai dezvaluie un meniu inline, ci navigheaza catre /amintiri-video.html.
test('melodia-mea.html: butonul de materiale exista, plasat imediat inainte de #video-status-msg, folosind stilul existent (.btn-cta-orange)', () => {
  const ctaIdx = melodiaMea.indexOf('id="memories-cta"');
  assert.notEqual(ctaIdx, -1);
  const statusIdx = melodiaMea.indexOf('id="video-status-msg"', ctaIdx);
  assert.notEqual(statusIdx, -1);
  assert.ok(statusIdx - ctaIdx < 500, 'butonul trebuie sa fie STRICT langa (imediat inaintea) mesajului de stare video');
  const block = melodiaMea.slice(ctaIdx, statusIdx);
  assert.ok(block.includes('class="btn-cta-orange"'), 'trebuie sa reutilizeze stilul existent, nu un buton nou');
});

test('melodia-mea.html: updateMemoriesCta() ascunde STRICT butonul cat timp versiunea finala nu e stabilita (pendingVariantChoice) SAU videoclipul e deja gata', () => {
  const idx = melodiaMea.indexOf('function updateMemoriesCta(order, pendingVariantChoice) {');
  assert.notEqual(idx, -1);
  const end = melodiaMea.indexOf('\n  }', idx);
  const snippet = melodiaMea.slice(idx, end);
  assert.ok(snippet.includes("ctaWrap.style.display = (!pendingVariantChoice && order.videoStatus !== 'ready') ? 'block' : 'none';"));
});

test("melodia-mea.html: apasarea butonului navigheaza (aceeasi fila) catre /amintiri-video.html, cu id si token, fara popup", () => {
  const idx = melodiaMea.indexOf("document.getElementById('memories-cta-btn').addEventListener('click'");
  assert.notEqual(idx, -1);
  const snippet = melodiaMea.slice(idx, idx + 400);
  assert.ok(snippet.includes('window.location.href = `/amintiri-video.html?id='), 'trebuie sa navigheze, aceeasi fila, catre noua pagina dedicata');
  assert.ok(!snippet.includes("window.open("), 'nu trebuie sa deschida niciun popup/tab nou');
});

test('amintiri-video.html: meniul de materiale e STRICT cel existent, neschimbat structural — acelasi input, aceleasi limite (3-10)', () => {
  assert.ok(amintiriVideo.includes('const MEM_MIN = 3;'));
  assert.ok(amintiriVideo.includes('const MEM_MAX = 10;'));
  assert.ok(amintiriVideo.includes('<input type="file" id="mem-file-input" multiple accept="image/*,video/*"'));
});

// ---------------------------------------------------------------------------------------------
// 5. Materialele se confirma automat (fara pas manual suplimentar) si declanseaza randarea
//    videoclipului STRICT pentru varianta finala aleasa — asocierea cu melodia corecta.
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: confirmarea materialelor foloseste STRICT endpointul existent /media/confirm, fara niciun endpoint nou', () => {
  const idx = amintiriVideo.indexOf('async function maybeAutoConfirmMedia(order, gateOk) {');
  assert.notEqual(idx, -1);
  const end = amintiriVideo.indexOf('\n  }', idx);
  const snippet = amintiriVideo.slice(idx, end);
  assert.ok(snippet.includes('/media/confirm'));
  assert.ok(snippet.includes("method: 'POST'"));
});

test('server.js: triggerVideoGeneration foloseste STRICT order.selectedVariantId (varianta finala aleasa) — asocierea video-melodie ramane neschimbata', () => {
  assert.ok(server.includes('async function triggerVideoGeneration(orderId, variantId) {'));
  // RELANSARE (2026-08-14, "o singura apasare trebuie sa creeze exact un singur job video"):
  // POST /media/confirm nu mai declanseaza automat PRIMA randare (acum STRICT rezultatul
  // apasarii explicite a butonului "Creează videoclipul meu cadou", vezi POST /create-video) —
  // reconfirmarea AUTOMATA ramane STRICT pentru cazul in care un videoclip exista deja.
  assert.ok(server.includes('if (result.order.status === \'preview_ready\' && result.order.selectedVariantId && confirmedVariant && confirmedVariant.videoKey) {'));
  assert.ok(server.includes('triggerVideoGeneration(order.id, order.selectedVariantId)'), '/create-video trebuie sa ramana capabil sa declanseze prima randare, explicit');
});

// ---------------------------------------------------------------------------------------------
// 6. Comenzile video vechi, cu materiale deja incarcate, isi pastreaza materialele — nicio
//    migrare distructiva, niciun element R2 sters.
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: renderMemories() afiseaza intotdeauna materialele DEJA existente (order.uploadedMedia), fara sa oblige reincarcarea', () => {
  assert.ok(amintiriVideo.includes('function renderExistingList(order) {'));
  const idx = amintiriVideo.indexOf('function renderMemories(order) {');
  const snippet = amintiriVideo.slice(idx, idx + 400);
  assert.ok(snippet.includes('renderExistingList(order)'));
});

test('server.js: nicio operatie de stergere in masa a obiectelor R2 sau migrare distructiva a uploadedMedia nu a fost adaugata', () => {
  assert.ok(!/DeleteObjects|deleteAllMedia|migrateUploadedMedia/.test(server));
});

// ---------------------------------------------------------------------------------------------
// 7. mediaDebug (Runda 9) si mesajul tehnic despre bifa albastra/iCloud/timp de asteptare
//    (Rundele 7-8) sunt eliminate complet, din toate cele 3 pagini si din server.js.
// ---------------------------------------------------------------------------------------------
const PAGES = { 'melodia-mea.html': melodiaMea, 'amintiri-video.html': amintiriVideo, 'comanda-mea.html': comandaMea, 'succes.html': succes };
for (const [name, html] of Object.entries(PAGES)) {
  test(`${name}: mediaDebug (panou, parametru, instrumentare) a fost eliminat complet`, () => {
    assert.ok(!/mediaDebug/i.test(html), `${name} nu mai trebuie sa contina nicio referinta la mediaDebug`);
    assert.ok(!html.includes('naluna-build'));
  });

  test(`${name}: mesajul tehnic despre bifa albastra/iCloud/timpul de asteptare a fost eliminat complet`, () => {
    // memories_no_files_selected (eroare distincta, cand selectorul nu a returnat niciun
    // fisier) ramane neschimbata — mentioneaza iCloud intr-un context util, diferit, si NU
    // face parte din instrumentarea/mesajul tehnic eliminat aici. Verificarea de mai jos e
    // STRICT pe cheile de traducere eliminate, nu pe comentarii interne de cod (care pot
    // mentiona istoric "bifa albastra" ca parte a documentarii unui incident trecut).
    assert.ok(!html.includes('memories_ios_wait_hint'));
    assert.ok(!html.includes('memories_ios_preparing'));
  });
}

test('server.js: middleware-ul de injectare a __NALUNA_BUILD__ (mediaDebug) a fost eliminat complet', () => {
  assert.ok(!server.includes('MEDIA_DEBUG_BUILD'));
  assert.ok(!server.includes('MEDIA_DEBUG_INJECT_FILES'));
  assert.ok(!server.includes('__NALUNA_BUILD__'));
});

// ---------------------------------------------------------------------------------------------
// 8. Cele 8 limbi — textul nou strict necesar noului pas.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: memories_cta_title exista in toate cele 8 limbi', () => {
  const occurrences = (melodiaMea.match(/memories_cta_title:/g) || []).length;
  assert.equal(occurrences, 8);
});

test('melodia-mea.html: memories_cta_sub exista in toate cele 8 limbi', () => {
  const occurrences = (melodiaMea.match(/memories_cta_sub:/g) || []).length;
  assert.equal(occurrences, 8);
});

test('melodia-mea.html: textul romana al noului pas e exact cel cerut', () => {
  assert.ok(melodiaMea.includes("memories_cta_title: 'Adaugă amintirile pentru videoclipul cadou',"));
  assert.ok(melodiaMea.includes("memories_cta_sub: 'Alege fotografiile și videoclipurile care vor da viață poveștii voastre.',"));
});

// ---------------------------------------------------------------------------------------------
// 9. Standard si Premium raman complet neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta runda', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

test('server.js: checkout-ul ramane STRICT gatat pe mediaConfirmedAt + videoclip gata, pretul si fluxul de plata nu s-au schimbat', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/checkout'");
  const end = server.indexOf('const checkoutGuard = await credits.evaluateGuard', idx);
  const routeSrc = server.slice(idx, end);
  assert.ok(routeSrc.includes("if (!order.mediaConfirmedAt) {"));
  assert.ok(routeSrc.includes("if (!videoVariant || !videoVariant.videoKey) {"));
});

test('melodia-mea.html: fluxul Premium (renderPremiumFlow) ramane complet separat si neatins', () => {
  assert.ok(melodiaMea.includes('function renderPremiumFlow(order, isResumeFlag) {'));
  assert.ok(melodiaMea.includes("if (order.plan === 'premium') {\n      renderPremiumFlow(order, isResume);\n      return;\n    }"));
});

test('amintiri-video.html: uploadul multipart direct catre R2 (Round 6) ramane neschimbat', () => {
  assert.ok(amintiriVideo.includes('async function startMultipartUpload(entry) {'));
  assert.ok(amintiriVideo.includes('function uploadOnePart('));
  assert.ok(amintiriVideo.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
});

// CORECȚIE (2026-08-29, runda 2, "selectorul nu se mai deschide deloc pe iPhone"): pragul/lock
// temporal (PICKER_MANUAL_RECOVERY_MS) a fost cauza EXACTA a blocajului — pointerdown seta
// lock-ul, iar click-ul legitim care urma imediat gasea lock-ul activ si isi anula singur
// deschiderea nativa. Eliminat complet; feedback-ul vizual (pickerPending) e acum STRICT
// pentru mesaje, niciodata pentru blocare — vezi test/amintiri-video-iphone-ux.test.js pentru
// testul de regresie dedicat secventei reale pointerdown->click.
test('amintiri-video.html: logica de picker nu mai foloseste niciun prag/lock temporal — feedback-ul vizual e separat de deschiderea selectorului, afordanta explicita de recuperare exista in continuare', () => {
  assert.ok(!amintiriVideo.includes('PICKER_MANUAL_RECOVERY_MS'), 'pragul de recuperare temporal a fost eliminat complet');
  assert.ok(!amintiriVideo.includes('pickerLockTimeoutId'));
  assert.ok(amintiriVideo.includes('function showPickerWaitingMessage() {'), 'afordanta explicita de recuperare trebuie sa existe');
});

// ---------------------------------------------------------------------------------------------
// 10. Sintaxa ramane valida in toate fisierele modificate.
// ---------------------------------------------------------------------------------------------
for (const [name, html] of Object.entries({ ...PAGES, 'comanda.html': comanda })) {
  test(`${name}: ramane sintactic valid dupa Runda 10`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
}

test('server.js: ramane sintactic valid dupa Runda 10', () => {
  require('node:child_process').execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
});
