// Teste pentru cerinta (2026-09-13, runda 2) "a treia melodie cadou pentru Premium": pe langa
// cele 2 melodii CUMPARATE (selectedVariantId + selectedVariantId2, deja acoperite in
// test/succes-page-redesign-2026-09-13.test.js), Premium livreaza acum si o A TREIA melodie,
// aleasa RANDOM dintre variantele NESELECTATE de client, STRICT ca surpriza post-plata.
//
// Exemplul explicit din cerinta: sunt generate A/B/C/D, clientul alege A si C -> bonusul e ales
// random din {B, D}. Acoperim: exact 3 melodii livrate, primele 2 = exact selectiile clientului,
// bonusul vine STRICT din variantele neselectate (niciodata una dintre cele 2 alese), doar a
// treia e marcata "cadou", traducerile in toate cele 8 limbi, si ca layout-ul ramane corect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pickPremiumBonusVariantId, getPremiumBonusVariant } = require('../lib/entitlements');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const succes = read('public/succes.html');
const server = read('server.js');
const dbjs = read('db.js');
const comandaMea = read('public/comanda-mea.html');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===============================================================================================
// PARTEA 1 — pickPremiumBonusVariantId: alegerea REALA, executata (nu doar text-matching).
// ===============================================================================================
const orderABCD = {
  plan: 'premium',
  selectedVariantId: 'A',
  selectedVariantId2: 'C',
  variants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]
};

test('pickPremiumBonusVariantId: exemplul EXACT din cerinta — A/B/C/D generate, client alege A+C, bonusul vine STRICT din {B, D}', () => {
  for (let i = 0; i < 200; i++) {
    const id = pickPremiumBonusVariantId(orderABCD);
    assert.ok(id === 'B' || id === 'D', `bonusul (${id}) trebuie sa fie STRICT B sau D, niciodata altceva`);
    assert.notEqual(id, 'A', 'bonusul nu poate fi niciodata una dintre variantele SELECTATE');
    assert.notEqual(id, 'C', 'bonusul nu poate fi niciodata una dintre variantele SELECTATE');
  }
});

test('pickPremiumBonusVariantId: alegerea e cu adevarat RANDOM — pe multe rulari, ambele variante neselectate (B si D) apar', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickPremiumBonusVariantId(orderABCD));
  assert.ok(seen.has('B'), 'B trebuie sa apara cel putin o data in 200 de incercari (altfel alegerea nu e cu adevarat random)');
  assert.ok(seen.has('D'), 'D trebuie sa apara cel putin o data in 200 de incercari (altfel alegerea nu e cu adevarat random)');
});

test('pickPremiumBonusVariantId: rng injectabil — rng=0 alege PRIMA varianta neselectata, rng aproape de 1 alege ULTIMA (deterministic, pentru teste)', () => {
  assert.equal(pickPremiumBonusVariantId(orderABCD, () => 0), 'B');
  assert.equal(pickPremiumBonusVariantId(orderABCD, () => 0.9999), 'D');
});

test('pickPremiumBonusVariantId: cu o singura editare (3 variante reale: A/B/C, alese A+C) — bonusul e STRICT B, fara nicio alegere aleatoare necesara', () => {
  const order = { plan: 'premium', selectedVariantId: 'A', selectedVariantId2: 'C', variants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] };
  for (let i = 0; i < 20; i++) assert.equal(pickPremiumBonusVariantId(order, Math.random), 'B');
});

test('pickPremiumBonusVariantId: fara nicio editare (2 variante reale, exact cele cumparate) — null, nimic de livrat in plus', () => {
  const order = { plan: 'premium', selectedVariantId: 'A', selectedVariantId2: 'B', variants: [{ id: 'A' }, { id: 'B' }] };
  assert.equal(pickPremiumBonusVariantId(order), null);
});

test('pickPremiumBonusVariantId: null pentru orice pachet diferit de Premium, chiar cu variante "in plus" in date', () => {
  assert.equal(pickPremiumBonusVariantId({ plan: 'standard', selectedVariantId: 'A', variants: [{ id: 'A' }, { id: 'B' }] }), null);
  assert.equal(pickPremiumBonusVariantId({ plan: 'video', selectedVariantId: 'A', variants: [{ id: 'A' }, { id: 'B' }] }), null);
  assert.equal(pickPremiumBonusVariantId(null), null);
});

test('pickPremiumBonusVariantId: comanda Premium fara selectedVariantId2 (foarte veche) — candidatii sunt toate variantele diferite de selectedVariantId', () => {
  const order = { plan: 'premium', selectedVariantId: 'A', variants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] };
  for (let i = 0; i < 20; i++) {
    const id = pickPremiumBonusVariantId(order);
    assert.ok(['B', 'C'].includes(id));
  }
});

// ===============================================================================================
// PARTEA 2 — getPremiumBonusVariant: rezolvarea id-ului PERSISTAT catre obiectul-varianta.
// ===============================================================================================
test('getPremiumBonusVariant: rezolva order.premiumBonusVariantId catre varianta completa', () => {
  const order = { plan: 'premium', premiumBonusVariantId: 'D', variants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D', fullKey: 'k-d' }] };
  const v = getPremiumBonusVariant(order);
  assert.ok(v && v.id === 'D' && v.fullKey === 'k-d');
});

test('getPremiumBonusVariant: null daca premiumBonusVariantId lipseste (nicio editare, nimic de livrat)', () => {
  assert.equal(getPremiumBonusVariant({ plan: 'premium', variants: [{ id: 'A' }] }), null);
});

test('getPremiumBonusVariant: null pentru orice pachet diferit de Premium, chiar daca campul ar exista din greseala', () => {
  assert.equal(getPremiumBonusVariant({ plan: 'standard', premiumBonusVariantId: 'B', variants: [{ id: 'B' }] }), null);
  assert.equal(getPremiumBonusVariant({ plan: 'video', premiumBonusVariantId: 'B', variants: [{ id: 'B' }] }), null);
});

// ===============================================================================================
// PARTEA 3 — db.js: persistarea ATOMICA, o singura data, in ACEEASI tranzactie care marcheaza
// comanda "ready" (fara nicio interogare separata — altfel ar exista o fereastra de race unde
// statusul devine "ready" inainte ca bonusul sa fie ales).
// ===============================================================================================
test('db.js: coloana premium_bonus_variant_id exista (migrare aditiva)', () => {
  assert.match(dbjs, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS premium_bonus_variant_id TEXT;/);
});

test('db.js: COLUMN_MAP include premiumBonusVariantId — altfel db.updateOrder nu ar putea scrie coloana', () => {
  assert.match(dbjs, /premiumBonusVariantId:\s*'premium_bonus_variant_id',/);
});

test('db.js: randul citit din DB expune premiumBonusVariantId', () => {
  assert.ok(dbjs.includes('premiumBonusVariantId: row.premium_bonus_variant_id || null,'));
});

test('db.js: importa pickPremiumBonusVariantId din lib/entitlements', () => {
  assert.match(dbjs, /require\('\.\/lib\/entitlements'\)/);
});

test('db.js: recordPaidOrderAtomically alege bonusul STRICT pentru Premium, STRICT daca nu exista deja unul persistat', () => {
  const idx = dbjs.indexOf('async function recordPaidOrderAtomically');
  assert.ok(idx !== -1);
  // db.js foloseste CRLF — cautam \n} (nu \n}\n) ca sa functionam indiferent daca dupa acolada
  // urmeaza \r\n, \n, sau alt caracter.
  const end = dbjs.indexOf('\n}', idx + 40);
  const body = dbjs.slice(idx, end);
  assert.match(body, /current\.plan === 'premium' && !current\.premiumBonusVariantId/, 'trebuie sa verifice explicit planul SI ca nu exista deja o alegere persistata (idempotenta)');
  assert.match(body, /pickPremiumBonusVariantId\(current\)/, 'trebuie sa foloseasca randul FRESH (FOR UPDATE), niciodata date vechi din afara tranzactiei');
});

test('db.js: recordPaidOrderAtomically foloseste O SINGURA interogare UPDATE — bonusul se scrie in ACEEASI tranzactie/rand ca status=\'ready\', nu separat (fara fereastra de race)', () => {
  const idx = dbjs.indexOf('async function recordPaidOrderAtomically');
  const end = dbjs.indexOf('\n}', idx + 40);
  const body = dbjs.slice(idx, end);
  const updateCount = (body.match(/UPDATE orders SET/g) || []).length;
  assert.equal(updateCount, 1, `trebuie sa existe exact un singur UPDATE orders in aceasta functie, gasite ${updateCount}`);
});

test('db.js si lib/entitlements.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib/entitlements.js')]));
});

// ===============================================================================================
// PARTEA 4 — server.js: noul endpoint /media/full/:orderId/bonus, ACELASI tipar de securitate
// ca /gift (token timing-safe, status==='ready', acces gazduit neexpirat), STRICT Premium.
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

test("server.js: GET /media/full/:orderId/bonus exista, foloseste getPremiumBonusVariant si acelasi tipar de securitate ca /gift", () => {
  const fnBody = extractFn(server, "app.get('/media/full/:orderId/bonus', async (req, res, next) => {");
  assert.ok(fnBody.includes('safeCompare('), 'trebuie sa foloseasca comparatie timing-safe a token-ului');
  assert.ok(fnBody.includes("if (order.status !== 'ready')"), 'trebuie sa refuze accesul inainte de confirmarea platii');
  assert.ok(fnBody.includes("if (order.plan !== 'premium') return denyGeneric();"), 'trebuie sa refuze explicit orice pachet diferit de Premium');
  assert.ok(fnBody.includes('getPremiumBonusVariant(order)'));
  assert.ok(fnBody.includes('isHostedAccessExpired(order)'), 'trebuie sa respecte acelasi plafon de 30 de zile de acces gazduit');
});

test('server.js: importa getPremiumBonusVariant alaturi de getGiftVariant din lib/entitlements', () => {
  assert.match(server, /const \{ getGiftVariant, getPremiumBonusVariant \} = require\('\.\/lib\/entitlements'\);/);
});

test('server.js: GET /api/orders/:orderId expune premiumBonusVariantId STRICT dupa plata (status===\'ready\'), niciodata inainte', () => {
  assert.match(server, /premiumBonusVariantId:\s*order\.status === 'ready' \? \(order\.premiumBonusVariantId \|\| null\) : null,/);
});

test('server.js ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

// ===============================================================================================
// PARTEA 5 — succes.html FUNCTIONAL: rezolvarea client-side, extrasa si rulata cu date sintetice.
// ===============================================================================================
function computeBonusFor(data) {
  const fnBody = extractFn(succes, 'function renderReadyCard(data) {');
  const startMarker = 'const variant = (data.variants || []).find';
  const endMarker = 'let resultHtml;';
  const start = fnBody.indexOf(startMarker);
  const end = fnBody.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1);
  const snippet = fnBody.slice(start, end);
  const sandboxSrc = `
    const orderId = 'test-order';
    const accessToken = 'test-token';
    const t = {
      variant_original_label: 'ORIGINAL', variant_edited_label: 'EDITED', video_song_title: 'GENERIC_MAIN',
      gift_title: 'GIFT_TITLE', gift_badge: 'GIFT_BADGE', included_song_1: 'SONG_1', included_song_2: 'SONG_2',
      premium_bonus_title: 'BONUS_TITLE', premium_bonus_download: 'BONUS_DOWNLOAD', download_wav: 'WAV', extra_processing: 'WAIT'
    };
    ${snippet}
    return { giftVariant, giftUrl, isPremiumSecondPurchasedSong, premiumBonusVariant, premiumBonusUrl };
  `;
  return new Function('data', sandboxSrc)(data);
}

test('succes.html FUNCTIONAL: exemplul EXACT din cerinta — Premium cu selectedVariantId2, premiumBonusVariantId=D — rezolva corect toate cele 3 melodii', () => {
  const data = {
    plan: 'premium',
    selectedVariantId: 'A',
    selectedVariantId2: 'C',
    premiumBonusVariantId: 'D',
    variants: [{ id: 'A', genre: 'jazz' }, { id: 'B', genre: 'jazz' }, { id: 'C', genre: 'pop' }, { id: 'D', genre: 'pop' }]
  };
  const { giftVariant, isPremiumSecondPurchasedSong, premiumBonusVariant, premiumBonusUrl } = computeBonusFor(data);
  assert.equal(giftVariant.id, 'C', 'a doua melodie inclusa in pachet trebuie sa fie EXACT selectedVariantId2');
  assert.equal(isPremiumSecondPurchasedSong, true, 'a doua melodie NU trebuie marcata drept cadou');
  assert.ok(premiumBonusVariant && premiumBonusVariant.id === 'D', 'melodia cadou trebuie sa fie EXACT variantei indicate de server (premiumBonusVariantId)');
  assert.ok(premiumBonusUrl, 'trebuie sa existe un link de descarcare pentru melodia cadou');
  assert.notEqual(premiumBonusVariant.id, data.selectedVariantId, 'melodia cadou nu poate fi niciodata prima melodie selectata');
  assert.notEqual(premiumBonusVariant.id, data.selectedVariantId2, 'melodia cadou nu poate fi niciodata a doua melodie selectata');
});

test('succes.html FUNCTIONAL: fara premiumBonusVariantId (nicio editare facuta) — nicio a treia melodie, niciun link de descarcare', () => {
  const data = {
    plan: 'premium', selectedVariantId: 'A', selectedVariantId2: 'B',
    variants: [{ id: 'A' }, { id: 'B' }]
  };
  const { premiumBonusVariant, premiumBonusUrl } = computeBonusFor(data);
  assert.equal(premiumBonusVariant, null);
  assert.equal(premiumBonusUrl, null);
});

test('succes.html FUNCTIONAL: Standard/Video ignora complet premiumBonusVariantId, chiar daca ar exista din greseala in date', () => {
  const dataStandard = { plan: 'standard', selectedVariantId: 'A', premiumBonusVariantId: 'B', variants: [{ id: 'A' }, { id: 'B' }] };
  const dataVideo = { plan: 'video', selectedVariantId: 'A', premiumBonusVariantId: 'B', variants: [{ id: 'A' }, { id: 'B', hasVideo: true }] };
  assert.equal(computeBonusFor(dataStandard).premiumBonusVariant, null);
  assert.equal(computeBonusFor(dataVideo).premiumBonusVariant, null);
});

test('succes.html: sectiunea melodiei cadou Premium foloseste simbolul 🎁 + gift_badge, si titlul dedicat premium_bonus_title (nu gift_title, ca sa nu se confunde cu Standard)', () => {
  assert.ok(succes.includes('const premiumBonusBlockHtml = premiumBonusUrl ? `'));
  const idx = succes.indexOf('const premiumBonusBlockHtml = premiumBonusUrl ? `');
  const block = succes.slice(idx, idx + 400);
  assert.ok(block.includes('🎁 ${t.gift_badge}'));
  assert.ok(block.includes('${t.premium_bonus_title}'));
  assert.ok(block.includes('${t.premium_bonus_download}'));
});

test('succes.html: blocul melodiei cadou Premium e adaugat DUPA cel al celei de-a doua melodii incluse (ordinea ceruta: 1, 2, apoi cadoul)', () => {
  // a doua aparitie a "resultHtml = `" e ramura else (Standard/Premium/Video-fara-video-gata) —
  // prima apartine ramurii video (structura ei separata, deja acoperita de alte teste).
  const firstIdx = succes.indexOf('resultHtml = `');
  const idx = succes.indexOf('resultHtml = `', firstIdx + 1);
  assert.ok(idx !== -1, 'trebuie sa existe o a doua atribuire resultHtml = ` (ramura else)');
  const block = succes.slice(idx, idx + 500);
  const giftIdx = block.indexOf('${giftBlockHtml}');
  const bonusIdx = block.indexOf('${premiumBonusBlockHtml}');
  assert.ok(giftIdx !== -1 && bonusIdx !== -1 && giftIdx < bonusIdx, 'ordinea DOM trebuie sa fie: melodia 1 -> melodia 2 -> melodia cadou');
});

test('succes.html: montarea audio a melodiei cadou Premium foloseste elementul dedicat #premium-bonus-audio-wrap, distinct de #gift-audio-wrap (a doua melodie inclusa)', () => {
  assert.ok(succes.includes("if (premiumBonusUrl) mountMedia(document.getElementById('premium-bonus-audio-wrap'), premiumBonusUrl, 'audio');"));
});

test('succes.html: /media/full/:orderId/bonus e folosit STRICT pentru URL-ul melodiei cadou Premium (endpoint nou, distinct de /gift)', () => {
  assert.ok(succes.includes('/media/full/${orderId}/bonus?token='));
});

// ===============================================================================================
// PARTEA 6 — traduceri: cheile noi exista corect in toate cele 8 limbi, fara fallback in engleza.
// ===============================================================================================
function loadSuccesTranslations() {
  const start = succes.indexOf('const T = ');
  let depth = 0, i = succes.indexOf('{', start);
  for (; i < succes.length; i++) {
    if (succes[i] === '{') depth++;
    else if (succes[i] === '}') { depth--; if (depth === 0) break; }
  }
  return new Function(`${succes.slice(start, i + 1)}\nreturn T;`)();
}

test('succes.html: premium_bonus_title si premium_bonus_download exista in toate cele 8 limbi', () => {
  const T = loadSuccesTranslations();
  for (const lang of LANGS) {
    assert.ok(T[lang].premium_bonus_title && T[lang].premium_bonus_title.trim(), `lipseste premium_bonus_title pentru ${lang}`);
    assert.ok(T[lang].premium_bonus_download && T[lang].premium_bonus_download.trim(), `lipseste premium_bonus_download pentru ${lang}`);
  }
});

test('succes.html: nicio limba nu ramane pe fallback-ul in engleza pentru premium_bonus_title/premium_bonus_download', () => {
  const T = loadSuccesTranslations();
  for (const lang of LANGS) {
    if (lang === 'en') continue;
    assert.notEqual(T[lang].premium_bonus_title, T.en.premium_bonus_title, `${lang}.premium_bonus_title pare sa fi ramas pe fallback-ul englez`);
    assert.notEqual(T[lang].premium_bonus_download, T.en.premium_bonus_download, `${lang}.premium_bonus_download pare sa fi ramas pe fallback-ul englez`);
  }
});

// ===============================================================================================
// PARTEA 7 — layout: melodia cadou Premium reutilizeaza EXACT clasa .song-block existenta
// (acelasi container vertical, responsive, folosit deja de melodiile 1/2 si de Standard/Video) —
// nicio regula CSS noua, deci nicio schimbare de comportament pe mobil.
// ===============================================================================================
test('succes.html: blocul melodiei cadou Premium reutilizeaza clasa .song-block existenta (acelasi container vertical/responsive, nicio regula CSS noua introdusa)', () => {
  const idx = succes.indexOf('const premiumBonusBlockHtml = premiumBonusUrl ? `');
  const block = succes.slice(idx, idx + 400);
  assert.ok(block.includes('<div class="song-block">'), 'trebuie sa foloseasca exact clasa .song-block, nu un container nou');
});

test('succes.html: regula mobila @media (max-width:480px) pentru .card ramane neschimbata (nicio limitare noua introdusa de a treia melodie)', () => {
  const styleBlock = succes.slice(succes.indexOf('<style>'), succes.indexOf('</style>'));
  assert.match(styleBlock, /@media \(max-width:480px\)\{\s*\.card\{ padding:32px 20px; border-radius:16px; \}\s*\}/);
});

test('succes.html: layout-ul de baza (page-wrap vertical, footer dupa continut) ramane neschimbat — verificat deja exhaustiv in test/succes-page-redesign-2026-09-13.test.js', () => {
  assert.ok(succes.includes('<div class="page-wrap">'));
  const bodyRuleIdx = styleBlockBodyRule(succes);
  assert.ok(!bodyRuleIdx.includes('display:flex'));
});

function styleBlockBodyRule(html) {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const bodyRuleIdx = styleBlock.indexOf('body{');
  return styleBlock.slice(bodyRuleIdx, styleBlock.indexOf('}', bodyRuleIdx));
}

// ===============================================================================================
// PARTEA 8 — email de livrare (sendDeliveryEmail): melodia cadou Premium primeste propriul link,
// distinct de giftLine (a doua melodie CUMPARATA) — extindere ceruta explicit (confirmata), ca
// clientul sa nu piarda niciodata bonusul daca nu descarca imediat de pe succes.html.
// ===============================================================================================
function extractSendDeliveryEmail() {
  return extractFn(server, 'async function sendDeliveryEmail(order) {');
}

test('server.js: sendDeliveryEmail calculeaza melodia cadou Premium prin getPremiumBonusVariant, distinct de giftVariant (a doua melodie CUMPARATA)', () => {
  const body = extractSendDeliveryEmail();
  assert.ok(body.includes('const premiumBonusVariant = getPremiumBonusVariant(order);'));
  assert.ok(body.includes('const hasPremiumBonus = !!(premiumBonusVariant && premiumBonusVariant.fullKey);'));
  assert.ok(body.includes('/media/full/${order.id}/bonus?token=${order.accessToken}'), 'trebuie sa foloseasca noul endpoint /bonus, distinct de /gift');
});

test('server.js: PREMIUM_BONUS_LINE foloseste simbolul 🎁 (surpriza), distinct de 🎵 folosit de GIFT_LINE (continut cumparat), in toate cele 8 limbi', () => {
  const body = extractSendDeliveryEmail();
  const idx = body.indexOf('const PREMIUM_BONUS_LINE = {');
  assert.ok(idx !== -1);
  const end = body.indexOf('};', idx);
  const block = body.slice(idx, end);
  for (const lang of LANGS) {
    const re = new RegExp(`${lang}: \`<p>🎁 <a href=`);
    assert.match(block, re, `PREMIUM_BONUS_LINE.${lang} trebuie sa existe si sa foloseasca 🎁`);
  }
});

test('server.js: cele 8 texte PREMIUM_BONUS_LINE sunt distincte intre ele (nicio limba nu ramane pe fallback-ul altei limbi)', () => {
  const body = extractSendDeliveryEmail();
  const idx = body.indexOf('const PREMIUM_BONUS_LINE = {');
  const end = body.indexOf('};', idx);
  const src = body.slice(idx, end + 1);
  const map = new Function(`const premiumBonusUrl = 'https://example.test/bonus';\n${src}\nreturn PREMIUM_BONUS_LINE;`)();
  for (const lang of LANGS) assert.ok(map[lang] && map[lang].includes('href='), `PREMIUM_BONUS_LINE.${lang} trebuie sa existe`);
  const uniqueValues = new Set(Object.values(map));
  assert.equal(uniqueValues.size, LANGS.length, 'toate cele 8 texte trebuie sa fie distincte');
});

test('server.js: ${premiumBonusLine} e inserat in toate cele 8 template-uri de email, intre ${giftLine} si ${videoLine} (ordinea: melodia 2, apoi cadoul, apoi videoclipul daca exista)', () => {
  const occurrences = (server.match(/\$\{giftLine\}\$\{premiumBonusLine\}\$\{videoLine\}/g) || []).length;
  assert.equal(occurrences, 8, `trebuie sa apara exact 8 ori (cate una per limba), gasit de ${occurrences} ori`);
});

test('server.js: hasPremiumBonus e null-safe si condiționeaza linia — fara bonus (Standard/Video/Premium fara editare), premiumBonusLine e string gol', () => {
  const body = extractSendDeliveryEmail();
  assert.match(body, /const premiumBonusLine = hasPremiumBonus \? \(PREMIUM_BONUS_LINE\[order\.lang\] \|\| PREMIUM_BONUS_LINE\.ro\) : '';/);
});

// ===============================================================================================
// PARTEA 9 — comanda-mea.html (pagina persistenta de acces "comanda mea") si endpoint-ul
// /api/orders/access/:token — extindere ceruta explicit (confirmata), ca melodia cadou Premium
// sa ramana descarcabila oricand in cele 30 de zile de acces gazduit, nu doar la prima vizita.
// ===============================================================================================
test("server.js: GET /api/orders/access/:token expune hasPremiumBonusAudio prin getPremiumBonusVariant (acelasi tipar ca hasGiftAudio existent)", () => {
  const fnBody = extractFn(server, "app.get('/api/orders/access/:token', lookupLimiter, async (req, res, next) => {");
  assert.ok(fnBody.includes('const premiumBonusVariant = getPremiumBonusVariant(order);'));
  assert.ok(fnBody.includes('hasPremiumBonusAudio: !!(premiumBonusVariant && premiumBonusVariant.fullKey),'));
});

test('comanda-mea.html: afiseaza linkul de descarcare al melodiei cadou Premium STRICT dupa plata si STRICT cand hasPremiumBonusAudio e adevarat, folosind noul endpoint /bonus', () => {
  assert.ok(comandaMea.includes("if (o.status === 'ready' && !accessExpired && o.hasPremiumBonusAudio) {"));
  assert.ok(comandaMea.includes('/media/full/${o.id}/bonus?token='));
  assert.ok(comandaMea.includes('${t.premium_bonus_download}'));
});

test('comanda-mea.html: premium_bonus_download exista in toate cele 8 limbi, cu simbolul 🎁, fara fallback in engleza', () => {
  const occurrences = (comandaMea.match(/premium_bonus_download:/g) || []).length;
  assert.equal(occurrences, 8, `trebuie sa apara exact 8 ori (cate una per limba), gasit de ${occurrences} ori`);
  const values = [...comandaMea.matchAll(/premium_bonus_download: '([^']+)'/g)].map(m => m[1]);
  assert.equal(values.length, 8);
  for (const v of values) assert.ok(v.startsWith('🎁'), `"${v}" trebuie sa inceapa cu simbolul 🎁`);
  assert.equal(new Set(values).size, 8, 'toate cele 8 traduceri trebuie sa fie distincte (nicio limba nu ramane pe fallback-ul altei limbi)');
});

test('comanda-mea.html ramane sintactic valid dupa aceasta corectie', () => {
  const scripts = [...comandaMea.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
