// test/helpers/fake-recovery-db.js
// "db" fals, in memorie, care REPLICA fidel contractul functiilor reale din db.js pentru
// order_notifications/recovery_client_state/email_marketing_suppressions/email_suppressions —
// ACELASI rol ca fake-meta-capi-db.js. findDueRecoveryCandidates() reimplementeaza in JS,
// PESTE fixtures `orders` seedate manual, exact aceeasi semantica ca SQL-ul real din db.js (vezi
// test/recovery-emails-db.test.js pentru verificarea SQL-ului propriu-zis, cu pool mockuit).

function makeFakeRecoveryDb() {
  const orders = new Map(); // id -> order fixture (camelCase, ca rowToOrder)
  const notifications = new Map(); // id -> row
  const byOrderType = new Map(); // `${orderId}:${type}` -> notification id
  const cooldowns = new Map(); // emailKey -> Date
  const marketingSuppressed = new Set();
  const bounceSuppressed = new Set();
  let nextId = 1;

  // emailMarketingOptOut: false implicit — reprezinta cazul TIPIC de test (comanda noua, clientul
  // NU a refuzat la colectarea emailului). Pentru comenzi ISTORICE (niciodata intrebate) sau care
  // AU refuzat explicit, suprascrie explicit cu null/true in fixture-ul specific acelui test.
  function seedOrder(order) {
    orders.set(order.id, { paidAt: null, anonymizedAt: null, checkoutCreatedAt: null, generatedAt: null, emailMarketingOptOut: false, ...order });
  }

  return {
    _orders: orders,
    _notifications: notifications,
    _cooldowns: cooldowns,
    _marketingSuppressed: marketingSuppressed,
    _bounceSuppressed: bounceSuppressed,
    seedOrder,

    async getOrderById(id) {
      return orders.get(id) || null;
    },

    async enqueueOrderNotification({ orderId, emailKey, notificationType, lang }) {
      const key = `${orderId}:${notificationType}`;
      if (byOrderType.has(key)) return null; // ON CONFLICT (order_id, notification_type) DO NOTHING
      const row = {
        id: `n${nextId++}`, orderId, emailKey, notificationType, lang: lang || null,
        status: 'pending', attempts: 0, maxAttempts: 5, nextAttemptAt: new Date(),
        claimedAt: null, lastAttemptAt: null, lastError: null, resendMessageId: null,
        createdAt: new Date(), sentAt: null
      };
      notifications.set(row.id, row);
      byOrderType.set(key, row.id);
      return { ...row };
    },

    async claimDueOrderNotification(types) {
      const now = Date.now();
      const candidates = [...notifications.values()]
        .filter((n) => n.status === 'pending' && types.includes(n.notificationType) && new Date(n.nextAttemptAt).getTime() <= now)
        .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());
      const claim = candidates[0];
      if (!claim) return null;
      claim.status = 'sending';
      claim.claimedAt = new Date();
      return { ...claim };
    },

    async finalizeOrderNotification(id, patch) {
      const existing = notifications.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, claimedAt: null };
      notifications.set(id, updated);
      return { ...updated };
    },

    async recoverStaleOrderNotifications(staleMinutes) {
      const cutoff = Date.now() - staleMinutes * 60 * 1000;
      const recovered = [];
      for (const n of notifications.values()) {
        if (n.status === 'sending' && n.claimedAt && new Date(n.claimedAt).getTime() < cutoff) {
          n.status = 'pending';
          n.nextAttemptAt = new Date();
          n.claimedAt = null;
          recovered.push({ ...n });
        }
      }
      return recovered;
    },

    async findDueRecoveryCandidates({ previewThresholdHours, checkoutThresholdHours, maxLookbackHours, cutoffSince, testEmails }) {
      const now = Date.now();
      const testSet = new Set((testEmails || []).map((e) => e.toLowerCase()));
      const cutoff = cutoffSince ? new Date(cutoffSince).getTime() : -Infinity;
      const hasNotification = (orderId, type) => byOrderType.has(`${orderId}:${type}`);
      const out = [];
      for (const o of orders.values()) {
        const emailKey = String(o.email || '').trim().toLowerCase();
        if (testSet.has(emailKey)) continue;
        if (o.anonymizedAt) continue;
        // email_marketing_opt_out = false (2026-09-25) — exclude ATAT true (a refuzat explicit)
        // CAT SI null/undefined (comanda veche, niciodata intrebata) — ACELASI predicat ca SQL-ul
        // real (db.js#findDueRecoveryCandidates).
        if (o.emailMarketingOptOut !== false) continue;

        if (o.status === 'preview_ready' && !o.paidAt && !o.checkoutCreatedAt && o.generatedAt && !hasNotification(o.id, 'preview_recovery')) {
          const t = new Date(o.generatedAt).getTime();
          if (t <= now - previewThresholdHours * 3600 * 1000 && t >= now - maxLookbackHours * 3600 * 1000 && t >= cutoff) {
            out.push({ orderId: o.id, emailKey, lang: o.lang, notificationType: 'preview_recovery', qualifyingAt: o.generatedAt });
          }
        }
        if (o.checkoutCreatedAt && !o.paidAt && o.status !== 'generation_failed' && !hasNotification(o.id, 'checkout_recovery')) {
          const t = new Date(o.checkoutCreatedAt).getTime();
          if (t <= now - checkoutThresholdHours * 3600 * 1000 && t >= now - maxLookbackHours * 3600 * 1000 && t >= cutoff) {
            out.push({ orderId: o.id, emailKey, lang: o.lang, notificationType: 'checkout_recovery', qualifyingAt: o.checkoutCreatedAt });
          }
        }
      }
      return out;
    },

    async getRecoveryClientCooldown(emailKey) {
      return cooldowns.get(emailKey) || null;
    },
    async touchRecoveryClientCooldown(emailKey) {
      cooldowns.set(emailKey, new Date());
    },

    async isEmailMarketingSuppressed(email) {
      return marketingSuppressed.has(String(email || '').toLowerCase().trim());
    },
    async addEmailMarketingSuppression(email) {
      marketingSuppressed.add(String(email || '').toLowerCase().trim());
    },
    async isEmailSuppressed(email) {
      return bounceSuppressed.has(String(email || '').toLowerCase().trim());
    }
  };
}

module.exports = { makeFakeRecoveryDb };
