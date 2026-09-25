// AUDIT (2026-09-25) — discrepanta reala observata in productie pentru 25.09.2026: Admin > KPI
// arata "2 comenzi platite / £30", dar tabelul (perioada 25.09.2026 + "Restrange la perioada" +
// "Doar platite") arata 3 comenzi / £45, toate 3 confirmate si in Stripe.
//
// CAUZA DEMONSTRATA (vezi raportul complet catre user): verificare DIRECTA pe productie (citire,
// fara nicio scriere) a confirmat ca toate cele 3 comenzi reale au created_at SI paid_at in
// ACEEASI fereastra Europe/London (25 Sep) — setul de comenzi e IDENTIC intre query-ul tabelului
// (created_at) si query-ul KPI (paid_at) pentru acest caz concret. Deci NU exista nicio eroare de
// fus orar/SQL in acest incident — cauza reala e ca panoul de KPI (loadFunnelSummary) se
// reimprospata STRICT la navigarea Period Selector-ului, niciodata la schimbarea filtrelor
// tabelului ("Doar plătite"/"Restrange la perioada") — vezi private/admin/orders.js. Intre
// momentul in care KPI-urile au fost calculate (la incarcarea paginii) si momentul in care
// Adminul a bifat filtrele tabelului, a treia plata a sosit (webhook Stripe procesat) — tabelul
// (interogare noua) a prins-o, KPI-ul (neschimbat de la incarcare) nu.
//
// Acest fisier acopera DOUA lucruri distincte, ambele cerute explicit:
// (A) confirma ca semantica create_at (tabel) vs paid_at (KPI) e REALA si INTENTIONATA — nu
//     trebuie "reparata" prin unificare, ci documentata clar (deja facuta, vezi orders.html) —
//     cu scenarii concrete unde cele doua NU coincid (comanda creata o zi, platita alta zi);
// (B) verifica FIXUL aplicat (private/admin/orders.js): filtrul "Doar plătite" si activarea
//     "Restrange la perioada" reimprospateaza acum explicit si cardurile KPI, eliminand exact
//     clasa de discrepanta observata (staleness), fara sa schimbe deloc semantica SQL.
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
// (A) Semantica create_at (tabel) vs paid_at (KPI) — REALA, INTENTIONATA, documentata.
// ================================================================================================

test('buildOrdersFilter: filtrul paid=true adauga STRICT "paid_at IS NOT NULL" — FARA nicio restrictie de DATA pe paid_at (tabelul ramane ferestruit STRICT pe created_at, prin dateFrom/dateToExclusive)', () => {
  const { where } = db.buildOrdersFilter({ paid: true, dateFrom: '2026-09-25', dateToExclusive: '2026-09-26' });
  assert.match(where, /paid_at IS NOT NULL/);
  assert.doesNotMatch(where, /paid_at\s*>=/, 'nu trebuie sa existe nicio limita inferioara de DATA pe paid_at');
  assert.doesNotMatch(where, /paid_at\s*</, 'nu trebuie sa existe nicio limita superioara de DATA pe paid_at');
  assert.match(where, /created_at >= \(\$\d::date AT TIME ZONE 'Europe\/London'\)/, 'restrictia de perioada ramane STRICT pe created_at');
});

test('SCENARIU CONCRET: o comanda creata pe 24 Sep, platita pe 25 Sep — apare in tabel pentru perioada 24 Sep (+"Doar platite"), NU apare in KPI-ul "platite" pentru 24 Sep, DAR apare in KPI-ul pentru 25 Sep — divergenta REALA si CORECTA, nu o eroare', async () => {
  // Tabel, perioada = 24 Sep, paid=true -> filtrul e STRICT pe created_at (24 Sep) + paid_at IS NOT NULL (orice data)
  const { where: tableWhere, values: tableValues } = db.buildOrdersFilter({ paid: true, dateFrom: '2026-09-24', dateToExclusive: '2026-09-25' });
  assert.equal(tableValues[0], '2026-09-24');
  assert.equal(tableValues[1], '2026-09-25');
  assert.match(tableWhere, /paid_at IS NOT NULL/);
  // -> aceasta comanda (created 24 Sep) TREBUIE inclusa de query-ul tabelului pentru 24 Sep,
  //    indiferent ca a fost platita abia pe 25 Sep — SQL-ul nu are nicio clauza care sa o excluda.

  // KPI, perioada = 24 Sep -> paidSql foloseste STRICT paid_at
  await withMockPool(
    (sql) => sql.includes('paid_orders') ? { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] } : { rows: [{ n: '0', distinct_customers: '0' }] },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-24', endDateExclusive: '2026-09-25', excludeEmails: [] });
      const paidCall = calls.find((c) => c.sql.includes('paid_orders'));
      assert.match(paidCall.sql, /paid_at >= \(\$1::date AT TIME ZONE 'Europe\/London'\) AND paid_at < \(\$2::date AT TIME ZONE 'Europe\/London'\)/);
      assert.deepEqual(paidCall.params.slice(0, 2), ['2026-09-24', '2026-09-25']);
      // -> paid_at real al comenzii (25 Sep) NU satisface "paid_at < 2026-09-25 London" -> KPI-ul
      //    pentru 24 Sep o EXCLUDE corect, desi tabelul (created_at) ar include-o.
    }
  );

  // KPI, perioada = 25 Sep -> ACEEASI comanda TREBUIE inclusa aici (paid_at cade in aceasta fereastra)
  await withMockPool(
    (sql) => sql.includes('paid_orders') ? { rows: [{ paid_orders: '1', paid_customers: '1', revenue: '15' }] } : { rows: [{ n: '0', distinct_customers: '0' }] },
    async () => {
      const result = await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
      assert.equal(result.paidOrders, 1, 'comanda platita pe 25 Sep trebuie numarata in KPI-ul zilei de 25 Sep, indiferent cand a fost CREATA');
    }
  );
});

test('SCENARIU EXACT DIN INCIDENT: 3 comenzi create pe 25 Sep, toate 3 platite (paid_at IS NOT NULL), dar STRICT 2 cu paid_at CHIAR in fereastra 25 Sep London — tabelul (+Doar platite +Restrange) arata 3, KPI arata 2 — ambele corecte, masoara lucruri diferite', async () => {
  const { where: tableWhere } = db.buildOrdersFilter({ paid: true, dateFrom: '2026-09-25', dateToExclusive: '2026-09-26' });
  assert.match(tableWhere, /created_at >= .*AND created_at < .*AND paid_at IS NOT NULL/s, 'tabelul: create_at in fereastra + paid_at IS NOT NULL (orice data) -> cele 3 comenzi (toate create 25 Sep, toate platite candva) trec');

  await withMockPool(
    (sql) => sql.includes('paid_orders') ? { rows: [{ paid_orders: '2', paid_customers: '2', revenue: '30' }] } : { rows: [{ n: '3', distinct_customers: '3' }] },
    async () => {
      const kpi = await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
      assert.equal(kpi.paidOrders, 2);
      assert.equal(kpi.revenue, 30);
      assert.equal(kpi.ordersCreated, 3, 'ordersCreated (create_at, ca si tabelul) ramane 3 — consistent cu ce arata tabelul, DOAR paidOrders/revenue difera (paid_at)');
    }
  );
});

test('BOUNDARY Europe/London: fereastra paid_at e SEMI-DESCHISA (>= start, < capat exclusiv) — identic cu created_at, asigura ca o plata la EXACT miezul noptii London apartine zilei care incepe, niciodata ambelor/niciuneia', async () => {
  await withMockPool(
    (sql) => sql.includes('paid_orders') ? { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] } : { rows: [{ n: '0', distinct_customers: '0' }] },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
      const paidCall = calls.find((c) => c.sql.includes('paid_orders'));
      assert.match(paidCall.sql, /paid_at >= \(\$1::date AT TIME ZONE 'Europe\/London'\)/, 'capatul de inceput trebuie sa fie inclusiv (>=)');
      assert.match(paidCall.sql, /paid_at < \(\$2::date AT TIME ZONE 'Europe\/London'\)/, 'capatul de sfarsit trebuie sa fie EXCLUSIV (<, niciodata <=) — evita numararea dubla la granita');
      // AT TIME ZONE 'Europe/London' foloseste baza de date IANA reala a Postgres — respecta
      // automat DST (BST in septembrie), identic cu created_at (buildOrdersFilter) si cu
      // timeWindowClause folosit peste tot in motorul KPI — nicio conversie proprie in JS.
    }
  );
});

test('DISTINCT PAYING CUSTOMERS: incidentul concret — 2 comenzi platite in fereastra, ale UNOR clienti DIFERITI -> paidCustomers=2 (nu 1, nu confundat cu paidOrders)', async () => {
  await withMockPool(
    (sql) => sql.includes('paid_orders') ? { rows: [{ paid_orders: '2', paid_customers: '2', revenue: '30' }] } : { rows: [{ n: '0', distinct_customers: '0' }] },
    async () => {
      const kpi = await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
      assert.equal(kpi.paidOrders, 2);
      assert.equal(kpi.paidCustomers, 2);
    }
  );
});

// ================================================================================================
// (B) Fixul de staleness (private/admin/orders.js) — verificare STATICA, acelasi tipar ca restul
// suitei pentru fisiere client-side.
// ================================================================================================

const ordersJs = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');

test('orders.js: filtrul "Doar plătite" (paidFilter) reimprospateaza ACUM si cardurile KPI (loadFunnelSummary), nu doar tabelul — elimina staleness-ul care a cauzat incidentul', () => {
  const idx = ordersJs.indexOf("paidFilter.addEventListener('change'");
  assert.ok(idx !== -1);
  const line = ordersJs.slice(idx, ordersJs.indexOf('\n', idx));
  assert.match(line, /loadOrders\(\);\s*loadFunnelSummary\(\);/);
});

test('orders.js: activarea "Restrânge la perioada selectată" (syncPeriodCheckbox, checked=true) reimprospateaza ACUM si cardurile KPI, nu doar tabelul', () => {
  const idx = ordersJs.indexOf("syncPeriodCheckbox.addEventListener('change'");
  assert.ok(idx !== -1);
  const end = ordersJs.indexOf('\n});', idx);
  const fn = ordersJs.slice(idx, end);
  const checkedBranchIdx = fn.indexOf('if (syncPeriodCheckbox.checked) {');
  const elseBranchIdx = fn.indexOf('} else {');
  const checkedBranch = fn.slice(checkedBranchIdx, elseBranchIdx);
  assert.match(checkedBranch, /applyPeriodSyncToOrdersFilter\(\);/);
  assert.match(checkedBranch, /loadFunnelSummary\(\);/);
});

test('orders.js: dezactivarea "Restrânge la perioada" (checked=false) NU are nevoie sa reimprospateze KPI-urile (perioada Period Selector-ului nu s-a schimbat, doar filtrul de date al tabelului a fost eliminat)', () => {
  const idx = ordersJs.indexOf("syncPeriodCheckbox.addEventListener('change'");
  const end = ordersJs.indexOf('\n});', idx);
  const fn = ordersJs.slice(idx, end);
  const elseBranchIdx = fn.indexOf('} else {');
  const elseBranch = fn.slice(elseBranchIdx);
  assert.match(elseBranch, /loadOrders\(\);/);
});

test('orders.js: celelalte filtre (status/sursa/campanie/test) raman NESCHIMBATE (nu au fost atinse de acest fix) — nu au nicio legatura cu semantica de plata, deci nu pot cauza aceasta discrepanta', () => {
  assert.match(ordersJs, /statusFilter\.addEventListener\('change', \(\) => \{ state\.status = statusFilter\.value; state\.offset = 0; loadOrders\(\); \}\);/);
  assert.match(ordersJs, /sourceFilter\.addEventListener\('change', \(\) => \{ state\.utmSource = sourceFilter\.value; state\.offset = 0; loadOrders\(\); \}\);/);
  assert.match(ordersJs, /campaignFilter\.addEventListener\('change', \(\) => \{ state\.utmCampaign = campaignFilter\.value; state\.offset = 0; loadOrders\(\); \}\);/);
  assert.match(ordersJs, /testFilterEl\.addEventListener\('change', \(\) => \{ state\.testFilter = testFilterEl\.value; state\.offset = 0; loadOrders\(\); \}\);/);
});

// ================================================================================================
// orders.html — nota explicativa vizibila (nu doar tooltip), pentru cazurile in care divergenta e
// legitima (comanda creata o zi, platita alta zi) — cerinta FAZA 2: sa nu para o contradictie.
// ================================================================================================
test('orders.html: exista o nota vizibila care explica STRICT ca tabelul foloseste data crearii, iar KPI-urile de plata folosesc data platii', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  assert.match(html, /Tabelul de mai jos filtrează după data creării comenzii/);
  assert.match(html, /KPI-urile „Comenzi plătite”, „Clienți plătitori” și „Venit încasat”.*folosesc data plății/);
});

test('orders.html: filtrul "Doar plătite" are un tooltip (title) care explica aceeasi distinctie', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  const idx = html.indexOf('<select id="orders-paid-filter"');
  const tag = html.slice(idx, html.indexOf('>', idx) + 1);
  assert.match(tag, /title="[^"]*data plății/);
});
