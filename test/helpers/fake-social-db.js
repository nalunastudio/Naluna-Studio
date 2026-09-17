// test/helpers/fake-social-db.js
// "db" fals, in memorie, care REPLICA fidel contractul functiilor reale din db.js pentru
// social_posts si instagram_token_state (verificat manual, linie cu linie, fata de SQL-ul
// real) — folosit de testele Etapa 3 care au nevoie de comportament realist de claim/tranzitie
// de stare (worker, cancel, retry, recovery, token lifecycle), nu doar de citire/scriere simpla.
// NU e Postgres — nu inlocuieste testarea SQL-ului propriu-zis (imposibila fara o instanta
// reala, indisponibila in acest mediu), dar codifica exact acelasi contract.

function makeFakeSocialDb() {
  const posts = new Map(); // id -> post (obiect mutat direct, ca un rand real)
  const byIdempotencyKey = new Map();
  const tokenState = {
    accessToken: null, refreshedAt: null, expiresAt: null, refreshClaimedAt: null,
    lastRefreshError: null, lastRefreshAttemptAt: null, consecutiveRefreshFailures: 0, lastAlertSentAt: null
  };

  return {
    async getSocialPostByIdempotencyKey(key) {
      return byIdempotencyKey.get(key) || null;
    },
    async getSocialPostById(id) {
      return posts.get(id) || null;
    },
    async createSocialPostIfNew(post) {
      if (byIdempotencyKey.has(post.idempotencyKey)) return null;
      const row = {
        id: post.id, idempotencyKey: post.idempotencyKey, status: post.status || 'draft',
        platforms: post.platforms, mediaType: post.mediaType, mediaKey: post.mediaKey, caption: post.caption || null,
        facebookStatus: null, facebookPostId: null, facebookError: null,
        facebookAttemptCount: 0, facebookLastAttemptAt: null, facebookNextAttemptAt: null,
        instagramStatus: null, instagramPostId: null, instagramContainerId: null, instagramError: null,
        instagramAttemptCount: 0, instagramLastAttemptAt: null, instagramNextAttemptAt: null,
        nextAttemptAt: post.nextAttemptAt || null, publishingClaimedAt: null, cancelledAt: null,
        createdAt: new Date(), updatedAt: new Date(), publishedAt: null, scheduledAt: post.scheduledAt || null
      };
      posts.set(row.id, row);
      byIdempotencyKey.set(row.idempotencyKey, row);
      return { ...row };
    },
    async finalizeSocialPost(id, patch) {
      const existing = posts.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: new Date(), publishingClaimedAt: null };
      posts.set(id, updated);
      byIdempotencyKey.set(existing.idempotencyKey, updated);
      return { ...updated };
    },
    // Aceeasi semantica STRICT ca UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED
    // LIMIT 1) din db.js: gaseste UN SINGUR rand scadent, cel mai vechi scadent primul, il
    // muta la 'publishing' in ACEEASI "operatie" (fara nicio pauza intre citire si scriere —
    // JS single-threaded reproduce exact garantia de atomicitate a acelei instructiuni SQL).
    async claimDueSocialPost() {
      const now = Date.now();
      const candidates = [...posts.values()]
        .filter((p) => ['scheduled', 'partially_failed', 'failed'].includes(p.status) && p.nextAttemptAt && new Date(p.nextAttemptAt).getTime() <= now)
        .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());
      const claim = candidates[0];
      if (!claim) return null;
      claim.status = 'publishing';
      claim.publishingClaimedAt = new Date();
      return { ...claim };
    },
    async recoverStalePublishingSocialPosts(staleMinutes) {
      const cutoff = Date.now() - staleMinutes * 60 * 1000;
      const recovered = [];
      for (const p of posts.values()) {
        if (p.status === 'publishing' && p.publishingClaimedAt && new Date(p.publishingClaimedAt).getTime() < cutoff) {
          const fbNull = p.facebookStatus == null;
          const igNull = p.instagramStatus == null;
          p.status = (fbNull && igNull) ? 'scheduled' : ((p.facebookStatus === 'success' || p.instagramStatus === 'success') ? 'partially_failed' : 'failed');
          p.nextAttemptAt = new Date();
          p.publishingClaimedAt = null;
          recovered.push({ ...p });
        }
      }
      return recovered;
    },
    async cancelScheduledSocialPost(id) {
      const p = posts.get(id);
      if (!p || p.status !== 'scheduled') return null;
      p.status = 'cancelled';
      p.cancelledAt = new Date();
      p.nextAttemptAt = null;
      return { ...p };
    },
    async retrySocialPostPlatform(id, platform) {
      const p = posts.get(id);
      if (!p) return null;
      if (platform !== 'facebook' && platform !== 'instagram') return null;
      if (!['partially_failed', 'failed'].includes(p.status)) return null;
      const statusField = platform === 'facebook' ? 'facebookStatus' : 'instagramStatus';
      if (p[statusField] !== 'error') return null;
      const nextField = platform === 'facebook' ? 'facebookNextAttemptAt' : 'instagramNextAttemptAt';
      p[nextField] = new Date();
      p.nextAttemptAt = new Date();
      return { ...p };
    },
    async getInstagramTokenState() {
      return { ...tokenState };
    },
    async claimInstagramTokenRefresh(lockMinutes) {
      const now = Date.now();
      if (tokenState.refreshClaimedAt && (now - new Date(tokenState.refreshClaimedAt).getTime()) < lockMinutes * 60 * 1000) {
        return null;
      }
      tokenState.refreshClaimedAt = new Date();
      tokenState.lastRefreshAttemptAt = new Date();
      return { accessToken: tokenState.accessToken };
    },
    async recordInstagramTokenRefreshSuccess(accessToken, expiresAt) {
      tokenState.accessToken = accessToken;
      tokenState.refreshedAt = new Date();
      tokenState.expiresAt = expiresAt;
      tokenState.refreshClaimedAt = null;
      tokenState.lastRefreshError = null;
      tokenState.consecutiveRefreshFailures = 0;
    },
    async recordInstagramTokenRefreshFailure(message) {
      tokenState.refreshClaimedAt = null;
      tokenState.lastRefreshError = message;
      tokenState.consecutiveRefreshFailures += 1;
    },
    async markInstagramTokenAlertSent() {
      tokenState.lastAlertSentAt = new Date();
    },
    _posts: posts,
    _tokenState: tokenState
  };
}

module.exports = { makeFakeSocialDb };
