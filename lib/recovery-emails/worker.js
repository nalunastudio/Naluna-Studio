// lib/recovery-emails/worker.js
// Worker-ul de fundal pentru recovery emails — ACELASI tipar de pornire ca
// lib/meta-capi/capi-worker.js (rulare imediata + tick periodic, `ticking` impotriva suprapunerii),
// dar cu O ETAPA IN PLUS fata de acela: inainte de a procesa coada (order_notifications), un pas
// de SCANARE gaseste comenzi nou-eligibile pentru 'preview_recovery'/'checkout_recovery' si le
// adauga in coada — cate UNA SINGURA per client, per tick (vezi lib/recovery-emails/eligibility.js,
// pickWinnersPerClient, pentru regula exacta). 'preview_ready' NU e scanat aici — e adaugat direct
// in coada de server.js, la momentul exact in care o comanda devine preview_ready (vezi
// finalizeVariantsIfNeeded) — instant, fara sa astepte un tick de scanare, si fara niciun risc de
// a "descoperi" retroactiv comenzi vechi.
//
// SIGURANTA IMPOTRIVA TRIMITERII RETROACTIVE (cerinta 10): getConfig().enabled controleaza daca
// tick-ul face ORICE (scanare SAU procesare) — cand e false, tick()-ul e un simplu no-op (doar
// recoverStaleOrderNotifications, care e complet inofensiv — muta randuri 'sending' orfane inapoi
// la 'pending', nu trimite nimic). Server.js nici macar nu PORNESTE acest worker cand flag-ul e
// oprit la boot — vezi comentariul din server.js la punctul de pornire. In plus, scanarea
// foloseste STRICT getConfig().cutoffSince (vezi server.js — citit din app_settings
// 'recovery_emails_first_enabled_at', scris o SINGURA data, la prima pornire REALA a worker-ului
// cu flag-ul activat) — nicio comanda mai veche decat acel moment nu poate deveni vreodata
// candidat, indiferent cat de "eligibila" ar parea altfel.

const { pickWinnersPerClient, checkSendEligibility, isWithinCooldown } = require('./eligibility');
const { computeNextAttempt } = require('./retry');

const DEFAULT_TICK_INTERVAL_MS = Number(process.env.RECOVERY_EMAIL_WORKER_INTERVAL_MS) > 0
  ? Number(process.env.RECOVERY_EMAIL_WORKER_INTERVAL_MS)
  : 15 * 60 * 1000; // 15 minute — nu e nevoie de granularitate de secunde, e un reminder, nu o plata

const STALE_CLAIM_MINUTES = 10; // trimiterea unui email real dureaza cateva secunde, nu minute
const MAX_CANDIDATES_PER_TICK = 500; // plasa de siguranta pe interogarea de scanare
const MAX_SENDS_PER_TICK = 50; // plasa de siguranta pe cat de multe emailuri trimite un singur tick

const RECOVERY_TYPES = ['preview_recovery', 'checkout_recovery'];
const ALL_TYPES = ['preview_ready', 'preview_recovery', 'checkout_recovery'];

async function scanAndEnqueueDueRecoveryCandidates({ db, config }) {
  const candidates = await db.findDueRecoveryCandidates({
    previewThresholdHours: config.previewRecoveryThresholdHours,
    checkoutThresholdHours: config.checkoutRecoveryThresholdHours,
    maxLookbackHours: config.maxLookbackHours,
    cutoffSince: config.cutoffSince,
    testEmails: config.testEmails
  });
  const bounded = candidates.slice(0, MAX_CANDIDATES_PER_TICK);
  const winners = pickWinnersPerClient(bounded);

  let enqueued = 0;
  for (const winner of winners) {
    const lastSentAt = await db.getRecoveryClientCooldown(winner.emailKey);
    if (isWithinCooldown(lastSentAt, config.clientCooldownHours)) continue;
    const inserted = await db.enqueueOrderNotification({
      orderId: winner.orderId,
      emailKey: winner.emailKey,
      notificationType: winner.notificationType,
      lang: winner.lang
    });
    // inserted === null inseamna ca randul exista deja (ON CONFLICT DO NOTHING — alt tick/proces
    // l-a creat intre timp) — cooldown-ul NU se atinge din nou pentru un no-op.
    if (inserted) {
      await db.touchRecoveryClientCooldown(winner.emailKey);
      enqueued++;
    }
  }
  return { candidateCount: bounded.length, enqueued };
}

// Un singur rand deja preluat (claimed) — reverifica ELIGIBILITATEA REALA, curenta (cerinta 4),
// apoi trimite (sendFn) sau marcheaza motivul exact pentru care a fost sarit.
async function processClaimedNotification({ claimed, db, sendFn, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn }) {
  const order = await db.getOrderById(claimed.orderId);
  const check = await checkSendEligibility({
    order, notificationType: claimed.notificationType,
    isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn
  });
  const now = new Date();
  if (!check.ok) {
    return db.finalizeOrderNotification(claimed.id, {
      status: check.reason,
      attempts: claimed.attempts,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastError: null,
      sentAt: null
    });
  }

  const attempts = claimed.attempts + 1;
  try {
    const result = await sendFn({ order, notification: claimed });
    return db.finalizeOrderNotification(claimed.id, {
      status: 'sent',
      attempts,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastError: null,
      resendMessageId: result && result.resendMessageId,
      sentAt: now
    });
  } catch (err) {
    const nextAttemptAt = computeNextAttempt(attempts, now);
    return db.finalizeOrderNotification(claimed.id, {
      status: nextAttemptAt ? 'pending' : 'abandoned',
      attempts,
      nextAttemptAt,
      lastAttemptAt: now,
      lastError: err.message,
      sentAt: null
    });
  }
}

async function processDueOrderNotifications({ db, sendFn, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn, maxPerTick = MAX_SENDS_PER_TICK }) {
  let processed = 0;
  for (let i = 0; i < maxPerTick; i++) {
    const claimed = await db.claimDueOrderNotification(ALL_TYPES);
    if (!claimed) break;
    try {
      await processClaimedNotification({ claimed, db, sendFn, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn });
    } catch (err) {
      console.error(`[recovery-email-worker] eroare neasteptata la procesarea notificarii ${claimed.id}:`, err.message);
    }
    processed++;
  }
  return processed;
}

async function runWorkerTick({ db, sendFn, getConfig, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn }) {
  const recovered = await db.recoverStaleOrderNotifications(STALE_CLAIM_MINUTES);
  const config = getConfig();
  if (!config.enabled) {
    return { enabled: false, recoveredCount: recovered.length, scanned: 0, enqueued: 0, processed: 0 };
  }
  const scanResult = await scanAndEnqueueDueRecoveryCandidates({ db, config });
  const processed = await processDueOrderNotifications({ db, sendFn, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn });
  return { enabled: true, recoveredCount: recovered.length, scanned: scanResult.candidateCount, enqueued: scanResult.enqueued, processed };
}

function startRecoveryEmailWorker({ db, sendFn, getConfig, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn, intervalMs = DEFAULT_TICK_INTERVAL_MS }) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runWorkerTick({ db, sendFn, getConfig, isTestEmailFn, isSuppressedFn, isMarketingSuppressedFn });
    } catch (err) {
      console.error('[recovery-email-worker] tick a esuat:', err.message);
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
  MAX_CANDIDATES_PER_TICK,
  MAX_SENDS_PER_TICK,
  RECOVERY_TYPES,
  ALL_TYPES,
  scanAndEnqueueDueRecoveryCandidates,
  processClaimedNotification,
  processDueOrderNotifications,
  runWorkerTick,
  startRecoveryEmailWorker
};
