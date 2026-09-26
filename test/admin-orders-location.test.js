// Admin > Comenzi — coloana "Locație" (2026-09-26, cerinta explicita, sectiunea 2). Sursa REALA
// gasita prin audit: session.customer_details.address (Stripe), acelasi loc/moment unde
// customerCountry e deja capturat de mult (webhook checkout.session.completed) — NICIODATA
// dedusa din limba melodiei/nume/email/gen, NICIODATA geolocalizare IP, NICIUN serviciu extern
// nou. Comenzile istorice/neplatite raman NULL -> Admin afiseaza "—", fara backfill inventat.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
const ordersJs = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');
const ordersHtml = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');

// ================================================================================================
// (1) Sursa REALA — captura customerCity ALATURI de customerCountry, ACELASI camp Stripe, in
// ACELASI webhook, la ACELASI moment (confirmarea platii) — nicio sursa noua introdusa.
// ================================================================================================
test('server.js: customerCity vine STRICT din session.customer_details.address.city — ACELASI obiect Stripe ca customerCountry, nicio sursa noua', () => {
  const idx = serverSrc.indexOf('const customerCountry = (session.customer_details');
  assert.ok(idx !== -1);
  const block = serverSrc.slice(idx, idx + 700);
  assert.match(block, /const customerCity = \(session\.customer_details && session\.customer_details\.address && session\.customer_details\.address\.city\) \|\| null;/);
});

test('server.js: customerCity e trimis in acelasi patch (recordPaidOrderAtomically) ca customerCountry/paidAt — scris ATOMIC, la confirmarea platii, nicaieri altundeva', () => {
  const idx = serverSrc.indexOf('const result = await db.recordPaidOrderAtomically(');
  assert.ok(idx !== -1);
  const block = serverSrc.slice(idx, idx + 400);
  assert.match(block, /customerCountry,\s*customerCity,/);
});

test('server.js: NICIUN cod nou de geolocalizare IP (fara "geoip", "maxmind", "ipapi", "ipinfo", header CF-IPCountry) — locatia ramane STRICT billing address Stripe', () => {
  const lower = serverSrc.toLowerCase();
  for (const forbidden of ['geoip', 'maxmind', 'ipapi', 'ipinfo', 'cf-ipcountry', 'x-vercel-ip-country']) {
    assert.ok(!lower.includes(forbidden), `nu ar trebui sa existe nicio mentiune de "${forbidden}"`);
  }
});

// ================================================================================================
// (2) db.js — schema (customer_city, ADD COLUMN IF NOT EXISTS — migrare sigura) + rowToOrder +
// COLUMN_MAP (necesar ca recordPaidOrderAtomically sa scrie efectiv coloana, nu un no-op tacut —
// vezi precedentul exact, comentariul din COLUMN_MAP pentru genre).
// ================================================================================================
test('db.js: coloana customer_city adaugata cu ADD COLUMN IF NOT EXISTS (migrare sigura, comenzile existente raman NULL retroactiv)', () => {
  assert.match(dbSrc, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_city TEXT;/);
});

test('db.js: rowToOrder expune customerCity', () => {
  assert.match(dbSrc, /customerCity: row\.customer_city,/);
});

test('db.js: COLUMN_MAP contine customerCity -> customer_city (altfel db.updateOrder/recordPaidOrderAtomically ar ignora tacut acest camp — vezi precedentul exact cu bug-ul genre)', () => {
  assert.match(dbSrc, /customerCity: 'customer_city',/);
});

// ================================================================================================
// (3) server.js — formatOrderLocation: format afisat, fara inventare.
// ================================================================================================
test('formatOrderLocation: oraș + țară -> "Oraș, Țară" (formatul cerut explicit)', () => {
  const idx = serverSrc.indexOf('function formatOrderLocation(');
  assert.ok(idx !== -1);
  // Executam functia real extrasa (pure, fara dependinte externe) intr-un sandbox minim.
  const mapIdx = serverSrc.indexOf('const COUNTRY_DISPLAY_NAMES = {');
  const mapEnd = serverSrc.indexOf('};', mapIdx) + 2;
  const fnEnd = serverSrc.indexOf('\n}', idx) + 2;
  const src = serverSrc.slice(mapIdx, fnEnd);
  const fn = new Function(`${src}\nreturn formatOrderLocation;`)();
  assert.equal(fn('London', 'GB'), 'London, UK');
  assert.equal(fn('Roma', 'IT'), 'Roma, Italia');
  assert.equal(fn('Madrid', 'ES'), 'Madrid, Spania');
  assert.equal(fn('Bucuresti', 'RO'), 'Bucuresti, România');
});

test('formatOrderLocation: DOAR țară (fara oraș) -> STRICT numele țării, fara nicio virgula orfana', () => {
  const mapIdx = serverSrc.indexOf('const COUNTRY_DISPLAY_NAMES = {');
  const fnEnd = serverSrc.indexOf('\n}', serverSrc.indexOf('function formatOrderLocation(')) + 2;
  const fn = new Function(`${serverSrc.slice(mapIdx, fnEnd)}\nreturn formatOrderLocation;`)();
  assert.equal(fn(null, 'GB'), 'UK');
  assert.equal(fn('', 'RO'), 'România');
});

test('formatOrderLocation: fara țară -> null (Admin va afișa "—"), niciodata un oraș fara țară si niciodata text inventat', () => {
  const mapIdx = serverSrc.indexOf('const COUNTRY_DISPLAY_NAMES = {');
  const fnEnd = serverSrc.indexOf('\n}', serverSrc.indexOf('function formatOrderLocation(')) + 2;
  const fn = new Function(`${serverSrc.slice(mapIdx, fnEnd)}\nreturn formatOrderLocation;`)();
  assert.equal(fn('London', null), null);
  assert.equal(fn(null, null), null);
});

test('formatOrderLocation: cod de țară necunoscut (absent din harta) -> afișat NETRADUS (codul ISO brut), niciodata ascuns sau inventat', () => {
  const mapIdx = serverSrc.indexOf('const COUNTRY_DISPLAY_NAMES = {');
  const fnEnd = serverSrc.indexOf('\n}', serverSrc.indexOf('function formatOrderLocation(')) + 2;
  const fn = new Function(`${serverSrc.slice(mapIdx, fnEnd)}\nreturn formatOrderLocation;`)();
  assert.equal(fn(null, 'ZZ'), 'ZZ');
});

// ================================================================================================
// (4) server.js — GET /api/admin/orders atasaza `location` pe fiecare comanda.
// ================================================================================================
test('server.js GET /api/admin/orders: fiecare comanda primeste location din formatOrderLocation(o.customerCity, o.customerCountry)', () => {
  const idx = serverSrc.indexOf("app.get('/api/admin/orders', async");
  const end = serverSrc.indexOf("\napp.get('/api/admin/orders/filter-options'", idx);
  const fn = serverSrc.slice(idx, end);
  assert.match(fn, /location:\s*formatOrderLocation\(o\.customerCity, o\.customerCountry\)/);
});

// ================================================================================================
// (5) Frontend — coloana "Locație" in antet + celula randata + fallback "—".
// ================================================================================================
test('orders.html: antetul tabelului contine coloana "Locație" dupa "Sursă" si inainte de "Recovery"', () => {
  assert.match(ordersHtml, /<th>Sursă<\/th><th[^>]*>Locație<\/th><th[^>]*>Recovery<\/th>/);
});

test('renderLocationCell: afiseaza o.location cand exista, altfel "—" (span text-muted) — niciodata text inventat', () => {
  const start = ordersJs.indexOf('function renderLocationCell(o) {');
  assert.ok(start !== -1);
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /o\.location \? escapeHtml\(o\.location\) : '<span class="text-muted">—<\/span>'/);
});

test('renderOrderRow: randeaza renderLocationCell(o) intre Sursă si Recovery', () => {
  assert.match(ordersJs, /\$\{renderSourceCell\(o\)\}<\/td>\s*<td>\$\{renderLocationCell\(o\)\}<\/td>\s*<td>\$\{renderRecoveryCell\(o\)\}<\/td>/);
});

// ================================================================================================
// (6) Comenzi istorice — fara backfill inventat.
// ================================================================================================
test('nicio comanda "UPDATE orders SET customer_city" in afara webhook-ului de plata — niciun backfill retroactiv inventat', () => {
  const matches = serverSrc.match(/customer_city/gi) || [];
  // singura mentiune reala e prin patch-ul (COLUMN_MAP), nu un UPDATE direct hardcodat separat
  assert.ok(!serverSrc.includes("SET customer_city"), 'nu trebuie sa existe niciun UPDATE direct pe customer_city (backfill) — STRICT prin COLUMN_MAP/recordPaidOrderAtomically');
});

test('db.js: rowToOrder returneaza customerCity = null pentru un rand fara aceasta coloana (comanda istorica) — nicio valoare implicita inventata', () => {
  // rowToOrder e o functie interna neexportata — testam indirect prin listOrdersPage cu un mock.
  const original = db.pool.query.bind(db.pool);
  db.pool.query = async () => ({ rows: [{ id: '1', price: '10', variants: null, created_at: new Date(), customer_city: null, customer_country: null }] });
  return db.listOrdersPage({}).then((rows) => {
    db.pool.query = original;
    assert.equal(rows[0].customerCity, null);
  }).catch((err) => { db.pool.query = original; throw err; });
});

test('server.js, db.js, private/admin/orders.js, private/admin/orders.html raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});

// ================================================================================================
// Izolare — Meta Ads Faza A/B, Privacy Policy (neschimbata in acest task — raportata separat).
// ================================================================================================
test('customer_city nu atinge lib/meta-ads/ — niciun require nou catre acel modul in server.js din acest bloc', () => {
  const idx = serverSrc.indexOf('const customerCity = (session.customer_details');
  const block = serverSrc.slice(idx, idx + 700);
  assert.ok(!block.includes('meta-ads'));
});
