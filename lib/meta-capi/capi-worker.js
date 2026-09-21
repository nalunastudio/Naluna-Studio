// lib/meta-capi/capi-worker.js
// Workerul de retry pentru Meta CAPI Purchase — ACELASI tipar exact ca lib/social/social-worker.js
// (claim atomic FOR UPDATE SKIP LOCKED prin db.claimDueMetaCapiEvent, recuperare dupa crash prin
// db.recoverStaleMetaCapiEvents, tick periodic + declansare imediata optionala), adaptat la un
// singur "job" per rand (o singura cerere HTTP catre Meta, nu doua platforme separate ca la
// social publishing).
//
// Postgres ramane sursa adevarului: daca acest worker nu ar mai porni niciodata dupa un restart,
// urmatoarea pornire tot recupereaza (randuri 'sending' orfane) si proceseaza tot ce era scadent
// ('pending' cu next_attempt_at <= acum) — starea traieste STRICT in meta_capi_events, niciodata
// doar in memoria procesului. Vezi cerinta explicita: "un esec temporar Meta dupa procesarea
// webhookului Stripe sa nu piarda definitiv Purchase".

const { sendPurchaseEvent } = require('./capi-client');
const { computeNextAttempt } = require('./capi-retry');

const DEFAULT_TICK_INTERVAL_MS = Number(process.env.META_CAPI_WORKER_INTERVAL_MS) > 0
  ? Number(process.env.META_CAPI_WORKER_INTERVAL_MS)
  : 60 * 1000; // 60s — acelasi interval ca social-worker.js, granularitate suficienta pentru retry-uri financiare non-urgente (Stripe/DB raman oricum sursa de adevar a platii, indiferent de acest job)

// Meta Conversions API raspunde tipic in cateva secunde — 5 minute e o marja generoasa fata de
// orice executie legitima, niciodata atinsa normal (acelasi plafon ca social-worker.js).
const STALE_CLAIM_MINUTES = 5;

const MAX_EVENTS_PER_TICK = 20; // plasa de siguranta — un tick nu proceseaza nelimitat de multe evenimente

// O singura incercare, pentru UN SINGUR eveniment deja preluat (claimed prin
// db.claimDueMetaCapiEvent) — trimite prin sendPurchaseEvent() si persista rezultatul.
// attempts se incrementeaza la FIECARE incercare reala (succes sau esec), pentru observabilitate
// si pentru calculul backoff-ului urmator.
async function attemptClaimedEvent({ event, db, accessToken, datasetId, testEventCode, sendPurchaseEventFn = sendPurchaseEvent }) {
  const attempts = event.attempts + 1;
  const now = new Date();
  try {
    await sendPurchaseEventFn(event.payload, { accessToken, datasetId, testEventCode });
    return db.finalizeMetaCapiEvent(event.id, {
      status: 'sent',
      attempts,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastError: null,
      sentAt: now
    });
  } catch (err) {
    const nextAttemptAt = computeNextAttempt(attempts, now);
    return db.finalizeMetaCapiEvent(event.id, {
      status: nextAttemptAt ? 'pending' : 'abandoned',
      attempts,
      nextAttemptAt,
      lastAttemptAt: now,
      lastError: err.message,
      sentAt: null
    });
  }
}

// Preia si proceseaza, SECVENTIAL, toate evenimentele scadente (pana la MAX_EVENTS_PER_TICK sau
// pana cand claimDueMetaCapiEvent() nu mai gaseste nimic).
async function processDueMetaCapiEvents({ db, getConfig, maxPerTick = MAX_EVENTS_PER_TICK, sendPurchaseEventFn }) {
  let processed = 0;
  for (let i = 0; i < maxPerTick; i++) {
    const claimed = await db.claimDueMetaCapiEvent();
    if (!claimed) break;
    const config = getConfig();
    if (!config.accessToken || !config.datasetId) {
      // Configuratia lipsea la momentul acestei incercari (era prezenta la enqueue — vezi gate-ul
      // din server.js — dar a putut disparea intre timp, ex. variabila stearsa din Railway).
      // Eliberam randul FARA sa consumam o incercare reala — nu e o eroare Meta, e o problema de
      // configurare, temporar sau permanent — worker-ul o va reincerca la urmatorul tick, cand
      // (daca) configuratia revine.
      await db.finalizeMetaCapiEvent(claimed.id, {
        status: 'pending',
        attempts: claimed.attempts,
        nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
        lastAttemptAt: claimed.lastAttemptAt,
        lastError: 'META_CAPI_ACCESS_TOKEN/META_DATASET_ID lipsa la momentul trimiterii',
        sentAt: null
      });
      processed++;
      continue;
    }
    try {
      await attemptClaimedEvent({
        event: claimed, db,
        accessToken: config.accessToken, datasetId: config.datasetId, testEventCode: config.testEventCode,
        sendPurchaseEventFn
      });
    } catch (err) {
      // Eroare NEASTEPTATA (nu un esec normal de trimitere, deja tratat in attemptClaimedEvent,
      // ci ex. Postgres pica la finalizeMetaCapiEvent) — randul ramane 'sending',
      // recoverStaleMetaCapiEvents il recupereaza la urmatorul tick.
      console.error(`[meta-capi-worker] eroare neasteptata la procesarea evenimentului ${claimed.id}:`, err.message);
    }
    processed++;
  }
  return processed;
}

async function runWorkerTick({ db, getConfig, sendPurchaseEventFn }) {
  const recovered = await db.recoverStaleMetaCapiEvents(STALE_CLAIM_MINUTES);
  const processed = await processDueMetaCapiEvents({ db, getConfig, sendPurchaseEventFn });
  return { recoveredCount: recovered.length, processed };
}

// Porneste worker-ul: o rulare IMEDIATA (recuperare + orice e deja scadent la pornire) urmata de
// tick-uri periodice. `tick()` (returnat) poate fi apelat si direct, fire-and-forget, imediat
// dupa un enqueue nou (vezi server.js) — pentru trimitere cu latenta mica in cazul comun, in
// completarea (nu in locul) garantiei de fond oferite de setInterval. `ticking` previne
// suprapunerea a doua tick-uri ale ACELUIASI proces.
function startMetaCapiWorker({ db, getConfig, intervalMs = DEFAULT_TICK_INTERVAL_MS, sendPurchaseEventFn }) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runWorkerTick({ db, getConfig, sendPurchaseEventFn });
    } catch (err) {
      console.error('[meta-capi-worker] tick a esuat:', err.message);
    } finally {
      ticking = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  DEFAULT_TICK_INTERVAL_MS,
  STALE_CLAIM_MINUTES,
  MAX_EVENTS_PER_TICK,
  attemptClaimedEvent,
  processDueMetaCapiEvents,
  runWorkerTick,
  startMetaCapiWorker
};
