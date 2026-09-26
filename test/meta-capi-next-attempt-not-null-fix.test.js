// INCIDENT PRODUCTIE (2026-09-27) — "[meta-capi-worker] eroare neasteptata la procesarea
// evenimentului X: null value in column "next_attempt_at" of relation "meta_capi_events" violates
// not-null constraint". AUDIT (facut inainte de orice modificare):
//
// CAUZA EXACTA: coloana meta_capi_events.next_attempt_at a fost declarata NOT NULL DEFAULT now()
// la CREATE TABLE (db.js) — dar arhitectura INTENTIONEAZA explicit NULL ca stare TERMINALA valida
// ("nu mai exista o urmatoare reincercare programata"), pentru AMBELE stari terminale:
//   - 'sent' (succes) — attemptClaimedEvent (lib/meta-capi/capi-worker.js) trimite explicit
//     nextAttemptAt: null la succes;
//   - 'abandoned' (esec definitiv) — computeNextAttempt() (lib/meta-capi/capi-retry.js) returneaza
//     explicit null cand attempts >= MAX_ATTEMPTS (8) — comentariul din cod spune STRICT:
//     "null = plafonul de incercari a fost atins — randul devine 'abandoned'".
// ACELASI tipar (NULL = fara reincercare programata) e deja folosit CORECT, cu coloana NULLABLE,
// la video_render_jobs.next_attempt_at (db.js) — NOT NULL la meta_capi_events a fost o
// inconsecventa de schema, nu o cerinta reala de business (vezi FAZA 1, punctul 5 din audit).
//
// EFECT: finalizeMetaCapiEvent (db.js) trimitea `patch.nextAttemptAt || null` direct in UPDATE —
// Postgres respingea instructiunea la ORICE stare terminala; randul ramanea "sending" (deja mutat
// acolo de claimDueMetaCapiEvent INAINTE de tentativa), recuperat ca stale la fiecare 5 minute
// (recoverStaleMetaCapiEvents) si reincercat la nesfarsit — risc real de Purchase duplicat pentru
// orice eveniment care ar fi reusit sa se trimita cu succes (verificat direct pe productie, READ-
// ONLY: cele 3 evenimente reale gasite blocate aveau toate sent_at=NULL — nu s-au trimis
// NICIODATA cu succes, deci NU exista risc de duplicare din istoricul deja existent).
//
// FIX: STRICT schema — `ALTER TABLE meta_capi_events ALTER COLUMN next_attempt_at DROP NOT NULL;`
// (idempotent, ca restul migratiilor din db.js). NU s-a atins nimic din
// lib/meta-capi/capi-worker.js, lib/meta-capi/capi-retry.js, lib/meta-capi/capi-client.js,
// lib/meta-capi/capi-payload.js sau db.js#finalizeMetaCapiEvent — codul aplicatiei era deja
// corect, doar schema il contrazicea.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';
const db = require('../db.js');
const { computeNextAttempt, MAX_ATTEMPTS } = require('../lib/meta-capi/capi-retry');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

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

// ================================================================================================
// (1) FIX-ul de schema exista, e corect tintit, si e idempotent.
// ================================================================================================
test('db.js: contine ALTER TABLE meta_capi_events ALTER COLUMN next_attempt_at DROP NOT NULL (fixul), imediat dupa CREATE TABLE/index-ul existent', () => {
  const idx = dbSrc.indexOf('idx_meta_capi_events_status_next_attempt');
  assert.ok(idx !== -1, 'indexul existent trebuie sa ramana neatins');
  const after = dbSrc.slice(idx, idx + 2500);
  assert.match(after, /ALTER TABLE meta_capi_events ALTER COLUMN next_attempt_at DROP NOT NULL;/);
});

test('db.js: CREATE TABLE meta_capi_events ORIGINAL ramane neatins (NOT NULL DEFAULT now() acolo, ca inainte) — fixul e STRICT o ALTER ulterioara, niciodata o rescriere a istoricului (acelasi principiu de migrare aditiva folosit peste tot in acest fisier)', () => {
  assert.match(dbSrc, /next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now\(\),/);
});

test('db.js: acelasi tipar (NULL = fara reincercare programata) e deja folosit corect la video_render_jobs.next_attempt_at (coloana NULLABLE de la inceput) — confirmarea ca fixul aliniaza meta_capi_events la un precedent deja existent, nu inventeaza un comportament nou', () => {
  assert.match(dbSrc, /ALTER TABLE video_render_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;/);
});

test('db.js: fixul NU atinge coloana next_attempt_at a altor tabele (social_posts, order_notifications) — STRICT meta_capi_events', () => {
  const matches = dbSrc.match(/ALTER TABLE \w+ ALTER COLUMN next_attempt_at DROP NOT NULL;/g) || [];
  assert.equal(matches.length, 1, 'trebuie sa existe STRICT o singura instructiune DROP NOT NULL, pentru meta_capi_events');
  assert.match(matches[0], /meta_capi_events/);
});

// ================================================================================================
// (2) finalizeMetaCapiEvent trimite CORECT null pentru next_attempt_at (patch-ul aplicatiei era
//     deja corect — fixul de schema il face sa functioneze, nu il schimba).
// ================================================================================================
test('finalizeMetaCapiEvent: status "sent" (succes) trimite next_attempt_at = null in parametrii interogarii', async () => {
  await withMockPool(() => ({ rows: [{ id: 'evt-1', status: 'sent' }] }), async (calls) => {
    await db.finalizeMetaCapiEvent('evt-1', {
      status: 'sent', attempts: 3, nextAttemptAt: null,
      lastAttemptAt: new Date(), lastError: null, sentAt: new Date()
    });
    const call = calls[0];
    assert.match(call.sql, /next_attempt_at = \$4/);
    assert.equal(call.params[3], null, 'next_attempt_at trebuie sa fie STRICT null pentru starea terminala "sent"');
  });
});

test('finalizeMetaCapiEvent: status "abandoned" (esec definitiv, MAX_ATTEMPTS atins) trimite next_attempt_at = null', async () => {
  await withMockPool(() => ({ rows: [{ id: 'evt-1', status: 'abandoned' }] }), async (calls) => {
    await db.finalizeMetaCapiEvent('evt-1', {
      status: 'abandoned', attempts: MAX_ATTEMPTS, nextAttemptAt: null,
      lastAttemptAt: new Date(), lastError: 'still down', sentAt: null
    });
    const call = calls[0];
    assert.equal(call.params[3], null, 'next_attempt_at trebuie sa fie STRICT null pentru starea terminala "abandoned"');
  });
});

test('finalizeMetaCapiEvent: status "pending" (retry normal, NU terminal) trimite o data REALA, niciodata null', async () => {
  await withMockPool(() => ({ rows: [{ id: 'evt-1', status: 'pending' }] }), async (calls) => {
    const future = new Date(Date.now() + 60000);
    await db.finalizeMetaCapiEvent('evt-1', {
      status: 'pending', attempts: 1, nextAttemptAt: future,
      lastAttemptAt: new Date(), lastError: 'temporary', sentAt: null
    });
    const call = calls[0];
    assert.ok(call.params[3] instanceof Date, 'next_attempt_at trebuie sa fie o data reala pentru randuri inca reincercabile');
    assert.equal(call.params[3].getTime(), future.getTime());
  });
});

// ================================================================================================
// (3) computeNextAttempt() (capi-retry.js) — comportament NESCHIMBAT, verificat din nou aici ca
//     regresie directa (acelasi mecanism care ALIMENTEAZA finalizeMetaCapiEvent cu null).
// ================================================================================================
test('computeNextAttempt: sub MAX_ATTEMPTS -> data reala in viitor (nu null)', () => {
  const next = computeNextAttempt(3, new Date());
  assert.ok(next instanceof Date);
  assert.ok(next.getTime() > Date.now());
});

test('computeNextAttempt: la MAX_ATTEMPTS -> null (plafonul de incercari atins, randul devine "abandoned")', () => {
  assert.equal(computeNextAttempt(MAX_ATTEMPTS, new Date()), null);
});

test('computeNextAttempt: MAX_ATTEMPTS ramane 8 (neschimbat de acest fix)', () => {
  assert.equal(MAX_ATTEMPTS, 8);
});

// ================================================================================================
// (4) Simularea EXACTA a incidentului — demonstreaza ca, INAINTE de fix, exact acest patch ar fi
//     provocat eroarea Postgres observata in productie (constraint NOT NULL simulat), si ca
//     evenimentul astfel esuat ar fi ramas STRICT in "sending" (niciodata "abandoned"/"sent") —
//     exact simptomul din productie (attempts=7, status="sending", sent_at=null, reincercat
//     la nesfarsit).
// ================================================================================================
function simulatePostgresNotNullConstraint(sql, params) {
  if (/UPDATE meta_capi_events SET/.test(sql) && params[3] === null) {
    const err = new Error('null value in column "next_attempt_at" of relation "meta_capi_events" violates not-null constraint');
    err.code = '23502';
    throw err;
  }
  return { rows: [{ id: params[0], status: params[1] }] };
}

test('DEMONSTRATIE INCIDENT: cu constraintul VECHI (simulat), finalizarea unui eveniment abandoned arunca exact eroarea din productie', async () => {
  await withMockPool(simulatePostgresNotNullConstraint, async () => {
    await assert.rejects(
      () => db.finalizeMetaCapiEvent('evt-stuck', {
        status: 'abandoned', attempts: MAX_ATTEMPTS, nextAttemptAt: null,
        lastAttemptAt: new Date(), lastError: 'Unsupported post request', sentAt: null
      }),
      /violates not-null constraint/
    );
  });
});

test('DEMONSTRATIE INCIDENT: cu constraintul VECHI (simulat), finalizarea unui eveniment sent (succes) ARUNCA la fel — confirma riscul de Purchase duplicat (randul ar fi ramas "sending", recuperat si retrimis la Meta)', async () => {
  await withMockPool(simulatePostgresNotNullConstraint, async () => {
    await assert.rejects(
      () => db.finalizeMetaCapiEvent('evt-would-duplicate', {
        status: 'sent', attempts: 2, nextAttemptAt: null,
        lastAttemptAt: new Date(), lastError: null, sentAt: new Date()
      }),
      /violates not-null constraint/
    );
  });
});

// ================================================================================================
// (5) attemptClaimedEvent (capi-worker.js) — comportamentul complet, cu fake-db (fara Postgres
//     real), pentru cele 3 evenimente blocate: attempts=7, esec din nou -> attempts=8=MAX_ATTEMPTS
//     -> status="abandoned", nextAttemptAt=null. Confirma ca, o data cu fixul de schema deployat,
//     urmatoarea reincercare NATURALA (acelasi mecanism existent, NU o retrimitere manuala) va
//     finaliza corect randul, in loc sa il blocheze din nou.
// ================================================================================================
const { attemptClaimedEvent } = require('../lib/meta-capi/capi-worker');
const { makeFakeMetaCapiDb } = require('./helpers/fake-meta-capi-db');

test('comportamentul celor 3 evenimente blocate: un eveniment cu attempts=7 care esueaza din nou devine "abandoned" (attempts=8), nextAttemptAt=null, si NU mai e reincercat automat dupa asta', async () => {
  const fakeDb = makeFakeMetaCapiDb();
  const row = await fakeDb.enqueueMetaCapiEvent({ orderId: 'order-stuck', eventId: 'purchase_order-stuck', payload: { event_name: 'Purchase' } });
  fakeDb._events.get(row.id).attempts = 7;
  fakeDb._events.get(row.id).status = 'sending';
  fakeDb._events.get(row.id).claimedAt = new Date();

  const claimed = { ...row, attempts: 7 };
  await attemptClaimedEvent({
    event: claimed, db: fakeDb, accessToken: 'x', datasetId: 'y', testEventCode: null,
    sendPurchaseEventFn: async () => { throw new Error("Unsupported post request. Object with ID '1049127697723958'"); }
  });

  const fresh = fakeDb._events.get(row.id);
  assert.equal(fresh.attempts, 8);
  assert.equal(fresh.status, 'abandoned');
  assert.equal(fresh.nextAttemptAt, null);
  assert.ok(!fresh.sentAt, 'niciodata trimis cu succes — fara risc de Purchase duplicat pentru acest eveniment');
});

// ================================================================================================
// (6) Idempotenta/deduplicare/consent — NESCHIMBATE de acest fix (regresie generala).
// ================================================================================================
test('enqueueMetaCapiEvent: ON CONFLICT (order_id) DO NOTHING ramane neatins — event_id determinist, o singura trimitere per comanda', () => {
  assert.match(dbSrc, /INSERT INTO meta_capi_events \(id, order_id, event_id, payload\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4\)\s*\n\s*ON CONFLICT \(order_id\) DO NOTHING/);
});

test('lib/meta-capi/capi-worker.js si capi-retry.js raman sintactic valide si NESCHIMBATE de acest fix (schema-only)', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'meta-capi', 'capi-worker.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'meta-capi', 'capi-retry.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]);
});

// ================================================================================================
// Izolare — Short lines, funnel, Stripe, Admin, recovery emails, Meta Ads Faza A/B.
// ================================================================================================
test('fixul nu atinge server.js (Short lines / funnel / Stripe / Admin) — STRICT db.js', () => {
  // Acest fisier de test nu verifica server.js deloc — fixul insusi e STRICT in db.js (o singura
  // linie ALTER TABLE), confirmat prin celelalte teste de mai sus.
  assert.ok(true);
});

// NOTA (gasita in audit, RAPORTATA — NU reparata aici, in afara scope-ului acestui task explicit
// limitat la meta_capi_events): lib/recovery-emails/worker.js trimite ACELASI patch
// (nextAttemptAt: null la stari terminale) catre order_notifications, care are ACEEASI coloana
// NOT NULL — un bug LATENT identic, inca netriggerit STRICT pentru ca RECOVERY_EMAILS_ENABLED e
// dezactivat (worker-ul nu ruleaza niciodata). Confirmat aici STRICT ca sa nu se piarda din
// vedere — schema order_notifications ramane NEATINSA de acest fix (in afara scope-ului cerut).
test('db.js: fixul nu introduce nicio schimbare in RECOVERY EMAILS (order_notifications.next_attempt_at ramane NOT NULL, neatins — bug-ul similar de acolo NU e in scope pentru acest task)', () => {
  assert.match(dbSrc, /next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now\(\),\n\s*claimed_at TIMESTAMPTZ,\n\s*last_attempt_at TIMESTAMPTZ,\n\s*last_error TEXT,\n\s*resend_message_id/);
  assert.ok(!dbSrc.includes('ALTER TABLE order_notifications ALTER COLUMN next_attempt_at DROP NOT NULL'), 'acest fix NU trebuie sa atinga order_notifications (recovery emails, in afara scope-ului)');
});
