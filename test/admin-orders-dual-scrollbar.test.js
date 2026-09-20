// TABEL COMENZI — bara de scroll orizontal sincronizata SUS + JOS (2026-09-19). Inlocuieste
// compactarea din commit 66cd46d (revenita explicit la cerere — vizual prea inghesuita, valori
// precum genurile lungi ("ballad_emotional") rupte pe mai multe randuri). Verifica STATIC (acelasi
// tipar ca restul suitei — proiectul NU are infrastructura de testare vizuala/browser real):
// (a) un SINGUR tabel, fara duplicare de date; (b) cele doua "ferestre" de scroll exista si sunt
// sincronizate bidirectional in JS; (c) compactarea veche a fost complet eliminata (fara col-*/
// orders-table-compact/admin-main-wide); (d) aspectul original (padding, latimi) e restaurat;
// (e) filtrele/paginarea/analytics-ul raman neatinse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const html = read('private/admin/orders.html');
const js = read('private/admin/orders.js');
const css = read('private/admin/shared.css');

test('orders.html: UN SINGUR <table id="orders-table"> — bara de sus nu introduce un al doilea tabel sau date duplicate', () => {
  const tableMatches = html.match(/<table[^>]*>/g) || [];
  const ordersTableMatches = tableMatches.filter((t) => t.includes('id="orders-table"'));
  assert.equal(ordersTableMatches.length, 1, 'trebuie sa existe EXACT un <table id="orders-table">');
  assert.equal((html.match(/id="orders-body"/g) || []).length, 1, 'trebuie sa existe UN SINGUR <tbody id="orders-body"> (o singura sursa de randuri)');
});

test('orders.html: bara de scroll de SUS exista, cu spacer intern, INAINTE de containerul de scroll de JOS existent', () => {
  const topIdx = html.indexOf('<div class="table-scroll-top" id="orders-table-scroll-top">');
  const spacerIdx = html.indexOf('id="orders-table-scroll-top-spacer"');
  const bottomIdx = html.indexOf('<div class="table-scroll" id="orders-table-scroll">');
  assert.ok(topIdx !== -1, 'bara de sus trebuie sa existe');
  assert.ok(spacerIdx !== -1 && spacerIdx > topIdx, 'spacer-ul trebuie sa fie in interiorul barei de sus');
  assert.ok(bottomIdx !== -1 && bottomIdx > topIdx, 'bara de jos (containerul existent de scroll) trebuie sa ramana, dupa cea de sus');
});

test('orders.html: NU mai contine niciuna dintre clasele compactarii vechi (col-*, orders-table-compact, admin-main-wide) — revenire completa la aspectul dinainte de 66cd46d', () => {
  for (const cls of ['orders-table-compact', 'admin-main-wide', 'col-date', 'col-recipient', 'col-email', 'col-lang', 'col-occasion', 'col-genre', 'col-plan', 'col-price', 'col-status', 'col-source', 'col-actions']) {
    assert.ok(!html.includes(cls), `${cls} nu mai trebuie sa apara in orders.html`);
  }
  assert.match(html, /<main class="admin-main">/, 'containerul Admin trebuie sa foloseasca latimea implicita (fara admin-main-wide)');
  assert.match(html, /<tr><th>Data<\/th><th>Pentru<\/th><th>Email<\/th><th>Limba<\/th><th>Ocazie<\/th><th>Gen<\/th><th>Pachet<\/th><th>Preț<\/th><th>Status<\/th><th>Sursă<\/th><th>Acțiuni<\/th><\/tr>/, 'antetul trebuie sa fie identic cu varianta originala (fara clase de coloana)');
});

test('orders.js: NU mai contine functiile/clasele compactarii vechi (renderDateCell pe doua randuri, cell-truncate) — data/email/sursa afisate simplu, ca inainte de 66cd46d', () => {
  assert.ok(!js.includes('function renderDateCell'), 'renderDateCell (data pe doua randuri) nu mai trebuie sa existe');
  assert.ok(!js.includes('cell-truncate'), 'trunchierea cu ellipsis nu mai trebuie sa existe');
  assert.ok(!js.includes('orders-table-compact'));
  assert.match(js, /<td>\$\{new Date\(o\.createdAt\)\.toLocaleString\('ro-RO'\)\}<\/td>/, 'data trebuie afisata simplu, pe un rand, ca inainte');
});

test('orders.js: bara de sus e sincronizata BIDIRECTIONAL cu bara de jos — scroll pe oricare seteaza scrollLeft pe cealalta', () => {
  const topListenerMatch = js.match(/topScrollEl\.addEventListener\('scroll', \(\) => \{[\s\S]*?\}\);/);
  const bottomListenerMatch = js.match(/bottomScrollEl\.addEventListener\('scroll', \(\) => \{[\s\S]*?\}\);/);
  assert.ok(topListenerMatch, 'trebuie sa existe un listener de scroll pe bara de sus');
  assert.ok(bottomListenerMatch, 'trebuie sa existe un listener de scroll pe bara de jos');
  assert.match(topListenerMatch[0], /bottomScrollEl\.scrollLeft = topScrollEl\.scrollLeft;/, 'scroll pe SUS trebuie sa mute bara de JOS');
  assert.match(bottomListenerMatch[0], /topScrollEl\.scrollLeft = bottomScrollEl\.scrollLeft;/, 'scroll pe JOS trebuie sa mute bara de SUS');
});

test('orders.js: sincronizarea are o garda impotriva bucla infinita (un flag, nu doua apeluri necontrolate care s-ar re-declansa reciproc la nesfarsit)', () => {
  assert.match(js, /let syncingTableScroll = false;/);
  const topListenerMatch = js.match(/topScrollEl\.addEventListener\('scroll', \(\) => \{[\s\S]*?\}\);/)[0];
  const bottomListenerMatch = js.match(/bottomScrollEl\.addEventListener\('scroll', \(\) => \{[\s\S]*?\}\);/)[0];
  assert.match(topListenerMatch, /if \(syncingTableScroll\) return;/);
  assert.match(bottomListenerMatch, /if \(syncingTableScroll\) return;/);
});

test('orders.js: latimea barei de sus se recalculeaza din latimea REALA scrollabila a tabelului (scrollWidth), nu un numar fix', () => {
  const fn = js.match(/function syncTopScrollbarWidth\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn[0], /topScrollSpacer\.style\.width = ordersTableEl\.scrollWidth \+ 'px';/);
});

test('orders.js: recalcularea latimii se declanseaza la resize (fereastra) SI la schimbari de continut (ResizeObserver pe tabel) SI dupa fiecare incarcare de comenzi (loadOrders, succes/eroare)', () => {
  assert.match(js, /window\.addEventListener\('resize', syncTopScrollbarWidth\);/);
  assert.match(js, /new ResizeObserver\(syncTopScrollbarWidth\)\.observe\(ordersTableEl\);/);
  const fnStart = js.indexOf('async function loadOrders() {');
  const fn = js.slice(fnStart, js.indexOf('\n}', fnStart));
  const occurrences = (fn.match(/syncTopScrollbarWidth\(\);/g) || []).length;
  assert.equal(occurrences, 2, 'syncTopScrollbarWidth() trebuie apelat atat pe ramura de succes cat si pe cea de eroare din loadOrders()');
});

test('shared.css: bara de sus foloseste scroll orizontal REAL (overflow-x:auto), fara sageti/butoane custom — inaltime mica, STRICT cat sa afiseze scrollbar-ul', () => {
  assert.match(css, /\.table-scroll-top\{ overflow-x:auto; overflow-y:hidden;[^}]*\}/);
  assert.match(css, /\.table-scroll-top-spacer\{ height:1px; \}/);
  assert.doesNotMatch(css, /table-scroll-top[\s\S]{0,200}(arrow|chevron|◀|▶|←|→)/i, 'nu trebuie introduse sageti/butoane vizuale pentru scroll');
});

test('shared.css: NICIUNA dintre regulile compactarii vechi nu mai exista (admin-main-wide, orders-table-compact, col-*, max-height/sticky pe scroll)', () => {
  for (const rule of ['admin-main-wide', 'orders-table-compact', 'orders-table-scroll thead th', 'col-date', 'col-recipient', 'col-email', 'col-occasion', 'col-genre', 'col-actions']) {
    assert.ok(!css.includes(rule), `regula "${rule}" din compactarea veche nu mai trebuie sa existe in shared.css`);
  }
});

test('shared.css: padding-ul original al celulelor (12px 16px) si latimea originala a containerului Admin (1180px, fara varianta "wide") sunt restaurate', () => {
  assert.match(css, /th, td\{ text-align:left; padding:12px 16px; font-size:13px;/);
  assert.match(css, /\.admin-main\{ flex:1; min-width:0; padding:36px 32px; max-width:1180px; \}/);
  assert.doesNotMatch(css, /max-width:1600px/);
});

test('orders.js: filtrele/paginarea raman IDENTICE (stare, PAGE_SIZE, buildQuery) — nicio schimbare de comportament din aceasta corectie de UI', () => {
  assert.match(js, /const PAGE_SIZE = 50;/);
  assert.match(js, /let state = \{ offset: 0, status: '', q: '', paid: '', utmSource: '', utmCampaign: '', testFilter: '', dateFrom: null, dateTo: null \};/);
  assert.match(js, /function buildQuery\(\) \{/);
});

test('orders.html/orders.js: sectiunile de analytics/funnel (Period Selector, KPI Cards, Conversion Funnel, Trend, Traffic Sources) raman complet neatinse de aceasta corectie', () => {
  assert.match(html, /id="period-type-tabs"/);
  assert.match(html, /id="kpi-cards"/);
  // id="funnel-chart" (container unic) a fost inlocuit pe 2026-09-19 (FAZA 1, clarificare funnel)
  // de doua containere separate, Trafic si Conversie comenzi — vezi
  // test/admin-orders-funnel-clarity.test.js pentru verificarea dedicata a acelei schimbari.
  assert.match(html, /id="funnel-traffic"/);
  assert.match(html, /id="funnel-cohort"/);
  assert.match(html, /id="trend-chart"/);
  assert.match(html, /id="sources-table"/);
  assert.match(js, /async function loadFunnelSummary\(\) \{/);
});
