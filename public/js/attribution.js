// ATRIBUIRE MARKETING NALUNA (2026-09-18, Meta Ads Funnel) — captare UTM + fbclid la aterizare,
// persistata STRICT local (localStorage), pentru a fi trimisa o singura data la crearea comenzii
// (vezi comanda.html, collectPayload). Modul PARTAJAT, acelasi tipar ca analytics.js — un singur
// fisier, incarcat static din /js/, fara build step.
//
// NICIODATA PII: STRICT identificatori de campanie/click (utm_source/medium/campaign/content/
// term, fbclid) — niciodata nume, email, poveste.
//
// "Ultima atingere cu parametri reali" — daca URL-ul curent NU are niciun utm_*/fbclid, valoarea
// deja stocata (dintr-o vizita anterioara, cu adevarat de la o reclama) ramane neatinsa; navigarea
// intre paginile site-ului, fara parametri noi, nu sterge atribuirea existenta. Expira dupa 30 de
// zile (fereastra rezonabila, apropiata de fereastra implicita de atribuire Meta) — dupa aceea,
// o comanda noua e considerata "fara atribuire cunoscuta", nu i se ataseaza o atingere prea veche.
(function (global) {
  'use strict';

  var STORAGE_KEY = 'naluna_attribution';
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  // ==========================================================================================
  // LOGICA PURA — fara acces DOM/storage direct, testabila izolat (vezi
  // test/attribution-client.test.js, acelasi tipar ca analytics-client.test.js).
  // ==========================================================================================

  // Extrage STRICT campurile cunoscute dintr-un obiect de parametri brut (ex. din
  // URLSearchParams convertit in obiect) — orice alt parametru din URL e ignorat.
  function parseAttributionParams(paramsObj) {
    var result = {};
    var hasAny = false;
    UTM_KEYS.forEach(function (key) {
      var v = paramsObj[key];
      if (typeof v === 'string' && v.trim()) { result[key] = v.trim().slice(0, 300); hasAny = true; }
    });
    if (typeof paramsObj.fbclid === 'string' && paramsObj.fbclid.trim()) {
      result.fbclid = paramsObj.fbclid.trim().slice(0, 300);
      hasAny = true;
    }
    return hasAny ? result : null;
  }

  // O valoare stocata e valida STRICT daca exista si nu a expirat — orice altceva (lipsa,
  // corupta, prea veche) inseamna "nicio atribuire cunoscuta".
  function isStoredValueValid(stored, nowMs) {
    if (!stored || typeof stored !== 'object' || typeof stored.capturedAt !== 'number') return false;
    return (nowMs - stored.capturedAt) < MAX_AGE_MS;
  }

  // ==========================================================================================
  // STORAGE — izolat, cu try/catch propriu (Safari mod privat / politici stricte pot arunca).
  // ==========================================================================================
  function readStored() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return isStoredValueValid(parsed, Date.now()) ? parsed : null;
    } catch (e) { return null; }
  }

  function writeStored(fields) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({ capturedAt: Date.now() }, fields)));
    } catch (e) { /* best-effort — o atribuire nesalvata nu blocheaza niciodata comanda */ }
  }

  // ==========================================================================================
  // CAPTARE — ruleaza o singura data, la incarcarea scriptului.
  // ==========================================================================================
  function captureFromCurrentUrl() {
    try {
      var search = new global.URLSearchParams(global.location.search);
      var raw = {};
      UTM_KEYS.concat(['fbclid']).forEach(function (key) { raw[key] = search.get(key); });
      var parsed = parseAttributionParams(raw);
      if (parsed) writeStored(parsed);
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  // API PUBLIC — folosit de comanda.html la crearea comenzii (collectPayload).
  function getStoredAttribution() {
    var stored = readStored();
    if (!stored) return {};
    var out = {};
    UTM_KEYS.concat(['fbclid']).forEach(function (key) { if (stored[key]) out[key] = stored[key]; });
    return out;
  }

  captureFromCurrentUrl();

  global.NalunaAttribution = {
    getStoredAttribution: getStoredAttribution,
    // expuse STRICT pentru teste (logica pura/re-declansare controlata, fara efecte reale in pagina)
    _parseAttributionParams: parseAttributionParams,
    _isStoredValueValid: isStoredValueValid,
    _captureFromCurrentUrl: captureFromCurrentUrl
  };
})(window);
