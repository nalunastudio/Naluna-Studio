// "CONTINUA CU ACEASTA COMANDA" (2026-09-28, cerinta explicita) — clientul verificase deja manual
// in productie ca "Comenzile mele" functioneaza corect (gaseste comenzile prin email, arata cele
// N comenzi Premium, fiecare cu previzualizarile ei, audio se asculta, quota/listarea merg) —
// problema ramasa era STRICT continuarea unei comenzi existente. Acest fisier testeaza:
//   - rezolvarea server-side a pasului urmator real (resolveOrderResumeStage/resumeUrlFor),
//     NICIODATA reguli aproximative gen "Premium + 4 melodii -> selectie";
//   - noul credential de continuare (buildResumeToken/isValidOrderCredential) — STATELESS,
//     interschimbabil cu accessToken-ul real DOAR pentru comanda/emailul pentru care a fost emis,
//     NICIODATA convertibil in accessToken-ul real, NICIODATA expus de /api/orders/by-email;
//   - noul endpoint POST /api/orders/:orderId/resume-by-email — STRICT citire + emitere de
//     credential, NICIODATA creare de comanda/generare/plata/email;
//   - frontend-ul (comenzile-mele.html) — CTA-ul "Continua cu aceasta comanda" pe ambele tipuri de
//     card (token local si email), in toate cele 8 limbi, fara mesaje false pentru comenzi
//     necontinuabile.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const page = read('public/comenzile-mele.html');
const comandaMea = read('public/comanda-mea.html');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function sliceBetween(source, startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  assert.ok(start !== -1, `nu am gasit "${startMarker}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `nu am gasit "${endMarker}" dupa startMarker`);
  return source.slice(start, end);
}

// ===================================================================================================
// SANDBOX server-side — extragem functiile REALE din server.js (nicio reimplementare paralela) si
// le executam izolat, cu un `db` minimal injectat STRICT pentru computeVideoStatus, si un `Date`
// controlabil injectat STRICT pentru testele de expirare (Date.now() din sursa reala rezolva la
// acest parametru, prin umbrire normala de scop JS — nu modifica ceasul global real).
// ===================================================================================================
const credentialSrc = sliceBetween(server, 'function normalizeEmailKey(email) {', '\n\n// -------- validatori simpli');
const videoLockSrc = sliceBetween(server, 'const VIDEO_LOCK_EXPIRY_MS = 20 * 60 * 1000;', '\n\n// CUTOVER');
const computeVideoStatusSrc = sliceBetween(server, 'async function computeVideoStatus(order) {', "\n\n// ==========================================================================================\n// \"CONTINUA CU ACEASTA COMANDA\"");
const resolveStageSrc = sliceBetween(server, 'function resolveOrderResumeStage(order) {', '\n\nasync function resumeUrlFor');
const resumeUrlForSrc = sliceBetween(server, 'async function resumeUrlFor(order, token) {', "\n\n// ==========================================================================================\n// EMAIL SUFICIENT");
const safeCompareSrc = sliceBetween(server, 'function safeCompare(a, b) {', '\n}') + '\n}';
const denyResumeCredentialSrc = sliceBetween(server, 'function denyResumeCredential(req, res, next) {', '\n}') + '\n}';

const TEST_SECRET = 'test-resume-secret-do-not-use-in-prod';
const DUMMY = crypto.randomBytes(24).toString('hex');

function buildHelpers({ videoJob = null, now = () => Date.now() } = {}) {
  const dbStub = { getLatestVideoRenderJobForOrder: async () => videoJob };
  const FakeDate = { now };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const src = `
    const RECOVERY_EMAIL_UNSUBSCRIBE_SECRET = ${JSON.stringify(TEST_SECRET)};
    const DUMMY_TOKEN_FOR_TIMING = ${JSON.stringify(DUMMY)};
    ${safeCompareSrc}
    ${credentialSrc}
    ${videoLockSrc}
    ${computeVideoStatusSrc}
    ${resolveStageSrc}
    ${resumeUrlForSrc}
    ${denyResumeCredentialSrc}
    return {
      buildResumeToken, isValidOrderCredential, classifyOrderCredential, isValidResumeToken,
      parseResumeToken, resolveOrderResumeStage, resumeUrlFor, normalizeEmailKey,
      denyResumeCredential, RESUME_TOKEN_TTL_MS, RESUME_TOKEN_SCOPE
    };
  `;
  const fn = new AsyncFunction('createHash', 'createHmac', 'timingSafeEqual', 'db', 'Date', 'Buffer', src);
  return fn(crypto.createHash, crypto.createHmac, crypto.timingSafeEqual, dbStub, FakeDate, Buffer);
}

// ===================================================================================================
// AUDIT (2026-09-30, cerinta explicita dupa raportul rundei 1) — runda 1 emitea un token PERMANENT,
// DETERMINIST, cu autoritate IDENTICA accessToken-ului. Testele de mai jos verifica RESTRUCTURAREA:
// expirare reala, non-determinism intre emiteri, scoping STRICT la orderId, si autoritate LIMITATA
// (nu identica accessToken-ului — vezi denyResumeCredential mai jos).
// ===================================================================================================
test('AUDIT Q1/Q2: buildResumeToken EXPIRA (contine issuedAt/expiresAt in payload) si NU mai e determinist — doua emiteri la momente DIFERITE pentru ACELASI orderId+email produc tokenuri DIFERITE (issuedAt/expiresAt/semnatura difera)', async () => {
  // Ceas controlat explicit (nu Date.now() real) — doua apeluri in aceeasi milisecunda reala ar
  // produce accidental acelasi payload, mascand exact non-determinismul pe care il testam.
  let currentTime = 5_000_000;
  const { buildResumeToken, normalizeEmailKey, parseResumeToken } = await buildHelpers({ now: () => currentTime });
  const t1 = buildResumeToken('order-1', normalizeEmailKey('client@exemplu.com'));
  currentTime += 1;
  const t2 = buildResumeToken('order-1', normalizeEmailKey('client@exemplu.com'));
  assert.notEqual(t1, t2, 'doua emiteri la momente diferite nu trebuie sa produca acelasi token (runda 1 era determinista — bug corectat)');
  const p1 = parseResumeToken(t1);
  assert.ok(Number.isFinite(p1.issuedAt) && Number.isFinite(p1.expiresAt) && p1.expiresAt > p1.issuedAt, 'tokenul trebuie sa contina issuedAt/expiresAt reale');
});

test('AUDIT Q3: un resume-token valid NU e acceptat de rutele care apeleaza SunoAPI (denyResumeCredential) — NU poate fi folosit "direct pe toate rutele care accepta accessToken", spre deosebire de runda 1', async () => {
  const { denyResumeCredential } = await buildHelpers();
  let statusCode = null, jsonBody = null, nextCalled = false;
  const req = { credentialKind: 'resume' };
  const res = { status: (c) => { statusCode = c; return res; }, json: (b) => { jsonBody = b; } };
  denyResumeCredential(req, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.ok(jsonBody && jsonBody.error);
  assert.equal(nextCalled, false, 'un credential de tip resume nu trebuie sa treaca mai departe pe rutele Suno');
});

test('AUDIT Q3b: denyResumeCredential lasa STRICT accessToken-ul real sa treaca (req.credentialKind === "access")', async () => {
  const { denyResumeCredential } = await buildHelpers();
  let nextCalled = false;
  const req = { credentialKind: 'access' };
  const res = { status: () => res, json: () => {} };
  denyResumeCredential(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('AUDIT Q7 (parial, cod): tokenul e transportat STRICT in query string-ul URL-urilor construite de resumeUrlFor (acelasi tipar ca accessToken-ul real, neschimbat) — NU e adaugat vreun mecanism nou de logare/analytics pentru el', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o-audit7', plan: 'standard', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1' }] };
  const url = await resumeUrlFor(order, 'RESUME.TOK');
  assert.match(url, /[?&]token=RESUME\.TOK(&|$)/);
});

// ===================================================================================================
// CREDENTIAL DE CONTINUARE (restructurat) — semnat, cu scope explicit, expira server-side, STRICT
// scoping la orderId, interschimbabil cu accessToken-ul real DOAR pentru citire/actiuni permise
// (vezi matricea de permisiuni mai jos), NICIODATA pentru /generate sau /regenerate.
// ===================================================================================================
test('buildResumeToken: mesajul semnat foloseste un prefix de domeniu distinct ("resume-v2:") si un scope versionat explicit — niciodata acelasi tipar ca buildUnsubscribeToken', () => {
  assert.match(credentialSrc, /createHmac\('sha256', RECOVERY_EMAIL_UNSUBSCRIBE_SECRET\)\.update\(`resume-v2:\$\{payloadB64\}`\)\.digest\('hex'\)/);
  assert.match(credentialSrc, /const RESUME_TOKEN_SCOPE = 'order-resume-v1';/);
});

test('RESUME_TOKEN_TTL_MS: exact 60 de minute (sesiune de continuare limitata, nu permanenta) — vezi raportul pentru justificarea duratei', async () => {
  const { RESUME_TOKEN_TTL_MS } = await buildHelpers();
  assert.equal(RESUME_TOKEN_TTL_MS, 60 * 60 * 1000);
});

test('isValidOrderCredential: accepta accessToken-ul real al comenzii (comportament neschimbat)', async () => {
  const { isValidOrderCredential } = await buildHelpers();
  const order = { id: 'order-1', email: 'client@exemplu.com', accessToken: 'a'.repeat(48) };
  assert.equal(isValidOrderCredential(order, 'a'.repeat(48)), true);
});

test('isValidOrderCredential/classifyOrderCredential: accepta un resume-token valid, proaspat emis, pentru id-ul si emailul EXACTE ale comenzii — clasificat STRICT "resume", niciodata "access"', async () => {
  const { isValidOrderCredential, classifyOrderCredential, buildResumeToken, normalizeEmailKey } = await buildHelpers();
  const order = { id: 'order-1', email: 'Client@Exemplu.com', accessToken: 'a'.repeat(48) };
  const token = buildResumeToken(order.id, normalizeEmailKey(order.email));
  assert.equal(isValidOrderCredential(order, token), true);
  assert.equal(classifyOrderCredential(order, token), 'resume');
  assert.equal(classifyOrderCredential(order, order.accessToken), 'access');
});

test('TEST 1 (audit): credential expirat -> REFUZAT — un resume-token valabil la emitere devine invalid dupa TTL, verificat server-side prin Date.now(), nu prin nicio incredere in client', async () => {
  let currentTime = 1_000_000;
  const helpers = await buildHelpers({ now: () => currentTime });
  const order = { id: 'order-1', email: 'client@exemplu.com', accessToken: 'a'.repeat(48) };
  const token = helpers.buildResumeToken(order.id, helpers.normalizeEmailKey(order.email));
  assert.equal(helpers.isValidOrderCredential(order, token), true, 'valid imediat dupa emitere');
  currentTime += helpers.RESUME_TOKEN_TTL_MS + 1;
  assert.equal(helpers.isValidOrderCredential(order, token), false, 'trebuie respins STRICT dupa expirarea TTL-ului');
});

test('TEST: credential cu 1ms inainte de expirare -> inca ACCEPTAT; exact la/dupa momentul expirarii -> RESPINS (limita testata explicit, nu doar "mult dupa")', async () => {
  let currentTime = 2_000_000;
  const helpers = await buildHelpers({ now: () => currentTime });
  const order = { id: 'order-2', email: 'client@exemplu.com', accessToken: 'b'.repeat(48) };
  const token = helpers.buildResumeToken(order.id, helpers.normalizeEmailKey(order.email));
  currentTime += helpers.RESUME_TOKEN_TTL_MS - 1;
  assert.equal(helpers.isValidOrderCredential(order, token), true);
  currentTime += 2;
  assert.equal(helpers.isValidOrderCredential(order, token), false);
});

test('TEST 3 (audit): credential emis pentru comanda A -> REFUZAT pentru comanda B (scoping STRICT la orderId, neschimbat fata de runda 1)', async () => {
  const { isValidOrderCredential, buildResumeToken, normalizeEmailKey } = await buildHelpers();
  const orderA = { id: 'order-A', email: 'client@exemplu.com' };
  const orderB = { id: 'order-B', email: 'client@exemplu.com', accessToken: 'c'.repeat(48) };
  const tokenForA = buildResumeToken(orderA.id, normalizeEmailKey(orderA.email));
  assert.equal(isValidOrderCredential(orderB, tokenForA), false);
});

test('TEST 4 (audit): credential MODIFICAT/tampered -> REFUZAT — orice bit schimbat in payload SAU semnatura invalideaza tokenul', async () => {
  const { isValidOrderCredential, buildResumeToken, normalizeEmailKey } = await buildHelpers();
  const order = { id: 'order-1', email: 'client@exemplu.com', accessToken: 'a'.repeat(48) };
  const token = buildResumeToken(order.id, normalizeEmailKey(order.email));
  const [payloadB64, signature] = token.split('.');

  // payload alterat (ex. incearca sa extinda expirarea) — semnatura veche nu se mai potriveste.
  const tamperedPayload = payloadB64.slice(0, -2) + (payloadB64.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(isValidOrderCredential(order, `${tamperedPayload}.${signature}`), false);

  // semnatura alterata — payload original, dar semnatura falsa.
  const tamperedSignature = signature.slice(0, -2) + (signature.slice(-2) === '00' ? '11' : '00');
  assert.equal(isValidOrderCredential(order, `${payloadB64}.${tamperedSignature}`), false);

  // format complet invalid (fara punct, gol, etc.)
  assert.equal(isValidOrderCredential(order, 'nu-e-un-token-valid'), false);
  assert.equal(isValidOrderCredential(order, ''), false);
  assert.equal(isValidOrderCredential(order, null), false);
});

test('TEST 5 (audit): un resume-token NU poate produce/revela accessToken-ul real — format structural distinct (payload.semnatura, base64url + hex), niciodata acelasi sir ca accessToken-ul (48 hex)', async () => {
  const { buildResumeToken, normalizeEmailKey } = await buildHelpers();
  const order = { id: 'order-1', email: 'client@exemplu.com', accessToken: 'a'.repeat(48) };
  const resumeToken = buildResumeToken(order.id, normalizeEmailKey(order.email));
  assert.notEqual(resumeToken, order.accessToken);
  assert.ok(resumeToken.includes('.'), 'formatul resume-token (payload.semnatura) e structural distinct de accessToken (sir hex simplu)');
  assert.ok(!/^[0-9a-f]{48}$/i.test(resumeToken), 'nu trebuie sa poata fi confundat cu formatul accessToken (48 hex)');
});

test('scope invalid/necunoscut in payload -> RESPINS (protectie fata de o versiune viitoare de token cu alta autoritate, reutilizata gresit)', async () => {
  const { isValidOrderCredential, normalizeEmailKey } = await buildHelpers();
  const order = { id: 'order-1', email: 'client@exemplu.com' };
  // construim manual un payload cu scope gresit, semnat cu ACELASI secret de test — semnatura e
  // validA structural, dar scope-ul nu se potriveste cu RESUME_TOKEN_SCOPE asteptat.
  const emailFingerprint = crypto.createHash('sha256').update(normalizeEmailKey(order.email)).digest('hex').slice(0, 16);
  const now = Date.now();
  const payload = `${order.id}:${emailFingerprint}:${now}:${now + 999999}:some-other-scope`;
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', TEST_SECRET).update(`resume-v2:${payloadB64}`).digest('hex');
  assert.equal(isValidOrderCredential(order, `${payloadB64}.${signature}`), false);
});

// ===================================================================================================
// MATRICEA DE PERMISIUNI (cerinta explicita, dupa audit) — NU se aplica automat resume-token-ul
// la toate rutele care accepta accessToken. Verificare STRUCTURALA, per ruta reala din server.js:
// STRICT /generate si /regenerate (singurele care apeleaza SunoAPI) resping explicit un credential
// de tip 'resume' (denyResumeCredential) — toate celelalte actiuni ale calatoriei normale de
// continuare (citire, selectie, checkout — creare sesiune Stripe, nu miscare de bani —, editare
// versuri/materiale, upload/stergere/reordonare materiale video, confirmare, creare videoclip,
// continut platit complet dupa livrare) raman accesibile, cu justificare per ruta in raport.
// ===================================================================================================
const RESUME_DENIED_ROUTES = [
  "app.post('/api/orders/:orderId/generate', generationLimiter, requireOrderToken, denyResumeCredential,",
  "app.post('/api/orders/:orderId/regenerate', generationLimiter, requireOrderToken, denyResumeCredential,"
];
const RESUME_ALLOWED_ROUTES = [
  "app.post('/api/orders/:orderId/variants/:variantId/lyrics', express.json(), requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/select', requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/media', mediaUploadLimiter, requireOrderToken, handleOrderMediaUpload, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/media/multipart/init', mediaUploadLimiter, requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/media/multipart/:sessionId/part-url', requireOrderToken, async (req, res, next) => {",
  "app.get('/api/orders/:orderId/media/multipart/:sessionId/part-etag', requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {",
  "app.delete('/api/orders/:orderId/media/multipart/:sessionId', requireOrderToken, async (req, res) => {",
  "app.post('/api/orders/:orderId/media/client-timing', requireOrderToken, (req, res) => {",
  "app.get('/api/orders/:orderId/media/:index/preview-url', requireOrderToken, async (req, res, next) => {",
  "app.delete('/api/orders/:orderId/media/:index', requireOrderToken, async (req, res, next) => {",
  "app.put('/api/orders/:orderId/media/:index/section', express.json(), requireOrderToken, async (req, res, next) => {",
  "app.put('/api/orders/:orderId/media/reorder', express.json(), requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/media/confirm', requireOrderToken, async (req, res, next) => {",
  "app.post('/api/orders/:orderId/create-video', requireOrderToken, async (req, res, next) => {",
  "app.get('/api/orders/:orderId/media/video-preview-url', requireOrderToken, async (req, res, next) => {"
];

test('MATRICE: toate rutele care apeleaza SunoAPI (generate/regenerate) resping explicit resume-token (denyResumeCredential in lantul de middleware)', () => {
  RESUME_DENIED_ROUTES.forEach((sig) => {
    assert.ok(server.includes(sig), `semnatura lipsa/schimbata: ${sig}`);
  });
});

test('MATRICE: toate celelalte rute protejate de requireOrderToken (editare versuri, selectie, checkout, upload/stergere/reordonare/confirmare materiale, creare video) NU au denyResumeCredential — resume-token functioneaza acolo, per justificarea din raport', () => {
  RESUME_ALLOWED_ROUTES.forEach((sig) => {
    assert.ok(server.includes(sig), `semnatura lipsa/schimbata: ${sig}`);
    assert.ok(!sig.includes('denyResumeCredential'), `ruta nu trebuie sa aiba denyResumeCredential: ${sig}`);
  });
});

test('MATRICE: cele doua liste (interzise + permise) acopera EXACT cele 19 rute reale protejate de requireOrderToken din server.js — nicio ruta noua ramasa neclasificata', () => {
  assert.equal(RESUME_DENIED_ROUTES.length + RESUME_ALLOWED_ROUTES.length, 19);
  const routeRegistrations = server.match(/app\.(get|post|put|delete)\('\/api\/orders\/:orderId[^\n]*requireOrderToken[^\n]*/g) || [];
  assert.equal(routeRegistrations.length, 19, `server.js are ${routeRegistrations.length} rute reale protejate de requireOrderToken — matricea de mai sus trebuie actualizata daca acest numar se schimba`);
});

test('MATRICE: GET /media/full+gift+bonus+wav+video (CONTINUT PLATIT COMPLET) folosesc isValidOrderCredential (accepta resume-token) — justificat STRICT pentru ca "ready" e destinatia de resume pentru comenzi platite (comanda-mea.html); ramane gated STRICT de order.status===\'ready\' indiferent de tipul de credential', () => {
  ["app.get('/media/full/:orderId', async (req, res, next) => {",
   "app.get('/media/full/:orderId/gift', async (req, res, next) => {",
   "app.get('/media/full/:orderId/bonus', async (req, res, next) => {",
   "app.get('/media/wav/:orderId', async (req, res, next) => {",
   "app.get('/media/video/:orderId', async (req, res, next) => {"
  ].forEach((sig) => {
    const idx = server.indexOf(sig);
    assert.ok(idx !== -1, `ruta lipseste: ${sig}`);
    const end = server.indexOf('\n});', idx);
    const body = server.slice(idx, end);
    assert.match(body, /isValidOrderCredential/);
    assert.match(body, /order\.status !== 'ready'/);
  });
});

test('MATRICE: quota/generation_attempts si apelurile catre SunoAPI (callMusicProvider) raman STRICT in interiorul handler-elor /generate si /regenerate, neatinse de adaugarea denyResumeCredential — verificat prin prezenta liniilor originale, byte-identice', () => {
  const generateFn = sliceBetween(server, "app.post('/api/orders/:orderId/generate',", '\n});');
  assert.match(generateFn, /db\.claimOrderForInitialGeneration\(/);
  assert.match(generateFn, /credits\.MAX_GENERATION_ATTEMPTS/);
  const regenerateFn = sliceBetween(server, "app.post('/api/orders/:orderId/regenerate',", '\n});', server.indexOf("app.post('/api/orders/:orderId/regenerate',"));
  assert.match(regenerateFn, /handlePremiumSelectiveRegenerate|handleLegacyRegenerate/);
});

// ===================================================================================================
// resolveOrderResumeStage — STRICT din starea reala (order.status), niciodata din reguli
// specifice de pachet ("Premium + N melodii").
// ===================================================================================================
test('resolveOrderResumeStage: ready -> "ready"; draft/generating/processing_provider_result -> "generating"; preview_ready -> "in_progress"; orice altceva -> null', async () => {
  const { resolveOrderResumeStage } = await buildHelpers();
  assert.equal(resolveOrderResumeStage({ status: 'ready' }), 'ready');
  assert.equal(resolveOrderResumeStage({ status: 'draft' }), 'generating');
  assert.equal(resolveOrderResumeStage({ status: 'generating' }), 'generating');
  assert.equal(resolveOrderResumeStage({ status: 'processing_provider_result' }), 'generating');
  assert.equal(resolveOrderResumeStage({ status: 'preview_ready' }), 'in_progress');
  assert.equal(resolveOrderResumeStage({ status: 'generation_failed' }), null);
});

// ===================================================================================================
// resumeUrlFor — reproduce EXACT rutarea deja corecta (audit): ready -> comanda-mea.html;
// draft/generating/processing_provider_result/generation_failed -> melodia-mea.html (gestioneaza
// deja aceste stari, inclusiv redirectul propriu catre se-compune.html); Standard/Premium
// preview_ready -> melodia-mea.html (renderContent/renderPremiumFlow aleg singure ecranul, dupa
// variants.length/selectedVariantId); Video cu materiale neconfirmate (videoStatus none/failed) ->
// amintiri-video.html (SINGURA ramura neacoperita de melodia-mea.html — butonul de creare video a
// fost mutat acolo structural); Video cu job activ/gata -> melodia-mea.html (updateVideoStatusUI
// arata deja corect generating/queued/stale/ready).
// ===================================================================================================
test('TEST 1/4: Premium/Standard, preview_ready, selectie nefacuta inca -> melodia-mea.html (ecranul de selectie/comparatie e randat acolo, dupa variants.length)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o1', plan: 'premium', status: 'preview_ready', variants: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] };
  const url = await resumeUrlFor(order, 'TOK');
  assert.equal(url, '/melodia-mea.html?id=o1&token=TOK');
});

test('TEST 2/6: Premium/Standard, preview_ready, selectie deja facuta -> tot melodia-mea.html (pasul urmator real, checkout, e randat pe aceeasi pagina, fara sa repete selectia)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o2', plan: 'standard', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1' }] };
  const url = await resumeUrlFor(order, 'TOK');
  assert.equal(url, '/melodia-mea.html?id=o2&token=TOK');
});

test('TEST 3: Standard neplatit, inca in generare (draft) -> melodia-mea.html (redirecteaza singur catre se-compune.html, NU se sare peste generare)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o3', plan: 'standard', status: 'draft' };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/melodia-mea.html?id=o3&token=TOK');
});

test('TEST 5: Video INAINTE de plata, materiale neconfirmate (nicio varianta selectata) -> melodia-mea.html (nu e inca eligibil pentru amintiri-video.html, ii lipseste selectedVariantId)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o5', plan: 'video', status: 'preview_ready', variants: [{ id: 'v1' }, { id: 'v2' }] };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/melodia-mea.html?id=o5&token=TOK');
});

test('TEST 6: Video platit, materiale INCOMPLETE (selectie facuta, videoStatus none) -> amintiri-video.html (STRICT stadiul real de upload/confirmare, unde a fost mutat butonul de creare)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o6', plan: 'video', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1' }] };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/amintiri-video.html?id=o6&token=TOK');
});

test('TEST 6b: Video, materiale confirmate, job de randare ESUAT (videoFailedReason) -> amintiri-video.html (recuperabil, acelasi stadiu de reincercare)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o6b', plan: 'video', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1', videoFailedReason: 'timeout' }] };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/amintiri-video.html?id=o6b&token=TOK');
});

test('TEST 7: Video, randare in curs (job "pending" in coada) -> melodia-mea.html (updateVideoStatusUI arata deja corect "in curs de creare", nu amintiri-video.html)', async () => {
  const { resumeUrlFor } = await buildHelpers({ videoJob: { status: 'pending' } });
  const order = { id: 'o7', plan: 'video', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1' }] };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/melodia-mea.html?id=o7&token=TOK');
});

test('TEST 7b: Video, randare GATA (videoKey + videoPreviewKey), comanda inca neplatita -> melodia-mea.html (checkout activat acolo, gift-preview aratat)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  const order = { id: 'o7b', plan: 'video', status: 'preview_ready', selectedVariantId: 'v1', variants: [{ id: 'v1', videoKey: 'k', videoPreviewKey: 'p' }] };
  assert.equal(await resumeUrlFor(order, 'TOK'), '/melodia-mea.html?id=o7b&token=TOK');
});

test('TEST 8: Comanda ready (platita) — Standard/Premium/Video, deopotriva -> comanda-mea.html (STRICT pagina care reda/descarca, nu melodia-mea.html)', async () => {
  const { resumeUrlFor } = await buildHelpers();
  for (const plan of ['standard', 'premium', 'video']) {
    const order = { id: 'o8-' + plan, plan, status: 'ready' };
    assert.equal(await resumeUrlFor(order, 'TOK'), `/comanda-mea.html?token=TOK&id=o8-${plan}`);
  }
});

test('TEST 9: comanda in generare (status="generating") -> melodia-mea.html, NICIODATA direct la un ecran de selectie/checkout — nu se sare peste generare', async () => {
  const { resumeUrlFor, resolveOrderResumeStage } = await buildHelpers();
  const order = { id: 'o9', plan: 'standard', status: 'generating' };
  assert.equal(resolveOrderResumeStage(order), 'generating');
  assert.equal(await resumeUrlFor(order, 'TOK'), '/melodia-mea.html?id=o9&token=TOK');
});

test('TEST 10: generation_failed -> resolveOrderResumeStage returneaza null (exclus de eligibilitate, la fel ca la recuperarea prin email/quota) — comportamentul de eroare ramane STRICT cel deja existent in melodia-mea.html pentru accesul cu token complet', () => {
  const idx = server.indexOf('function resolveOrderResumeStage(order) {');
  const body = server.slice(idx, server.indexOf('\n}', idx));
  assert.ok(!/generation_failed/.test(body), 'generation_failed nu trebuie mapat explicit la o stare continuabila — cade in ramura null, exact ca la eligibilitatea SQL (status NOT IN (\'draft\',\'generation_failed\'))');
});

// ===================================================================================================
// POST /api/orders/:orderId/resume-by-email — STRICT emitere de credential pentru O comanda,
// dupa aceeasi eligibilitate ca /api/orders/by-email. NICIODATA accessToken in raspuns.
// ===================================================================================================
const resumeRouteSrc = sliceBetween(server, "app.post('/api/orders/:orderId/resume-by-email',", '\n});');

test('server.js: POST /api/orders/:orderId/resume-by-email reutilizeaza STRICT recoveryIpLimiter + recoveryEmailTargetLimiter (acelasi anti-enumerare, niciun limiter nou)', () => {
  assert.match(resumeRouteSrc, /app\.post\('\/api\/orders\/:orderId\/resume-by-email', recoveryIpLimiter, recoveryEmailTargetLimiter, async \(req, res, next\) => \{/);
});

test('server.js: resume-by-email foloseste STRICT db.getEligibleOrdersForAccessRecovery (aceeasi eligibilitate ca /by-email) — nicio interogare SQL noua/paralela, si cauta comanda ceruta STRICT in acea lista deja vetted', () => {
  assert.match(resumeRouteSrc, /const orders = await db\.getEligibleOrdersForAccessRecovery\(emailKey\);/);
  assert.match(resumeRouteSrc, /const order = orders\.find\(\(o\) => o\.id === req\.params\.orderId\);/);
});

test('server.js: resume-by-email NU contine STRINGUL "accessToken" nicaieri — raspunsul nu poate scurge NICIODATA tokenul real, sub nicio forma', () => {
  assert.ok(!resumeRouteSrc.includes('accessToken'), 'ruta resume-by-email nu trebuie sa refere accessToken sub nicio forma');
});

test('server.js: resume-by-email NU creeaza nicio comanda, NU atinge quota/generation_attempts, NU apeleaza Suno, NU creeaza sesiune Stripe, NU trimite niciun email — STRICT emitere de credential + calcul de URL', () => {
  const forbidden = [
    'createOrder', 'claimOrderForInitialGeneration', 'claimOrderForRegeneration', 'runGeneration',
    'generation_attempts', 'stripe.checkout.sessions.create', 'sendDeliveryEmail',
    'sendAccessRecoveryEmail', 'sendRecoveryNotificationEmail', 'INSERT INTO orders', 'UPDATE orders'
  ];
  forbidden.forEach((token) => {
    assert.ok(!resumeRouteSrc.includes(token), `ruta nu trebuie sa contina "${token}"`);
  });
});

test('server.js: email lipsa/invalid, comanda inexistenta in lista eligibila, SAU throttling pe email -> raspuns IDENTIC {canResume:false} — niciun semnal de enumerare', () => {
  assert.match(resumeRouteSrc, /if \(!rawEmail \|\| !rawEmail\.includes\('@'\)\) return res\.json\(\{ canResume: false \}\);/);
  assert.match(resumeRouteSrc, /if \(req\.recoveryEmailThrottled\) return res\.json\(\{ canResume: false \}\);/);
  assert.match(resumeRouteSrc, /if \(!order\) return res\.json\(\{ canResume: false \}\);/);
});

test('server.js: resume-by-email calculeaza resumeUrl STRICT prin resumeUrlFor(order, resumeToken) — acelasi rezolvator de stare testat mai sus, nicio logica de rutare duplicata in ruta', () => {
  assert.match(resumeRouteSrc, /const resumeUrl = await resumeUrlFor\(order, resumeToken\);/);
  assert.match(resumeRouteSrc, /res\.json\(\{ canResume: true, resumeUrl \}\);/);
});

// ===================================================================================================
// GET /api/orders/access/:token — extins cu ?id= optional, STRICT pentru resumeUrl (comanda-mea.html).
// Traseul VECHI (fara ?id=, linkul real din email) ramane identic.
// ===================================================================================================
const accessRouteSrc = sliceBetween(server, "app.get('/api/orders/access/:token', lookupLimiter, async (req, res, next) => {", '\n});');

test('server.js: GET /api/orders/access/:token — traseul VECHI (fara ?id=) ramane STRICT neschimbat: format 48-hex obligatoriu, db.getOrderByToken', () => {
  assert.match(accessRouteSrc, /if \(typeof token !== 'string' \|\| !\/\^\[0-9a-f\]\{48\}\$\/i\.test\(token\)\) \{/);
  assert.match(accessRouteSrc, /const order = await db\.getOrderByToken\(token\);/);
});

test('server.js: GET /api/orders/access/:token — traseul NOU (?id=) foloseste db.getOrderById + isValidOrderCredential (accepta accessToken real SAU resume-token) — nu slabeste traseul vechi', () => {
  assert.match(accessRouteSrc, /const order = await db\.getOrderById\(explicitId\);/);
  assert.match(accessRouteSrc, /if \(!order \|\| !isValidOrderCredential\(order, token\)\) \{/);
});

// ===================================================================================================
// FRONTEND — comenzile-mele.html: CTA vizibil pe ambele tipuri de card, mesaj corect cand
// comanda NU poate fi continuata, toate cele 8 limbi.
// ===================================================================================================
test('comenzile-mele.html: scriptul inline ramane sintactic valid dupa adaugarea CTA-ului de continuare', () => {
  const matches = [...page.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(matches[matches.length - 1][1]));
});

test('comenzile-mele.html: renderOrderCard (card CLICKABIL, token local) afiseaza vizibil t.continue_btn in interiorul link-ului — mecanismul de navigare (href=continueUrl) ramane NESCHIMBAT', () => {
  const idx = page.indexOf('function renderOrderCard(order, index, continueUrl) {');
  const end = page.indexOf('async function resumeOrderByEmail');
  const body = page.slice(idx, end);
  assert.match(body, /card\.href = continueUrl;/);
  assert.match(body, /t\.continue_btn/);
});

test('comenzile-mele.html: renderReadOnlyOrderCard afiseaza butonul de continuare STRICT cand order.canResume e true, altfel un mesaj corect (resume_unavailable) — niciodata un CTA fals', () => {
  const idx = page.indexOf('function renderReadOnlyOrderCard(order, index, previewVariantIds, email) {');
  const end = page.indexOf('function handleNoVisibleOrders');
  const body = page.slice(idx, end);
  assert.match(body, /if \(order\.canResume\) \{/);
  assert.match(body, /btn\.textContent = t\.continue_btn;/);
  assert.match(body, /msg\.textContent = t\.resume_unavailable;/);
  assert.match(body, /note\.textContent = t\.resume_unavailable;/);
});

test('comenzile-mele.html: butonul de continuare apeleaza STRICT resumeOrderByEmail(order.id, email) si navigheaza STRICT dupa ce serverul confirma canResume+resumeUrl — niciodata inainte', () => {
  const idx = page.indexOf('function renderReadOnlyOrderCard(order, index, previewVariantIds, email) {');
  const end = page.indexOf('function handleNoVisibleOrders');
  const body = page.slice(idx, end);
  assert.match(body, /const result = await resumeOrderByEmail\(order\.id, email\);/);
  assert.match(body, /if \(result\.canResume && result\.resumeUrl\) \{\s*\n\s*window\.location\.href = result\.resumeUrl;/);
});

test('comenzile-mele.html: resumeOrderByEmail cere STRICT POST /api/orders/:orderId/resume-by-email cu {email} — niciodata accessToken, niciodata un GET cu id-uri in query care sa scurga starea altor comenzi', () => {
  const idx = page.indexOf('async function resumeOrderByEmail');
  const end = page.indexOf("return (data && typeof data === 'object') ? data : { canResume: false };") + 80;
  const body = page.slice(idx, end);
  assert.match(body, /fetch\(`\/api\/orders\/\$\{encodeURIComponent\(orderId\)\}\/resume-by-email`, \{/);
  assert.match(body, /method: 'POST'/);
  assert.ok(!body.includes('accessToken'));
});

for (const lang of ALLOWED_LANGS) {
  test(`comenzile-mele.html: limba ${lang} are cheile continue_btn si resume_unavailable, ambele nevide si distincte una de alta`, () => {
    const idxLang = page.indexOf(`    ${lang}: {`);
    assert.ok(idxLang !== -1, `bloc de traduceri lipsa pentru ${lang}`);
    const endLang = page.indexOf('\n    },', idxLang);
    const block = page.slice(idxLang, endLang);
    const continueMatch = block.match(/continue_btn: '([^']+)'/) || block.match(/continue_btn: "([^"]+)"/);
    const resumeMatch = block.match(/resume_unavailable: '([^']+)'/) || block.match(/resume_unavailable: "([^"]+)"/);
    assert.ok(continueMatch && continueMatch[1].trim().length > 0, `[${lang}] continue_btn lipseste/gol`);
    assert.ok(resumeMatch && resumeMatch[1].trim().length > 0, `[${lang}] resume_unavailable lipseste/gol`);
    assert.notEqual(continueMatch[1], resumeMatch[1], `[${lang}] continue_btn si resume_unavailable trebuie sa fie mesaje distincte`);
  });
}

test('comenzile-mele.html: toate cele 8 traduceri ale "resume_unavailable" sunt distincte intre ele (nicio limba lasata cu textul altei limbi)', () => {
  const idx = page.indexOf('const T = {');
  let depth = 0, i = page.indexOf('{', idx);
  const start = i;
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  const T = new Function(page.slice(idx, i + 1) + '\nreturn T;')();
  const values = ALLOWED_LANGS.map((lang) => T[lang].resume_unavailable);
  assert.equal(new Set(values).size, ALLOWED_LANGS.length, 'toate cele 8 traduceri "resume_unavailable" trebuie sa fie distincte');
});

// ===================================================================================================
// TEST 18 — browser FARA naluna_my_order_keys: comanda apare prin email (view/listen, deja auditat
// in test/orders-by-email-endpoint.test.js + comenzile-mele-page.test.js) SI poate fi continuata
// legitim — verificat structural (canResume vine din acelasi DTO deja folosit de acel flux).
// ===================================================================================================
test('server.js: buildOrderSummaryDto (folosit de /api/orders/by-email, sursa pentru cardurile view/listen) include canResume/resumeStage, calculate STRICT prin resolveOrderResumeStage — acelasi camp pe care se bazeaza butonul de continuare', () => {
  const idx = server.indexOf('function buildOrderSummaryDto(order) {');
  const end = server.indexOf("app.post('/api/orders/by-email',");
  const body = server.slice(idx, end);
  assert.match(body, /canResume: resolveOrderResumeStage\(order\) !== null,/);
  assert.match(body, /resumeStage: resolveOrderResumeStage\(order\)/);
});

// ===================================================================================================
// TEST 20 — fixul anterior de Back (continueUrlFor, cardul token-path) ramane functional: click pe
// card duce tot la pagina corecta, acum cu eticheta CTA vizibila in plus — verificat deja de
// test/comenzile-mele-page.test.js (sandbox "click pe comanda -> acces la variantele audio"), care
// continua sa treaca dupa aceasta schimbare (rulat separat, neschimbat aici).
// ===================================================================================================
test('comenzile-mele.html: continueUrlFor ramane STRICT neschimbat (acelasi fisier, aceeasi functie) — fixul de Back nu a fost atins de adaugarea CTA-ului de continuare', () => {
  assert.match(page, /function continueUrlFor\(order, token\) \{\s*\n\s*if \(order\.status === 'ready'\) \{\s*\n\s*return `\/comanda-mea\.html\?token=\$\{encodeURIComponent\(token\)\}`;/);
});

// ===================================================================================================
// comanda-mea.html — ?id= optional, STRICT pentru resumeUrl; linkul real din email (fara ?id=)
// ramane identic.
// ===================================================================================================
test('comanda-mea.html: lookup() accepta un orderId optional si il include STRICT ca ?id= in fetch-ul catre /api/orders/access/:token — fara el (linkul real din email), comportamentul e identic cu inainte', () => {
  assert.match(comandaMea, /async function lookup\(token, orderId\) \{/);
  assert.match(comandaMea, /const idSuffix = orderId \? '\?id=' \+ encodeURIComponent\(orderId\) : '';/);
  assert.match(comandaMea, /fetch\('\/api\/orders\/access\/' \+ encodeURIComponent\(token\) \+ idSuffix\)/);
});

test('comanda-mea.html: gate-ul "fara ?token= -> comenzile-mele.html" verifica STRICT prezenta lui token (nu id) — un resumeUrl (?token=&id=) trece garda identic cu linkul real din email', () => {
  const idx = comandaMea.indexOf('data-purpose="no-token-redirect"');
  const scriptBody = comandaMea.slice(idx, comandaMea.indexOf('</script>', idx));
  assert.match(scriptBody, /if \(!new URLSearchParams\(window\.location\.search\)\.get\('token'\)\) \{/);
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
