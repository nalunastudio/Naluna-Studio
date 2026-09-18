// FUNNEL ANALYTICS — schema + detalii de completitudine (2026-09-18, FAZA 2). Acopera: schema
// tabelei funnel_events + coloanele noi ale orders (statice, citesc db.js), getFunnelDataCompleteSince
// (mock pool.query), coloana checkout_created_at ("ultima incercare castiga" — acelasi
// comportament, deja stabilit, ca checkout_session_id), si badge-ul "TEST" in raspunsul
// GET /api/admin/orders.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

function readDb() {
  return fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
}
function readServer() {
  return fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
}

async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  db.pool.query = async (sql, params) => dispatch(sql, params);
  try { return await fn(); } finally { db.pool.query = original; }
}

test('db.js: tabela funnel_events are toate coloanele necesare (id, event_name, visitor_id, order_id, utm_*, fbclid, meta, occurred_at) si NICIO coloana de email/PII', () => {
  const src = readDb();
  const match = src.match(/CREATE TABLE IF NOT EXISTS funnel_events \(([\s\S]*?)\);/);
  assert.ok(match, 'tabela funnel_events trebuie sa existe');
  const body = match[1];
  for (const col of ['id UUID PRIMARY KEY', 'event_name TEXT NOT NULL', 'visitor_id TEXT NOT NULL', 'order_id UUID', 'utm_source TEXT', 'utm_campaign TEXT', 'fbclid TEXT', 'meta JSONB', 'occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()']) {
    assert.ok(body.includes(col), `lipseste coloana: ${col}`);
  }
  assert.doesNotMatch(body, /\bemail\b/i);
});

test('db.js: funnel_events are indecsi pe (event_name, occurred_at), visitor_id, order_id si utm_campaign — volum mare asteptat, interogari agregate frecvente pe aceste campuri', () => {
  const src = readDb();
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_funnel_events_name_occurred_at ON funnel_events\(event_name, occurred_at\)/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_funnel_events_visitor_id ON funnel_events\(visitor_id\)/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_funnel_events_order_id ON funnel_events\(order_id\)/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_funnel_events_utm_campaign ON funnel_events\(utm_campaign\)/);
});

test('db.js: orders capata visitor_id + checkout_created_at (ADD COLUMN IF NOT EXISTS — aditiv, niciodata distructiv) cu indecsi pe amandoua, plus index pe paid_at', () => {
  const src = readDb();
  assert.match(src, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS visitor_id TEXT;/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_orders_visitor_id ON orders\(visitor_id\);/);
  assert.match(src, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_created_at TIMESTAMPTZ;/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_orders_checkout_created_at ON orders\(checkout_created_at\);/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders\(paid_at\);/);
});

test('db.js: checkoutCreatedAt e in COLUMN_MAP (updateOrder o poate seta) — "ultima incercare de checkout castiga", acelasi comportament ca checkoutSessionId (deja stabilit, neschimbat aici)', () => {
  const src = readDb();
  assert.match(src, /checkoutCreatedAt: 'checkout_created_at',/);
});

test('getFunnelDataCompleteSince: interogheaza MIN(occurred_at) din funnel_events; fara niciun eveniment inca -> null (niciodata o data inventata)', async () => {
  await withMockPool(
    () => ({ rows: [{ min_at: null }] }),
    async () => {
      const result = await db.getFunnelDataCompleteSince();
      assert.equal(result, null);
    }
  );
});

test('getFunnelDataCompleteSince: cu evenimente existente -> returneaza data reala din DB, neschimbata', async () => {
  await withMockPool(
    () => ({ rows: [{ min_at: '2026-09-18T10:00:00.000Z' }] }),
    async () => {
      const result = await db.getFunnelDataCompleteSince();
      assert.equal(result, '2026-09-18T10:00:00.000Z');
    }
  );
});

test('server.js: GET /api/admin/orders raspunde cu isTestOrder pe fiecare comanda (badge TEST) — STRICT informativ, comanda ramane vizibila si gestionabila normal', () => {
  const src = readServer();
  const routeStart = src.indexOf("app.get('/api/admin/orders'");
  const routeEnd = src.indexOf('\n});', routeStart);
  const body = src.slice(routeStart, routeEnd);
  assert.match(body, /isTestOrder: isTestCustomerEmail\(o\.email\)/);
});

test('server.js: /api/admin/orders/funnel-summary respinge un periodType necunoscut cu 400, NICIODATA o presupunere silentioasa a perioadei curente', () => {
  const src = readServer();
  const routeStart = src.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const routeEnd = src.indexOf('\n});', routeStart);
  const body = src.slice(routeStart, routeEnd);
  assert.match(body, /return res\.status\(400\)\.json\(\{ error: 'periodType invalid/);
  assert.match(body, /catch \(err\) \{\s*return res\.status\(400\)\.json\(\{ error: err\.message \}\);/);
});

test('server.js: /api/admin/orders/funnel-summary trimite ANALYTICS_EXCLUDED_EMAILS catre TOATE cele 4 functii de agregare (kpis/funnel/trend/sources) — o singura sursa de adevar, niciodata cifre calculate cu excluderi diferite in aceeasi pagina', () => {
  const src = readServer();
  const routeStart = src.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const routeEnd = src.indexOf('\n});', routeStart);
  const body = src.slice(routeStart, routeEnd);
  const argsMatch = body.match(/const args = \{([\s\S]*?)\};/);
  assert.ok(argsMatch);
  assert.match(argsMatch[1], /excludeEmails: ANALYTICS_EXCLUDED_EMAILS/);
  for (const fn of ['getFunnelKpis', 'getConversionFunnel', 'getRevenueAndOrdersTrend', 'getTrafficSources']) {
    assert.match(body, new RegExp(`db\\.${fn}\\(args\\)`), `${fn} trebuie apelat cu (args), care contine excludeEmails`);
  }
});
