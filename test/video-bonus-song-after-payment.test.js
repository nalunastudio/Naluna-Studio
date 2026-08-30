// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerința 7): dupa plata, daca exista o editare
// REALA, clientul primeste videoclipul (STRICT al variantei selectate) SI ambele melodii complete
// (initiala + editata), ca fisiere audio — cu etichetele "Versiunea inițială"/"Versiunea editată".
// Fara nicio editare, comportamentul ramane exact ca inainte (o singura melodie + videoclip).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getGiftVariant } = require('../lib/entitlements');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const succes = read('public/succes.html');
const server = read('server.js');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function loadSuccesTranslations() {
  const start = succes.indexOf('const translations = ') !== -1 ? succes.indexOf('const translations = ') : succes.indexOf('const T = ');
  let depth = 0, i = succes.indexOf('{', start);
  for (; i < succes.length; i++) {
    if (succes[i] === '{') depth++;
    else if (succes[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = succes.slice(start, i + 1);
  const varName = succes.indexOf('const translations = ') !== -1 ? 'translations' : 'T';
  return new Function(`${src}\nreturn ${varName};`)();
}

// ===============================================================================================
// PARTEA 1 — succes.html: etichetele "Versiunea inițială"/"Versiunea editată" exista in toate
// cele 8 limbi, reutilizand exact textul deja folosit in melodia-mea.html.
// ===============================================================================================
test('public/succes.html: variant_original_label si variant_edited_label exista in toate cele 8 limbi', () => {
  const T = loadSuccesTranslations();
  for (const lang of LANGS) {
    assert.ok(T[lang].variant_original_label && T[lang].variant_original_label.trim(), `lipseste variant_original_label pentru ${lang}`);
    assert.ok(T[lang].variant_edited_label && T[lang].variant_edited_label.trim(), `lipseste variant_edited_label pentru ${lang}`);
    assert.notEqual(T[lang].variant_original_label, T[lang].variant_edited_label, `etichetele trebuie sa fie distincte (${lang})`);
  }
});

test('public/succes.html si public/melodia-mea.html: variant_original_label/variant_edited_label sunt IDENTICE intre cele doua pagini, in toate cele 8 limbi (reutilizare explicita, nu text nou inventat)', () => {
  const melodia = read('public/melodia-mea.html');
  function loadMelodiaTranslations() {
    const start = melodia.indexOf('const T = ');
    let depth = 0, i = melodia.indexOf('{', start);
    for (; i < melodia.length; i++) {
      if (melodia[i] === '{') depth++;
      else if (melodia[i] === '}') { depth--; if (depth === 0) break; }
    }
    return new Function(`${melodia.slice(start, i + 1)}\nreturn T;`)();
  }
  const succesT = loadSuccesTranslations();
  const melodiaT = loadMelodiaTranslations();
  for (const lang of LANGS) {
    assert.equal(succesT[lang].variant_original_label, melodiaT[lang].variant_original_label, `(${lang}) eticheta "inițială" trebuie sa fie identica intre pagini`);
    assert.equal(succesT[lang].variant_edited_label, melodiaT[lang].variant_edited_label, `(${lang}) eticheta "editată" trebuie sa fie identica intre pagini`);
  }
});

// ===============================================================================================
// PARTEA 2 — FUNCTIONAL: logica videoMainLabel/videoGiftLabel din renderReadyCard(), extrasa si
// rulata cu date sintetice — nu doar text-matching.
// ===============================================================================================
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

function computeLabelsFor(data) {
  const fnBody = extractFn(succes, 'function renderReadyCard(data) {');
  // izolam STRICT sectiunea relevanta (giftVariant + videoMainLabel/videoGiftLabel), fara restul
  // functiei (care manipuleaza DOM real, indisponibil in acest sandbox).
  const startMarker = 'const variant = (data.variants || []).find';
  const endMarker = 'let resultHtml;';
  const start = fnBody.indexOf(startMarker);
  const end = fnBody.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1);
  const snippet = fnBody.slice(start, end);
  const sandboxSrc = `
    const orderId = 'test-order';
    const accessToken = 'test-token';
    const t = { variant_original_label: 'ORIGINAL', variant_edited_label: 'EDITED', video_song_title: 'GENERIC_MAIN' };
    ${snippet}
    return { giftVariant, videoMainLabel, videoGiftLabel, giftUrl };
  `;
  return new Function('data', sandboxSrc)(data);
}

test('succes.html FUNCTIONAL: cu o editare REALA, varianta selectata=ORIGINALA — eticheta principala e "ORIGINAL", eticheta bonusului e "EDITED"', () => {
  const data = {
    plan: 'video',
    selectedVariantId: 'v1',
    variants: [{ id: 'v1', fullKey: 'a', hasVideo: true }, { id: 'v2', fullKey: 'b', isEditedAlternative: true }]
  };
  const { videoMainLabel, videoGiftLabel, giftVariant, giftUrl } = computeLabelsFor(data);
  assert.ok(giftVariant && giftVariant.id === 'v2');
  assert.ok(giftUrl, 'trebuie sa existe un link de descarcare pentru bonus');
  assert.equal(videoMainLabel, 'ORIGINAL');
  assert.equal(videoGiftLabel, 'EDITED');
});

test('succes.html FUNCTIONAL: cu o editare REALA, varianta selectata=EDITATA — eticheta principala e "EDITED", eticheta bonusului e "ORIGINAL" (functioneaza in ambele directii)', () => {
  const data = {
    plan: 'video',
    selectedVariantId: 'v2',
    variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b', isEditedAlternative: true, hasVideo: true }]
  };
  const { videoMainLabel, videoGiftLabel, giftVariant } = computeLabelsFor(data);
  assert.ok(giftVariant && giftVariant.id === 'v1');
  assert.equal(videoMainLabel, 'EDITED');
  assert.equal(videoGiftLabel, 'ORIGINAL');
});

test('succes.html FUNCTIONAL: FARA nicio editare reala (o singura varianta) — nu exista bonus, eticheta principala ramane GENERICA (comportament vechi neschimbat)', () => {
  const data = { plan: 'video', selectedVariantId: 'v1', variants: [{ id: 'v1', fullKey: 'a', hasVideo: true }] };
  const { videoMainLabel, giftVariant, giftUrl } = computeLabelsFor(data);
  assert.equal(giftVariant, null);
  assert.equal(giftUrl, null);
  assert.equal(videoMainLabel, 'GENERIC_MAIN', 'fara editare, titlul ramane cel generic vechi, nu "ORIGINAL"/"EDITED"');
});

test('succes.html FUNCTIONAL: comanda VECHE cu 2 variante NEMARCATE (niciuna editare) — NU primeste bonus accidental, eticheta ramane generica', () => {
  const data = {
    plan: 'video',
    selectedVariantId: 'v1',
    variants: [{ id: 'v1', fullKey: 'a', hasVideo: true }, { id: 'v2', fullKey: 'b' }]
  };
  const { videoMainLabel, giftVariant } = computeLabelsFor(data);
  assert.equal(giftVariant, null, 'fara marcaj explicit de editare, nu trebuie acordat accces la a doua melodie');
  assert.equal(videoMainLabel, 'GENERIC_MAIN');
});

test('succes.html FUNCTIONAL: Standard nu primeste niciodata etichetele Versiune inițială/editată (ramane pe fluxul generic existent)', () => {
  const data = { plan: 'standard', selectedVariantId: 'v1', variants: [{ id: 'v1', fullKey: 'a' }, { id: 'v2', fullKey: 'b', isEditedAlternative: true }] };
  const { videoMainLabel, giftVariant } = computeLabelsFor(data);
  assert.equal(videoMainLabel, 'GENERIC_MAIN', 'Standard nu intra niciodata pe ramura de etichetare video');
  // Standard TOT primeste giftUrl prin fluxul generic (ramura else, neschimbata) — dar nu prin
  // logica STRICTA video; verificat separat in test/entitlements.test.js.
  assert.ok(giftVariant, 'ramura genericului (fallback) tot gaseste "cealalta varianta" pentru orice plan diferit de video in acest sandbox izolat — comportamentul REAL Standard e gatat de getGiftVariant in server.js, testat separat');
});

// ===============================================================================================
// PARTEA 3 — Video/WAV principal raman STRICT ale variantei selectate; niciun al doilea
// videoclip; WAV-ul bonusului nu e generat special (doar MP3, deja existent).
// ===============================================================================================
test('succes.html: videoUrl (playerul principal) foloseste STRICT selectedVariantId — niciodata varianta bonus', () => {
  const fnBody = extractFn(succes, 'function renderReadyCard(data) {');
  assert.ok(fnBody.includes("const variant = (data.variants || []).find(v => v.id === data.selectedVariantId)"));
  assert.ok(!fnBody.includes('giftVariant.videoKey'), 'varianta bonus nu trebuie sa aiba niciodata propriul videoclip — un singur videoclip, al variantei selectate');
});

test('server.js: nu exista nicio generare de videoclip/WAV special pentru varianta bonus — extrasele raman generate STRICT pentru selectedVariantId (generatePremiumExtras)', () => {
  const fnBody = extractFn(server, 'async function generatePremiumExtras(orderId, options = {}) {');
  assert.ok(!fnBody.includes('giftVariant'), 'generatePremiumExtras nu trebuie sa stie nimic despre "varianta bonus" — WAV/video raman STRICT ale variantei selectate, bonusul ofera doar MP3-ul deja existent');
});

// ===============================================================================================
// PARTEA 4 — securitate: accesul ramane STRICT post-plata + token valid (endpoint neschimbat).
// ===============================================================================================
test('server.js: GET /media/full/:orderId/gift ramane gated STRICT pe order.status===\'ready\' (post-plata) SI token valid (safeCompare) — neschimbat de aceasta corectie', () => {
  const idx = server.indexOf("app.get('/media/full/:orderId/gift'");
  const fnBody = extractFn(server, "app.get('/media/full/:orderId/gift', async (req, res, next) => {");
  assert.ok(fnBody.includes('safeCompare('), 'trebuie sa foloseasca comparatie timing-safe a token-ului');
  assert.ok(fnBody.includes("if (order.status !== 'ready')"), 'trebuie sa refuze accesul inainte de confirmarea platii');
  assert.ok(fnBody.includes('getGiftVariant(order)'));
});

test('lib/entitlements.js si server.js raman sintactic valide dupa aceasta corectie', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib/entitlements.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  const scripts = [...succes.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
