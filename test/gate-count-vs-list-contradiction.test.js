// BUG REAL, URGENT (2026-09-28, dupa deploy 811d5c0) — reprodus exact din raportul clientului:
// pe comanda.html, ecranul "Ce vrei sa faci?" arata "Ai 4 comenzi salvate in acest browser.", dar
// click pe "Comenzile mele" duce la "Nu am gasit nicio comanda in acest browser." — ACELASI
// localStorage, doua raspunsuri contradictorii.
//
// CAUZA EXACTA, demonstrata mai jos (NU presupusa):
//
// (1) comanda.html#computeLocalKnownOrderCount() numara STRICT `naluna_my_order_keys.length`
//     (dupa un filtru minimal id+token nevide) — ZERO verificare server-side. Orice intrare
//     stale/invalida (comanda expirata, token gresit, ID inexistent) e numarata identic cu o
//     comanda reala, valida.
//
// (2) comenzile-mele.html#loadAndRenderOrders() face verificarea server-side reala, DAR
//     confunda doua situatii complet diferite in acelasi `catch (e) { return null; }`:
//       (a) serverul CONFIRMA explicit ca id/token nu sunt valide (404/400) — comanda chiar nu
//           mai exista / tokenul e gresit — pruning e corect aici;
//       (b) fetch-ul ESUEAZA (exceptie de retea — offline, timeout, conexiune mobila instabila,
//           tab-ul e in fundal etc.) SAU serverul raspunde cu o eroare temporara (5xx) — NU avem
//           NICIO dovada ca acea comanda nu mai e valida, doar ca NU AM PUTUT verifica ACUM.
//     Codul actual trateaza (a) si (b) IDENTIC: `return null` in ambele cazuri -> intrarea e
//     SCOASA PERMANENT din naluna_my_order_keys (`stillValidIds`/`known.filter`), desi in cazul
//     (b) comanda ramane perfect valida — pur si simplu nu am reusit sa o verificam acum. Pe un
//     telefon, cu retea mobila instabila, ACEASTA e calea cea mai probabila prin care 4 comenzi
//     reale, valide, autorizate ajung sa fie sterse dintr-o singura vizita pe Comenzile mele.
//
// Testul de mai jos reproduce EXACT scenariul: 4 intrari valide in naluna_my_order_keys, dintre
// care fetch-urile catre server ESUEAZA prin exceptie de retea (NU 404/400 — o eroare de retea
// reala, simulata) -> comanda.html ar arata "4", comenzile-mele.html arata 0 SI STERGE toate cele
// 4 intrari din localStorage. TREBUIE sa esueze pe codul curent (inainte de fix).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const comanda = read('public/comanda.html');
const comenzileMele = read('public/comenzile-mele.html');

function lastInlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

// ===============================================================================================
// Sandbox comenzile-mele.html — extragem intreg IIFE-ul (acelasi tipar deja folosit in
// comenzile-mele-page.test.js), il executam cu fetch care ARUNCA (exceptie de retea reala).
// ===============================================================================================
function buildComenzileMeleSandbox({ storedOrders, fetchImpl }) {
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
  const windowMock = { location: { search: '', href: 'https://nalunastudio.com/comenzile-mele.html' }, history: { replaceState: () => {} } };
  const fetchMock = async (url) => fetchImpl(url);
  const fn = new Function('document', 'window', 'localStorage', 'navigator', 'URLSearchParams', 'fetch', 'history',
    harness + '\nreturn window.__test_api;'
  );
  const api = fn(documentMock, windowMock, localStorageMock, { language: 'en' }, URLSearchParams, fetchMock, { replaceState: () => {} });
  return { api, elements, storage };
}

// ===============================================================================================
// Sandbox comanda.html — extragem STRICT computeVerifiedKnownOrderCount() (functie asincrona,
// verifica FIECARE intrare server-side, acelasi filtru de eligibilitate ca in comenzile-mele.html)
// — acelasi tipar de extragere ca in celelalte teste ale acestei pagini.
// ===============================================================================================
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function computeGateCount(storedOrders, fetchImpl) {
  const idx = comanda.indexOf('async function computeVerifiedKnownOrderCount() {');
  const end = comanda.indexOf('\n  }', idx) + 4;
  const fnSrc = comanda.slice(idx, end);
  const localStorageMock = { getItem: () => JSON.stringify(storedOrders) };
  const fetchMock = fetchImpl || (async () => ({ ok: false }));
  const fn = new AsyncFunction('localStorage', 'fetch', fnSrc + '\nreturn computeVerifiedKnownOrderCount();');
  return fn(localStorageMock, fetchMock);
}

function jsonRes(obj) { return { ok: true, json: async () => obj }; }
function order(id, overrides = {}) {
  return { id, plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, ...overrides };
}

// ===============================================================================================
// REPRODUCERE #1 — 4 intrari valide, toate esueaza prin EXCEPTIE DE RETEA (nu 404/400 confirmat) —
// EXACT scenariul "am testat pe telefon" (retea mobila instabila).
// ===============================================================================================
// ACESTE ASERTIUNI TREBUIE SA ESUEZE PE CODUL DINAINTE DE FIX. Dupa fix: gate-ul NU mai afirma
// orbeste "4" (nu poate verifica nimic acum -> ramane pe mesajul generic, niciodata un numar
// nesigur), iar comenzile-mele.html NU mai sterge cele 4 intrari VALIDE doar din cauza unei erori
// de retea — cele doua pagini nu mai pot ajunge NICIODATA in contradictie, pentru ca folosesc
// ACEEASI regula: numara/afiseaza STRICT ce serverul CONFIRMA, pastreaza tot ce nu poate verifica.
test('FIX: 4 intrari valide, fetch-urile ESUEAZA prin exceptie de retea -> gate-ul NU afirma un numar nesigur, comenzile-mele.html NU sterge cele 4 intrari valide', async () => {
  const known = [
    { id: 'order-1', token: '1'.repeat(48) },
    { id: 'order-2', token: '2'.repeat(48) },
    { id: 'order-3', token: '3'.repeat(48) },
    { id: 'order-4', token: '4'.repeat(48) }
  ];
  const flakyNetwork = async () => { throw new TypeError('Failed to fetch'); };

  const gateCount = await computeGateCount(known, flakyNetwork);
  assert.equal(gateCount, 0, 'gate-ul nu poate CONFIRMA nicio comanda acum — nu trebuie sa afirme un numar nesigur (ramane pe mesajul generic in UI, nu o cifra falsa)');

  const { api, storage } = buildComenzileMeleSandbox({ storedOrders: known, fetchImpl: flakyNetwork });
  await api.__loadPromise;

  const afterCleanup = JSON.parse(storage.naluna_my_order_keys);
  assert.equal(afterCleanup.length, 4, 'o eroare de retea NU e o confirmare server-side ca o comanda nu mai exista — cele 4 intrari VALIDE trebuie pastrate, nu sterse orbeste');
});

// ===============================================================================================
// REPRODUCERE #2 — 4 chei, DOAR 3 comenzi confirmate valide (a 4-a e CONFIRMATA (404) ca nu mai
// exista) — cerinta explicita Faza 3.D: "Daca exista 4 chei dar doar 3 comenzi valide, UI trebuie
// sa spuna 3 si sa afiseze exact acele 3."
// ===============================================================================================
test('FIX: 4 chei, 1 confirmata inexistenta (404) -> gate-ul spune 3, comenzile-mele.html afiseaza exact 3 carduri, intrarea stearsa e STRICT cea confirmata', async () => {
  const known = [
    { id: 'order-a', token: 'a'.repeat(48) },
    { id: 'order-b', token: 'b'.repeat(48) },
    { id: 'order-c', token: 'c'.repeat(48) },
    { id: 'order-gone', token: 'g'.repeat(48) }
  ];
  const orders = {
    'order-a': order('order-a', { createdAt: '2026-09-01T00:00:00Z' }),
    'order-b': order('order-b', { createdAt: '2026-09-02T00:00:00Z' }),
    'order-c': order('order-c', { createdAt: '2026-09-03T00:00:00Z' })
  };
  const fetchImpl = async (url) => {
    if (url.includes('order-gone')) return { ok: false, status: 404 };
    const id = Object.keys(orders).find((k) => url.includes(k));
    return id ? jsonRes(orders[id]) : { ok: false, status: 404 };
  };

  const gateCount = await computeGateCount(known, fetchImpl);
  assert.equal(gateCount, 3, 'gate-ul trebuie sa spuna EXACT 3, nu 4 — o comanda confirmata inexistenta nu conteaza');

  const { api, elements, storage } = buildComenzileMeleSandbox({ storedOrders: known, fetchImpl });
  await api.__loadPromise;
  const cardCount = elements['orders-list'].children.filter((c) => c.className === 'order').length;
  assert.equal(cardCount, 3, 'comenzile-mele.html trebuie sa afiseze EXACT 3 carduri');

  const afterCleanup = JSON.parse(storage.naluna_my_order_keys).map((e) => e.id).sort();
  assert.deepEqual(afterCleanup, ['order-a', 'order-b', 'order-c'], 'STRICT intrarea confirmata inexistenta trebuie stearsa — celelalte 3 raman neatinse');
});

// ===============================================================================================
// REPRODUCERE #3 — toate cele 4 chei sunt CONFIRMATE (404) ca nu mai exista -> 0 comenzi reale,
// recovery poate aparea (Faza 3.E).
// ===============================================================================================
test('FIX: toate cele 4 chei confirmate inexistente (404) -> gate-ul spune 0 (mesaj generic), comenzile-mele.html arata 0 + recovery, storage golit', async () => {
  const known = ['order-1', 'order-2', 'order-3', 'order-4'].map((id) => ({ id, token: id.repeat(12).slice(0, 48) }));
  const fetchImpl = async () => ({ ok: false, status: 404 });

  const gateCount = await computeGateCount(known, fetchImpl);
  assert.equal(gateCount, 0);

  const { api, elements, storage } = buildComenzileMeleSandbox({ storedOrders: known, fetchImpl });
  await api.__loadPromise;
  const cardCount = elements['orders-list'].children.filter((c) => c.className === 'order').length;
  assert.equal(cardCount, 0);
  assert.equal(JSON.parse(storage.naluna_my_order_keys).length, 0);
  assert.equal(elements['recovery-box'].style.display, '', 'recovery trebuie sa devina vizibil cand chiar nu exista nicio comanda reala');
});

test('control — comenzile CONFIRMATE valide (200, status eligibil) sunt numarate/afisate normal, fara nicio schimbare de comportament', async () => {
  const known = [{ id: 'order-real', token: 'r'.repeat(48) }];
  const fetchImpl = async () => jsonRes(order('order-real'));
  const gateCount = await computeGateCount(known, fetchImpl);
  assert.equal(gateCount, 1);
});
