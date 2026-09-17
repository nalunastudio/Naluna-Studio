// Verificare STRUCTURALA a rutelor admin de social publishing din server.js — server.js nu
// poate fi require()-uit direct in teste (porneste Postgres/Stripe reale la incarcare, ca
// restul suitei — vezi email-deliverability.test.js pentru acelasi tipar de verificare prin
// citirea sursei ca text). Comportamentul REAL al orchestrarii e acoperit in
// social-post-service.test.js; aici verificam DOAR cablarea: ca rutele exista, ca sunt
// inregistrate DUPA middleware-ul de autentificare admin (deci protejate automat), si ca NU
// duplica logica de orchestrare deja testata separat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server.js importa social-publisher si social-post-service (nu duplica logica inline)', () => {
  assert.ok(server.includes("require('./lib/social/social-publisher')"));
  assert.ok(server.includes("require('./lib/social/social-post-service')"));
});

test('POST /api/admin/social/publish exista si e inregistrata DUPA middleware-ul de autentificare admin', () => {
  const authIndex = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  const routeIndex = server.indexOf("app.post('/api/admin/social/publish'");
  assert.notEqual(authIndex, -1, 'middleware-ul de autentificare admin trebuie sa existe');
  assert.notEqual(routeIndex, -1, 'ruta de publicare trebuie sa existe');
  assert.ok(routeIndex > authIndex, 'ruta trebuie inregistrata DUPA middleware-ul de autentificare, ca sa fie protejata automat');
});

test('GET /api/admin/social/posts si /api/admin/social/posts/:id exista, dupa acelasi middleware', () => {
  const authIndex = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  const listIndex = server.indexOf("app.get('/api/admin/social/posts'");
  const detailIndex = server.indexOf("app.get('/api/admin/social/posts/:id'");
  assert.notEqual(listIndex, -1);
  assert.notEqual(detailIndex, -1);
  assert.ok(listIndex > authIndex && detailIndex > authIndex);
});

test('ruta POST /publish foloseste validatePublishRequest si executeSocialPublish (orchestrarea traieste STRICT in lib/social)', () => {
  const start = server.indexOf("app.post('/api/admin/social/publish'");
  const end = server.indexOf("app.post('/api/admin/social/schedule'", start);
  assert.notEqual(end, -1);
  const routeBody = server.slice(start, end);
  assert.match(routeBody, /validateSocialPublishRequest\(/);
  assert.match(routeBody, /executeSocialPublish\(/);
  // Nu trebuie sa apara logica de calcul al statusului final (allSuccess/allFailed) direct
  // in server.js — asta ar insemna ca a fost re-duplicata in loc sa fie reutilizata din lib/.
  assert.ok(!/allSuccess/.test(routeBody), 'calculul statusului final trebuie sa traiasca STRICT in executeSocialPublish, nu duplicat in ruta');
});

test('media pentru social urca STRICT prin storage.js (uploadPublicBuffer), fara un al doilea sistem de storage', () => {
  const start = server.indexOf('async function saveSocialMediaFile(file)');
  assert.notEqual(start, -1);
  const end = server.indexOf('\n}', start);
  const fnBody = server.slice(start, end);
  assert.match(fnBody, /storage\.uploadPublicBuffer\(/);
});

// ---------------- Etapa 3 — scheduling, cancel, retry, worker ----------------

test('server.js importa social-worker, instagram-token-store si instagram-token-lifecycle', () => {
  assert.ok(server.includes("require('./lib/social/social-worker')"));
  assert.ok(server.includes("require('./lib/social/instagram-token-store')"));
  assert.ok(server.includes("require('./lib/social/instagram-token-lifecycle')"));
});

test('POST /api/admin/social/schedule exista, dupa middleware-ul admin, si foloseste createScheduledPost + validateScheduleRequest', () => {
  const authIndex = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  const start = server.indexOf("app.post('/api/admin/social/schedule'");
  assert.notEqual(start, -1);
  assert.ok(start > authIndex);
  const end = server.indexOf("app.get('/api/admin/social/posts'", start);
  const routeBody = server.slice(start, end);
  assert.match(routeBody, /validateSocialScheduleRequest\(/);
  assert.match(routeBody, /createScheduledSocialPost\(/);
  // Programarea NU trebuie sa apeleze publicarea direct — asta ar insemna ca publica imediat
  // in loc sa lase workerul sa o preia la termen.
  assert.ok(!/publishSocialPost\(/.test(routeBody), 'programarea nu trebuie sa publice nimic sincron');
});

test('POST /api/admin/social/posts/:id/cancel si /retry exista, dupa middleware-ul admin, si folosesc db-ul (nu reimplementeaza logica atomica)', () => {
  const authIndex = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth)");
  const cancelIndex = server.indexOf("app.post('/api/admin/social/posts/:id/cancel'");
  const retryIndex = server.indexOf("app.post('/api/admin/social/posts/:id/retry'");
  assert.notEqual(cancelIndex, -1);
  assert.notEqual(retryIndex, -1);
  assert.ok(cancelIndex > authIndex && retryIndex > authIndex);

  const cancelEnd = server.indexOf("app.post('/api/admin/social/posts/:id/retry'", cancelIndex);
  const cancelBody = server.slice(cancelIndex, cancelEnd);
  assert.match(cancelBody, /db\.cancelScheduledSocialPost\(/);

  const retryEnd = server.indexOf("Reactii publicate", retryIndex);
  const retryBody = server.slice(retryIndex, retryEnd);
  assert.match(retryBody, /db\.retrySocialPostPlatform\(/);
});

test('worker-ul e pornit la boot (startSocialWorker), legat de db.initDb().then(...)', () => {
  const bootIndex = server.indexOf('db.initDb()');
  const startIndex = server.indexOf('startSocialWorker(');
  assert.notEqual(bootIndex, -1);
  assert.notEqual(startIndex, -1);
  assert.ok(startIndex > bootIndex, 'worker-ul trebuie pornit DUPA confirmarea conexiunii la Postgres, nu inainte');
});

test('alerta de token Instagram NU include niciodata accessToken in emailul construit', () => {
  const start = server.indexOf('async function sendInstagramTokenAlertEmail(state)');
  assert.notEqual(start, -1);
  const end = server.indexOf('\nlet socialWorkerHandle', start);
  const fnBody = server.slice(start, end);
  assert.ok(!/state\.accessToken/.test(fnBody), 'functia de alerta nu trebuie sa citeasca state.accessToken sub nicio forma');
});
