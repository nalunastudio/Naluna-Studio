// PROBLEMA 1/2 (2026-09-30, "Comenzile mele goala desi quota stie ca exista melodii" + "quota
// block trebuie sa duca direct la melodiile existente" — decizie explicita de produs, "emailul
// introdus de client e suficient"): POST /api/orders/by-email — sursa de adevar noua, dupa email,
// pentru "Comenzile mele". Eligibilitate IDENTICA cu db.getEligibleOrdersForAccessRecovery (deja
// folosita de recuperarea prin email si aliniata cu criteriul de numarare a cotei). STRICT citire
// — niciodata o comanda noua, niciodata quota/Suno/Stripe/email atinse.
//
// CORECTIE CRITICA DE SECURITATE (2026-09-30, runda 2 — decizie explicita, dupa audit): runda 1
// intorcea un `continueUrl` cu accessToken-ul COMPLET embedat in query string — desi nu exista
// niciun camp `accessToken` separat, tokenul ajungea oricum la client, oferind autoritate
// COMPLETA (plata/editare/regenerare/upload media/video) STRICT prin cunoasterea unui email.
// Eliminat complet — raspunsul ofera acum STRICT un VIEW/LISTEN MODE: date de sumar +
// previewVariantIds (id-uri de variante, redabile STRICT prin GET /media/preview/:orderId/
// :variantId, ruta deja PUBLICA/neautentificata, neatinsa aici). NICIODATA accessToken, sub
// nicio forma (proprietate, query param, URL, metadata) — verificat exhaustiv mai jos.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getGiftVariant, getPremiumBonusVariant } = require('../lib/entitlements.js');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `nu am gasit "${startMarker}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `nu am gasit "${endMarker}" dupa startMarker`);
  return source.slice(start, end);
}

const routeSrc = sliceBetween(server, "app.post('/api/orders/by-email',", '\n});');
const dtoSrc = sliceBetween(server, 'function buildOrderSummaryDto(order) {', "app.post('/api/orders/by-email',");
const hostedAccessSrc = sliceBetween(server, 'const CONTENT_RETENTION_DAYS = 30;', '\n\n// Content-Disposition:');

// ===================================================================================================
// STRUCTURA RUTEI — reutilizeaza rate limiting-ul deja auditat (anti-enumerare), NU creeaza unul nou.
// ===================================================================================================
test('server.js: POST /api/orders/by-email reutilizeaza STRICT recoveryIpLimiter + recoveryEmailTargetLimiter — acelasi mecanism anti-enumerare ca /recover-access, niciun limiter nou', () => {
  assert.match(routeSrc, /app\.post\('\/api\/orders\/by-email', recoveryIpLimiter, recoveryEmailTargetLimiter, async \(req, res, next\) => \{/);
});

test('server.js: POST /api/orders/by-email — email lipsa/invalid SAU throttled pe email -> raspuns IDENTIC, gol ({orders: []}), fara nicio interogare DB — acelasi anti-enumerare ca /recover-access', () => {
  assert.match(routeSrc, /if \(!rawEmail \|\| !rawEmail\.includes\('@'\)\) return res\.json\(\{ orders: \[\] \}\);/);
  assert.match(routeSrc, /if \(req\.recoveryEmailThrottled\) return res\.json\(\{ orders: \[\] \}\);/);
});

test('server.js: POST /api/orders/by-email foloseste STRICT db.getEligibleOrdersForAccessRecovery (acelasi criteriu de eligibilitate ca recuperarea prin email/quota) — nicio interogare noua/paralela', () => {
  assert.match(routeSrc, /const orders = await db\.getEligibleOrdersForAccessRecovery\(emailKey\);/);
});

// ===================================================================================================
// STRICT CITIRE — niciodata o comanda noua, niciodata quota/Suno/Stripe/email/analytics atinse.
// ===================================================================================================
test('server.js: POST /api/orders/by-email NU creeaza nicio comanda, NU atinge quota/generation_attempts, NU apeleaza Suno, NU creeaza sesiune Stripe, NU trimite niciun email, NU scrie analytics/funnel', () => {
  const forbidden = [
    'createOrder', 'claimOrderForInitialGeneration', 'claimOrderForRegeneration', 'runGeneration',
    'generation_attempts', 'stripe.checkout.sessions.create', 'sendDeliveryEmail',
    'sendAccessRecoveryEmail', 'sendRecoveryNotificationEmail', 'linkFunnelEventsToOrder',
    'recordFunnelEvent', 'NalunaAnalytics', 'INSERT INTO orders', 'UPDATE orders'
  ];
  forbidden.forEach((token) => {
    assert.ok(!routeSrc.includes(token), `ruta nu trebuie sa contina "${token}" — trebuie sa ramana STRICT citire`);
  });
});

// ===================================================================================================
// DTO — camp cu camp, NICIODATA accessToken/email/Stripe IDs/chei de storage/date administrative.
// STRICT view/listen: previewVariantIds (id-uri, NU URL-uri/chei), NICIODATA continueUrl/token.
// ===================================================================================================
test('server.js: buildOrderSummaryDto NU face spread pe randul din DB — raspunsul e construit camp cu camp, exact ca la GET /api/orders/:orderId (acelasi tipar deja auditat)', () => {
  assert.ok(!/\.\.\.order/.test(dtoSrc), 'niciun spread pe order — ar scurge accessToken/email');
  assert.match(dtoSrc, /return \{/);
});

test('server.js: buildOrderSummaryDto NU contine STRINGUL "accessToken" NICAIERI (nu doar ca nume de camp in obiectul returnat) — nicio cale (URL, concatenare, field derivat) prin care accessToken sa ajunga in raspuns', () => {
  assert.ok(!dtoSrc.includes('accessToken'), 'buildOrderSummaryDto nu trebuie sa refere accessToken sub nicio forma');
  assert.ok(!routeSrc.includes('accessToken'), 'ruta POST /api/orders/by-email nu trebuie sa refere accessToken sub nicio forma');
});

test('server.js: buildOrderSummaryDto NU returneaza NICIODATA accessToken/continueUrl/email/Stripe IDs/chei de storage/date administrative ca proprietati separate — STRICT campurile whitelisted (view/listen)', () => {
  const returnBlock = dtoSrc.slice(dtoSrc.indexOf('return {'));
  const FORBIDDEN_FIELDS = [/^\s*accessToken:/m, /^\s*continueUrl:/m, /^\s*email:/m, /^\s*stripeCustomerId:/m, /^\s*stripeSessionId:/m, /^\s*storageKey:/m, /^\s*ip:/m, /^\s*fbp:/m, /^\s*fbc:/m];
  FORBIDDEN_FIELDS.forEach((re) => assert.ok(!re.test(returnBlock), `campul interzis ${re} nu trebuie sa apara in DTO`));
  // previewVariantIds — STRICT id-uri de variante, niciodata URL-uri sau chei de storage.
  assert.match(returnBlock, /previewVariantIds: \(order\.variants \|\| \[\]\)\.filter\(\(v\) => v\.previewUrl\)\.map\(\(v\) => v\.id\)/);
});

function evalDto(order) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction(
    'order', 'getGiftVariant', 'getPremiumBonusVariant',
    hostedAccessSrc + '\n' + dtoSrc + '\nreturn buildOrderSummaryDto(order);'
  );
  return fn(order, getGiftVariant, getPremiumBonusVariant);
}

test('sandbox: buildOrderSummaryDto(order) — obiectul rezultat NU are NICIODATA cheile accessToken/email/continueUrl, indiferent de continutul comenzii (verificare directa pe obiectul JS, nu doar pe sursa)', async () => {
  const order = {
    id: 'order-1', recipient: 'Maria', plan: 'standard', status: 'ready', createdAt: '2026-09-01T00:00:00Z',
    accessToken: 'a'.repeat(48), email: 'client@exemplu.com', variants: [{ id: 'v1', title: 'Titlul melodiei', fullKey: 'k1', previewUrl: 'https://cdn/v1.mp3' }],
    selectedVariantId: 'v1'
  };
  const dto = await evalDto(order);
  assert.ok(!('accessToken' in dto));
  assert.ok(!('email' in dto));
  assert.ok(!('continueUrl' in dto));
  assert.equal(dto.id, 'order-1');
  assert.equal(dto.songTitle, 'Titlul melodiei');
  // previewVariantIds contine STRICT id-uri — niciun URL, nicio cheie de storage, niciun token.
  assert.deepEqual(dto.previewVariantIds, ['v1']);
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('a'.repeat(48)), 'accessToken-ul real nu trebuie sa apara nicaieri in raspunsul serializat');
});

test('sandbox: buildOrderSummaryDto — previewVariantIds contine STRICT variantele cu preview real disponibil (previewUrl), indiferent de statusul comenzii (ready sau nu) — acelasi preview deja ascultabil inainte de plata', async () => {
  const order = {
    id: 'order-2', recipient: 'Ion', plan: 'video', status: 'ready', createdAt: '2026-09-01T00:00:00Z', accessToken: 'b'.repeat(48),
    variants: [{ id: 'v1', previewUrl: 'https://cdn/x.mp3', fullKey: 'k1' }, { id: 'v2', fullKey: 'k2' }]
  };
  const dto = await evalDto(order);
  assert.deepEqual(dto.previewVariantIds, ['v1'], 'STRICT varianta cu previewUrl — v2 nu are preview, nu trebuie inclusa');
});

test('sandbox: buildOrderSummaryDto — comanda platita (ready) numara STRICT principala + cadou + bonus Premium, EXACT ca lib/entitlements.js (aceeasi regula ca la comanda-mea.html) — songCount ramane informativ, fara acces la fisierul complet', async () => {
  const order = {
    id: 'order-3', recipient: 'Elena', plan: 'premium', status: 'ready', createdAt: '2026-09-01T00:00:00Z', accessToken: 'c'.repeat(48),
    selectedVariantId: 'v1', premiumBonusVariantId: 'v3',
    variants: [{ id: 'v1', fullKey: 'k1', songSlot: 1 }, { id: 'v2', fullKey: 'k2', songSlot: 2 }, { id: 'v3', fullKey: 'k3' }]
  };
  const dto = await evalDto(order);
  assert.equal(dto.songCount, 3, 'principala + cadou (v2) + bonus Premium (v3)');
});

test('sandbox: buildOrderSummaryDto — songTitle e null cand nicio varianta nu are titlu (sistem emotional inca neaplicat/comanda veche)', async () => {
  const order = { id: 'order-4', recipient: 'Radu', plan: 'standard', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', accessToken: 'd'.repeat(48), variants: [{ id: 'v1', previewUrl: 'x' }] };
  const dto = await evalDto(order);
  assert.equal(dto.songTitle, null);
});

test('sandbox: buildOrderSummaryDto — hostedAccessExpired reflecta EXACT aceeasi regula (CONTENT_RETENTION_DAYS de la paidAt) ca restul site-ului', async () => {
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const order = { id: 'order-5', recipient: 'Sara', plan: 'standard', status: 'ready', createdAt: '2026-01-01T00:00:00Z', accessToken: 'e'.repeat(48), paidAt: longAgo, variants: [] };
  const dto = await evalDto(order);
  assert.equal(dto.hostedAccessExpired, true, 'peste 30 de zile de la plata, accesul gazduit trebuie marcat expirat');
});

// ===================================================================================================
// SEPARAREA FINALA: EMAIL -> discovery + read/listen; ACCESS TOKEN COMPLET -> mutate/full authority.
// Read mode-ul (fara accessToken) NU trebuie sa poata autoriza NICIUN endpoint mutabil protejat —
// verificat structural: requireOrderToken (garda comuna a tuturor rutelor mutabile) ramane
// NESCHIMBATA, cere STRICT accessToken-ul real (safeCompare), pe care raspunsul by-email nu il
// contine sub nicio forma (verificat mai sus) — deci nu exista nicio valoare din acest raspuns
// care sa poata fi refolosita ca "X-Access-Token"/accessToken pe acele rute.
// ===================================================================================================
test('server.js: requireOrderToken (garda comuna pentru edit lyrics/regenerate/select/generate/checkout/media upload-delete-reorder/create-video) ramane STRICT NESCHIMBATA — cere accessToken real (safeCompare), pe care raspunsul by-email nu il ofera', () => {
  const guardSrc = sliceBetween(server, 'async function requireOrderToken(req, res, next) {', '\n\n// ==');
  assert.match(guardSrc, /const token = req\.get\('X-Access-Token'\) \|\| \(req\.body && req\.body\.accessToken\) \|\| null;/);
  assert.match(guardSrc, /if \(!order \|\| !token \|\| !safeCompare\(token, order\.accessToken\)\) \{/);
  const MUTATING_ROUTES = [
    "app.post('/api/orders/:orderId/generate', generationLimiter, requireOrderToken,",
    "app.post('/api/orders/:orderId/regenerate', generationLimiter, requireOrderToken,",
    "app.post('/api/orders/:orderId/variants/:variantId/lyrics', express.json(), requireOrderToken,",
    "app.post('/api/orders/:orderId/select', requireOrderToken,",
    "app.post('/api/orders/:orderId/checkout', requireOrderToken,",
    "app.post('/api/orders/:orderId/media', mediaUploadLimiter, requireOrderToken,",
    "app.post('/api/orders/:orderId/media/multipart/init', mediaUploadLimiter, requireOrderToken,",
    "app.delete('/api/orders/:orderId/media/:index', requireOrderToken,",
    "app.put('/api/orders/:orderId/media/reorder', express.json(), requireOrderToken,",
    "app.post('/api/orders/:orderId/create-video', requireOrderToken,"
  ];
  MUTATING_ROUTES.forEach((sig) => assert.ok(server.includes(sig), `ruta mutabila lipseste/s-a schimbat semnatura: ${sig}`));
});

test('GET /media/full/:orderId (fisierul COMPLET, platit) ramane STRICT protejat prin accessToken/safeCompare — raspunsul by-email nu largeste acest acces', () => {
  const fullMediaSrc = sliceBetween(server, "app.get('/media/full/:orderId', async (req, res, next) => {", '\n});');
  assert.match(fullMediaSrc, /safeCompare/);
  assert.ok(!fullMediaSrc.includes('previewVariantIds'), 'media/full nu trebuie sa aiba nicio legatura cu mecanismul de preview by-email');
});
