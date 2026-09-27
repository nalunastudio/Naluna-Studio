// AUDIT EXPLICIT (2026-09-27, cerinta explicita, client REAL cu 13 comenzi/generari neplatite):
// "istoricul preexistent trebuie sa conteze la limita 3/7, chiar la PRIMA evaluare dupa
// introducerea sistemului — clientul nu trebuie sa primeasca artificial inca 3 doar pentru ca
// tabelul client_generation_cycles e nou/gol".
//
// CONCLUZIA AUDITULUI (verificata prin citirea directa a codului, nu presupusa): interogarea de
// numarare din claimOrderForInitialGeneration (db.js) NU a folosit NICIODATA existenta unui rand
// in client_generation_cycles ca sa decida CE conteaza — foloseste STRICT starea REALA din
// tabela orders (created_at, status, email), live, la fiecare apel. Absenta unui rand pentru un
// email (client care nu a platit NICIODATA) inseamna cycleStartedAt=null -> COALESCE(null,
// '-infinity') -> GREATEST(now()-7zile, '-infinity') = now()-7zile — fereastra completa de 7
// zile se aplica NESLABITA, exact ca pentru orice alt client. NU exista nicio "perioada de
// gratie"/"reset la deploy" — istoricul real din orders a fost DINTOTDEAUNA sursa de adevar.
// Testele de mai jos DOVEDESC acest lucru explicit, per scenariile cerute (A-H), fara sa schimbe
// niciun cod (nu a fost necesara nicio corectie pentru acest punct).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
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

// "Prima evaluare dupa introducerea sistemului" = client_generation_cycles NU are inca niciun
// rand pentru acest email (niciodata platit) -> cycleRes intoarce 0 randuri -> cycleStartedAt=null.
// Secventa REALA de interogari (in aceasta ordine, in aceeasi tranzactie): (1) advisory lock —
// rezultatul e irelevant, doar sincronizeaza; (2) SELECT cycle_started_at; (3) SELECT COUNT(*);
// (4) UPDATE ... RETURNING (claim), STRICT daca nu s-a blocat la pasul 3.
const LOCK_ROW = { rows: [] };
const NO_CYCLE_ROW = { rows: [] };

test('A. client istoric cu 0 generari relevante -> poate genera (quotaBlocked=false)', async () => {
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '0' }] }, { rows: [{ id: 'new-order' }] }],
    async () => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-a@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
      assert.ok(result.order);
    }
  );
});

test('B. client istoric cu 1 generare relevanta -> poate genera', async () => {
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '1' }] }, { rows: [{ id: 'new-order' }] }],
    async () => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-b@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
    }
  );
});

test('C. client istoric cu 2 generari relevante -> poate genera (ultimul loc din alocatie)', async () => {
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '2' }] }, { rows: [{ id: 'new-order' }] }],
    async () => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-c@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
    }
  );
});

test('D. client istoric cu 3 generari relevante -> urmatoarea tentativa BLOCATA inainte de orice claim (deci inainte de orice apel Suno) — niciun UPDATE de claim executat', async () => {
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '3' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-d@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true);
      assert.equal(result.order, null);
      assert.ok(!calls.some((c) => c.sql.includes("status = 'generating'")), 'blocarea trebuie sa se intample INAINTE de claim — server.js nu mai apeleaza Suno dupa acest punct');
    }
  );
});

test('E. CAZUL REAL RAPORTAT — client cu 13 generari neplatite recente (istoric preexistent, dinainte de acest deploy) -> urmatoarea tentativa e BLOCATA inainte de Suno, la FEL ca la 3 — niciun tratament special/gratie pentru "sistem nou"', async () => {
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '13' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-13@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true, 'un istoric de 13 generari neplatite recente trebuie sa blocheze — NU acorda artificial inca 3 doar pentru ca client_generation_cycles nu are inca un rand pentru acest client');
      assert.equal(result.order, null);
      assert.ok(!calls.some((c) => c.sql.includes("status = 'generating'")));
    }
  );
});

test('F. client cu generari MAI VECHI de 7 zile -> nu ramane blocat din cauza lor (fereastra mobila, verificata direct in interogarea SQL — Postgres exclude aceste randuri prin created_at >= GREATEST(now()-7zile,...), nu codul JS)', async () => {
  // Simuleaza exact ce ar intoarce Postgres real: din cele 13 istorice, doar 1 mai e in fereastra
  // (restul de 12 sunt mai vechi de 7 zile si NU sunt numarate de interogarea SQL insasi).
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '1' }] }, { rows: [{ id: 'new-order' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-f@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false, 'doar generarile REAL in fereastra de 7 zile conteaza — cele mai vechi ies natural din calcul');
      const countCall = calls.find((c) => /COUNT\(\*\)/.test(c.sql));
      assert.match(countCall.sql, /created_at >= GREATEST\(now\(\) - \(\$3 \|\| ' days'\)::interval, COALESCE\(\$4, '-infinity'::timestamptz\)\)/, 'filtrarea pe fereastra de 7 zile trebuie sa ramana in interogarea SQL insasi (Postgres), nu presupusa in JS');
    }
  );
});

test('G. client cu istoric MARE, dar cu o plata/reset VALID ulterior -> se calculeaza STRICT ciclul relevant de dupa reset (GREATEST alege cycle_started_at, nu now()-7zile, cand reset-ul e mai recent) — istoricul dinainte de reset nu mai conteaza', async () => {
  const cycleStartedAt = new Date('2026-09-25T12:00:00Z'); // plata a avut loc acum 2 zile, de exemplu
  await withMockDbClient(
    [LOCK_ROW, { rows: [{ cycle_started_at: cycleStartedAt }] }, { rows: [{ n: '1' }] }, { rows: [{ id: 'new-order' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-g@exemplu.ro', false);
      assert.equal(result.quotaBlocked, false);
      const countCall = calls.find((c) => /COUNT\(\*\)/.test(c.sql));
      assert.deepEqual(countCall.params[3], cycleStartedAt, 'cycle_started_at citit din client_generation_cycles trebuie transmis ca prag pentru GREATEST — istoricul dinainte de reset e exclus automat de Postgres (created_at < cycle_started_at)');
    }
  );
});

test('H. deploy/restart NU acorda artificial alte 3 generari — "prima evaluare dupa introducerea sistemului" (client_generation_cycles gol pentru acest email) foloseste STRICT fereastra de 7 zile, IDENTIC cu orice apel ulterior, niciodata un cont "proaspat"', async () => {
  // Randul din client_generation_cycles NU exista (echivalentul exact al "sistemul tocmai a
  // pornit, tabelul e gol pentru acest client") — SINGURUL efect e ca GREATEST cade pe
  // now()-7zile (fereastra normala), NICIODATA pe o alocatie noua/resetata.
  await withMockDbClient(
    [LOCK_ROW, NO_CYCLE_ROW, { rows: [{ n: '13' }] }],
    async (calls) => {
      const result = await db.claimOrderForInitialGeneration('new-order', 5, 'client-h@exemplu.ro', false);
      assert.equal(result.quotaBlocked, true, 'absenta unui rand in client_generation_cycles (deploy nou) nu trebuie sa se comporte diferit de un client care a epuizat deja alocatia');
      const countCall = calls.find((c) => /COUNT\(\*\)/.test(c.sql));
      assert.equal(countCall.params[3], null, 'fara nicio plata anterioara, pragul de reset transmis catre GREATEST e null -> COALESCE il transforma in -infinity -> se aplica STRICT fereastra de 7 zile, niciodata un reset implicit');
    }
  );
});

test('AUDIT: interogarea de numarare (claimOrderForInitialGeneration) NU face referire, in nicio forma, la momentul cand a fost creat tabelul/coloana client_generation_cycles sau la vreun "prag de migrare" — foloseste STRICT created_at/status/email din orders, live, la fiecare apel', () => {
  const fs = require('fs');
  const path = require('node:path');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const start = dbSrc.indexOf('async function claimOrderForInitialGeneration');
  const end = dbSrc.indexOf('\n}', start) + 2;
  const body = dbSrc.slice(start, end);
  assert.ok(!/migrat|deploy|launch_date|introducer/i.test(body), 'nu trebuie sa existe niciun concept de "prag de migrare"/"data de lansare" in aceasta functie — istoricul real conteaza necondiționat');
});
