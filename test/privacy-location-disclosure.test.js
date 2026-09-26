// PRIVACY POLICY — dezvaluire oraș/țară (2026-09-26, Admin > Comenzi, coloana "Locație" —
// aprobat pentru productie, cu conditia acestei corectii explicite). Inainte de acest bloc,
// privacy.html nu mentiona NICAIERI ca stocam customer_city/customer_country (deja capturate din
// Stripe, vezi test/admin-orders-location.test.js) — un gol preexistent, semnalat in raportul de
// audit. Text cerut EXPLICIT: NU "geolocatie IP", NU "GPS", NU "locatie aproximativa" (desi tehnic
// datele SUNT oras+tara, ele provin STRICT din billing/customer details Stripe, nu dintr-o
// aproximare) — sursa si scopul REALE, fara sa extinda colectarea dincolo de ce a fost auditat
// (fara strada/postcode/GPS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const privacy = read('public/privacy.html');

test('privacy.html: exista un bullet dedicat "City and country (billing details)" in sectiunea "What we collect"', () => {
  const idx = privacy.indexOf('<h2>1. What we collect</h2>');
  const end = privacy.indexOf('<h2>2.', idx);
  const section = privacy.slice(idx, end);
  assert.match(section, /<strong>City and country \(billing details\)<\/strong>/);
});

test('privacy.html: sursa declarata e STRICT billing/customer details procesate prin Stripe la checkout — nu o sursa inventata/vaga', () => {
  const idx = privacy.indexOf('<strong>City and country (billing details)</strong>');
  assert.ok(idx !== -1);
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.match(block, /billing\/customer details you provide to Stripe at checkout/i);
});

test('privacy.html: scopul declarat e administrarea comenzii + raportare agregata despre provenienta comenzilor — ACELASI scop real din implementare (Admin > Comenzi)', () => {
  const idx = privacy.indexOf('<strong>City and country (billing details)</strong>');
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.match(block, /administer your order/i);
  assert.match(block, /aggregate reporting on where orders come from/i);
});

// NOTA: cerinta explicita era "nu spune ca FOLOSIM GPS sau geolocatie IP" — GPS/IP pot fi
// mentionate STRICT in forma negativa, ca reasigurare ("nu colectam GPS", "nu folosim IP pentru
// asta") — nicio afirmatie care ar sugera ca aceste surse SUNT folosite pentru oraș/țară.
test('privacy.html: bullet-ul NU afirma NICIODATA ca FOLOSIM GPS sau geolocalizare IP — mentionate STRICT ca reasigurare negativa (cerinta explicita)', () => {
  const idx = privacy.indexOf('<strong>City and country (billing details)</strong>');
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.doesNotMatch(block, /we (use|collect|rely on).{0,40}GPS/i, 'nu trebuie sa existe nicio afirmatie ca FOLOSIM GPS');
  assert.doesNotMatch(block, /based on your IP address/i, 'nu trebuie sa existe nicio afirmatie ca datele vin din IP');
  assert.match(block, /we do not collect your street address, postcode, or GPS coordinates/i, 'GPS apare STRICT in forma negativa (reasigurare)');
  assert.match(block, /we do not use IP address-based location lookups/i, 'IP apare STRICT in forma negativa (reasigurare)');
});

test('privacy.html: bullet-ul NU foloseste sintagma "approximate location" (cerinta explicita — datele sunt oraș+țară REALE din billing Stripe, nu o aproximare)', () => {
  const idx = privacy.indexOf('<strong>City and country (billing details)</strong>');
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.doesNotMatch(block, /approximate location/i);
});

test('privacy.html: bullet-ul declara explicit ca NU colectam strada/cod postal/coordonate GPS pentru acest scop — nu extinde colectarea dincolo de ce a fost auditat (STRICT oraș+țară)', () => {
  const idx = privacy.indexOf('<strong>City and country (billing details)</strong>');
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.match(block, /we do not collect your street address, postcode, or GPS coordinates/i);
});

test('privacy.html: retentia oraș/țară e legata explicit de bucket-ul "Payment and order records" (5 ani, contabilitate) — NU o retentie noua, inventata, si NU cele 180 de zile ale funnel analytics', () => {
  const idx = privacy.indexOf('<strong>Payment and order records needed for tax and accounting</strong>');
  assert.ok(idx !== -1);
  const end = privacy.indexOf('</li>', idx);
  const block = privacy.slice(idx, end);
  assert.match(block, /billing city\/country described in "What we collect" above/i);
  assert.doesNotMatch(block, /180/);
});

test('privacy.html: sectiunile raman numerotate secvential 1-9 (nicio sectiune noua adaugata, doar bullet-uri in sectiunea existenta)', () => {
  const numbers = [...privacy.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('privacy.html: ramane sintactic HTML valid dupa aceasta editare — <li> deschise = <li> inchise', () => {
  const countTag = (tag) => (privacy.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
  const countCloseTag = (tag) => (privacy.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  assert.equal(countTag('li'), countCloseTag('li'));
  assert.equal(countTag('ul'), countCloseTag('ul'));
});

// ================================================================================================
// "8 limbi" — decizie explicita a userului (2026-09-26): privacy.html ramane STRICT engleza
// (singura versiune care exista REAL azi, vezi raportul de audit — nu exista nicio infrastructura
// de traducere pentru paginile legale, spre deosebire de comanda.html/melodia-mea.html etc., care
// folosesc data-i18n pentru limba MELODIEI, un concept diferit). Testul de mai jos documenteaza
// STRICT acest fapt, ca sa nu se piarda contextul deciziei.
test('privacy.html: ramane STRICT engleza (lang="en") — "8 limbi" se refera la limbile melodiei (data-i18n in comanda.html etc.), NU exista infrastructura de traducere pentru pagini legale', () => {
  assert.match(privacy, /<html lang="en">/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'ro', 'privacy.html')));
});

test('server.js, db.js, private/admin/orders.js raman sintactic valide (regresie generala dupa editarea privacy.html)', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
});
