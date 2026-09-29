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
  // "Continua cu aceasta comanda" (2026-09-28) — urlToken citeste acum dintr-un urlParams comun
  // (impreuna cu urlId, optional, pentru resumeUrl) — acelasi token din URL, acelasi comportament
  // pentru linkul real din email (fara ?id=).
  assert.match(comandaMea, /const urlToken = urlParams\.get\('token'\);/);
  assert.match(comandaMea, /fetch\('\/api\/orders\/access\/' \+ encodeURIComponent\(token\) \+ idSuffix\)/);
  assert.match(comandaMea, /<audio controls src="\$\{fullUrl\}"><\/audio>/);
  assert.match(comandaMea, /if \(o\.status === 'ready' && !accessExpired && o\.hasGiftAudio\)/);
  assert.match(comandaMea, /if \(o\.status === 'ready' && !accessExpired && o\.hasPremiumBonusAudio\)/);
});

// UX SIMPLIFICAT (2026-09-30, cerinta explicita dupa testul real in productie): NICIUN card de pe
// aceasta pagina (nici cel clicabil cu token local, nici cel gasit prin email) nu mai reda playere
// audio inline — STRICT sumar + rutare catre pagina corecta (unde ascultarea REALA se intampla).
test('AUDIT: renderOrderCard (cardul CLICKABIL, cu token local, acces complet) NU reimplementeaza un al doilea sistem de redare audio — STRICT rutare catre pagina corecta', () => {
  const idx = page.indexOf('function renderOrderCard(order, index, continueUrl) {');
  const end = page.indexOf('function renderReadOnlyOrderCard');
  const body = page.slice(idx, end);
  assert.ok(!/<audio\s/.test(body), 'cardul clickabil (acces complet) nu trebuie sa contina playere inline — click duce la pagina corecta');
});

test('AUDIT: renderReadOnlyOrderCard (comanda gasita prin email fara token) NU mai reda playere audio inline — STRICT sumar + buton de continuare, niciodata /media/full, /media/wav, /media/video sau /media/preview', () => {
  const idx = page.indexOf('function renderReadOnlyOrderCard');
  const end = page.indexOf('function handleNoVisibleOrders');
  const body = page.slice(idx, end);
  assert.ok(!/<audio\s/.test(body), 'cardul view/listen nu mai trebuie sa contina playere inline — ascultarea reala se intampla dupa Continua cu aceasta comanda, pe pagina de destinatie');
  assert.ok(!/\/media\/full|\/media\/wav|\/media\/video|\/media\/preview/.test(body), 'view/listen mode nu trebuie sa acceseze niciun continut media direct pe aceasta pagina');
  // "Continua cu aceasta comanda" (2026-09-28) — cardul ramane STRICT un <div> necliclabil (nu
  // primeste niciodata un href static/continueUrl) — navigarea reala (window.location.href) se
  // intampla STRICT in interiorul handler-ului de click al butonului, STRICT dupa ce serverul a
  // confirmat explicit (POST /resume-by-email, canResume:true) — nu e echivalenta cu un link static
  // cu autoritate completa, gata clicabil imediat, cum interzicea testul original.
  assert.ok(!/card\.href\s*=/.test(body), 'cardul view/listen nu trebuie sa primeasca niciodata un href static (continueUrl/acces complet)');
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
    for (const key of ['title', 'order_label', 'blocked', 'blocked_empty', 'continue_btn', 'status_progress', 'status_ready', 'recovery_btn', 'recovery_searching', 'recovery_no_orders_for_email', 'recovery_email_fallback_btn', 'recovery_sent', 'use_other_email', 'empty_no_orders']) {
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

// TEST 6 (cerinta explicita) — toate cele 8 limbi: recovery_btn (reutilizat pentru CTA-ul negru
// nou) exista si e nevid (deja verificat mai sus, in lista de chei obligatorii); recovery_sub NU
// mai afirma ca emailul arata melodiile "direct" — vechiul buton instant a fost eliminat, STRICT
// "Trimite-mi link pe email" (fallback) mai ramane in acea sectiune.
for (const lang of ALLOWED_LANGS) {
  test(`TEST 6: comenzile-mele.html: limba ${lang} — recovery_sub descrie corect recuperarea prin LINK pe email (nu mai afirma "direct"/"imediat", odata ce butonul instant a fost eliminat)`, () => {
    assert.ok(T[lang].recovery_sub && T[lang].recovery_sub.trim().length > 0, `[${lang}] recovery_sub lipseste/gol`);
    assert.ok(!/direct|immediately|directement|direkt|directamente|subito|hemen|директно/i.test(T[lang].recovery_sub), `[${lang}] recovery_sub nu mai trebuie sa afirme ca melodiile apar "direct" — acel buton a fost eliminat`);
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
// Simuleaza STRICT semantica reala a stivei de istoric a browserului (push trunchiaza orice
// "inainte" existent la pozitia curenta, exact ca la un click nou de link; back muta STRICT
// pointerul, fara sa trunchieze nimic) — folosita pentru testele "Continue -> Back -> Continue"
// care trebuie sa dovedeasca exact unde ajunge un Back REAL dupa mai multe cicluri.
function makeSharedHistory(initialUrl) {
  const stack = [{ url: initialUrl, state: null }];
  let pos = 0;
  return {
    current: () => stack[pos],
    pushState(state, url) { stack.length = pos + 1; stack.push({ url, state }); pos = stack.length - 1; },
    replaceState(state, url) { stack[pos] = { url, state }; },
    navigateTo(url) { stack.length = pos + 1; stack.push({ url, state: null }); pos = stack.length - 1; },
    back() { if (pos > 0) pos -= 1; return stack[pos]; },
    depth: () => stack.length,
    position: () => pos
  };
}

function buildSandbox({ search = '', storedOrders, fetchImpl, pendingRecoveryEmail, sharedHistory } = {}) {
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
      set innerHTML(v) { this._html = v; this.children = []; },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(evt, fn) { listeners[evt] = fn; },
      __listeners: listeners,
      setAttribute() {},
      scrollIntoView() {},
      focus() { this.__focused = true; },
      set value(v) { this._value = v; },
      get value() { return this._value || ''; }
    };
  }
  const elements = {};
  const ids = ['h1-title', 'p-sub', 'loading-msg', 'recovery-title', 'recovery-sub', 'recovery-email', 'blocked-cta-btn', 'recovery-email-fallback-btn', 'blocked-banner', 'orders-list', 'recovery-box', 'recovery-result', 'create-new-cta-wrap', 'create-new-cta-btn'];
  for (const id of ids) elements[id] = makeEl();
  // Starea initiala reala a paginii (vezi markup-ul static): blocked-banner/recovery-box pornesc
  // ascunse (style="display:none;" in HTML) — scriptul le dezvaluie explicit, nu mock-ul.
  elements['blocked-banner'].style.display = 'none';
  elements['blocked-cta-btn'].style.display = 'none';
  elements['recovery-box'].style.display = 'none';
  elements['create-new-cta-wrap'].style.display = 'none';
  const documentMock = {
    documentElement: { lang: '' },
    getElementById: (id) => elements[id] || makeEl(),
    createElement: () => makeEl(),
    // STRICT suficient pentru selectorul real folosit de pagina (.continue-cta-btn, pentru fixul
    // de bfcache) — cauta recursiv in cardurile deja randate (orders-list), nu un motor de
    // selectori complet.
    querySelectorAll: (selector) => {
      const results = [];
      function walk(node) {
        if (!node) return;
        if (selector === '.' + node.className) results.push(node);
        (node.children || []).forEach(walk);
      }
      walk(elements['orders-list']);
      return results;
    }
  };
  const windowListeners = {};
  const pushStateCalls = [];
  // sharedHistory (optional) — simuleaza un STIVA reala de istoric de browser, persistenta intre
  // mai multe instante buildSandbox() succesive (fiecare instanta = o "incarcare" separata a
  // paginii, exact ca o reincarcare reala/bfcache dupa un Back) — necesar STRICT pentru testele
  // care verifica secvente reale Continue -> Back -> Continue -> Back (garda anti-history-trap).
  // Fara el (implicit), fiecare test ramane izolat, cu propriul history.state local, ca pana acum.
  const historyMock = sharedHistory ? {
    get state() { return sharedHistory.current().state; },
    replaceState: (state, _t, url) => sharedHistory.replaceState(state, url),
    pushState: (state, _t, url) => { pushStateCalls.push([state, _t, url]); sharedHistory.pushState(state, url); }
  } : {
    state: null,
    replaceState: () => {},
    pushState: (...args) => { pushStateCalls.push(args); historyMockSelf.state = args[0]; }
  };
  const historyMockSelf = historyMock;
  const windowMock = {
    location: { search, href: (sharedHistory ? sharedHistory.current().url : 'https://nalunastudio.com/comenzile-mele.html' + search) },
    history: historyMock,
    addEventListener: (evt, fn) => { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }
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
  // PROBLEMA 1/2 (2026-09-30) — pendingRecoveryEmail (gate "Comenzile mele" SAU blocare quota)
  // e citit STRICT din sessionStorage, o singura data, si sters imediat — simulat aici explicit
  // ca sa putem exercita REAL calea "emailul e sursa de adevar" din loadAndRenderOrders().
  const sessionStorageBacking = pendingRecoveryEmail !== undefined ? { naluna_pending_recovery_email: pendingRecoveryEmail } : {};
  const sessionStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStorageBacking, k) ? sessionStorageBacking[k] : null),
    removeItem: (k) => { delete sessionStorageBacking[k]; }
  };
  const fn = new Function('document', 'window', 'localStorage', 'sessionStorage', 'navigator', 'URLSearchParams', 'fetch', 'history',
    harness + '\nreturn window.__test_api;'
  );
  const api = fn(documentMock, windowMock, localStorageMock, sessionStorageMock, { language: 'en' }, URLSearchParams, fetchMock, { replaceState: () => {} });
  return { api, elements, fetchCalls, windowListeners, windowMock, pushStateCalls };
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

// ===================================================================================================
// PROBLEMA 1/2 (2026-09-30, "Comenzile mele goala desi quota stie ca exista melodii" +
// "quota block trebuie sa duca direct la melodiile existente" — decizie explicita de produs):
// emailul (din gate SAU din blocarea quota, transmis STRICT prin sessionStorage) e acum o a DOUA
// sursa de adevar, combinata cu tokenurile locale — NICIODATA exclusiva, NICIODATA ignorata.
// ===================================================================================================
test('PROBLEMA 1: email cu comenzi eligibile, browser FARA niciun token local (naluna_my_order_keys absent) -> comenzile apar oricum, DIRECT, fara niciun link din email, STRICT sumar + buton de continuare (fara accessToken/continueUrl/playere)', async () => {
  const { api, elements, fetchCalls } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email'
      ? jsonRes({ orders: [
        { id: 'o1', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, previewVariantIds: ['v1'] },
        { id: 'o2', plan: 'premium', recipient: 'Ion', status: 'preview_ready', createdAt: '2026-09-02T00:00:00Z', songCount: 2, hostedAccessExpired: false, previewVariantIds: ['v2a', 'v2b'] },
        { id: 'o3', plan: 'video', recipient: 'Elena', status: 'ready', createdAt: '2026-09-03T00:00:00Z', songCount: 2, hostedAccessExpired: false, previewVariantIds: [] }
      ] })
      : { ok: false })
  });
  await api.__loadPromise;
  const byEmailCalls = fetchCalls.filter((c) => c.url === '/api/orders/by-email');
  assert.equal(byEmailCalls.length, 1);
  assert.equal(byEmailCalls[0].opts.method, 'POST');
  assert.equal(byEmailCalls[0].opts.body, JSON.stringify({ email: 'client@exemplu.com' }));
  const cards = elements['orders-list'].children;
  assert.equal(cards.length, 3, 'toate cele 3 comenzi eligibile trebuie afisate DIRECT, fara niciun link din email');
  cards.forEach((c) => {
    assert.ok(!c.href, 'cardurile view/listen (fara token local) nu trebuie sa fie clicabile — niciun continueUrl/acces complet');
    assert.ok(!c.innerHTML.includes('token='), 'niciun token nu trebuie sa apara in cardul randat');
  });
  cards.forEach((c, i) => {
    assert.ok(!c.innerHTML.includes('<audio'), `cardul ${i} nu mai trebuie sa contina niciun player audio — ascultarea reala se intampla dupa Continua cu aceasta comanda`);
    const btn = c.children.find((child) => child.className === 'continue-cta-btn');
    assert.ok(btn, `cardul ${i} trebuie sa aiba butonul de continuare`);
    assert.equal(btn.textContent, api.t.continue_btn);
  });
});

test('PROBLEMA 2: quota block (?blocked=1) CU email transmis si comenzi eligibile reale -> banner "ai deja melodii" + comenzile afisate DIRECT dedesubt (view/listen mode), niciodata "nu am gasit nicio comanda" langa banner-ul de blocare', async () => {
  const { api, elements } = buildSandbox({
    search: '?blocked=1',
    pendingRecoveryEmail: 'blocat@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email'
      ? jsonRes({ orders: [{ id: 'o1', plan: 'standard', recipient: 'Ana', status: 'ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, previewVariantIds: ['v1'] }] })
      : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked, 'mesajul trebuie sa fie cel de succes ("ai deja melodii"), nu blocked_empty');
  assert.equal(elements['orders-list'].children.length, 1);
  const card = elements['orders-list'].children[0];
  assert.ok(!card.innerHTML.includes('<audio'), 'cardul nu mai trebuie sa contina niciun player audio');
  const btn = card.children.find((c) => c.className === 'continue-cta-btn');
  assert.ok(btn, 'comanda gasita din blocarea quota trebuie sa aiba butonul de continuare');
  assert.ok(!elements['orders-list'].children.some((c) => c.textContent === api.t.empty_no_orders), 'nu trebuie sa apara NICIODATA "nu am gasit nicio comanda" langa comenzi reale afisate');
});

test('PROBLEMA 1/2: email fara comenzi eligibile (cont real, dar 0 comenzi) -> lista goala corecta, NICIODATA un card inventat', async () => {
  const { api, elements } = buildSandbox({
    pendingRecoveryEmail: 'fara-comenzi@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email' ? jsonRes({ orders: [] }) : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.filter((c) => c.className === 'order').length, 0);
});

test('PROBLEMA 1: localStorage stale (toate tokenurile locale CONFIRMATE inexistente, 404) DAR emailul are comenzi eligibile reale -> comenzile tot apar (serverul, dupa email, ramane sursa de adevar, niciodata tokenurile locale)', async () => {
  const staleToken = 'f'.repeat(48);
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-stale', token: staleToken }],
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url.includes('order-stale')) return { ok: false, status: 404 };
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-real', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, previewVariantIds: ['v1'] }] });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.length, 1, 'comanda gasita prin email trebuie afisata, desi tokenul local era stale/inexistent');
  const card = elements['orders-list'].children[0];
  assert.match(card.innerHTML, /Maria/);
  assert.ok(!card.innerHTML.includes('<audio'), 'cardul nu mai trebuie sa contina niciun player audio');
  assert.ok(card.children.find((c) => c.className === 'continue-cta-btn'), 'trebuie sa aiba butonul de continuare, desi tokenul local era stale/inexistent');
  assert.ok(!card.href, 'cardul view/listen nu trebuie sa fie clicabil');
});

test('PROBLEMA 1: aceeasi comanda confirmata ATAT prin token local CAT SI prin email (acelasi id) -> apare O SINGURA DATA, niciodata dublata', async () => {
  const token = 'g'.repeat(48);
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-dup', token }],
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url.includes('order-dup?token=')) return jsonRes({ id: 'order-dup', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false });
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-dup', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, previewVariantIds: ['v1'] }] });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.length, 1, 'aceeasi comanda (acelasi id) nu trebuie sa apara de doua ori');
});

// FALLBACK SECUNDAR (2026-09-30, decizie explicita de produs — "recovery prin email poate ramane
// ca fallback secundar pentru situatii speciale"; ramas STRICT fallback dupa 2026-10-05, cand
// vechiul buton PRIMAR #recovery-btn a fost eliminat din sectiunea de jos — vezi CTA-ul negru
// #blocked-cta-btn, testat separat mai jos): mecanismul VECHI de trimitere pe email, cu
// proprietatea lui de securitate (raspuns generic, anti-enumerare), ramane STRICT pe acest buton.
test('sandbox (fallback: recovery prin email ramane functional si securizat): trimite STRICT {email, lang} catre /api/orders/recover-access, niciodata id-uri/tokenuri locale — si arata ACELASI mesaj generic indiferent de raspunsul serverului (nicio enumerare de conturi)', async () => {
  const { api, elements, fetchCalls } = buildSandbox({ storedOrders: [] });
  await api.__loadPromise;
  elements['recovery-email'].value = 'client@exemplu.com';
  await elements['recovery-email-fallback-btn'].__listeners.click();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/orders/recover-access');
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.equal(fetchCalls[0].opts.body, JSON.stringify({ email: 'client@exemplu.com', lang: 'en' }));
  assert.ok(!fetchCalls[0].opts.body.includes('naluna_my_order_keys'));
  assert.equal(elements['recovery-result'].textContent, api.t.recovery_sent);
});

test('sandbox (fallback: recovery ramane securizat chiar daca serverul esueaza/e lent): mesajul afisat clientului e IDENTIC (generic), niciodata o eroare care ar confirma/infirma existenta contului', async () => {
  const { api, elements } = buildSandbox({ storedOrders: [], fetchImpl: () => { throw new Error('retea cazuta'); } });
  await api.__loadPromise;
  elements['recovery-email'].value = 'oricine@exemplu.com';
  await elements['recovery-email-fallback-btn'].__listeners.click();
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

// ===================================================================================================
// BUG REAL DE PRODUCTIE, RUNDA 2 (2026-09-30) — UX: badge-ul "SE COMPUNE" (status_progress) e
// confuz pe carduri cu melodii deja generate — eliminat COMPLET (nu doar pentru cazul expirat de
// mai sus), pentru orice comanda, indiferent de status. Neinlocuit acum cu alt status.
// ===================================================================================================
test('sandbox: NICIUN card (indiferent de status) nu mai afiseaza vreun badge/pill de status ("Gata"/"Se compune") — eliminat complet, nu doar pentru comenzi expirate', async () => {
  const tok = 'h'.repeat(48);
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-progress', token: tok }],
    fetchImpl: (url) => (url.includes('order-progress')
      ? jsonRes({ id: 'order-progress', plan: 'premium', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 4, hostedAccessExpired: false })
      : { ok: false })
  });
  await api.__loadPromise;
  const card = elements['orders-list'].children[0];
  assert.ok(!card.innerHTML.includes('class="status'), 'niciun pill de status nu mai trebuie afisat pe card');
  assert.ok(!card.innerHTML.includes(api.t.status_progress), '"Se compune" nu mai trebuie afisat, nici macar pentru o comanda inca in preview_ready');
  assert.match(card.innerHTML, /4 (melodii|songs)/i, 'numarul real de melodii ramane afisat');
});

// ===================================================================================================
// CTA NEGRU "VEZI COMENZILE MELE" SUB "AI ATINS LIMITA..." (2026-10-05, cerinta explicita) —
// inlocuieste vechiul buton PRIMAR #recovery-btn (eliminat din sectiunea de jos). Vizibil STRICT
// cand quota tocmai a blocat clientul SI nicio comanda nu a fost gasita automat (blocked_empty),
// niciodata pentru un vizitator neblocat sau cand comenzile apar deja pe ecran.
// ===================================================================================================
test('sandbox: dupa afisarea AUTOMATA a comenzilor (token local confirmat), CTA-ul negru ramane ascuns (nu are legatura cu acest traseu) — fallback-ul de email ramane vizibil/functional', async () => {
  const tok = 'i'.repeat(48);
  const { api, elements } = buildSandbox({
    storedOrders: [{ id: 'order-auto', token: tok }],
    fetchImpl: (url) => (url.includes('order-auto')
      ? jsonRes({ id: 'order-auto', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false })
      : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['orders-list'].children.length, 1);
  assert.equal(elements['blocked-cta-btn'].style.display, 'none', 'CTA-ul negru nu are legatura cu descoperirea automata (STRICT quota block) — ramane ascuns');
  assert.notEqual(elements['recovery-email-fallback-btn'].style.display, 'none', 'fallback-ul de email trebuie sa ramana vizibil/functional');
});

// TEST 3 (cerinta explicita) — vechiul buton "Vezi comenzile mele" din sectiunea de jos NU mai
// exista in markup; CTA-ul negru nou e plasat IMEDIAT dupa #blocked-banner in DOM (inaintea
// oricarui alt element), nu in .recovery-box.
test('TEST 3: markup — #recovery-btn (vechiul buton din "Nu vezi o comanda?") nu mai exista deloc; #blocked-cta-btn exista, e plasat IMEDIAT dupa #blocked-banner, si e in AFARA .recovery-box (nu langa campul de email)', () => {
  assert.ok(!/id="recovery-btn"/.test(page), 'vechiul buton #recovery-btn trebuie eliminat complet din markup');
  assert.match(page, /<div id="blocked-banner"[^>]*><\/div>\s*\n\s*<button type="button" id="blocked-cta-btn"/, 'CTA-ul negru trebuie sa fie STRICT urmatorul element dupa banner, in markup');
  const ctaIdx = page.indexOf('id="blocked-cta-btn"');
  const recoveryBoxIdx = page.indexOf('id="recovery-box"');
  assert.ok(ctaIdx < recoveryBoxIdx, 'CTA-ul negru trebuie sa fie in afara/inaintea .recovery-box, nu langa campul de email');
});

// TEST 7 (cerinta explicita, "mobile layout") — CTA-ul negru foloseste STRICT stilul vizual al
// butoanelor negre principale (button{} generic, aceeasi regula folosita de #create-new-cta-btn/
// .continue-cta-btn), latime completa (acelasi tipar .create-new-cta-btn{width:100%}) — nu clasa
// ghost/secundara din .recovery-box (background:transparent, border, font mai mic).
test('TEST 7: CSS — .blocked-cta-btn e latime completa (width:100%, ca .create-new-cta-btn) si NU e scopat de regula ghost .recovery-box button (elementul e in afara acelui container, vezi TEST 3)', () => {
  assert.match(page, /\.blocked-cta-btn\{\s*width:100%;/, 'CTA-ul negru trebuie sa fie latime completa, ca celelalte CTA-uri principale (mobile-friendly)');
  const recoveryBoxCss = page.slice(page.indexOf('.recovery-box{'), page.indexOf('.recovery-result{'));
  assert.ok(!recoveryBoxCss.includes('blocked-cta-btn'), '.blocked-cta-btn nu trebuie stilat de regulile .recovery-box (ar deveni butonul ghost/secundar, nu CTA-ul negru principal)');
});

// TEST 5 (cerinta explicita) — client FARA quota block nu primeste noul CTA inutil, nici macar
// cand nicio comanda nu e gasita (STAREA A obisnuita, fara ?blocked=1).
test('TEST 5: cand NICIO comanda nu e gasita SI clientul NU a fost blocat de quota (fara ?blocked=1), CTA-ul negru RAMANE ascuns — mesajul obisnuit "nicio comanda" ramane, fara CTA inutil', async () => {
  const { api, elements } = buildSandbox({
    storedOrders: [],
    fetchImpl: (url) => (url === '/api/orders/by-email' ? jsonRes({ orders: [] }) : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-cta-btn'].style.display, 'none', 'fara quota block, CTA-ul negru nu trebuie aratat niciodata');
});

// TEST 1 (cerinta explicita) — quota block -> CTA negru apare IMEDIAT sub mesajul "Ai atins limita...".
test('TEST 1: quota block (?blocked=1) SI nicio comanda gasita automat (blocked_empty) -> CTA-ul negru "Vezi comenzile mele" devine vizibil, imediat sub chenar', async () => {
  const { api, elements } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [],
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email' ? jsonRes({ orders: [] }) : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked_empty);
  assert.notEqual(elements['blocked-banner'].style.display, 'none');
  assert.notEqual(elements['blocked-cta-btn'].style.display, 'none', 'CTA-ul negru trebuie sa devina vizibil imediat sub chenarul "Ai atins limita..."');
  assert.equal(elements['blocked-cta-btn'].textContent, api.t.recovery_btn, 'textul CTA-ului trebuie sa fie "Vezi comenzile mele" (cheia de traducere existenta, refolosita)');
});

// TEST 2 (cerinta explicita) — click -> afiseaza comenzile existente prin fluxul EXISTENT
// (lookupOrdersByEmail -> POST /api/orders/by-email), STRICT cu emailul DEJA cunoscut din
// traseul de blocare quota — clientul NU retasteaza nimic.
test('TEST 2: click pe CTA-ul negru, cu emailul DEJA cunoscut din quota block -> cere STRICT POST /api/orders/by-email cu acel email (niciodata cerut din nou clientului) si afiseaza comenzile gasite, ascunzand apoi CTA-ul redundant', async () => {
  // Prima cerere (automata, la incarcare) nu gaseste nimic -> blocked_empty + CTA vizibil
  // (scenariul EXPLICIT cerut: chenarul apare, apoi CTA-ul). A doua cerere (declansata de click,
  // acelasi email, acelasi mecanism lookupOrdersByEmail) gaseste comanda — situatie reala posibila
  // (eventual consistency / o comanda devenita eligibila intre timp), STRICT ca sa dovedim ca
  // butonul chiar refoloseste fluxul existent, cu rezultatul REAL primit de la server.
  let byEmailCallCount = 0;
  const { api, elements, fetchCalls } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [],
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url !== '/api/orders/by-email') return { ok: false };
      byEmailCallCount++;
      if (byEmailCallCount === 1) return jsonRes({ orders: [] });
      return jsonRes({ orders: [{ id: 'order-manual', plan: 'premium', recipient: 'Ana', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 2, hostedAccessExpired: false, previewVariantIds: [] }] });
    }
  });
  await api.__loadPromise;
  assert.equal(elements['blocked-banner'].textContent, api.t.blocked_empty);
  assert.notEqual(elements['blocked-cta-btn'].style.display, 'none', 'CTA-ul trebuie vizibil dupa chenarul "Ai atins limita..."');
  const callsBefore = fetchCalls.length;
  await elements['blocked-cta-btn'].__listeners.click();
  const byEmailCalls = fetchCalls.slice(callsBefore).filter((c) => c.url === '/api/orders/by-email');
  assert.equal(byEmailCalls.length, 1, 'trebuie sa refoloseasca STRICT ruta existenta /api/orders/by-email');
  assert.equal(byEmailCalls[0].opts.body, JSON.stringify({ email: 'client@exemplu.com' }), 'emailul folosit trebuie sa fie STRICT cel deja cunoscut din quota block, niciodata cerut din nou clientului');
  assert.equal(elements['orders-list'].children.length, 1, 'comanda gasita trebuie afisata prin fluxul existent');
  assert.match(elements['orders-list'].children[0].innerHTML, /Ana/);
  assert.equal(elements['blocked-cta-btn'].style.display, 'none', 'CTA-ul redundant trebuie ascuns odata ce comenzile sunt afisate');
});

test('sandbox: click pe CTA-ul negru, emailul din quota block DAR fara comenzi eligibile -> mesaj clar (recovery_no_orders_for_email), fara card inventat', async () => {
  const { api, elements, fetchCalls } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [],
    pendingRecoveryEmail: 'fara-comenzi@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email' ? jsonRes({ orders: [] }) : { ok: false })
  });
  await api.__loadPromise;
  await elements['blocked-cta-btn'].__listeners.click();
  assert.ok(fetchCalls.some((c) => c.url === '/api/orders/by-email' && c.opts.body === JSON.stringify({ email: 'fara-comenzi@exemplu.com' })));
  assert.equal(elements['orders-list'].children.filter((c) => c.className === 'order').length, 0, 'niciun card de comanda nu trebuie inventat');
  assert.equal(elements['recovery-result'].textContent, api.t.recovery_no_orders_for_email);
});

// Emailul NU mai e cunoscut (sessionStorage deja consumat la o vizita anterioara, sau clientul a
// ajuns aici altfel) — clickul NU cere un email pe care nu il are; STRICT muta focusul catre
// campul de email din sectiunea de recuperare de mai jos, fara niciun fetch nou.
test('sandbox: click pe CTA-ul negru cand emailul NU mai e cunoscut -> NU face niciun fetch, STRICT muta focusul pe campul de email din "Nu vezi o comanda?" (fluxul existent de acolo)', async () => {
  const { api, elements, fetchCalls } = buildSandbox({
    search: '?blocked=1',
    storedOrders: [],
    fetchImpl: () => { throw new Error('niciun fetch nu trebuie declansat fara un email cunoscut'); }
  });
  await api.__loadPromise;
  assert.notEqual(elements['blocked-cta-btn'].style.display, 'none');
  const callsBefore = fetchCalls.length;
  await elements['blocked-cta-btn'].__listeners.click();
  assert.equal(fetchCalls.length, callsBefore, 'niciun fetch nu trebuie declansat cand emailul nu e cunoscut');
  assert.ok(elements['recovery-email'].__focused, 'campul de email trebuie sa primeasca focus, ca sa poata fi folosit fluxul existent ("Trimite-mi link pe email")');
});

// ===================================================================================================
// TEST DE REGRESIE (cerinta #4 — audit event binding) — fiecare card foloseste PROPRIUL orderId si
// email: apasarea butonului unei comenzi NU trebuie sa foloseasca vreodata id-ul/emailul altei
// comenzi (nicio closure/id/dataset partajat gresit, niciun listener atasat doar primului element).
// ===================================================================================================
test('sandbox: 3 comenzi eligibile prin email — apasarea Continue pe FIECARE card cere resume-by-email STRICT cu propriul orderId, niciodata id-ul altei comenzi (fara closure/state partajat)', async () => {
  const { api, elements, fetchCalls } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') {
        return jsonRes({ orders: [
          { id: 'order-A', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true },
          { id: 'order-B', plan: 'premium', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-02T00:00:00Z', songCount: 4, hostedAccessExpired: false, canResume: true },
          { id: 'order-C', plan: 'video', recipient: 'Maria', status: 'ready', createdAt: '2026-09-03T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }
        ] });
      }
      if (url.includes('/resume-by-email')) {
        return jsonRes({ canResume: true, resumeUrl: '/resumed?for=' + url.split('/api/orders/')[1].split('/')[0] });
      }
      return { ok: false };
    }
  });
  await api.__loadPromise;
  const cards = elements['orders-list'].children;
  assert.equal(cards.length, 3);
  const findBtn = (card) => card.children.find((c) => c.className === 'continue-cta-btn');
  for (let i = 0; i < cards.length; i++) {
    assert.ok(findBtn(cards[i]), `cardul ${i} trebuie sa aiba propriul buton de continuare`);
  }
  // Apasam in ordine INVERSA (C, apoi A, apoi B) — anume ca sa dovedim ca nu exista niciun
  // "primul orderId reutilizat" sau stare ramasa de la un click anterior.
  await findBtn(cards[2]).__listeners.click();
  await findBtn(cards[0]).__listeners.click();
  await findBtn(cards[1]).__listeners.click();
  const resumeCalls = fetchCalls.filter((c) => c.url.includes('/resume-by-email'));
  assert.equal(resumeCalls.length, 3);
  assert.equal(resumeCalls[0].url, '/api/orders/order-C/resume-by-email');
  assert.equal(resumeCalls[1].url, '/api/orders/order-A/resume-by-email');
  assert.equal(resumeCalls[2].url, '/api/orders/order-B/resume-by-email');
  resumeCalls.forEach((c) => assert.equal(c.opts.body, JSON.stringify({ email: 'client@exemplu.com' }), 'fiecare cerere trebuie sa foloseasca STRICT acelasi email real, niciodata unul gresit/lipsa'));
});

// ===================================================================================================
// BUG REAL DE PRODUCTIE (2026-09-30, "dupa Back, butonul ramane gri cu 'Se incarca...'") —
// cauza: bfcache restaureaza pagina EXACT cum a fost lasata (buton dezactivat + text de asteptare),
// fara sa re-execute scriptul. Fixul: `pageshow` cu `event.persisted===true` reseteaza butoanele.
// ===================================================================================================
test('sandbox: dupa restaurare din bfcache (pageshow cu persisted:true), un buton de continuare ramas dezactivat/"Se incarca..." e resetat la starea normala', async () => {
  const { api, elements, windowListeners } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email'
      ? jsonRes({ orders: [{ id: 'order-A', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] })
      : { ok: false })
  });
  await api.__loadPromise;
  const card = elements['orders-list'].children[0];
  const btn = card.children.find((c) => c.className === 'continue-cta-btn');
  // Simuleaza STRICT starea inghetata lasata de bfcache dupa un click reusit (navigare in curs,
  // pagina nu se mai reincarca de la zero la Back).
  btn.disabled = true;
  btn.textContent = api.t.loading;
  assert.ok(windowListeners.pageshow && windowListeners.pageshow.length > 0, 'trebuie sa existe un listener pageshow inregistrat');
  windowListeners.pageshow.forEach((fn) => fn({ persisted: true }));
  assert.equal(btn.disabled, false, 'butonul trebuie reactivat dupa restaurarea din bfcache');
  assert.equal(btn.textContent, api.t.continue_btn, 'textul trebuie restaurat la eticheta normala, niciodata ramas pe "Se incarca..."');
});

test('sandbox: secventa REALA Comanda 1 -> Back -> Comanda 2 -> Back -> Comanda 3 -> Back — fiecare restaurare din bfcache reseteaza STRICT butonul ramas dezactivat, fara sa afecteze celelalte', async () => {
  const { api, elements, windowListeners } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email'
      ? jsonRes({ orders: [
        { id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true },
        { id: 'order-2', plan: 'premium', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-02T00:00:00Z', songCount: 4, hostedAccessExpired: false, canResume: true },
        { id: 'order-3', plan: 'video', recipient: 'Maria', status: 'ready', createdAt: '2026-09-03T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }
      ] })
      : { ok: false })
  });
  await api.__loadPromise;
  const cards = elements['orders-list'].children;
  const btns = cards.map((c) => c.children.find((child) => child.className === 'continue-cta-btn'));
  // Continue Comanda 1 -> Back (STRICT butonul 1 ramane dezactivat/incarcare la revenire).
  btns[0].disabled = true; btns[0].textContent = api.t.loading;
  windowListeners.pageshow.forEach((fn) => fn({ persisted: true }));
  assert.equal(btns[0].disabled, false);
  assert.equal(btns[0].textContent, api.t.continue_btn);
  assert.equal(btns[1].disabled, false, 'butonul 2 nu trebuie atins de resetarea butonului 1');
  assert.equal(btns[2].disabled, false, 'butonul 3 nu trebuie atins de resetarea butonului 1');
  // Continue Comanda 2 -> Back.
  btns[1].disabled = true; btns[1].textContent = api.t.loading;
  windowListeners.pageshow.forEach((fn) => fn({ persisted: true }));
  assert.equal(btns[1].disabled, false);
  assert.equal(btns[1].textContent, api.t.continue_btn);
  // Continue Comanda 3 -> Back.
  btns[2].disabled = true; btns[2].textContent = api.t.loading;
  windowListeners.pageshow.forEach((fn) => fn({ persisted: true }));
  assert.equal(btns[2].disabled, false);
  assert.equal(btns[2].textContent, api.t.continue_btn);
  // Toate 3 sunt active la final — "toate butoanele sunt din nou active".
  btns.forEach((b) => assert.equal(b.disabled, false));
});

// ===================================================================================================
// BUG REAL DE PRODUCTIE, PARTEA A 3-A (2026-09-30 -> 2026-10-03, "Back trebuie sa revina la
// Comenzile mele"): incercarea initiala (history.pushState() cu o intrare-ancora, chiar si cu
// garda anti-dublare) rezolva navigarea catre Comenzile mele, DAR introducea ea insasi un history
// trap (Back de doua ori, constant, ca sa se paraseasca efectiv pagina — cerinta explicita: STRICT
// UN SINGUR Back trebuie sa arate Comenzile mele, iar Back-ul urmator trebuie sa paraseasca normal
// pagina). SOLUTIA FINALA: eliminam COMPLET orice manipulare de istoric (pushState/replaceState)
// legata de navigarea catre o comanda — nici comenzile-mele.html, nici melodia-mea.html, nici
// comanda-mea.html, nici amintiri-video.html nu ating window.history in acest scop (verificat
// direct, cautare completa in toate 4 fisierele). Motivul pentru care asta e suficient: click-ul
// pe un card (<a href>) sau navigarea din resumeOrderByEmail (window.location.href=) pornesc
// AMBELE de pe comenzile-mele.html, care e prin definitie varful stivei de istoric in acel moment
// — o navigare noua dintr-o pozitie cu istoric "inainte" (draft/wizard vechi in acelasi tab)
// TRUNCHIAZA acel istoric (semantica standard de browser, neschimbata de codul nostru) si
// insereaza noua intrare STRICT dupa pozitia curenta. Back revine deci STRICT la comenzile-mele.html,
// FARA nicio entry suplimentara/duplicata — testele de mai jos simuleaza o STIVA REALA de istoric
// (push trunchiaza forward-ul, back muta STRICT pointerul, exact semantica de browser) ca sa
// dovedeasca exact acest lucru pentru toate scenariile cerute explicit (1 comanda, 2, 3, inca un
// Back dupa oricare, un draft vechi, si "Creeaza o melodie noua").
// ===================================================================================================
test('comenzile-mele.html: NU exista niciun apel history.pushState() in tot fisierul — navigarea catre o comanda ramane STRICT o navigare normala (<a href> / location.href=), fara nicio manipulare de istoric', () => {
  assert.ok(!page.includes('history.pushState'), 'niciun history.pushState nu trebuie sa existe — cauza confirmata a unui history trap real');
});

for (const destFile of [
  ['public/melodia-mea.html', read('public/melodia-mea.html')],
  ['public/comanda-mea.html', read('public/comanda-mea.html')],
  ['public/amintiri-video.html', read('public/amintiri-video.html')]
]) {
  test(`${destFile[0]}: nu manipuleaza window.history in niciun fel (nici pushState, nici replaceState, nici back/go/forward) — problema Back nu se rezolva (si nu trebuie rezolvata) pe pagina destinatie`, () => {
    assert.ok(!/history\.(pushState|replaceState|back\(|go\(|forward\()/.test(destFile[1]), `${destFile[0]} nu trebuie sa atinga history deloc`);
  });
}

test('sandbox: Continua cu aceasta comanda (token local — Standard/Premium/Video, fiecare izolat) NU apeleaza NICIODATA history.pushState() — navigarea ramane STRICT nativa (card.href)', async () => {
  const cases = [
    { id: 'order-standard', plan: 'standard', recipient: 'Ion', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false },
    { id: 'order-premium', plan: 'premium', recipient: 'Elena', status: 'preview_ready', createdAt: '2026-09-02T00:00:00Z', variants: [{ previewUrl: 'https://cdn/a.mp3' }, { previewUrl: 'https://cdn/b.mp3' }] },
    { id: 'order-video', plan: 'video', recipient: 'Andrei', status: 'preview_ready', createdAt: '2026-09-03T00:00:00Z', variants: [{ previewUrl: 'https://cdn/x1.mp3' }] }
  ];
  for (const order of cases) {
    const tok = 's'.repeat(48);
    const { api, elements, pushStateCalls } = buildSandbox({
      storedOrders: [{ id: order.id, token: tok }],
      fetchImpl: (url) => (url.includes(`/api/orders/${order.id}?token=`) ? jsonRes(order) : { ok: false })
    });
    await api.__loadPromise;
    const card = elements['orders-list'].children[0];
    // Cardul e un <a href> nativ, fara niciun listener JS de click (verificat implicit: nu
    // exista __listeners.click) — navigarea o face STRICT browserul, urmarind href-ul.
    assert.ok(!card.__listeners.click, `${order.plan}: cardul nu trebuie sa aiba niciun listener de click — navigare 100% nativa`);
    assert.equal(pushStateCalls.length, 0, `${order.plan}: nimic nu trebuie sa apeleze pushState`);
  }
});

test('sandbox: Continua cu aceasta comanda prin resume-by-email NU apeleaza history.pushState() — STRICT window.location.href = resumeUrl, fara nicio manipulare de istoric', async () => {
  const { api, elements, windowMock, pushStateCalls } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') {
        return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      }
      if (url.includes('/resume-by-email')) {
        return jsonRes({ canResume: true, resumeUrl: '/melodia-mea.html?id=order-1&token=payload.semnatura' });
      }
      return { ok: false };
    }
  });
  await api.__loadPromise;
  const card = elements['orders-list'].children[0];
  const btn = card.children.find((c) => c.className === 'continue-cta-btn');
  assert.ok(btn, 'trebuie sa existe butonul de continuare');
  await btn.__listeners.click();
  assert.equal(pushStateCalls.length, 0, 'niciun pushState nu trebuie chemat — STRICT navigarea nativa');
  assert.equal(windowMock.location.href, '/melodia-mea.html?id=order-1&token=payload.semnatura', 'navigarea reala catre comanda tot are loc, neschimbata');
});

test('sandbox: click pe "Creeaza o melodie noua" NU apeleaza history.pushState() — fluxul normal existent, neatins', async () => {
  const { api, elements, pushStateCalls } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') return jsonRes({ canCreateNew: true });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  elements['create-new-cta-btn'].__listeners.click();
  assert.equal(pushStateCalls.length, 0, '"Creeaza o melodie noua" trebuie sa ramana STRICT fluxul normal existent, fara nicio manipulare de istoric');
});

// ===================================================================================================
// SCENARIILE OBLIGATORII (2026-10-03, cerinta explicita, verbatim) — simuleaza o STIVA REALA de
// istoric de browser (push trunchiaza forward-ul de la pozitia curenta, back muta STRICT
// pointerul — exact semantica standard, NIMIC adaugat de codul nostru) ca sa dovedeasca:
//   1. Comenzile mele -> Comanda 1 -> Back = Comenzile mele
//   2. Comenzile mele -> Comanda 1 -> Back -> Comanda 2 -> Back = Comenzile mele
//   3. Comenzile mele -> Comanda 1 -> Back -> Comanda 2 -> Back -> Comanda 3 -> Back = Comenzile mele
//   4. Dupa oricare dintre 1-3: INCA un Back = paraseste normal Comenzile mele (NU Comenzile mele
//      din nou, NU vreo entry duplicata)
//   5. Cu un draft/formular vechi deja in istoric: Comenzile mele -> Continue -> Back = tot
//      Comenzile mele, NU draftul
//   6. Creeaza o melodie noua -> Back = Comenzile mele, daca navigarea a pornit de acolo
// ===================================================================================================
test('sandbox: SCENARIILE 1-4 (stiva de istoric REALA, fara nicio manipulare JS) — Comanda1->Back, apoi Comanda2->Back, apoi Comanda3->Back arata de fiecare data STRICT Comenzile mele; un Back suplimentar dupa oricare paraseste normal pagina (nu mai exista Comenzile mele din nou, nu exista nicio entry duplicata)', async () => {
  const initialUrl = 'https://nalunastudio.com/comenzile-mele.html';
  const beforeSiteUrl = 'https://google.com/search?q=naluna'; // orice ar fi existat REAL inainte de a ajunge pe site
  const orders = [
    { id: 'order-1', plan: 'standard', recipient: 'Ion', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false },
    { id: 'order-2', plan: 'premium', recipient: 'Elena', status: 'ready', createdAt: '2026-09-02T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false },
    { id: 'order-3', plan: 'video', recipient: 'Andrei', status: 'ready', createdAt: '2026-09-03T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false }
  ];
  const tokens = { 'order-1': 'a'.repeat(48), 'order-2': 'b'.repeat(48), 'order-3': 'c'.repeat(48) };
  const fetchImpl = (url) => {
    const match = orders.find((o) => url.includes(`/api/orders/${o.id}?token=`));
    return match ? jsonRes(match) : { ok: false };
  };

  // Stiva reala inainte de sosirea pe Comenzile mele — orice ar fi fost acolo (chiar si un
  // referrer extern), complet irelevant, pentru ca noua navigare catre Comenzile mele oricum
  // devine varful stivei in mod normal.
  const history = makeSharedHistory(beforeSiteUrl);
  history.navigateTo(initialUrl); // sosirea REALA pe Comenzile mele — stack: [google, comenzile-mele]

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const { api, elements, pushStateCalls } = buildSandbox({
      sharedHistory: history,
      storedOrders: [{ id: order.id, token: tokens[order.id] }],
      fetchImpl
    });
    await api.__loadPromise;
    const card = elements['orders-list'].children[0];
    assert.ok(!card.__listeners.click, `Comanda ${i + 1}: cardul nu trebuie sa aiba niciun listener JS — navigare 100% nativa`);
    assert.equal(pushStateCalls.length, 0, `Comanda ${i + 1}: nimic nu trebuie sa manipuleze istoricul`);
    // Navigarea reala catre pagina comenzii — browserul urmeaza STRICT card.href (niciun JS implicat).
    assert.equal(card.href, `/comanda-mea.html?token=${encodeURIComponent(tokens[order.id])}`, `Comanda ${i + 1}: href-ul cardului trebuie sa duca la comanda corecta`);
    history.navigateTo(card.href);
    // Back — SCENARIILE 1/2/3: dupa Comanda 1, apoi dupa Comanda 1->Back->Comanda 2, apoi dupa ...->Comanda 3.
    const afterBack = history.back();
    assert.equal(afterBack.url, initialUrl, `SCENARIUL ${i + 1}: dupa Comanda ${i + 1} -> Back, trebuie sa fim STRICT pe Comenzile mele`);
  }

  // Stiva finala trebuie sa aiba STRICT 3 intrari: [google, comenzile-mele, order-3] — NICIO
  // entry duplicata de Comenzile mele, indiferent de cate comenzi au fost vizitate (1, 2 sau 3).
  assert.equal(history.depth(), 3, 'NU trebuie sa existe nicio duplicare de Comenzile mele in istoric, indiferent de numarul de comenzi vizitate');
  assert.equal(history.position(), 1, 'pozitia curenta trebuie sa fie STRICT intrarea comenzile-mele.html, unica');

  // SCENARIUL 4: inca un Back, DUPA ce am revenit la Comenzile mele — trebuie sa paraseasca
  // normal pagina (catre ce a existat REAL inainte), NICIODATA sa arate Comenzile mele din nou.
  const oneMoreBack = history.back();
  assert.notEqual(oneMoreBack.url, initialUrl, 'Back-ul suplimentar NU trebuie sa arate Comenzile mele din nou — trebuie sa paraseasca normal pagina');
  assert.equal(oneMoreBack.url, beforeSiteUrl, 'Back-ul suplimentar trebuie sa ajunga STRICT la ce a existat cu adevarat inainte de Comenzile mele — fara nicio entry intermediara inventata');
});

test('sandbox: SCENARIUL 5 (draft/formular vechi deja in istoric) — Comenzile mele -> Continue -> Back = tot Comenzile mele, NICIODATA draftul vechi, chiar daca acesta exista mai devreme in aceeasi stiva', async () => {
  const draftUrl = 'https://nalunastudio.com/comanda.html'; // draftul vechi, deja vizitat cu mult inainte, in acelasi tab
  const initialUrl = 'https://nalunastudio.com/comenzile-mele.html';
  const order = { id: 'order-1', plan: 'standard', recipient: 'Ion', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false };
  const tok = 'a'.repeat(48);

  const history = makeSharedHistory(draftUrl); // clientul a inceput demult un draft aici
  history.navigateTo(initialUrl); // apoi, separat, ajunge (real) pe Comenzile mele — stack: [comanda.html(draft), comenzile-mele]

  const { api, elements, pushStateCalls } = buildSandbox({
    sharedHistory: history,
    storedOrders: [{ id: order.id, token: tok }],
    fetchImpl: (url) => (url.includes(`/api/orders/${order.id}?token=`) ? jsonRes(order) : { ok: false })
  });
  await api.__loadPromise;
  const card = elements['orders-list'].children[0];
  assert.ok(!card.__listeners.click, 'cardul nu trebuie sa aiba niciun listener JS — navigare 100% nativa');
  assert.equal(pushStateCalls.length, 0, 'niciun pushState — draftul vechi ramane STRICT in istoric, netouched, dar NU trebuie sa "castige" Back-ul');
  history.navigateTo(card.href);
  const afterBack = history.back();
  assert.equal(afterBack.url, initialUrl, 'Back trebuie sa arate STRICT Comenzile mele, NICIODATA draftul vechi de pe comanda.html, desi acesta exista mai devreme in aceeasi stiva');
});

test('sandbox: SCENARIUL 6 — Comenzile mele -> Creeaza o melodie noua -> Back = Comenzile mele (navigarea a pornit de acolo, deci Back revine STRICT acolo, fara nicio manipulare suplimentara)', async () => {
  const initialUrl = 'https://nalunastudio.com/comenzile-mele.html';
  const history = makeSharedHistory(initialUrl);
  const { api, elements, pushStateCalls } = buildSandbox({
    sharedHistory: history,
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') return jsonRes({ canCreateNew: true });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  elements['create-new-cta-btn'].__listeners.click();
  assert.equal(pushStateCalls.length, 0, '"Creeaza o melodie noua" nu manipuleaza istoricul');
  history.navigateTo('https://nalunastudio.com/comanda.html');
  const afterBack = history.back();
  assert.equal(afterBack.url, initialUrl, 'Back de pe /comanda.html trebuie sa revina STRICT la comenzile-mele.html, de unde a pornit navigarea');
  assert.equal(history.depth(), 2, 'stiva ramane cu STRICT 2 intrari (comenzile-mele + comanda.html) — nicio entry suplimentara');
});

// ===================================================================================================
// BUG REAL DE PRODUCTIE, PARTEA A 2-A (2026-09-30, "dupa Back, cardul devine link auriu cu
// sageata, in loc de buton negru") — DISTINCT de bug-ul de mai sus (disabled/"Se incarca..."):
// aici cauza NU era bfcache — era o RE-INCARCARE REALA in care melodia-mea.html/comanda-mea.html
// retinusera GRESIT resume-tokenul in naluna_my_order_keys (fix separat, vezi
// test/same-browser-token-persistence-fix.test.js). Cardul trecea astfel de la
// renderReadOnlyOrderCard (buton negru, .continue-cta-btn) la renderOrderCard (link auriu + "→",
// .continue-cta) — nu doar un state ramas, ci FUNCTIA DE RANDARE insasi schimbata. Cu fixul din
// melodia-mea.html/comanda-mea.html (resume-tokenul nu se mai retine), naluna_my_order_keys ramane
// gol pentru comenzile 1/2/3 dupa Back, deci comenzile-mele.html continua sa le randeze STRICT
// prin renderReadOnlyOrderCard (buton negru normal, latime/stil originale) la fiecare reincarcare.
// ===================================================================================================
test('sandbox: Comanda 1/2/3 accesate prin resume-by-email, apoi Back -> RE-INCARCARE REALA (nu bfcache) cu naluna_my_order_keys STRICT gol (fixul din melodia-mea.html/comanda-mea.html) -> toate 3 carduri raman butoane negre normale (.continue-cta-btn), NICIODATA link auriu (.continue-cta) cu sageata', async () => {
  const { api, elements } = buildSandbox({
    storedOrders: [], // naluna_my_order_keys GOL — exact rezultatul fixului melodia-mea.html/comanda-mea.html dupa Continue+Back pe toate 3 comenzile
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => (url === '/api/orders/by-email'
      ? jsonRes({ orders: [
        { id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true },
        { id: 'order-2', plan: 'premium', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-02T00:00:00Z', songCount: 4, hostedAccessExpired: false, canResume: true },
        { id: 'order-3', plan: 'video', recipient: 'Maria', status: 'ready', createdAt: '2026-09-03T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }
      ] })
      : { ok: false })
  });
  await api.__loadPromise;
  const cards = elements['orders-list'].children;
  assert.equal(cards.length, 3);
  cards.forEach((card, i) => {
    const blackBtn = card.children.find((c) => c.className === 'continue-cta-btn');
    assert.ok(blackBtn, `cardul ${i + 1} trebuie sa aiba butonul negru normal (.continue-cta-btn)`);
    assert.equal(blackBtn.textContent, api.t.continue_btn, `cardul ${i + 1}: text corect, fara sageata`);
    assert.ok(!card.innerHTML.includes('continue-cta"'), `cardul ${i + 1} nu trebuie sa foloseasca NICIODATA varianta link auriu (.continue-cta)`);
    assert.ok(!card.innerHTML.includes('→'), `cardul ${i + 1} nu trebuie sa contina sageata (STRICT pentru cardurile cu token local complet)`);
    assert.ok(!card.href, `cardul ${i + 1} nu trebuie sa fie un <a> clicabil — STRICT div, view/listen prin email`);
  });
});

test('sandbox: o incarcare NORMALA (nu din bfcache — event.persisted===false, ex. pageshow la incarcarea initiala) NU declanseaza resetarea (loadAndRenderOrders() oricum reconstruieste totul de la zero)', async () => {
  const { elements, windowListeners } = buildSandbox({ storedOrders: [] });
  const btn = elements['blocked-cta-btn']; // orice element existent, STRICT ca sa verificam ca handler-ul nu arunca / nu modifica nimic in afara .continue-cta-btn
  const before = btn.disabled;
  windowListeners.pageshow.forEach((fn) => fn({ persisted: false }));
  assert.equal(btn.disabled, before, 'un pageshow normal (persisted:false) nu trebuie sa modifice nimic');
});

// ===================================================================================================
// "CREEAZA O MELODIE NOUA" (2026-09-30, cerinta explicita) — vizibil STRICT dupa confirmarea
// server-side (canCreateNew), niciodata dedus din numarul de carduri afisate. UN SINGUR CTA, dupa
// lista — niciodata per card. Click -> STRICT fluxul normal existent (/comanda.html), fara nicio
// cerere suplimentara (nicio generare/creare de comanda la simpla apasare).
// ===================================================================================================
test('sandbox: server confirma canCreateNew:true -> CTA-ul "Creeaza o melodie noua" devine vizibil dupa lista de comenzi', async () => {
  const { api, elements } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') return jsonRes({ canCreateNew: true });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.notEqual(elements['create-new-cta-wrap'].style.display, 'none');
  assert.equal(elements['create-new-cta-btn'].textContent, api.t.create_new_song_btn);
});

test('sandbox: server confirma canCreateNew:false -> CTA-ul "Creeaza o melodie noua" RAMANE ascuns (niciodata dedus din numarul de comenzi afisate)', async () => {
  const { api, elements } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') return jsonRes({ canCreateNew: false });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['create-new-cta-wrap'].style.display, 'none');
});

test('sandbox: eroare de retea la verificarea can-create-new -> CTA ramane ascuns (niciodata un fals-pozitiv)', async () => {
  const { api, elements } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') throw new Error('network down');
      return { ok: false };
    }
  });
  await api.__loadPromise;
  assert.equal(elements['create-new-cta-wrap'].style.display, 'none');
});

test('sandbox: fara niciun email cunoscut (STRICT tokenuri locale, fara pendingRecoveryEmail) -> CTA-ul ramane ascuns, fara nicio cerere can-create-new (nimic de verificat fara email)', async () => {
  const token = 'j'.repeat(48);
  const { api, elements, fetchCalls } = buildSandbox({
    storedOrders: [{ id: 'order-local', token }],
    fetchImpl: (url) => (url.includes('order-local')
      ? jsonRes({ id: 'order-local', plan: 'standard', recipient: 'Maria', status: 'ready', createdAt: '2026-09-01T00:00:00Z', hasGiftAudio: false, hasPremiumBonusAudio: false, hostedAccessExpired: false })
      : { ok: false })
  });
  await api.__loadPromise;
  assert.equal(elements['create-new-cta-wrap'].style.display, 'none');
  assert.ok(!fetchCalls.some((c) => c.url === '/api/orders/can-create-new'), 'fara email cunoscut, nu trebuie facuta nicio cerere de verificare');
});

test('sandbox: click pe "Creeaza o melodie noua" navigheaza STRICT catre /comanda.html (fluxul normal existent) si NU face nicio cerere suplimentara — niciun order/generare/quota atinsa la simpla apasare', async () => {
  const { api, elements, fetchCalls } = buildSandbox({
    pendingRecoveryEmail: 'client@exemplu.com',
    fetchImpl: (url) => {
      if (url === '/api/orders/by-email') return jsonRes({ orders: [{ id: 'order-1', plan: 'standard', recipient: 'Maria', status: 'preview_ready', createdAt: '2026-09-01T00:00:00Z', songCount: 1, hostedAccessExpired: false, canResume: true }] });
      if (url === '/api/orders/can-create-new') return jsonRes({ canCreateNew: true });
      return { ok: false };
    }
  });
  await api.__loadPromise;
  const callsBeforeClick = fetchCalls.length;
  elements['create-new-cta-btn'].__listeners.click();
  assert.equal(fetchCalls.length, callsBeforeClick, 'simpla apasare nu trebuie sa declanseze NICIO cerere noua (nicio creare de comanda/generare la click)');
});

for (const lang of ALLOWED_LANGS) {
  test(`comenzile-mele.html: limba ${lang} are cheia create_new_song_btn, nevida`, () => {
    const idxLang = page.indexOf(`    ${lang}: {`);
    const endLang = page.indexOf('\n    },', idxLang);
    const block = page.slice(idxLang, endLang);
    const m = block.match(/create_new_song_btn: '([^']+)'/);
    assert.ok(m && m[1].trim().length > 0, `[${lang}] create_new_song_btn lipseste/gol`);
  });
}

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
