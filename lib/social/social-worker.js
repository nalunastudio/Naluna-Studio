// lib/social/social-worker.js
// Workerul de scheduling/retry — procesarea postarilor 'scheduled'/'partially_failed'/'failed'
// ajunse la termen, recuperarea dupa restart, si verificarea periodica a lifecycle-ului
// tokenului Instagram. Foloseste STRICT publishPost() (lib/social/social-publisher.js) si
// computeAttemptPatch() (lib/social/social-retry.js) — ACELEASI functii folosite de publicarea
// manuala instant (social-post-service.js). Nu exista un al doilea sistem de publishing aici,
// doar orchestrarea "cand" si "ce anume" (platformele inca esuate) se reincearca.
//
// Postgres ramane sursa adevarului: db.claimDueSocialPost() e o singura instructiune SQL
// atomica (FOR UPDATE SKIP LOCKED) — sigura sub oricate instante/tick-uri concurente, vezi
// comentariul din db.js. setInterval() de mai jos e STRICT un declansator de "verifica acum",
// nu un mecanism de corectitudine — daca nu ar mai porni niciodata dupa un restart, urmatoarea
// pornire tot recupereaza si proceseaza tot ce era scadent, pentru ca starea traieste in DB,
// nu in memoria procesului.

const { computeAttemptPatch } = require('./social-retry');

const DEFAULT_TICK_INTERVAL_MS = Number(process.env.SOCIAL_WORKER_INTERVAL_MS) > 0
  ? Number(process.env.SOCIAL_WORKER_INTERVAL_MS)
  : 60 * 1000; // 60s — granularitatea programarilor sociale nu are nevoie de precizie sub-minut

// Publicarea pe Meta dureaza cel mult cateva zeci de secunde (Instagram poate astepta status
// FINISHED al containerului, dar waitForContainerReady are propriul plafon de incercari) —
// 5 minute e o marja generoasa fata de orice executie legitima, niciodata atinsa normal.
const STALE_PUBLISHING_MINUTES = 5;

const MAX_POSTS_PER_TICK = 20; // plasa de siguranta — un tick nu proceseaza nelimitat de multe postari, ca sa nu blocheze urmatorul tick la o coada foarte mare

// O singura incercare pentru O SINGURA postare deja preluata (claimed) — ataca STRICT
// platformele care inca au nevoie de o incercare, calculeaza rezultatul cu computeAttemptPatch
// (aceeasi functie folosita de publicarea instant) si il persista.
//
// IMPORTANT: claimDueSocialPost() a preluat postarea pentru ca cel putin o platforma era
// scadenta (next_attempt_at la nivel de postare = MIN al celor per-platforma) — asta NU
// inseamna ca AMBELE platforme sunt scadente acum. Daca Facebook mai are inca 30 minute de
// backoff dar Instagram a fost rearmat manual pentru acum, atacam STRICT Instagram — altfel
// am incalca exact cerinta "retry doar platforma care a esuat", consumand o incercare Facebook
// inainte de vreme. O platforma fara nicio incercare anterioara (*_next_attempt_at inca null)
// e mereu eligibila — asta acopera prima incercare a unei postari proaspat scadente.
async function runClaimedSocialPostAttempt({ post, db, publishPost, getPublicUrl, getInstagramAccessToken }) {
  const now = Date.now();
  const platformsToAttempt = post.platforms.filter((p) => {
    const currentStatus = p === 'facebook' ? post.facebookStatus : post.instagramStatus;
    if (currentStatus === 'success') return false;
    const perPlatformNextAttemptAt = p === 'facebook' ? post.facebookNextAttemptAt : post.instagramNextAttemptAt;
    return !perPlatformNextAttemptAt || new Date(perPlatformNextAttemptAt).getTime() <= now;
  });

  let results = {};
  if (platformsToAttempt.length > 0) {
    const mediaUrl = getPublicUrl(post.mediaKey);
    const credentials = {};
    if (platformsToAttempt.includes('instagram')) {
      credentials.instagramAccessToken = await getInstagramAccessToken(db);
    }
    results = await publishPost({
      platforms: platformsToAttempt,
      mediaType: post.mediaType,
      mediaUrl,
      caption: post.caption || undefined,
      credentials
    });
  }

  const patch = computeAttemptPatch({ post, attemptedPlatforms: platformsToAttempt, results });
  return db.finalizeSocialPost(post.id, patch);
}

// Preia si proceseaza, SECVENTIAL, toate postarile scadente (pana la MAX_POSTS_PER_TICK sau
// pana cand claimDueSocialPost() nu mai gaseste nimic) — fiecare claim e propria instructiune
// SQL atomica, deci doua tick-uri (sau doua instante) care ruleaza aceasta bucla "simultan" nu
// pot prelua NICIODATA acelasi rand de doua ori (vezi FOR UPDATE SKIP LOCKED in db.js).
async function processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken, maxPerTick = MAX_POSTS_PER_TICK }) {
  let processed = 0;
  for (let i = 0; i < maxPerTick; i++) {
    const claimed = await db.claimDueSocialPost();
    if (!claimed) break;
    try {
      await runClaimedSocialPostAttempt({ post: claimed, db, publishPost, getPublicUrl, getInstagramAccessToken });
    } catch (err) {
      // O eroare NEASTEPTATA (nu un rezultat 'error' normal de la publishPost, care e deja
      // tratat de computeAttemptPatch, ci ex. Postgres pica la finalizeSocialPost) lasa randul
      // in 'publishing' — recoverStalePublishingSocialPosts il recupereaza la urmatorul tick.
      console.error(`[social-worker] eroare neasteptata la procesarea postarii ${claimed.id}:`, err.message);
    }
    processed++;
  }
  return processed;
}

// Un tick complet: recuperare (randuri 'publishing' ramase orfane de la un crash anterior),
// apoi procesarea normala a postarilor scadente, apoi (optional) verificarea lifecycle-ului
// tokenului Instagram.
async function runWorkerTick({ db, publishPost, getPublicUrl, getInstagramAccessToken, checkInstagramTokenLifecycle }) {
  const recovered = await db.recoverStalePublishingSocialPosts(STALE_PUBLISHING_MINUTES);
  const processed = await processDueSocialPosts({ db, publishPost, getPublicUrl, getInstagramAccessToken });
  let tokenLifecycle = null;
  if (checkInstagramTokenLifecycle) {
    try {
      tokenLifecycle = await checkInstagramTokenLifecycle();
    } catch (err) {
      console.error('[social-worker] verificarea lifecycle-ului tokenului Instagram a esuat:', err.message);
    }
  }
  return { recoveredCount: recovered.length, processed, tokenLifecycle };
}

// Porneste worker-ul: o rulare IMEDIATA (recuperare + orice e deja scadent la pornire — nu
// asteapta primul interval) urmata de tick-uri periodice. `ticking` previne suprapunerea a
// doua tick-uri ale ACELUIASI proces (defensiv — improbabil dat fiind intervalul, dar un tick
// neasteptat de lent nu trebuie sa porneasca un al doilea peste el).
function startSocialWorker({ db, publishPost, getPublicUrl, getInstagramAccessToken, checkInstagramTokenLifecycle, intervalMs = DEFAULT_TICK_INTERVAL_MS }) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runWorkerTick({ db, publishPost, getPublicUrl, getInstagramAccessToken, checkInstagramTokenLifecycle });
    } catch (err) {
      console.error('[social-worker] tick a esuat:', err.message);
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
  STALE_PUBLISHING_MINUTES,
  MAX_POSTS_PER_TICK,
  runClaimedSocialPostAttempt,
  processDueSocialPosts,
  runWorkerTick,
  startSocialWorker
};
