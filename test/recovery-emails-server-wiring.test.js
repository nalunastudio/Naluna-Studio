// server.js — verificare STATICA (acelasi tipar ca test/email-bounce-complaint-handling.test.js si
// test/meta-capi-server-wiring.test.js) a punctelor de integrare ale recovery emails: SAFE
// DISABLE implicit, gating la boot, hook-ul de enqueue la preview_ready, ruta de unsubscribe,
// refuzul de a trimite un reminder fara secret de unsubscribe configurat. O pornire reala a
// serverului ar necesita Postgres — vezi nota din email-bounce-complaint-handling.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
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

const server = read('server.js');

test('RECOVERY_EMAILS_ENABLED: implicit FALSE — STRICT "true" (string) il activeaza, ACELASI idiom ca STRIPE_AUTOMATIC_TAX_ENABLED', () => {
  assert.match(server, /const RECOVERY_EMAILS_ENABLED = process\.env\.RECOVERY_EMAILS_ENABLED === 'true';/);
});

test('boot: worker-ul de recovery emails NU porneste deloc daca RECOVERY_EMAILS_ENABLED e fals — gate explicit "if (RECOVERY_EMAILS_ENABLED)" inainte de startRecoveryEmailWorker', () => {
  const idx = server.indexOf('if (RECOVERY_EMAILS_ENABLED) {');
  assert.ok(idx !== -1, 'gate-ul explicit lipseste');
  const end = server.indexOf('\n      }', idx);
  const block = server.slice(idx, end);
  assert.match(block, /recoveryEmailWorkerHandle = startRecoveryEmailWorker\(/);
});

test('boot: cutoffSince (recovery_emails_first_enabled_at) e citit din app_settings si scris O SINGURA DATA — nu e resetat la fiecare boot', () => {
  const idx = server.indexOf('if (RECOVERY_EMAILS_ENABLED) {');
  const end = server.indexOf('\n      }', idx);
  const block = server.slice(idx, end);
  assert.match(block, /recoveryEmailsCutoffSince = await db\.getSetting\('recovery_emails_first_enabled_at'\);/);
  assert.match(block, /if \(!recoveryEmailsCutoffSince\)\s*\{/, 'scrierea trebuie sa fie CONDITIONATA de lipsa valorii existente');
  assert.match(block, /await db\.setSetting\('recovery_emails_first_enabled_at', recoveryEmailsCutoffSince\);/);
});

test('boot: db.initDb().then(...) e ASYNC — necesar pentru await-urile din blocul de pornire al recovery emails', () => {
  assert.match(server, /db\.initDb\(\)\s*\.then\(async \(\) => \{/);
});

test('enqueuePreviewReadyNotification: apelat in finalizeVariantsIfNeeded IMEDIAT dupa scrierea in DB (db.updateOrder(orderId, finalizePatch)), fire-and-forget', () => {
  const updateIdx = server.indexOf('await db.updateOrder(orderId, finalizePatch);');
  assert.ok(updateIdx !== -1);
  const nearby = server.slice(updateIdx, updateIdx + 700);
  assert.match(nearby, /enqueuePreviewReadyNotification\(\{ id: orderId, email: claimed\.email, lang: claimed\.lang \}\)\.catch\(\(\) => \{\}\);/);
});

test('enqueuePreviewReadyNotification: no-op explicit cand RECOVERY_EMAILS_ENABLED e oprit — nu doar "nu trimite", ci nici macar nu scrie in order_notifications', () => {
  const fn = extractFn(server, 'async function enqueuePreviewReadyNotification(order) {');
  assert.match(fn, /if \(!RECOVERY_EMAILS_ENABLED\) return;/);
});

test('enqueueOrderNotification e apelat cu ON CONFLICT DO NOTHING implicit (idempotent) pentru preview_ready — regenerari ulterioare NU retrimit', () => {
  const fn = extractFn(server, 'async function enqueuePreviewReadyNotification(order) {');
  assert.match(fn, /notificationType: 'preview_ready'/);
});

test('sendRecoveryNotificationEmail: reminder-ele (preview_recovery/checkout_recovery) refuza explicit sa trimita FARA RECOVERY_EMAIL_UNSUBSCRIBE_SECRET configurat', () => {
  const fn = extractFn(server, 'async function sendRecoveryNotificationEmail({ order, notification }) {');
  assert.match(fn, /if \(isReminderType && !RECOVERY_EMAIL_UNSUBSCRIBE_SECRET\)\s*\{/);
  assert.match(fn, /throw new Error/);
});

test('sendRecoveryNotificationEmail: preview_ready (operational) NU cere secretul de unsubscribe — isReminderType = notification.notificationType !== \'preview_ready\'', () => {
  const fn = extractFn(server, 'async function sendRecoveryNotificationEmail({ order, notification }) {');
  assert.match(fn, /const isReminderType = notification\.notificationType !== 'preview_ready';/);
});

test('sendRecoveryNotificationEmail: RESEND_API_KEY lipsa -> arunca explicit (nu trimite silentios nimic)', () => {
  const fn = extractFn(server, 'async function sendRecoveryNotificationEmail({ order, notification }) {');
  assert.match(fn, /if \(!process\.env\.RESEND_API_KEY\)\s*\{\s*throw new Error/);
});

test('unsubscribe: ruta GET /api/email-marketing/unsubscribe exista, PUBLICA (nu incepe cu /api/admin, deci nu e gated de requireAdminAuth)', () => {
  const idx = server.indexOf("app.get('/api/email-marketing/unsubscribe'");
  assert.ok(idx !== -1);
});

test('unsubscribe: verifica tokenul cu verifyUnsubscribeToken (HMAC timing-safe) inainte de a suprima — niciun email poate fi dezabonat fara token valid', () => {
  const idx = server.indexOf("app.get('/api/email-marketing/unsubscribe'");
  const end = server.indexOf('\n});', idx);
  const fn = server.slice(idx, end);
  assert.match(fn, /verifyUnsubscribeToken\(emailFromQuery, token\)/);
  assert.match(fn, /db\.addEmailMarketingSuppression\(emailFromQuery, 'unsubscribed'\)/);
});

test('verifyUnsubscribeToken: foloseste timingSafeEqual (nu comparare directa de string, vulnerabila la timing attack)', () => {
  const fn = extractFn(server, 'function verifyUnsubscribeToken(emailKey, token) {');
  assert.match(fn, /timingSafeEqual\(/);
});

test('createHmac importat din crypto (pentru buildUnsubscribeToken)', () => {
  assert.match(server, /const \{ randomUUID, randomBytes, timingSafeEqual, createHash, createHmac \} = require\('crypto'\);/);
});

test('escapeHtmlForEmail: mutat in lib/email-text.js (sursa unica), reimportat in server.js — comportament identic, reutilizabil de lib/recovery-emails/templates.js', () => {
  assert.match(server, /const \{ htmlToPlainText, escapeHtmlForEmail \} = require\('\.\/lib\/email-text'\);/);
  assert.ok(!server.includes('function escapeHtmlForEmail('), 'definitia veche, locala, nu mai trebuie sa existe in server.js');
  const emailText = read('lib/email-text.js');
  assert.match(emailText, /function escapeHtmlForEmail\(str\) \{/);
});

test('GET /api/admin/orders: ramane in continuare protejat de requireAdminAuth (app.use(\'/api/admin\', ...)) — neschimbat de aceasta implementare', () => {
  assert.match(server, /app\.use\('\/api\/admin', adminAuthLimiter, requireAdminAuth\);/);
});

test('izolare: Meta Ads Faza A/B (lib/meta-ads/, meta_ads_insights_daily) raman COMPLET neatinse de aceasta implementare — niciun require() nou catre acele fisiere din codul de recovery emails (o mentiune in comentariu, ca referinta la tiparul copiat, e acceptabila)', () => {
  const workerSrc = read('lib/recovery-emails/worker.js');
  const templatesSrc = read('lib/recovery-emails/templates.js');
  const eligibilitySrc = read('lib/recovery-emails/eligibility.js');
  for (const src of [workerSrc, templatesSrc, eligibilitySrc]) {
    assert.ok(!/require\([^)]*meta-ads/.test(src));
    assert.ok(!/require\([^)]*meta-capi/.test(src));
  }
});

test('izolare: nicio mentiune noua de payment_intent.payment_failed sau checkout.session.expired in codul de recovery emails (neimplementate, cerinta explicita din auditul anterior)', () => {
  const workerSrc = read('lib/recovery-emails/worker.js');
  assert.ok(!workerSrc.includes('payment_intent.payment_failed'));
  assert.ok(!workerSrc.includes('checkout.session.expired'));
});

// ==================================================================================
// EMAIL MARKETING OPT-OUT (2026-09-25, corectie PECR soft opt-in) — POST /api/orders
// ==================================================================================

test('POST /api/orders: emailMarketingOptOut STRICT boolean — orice altceva (lipsa/tip gresit) devine implicit false (soft opt-in: optiunea e OPTIONALA, niciodata obligatorie)', () => {
  const fn = extractFn(server, "app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {");
  assert.match(fn, /const safeEmailMarketingOptOut = emailMarketingOptOut === true;/);
});

test('POST /api/orders: daca a refuzat explicit, suprimarea (email_marketing_suppressions) se scrie SINCRON, inainte de db.createOrder', () => {
  const fn = extractFn(server, "app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {");
  const optOutIdx = fn.indexOf('const safeEmailMarketingOptOut = emailMarketingOptOut === true;');
  const suppressIdx = fn.indexOf('await db.addEmailMarketingSuppression(email.trim().toLowerCase(), \'opted_out_at_order_creation\');');
  const createOrderIdx = fn.indexOf('const order = await db.createOrder({');
  assert.ok(optOutIdx !== -1 && suppressIdx !== -1 && createOrderIdx !== -1);
  assert.ok(optOutIdx < suppressIdx && suppressIdx < createOrderIdx, 'ordinea trebuie sa fie: calcul -> suprimare (daca refuza) -> createOrder');
  assert.match(fn, /if \(safeEmailMarketingOptOut\)\s*\{\s*await db\.addEmailMarketingSuppression/);
});

test('POST /api/orders: db.createOrder primeste emailMarketingOptOut, emailMarketingChoiceAt (now) si emailMarketingPolicyVersion (EMAIL_MARKETING_POLICY_VERSION) — dovada server-side a alegerii/regulii aplicabile comenzii', () => {
  const fn = extractFn(server, "app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {");
  assert.match(fn, /emailMarketingOptOut: safeEmailMarketingOptOut,/);
  assert.match(fn, /emailMarketingChoiceAt: new Date\(\),/);
  assert.match(fn, /emailMarketingPolicyVersion: EMAIL_MARKETING_POLICY_VERSION/);
});

test('EMAIL_MARKETING_POLICY_VERSION: constanta distincta de CONSENT_POLICY_VERSION (versiuni independente — una acopera termenii Stripe, alta textul de opt-out de la colectarea emailului)', () => {
  assert.match(server, /const EMAIL_MARKETING_POLICY_VERSION = '2026-09-25-softoptin-v1';/);
});

test('db.js: email_marketing_opt_out = false e gate-ul de eligibilitate in interogarea SQL findDueRecoveryCandidates (verificare exacta a SQL-ului insusi, nu doar a comentariilor, in test/recovery-emails-db.test.js) — apare de cel putin 2 ori in fisier (SQL + documentare)', () => {
  const dbSrc = read('db.js');
  const occurrences = (dbSrc.match(/email_marketing_opt_out = false/g) || []).length;
  assert.ok(occurrences >= 2, `asteptat cel putin 2 aparitii, gasite ${occurrences}`);
});

test('lib/recovery-emails/eligibility.js: checkSendEligibility reverifica emailMarketingOptOut LA TRIMITERE (nu doar la scanare) — !== false respinge ATAT true CAT SI null/undefined, STRICT pentru reminderele de marketing', () => {
  const eligibilitySrc = read('lib/recovery-emails/eligibility.js');
  assert.match(eligibilitySrc, /if \(notificationType !== 'preview_ready' && order\.emailMarketingOptOut !== false\)\s*\{/);
  assert.match(eligibilitySrc, /reason: 'skipped_opted_out'/);
});

test('fisierele noi raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['lib/recovery-emails/retry.js', 'lib/recovery-emails/eligibility.js', 'lib/recovery-emails/templates.js', 'lib/recovery-emails/worker.js', 'lib/email-text.js', 'server.js', 'db.js']) {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', f)]);
  }
});
