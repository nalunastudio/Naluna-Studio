// UX + AUTORIZARE (2026-09-28, "Comenzile mele goale in Chrome normal" — audit + fix) — un client
// a folosit EXACT ACELASI browser (Chrome normal, nu Incognito) pentru a crea/testa comenzi
// anterior, dar "Comenzile mele" aparea GOALA pana la recovery prin email. Root cause DEMONSTRAT
// (nu presupus): STRICT comanda.html scria in naluna_my_order_keys, la crearea comenzii — NICIO
// alta pagina care detine/valideaza deja un accessToken (melodia-mea.html — destinatia
// reminderelor de preview/checkout; comanda-mea.html — destinatia LINKULUI DIN EMAILUL DE LIVRARE,
// cea mai comuna revenire a unui client platit) nu il intarea acolo. Un browser care a ajuns la
// oricare din aceste doua pagini altfel decat prin fluxul complet, neintrerupt, comanda.html ->
// /generate (ex. a inchis fila inainte de acel moment, sau a continuat STRICT prin linkul din
// email — cazul cel mai comun pentru un client care isi verifica melodia livrata) ramane
// "neautorizat" pentru Comenzile mele, desi detine deja, legitim, un accessToken valid, verificat
// server-side chiar pe acea pagina.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const melodiaMea = read('public/melodia-mea.html');
const comandaMea = read('public/comanda-mea.html');
const comanda = read('public/comanda.html');
const comenzileMele = read('public/comenzile-mele.html');
const server = read('server.js');

function lastInlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

// ===============================================================================================
// A. AUDIT/ROOT CAUSE — demonstratie directa in cod: cele doua destinatii de email (reminder si
// livrare) NU salvau tokenul inainte de acest fix, comanda.html ramanea SINGURUL scriitor.
// ===============================================================================================
test('AUDIT: linkul din emailul de LIVRARE (server.js, dupa plata) duce STRICT la comanda-mea.html?token= — cea mai comuna revenire a unui client platit', () => {
  const idx = server.indexOf("const accessUrl = `${DOMAIN}/comanda-mea.html?token=${order.accessToken}`;");
  assert.ok(idx !== -1, 'accessUrl-ul emailului de livrare trebuie sa duca la comanda-mea.html?token=');
});

test('AUDIT: linkurile din reminderele de preview/checkout (lib/recovery-emails/templates.js) duc STRICT la melodia-mea.html?id=&token=', () => {
  const templates = read('lib/recovery-emails/templates.js');
  assert.match(templates, /\$\{domain\}\/melodia-mea\.html\?id=\$\{encodeURIComponent\(orderId\)\}&token=\$\{encodeURIComponent\(accessToken\)\}/);
});

test('AUDIT: inainte de acest fix, STRICT comanda.html scria in naluna_my_order_keys — nicio alta pagina de destinatie (se-compune, succes, amintiri-video, se-creeaza-video) nu o face (ramane asa, neschimbat — nu sunt puncte de intrare din email pentru clienti care revin)', () => {
  for (const f of ['se-compune.html', 'succes.html', 'amintiri-video.html', 'se-creeaza-video.html']) {
    const html = read('public/' + f);
    assert.ok(!html.includes('naluna_my_order_keys'), `public/${f} nu ar trebui sa scrie in naluna_my_order_keys (nu e punct de intrare din email) — daca acest test pica, verifica daca a devenit un punct de intrare din email si necesita acelasi fix`);
  }
});

// ===============================================================================================
// B. FIX — melodia-mea.html: rememberAuthorizedOrder() scrie STRICT dupa succesul (res.ok) al
// validarii server-side, niciodata pe baza simplei prezente a parametrilor din URL.
// ===============================================================================================
test('melodia-mea.html: functia rememberAuthorizedOrder() exista si e apelata IMEDIAT dupa parsarea raspunsului JSON din loadOrder(), inaintea oricarei ramuri de status', () => {
  const idx = melodiaMea.indexOf('function rememberAuthorizedOrder(id, token) {');
  assert.ok(idx !== -1);
  const loadOrderIdx = melodiaMea.indexOf('async function loadOrder() {');
  const body = melodiaMea.slice(loadOrderIdx, loadOrderIdx + 600);
  const resOkIdx = body.indexOf('if (!res.ok)');
  const jsonIdx = body.indexOf('const order = await res.json();');
  const rememberIdx = body.indexOf('rememberAuthorizedOrder(orderId, accessToken);');
  assert.ok(resOkIdx !== -1 && jsonIdx !== -1 && rememberIdx !== -1);
  assert.ok(resOkIdx < jsonIdx && jsonIdx < rememberIdx, 'ordinea trebuie sa fie: verificare res.ok (early return) -> parsare JSON -> salvare token — NICIODATA inaintea validarii server-side');
});

test('melodia-mea.html: node --check (indirect, sintaxa scriptului inline) trece dupa modificare', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(melodiaMea)));
});

// ===============================================================================================
// C. FIX — comanda-mea.html: aceeasi reinforce, dupa succesul GET /api/orders/access/:token.
// ===============================================================================================
test('comanda-mea.html: salvarea in naluna_my_order_keys se face STRICT dupa toate verificarile de esec (400/404/!res.ok), niciodata inainte', () => {
  const idx = comandaMea.indexOf('async function lookup(token) {');
  const end = comandaMea.indexOf('const fullUrl = `/media/full/', idx);
  const body = comandaMea.slice(idx, end);
  const idx400 = body.indexOf("if (res.status === 400)");
  const idx404 = body.indexOf("if (res.status === 404)");
  const idxNotOk = body.indexOf("if (!res.ok)");
  const idxJson = body.indexOf('const o = await res.json();');
  const idxSave = body.indexOf("localStorage.setItem(KEY, JSON.stringify(list.slice(-50)));");
  assert.ok([idx400, idx404, idxNotOk, idxJson, idxSave].every((i) => i !== -1));
  assert.ok(idx400 < idxJson && idx404 < idxJson && idxNotOk < idxJson, 'toate gardurile de eroare trebuie sa preceada parsarea JSON');
  assert.ok(idxJson < idxSave, 'salvarea trebuie sa vina STRICT dupa parsarea raspunsului de succes');
});

test('comanda-mea.html: node --check (indirect, sintaxa scriptului inline) trece dupa modificare', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(comandaMea)));
});

// ===============================================================================================
// D. COMPORTAMENT REAL, sandbox — merge idempotent (nu suprascrie, nu duplica).
// ===============================================================================================
function loadRememberFn(html) {
  const idx = html.indexOf('function rememberAuthorizedOrder(id, token) {');
  const end = html.indexOf('\n  }', idx) + 4;
  const fnSrc = html.slice(idx, end);
  const fn = new Function('localStorage', fnSrc + '\nreturn rememberAuthorizedOrder;');
  const storage = {};
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  return { remember: fn(localStorageMock), storage };
}

test('sandbox (melodia-mea.html): rememberAuthorizedOrder() pe o lista goala creeaza o singura intrare noua', () => {
  const { remember, storage } = loadRememberFn(melodiaMea);
  remember('order-A', 'tok-A'.padEnd(48, '0'));
  const list = JSON.parse(storage.naluna_my_order_keys);
  assert.deepEqual(list, [{ id: 'order-A', token: 'tok-A'.padEnd(48, '0') }]);
});

test('sandbox (melodia-mea.html): apelat pentru DOUA comenzi diferite -> lista se COMPLETEAZA (2 intrari), niciodata suprascrisa', () => {
  const { remember, storage } = loadRememberFn(melodiaMea);
  remember('order-A', 'a'.repeat(48));
  remember('order-B', 'b'.repeat(48));
  const list = JSON.parse(storage.naluna_my_order_keys);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((o) => o.id).sort(), ['order-A', 'order-B']);
});

test('sandbox (melodia-mea.html): apelat DE DOUA ORI pentru ACEEASI comanda (ex. token reimprospatat) -> actualizeaza intrarea existenta, NU o duplica', () => {
  const { remember, storage } = loadRememberFn(melodiaMea);
  remember('order-A', 'a'.repeat(48));
  remember('order-A', 'z'.repeat(48));
  const list = JSON.parse(storage.naluna_my_order_keys);
  assert.equal(list.length, 1, 'nu trebuie sa existe doua intrari pentru aceeasi comanda');
  assert.equal(list[0].token, 'z'.repeat(48));
});

test('sandbox (melodia-mea.html): apelat alaturi de comenzi deja existente (create prin comanda.html) -> le PASTREAZA, nu le sterge/suprascrie', () => {
  const { remember, storage } = loadRememberFn(melodiaMea);
  storage.naluna_my_order_keys = JSON.stringify([{ id: 'order-existing', token: 'e'.repeat(48) }]);
  remember('order-new', 'n'.repeat(48));
  const list = JSON.parse(storage.naluna_my_order_keys);
  assert.equal(list.length, 2);
  assert.ok(list.some((o) => o.id === 'order-existing'));
  assert.ok(list.some((o) => o.id === 'order-new'));
});

test('sandbox (melodia-mea.html): id/token lipsa/goale -> nu scrie nimic (defensiv, nu populeaza cu date invalide)', () => {
  const { remember, storage } = loadRememberFn(melodiaMea);
  remember('', '');
  remember(null, null);
  assert.equal(storage.naluna_my_order_keys, undefined);
});

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadComandaMeaRememberSnippet() {
  const idx = comandaMea.indexOf("const o = await res.json();");
  const end = comandaMea.indexOf('const fullUrl = `/media/full/', idx);
  const snippet = comandaMea.slice(idx, end);
  return `
    ${snippet}
    return localStorage.getItem('naluna_my_order_keys');
  `;
}

test('sandbox (comanda-mea.html): dupa un lookup reusit, naluna_my_order_keys contine {id, token} al comenzii gasite prin recovery cu un singur cod', () => {
  const storage = {};
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  const resMock = { json: async () => ({ id: 'order-XYZ' }) };
  const fn = new AsyncFunction('localStorage', 'res', 'token', loadComandaMeaRememberSnippet());
  const result = fn(localStorageMock, resMock, 'z'.repeat(48));
  return result.then((raw) => {
    const list = JSON.parse(raw);
    assert.deepEqual(list, [{ id: 'order-XYZ', token: 'z'.repeat(48) }]);
  });
});

test('sandbox (comanda-mea.html): apelat de doua ori pentru ACEEASI comanda -> actualizeaza, nu duplica', () => {
  const storage = { naluna_my_order_keys: JSON.stringify([{ id: 'order-XYZ', token: 'old'.padEnd(48, '0') }]) };
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  const resMock = { json: async () => ({ id: 'order-XYZ' }) };
  const fn = new AsyncFunction('localStorage', 'res', 'token', loadComandaMeaRememberSnippet());
  const result = fn(localStorageMock, resMock, 'new'.padEnd(48, '0'));
  return result.then((raw) => {
    const list = JSON.parse(raw);
    assert.equal(list.length, 1);
    assert.equal(list[0].token, 'new'.padEnd(48, '0'));
  });
});

// ===============================================================================================
// E. NICIO SCURGERE — noile blocuri de cod nu trimit accessToken/email catre analytics/console.
// ===============================================================================================
test('melodia-mea.html si comanda-mea.html: blocul nou (rememberAuthorizedOrder / salvarea inline) nu apeleaza niciodata NalunaAnalytics/console.* cu id/token', () => {
  const melodiaBlock = melodiaMea.slice(melodiaMea.indexOf('function rememberAuthorizedOrder'), melodiaMea.indexOf('async function loadOrder() {') + 700);
  const comandaMeaBlock = comandaMea.slice(comandaMea.indexOf("const o = await res.json();"), comandaMea.indexOf('const fullUrl = `/media/full/'));
  for (const [name, block] of [['melodia-mea.html', melodiaBlock], ['comanda-mea.html', comandaMeaBlock]]) {
    assert.ok(!/NalunaAnalytics/.test(block), `[${name}] blocul nou nu trebuie sa apeleze analytics`);
    assert.ok(!/console\./.test(block), `[${name}] blocul nou nu trebuie sa apeleze console`);
  }
});

// ===============================================================================================
// F. ELIGIBILITATE — reconfirmare (neschimbata de acest task): comenzile-mele.html exclude STRICT
// 'draft' (fara generare pornita, variants mereu gol) si 'generation_failed' din lista afisata —
// un draft gol NU apare niciodata ca o comanda cu melodii.
// ===============================================================================================
test('comenzile-mele.html: filtrul de eligibilitate exclude STRICT draft/generation_failed — reconfirmat, neschimbat de acest fix', () => {
  assert.match(comenzileMele, /r\.order\.status !== 'draft' && r\.order\.status !== 'generation_failed'/);
});

test("db.js: un 'draft' NU poate avea niciodata variants populate — generarea (care populeaza variants) tranzitioneaza STRICT prin 'generating', niciodata direct din 'draft' fara claim — deci excluderea din lista clientului nu ascunde niciodata continut real", () => {
  const db = read('db.js');
  const idx = db.indexOf("SET status = 'generating',");
  assert.ok(idx !== -1, 'tranzitia draft -> generating trebuie sa existe STRICT in claimOrderForInitialGeneration');
});

// ===============================================================================================
// G. RECOVERY -> AUTORIZARE PERSISTENTA — dupa un recovery reusit (tokenuri importate + salvate),
// urmatoarea vizita (fara ?tokens= in URL) afiseaza deja comenzile, fara alt recovery.
// ===============================================================================================
function buildSandbox({ search = '', storedOrders, fetchImpl } = {}) {
  const script = lastInlineScript(comenzileMele);
  const bodyStart = script.indexOf('(function () {') + '(function () {'.length;
  const bodyEnd = script.lastIndexOf('})();');
  const body = script.slice(bodyStart, bodyEnd);
  const marker = 'loadAndRenderOrders().catch(() => {';
  const instrumentedBody = body.replace(marker, 'window.__test_loadPromise = ' + marker);
  const harness = `
    ${instrumentedBody}
    window.__test_api = { loadAndRenderOrders, __loadPromise: window.__test_loadPromise };
  `;
  function makeEl() {
    const listeners = {};
    return {
      style: {}, dataset: {}, children: [], href: '',
      set textContent(v) { this._text = v; this._html = v; },
      get textContent() { return this._text || ''; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(evt, fn) { listeners[evt] = fn; },
      __listeners: listeners,
      setAttribute() {},
      set value(v) { this._value = v; },
      get value() { return this._value || ''; }
    };
  }
  const elements = {};
  const ids = ['h1-title', 'p-sub', 'loading-msg', 'recovery-title', 'recovery-sub', 'recovery-email', 'recovery-btn', 'blocked-banner', 'orders-list', 'recovery-box', 'recovery-result', 'use-other-email-btn'];
  for (const id of ids) elements[id] = makeEl();
  elements['blocked-banner'].style.display = 'none';
  elements['recovery-box'].style.display = 'none';
  const documentMock = {
    documentElement: { lang: '' },
    getElementById: (id) => elements[id] || makeEl(),
    createElement: () => makeEl()
  };
  const storage = {};
  if (storedOrders !== undefined) storage.naluna_my_order_keys = JSON.stringify(storedOrders);
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  const windowMock = { location: { search, href: 'https://nalunastudio.com/comenzile-mele.html' + search }, history: { replaceState: () => {} } };
  const fetchCalls = [];
  const fetchMock = async (url) => {
    fetchCalls.push(url);
    return fetchImpl ? fetchImpl(url) : { ok: false };
  };
  const fn = new Function('document', 'window', 'localStorage', 'navigator', 'URLSearchParams', 'fetch', 'history',
    harness + '\nreturn window.__test_api;'
  );
  const api = fn(documentMock, windowMock, localStorageMock, { language: 'en' }, URLSearchParams, fetchMock, { replaceState: () => {} });
  return { api, elements, storage, fetchCalls };
}

function jsonRes(obj) { return { ok: true, json: async () => obj }; }

test('sandbox: recovery via ?tokens=... importa comenzile eligibile, le salveaza local — o vizita ULTERIOARA (search gol, DOAR localStorage deja populat) le afiseaza direct, FARA ?tokens= din nou', async () => {
  const tokenA = 'a'.repeat(48);
  const orderA = { id: 'order-A', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false };

  // Pasul 1 — recovery: link cu ?tokens=..., localStorage initial GOL.
  const first = buildSandbox({
    search: `?tokens=${tokenA}`,
    storedOrders: [],
    fetchImpl: (url) => {
      if (url.includes('/api/orders/access/')) return jsonRes({ id: 'order-A' });
      if (url.includes('/api/orders/order-A?token=')) return jsonRes(orderA);
      return { ok: false };
    }
  });
  await first.api.__loadPromise;
  assert.equal(first.elements['orders-list'].children.length, 1, 'dupa recovery, comanda trebuie afisata IMEDIAT, in aceeasi vizita');
  const savedAfterFirst = JSON.parse(first.storage.naluna_my_order_keys);
  assert.deepEqual(savedAfterFirst, [{ id: 'order-A', token: tokenA }]);

  // Pasul 2 — vizita ULTERIOARA: search GOL (fara ?tokens=), STRICT ce a fost salvat la pasul 1.
  const second = buildSandbox({
    search: '',
    storedOrders: savedAfterFirst,
    fetchImpl: (url) => (url.includes('/api/orders/order-A?token=') ? jsonRes(orderA) : { ok: false })
  });
  await second.api.__loadPromise;
  assert.equal(second.fetchCalls.some((u) => u.includes('/api/orders/access/')), false, 'a doua vizita nu trebuie sa mai apeleze recovery-by-token — autorizarea locala e deja suficienta');
  assert.equal(second.elements['orders-list'].children.length, 1, 'comanda trebuie sa apara DIRECT, fara alt recovery');
  assert.match(second.elements['recovery-box'].style.display, /^$/, 'recovery ramane vizibil ca optiune secundara, dar NU e necesar pentru a vedea comanda');
});

test('sandbox: 3 comenzi autorizate (Standard/Premium/Video) -> 3 carduri, in aceeasi lista, la o vizita STRICT locala (fara niciun token in URL)', async () => {
  const toks = { s: 's'.repeat(48), p: 'p'.repeat(48), v: 'v'.repeat(48) };
  const orders = {
    'order-s': { id: 'order-s', plan: 'standard', recipient: 'Ion', status: 'ready', createdAt: '2026-09-01T00:00:00Z' },
    'order-p': { id: 'order-p', plan: 'premium', recipient: 'Alina', status: 'ready', createdAt: '2026-09-02T00:00:00Z', hasGiftAudio: true, hasPremiumBonusAudio: true },
    'order-v': { id: 'order-v', plan: 'video', recipient: 'Andrei', status: 'preview_ready', createdAt: '2026-09-03T00:00:00Z', variants: [{ previewUrl: 'x' }] }
  };
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-s', token: toks.s }, { id: 'order-p', token: toks.p }, { id: 'order-v', token: toks.v }],
    fetchImpl: (url) => {
      const match = Object.keys(orders).find((id) => url.includes(`/api/orders/${id}?token=`));
      return match ? jsonRes(orders[match]) : { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.length, 3);
});

// ===============================================================================================
// H. 8 LIMBI — reconfirmare ca noile fixuri nu au stricat cheile deja existente (fara text nou
// vizibil clientului adaugat de ACEST task — schimbarea e STRICT persistenta locala a tokenului).
// ===============================================================================================
test('comenzile-mele.html: toate cele 8 limbi raman intacte dupa acest fix (nicio cheie lipsa)', () => {
  const idx = comenzileMele.indexOf('const T = {');
  let depth = 0, i = comenzileMele.indexOf('{', idx);
  const start = i;
  for (; i < comenzileMele.length; i++) {
    if (comenzileMele[i] === '{') depth++;
    else if (comenzileMele[i] === '}') { depth--; if (depth === 0) break; }
  }
  const T = new Function(comenzileMele.slice(idx, i + 1) + '\nreturn T;')();
  for (const lang of ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']) {
    assert.ok(T[lang], `limba ${lang} lipseste`);
    assert.ok(T[lang].order_label && T[lang].song_count && T[lang].use_other_email && T[lang].recovery_email_fallback_btn);
  }
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
