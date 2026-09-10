// worker.js
// Punct de intrare pentru serviciul Railway separat "video-worker" — arhitectura de
// scalare orizontala aprobata (vezi raportul de scalabilitate). ÎN TESTARE — nu e
// declansat inca de fluxul live de comenzi reale (acela ramane exclusiv pe
// generatePremiumExtras/triggerVideoGeneration din server.js, neschimbat).
//
// Reutilizeaza EXACT functia de randare a fluxului live (generateLyricVideo, exportata
// aditiv din server.js) — niciodata o copie/reimplementare — deci rezultatul unei randari
// facute de acest worker e, prin constructie, identic cu cel al pipeline-ului curent.
//
// Configurat STRICT pentru maximum 1 randare activa per proces: bucla de mai jos asteapta
// randarea curenta sa se termine COMPLET (succes sau esec) inainte sa preia urmatorul job —
// niciodata doua randari in paralel in acelasi proces. Scalarea la N randari simultane vine
// din N replici ale acestui serviciu (vezi autoscaler.js), nu din concurenta interna.
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db.js');
const storage = require('./storage.js');
const { generateLyricVideo, TEMP_DIR, downloadFile } = require('./server.js');

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

// Lease de 3 minute (180s) fara heartbeat = job considerat abandonat (worker mort/replica
// disparuta) si eligibil pentru re-preluare. MULT mai scurt decat vechiul lock de 20 minute
// (db.claimVideoRender) — sigur DOAR pentru ca exista heartbeat activ (vezi mai jos): un
// worker viu reinnoieste la fiecare 60s, deci 180s fara reinnoire indica de 3 ori la rand o
// absenta, nu o incetinire tranzitorie.
const LEASE_SECONDS = 180;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;
const IDLE_LOG_EVERY_N_POLLS = 12; // ~1 minut, ca sa nu inunde logul cat timp coada e goala

// Backoff exponential + jitter intre reincercarile ACELUIASI job (max_attempts=3, deja
// existent) — O SINGURA politica de retry, la nivel de job, nu doua bucle imbricate (nu
// atinge deloc bucla interna de 2 incercari din fetchTimestampedLyricsOnce/server.js, care
// ramane neschimbata si comuna cu drumul de muzica). Baza 10s, dublata per incercare
// (10s, 20s, 40s...), plafonata la 120s, plus jitter aleator 0-5s ca mai multi workeri care
// esueaza in acelasi moment sa NU se resincronizeze intr-o noua rafala simultana. Daca
// furnizorul semnaleaza explicit un Retry-After (vezi err.retryAfterSeconds, camp aditiv
// din server.js), se respecta acea valoare daca e mai mare decat backoff-ul calculat.
const BACKOFF_BASE_SECONDS = 10;
const BACKOFF_MAX_SECONDS = 120;
const BACKOFF_JITTER_MAX_SECONDS = 5;

function computeBackoffSeconds(attempts, err) {
  const exponential = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.random() * BACKOFF_JITTER_MAX_SECONDS;
  const computed = exponential + jitter;
  const providerHint = (err && typeof err.retryAfterSeconds === 'number') ? err.retryAfterSeconds : 0;
  return Math.round(Math.max(computed, providerHint));
}

let idlePollCount = 0;

function log(...args) {
  console.log(`[video-worker ${WORKER_ID}]`, ...args);
}

async function claimAndRenderOnce() {
  const job = await db.claimNextVideoRenderJob(WORKER_ID, LEASE_SECONDS);
  if (!job) return false;

  idlePollCount = 0;
  log(`Job preluat: ${job.id} (comanda ${job.orderId.slice(0, 8)}, varianta ${job.variantId}, revizie ${job.mediaRevision}, incercarea ${job.attempts}/${job.maxAttempts}, fencing=${job.fencingToken})`);

  let fencedOut = false;
  const heartbeat = setInterval(async () => {
    try {
      const ok = await db.heartbeatVideoRenderJob(job.id, WORKER_ID, job.fencingToken);
      if (!ok) {
        fencedOut = true;
        log(`Job ${job.id}: heartbeat respins — lease-ul a expirat si jobul a fost preluat de altcineva. Rezultatul acestei randari va fi aruncat la finalizare.`);
      }
    } catch (err) {
      log(`Job ${job.id}: eroare la heartbeat (ignorata, se continua):`, err.message);
    }
  }, HEARTBEAT_INTERVAL_MS);

  let tempFullMp3Path = null;
  try {
    const order = await db.getOrderById(job.orderId);
    if (!order) throw new Error('Comanda nu mai exista.');
    const variant = (order.variants || []).find(v => v.id === job.variantId);
    if (!variant || !variant.fullKey) throw new Error('Varianta nu mai exista sau nu are fullKey.');

    tempFullMp3Path = path.join(TEMP_DIR, `${order.id}-${variant.id}-worker-${WORKER_ID}-full.mp3`);
    const signedUrl = await storage.getSignedDownloadUrl(variant.fullKey, 600);
    await downloadFile(signedUrl, tempFullMp3Path);

    const videoResult = await generateLyricVideo(order, variant, tempFullMp3Path);

    clearInterval(heartbeat);

    if (fencedOut) {
      log(`Job ${job.id}: randare terminata dar worker-ul fusese deja fenced out — rezultatul NU se scrie.`);
      return true;
    }

    const completed = await db.completeVideoRenderJob(job.id, WORKER_ID, job.fencingToken, videoResult);
    if (!completed) {
      log(`Job ${job.id}: completeVideoRenderJob respins (fencing token schimbat) — rezultatul NU se scrie.`);
      return true;
    }

    // Compune cu verificarea deja existenta in fluxul live (isVideoClaimStillCurrent) —
    // fencing-ul de mai sus protejeaza impotriva unui WORKER invechit; aceasta verificare
    // protejeaza impotriva unui REZULTAT invechit (clientul a schimbat varianta/materialele
    // cat randarea era in curs). Ambele trebuie sa treaca inainte de scrierea pe comanda.
    const stillCurrent = await db.isVideoClaimStillCurrent(job.orderId, job.variantId, job.mediaRevision);
    if (!stillCurrent) {
      log(`Job ${job.id}: isVideoClaimStillCurrent = false — varianta/materialele s-au schimbat intre timp, rezultatul NU se scrie pe comanda (jobul ramane marcat 'done' — randarea a reusit tehnic, dar rezultatul e invechit).`);
      return true;
    }

    const fresh = await db.getOrderById(job.orderId);
    if (fresh) {
      const updatedVariants = (fresh.variants || []).map(v =>
        v.id === job.variantId
          ? { ...v, videoKey: videoResult.videoKey, videoPreviewKey: videoResult.videoPreviewKey, sectionTimings: videoResult.sectionTimings, videoFailedReason: null }
          : v
      );
      await db.updateOrder(job.orderId, { variants: updatedVariants });
      log(`Job ${job.id}: rezultat scris cu succes pe comanda ${job.orderId.slice(0, 8)}.`);
    }
    return true;
  } catch (err) {
    clearInterval(heartbeat);
    log(`Job ${job.id}: randare esuata:`, err && err.stack ? err.stack : err);
    if (!fencedOut) {
      const backoffSeconds = computeBackoffSeconds(job.attempts, err);
      if (err && err.isRateLimit) log(`Job ${job.id}: furnizorul a semnalat rate-limit — backoff ${backoffSeconds}s.`);
      const outcome = await db.failVideoRenderJob(job.id, WORKER_ID, job.fencingToken, (err && err.message) || String(err), backoffSeconds);
      if (outcome) log(`Job ${job.id}: marcat '${outcome.status}' dupa esec${outcome.status === 'pending' ? ` (reincercabil dupa ${backoffSeconds}s)` : ''}.`);
    }
    return true;
  } finally {
    if (tempFullMp3Path) {
      try { if (fs.existsSync(tempFullMp3Path)) fs.unlinkSync(tempFullMp3Path); } catch (e) { /* best-effort */ }
    }
  }
}

async function mainLoop() {
  log('Pornit. Astept joburi in coada video_render_jobs...');
  for (;;) {
    let handled = false;
    try {
      handled = await claimAndRenderOnce();
    } catch (err) {
      log('Eroare neasteptata in bucla principala (se continua):', err && err.stack ? err.stack : err);
    }
    if (!handled) {
      idlePollCount += 1;
      if (idlePollCount % IDLE_LOG_EVERY_N_POLLS === 0) {
        log(`Inca astept — nicio comanda in coada de ${Math.round(idlePollCount * POLL_INTERVAL_MS / 1000)}s.`);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

mainLoop().catch(err => {
  console.error('[video-worker] eroare fatala, procesul se opreste:', err && err.stack ? err.stack : err);
  process.exit(1);
});
