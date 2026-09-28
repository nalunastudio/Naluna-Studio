// BLOCKER URGENT (2026-09-28, audit + fix complet) — client blocat de quota (3/7, server-side,
// neschimbata) ajungea intr-un DEAD-END: comenzile-mele.html afisa simultan "ai atins limita" SI
// "nu am gasit nicio comanda" (browser fara tokenuri locale — quota e verificata dupa EMAIL, nu
// dupa browser), iar Back nu revenea la email gate (STEP_KEY ramanea setat, sarind gate-ul la loc
// in acelasi pas blocat al wizard-ului). In plus, testarea repetata a acestui dead-end a creat
// randuri "draft" reale in DB (confirmat prin audit direct — vezi raportul): STRICT randuri, NU
// generari — music_task_id=null, generation_attempts=0, variants=[] pentru toate.
//
// Acest fisier acopera STRICT fixurile noi (fara sa duplice test/generation-quota-limit.test.js,
// deja exhaustiv pentru claimOrderForInitialGeneration/race-safety/3-7/reset-plata — reverificat
// mai jos ca ramane rulat neschimbat, nu ca e re-testat aici).
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
const server = read('server.js');
const ordersJs = read('private/admin/orders.js');
const ordersHtml = read('private/admin/orders.html');
const dashboardJs = read('private/admin/dashboard.js');
const funnelMath = read('lib/funnel-math.js');

// ===============================================================================================
// A. ORDER CREATION / QUOTA — ordinea REALA (audit): draft creation e complet libera/gratuita,
// quota se verifica STRICT la /generate, in interiorul claimOrderForInitialGeneration. Suno NU e
// apelat niciodata inainte de acel claim.
// ===============================================================================================
test('AUDIT: POST /api/orders (creare comanda) NU contine niciun cod de verificare quota — draft creation ramane STRICT libera/gratuita, exact ca inainte de aceasta protectie', () => {
  const idx = server.indexOf("app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {");
  const end = server.indexOf("res.json({ orderId: order.id, accessToken: order.accessToken });");
  const body = server.slice(idx, end);
  assert.ok(!body.includes('claimOrderForInitialGeneration'));
  assert.ok(!body.includes('FREE_GENERATION_LIMIT'));
  assert.ok(!body.includes('quotaBlocked'));
  assert.match(body, /status: 'draft'/);
});

test('AUDIT: ruta /generate verifica quotaBlocked SI returneaza 403 STRICT INAINTE de orice referinta la runGeneration() — Suno nu e apelat niciodata pentru o comanda blocata de quota', () => {
  const idx = server.indexOf("app.post('/api/orders/:orderId/generate', generationLimiter, requireOrderToken, async (req, res, next) => {");
  const end = server.indexOf("app.post('/api/orders/recover-access'", idx);
  const body = server.slice(idx, end);
  const quotaBlockIdx = body.indexOf('if (quotaBlocked) {');
  const statusIdx = body.indexOf("return res.status(403).json({ error: generationQuotaBlockedMessage(order.lang) });");
  const runGenerationIdx = body.indexOf('runGeneration(order.id, feedback)');
  assert.ok(quotaBlockIdx !== -1 && statusIdx !== -1 && runGenerationIdx !== -1);
  assert.ok(quotaBlockIdx < statusIdx, 'verificarea quotaBlocked trebuie sa preceada raspunsul 403');
  assert.ok(statusIdx < runGenerationIdx, 'raspunsul 403 (si return-ul asociat) trebuie sa preceada STRICT orice apel runGeneration() — Suno nu poate fi atins pe ramura blocata');
});

test('AUDIT: claimOrderForInitialGeneration NU modifica statusul/generation_attempts cand quotaBlocked=true — o comanda blocata ramane STRICT "draft", cu 0 incercari, exact starea gasita in productie pentru cele doua randuri din 18:50/18:51', () => {
  const db = read('db.js');
  const idx = db.indexOf('async function claimOrderForInitialGeneration(orderId, maxAttempts, emailKey, skipQuota) {');
  const end = db.indexOf('// RECUPERARE SECURIZATA A COMENZILOR', idx);
  const body = db.slice(idx, end);
  const returnBlockedIdx = body.indexOf('return { order: null, quotaBlocked: true };');
  const updateIdx = body.indexOf('UPDATE orders');
  assert.ok(returnBlockedIdx !== -1 && updateIdx !== -1);
  assert.ok(returnBlockedIdx < updateIdx, 'return-ul de quotaBlocked trebuie sa preceada STRICT orice UPDATE — niciun rand nu e atins cand e blocat');
});

// ===============================================================================================
// B. BACK/NAVIGATION — comanda.html: STEP_KEY curatat pe ramura de blocare quota + pageshow
// (bfcache) fortand un reload real la Back/Forward, pe mobil (Chrome/Safari) si desktop.
// ===============================================================================================
test('comanda.html: la 403 (quota), STEP_KEY e curatat INAINTE de redirect — Back/reload ulterior nu mai sare gate-ul (gateAlreadyPassed devine fals)', () => {
  const idx = comanda.indexOf('if (generateRes.status === 403) {');
  const end = comanda.indexOf("window.location.href = '/comenzile-mele.html?blocked=1';", idx) + 60;
  const body = comanda.slice(idx, end);
  assert.match(body, /localStorage\.removeItem\(STEP_KEY\);/);
});

test('comanda.html: DRAFT_KEY (povestea/destinatarul/etc.) NU e curatat pe ramura de blocare quota — clientul nu retasteaza nimic daca alege sa continue cu alt email', () => {
  const idx = comanda.indexOf('if (generateRes.status === 403) {');
  const end = comanda.indexOf("window.location.href = '/comenzile-mele.html?blocked=1';", idx) + 60;
  const body = comanda.slice(idx, end);
  assert.ok(!/removeItem\(DRAFT_KEY\)/.test(body), 'DRAFT_KEY nu trebuie sters pe aceasta ramura (poate fi mentionat STRICT in comentarii explicative)');
});

test('comanda.html: un handler pageshow forteaza reload la restaurare din bfcache (event.persisted) — Back/Forward pe mobil Chrome/Safari re-evalueaza STRICT starea curenta din localStorage, nu DOM-ul vechi cache-uit', () => {
  assert.match(comanda, /window\.addEventListener\('pageshow', \(event\) => \{\s*\n\s*if \(event\.persisted\) \{\s*\n\s*window\.location\.reload\(\);/);
});

test('comanda.html: node --check (indirect, via sintaxa scriptului inline) trece dupa modificari — nicio eroare introdusa', () => {
  const re = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g;
  const matches = [...comanda.matchAll(re)];
  const script = matches[matches.length - 1][1];
  assert.doesNotThrow(() => new Function(script));
});

// ===============================================================================================
// C. RECOVERY AUTOMAT SECURIZAT — emailul TOCMAI folosit pentru verificarea quota e transmis
// STRICT prin sessionStorage (consum unic), niciodata URL/query, niciodata localStorage
// persistent. comenzile-mele.html il citeste O SINGURA DATA, il sterge imediat, si porneste
// STRICT acelasi endpoint public deja auditat.
// ===============================================================================================
test('comanda.html: emailul e stocat STRICT in sessionStorage (NICIODATA in URL-ul catre comenzile-mele.html, NICIODATA in localStorage) — cheia naluna_pending_recovery_email', () => {
  const idx = comanda.indexOf('if (generateRes.status === 403) {');
  const end = comanda.indexOf("window.location.href = '/comenzile-mele.html?blocked=1';", idx) + 60;
  const body = comanda.slice(idx, end);
  assert.match(body, /sessionStorage\.setItem\('naluna_pending_recovery_email', emailForRecovery\)/);
  assert.match(body, /window\.location\.href = '\/comenzile-mele\.html\?blocked=1';/, 'URL-ul catre comenzile-mele.html ramane STRICT ?blocked=1, fara emailul in query');
  assert.ok(!/comenzile-mele\.html\?blocked=1[^']*email/.test(body), 'niciun email in URL-ul de redirect');
});

test('comenzile-mele.html: sessionStorage e citit O SINGURA DATA si sters IMEDIAT (consum unic) — nu ramane disponibil pentru o vizita ulterioara neinrudita', () => {
  const idx = comenzileMele.indexOf('let pendingRecoveryEmail');
  const end = comenzileMele.indexOf('async function resolveIncomingTokens');
  const body = comenzileMele.slice(idx, end);
  assert.match(body, /sessionStorage\.getItem\('naluna_pending_recovery_email'\)/);
  assert.match(body, /sessionStorage\.removeItem\('naluna_pending_recovery_email'\)/);
});

test('comenzile-mele.html: recovery-ul automat foloseste STRICT acelasi endpoint public deja auditat (POST /api/orders/recover-access, {email, lang}) — niciun sistem paralel', () => {
  const idx = comenzileMele.indexOf('async function triggerAutoRecovery(email) {');
  const end = comenzileMele.indexOf('async function loadAndRenderOrders');
  const body = comenzileMele.slice(idx, end);
  assert.match(body, /fetch\('\/api\/orders\/recover-access', \{/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /body: JSON\.stringify\(\{ email, lang \}\)/);
});

test('comenzile-mele.html: recovery automat se declanseaza STRICT cand (a) NU exista comenzi vizibile SI (b) exista un email transmis — niciodata cand exista deja comenzi vizibile (tokenurile locale au prioritate, niciodata suprascrise)', () => {
  const idx = comenzileMele.indexOf('function handleNoVisibleOrders() {');
  const end = comenzileMele.indexOf('async function triggerAutoRecovery');
  const body = comenzileMele.slice(idx, end);
  assert.match(body, /if \(pendingRecoveryEmail\) \{\s*\n\s*triggerAutoRecovery\(pendingRecoveryEmail\);/);
  // handleNoVisibleOrders() e apelat STRICT din cele doua ramuri "nicio comanda vizibila" —
  // niciodata cand eligible.length > 0 (verificat separat, testul de mai jos).
  assert.match(comenzileMele, /if \(known\.length === 0\) \{\s*\n\s*loadingEl\.style\.display = 'none';\s*\n\s*handleNoVisibleOrders\(\);/);
  // CORECTIE (2026-09-28, audit "4 comenzi salvate" vs "0"): cand eligible.length===0, se apeleaza
  // handleNoVisibleOrders() STRICT daca nu exista intrari 'unknown' (neverificabile din cauza unei
  // erori de retea/server) — acelea primesc acum un mesaj distinct (verify_error), NU o afirmatie
  // falsa de "nicio comanda" si NU recovery automat inutil. Vezi
  // test/gate-count-vs-list-contradiction.test.js pentru comportamentul complet.
  const eligibleZeroIdx = comenzileMele.indexOf('if (eligible.length === 0) {');
  const eligibleZeroBody = comenzileMele.slice(eligibleZeroIdx, comenzileMele.indexOf('\n    }', comenzileMele.indexOf('handleNoVisibleOrders();', eligibleZeroIdx)) + 6);
  assert.match(eligibleZeroBody, /if \(hasUnverified\) \{/);
  assert.match(eligibleZeroBody, /handleNoVisibleOrders\(\);/);
});

// ===============================================================================================
// D. "FOLOSESTE ALT EMAIL" — revine la email gate, sterge STRICT STEP_KEY, NICIODATA
// naluna_my_order_keys (comenzile autorizate) sau nds_form_draft (draftul formularului).
// ===============================================================================================
test('comenzile-mele.html: butonul "Foloseste alt email" sterge STRICT STEP_KEY (currentStep) si navigheaza la /comanda.html — email gate se re-arata acolo (gateAlreadyPassed devine fals)', () => {
  const idx = comenzileMele.indexOf("document.getElementById('use-other-email-btn').addEventListener('click'");
  const end = comenzileMele.indexOf('});', idx) + 3;
  const body = comenzileMele.slice(idx, end);
  assert.match(body, /localStorage\.removeItem\('currentStep'\)/);
  assert.match(body, /window\.location\.href = '\/comanda\.html'/);
  assert.ok(!body.includes('naluna_my_order_keys'), 'NU trebuie sa stearga comenzile autorizate');
  assert.ok(!body.includes('nds_form_draft'), 'NU trebuie sa stearga draftul formularului (destinatar/poveste/etc.)');
});

test('comanda.html: STEP_KEY foloseste STRICT cheia "currentStep" (aceeasi cheie pe care "Foloseste alt email" o sterge din comenzile-mele.html) — cele doua pagini raman sincronizate pe acelasi mecanism', () => {
  assert.match(comanda, /const STEP_KEY = 'currentStep';/);
});

// ===============================================================================================
// E. MESAJE CONTRADICTORII ELIMINATE — "Nu am gasit nicio comanda" nu mai apare ALATURI de
// banner-ul de blocare quota (era exact contradictia raportata).
// ===============================================================================================
test('comenzile-mele.html: cand wasBlocked e adevarat, handleNoVisibleOrders() NU mai adauga paragraful "empty_no_orders" — STRICT banner-ul (blocked_empty), fara mesaj dublu/contradictoriu', () => {
  const idx = comenzileMele.indexOf('function handleNoVisibleOrders() {');
  const end = comenzileMele.indexOf('async function triggerAutoRecovery');
  const body = comenzileMele.slice(idx, end);
  const ifBlockedIdx = body.indexOf('if (wasBlocked) {');
  const elseIdx = body.indexOf('} else {', ifBlockedIdx);
  const blockedBranch = body.slice(ifBlockedIdx, elseIdx);
  const elseBranch = body.slice(elseIdx, body.indexOf('}', elseIdx + 200));
  assert.ok(!blockedBranch.includes('empty_no_orders'), 'ramura wasBlocked nu trebuie sa mai afiseze empty_no_orders');
  assert.ok(elseBranch.includes('empty_no_orders'), 'ramura NEBLOCATA (fara context de quota) trebuie sa pastreze mesajul clarificator');
});

// ===============================================================================================
// F. ADMIN/FUNNEL — semantica corecta: "Nefinalizata" (fara generare pornita), NU "Neplatita"
// (care ar sugera fals o melodie deja generata, doar neplatita).
// ===============================================================================================
test('Admin: eticheta statusului "draft" NU mai e "Neplătită" (mislabeling confirmat prin audit — sugera fals o melodie deja generata) — noua eticheta e explicit "fara generare pornita", in toate cele 3 locuri (orders.js tabel, orders.html filtru, dashboard.js)', () => {
  assert.ok(!ordersJs.includes("draft: 'Neplătită'"));
  assert.ok(!ordersHtml.includes('<option value="draft">Neplătită</option>'));
  assert.ok(!dashboardJs.includes("draft: 'Neplătită'"));
  assert.match(ordersJs, /draft: 'Nefinalizată \(fără generare pornită\)'/);
  assert.match(ordersHtml, /<option value="draft">Nefinalizată \(fără generare pornită\)<\/option>/);
  assert.match(dashboardJs, /draft: 'Nefinalizată \(fără generare pornită\)'/);
});

test('Admin: celelalte etichete de status (generating/processing_provider_result/preview_ready/ready/generation_failed) raman STRICT neschimbate — DOAR eticheta "draft" a fost corectata', () => {
  for (const [status, label] of [
    ['generating', 'Se compune'], ['processing_provider_result', 'Se finalizează'],
    ['preview_ready', 'Previzualizare gata'], ['ready', 'Plătită și livrată'], ['generation_failed', 'Eroare']
  ]) {
    assert.ok(ordersJs.includes(`${status}: '${label}'`) || ordersJs.includes(`  ${status}: '${label}'`), `orders.js: ${status} trebuie sa ramana "${label}"`);
    assert.ok(dashboardJs.includes(`${status}: '${label}'`), `dashboard.js: ${status} trebuie sa ramana "${label}"`);
  }
});

test('Admin/funnel: "Comenzi create" (ordersCreated) NUMARA STRICT randuri din tabela orders, fara filtru de status — eticheta insasi spune "create", niciodata "generate"/"melodii" — NU s-a modificat aceasta logica (draft-urile raman incluse, cum era si inainte, e un KPI documentat ca atare)', () => {
  const db = read('db.js');
  const idx = db.indexOf('const ordersCreatedSql = `');
  const end = db.indexOf('`;', idx);
  const sql = db.slice(idx, end);
  assert.ok(!/status/i.test(sql), 'ordersCreatedSql nu trebuie sa filtreze dupa status (KPI neschimbat, doar eticheta Admin corectata separat)');
});

test('lib/funnel-math.js: Conversion Funnel-ul cohortat NU are nicio etapa "generare"/"melodie generata" — STRICT Comenzi create / Au ajuns la checkout / Au fost platite — nicio conflatie intre "order created" si "generation completed"', () => {
  assert.match(funnelMath, /const COHORT_STAGES = \[/);
  assert.ok(!/generat/i.test(funnelMath.slice(funnelMath.indexOf('COHORT_STAGES'), funnelMath.indexOf('function computeCohortFunnel'))), 'etapele cohortate nu trebuie sa mentioneze "generare"');
});

test('node --check pentru fisierele Admin modificate (orders.js, dashboard.js) trece', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'dashboard.js')]));
});

// ===============================================================================================
// G. NICIO SCURGERE — email/accessToken/sessionStorage nu ajung in analytics, console, sau URL.
// ===============================================================================================
test('comanda.html si comenzile-mele.html: NICIUN apel NalunaAnalytics/console.* nu foloseste emailForRecovery/pendingRecoveryEmail/naluna_pending_recovery_email', () => {
  for (const [name, src] of [['comanda.html', comanda], ['comenzile-mele.html', comenzileMele]]) {
    const analyticsCalls = [...src.matchAll(/NalunaAnalytics\.[a-zA-Z]+\([^)]*\)/g)];
    analyticsCalls.forEach((m) => {
      assert.ok(!/emailForRecovery|pendingRecoveryEmail|naluna_pending_recovery_email/.test(m[0]), `[${name}] apel analytics nu trebuie sa contina emailul de recovery: ${m[0]}`);
    });
    const consoleCalls = [...src.matchAll(/console\.[a-zA-Z]+\([^)]*\)/g)];
    consoleCalls.forEach((m) => {
      assert.ok(!/emailForRecovery|pendingRecoveryEmail/.test(m[0]), `[${name}] apel console nu trebuie sa contina emailul de recovery: ${m[0]}`);
    });
  }
});

test('comenzile-mele.html: URL-ul ramane STRICT ?blocked=1 (sau token/tokens, deja auditate) — niciodata cu parametrul email in query string', () => {
  assert.ok(!/params\.get\('email'\)/.test(comenzileMele));
  assert.ok(!/searchParams\.get\('email'\)/.test(comenzileMele));
});
