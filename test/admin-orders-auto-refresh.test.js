// AUTO-REFRESH Admin > Comenzi (2026-09-25) — elimina riscul ramas de staleness (vezi raportul
// catre user): daca pagina ramane deschisa si intra o plata noua, cardurile KPI trebuie sa se
// actualizeze fara nicio interactiune a adminului. Verificare STATICA (acelasi tipar ca restul
// suitei pentru private/admin/orders.js — sursa citita ca text, nicio executie reala in jsdom).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');

// ACELASI tipar exact ca test/email-bounce-complaint-handling.test.js — `signature` trebuie sa se
// termine chiar cu acolada de deschidere a corpului functiei; depth porneste de la 1 (acea
// acolada) — nu cauta separat un "{" (care ar prinde gresit acoladele din destructurarea
// parametrilor, ex. `({ silent = false } = {})`, inchizand extragerea mult prea devreme).
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

test('AUTO_REFRESH_INTERVAL_MS: 60 secunde ("rezonabil", cerinta explicita)', () => {
  assert.match(js, /const AUTO_REFRESH_INTERVAL_MS = 60 \* 1000;/);
});

test('startAutoRefresh(): garda impotriva unui AL DOILEA interval (autoRefreshTimer deja setat -> no-op) — o a doua chemare NU dubleaza frecventa reala a request-urilor', () => {
  const fn = extractFn(js, 'function startAutoRefresh() {');
  assert.match(fn, /if \(autoRefreshTimer\) return;/);
  assert.match(fn, /autoRefreshTimer = setInterval\(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS\);/);
});

test('startAutoRefresh() e apelat EXACT o data, la nivelul de top al fisierului (init) — nicio dublare la incarcare', () => {
  const matches = js.match(/^startAutoRefresh\(\);/gm) || [];
  assert.equal(matches.length, 1, `asteptat exact 1 apel, gasit ${matches.length}`);
});

test('autoRefreshTick(): pagina ASCUNSA (document.hidden) -> return imediat, ZERO cereri catre server (Page Visibility API)', () => {
  const fn = extractFn(js, 'async function autoRefreshTick() {');
  const hiddenCheckIdx = fn.indexOf('if (typeof document !== \'undefined\' && document.hidden) return;');
  assert.ok(hiddenCheckIdx !== -1, 'garda document.hidden trebuie sa fie PRIMA instructiune reala a functiei');
  const fetchIdx = fn.search(/loadFunnelSummary\(|loadOrders\(/);
  assert.ok(hiddenCheckIdx < fetchIdx, 'garda document.hidden trebuie sa vina INAINTE de orice reimprospatare');
});

test('autoRefreshTick(): reimprospateaza KPI-urile SILENTIOS (loadFunnelSummary({silent:true})) — NICIODATA applyPeriodSyncToOrdersFilter direct, care ar reseta pagina/offset-ul tabelului', () => {
  const fn = extractFn(js, 'async function autoRefreshTick() {');
  assert.match(fn, /await loadFunnelSummary\(\{ silent: true \}\);/);
  assert.doesNotMatch(fn, /applyPeriodSyncToOrdersFilter\(\)/, 'tick-ul de fundal nu trebuie sa apeleze NICIODATA direct functia care reseteaza offset-ul');
});

test('autoRefreshTick(): reimprospateaza si tabelul prin loadOrders() STRICT (foloseste `state` curent — cautare/filtre/pagina NESCHIMBATE, niciun reset)', () => {
  const fn = extractFn(js, 'async function autoRefreshTick() {');
  assert.match(fn, /await loadOrders\(\);/);
});

test('autoRefreshTick(): loadOrders() e apelat intr-un try/catch propriu — un esec de retea la reimprospatarea de fundal NU trebuie sa arunce mai departe si sa strice pagina', () => {
  const fn = extractFn(js, 'async function autoRefreshTick() {');
  assert.match(fn, /try\s*\{\s*await loadOrders\(\);\s*\}\s*catch \(err\)\s*\{/);
});

test('loadFunnelSummary({silent:true}): SARE peste applyPeriodSyncToOrdersFilter (care ar reseta state.offset la 0) — apelurile explicite existente (silent implicit false) raman NESCHIMBATE', () => {
  const fn = extractFn(js, 'async function loadFunnelSummary({ silent = false } = {}) {');
  assert.match(fn, /if \(!silent && syncPeriodCheckbox\.checked\) applyPeriodSyncToOrdersFilter\(\);/);
});

test('loadFunnelSummary(): pastreaza try/catch existent (un fetch esuat, silent sau nu, NU trebuie sa strice pagina)', () => {
  const fn = extractFn(js, 'async function loadFunnelSummary({ silent = false } = {}) {');
  assert.match(fn, /\} catch \(err\) \{\s*[\s\S]*?console\.error\('Eroare la încărcarea rezumatului funnel:', err\);/);
});

test('apelurile EXPLICITE existente (paidFilter, syncPeriodCheckbox) NU trec silent:true — comportamentul lor (inclusiv resetarea paginii la schimbarea filtrului) ramane NESCHIMBAT de auto-refresh', () => {
  assert.match(js, /paidFilter\.addEventListener\('change', \(\) => \{ state\.paid = paidFilter\.value; state\.offset = 0; loadOrders\(\); loadFunnelSummary\(\); \}\);/);
  const syncFn = extractFn(js, "syncPeriodCheckbox.addEventListener('change', () => {");
  assert.match(syncFn, /applyPeriodSyncToOrdersFilter\(\);\s*[\s\S]*?loadFunnelSummary\(\);/);
  assert.doesNotMatch(syncFn, /loadFunnelSummary\(\{\s*silent/, 'apelurile explicite din listenerii de filtre nu trebuie sa treaca silent:true');
});

test('visibilitychange: la revenirea in prim-plan, reimprospateaza IMEDIAT STRICT daca a trecut deja cel putin un interval intreg de la ultima reimprospatare — un comutator rapid intre tab-uri NU declanseaza cereri suplimentare (fara dublare)', () => {
  const idx = js.indexOf("document.addEventListener('visibilitychange'");
  assert.ok(idx !== -1);
  const end = js.indexOf('\n}', idx);
  const block = js.slice(idx, end);
  assert.match(block, /if \(!document\.hidden && \(Date\.now\(\) - lastAutoRefreshAt\) >= AUTO_REFRESH_INTERVAL_MS\) \{/);
  assert.match(block, /autoRefreshTick\(\);/);
});

test('lastAutoRefreshAt: actualizat la INCEPUTUL fiecarui tick real (nu la final) — garanteaza ca garda de mai sus masoara corect timpul scurs, chiar daca fetch-urile dureaza', () => {
  const fn = extractFn(js, 'async function autoRefreshTick() {');
  const hiddenIdx = fn.indexOf('document.hidden) return;');
  const touchIdx = fn.indexOf('lastAutoRefreshAt = Date.now();');
  const kpiIdx = fn.indexOf('await loadFunnelSummary(');
  assert.ok(hiddenIdx !== -1 && touchIdx !== -1 && kpiIdx !== -1);
  assert.ok(hiddenIdx < touchIdx && touchIdx < kpiIdx, 'ordinea trebuie sa fie: verificare hidden -> marcare timestamp -> reimprospatari reale');
});

test('lastAutoRefreshAt: initializat la Date.now() chiar la incarcarea paginii (nu ramane undefined/0) — pagina abia incarcata are deja date proaspete, un revino-in-prim-plan imediat dupa nu trebuie sa forteze un refresh suplimentar redundant', () => {
  assert.match(js, /let lastAutoRefreshAt = Date\.now\(\);/);
});

// ================================================================================================
// Izolare — semantica de plata, nota explicativa, Nr. client, recovery emails, Meta Ads Faza A/B.
// ================================================================================================

test('semantica KPI=paid_at / tabel=created_at ramane NEATINSA — niciun query nou catre server.js/db.js introdus de acest fix (STRICT client-side)', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // nicio mentiune noua de "autoRefresh"/"AUTO_REFRESH" in backend — fixul e STRICT in orders.js
  assert.ok(!dbSrc.includes('AUTO_REFRESH') && !dbSrc.toLowerCase().includes('autorefresh'));
  assert.ok(!serverSrc.includes('AUTO_REFRESH') && !serverSrc.toLowerCase().includes('autorefresh'));
});

test('nota explicativa (create_at vs paid_at), adaugata la fixul anterior, ramane vizibila in orders.html — auto-refresh-ul nu a inlocuit-o', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.html'), 'utf8');
  assert.match(html, /Tabelul de mai jos filtrează după data creării comenzii/);
});

test('Nr. client server-side (db.getDistinctCustomerRanks) ramane neatins — nicio schimbare in server.js/db.js in aceasta corectie', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /db\.getDistinctCustomerRanks\(filterArgs\)/);
});

test('recovery emails (lib/recovery-emails/) si Meta Ads Faza A/B (lib/meta-ads/) raman COMPLET neatinse — auto-refresh-ul nu introduce niciun require nou catre acele module', () => {
  assert.ok(!js.includes('recovery-emails'));
  assert.ok(!js.includes('meta-ads'));
});
