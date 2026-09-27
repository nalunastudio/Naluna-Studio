// SECTIUNEA E (2026-09-27, cerinta explicita): retentie pentru comenzi NEPLATITE — 7 zile,
// COMPLET SEPARATA de retentia comenzilor PLATITE (CONTENT_RETENTION_DAYS=30, neschimbata) si
// de generation quota (client_generation_cycles, neatinsa de acest job).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');

async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  const calls = [];
  db.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return dispatch(sql, params);
  };
  try {
    return await fn(calls);
  } finally {
    db.pool.query = original;
  }
}

// ===============================================================================================
// (1) Schema — additiv, fara migrare distructiva.
// ===============================================================================================
test('db.js: unpaid_expired_at e adaugat STRICT additiv (ALTER TABLE ... ADD COLUMN IF NOT EXISTS)', () => {
  const dbSrc = read('db.js');
  assert.match(dbSrc, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS unpaid_expired_at TIMESTAMPTZ;/);
});

// ===============================================================================================
// (2) findOrdersEligibleForUnpaidExpiry — forma exacta a interogarii.
// ===============================================================================================
test('findOrdersEligibleForUnpaidExpiry: exclude status=ready (retentia platita e SEPARATA), exclude deja expirate, exclude regenerare activa, filtreaza pe created_at (nu paid_at — comenzile neplatite nu au paid_at)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    const cutoff = new Date('2026-09-20T00:00:00Z');
    await db.findOrdersEligibleForUnpaidExpiry(cutoff);
    const call = calls[0];
    assert.match(call.sql, /status <> 'ready'/);
    assert.match(call.sql, /unpaid_expired_at IS NULL/);
    assert.match(call.sql, /regeneration_status IS DISTINCT FROM 'running'/);
    assert.match(call.sql, /created_at < \$1/);
    assert.ok(!/paid_at/.test(call.sql), 'nu trebuie sa filtreze dupa paid_at — comenzile neplatite nu au niciodata paid_at setat');
    assert.deepEqual(call.params, [cutoff]);
  });
});

// ===============================================================================================
// (3) expireUnpaidOrder — soft-expire, NICIODATA sterge randul (fara risc FK).
// ===============================================================================================
test('expireUnpaidOrder: UPDATE (nu DELETE) — goleste variants+uploaded_media, seteaza unpaid_expired_at=now(), NU atinge story/recipient/email/pret/status', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.expireUnpaidOrder('order-1', [{ id: 'v1' }]);
    const call = calls[0];
    assert.match(call.sql, /^\s*UPDATE orders SET/);
    assert.ok(!/DELETE/i.test(call.sql));
    assert.match(call.sql, /variants = \$2::jsonb/);
    assert.match(call.sql, /uploaded_media = '\[\]'::jsonb/);
    assert.match(call.sql, /unpaid_expired_at = now\(\)/);
    assert.ok(!/story|recipient|email|price|status =/i.test(call.sql), 'nu trebuie sa atinga story/recipient/email/pret/status');
  });
});

// ===============================================================================================
// (4) server.js — jobul expireStaleUnpaidOrders(): sterge fisiere reale, sare randari active,
// foloseste UNPAID_ORDER_RETENTION_DAYS=7 (NU CONTENT_RETENTION_DAYS=30).
// ===============================================================================================
test('server.js: UNPAID_ORDER_RETENTION_DAYS = 7 (constanta SEPARATA de CONTENT_RETENTION_DAYS=30)', () => {
  assert.match(server, /const UNPAID_ORDER_RETENTION_DAYS = 7;/);
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/);
});

function extractFn(src, signature) {
  const idx = src.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 0, i = src.indexOf('{', idx);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(idx, i + 1);
}

test('server.js: expireStaleUnpaidOrders() calculeaza cutoff-ul STRICT din UNPAID_ORDER_RETENTION_DAYS, apeleaza db.findOrdersEligibleForUnpaidExpiry si db.expireUnpaidOrder', () => {
  const body = extractFn(server, 'async function expireStaleUnpaidOrders() {');
  assert.match(body, /UNPAID_ORDER_RETENTION_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.match(body, /db\.findOrdersEligibleForUnpaidExpiry\(cutoff\)/);
  assert.match(body, /db\.expireUnpaidOrder\(order\.id, newVariants\)/);
});

test('server.js: expireStaleUnpaidOrders() sterge fisierele reale (variants: fullKey/previewKey/videoKey/videoPreviewKey/wavKey SI uploadedMedia.key) prin storage.deletePrivateFile, izolat per fisier', () => {
  const body = extractFn(server, 'async function expireStaleUnpaidOrders() {');
  for (const key of ['fullKey', 'previewKey', 'videoKey', 'videoPreviewKey', 'wavKey']) {
    assert.match(body, new RegExp(`v\\.${key}`), `trebuie sa stearga ${key}`);
  }
  assert.match(body, /order\.uploadedMedia \|\| \[\]/, 'trebuie sa curete si materialele sursa incarcate (Cadou Video pre-plata)');
  assert.match(body, /storage\.deletePrivateFile\(key\)/);
});

test('server.js: expireStaleUnpaidOrders() sare o comanda cu randare video ACTIVA (isVideoRenderActiveForOrder), aceeasi garda ca retentia platita', () => {
  const body = extractFn(server, 'async function expireStaleUnpaidOrders() {');
  assert.match(body, /if \(await isVideoRenderActiveForOrder\(order\)\) \{ skipped\+\+; continue; \}/);
});

test('server.js: jobul ruleaza IMEDIAT la boot SI la fiecare 24h (acelasi tipar ca celelalte 4 joburi de retentie)', () => {
  assert.match(server, /expireStaleUnpaidOrders\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(server, /setInterval\(\(\) => \{ expireStaleUnpaidOrders\(\)\.catch\(\(\) => \{\}\); \}, 24 \* 60 \* 60 \* 1000\)\.unref\(\);/);
});

// ===============================================================================================
// (5) Comanda expirata nu mai acorda acces — 404 identic cu "nu exista", NICIODATA o stare
// distincta care ar putea trada existenta anterioara a comenzii.
// ===============================================================================================
test('server.js: requireOrderToken respinge (404 generic) o comanda cu unpaid_expired_at setat si status != ready', () => {
  const body = extractFn(server, 'async function requireOrderToken(req, res, next) {');
  assert.match(body, /if \(order\.unpaidExpiredAt && order\.status !== 'ready'\)/);
  assert.match(body, /return res\.status\(404\)\.json\(\{ error: 'Comanda nu există' \}\);/);
});

test("server.js: GET /api/orders/access/:token respinge (404 generic, identic cu 'nicio comanda gasita') o comanda expirata neplatita", () => {
  const idx = server.indexOf("app.get('/api/orders/access/:token'");
  const end = server.indexOf('\n});', idx) + 4;
  const body = server.slice(idx, end);
  assert.match(body, /if \(order\.unpaidExpiredAt && order\.status !== 'ready'\)/);
});

test("server.js: GET /api/orders/:orderId respinge (404 generic) o comanda expirata neplatita", () => {
  const idx = server.indexOf("app.get('/api/orders/:orderId', async");
  const end = server.indexOf('\n});', idx) + 4;
  const body = server.slice(idx, end);
  assert.match(body, /if \(order\.unpaidExpiredAt && order\.status !== 'ready'\)/);
});

test('db.js: rowToOrder expune unpaidExpiredAt (row.unpaid_expired_at) — necesar rutelor de mai sus', () => {
  const dbSrc = read('db.js');
  assert.match(dbSrc, /unpaidExpiredAt: row\.unpaid_expired_at \|\| null/);
});

// ===============================================================================================
// (6) getEligibleOrdersForAccessRecovery (email recovery, sectiunea M) exclude si el comenzile
// expirate — o comanda care nu mai acorda acces prin token nu trebuie sa apara nici in emailul
// de recuperare.
// ===============================================================================================
test('getEligibleOrdersForAccessRecovery: exclude STRICT unpaid_expired_at IS NOT NULL, alaturi de excluderile deja existente (draft/generation_failed/ready expirat)', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getEligibleOrdersForAccessRecovery('client@exemplu.ro');
    const call = calls[0];
    assert.match(call.sql, /unpaid_expired_at IS NULL/);
  });
});

// ===============================================================================================
// (7) Fara interactiune cu generation quota — cleanup-ul nu atinge NICIODATA
// client_generation_cycles, si nu reseteaza/bypasseaza quota.
// ===============================================================================================
test('server.js: expireStaleUnpaidOrders() NU atinge NICIODATA client_generation_cycles (mecanisme complet independente)', () => {
  const body = extractFn(server, 'async function expireStaleUnpaidOrders() {');
  assert.ok(!/client_generation_cycles/.test(body));
});

test('db.js: findOrdersEligibleForUnpaidExpiry si expireUnpaidOrder NU ating client_generation_cycles', () => {
  const dbSrc = read('db.js');
  const idx1 = dbSrc.indexOf('async function findOrdersEligibleForUnpaidExpiry(');
  const idx2 = dbSrc.indexOf('async function expireUnpaidOrder(');
  const end2 = dbSrc.indexOf('\n}', idx2) + 2;
  const combined = dbSrc.slice(idx1, end2);
  assert.ok(!/client_generation_cycles/.test(combined));
});

// ===============================================================================================
// (8) Nu afecteaza retentia platita — CONTENT_RETENTION_DAYS/paid_at raman neschimbate,
// findOrdersEligibleForFinalMediaExpiry/expireOrderFinalMedia neatinse.
// ===============================================================================================
test('server.js/db.js: retentia PLATITA (CONTENT_RETENTION_DAYS=30, paid_at, findOrdersEligibleForFinalMediaExpiry/expireOrderFinalMedia) ramane complet neschimbata', () => {
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/);
  const dbSrc = read('db.js');
  assert.match(dbSrc, /AND paid_at IS NOT NULL AND paid_at < \$1/);
  assert.match(dbSrc, /final_media_expired_at = now\(\)/);
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
