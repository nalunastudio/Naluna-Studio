// SMART PREVIEW — ADMIN (2026-09-22): sectiunea compacta "Comportament Preview (Smart Preview)"
// din Admin -> Vânzări & Funnel. Acopera: db.getPreviewFunnel/getPreviewDataCompleteSince/
// getPreviewDataAvailability (mock pool.query, acelasi tipar ca test/funnel-schema-and-misc.test.js),
// cablarea in GET /api/admin/orders/funnel-summary, si sectiunea statica din orders.html/orders.js
// (acelasi tipar ca test/admin-creative-performance.test.js — proiectul nu are infrastructura de
// testare vizuala/browser reala).
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
const html = read('private/admin/orders.html');
const js = read('private/admin/orders.js');

async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  db.pool.query = async (sql, params) => dispatch(sql, params);
  try { return await fn(); } finally { db.pool.query = original; }
}

// ================================================================================================
// db.getPreviewFunnel
// ================================================================================================
test('getPreviewFunnel: agrega cele 7 evenimente de preview + checkout dupa preview, prin doua interogari separate (evenimente vs. checkout)', async () => {
  const calls = [];
  await withMockPool(
    (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('COUNT(DISTINCT fe.order_id)')) return { rows: [{ n: '3' }] };
      return { rows: [{ played: '10', p25: '8', p50: '6', p75: '4', p100: '2', completed: '2', replayed: '1' }] };
    },
    async () => {
      const result = await db.getPreviewFunnel({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      assert.deepEqual(result, {
        played: 10, progress25: 8, progress50: 6, progress75: 4, progress100: 2,
        completed: 2, replayed: 1, checkoutAfterPreview: 3
      });
    }
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /FROM funnel_events fe/);
  assert.match(calls[0].sql, /preview_played/);
  assert.match(calls[1].sql, /checkout_created_at IS NOT NULL/);
});

test('getPreviewFunnel: cu excludeEmails, ambele interogari filtreaza pe email-urile de test (acelasi tipar ca restul motorului de funnel)', async () => {
  let sqls = [];
  await withMockPool(
    (sql, params) => { sqls.push(sql); return { rows: [{ played: '0', p25: '0', p50: '0', p75: '0', p100: '0', completed: '0', replayed: '0', n: '0' }] }; },
    async () => {
      await db.getPreviewFunnel({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: ['Test@Naluna.com'] });
    }
  );
  assert.ok(sqls.every((sql) => sql.includes('lower(') && sql.includes('!= ALL(')), 'ambele interogari trebuie sa excluda email-urile de test');
});

test('getPreviewFunnel: fara evenimente inca -> toate valorile 0, niciodata null/eroare', async () => {
  await withMockPool(
    () => ({ rows: [{ played: null, p25: null, p50: null, p75: null, p100: null, completed: null, replayed: null, n: null }] }),
    async () => {
      const result = await db.getPreviewFunnel({ startDate: '2026-09-01', endDateExclusive: '2026-10-01' });
      for (const key of ['played', 'progress25', 'progress50', 'progress75', 'progress100', 'completed', 'replayed', 'checkoutAfterPreview']) {
        assert.equal(result[key], 0);
      }
    }
  );
});

// ================================================================================================
// db.getPreviewDataCompleteSince / getPreviewDataAvailability
// ================================================================================================
test('getPreviewDataCompleteSince: fara niciun eveniment de preview inca -> null (niciodata o data inventata)', async () => {
  await withMockPool(
    (sql) => { assert.match(sql, /event_name IN/); assert.match(sql, /preview_played/); return { rows: [{ min_at: null }] }; },
    async () => {
      const result = await db.getPreviewDataCompleteSince();
      assert.equal(result, null);
    }
  );
});

test('getPreviewDataCompleteSince: cu evenimente -> data reala din DB', async () => {
  await withMockPool(
    () => ({ rows: [{ min_at: '2026-09-22T12:00:00.000Z' }] }),
    async () => {
      const result = await db.getPreviewDataCompleteSince();
      assert.equal(result, '2026-09-22T12:00:00.000Z');
    }
  );
});

test('getPreviewDataAvailability: filtreaza STRICT pe cele 7 evenimente de preview (nu tot funnel_events, spre deosebire de getTrafficDataAvailability)', async () => {
  await withMockPool(
    (sql) => {
      assert.match(sql, /WHERE event_name IN \('preview_played','preview_progress_25','preview_progress_50','preview_progress_75','preview_progress_100','preview_completed','preview_replayed'\)/);
      return { rows: [{ status: 'partial' }] };
    },
    async () => {
      const result = await db.getPreviewDataAvailability('2026-09-01', '2026-10-01');
      assert.equal(result, 'partial');
    }
  );
});

// ================================================================================================
// SERVER — cablare in /api/admin/orders/funnel-summary
// ================================================================================================
test('server.js: GET /api/admin/orders/funnel-summary apeleaza cele 3 functii noi si include preview/previewDataCompleteSince/previewDataAvailability in raspuns', () => {
  const idx = server.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const end = server.indexOf('\n});', idx);
  const body = server.slice(idx, end);
  assert.match(body, /db\.getPreviewFunnel\(args\)/);
  assert.match(body, /db\.getPreviewDataCompleteSince\(\)/);
  assert.match(body, /db\.getPreviewDataAvailability\(bounds\.startDate, bounds\.endDateExclusive\)/);
  assert.match(body, /preview,/);
  assert.match(body, /previewDataCompleteSince,/);
  assert.match(body, /previewDataAvailability/);
});

test('server.js: NICIO cifra de cost Meta (Spend/CPA/ROAS) in blocul Smart Preview al endpoint-ului funnel-summary', () => {
  const idx = server.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const end = server.indexOf('\n});', idx);
  const body = server.slice(idx, end);
  for (const forbidden of ['Spend', 'CPA', 'ROAS']) {
    assert.ok(!body.includes(forbidden), `endpoint-ul funnel-summary nu trebuie sa contina "${forbidden}"`);
  }
});

// ================================================================================================
// ADMIN UI — orders.html / orders.js (static, acelasi tipar ca admin-creative-performance.test.js)
// ================================================================================================
test('orders.html: sectiunea "Comportament Preview (Smart Preview)" exista, DUPA "Performanța creativelor" si INAINTE de tabelul de Comenzi', () => {
  const creativesIdx = html.indexOf('Performanța creativelor');
  const previewIdx = html.indexOf('Comportament Preview (Smart Preview)');
  const ordersTableIdx = html.indexOf('<!-- Orders Table -->');
  assert.ok(creativesIdx !== -1);
  assert.ok(previewIdx !== -1, 'sectiunea noua trebuie sa existe');
  assert.ok(ordersTableIdx !== -1);
  assert.ok(creativesIdx < previewIdx, 'sectiunea Smart Preview trebuie sa fie DUPA Performanța creativelor');
  assert.ok(previewIdx < ordersTableIdx, 'sectiunea Smart Preview trebuie sa fie INAINTE de tabelul de Comenzi');
  assert.match(html, /<div class="stats kpi-grid" id="preview-cards">/);
  assert.match(html, /<div id="preview-partial-note">/);
});

test('orders.js: PREVIEW_DEFS acopera toate cele 8 valori cerute (played/25/50/75/100/completed/replayed/checkoutAfterPreview)', () => {
  const idx = js.indexOf('const PREVIEW_DEFS = [');
  assert.ok(idx !== -1);
  const end = js.indexOf('];', idx);
  const block = js.slice(idx, end);
  for (const key of ['played', 'progress25', 'progress50', 'progress75', 'progress100', 'completed', 'replayed', 'checkoutAfterPreview']) {
    assert.match(block, new RegExp(`key: '${key}'`), `lipseste cheia: ${key}`);
  }
});

test('orders.js: renderPreviewSection() afiseaza STRICT "Nemăsurat" pentru toate cardurile cand previewDataAvailability === "unmeasured", niciodata 0 fals', () => {
  const fnStart = js.indexOf('function renderPreviewSection(');
  assert.ok(fnStart !== -1);
  const fnEnd = js.indexOf('\nfunction ', fnStart + 10);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /previewDataAvailability === 'unmeasured'/);
  assert.match(fn, /Nemăsurat/);
});

test('orders.js: renderPreviewSection() afiseaza o nota "Date parțiale" cand previewDataAvailability === "partial", cu sursa STRICT previewDataCompleteSince (nu dataCompleteSince general)', () => {
  const fnStart = js.indexOf('function renderPreviewSection(');
  const fnEnd = js.indexOf('\nfunction ', fnStart + 10);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /previewDataAvailability === 'partial'/);
  assert.match(fn, /formatPartialNote\(previewDataCompleteSince\)/);
});

test('orders.js: loadFunnelSummary() apeleaza renderPreviewSection(data.preview, data.previewDataAvailability, data.previewDataCompleteSince)', () => {
  // CORECTIE (2026-09-25, auto-refresh KPI): semnatura a capatat un parametru optional
  // ({ silent = false } = {}) — cautam STRICT prefixul stabil al declaratiei.
  const loadIdx = js.indexOf('async function loadFunnelSummary(');
  assert.ok(loadIdx !== -1);
  const loadEnd = js.indexOf('\n}', loadIdx);
  const loadBody = js.slice(loadIdx, loadEnd);
  assert.match(loadBody, /renderPreviewSection\(data\.preview,\s*data\.previewDataAvailability,\s*data\.previewDataCompleteSince\)/);
});
