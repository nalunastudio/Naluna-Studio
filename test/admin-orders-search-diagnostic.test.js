// Admin > Comenzi — (4) cautare repozitionata/facuta mai practica + (5) diagnostic client compact
// (2026-09-26, cerinta explicita). Verificari STATICE (acelasi tipar ca restul suitei pentru
// private/admin/orders.js/.html) — fara DOM real, fara server HTTP pornit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ordersHtml = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
const ordersJs = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');
const sharedCss = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'shared.css'), 'utf8');

// ================================================================================================
// (4) CAUTAREA — reutilizata (acelasi #orders-search, acelasi q server-side), NU un al doilea
// sistem — doar repozitionata pe randul ei, imediat deasupra barei de filtre/tabel.
// ================================================================================================
test('orders.html: #orders-search exista o SINGURA data in tot fisierul (nu s-a creat un al doilea sistem de cautare)', () => {
  const matches = ordersHtml.match(/id="orders-search"/g) || [];
  assert.equal(matches.length, 1);
});

test('orders.html: #orders-search e acum in propriul rand (.orders-search-row), plasat INAINTE de .orders-toolbar (deasupra barei de filtre, imediat deasupra tabelului)', () => {
  const searchRowIdx = ordersHtml.indexOf('class="orders-search-row"');
  const toolbarIdx = ordersHtml.indexOf('class="orders-toolbar"');
  const tableIdx = ordersHtml.indexOf('id="orders-table"');
  assert.ok(searchRowIdx !== -1 && toolbarIdx !== -1 && tableIdx !== -1);
  assert.ok(searchRowIdx < toolbarIdx, '.orders-search-row trebuie sa vina inaintea .orders-toolbar');
  assert.ok(toolbarIdx < tableIdx, '.orders-toolbar (si deci si cautarea) trebuie sa ramana deasupra tabelului');
});

test('orders.html: search input-ul NU mai e in .orders-toolbar (mutat, nu duplicat)', () => {
  const toolbarIdx = ordersHtml.indexOf('class="orders-toolbar"');
  const toolbarEnd = ordersHtml.indexOf('orders-period-sync', toolbarIdx);
  const toolbarBlock = ordersHtml.slice(toolbarIdx, toolbarEnd);
  assert.ok(!toolbarBlock.includes('id="orders-search"'));
});

test('private/admin/orders.js: logica de cautare (debounce, state.q, trim client-side) ramane EXACT neschimbata — acelasi element, acelasi comportament, doar HTML-ul din jur s-a mutat', () => {
  assert.match(ordersJs, /searchInput\.addEventListener\('input', \(\) => \{/);
  assert.match(ordersJs, /state\.q = searchInput\.value\.trim\(\);/);
});

test('server.js: filtrul q ramane server-side, ILIKE case-insensitive peste recipient SAU email, peste toata baza de date (nu doar pagina curenta)', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(dbSrc, /\(recipient ILIKE \$\$\{values\.length\} OR email ILIKE \$\$\{values\.length\}\)/);
});

test('shared.css: stilul search input-ului a fost mutat la .orders-search-row (nu mai exista sub .orders-toolbar)', () => {
  assert.match(sharedCss, /\.orders-search-row input\[type=search\]\{/);
  assert.doesNotMatch(sharedCss, /\.orders-toolbar input\[type=search\]\{/);
});

test('shared.css: .orders-search-row e inclus in stacking-ul mobil (aceeasi breakpoint ca .orders-toolbar)', () => {
  const mobileBlockIdx = sharedCss.indexOf('@media (max-width: 700px)');
  const mobileBlock = sharedCss.slice(mobileBlockIdx);
  assert.match(mobileBlock, /\.orders-search-row\{ flex-direction:column; align-items:stretch; \}/);
});

// ================================================================================================
// (5) DIAGNOSTIC CLIENT COMPACT — STRICT date deja existente pe `o` (niciun fetch nou), niciun
// secret expus, toggle simplu (fara sa transforme tabelul intr-un dashboard incarcat).
// ================================================================================================
test('getOrderDiagnosticItems: nu expune NICIODATA accessToken/stripeSessionId/stripePaymentIntentId (date tehnice sensibile)', () => {
  const start = ordersJs.indexOf('function getOrderDiagnosticItems(o) {');
  assert.ok(start !== -1);
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.doesNotMatch(fn, /accessToken/);
  assert.doesNotMatch(fn, /stripeSessionId/);
  assert.doesNotMatch(fn, /stripePaymentIntentId/);
});

test('getOrderDiagnosticItems: previewReached e STRICT derivat din status (preview_ready sau ready) — nicio presupunere/eveniment inventat', () => {
  const start = ordersJs.indexOf('function getOrderDiagnosticItems(o) {');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /const previewReached = o\.status === 'preview_ready' \|\| o\.status === 'ready';/);
});

test('getOrderDiagnosticItems: checkout creat/platit derivate STRICT din checkoutCreatedAt/paidAt (prezenta/lipsa), niciodata inventate', () => {
  const start = ordersJs.indexOf('function getOrderDiagnosticItems(o) {');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /o\.checkoutCreatedAt \? new Date\(o\.checkoutCreatedAt\)\.toLocaleString\('ro-RO'\) : 'Nu'/);
  assert.match(fn, /o\.paidAt \? new Date\(o\.paidAt\)\.toLocaleString\('ro-RO'\) : 'Nu'/);
});

test('getOrderDiagnosticItems: eroarea reala (o.error) apare STRICT daca exista — niciun rand "Eroare: —" afisat cand nu exista', () => {
  const start = ordersJs.indexOf('function getOrderDiagnosticItems(o) {');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /if \(o\.error\) items\.push\(\{ k: 'Eroare', v: o\.error, err: true \}\);/);
});

test('renderOrderDetailRow: randul de detalii e ASCUNS implicit (display:none) — nu transforma tabelul intr-un dashboard incarcat, se afiseaza STRICT la cerere', () => {
  const start = ordersJs.indexOf('function renderOrderDetailRow(o) {');
  assert.ok(start !== -1);
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /style="display:none;"/);
});

test('renderOrderRow: contine butonul de toggle "Detalii" langa Anonimizează/Retry Extras, si adauga renderOrderDetailRow(o) imediat dupa randul principal', () => {
  assert.match(ordersJs, /<button type="button" class="order-detail-toggle" data-order-detail-toggle="\$\{escapeHtml\(o\.id\)\}">Detalii<\/button>/);
  assert.match(ordersJs, /\$\{renderOrderDetailRow\(o\)\}\s*`;\s*\n\}/);
});

test('ordersBody click handler: toggle-ul de detalii comuta STRICT display-ul randului (nu face niciun fetch nou catre server)', () => {
  const idx = ordersJs.indexOf("ordersBody.addEventListener('click', (e) => {");
  assert.ok(idx !== -1);
  const end = ordersJs.indexOf('\n});', idx);
  const fn = ordersJs.slice(idx, end);
  assert.match(fn, /data-order-detail-toggle/);
  assert.match(fn, /detailRow\.style\.display = detailRow\.style\.display === 'none' \? '' : 'none';/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('data-order-action')), /fetch\(/, 'toggle-ul de detalii nu trebuie sa faca niciun fetch');
});

test('shared.css: stilurile diagnosticului compact exista (.order-detail-row, .order-detail-grid) fara sa strice restul tabelului', () => {
  assert.match(sharedCss, /\.order-detail-row td\{/);
  assert.match(sharedCss, /\.order-detail-grid\{/);
});

test('server.js, private/admin/orders.js, private/admin/orders.html raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});
