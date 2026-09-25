// ORDINE DE BOOT — joburile de retentie DB-dependente (2026-09-18, corectie incident productie).
// Regresie directa: purgeStaleFunnelEvents() (si, structural, celelalte 3 joburi de retentie)
// porneau INAINTE ca db.initDb() sa fi creat schema, producand "relation funnel_events does not
// exist" la primul boot dupa introducerea tabelei. Corectat mutand pornirea (apel imediat +
// setInterval) a tuturor celor 4 joburi in interiorul db.initDb().then(...). Acest fisier
// demonstreaza STATIC (acelasi tipar ca test/track-endpoint.test.js — numarare de acolade, nu
// doar ordine textuala) ca regresia nu mai e posibila.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const JOBS = ['purgeStaleSourceMedia', 'expireStaleFinalMedia', 'anonymizeStaleStories', 'purgeStaleFunnelEvents'];

// Extrage corpul REAL al unei functii/handler prin numarare de acolade — vezi
// test/track-endpoint.test.js pentru motivatia completa (a prins deja o regresie reala in
// productie: cod plasat textual "intre" doua puncte cautate de un test bazat pe indexOf, dar in
// realitate in afara scope-ului corect).
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

const idxInitDbCall = server.indexOf('db.initDb()');
// CORECTIE (2026-09-25, recovery emails): .then(() => {...}) a devenit .then(async () => {...})
// — necesar pentru await-urile din pornirea conditionata a worker-ului de recovery emails
// (citirea/scrierea o singura data a cutoffSince in app_settings). Comportamentul de fire-and-
// forget al celor 4 joburi de retentie, verificat mai jos, ramane NESCHIMBAT.
const thenBody = extractFn(server, 'db.initDb()\n    .then(async () => {');

test('CRITIC (regresie directa) — niciunul din cele 4 apeluri imediate de retentie nu apare INAINTE de db.initDb() in fisier', () => {
  for (const job of JOBS) {
    const idxImmediateCall = server.indexOf(`${job}().catch(() => {});`);
    assert.ok(idxImmediateCall !== -1, `apelul imediat pentru ${job} trebuie sa existe`);
    assert.ok(idxImmediateCall > idxInitDbCall, `${job}() nu trebuie sa porneasca inainte de db.initDb() (index ${idxImmediateCall} vs ${idxInitDbCall})`);
  }
});

test('toate cele 4 joburi (apel imediat + setInterval) sunt REAL in interiorul callback-ului de succes db.initDb().then(() => {...}) — verificat prin numarare de acolade, nu ordine textuala', () => {
  for (const job of JOBS) {
    assert.match(thenBody, new RegExp(`${job}\\(\\)\\.catch\\(\\(\\) => \\{\\}\\);`), `${job}() trebuie apelat imediat, in interiorul .then()`);
    assert.match(thenBody, new RegExp(`setInterval\\(\\(\\) => \\{ ${job}\\(\\)\\.catch\\(\\(\\) => \\{\\}\\); \\}, 24 \\* 60 \\* 60 \\* 1000\\)\\.unref\\(\\);`), `setInterval pentru ${job} trebuie sa fie in interiorul .then()`);
  }
});

test('exact UN apel imediat si exact UN setInterval pentru fiecare job, in tot fisierul — nicio duplicare, niciun mecanism paralel introdus din greseala', () => {
  for (const job of JOBS) {
    const immediateCalls = server.match(new RegExp(`${job}\\(\\)\\.catch\\(\\(\\) => \\{\\}\\);`, 'g')) || [];
    // fiecare job are 2 aparitii ale "job().catch(() => {})": una STRICT ca apel imediat, una in
    // interiorul lambda-ei setInterval — verificam separat cele doua tipare, nu doar un numar brut.
    assert.equal(immediateCalls.length, 2, `${job}: asteptat exact 2 aparitii ale "().catch(() => {})" (1 apel imediat + 1 in interiorul setInterval), gasit ${immediateCalls.length}`);
    const intervalCalls = server.match(new RegExp(`setInterval\\(\\(\\) => \\{ ${job}\\(\\)`, 'g')) || [];
    assert.equal(intervalCalls.length, 1, `${job}: asteptat exact UN setInterval, gasit ${intervalCalls.length}`);
  }
});

test('toate cele 4 setInterval raman la 24h (24 * 60 * 60 * 1000) cu .unref() — perioada de retentie NESCHIMBATA de aceasta corectie', () => {
  for (const job of JOBS) {
    assert.match(server, new RegExp(`setInterval\\(\\(\\) => \\{ ${job}\\(\\)\\.catch\\(\\(\\) => \\{\\}\\); \\}, 24 \\* 60 \\* 60 \\* 1000\\)\\.unref\\(\\);`));
  }
});

test('app.listen NU asteapta finalizarea joburilor de retentie — niciun "await" pe cele 4 joburi in interiorul .then(), si app.listen ramane ultimul apel real din bloc', () => {
  for (const job of JOBS) {
    assert.doesNotMatch(thenBody, new RegExp(`await ${job}\\(\\)`), `${job}() nu trebuie asteptat (await) — trebuie sa ramana fire-and-forget`);
  }
  const idxLastJobCall = Math.max(...JOBS.map((job) => thenBody.lastIndexOf(`${job}()`)));
  const idxAppListen = thenBody.indexOf('app.listen(PORT');
  assert.ok(idxAppListen !== -1, 'app.listen trebuie sa fie in interiorul aceluiasi bloc .then()');
  assert.ok(idxLastJobCall < idxAppListen, 'app.listen trebuie sa apara TEXTUAL dupa joburile de retentie, dar fara sa le astepte (fire-and-forget)');
});

test('daca db.initDb() esueaza, procesul face process.exit(1) — cele 4 joburi de retentie nu pot porni NICIODATA intr-o stare cu DB inaccesibila', () => {
  const catchIdx = server.indexOf('.catch(err => {\n      console.error(\'Nu m-am putut conecta la PostgreSQL la pornire:\'');
  assert.ok(catchIdx !== -1, 'catch-ul de esec al db.initDb() trebuie sa existe, neschimbat');
  const catchBody = server.slice(catchIdx, server.indexOf('\n    });', catchIdx));
  assert.match(catchBody, /process\.exit\(1\)/);
});

test('cleanup-ul multipartSessions (fara dependenta DB) ramane NESCHIMBAT — nu a fost mutat/atins de aceasta corectie', () => {
  assert.match(server, /const multipartSessions = new Map\(\);/);
  const idx = server.indexOf('if (require.main === module) {\n  setInterval(() => {\n    const now = Date.now();\n    for (const [sessionId, session] of multipartSessions.entries())');
  assert.ok(idx !== -1, 'cleanup-ul multipartSessions trebuie sa ramana in propriul bloc require.main, neschimbat, separat de joburile de retentie DB');
});

test('endpoint-urile admin manuale de retentie raman NESCHIMBATE (nu au fost mutate) — tot apeleaza direct functia, fara sa astepte initDb() (oricum ruleaza doar la un request real, mult dupa boot)', () => {
  const routes = [
    ['purge-source-media', 'purgeStaleSourceMedia'],
    ['expire-final-media', 'expireStaleFinalMedia'],
    ['anonymize-stale-stories', 'anonymizeStaleStories'],
    ['purge-funnel-events', 'purgeStaleFunnelEvents']
  ];
  for (const [path, fn] of routes) {
    const routeIdx = server.indexOf(`app.post('/api/admin/retention/${path}'`);
    assert.ok(routeIdx !== -1, `ruta pentru ${path} trebuie sa existe`);
    const routeEnd = server.indexOf('\n});', routeIdx);
    const routeBody = server.slice(routeIdx, routeEnd);
    assert.match(routeBody, new RegExp(`await ${fn}\\(\\)`));
  }
});
