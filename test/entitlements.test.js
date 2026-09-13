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

// CORECȚIE (2026-09-13, "livrare Standard/Premium/Video dupa plata"): Standard livreaza acum
// "melodia cadou" cu ACEEASI regula STRICTA ca Video (exact 2 variante, exact una marcata real
// ca editare) — vezi lib/entitlements.js pentru contextul complet al reversarii hotfix-ului
// 2026-08-08.
test('getGiftVariant — Standard livreaza "melodia cadou" cand exista o editare REALA (exact 2 variante, exact una marcata isEditedAlternative)', () => {
  const order = {
    plan: 'standard',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }]
  };
  const gift = getGiftVariant(order);
  assert.ok(gift);
  assert.equal(gift.id, 'b');
});

test('getGiftVariant — Standard: NICIUN cadou daca are doar 1 varianta (nicio editare a existat vreodata)', () => {
  const order = { plan: 'standard', selectedVariantId: 'a', variants: [{ id: 'a', fullKey: 'k1' }] };
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — Standard: NICIUN cadou pentru o comanda VECHE cu 2 variante NEMARCATE (niciuna isEditedAlternative) — nu acorda acces accidental', () => {
  const order = {
    plan: 'standard',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order), null, 'fara marcajul explicit de editare, cele 2 variante nu formeaza o pereche legitima initiala+editata');
});

test('getGiftVariant — Premium livreaza "melodia cadou" (doua melodii reale, distincte), fara sa ceara isEditedAlternative', () => {
  const order = {
    plan: 'premium',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order).id, 'b');
});

// ---------------------------------------------------------------------------------------------
// CORECȚIE (2026-08-30, Cerinta 7, "dupa plata, clientul primeste ambele melodii"): Video
// livreaza acum bonusul (melodia neselectata), DAR STRICT cand exista o pereche legitima —
// exact 2 variante, exact una marcata REAL ca editare (isEditedAlternative). Regula e mai
// STRICTA decat la Premium (care nu cere deloc acest marcaj), tocmai ca sa nu acorde acces
// accidental unor comenzi vechi cu 2 variante nemarcate.
// ---------------------------------------------------------------------------------------------
test('getGiftVariant — Video livreaza bonusul cand exista o editare REALA (exact 2 variante, exact una marcata isEditedAlternative)', () => {
  const order = {
    plan: 'video',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }]
  };
  const gift = getGiftVariant(order);
  assert.ok(gift);
  assert.equal(gift.id, 'b');
});

test('getGiftVariant — Video: bonusul e varianta INITIALA cand clientul a selectat pentru checkout varianta EDITATA (functioneaza in ambele directii)', () => {
  const order = {
    plan: 'video',
    selectedVariantId: 'b', // a ales editarea pentru checkout/video
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }]
  };
  const gift = getGiftVariant(order);
  assert.ok(gift);
  assert.equal(gift.id, 'a', 'bonusul trebuie sa fie varianta INITIALA, cea neselectata');
});

test('getGiftVariant — Video: NICIUN bonus daca are doar 1 varianta (nicio editare a existat vreodata)', () => {
  const order = { plan: 'video', selectedVariantId: 'a', variants: [{ id: 'a', fullKey: 'k1' }] };
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — Video: NICIUN bonus pentru o comanda VECHE cu 2 variante NEMARCATE (niciuna isEditedAlternative) — nu acorda acces accidental', () => {
  const order = {
    plan: 'video',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2' }]
  };
  assert.equal(getGiftVariant(order), null, 'fara marcajul explicit de editare, cele 2 variante nu formeaza o pereche legitima initiala+editata');
});

test('getGiftVariant — Video: NICIUN bonus daca (defensiv, nu ar trebui sa se intample niciodata in practica) AMBELE variante sunt marcate isEditedAlternative', () => {
  const order = {
    plan: 'video',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1', isEditedAlternative: true }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }]
  };
  assert.equal(getGiftVariant(order), null);
});

test('getGiftVariant — Video: NICIUN bonus daca exista 3+ variante (structura neasteptata pentru Video — Video are STRICT 2 variante posibile, niciodata 3+)', () => {
  const order = {
    plan: 'video',
    selectedVariantId: 'a',
    variants: [{ id: 'a', fullKey: 'k1' }, { id: 'b', fullKey: 'k2', isEditedAlternative: true }, { id: 'c', fullKey: 'k3' }]
  };
  assert.equal(getGiftVariant(order), null);
});
