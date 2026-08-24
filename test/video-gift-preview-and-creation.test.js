// Round 11 ("cauza reala pentru care previzualizarea video nu devenea disponibila; meniul de
// editare aglomereaza pagina; claritatea uploadului"): STRICT pachetul "Cadou video".
//
// Cauza radacina TRASATA (nu presupusa): triggerVideoGeneration() e apelat FARA "await" chiar
// inainte ca raspunsul HTTP sa fie trimis — corpul lui asincron cedeaza controlul la primul
// "await" real (o interogare Postgres) inainte ca db.claimVideoRender sa scrie
// video_render_claimed_at. O verificare imediata a starii comenzii, facuta de client chiar
// dupa ce raspunsul soseste, putea prinde 'none' in acea fereastra — iar bucla de polling se
// re-arma STRICT pentru 'generating'/'stale', asa ca o citire 'none' in acel moment insemna ca
// clientul nu mai verifica NICIODATA din nou, ramanand vizual blocat desi job-ul chiar rula
// (sau se terminase) in fundal. Fixat structural: crearea jobului nu mai e niciodata implicita
// (POST /media/confirm nu mai declanseaza automat prima randare), e STRICT rezultatul apasarii
// explicite a butonului "Creează videoclipul meu cadou" — iar acel handler porneste el insusi,
// local, starea de asteptare si bucla de verificare, fara sa astepte sau sa aiba incredere ca
// o citire imediata reflecta deja lock-ul real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const melodiaMea = read('public/melodia-mea.html');

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ---------------------------------------------------------------------------------------------
// 1. COMPORTAMENTUL MENIULUI DE EDITARE — ascunde sectiunea media + textul despre editarea
//    gratuita cat timp meniul e deschis; le reafiseaza la inchidere (fara regenerare).
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: meniul de editare deschis (menuExpanded) ascunde STRICT sectiunea media si textul despre editarea gratuita, pentru pachetul video', () => {
  const idx = melodiaMea.indexOf("function updateStandardEditMenuVisibility(order, pendingVariantChoice) {");
  const body = extractFunction(melodiaMea, "function updateStandardEditMenuVisibility(order, pendingVariantChoice) {");
  assert.ok(body.includes("if (order.plan === 'video') {"));
  assert.ok(body.includes("document.getElementById('edits-info-msg').style.display = menuExpanded ? 'none' : '';"));
  assert.ok(body.includes("document.getElementById('memories-cta').style.display = 'none';"));
  assert.ok(body.includes("document.getElementById('memories-section').style.display = 'none';"));
});

test('melodia-mea.html: inchiderea meniului (fara regenerare) reafiseaza sectiunea media prin updateMemoriesCta — melodia initiala ramane versiunea aleasa', () => {
  const body = extractFunction(melodiaMea, "function updateStandardEditMenuVisibility(order, pendingVariantChoice) {");
  const idx = body.indexOf("if (order.plan === 'video') {");
  const snippet = body.slice(idx, idx + 400);
  assert.ok(snippet.includes('} else {\n        updateMemoriesCta(order, pendingVariantChoice);'), 'meniul INCHIS trebuie sa reafiseze sectiunea media prin updateMemoriesCta (nu o ascunde neconditionat)');
});

test('melodia-mea.html: "Renunță" (confirmCancelBtn) trateaza Standard SI Video identic — inchide meniul si anuleaza modificarile nesalvate pentru ambele', () => {
  const idx = melodiaMea.indexOf("confirmCancelBtn.addEventListener('click'");
  const block = melodiaMea.slice(idx, idx + 1300);
  assert.ok(block.includes("currentOrder.plan === 'standard' || currentOrder.plan === 'video'"));
  assert.ok(block.includes('menuExpanded = false;'));
  assert.ok(block.includes('updateStandardEditMenuVisibility(currentOrder, pendingVariantChoiceNow);'));
});

test('melodia-mea.html: deschiderea/inchiderea meniului NU sterge materialele deja selectate — doar ascunde/reafiseaza sectiunea (display:none), fara sa atinga uploadQueue sau memOrderRef.uploadedMedia', () => {
  const body = extractFunction(melodiaMea, "function updateStandardEditMenuVisibility(order, pendingVariantChoice) {");
  const idx = body.indexOf("if (order.plan === 'video') {");
  const snippet = body.slice(idx, body.length);
  assert.ok(!snippet.includes('uploadQueue = []'), 'nu trebuie sa goleasca uploadQueue la deschiderea/inchiderea meniului');
  assert.ok(!snippet.includes('uploadedMedia = []'), 'nu trebuie sa stearga materialele confirmate la deschiderea/inchiderea meniului');
  assert.ok(!snippet.includes('.abort()'), 'nu trebuie sa opreasca vreun upload activ la deschiderea/inchiderea meniului');
});

test('melodia-mea.html: dupa o regenerare REALA (ecranul de comparare), sectiunea media apare STRICT dupa alegerea versiunii finale (pendingVariantChoice)', () => {
  const body = extractFunction(melodiaMea, "function updateStandardEditMenuVisibility(order, pendingVariantChoice) {");
  const idx = body.indexOf('if (isStandardEditChoice) {');
  const end = body.indexOf('return;', idx);
  const snippet = body.slice(idx, end);
  assert.ok(snippet.includes("if (order.plan === 'video') updateMemoriesCta(order, pendingVariantChoice);"));
});

test('melodia-mea.html: updateMemoriesCta() ascunde sectiunea media STRICT cat timp pendingVariantChoice e adevarat', () => {
  const body = extractFunction(melodiaMea, 'function updateMemoriesCta(order, pendingVariantChoice) {');
  assert.ok(body.includes('if (pendingVariantChoice) {'));
  const idx = body.indexOf('if (pendingVariantChoice) {');
  const snippet = body.slice(idx, idx + 300);
  assert.ok(snippet.includes("ctaWrap.style.display = 'none';"));
  assert.ok(snippet.includes("section.style.display = 'none';"));
});

// ---------------------------------------------------------------------------------------------
// 2. CLARITATEA INCARCARII — starea "Încărcat" e confirmata STRICT server-side; thumbnail-urile
//    esuate cad pe pictograma, niciodata pe un card gol.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: lista de materiale CONFIRMATE (mem-uploaded-list) se construieste STRICT din order.uploadedMedia (confirmat de server) — nu din coada locala', () => {
  const body = extractFunction(melodiaMea, 'function renderExistingList(order) {');
  assert.ok(body.includes('const uploaded = order.uploadedMedia || [];'));
  assert.ok(!body.includes('uploadQueue'), 'lista de materiale confirmate nu trebuie sa foloseasca deloc coada locala de upload');
});

test('melodia-mea.html: thumbnail-ul care esueaza la incarcare (onerror) revine STRICT la pictograma — niciodata un card gol', () => {
  const body = extractFunction(melodiaMea, 'function renderExistingList(order) {');
  const idx = body.indexOf('[data-thumb-index]');
  const snippet = body.slice(idx, idx + 900);
  assert.ok(snippet.includes("mediaEl.addEventListener('error'"));
  assert.ok(snippet.includes('fallbackIcon'));
});

test('melodia-mea.html: coada locala de upload afiseaza STRICT cele 5 stari cerute (pending/uploading/processing/error/implicit=incarcat)', () => {
  const body = extractFunction(melodiaMea, 'function renderQueueRowInner(q) {');
  assert.ok(body.includes("q.status === 'uploading' ? t.memories_uploading_pct(q.progress)"));
  assert.ok(body.includes("q.status === 'processing' ? t.memories_processing"));
  assert.ok(body.includes("q.status === 'pending' ? t.memories_queued"));
  assert.ok(body.includes("q.status === 'error' ?"));
  assert.ok(body.includes('t.memories_uploaded'));
});

test('melodia-mea.html: un material devine "confirmat" STRICT dupa raspunsul cu succes al serverului — este eliminat din coada locala si sincronizat cu order.uploadedMedia (scheduleMemSync), niciodata marcat "Încărcat" doar local', () => {
  const body = extractFunction(melodiaMea, 'function startSingleUpload(entry) {');
  assert.ok(body.includes('uploadQueue = uploadQueue.filter(q => q.localId !== entry.localId);'));
  assert.ok(body.includes('scheduleMemSync();'));
});

// ---------------------------------------------------------------------------------------------
// 3. BUTONUL DE CREARE — apare STRICT cand toate conditiile sunt indeplinite simultan; o
//    singura apasare = un singur job.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: butonul de creare a videoclipului exista, plasat langa zona de stare video, folosind stilul existent (.btn-cta-orange)', () => {
  assert.ok(melodiaMea.includes('id="gift-video-create"'));
  assert.ok(melodiaMea.includes('id="gift-video-create-btn"'));
  const idx = melodiaMea.indexOf('id="gift-video-create"');
  const snippet = melodiaMea.slice(idx, idx + 400);
  assert.ok(snippet.includes('class="btn-cta-orange"'));
});

test('melodia-mea.html: updateVideoStatusUI() ofera butonul de creare STRICT cand nu exista niciun job activ/cerut, versiunea finala e stabilita, materialele sunt confirmate de server SI coada locala e goala', () => {
  const body = extractFunction(melodiaMea, 'function updateVideoStatusUI(order, pendingVariantChoice) {');
  assert.ok(body.includes('const jobActiveOrPending = order.videoStatus === \'generating\' || order.videoStatus === \'stale\' || order.videoStatus === \'failed\' || videoCreationInFlight;'));
  assert.ok(body.includes('if (!jobActiveOrPending) {'));
  assert.ok(body.includes('const mediaReady = !pendingVariantChoice && !!order.mediaConfirmedAt && uploadQueue.length === 0;'));
});

test('melodia-mea.html: apasarea butonului de creare foloseste un flag local (giftVideoCreateRequested) care blocheaza sincron a doua cerere — dublu-tapul nu porneste doua joburi', () => {
  const idx = melodiaMea.indexOf("document.getElementById('gift-video-create-btn').addEventListener('click'");
  assert.notEqual(idx, -1);
  const snippet = melodiaMea.slice(idx, idx + 600);
  assert.ok(snippet.includes('if (giftVideoCreateRequested) return;'));
  assert.ok(snippet.includes('giftVideoCreateRequested = true;'));
  assert.ok(snippet.includes('btn.disabled = true;'));
});

test('server.js: POST /media/confirm NU mai declanseaza automat PRIMA randare video — doar reconfirmarea unui videoclip deja existent', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/media/confirm'");
  const end = server.indexOf("app.post('/api/orders/:orderId/create-video'", idx);
  const routeSrc = server.slice(idx, end);
  assert.ok(routeSrc.includes('confirmedVariant && confirmedVariant.videoKey'), 'reconfirmarea trebuie sa declanseze randarea STRICT daca un videoclip exista deja');
  assert.ok(!/triggerVideoGeneration\(result\.order\.id, result\.order\.selectedVariantId\)\.catch/.test(routeSrc) || routeSrc.includes('confirmedVariant'), 'nu trebuie sa mai existe un apel neconditionat catre triggerVideoGeneration la simpla confirmare');
});

test('server.js: POST /create-video ramane singurul punct care porneste explicit PRIMA randare, deja idempotent (isVideoLockActive + videoKey/videoPreviewKey existente)', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/create-video'");
  const end = server.indexOf('app.get(\'/api/orders/:orderId/media/video-preview-url\'', idx);
  const routeSrc = server.slice(idx, end);
  assert.ok(routeSrc.includes('if (variant && variant.videoKey && variant.videoPreviewKey && !order.videoStaleReason) {'));
  assert.ok(routeSrc.includes('return res.json({ started: false, alreadyReady: true });'));
  assert.ok(routeSrc.includes('if (isVideoLockActive(order)) {'));
});

// ---------------------------------------------------------------------------------------------
// 4. ASOCIEREA CU MELODIA CORECTA — jobul foloseste STRICT selectedVariantId (ID stabil, nu
//    index), nicio combinare intre audio-ul unei versiuni si versurile alteia.
// ---------------------------------------------------------------------------------------------
test('server.js: triggerVideoGeneration primeste STRICT variantId (id stabil) — nu un index; generatePremiumExtras cauta varianta prin order.selectedVariantId', () => {
  assert.ok(server.includes('async function triggerVideoGeneration(orderId, variantId) {'));
  const idx = server.indexOf('async function generatePremiumExtras(orderId, options = {}) {');
  const body = server.slice(idx, idx + 800);
  assert.ok(body.includes('const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);'));
});

test('server.js: generateLyricVideo foloseste STRICT audio-ul si versurile ACELEIASI variante primite ca parametru — niciodata combinate intre versiuni', () => {
  const idx = server.indexOf('async function generateLyricVideo(order, variant, tempFullMp3Path) {');
  assert.notEqual(idx, -1);
  const body = server.slice(idx, idx + 1200);
  assert.ok(body.includes('variant.sunoTrackId'));
  assert.ok(body.includes('order.musicTaskId'));
});

test('server.js: schimbarea variantei (POST /select) marcheaza videoclipul VECHI ca depasit — niciodata nu ramane asociat gresit cu noua varianta', () => {
  assert.ok(server.includes("patch.videoStaleReason = 'variant_changed';"));
});

// ---------------------------------------------------------------------------------------------
// 5. PREVIZUALIZAREA GRATUITA DE 25s (CORECȚIE 2026-08-23, min(25s, durata totală)) — fisier
//    video REAL, taiat din videoclipul complet deja randat (acelasi montaj/materiale/melodie),
//    fara watermark/filtre/servicii noi.
// ---------------------------------------------------------------------------------------------
test('server.js: VIDEO_PREVIEW_SECONDS e definit la exact 25', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
});

test('server.js: previzualizarea se taie STRICT din videoclipul complet DEJA randat (acelasi montaj/materiale/melodie), fara reencodare (-c copy), fara filtre/watermark noi', () => {
  const idx = server.indexOf("const videoKey = `orders/full-video/${order.id}-${variant.id}.mp4`;");
  assert.notEqual(idx, -1);
  const body = server.slice(idx, idx + 1200);
  assert.ok(body.includes("execFfmpeg(['-y', '-i', tempVideo, '-t', String(VIDEO_PREVIEW_SECONDS), '-c', 'copy', tempVideoPreview]"));
  assert.ok(!/watermark|drawtext.*preview|logo/i.test(body), 'nu trebuie adaugat niciun watermark/logo nou pentru previzualizare');
});

test('server.js: previzualizarea se salveaza sub o cheie PRIVATA dedicata (orders/preview-video/), separata de videoclipul complet', () => {
  assert.ok(server.includes("videoPreviewKey = `orders/preview-video/${order.id}-${variant.id}.mp4`;"));
});

test('server.js: un esec la taierea previzualizarii NU pierde videoclipul complet deja randat (try/catch dedicat, izolat)', () => {
  const idx = server.indexOf("const tempVideoPreview = path.join(TEMP_DIR");
  const body = server.slice(idx, idx + 700);
  assert.ok(body.includes('try {'));
  assert.ok(body.includes('} catch (err) {'));
  assert.ok(body.includes('videoPreviewKey = null'));
});

// ---------------------------------------------------------------------------------------------
// 6. STAREA DE PROCESARE si PLAYERUL DE PREVIZUALIZARE — carduri existente, stari reale bazate
//    pe jobul serverului, niciodata "gata" inainte ca fisierul sa existe.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: cardul de procesare afiseaza STRICT stari reale (asteptare/creare/esec), niciodata "gata" inainte ca previzualizarea sa existe', () => {
  const body = extractFunction(melodiaMea, 'function updateVideoStatusUI(order, pendingVariantChoice) {');
  assert.ok(body.includes('gift_video_state_waiting'));
  assert.ok(body.includes('gift_video_state_creating'));
  assert.ok(body.includes('gift_video_state_failed'));
  // "ready" iese pe o ramura SEPARATA, cu return timpuriu — nu trece niciodata prin cardul de procesare.
  const readyIdx = body.indexOf("if (order.videoStatus === 'ready') {");
  const readyBlock = body.slice(readyIdx, readyIdx + 250);
  assert.ok(readyBlock.includes('return;'));
});

test('melodia-mea.html: playerul de previzualizare foloseste STRICT un URL semnat, obtinut prin accessToken-ul comenzii — niciodata videoclipul complet', () => {
  const body = extractFunction(melodiaMea, 'async function showGiftVideoPreview(order) {');
  assert.ok(body.includes('/api/orders/${orderId}/media/video-preview-url'));
  assert.ok(body.includes("headers: { 'X-Access-Token': accessToken }"));
  assert.ok(!body.includes('/media/video/'), 'nu trebuie sa faca nicio cerere catre ruta videoclipului COMPLET');
});

test('server.js: GET /media/video-preview-url e autorizat STRICT prin accessToken-ul comenzii (requireOrderToken) — nu prin order.status===\'ready\' (plata)', () => {
  const idx = server.indexOf("app.get('/api/orders/:orderId/media/video-preview-url'");
  assert.notEqual(idx, -1);
  const line = server.slice(idx, server.indexOf('\n', idx));
  assert.ok(line.includes('requireOrderToken'));
  const body = server.slice(idx, idx + 700);
  assert.ok(!body.includes("order.status !== 'ready'"), 'previzualizarea nu trebuie gatata pe plata — e STRICT gratuita, inainte de plata');
});

test('videoStatus === \'ready\' cere ambele fisiere — videoclipul complet SI previzualizarea — nu doar unul', () => {
  const idx = server.indexOf("else if (currentVariant && currentVariant.videoKey && currentVariant.videoPreviewKey) videoStatus = 'ready';");
  assert.notEqual(idx, -1, 'videoStatus trebuie sa devina \'ready\' STRICT cand ambele chei exista');
});

// ---------------------------------------------------------------------------------------------
// 7. VIDEOCLIPUL COMPLET RAMANE BLOCAT INAINTE DE PLATA — neschimbat.
// ---------------------------------------------------------------------------------------------
test('server.js: GET /media/video/:orderId ramane blocat STRICT la order.status===\'ready\' (plata confirmata server-side) — neschimbat', () => {
  const idx = server.indexOf("app.get('/media/video/:orderId'");
  const body = server.slice(idx, idx + 1500);
  assert.ok(body.includes("if (order.status !== 'ready') return res.status(403).send('Videoclipul se deblochează după plată');"));
});

test('server.js: checkout-ul ramane gatat pe videoKey (videoclipul complet), neschimbat de adaugarea previzualizarii', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/checkout'");
  const end = server.indexOf('const checkoutGuard = await credits.evaluateGuard', idx);
  const body = server.slice(idx, end);
  assert.ok(body.includes('if (!videoVariant || !videoVariant.videoKey) {'));
});

test('server.js: plata e confirmata STRICT server-side (webhook Stripe), niciodata pe baza revenirii clientului din pagina de plata — neschimbat', () => {
  assert.ok(server.includes("app.post('/api/webhook'") || server.includes('webhook'));
  assert.ok(server.includes('recordPaidOrderAtomically'));
});

// ---------------------------------------------------------------------------------------------
// 8. COMPATIBILITATEA COMENZILOR VECHI — o comanda cu videoKey dar fara videoPreviewKey
//    (dinainte de aceasta relansare) se completeaza automat, fara sa piarda materialele.
// ---------------------------------------------------------------------------------------------
test('server.js: generatePremiumExtras re-randeaza pentru o comanda veche cu videoKey dar FARA videoPreviewKey — completeaza previzualizarea lipsa, fara sa oblige un upload nou', () => {
  assert.ok(server.includes("if (order.plan === 'video' && forceVideo && (!variant.videoKey || !variant.videoPreviewKey)) {"));
});

test('server.js: nicio migrare distructiva sau stergere in masa a materialelor/obiectelor R2 nu a fost adaugata', () => {
  assert.ok(!/DeleteObjects|deleteAllMedia|migrateUploadedMedia|\bTRUNCATE TABLE\b/.test(server));
});

// ---------------------------------------------------------------------------------------------
// 9. Cele 8 limbi — toate textele noi.
// ---------------------------------------------------------------------------------------------
const NEW_KEYS = [
  'gift_video_create_btn', 'gift_video_create_sub', 'gift_video_processing_title',
  'gift_video_processing_text', 'gift_video_state_waiting', 'gift_video_state_creating',
  'gift_video_state_failed', 'gift_video_preview_title', 'gift_video_preview_badge',
  'gift_video_preview_text'
];
for (const key of NEW_KEYS) {
  test(`melodia-mea.html: cheia "${key}" exista in toate cele 8 limbi`, () => {
    const occurrences = (melodiaMea.match(new RegExp(key + ':', 'g')) || []).length;
    assert.equal(occurrences, 8, `cheia "${key}" trebuie sa apara exact 8 ori, gasita de ${occurrences} ori`);
  });
}

test('melodia-mea.html: textul romana al noilor chei e exact cel cerut', () => {
  assert.ok(melodiaMea.includes("gift_video_create_btn: 'Creează videoclipul meu cadou',"));
  assert.ok(melodiaMea.includes("gift_video_create_sub: 'Vom transforma amintirile tale într-un videoclip sincronizat cu melodia aleasă.',"));
  assert.ok(melodiaMea.includes("gift_video_processing_title: 'Îți pregătim videoclipul cadou',"));
  assert.ok(melodiaMea.includes("gift_video_preview_title: 'Previzualizarea videoclipului tău cadou',"));
  assert.ok(melodiaMea.includes("gift_video_preview_badge: '25 de secunde gratuite',"));
});

// ---------------------------------------------------------------------------------------------
// 10. Standard si Premium raman complet neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta runda', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

test('melodia-mea.html: fluxul Premium (renderPremiumFlow) ramane complet separat si neatins', () => {
  assert.ok(melodiaMea.includes('function renderPremiumFlow(order, isResumeFlag) {'));
});

test('melodia-mea.html: uploadul multipart direct catre R2 (Round 6) ramane neschimbat — nu e cauza demonstrata a acestei runde', () => {
  assert.ok(melodiaMea.includes('async function startMultipartUpload(entry) {'));
  assert.ok(melodiaMea.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
});

test('storage.js: functiile multipart/CORS raman neschimbate', () => {
  const storage = read('storage.js');
  assert.ok(storage.includes('async function createPrivateMultipartUpload('));
  assert.ok(storage.includes('async function checkUploadCors('));
});

// ---------------------------------------------------------------------------------------------
// 11. Sintaxa ramane valida.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: ramane sintactic valid dupa Runda 11', () => {
  const scripts = [...melodiaMea.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach(m => { new Function(m[1]); });
});

test('server.js: ramane sintactic valid dupa Runda 11', () => {
  require('node:child_process').execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
});
