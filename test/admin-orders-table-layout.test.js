// LAYOUT TABEL COMENZI (2026-09-18, compactare responsive) — teste STATICE (citesc direct
// sursa — acelasi tipar ca restul suitei, proiectul NU are infrastructura de testare vizuala/
// browser real — nici jsdom, nici Playwright/Puppeteer/Cypress, verificat direct in package.json).
// Verifica STRUCTURAL: clasele de coloana corespund intre orders.html (<th>) si orders.js
// (<td>), regulile CSS de compactare/scroll exista cu proprietatile corecte, breakpoint-ul sub
// 900px elibereaza constrangerile (scroll acceptat explicit acolo), si ca nicio functionalitate
// (filtre/paginare/colspan) nu a fost afectata.
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

const COLUMN_CLASSES = ['col-date', 'col-recipient', 'col-email', 'col-lang', 'col-occasion', 'col-genre', 'col-plan', 'col-price', 'col-status', 'col-source', 'col-actions'];

test('orders.html: fiecare <th> al tabelului Comenzi are clasa de coloana corespunzatoare, in ordinea corecta, exact 11 coloane (neschimbat)', () => {
  const theadMatch = html.match(/<table id="orders-table"[\s\S]*?<thead>([\s\S]*?)<\/thead>/);
  assert.ok(theadMatch, 'thead-ul tabelului Comenzi trebuie sa existe');
  const ths = [...theadMatch[1].matchAll(/<th class="([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(ths, COLUMN_CLASSES);
});

test('orders.html: wrapper-ul tabelului are ambele clase table-scroll + orders-table-scroll (scroll orizontal fallback + inaltime marginita/sticky header)', () => {
  assert.match(html, /<div class="table-scroll orders-table-scroll">\s*<table id="orders-table" class="orders-table-compact">/);
});

test('orders.html: <main> foloseste admin-main-wide (container mai lat, STRICT pe aceasta pagina)', () => {
  assert.match(html, /<main class="admin-main admin-main-wide">/);
});

test('orders.js: renderOrderRow() genereaza EXACT aceleasi 11 clase de coloana pe <td>, in aceeasi ordine ca <th>-urile din orders.html', () => {
  const fnStart = js.indexOf('function renderOrderRow(o) {');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  const tds = [...fn.matchAll(/<td class="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tds, COLUMN_CLASSES);
});

test('orders.js: valorile lungi (destinatar/email/sursa) au atribut title cu valoarea COMPLETA, nescurtata — truncarea vizuala (CSS) nu ascunde niciodata definitiv informatia', () => {
  const fnStart = js.indexOf('function renderOrderRow(o) {');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /class="col-recipient" title="\$\{escapeHtml\(o\.recipient\)\}"/, 'Pentru (destinatar) trebuie sa aiba title cu numele complet');
  assert.match(fn, /class="cell-truncate" title="\$\{escapeHtml\(o\.email \|\| ''\)\}"/, 'Email trebuie sa aiba title cu adresa completa');

  const sourceFnStart = js.indexOf('function renderSourceCell(o) {');
  const sourceFnEnd = js.indexOf('\n}', sourceFnStart);
  const sourceFn = js.slice(sourceFnStart, sourceFnEnd);
  assert.match(sourceFn, /title="\$\{escapeHtml\(full\)\}"/, 'Sursa trebuie sa aiba title cu valoarea completa (sursa + campanie)');
});

test('orders.js: badge-ul TEST NU e niciodata trunchiat odata cu textul email-ului — e un element SEPARAT, in afara span-ului cell-truncate', () => {
  const fnStart = js.indexOf('function renderOrderRow(o) {');
  const fnEnd = js.indexOf('\n}', fnStart);
  const fn = js.slice(fnStart, fnEnd);
  const emailCellMatch = fn.match(/<td class="col-email">([\s\S]*?)<\/td>/);
  assert.ok(emailCellMatch);
  const emailCell = emailCellMatch[1];
  const truncateSpanMatch = emailCell.match(/<span class="cell-truncate"[^>]*>[\s\S]*?<\/span>/);
  assert.ok(truncateSpanMatch, 'span-ul cell-truncate trebuie sa existe');
  assert.doesNotMatch(truncateSpanMatch[0], /badge/, 'badge-ul TEST nu trebuie sa fie in interiorul span-ului trunchiat');
  assert.match(emailCell, /badge b-draft/, 'badge-ul TEST trebuie sa existe undeva in celula, ca element separat');
});

test('orders.js: data e afisata compact, pe doua randuri (zi + ora, fara secunde) — renderDateCell() foloseste toLocaleDateString + toLocaleTimeString separat, nu toLocaleString complet', () => {
  const fnStart = js.indexOf('function renderDateCell(createdAt) {');
  const fn = js.slice(fnStart, js.indexOf('\n}', fnStart));
  assert.match(fn, /toLocaleDateString\('ro-RO'\)/);
  assert.match(fn, /toLocaleTimeString\('ro-RO', \{ hour: '2-digit', minute: '2-digit' \}\)/);
  assert.match(fn, /class="order-date-time"/);
});

test('orders.js: colspan-ul randurilor "Se incarca"/"Nicio comanda"/"Eroare" ale tabelului COMENZI ramane 11 (numarul de coloane e neschimbat) — verificat STRICT in loadOrders()/render-urile de stare a acestui tabel, separat de tabelul Surse (9 coloane)', () => {
  const fnStart = js.indexOf('async function loadOrders() {');
  assert.ok(fnStart !== -1);
  const fn = js.slice(fnStart, js.indexOf('\n}', fnStart));
  const matches = fn.match(/colspan="(\d+)"/g) || [];
  assert.ok(matches.length >= 3, 'trebuie sa existe cel putin cele 3 randuri de stare (loading/empty/error) pentru tabelul Comenzi');
  for (const m of matches) assert.equal(m, 'colspan="11"');
});

test('shared.css: .orders-table-scroll limiteaza inaltimea (max-height) SI antetul e sticky — bara de scroll orizontala ramane mereu langa randurile vizibile, niciodata sub o lista lunga', () => {
  assert.match(css, /\.orders-table-scroll\{\s*max-height:65vh;\s*overflow:auto;/);
  assert.match(css, /\.orders-table-scroll thead th\{\s*position:sticky;\s*top:0;/);
});

test('shared.css: .admin-main-wide exista, mareste max-width STRICT prin combinatia .admin-main.admin-main-wide — nu modifica .admin-main de baza (Dashboard/Social/Website/Sistem raman la 1180px, neatinse)', () => {
  assert.match(css, /\.admin-main\.admin-main-wide\{ max-width:1600px; \}/);
  // regula de baza .admin-main (1180px) trebuie sa ramana EXACT neschimbata
  assert.match(css, /\.admin-main\{ flex:1; min-width:0; padding:36px 32px; max-width:1180px; \}/);
});

test('shared.css: padding-ul celulelor tabelului a fost redus (16px -> 10px orizontal), fontul NU a fost micsorat (13px, neschimbat)', () => {
  assert.match(css, /th, td\{ text-align:left; padding:9px 10px; font-size:13px;/);
});

test('shared.css: coloanele cu valori scurte (data/limba/pachet/pret/status) sunt white-space:nowrap fara max-width — se micsoreaza la continutul lor minim, fara sa piarda text', () => {
  for (const cls of ['col-date', 'col-lang', 'col-plan', 'col-price', 'col-status']) {
    const re = new RegExp(`td\\.${cls}[,{][\\s\\S]{0,400}?white-space:nowrap`);
    assert.match(css, re, `${cls} trebuie sa fie white-space:nowrap`);
  }
});

test('shared.css: sub 900px, constrangerile de max-width pe coloanele variabile sunt eliminate explicit — scroll orizontal ACCEPTAT pe ecrane inguste, fara trunchiere agresiva care ar strica lizibilitatea', () => {
  const mqMatch = css.match(/@media \(max-width: 900px\)\{([\s\S]*?)\n\}/);
  assert.ok(mqMatch, 'media query pentru sub 900px trebuie sa existe');
  const mq = mqMatch[1];
  assert.match(mq, /td\.col-recipient,[\s\S]*?td\.col-source\{ max-width:none;/);
  assert.match(mq, /td\.col-occasion,[\s\S]*?td\.col-genre,[\s\S]*?td\.col-actions\{ max-width:none; \}/);
});

test('orders.js: filtrele/paginarea NU au fost atinse — buildQuery/loadOrders/state raman functional identice (verificare structurala: aceleasi chei de stare, acelasi PAGE_SIZE)', () => {
  assert.match(js, /const PAGE_SIZE = 50;/);
  assert.match(js, /let state = \{ offset: 0, status: '', q: '', paid: '', utmSource: '', utmCampaign: '', testFilter: '', dateFrom: null, dateTo: null \};/);
  assert.match(js, /function buildQuery\(\) \{/);
});
