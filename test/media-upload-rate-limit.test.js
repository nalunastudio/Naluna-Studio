// LAUNCH SAFETY (2026-09-01, Faza 3 — vector DoS evident): endpoint-urile de "inceput" ale
// unui upload media (Cadou video) erau protejate STRICT de requireOrderToken (imposibil de
// ghicit, dar fara nicio limita de rata odata cunoscut un token real). part-url/complete NU
// primesc acest limiter — sunt chemate legitim de zeci de ori pentru UN singur videoclip mare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server.js: mediaUploadLimiter e definit (windowMs/max rezonabile, cheie pe IP-ul real)', () => {
  assert.match(server, /const mediaUploadLimiter = rateLimit\(\{/);
  const idx = server.indexOf('const mediaUploadLimiter = rateLimit({');
  const snippet = server.slice(idx, idx + 300);
  assert.match(snippet, /keyGenerator: realClientIp/);
  assert.match(snippet, /max:\s*\d+/);
});

test('server.js: POST /api/orders/:orderId/media (upload direct) foloseste mediaUploadLimiter', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media', mediaUploadLimiter, requireOrderToken/);
});

test('server.js: POST .../media/multipart/init (inceperea unei sesiuni multipart) foloseste mediaUploadLimiter', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/init', mediaUploadLimiter, requireOrderToken/);
});

test('server.js: part-url si complete NU au mediaUploadLimiter (chemate legitim de multe ori pentru un singur videoclip mare — limitarea acolo ar rupe uploadul real)', () => {
  const partUrlIdx = server.indexOf("app.post('/api/orders/:orderId/media/multipart/:sessionId/part-url'");
  const completeIdx = server.indexOf("app.post('/api/orders/:orderId/media/multipart/:sessionId/complete'");
  assert.notEqual(partUrlIdx, -1);
  assert.notEqual(completeIdx, -1);
  assert.ok(!server.slice(partUrlIdx, partUrlIdx + 120).includes('mediaUploadLimiter'));
  assert.ok(!server.slice(completeIdx, completeIdx + 120).includes('mediaUploadLimiter'));
});
