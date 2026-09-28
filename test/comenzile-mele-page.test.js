// AUDIT + REDESIGN (2026-09-28, cerinta explicita) — "Comenzile mele" trebuie sa fie experienta
// PRINCIPALA: la accesare, lista de comenzi autorizate ale acestui browser (naluna_my_order_keys +
// accessToken, acelasi mecanism deja auditat) e primul lucru vizibil, INAINTE de orice recuperare
// prin email. Fiecare card e acum un rezumat clar si REAL ("Comanda N — Pachet" / "Pentru
// destinatar" / "N melodii"), niciodata inventat, iar click pe card duce la pagina CORECTA pentru
// starea comenzii — auditat direct in cod, NU presupus:
//   - status='ready' (platita)     -> comanda-mea.html?token=  (STRICT pagina care reda/descarca
//     melodiile platite — melodia-mea.html arata DOAR "ai primit deja emailul", fara niciun player,
//     pentru comenzi ready; verificat direct in public/melodia-mea.html, showState('paid-state')).
//   - orice alta stare eligibila   -> melodia-mea.html?id=&token= (neschimbat, gestioneaza deja
//     toate gate-urile Standard/Premium/Video si redirectul propriu catre se-compune.html).
// BUG REAL gasit la audit: GET /api/orders/:orderId (folosit de aceasta pagina) nu expunea deloc
// hasGiftAudio/hasPremiumBonusAudio (doar GET /api/orders/access/:token le expunea) — desi
// renderOrderCard le citea deja, eran mereu undefined => numarul de melodii afisat pentru
// Premium/Video cu bonus era sistematic subestimat. Corectat in server.js, aceeasi logica PURA
// (lib/entitlements.js), acum expusa consecvent pe ambele endpointuri.
// BUG REAL #2 gasit la audit: banner-ul "Ai deja melodii create pentru tine..." (?blocked=1,
// setat de comanda.html la quota 403) era afisat STRICT pe baza parametrului din URL, INAINTE sa
// se stie daca lista reala (asincron) contine ceva — quota e verificata server-side dupa EMAIL,
// nu dupa acest browser, deci un client putea ajunge aici cu banner-ul afirmand fals ca are
// melodii, langa o lista goala. Corectat: decizia se ia STRICT dupa ce eligible.length e cunoscut.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const page = read('public/comenzile-mele.html');
const comanda = read('public/comanda.html');
const server = read('server.js');
const melodiaMea = read('public/melodia-mea.html');
const comandaMea = read('public/comanda-mea.html');
const entitlements = read('lib/entitlements.js');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function lastInlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

test('public/comenzile-mele.html: scriptul inline ramane sintactic valid', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(page)));
});

// ===============================================================================================
// (0) AUDIT — confirmarea directa a paginii CORECTE de reutilizat pentru fiecare stare, in codul
// REAL al melodia-mea.html/comanda-mea.html (nu presupunere).
// ===============================================================================================
test('AUDIT: melodia-mea.html arata STRICT "melodia a fost livrata deja" pentru status=ready, FARA niciun player — confirma ca NU e pagina corecta de reutilizat pentru ascultarea comenzilor platite', () => {
  const idx = melodiaMea.indexOf('<div id="paid-state"');
  const block = melodiaMea.slice(idx, idx + 400);
  assert.ok(!block.includes('<audio'), 'paid-state nu trebuie sa contina niciun player audio');
  assert.match(melodiaMea, /\} else if \(order\.status === 'ready'\) \{\s*\n\s*showState\('paid-state'\);/);
});

test('AUDIT: comanda-mea.html reda EFECTIV melodia (principala + cadou + bonus) pentru status=ready, folosind GET /api/orders/access/:token si accessToken din URL — pagina corecta de reutilizat', () => {
  assert.match(comandaMea, /const urlToken = new URLSearchParams\(window\.location\.search\)\.get\('token'\);/);
  assert.match(comandaMea, /fetch\('\/api\/orders\/access\/' \+ encodeURIComponent\(token\)\)/);
  assert.match(comandaMea, /<audio controls src="\$\{fullUrl\}"><\/audio>/);
  assert.match(comandaMea, /if \(o\.status === 'ready' && !accessExpired && o\.hasGiftAudio\)/);
  assert.match(comandaMea, /if \(o\.status === 'ready' && !accessExpired && o\.hasPremiumBonusAudio\)/);
});

test('AUDIT: comenzile-mele.html NU reimplementeaza un al doilea sistem de redare audio — niciun <audio> real pe aceasta pagina (STRICT mentionat in comentarii de audit), ci STRICT rutare catre pagina corecta (comanda-mea.html/melodia-mea.html)', () => {
  assert.ok(!/<audio\s/.test(page), 'lista de comenzi nu trebuie sa mai contina playere inline (tag real <audio ...>) — click pe card duce la pagina corecta');
});

// ===============================================================================================
// (1) BUG REAL #1 — server.js: GET /api/orders/:orderId acum expune hasGiftAudio/hasPremiumBonusAudio
// (folosind ACEEASI logica pura din lib/entitlements.js), la fel ca GET /api/orders/access/:token.
// ===============================================================================================
test('server.js: GET /api/orders/:orderId expune ACUM hasGiftAudio/hasPremiumBonusAudio (bug real corectat — inainte lipseau complet din acest endpoint, desi comenzile-mele.html le citea deja)', () => {
  const idx = server.indexOf("app.get('/api/orders/:orderId', async (req, res, next) => {");
  const end = server.indexOf("app.post('/api/orders/:orderId/checkout'", idx);
  const body = server.slice(idx, end);
  assert.match(body, /const giftVariantForCount = getGiftVariant\(order\);/);
  assert.match(body, /const premiumBonusVariantForCount = getPremiumBonusVariant\(order\);/);
  assert.match(body, /hasGiftAudio: !!\(giftVariantForCount && giftVariantForCount\.fullKey\),/);
  assert.match(body, /hasPremiumBonusAudio: !!\(premiumBonusVariantForCount && premiumBonusVariantForCount\.fullKey\),/);
});

test('server.js: hasGiftAudio/hasPremiumBonusAudio din /api/orders/:orderId folosesc EXACT aceeasi sursa pura (lib/entitlements.js) ca /api/orders/access/:token — nicio regula noua/duplicata', () => {
  assert.match(server, /const \{ getGiftVariant, getPremiumBonusVariant \} = require\('\.\/lib\/entitlements'\);/);
  assert.match(entitlements, /module\.exports = \{ getGiftVariant, pickPremiumBonusVariantId, getPremiumBonusVariant \};/);
});

test('node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

// ===============================================================================================
// (2) Securitate/model de acces — neschimbat, reverificat dupa redesign.
// ===============================================================================================
test('comenzile-mele.html: NU exista niciun endpoint email->comenzi — foloseste STRICT GET /api/orders/:id?token= per comanda cunoscuta local/din URL, acelasi mecanism deja auditat', () => {
  assert.ok(!/email=/.test(page.replace(/recovery-email|email@|type="email"|body: JSON\.stringify\(\{ email, lang \}\)/g, '')), 'nicio interogare de tip email=... in afara campului de recuperare deja aprobat');
  assert.match(page, /fetch\(`\/api\/orders\/\$\{encodeURIComponent\(entry\.id\)\}\?token=\$\{encodeURIComponent\(entry\.token\)\}`\)/);
});

test('comenzile-mele.html: accepta ?token= (un singur link) SAU ?tokens=a,b,c (mai multe, din emailul de recuperare) si le rezolva prin GET /api/orders/access/:token (validare server-side reala, nu presupunere din URL)', () => {
  assert.match(page, /params\.get\('token'\)/);
  assert.match(page, /params\.get\('tokens'\)/);
  assert.match(page, /fetch\('\/api\/orders\/access\/' \+ encodeURIComponent\(token\)\)/);
});

test('comenzile-mele.html: dupa rezolvarea token-urilor din URL, acestea sunt sterse din URL (history.replaceState) — nu raman in istoric/referrer mai mult decat necesar', () => {
  assert.match(page, /clean\.searchParams\.delete\('token'\)/);
  assert.match(page, /clean\.searchParams\.delete\('tokens'\)/);
  assert.match(page, /window\.history\.replaceState\(null, '', clean\.toString\(\)\)/);
});

test('comenzile-mele.html: o comanda CONFIRMATA inexistenta (404/400 — expirata/token gresit) e scoasa din lista locala; o eroare de retea/server (necunoscuta) NU e tratata ca "moarta" si NU sterge intrarea', () => {
  assert.match(page, /if \(res\.status === 404 \|\| res\.status === 400\) return \{ entry, state: 'gone' \};/);
  assert.match(page, /goneIds = new Set\(results\.filter\(\(r\) => r\.state === 'gone'\)\.map\(\(r\) => r\.entry\.id\)\)/);
  assert.match(page, /known = known\.filter\(\(entry\) => !goneIds\.has\(entry\.id\)\)/);
});

test('comenzile-mele.html: exclude draft/generation_failed din afisare (acelasi filtru ca recovery email/quota — nimic de continuat/diferentiat)', () => {
  assert.match(page, /r\.order\.status !== 'draft' && r\.order\.status !== 'generation_failed'/);
});

test('comenzile-mele.html: NICIODATA nu afiseaza UUID/accessToken ca TEXT vizibil in continutul cardului (innerHTML) — apar STRICT ca proprietate .href (atribut de navigare), niciodata in innerHTML ca eticheta/continut', () => {
  assert.ok(!/textContent = .*order\.id/.test(page));
  assert.ok(!/textContent = .*token/.test(page));
  // card.innerHTML (sumarul afisat) e construit STRICT din order_label/index/plan/recipient/count/status —
  // niciodata din `token` — verificat structural: singura atribuire de tip innerHTML din renderOrderCard
  // nu contine substringul "token".
  const idx = page.indexOf('function renderOrderCard');
  const end = page.indexOf('function loadAndRenderOrders');
  const body = page.slice(idx, end);
  const innerHtmlAssignment = body.slice(body.indexOf('card.innerHTML = `'), body.indexOf('`;', body.indexOf('card.innerHTML = `')));
  assert.ok(!/token/i.test(innerHtmlAssignment), 'card.innerHTML nu trebuie sa contina niciodata cuvantul "token"');
});

test('comenzile-mele.html: pagina nu apeleaza niciodata NalunaAnalytics/console.* cu token/id-uri de comanda — nicio scurgere posibila catre analytics sau consola', () => {
  assert.ok(!page.includes('NalunaAnalytics'));
  assert.ok(!page.includes('console.'));
});

// ===============================================================================================
// (3) Mesajul de sus — STRUCTURAL: decizia se ia STRICT dupa ce se cunoaste eligible.length,
// niciodata la parsare (bug real corectat, vezi antetul fisierului).
// ===============================================================================================
test('comenzile-mele.html: parametrul ?blocked=1 e STRICT capturat intr-un flag (wasBlocked) la parsare — continutul banner-ului NU mai e scris in DOM decat DUPA ce lista reala (eligible) e cunoscuta', () => {
  assert.match(page, /const wasBlocked = params\.get\('blocked'\) === '1';/);
  // "la parsare" = cod care ruleaza IMEDIAT, in afara oricarei definitii de functie — verificam
  // STRICT segmentul dintre definitia lui wasBlocked si INCEPUTUL primei functii care scrie
  // efectiv in banner (handleNoVisibleOrders/loadAndRenderOrders) — o DEFINITIE de functie
  // (function ... { ... }) nu executa nimic la parsare, doar apelarea ei mai tarziu conteaza.
  const wasBlockedIdx = page.indexOf("const wasBlocked = params.get('blocked') === '1';");
  const firstWriterIdx = page.indexOf('function handleNoVisibleOrders');
  assert.ok(wasBlockedIdx !== -1 && firstWriterIdx > wasBlockedIdx);
  const betweenDefinitionAndFirstWriter = page.slice(wasBlockedIdx, firstWriterIdx);
  assert.ok(!/banner\.textContent = t\.blocked/.test(betweenDefinitionAndFirstWriter.replace(/\/\/.*$/gm, '')), 'niciun banner.textContent asignat la parsare, in afara unei functii — DOAR in interiorul handleNoVisibleOrders/loadAndRenderOrders, apelate STRICT dupa rezolvarea listei reale');
});

test('comenzile-mele.html: banner-ul foloseste t.blocked STRICT cand exista comenzi eligibile reale (dupa if (eligible.length === 0) ... return), si t.blocked_empty (mesaj DIFERIT, care NU afirma ca exista melodii) STRICT prin handleNoVisibleOrders() cand lista e goala', () => {
  const eligibleIdx = page.indexOf("if (eligible.length === 0)");
  const afterEligible = page.slice(eligibleIdx, page.indexOf('async function loadAndRenderOrders') === -1 ? page.length : eligibleIdx + 800);
  assert.match(afterEligible, /banner\.textContent = t\.blocked;/, 'banner-ul t.blocked trebuie scris STRICT dupa garda de "eligible.length === 0"');
  assert.match(page, /function handleNoVisibleOrders\(\) \{/);
  const noOrdersBody = page.slice(page.indexOf('function handleNoVisibleOrders'), page.indexOf('async function triggerAutoRecovery'));
  assert.match(noOrdersBody, /banner\.textContent = t\.blocked_empty;/);
});

// ===============================================================================================
// (4) Toate cele 8 limbi.
// ===============================================================================================
function extractTranslationsObject() {
  const idx = page.indexOf('const T = {');
  let depth = 0, i = page.indexOf('{', idx);
  const start = i;
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  const objSrc = page.slice(idx, i + 1);
  return new Function(objSrc + '\nreturn T;')();
}
const T = extractTranslationsObject();

for (const lang of ALLOWED_LANGS) {
  test(`comenzile-mele.html: limba ${lang} are toate cheile obligatorii noi (order_label/song_count/blocked_empty) plus cele existente`, () => {
    assert.ok(T[lang], `bloc de traduceri lipsa pentru ${lang}`);
    for (const key of ['title', 'order_label', 'blocked', 'blocked_empty', 'continue_btn', 'status_progress', 'status_ready', 'recovery_btn', 'recovery_sent', 'auto_recovery_sent', 'use_other_email', 'empty_no_orders']) {
      assert.ok(typeof T[lang][key] !== 'undefined', `[${lang}] cheia lipsa: ${key}`);
    }
    assert.equal(typeof T[lang].song_count, 'function', `[${lang}] song_count trebuie sa fie o functie (n) => string`);
    assert.ok(T[lang].plan && T[lang].plan.standard && T[lang].plan.premium && T[lang].plan.video, `[${lang}] plan.standard/premium/video lipsesc`);
  });

  test(`comenzile-mele.html: limba ${lang} — song_count(1) si song_count(2) produc text valid si nevid (majoritatea limbilor distincte la plural; turca foloseste aceeasi forma, cerinta lingvistica reala, nu un bug)`, () => {
    const s1 = T[lang].song_count(1);
    const s2 = T[lang].song_count(2);
    assert.ok(s1.includes('1'), `[${lang}] song_count(1) trebuie sa contina numarul`);
    assert.ok(s2.includes('2'), `[${lang}] song_count(2) trebuie sa contina numarul`);
    if (lang !== 'tr') assert.notEqual(s1.replace(/1/, ''), s2.replace(/2/, ''), `[${lang}] forma singular/plural trebuie sa difere`);
  });
}

test('comenzile-mele.html: toate cele 8 traduceri ale "blocked" si "blocked_empty" sunt distincte intre ele (per limba) si nu contin nicio cifra — si "blocked_empty" nu afirma ca exista melodii', () => {
  ALLOWED_LANGS.forEach((lang) => {
    const blocked = T[lang].blocked;
    const blockedEmpty = T[lang].blocked_empty;
    assert.ok(!/\d/.test(blocked), `[${lang}] "blocked" nu trebuie sa contina nicio cifra`);
    assert.ok(!/\d/.test(blockedEmpty), `[${lang}] "blocked_empty" nu trebuie sa contina nicio cifra`);
    assert.notEqual(blocked, blockedEmpty, `[${lang}] "blocked" si "blocked_empty" trebuie sa fie mesaje distincte`);
  });
  const blockedValues = ALLOWED_LANGS.map((lang) => T[lang].blocked);
  assert.equal(new Set(blockedValues).size, ALLOWED_LANGS.length, 'toate cele 8 traduceri "blocked" trebuie sa fie distincte');
  const blockedEmptyValues = ALLOWED_LANGS.map((lang) => T[lang].blocked_empty);
  assert.equal(new Set(blockedEmptyValues).size, ALLOWED_LANGS.length, 'toate cele 8 traduceri "blocked_empty" trebuie sa fie distincte');
});

// ===============================================================================================
// (5) COMPORTAMENT REAL, sandbox — extragem intreg IIFE-ul (acelasi tipar deja folosit) si il
// executam cu document/localStorage/fetch minimale, dar suficient de fidele pentru a exercita
// REAL functiile: realSongCount, continueUrlFor, renderOrderCard, loadAndRenderOrders.
// ===============================================================================================
function buildSandbox({ search = '', storedOrders, fetchImpl } = {}) {
  const script = lastInlineScript(page);
  const bodyStart = script.indexOf('(function () {') + '(function () {'.length;
  const bodyEnd = script.lastIndexOf('})();');
  const body = script.slice(bodyStart, bodyEnd);
  // Fisierul real invoca loadAndRenderOrders() O SINGURA DATA, la incarcare (fara sa expuna
  // promisiunea rezultata). Pentru teste, capturam ACEEASI invocare unica (nu una suplimentara —
  // ar dubla cardurile randate in mock-urile persistente de mai jos) — STRICT text-replace in
  // COPIA folosita de test, niciodata in fisierul real.
  const marker = 'loadAndRenderOrders().catch(() => {';
  if (!body.includes(marker)) throw new Error('marker de instrumentare negasit — pagina reala s-a schimbat?');
  const instrumentedBody = body.replace(marker, 'window.__test_loadPromise = ' + marker);
  const harness = `
    ${instrumentedBody}
    window.__test_api = { renderOrderCard, t, realSongCount, continueUrlFor, loadAndRenderOrders, __loadPromise: window.__test_loadPromise };
  `;

  function escapeForMock(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function makeEl() {
    const listeners = {};
    return {
      style: {}, dataset: {}, children: [], href: '',
      set textContent(v) { this._text = v; this._html = escapeForMock(v); },
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
  const ids = ['h1-title', 'p-sub', 'loading-msg', 'recovery-title', 'recovery-sub', 'recovery-email', 'recovery-btn', 'blocked-banner', 'orders-list', 'recovery-box', 'recovery-result'];
  for (const id of ids) elements[id] = makeEl();
  // Starea initiala reala a paginii (vezi markup-ul static): blocked-banner/recovery-box pornesc
  // ascunse (style="display:none;" in HTML) — scriptul le dezvaluie explicit, nu mock-ul.
  elements['blocked-banner'].style.display = 'none';
  elements['recovery-box'].style.display = 'none';
  const documentMock = {
    documentElement: { lang: '' },
    getElementById: (id) => elements[id] || makeEl(),
    createElement: () => makeEl()
  };
  const windowMock = {
    location: { search, href: 'https://nalunastudio.com/comenzile-mele.html' + search },
    history: { replaceState: () => {} }
  };
  const storage = {};
  if (storedOrders !== undefined) storage.naluna_my_order_keys = JSON.stringify(storedOrders);
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  const fetchCalls = [];
  const fetchMock = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl ? fetchImpl(url, opts) : { ok: false };
  };
  const fn = new Function('document', 'window', 'localStorage', 'navigator', 'URLSearchParams', 'fetch', 'history',
    harness + '\nreturn window.__test_api;'
  );
  const api = fn(documentMock, windowMock, localStorageMock, { language: 'en' }, URLSearchParams, fetchMock, { replaceState: () => {} });
  return { api, elements, fetchCalls };
}

function jsonRes(obj) {
  return { ok: true, json: async () => obj };
}

test('sandbox (1 comanda autorizata): browser cu exact O comanda cunoscuta local afiseaza direct 1 card, cu numarul real de melodii si ruta corecta', async () => {
  const token = 'a'.repeat(48);
  const { api, elements, fetchCalls } = buildSandbox({
    storedOrders: [{ id: 'order-1', token }],
    fetchImpl: (url) => {
      if (url.includes('/api/orders/order-1?token=')) {
        return jsonRes({ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false });
      }
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.length, 1, 'trebuie afisat exact un card');
  const card = elements['orders-list'].children[0];
  assert.match(card.innerHTML, /Comandă 1 — Standard|Order 1 — Standard/i);
  assert.match(card.innerHTML, /Pentru Maria|For Maria/i);
  assert.match(card.innerHTML, /1 (melodie|song)/i);
  assert.equal(card.href, `/comanda-mea.html?token=${encodeURIComponent(token)}`, 'comanda ready trebuie sa duca la comanda-mea.html (pagina care CHIAR reda melodia)');
  assert.equal(elements['recovery-box'].style.display, '', 'recovery ramane vizibil (secundar), niciodata ascuns complet');
});

test('sandbox (mai multe comenzi Standard/Premium/Video): numerotare coerenta 1..3, fiecare card cu propriul plan/destinatar/numar real de melodii, fara amestec intre comenzi', async () => {
  const tokS = 's'.repeat(48), tokP = 'b'.repeat(48), tokV = 'c'.repeat(48);
  const orders = {
    'order-standard': { id: 'order-standard', plan: 'standard', recipient: 'Ion', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false },
    'order-premium': { id: 'order-premium', plan: 'premium', recipient: 'Elena', status: 'ready', createdAt: '2026-09-02T00:00:00Z', hasGiftAudio: true, hasPremiumBonusAudio: true, hostedAccessExpired: false },
    'order-video': { id: 'order-video', plan: 'video', recipient: 'Andrei', status: 'preview_ready', createdAt: '2026-09-03T00:00:00Z', variants: [{ previewUrl: 'https://cdn/x1.mp3' }, { previewUrl: 'https://cdn/x2.mp3' }] }
  };
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-standard', token: tokS }, { id: 'order-premium', token: tokP }, { id: 'order-video', token: tokV }],
    fetchImpl: (url) => {
      const match = Object.keys(orders).find((id) => url.includes(`/api/orders/${id}?token=`));
      return match ? jsonRes(orders[match]) : { ok: false };
    }
  });
  await api.__loadPromise;
  const cards = elements['orders-list'].children;
  assert.equal(cards.length, 3);

  assert.match(cards[0].innerHTML, /1 — Standard/);
  assert.match(cards[0].innerHTML, /Ion/);
  assert.match(cards[0].innerHTML, /1 (melodie|song)\b/i);
  assert.equal(cards[0].href, `/comanda-mea.html?token=${encodeURIComponent(tokS)}`);

  assert.match(cards[1].innerHTML, /2 — Premium/);
  assert.match(cards[1].innerHTML, /Elena/);
  assert.match(cards[1].innerHTML, /3 (melodii|songs)/i, 'Premium cu gift+bonus = 1 principala + 2 = 3 melodii REALE');
  assert.equal(cards[1].href, `/comanda-mea.html?token=${encodeURIComponent(tokP)}`);
  assert.ok(!cards[1].innerHTML.includes('Ion') && !cards[1].innerHTML.includes('Andrei'), 'cardul Premium nu trebuie sa amestece date din alte comenzi');

  assert.match(cards[2].innerHTML, /3 — (Video gift|Cadou video)/);
  assert.match(cards[2].innerHTML, /Andrei/);
  assert.match(cards[2].innerHTML, /2 (melodii|songs)/i, 'Video inca neplatit, 2 previzualizari reale disponibile');
  assert.equal(cards[2].href, `/melodia-mea.html?id=order-video&token=${encodeURIComponent(tokV)}`, 'comanda inca neplatita duce la melodia-mea.html (gestioneaza deja preview/editare/checkout)');
});

test('sandbox (numarul real de variante audio): realSongCount() calculeaza STRICT din campurile reale primite — niciodata inventat', () => {
  const { api } = buildSandbox({});
  assert.equal(api.realSongCount({ status: 'ready', hasGiftAudio: false, hasPremiumBonusAudio: false }), 1);
  assert.equal(api.realSongCount({ status: 'ready', hasGiftAudio: true, hasPremiumBonusAudio: false }), 2);
  assert.equal(api.realSongCount({ status: 'ready', hasGiftAudio: true, hasPremiumBonusAudio: true }), 3);
  assert.equal(api.realSongCount({ status: 'preview_ready', variants: [{ previewUrl: 'a' }, { previewUrl: 'b' }] }), 2);
  assert.equal(api.realSongCount({ status: 'preview_ready', variants: [{ previewUrl: 'a' }, {}] }), 1, 'o varianta fara previewUrl real nu conteaza');
  assert.equal(api.realSongCount({ status: 'generating', variants: [] }), 0);
  assert.equal(api.realSongCount({ status: 'generating' }), 0, 'fara camp variants deloc — 0, niciodata o eroare');
});

test('sandbox (click pe comanda -> acces la variantele audio): continueUrlFor() ruteaza STRICT catre comanda-mea.html pentru status=ready, si melodia-mea.html?id=&token= pentru orice alta stare eligibila', () => {
  const { api } = buildSandbox({});
  const token = 'f'.repeat(48);
  assert.equal(api.continueUrlFor({ id: 'x', status: 'ready' }, token), `/comanda-mea.html?token=${encodeURIComponent(token)}`);
  for (const status of ['preview_ready', 'generating', 'processing_provider_result']) {
    assert.equal(api.continueUrlFor({ id: 'order-x', status }, token), `/melodia-mea.html?id=order-x&token=${encodeURIComponent(token)}`);
  }
});

test('sandbox (browser fara tokenuri, ex. Incognito nou): NU se face niciun fetch catre server pentru orders, NU se afiseaza niciun card de comanda inventat — STRICT mesajul "nicio comanda" + recovery vizibil', async () => {
  const { api, elements, fetchCalls } = buildSandbox({ storedOrders: [] });
  await api.__loadPromise;
  assert.equal(fetchCalls.length, 0, 'un browser fara tokenuri nu trebuie sa apeleze deloc serverul pentru orders');
  const cardCount = elements['orders-list'].children.filter((c) => c.className === 'order').length;
  assert.equal(cardCount, 0, 'niciun card de comanda inventat');
  assert.equal(elements['recovery-box'].style.display, '', 'recovery trebuie sa fie STRICT optiunea disponibila');
  assert.equal(elements['blocked-banner'].style.display, 'none', 'niciun banner fals cand nu exista niciun context de blocare');
});

test('sandbox (mesaj corect, browser fara tokenuri + ajuns aici din quota/?blocked=1): banner-ul foloseste STRICT blocked_empty (NU afirma ca exista melodii in acest browser)', async () => {
  const { api, elements } = buildSandbox({ search: '?blocked=1', storedOrders: [] });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].style.display, '');
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked_empty);
  assert.notEqual(elements['blocked-banner'].textContent, api.t.blocked);
});

test('sandbox (mesaj corect, comenzi cunoscute dar toate draft/invalide + ?blocked=1): lista eligibila e goala => banner-ul ramane blocked_empty, niciodata "ai deja melodii"', async () => {
  const token = 'd'.repeat(48);
  const { api, elements } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [{ id: 'order-draft', token }],
    fetchImpl: (url) => (url.includes('order-draft') ? jsonRes({ id: 'order-draft', status: 'draft', createdAt: '2026-09-01T00:00:00Z' }) : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked_empty);
  const cardCount = elements['orders-list'].children.filter((c) => c.className === 'order').length;
  assert.equal(cardCount, 0, 'o comanda draft nu trebuie sa apara ca un card de comanda (poate exista un mesaj "nicio comanda gasita", nu un card)');
});

test('sandbox (banner corect cand exista REAL comenzi + ?blocked=1): foloseste t.blocked (mesajul original), confirmand ca mecanismul functioneaza cand starea e REAL adevarata', async () => {
  const token = 'e'.repeat(48);
  const { api, elements } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [{ id: 'order-real', token }],
    fetchImpl: (url) => (url.includes('order-real') ? jsonRes({ id: 'order-real', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z' }) : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked);
  assert.equal(elements['orders-list'].children.length, 1);
});

test('sandbox (recovery prin email ramane functional si securizat): trimite STRICT {email, lang} catre /api/orders/recover-access, niciodata id-uri/tokenuri locale — si arata ACELASI mesaj generic indiferent de raspunsul serverului (nicio enumerare de conturi)', async () => {
  const { api, elements, fetchCalls } = buildSandbox({ storedOrders: [] });
  await api.__loadPromise;
  elements['recovery-email'].value = 'client@exemplu.com';
  await elements['recovery-btn'].__listeners.click();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/orders/recover-access');
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.equal(fetchCalls[0].opts.body, JSON.stringify({ email: 'client@exemplu.com', lang: 'en' }));
  assert.ok(!fetchCalls[0].opts.body.includes('naluna_my_order_keys'));
  assert.equal(elements['recovery-result'].textContent, api.t.recovery_sent);
});

test('sandbox (recovery ramane securizat chiar daca serverul esueaza/e lent): mesajul afisat clientului e IDENTIC (generic), niciodata o eroare care ar confirma/infirma existenta contului', async () => {
  const { api, elements } = buildSandbox({ storedOrders: [], fetchImpl: () => { throw new Error('retea cazuta'); } });
  await api.__loadPromise;
  elements['recovery-email'].value = 'oricine@exemplu.com';
  await elements['recovery-btn'].__listeners.click();
  assert.equal(elements['recovery-result'].textContent, api.t.recovery_sent, 'mesajul trebuie sa ramana generic chiar si la eroare de retea');
});

test('sandbox: acces expirat (hostedAccessExpired) — numarul real de melodii ramane afisat (fapt istoric real), dar fara pill-ul de status "Gata" (comportament pastrat neschimbat)', async () => {
  const token = 'g'.repeat(48);
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-expired', token }],
    fetchImpl: (url) => (url.includes('order-expired') ? jsonRes({ id: 'order-expired', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hostedAccessExpired: true, hasGiftAudio: false, hasPremiumBonusAudio: false }) : { ok: false })
  });
  await api.__loadPromise;
  const card = elements['orders-list'].children[0];
  assert.match(card.innerHTML, /1 (melodie|song)\b/i);
  assert.ok(!card.innerHTML.includes('status-ready'), 'nu trebuie afisat pill-ul de status cand accesul gazduit a expirat');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
