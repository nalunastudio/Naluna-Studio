// ORDERS TABLE FILTERS (2026-09-18, Funnel Analytics FAZA 2) — teste REALE pentru
// db.js#buildOrdersFilter, clauza WHERE comuna intre listOrdersPage si countOrders (tabelul
// Comenzi din /admin/orders). Acopera filtrele NOI cerute explicit (interval de date, platit/
// neplatit, sursa, campanie, real/test) — fara sa afecteze filtrele deja existente (status,
// cautare, excludeEmails, folosite de Dashboard).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

test('fara niciun filtru -> WHERE gol, niciun parametru (comportament implicit neschimbat)', () => {
  const { where, values } = db.buildOrdersFilter({});
  assert.equal(where, '');
  assert.deepEqual(values, []);
});

test('status + q + excludeEmails (filtrele EXISTENTE) — combinate cu AND, in aceasta ordine, neschimbate', () => {
  const { where, values } = db.buildOrdersFilter({ status: 'ready', q: 'maria', excludeEmails: ['test@team.com'] });
  assert.match(where, /status = \$1/);
  assert.match(where, /recipient ILIKE \$2 OR email ILIKE \$2/);
  assert.match(where, /lower\(email\) != ALL\(\$3\)/);
  assert.deepEqual(values, ['ready', '%maria%', ['test@team.com']]);
});

test('dateFrom/dateToExclusive: interval de date pe created_at, Europe/London, capat exclusiv', () => {
  const { where, values } = db.buildOrdersFilter({ dateFrom: '2026-09-01', dateToExclusive: '2026-10-01' });
  assert.match(where, /created_at >= \(\$1::date AT TIME ZONE 'Europe\/London'\)/);
  assert.match(where, /created_at < \(\$2::date AT TIME ZONE 'Europe\/London'\)/);
  assert.deepEqual(values, ['2026-09-01', '2026-10-01']);
});

test('paid=true -> paid_at IS NOT NULL STRICT; paid=false -> paid_at IS NULL STRICT; paid=null/undefined -> niciun filtru de plata (2026-09-18 runda 2: NICIODATA status=\'ready\', concept operational diferit)', () => {
  assert.match(db.buildOrdersFilter({ paid: true }).where, /paid_at IS NOT NULL/);
  assert.match(db.buildOrdersFilter({ paid: false }).where, /paid_at IS NULL/);
  assert.doesNotMatch(db.buildOrdersFilter({ paid: true }).where, /status/);
  assert.doesNotMatch(db.buildOrdersFilter({ paid: false }).where, /status/);
  assert.equal(db.buildOrdersFilter({ paid: null }).where, '');
  assert.equal(db.buildOrdersFilter({}).where, '');
});

test('utmSource/utmCampaign: comparatie case-insensitive (lower(...) = lower($n))', () => {
  const { where, values } = db.buildOrdersFilter({ utmSource: 'Facebook', utmCampaign: 'Launch_Post_1' });
  assert.match(where, /lower\(utm_source\) = lower\(\$1\)/);
  assert.match(where, /lower\(utm_campaign\) = lower\(\$2\)/);
  assert.deepEqual(values, ['Facebook', 'Launch_Post_1']);
});

test('testFilter="real" cu testEmails -> exclude EXACT acele adrese (lower(email) != ALL)', () => {
  const { where, values } = db.buildOrdersFilter({ testFilter: 'real', testEmails: ['A@Team.com', 'b@team.com'] });
  assert.match(where, /lower\(email\) != ALL\(\$1\)/);
  assert.deepEqual(values, [['a@team.com', 'b@team.com']]);
});

test('testFilter="test" cu testEmails -> INCLUDE STRICT acele adrese (lower(email) = ANY)', () => {
  const { where, values } = db.buildOrdersFilter({ testFilter: 'test', testEmails: ['a@team.com'] });
  assert.match(where, /lower\(email\) = ANY\(\$1\)/);
  assert.deepEqual(values, [['a@team.com']]);
});

test('testFilter="test" FARA nicio adresa de test configurata (ANALYTICS_EXCLUDED_EMAILS lipsa) -> "FALSE" (niciun rezultat), NICIODATA o eroare sau tot tabelul', () => {
  const { where, values } = db.buildOrdersFilter({ testFilter: 'test', testEmails: [] });
  assert.match(where, /FALSE/);
  assert.deepEqual(values, []);
});

test('testFilter="real" FARA nicio adresa de test configurata -> echivalent cu "toate comenzile" (nimic de exclus), fara eroare', () => {
  const { where, values } = db.buildOrdersFilter({ testFilter: 'real', testEmails: [] });
  assert.equal(where, '');
  assert.deepEqual(values, []);
});

test('testFilter e SEPARAT de excludeEmails — combinarea ambelor (teoretic posibil, desi apelantii reali nu o fac) produce ambele conditii, fara sa se anuleze reciproc', () => {
  const { where, values } = db.buildOrdersFilter({ excludeEmails: ['x@y.com'], testFilter: 'test', testEmails: ['a@team.com'] });
  assert.match(where, /lower\(email\) != ALL\(\$1\)/);
  assert.match(where, /lower\(email\) = ANY\(\$2\)/);
  assert.deepEqual(values, [['x@y.com'], ['a@team.com']]);
});

test('toate filtrele noi combinate — numerotarea parametrilor ($n) e secventiala si consistenta cu ordinea din clauza WHERE', () => {
  const { where, values } = db.buildOrdersFilter({
    status: 'ready', dateFrom: '2026-09-01', dateToExclusive: '2026-10-01', paid: true,
    utmSource: 'facebook', utmCampaign: 'launch_post_1', testFilter: 'real', testEmails: ['a@team.com']
  });
  assert.deepEqual(values, ['ready', '2026-09-01', '2026-10-01', 'facebook', 'launch_post_1', ['a@team.com']]);
  // fiecare pozitie din values trebuie sa corespunda EXACT indexului $n folosit in where
  values.forEach((v, i) => assert.match(where, new RegExp(`\\$${i + 1}(?!\\d)`), `parametrul $${i + 1} nu apare in WHERE`));
});
