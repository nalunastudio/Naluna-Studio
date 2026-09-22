// PERFORMANȚA CREATIVELOR (2026-09-22, atribuire reclame/creative prin utm_content) — teste
// STATICE (acelasi tipar ca test/admin-orders-funnel-clarity.test.js — proiectul NU are
// infrastructura de testare vizuala/browser real). Acopera: sectiunea noua din Admin Vânzări &
// Funnel, ruptura reala gasita si reparata in comanda.html (mapare snake_case -> camelCase pentru
// atributia trimisa la POST /api/orders), si absenta oricarei cifre de cost Meta (Spend/CPA/ROAS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const html = read('private/admin/orders.html');
const js = read('private/admin/orders.js');
const server = read('server.js');
const comanda = read('public/comanda.html');
const attribution = read('public/js/attribution.js');

// ==================================================================================================
// RUPTURA REALA gasita la audit: attribution.js#getStoredAttribution() intoarce chei snake_case
// (utm_source, utm_content etc.), dar POST /api/orders (server.js) destructureaza STRICT camelCase
// — un spread direct nu traducea niciodata aceste chei. comanda.html trebuie acum sa traduca
// explicit, exact ca public/js/analytics.js (postTrackEvent) deja face pentru funnel_events.
// ==================================================================================================
test('attribution.js: getStoredAttribution() ramane NESCHIMBATA — intoarce STRICT chei snake_case (utm_source, utm_content etc.), acelasi contract folosit corect de analytics.js', () => {
  assert.match(attribution, /var UTM_KEYS = \['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'\]/);
});

test('comanda.html: payload-ul catre POST /api/orders traduce EXPLICIT attribution.utm_content -> utmContent (nu mai face spread direct, netradus, al obiectului getStoredAttribution())', () => {
  const idx = comanda.indexOf('NalunaAttribution.getStoredAttribution()');
  assert.ok(idx !== -1, 'apelul catre getStoredAttribution trebuie sa existe in comanda.html');
  const surrounding = comanda.slice(Math.max(0, idx - 400), idx + 700);
  assert.match(surrounding, /utmSource:\s*attribution\.utm_source\s*\|\|\s*null/);
  assert.match(surrounding, /utmMedium:\s*attribution\.utm_medium\s*\|\|\s*null/);
  assert.match(surrounding, /utmCampaign:\s*attribution\.utm_campaign\s*\|\|\s*null/);
  assert.match(surrounding, /utmContent:\s*attribution\.utm_content\s*\|\|\s*null/);
  assert.match(surrounding, /utmTerm:\s*attribution\.utm_term\s*\|\|\s*null/);
  assert.match(surrounding, /fbclid:\s*attribution\.fbclid\s*\|\|\s*null/);
});

test('comanda.html: NU mai exista un spread direct netradus al getStoredAttribution() (regresia care cauza ruptura — chei snake_case ajungeau nemapate in payload-ul catre server)', () => {
  assert.ok(
    !comanda.includes('...(typeof window !== \'undefined\' && window.NalunaAttribution ? window.NalunaAttribution.getStoredAttribution() : {}),'),
    'spread-ul direct, netradus, nu mai trebuie sa existe — inlocuit de maparea explicita snake_case -> camelCase'
  );
});

test('server.js: POST /api/orders destructureaza STRICT camelCase (utmSource/utmMedium/utmCampaign/utmContent/utmTerm) din req.body — neschimbat, confirma ce trebuie sa trimita clientul', () => {
  const idx = server.indexOf("app.post('/api/orders', orderCreationLimiter");
  assert.ok(idx !== -1);
  const routeStart = server.slice(idx, idx + 1200);
  assert.match(routeStart, /utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid, fbp/);
});

// ==================================================================================================
// SECTIUNEA ADMIN NOUA — Performanța creativelor.
// ==================================================================================================
test('orders.html: sectiunea "Performanța creativelor" exista, DUPA sectiunea existenta "Surse de trafic & vânzări" (nu o inlocuieste, nu o strica)', () => {
  const sourcesIdx = html.indexOf('Surse de trafic');
  const creativesIdx = html.indexOf('Performanța creativelor');
  assert.ok(sourcesIdx !== -1, 'sectiunea existenta "Surse de trafic & vânzări" trebuie sa ramana neatinsa');
  assert.ok(creativesIdx !== -1, 'sectiunea noua "Performanța creativelor" trebuie sa existe');
  assert.ok(sourcesIdx < creativesIdx, 'sectiunea noua trebuie sa fie DUPA cea existenta, nu inainte/in locul ei');
  // tabelul vechi #sources-table ramane intact
  assert.match(html, /<table id="sources-table">/);
  assert.match(html, /<tbody id="sources-body"><\/tbody>/);
});

test('orders.html: tabelul #creatives-table are coloanele cerute explicit (Creative, Vizitatori urmăriți, Formular început, Comenzi create, Checkout, Plătite, Venit)', () => {
  const idx = html.indexOf('id="creatives-table"');
  assert.ok(idx !== -1);
  const tableBlock = html.slice(idx, html.indexOf('</table>', idx));
  assert.match(tableBlock, /utm_content/i);
  assert.match(tableBlock, /Vizitatori urmăriți/);
  assert.match(tableBlock, /Formular început/);
  assert.match(tableBlock, /Comenzi create/);
  assert.match(tableBlock, /Checkout/);
  assert.match(tableBlock, /Plătite/);
  assert.match(tableBlock, /Venit/);
});

test('orders.html/server.js: NICIO urma de Spend/CPA/ROAS/Profit in sectiunea de creative — Meta Marketing API de costuri neimplementat inca (cerinta explicita)', () => {
  const idx = html.indexOf('Performanța creativelor');
  const sectionEnd = html.indexOf('<!-- Orders Table -->', idx);
  const section = html.slice(idx, sectionEnd);
  for (const forbidden of ['Spend', 'CPA', 'ROAS', 'Profit']) {
    assert.ok(!section.includes(forbidden), `sectiunea Performanța creativelor nu trebuie sa contina "${forbidden}"`);
  }
  const funnelSummaryIdx = server.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const funnelSummaryEnd = server.indexOf('\n});', funnelSummaryIdx);
  const funnelSummaryBody = server.slice(funnelSummaryIdx, funnelSummaryEnd);
  for (const forbidden of ['spend', 'cpa', 'roas', 'marketing_api', 'MarketingApi']) {
    assert.ok(!funnelSummaryBody.toLowerCase().includes(forbidden.toLowerCase()), `endpoint-ul funnel-summary nu trebuie sa contina "${forbidden}"`);
  }
});

test('orders.js: renderCreatives() exista si e apelata din loadFunnelSummary, cu data.creatives + trafficDataAvailability', () => {
  assert.match(js, /function renderCreatives\(/);
  const loadIdx = js.indexOf('async function loadFunnelSummary()');
  assert.ok(loadIdx !== -1);
  const loadEnd = js.indexOf('\n}', loadIdx);
  const loadBody = js.slice(loadIdx, loadEnd);
  assert.match(loadBody, /renderCreatives\(data\.creatives,\s*data\.trafficDataAvailability,\s*data\.dataCompleteSince\)/);
});

test('orders.js: renderCreatives() NU transforma "unmeasured" in 0 pentru Vizitatori urmăriți/Formular început — afiseaza "—" (nemăsurat), niciodata o cifra falsa', () => {
  const fnStart = js.indexOf('function renderCreatives(');
  assert.ok(fnStart !== -1);
  const fnEnd = js.indexOf('\nfunction ', fnStart + 10);
  const fn = js.slice(fnStart, fnEnd);
  assert.match(fn, /unmeasured/);
  assert.match(fn, /unmeasured\s*\?\s*['"]—['"]\s*:\s*c\.trackedVisitors/);
  assert.match(fn, /unmeasured\s*\?\s*['"]—['"]\s*:\s*c\.formStarted/);
  // Comenzi create/Checkout/Plătite/Venit raman NEATINSE de trafficDataAvailability — sursa lor
  // (orders) e mereu reala, indiferent de tracking.
  assert.match(fn, /\$\{c\.ordersCreated\}/);
  assert.match(fn, /\$\{c\.reachedCheckout\}/);
  assert.match(fn, /\$\{c\.paidOrders\}/);
});

test('server.js: GET /api/admin/orders/funnel-summary include db.getCreativePerformance(args) in Promise.all si "creatives" in raspunsul JSON', () => {
  const idx = server.indexOf("app.get('/api/admin/orders/funnel-summary'");
  const end = server.indexOf('\n});', idx);
  const routeBody = server.slice(idx, end);
  assert.match(routeBody, /db\.getCreativePerformance\(args\)/);
  assert.match(routeBody, /creatives\s*[,}]/);
});
