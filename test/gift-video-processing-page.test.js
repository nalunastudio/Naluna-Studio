// Teste pentru CORECȚIA 2026-08-24 — "cauza reala pentru care clientul ramane la Se creează
// videoclipul": (1) POST /create-video asteapta rezervarea atomica (claimVideoRenderForOrder)
// INAINTE de a raspunde, nu doar fire-and-forget dupa res.json(); (2) butonul de creare din
// melodia-mea.html verifica STRICT res.ok/status inainte sa navigheze, si reseteaza starea la
// eroare (nu mai ramane blocat cu videoCreationInFlight=true la nesfarsit); (3) pollingul
// (refreshVideoStatusOnly) nu se mai opreste definitiv la o singura eroare de retea — reincearca
// cu backoff; (4) previzualizarea video (showGiftVideoPreview) si auto-confirmarea materialelor
// (maybeAutoConfirmMedia) reincearca si ele, in loc sa esueze silentios si definitiv; (5) pagina
// dedicata de procesare (se-creeaza-video.html) exista, deriva starea de pe server si e tradusa
// in toate cele 8 limbi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const melodia = read('public/melodia-mea.html');
const processingPage = read('public/se-creeaza-video.html');
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): butonul
// "Creează videoclipul meu cadou" si maybeAutoConfirmMedia() au fost MUTATE din melodia-mea.html
// in public/amintiri-video.html — retargetat STRICT aceasta pagina; butonul Retry (job
// videoStatus=failed) ramane in melodia-mea.html (parte din mesajul de stare video, neatins).
const amintiriVideo = read('public/amintiri-video.html');

// ---------------------------------------------------------------------------------------------
// 1) server.js — rezervarea (claim) e separata de randare si ASTEPTATA inainte de raspuns.
// ---------------------------------------------------------------------------------------------
test('server.js: claimVideoRenderForOrder si runVideoRenderJob exista ca functii SEPARATE (faza de rezervare, distincta de randarea propriu-zisa)', () => {
  assert.match(server, /async function claimVideoRenderForOrder\(orderId, variantId\) \{/);
  assert.match(server, /async function runVideoRenderJob\(orderId, variantId, mediaRevisionAtStart\) \{/);
});

test('server.js: triggerVideoGeneration (folosit de apelantii fire-and-forget, ex. finalizeVariantsIfNeeded) compune STRICT cele doua faze de mai sus, neschimbat functional', () => {
  const idx = server.indexOf('async function triggerVideoGeneration(orderId, variantId) {');
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 300);
  assert.match(snippet, /const claim = await claimVideoRenderForOrder\(orderId, variantId\);/);
  assert.match(snippet, /if \(!claim\) return;/);
  assert.match(snippet, /await runVideoRenderJob\(orderId, variantId, claim\.mediaRevisionAtStart\);/);
});

test('server.js: POST /create-video ASTEAPTA (await) claimVideoRenderForOrder INAINTE de res.json({ started: true }) — clientul nu mai poate primi "started" fara ca lock-ul sa fie deja scris', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/create-video'");
  assert.ok(idx !== -1);
  const snippet = server.slice(idx, idx + 3000);
  const claimIdx = snippet.indexOf('const claim = await claimVideoRenderForOrder(order.id, order.selectedVariantId);');
  const respondIdx = snippet.indexOf('res.json({ started: true });');
  assert.ok(claimIdx !== -1, 'lipseste asteptarea rezervarii in POST /create-video');
  assert.ok(respondIdx !== -1, 'lipseste raspunsul de succes in POST /create-video');
  assert.ok(claimIdx < respondIdx, 'rezervarea trebuie asteptata STRICT inainte de raspunsul de succes, nu dupa');
  assert.match(snippet, /if \(!claim\) \{\s*return res\.status\(409\)/, 'daca rezervarea esueaza (job deja activ, cursa cu alta cerere), raspunsul trebuie sa fie 409, nu "started: true"');
});

test('server.js: randarea propriu-zisa (runVideoRenderJob) ramane fire-and-forget DUPA raspunsul HTTP — nu blocheaza cererea clientului cu durata reala a randarii (poate dura minute)', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/create-video'");
  const snippet = server.slice(idx, idx + 3000);
  assert.match(snippet, /res\.json\(\{ started: true \}\);\s*runVideoRenderJob\(order\.id, order\.selectedVariantId, claim\.mediaRevisionAtStart\)\.catch\(/);
});

// ---------------------------------------------------------------------------------------------
// 2) melodia-mea.html — butonul de creare verifica raspunsul, nu mai ramane blocat la eroare.
// ---------------------------------------------------------------------------------------------
test('amintiri-video.html: click pe gift-video-create-btn verifica res.ok SAU res.status===409 inainte sa navigheze catre pagina dedicata — orice alt raspuns (sau eroare de retea) ramane pe pagina curenta', () => {
  const idx = amintiriVideo.indexOf("document.getElementById('gift-video-create-btn').addEventListener('click'");
  assert.ok(idx !== -1);
  const snippet = amintiriVideo.slice(idx, idx + 1800);
  assert.match(snippet, /if \(res && \(res\.ok \|\| res\.status === 409\)\) \{/);
  assert.match(snippet, /window\.location\.href = `\/se-creeaza-video\.html\?id=\$\{encodeURIComponent\(orderId\)\}&token=\$\{encodeURIComponent\(accessToken\)\}`;/);
});

test('amintiri-video.html: la eroare (raspuns non-ok/non-409 SAU eroare de retea), butonul de creare e reactivat si mesajul de eroare tradus e afisat', () => {
  const idx = amintiriVideo.indexOf("document.getElementById('gift-video-create-btn').addEventListener('click'");
  const snippet = amintiriVideo.slice(idx, idx + 2200);
  assert.match(snippet, /errEl\.textContent = t\.msg_error_prefix \+ message;/);
  assert.match(snippet, /btn\.disabled = false;/);
  assert.match(snippet, /giftVideoCreateRequested = false;/);
});

test('melodia-mea.html: butonul Retry (job videoStatus=failed) foloseste ACELASI tipar — res.ok/409 -> navigheaza, altfel ramane pe loc cu butonul reactivat', () => {
  // A DOUA aparitie in fisier — prima e retry-ul (fara legatura) al unui upload esuat din
  // coada de materiale (vezi wireQueueRow), NU butonul de creare video.
  const idx = melodia.lastIndexOf("retryBtn.addEventListener('click'");
  assert.ok(idx !== -1);
  const snippet = melodia.slice(idx, idx + 900);
  assert.match(snippet, /if \(res && \(res\.ok \|\| res\.status === 409\)\) \{/);
  assert.match(snippet, /window\.location\.href = `\/se-creeaza-video\.html\?id=/);
  assert.match(snippet, /retryBtn\.disabled = false;/);
});

test('amintiri-video.html: dublul-click ramane prevenit — giftVideoCreateRequested se verifica la primul rand al handler-ului, inainte de orice cerere de retea', () => {
  const idx = amintiriVideo.indexOf("document.getElementById('gift-video-create-btn').addEventListener('click'");
  const snippet = amintiriVideo.slice(idx, idx + 200);
  assert.match(snippet, /if \(giftVideoCreateRequested\) return;\s*giftVideoCreateRequested = true;/);
});

// ---------------------------------------------------------------------------------------------
// 3) melodia-mea.html — pollingul nu mai moare la o singura eroare de retea (backoff).
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: refreshVideoStatusOnly() re-arma bucla de polling (cu backoff) SI pe raspuns non-ok SI pe eroare de retea — niciun drum din functie nu lasa polling-ul oprit definitiv', () => {
  const idx = melodia.indexOf('async function refreshVideoStatusOnly() {');
  assert.ok(idx !== -1);
  const snippet = melodia.slice(idx, idx + 1500);
  assert.match(snippet, /if \(!res\.ok\) \{ videoPollFailCount\+\+; armVideoPoll\(Math\.min\(5000 \* videoPollFailCount, 30000\)\); return; \}/);
  assert.match(snippet, /catch \(e\) \{\s*videoPollFailCount\+\+;\s*armVideoPoll\(Math\.min\(5000 \* videoPollFailCount, 30000\)\);\s*\}/);
});

test('melodia-mea.html: videoPollFailCount se reseteaza la 0 dupa un raspuns reusit (backoff nu ramane permanent ridicat dupa ce conexiunea revine)', () => {
  const idx = melodia.indexOf('async function refreshVideoStatusOnly() {');
  const snippet = melodia.slice(idx, idx + 900);
  assert.match(snippet, /videoPollFailCount = 0;/);
});

// ---------------------------------------------------------------------------------------------
// 4) melodia-mea.html — previzualizarea video si auto-confirmarea materialelor reincearca.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: showGiftVideoPreview() reincearca (backoff, plafonat la un numar maxim) daca URL-ul semnat esueaza sau lipseste, in loc sa renunte definitiv', () => {
  assert.match(melodia, /function scheduleGiftVideoPreviewRetry\(order\) \{/);
  assert.match(melodia, /const GIFT_VIDEO_PREVIEW_MAX_RETRIES = 6;/);
  const idx = melodia.indexOf('async function showGiftVideoPreview(order) {');
  const snippet = melodia.slice(idx, idx + 1600);
  assert.match(snippet, /if \(!res\.ok\) \{ scheduleGiftVideoPreviewRetry\(order\); return; \}/);
  assert.match(snippet, /if \(!data\.url\) \{ scheduleGiftVideoPreviewRetry\(order\); return; \}/);
  assert.match(snippet, /catch \(e\) \{ scheduleGiftVideoPreviewRetry\(order\); \}/);
});

test('amintiri-video.html: maybeAutoConfirmMedia() reincearca (backoff, plafonat) daca POST /media/confirm esueaza, in loc sa astepte tacit o schimbare ulterioara a materialelor', () => {
  assert.match(amintiriVideo, /const MEDIA_CONFIRM_MAX_RETRIES = 6;/);
  const idx = amintiriVideo.indexOf('async function maybeAutoConfirmMedia(order, gateOk) {');
  const snippet = amintiriVideo.slice(idx, idx + 1600);
  assert.match(snippet, /mediaConfirmRetryTimer = setTimeout\(\(\) => \{ mediaConfirmRetryTimer = null; maybeAutoConfirmMedia\(order, gateOk\); \},/);
});

// ---------------------------------------------------------------------------------------------
// 5) se-creeaza-video.html — pagina dedicata exista, deriva starea reala, tradusa in 8 limbi.
// ---------------------------------------------------------------------------------------------
test('se-creeaza-video.html: exista si citeste orderId/token STRICT din URL (acelasi tipar ca se-compune.html/melodia-mea.html)', () => {
  assert.match(processingPage, /const orderId = params\.get\('id'\);/);
  assert.match(processingPage, /const accessToken = params\.get\('token'\) \|\| localStorage\.getItem\('nds_access_token'\) \|\| '';/);
});

test('se-creeaza-video.html: NU porneste niciun job la incarcare — doar citeste starea reala prin GET /api/orders/:id (acelasi endpoint existent, niciun endpoint nou)', () => {
  assert.ok(!processingPage.includes("method: 'POST'") || processingPage.includes("/create-video"), 'singurul POST admis pe aceasta pagina e retry-ul explicit catre /create-video');
  assert.match(processingPage, /fetch\(`\/api\/orders\/\$\{encodeURIComponent\(orderId\)\}\?token=\$\{encodeURIComponent\(accessToken\)\}`\)/);
});

test('se-creeaza-video.html: starea terminala "ready" duce la redirect catre melodia-mea.html (unde traiesc deja preview-ul si checkout-ul) — nicio duplicare a acelei logici pe pagina noua', () => {
  assert.match(processingPage, /if \(order\.videoStatus === 'ready'\) \{\s*finishSuccess\(\);/);
  assert.match(processingPage, /window\.location\.href = `\/melodia-mea\.html\?id=\$\{encodeURIComponent\(orderId\)\}&token=\$\{encodeURIComponent\(accessToken\)\}`;/);
});

test('se-creeaza-video.html: starea terminala "failed" afiseaza eroare clara si Retry, fara sa porneasca automat o noua randare', () => {
  assert.match(processingPage, /if \(order\.videoStatus === 'failed'\) \{\s*handleFailed\(\);/);
  assert.match(processingPage, /function handleFailed\(\) \{/);
});

test('se-creeaza-video.html: Retry trateaza 200\\/202 SI 409 (job deja activ) ca succes — idempotent, fara joburi duplicate', () => {
  const idx = processingPage.indexOf("retryBtn.addEventListener('click'");
  assert.ok(idx !== -1);
  const snippet = processingPage.slice(idx, idx + 700);
  assert.match(snippet, /if \(!res \|\| \(!res\.ok && res\.status !== 409\)\) \{/);
});

test('se-creeaza-video.html: pollingul foloseste backoff (nu un interval fix) si nu se opreste definitiv la o eroare tranzitorie', () => {
  assert.match(processingPage, /function nextPollDelay\(\) \{\s*return Math\.min\(5000 \* Math\.max\(1, consecutivePollFailures\), 20000\);\s*\}/);
  const idx = processingPage.indexOf('async function pollStatus() {');
  const snippet = processingPage.slice(idx, idx + 2600);
  const catchIdx = snippet.lastIndexOf('} catch (err) {');
  assert.ok(catchIdx !== -1);
  const catchBody = snippet.slice(catchIdx, catchIdx + 200);
  assert.match(catchBody, /pollTimer = setTimeout\(pollStatus, nextPollDelay\(\)\);/);
});

test('se-creeaza-video.html: revenirea din fundal pe iPhone (visibilitychange/pageshow) forteaza o verificare imediata a starii, acelasi hotfix mostenit din se-compune.html', () => {
  assert.match(processingPage, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!document\.hidden\) forceImmediatePoll\(\);/);
  assert.match(processingPage, /window\.addEventListener\('pageshow', \(event\) => \{\s*if \(event\.persisted\) forceImmediatePoll\(\);/);
});

test('se-creeaza-video.html: NU afiseaza niciun procent numeric de progres (nicio metrica reala expusa de server pentru randarea video) — doar eticheta etapei curente, ca sa nu inventeze cifre', () => {
  assert.ok(!processingPage.includes('order.generationPhasePercent'), 'pagina video nu trebuie sa citeasca procentul melodiei (concept diferit, nerelevant aici) din raspunsul serverului');
  assert.ok(!processingPage.includes("+ '%'"), 'nu trebuie construit niciun text de forma "N%" pe aceasta pagina');
  assert.ok(!processingPage.includes('progressFill.style.width'), 'latimea barei nu trebuie controlata explicit pe baza unui procent — ramane STRICT nedeterminata pana la starea finala "ready"');
  assert.match(processingPage, /progressFill\.classList\.add\('done'\);/, 'bara trece la starea finala vizuala STRICT la "ready", niciodata pe baza unui procent inventat');
});

test('se-creeaza-video.html: nu foloseste niciodata cuvantul "30 de secunde" (previzualizarea video ramane min(25s, durata reala), consecvent cu restul aplicatiei)', () => {
  assert.ok(!processingPage.includes('30 de secunde'));
  assert.ok(!processingPage.includes('30 seconds'));
});

[
  'title', 'subtitle', 'staleTitle', 'staleSubtitle', 'keepOpen', 'readyMsg', 'readySub',
  'softNotice', 'longTitle', 'longSub', 'errTitle', 'errSub', 'retryBtn', 'retrying'
].forEach(key => {
  test(`se-creeaza-video.html: cheia de traducere "${key}" exista in toate cele 8 limbi (ro/en/de/es/it/fr/bg/tr)`, () => {
    const re = new RegExp(`[{,]\\s*${key}:`, 'g');
    const count = (processingPage.match(re) || []).length;
    assert.equal(count, 8, `"${key}" trebuie sa existe o data per limba, gasita de ${count} ori`);
  });
});

test('se-creeaza-video.html: lista "stages" (etapele reale afisate rotativ) exista pentru toate cele 8 limbi, cu exact 5 etape fiecare', () => {
  const matches = [...processingPage.matchAll(/stages: \[([\s\S]*?)\]/g)];
  assert.equal(matches.length, 8, `trebuie sa existe cate o lista "stages" per limba, gasite ${matches.length}`);
  matches.forEach((m, i) => {
    // Numara literalii string individuali (unele limbi folosesc ghilimele duble cand textul
    // contine un apostrof, ex. "Finalizziamo l'anteprima...") — nu doar caracterele ' brute.
    const items = (m[1].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || []).length;
    assert.equal(items, 5, `lista "stages" #${i} trebuie sa aiba exact 5 etape, gasite ${items}`);
  });
});

test('se-creeaza-video.html: ramane sintactic valid JavaScript (fara erori introduse)', () => {
  const scripts = [...processingPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

// ---------------------------------------------------------------------------------------------
// 6) Regresie — traducerea existenta a badge-ului "25 de secunde" (fostul "30") propagata corect.
// ---------------------------------------------------------------------------------------------
[
  'gift_video_preview_badge: \'25 de secunde gratuite\'',
  'gift_video_preview_badge: \'25 seconds free\'',
  'gift_video_preview_badge: \'25 Sekunden gratis\'',
  'gift_video_preview_badge: \'25 segundos gratis\'',
  'gift_video_preview_badge: \'25 secondi gratis\'',
  'gift_video_preview_badge: \'25 secondes gratuites\'',
  'gift_video_preview_badge: \'25 безплатни секунди\'',
  'gift_video_preview_badge: \'25 saniye ücretsiz\''
].forEach(expected => {
  test(`melodia-mea.html: badge-ul de previzualizare video a fost actualizat la 25 de secunde — "${expected}"`, () => {
    assert.ok(melodia.includes(expected), `lipseste textul actualizat: ${expected}`);
  });
});

test('server.js: VIDEO_PREVIEW_SECONDS = 25 (previzualizarea video, DISTINCTA de PREVIEW_SECONDS = 40 al previzualizarii audio, care ramane neschimbata)', () => {
  assert.match(server, /const VIDEO_PREVIEW_SECONDS = 25;/);
  assert.match(server, /const PREVIEW_SECONDS = 40;/);
});

test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
