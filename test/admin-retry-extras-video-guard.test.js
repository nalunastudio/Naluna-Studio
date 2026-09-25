// Admin "Retry Extras" — garda specifica planului Video (2026-09-25, investigatie separata,
// aprobata explicit). AUDIT read-only premergator, pe productie (STRICT non-PII): 20 comenzi Video
// cu status ready/preview_ready aveau toate butonul "Retry Extras" afisat — dar 13/20 aveau deja un
// videoclip COMPLET (videoKey + videoPreviewKey), 5/20 nici nu ajunsesera la confirmarea
// materialelor (video niciodata cerut). Root cause: atat getOrderRowActions() (private/admin/
// orders.js) cat si guard-ul din POST .../retry-extras (server.js) verificau STRICT plan+status,
// fara sa verifice vreo stare reala a video-ului — butonul aparea generic pentru orice comanda
// Video in ready/preview_ready, indiferent daca era ceva de reincercat.
//
// Risc real confirmat separat: triggerVideoGeneration() -> db.enqueueVideoRenderJob() NU verifica
// daca exista deja un videoclip complet inainte sa puna un job nou in coada (protejeaza STRICT
// impotriva unui job 'pending'/'claimed' duplicat, nu impotriva unuia deja 'done') — fara o garda
// explicita, apasarea butonului pe o comanda deja livrata ar fi declansat o re-randare reala,
// costisitoare, a unui videoclip deja bun.
//
// Fix: "video are nevoie de retry" = mediaConfirmedAt exista (altfel video nici n-a fost cerut
// vreodata) SI varianta selectata NU are AMBELE chei (videoKey + videoPreviewKey). Protectia exista
// ACUM in ambele straturi — UI (isVideoRetryNeeded(), private/admin/orders.js) SI backend (garda
// explicita in POST .../retry-extras, server.js) — backend-ul NU se bazeaza NICIODATA doar pe UI.
//
// NU s-a atins: Premium (poarta de plata ramane EXACT cea din corectia anterioara, vezi
// test/admin-retry-extras-payment-gate.test.js), mecanismul de retry al CLIENTULUI (videoStatus
// 'failed' pe melodia-mea.html, complet separat de acest endpoint admin), Stripe/checkout/plati,
// generarea audio, lyrics/coherence, Meta Pixel/CAPI/GA4/consent/funnel/social, Meta Ads Faza A/B.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ================================================================================================
// Extragere TEXTUALA (acelasi tipar ca test/admin-retry-extras-payment-gate.test.js).
// ================================================================================================
function extractGetOrderRowActions() {
  const helperRe = /function isVideoRetryNeeded\(order\) \{[\s\S]*?\n\}/;
  const helperMatch = ordersSrc.match(helperRe);
  assert.ok(helperMatch, 'isVideoRetryNeeded lipseste sau s-a schimbat structural in orders.js');
  const re = /function getOrderRowActions\(order\) \{[\s\S]*?\n\}/;
  const match = ordersSrc.match(re);
  assert.ok(match, 'getOrderRowActions lipseste sau s-a schimbat structural in orders.js');
  const wrapperSrc = `(function () {\n${helperMatch[0]}\n${match[0]}\nreturn getOrderRowActions;\n})`;
  return new Function('return ' + wrapperSrc)()();
}

function extractIsVideoRetryNeeded() {
  const helperRe = /function isVideoRetryNeeded\(order\) \{[\s\S]*?\n\}/;
  const helperMatch = ordersSrc.match(helperRe);
  assert.ok(helperMatch);
  const wrapperSrc = `(function () {\n${helperMatch[0]}\nreturn isVideoRetryNeeded;\n})`;
  return new Function('return ' + wrapperSrc)()();
}

// Simuleaza EXACT guard-ul backend din POST .../retry-extras pentru ramura video (extras din sursa
// reala, verificat structural mai jos ca textul exista neschimbat) — nu poate executa Express
// direct (fara Postgres/server real), deci reproduce logica STRICT pentru a o testa determinist,
// cu asertiuni STRUCTURALE separate care confirma ca sursa reala contine exact aceste linii.
function simulateBackendVideoGuard(order) {
  const extrasEligible = order.status === 'ready' || (order.status === 'preview_ready' && (order.plan === 'video' || !!order.paidAt));
  if (!extrasEligible) return { status: 400, error: 'Comanda nu e încă plătită.', enqueued: false };
  if (order.plan === 'video' && order.selectedVariantId) {
    if (!order.mediaConfirmedAt) {
      return { status: 400, error: 'Materialele video nu au fost confirmate încă — nu există niciun videoclip de reîncercat.', enqueued: false };
    }
    const videoVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    if (videoVariant && videoVariant.videoKey && videoVariant.videoPreviewKey) {
      return { status: 400, error: 'Videoclipul este deja complet — nu necesită reîncercare.', enqueued: false };
    }
    return { status: 200, enqueued: true };
  }
  return { status: 200, enqueued: false, calledGeneratePremiumExtras: true };
}

function videoOrder(overrides) {
  return Object.assign({
    plan: 'video', status: 'preview_ready', paidAt: null,
    selectedVariantId: 'v1', variants: [{ id: 'v1', videoKey: null, videoPreviewKey: null }]
  }, overrides);
}

// ================================================================================================
// UI — isVideoRetryNeeded() izolat.
// ================================================================================================
test('isVideoRetryNeeded: media neconfirmata -> false, indiferent de starea video-ului', () => {
  const isVideoRetryNeeded = extractIsVideoRetryNeeded();
  assert.equal(isVideoRetryNeeded({ mediaConfirmedAt: null, selectedVariantId: 'v1', variants: [{ id: 'v1' }] }), false);
});

test('isVideoRetryNeeded: media confirmata, video COMPLET (ambele chei) -> false', () => {
  const isVideoRetryNeeded = extractIsVideoRetryNeeded();
  assert.equal(isVideoRetryNeeded({ mediaConfirmedAt: '2026-09-20T10:00:00.000Z', selectedVariantId: 'v1', variants: [{ id: 'v1', videoKey: 'k', videoPreviewKey: 'p' }] }), false);
});

test('isVideoRetryNeeded: media confirmata, DOAR videoKey (fara videoPreviewKey — cerinta veche, dinainte de preview-ul gratuit) -> true (incomplet)', () => {
  const isVideoRetryNeeded = extractIsVideoRetryNeeded();
  assert.equal(isVideoRetryNeeded({ mediaConfirmedAt: '2026-09-20T10:00:00.000Z', selectedVariantId: 'v1', variants: [{ id: 'v1', videoKey: 'k', videoPreviewKey: null }] }), true);
});

test('isVideoRetryNeeded: media confirmata, nicio cheie (video niciodata generat sau esuat) -> true', () => {
  const isVideoRetryNeeded = extractIsVideoRetryNeeded();
  assert.equal(isVideoRetryNeeded({ mediaConfirmedAt: '2026-09-20T10:00:00.000Z', selectedVariantId: 'v1', variants: [{ id: 'v1', videoKey: null, videoPreviewKey: null }] }), true);
});

test('isVideoRetryNeeded: varianta selectata nu se gaseste in array -> false (nimic de reincercat pentru o varianta inexistenta)', () => {
  const isVideoRetryNeeded = extractIsVideoRetryNeeded();
  assert.equal(isVideoRetryNeeded({ mediaConfirmedAt: '2026-09-20T10:00:00.000Z', selectedVariantId: 'v-missing', variants: [{ id: 'v1' }] }), false);
});

// ================================================================================================
// UI — getOrderRowActions() end-to-end, cele 4 scenarii cerute explicit.
// ================================================================================================
test('1) preview_ready + media NECONFIRMATA -> FARA Retry Extras', () => {
  const getOrderRowActions = extractGetOrderRowActions();
  const order = videoOrder({ status: 'preview_ready', mediaConfirmedAt: null });
  const actions = getOrderRowActions(order);
  assert.ok(!actions.some(a => a.id === 'retry-extras'));
});

test('2) preview_ready + media CONFIRMATA + video COMPLET -> FARA Retry Extras', () => {
  const getOrderRowActions = extractGetOrderRowActions();
  const order = videoOrder({
    status: 'preview_ready', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: 'key', videoPreviewKey: 'preview' }]
  });
  const actions = getOrderRowActions(order);
  assert.ok(!actions.some(a => a.id === 'retry-extras'));
});

test('3) ready + video COMPLET -> FARA Retry Extras', () => {
  const getOrderRowActions = extractGetOrderRowActions();
  const order = videoOrder({
    status: 'ready', paidAt: '2026-09-20T10:00:00.000Z', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: 'key', videoPreviewKey: 'preview' }]
  });
  const actions = getOrderRowActions(order);
  assert.ok(!actions.some(a => a.id === 'retry-extras'));
});

test('4) preview_ready + media CONFIRMATA + video INCOMPLET/ESUAT -> Retry Extras DISPONIBIL', () => {
  const getOrderRowActions = extractGetOrderRowActions();
  const order = videoOrder({
    status: 'preview_ready', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: null, videoPreviewKey: null, videoFailedReason: 'Randarea a esuat.' }]
  });
  const actions = getOrderRowActions(order);
  assert.ok(actions.some(a => a.id === 'retry-extras'));
});

// ================================================================================================
// BACKEND — aceleasi 4 scenarii, plus confirmarea explicita ca refuzurile NU pun niciun job in coada.
// ================================================================================================
test('backend refuza retry daca media NECONFIRMATA (400, niciun job enqueued)', () => {
  const order = videoOrder({ status: 'preview_ready', mediaConfirmedAt: null });
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 400);
  assert.equal(result.enqueued, false);
});

test('backend refuza retry daca video COMPLET (400, niciun job enqueued)', () => {
  const order = videoOrder({
    status: 'preview_ready', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: 'key', videoPreviewKey: 'preview' }]
  });
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 400);
  assert.equal(result.enqueued, false);
});

test('backend refuza retry daca video COMPLET, chiar cu status "ready" si comanda platita (400, niciun job enqueued)', () => {
  const order = videoOrder({
    status: 'ready', paidAt: '2026-09-20T10:00:00.000Z', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: 'key', videoPreviewKey: 'preview' }]
  });
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 400);
  assert.equal(result.enqueued, false);
});

test('backend PERMITE retry daca media confirmata SI video incomplet/esuat (job enqueued)', () => {
  const order = videoOrder({
    status: 'preview_ready', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: null, videoPreviewKey: null, videoFailedReason: 'Randarea a esuat.' }]
  });
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 200);
  assert.equal(result.enqueued, true);
});

test('backend PERMITE retry daca DOAR videoKey exista (fara videoPreviewKey) — inca incomplet', () => {
  const order = videoOrder({
    status: 'preview_ready', mediaConfirmedAt: '2026-09-20T10:00:00.000Z',
    variants: [{ id: 'v1', videoKey: 'key', videoPreviewKey: null }]
  });
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 200);
  assert.equal(result.enqueued, true);
});

// ================================================================================================
// Confirmare STRUCTURALA — logica simulata mai sus corespunde EXACT sursei reale din server.js
// (nu doar o presupunere despre cum s-ar comporta).
// ================================================================================================
test('server.js: garda de video (mediaConfirmedAt + videoKey/videoPreviewKey) exista STRICT in ramura video, INAINTE de triggerVideoGeneration', () => {
  const idx = serverSrc.indexOf("app.post('/api/admin/orders/:orderId/retry-extras'");
  assert.ok(idx !== -1);
  const end = serverSrc.indexOf('\n});', idx);
  const block = serverSrc.slice(idx, end);
  const videoBranchIdx = block.indexOf("if (order.plan === 'video' && order.selectedVariantId) {");
  assert.ok(videoBranchIdx !== -1);
  const videoBranchEnd = block.indexOf('} else {', videoBranchIdx);
  const videoBranch = block.slice(videoBranchIdx, videoBranchEnd);

  assert.match(videoBranch, /if \(!order\.mediaConfirmedAt\) \{\s*return res\.status\(400\)/);
  assert.match(videoBranch, /videoVariant\.videoKey && videoVariant\.videoPreviewKey/);

  const mediaGuardIdx = videoBranch.indexOf('if (!order.mediaConfirmedAt)');
  const videoCompleteGuardIdx = videoBranch.indexOf('videoVariant.videoKey && videoVariant.videoPreviewKey');
  const triggerIdx = videoBranch.indexOf('await triggerVideoGeneration(order.id, order.selectedVariantId);');
  assert.ok(mediaGuardIdx !== -1 && videoCompleteGuardIdx !== -1 && triggerIdx !== -1);
  assert.ok(mediaGuardIdx < videoCompleteGuardIdx, 'garda de media neconfirmata trebuie sa vina INAINTE de cea de video complet');
  assert.ok(videoCompleteGuardIdx < triggerIdx, 'ambele garzi trebuie sa vina INAINTE de triggerVideoGeneration');
});

test('server.js: ramura ELSE (Premium, generatePremiumExtras) ramane STRICT neatinsa — nicio garda noua acolo', () => {
  const idx = serverSrc.indexOf("app.post('/api/admin/orders/:orderId/retry-extras'");
  const end = serverSrc.indexOf('\n});', idx);
  const block = serverSrc.slice(idx, end);
  const elseIdx = block.indexOf('} else {');
  const elseEnd = block.indexOf('const fresh = await db.getOrderById', elseIdx);
  assert.ok(elseIdx !== -1 && elseEnd !== -1);
  const elseBranch = block.slice(elseIdx, elseEnd);
  assert.match(elseBranch, /await generatePremiumExtras\(req\.params\.orderId, \{ forceVideo: false \}\);/);
  assert.ok(!/mediaConfirmedAt/.test(elseBranch), 'ramura Premium nu trebuie sa capete nicio verificare de mediaConfirmedAt');
});

// ================================================================================================
// PREMIUM — comportamentul existent ramane complet neschimbat (regresie directa).
// ================================================================================================
test('PREMIUM: getOrderRowActions ramane neschimbat — isVideoRetryNeeded nu se aplica NICIODATA planului premium', () => {
  const getOrderRowActions = extractGetOrderRowActions();
  const paidPremiumNoVideoFields = { plan: 'premium', status: 'ready', paidAt: '2026-09-20T10:00:00.000Z' };
  const actions = getOrderRowActions(paidPremiumNoVideoFields);
  assert.ok(actions.some(a => a.id === 'retry-extras'), 'premium platit ramane eligibil chiar FARA campuri de video (mediaConfirmedAt/variants) — isVideoRetryNeeded nu trebuie evaluat pentru premium');
});

test('PREMIUM: backend ramane neschimbat — garda de video nu se aplica planului premium', () => {
  const order = { plan: 'premium', status: 'ready', paidAt: '2026-09-20T10:00:00.000Z', selectedVariantId: 'v1' };
  const result = simulateBackendVideoGuard(order);
  assert.equal(result.status, 200);
  assert.equal(result.calledGeneratePremiumExtras, true);
});

test('server.js si private/admin/orders.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});
