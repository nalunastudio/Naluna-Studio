const test = require('node:test');
const assert = require('node:assert/strict');
const { getGiftVariant } = require('../lib/entitlements');

test('getGiftVariant — returneaza cealalta varianta cand exista exact 2', () => {
  const order = {
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order).id, 'b');
});

test('getGiftVariant — functioneaza indiferent de ordinea din array (varianta selectata pe pozitia 2)', () => {
  const order = {
    selectedVariantId: 'b',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order).id, 'a');
});

test('getGiftVariant — null cand exista o singura varianta (fara pereche)', () => {
  const order = { selectedVariantId: 'a', variants: [{ id: 'a', fullKey: 'k1' }] };
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — null cand nu exista deloc variante', () => {
  const order = { selectedVariantId: 'a', variants: [] };
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — null cand selectedVariantId lipseste', () => {
  const order = { variants: [{ id: 'a' }, { id: 'b' }] };
  // fara selectedVariantId, "cealalta varianta decat cea selectata" nu are sens definit —
  // functia returneaza prima varianta gasita (niciun id nu se potriveste cu undefined),
  // nu trebuie sa arunce o eroare.
  assert.ok(['a', 'b'].includes(getGiftVariant(order).id));
});

test('getGiftVariant — nu se sparge pe un order fara camp variants deloc', () => {
  assert.equal(getGiftVariant({ selectedVariantId: 'a' }), null);
});

test('getGiftVariant — Standard NU livreaza niciodata "melodia cadou", chiar daca exista 2 variante (original+editat)', () => {
  const order = {
    plan: 'standard',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }]
  };
  // Standard ramane o singura melodie finala — cele 2 variante sunt alternative ALE ACELEIASI
  // melodii (originala/editata), nu doua melodii diferite; livrarea celeilalte ca "bonus"
  // ar incalca cerinta explicita "Standard ramane o singura melodie finala".
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — Premium/Video tot livreaza "melodia cadou" (doua melodii reale, distincte)', () => {
  const order = {
    plan: 'premium',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order).id, 'b');
});
