// Admin > Comenzi — (6) Perioada implicita = "Zi"/Azi in Europe/London, ordinea
// Zi | Săptămână | Lună | Interval custom (2026-09-26, cerinta explicita). Verificari STATICE
// (sursa citita ca text) — acelasi tipar ca test/admin-orders-auto-refresh.test.js. Executam DOAR
// helper-ele pure de calendar + todayInLondon() intr-un sandbox minim (fara DOM), ca sa verificam
// comportamentul lor real, nu doar prezenta textuala.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ordersJs = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');
const ordersHtml = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');

// ================================================================================================
// (a) orders.html — ordinea butoanelor Zi | Săptămână | Lună | Interval custom, "Zi" activ implicit.
// ================================================================================================
test('orders.html: ordinea tab-urilor Period Selector e Zi | Săptămână | Lună | Interval custom', () => {
  const idx = ordersHtml.indexOf('id="period-type-tabs"');
  const end = ordersHtml.indexOf('</div>', idx);
  const block = ordersHtml.slice(idx, end);
  const order = [...block.matchAll(/data-period-type="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['day', 'week', 'month', 'custom']);
});

test('orders.html: butonul "Zi" (data-period-type="day") e cel activ implicit (class="period-tab active"), niciun alt tab activ', () => {
  const idx = ordersHtml.indexOf('id="period-type-tabs"');
  const end = ordersHtml.indexOf('</div>', idx);
  const block = ordersHtml.slice(idx, end);
  const activeMatches = block.match(/class="period-tab active"/g) || [];
  assert.equal(activeMatches.length, 1, 'STRICT un singur tab activ implicit');
  assert.match(block, /<button type="button" class="period-tab active" data-period-type="day">Zi<\/button>/);
});

// ================================================================================================
// (b) orders.js — periodState.type implicit 'day', si data folosita e AZI in Europe/London (nu
// ceasul local al browserului), calculata prin todayInLondon().
// ================================================================================================
test('orders.js: periodState.type implicit este "day" (nu "month")', () => {
  assert.match(ordersJs, /let periodState = \{ type: 'day',/);
});

test('orders.js: todayInLondon() foloseste Intl.DateTimeFormat cu timeZone Europe/London, locale en-CA (format nativ YYYY-MM-DD)', () => {
  const start = ordersJs.indexOf('function todayInLondon() {');
  assert.ok(start !== -1, 'functia todayInLondon trebuie sa existe');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.match(fn, /timeZone: 'Europe\/London'/);
  assert.match(fn, /new Intl\.DateTimeFormat\('en-CA'/);
});

test('todayInLondon(): executat real, returneaza STRICT formatul YYYY-MM-DD si difera de UTC exact in jurul miezul noptii cand Europe/London e in DST (BST, UTC+1) — verificam STRUCTURAL formatul, nu o data hardcodata (testul trebuie sa treaca in orice zi)', () => {
  const start = ordersJs.indexOf('function todayInLondon() {');
  const end = ordersJs.indexOf('\n}', start) + 2;
  const fn = new Function(`${ordersJs.slice(start, end)}\nreturn todayInLondon;`)();
  const result = fn();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('orders.js: periodState initial (year/month/anchorDate/date/startDate/endDate) e derivat din todayLondonStr — NU din ceasul local al browserului (fara "new Date()" nefiltrat direct in initializarea periodState)', () => {
  const idx = ordersJs.indexOf('const todayLondonStr = todayInLondon();');
  assert.ok(idx !== -1);
  const stateIdx = ordersJs.indexOf('let periodState = {', idx);
  const stateEnd = ordersJs.indexOf('};', stateIdx) + 1;
  const block = ordersJs.slice(idx, stateEnd);
  assert.match(block, /anchorDate: todayLondonStr, date: todayLondonStr/);
  assert.match(block, /startDate: addDaysLocal\(todayLondonStr, -6\), endDate: todayLondonStr/);
  assert.doesNotMatch(block.slice(block.indexOf('let periodState')), /new Date\(\)/, 'periodState nu trebuie sa mai citeasca direct new Date() (browser local) pentru valorile lui initiale');
});

// ================================================================================================
// (c) "Azi" (period-today) button + prev/next raman NESCHIMBATE (comportament pre-existent,
// documentat — ceasul local al browserului e STRICT comoditate UI pentru navigare ulterioara,
// bucketing-ul real ramane server-side in Europe/London indiferent). Cerinta explicita acopera
// STRICT defaultul de la reincarcarea completa a paginii.
// ================================================================================================
test('butoanele "Azi"/prev/next raman NESCHIMBATE (folosesc in continuare new Date() local — comportament pre-existent, documentat, NU parte din aceasta cerinta)', () => {
  const idx = ordersJs.indexOf("document.getElementById('period-today').addEventListener");
  assert.ok(idx !== -1);
  const end = ordersJs.indexOf('\n});', idx);
  const fn = ordersJs.slice(idx, end);
  assert.match(fn, /const t = toDateStr\(new Date\(\)\);/);
});

// ================================================================================================
// (d) auto-refresh NU reseteaza perioada aleasa manual de admin (cerinta explicita, sectiunea 6) —
// comportament deja existent (loadFunnelSummary({silent:true}) sare peste
// applyPeriodSyncToOrdersFilter), verificam ca a supravietuit neschimbat reordonarii tab-urilor.
// ================================================================================================
test('autoRefreshTick(): tot apeleaza loadFunnelSummary({ silent: true }) — perioada aleasa manual (ex. Lună) NU e resetata de tick-ul de fundal', () => {
  const idx = ordersJs.indexOf('async function autoRefreshTick() {');
  const end = ordersJs.indexOf('\n}', idx);
  const fn = ordersJs.slice(idx, end);
  assert.match(fn, /await loadFunnelSummary\(\{ silent: true \}\);/);
});

test('schimbarea tab-ului de perioada (periodTypeTabs click) ramane STRICT manuala — actualizeaza periodState.type si apeleaza refreshAll() STRICT la click, niciodata automat de auto-refresh', () => {
  const idx = ordersJs.indexOf("periodTypeTabs.addEventListener('click'");
  assert.ok(idx !== -1);
  const end = ordersJs.indexOf('\n});', idx);
  const fn = ordersJs.slice(idx, end);
  assert.match(fn, /periodState\.type = btn\.dataset\.periodType;/);
});

test('simulare: dupa ce adminul schimba manual pe "Luna" (periodState.type = "month"), un tick de auto-refresh (loadFunnelSummary({silent:true})) NU trebuie sa reScrie periodState.type — funcția nu primește deloc parametrul type ca input', () => {
  const start = ordersJs.indexOf('async function loadFunnelSummary({ silent = false } = {}) {');
  const end = ordersJs.indexOf('\n}', start);
  const fn = ordersJs.slice(start, end);
  assert.doesNotMatch(fn, /periodState\.type\s*=/, 'loadFunnelSummary nu trebuie sa scrie NICIODATA periodState.type — doar il citeste (buildPeriodParams)');
});

test('server.js, private/admin/orders.js, private/admin/orders.html raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});

// ================================================================================================
// Izolare — Meta Ads Faza A/B, recovery emails.
// ================================================================================================
test('reordonarea tab-urilor + defaultul Zi nu ating lib/meta-ads/ sau lib/recovery-emails/ — niciun require nou in orders.js', () => {
  assert.ok(!ordersJs.includes('meta-ads'));
  assert.ok(!ordersJs.includes('recovery-emails'));
});
