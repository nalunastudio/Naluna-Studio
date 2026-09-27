// PROBLEME I/J/K/L/M (2026-09-27, cerinta explicita) — pagina noua "Comenzile mele"
// (public/comenzile-mele.html): la a 4-a generare, clientul e redirectionat aici (nu mai un
// mesaj inline pe comanda.html); pagina arata direct comenzile browserului (localStorage,
// {id, accessToken} — acelasi mecanism de acces deja auditat, NU un credential nou), plus
// toate variantele audio disponibile, plus actiunea corecta de continuare per comanda
// (melodia-mea.html?id=&token=, care respecta deja toate gate-urile Standard/Premium/Video).
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
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function lastInlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

test('public/comenzile-mele.html: scriptul inline ramane sintactic valid', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(page)));
});

// ===============================================================================================
// (1) comanda.html — la 403 (quota atinsa), redirectioneaza catre comenzile-mele.html?blocked=1
// (nu mai afiseaza un mesaj/buton inline pe aceasta pagina).
// ===============================================================================================
test('comanda.html: la 403 de la /generate, redirectioneaza catre /comenzile-mele.html?blocked=1 (traseul normal, fara email)', () => {
  const idx = comanda.indexOf('if (!generateRes.ok && generateRes.status !== 409)');
  const end = comanda.indexOf('\n      }', idx);
  const body = comanda.slice(idx, end);
  assert.match(body, /if \(generateRes\.status === 403\) \{/);
  assert.match(body, /window\.location\.href = '\/comenzile-mele\.html\?blocked=1';/);
});

test('comanda.html: mecanismul inline vechi (quota-recovery-box/buton propriu) a fost eliminat complet — inlocuit de redirect', () => {
  assert.ok(!comanda.includes('quota-recovery-box'));
  assert.ok(!comanda.includes('quota_recovery_btn'));
  assert.ok(!comanda.includes('quotaRecoveryBtn'));
});

// ===============================================================================================
// (2) comanda.html — la fiecare creare reusita de comanda, {id, accessToken} e adaugat in
// localStorage (naluna_my_order_keys) — asta permite "acelasi browser vede direct".
// ===============================================================================================
test('comanda.html: dupa POST /api/orders reusit, {id, accessToken} e adaugat in localStorage sub cheia naluna_my_order_keys (plafonat, fara sa arunce daca localStorage e indisponibil)', () => {
  const idx = comanda.indexOf('currentOrderId = createData.orderId;');
  const body = comanda.slice(idx, idx + 1100);
  assert.match(body, /const KEY = 'naluna_my_order_keys';/);
  assert.match(body, /list\.push\(\{ id: currentOrderId, token: currentAccessToken \}\)/);
  assert.match(body, /list\.slice\(-50\)/);
  assert.match(body, /catch \(e\) \{ \/\*/, 'trebuie sa fie invelit intr-un try/catch — localStorage poate lipsi (mod privat strict)');
});

// ===============================================================================================
// (3) Pagina noua — securitate/model de acces.
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

test('comenzile-mele.html: o comanda care nu mai raspunde (404 — expirata/token gresit) e scoasa din lista locala, niciodata pastrata "moarta"', () => {
  assert.match(page, /stillValidIds = new Set\(results\.filter\(Boolean\)\.map\(\(r\) => r\.order\.id\)\)/);
  assert.match(page, /known = known\.filter\(\(entry\) => stillValidIds\.has\(entry\.id\)\)/);
});

test('comenzile-mele.html: exclude draft/generation_failed din afisare (acelasi filtru ca recovery email/quota — nimic de continuat/diferentiat)', () => {
  assert.match(page, /r\.order\.status !== 'draft' && r\.order\.status !== 'generation_failed'/);
});

test('comenzile-mele.html: NICIODATA nu afiseaza UUID/accessToken ca TEXT vizibil — apar STRICT in atribute href/src (acelasi mecanism ca restul site-ului), niciodata in innerHTML ca eticheta/continut', () => {
  assert.ok(!/textContent = .*order\.id/.test(page));
  assert.ok(!/textContent = .*token/.test(page));
});


test('comenzile-mele.html: mesajul de blocare (banner) e afisat STRICT cand URL contine ?blocked=1 — o vizita normala ulterioara nu il arata', () => {
  assert.match(page, /if \(params\.get\('blocked'\) === '1'\)/);
});

// ===============================================================================================
// (4) Toate cele 8 limbi — titlu, status, buton continuare, recuperare.
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
  test(`comenzile-mele.html: limba ${lang} are toate cheile obligatorii (title/blocked/continue_btn/status_progress/status_ready/plan/recovery_*)`, () => {
    assert.ok(T[lang], `bloc de traduceri lipsa pentru ${lang}`);
    for (const key of ['title', 'blocked', 'continue_btn', 'status_progress', 'status_ready', 'song_label', 'recovery_btn', 'recovery_sent', 'empty_no_orders']) {
      assert.ok(typeof T[lang][key] !== 'undefined', `[${lang}] cheia lipsa: ${key}`);
    }
    assert.ok(T[lang].plan && T[lang].plan.standard && T[lang].plan.premium && T[lang].plan.video, `[${lang}] plan.standard/premium/video lipsesc`);
  });
}

test('comenzile-mele.html: toate cele 8 traduceri ale mesajului "blocked" sunt distincte si nu contin nicio cifra', () => {
  const values = ALLOWED_LANGS.map((lang) => T[lang].blocked);
  for (let i = 0; i < ALLOWED_LANGS.length; i++) {
    assert.ok(!/\d/.test(values[i]), `[${ALLOWED_LANGS[i]}] mesajul blocked nu trebuie sa contina nicio cifra: "${values[i]}"`);
  }
  assert.equal(new Set(values).size, ALLOWED_LANGS.length, 'toate cele 8 traduceri trebuie sa fie distincte');
});

// ===============================================================================================
// (5) COMPORTAMENT REAL, sandbox — renderOrderCard(): pretul/planul/status vin STRICT din
// obiectul order primit (server), playerul foloseste STRICT token-ul propriei comenzi (fara
// amestec intre comenzi), Standard/Premium/Video continua catre propriul link, fara confuzie.
// ===============================================================================================
function loadRenderOrderCard() {
  // renderOrderCard() foloseste `t`/`escapeHtml`/`planName` din inchiderea (closure) modulului —
  // extragem tot IIFE-ul si il executam intr-un DOM minimal simulat (jsdom nu e disponibil in
  // acest proiect — construim un `document`/`window` minimal, suficient pentru ce foloseste
  // efectiv scriptul la incarcare: querySelector-uri pe elemente care exista in pagina reala).
  const script = lastInlineScript(page);
  // Scoatem STRICT wrapper-ul IIFE ("(function () {" ... "})();") — pastram corpul intact,
  // ca sa putem adauga propriile linii de expunere (window.__test_*) inainte de inchiderea reala.
  const bodyStart = script.indexOf('(function () {') + '(function () {'.length;
  const bodyEnd = script.lastIndexOf('})();');
  const body = script.slice(bodyStart, bodyEnd);
  // Injectam un `document`/`localStorage`/`fetch`/`navigator`/`window` minimale, apoi expunem
  // renderOrderCard si t pe `window` pentru a le putea testa direct.
  const harness = `
    ${body}
    window.__test_renderOrderCard = renderOrderCard;
    window.__test_t = t;
  `;
  const elements = {};
  // escapeHtml() din pagina reala seteaza div.textContent apoi citeste div.innerHTML — un DOM
  // real face automat escaping-ul de caractere in acest proces. Mock-ul trebuie sa reproduca
  // ACELASI comportament (nu doar sa stocheze separat), altfel escapeHtml() ar returna mereu gol.
  function escapeForMock(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function makeEl() {
    return {
      style: {}, dataset: {}, children: [],
      set textContent(v) { this._text = v; this._html = escapeForMock(v); },
      get textContent() { return this._text || ''; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      setAttribute() {}
    };
  }
  const ids = ['h1-title', 'p-sub', 'loading-msg', 'recovery-title', 'recovery-sub', 'recovery-email', 'recovery-btn', 'blocked-banner', 'orders-list', 'recovery-box', 'recovery-result'];
  for (const id of ids) elements[id] = makeEl();
  const documentMock = {
    documentElement: { lang: '' },
    getElementById: (id) => elements[id] || makeEl(),
    createElement: () => makeEl()
  };
  const windowMock = {
    location: { search: '', href: 'https://nalunastudio.com/comenzile-mele.html' },
    history: { replaceState: () => {} }
  };
  const localStorageMock = (() => {
    let store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    };
  })();
  const fn = new Function('document', 'window', 'localStorage', 'navigator', 'URLSearchParams', 'fetch', 'history',
    harness + '\nreturn { renderOrderCard: window.__test_renderOrderCard, t: window.__test_t };'
  );
  return fn(
    documentMock, windowMock, localStorageMock, { language: 'en' },
    URLSearchParams, async () => ({ ok: false }), { replaceState: () => {} }
  );
}

test('sandbox: renderOrderCard() — comanda READY afiseaza pretul EXACT din order.price (server), planul din order.plan, playerul foloseste EXACT accessToken-ul propriei comenzi (nu al alteia)', () => {
  const { renderOrderCard } = loadRenderOrderCard();
  const order = { id: 'order-standard-1', plan: 'standard', price: 15, recipient: 'Maria', status: 'ready', hostedAccessExpired: false };
  const card = renderOrderCard(order, 1, 'tok-standard-AAAA');
  assert.match(card.innerHTML, /£15/, 'pretul afisat trebuie sa fie EXACT cel din order.price');
  assert.match(card.innerHTML, /Standard/i);
  assert.match(card.innerHTML, /tok-standard-AAAA/, 'playerul trebuie sa foloseasca STRICT token-ul acestei comenzi');
  assert.ok(!card.innerHTML.includes('tok-standard-AAAA-alta'), 'nu trebuie sa apara vreun alt token');
});

test('sandbox: renderOrderCard() — comanda Premium (£25) si comanda Video (£35) NU se amesteca — fiecare card afiseaza STRICT propriul pret/plan/token, butonul de continuare duce la propriul id+token', () => {
  const { renderOrderCard } = loadRenderOrderCard();
  const premiumOrder = { id: 'order-premium', plan: 'premium', price: 25, recipient: 'Elena', status: 'ready', hostedAccessExpired: false };
  const videoOrder = { id: 'order-video', plan: 'video', price: 35, recipient: 'Andrei', status: 'ready', hostedAccessExpired: false };
  const cardPremium = renderOrderCard(premiumOrder, 1, 'tok-premium');
  const cardVideo = renderOrderCard(videoOrder, 2, 'tok-video');

  assert.match(cardPremium.innerHTML, /£25/);
  assert.match(cardPremium.innerHTML, /id=order-premium&token=tok-premium/);
  assert.ok(!cardPremium.innerHTML.includes('£35'), 'cardul Premium nu trebuie sa arate pretul Video');
  assert.ok(!cardPremium.innerHTML.includes('order-video'), 'cardul Premium nu trebuie sa refere comanda Video');

  assert.match(cardVideo.innerHTML, /£35/);
  assert.match(cardVideo.innerHTML, /id=order-video&token=tok-video/);
  assert.ok(!cardVideo.innerHTML.includes('£25'), 'cardul Video nu trebuie sa arate pretul Premium');
});

test('sandbox: renderOrderCard() — comanda INCA NEPLATITA (preview_ready, cu variante) afiseaza playere pentru variantele reale primite, buton "Continua" catre melodia-mea.html (plata/selectia raman gestionate ACOLO, neduplicate aici)', () => {
  const { renderOrderCard } = loadRenderOrderCard();
  const order = {
    id: 'order-unpaid', plan: 'standard', price: 15, recipient: 'Ion', status: 'preview_ready',
    variants: [{ previewUrl: 'https://cdn.example/preview1.mp3' }, { previewUrl: 'https://cdn.example/preview2.mp3' }]
  };
  const card = renderOrderCard(order, 1, 'tok-unpaid');
  assert.match(card.innerHTML, /preview1\.mp3/);
  assert.match(card.innerHTML, /preview2\.mp3/);
  assert.match(card.innerHTML, /melodia-mea\.html\?id=order-unpaid&token=tok-unpaid/);
  assert.ok(!/checkout|Stripe|selectedVariant/i.test(card.innerHTML), 'pagina NU trebuie sa reimplementeze plata/selectia — ramane STRICT in melodia-mea.html');
});

test('sandbox: renderOrderCard() — comanda cu acces expirat (hostedAccessExpired) NU arata niciun player stricat', () => {
  const { renderOrderCard } = loadRenderOrderCard();
  const order = { id: 'order-expired', plan: 'standard', price: 15, recipient: 'Maria', status: 'ready', hostedAccessExpired: true };
  const card = renderOrderCard(order, 1, 'tok-expired');
  assert.ok(!card.innerHTML.includes('<audio'), 'nicio comanda cu acces expirat nu trebuie sa arate un player');
});

test('sandbox: renderOrderCard() — Premium cu bonus (hasGiftAudio/hasPremiumBonusAudio) arata TOATE variantele disponibile, nu doar prima', () => {
  const { renderOrderCard } = loadRenderOrderCard();
  const order = { id: 'order-premium-bonus', plan: 'premium', price: 25, recipient: 'Elena', status: 'ready', hasGiftAudio: true, hasPremiumBonusAudio: true };
  const card = renderOrderCard(order, 1, 'tok-p');
  const audioCount = (card.innerHTML.match(/<audio/g) || []).length;
  assert.equal(audioCount, 3, 'melodia principala + gift + bonus = 3 playere');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
