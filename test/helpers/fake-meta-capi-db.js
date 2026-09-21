// test/helpers/fake-meta-capi-db.js
// "db" fals, in memorie, care REPLICA fidel contractul functiilor reale din db.js pentru
// meta_capi_events (verificat manual fata de SQL-ul real din db.js) — acelasi rol ca
// fake-social-db.js pentru social_posts. NU e Postgres, dar codifica exact acelasi contract:
// enqueue idempotent (UNIQUE order_id), claim atomic (FOR UPDATE SKIP LOCKED simulat), finalize,
// recuperare dupa crash (randuri 'sending' stale).

function makeFakeMetaCapiDb() {
  const events = new Map(); // id -> event
  const byOrderId = new Map();

  return {
    async enqueueMetaCapiEvent({ orderId, eventId, payload }) {
      if (byOrderId.has(orderId)) return null; // ON CONFLICT (order_id) DO NOTHING
      const row = {
        id: `evt-${events.size + 1}`,
        orderId, eventId, payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: 8,
        nextAttemptAt: new Date(),
        claimedAt: null,
        lastAttemptAt: null,
        lastError: null,
        createdAt: new Date(),
        sentAt: null
      };
      events.set(row.id, row);
      byOrderId.set(orderId, row);
      return { ...row };
    },
    async claimDueMetaCapiEvent() {
      const now = Date.now();
      const candidates = [...events.values()]
        .filter((e) => e.status === 'pending' && new Date(e.nextAttemptAt).getTime() <= now)
        .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());
      const claim = candidates[0];
      if (!claim) return null;
      claim.status = 'sending';
      claim.claimedAt = new Date();
      return { ...claim };
    },
    async finalizeMetaCapiEvent(id, patch) {
      const existing = events.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, claimedAt: null };
      events.set(id, updated);
      byOrderId.set(existing.orderId, updated);
      return { ...updated };
    },
    async recoverStaleMetaCapiEvents(staleMinutes) {
      const cutoff = Date.now() - staleMinutes * 60 * 1000;
      const recovered = [];
      for (const e of events.values()) {
        if (e.status === 'sending' && e.claimedAt && new Date(e.claimedAt).getTime() < cutoff) {
          e.status = 'pending';
          e.nextAttemptAt = new Date();
          e.claimedAt = null;
          recovered.push({ ...e });
        }
      }
      return recovered;
    },
    async getMetaCapiEventByOrderId(orderId) {
      const row = byOrderId.get(orderId);
      return row ? { ...row } : null;
    },
    _events: events
  };
}

module.exports = { makeFakeMetaCapiDb };
