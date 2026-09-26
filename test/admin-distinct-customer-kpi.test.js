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

// ================================================================================================
// (2b) db.js#getDistinctCustomerRanks — REFACUT server-side (2026-09-25, aprobat explicit) —
// inlocuieste vechea assignDistinctCustomerNumbers (client-side, doar pagina curenta, ordine
// INVERSA — cel mai recent client = 1). Vezi raportul pentru explicatia completa a schimbarii.
// ================================================================================================
test('getDistinctCustomerRanks: foloseste DENSE_RANK() OVER (ORDER BY MIN(created_at) ASC) — primul client din perioada = 1, GROUP BY lower(trim(email))', async () => {
  await withMockPool((sql) => ({ rows: [] }), async (calls) => {
    await db.getDistinctCustomerRanks({});
    const call = calls.find((c) => c.sql.includes('DENSE_RANK'));
    assert.ok(call, 'trebuie sa existe o interogare cu DENSE_RANK');
    assert.match(call.sql, /DENSE_RANK\(\) OVER \(ORDER BY MIN\(created_at\) ASC\)/);
    assert.match(call.sql, /GROUP BY lower\(trim\(email\)\)/);
  });
});

test('getDistinctCustomerRanks: reutilizeaza buildOrdersFilter (ACELASI where/values ca listOrdersPage/countOrders) — respecta testFilter/perioada/status curente', async () => {
  await withMockPool((sql) => ({ rows: [] }), async (calls) => {
    await db.getDistinctCustomerRanks({ testFilter: 'real', testEmails: ['test@naluna.dev'], dateFrom: '2026-09-25', dateToExclusive: '2026-09-26' });
    const call = calls.find((c) => c.sql.includes('DENSE_RANK'));
    assert.match(call.sql, /lower\(email\) != ALL\(\$\d\)/, 'testFilter=real trebuie sa produca aceeasi clauza de excludere ca listOrdersPage');
    assert.match(call.sql, /created_at >= \(\$\d::date AT TIME ZONE 'Europe\/London'\)/);
  });
});

test('getDistinctCustomerRanks: transforma randurile (email_key, rnk) intr-un Map email_key -> numar', async () => {
  const rows = [
    { email_key: 'primul@exemplu.com', rnk: '1' },
    { email_key: 'aldoilea@exemplu.com', rnk: '2' }
  ];
  const map = await withMockPool(() => ({ rows }), () => db.getDistinctCustomerRanks({}));
  assert.equal(map.get('primul@exemplu.com'), 1);
  assert.equal(map.get('aldoilea@exemplu.com'), 2);
  assert.equal(typeof map.get('primul@exemplu.com'), 'number');
});

// ================================================================================================
// (2c) server.js — GET /api/admin/orders atasaza clientNumber (din getDistinctCustomerRanks) si
// recovery (din getOrderNotificationSummaries) pe fiecare comanda, ACELASI filterArgs ca
// listOrdersPage/countOrders — fara sa schimbe KPI-urile (totalCount/revenue raman globale).
// ================================================================================================
const serverSrcForOrders = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server.js GET /api/admin/orders: apeleaza db.getDistinctCustomerRanks(filterArgs) — ACELASI filterArgs ca listOrdersPage/countOrders', () => {
  const idx = serverSrcForOrders.indexOf("app.get('/api/admin/orders', async");
  assert.ok(idx !== -1);
  const end = serverSrcForOrders.indexOf('\n});', idx);
  const fn = serverSrcForOrders.slice(idx, end);
  assert.match(fn, /db\.getDistinctCustomerRanks\(filterArgs\)/);
});

// CORECTIE (2026-09-26, "Nr. comandă"/"Locație"/lifetime — cerinta explicita): normalizarea
// emailului a fost extrasa intr-o variabila `emailKey` (refolosita si pentru
// clientLifetimeOrderCount), aceeasi normalizare exacta (lower+trim) — vezi
// test/admin-orders-numbering.test.js pentru verificarea completa a noii forme.
test('server.js GET /api/admin/orders: fiecare comanda primeste clientNumber din clientRanks.get(email normalizat, prin variabila emailKey)', () => {
  const idx = serverSrcForOrders.indexOf("app.get('/api/admin/orders', async");
  const end = serverSrcForOrders.indexOf('\n});', idx);
  const fn = serverSrcForOrders.slice(idx, end);
  assert.match(fn, /const emailKey = String\(o\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(fn, /clientNumber:\s*clientRanks\.get\(emailKey\)\s*\|\|\s*null/);
});

test('server.js GET /api/admin/orders: totalCount si revenue raman GLOBALE (db.countOrders({}) fara filtre, db.computeRevenue() neschimbat) — KPI-urile nu s-au schimbat', () => {
  const idx = serverSrcForOrders.indexOf("app.get('/api/admin/orders', async");
  const end = serverSrcForOrders.indexOf('\n});', idx);
  const fn = serverSrcForOrders.slice(idx, end);
  assert.match(fn, /db\.countOrders\(\{\}\)/);
  assert.match(fn, /db\.computeRevenue\(\)/);
});

// ================================================================================================
// (3) private/admin/orders.js — renderOrderRow foloseste o.clientNumber (server-side), colspan
// actualizat pentru coloana noua "Recovery".
// ================================================================================================
// CORECTIE (2026-09-26, "Nr. comandă" — coloana noua APROBATA, devine PRIMA celula): Nr. client
// (renderClientNumberCell, care randeaza acum "X (N)" — vezi test/admin-orders-numbering.test.js)
// trece pe A DOUA celula, dupa Nr. comandă (o.orderNumber).
test('renderOrderRow: primeste STRICT `o` (nu mai primeste clientNumber separat) si randeaza renderClientNumberCell(o) in A DOUA celula (dupa Nr. comandă)', () => {
  assert.match(ordersSrc, /<td>\$\{o\.orderNumber != null \? o\.orderNumber : '—'\}<\/td>\s*<td>\$\{renderClientNumberCell\(o\)\}<\/td>/);
});

test('loadOrders(): NU mai calculeaza numerotarea client-side — renderOrderRow(o) e apelat direct pe ordersCache, fara nicio functie intermediara de numerotare', () => {
  assert.ok(!ordersSrc.includes('function assignDistinctCustomerNumbers'), 'functia veche client-side trebuie eliminata complet (nu doar neapelata) — o mentiune in comentariu, ca explicatie istorica, e acceptabila');
  const idx = ordersSrc.indexOf('ordersCache.map((o) => renderOrderRow(o))');
  assert.ok(idx !== -1);
});

// CORECTIE (2026-09-26, "Nr. comandă" + "Locație" — coloane noi APROBATE): colspan-ul a crescut
// din nou, la 15 (13 + Nr. comandă + Locație) — cele 3 stari ale tabelului folosesc acum
// constanta TABLE_COLSPAN (nu mai un literal "15" repetat de 3 ori), plus randul de detalii
// diagnostic (renderOrderDetailRow) foloseste ACEEASI constanta.
test('colspan actualizat la 15 (13 + Nr. comandă + Locație), prin constanta TABLE_COLSPAN, folosita in toate cele 3 stari ale tabelului (incarcare/gol/eroare) SI in randul de detalii', () => {
  assert.match(ordersSrc, /const TABLE_COLSPAN = 15;/);
  const matches = ordersSrc.match(/colspan="\$\{TABLE_COLSPAN\}"/g) || [];
  assert.equal(matches.length, 4, 'trebuie folosita in cele 3 stari ale tabelului (Se încarcă/Nicio comandă/Eroare) + randul de detalii diagnostic');
  assert.ok(!ordersSrc.includes('colspan="13"'), 'nu trebuie sa mai ramana niciun colspan vechi literal de 13');
  assert.ok(!ordersSrc.includes('colspan="12"'), 'nu trebuie sa mai ramana niciun colspan vechi literal de 12');
});

test('renderOrderRow: randeaza o celula Recovery (renderRecoveryCell) inainte de coloana Actiuni', () => {
  const start = ordersSrc.indexOf('function renderOrderRow(o) {');
  const end = ordersSrc.indexOf('\n}', start);
  const fn = ordersSrc.slice(start, end);
  assert.match(fn, /\$\{renderRecoveryCell\(o\)\}/);
});

// CORECTIE (2026-09-26, coloana noua "Locație" — APROBATA separat, vezi
// test/admin-orders-location.test.js): "Recovery" ramane dupa "Sursă" si inainte de "Acțiuni",
// dar "Locație" s-a intercalat intre ele — actualizat sa reflecte asta, fara sa schimbe ce
// verifica testul original (Recovery tot inainte de Acțiuni).
test('orders.html: antetul tabelului contine coloana "Recovery" dupa "Sursă" (cu "Locație" intre ele) si inainte de "Acțiuni"', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  assert.match(htmlSrc, /<th>Sursă<\/th><th[^>]*>Locație<\/th><th[^>]*>Recovery<\/th><th>Acțiuni<\/th>/);
});

// ================================================================================================
// orders.html — antetul tabelului.
// ================================================================================================
// CORECTIE (2026-09-26, coloana noua "Nr. comandă" — APROBATA separat, vezi
// test/admin-orders-numbering.test.js): devine ea PRIMA coloana, "Nr. client" ramane a doua —
// verificarea originala (Nr. client prima) actualizata sa reflecte asta.
test('orders.html: antetul tabelului are "Nr. comandă" ca PRIMA coloana, urmata de "Nr. client", inaintea "Data"', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  const theadMatch = htmlSrc.match(/<tr><th[^>]*>Nr\. comandă<\/th><th[^>]*>Nr\. client<\/th><th>Data<\/th>/);
  assert.ok(theadMatch, 'antetul trebuie sa inceapa cu Nr. comandă, urmat de Nr. client, apoi Data');
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
