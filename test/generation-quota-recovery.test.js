// RECUPERARE SECURIZATA A COMENZILOR (2026-09-27, cerinta explicita) — POST /api/orders/recover-access.
// Clientul, odata blocat de protectia impotriva generarilor gratuite repetate (vezi
// test/generation-quota-limit.test.js), poate cere sa i se retrimita pe email linkurile catre
// comenzile sale ELIGIBILE (accessToken existent, mecanism NEATINS) — FARA sa reintroducem
// cautarea "email -> lista de comenzi" eliminata deliberat din arhitectura (motivul exact pentru
// care accessToken e SINGURUL mod sanctionat de acces la o comanda).
//
// GARANTIA DE SECURITATE CENTRALA, testata exhaustiv mai jos: raspunsul HTTP public al acestui
// endpoint e STRICT identic (acelasi status 202, acelasi corp JSON) indiferent daca emailul
// exista, nu exista, are 0/1/mai multe comenzi eligibile, sau daca limitatorul per-email a sarit
// silentios peste trimiterea reala — niciun canal de enumerare posibil din continutul sau
// timpul raspunsului (raspunsul se trimite INAINTE de orice interogare DB/apel Resend).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const serverSrc = read('server.js');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractConstObject(src, name) {
  const idx = src.indexOf(`const ${name} = {`);
  assert.ok(idx !== -1, `${name} trebuie sa existe in server.js`);
  const end = src.indexOf('};', idx) + 2;
  return src.slice(idx, end);
}
function findMatchingBraceEnd(src, openIdx) {
  let depth = 0, i = openIdx;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('acolada nepereche');
}
function extractBraced(src, signature) {
  const idx = src.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let openIdx = src.indexOf('{', idx);
  // Daca "{" gasita e o destructurare de parametru (ex. "function foo({ email, lang })" — cel
  // mai apropiat caracter ne-spatiu dinaintea ei e "("), sare peste ea (pana la "}" ei pereche)
  // si cauta URMATOAREA "{" — aceea e inceputul real al corpului functiei.
  let before = src.slice(0, openIdx).trimEnd();
  if (before.endsWith('(')) {
    const paramBraceEnd = findMatchingBraceEnd(src, openIdx);
    openIdx = src.indexOf('{', paramBraceEnd);
  }
  const end = findMatchingBraceEnd(src, openIdx);
  return src.slice(idx, end + 1);
}

// ===============================================================================================
// (1) db.js#getEligibleOrdersForAccessRecovery — forma exacta a interogarii.
// ===============================================================================================
async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  const calls = [];
  db.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return dispatch(sql, params);
  };
  try {
    return await fn(calls);
  } finally {
    db.pool.query = original;
  }
}

test('getEligibleOrdersForAccessRecovery: exclude draft/generation_failed (ACELASI filtru ca numararea cotei), exclude ready cu media expirata, ordonat cronologic, cu plafon', async () => {
  await withMockPool(() => ({ rows: [] }), async (calls) => {
    await db.getEligibleOrdersForAccessRecovery('client@exemplu.ro');
    const call = calls[0];
    assert.match(call.sql, /status NOT IN \('draft', 'generation_failed'\)/);
    assert.match(call.sql, /status <> 'ready' OR final_media_expired_at IS NULL/);
    assert.match(call.sql, /ORDER BY created_at ASC/);
    assert.match(call.sql, /LIMIT 20/);
    assert.deepEqual(call.params, ['client@exemplu.ro']);
  });
});

test('getEligibleOrdersForAccessRecovery: randurile returnate trec prin rowToOrder (contin accessToken utilizabil pentru link-uri)', async () => {
  await withMockPool(
    () => ({
      rows: [
        { id: 'o1', access_token: 'a'.repeat(48), plan: 'standard', recipient: 'Maria', status: 'preview_ready', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }
      ]
    }),
    async () => {
      const orders = await db.getEligibleOrdersForAccessRecovery('client@exemplu.ro');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].accessToken, 'a'.repeat(48));
      assert.equal(orders[0].plan, 'standard');
      assert.equal(orders[0].recipient, 'Maria');
    }
  );
});

// ===============================================================================================
// (2) server.js — ruta: wiring middleware (limitatoare), NICIUN camp orderId/accessToken citit
// din request (endpoint-ul ia STRICT emailul).
// ===============================================================================================
test("server.js: POST /api/orders/recover-access e protejata de recoveryIpLimiter SI recoveryEmailTargetLimiter, FARA requireOrderToken (clientul nu are inca token)", () => {
  assert.match(serverSrc, /app\.post\('\/api\/orders\/recover-access', recoveryIpLimiter, recoveryEmailTargetLimiter, async/);
});

test('server.js: handler-ul NU citeste niciodata orderId/accessToken/token din request — STRICT email(+lang)', () => {
  const body = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  assert.ok(!/req\.body\??\.(orderId|accessToken|token)\b/.test(body), 'endpoint-ul nu trebuie sa citeasca niciun identificator de comanda din request');
});

test('server.js: exista EXACT UN singur res.status(...).json(...) in tot handler-ul — raspunsul nu se ramifica niciodata dupa rezultatul interogarii DB (garantia anti-enumerare)', () => {
  const body = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  const matches = body.match(/res\.status\(\d+\)\.json\(/g) || [];
  assert.equal(matches.length, 2, 'un singur raspuns de succes (202) + un singur raspuns pentru email lipsa (400, validare de camp obligatoriu, NU enumerare) — nimic altceva');
  assert.ok(body.includes('res.status(202).json'), 'raspunsul de succes trebuie sa fie 202');
  assert.ok(body.includes('res.status(400).json'), 'raspunsul pentru email lipsa/gol trebuie sa fie 400 (camp obligatoriu, nu existenta contului)');
});

test('server.js: raspunsul 202 e trimis INAINTE de orice interogare DB/trimitere email (fara canal de timing) — db.getEligibleOrdersForAccessRecovery apare DUPA res.status(202) in sursa', () => {
  const body = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  const resIdx = body.indexOf('res.status(202).json');
  const dbIdx = body.indexOf('db.getEligibleOrdersForAccessRecovery');
  assert.ok(resIdx !== -1 && dbIdx !== -1 && resIdx < dbIdx, 'interogarea DB trebuie sa vina STRICT dupa ce raspunsul a fost deja trimis');
});

test('server.js: raspunsul 202 nu contine niciodata accessToken/orders/email in corpul JSON', () => {
  const body = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  const idx = body.indexOf('res.status(202).json(');
  const end = body.indexOf(');', idx);
  const responseLiteral = body.slice(idx, end);
  assert.ok(!/accessToken|orders|email/i.test(responseLiteral), `raspunsul public nu trebuie sa contina date de comanda: "${responseLiteral}"`);
});

test('server.js: dupa raspuns, handler-ul verifica req.recoveryEmailThrottled si iese fara sa mai atinga DB/email daca limitatorul per-email a fost activat — raspunsul catre client ramane oricum identic (deja trimis)', () => {
  const body = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  const throttledIdx = body.indexOf('req.recoveryEmailThrottled');
  const resIdx = body.indexOf('res.status(202).json');
  assert.ok(throttledIdx > resIdx, 'verificarea flag-ului trebuie sa vina DUPA ce raspunsul a fost deja trimis');
});

// ===============================================================================================
// (3) Limitatoarele — recoveryIpLimiter (standard, raspuns propriu 429 — nu e o scurgere, e
// STRICT despre volumul DE CERERI al acelui IP) vs. recoveryEmailTargetLimiter (silentios,
// handler custom care NU trimite un raspuns propriu, ca sa nu creeze un canal de enumerare pe
// baza adresei tinta).
// ===============================================================================================
test('server.js: recoveryEmailTargetLimiter e cheiat STRICT pe emailul normalizat din body (nu pe IP) si handler-ul lui NU trimite un raspuns propriu — doar seteaza un flag si continua (next())', () => {
  const body = extractBraced(serverSrc, 'const recoveryEmailTargetLimiter = rateLimit(');
  assert.match(body, /keyGenerator:\s*\(req\)\s*=>\s*String\(req\.body\?\.email/);
  assert.match(body, /handler:\s*\(req, res, next\)\s*=>\s*\{\s*req\.recoveryEmailThrottled = true;\s*next\(\);\s*\}/);
  assert.ok(!/res\.status|res\.send|res\.json/.test(body), 'handler-ul limitatorului per-email NU trebuie sa trimita niciodata un raspuns propriu (ar crea un canal de enumerare)');
});

test('server.js: recoveryIpLimiter e un limitator STANDARD (raspuns 429 propriu, cheiat pe IP) — diferenta de raspuns e legata STRICT de volumul cererilor acelui IP, nu de vreo proprietate a emailului tinta', () => {
  const body = extractBraced(serverSrc, 'const recoveryIpLimiter = rateLimit(');
  assert.match(body, /keyGenerator:\s*realClientIp/);
  assert.match(body, /message:\s*\{\s*error:/);
});

// ===============================================================================================
// (4) Mesajul public generic (RECOVERY_REQUEST_ACCEPTED_MESSAGES) — 8 limbi, distincte.
// ===============================================================================================
test('server.js: RECOVERY_REQUEST_ACCEPTED_MESSAGES contine toate cele 8 limbi, traduceri distincte', () => {
  const objSrc = extractConstObject(serverSrc, 'RECOVERY_REQUEST_ACCEPTED_MESSAGES');
  const map = new Function(objSrc + '\nreturn RECOVERY_REQUEST_ACCEPTED_MESSAGES;')();
  for (const lang of ALLOWED_LANGS) {
    assert.ok(typeof map[lang] === 'string' && map[lang].length > 10, `${lang} trebuie sa aiba un text real`);
  }
  assert.equal(new Set(Object.values(map)).size, ALLOWED_LANGS.length);
});

// ===============================================================================================
// (5) sendAccessRecoveryEmail — email OPERATIONAL, independent de RECOVERY_EMAILS_ENABLED/worker-ul
// automat, fara promotii, cu accessToken STRICT in link (niciodata logat).
// ===============================================================================================
test('server.js: sendAccessRecoveryEmail NU verifica/foloseste RECOVERY_EMAILS_ENABLED si nu apeleaza nimic din worker-ul automat (lib/recovery-emails/) — email operational independent', () => {
  const body = extractBraced(serverSrc, 'async function sendAccessRecoveryEmail(');
  assert.ok(!/RECOVERY_EMAILS_ENABLED/.test(body));
  assert.ok(!/recoveryEmailWorkerHandle|checkSendEligibility|order_notifications/.test(body));
  assert.match(body, /RESEND_API_KEY/, 'trebuie sa foloseasca Resend direct, ca sendDeliveryEmail');
});

test('server.js: sendAccessRecoveryEmail NU contine nicio mentiune de promotie/reducere/upsell', () => {
  const body = extractBraced(serverSrc, 'async function sendAccessRecoveryEmail(');
  assert.ok(!/discount|reducer|promo|upsell|ofert/i.test(body));
});

test('server.js: sendAccessRecoveryEmail respecta email_suppressions (isEmailSuppressed), exact ca sendDeliveryEmail', () => {
  const body = extractBraced(serverSrc, 'async function sendAccessRecoveryEmail(');
  assert.match(body, /db\.isEmailSuppressed\(email\)/);
});

test('server.js: link-ul din emailul de recuperare foloseste EXACT acelasi mecanism de acces (comanda-mea.html?token=) ca livrarea normala — nicio ruta/bypass noua', () => {
  const body = extractBraced(serverSrc, 'async function sendAccessRecoveryEmail(');
  assert.match(body, /\$\{DOMAIN\}\/comanda-mea\.html\?token=\$\{order\.accessToken\}/);
});

test('server.js: niciun console.log/warn/error din sendAccessRecoveryEmail NU interpoleaza accessToken — tokenul nu ajunge niciodata in loguri', () => {
  const body = extractBraced(serverSrc, 'async function sendAccessRecoveryEmail(');
  const consoleCalls = body.match(/console\.(log|warn|error)\([^)]*\)/g) || [];
  for (const call of consoleCalls) {
    assert.ok(!/accessToken/.test(call), `un console.* nu trebuie sa contina accessToken: "${call}"`);
  }
});

test('server.js: PLAN_DISPLAY_NAMES acopera standard/premium/video in toate cele 8 limbi', () => {
  const objSrc = extractConstObject(serverSrc, 'PLAN_DISPLAY_NAMES');
  const map = new Function(objSrc + '\nreturn PLAN_DISPLAY_NAMES;')();
  for (const plan of ['standard', 'premium', 'video']) {
    for (const lang of ALLOWED_LANGS) {
      assert.ok(typeof map[plan][lang] === 'string' && map[plan][lang].length > 0, `${plan}.${lang} trebuie sa existe`);
    }
  }
});

// ===============================================================================================
// (6) COMPORTAMENT REAL, sandbox — handler-ul executat cu dependinte mocate, verificand:
// raspuns identic pentru email inexistent/0 comenzi/mai multe comenzi/limitat silentios.
// ===============================================================================================
function loadRecoverAccessHandler(mocks) {
  const handlerSrc = extractBraced(serverSrc, "app.post('/api/orders/recover-access'");
  // "async (req, res, next) => { ... }" -> extrage DOAR corpul functiei (handlerSrc contine tot
  // apelul app.post(...) pana la ")" final) — reconstruim strict functia din interior.
  const asyncIdx = serverSrc.indexOf('async (req, res, next) => {', serverSrc.indexOf("app.post('/api/orders/recover-access'"));
  let depth = 0, i = serverSrc.indexOf('{', asyncIdx);
  const start = asyncIdx;
  for (; i < serverSrc.length; i++) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnSrc = serverSrc.slice(start, i + 1);

  const invalidEmailSrc = extractConstObject(serverSrc, 'INVALID_EMAIL_MESSAGES');
  const invalidEmailFnStart = serverSrc.indexOf('function invalidEmailMessage');
  const invalidEmailFnSrc = extractBraced(serverSrc, 'function invalidEmailMessage');
  const acceptedSrc = extractConstObject(serverSrc, 'RECOVERY_REQUEST_ACCEPTED_MESSAGES');
  const acceptedFnSrc = extractBraced(serverSrc, 'function recoveryRequestAcceptedMessage');

  const sandboxSrc = `
    const ALLOWED_LANGS = ${JSON.stringify(ALLOWED_LANGS)};
    ${invalidEmailSrc}
    ${invalidEmailFnSrc}
    ${acceptedSrc}
    ${acceptedFnSrc}
    return ${fnSrc};
  `;
  return new Function('db', 'sendAccessRecoveryEmail', 'console', sandboxSrc)(mocks.db, mocks.sendAccessRecoveryEmail, mocks.console || console);
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('sandbox: email inexistent (0 comenzi eligibile) -> raspuns 202 identic, sendAccessRecoveryEmail NICIODATA apelat', async () => {
  let sendCalled = false;
  const handler = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async () => [] },
    sendAccessRecoveryEmail: async () => { sendCalled = true; }
  });
  const req = { body: { email: 'nu-exista@exemplu.ro', lang: 'ro' } };
  const res = fakeRes();
  await handler(req, res, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(res.statusCode, 202);
  assert.equal(sendCalled, false, '0 comenzi eligibile -> niciun email trimis, dar raspunsul catre client nu se schimba');
});

test('sandbox: email cu 2 comenzi eligibile -> raspuns 202 IDENTIC (acelasi status/corp) fata de cazul "0 comenzi", email TRIMIS de data asta', async () => {
  let sentWith = null;
  const handler = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async () => [{ id: 'o1' }, { id: 'o2' }] },
    sendAccessRecoveryEmail: async (args) => { sentWith = args; }
  });
  const req = { body: { email: 'exista@exemplu.ro', lang: 'ro' } };
  const res = fakeRes();
  await handler(req, res, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(res.statusCode, 202);
  assert.ok(sentWith, 'cu comenzi eligibile, emailul chiar trebuie trimis');
  assert.equal(sentWith.orders.length, 2);
});

test('sandbox: raspunsul (status + corp JSON) e BYTE-IDENTIC intre "0 comenzi" si "2 comenzi" pentru acelasi lang — nicio diferenta observabila de catre apelant', async () => {
  const res0 = fakeRes();
  const handler0 = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async () => [] },
    sendAccessRecoveryEmail: async () => {}
  });
  await handler0({ body: { email: 'a@exemplu.ro', lang: 'en' } }, res0, () => {});
  await new Promise((r) => setImmediate(r));

  const res2 = fakeRes();
  const handler2 = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async () => [{ id: 'o1' }, { id: 'o2' }] },
    sendAccessRecoveryEmail: async () => {}
  });
  await handler2({ body: { email: 'b@exemplu.ro', lang: 'en' } }, res2, () => {});
  await new Promise((r) => setImmediate(r));

  assert.equal(res0.statusCode, res2.statusCode);
  assert.deepEqual(res0.body, res2.body);
});

test('sandbox: cerere limitata silentios (req.recoveryEmailThrottled=true) -> raspuns 202 IDENTIC, dar NICIO interogare DB si NICIUN email trimis', async () => {
  let dbCalled = false, sendCalled = false;
  const handler = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async () => { dbCalled = true; return [{ id: 'o1' }]; } },
    sendAccessRecoveryEmail: async () => { sendCalled = true; }
  });
  const req = { body: { email: 'hartuit@exemplu.ro', lang: 'ro' }, recoveryEmailThrottled: true };
  const res = fakeRes();
  await handler(req, res, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(res.statusCode, 202, 'raspunsul ramane identic chiar daca limitatorul per-email a fost activat — altfel ar dezvalui ca aceasta adresa a fost solicitata de multe ori');
  assert.equal(dbCalled, false);
  assert.equal(sendCalled, false);
});

test('sandbox: email lipsa/gol -> 400 (validare de camp obligatoriu, nu enumerare) in toate cele 8 limbi', async () => {
  for (const lang of ALLOWED_LANGS) {
    const handler = loadRecoverAccessHandler({
      db: { getEligibleOrdersForAccessRecovery: async () => [] },
      sendAccessRecoveryEmail: async () => {}
    });
    const res = fakeRes();
    await handler({ body: { email: '', lang } }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  }
});

test('sandbox: email cu spatii/majuscule (" Client@Exemplu.RO ") -> lookup-ul foloseste versiunea normalizata (lower+trim), emailul REAL (fara normalizare) e cel folosit pentru trimiterea catre Resend', async () => {
  let lookupKey = null, sentTo = null;
  const handler = loadRecoverAccessHandler({
    db: { getEligibleOrdersForAccessRecovery: async (key) => { lookupKey = key; return [{ id: 'o1' }]; } },
    sendAccessRecoveryEmail: async ({ email }) => { sentTo = email; }
  });
  const res = fakeRes();
  await handler({ body: { email: '  Client@Exemplu.RO  ', lang: 'ro' } }, res, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(lookupKey, 'client@exemplu.ro');
  assert.equal(sentTo, 'Client@Exemplu.RO', 'Resend trebuie sa primeasca adresa reala (trimmed), nu neaparat cu litere mici fortate');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
