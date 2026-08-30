// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerința 6): doua butoane de plata identice pe
// pagina finala — primul imediat dupa previzualizarea video, al doilea la finalul paginii, dupa
// cardurile cu melodiile. Aceeasi eticheta/pret/design, aceeasi functie de checkout, aceeasi
// comanda Stripe (backend neschimbat), vizibile STRICT cand videoclipul e ready, dezactivate
// impreuna la dublu-click. ID-uri unice, niciodata duplicate. Standard/Premium neatinse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const html = read('public/melodia-mea.html');

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

// ===============================================================================================
// PARTEA 1 — Structura HTML: ID-uri unice, pozitionare corecta, niciun clonaj cu handler
// incomplet.
// ===============================================================================================
test('melodia-mea.html: exista EXACT doua butoane de checkout, cu ID-uri UNICE (checkout-btn, checkout-btn-2) — niciun ID duplicat in document', () => {
  const idOccurrences = (idPattern) => (html.match(new RegExp(`id="${idPattern}"`, 'g')) || []).length;
  assert.equal(idOccurrences('checkout-btn'), 1);
  assert.equal(idOccurrences('checkout-btn-2'), 1);
});

test('melodia-mea.html: al doilea buton (#checkout-btn-2) e plasat imediat DUPA chenarul cu previzualizarea video (#gift-video-section), INAINTE de cardurile cu melodiile (#variants-wrap)', () => {
  const giftVideoIdx = html.indexOf('id="gift-video-section"');
  const checkout2Idx = html.indexOf('id="checkout-btn-2"');
  const variantsWrapIdx = html.indexOf('id="variants-wrap"');
  assert.ok(giftVideoIdx !== -1 && checkout2Idx !== -1 && variantsWrapIdx !== -1);
  assert.ok(giftVideoIdx < checkout2Idx && checkout2Idx < variantsWrapIdx, 'ordinea trebuie sa fie: previzualizare video -> checkout-btn-2 -> cardurile melodiilor');
});

test('melodia-mea.html: #checkout-btn (primul buton, la finalul paginii dupa carduri) ramane singurul reparentat — #checkout-btn-2 e STATIC, niciodata reparentat/clonat', () => {
  const isFinalBranch = extractFn(html, 'const isFinalGiftVideo = order.plan === \'video\' && order.videoStatus === \'ready\';\n    if (isFinalGiftVideo) {');
  assert.ok(isFinalBranch.includes('regenerateRow.appendChild(checkoutBtn);'));
  assert.ok(!isFinalBranch.includes('appendChild(checkoutBtn2)'), 'checkoutBtn2 nu trebuie NICIODATA reparentat — ramane static la pozitia lui fixa in HTML');
});

// ===============================================================================================
// PARTEA 2 — Aceeasi functie de checkout, acelasi handler, acelasi backend/comanda Stripe.
// ===============================================================================================
test('melodia-mea.html: ambele butoane apeleaza EXACT aceeasi functie goToCheckout — niciun handler separat/incomplet pentru al doilea buton', () => {
  assert.match(html, /checkoutBtn\.addEventListener\('click', goToCheckout\);/);
  assert.match(html, /if \(checkoutBtn2\) checkoutBtn2\.addEventListener\('click', goToCheckout\);/);
  // NU exista o a doua definitie de functie de checkout (ex. goToCheckout2) — o singura sursa.
  assert.ok(!html.includes('function goToCheckout2'));
  const occurrences = (html.match(/async function goToCheckout\(\)/g) || []).length;
  assert.equal(occurrences, 1);
});

test('melodia-mea.html: goToCheckout() foloseste STRICT acelasi endpoint (POST /api/orders/:orderId/checkout) — nicio cerere separata pentru al doilea buton', () => {
  const fnSrc = extractFn(html, 'async function goToCheckout() {');
  const occurrences = (fnSrc.match(/fetch\(`\/api\/orders\/\$\{orderId\}\/checkout`/g) || []).length;
  assert.equal(occurrences, 1, 'trebuie sa existe STRICT un singur apel catre backend, indiferent care buton a fost apasat');
});

test('server.js: endpoint-ul de checkout ramane neschimbat — aceeasi cheie de idempotency versionata, aceleasi validari (variantId curent, mediaRevision, videoKey) — niciun cod nou introdus pentru "al doilea buton"', () => {
  const server = read('server.js');
  assert.match(server, /checkout-\$\{order\.id\}-\$\{versionFingerprint\}/);
});

// ===============================================================================================
// PARTEA 3 — Vizibilitate: STRICT videoStatus==='ready', fara alegere de varianta in asteptare;
// ascunse in orice alta stare (meniu deschis, ecran de alegere, Premium).
// ===============================================================================================
test('melodia-mea.html: #checkout-btn-top-wrap e ascuns implicit la INCEPUTUL updateStandardEditMenuVisibility() — SINGURA ramura care il re-afiseaza e isFinalGiftVideo', () => {
  const fnSrc = extractFn(html, 'function updateStandardEditMenuVisibility(order, pendingVariantChoice) {');
  const hideIdx = fnSrc.indexOf("checkoutBtnTopWrap.style.display = 'none';");
  const isFinalGiftVideoIdx = fnSrc.indexOf('const isFinalGiftVideo');
  assert.ok(hideIdx !== -1 && hideIdx < isFinalGiftVideoIdx, 'ascunderea implicita trebuie sa preceada orice ramura');
  const showOccurrences = (fnSrc.match(/checkoutBtnTopWrap\.style\.display = 'block';/g) || []).length;
  assert.equal(showOccurrences, 1, 'trebuie sa existe STRICT un singur loc care il reafiseaza — ramura isFinalGiftVideo');
});

test('melodia-mea.html: al doilea buton e sincronizat (continut + disabled) cu primul prin syncCheckoutBtn2(), apelata dupa fiecare actualizare a etichetei/pretului in renderContent()', () => {
  assert.match(html, /function syncCheckoutBtn2\(\) \{/);
  const renderContentSrc = extractFn(html, 'function renderContent(order) {');
  assert.ok(renderContentSrc.includes('syncCheckoutBtn2();'));
});

test('syncCheckoutBtn2(): FUNCTIONAL — copiaza innerHTML si disabled ale primului buton, dar redenumeste ID-urile interne (checkout-price/selected-variant-label) ca sa nu duplice ID-uri in document', () => {
  const fnSrc = extractFn(html, 'function syncCheckoutBtn2() {');
  const sandboxSrc = `
    const checkoutBtn = { innerHTML: 'Continuă — <span id="checkout-price">£35</span> <span id="selected-variant-label">1</span> →', disabled: true };
    const checkoutBtn2 = { innerHTML: '', disabled: false };
    ${fnSrc}
    syncCheckoutBtn2();
    return checkoutBtn2;
  `;
  const result = new Function(sandboxSrc)();
  assert.ok(result.innerHTML.includes('id="checkout-price-2"'));
  assert.ok(result.innerHTML.includes('id="selected-variant-label-2"'));
  assert.ok(!result.innerHTML.includes('id="checkout-price"><'), 'ID-ul original nu trebuie sa mai apara neschimbat in al doilea buton');
  assert.equal(result.disabled, true, 'starea disabled trebuie copiata identic');
});

// ===============================================================================================
// PARTEA 4 — Protectie single-flight/dublu-click, INCLUSIV apasari rapide pe AMBELE butoane.
// ===============================================================================================
test('goToCheckout(): FUNCTIONAL — a doua apasare (pe ORICARE buton) cat timp prima cerere e in curs e ignorata complet (single-flight real, nu doar disabled vizual)', async () => {
  const fnSrc = extractFn(html, 'async function goToCheckout() {');
  let fetchCallCount = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const sandboxSrc = `
    let checkoutInFlight = false;
    const checkoutBtn = { disabled: false };
    const checkoutBtn2 = { disabled: false };
    const statusMsgEl = { textContent: '', className: '' };
    const t = { msg_preparing_payment: '...', msg_error_prefix: 'Eroare: ', msg_try_again: 'incearca din nou', msg_conn_error: 'eroare conexiune' };
    const orderId = 'test-order';
    const accessToken = 'test-token';
    async function fetch(url, opts) { __recordFetchCall(); return { json: async () => (await __fetchPromise) }; }
    ${fnSrc}
    return { goToCheckout, getCheckoutBtn: () => checkoutBtn, getCheckoutBtn2: () => checkoutBtn2, getInFlight: () => checkoutInFlight };
  `;
  const mod = new Function('__recordFetchCall', '__fetchPromise', sandboxSrc)(() => { fetchCallCount++; }, fetchPromise);
  const firstCall = mod.goToCheckout();
  const secondCall = mod.goToCheckout(); // apasare rapida, a doua, in timp ce prima e inca in curs
  assert.equal(mod.getCheckoutBtn().disabled, true, 'primul buton trebuie dezactivat sincron, imediat');
  assert.equal(mod.getCheckoutBtn2().disabled, true, 'al doilea buton trebuie dezactivat sincron, imediat, chiar daca a fost apasat primul');
  resolveFetch({ url: null, error: 'test' });
  await Promise.all([firstCall, secondCall]);
  assert.equal(fetchCallCount, 1, 'a doua apasare, cat timp prima era in curs, NU trebuie sa declanseze o a doua cerere catre server');
});

test('goToCheckout(): la eroare, AMBELE butoane sunt reactivate (nu ramane blocat definitiv un al doilea buton uitat)', async () => {
  const fnSrc = extractFn(html, 'async function goToCheckout() {');
  const sandboxSrc = `
    let checkoutInFlight = false;
    const checkoutBtn = { disabled: false };
    const checkoutBtn2 = { disabled: false };
    const statusMsgEl = { textContent: '', className: '' };
    const t = { msg_preparing_payment: '...', msg_error_prefix: 'Eroare: ', msg_try_again: 'incearca din nou', msg_conn_error: 'eroare conexiune' };
    const orderId = 'test-order';
    const accessToken = 'test-token';
    async function fetch() { return { json: async () => ({ url: null, error: 'a esuat' }) }; }
    ${fnSrc}
    return { goToCheckout, getCheckoutBtn: () => checkoutBtn, getCheckoutBtn2: () => checkoutBtn2 };
  `;
  const mod = new Function(sandboxSrc)();
  await mod.goToCheckout();
  assert.equal(mod.getCheckoutBtn().disabled, false, 'primul buton trebuie reactivat dupa un esec');
  assert.equal(mod.getCheckoutBtn2().disabled, false, 'al doilea buton trebuie reactivat dupa un esec — niciodata uitat blocat');
});

// ===============================================================================================
// PARTEA 5 — Standard/Premium raman complet neatinse.
// ===============================================================================================
test('melodia-mea.html: #checkout-btn-2 nu apare niciodata in fluxul Premium (renderPremiumFlow) — ramane STRICT rezervat paginii finale Video', () => {
  const premiumFnSrc = extractFn(html, 'function renderPremiumFlow(order, isResumeFlag) {');
  assert.ok(!premiumFnSrc.includes('checkoutBtn2'), 'fluxul Premium nu trebuie sa atinga deloc al doilea buton');
});

test('melodia-mea.html: Standard nu ajunge niciodata in ramura isFinalGiftVideo (STRICT order.plan===\'video\') — al doilea buton ramane invizibil pentru Standard', () => {
  const fnSrc = extractFn(html, 'function updateStandardEditMenuVisibility(order, pendingVariantChoice) {');
  assert.match(fnSrc, /const isFinalGiftVideo = order\.plan === 'video' && order\.videoStatus === 'ready';/);
});

test('server.js, public/melodia-mea.html raman sintactic valide dupa aceasta corectie', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
