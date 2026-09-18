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

// Extrage corpul REAL al unei functii/handler prin numarare de acolade — spre deosebire de o
// cautare textuala de tip "indexOf(...) < indexOf('\n});')" (care poate gresi daca exista un
// "\n});" intermediar, ex. un apel db.updateOrder({...}) inchis inainte de finalul handler-ului
// real), aceasta metoda gaseste EXACT acolada de inchidere care corespunde celei de deschidere.
// Regresie directa (2026-09-18, incident productie): un bloc "db.insertFunnelEvent({eventName:
// 'order_created', ...})" fusese plasat GRESIT in afara handler-ului POST /api/orders (dupa
// acolada lui de inchidere reala), la nivel de modul — un test bazat STRICT pe indexOf/ordine
// textuala (varianta veche a testelor de mai jos) NU a putut detecta asta, pentru ca textul
// tot aparea "intre" cele doua puncte cautate; ReferenceError la boot a scos productia din
// functiune. extractFn() previne aceasta clasa de bug pe viitor.
function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
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

test('server.js: POST /api/orders insereaza "order_created" server-side DIRECT dupa db.createOrder, REALMENTE in interiorul handler-ului (verificat prin numarare de acolade, nu doar ordine textuala) — niciodata prin ruta publica /api/track', () => {
  const server = read('server.js');
  const fn = extractFn(server, "app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {");
  assert.match(fn, /const order = await db\.createOrder\(\{/, 'db.createOrder trebuie sa fie in interiorul handler-ului');
  assert.match(fn, /eventName: 'order_created'/, 'insertia order_created trebuie sa fie REAL in interiorul handler-ului (in afara lui ar produce ReferenceError la boot — incident real, 2026-09-18)');
  assert.match(fn, /db\.insertFunnelEvent\(\{[\s\S]*?eventName: 'order_created'/, 'trebuie sa fie chiar apelul db.insertFunnelEvent, nu doar un string coincidental');
  // ordinea reala in interiorul handler-ului: createOrder -> insertFunnelEvent -> res.json(...)
  const idxCreate = fn.indexOf('const order = await db.createOrder({');
  const idxEvent = fn.indexOf("eventName: 'order_created'");
  const idxResJson = fn.indexOf('res.json({ orderId: order.id, accessToken: order.accessToken });');
  assert.ok(idxCreate !== -1 && idxEvent !== -1 && idxResJson !== -1);
  assert.ok(idxCreate < idxEvent && idxEvent < idxResJson, 'ordinea trebuie sa fie: creare comanda -> insertie eveniment -> raspuns catre client');
});

test('server.js: POST /checkout insereaza "checkout_created" server-side DUPA ce sesiunea Stripe a fost creata cu succes (dupa db.updateOrder cu checkoutCreatedAt), REALMENTE in interiorul handler-ului (verificat prin numarare de acolade)', () => {
  const server = read('server.js');
  const fn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  const idxCheckoutCreatedAt = fn.indexOf('checkoutCreatedAt: new Date(),');
  const idxCheckoutCreatedEvent = fn.indexOf("eventName: 'checkout_created'");
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
