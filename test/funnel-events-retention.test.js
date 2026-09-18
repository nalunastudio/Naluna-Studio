// RETENTIE funnel_events — 180 de zile (2026-09-18, cerinta explicita). Acopera atat db.js
// (db.deleteFunnelEventsOlderThan, cu un simulator in-memory al DELETE-ului real, ca sa verificam
// exact comportamentul la granita celor 180 de zile — fara Postgres local disponibil) cat si
// server.js (purgeStaleFunnelEvents/job zilnic/ruta admin manuala), STATIC — acelasi tipar ca
// celelalte 3 job-uri de retentie deja existente (vezi test/legal-consent-and-pages.test.js).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// Simulator in-memory al `DELETE FROM funnel_events WHERE occurred_at < $1` — reproduce EXACT
// semantica reala a comparatiei Postgres (`<` STRICT, nu `<=`) pe un set de randuri fake, ca sa
// putem verifica granita exacta (o data egala cu cutoff-ul NU trebuie stearsa) fara o baza de
// date reala. Orice interogare care NU se potriveste acestui tipar exact e respinsa (eroare) —
// garanteaza ca testul chiar exercita SQL-ul real emis de db.js, nu un mock generic care ar trece
// indiferent ce ar scrie functia.
function withFakeFunnelEventsTable(initialRows, fn) {
  let rows = initialRows.map((r) => ({ ...r }));
  const queryLog = [];
  const original = db.pool.query.bind(db.pool);
  db.pool.query = async (sql, params) => {
    queryLog.push({ sql, params });
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'DELETE FROM funnel_events WHERE occurred_at < $1') {
      const cutoff = params[0];
      const before = rows.length;
      rows = rows.filter((r) => !(r.occurred_at < cutoff));
      return { rowCount: before - rows.length };
    }
    throw new Error('Interogare neasteptata in acest test: ' + normalized);
  };
  return Promise.resolve()
    .then(() => fn({ getRows: () => rows, queryLog }))
    .finally(() => { db.pool.query = original; });
}

const DAY_MS = 24 * 60 * 60 * 1000;

test('deleteFunnelEventsOlderThan: eveniment MAI VECHI de 180 zile -> sters', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const oldEvent = { id: 'e1', occurred_at: new Date(cutoff.getTime() - DAY_MS) }; // 181 zile
  await withFakeFunnelEventsTable([oldEvent], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 1);
    assert.equal(getRows().length, 0);
  });
});

test('deleteFunnelEventsOlderThan: eveniment MAI NOU de 180 zile -> PASTRAT', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const recentEvent = { id: 'e2', occurred_at: new Date(cutoff.getTime() + DAY_MS) }; // 179 zile
  await withFakeFunnelEventsTable([recentEvent], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 0);
    assert.equal(getRows().length, 1);
  });
});

test('CRITIC — eveniment EXACT la limita de 180 zile (occurred_at === cutoff) -> PASTRAT (comparatia e STRICT "<", nu "<=" — "mai vechi de 180 zile" inseamna strict mai vechi, nu "180 zile sau mai vechi")', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const exactlyAtLimit = { id: 'e3', occurred_at: new Date(cutoff.getTime()) };
  await withFakeFunnelEventsTable([exactlyAtLimit], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 0, 'un eveniment exact la limita NU trebuie sters');
    assert.equal(getRows().length, 1);
  });
});

test('un eveniment o milisecunda DUPA limita (chiar peste cutoff) -> sters', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const oneMsOver = { id: 'e4', occurred_at: new Date(cutoff.getTime() - 1) };
  await withFakeFunnelEventsTable([oneMsOver], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 1);
    assert.equal(getRows().length, 0);
  });
});

test('eveniment CU order_id, mai vechi de 180 zile -> sters IDENTIC ca unul fara order_id (legatura cu o comanda NU protejeaza evenimentul)', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const linkedOldEvent = { id: 'e5', order_id: 'order-abc-123', occurred_at: new Date(cutoff.getTime() - DAY_MS) };
  await withFakeFunnelEventsTable([linkedOldEvent], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 1, 'un eveniment cu order_id setat tot trebuie sters daca e mai vechi de 180 zile');
    assert.equal(getRows().length, 0);
  });
});

test('eveniment FARA order_id (niciodata legat de o comanda), mai vechi de 180 zile -> sters', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const anonymousOldEvent = { id: 'e6', order_id: null, occurred_at: new Date(cutoff.getTime() - DAY_MS) };
  await withFakeFunnelEventsTable([anonymousOldEvent], async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 1);
    assert.equal(getRows().length, 0);
  });
});

test('mix realist: evenimente vechi (cu si fara order_id) sterse, evenimente noi (cu si fara order_id) pastrate — intr-un singur apel', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const rows = [
    { id: 'old-linked', order_id: 'order-1', occurred_at: new Date(cutoff.getTime() - DAY_MS) },
    { id: 'old-anon', order_id: null, occurred_at: new Date(cutoff.getTime() - 2 * DAY_MS) },
    { id: 'new-linked', order_id: 'order-2', occurred_at: new Date(cutoff.getTime() + DAY_MS) },
    { id: 'new-anon', order_id: null, occurred_at: new Date(cutoff.getTime() + 2 * DAY_MS) }
  ];
  await withFakeFunnelEventsTable(rows, async ({ getRows }) => {
    const deleted = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(deleted, 2);
    const remainingIds = getRows().map((r) => r.id).sort();
    assert.deepEqual(remainingIds, ['new-anon', 'new-linked']);
  });
});

test('CRITIC — interogarea NU atinge NICIODATA tabela orders: nicio comanda si nicio atributie UTM/fbclid persistata pe orders nu poate fi stearsa/modificata de acest job', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const oldEvent = { id: 'e7', occurred_at: new Date(cutoff.getTime() - DAY_MS) };
  await withFakeFunnelEventsTable([oldEvent], async ({ queryLog }) => {
    await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(queryLog.length, 1, 'trebuie sa emita STRICT o singura interogare per apel');
    assert.doesNotMatch(queryLog[0].sql, /\borders\b/i, 'interogarea nu trebuie sa mentioneze deloc tabela orders');
    assert.match(queryLog[0].sql, /DELETE FROM funnel_events/);
  });
});

test('IDEMPOTENT: rularea de doua ori consecutiv cu ACELASI cutoff -> a doua rulare gaseste 0 randuri de sters, fara eroare, fara dublu-numarat', async () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const oldEvent = { id: 'e8', occurred_at: new Date(cutoff.getTime() - DAY_MS) };
  await withFakeFunnelEventsTable([oldEvent], async ({ getRows }) => {
    const firstRun = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(firstRun, 1);
    const secondRun = await db.deleteFunnelEventsOlderThan(cutoff);
    assert.equal(secondRun, 0, 'a doua rulare nu trebuie sa mai gaseasca nimic de sters');
    assert.equal(getRows().length, 0);
  });
});

// ==========================================================================================
// server.js — job zilnic + ruta admin manuala (STATIC, acelasi tipar ca celelalte 3 job-uri de
// retentie deja existente — vezi test/legal-consent-and-pages.test.js).
// ==========================================================================================
const server = read('server.js');

test('server.js: FUNNEL_EVENTS_RETENTION_DAYS = 180, SEPARATA de CONTENT_RETENTION_DAYS (30, orders)', () => {
  assert.match(server, /const FUNNEL_EVENTS_RETENTION_DAYS = 180;/);
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/, 'CONTENT_RETENTION_DAYS (orders) trebuie sa ramana neschimbata, 30 de zile');
});

test('server.js: purgeStaleFunnelEvents() foloseste db.deleteFunnelEventsOlderThan cu un cutoff calculat din FUNNEL_EVENTS_RETENTION_DAYS', () => {
  const idx = server.indexOf('async function purgeStaleFunnelEvents() {');
  assert.ok(idx !== -1);
  const end = server.indexOf('\n}', idx);
  const fn = server.slice(idx, end);
  assert.match(fn, /FUNNEL_EVENTS_RETENTION_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.match(fn, /db\.deleteFunnelEventsOlderThan\(cutoff\)/);
});

test('server.js: job-ul ruleaza cu ACELASI tipar exact ca celelalte 3 job-uri de retentie — rulare imediata la boot (require.main===module) + setInterval zilnic (24*60*60*1000) cu .unref(), niciun interval/mecanism paralel nou', () => {
  const idx = server.indexOf('purgeStaleFunnelEvents().catch(() => {});');
  assert.ok(idx !== -1, 'trebuie sa ruleze imediat la boot, ca celelalte job-uri de retentie');
  const nearby = server.slice(idx, idx + 200);
  assert.match(nearby, /setInterval\(\(\) => \{ purgeStaleFunnelEvents\(\)\.catch\(\(\) => \{\}\); \}, 24 \* 60 \* 60 \* 1000\)\.unref\(\);/);
});

test('server.js: exista o ruta admin manuala POST /api/admin/retention/purge-funnel-events, protejata de acelasi middleware admin ca celelalte rute de retentie (definita dupa app.use(\'/api/admin\', ...))', () => {
  const routeIdx = server.indexOf("app.post('/api/admin/retention/purge-funnel-events'");
  assert.ok(routeIdx !== -1);
  const adminMiddlewareIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  assert.ok(adminMiddlewareIdx !== -1 && adminMiddlewareIdx < routeIdx, 'ruta trebuie definita DUPA middleware-ul de autentificare admin, ca sa fie protejata de el');
  const routeEnd = server.indexOf('\n});', routeIdx);
  const routeBody = server.slice(routeIdx, routeEnd);
  assert.match(routeBody, /await purgeStaleFunnelEvents\(\)/);
});

test('server.js: purgeStaleFunnelEvents NU apare NICIUNDE langa cod care citeste/scrie orders (verificare structurala — functia foloseste STRICT db.deleteFunnelEventsOlderThan, niciun alt apel db.*Order*)', () => {
  const idx = server.indexOf('async function purgeStaleFunnelEvents() {');
  const end = server.indexOf('\n}', idx);
  const fn = server.slice(idx, end);
  assert.doesNotMatch(fn, /db\.\w*[Oo]rder\w*/, 'functia de retentie funnel_events nu trebuie sa apeleze nicio functie db.js legata de orders');
});
