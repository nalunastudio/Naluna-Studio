// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerința 6) + CORECȚIA 2026-08-31 (Cerinta 2,
// "doua butoane de plata mari si usor de gasit"): doua butoane de plata identice pe pagina
// finala. Pozitia a fost REVIZUITA in runda 2026-08-31: primul buton s-a mutat INAINTEA
// previzualizarii video (imediat dupa cardul planului, vizibil in primul ecran pe iPhone), al
// doilea ramane ultimul element vizibil, dupa cardurile cu melodiile, intr-un slot STABIL,
// NICIODATA descendent al unui container care primeste `hidden=true` (cauza exacta a bug-ului
// "butonul de jos lipsea" — vezi testele dedicate mai jos). Aceeasi eticheta/pret/design (acum
// marite — .btn-cta-checkout-lg), aceeasi functie de checkout, aceeasi comanda Stripe (backend
// neschimbat), vizibile STRICT cand videoclipul e ready, dezactivate impreuna la dublu-click.
// ID-uri unice, niciodata duplicate. Standard/Premium neatinse.
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

// CORECȚIE (2026-08-31, Cerinta 2A): ordinea DOM reala ceruta explicit — titlu/dedicatie -> cardul
// planului (plan-badge) -> PRIMUL buton (checkout-btn-2) -> previzualizarea video -> cardurile
// melodiilor (variants-wrap) -> AL DOILEA buton (checkout-btn-bottom-wrap, static, la finalul
// paginii). Primul buton trebuie sa fie vizibil in primul ecran pe iPhone, fara derulare dupa
// player — deci STRICT inaintea chenarului de previzualizare, nu dupa el.
test('melodia-mea.html: ordinea DOM reala e card plan -> CTA sus -> preview -> melodii -> CTA jos', () => {
  const planBadgeIdx = html.indexOf('id="plan-badge"');
  const checkout2Idx = html.indexOf('id="checkout-btn-2"');
  const giftVideoIdx = html.indexOf('id="gift-video-section"');
  const variantsWrapIdx = html.indexOf('id="variants-wrap"');
  const checkoutBottomWrapIdx = html.indexOf('id="checkout-btn-bottom-wrap"');
  assert.ok([planBadgeIdx, checkout2Idx, giftVideoIdx, variantsWrapIdx, checkoutBottomWrapIdx].every(i => i !== -1), 'toate elementele trebuie sa existe');
  assert.ok(planBadgeIdx < checkout2Idx, 'primul buton trebuie sa vina dupa cardul planului');
  assert.ok(checkout2Idx < giftVideoIdx, 'primul buton trebuie sa vina INAINTE de previzualizarea video (vizibil in primul ecran, fara derulare)');
  assert.ok(giftVideoIdx < variantsWrapIdx, 'previzualizarea video ramane inaintea cardurilor melodiilor');
  assert.ok(variantsWrapIdx < checkoutBottomWrapIdx, 'al doilea buton trebuie sa fie STRICT dupa cardurile melodiilor');
});

test('melodia-mea.html: slotul final (#checkout-btn-bottom-wrap) e ultimul element din #content-state — fara alte sectiuni/spatii mari dupa el', () => {
  const checkoutBottomWrapIdx = html.indexOf('id="checkout-btn-bottom-wrap"');
  const contentStateCloseIdx = html.indexOf('<div id="lyrics-editor-state"');
  assert.ok(checkoutBottomWrapIdx !== -1 && contentStateCloseIdx !== -1);
  const between = html.slice(checkoutBottomWrapIdx, contentStateCloseIdx);
  // intre slot si finalul lui #content-state pot exista STRICT tag-urile de inchidere (</div>),
  // niciun alt element vizibil nou.
  assert.ok(!/<div id="/.test(between.slice(between.indexOf('</div>'))), 'nu trebuie sa mai existe alt container nou dupa slotul final');
});

// CORECȚIE (2026-08-31, Cerinta 2B, "cauza pentru care butonul de jos lipsea"): #checkout-btn NU
// mai e reparentat in #regenerate-row — acela e un COPIL al lui #edit-menu-fields, care primeste
// `hidden = true` pe pagina finala; atributul HTML `hidden` forteaza display:none pe element
// INDIFERENT de style.display al descendentilor, deci butonul devenea invizibil desi era "vizibil"
// dupa propriul lui style. Reparentat acum intr-un slot STATIC, independent, NICIODATA descendent
// al unui container cu `hidden` — #checkout-btn-bottom-wrap.
test('melodia-mea.html: #checkout-btn e reparentat intr-un slot STABIL (#checkout-btn-bottom-wrap), NICIODATA in #regenerate-row (copil al lui #edit-menu-fields, care primeste hidden=true) — #checkout-btn-2 ramane STATIC, niciodata reparentat/clonat', () => {
  const fnSrc = extractFn(html, 'function updateStandardEditMenuVisibility(order, pendingVariantChoice) {');
  const isFinalIdx = fnSrc.indexOf('if (isFinalGiftVideo) {');
  const isFinalEnd = fnSrc.indexOf('\n    }', isFinalIdx);
  const isFinalBranch = fnSrc.slice(isFinalIdx, isFinalEnd);
  assert.ok(isFinalBranch.includes('checkoutBtnBottomWrap.appendChild(checkoutBtn);'), 'checkoutBtn trebuie reparentat in slotul stabil, independent');
  assert.ok(!isFinalBranch.includes('regenerateRow.appendChild(checkoutBtn)'), 'checkoutBtn nu mai trebuie reparentat in regenerate-row (copil al unui container cu hidden=true)');
  assert.ok(!isFinalBranch.includes('appendChild(checkoutBtn2)'), 'checkoutBtn2 nu trebuie NICIODATA reparentat — ramane static la pozitia lui fixa in HTML');
});

test('melodia-mea.html: #regenerate-row e un descendent al lui #edit-menu-fields, care primeste hidden=true pe pagina finala — confirma STRUCTURAL cauza exacta a bug-ului original', () => {
  const editMenuFieldsSrc = extractFn(html, '<div id="edit-menu-fields">');
  assert.ok(editMenuFieldsSrc.includes('id="regenerate-row"'), 'regenerate-row trebuie sa ramana descendent al edit-menu-fields (confirma cauza bug-ului, nu o schimbare de structura HTML)');
});

test('melodia-mea.html: ambele butoane primesc clasa .btn-cta-checkout-lg (latime completa, fara max-width, inaltime mare) pe pagina finala', () => {
  assert.match(html, /<button type="button" class="btn btn-primary btn-cta-checkout-lg" id="checkout-btn-2">/);
  const fnSrc = extractFn(html, 'function updateStandardEditMenuVisibility(order, pendingVariantChoice) {');
  const isFinalIdx = fnSrc.indexOf('if (isFinalGiftVideo) {');
  const isFinalEnd = fnSrc.indexOf('\n    }', isFinalIdx);
  const isFinalBranch = fnSrc.slice(isFinalIdx, isFinalEnd);
  assert.ok(isFinalBranch.includes("checkoutBtn.classList.add('btn-cta-checkout-lg')"));
});

test('CSS: .btn-cta-checkout-lg respecta dimensiunile cerute — latime completa, fara max-width:420px, inaltime minima 64-68px, font minimum 18px, font-weight 700', () => {
  const cssIdx = html.indexOf('.btn-cta-checkout-lg{');
  assert.ok(cssIdx !== -1);
  const cssBlock = html.slice(cssIdx, html.indexOf('}', cssIdx) + 1);
  assert.ok(cssBlock.includes('width:100%'));
  assert.ok(!cssBlock.includes('max-width:420px'));
  const minHeightMatch = cssBlock.match(/min-height:(\d+)px/);
  assert.ok(minHeightMatch && Number(minHeightMatch[1]) >= 64 && Number(minHeightMatch[1]) <= 68, 'inaltimea minima trebuie sa fie intre 64 si 68px');
  const fontSizeMatch = cssBlock.match(/font-size:(\d+)px/);
  assert.ok(fontSizeMatch && Number(fontSizeMatch[1]) >= 18, 'fontul trebuie sa fie de minimum 18px');
  assert.ok(cssBlock.includes('font-weight:700'));
});

test('melodia-mea.html: ambele butoane folosesc culoarea neagra existenta (.btn-primary), nu portocaliu — .btn-cta-checkout-lg nu redefineste background/color', () => {
  const cssIdx = html.indexOf('.btn-cta-checkout-lg{');
  const cssBlock = html.slice(cssIdx, html.indexOf('}', cssIdx) + 1);
  assert.ok(!cssBlock.includes('background'), 'clasa de dimensiune nu trebuie sa schimbe culoarea — ramane .btn-primary (negru existent)');
  assert.ok(!cssBlock.includes('color:'));
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
    const t = { msg_preparing_payment: '...', msg_error_prefix: 'Eroare: ', msg_try_again: 'incearca din nou', msg_conn_error: 'eroare conexiune', consent_required_error: 'bifeaza mai intai' };
    const orderId = 'test-order';
    const accessToken = 'test-token';
    const checkoutConsentCheckbox = { checked: true, focus: () => {} };
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
    const t = { msg_preparing_payment: '...', msg_error_prefix: 'Eroare: ', msg_try_again: 'incearca din nou', msg_conn_error: 'eroare conexiune', consent_required_error: 'bifeaza mai intai' };
    const orderId = 'test-order';
    const accessToken = 'test-token';
    const checkoutConsentCheckbox = { checked: true, focus: () => {} };
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

// ===============================================================================================
// PARTEA 6 — Cerinta 2D: pollingul generating->ready afiseaza ambele CTA-uri fara refresh manual.
// ===============================================================================================
test('melodia-mea.html: refreshVideoStatusOnly() (refresh-ul USOR de polling) apeleaza updateStandardEditMenuVisibility() — daca videoStatus devine "ready" cat clientul e pe pagina, ambele CTA-uri trebuie sa apara automat, fara reincarcare completa', () => {
  const fnSrc = extractFn(html, 'async function refreshVideoStatusOnly() {');
  assert.ok(fnSrc.includes('updateStandardEditMenuVisibility(order, pendingVariantChoiceNow)'), 'refresh-ul usor de polling trebuie sa re-evalueze vizibilitatea butoanelor de plata, nu doar mesajul de stare video');
});

test('server.js, public/melodia-mea.html raman sintactic valide dupa aceasta corectie', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => new Function(m[1]));
});
