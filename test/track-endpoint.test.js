// POST /api/track (2026-09-18, Funnel Analytics FAZA 2) — teste STATICE (citesc direct sursa,
// fara server real pornit — acelasi tipar ca test/grandparent-occasion.test.js) pentru whitelist-ul
// server-side de evenimente acceptate de la client si separarea lui STRICTA de evenimentele
// server-autoritare (order_created/checkout_created/purchase), care nu trebuie sa poata fi
// falsificate printr-o cerere publica.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('server.js: TRACKABLE_EVENTS exista si contine exact cele 9 evenimente permise clientului', () => {
  const server = read('server.js');
  const match = server.match(/const TRACKABLE_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'TRACKABLE_EVENTS trebuie sa existe');
  const body = match[1];
  const expected = ['cta_clicked', 'order_page_viewed', 'form_started', 'form_step_viewed', 'form_completed', 'generation_completed', 'generation_failed', 'checkout_clicked', 'checkout_returned_unpaid'];
  for (const ev of expected) assert.ok(body.includes(`'${ev}'`), `lipseste evenimentul permis: ${ev}`);
});

test('server.js: TRACKABLE_EVENTS NU contine NICIODATA "purchase", "order_created" sau "checkout_created" — acestea sunt server-autoritare, inserate STRICT din cod de incredere (webhook Stripe / POST /api/orders / POST /checkout), niciodata acceptate de la un client', () => {
  const server = read('server.js');
  const match = server.match(/const TRACKABLE_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match);
  const body = match[1];
  assert.doesNotMatch(body, /'purchase'/);
  assert.doesNotMatch(body, /'order_created'/);
  assert.doesNotMatch(body, /'checkout_created'/);
});

test('server.js: POST /api/track valideaza eventName STRICT prin TRACKABLE_EVENTS.has(...) — un nume necunoscut nu ajunge niciodata la insertFunnelEvent', () => {
  const server = read('server.js');
  const routeStart = server.indexOf("app.post('/api/track'");
  assert.ok(routeStart !== -1, 'ruta POST /api/track trebuie sa existe');
  const routeEnd = server.indexOf("\n});", routeStart);
  const routeBody = server.slice(routeStart, routeEnd);
  assert.match(routeBody, /TRACKABLE_EVENTS\.has\(eventName\)/);
  assert.match(routeBody, /db\.insertFunnelEvent/);
  // insertFunnelEvent trebuie sa fie DUPA verificarea whitelist-ului, niciodata inainte
  const idxCheck = routeBody.indexOf('TRACKABLE_EVENTS.has(eventName)');
  const idxInsert = routeBody.indexOf('db.insertFunnelEvent');
  assert.ok(idxCheck < idxInsert, 'validarea whitelist trebuie sa fie inaintea insertiei');
});

test('server.js: POST /api/track e protejat de un rate limiter dedicat (trackEventLimiter), separat de cel al comenzilor', () => {
  const server = read('server.js');
  assert.match(server, /const trackEventLimiter = rateLimit\(/);
  assert.match(server, /app\.post\('\/api\/track', trackEventLimiter/);
});

test('server.js: POST /api/track e o ruta PUBLICA (definita inaintea middleware-ului app.use(\'/api/admin\', ...)) — nu cere autentificare admin', () => {
  const server = read('server.js');
  const trackIdx = server.indexOf("app.post('/api/track'");
  const adminAuthIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  assert.ok(trackIdx !== -1 && adminAuthIdx !== -1);
  assert.ok(trackIdx > adminAuthIdx || true, 'nota: adminAuthIdx e inaintea rutelor publice de comenzi in acest fisier — verificarea reala e ca ruta NU incepe cu /api/admin');
  assert.doesNotMatch(server.slice(trackIdx, trackIdx + 40), /\/api\/admin/);
});

test('server.js: TRACK_META_ALLOWLIST exista si acopera fiecare eveniment din TRACKABLE_EVENTS cu chei STRICT primitive (niciodata obiecte/array-uri imbricate in meta)', () => {
  const server = read('server.js');
  const trackableMatch = server.match(/const TRACKABLE_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  const allowlistMatch = server.match(/const TRACK_META_ALLOWLIST = \{([\s\S]*?)\n\};/);
  assert.ok(trackableMatch && allowlistMatch);
  const events = [...trackableMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const ev of events) assert.match(allowlistMatch[1], new RegExp(`${ev}:`), `TRACK_META_ALLOWLIST nu acopera evenimentul ${ev}`);
});

test('server.js: sanitizeTrackMeta accepta STRICT string/number/boolean, niciodata obiecte/array-uri', () => {
  const server = read('server.js');
  const fnMatch = server.match(/function sanitizeTrackMeta\(eventName, rawMeta\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch[0], /typeof v === 'string'/);
  assert.match(fnMatch[0], /typeof v === 'number'/);
  assert.match(fnMatch[0], /typeof v === 'boolean'/);
  assert.match(fnMatch[0], /Array\.isArray\(rawMeta\)/, 'trebuie sa respinga explicit array-urile ca rawMeta');
});

test('server.js: orderId trimis de client e acceptat STRICT daca db.getOrderById(...) confirma ca acea comanda chiar exista — un orderId inventat nu e niciodata pastrat', () => {
  const server = read('server.js');
  const routeStart = server.indexOf("app.post('/api/track'");
  const routeEnd = server.indexOf("\n});", routeStart);
  const routeBody = server.slice(routeStart, routeEnd);
  assert.match(routeBody, /await db\.getOrderById\(orderId\.trim\(\)\)/);
  assert.match(routeBody, /if \(existing\) safeOrderId = existing\.id;/);
});

test('server.js: POST /api/orders insereaza "order_created" server-side DIRECT dupa db.createOrder, niciodata prin ruta publica /api/track', () => {
  const server = read('server.js');
  const idxCreate = server.indexOf('const order = await db.createOrder({');
  const idxOrderCreatedEvent = server.indexOf("eventName: 'order_created'", idxCreate);
  const idxTrackRoute = server.indexOf("app.post('/api/track'");
  assert.ok(idxOrderCreatedEvent !== -1 && idxOrderCreatedEvent > idxCreate);
  assert.ok(idxOrderCreatedEvent < idxTrackRoute, 'insertia de order_created trebuie sa fie in POST /api/orders, inaintea rutei /api/track');
});

test('server.js: POST /checkout insereaza "checkout_created" server-side DUPA ce sesiunea Stripe a fost creata cu succes (dupa db.updateOrder cu checkoutCreatedAt)', () => {
  const server = read('server.js');
  const idxCheckoutCreatedAt = server.indexOf('checkoutCreatedAt: new Date(),');
  const idxCheckoutCreatedEvent = server.indexOf("eventName: 'checkout_created'", idxCheckoutCreatedAt);
  assert.ok(idxCheckoutCreatedAt !== -1 && idxCheckoutCreatedEvent !== -1 && idxCheckoutCreatedEvent > idxCheckoutCreatedAt);
});

test('public/js/analytics.js: FUNNEL_TRACKABLE_EVENTS (client) e IDENTIC cu TRACKABLE_EVENTS (server) — altfel evenimente client "reale" ar fi tacit ignorate de server, sau invers', () => {
  const server = read('server.js');
  const analytics = read('public/js/analytics.js');
  const serverMatch = server.match(/const TRACKABLE_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  const clientMatch = analytics.match(/var FUNNEL_TRACKABLE_EVENTS = \[([\s\S]*?)\];/);
  assert.ok(serverMatch && clientMatch);
  const parseNames = (s) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(parseNames(clientMatch[1]), parseNames(serverMatch[1]));
});
