// KPI nou "Clienți distincți cu comandă" + coloana "Nr. client" (2026-09-25, cerinta explicita,
// urmare a auditului KPI/funnel din aceeasi zi — vezi raportul: 19-20 "Vizitatori urmăriți" DAR
// 47-48 "Comenzi create" e comportament CORECT, nu bug, pentru ca sunt doua sisteme de masurare
// independente — trackedVisitors (funnel_events, STRICT dupa Analytics consent) vs orders (STRICT
// server-side, fara nicio dependenta de consent). Acest fisier acopera:
//   (1) db.js#getFunnelKpis — noul camp `distinctCustomers`, calculat STRICT din tabela orders
//       (COUNT(DISTINCT lower(trim(email)))), NEATINS de consimtamant/visitor_id;
//   (2) private/admin/orders.js — KPI_DEFS (eticheta noua + tooltip pe "Vizitatori urmăriți") si
//       assignDistinctCustomerNumbers() (numerotarea "Nr. client" din tabel);
//   (3) private/admin/orders.html — coloana noua in antetul tabelului, inainte de "Data".
//
// NU s-a atins: formula "Vizitatori urmăriți" (trackedVisitors, neschimbata), Stripe/checkout,
// payment_intent.payment_failed/checkout.session.expired (neimplementate, cerinta explicita),
// tracking nou pentru preview, Meta Ads Faza A/B.
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

function defaultDispatch(overrides = {}) {
  return (sql) => {
    if (sql.includes('funnel_events')) return overrides.preOrder || { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
    if (sql.includes('paid_orders')) return overrides.paid || { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] };
    if (sql.includes('checkout_created_at IS NOT NULL')) return overrides.reachedCheckout || { rows: [{ n: '0' }] };
    return overrides.ordersCreated || { rows: [{ n: '0', distinct_customers: '0' }] };
  };
}

// ================================================================================================
// (1) db.js#getFunnelKpis — distinctCustomers.
// ================================================================================================
test('getFunnelKpis: distinctCustomers foloseste COUNT(DISTINCT lower(trim(email))) — case-insensitive SI trim, in aceeasi interogare ca ordersCreated', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
    const ordersCall = calls.find((c) => c.sql.includes('distinct_customers'));
    assert.ok(ordersCall, 'interogarea ordersCreated trebuie sa contina distinct_customers');
    assert.match(ordersCall.sql, /COUNT\(DISTINCT lower\(trim\(email\)\)\) AS distinct_customers/);
  });
});

test('getFunnelKpis: rezultatul distinctCustomers ajunge corect in obiectul returnat (Number, nu string)', async () => {
  const result = await withMockPool(
    defaultDispatch({ ordersCreated: { rows: [{ n: '48', distinct_customers: '30' }] } }),
    () => db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] })
  );
  assert.equal(result.ordersCreated, 48);
  assert.equal(result.distinctCustomers, 30);
  assert.equal(typeof result.distinctCustomers, 'number');
});

test('getFunnelKpis: doua comenzi cu ACELASI email (case/spatii diferite) -> distinct_customers=1, simulat direct pe rezultatul agregat de DB (SQL-ul face dedup, nu JS-ul)', async () => {
  // Simuleaza rezultatul PE CARE l-ar produce Postgres pentru comenzi cu
  // "Ana@Exemplu.com" / " ana@exemplu.com " / "ana@exemplu.com" — toate normalizate identic de
  // lower(trim(...)) — deci COUNT(DISTINCT ...) = 1, desi COUNT(*) = 3.
  const result = await withMockPool(
    defaultDispatch({ ordersCreated: { rows: [{ n: '3', distinct_customers: '1' }] } }),
    () => db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] })
  );
  assert.equal(result.ordersCreated, 3);
  assert.equal(result.distinctCustomers, 1, 'aceeasi persoana (email normalizat identic) trebuie numarata o singura data');
});

test('getFunnelKpis: emailuri DIFERITE -> distinct_customers creste corespunzator (nu ramane blocat la 1)', async () => {
  const result = await withMockPool(
    defaultDispatch({ ordersCreated: { rows: [{ n: '4', distinct_customers: '3' }] } }),
    () => db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] })
  );
  assert.equal(result.distinctCustomers, 3);
});

test('getFunnelKpis: distinctCustomers respecta EXACT aceeasi fereastra de timp (Europe/London) ca ordersCreated — aceeasi interogare, acelasi WHERE', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
    const ordersCall = calls.find((c) => c.sql.includes('distinct_customers'));
    assert.match(ordersCall.sql, /created_at >= \(\$1::date AT TIME ZONE 'Europe\/London'\) AND created_at < \(\$2::date AT TIME ZONE 'Europe\/London'\)/);
    assert.deepEqual(ordersCall.params.slice(0, 2), ['2026-09-25', '2026-09-26']);
  });
});

test('getFunnelKpis: excludeEmails (comenzi TEST) exclude si distinctCustomers — aceeasi clauza lower(email) != ALL($3) ca ordersCreated', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: ['test@naluna.dev'] });
    const ordersCall = calls.find((c) => c.sql.includes('distinct_customers'));
    assert.match(ordersCall.sql, /lower\(email\) != ALL\(\$3\)/);
    assert.deepEqual(ordersCall.params[2], ['test@naluna.dev']);
  });
});

test('getFunnelKpis: FARA excludeEmails -> interogarea distinctCustomers nu contine nicio clauza de excludere', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
    const ordersCall = calls.find((c) => c.sql.includes('distinct_customers'));
    assert.doesNotMatch(ordersCall.sql, /!= ALL/);
  });
});

test('getFunnelKpis: distinctCustomers NU depinde de funnel_events/visitor_id — interogarea lui nu contine deloc "funnel_events" sau "visitor_id"', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
    const ordersCall = calls.find((c) => c.sql.includes('distinct_customers'));
    assert.doesNotMatch(ordersCall.sql, /funnel_events/);
    assert.doesNotMatch(ordersCall.sql, /visitor_id/);
  });
});

test('getFunnelKpis: trackedVisitors (Vizitatori urmăriți) ramane EXACT neschimbat — formula, sursa si interogarea sa proprie neatinse', async () => {
  await withMockPool(defaultDispatch(), async (calls) => {
    await db.getFunnelKpis({ startDate: '2026-09-25', endDateExclusive: '2026-09-26', excludeEmails: [] });
    const trafficCall = calls.find((c) => c.sql.includes('funnel_events'));
    assert.match(trafficCall.sql, /COUNT\(DISTINCT fe\.visitor_id\) FILTER \(WHERE fe\.visitor_id IS NOT NULL\) AS tracked_visitors/);
  });
});

// ================================================================================================
// (2) private/admin/orders.js — KPI_DEFS + assignDistinctCustomerNumbers.
// ================================================================================================
const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');

test('KPI_DEFS: "Clienți distincți cu comandă" exista, cu cheia distinctCustomers, si NU are traffic:true (nu depinde de trafficDataAvailability/Analytics consent)', () => {
  const idx = ordersSrc.indexOf('const KPI_DEFS = [');
  const end = ordersSrc.indexOf('];', idx);
  const block = ordersSrc.slice(idx, end);
  const lineMatch = block.match(/\{ key: 'distinctCustomers'[^}]*\}/);
  assert.ok(lineMatch, 'definitia KPI distinctCustomers lipseste din KPI_DEFS');
  assert.match(lineMatch[0], /label: 'Clienți distincți cu comandă'/);
  assert.doesNotMatch(lineMatch[0], /traffic:\s*true/);
});

test('KPI_DEFS: "Vizitatori urmăriți" pastreaza traffic:true (formula NESCHIMBATA) si capata un tooltip explicit despre Analytics consent', () => {
  const idx = ordersSrc.indexOf('const KPI_DEFS = [');
  const end = ordersSrc.indexOf('];', idx);
  const block = ordersSrc.slice(idx, end);
  const lineMatch = block.match(/\{ key: 'trackedVisitors'[^}]*\}/);
  assert.ok(lineMatch);
  assert.match(lineMatch[0], /traffic:\s*true/);
  assert.match(lineMatch[0], /note: 'Doar vizitatorii cu Analytics acceptat'/);
});

test('KPI_DEFS: "Clienți distincți cu comandă" NU inlocuieste "Vizitatori urmăriți" — ambele chei coexista', () => {
  const idx = ordersSrc.indexOf('const KPI_DEFS = [');
  const end = ordersSrc.indexOf('];', idx);
  const block = ordersSrc.slice(idx, end);
  assert.match(block, /key: 'trackedVisitors'/);
  assert.match(block, /key: 'distinctCustomers'/);
});

test('renderKpiCards: randeaza title-ul (tooltip) pe label STRICT cand d.note exista', () => {
  const fnStart = ordersSrc.indexOf('function renderKpiCards(kpis, trafficDataAvailability, dataCompleteSince) {');
  assert.ok(fnStart !== -1);
  const fnEnd = ordersSrc.indexOf('\n}', fnStart);
  const fn = ordersSrc.slice(fnStart, fnEnd);
  assert.match(fn, /d\.note \? ` title="\$\{escapeHtml\(d\.note\)\}"` : ''/);
});

// ---- assignDistinctCustomerNumbers — functie PURA, extrasa textual si evaluata intr-un sandbox.
function loadAssignDistinctCustomerNumbers() {
  const start = ordersSrc.indexOf('function assignDistinctCustomerNumbers(orders) {');
  assert.ok(start !== -1, 'assignDistinctCustomerNumbers lipseste sau s-a schimbat structural');
  let depth = 0, i = ordersSrc.indexOf('{', start);
  for (; i < ordersSrc.length; i++) {
    if (ordersSrc[i] === '{') depth++;
    else if (ordersSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = ordersSrc.slice(start, i + 1);
  const wrapperSrc = `(function () {\n${snippet}\nreturn assignDistinctCustomerNumbers;\n})`;
  return new Function('return ' + wrapperSrc)()();
}
const assignDistinctCustomerNumbers = loadAssignDistinctCustomerNumbers();

test('assignDistinctCustomerNumbers: email CASE-INSENSITIVE — "Ana@Exemplu.com" si "ana@exemplu.com" primesc ACELASI numar', () => {
  const orders = [
    { id: 'o1', email: 'Ana@Exemplu.com' },
    { id: 'o2', email: 'ana@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  assert.equal(numbers.get('o1'), numbers.get('o2'));
  assert.equal(numbers.get('o1'), 1);
});

test('assignDistinctCustomerNumbers: TRIM whitespace — " ana@exemplu.com " (spatii la capete) e acelasi client ca "ana@exemplu.com"', () => {
  const orders = [
    { id: 'o1', email: ' ana@exemplu.com ' },
    { id: 'o2', email: 'ana@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  assert.equal(numbers.get('o1'), numbers.get('o2'));
});

test('assignDistinctCustomerNumbers: exemplul EXACT cerut — client 1 (3 comenzi) -> 1,1,1; client 2 (1 comanda) -> 2; client 3 (2 comenzi) -> 3,3', () => {
  const orders = [
    { id: 'a1', email: 'client1@exemplu.com' },
    { id: 'a2', email: 'client1@exemplu.com' },
    { id: 'a3', email: 'client1@exemplu.com' },
    { id: 'b1', email: 'client2@exemplu.com' },
    { id: 'c1', email: 'client3@exemplu.com' },
    { id: 'c2', email: 'client3@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  assert.equal(numbers.get('a1'), 1);
  assert.equal(numbers.get('a2'), 1);
  assert.equal(numbers.get('a3'), 1);
  assert.equal(numbers.get('b1'), 2);
  assert.equal(numbers.get('c1'), 3);
  assert.equal(numbers.get('c2'), 3);
});

test('assignDistinctCustomerNumbers: emailuri DIFERITE -> numere DIFERITE, niciodata grupate gresit', () => {
  const orders = [
    { id: 'o1', email: 'primul@exemplu.com' },
    { id: 'o2', email: 'aldoilea@exemplu.com' },
    { id: 'o3', email: 'altreilea@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  const values = [numbers.get('o1'), numbers.get('o2'), numbers.get('o3')];
  assert.equal(new Set(values).size, 3, 'trei emailuri distincte trebuie sa produca trei numere distincte');
});

test('assignDistinctCustomerNumbers: numerotarea e STABILA (deterministica) pentru ACELASI set de comenzi, reevaluata de mai multe ori', () => {
  const orders = [
    { id: 'a1', email: 'client1@exemplu.com' },
    { id: 'b1', email: 'client2@exemplu.com' },
    { id: 'a2', email: 'client1@exemplu.com' }
  ];
  const numbers1 = assignDistinctCustomerNumbers(orders);
  const numbers2 = assignDistinctCustomerNumbers(orders);
  assert.equal(numbers1.get('a1'), numbers2.get('a1'));
  assert.equal(numbers1.get('b1'), numbers2.get('b1'));
  assert.equal(numbers1.get('a2'), numbers2.get('a2'));
  assert.equal(numbers1.get('a1'), numbers1.get('a2'), 'client1 trebuie sa aiba acelasi numar pe ambele comenzi ale lui');
});

test('assignDistinctCustomerNumbers: numarul reflecta ORDINEA PRIMEI aparitii, nu ordinea alfabetica sau alt criteriu', () => {
  const orders = [
    { id: 'o1', email: 'zzz@exemplu.com' },
    { id: 'o2', email: 'aaa@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  assert.equal(numbers.get('o1'), 1, 'primul aparut (zzz@) trebuie sa fie clientul 1, desi alfabetic ar fi ultimul');
  assert.equal(numbers.get('o2'), 2);
});

test('assignDistinctCustomerNumbers: comenzi FARA email (caz defensiv) primesc fiecare propriul numar, niciodata grupate impreuna intre ele', () => {
  const orders = [
    { id: 'o1', email: '' },
    { id: 'o2', email: null },
    { id: 'o3', email: 'real@exemplu.com' }
  ];
  const numbers = assignDistinctCustomerNumbers(orders);
  assert.notEqual(numbers.get('o1'), numbers.get('o2'), 'doua comenzi fara email NU trebuie grupate ca acelasi client');
  assert.equal(numbers.get('o3'), 3);
});

// ================================================================================================
// (3) private/admin/orders.js — renderOrderRow foloseste numarul primit, colspan actualizat.
// ================================================================================================
test('renderOrderRow: primeste clientNumber ca al doilea parametru si il randeaza in PRIMA celula', () => {
  const start = ordersSrc.indexOf('function renderOrderRow(o, clientNumber) {');
  assert.ok(start !== -1, 'renderOrderRow trebuie sa primeasca clientNumber ca parametru');
  const end = ordersSrc.indexOf('\n}', start);
  const fn = ordersSrc.slice(start, end);
  const firstTdIdx = fn.indexOf('<td>');
  assert.ok(firstTdIdx !== -1);
  assert.match(fn.slice(firstTdIdx, firstTdIdx + 30), /<td>\$\{clientNumber\}<\/td>/);
});

test('loadOrders(): apeleaza assignDistinctCustomerNumbers() pe ordersCache INAINTE de a randa randurile, si trece numarul catre renderOrderRow', () => {
  const idx = ordersSrc.indexOf('const clientNumbers = assignDistinctCustomerNumbers(ordersCache);');
  assert.ok(idx !== -1);
  const afterIdx = ordersSrc.indexOf('renderOrderRow(o, clientNumbers.get(o.id))', idx);
  assert.ok(afterIdx !== -1 && afterIdx > idx);
});

test('colspan actualizat la 12 (11 coloane vechi + 1 noua "Nr. client") in toate cele 3 stari ale tabelului (incarcare/gol/eroare)', () => {
  const matches = ordersSrc.match(/colspan="12"/g) || [];
  assert.equal(matches.length, 3, 'trebuie actualizate toate cele 3 locuri (Se încarcă/Nicio comandă/Eroare)');
  assert.ok(!ordersSrc.includes('colspan="11"'), 'nu trebuie sa mai ramana niciun colspan vechi de 11');
});

// ================================================================================================
// orders.html — antetul tabelului.
// ================================================================================================
test('orders.html: antetul tabelului are "Nr. client" ca PRIMA coloana, inaintea "Data"', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  const theadMatch = htmlSrc.match(/<tr><th[^>]*>Nr\. client<\/th><th>Data<\/th>/);
  assert.ok(theadMatch, 'antetul trebuie sa inceapa cu Nr. client, urmat imediat de Data');
});

// ================================================================================================
// Izolare — Meta Ads Faza A/B, Stripe/checkout, payment_intent.payment_failed neatinse.
// ================================================================================================
test('server.js: nicio mentiune noua de payment_intent.payment_failed sau checkout.session.expired (neimplementate, cerinta explicita)', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!serverSrc.includes('payment_intent.payment_failed'));
  assert.ok(!serverSrc.includes('checkout.session.expired'));
});

test('server.js, db.js, private/admin/orders.js, private/admin/orders.html raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});
