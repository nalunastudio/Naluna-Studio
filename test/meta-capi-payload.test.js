// lib/meta-capi/capi-payload.js — logica PURA de construire a evenimentului Purchase. Acopera:
// normalizare+hash email, event_id determinist, fbp trecut mai departe STRICT daca exista
// (niciodata inventat), fbc NICIODATA acceptat/inclus, value/currency/order_id corecte, fara
// email brut (raw PII) in payload-ul construit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalizeEmail, hashEmail, buildEventId, buildPurchaseEvent } = require('../lib/meta-capi/capi-payload');

test('normalizeEmail: trim + lowercase, STRICT (Meta nu cere eliminarea punctelor/alias-urilor)', () => {
  assert.equal(normalizeEmail('  Test.User+alias@Example.COM  '), 'test.user+alias@example.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('hashEmail: SHA-256 al emailului normalizat (verificat impotriva unui hash calculat manual)', () => {
  const email = 'Client@Example.com';
  const expected = createHash('sha256').update('client@example.com', 'utf8').digest('hex');
  assert.equal(hashEmail(email), expected);
});

test('hashEmail: email lipsa/gol -> null (niciodata hash-ul unui string gol)', () => {
  assert.equal(hashEmail(''), null);
  assert.equal(hashEmail(null), null);
  assert.equal(hashEmail(undefined), null);
});

test('buildEventId: determinist, STRICT derivat din orderId — acelasi orderId -> acelasi event_id de fiecare data', () => {
  assert.equal(buildEventId('order-123'), 'purchase_order-123');
  assert.equal(buildEventId('order-123'), buildEventId('order-123'));
  assert.notEqual(buildEventId('order-123'), buildEventId('order-456'));
});

test('buildPurchaseEvent: structura completa, corecta — event_name/event_time/event_id/action_source/custom_data', () => {
  const event = buildPurchaseEvent({
    orderId: 'order-abc', eventTimeSeconds: 1700000000, value: 24.5, currency: 'gbp',
    email: 'buyer@example.com', fbp: 'fb.1.1600000000000.1234567890'
  });
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_time, 1700000000);
  assert.equal(event.event_id, 'purchase_order-abc');
  assert.equal(event.action_source, 'website');
  assert.equal(event.custom_data.currency, 'GBP', 'currency trebuie normalizata la majuscule (ISO 4217)');
  assert.equal(event.custom_data.value, 24.5, 'value trebuie sa fie EXACT cea primita, fara recalculare');
  assert.equal(event.custom_data.order_id, 'order-abc');
});

test('buildPurchaseEvent: user_data.em contine STRICT hash-ul emailului, NICIODATA emailul brut', () => {
  const event = buildPurchaseEvent({ orderId: 'order-1', eventTimeSeconds: 1700000000, value: 10, currency: 'gbp', email: 'raw@example.com' });
  assert.deepEqual(event.user_data.em, [hashEmail('raw@example.com')]);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('raw@example.com'), 'emailul brut nu trebuie sa apara NICIODATA in evenimentul construit');
  assert.ok(!serialized.toLowerCase().includes('@example.com'), 'niciun email in forma citibila, hash-uit sau nu, altul decat hash-ul hex');
});

test('buildPurchaseEvent: fbp trecut mai departe DOAR daca a fost furnizat — niciodata inventat', () => {
  const withFbp = buildPurchaseEvent({ orderId: 'o1', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com', fbp: 'fb.1.111.222' });
  assert.equal(withFbp.user_data.fbp, 'fb.1.111.222');

  const withoutFbp = buildPurchaseEvent({ orderId: 'o2', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com', fbp: null });
  assert.ok(!Object.prototype.hasOwnProperty.call(withoutFbp.user_data, 'fbp'), 'fbp NU trebuie sa apara deloc daca lipseste — niciodata o valoare goala/inventata');
});

test('buildPurchaseEvent: NU exista niciun parametru/camp pentru fbc — modulul nu accepta si nu poate include vreodata o valoare inventata', () => {
  // fbc trimis explicit ca argument extra -> functia il ignora complet (nu exista in semnatura),
  // garantie structurala ca nu poate "scapa" printr-un refactor accidental care ar adauga ...rest.
  const event = buildPurchaseEvent({ orderId: 'o3', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com', fbc: 'fb.1.999.888' });
  assert.ok(!Object.prototype.hasOwnProperty.call(event.user_data, 'fbc'), 'fbc nu trebuie sa apara NICIODATA in evenimentul construit');
  assert.ok(!JSON.stringify(event).includes('999.888'), 'valoarea fbc pasata din greseala nu trebuie sa ajunga NICIUNDE in payload');
});

test('buildPurchaseEvent: event_source_url inclus DOAR daca a fost furnizat', () => {
  const withUrl = buildPurchaseEvent({ orderId: 'o4', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com', eventSourceUrl: 'https://nalunastudio.com/succes.html?order=o4' });
  assert.equal(withUrl.event_source_url, 'https://nalunastudio.com/succes.html?order=o4');

  const withoutUrl = buildPurchaseEvent({ orderId: 'o5', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com' });
  assert.ok(!Object.prototype.hasOwnProperty.call(withoutUrl, 'event_source_url'));
});

test('buildPurchaseEvent: acelasi orderId apelat de doua ori produce EXACT acelasi event_id (idempotenta/deduplicare)', () => {
  const e1 = buildPurchaseEvent({ orderId: 'order-dup', eventTimeSeconds: 1, value: 1, currency: 'gbp', email: 'a@b.com' });
  const e2 = buildPurchaseEvent({ orderId: 'order-dup', eventTimeSeconds: 2, value: 2, currency: 'usd', email: 'x@y.com' });
  assert.equal(e1.event_id, e2.event_id);
});
