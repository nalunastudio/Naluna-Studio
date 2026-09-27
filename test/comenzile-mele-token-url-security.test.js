// PROBLEMA 3 (2026-09-27, audit securitate cerut explicit — "SECURITATEA URL-ULUI CU MULTIPLE
// ACCESS TOKENS"): linkul de recuperare acces foloseste comenzile-mele.html?tokens=a,b,c, unde
// token-urile SUNT credentiale de acces (accessToken, acelasi mecanism auditat peste tot in
// site). Design-ul deja avea history.replaceState() (vezi testul existent din
// comenzile-mele-page.test.js), dar analiza a scos la iveala o CURSA reala: replaceState() rula
// abia DUPA ce fetch-ul asincron de validare server-side (/api/orders/access/:token) se termina —
// iar analytics.js incarca GA4/Meta Pixel STRICT la DOMContentLoaded (independent, nu asteapta
// acest fetch). Pentru un vizitator cu consimtamant Analytics/Marketing deja acordat dintr-o
// vizita anterioara, page_view/PageView automat s-ar fi putut trimite cu window.location.href
// INAINTE ca fetch-ul nostru sa se termine — expunand token-urile catre Google/Meta.
//
// REPARATIE: replaceState() muta SINCRON, imediat dupa capturarea token-urilor in memorie
// (incomingTokens), inainte de orice await/fetch — inchide cursa complet, indiferent de viteza
// retelei, fara nicio schimbare de arhitectura (acelasi mecanism accessToken, neschimbat).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const page = read('public/comenzile-mele.html');
const analytics = read('public/js/analytics.js');
const attribution = read('public/js/attribution.js');

function lastInlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

// ===============================================================================================
// (1) Ordinea in SURSA: replaceState() apare INAINTE de definitia lui resolveIncomingTokens()
// (deci inainte de orice fetch), nu in interiorul/dupa functia asincrona.
// ===============================================================================================
test('comenzile-mele.html: history.replaceState() (curatarea URL-ului de token/tokens) apare in sursa INAINTE de "async function resolveIncomingTokens", deci se executa sincron, nu dupa fetch', () => {
  const cleanupIdx = page.indexOf("window.history.replaceState(null, '', clean.toString());");
  const asyncFnIdx = page.indexOf('async function resolveIncomingTokens() {');
  assert.ok(cleanupIdx !== -1, 'nu am gasit apelul replaceState');
  assert.ok(asyncFnIdx !== -1, 'nu am gasit definitia resolveIncomingTokens');
  assert.ok(cleanupIdx < asyncFnIdx, 'replaceState trebuie sa apara INAINTE de resolveIncomingTokens (sincron, nu dupa fetch)');
});

test('comenzile-mele.html: resolveIncomingTokens() NU mai contine apelul replaceState (mutat sincron mai sus) — functia asincrona doar valideaza server-side si salveaza local', () => {
  const start = page.indexOf('async function resolveIncomingTokens() {');
  let depth = 1, i = start + 'async function resolveIncomingTokens() {'.length;
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = page.slice(start, i + 1);
  assert.ok(!/replaceState/.test(body), 'replaceState nu mai trebuie apelat in interiorul functiei asincrone');
  assert.match(body, /saveKnownOrders\(known\)/);
});

// ===============================================================================================
// (2) Simulare runtime (sandbox) — proba ca URL-ul e curatat INAINTE ca fetch-ul (asincron) sa
// se rezolve, nu dupa. Simulam un fetch lent (Promise nerezolvata pana testul o rezolva manual)
// si verificam ca replaceState a fost deja chemat cand pornim scriptul, fara sa asteptam fetch-ul.
// ===============================================================================================
test('sandbox: la incarcare cu ?tokens=..., URL-ul e curatat (history.replaceState) SINCRON, inainte ca raspunsul fetch (simulat lent) sa soseasca', async () => {
  const src = lastInlineScript(page);

  const replaceStateCalls = [];
  let fetchCallCount = 0;
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });

  const fakeDocument = {
    documentElement: { getAttribute: () => 'ro' },
    getElementById: () => ({ style: {}, textContent: '', appendChild() {}, addEventListener() {}, querySelector: () => null }),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }),
    addEventListener: () => {},
    body: { appendChild() {} }
  };
  const TOKEN_A = 'a'.repeat(48);
  const TOKEN_B = 'b'.repeat(48);
  const fakeLocation = { href: `https://naluna.studio/comenzile-mele.html?tokens=${TOKEN_A},${TOKEN_B}`, search: `?tokens=${TOKEN_A},${TOKEN_B}` };
  const fakeHistory = {
    replaceState(state, title, url) { replaceStateCalls.push(url); }
  };
  const fakeLocalStorage = { getItem: () => null, setItem() {} };
  function fakeFetch() {
    fetchCallCount++;
    return pendingFetch;
  }

  const runner = new Function(
    'window', 'document', 'localStorage', 'history', 'fetch', 'URLSearchParams', 'URL', 'navigator',
    src
  );

  const started = runner(
    { location: fakeLocation, history: fakeHistory, NalunaAnalytics: { isAnalyticsConsentGranted: () => false } },
    fakeDocument,
    fakeLocalStorage,
    fakeHistory,
    fakeFetch,
    URLSearchParams,
    URL,
    { language: 'en' }
  );

  // Punctul-cheie: chiar INAINTE ca fetch-ul (inca nerezolvat, simuland o retea lenta) sa
  // raspunda, replaceState() trebuie sa fi fost deja apelat (curatarea e sincrona).
  assert.equal(fetchCallCount > 0, true, 'fetch-ul de validare trebuia sa fi pornit deja (macar declansat)');
  assert.equal(replaceStateCalls.length, 1, 'replaceState trebuia sa fi fost apelat DEJA, inainte ca fetch-ul sa se rezolve');
  assert.ok(!replaceStateCalls[0].includes(TOKEN_A) && !replaceStateCalls[0].includes(TOKEN_B), 'URL-ul curatat nu mai trebuie sa contina token-urile');

  // Curatare — rezolvam fetch-ul ramas in asteptare, ca sa nu ramana o promisiune nerezolvata.
  resolveFetch({ ok: false });
  await new Promise((r) => setTimeout(r, 0));
});

// ===============================================================================================
// (3) analytics.js — confirmare ca automat page_view (GA4) si PageView (Meta) se declanseaza
// STRICT la DOMContentLoaded (initConsentUi), niciodata inainte, si ca nu exista niciun cod care
// asteapta explicit finalizarea unui fetch al altei pagini inainte de a trimite aceste evenimente
// (adica riscul de cursa descris in comentariul din comenzile-mele.html e real — analytics.js nu
// are de unde sa stie sa astepte).
// ===============================================================================================
test('analytics.js: gtag("config", ...) (declanseaza automat page_view GA4) e apelat STRICT din loadGtagIfNeeded(), fara send_page_view:false — deci page_view automat foloseste window.location.href curent la momentul incarcarii gtag.js', () => {
  const body = analytics.slice(analytics.indexOf('function loadGtagIfNeeded() {'), analytics.indexOf('function applyStoredConsent'));
  assert.match(body, /global\.gtag\('config', GA_ID/);
  assert.ok(!/send_page_view\s*:\s*false/.test(body), 'confirmare: automatic page_view NU e dezactivat global (schimbarea asta ar fi o modificare de arhitectura mai ampla, in afara scopului — fixul e STRICT in comenzile-mele.html)');
});

test('analytics.js: initConsentUi() (care poate incarca GA4/Meta Pixel daca exista deja consimtamant) ruleaza STRICT la DOMContentLoaded / imediat daca documentul e deja gata — independent de orice fetch al paginii care il incarca', () => {
  assert.match(analytics, /if \(document\.readyState === 'loading'\) \{\s*document\.addEventListener\('DOMContentLoaded', initConsentUi\);/);
});

test('attribution.js: captureFromCurrentUrl() foloseste STRICT o lista fixa de chei (utm_*/fbclid) — niciodata token/tokens, deci nu poate stoca accidental credentiale de acces in naluna_attribution', () => {
  assert.match(attribution, /var UTM_KEYS = \['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'\];/);
  assert.ok(!/token/i.test(attribution), 'attribution.js nu trebuie sa mentioneze niciodata token/tokens');
});

// ===============================================================================================
// (4) server.js — nicio logare a URL-ului/query string-ului complet (console.log/error cu
// req.url/req.originalUrl) care ar putea scrie token-urile in loguri de aplicatie.
// ===============================================================================================
test('server.js: nicio logare a req.url/req.originalUrl complet (query string-ul, deci token-urile, nu ajunge in console.log/error din codul aplicatiei)', () => {
  const server = read('server.js');
  assert.ok(!/console\.(log|error|warn)\([^)]*req\.(url|originalUrl)/.test(server));
});

test('server.js: linkul de recuperare acces foloseste STRICT accessToken existent (48 hex) — nicio schimbare de mecanism, fixul e STRICT client-side (ordinea replaceState)', () => {
  const server = read('server.js');
  assert.match(server, /const allTokens = orders\.map\(\(o\) => o\.accessToken\)\.join\(','\);/);
  assert.match(server, /const accessUrl = `\$\{DOMAIN\}\/comenzile-mele\.html\?tokens=\$\{encodeURIComponent\(allTokens\)\}`;/);
});

test('node --check server.js trece (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

test('sintaxa scriptului inline din comenzile-mele.html ramane valida dupa mutarea replaceState', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(page)));
});
