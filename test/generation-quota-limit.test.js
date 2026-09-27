// PROTECTIE GENERARI GRATUITE REPETATE (2026-09-26/27, cerinta explicita; REGULA FINALA 3/7
// actualizata 2026-09-27, inlocuieste runda anterioara 2/14): un client (identificat server-side
// prin email normalizat) poate avea maxim 3 comenzi NOI, NEPLATITE, generate, intr-o fereastra
// ROLITOARE de 7 zile (combinat Standard+Premium+Video, nu per-plan). Plata ORICAREI comenzi
// eligibile deschide un CICLU NOU complet (3 generari noi, nu doar "elibereaza un loc"). Fara
// nicio plata, restrictia expira natural prin fereastra rolitoare. Clientul nu vede NICIODATA
// limita/fereastra/data de resetare — STRICT un mesaj fix, identic ca structura in toate cele 8
// limbi. Emailurile de test (ANALYTICS_EXCLUDED_EMAILS/isTestCustomerEmail, mecanism EXISTENT,
// NEmodificat) sunt COMPLET exceptate — nicio limita, nicio fereastra, nicio inregistrare in
// observabilitate.
//
// Mecanism (db.js#claimOrderForInitialGeneration, rescris; db.js#recordPaidOrderAtomically,
// extins cu upsert client_generation_cycles): atomic, race-safe, intr-o SINGURA tranzactie
// Postgres — pg_advisory_xact_lock(hashtextextended(emailKey, 0)) serializeaza doua cereri
// concurente pentru ACELASI email (nu blocheaza clienti diferiti intre ei), apoi numarul de
// comenzi eligibile e numarat SI verificat SI (daca sub limita) comanda e reclamata pentru
// generare, toate in aceeasi tranzactie — nicio fereastra TOCTOU intre "numara" si "actioneaza".
//
// NU testeaza SQL-ul executat efectiv de Postgres (proiectul nu ruleaza teste pe un Postgres
// real — vezi restul suitei, ex. test/admin-orders-numbering.test.js, test/analytics-server.test.js)
// ci FORMA interogarilor si SECVENTA/ATOMICITATEA apelurilor, acelasi tipar consacrat deja folosit
// pentru recordPaidOrderAtomically (test/analytics-server.test.js).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

async function withMockDbClient(rowsQueue, fn) {
  const originalConnect = db.pool.connect.bind(db.pool);
  const calls = [];
  db.pool.connect = async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
      return rowsQueue.shift() || { rows: [] };
    },
    release: () => {}
  });
  try {
    return await fn(calls);
  } finally {
    db.pool.connect = originalConnect;
  }
}

// ===============================================================================================
// (1) claimOrderForInitialGeneration — emailuri de TEST (skipQuota=true): comportament IDENTIC
// cu inainte de protectie — nicio verificare de cota, nicio interogare noua executata.
// ===============================================================================================
test('claimOrderForInitialGeneration: skipQuota=true (email de test) -> NU executa nicio interogare de cota (fara advisory lock, fara numarare, fara client_generation_cycles), trece direct la claim', async () => {
  await withMockDbClient(
    [{ rows: [{ id: 'order-1', status: 'generating' }] }], // UPDATE ... RETURNING (claim)
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('order-1', 5, 'test@naluna.dev', true);
      assert.equal(result.quotaBlocked, false);
      assert.ok(result.order, 'comanda trebuie reclamata normal pentru un email de test');
      assert.ok(!calls.some((c) => c.sql.includes('pg_advisory_xact_lock')), 'niciun advisory lock pentru emailuri de test');
      assert.ok(!calls.some((c) => c.sql.includes('client_generation_cycles')), 'niciun acces la client_generation_cycles pentru emailuri de test');
      assert.ok(!calls.some((c) => /FROM orders[\s\S]*COUNT/i.test(c.sql) || /COUNT\(\*\)/.test(c.sql)), 'nicio numarare de comenzi pentru emailuri de test');
    }
  );
});

// ===============================================================================================
// (2) Client normal, SUB limita (0, 1 sau 2 comenzi eligibile in fereastra) -> permis, claim executat.
// ===============================================================================================
test('claimOrderForInitialGeneration: client normal, 0 comenzi eligibile in fereastra -> quotaBlocked=false, comanda reclamata (generarea 1)', async () => {
  await withMockDbClient(
    [
      { rows: [] }, // SELECT pg_advisory_xact_lock (rezultatul e irelevant, doar sincronizeaza)
      { rows: [] }, // SELECT cycle_started_at (niciun ciclu inca)
      { rows: [{ n: '0' }] }, // COUNT(*)
      { rows: [{ id: 'order-2', status: 'generating' }] } // UPDATE ... RETURNING
    ],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('order-2', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
      assert.ok(result.order);
      assert.ok(calls.some((c) => c.sql.includes('pg_advisory_xact_lock')), 'trebuie sa foloseasca advisory lock pentru clienti normali');
    }
  );
});

test('claimOrderForInitialGeneration: client normal, 1 comanda eligibila in fereastra -> tot permis (generarea 2)', async () => {
  await withMockDbClient(
    [
      { rows: [] },
      { rows: [{ cycle_started_at: null }] },
      { rows: [{ n: '1' }] },
      { rows: [{ id: 'order-3', status: 'generating' }] }
    ],
    async () => {
      const result = await db.claimOrderForInitialGeneration('order-3', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
      assert.ok(result.order);
    }
  );
});

test('claimOrderForInitialGeneration: client normal, 2 comenzi eligibile in fereastra -> tot permis (generarea 3, ultima din alocatie — sub limita de 3, nu la limita)', async () => {
  await withMockDbClient(
    [
      { rows: [] },
      { rows: [{ cycle_started_at: null }] },
      { rows: [{ n: '2' }] },
      { rows: [{ id: 'order-3b', status: 'generating' }] }
    ],
    async () => {
      const result = await db.claimOrderForInitialGeneration('order-3b', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
      assert.ok(result.order);
    }
  );
});

// ===============================================================================================
// (3) Client normal, LA limita (3 comenzi eligibile deja) -> a patra BLOCATA, fara claim executat.
// ===============================================================================================
test('claimOrderForInitialGeneration: client normal, 3 comenzi eligibile deja in fereastra -> quotaBlocked=true, NICIUN UPDATE de claim executat (generarea 4, blocata)', async () => {
  await withMockDbClient(
    [
      { rows: [] },
      { rows: [] },
      { rows: [{ n: '3' }] }
    ],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('order-4', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true);
      assert.equal(result.order, null);
      assert.ok(!calls.some((c) => c.sql.includes("status = 'generating'")), 'a patra generare nu trebuie sa mai ajunga la UPDATE-ul de claim');
    }
  );
});

test('claimOrderForInitialGeneration: peste limita (4+) -> tot blocat (>=, nu ==)', async () => {
  await withMockDbClient(
    [
      { rows: [] },
      { rows: [] },
      { rows: [{ n: '5' }] }
    ],
    async () => {
      const result = await db.claimOrderForInitialGeneration('order-5', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true);
    }
  );
});

test('claimOrderForInitialGeneration: mix Standard+Premium+Video -> limita e COMUNA (aceeasi numarare, indiferent de plan) — 3 comenzi din pachete diferite blocheaza a 4-a la fel ca 3 din acelasi pachet', async () => {
  // Numararea (COUNT(*) FROM orders WHERE lower(trim(email))=$1 ...) nu filtreaza NICIODATA dupa
  // plan/coloana "plan" — vezi asertiunea SQL de mai jos (sectiunea 4): aceeasi interogare conteaza
  // Standard+Premium+Video laolalta, fara nicio distinctie. Testul de aici confirma explicit ca
  // niciun filtru de plan nu a fost adaugat vreodata in aceasta interogare.
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const start = dbSrc.indexOf('async function claimOrderForInitialGeneration');
  const end = dbSrc.indexOf('\n}', start) + 2;
  const body = dbSrc.slice(start, end);
  assert.ok(!/plan\s*=/.test(body), 'interogarea de numarare nu trebuie sa filtreze niciodata dupa plan (limita e comuna Standard+Premium+Video)');
});

// ===============================================================================================
// (4) Forma exacta a interogarilor — count exclude draft/generation_failed, exclude comanda curenta,
// foloseste fereastra rolitoare COMBINATA cu ciclul de reset (GREATEST), si advisory lock-ul
// PRECEDE numararea (garanteaza atomicitatea "numara + actioneaza" in aceeasi tranzactie).
// ===============================================================================================
test('claimOrderForInitialGeneration: interogarea de numarare exclude draft/generation_failed, exclude comanda curenta (id != $2), si combina fereastra de 7 zile cu reset-ul de ciclu (GREATEST)', async () => {
  await withMockDbClient(
    [
      { rows: [] },
      { rows: [{ cycle_started_at: new Date('2026-09-20T00:00:00Z') }] },
      { rows: [{ n: '0' }] },
      { rows: [{ id: 'order-6' }] }
    ],
    async (calls) => {
      await db.claimOrderForInitialGeneration('order-6', 5, 'client@exemplu.ro', false);
      const countCall = calls.find((c) => /COUNT\(\*\)/.test(c.sql));
      assert.ok(countCall, 'trebuie sa existe o interogare COUNT(*)');
      assert.match(countCall.sql, /status NOT IN \('draft', 'generation_failed'\)/);
      assert.match(countCall.sql, /id != \$2/);
      assert.match(countCall.sql, /GREATEST\(now\(\) - \(\$3 \|\| ' days'\)::interval, COALESCE\(\$4, '-infinity'::timestamptz\)\)/);
      assert.equal(countCall.params[0], 'client@exemplu.ro');
      assert.equal(countCall.params[1], 'order-6');
      assert.equal(countCall.params[2], 7, 'fereastra trebuie sa fie STRICT 7 zile (REGULA FINALA, nu mai 14)');
      assert.ok(countCall.params[3] instanceof Date, 'cycle_started_at citit trebuie transmis ca parametru pentru GREATEST');
    }
  );
});

test('FREE_GENERATION_LIMIT/FREE_GENERATION_WINDOW_DAYS: constantele modulului sunt STRICT 3 si 7 (regula finala, nu mai 2/14)', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(dbSrc, /const FREE_GENERATION_LIMIT = 3;/);
  assert.match(dbSrc, /const FREE_GENERATION_WINDOW_DAYS = 7;/);
});

// Granita exacta a ferestrei mobile de 7 zile: parametrul trimis catre GREATEST(now() - ($3 ||
// ' days')::interval, ...) e STRICT 7 — Postgres insusi evalueaza granita (now()-7 zile) la
// executie reala; aici verificam STRICT ca serverul trimite parametrul corect si o singura data
// (nicio dubla-rotunjire/conversie facuta in JS inainte de a ajunge la Postgres).
test('fereastra mobila: parametrul de 7 zile e trimis CA NUMAR intreg catre Postgres (nu ca string/interval preformatat in JS) — Postgres face STRICT matematica de date/interval', async () => {
  await withMockDbClient(
    [{ rows: [] }, { rows: [] }, { rows: [{ n: '0' }] }, { rows: [{ id: 'order-6b' }] }],
    async (calls) => {
      await db.claimOrderForInitialGeneration('order-6b', 5, 'client@exemplu.ro', false);
      const countCall = calls.find((c) => /COUNT\(\*\)/.test(c.sql));
      assert.equal(typeof countCall.params[2], 'number');
      assert.equal(countCall.params[2], 7);
    }
  );
});

test('claimOrderForInitialGeneration: advisory lock (pg_advisory_xact_lock) e apelat INAINTE de numarare — atomic, per email, in aceeasi tranzactie', async () => {
  await withMockDbClient(
    [{ rows: [] }, { rows: [] }, { rows: [{ n: '0' }] }, { rows: [{ id: 'order-7' }] }],
    async (calls) => {
      await db.claimOrderForInitialGeneration('order-7', 5, 'client@exemplu.ro', false);
      const lockIdx = calls.findIndex((c) => c.sql.includes('pg_advisory_xact_lock'));
      const countIdx = calls.findIndex((c) => /COUNT\(\*\)/.test(c.sql));
      assert.ok(lockIdx !== -1 && countIdx !== -1 && lockIdx < countIdx, 'lock-ul trebuie sa preceada numararea, in aceeasi tranzactie (fara fereastra TOCTOU intre cereri concurente pentru acelasi email)');
      const lockCall = calls[lockIdx];
      assert.equal(lockCall.params[0], 'client@exemplu.ro', 'lock-ul trebuie sa fie SCOPED pe emailul clientului (nu un lock global)');
    }
  );
});

test('claimOrderForInitialGeneration: client cu istoric MARE (ex. >3 comenzi vechi neplatite gasite de numarare) -> tot blocat, exact ca la 3 — nicio distinctie intre "istoric vechi" si "recent", STRICT numarul din fereastra curenta conteaza', async () => {
  await withMockDbClient(
    [{ rows: [] }, { rows: [] }, { rows: [{ n: '47' }] }],
    async () => {
      const result = await db.claimOrderForInitialGeneration('order-hist', 5, 'client-vechi@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true);
    }
  );
});

test('mecanismul e STRICT persistat in Postgres, fara nicio stare in memoria procesului (niciun Map/Set/cache la nivel de modul) — un restart/redeploy NU poate reseta artificial cota, spre deosebire de un contor in memorie', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const start = dbSrc.indexOf('const FREE_GENERATION_LIMIT');
  const end = dbSrc.indexOf('async function getEligibleOrdersForAccessRecovery');
  const section = dbSrc.slice(start, end);
  assert.ok(!/new Map\(\)|new Set\(\)|=\s*\{\s*\}\s*;.*cache/i.test(section), 'nicio structura de date in memorie pentru numarare/cota — totul trece prin client_generation_cycles/orders (Postgres)');
});

test('claimOrderForInitialGeneration: emailKey lipsa (gol) -> se comporta ca skipQuota (defensiv, nu blocă orbeste)', async () => {
  await withMockDbClient(
    [{ rows: [{ id: 'order-8' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('order-8', 5, '', false);
      assert.equal(result.quotaBlocked, false);
      assert.ok(!calls.some((c) => c.sql.includes('pg_advisory_xact_lock')));
    }
  );
});

// ===============================================================================================
// (5) recordPaidOrderAtomically — reset de ciclu la o plata REALA si NOUA, o singura data.
// ===============================================================================================
test('recordPaidOrderAtomically: eveniment deja procesat (dedup, isNewEvent=false) -> NU atinge client_generation_cycles', async () => {
  await withMockDbClient(
    [{ rows: [] }], // dedup INSERT -> 0 randuri (deja procesat)
    async (calls) => {
      const result = await db.recordPaidOrderAtomically('evt_dup', 'order-9', { status: 'ready' });
      assert.equal(result.isNewEvent, false);
      assert.ok(!calls.some((c) => c.sql.includes('client_generation_cycles')), 'un eveniment retrimis (retry webhook) nu poate reseta ciclul a doua oara');
    }
  );
});

test('recordPaidOrderAtomically: comanda deja "ready" (alreadyPaid) -> NU atinge client_generation_cycles a doua oara', async () => {
  await withMockDbClient(
    [
      { rows: [{ event_id: 'evt_1' }] },
      { rows: [{ id: 'order-10', status: 'ready', email: 'client@exemplu.ro', plan: 'standard', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }] }
    ],
    async (calls) => {
      const result = await db.recordPaidOrderAtomically('evt_2', 'order-10', { status: 'ready' });
      assert.equal(result.alreadyPaid, true);
      assert.ok(!calls.some((c) => c.sql.includes('client_generation_cycles')), 'alreadyPaid trebuie sa opreasca inainte de reset-ul de ciclu');
    }
  );
});

test('recordPaidOrderAtomically: plata noua reala -> upsert client_generation_cycles (ON CONFLICT DO UPDATE, cycle_started_at = now()), o singura data, cheie email normalizat', async () => {
  await withMockDbClient(
    [
      { rows: [{ event_id: 'evt_3' }] },
      { rows: [{ id: 'order-11', status: 'preview_ready', email: '  Client@Exemplu.RO  ', plan: 'standard', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }] },
      { rows: [] },
      { rows: [{ id: 'order-11', status: 'ready' }] }
    ],
    async (calls) => {
      await db.recordPaidOrderAtomically('evt_3', 'order-11', { status: 'ready' });
      const cycleCall = calls.find((c) => c.sql.includes('client_generation_cycles'));
      assert.ok(cycleCall, 'plata noua trebuie sa deschida un ciclu nou');
      assert.match(cycleCall.sql, /ON CONFLICT \(email_key\) DO UPDATE SET cycle_started_at = now\(\)/);
      assert.deepEqual(cycleCall.params, ['client@exemplu.ro'], 'cheia trebuie normalizata (trim + lowercase), acelasi mecanism ca restul codului');
    }
  );
});

test('dupa o plata (reset de ciclu), clientul primeste EXACT inca 3 generari noi — count-ul relativ la NOUL cycle_started_at porneste de la 0, indiferent cate comenzi vechi (dinainte de reset) mai existau', async () => {
  // Pasul 1: plata reseteaza ciclul -> cycle_started_at devine T (now()).
  await withMockDbClient(
    [
      { rows: [{ event_id: 'evt_reset' }] },
      { rows: [{ id: 'order-paid', status: 'preview_ready', email: 'client@exemplu.ro', plan: 'standard', variants: '[]', uploaded_media: '[]', regenerate_edit_variant_ids: '[]' }] },
      { rows: [] },
      { rows: [{ id: 'order-paid', status: 'ready' }] }
    ],
    async (calls) => {
      await db.recordPaidOrderAtomically('evt_reset', 'order-paid', { status: 'ready' });
      const cycleCall = calls.find((c) => c.sql.includes('client_generation_cycles'));
      assert.ok(cycleCall, 'plata trebuie sa fi resetat ciclul inainte de a continua');
    }
  );

  // Pasul 2: 3 cereri succesive DUPA reset, cu numaratoarea relativa la NOUL cycle_started_at
  // (simulat prin cycle_started_at="acum", count=0,1,2 pentru fiecare) -> toate 3 permise.
  const cycleStartedAtAfterReset = new Date();
  for (const [n, orderId] of [['0', 'order-new-1'], ['1', 'order-new-2'], ['2', 'order-new-3']]) {
    await withMockDbClient(
      [
        { rows: [] },
        { rows: [{ cycle_started_at: cycleStartedAtAfterReset }] },
        { rows: [{ n }] },
        { rows: [{ id: orderId, status: 'generating' }] }
      ],
      async () => {
        const result = await db.claimOrderForInitialGeneration(orderId, 5, 'client@exemplu.ro', false);
        assert.equal(result.quotaBlocked, false, `generarea cu count=${n} (relativ la noul ciclu) trebuie permisa`);
      }
    );
  }

  // A 4-a cerere DUPA reset (count=3, relativ la noul ciclu) -> blocata din nou.
  await withMockDbClient(
    [{ rows: [] }, { rows: [{ cycle_started_at: cycleStartedAtAfterReset }] }, { rows: [{ n: '3' }] }],
    async () => {
      const result = await db.claimOrderForInitialGeneration('order-new-4', 5, 'client@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true, 'a 4-a generare dupa reset trebuie blocata la fel ca inainte de reset');
    }
  );
});

// ===============================================================================================
// (6) Fara migratie distructiva — client_generation_cycles e STRICT additiv (CREATE TABLE IF NOT
// EXISTS), nicio comanda/audio existenta nu e stearsa sau modificata la deploy.
// ===============================================================================================
test('db.js: client_generation_cycles e creat STRICT additiv (CREATE TABLE IF NOT EXISTS), fara DROP/DELETE/migratie distructiva asociata', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS client_generation_cycles/);
  const idx = dbSrc.indexOf('client_generation_cycles');
  const nearby = dbSrc.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(!/DROP TABLE.*client_generation_cycles|DELETE FROM orders|TRUNCATE/i.test(nearby), 'nicio operatie distructiva langa introducerea tabelei noi');
});

// ===============================================================================================
// (7) server.js — mesajul FIX, identic in toate cele 8 limbi, FARA niciun numar (limita/fereastra/
// data), traduceri naturale si distincte.
// ===============================================================================================
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractConstObject(src, name) {
  const idx = src.indexOf(`const ${name} = {`);
  assert.ok(idx !== -1, `${name} trebuie sa existe in server.js`);
  const end = src.indexOf('};', idx) + 2;
  const objSrc = src.slice(idx, end);
  return new Function(objSrc + `\nreturn ${name};`)();
}

test('server.js: GENERATION_QUOTA_BLOCKED_MESSAGES contine toate cele 8 limbi, traduceri distincte, text real (nu placeholder)', () => {
  const map = extractConstObject(serverSrc, 'GENERATION_QUOTA_BLOCKED_MESSAGES');
  for (const lang of ALLOWED_LANGS) {
    assert.ok(typeof map[lang] === 'string' && map[lang].length > 10, `${lang} trebuie sa aiba un text real`);
  }
  const uniqueValues = new Set(Object.values(map));
  assert.equal(uniqueValues.size, ALLOWED_LANGS.length, 'toate cele 8 traduceri trebuie sa fie distincte');
});

test('server.js: mesajul RO e EXACT textul fix cerut, neschimbat', () => {
  const map = extractConstObject(serverSrc, 'GENERATION_QUOTA_BLOCKED_MESSAGES');
  assert.equal(map.ro, 'Ai deja melodii create pentru tine. Alege una dintre comenzile tale pentru a continua.');
});

test('server.js: NICIUNA din cele 8 traduceri nu contine vreo cifra — clientul nu trebuie sa poata deduce limita, fereastra sau o data', () => {
  const map = extractConstObject(serverSrc, 'GENERATION_QUOTA_BLOCKED_MESSAGES');
  for (const lang of ALLOWED_LANGS) {
    assert.ok(!/\d/.test(map[lang]), `${lang}: mesajul nu trebuie sa contina nicio cifra (gasit in: "${map[lang]}")`);
  }
});

test('server.js: generationQuotaBlockedMessage(lang) cade pe "ro" pentru o limba necunoscuta/lipsa', () => {
  const idx = serverSrc.indexOf('function generationQuotaBlockedMessage');
  const end = serverSrc.indexOf('\n}', idx) + 2;
  const mapIdx = serverSrc.indexOf('const GENERATION_QUOTA_BLOCKED_MESSAGES = {');
  const mapEnd = serverSrc.indexOf('};', mapIdx) + 2;
  const allowedLangsSrc = 'const ALLOWED_LANGS = ' + JSON.stringify(ALLOWED_LANGS) + ';';
  const fnSrc = allowedLangsSrc + serverSrc.slice(mapIdx, mapEnd) + serverSrc.slice(idx, end);
  const fn = new Function(fnSrc + '\nreturn generationQuotaBlockedMessage;')();
  assert.equal(fn('xx'), fn('ro'));
  assert.equal(fn(undefined), fn('ro'));
});

// ===============================================================================================
// (8) server.js — wiring-ul rutei /generate: emailKey + skipQuota (isTestCustomerEmail, mecanismul
// EXISTENT, NEmodificat) transmise catre claimOrderForInitialGeneration; raspuns 403 localizat pe
// blocare; observabilitate (funnel_events) STRICT pentru clienti normali, NICIODATA pentru test.
// ===============================================================================================
function generateHandlerBody() {
  const idx = serverSrc.indexOf("app.post('/api/orders/:orderId/generate'");
  const end = serverSrc.indexOf("\n});", idx) + 4;
  return serverSrc.slice(idx, end);
}

test("server.js: ruta /generate calculeaza skipQuota STRICT prin isTestCustomerEmail (mecanismul existent), fara nicio lista noua hardcodata", () => {
  const body = generateHandlerBody();
  assert.match(body, /skipQuota = isTestCustomerEmail\(order\.email\)/);
  assert.match(body, /emailKey = String\(order\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
});

test('server.js: ruta /generate transmite emailKey+skipQuota catre db.claimOrderForInitialGeneration (noua semnatura, 4 parametri)', () => {
  const body = generateHandlerBody();
  assert.match(body, /db\.claimOrderForInitialGeneration\(\s*order\.id, credits\.MAX_GENERATION_ATTEMPTS, emailKey, skipQuota\s*\)/);
});

test('server.js: la quotaBlocked, raspunsul foloseste STRICT mesajul localizat fix (generationQuotaBlockedMessage), niciun numar/limita in raspuns', () => {
  const body = generateHandlerBody();
  assert.match(body, /error: generationQuotaBlockedMessage\(order\.lang\)/);
});

test('server.js: observabilitatea (funnel_events, "generation_quota_blocked") e STRICT in interiorul unui "if (!skipQuota)" — niciodata inregistrata pentru emailuri de test', () => {
  const body = generateHandlerBody();
  const idx = body.indexOf("eventName: 'generation_quota_blocked'");
  assert.ok(idx !== -1, 'trebuie sa existe un eveniment funnel pentru blocare');
  const before = body.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(!skipQuota\)\s*\{/, 'insertFunnelEvent pentru blocare trebuie sa fie garda de "if (!skipQuota)"');
});

test('server.js: evenimentul funnel de blocare NU contine adresa de email (fara PII) — doar orderId si planul', () => {
  const body = generateHandlerBody();
  const idx = body.indexOf("eventName: 'generation_quota_blocked'");
  const blockEnd = body.indexOf('});', idx) + 3;
  const block = body.slice(idx - 20, blockEnd);
  assert.ok(!/email/i.test(block), 'blocul de insertFunnelEvent nu trebuie sa refere emailul in niciun fel');
});

test('server.js: nu exista o a doua lista hardcodata de emailuri de test pentru aceasta protectie — se refoloseste STRICT ANALYTICS_EXCLUDED_EMAILS existent', () => {
  const occurrences = (serverSrc.match(/ANALYTICS_EXCLUDED_EMAILS\s*=\s*\(process\.env/g) || []).length;
  assert.equal(occurrences, 1, 'trebuie sa existe o SINGURA sursa de adevar pentru emailurile de test/excluse');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
