// Admin > Comenzi — "Nr. comandă" + "Nr. client" -> "X (N)" (2026-09-26, cerinta explicita).
// Doua concepte separate, deliberat NECONFUNDATE:
//   - Nr. comandă (db.getOrderSequenceNumbers): numerotare cronologica STRICT per COMANDA, peste
//     tot setul filtrat curent (ROW_NUMBER), niciodata doar pagina curenta de 50.
//   - Nr. client (db.getDistinctCustomerRanks, NEATINS) + numarul din paranteza, LIFETIME REAL
//     (db.getLifetimeCustomerOrderCounts) — totalul de comenzi al acelui email, in INTREAGA baza
//     de date, indiferent de pagina/perioada/filtrele curente.
// Acelasi tipar de test ca test/admin-distinct-customer-kpi.test.js — mock pe db.pool.query,
// verificari SQL text + comportament pe randuri simulate, plus verificari statice pe server.js/
// private/admin/orders.js/orders.html (fara DB reala, fara server HTTP pornit).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

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

// ================================================================================================
// (1) db.js#getOrderSequenceNumbers — "Nr. comandă".
// ================================================================================================
test('getOrderSequenceNumbers: foloseste ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) — cronologic, cu tie-breaker determinist pe id', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getOrderSequenceNumbers({});
    const call = calls.find((c) => c.sql.includes('ROW_NUMBER'));
    assert.ok(call, 'trebuie sa existe o interogare cu ROW_NUMBER');
    assert.match(call.sql, /ROW_NUMBER\(\) OVER \(ORDER BY created_at ASC, id ASC\)/);
  });
});

test('getOrderSequenceNumbers: reutilizeaza buildOrdersFilter (ACELASI where/values ca listOrdersPage/countOrders/getDistinctCustomerRanks) — respecta testFilter/perioada/status curente', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getOrderSequenceNumbers({ testFilter: 'real', testEmails: ['test@naluna.dev'], dateFrom: '2026-09-26', dateToExclusive: '2026-09-27' });
    const call = calls.find((c) => c.sql.includes('ROW_NUMBER'));
    assert.match(call.sql, /lower\(email\) != ALL\(\$\d\)/, 'testFilter=real trebuie sa produca aceeasi clauza de excludere ca restul interogarilor');
    assert.match(call.sql, /created_at >= \(\$\d::date AT TIME ZONE 'Europe\/London'\)/);
  });
});

test('getOrderSequenceNumbers: NU grupeaza pe email (e per COMANDA, nu per client) — nicio clauza GROUP BY', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getOrderSequenceNumbers({});
    const call = calls.find((c) => c.sql.includes('ROW_NUMBER'));
    assert.doesNotMatch(call.sql, /GROUP BY/);
  });
});

test('getOrderSequenceNumbers: transforma randurile (id, rnk) intr-un Map id -> numar cronologic (1, 2, 3...), NICIODATA in ordine inversa', async () => {
  const rows = [
    { id: 'order-a', rnk: '1' },
    { id: 'order-b', rnk: '2' },
    { id: 'order-c', rnk: '3' }
  ];
  const map = await withMockPool(() => ({ rows }), () => db.getOrderSequenceNumbers({}));
  assert.equal(map.get('order-a'), 1);
  assert.equal(map.get('order-b'), 2);
  assert.equal(map.get('order-c'), 3);
  assert.equal(typeof map.get('order-a'), 'number');
});

test('getOrderSequenceNumbers: doi clienti diferiti, comenzi multiple fiecare -> numarul de comanda NU se repeta si NU e legat de clientNumber (e STRICT secvential per comanda)', async () => {
  // Simuleaza 5 comenzi: clientul A are 3 comenzi, clientul B are 2 — numarul de comanda
  // trebuie sa fie 1..5, indiferent de cate comenzi are fiecare client (spre deosebire de Nr.
  // client, care ar da acelasi numar de 3 ori pentru clientul A).
  const rows = [
    { id: 'o1', rnk: '1' }, { id: 'o2', rnk: '2' }, { id: 'o3', rnk: '3' },
    { id: 'o4', rnk: '4' }, { id: 'o5', rnk: '5' }
  ];
  const map = await withMockPool(() => ({ rows }), () => db.getOrderSequenceNumbers({}));
  const values = [...map.values()].sort((a, b) => a - b);
  assert.deepEqual(values, [1, 2, 3, 4, 5], 'fiecare comanda trebuie sa aiba propriul numar unic, chiar daca acelasi client revine');
});

// ================================================================================================
// (2) db.js#getLifetimeCustomerOrderCounts — numarul din paranteza "(N)", LIFETIME REAL.
// ================================================================================================
test('getLifetimeCustomerOrderCounts: normalizeaza emailurile primite (lower+trim), dedupleaza, si NU interogheaza deloc daca lista e goala', async () => {
  const result = await withMockPool(() => { throw new Error('nu trebuia apelat pool.query'); }, () => db.getLifetimeCustomerOrderCounts([]));
  assert.deepEqual([...result.entries()], []);
});

test('getLifetimeCustomerOrderCounts: interogheaza lower(trim(email)) = ANY($1), fara NICIUN filtru de perioada/status/paid — LIFETIME real, necontaminat de filtrele curente ale tabelului', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getLifetimeCustomerOrderCounts(['Ana@Exemplu.com']);
    const call = calls[0];
    assert.match(call.sql, /WHERE lower\(trim\(email\)\) = ANY\(\$1\)/);
    assert.doesNotMatch(call.sql, /created_at|paid_at|status =|utm_/, 'nu trebuie sa existe niciun filtru de perioada/status/sursa in interogarea LIFETIME');
  });
});

test('getLifetimeCustomerOrderCounts: emailurile trimise sunt normalizate (lower+trim) INAINTE de a ajunge in interogare — " Ana@Exemplu.com " -> "ana@exemplu.com"', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getLifetimeCustomerOrderCounts([' Ana@Exemplu.com ', 'ana@exemplu.com']);
    const call = calls[0];
    assert.deepEqual(call.params[0], ['ana@exemplu.com'], 'dedup + normalizare — un singur email in interogare, nu doua variante ale aceleiasi adrese');
  });
});

test('getLifetimeCustomerOrderCounts: 5 comenzi ale aceluiasi client -> Map returneaza 5 pentru acel email (sursa formatului "1 (5)")', async () => {
  const map = await withMockPool(
    () => ({ rows: [{ email_key: 'client@exemplu.com', n: '5' }] }),
    () => db.getLifetimeCustomerOrderCounts(['client@exemplu.com'])
  );
  assert.equal(map.get('client@exemplu.com'), 5);
  assert.equal(typeof map.get('client@exemplu.com'), 'number');
});

test('getLifetimeCustomerOrderCounts: un client cu o singura comanda -> 1 (sursa formatului "27 (1)")', async () => {
  const map = await withMockPool(
    () => ({ rows: [{ email_key: 'unic@exemplu.com', n: '1' }] }),
    () => db.getLifetimeCustomerOrderCounts(['unic@exemplu.com'])
  );
  assert.equal(map.get('unic@exemplu.com'), 1);
});

// ================================================================================================
// (3) server.js GET /api/admin/orders — atasare orderNumber/clientLifetimeOrderCount pe fiecare
// comanda, folosind emailurile PAGINII curente (nu tot setul filtrat) pentru LIFETIME.
// ================================================================================================
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractOrdersEndpoint() {
  const idx = serverSrc.indexOf("app.get('/api/admin/orders', async");
  assert.ok(idx !== -1);
  const end = serverSrc.indexOf("\napp.get('/api/admin/orders/filter-options'", idx);
  assert.ok(end !== -1);
  return serverSrc.slice(idx, end);
}

test('server.js GET /api/admin/orders: apeleaza db.getOrderSequenceNumbers(filterArgs) — ACELASI filterArgs ca listOrdersPage/countOrders/getDistinctCustomerRanks', () => {
  const fn = extractOrdersEndpoint();
  assert.match(fn, /db\.getOrderSequenceNumbers\(filterArgs\)/);
});

test('server.js GET /api/admin/orders: apeleaza db.getLifetimeCustomerOrderCounts cu emailurile PAGINII curente (orders.map), NU cu tot setul filtrat', () => {
  const fn = extractOrdersEndpoint();
  assert.match(fn, /db\.getLifetimeCustomerOrderCounts\(orders\.map\(\(o\) => o\.email\)\)/);
});

test('server.js GET /api/admin/orders: fiecare comanda primeste orderNumber din orderSeqNumbers.get(o.id)', () => {
  const fn = extractOrdersEndpoint();
  assert.match(fn, /orderNumber:\s*orderSeqNumbers\.get\(o\.id\)\s*\|\|\s*null/);
});

test('server.js GET /api/admin/orders: fiecare comanda primeste clientLifetimeOrderCount din lifetimeCounts.get(email normalizat)', () => {
  const fn = extractOrdersEndpoint();
  assert.match(fn, /clientLifetimeOrderCount:\s*lifetimeCounts\.get\(emailKey\)\s*\|\|\s*null/);
});

test('server.js GET /api/admin/orders: clientNumber (Nr. client, rangul "X") ramane EXACT neschimbat — tot clientRanks.get(emailKey)', () => {
  const fn = extractOrdersEndpoint();
  assert.match(fn, /clientNumber:\s*clientRanks\.get\(emailKey\)\s*\|\|\s*null/);
});

// ================================================================================================
// (4) private/admin/orders.js — randare "X (N)" + Nr. comandă in prima celula.
// ================================================================================================
const ordersJs = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');

test('renderClientNumberCell: formateaza "X (N)" cand clientNumber exista, folosind clientLifetimeOrderCount (default 1 STRICT defensiv, nu ar trebui sa se intample in practica)', () => {
  const start = ordersJs.indexOf('function renderClientNumberCell(o) {');
  assert.ok(start !== -1, 'renderClientNumberCell trebuie sa existe');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /if \(o\.clientNumber == null\) return '—';/);
  assert.match(fn, /`\$\{o\.clientNumber\} \(\$\{n\}\)`/);
});

test('renderOrderRow: prima celula e Nr. comandă (o.orderNumber), a doua e Nr. client (renderClientNumberCell)', () => {
  assert.match(ordersJs, /<td>\$\{o\.orderNumber != null \? o\.orderNumber : '—'\}<\/td>\s*<td>\$\{renderClientNumberCell\(o\)\}<\/td>/);
});

test('orders.html: antetul tabelului are "Nr. comandă" ca PRIMA coloana, urmata de "Nr. client", inaintea "Data"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  assert.match(html, /<tr><th[^>]*>Nr\. comandă<\/th><th[^>]*>Nr\. client<\/th><th>Data<\/th>/);
});

// ================================================================================================
// Regresie: numarul lifetime nu poate fi calculat pe cele 50 de randuri incarcate ca fallback —
// verificam ca `n` din renderClientNumberCell foloseste STRICT o.clientLifetimeOrderCount (server),
// nu vreo numarare locala pe ordersCache.
// ================================================================================================
test('renderClientNumberCell: NU numara local pe ordersCache — foloseste STRICT campul server-side clientLifetimeOrderCount', () => {
  const start = ordersJs.indexOf('function renderClientNumberCell(o) {');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.doesNotMatch(fn, /ordersCache/, 'nu trebuie sa existe nicio referinta la ordersCache in aceasta functie — ar insemna numarare STRICT pe pagina curenta');
});

test('server.js, db.js, private/admin/orders.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});

// ================================================================================================
// Izolare — Meta Ads Faza A/B, RECOVERY_EMAILS_ENABLED.
// ================================================================================================
test('numerotarea noua nu atinge lib/meta-ads/ sau recovery-emails — niciun require nou catre acele module in orders.js', () => {
  assert.ok(!ordersJs.includes('meta-ads'));
  assert.ok(!ordersJs.includes('recovery-emails'));
});
