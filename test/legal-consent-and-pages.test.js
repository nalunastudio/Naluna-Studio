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

test('refund.html si terms.html: NU exista niciun termen general de "14 zile" impus pentru RECLAMAREA unui defect — nu e cerut legal (CRA 2015 nu impune un astfel de termen, doar termenul de plata a rambursarii dupa acceptare)', () => {
  const refund = read('public/refund.html');
  const terms = read('public/terms.html');
  assert.ok(!/within 14 days of delivery/i.test(refund), 'refund.html nu trebuie sa impuna un termen de 14 zile pentru raportarea unui defect');
  assert.ok(!/within 14 days of delivery/i.test(terms));
  assert.ok(/within 14 days.*(agree|agreeing)/i.test(refund), 'refund.html poate mentiona 14 zile STRICT ca termen de PLATA a rambursarii dupa ce a fost acceptata (cerinta reala CRA 2015 s.44/45)');
});

test('refund.html si terms.html: NU exista rambursare voluntara doar pentru schimbarea parerii/nu-mi place rezultatul, dupa livrare', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/not entitled to a (voluntary )?refund/i.test(html), `${page} trebuie sa afirme explicit ca nu exista rambursare pentru schimbarea parerii`);
    assert.ok(/change (your|my) mind/i.test(html) || /change of mind/i.test(html));
  }
});

test('refund.html si terms.html: rambursare GARANTATA daca Naluna esueaza sa livreze din cauza unui defect tehnic/de sistem propriu si nu poate fi remediat rezonabil', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/technical or system failure/i.test(html), `${page} trebuie sa promita rambursare pentru esec tehnic/de sistem propriu`);
    assert.ok(/refund what you paid/i.test(html) || /refund (in full|the full price)/i.test(html));
  }
});

test('refund.html si terms.html: drepturile STATUTARE (CRA 2015) pentru continut defect/neconform/nelivrat sunt pastrate — reparare/inlocuire, apoi reducere de pret pana la 100%, fara excludere', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/repair.*or.*(correct|replacement)|repair or correct/i.test(html), `${page} trebuie sa mentioneze dreptul la reparare/inlocuire`);
    assert.ok(/price reduction/i.test(html), `${page} trebuie sa mentioneze reducerea de pret`);
    assert.ok(/full price/i.test(html), `${page} trebuie sa clarifice ca reducerea poate ajunge la pretul integral`);
    assert.ok(/cannot be excluded|cannot exclude/i.test(html), `${page} trebuie sa clarifice ca aceste drepturi statutare nu pot fi excluse`);
  }
});

test('melodia-mea.html: toate cele 8 limbi ale consent_text includ clauza "nu exista rambursare pentru schimbarea parerii", pastrand neafectate drepturile pentru continut defect/nelivrat din vina Naluna', () => {
  const html = read('public/melodia-mea.html');
  const matches = html.match(/consent_text: '/g) || [];
  assert.equal(matches.length, 8, 'trebuie sa existe exact 8 chei consent_text (una per limba)');
  const faultMarkers = ["fault on Naluna\\'s side", 'din vina Naluna', 'eines Fehlers von Naluna', 'un fallo de Naluna', 'un errore di Naluna', 'défaillance de Naluna', 'грешка на Naluna', 'Naluna kaynaklı bir hata'];
  for (const marker of faultMarkers) {
    assert.ok(html.includes(marker), `lipseste mentiunea drepturilor pastrate pentru esecul din vina Naluna: "${marker}"`);
  }
});

test('Cele 3 pagini legale NU mai contin nicio referinta la "AI"/"artificial intelligence" — EU AI Act art.50 (deepfake) nu se aplica unui cantec personalizat/unui montaj din pozele reale ale clientului, deci nu e o dezvaluire ceruta legal; formularea a fost mutata spre limbaj neutru de produs, fara a pretinde "handmade" sau compus de muzicieni', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!/\bAI\b/.test(html), `${page} nu trebuie sa mai contina "AI"`);
    assert.ok(!/artificial intelligence/i.test(html), `${page} nu trebuie sa mai contina "artificial intelligence"`);
    assert.ok(!/\b(handmade|hand-made|composed by our|created personally by)\b/i.test(html), `${page} nu trebuie sa introduca o pretentie falsa de creatie umana in locul AI`);
  }
});

test('Privacy Policy: tabelul de destinatari foloseste CATEGORII (nu nume de furnizori tehnici) — permis explicit de UK GDPR art.13(1)(e)/14(1)(e) ("recipients OR categories of recipients") — Stripe ramane numit explicit (motiv real de transparenta despre plati)', () => {
  const html = read('public/privacy.html');
  assert.ok(html.includes('Stripe'), 'Stripe poate ramane numit explicit');
  for (const vendor of ['Our AI music generation provider', 'Resend', 'Cloudflare', 'Railway (hosting']) {
    assert.ok(!html.includes(vendor), `${vendor} nu trebuie sa mai apara — foloseste categoria, nu numele furnizorului tehnic`);
  }
  assert.ok(html.includes('The service that generates your song'));
  assert.ok(html.includes('email delivery provider'));
  assert.ok(html.includes('cloud storage provider'));
  assert.ok(html.includes('hosting provider'));
});

test('Privacy Policy: eticheta "(data controller)" nu mai apare ca element de branding in entity-box — termenul "controller" e explicat natural in corpul textului, informatia de identitate a operatorului ramane intacta', () => {
  const html = read('public/privacy.html');
  assert.ok(!html.includes('(data controller)'), 'eticheta stil-branding trebuie eliminata din entity-box');
  assert.match(html, /makes us the ["']controller["'] of that data/, 'termenul controller trebuie explicat in text, nu doar afisat ca eticheta');
  const boxStart = html.indexOf('class="entity-box"');
  const boxEnd = html.indexOf('</div>', boxStart);
  assert.ok(html.slice(boxStart, boxEnd).includes('5 Brayford Square'), 'identitatea/adresa operatorului trebuie sa ramana in entity-box');
});

test('Terms.html: "Last updated" nu mai e afisat proeminent sub H1 — mutat discret in footer, fara sa rupa nimic altceva', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    const h1End = html.indexOf('</h1>');
    const entityBoxStart = html.indexOf('class="entity-box"');
    assert.ok(!html.slice(h1End, entityBoxStart).includes('Last updated'), `${page}: "Last updated" nu trebuie sa mai fie intre <h1> si entity-box`);
    const footerStart = html.indexOf('<footer>');
    assert.ok(html.slice(footerStart).includes('Last updated'), `${page}: "Last updated" trebuie sa existe discret in footer`);
  }
});

test('Numele "Maria" nu apare niciodata ca identitate a proprietarului/afacerii in paginile legale (poate exista doar ca exemplu generic de nume in alte pagini, ex. placeholder de formular)', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!html.includes('Maria'), `${page} nu trebuie sa contina "Maria"`);
  }
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

// ---------------------------------------------------------------------------------------------
// Retentie materiale SURSA (Faza 6, 2026-09-05) — categorie STRICT separata de produsul FINAL
// ---------------------------------------------------------------------------------------------
test('db.js: source_media_purged_at exista in schema, findOrdersEligibleForSourceMediaPurge cauta STRICT plan video + status ready + regenerare inactiva, purgeOrderSourceMedia NU atinge variants/videoKey', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_media_purged_at TIMESTAMPTZ;/);
  const findFn = extractFn(db, 'async function findOrdersEligibleForSourceMediaPurge(cutoffDate) {');
  assert.match(findFn, /plan = 'video'/);
  assert.match(findFn, /status = 'ready'/);
  assert.match(findFn, /regeneration_status IS DISTINCT FROM 'running'/);
  assert.match(findFn, /source_media_purged_at IS NULL/);
  const purgeFn = extractFn(db, 'async function purgeOrderSourceMedia(id) {');
  assert.match(purgeFn, /uploaded_media = '\[\]'::jsonb/);
  assert.ok(!purgeFn.includes('variants'), 'purgeOrderSourceMedia nu trebuie sa atinga variants (produsul final)');
  assert.ok(!purgeFn.includes('videoKey') && !purgeFn.includes('video_key'), 'purgeOrderSourceMedia nu trebuie sa atinga videoKey (produsul final)');
});

test('server.js: SOURCE_MEDIA_RETENTION_DAYS=90 e o alegere operationala declarata ca atare in cod, purgeStaleSourceMedia NU sterge o comanda cu randare video activa sau incompleta (videoKey/videoPreviewKey lipsa)', () => {
  assert.match(server, /const SOURCE_MEDIA_RETENTION_DAYS = 90;/);
  const fn = extractFn(server, 'async function purgeStaleSourceMedia() {');
  assert.match(fn, /isVideoLockActive\(order\)/);
  assert.match(fn, /currentVariant\.videoKey/);
  assert.match(fn, /currentVariant\.videoPreviewKey/);
  assert.match(fn, /db\.purgeOrderSourceMedia\(order\.id\)/);
});

test('server.js: curatarea materialelor sursa ruleaza automat (setInterval, .unref()) SI e declansabila manual pentru testare/audit prin /api/admin/retention/purge-source-media, protejata de acelasi middleware admin', () => {
  assert.match(server, /setInterval\(\(\) => \{ purgeStaleSourceMedia\(\)\.catch/);
  assert.match(server, /\.unref\(\);/);
  const routeIdx = server.indexOf("app.post('/api/admin/retention/purge-source-media'");
  assert.notEqual(routeIdx, -1);
  const adminMwIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth);");
  assert.ok(adminMwIdx !== -1 && adminMwIdx < routeIdx, 'ruta trebuie inregistrata DUPA middleware-ul de autentificare admin');
});

test('Privacy Policy: accesul la produsul FINAL cumparat ramane neschimbat (legat de existenta comenzii), fara nicio perioada in zile inventata langa acea propozitie — decizie de business separata, NU luata aici', () => {
  const html = read('public/privacy.html');
  const idx = html.indexOf('purchased song or video, and your order record');
  assert.notEqual(idx, -1, 'trebuie sa existe categoria separata pentru produsul final cumparat');
  const sentenceEnd = html.indexOf('</li>', idx);
  const sentence = html.slice(idx, sentenceEnd);
  assert.ok(sentence.includes('for as long as your order exists'), 'accesul la produsul final ramane legat de existenta comenzii, neschimbat');
  assert.ok(!/\b\d+\s*(day|days|month|months|year|years)\b/i.test(sentence), 'NU trebuie sa apara nicio perioada calendaristica langa produsul final — e o decizie separata, ne-luata inca');
  assert.ok(!/\b(permanent|lifetime|forever)\b/i.test(html), 'nu trebuie promisa o disponibilitate "permanenta"/"lifetime" nerealist de garantat');
});

test('Privacy Policy: retentia materialelor SURSA (foto/video incarcate) e diferentiata de produsul final si REAL implementata (90 zile = SOURCE_MEDIA_RETENTION_DAYS din server.js, nu un numar inventat)', () => {
  const html = read('public/privacy.html');
  const server = read('server.js');
  assert.match(html, /original photos\/videos you uploaded within 90 days/);
  assert.match(server, /const SOURCE_MEDIA_RETENTION_DAYS = 90;/, 'perioada declarata public trebuie sa corespunda EXACT constantei reale din server.js');
  assert.ok(html.includes('operational choice'), 'trebuie sa clarifice ca perioada de 90 de zile e o alegere operationala, nu o obligatie legala');
});

test('Privacy Policy: retentia inregistrarilor de consimtamant (6 ani) si a celor contabile/fiscale (5 ani de la 31 ianuarie) sunt distincte, cu sursa legala/justificare pentru fiecare', () => {
  const html = read('public/privacy.html');
  assert.match(html, /consent you gave at checkout.*kept for 6 years/s);
  assert.match(html, /kept for 5 years from the 31 January/);
  assert.ok(html.includes('HMRC'), 'perioada contabila trebuie legata explicit de o obligatie legala reala (HMRC), nu inventata');
});

test('Privacy Policy: transferul international mentioneaza tara reala (United States) si NU afirma safeguard-uri nesustinute — angajament declarat, nu fapt istoric neverificabil despre furnizori', () => {
  const html = read('public/privacy.html');
  assert.ok(html.includes('United States'));
  assert.ok(html.includes('we only work with providers who commit contractually'), 'formularea trebuie sa fie un angajament al Naluna, nu o afirmatie despre documentatia deja semnata a fiecarui furnizor');
});
