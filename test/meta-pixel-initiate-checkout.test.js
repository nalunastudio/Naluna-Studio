// META PIXEL V1 — InitiateCheckout (2026-09-24, evenimente Meta pre-purchase). Verifica STRICT
// punctul de apel confirmat de audit: public/melodia-mea.html, goToCheckout(), EXACT acelasi loc
// ca begin_checkout existent (sesiune Stripe confirmata valida, imediat inainte de redirectul
// real) — NICIODATA la simplul checkout_clicked (care include si cererile esuate/abandonate).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const melodia = read('public/melodia-mea.html');

test('goToCheckout(): trackMeta("InitiateCheckout", ...) e apelat STRICT in interiorul "if (data.url) {" (sesiune Stripe confirmata), ALATURI de begin_checkout existent, ambele INAINTEA redirectului real', () => {
  const fnStart = melodia.indexOf('async function goToCheckout() {');
  assert.ok(fnStart !== -1, 'goToCheckout() trebuie sa existe');
  const dataUrlIdx = melodia.indexOf('if (data.url) {', fnStart);
  assert.ok(dataUrlIdx !== -1);
  const beginCheckoutIdx = melodia.indexOf("window.NalunaAnalytics.track('begin_checkout'", dataUrlIdx);
  const trackMetaIdx = melodia.indexOf("window.NalunaAnalytics.trackMeta('InitiateCheckout'", dataUrlIdx);
  const redirectIdx = melodia.indexOf('window.location.href = data.url;', dataUrlIdx);
  assert.ok(beginCheckoutIdx !== -1, 'begin_checkout trebuie sa existe, neschimbat');
  assert.ok(trackMetaIdx !== -1, 'trackMeta InitiateCheckout trebuie sa existe');
  assert.ok(redirectIdx !== -1, 'redirectul real trebuie sa existe');
  // Ordinea exacta: dataUrlIdx < beginCheckoutIdx < trackMetaIdx < redirectIdx — InitiateCheckout
  // DUPA begin_checkout (langa el), dar STRICT inainte de redirect.
  assert.ok(dataUrlIdx < beginCheckoutIdx && beginCheckoutIdx < trackMetaIdx && trackMetaIdx < redirectIdx,
    'ordinea trebuie sa fie: sesiune confirmata -> begin_checkout -> InitiateCheckout -> redirect real');
});

test('InitiateCheckout foloseste datele reale deja disponibile: currentOrder.price, GBP, orderId (content_ids) — nimic inventat', () => {
  const idx = melodia.indexOf("window.NalunaAnalytics.trackMeta('InitiateCheckout'");
  const call = melodia.slice(idx, melodia.indexOf(');', idx) + 2);
  assert.match(call, /value:\s*currentOrder\.price/);
  assert.match(call, /currency:\s*'GBP'/);
  assert.match(call, /content_ids:\s*\[orderId\]/);
});

test('InitiateCheckout NU e trimis la simplul checkout_clicked (inainte de raspunsul serverului) — apare STRICT o singura data in tot fisierul, in interiorul goToCheckout()', () => {
  const matches = melodia.match(/trackMeta\('InitiateCheckout'/g) || [];
  assert.equal(matches.length, 1, 'trebuie sa existe STRICT un singur punct de trimitere InitiateCheckout in toata pagina');
  const checkoutClickedIdx = melodia.indexOf("track('checkout_clicked'");
  const trackMetaIdx = melodia.indexOf("trackMeta('InitiateCheckout'");
  assert.ok(checkoutClickedIdx !== -1 && trackMetaIdx !== -1 && checkoutClickedIdx < trackMetaIdx,
    'checkout_clicked (intentie, la click) trebuie sa ramana STRICT inaintea InitiateCheckout (intentie confirmata, la sesiune Stripe validata)');
});

test('begin_checkout (GA4/funnel existent) ramane STRICT neschimbat de aceasta adaugare', () => {
  assert.match(
    melodia,
    /window\.NalunaAnalytics\.track\('begin_checkout', \{\s*currency: 'GBP',\s*value: currentOrder\.price,\s*package: currentOrder\.plan,\s*order_id: orderId\s*\}\);/
  );
});

test('melodia-mea.html ramane sintactic valid', () => {
  const start = melodia.indexOf('<script>');
  const end = melodia.lastIndexOf('</script>');
  const inline = melodia.slice(start + '<script>'.length, end);
  assert.doesNotThrow(() => new Function(inline));
});
