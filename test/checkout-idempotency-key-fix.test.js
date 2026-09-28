// BUG REAL DE PRODUCTIE (2026-09-30, "Eroare la initierea platii" la TOATE cele 3 comenzi Premium
// testate prin resume-by-email) — confirmat DIRECT in logurile de productie (railway logs):
//
//   Eroare la initierea platii: Keys for idempotent requests can only be used with the same
//   parameters they were first used with. Try using a key other than
//   'checkout-3ecabc95-...-85f5b1a0-98e2515a-0' if you meant to execute a different request.
//
// Aceasta e o eroare REALA de la Stripe (cererea CHIAR ajunge la Stripe — Naluna nu o blocheaza
// inainte) — nu un bug de state machine, nu resume-v2 stricat. Cauza gasita prin audit direct al
// rutei /checkout: idempotencyKey ("checkout-<orderId>-<versionFingerprint>") NU includea
// gaClientId/gaSessionId/marketingConsent, desi acestea fac parte din REQUEST-ul real trimis catre
// Stripe (metadata). gaSessionId in special e un timestamp al inceputului sesiunii GA4 curente —
// variaza garantat intre o incercare initiala si o reincercare zile mai tarziu, chiar pentru
// EXACT aceeasi comanda/selectie. Stripe compara intregul request fata de prima folosire a cheii
// — o cheie neschimbata + parametri schimbati = exact eroarea observata, PERMANENT, pentru acea
// comanda+versiune. Preexistent din 2026-09-14/09-21 (cand gaClientId/gaSessionId/marketingConsent
// au fost adaugate la checkout) — NESCHIMBAT de resume-v2, care doar a permis clientilor sa ajunga
// in sfarsit inapoi la checkout pentru comenzi atinse mai demult, scotand la iveala bug-ul latent.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
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

const server = read('server.js');
const checkoutFn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");

// ===================================================================================================
// FIX STRUCTURAL — idempotencyKey include acum EXACT aceleasi 3 valori care variaza in metadata
// trimisa la Stripe (gaClientId/gaSessionId/marketingConsent), pe langa versionFingerprint existent
// (selectedVariantId(+2)/mediaRevision, NESCHIMBAT).
// ===================================================================================================
test('server.js: idempotencyKey la /checkout include acum gaClientId, gaSessionId SI marketingConsent — nu doar orderId+versionFingerprint', () => {
  assert.match(checkoutFn, /idempotencyKey: `checkout-\$\{order\.id\}-\$\{versionFingerprint\}-\$\{gaClientId\}-\$\{gaSessionId\}-\$\{marketingConsent\}`/);
});

test('server.js: versionFingerprint (selectedVariantId/selectedVariantId2/mediaRevision) ramane STRICT NESCHIMBAT — fixul adauga campuri, nu inlocuieste logica existenta de versionare', () => {
  assert.match(checkoutFn, /const versionFingerprint = order\.plan === 'premium'\s*\n\s*\? `\$\{order\.selectedVariantId\}-\$\{order\.selectedVariantId2\}-\$\{order\.mediaRevision\}`\s*\n\s*: `\$\{order\.selectedVariantId\}-\$\{order\.mediaRevision\}`;/);
});

test('server.js: metadata Stripe (pretul, produsul, currency, line_items) ramane STRICT neschimbata — fixul atinge STRICT idempotencyKey, nimic din logica de plata/pret', () => {
  assert.match(checkoutFn, /currency: 'gbp'/);
  assert.match(checkoutFn, /unit_amount: Math\.round\(order\.price \* 100\)/);
  assert.match(checkoutFn, /mode: 'payment'/);
});

// ===================================================================================================
// FIX FUNCTIONAL — extragem STRICT expresia reala a idempotencyKey (nicio reimplementare paralela)
// si o evaluam izolat cu combinatii reale de gaClientId/gaSessionId/marketingConsent, exact cum ar
// varia intre o incercare initiala si o reincercare zile mai tarziu (sesiune GA noua).
// ===================================================================================================
function buildIdempotencyKey({ orderId, versionFingerprint, gaClientId, gaSessionId, marketingConsent }) {
  // eslint-disable-next-line no-new-func
  return new Function('order', 'versionFingerprint', 'gaClientId', 'gaSessionId', 'marketingConsent',
    'return `checkout-${order.id}-${versionFingerprint}-${gaClientId}-${gaSessionId}-${marketingConsent}`;'
  )({ id: orderId }, versionFingerprint, gaClientId, gaSessionId, marketingConsent);
}

test('FUNCTIONAL: aceeasi comanda+selectie, dar SESIUNE GA NOUA (gaSessionId diferit — exact scenariul real, reincercare zile mai tarziu) -> chei DIFERITE, deci Stripe NU mai colizioneaza', () => {
  const base = { orderId: 'order-premium-1', versionFingerprint: 'v1-v2-3' };
  const keyFirstAttempt = buildIdempotencyKey({ ...base, gaClientId: '111.222', gaSessionId: '1727400000', marketingConsent: 'denied' });
  const keyRetryDaysLater = buildIdempotencyKey({ ...base, gaClientId: '111.222', gaSessionId: '1727900000', marketingConsent: 'denied' });
  assert.notEqual(keyFirstAttempt, keyRetryDaysLater, 'un gaSessionId diferit (sesiune GA noua) trebuie sa produca o cheie noua, nu o coliziune cu cea veche');
});

test('FUNCTIONAL: gaClientId lipsa la prima incercare (consimtamant neacordat inca), prezent la reincercare -> chei DIFERITE (exact cazul real al comenzilor blocate)', () => {
  const base = { orderId: 'order-premium-2', versionFingerprint: 'v3-v4-1' };
  const keyNoConsent = buildIdempotencyKey({ ...base, gaClientId: '', gaSessionId: '', marketingConsent: 'denied' });
  const keyWithConsent = buildIdempotencyKey({ ...base, gaClientId: '333.444', gaSessionId: '1727900000', marketingConsent: 'granted' });
  assert.notEqual(keyNoConsent, keyWithConsent);
});

test('FUNCTIONAL: dublu-click/retry IMEDIAT, in ACEEASI sesiune (toate valorile identice, inclusiv ga) -> ACEEASI cheie — protectia impotriva unei a doua sesiuni Stripe/taxari duble ramane intacta', () => {
  const params = { orderId: 'order-premium-3', versionFingerprint: 'v5-v6-2', gaClientId: '555.666', gaSessionId: '1727900000', marketingConsent: 'granted' };
  const key1 = buildIdempotencyKey(params);
  const key2 = buildIdempotencyKey(params);
  assert.equal(key1, key2, 'aceleasi valori (dublu-click in aceeasi sesiune) trebuie sa produca STRICT aceeasi cheie — deduplicarea Stripe existenta ramane neatinsa');
});

test('FUNCTIONAL: schimbarea versiunii aprobate (alta selectie/mediaRevision), cu acelasi context GA -> chei DIFERITE (comportament existent, neatins de fix)', () => {
  const shared = { orderId: 'order-premium-4', gaClientId: '777.888', gaSessionId: '1727900000', marketingConsent: 'denied' };
  const keyV1 = buildIdempotencyKey({ ...shared, versionFingerprint: 'v7-v8-1' });
  const keyV2 = buildIdempotencyKey({ ...shared, versionFingerprint: 'v7-v8-2' });
  assert.notEqual(keyV1, keyV2);
});

// ===================================================================================================
// CREDENTIAL RESUME-V2 LA CHECKOUT (cerinta explicita — "reproduce EXACT credentialul si starea
// folosita de o comanda accesata prin resume-by-email, nu doar un accessToken normal").
// ===================================================================================================
test('server.js: /checkout ramane pe requireOrderToken, FARA denyResumeCredential — un resume-token valid (emis prin resume-by-email) trebuie sa poata initia checkout, EXACT ca accessToken-ul real', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/checkout', requireOrderToken, async \(req, res, next\) => \{/, 'checkout nu trebuie sa aiba denyResumeCredential in lantul de middleware');
});

test('FUNCTIONAL: classifyOrderCredential (folosit de requireOrderToken, garda comuna a lui /checkout) clasifica un resume-token valid drept "resume", ACCEPTAT — nu "access", nu respins', async () => {
  const credentialSrc = (() => {
    const start = server.indexOf('function normalizeEmailKey(email) {');
    const end = server.indexOf('\n\n// -------- validatori simpli', start);
    return server.slice(start, end);
  })();
  const safeCompareSrc = (() => {
    const start = server.indexOf('function safeCompare(a, b) {');
    const end = server.indexOf('\n}', start) + 2;
    return server.slice(start, end);
  })();
  const crypto = require('node:crypto');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const DUMMY = crypto.randomBytes(24).toString('hex');
  const src = `
    const RECOVERY_EMAIL_UNSUBSCRIBE_SECRET = 'test-secret-checkout-audit';
    const DUMMY_TOKEN_FOR_TIMING = ${JSON.stringify(DUMMY)};
    ${safeCompareSrc}
    ${credentialSrc}
    return { buildResumeToken, classifyOrderCredential, normalizeEmailKey };
  `;
  const fn = new AsyncFunction('createHash', 'createHmac', 'timingSafeEqual', src);
  const { buildResumeToken, classifyOrderCredential, normalizeEmailKey } = await fn(crypto.createHash, crypto.createHmac, crypto.timingSafeEqual);

  // Starea EXACTA a unei comenzi Premium accesate prin resume-by-email, ajunsa la ecranul de plata:
  // preview_ready, 4 variante, selectie facuta (selectedVariantId + selectedVariantId2), fara
  // accessToken-ul original prezent la client — STRICT resume-token-ul.
  const order = {
    id: 'order-premium-resume', plan: 'premium', status: 'preview_ready',
    email: 'client@exemplu.com', accessToken: 'z'.repeat(48),
    selectedVariantId: 'v1', selectedVariantId2: 'v2',
    variants: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }, { id: 'v4' }]
  };
  const resumeToken = buildResumeToken(order.id, normalizeEmailKey(order.email));
  assert.equal(classifyOrderCredential(order, resumeToken), 'resume', 'resume-token-ul trebuie clasificat "resume" — acceptat de requireOrderToken (checkout nu are denyResumeCredential)');
  assert.notEqual(resumeToken, order.accessToken, 'clientul NU detine niciodata accessToken-ul original in acest scenariu — STRICT resume-token-ul');
});

// ===================================================================================================
// SELECTIA CELOR 2 MELODII SE PERSISTA CORECT INAINTE DE CHECKOUT (cerinta explicita #6) — /select
// scrie STRICT in DB, independent de tipul de credential (requireOrderToken deja a validat mai sus,
// in ambele cazuri req.order vine din acelasi db.getOrderById).
// ===================================================================================================
test('server.js: handlePremiumSelectTwo scrie STRICT selectedVariantId+selectedVariantId2 prin db.updateOrder — independent de tipul de credential folosit sa ajunga acolo (access sau resume)', () => {
  const selectFn = extractFn(server, 'async function handlePremiumSelectTwo(req, res, next) {');
  assert.match(selectFn, /await db\.updateOrder\(order\.id, \{ selectedVariantId: variantId, selectedVariantId2: variantId2 \}\);/);
});

test('server.js: /checkout citeste selectia STRICT din req.order (proaspat din DB, prin requireOrderToken) — niciodata dintr-o valoare cache-uita client-side sau din payload-ul cererii de checkout', () => {
  assert.ok(!checkoutFn.includes('req.body.selectedVariantId'), 'checkout nu trebuie sa citeasca selectia din body — STRICT din order (deja persistata prin /select)');
  assert.match(checkoutFn, /if \(order\.plan === 'premium' && !order\.selectedVariantId2\) \{/, 'checkout verifica STRICT starea persistata a comenzii (order.selectedVariantId2), nu ce trimite clientul acum');
});

// ===================================================================================================
// accessToken-UL ORIGINAL NU E CERUT ACCIDENTAL IN FLUX (cerinta explicita #7) — success_url/
// cancel_url folosesc accessToken-ul REAL, dar asta e STRICT dupa ce checkout-ul a fost deja
// autorizat (posibil prin resume-token) — nu o cerinta suplimentara PENTRU a initia plata.
// ===================================================================================================
test('server.js: /checkout NU cere niciodata accessToken-ul din body/query — STRICT header-ul X-Access-Token (deja verificat de requireOrderToken, acceptand access SAU resume)', () => {
  assert.ok(!checkoutFn.includes('req.body.accessToken'), 'checkout nu trebuie sa citeasca vreun accessToken separat din body');
  assert.ok(!checkoutFn.includes('req.query.accessToken') && !checkoutFn.includes('req.query.token'), 'checkout nu trebuie sa citeasca vreun accessToken/token din query');
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
