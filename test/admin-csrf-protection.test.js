// AUDIT PRE-LAUNCH (2026-09-13, Faza A1 — CSRF): /api/admin/* foloseste HTTP Basic Auth, reatasat
// automat de browser la orice cerere ulterioara catre aceeasi origine (spre deosebire de un cookie
// de sesiune, fara nicio limitare SameSite). Actiuni distructive/operationale (anonymize, retention
// purge/expire, retry-extras, testimonials POST) sunt POST-uri fara body obligatoriu — exact
// tiparul pe care un formular HTML cross-origin (sau un fetch cu Content-Type "simplu") il poate
// declansa fara sa activeze un preflight CORS, daca adminul are Basic Auth cache-uit in browser.
// Reparatie: middleware nou care cere explicit header-ul X-Requested-With pentru orice metoda care
// schimba starea (POST/PUT/DELETE/PATCH) pe /api/admin/* — un formular HTML simplu NU poate seta
// headere custom, iar un fetch cross-origin cu acest header declanseaza un preflight CORS respins
// (fara politica CORS configurata pe server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin.html'), 'utf8');

test('server.js: middleware-ul CSRF pentru /api/admin este inregistrat DUPA requireAdminAuth (autentificare intai) si INAINTE de toate rutele mutabile', () => {
  const authIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth);");
  const csrfIdx = server.indexOf("if (req.get('X-Requested-With') !== 'XMLHttpRequest')");
  const firstRouteIdx = server.indexOf("app.post('/api/admin/orders/:orderId/anonymize'");
  assert.ok(authIdx !== -1 && csrfIdx !== -1 && firstRouteIdx !== -1);
  assert.ok(authIdx < csrfIdx, 'auth trebuie sa ruleze inainte de verificarea CSRF');
  assert.ok(csrfIdx < firstRouteIdx, 'verificarea CSRF trebuie sa ruleze inainte de rutele mutabile');
});

test('server.js: middleware-ul CSRF respinge (403) metodele mutabile fara X-Requested-With, dar lasa GET/HEAD/OPTIONS neatinse', () => {
  const idx = server.indexOf("app.use('/api/admin', (req, res, next) => {");
  const end = server.indexOf('});', idx) + 3;
  const body = server.slice(idx, end);
  assert.match(body, /if \(\['GET', 'HEAD', 'OPTIONS'\]\.includes\(req\.method\)\) return next\(\);/);
  assert.match(body, /req\.get\('X-Requested-With'\) !== 'XMLHttpRequest'/);
  assert.match(body, /res\.status\(403\)/);
});

test("admin.html: toate cele 3 cereri mutabile (DELETE testimonial, POST move, POST/PUT create-edit) trimit explicit X-Requested-With: XMLHttpRequest", () => {
  const deleteCall = adminHtml.slice(adminHtml.indexOf('window.deleteTestimonial'), adminHtml.indexOf('window.deleteTestimonial') + 300);
  assert.match(deleteCall, /'X-Requested-With': 'XMLHttpRequest'/, 'DELETE trebuie sa trimita header-ul');

  const moveCall = adminHtml.slice(adminHtml.indexOf('window.moveTestimonial'), adminHtml.indexOf('window.moveTestimonial') + 300);
  assert.match(moveCall, /'X-Requested-With': 'XMLHttpRequest'/, 'POST move trebuie sa trimita header-ul');

  const submitCall = adminHtml.slice(adminHtml.indexOf('const res = await fetch(url, { method,'), adminHtml.indexOf('const res = await fetch(url, { method,') + 200);
  assert.match(submitCall, /'X-Requested-With': 'XMLHttpRequest'/, 'formularul de creare/editare trebuie sa trimita header-ul');
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
