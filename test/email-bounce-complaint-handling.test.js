// LAUNCH SAFETY (2026-09-01, Faza 6 — bounce/complaint handling production-safe): verifica
// STRUCTURAL noul webhook Resend (acelasi tipar de testare folosit deja pentru webhook-ul
// Stripe in acest proiect — o pornire reala a serverului ar necesita o conexiune Postgres
// reala, nedisponibila la teste unitare). Verificarea END-TO-END REALA (semnatura svix reala,
// adresele de test bounced@resend.dev/complained@resend.dev) se face separat, dupa ce webhook-ul
// e configurat in dashboard-ul Resend (necesita RESEND_WEBHOOK_SECRET real).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

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

const server = read('server.js');
const db = read('db.js');

test('server.js: ruta /api/resend/webhook exista, monteaza express.raw INAINTE de verificare (svix cere raw body, la fel ca Stripe)', () => {
  const idx = server.indexOf("app.post('/api/resend/webhook'");
  assert.notEqual(idx, -1);
  const routeDecl = server.slice(idx, idx + 200);
  assert.match(routeDecl, /express\.raw\(\{\s*type:\s*'application\/json'\s*\}\)/);
});

test('server.js: verifica semnatura svix cu cele 3 headere corecte (svix-id/svix-timestamp/svix-signature), respinge cu 400 la semnatura invalida', () => {
  const idx = server.indexOf("app.post('/api/resend/webhook'");
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  assert.match(fn, /new Webhook\(process\.env\.RESEND_WEBHOOK_SECRET\)/);
  assert.match(fn, /'svix-id':\s*req\.headers\['svix-id'\]/);
  assert.match(fn, /'svix-timestamp':\s*req\.headers\['svix-timestamp'\]/);
  assert.match(fn, /'svix-signature':\s*req\.headers\['svix-signature'\]/);
  assert.match(fn, /res\.status\(400\)\.json\(\{ error: 'Webhook Error: invalid signature' \}\)/);
});

test('server.js: fara RESEND_WEBHOOK_SECRET configurat, webhook-ul refuza explicit (503), niciodata nu accepta implicit fara verificare', () => {
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  assert.match(fn, /if\s*\(!process\.env\.RESEND_WEBHOOK_SECRET\)\s*\{[\s\S]*?res\.status\(503\)/);
});

test('server.js: dedup prin db.recordResendEventIfNew(svix-id) INAINTE de a actiona pe eveniment — reincercarile svix nu proceseaza de doua ori', () => {
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  assert.match(fn, /db\.recordResendEventIfNew\(eventId\)/);
  assert.match(fn, /if\s*\(!isNew\)\s*\{\s*return res\.json\(\{ received: true, duplicate: true \}\);/);
});

test('server.js: suprima STRICT pe email.bounced CU bounce.type==="Permanent", si pe email.complained — niciun alt caz nu suprima', () => {
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  // CORECȚIE (2026-09-02, gasita prin testare REALA cu bounced@resend.dev): payload-ul REAL
  // Resend pentru email.bounced contine data.bounce.type ('Permanent' SAU 'Transient') — acelasi
  // tip de eveniment poate fi un bounce TEMPORAR. Suprimarea trebuie sa verifice explicit
  // bounceType === 'Permanent', nu doar event.type === 'email.bounced'.
  assert.match(fn, /const bounceType = event\?\.data\?\.bounce\?\.type \|\| null;/);
  assert.match(fn, /event\.type === 'email\.bounced' && recipientEmail && bounceType === 'Permanent'/);
  assert.match(fn, /event\.type === 'email\.complained'/);
  assert.ok(!fn.includes("'email.delivery_delayed'"), 'nu trebuie sa existe nicio ramura care actioneaza explicit pe delivery_delayed');
  assert.match(fn, /db\.addEmailSuppression\(recipientEmail, 'email\.bounced:Permanent'\)/);
  assert.match(fn, /db\.addEmailSuppression\(recipientEmail, 'email\.complained'\)/);
});

test('server.js: un bounce NEPERMANENT (bounce.type absent sau "Transient") NU suprima, chiar daca event.type === "email.bounced"', () => {
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  assert.match(fn, /else if\s*\(event\.type === 'email\.bounced' && recipientEmail\)\s*\{\s*console\.warn/, 'trebuie sa existe o ramura explicita pentru bounce NEPERMANENT, care doar logheaza, fara sa suprime');
});

test('server.js: JSON.parse(req.body) se face DUPA verificarea semnaturii svix, niciodata din valoarea de retur a wh.verify() (care e mereu undefined — verificat direct in sursa svix)', () => {
  const fn = extractFn(server, "app.post('/api/resend/webhook', express.raw({ type: 'application/json' }), async (req, res) => {");
  assert.match(fn, /wh\.verify\(req\.body,/);
  assert.match(fn, /event = JSON\.parse\(req\.body\.toString\('utf8'\)\);/);
});

test('server.js: sendDeliveryEmail() verifica db.isEmailSuppressed() INAINTE de a trimite, si se opreste (fara sa arunce, fara sa trimita) daca adresa e suprimata', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  assert.match(fn, /db\.isEmailSuppressed\(order\.email\)/);
  assert.match(fn, /if\s*\(suppressed\)\s*\{[\s\S]*?return;/);
});

test('db.js: email_suppressions si processed_resend_events sunt tabele reale, create idempotent (CREATE TABLE IF NOT EXISTS)', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS email_suppressions \(/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS processed_resend_events \(/);
});

test('db.js: isEmailSuppressed/addEmailSuppression/recordResendEventIfNew sunt exportate', () => {
  assert.match(db, /module\.exports = \{[\s\S]*recordResendEventIfNew[\s\S]*addEmailSuppression[\s\S]*isEmailSuppressed/);
});

test('db.js: addEmailSuppression normalizeaza email-ul (lowercase/trim) inainte de a-l stoca, ca sa nu existe duplicate din diferente de capitalizare', () => {
  const fn = extractFn(db, 'async function addEmailSuppression(email, reason) {');
  assert.match(fn, /email\.toLowerCase\(\)\.trim\(\)/);
});

test('package.json: svix e o dependenta reala (nu doar folosita in cod fara sa fie instalata)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies && pkg.dependencies.svix, 'svix trebuie sa fie in package.json dependencies');
});
