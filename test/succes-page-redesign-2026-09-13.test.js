// Teste pentru cerinta "livrare Standard/Premium/Video dupa plata + redesign pagina finala"
// (2026-09-13): (1) Standard livreaza acum "melodia cadou" (revizuire hotfix 2026-08-08); (2)
// Premium arata AMBELE melodii cumparate (selectedVariantId + selectedVariantId2) ca "incluse in
// pachet", niciodata ca "cadou" — a doua melodie NU e un bonus, e parte din pachetul platit; (3)
// layout vertical (page-wrap), footer legal mutat la finalul fluxului DOM; (4) traducerile noi
// exista in toate cele 8 limbi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const succes = read('public/succes.html');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function loadSuccesTranslations() {
  const start = succes.indexOf('const T = ');
  let depth = 0, i = succes.indexOf('{', start);
  for (; i < succes.length; i++) {
    if (succes[i] === '{') depth++;
    else if (succes[i] === '}') { depth--; if (depth === 0) break; }
  }
  return new Function(`${succes.slice(start, i + 1)}\nreturn T;`)();
}

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// Extrage STRICT sectiunea giftVariant/giftUrl/isPremiumSecondPurchasedSong din renderReadyCard,
// rulata cu date sintetice — fara restul functiei, care manipuleaza DOM real.
function computeEntitlementFor(data) {
  const fnBody = extractFn(succes, 'function renderReadyCard(data) {');
  const startMarker = 'const variant = (data.variants || []).find';
  const endMarker = 'let extrasHtml';
  const start = fnBody.indexOf(startMarker);
  const end = fnBody.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1);
  const snippet = fnBody.slice(start, end);
  const sandboxSrc = `
    const orderId = 'test-order';
    const accessToken = 'test-token';
    const t = { variant_original_label: 'ORIGINAL', variant_edited_label: 'EDITED', video_song_title: 'GENERIC_MAIN' };
    ${snippet}
    return { giftVariant, giftUrl, isPremiumSecondPurchasedSong };
  `;
  return new Function('data', sandboxSrc)(data);
}

// ===============================================================================================
// STANDARD — CORECȚIE 2026-09-13: livreaza acum bonusul, cu ACEEASI regula STRICTA ca Video.
// ===============================================================================================
test('succes.html FUNCTIONAL: Standard cu o editare REALA (exact 2 variante, exact una editata) primeste giftUrl', () => {
  const data = {
    plan: 'standard',
    selectedVariantId: 'v1',
    variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b', isEditedAlternative: true }]
  };
  const { giftVariant, giftUrl, isPremiumSecondPurchasedSong } = computeEntitlementFor(data);
  assert.ok(giftVariant && giftVariant.id === 'v2');
  assert.ok(giftUrl);
  assert.equal(isPremiumSecondPurchasedSong, false);
});

test('succes.html FUNCTIONAL: Standard fara nicio editare (o singura varianta) NU primeste giftUrl', () => {
  const data = { plan: 'standard', selectedVariantId: 'v1', variants: [{ id: 'v1', fullKey: 'a' }] };
  const { giftVariant, giftUrl } = computeEntitlementFor(data);
  assert.equal(giftVariant, null);
  assert.equal(giftUrl, null);
});

test('succes.html FUNCTIONAL: Standard cu o comanda VECHE (2 variante NEMARCATE) NU primeste giftUrl accidental', () => {
  const data = { plan: 'standard', selectedVariantId: 'v1', variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b' }] };
  const { giftVariant, giftUrl } = computeEntitlementFor(data);
  assert.equal(giftVariant, null);
  assert.equal(giftUrl, null);
});

// ===============================================================================================
// PREMIUM — cele doua melodii CUMPARATE (selectedVariantId + selectedVariantId2) sunt "incluse
// in pachet", niciodata etichetate ca "cadou" (isPremiumSecondPurchasedSong === true).
// ===============================================================================================
test('succes.html FUNCTIONAL: Premium cu selectedVariantId2 — giftUrl serveste EXACT a doua melodie cumparata, marcata isPremiumSecondPurchasedSong', () => {
  const data = {
    plan: 'premium',
    selectedVariantId: 'v1',
    selectedVariantId2: 'v2',
    variants: [{ id: 'v1', fullKey: 'a', genre: 'jazz' }, { id: 'v2', fullKey: 'b', genre: 'pop' }]
  };
  const { giftVariant, giftUrl, isPremiumSecondPurchasedSong } = computeEntitlementFor(data);
  assert.ok(giftVariant && giftVariant.id === 'v2', 'a doua melodie cumparata trebuie servita prin acelasi slot tehnic /gift');
  assert.ok(giftUrl);
  assert.equal(isPremiumSecondPurchasedSong, true, 'trebuie marcata explicit ca NU e un cadou real, ci a doua melodie platita');
});

test('succes.html FUNCTIONAL: Premium cu selectedVariantId2 SI editari suplimentare — a doua melodie ramane STRICT selectedVariantId2, niciodata o alta varianta din array', () => {
  const data = {
    plan: 'premium',
    selectedVariantId: 'v1',
    selectedVariantId2: 'v2',
    variants: [
      { id: 'v1', fullKey: 'a', genre: 'jazz' },
      { id: 'v2', fullKey: 'b', genre: 'pop' },
      { id: 'v3', fullKey: 'c', genre: 'jazz', isEditedAlternative: true },
      { id: 'v4', fullKey: 'd', genre: 'pop', isEditedAlternative: true }
    ]
  };
  const { giftVariant, isPremiumSecondPurchasedSong } = computeEntitlementFor(data);
  assert.equal(giftVariant.id, 'v2', 'ambiguitatea (3-4 variante reale) trebuie rezolvata STRICT prin selectedVariantId2, niciodata prin "prima alta varianta gasita"');
  assert.equal(isPremiumSecondPurchasedSong, true);
});

test('succes.html FUNCTIONAL: Premium FOARTE VECHI (fara selectedVariantId2) ramane pe regula originala — "cealalta varianta" e un cadou real, NU isPremiumSecondPurchasedSong', () => {
  const data = { plan: 'premium', selectedVariantId: 'v1', variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b' }] };
  const { giftVariant, giftUrl, isPremiumSecondPurchasedSong } = computeEntitlementFor(data);
  assert.ok(giftVariant && giftVariant.id === 'v2');
  assert.ok(giftUrl);
  assert.equal(isPremiumSecondPurchasedSong, false, 'comportamentul vechi (dinainte de migrarea la selectedVariantId2) ramane un cadou real, neschimbat');
});

// ===============================================================================================
// TRADUCERI — cheile noi exista in toate cele 8 limbi, fara fallback accidental in engleza.
// ===============================================================================================
test('succes.html: gift_badge, included_song_1, included_song_2 exista in toate cele 8 limbi', () => {
  const T = loadSuccesTranslations();
  for (const lang of LANGS) {
    assert.ok(T[lang].gift_badge && T[lang].gift_badge.trim(), `lipseste gift_badge pentru ${lang}`);
    assert.ok(T[lang].included_song_1 && T[lang].included_song_1.trim(), `lipseste included_song_1 pentru ${lang}`);
    assert.ok(T[lang].included_song_2 && T[lang].included_song_2.trim(), `lipseste included_song_2 pentru ${lang}`);
  }
});

test('succes.html: nicio limba nu ramane pe fallback-ul in engleza pentru cheile noi (gift_badge distinct de varianta EN, cu exceptia EN insusi)', () => {
  const T = loadSuccesTranslations();
  const enValue = T.en.gift_badge;
  for (const lang of LANGS) {
    if (lang === 'en') continue;
    assert.notEqual(T[lang].gift_badge, enValue, `${lang}.gift_badge pare sa fi ramas pe fallback-ul englez`);
  }
});

// ===============================================================================================
// LAYOUT — body nu mai e display:flex fara flex-direction (bug-ul "doua coloane" pe mobil);
// .card si <footer> sunt acum copii directi ai aceluiasi .page-wrap, in ordine DOM verticala.
// ===============================================================================================
test('succes.html: body nu mai foloseste display:flex (elimina bug-ul de layout orizontal fata de footer)', () => {
  const styleBlock = succes.slice(succes.indexOf('<style>'), succes.indexOf('</style>'));
  const bodyRuleIdx = styleBlock.indexOf('body{');
  const bodyRule = styleBlock.slice(bodyRuleIdx, styleBlock.indexOf('}', bodyRuleIdx));
  assert.ok(!bodyRule.includes('display:flex'), 'body nu mai trebuie sa fie flex — .card/<footer> trebuie sa se aseze vertical prin block layout normal');
});

test('succes.html: .card si <footer> sunt copii directi ai .page-wrap, in aceasta ordine DOM', () => {
  const wrapIdx = succes.indexOf('<div class="page-wrap">');
  const cardIdx = succes.indexOf('id="card"');
  const footerIdx = succes.indexOf('<footer class="page-footer">');
  assert.ok(wrapIdx !== -1 && cardIdx !== -1 && footerIdx !== -1, 'toate cele 3 elemente trebuie sa existe');
  assert.ok(wrapIdx < cardIdx && cardIdx < footerIdx, 'ordinea DOM trebuie sa fie: page-wrap -> card -> footer (footer dupa continut, niciodata langa el)');
});

test('succes.html: footer-ul legal nu mai apare duplicat la finalul fisierului (era prezent o singura data, dupa </script>, inainte)', () => {
  const count = (succes.match(/<footer class=/g) || []).length;
  assert.equal(count, 1, 'trebuie sa existe exact un singur footer in pagina');
});

test('lib/entitlements.js si public/succes.html raman sintactic valide dupa aceasta corectie', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib/entitlements.js')]));
  const scripts = [...succes.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
