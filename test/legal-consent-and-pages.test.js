// LAUNCH SAFETY (2026-09-02, Faza 2 — Legal: checkout consent, durable confirmation, pagini
// legale) + Faza 5 (retention/deletion). Verifica STRUCTURAL toate piesele noi.
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
const db = read('db.js');
const melodia = read('public/melodia-mea.html');

// ---------------------------------------------------------------------------------------------
// Pagini legale
// ---------------------------------------------------------------------------------------------
for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
  test(`public/${page}: exista, contine adresa reala si contact@nalunastudio.com, fara [DE COMPLETAT]`, () => {
    const html = read(`public/${page}`);
    assert.ok(html.includes('5 Brayford Square'));
    assert.ok(html.includes('contact@nalunastudio.com'));
    assert.ok(!html.includes('DE COMPLETAT'), `${page} nu trebuie sa mai contina placeholder-e necompletate`);
    assert.ok(!/\[.*TBD.*\]/i.test(html));
  });
}

test('terms.html: dezvaluirea numelui proprietarului (Natalia Andoni, cerinta CA2006 s.1201) apare STRICT in interiorul entity-box, ca text simplu — fara heading, bold sau evidentiere separata', () => {
  const html = read('public/terms.html');
  const idx = html.indexOf('Natalia Andoni');
  assert.notEqual(idx, -1, 'terms.html trebuie sa dezvaluie numele proprietarului (cerinta legala CA2006 s.1201)');
  const boxStart = html.indexOf('class="entity-box"');
  const boxEnd = html.indexOf('</div>', boxStart);
  assert.ok(idx > boxStart && idx < boxEnd, 'numele trebuie sa fie in interiorul entity-box, alaturi de restul informatiilor legale ale firmei');
  const boxContent = html.slice(boxStart, boxEnd);
  assert.ok(!/<(h1|h2|h3|h4|h5|h6|strong|b)[ >]/i.test(boxContent), 'entity-box nu trebuie sa contina niciun heading/bold — text simplu, ca restul continutului legal');
});

test('numele personal (Natalia Andoni) NU apare NICAIERI altundeva in site (alte pagini publice, server.js/db.js, emailuri, footere, metadate) — vizibilitate STRICT minima, doar in terms.html', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html') && f !== 'terms.html');
  for (const file of htmlFiles) {
    const html = read(`public/${file}`);
    assert.ok(!html.includes('Natalia Andoni'), `${file} NU trebuie sa contina numele personal al proprietarului`);
    assert.ok(!html.includes('Andoni'), `${file} NU trebuie sa contina numele de familie al proprietarului`);
  }
  assert.ok(!server.includes('Natalia Andoni') && !server.includes('Andoni'), 'server.js (inclusiv emailurile de livrare) nu trebuie sa contina numele personal');
  assert.ok(!db.includes('Natalia Andoni') && !db.includes('Andoni'), 'db.js nu trebuie sa contina numele personal');
});

test('Cele 3 pagini legale se leaga reciproc (footer identic pe toate)', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(html.includes('href="/terms.html"'));
    assert.ok(html.includes('href="/privacy.html"'));
    assert.ok(html.includes('href="/refund.html"'));
  }
});

test('index.html si toate paginile client (comanda/melodia-mea/comanda-mea/succes) leaga cele 3 pagini legale in footer', () => {
  for (const page of ['index.html', 'comanda.html', 'melodia-mea.html', 'comanda-mea.html', 'succes.html']) {
    const html = read(`public/${page}`);
    assert.ok(html.includes('href="/terms.html"'), `${page} lipseste link Terms`);
    assert.ok(html.includes('href="/privacy.html"'), `${page} lipseste link Privacy`);
    assert.ok(html.includes('href="/refund.html"'), `${page} lipseste link Refund`);
    assert.ok(html.includes('contact@nalunastudio.com'), `${page} lipseste emailul de contact`);
    assert.ok(!html.includes('DE COMPLETAT'));
  }
});

// ---------------------------------------------------------------------------------------------
// Checkout consent — server-side
// ---------------------------------------------------------------------------------------------
test('server.js: POST /checkout respinge cu 400 fara consentGiven===true, INAINTE de a crea sesiunea Stripe', () => {
  const fn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  const consentIdx = fn.indexOf("req.body?.consentGiven !== true");
  const stripeIdx = fn.indexOf('stripe.checkout.sessions.create');
  assert.notEqual(consentIdx, -1);
  assert.notEqual(stripeIdx, -1);
  assert.ok(consentIdx < stripeIdx, 'validarea consimtamantului trebuie sa fie INAINTE de crearea sesiunii Stripe');
});

test('server.js: la succes, comanda salveaza consentGivenAt si consentPolicyVersion (dovada asociata comenzii)', () => {
  const fn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(fn, /consentGivenAt:\s*new Date\(\)/);
  assert.match(fn, /consentPolicyVersion:\s*CONSENT_POLICY_VERSION/);
});

test('db.js: consent_given_at/consent_policy_version exista in schema, rowToOrder si COLUMN_MAP', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;/);
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_policy_version TEXT;/);
  assert.match(db, /consentGivenAt: row\.consent_given_at \|\| null,/);
  assert.match(db, /consentGivenAt: 'consent_given_at',/);
});

// ---------------------------------------------------------------------------------------------
// Checkout consent — client-side (melodia-mea.html)
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: bara de consimtamant (#checkout-consent-bar) apare INAINTE de <script> in HTML — REGRESIE REALA gasita live: applyStaticTexts() ruleaza sincron la parsare si arunca daca elementul nu exista inca in DOM, oprind silentios toata initializarea paginii', () => {
  const barIdx = melodia.indexOf('id="checkout-consent-bar"');
  const scriptIdx = melodia.indexOf('<script>');
  assert.notEqual(barIdx, -1);
  assert.notEqual(scriptIdx, -1);
  assert.ok(barIdx < scriptIdx, 'bara de consimtamant trebuie sa fie in DOM INAINTE ca <script> sa ruleze applyStaticTexts()');
});

test('melodia-mea.html: exista checkbox-ul de consimtamant, NEBIFAT implicit (fara atributul checked)', () => {
  const idx = melodia.indexOf('id="checkout-consent-checkbox"');
  assert.notEqual(idx, -1);
  const tag = melodia.slice(melodia.lastIndexOf('<input', idx), melodia.indexOf('>', idx) + 1);
  assert.ok(!tag.includes('checked'), 'checkbox-ul NU trebuie sa fie pre-bifat');
});

test('melodia-mea.html: goToCheckout() verifica checkbox-ul INAINTE de checkoutInFlight/fetch, opreste cu eroare clara daca nu e bifat', () => {
  const fn = extractFn(melodia, 'async function goToCheckout() {');
  const checkIdx = fn.indexOf('!checkoutConsentCheckbox.checked');
  const inFlightIdx = fn.indexOf('checkoutInFlight = true;');
  const fetchIdx = fn.indexOf("fetch(`/api/orders/${orderId}/checkout`");
  assert.notEqual(checkIdx, -1);
  assert.ok(checkIdx < inFlightIdx && checkIdx < fetchIdx, 'verificarea consimtamantului trebuie sa fie PRIMA, inainte de orice alta actiune');
  assert.match(fn, /statusMsgEl\.textContent = t\.consent_required_error;/);
});

test('melodia-mea.html: fetch-ul de checkout trimite consentGiven:true in body, cu Content-Type corect', () => {
  const fn = extractFn(melodia, 'async function goToCheckout() {');
  assert.match(fn, /'Content-Type':\s*'application\/json'/);
  assert.match(fn, /body:\s*JSON\.stringify\(\{\s*consentGiven:\s*true\s*\}\)/);
});

test('melodia-mea.html: bara de consimtamant e vizibila STRICT in content-state (centralizat in showState)', () => {
  const fn = extractFn(melodia, 'function showState(name) {');
  assert.match(fn, /checkout-consent-bar/);
  assert.match(fn, /name === 'content-state'/);
});

test('melodia-mea.html: toate cele 8 limbi au consent_text (cu linkuri catre /terms.html si /refund.html) si consent_required_error', () => {
  const consentTextCount = (melodia.match(/consent_text:/g) || []).length;
  const consentErrCount = (melodia.match(/consent_required_error:/g) || []).length;
  assert.equal(consentTextCount, 8, `asteptat 8 aparitii consent_text, gasit ${consentTextCount}`);
  assert.equal(consentErrCount, 8, `asteptat 8 aparitii consent_required_error, gasit ${consentErrCount}`);
  const linksCount = (melodia.match(/href="\/terms\.html"/g) || []).length;
  assert.ok(linksCount >= 8, 'fiecare din cele 8 traduceri trebuie sa lege /terms.html');
});

// ---------------------------------------------------------------------------------------------
// Durable confirmation — emailul de livrare
// ---------------------------------------------------------------------------------------------
test('server.js: sendDeliveryEmail() include legalLine (mentiunea consimtamantului) in toate cele 8 sabloane, inainte de "— NALUNA"', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  const legalLineCount = (fn.match(/\$\{legalLine\}/g) || []).length;
  assert.equal(legalLineCount, 8, `asteptat 8 sabloane cu \${legalLine}, gasit ${legalLineCount}`);
  const domainLinksCount = (fn.match(/\$\{DOMAIN\}\/terms\.html/g) || []).length;
  assert.equal(domainLinksCount, 8);
});

// ---------------------------------------------------------------------------------------------
// Retention / deletion (Faza 5)
// ---------------------------------------------------------------------------------------------
test('server.js: POST /api/admin/orders/:orderId/anonymize exista, refuza o comanda ACTIVA (generating/processing/regenerating/video lock)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  assert.match(fn, /order\.status === 'generating'/);
  assert.match(fn, /order\.status === 'processing_provider_result'/);
  assert.match(fn, /order\.regenerationStatus === 'running'/);
  assert.match(fn, /isVideoLockActive\(order\)/);
  assert.match(fn, /res\.status\(409\)/);
});

test('server.js: anonymize sterge REAL fisierele din storage (fullKey/previewKey/videoKey/uploadedMedia keys), izolat per fisier (un esec nu opreste restul)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  assert.match(fn, /storage\.deletePrivateFile\(key\)/);
  assert.match(fn, /v\.fullKey/);
  assert.match(fn, /v\.previewKey/);
  assert.match(fn, /v\.videoKey/);
  assert.match(fn, /m\.key/);
  assert.match(fn, /try\s*\{\s*await storage\.deletePrivateFile\(key\);\s*\}\s*catch/);
});

test('server.js: anonymize apeleaza db.anonymizeOrder() DUPA stergerea fisierelor din storage (fisierele nu raman orfane referentiate)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  const deleteIdx = fn.lastIndexOf('storage.deletePrivateFile');
  const anonIdx = fn.indexOf('db.anonymizeOrder(order.id)');
  assert.notEqual(anonIdx, -1);
  assert.ok(deleteIdx < anonIdx);
});

test('db.js: anonymizeOrder() pastreaza id/pret/status/plan (contabilitate), sterge identitate/continut/media, email devine placeholder .invalid (RFC 2606), NICIODATA livrabil', () => {
  const fn = extractFn(db, 'async function anonymizeOrder(id) {');
  assert.match(fn, /recipient = '\[deleted\]'/);
  assert.match(fn, /story = '\[deleted\]'/);
  assert.match(fn, /sender_name = NULL/);
  assert.match(fn, /uploaded_media = '\[\]'::jsonb/);
  assert.match(fn, /variants = '\[\]'::jsonb/);
  assert.match(fn, /anonymized_at = now\(\)/);
  assert.match(fn, /@nalunastudio\.invalid/);
  assert.ok(!fn.includes('price'), 'pretul NU trebuie atins de anonimizare — necesar contabil');
  assert.ok(!fn.includes('status ='), 'statusul NU trebuie atins de anonimizare');
});

test('db.js: anonymized_at exista in schema (audit minim)', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;/);
});

test('Privacy Policy reflecta STRICT ce exista real in sistem: retentie nedefinita + stergere la cerere, transfer international (Railway SUA), NU inventeaza o perioada fixa', () => {
  const html = read('public/privacy.html');
  assert.ok(html.includes('do not currently apply an automatic deletion schedule') || html.includes('as long as your order record exists'));
  assert.ok(html.includes('United States'));
  assert.ok(!/\b(30|60|90|180|365)\s*days\b/i.test(html), 'nu trebuie inventata o perioada fixa de retentie, nesustinuta de o implementare reala');
});
