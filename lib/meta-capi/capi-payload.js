// lib/meta-capi/capi-payload.js
// Logica PURA (fara I/O) de construire a evenimentului Meta Conversions API "Purchase" —
// extrasa separat ca sa fie testabila izolat, pe acelasi model ca lib/social/social-retry.js.
// NU contine niciodata access_token (acela traieste STRICT in capi-client.js, la momentul
// trimiterii, niciodata persistat in payload-ul salvat in DB — vezi db.enqueueMetaCapiEvent).

const { createHash } = require('crypto');

// Normalizare email ceruta de Meta pentru hashing: lowercase + fara spatii la capete. Meta NU
// cere eliminarea punctelor/alias-urilor (spre deosebire de conventia Gmail) — STRICT
// trim+lowercase, documentat explicit de Meta pentru parametrul `em`.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return sha256Hex(normalized);
}

// event_id determinist — STRICT derivat din orderId, niciodata aleator: Purchase se intampla o
// singura data per comanda (garantat de gate-ul isNewEvent/alreadyPaid din processConfirmedPayment,
// server.js), deci acelasi event_id la fiecare eventuala reincercare (retry outbox) — cerinta
// explicita de idempotenta/deduplicare.
function buildEventId(orderId) {
  return `purchase_${orderId}`;
}

// Construieste evenimentul COMPLET (fara access_token) trimis catre Meta — apelat o singura
// data, la momentul platii confirmate (processConfirmedPayment), si REFOLOSIT neschimbat la
// fiecare eventuala reincercare (payload-ul persistat in meta_capi_events.payload, vezi db.js).
//
// fbp: STRICT trecut mai departe daca a fost deja capturat (order.fbp, vezi coloana existenta
// orders.fbp) — NICIODATA inventat aici daca lipseste (cerinta explicita "nu inventa fbp").
// fbc: NU exista inca nicio infrastructura care il capteaza (niciun fbclid->_fbc pe acest site)
// — parametrul nu e acceptat de aceasta functie, ca sa nu poata fi introdus accidental cu o
// valoare inventata/derivata gresit dintr-un alt camp (ex. fbclid brut, care NU e acelasi lucru
// ca _fbc).
// NOTA: test_event_code (META_CAPI_TEST_EVENT_CODE) NU face parte din acest payload — e citit
// PROASPAT din mediu la fiecare incercare reala de trimitere (vezi capi-client.js/capi-worker.js),
// niciodata inghetat aici la momentul enqueue-ului, ca activarea/dezactivarea Test Events sa nu
// depinda de cand anume a fost creat randul in coada.
function buildPurchaseEvent({ orderId, eventTimeSeconds, value, currency, email, fbp, eventSourceUrl }) {
  const emailHash = hashEmail(email);
  const userData = {};
  if (emailHash) userData.em = [emailHash];
  if (fbp) userData.fbp = fbp;

  const event = {
    event_name: 'Purchase',
    event_time: eventTimeSeconds,
    event_id: buildEventId(orderId),
    action_source: 'website',
    user_data: userData,
    custom_data: {
      currency: (currency || 'GBP').toUpperCase(),
      value,
      order_id: orderId
    }
  };
  if (eventSourceUrl) event.event_source_url = eventSourceUrl;
  return event;
}

module.exports = { normalizeEmail, sha256Hex, hashEmail, buildEventId, buildPurchaseEvent };
