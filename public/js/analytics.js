// ANALYTICS NALUNA (2026-09-14) — Google Analytics 4, STRICT dupa consimtamant explicit.
//
// Modul PARTAJAT (incarcat de toate paginile publice relevante), acelasi tipar ca
// media-compress.js — un singur fisier, incarcat static din /js/, fara build step.
//
// PRINCIPIU DE BAZA (UK/UE — GDPR/PECR): gtag.js NU se incarca deloc, si niciun cookie de
// analytics NU se seteaza, inainte ca utilizatorul sa apese explicit "Accept" pe bannerul de
// mai jos. Alegerea (accept/refuz) se retine in localStorage — bannerul nu mai reapare dupa
// prima alegere, dar poate fi redeschis oricand din link-ul mic "Cookie settings".
//
// Measurement ID-ul vine STRICT din window.NALUNA_GA_MEASUREMENT_ID, injectat de server la
// runtime din variabila de mediu GA_MEASUREMENT_ID (vezi GET /js/config.js, server.js) —
// niciodata hardcodat aici. Daca variabila de mediu lipseste, analytics.js nu incarca nimic
// (banner-ul de consimtamant tot apare, dar acceptarea lui nu are niciun efect vizibil —
// comportament sigur, niciodata o eroare).
//
// ANALYTICS NU TREBUIE SA POATA BLOCA NICIODATA FLUXUL DE COMANDA: fiecare functie publica de
// mai jos e invelita in try/catch — orice eroare (gtag lipsa, ad-blocker, localStorage
// indisponibil in mod privat) esueaza silentios, niciodata aruncata mai departe catre codul
// paginii care a apelat-o.
(function (global) {
  'use strict';

  var CONSENT_KEY = 'naluna_consent'; // 'granted' | 'denied' — absent = inca nedecis
  var GA_ID = (global.NALUNA_GA_MEASUREMENT_ID || '').trim();

  var gaLoadStarted = false;

  // FUNNEL ANALYTICS (2026-09-18) — visitor_id anonim (UUID, crypto.randomUUID()) STRICT dupa
  // consimtamant, folosit DOAR pentru a lega evenimentele funnel (funnel_events, DB interna) de
  // un vizitator anonim, niciodata pentru identificare (fara nume/email/IP). Lista de mai jos
  // trebuie sa ramana IDENTICA cu TRACKABLE_EVENTS din server.js (POST /api/track) — evenimente
  // in afara ei raman STRICT GA4 (niciun request suplimentar catre server).
  var VISITOR_ID_KEY = 'naluna_visitor_id';
  var FUNNEL_TRACKABLE_EVENTS = [
    'cta_clicked', 'order_page_viewed', 'form_started', 'form_step_viewed', 'form_completed',
    'generation_completed', 'generation_failed', 'checkout_clicked', 'checkout_returned_unpaid'
  ];

  // ==========================================================================================
  // LOGICA PURA — fara acces DOM/localStorage direct, testabila izolat (vezi
  // test/analytics-client.test.js, care extrage aceste functii textual, exact ca testele
  // existente pentru server.js).
  // ==========================================================================================

  // Decide daca un consimtamant citit din storage (string brut, posibil null/invalid) inseamna
  // "analytics permis" — STRICT egalitate cu 'granted', niciodata un fallback permisiv pentru
  // valori necunoscute/corupte.
  function isConsentGranted(rawConsentValue) {
    return rawConsentValue === 'granted';
  }

  // true STRICT pentru 'granted'/'denied' — orice altceva (null, string gol, valoare corupta)
  // inseamna "inca nedecis", deci bannerul trebuie aratat.
  function isConsentDecided(rawConsentValue) {
    return rawConsentValue === 'granted' || rawConsentValue === 'denied';
  }

  // Construieste payload-ul GA4 pentru un eveniment — functie pura, ca sa poata fi verificat
  // programatic (teste) ca NICIUN camp trimis nu contine PII (nume/email/poveste/etc.) si ca
  // parametrii sunt exact cei asteptati, fara sa fie nevoie de un browser real.
  function buildEventParams(extraParams) {
    var params = {};
    if (extraParams && typeof extraParams === 'object') {
      for (var key in extraParams) {
        if (Object.prototype.hasOwnProperty.call(extraParams, key)) {
          params[key] = extraParams[key];
        }
      }
    }
    return params;
  }

  // ==========================================================================================
  // STORAGE — izolat in functii mici, fiecare cu propriul try/catch (Safari mod privat / politici
  // stricte de browser pot arunca la orice acces localStorage, nu doar la citire).
  // ==========================================================================================
  function readConsent() {
    try { return global.localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function writeConsent(value) {
    try { global.localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* best-effort */ }
  }

  // Anonim, generat DOAR dupa consimtamant, persistat local — refuzul/revocarea consimtamantului
  // (readConsent() != 'granted') face aceasta functie sa returneze mereu null, fara sa citeasca
  // sau sa scrie vreo valoare veche ramasa in storage dintr-o eventuala acceptare anterioara.
  function getOrCreateVisitorId() {
    try {
      if (!isConsentGranted(readConsent())) return null;
      var existing = global.localStorage.getItem(VISITOR_ID_KEY);
      if (existing) return existing;
      if (!global.crypto || typeof global.crypto.randomUUID !== 'function') return null;
      var id = global.crypto.randomUUID();
      global.localStorage.setItem(VISITOR_ID_KEY, id);
      return id;
    } catch (e) { return null; }
  }

  // ==========================================================================================
  // GA4 — incarcare STRICT dupa consimtamant, o singura data per pagina (gaLoadStarted).
  // ==========================================================================================
  function loadGtagIfNeeded() {
    if (gaLoadStarted || !GA_ID) return;
    gaLoadStarted = true;
    try {
      global.dataLayer = global.dataLayer || [];
      global.gtag = function () { global.dataLayer.push(arguments); };
      global.gtag('js', new Date());
      // anonymize_ip: nu e strict necesar pentru GA4 (IP-ul nu mai e stocat oricum, spre
      // deosebire de Universal Analytics), dar nu costa nimic si ramane un semnal explicit,
      // documentat, de minimizare a datelor.
      global.gtag('config', GA_ID, { anonymize_ip: true });
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
      document.head.appendChild(script);
    } catch (e) { /* analytics nu trebuie sa poata rupe pagina */ }
  }

  function applyStoredConsent() {
    if (isConsentGranted(readConsent())) loadGtagIfNeeded();
  }

  // CORECTIE (2026-09-18, verificare revocare consimtamant): gtag.js, o data INCARCAT, poate
  // trimite singur catre Google evenimente automate (ex. ping-uri periodice de "user engagement"
  // cat timp pagina ramane deschisa) care NU trec prin functia noastra track() — a opri STRICT
  // apelurile track() ulterioare (ce faceam pana acum) nu opreste si aceste ping-uri automate ale
  // bibliotecii deja incarcate. Google Consent Mode e mecanismul DOCUMENTAT oficial pentru asta:
  // gtag('consent', 'update', ...) instruieste biblioteca INSASI sa opreasca orice trimitere,
  // indiferent de sursa apelului. No-op sigur daca gtag nu exista inca (nu a fost niciodata
  // acordat consimtamant, deci nu s-a incarcat).
  function updateGtagConsent(granted) {
    try {
      if (typeof global.gtag === 'function') {
        global.gtag('consent', 'update', { analytics_storage: granted ? 'granted' : 'denied' });
      }
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  // Revocare (2026-09-18): la refuz — fie prima alegere, fie o revocare ulterioara unei acceptari
  // anterioare (din link-ul "Cookie settings") — STERGE si identificatorul anonim local
  // (visitor_id) deja creat. getOrCreateVisitorId() oricum nu l-ar mai fi citit/folosit cat timp
  // consimtamantul ramane refuzat, dar il eliminam explicit din storage: (a) niciun identificator
  // de urmarire nu ramane "in asteptare" in browser-ul utilizatorului dupa retragere, (b) daca
  // utilizatorul accepta din nou mai tarziu, primeste un visitor_id NOU, nu il reia pe cel
  // asociat activitatii dinainte de retragere.
  function clearVisitorId() {
    try { global.localStorage.removeItem(VISITOR_ID_KEY); } catch (e) { /* best-effort */ }
  }

  // ==========================================================================================
  // API PUBLIC — folosit de paginile individuale (comanda.html, melodia-mea.html etc.)
  // ==========================================================================================

  // Trimite evenimentul catre POST /api/track (DB interna, funnel_events) — complet SEPARAT de
  // GA4 (esecul unuia nu afecteaza celalalt), STRICT dupa consimtamant, STRICT pentru evenimentele
  // din FUNNEL_TRACKABLE_EVENTS (vezi mai sus). Fire-and-forget: raspunsul nu e niciodata asteptat
  // de codul paginii, un esec de retea nu genereaza nicio eroare vizibila.
  // extraParams poate contine STRICT o cheie rezervata `orderId` (trimisa separat, cand comanda
  // deja exista — ex. checkout_clicked) — restul cheilor devin `meta`, filtrate oricum server-side
  // printr-un allowlist per eveniment (vezi TRACK_META_ALLOWLIST, server.js).
  function postTrackEvent(eventName, extraParams) {
    try {
      var visitorId = getOrCreateVisitorId();
      if (!visitorId || typeof global.fetch !== 'function') return;
      var attribution = (global.NalunaAttribution && typeof global.NalunaAttribution.getStoredAttribution === 'function')
        ? global.NalunaAttribution.getStoredAttribution() : {};
      var meta = {};
      var orderId = null;
      if (extraParams && typeof extraParams === 'object') {
        for (var key in extraParams) {
          if (!Object.prototype.hasOwnProperty.call(extraParams, key)) continue;
          if (key === 'orderId') { orderId = extraParams[key]; continue; }
          meta[key] = extraParams[key];
        }
      }
      var body = JSON.stringify({
        eventName: eventName,
        visitorId: visitorId,
        orderId: orderId,
        utmSource: attribution.utm_source || null,
        utmMedium: attribution.utm_medium || null,
        utmCampaign: attribution.utm_campaign || null,
        utmContent: attribution.utm_content || null,
        utmTerm: attribution.utm_term || null,
        fbclid: attribution.fbclid || null,
        meta: meta
      });
      global.fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
        .catch(function () { /* best-effort — niciodata nu blocam pagina */ });
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  // Trimite un eveniment GA4 — no-op silentios daca: consimtamantul nu e 'granted', gtag nu
  // exista (blocat/inca neincarcat) sau orice alta eroare neasteptata. Independent, si tot dupa
  // consimtamant, poate trimite ACELASI eveniment si catre funnel_events (DB interna) — vezi
  // postTrackEvent — pentru un KPI operational care nu depinde de posibilitatea de a interoga GA4.
  function track(eventName, extraParams) {
    try {
      if (!isConsentGranted(readConsent())) return;
      if (typeof global.gtag === 'function') {
        global.gtag('event', eventName, buildEventParams(extraParams));
      }
      if (FUNNEL_TRACKABLE_EVENTS.indexOf(eventName) !== -1) {
        postTrackEvent(eventName, extraParams);
      }
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  // form_started: ataseaza UN SINGUR listener care se auto-elimina dupa prima interactie reala
  // (input SAU change) — garanteaza trimiterea o singura data per incarcare de pagina, niciodata
  // la fiecare tasta/camp, exact cerinta explicita.
  function onFormStarted(formSelector, eventName) {
    try {
      var form = document.querySelector(formSelector);
      if (!form) return;
      var fired = false;
      function handler() {
        if (fired) return;
        fired = true;
        track(eventName || 'form_started');
        form.removeEventListener('input', handler, true);
        form.removeEventListener('change', handler, true);
      }
      form.addEventListener('input', handler, true);
      form.addEventListener('change', handler, true);
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  // client_id GA4 — folosit STRICT pentru a atasa achizitia (purchase, server-side) de aceeasi
  // calatorie de utilizator masurata client-side (atributie corecta sursa/UTM). Timeout scurt,
  // obligatoriu — daca gtag nu raspunde (blocat, inca neincarcat, consimtamant refuzat), NU
  // blocam niciodata checkout-ul; rezolva pur si simplu null, apelantul trece mai departe fara el.
  function getClientId(timeoutMs) {
    return new Promise(function (resolve) {
      try {
        if (!isConsentGranted(readConsent()) || typeof global.gtag !== 'function' || !GA_ID) {
          return resolve(null);
        }
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve(null); }
        }, timeoutMs || 300);
        global.gtag('get', GA_ID, 'client_id', function (id) {
          if (!done) { done = true; clearTimeout(timer); resolve(id || null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  // session_id GA4 (2026-09-14, corectie — atribuire sesiune pentru "purchase" server-side):
  // client_id (mai sus) identifica VIZITATORUL, dar NU e suficient pentru ca Measurement
  // Protocol sa lege evenimentul de ACEEASI sesiune deja masurata client-side (begin_checkout
  // etc.) — fara session_id, GA4 poate crea o sesiune noua, sintetica, pentru hit-ul server-side,
  // fara context de sursa/campanie, aparand ca "(not set)" in rapoartele scoped-la-sesiune
  // pentru acel purchase. Acelasi tipar STRICT ca getClientId() — timeout scurt obligatoriu,
  // niciodata nu blocam checkout-ul, rezolva null daca gtag nu raspunde.
  function getSessionId(timeoutMs) {
    return new Promise(function (resolve) {
      try {
        if (!isConsentGranted(readConsent()) || typeof global.gtag !== 'function' || !GA_ID) {
          return resolve(null);
        }
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve(null); }
        }, timeoutMs || 300);
        global.gtag('get', GA_ID, 'session_id', function (id) {
          if (!done) { done = true; clearTimeout(timer); resolve(id || null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  // ==========================================================================================
  // BANNER DE CONSIMTAMANT — injectat o singura data (nu duplica markup in fiecare pagina HTML).
  // Minimal, deliberat — STRICT Accept/Refuz pentru o singura categorie (analytics), pentru ca
  // e singura categorie non-esentiala folosita de site (accessToken din localStorage e strict
  // functional, nu necesita consimtamant).
  // ==========================================================================================
  var BANNER_ID = 'naluna-cookie-banner';
  var SETTINGS_LINK_ID = 'naluna-cookie-settings-link';

  function renderBanner(lang) {
    if (document.getElementById(BANNER_ID)) return;
    var copy = {
      ro: { text: 'Folosim cookie-uri de analiză, doar cu acordul tău, ca să înțelegem cum e folosit site-ul. Poți schimba oricând alegerea din link-ul „Cookie settings”.', accept: 'Accept', reject: 'Refuz' },
      en: { text: 'We use analytics cookies, only with your consent, to understand how the site is used. You can change your choice anytime from the "Cookie settings" link.', accept: 'Accept', reject: 'Reject' }
    };
    var c = copy[lang] || copy.en;
    var el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#2B2016;color:#F3ECE0;padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:center;font:14px/1.4 system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.15);';
    var textEl = document.createElement('span');
    textEl.style.cssText = 'max-width:640px;';
    textEl.textContent = c.text;
    var btnWrap = document.createElement('span');
    btnWrap.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';
    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = c.accept;
    acceptBtn.style.cssText = 'background:#8B6D3F;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font:inherit;';
    var rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.textContent = c.reject;
    rejectBtn.style.cssText = 'background:transparent;color:#F3ECE0;border:1px solid #F3ECE0;padding:8px 16px;border-radius:6px;cursor:pointer;font:inherit;';
    acceptBtn.addEventListener('click', function () {
      writeConsent('granted');
      loadGtagIfNeeded();
      // Acopera si cazul "revocare, apoi re-acceptare, pe aceeasi incarcare de pagina": gtag.js
      // era deja incarcat (gaLoadStarted=true), deci loadGtagIfNeeded() de mai sus e un no-op —
      // fara acest apel explicit, biblioteca ar ramane "oprita" din update-ul de la refuz.
      updateGtagConsent(true);
      hideBanner();
    });
    rejectBtn.addEventListener('click', function () {
      writeConsent('denied');
      // Opreste orice trimitere ULTERIOARA a bibliotecii gtag.js deja incarcate (inclusiv
      // ping-uri automate de "user engagement", nu doar apelurile noastre track()) — vezi
      // comentariul de la updateGtagConsent — si sterge visitor_id-ul local deja creat.
      updateGtagConsent(false);
      clearVisitorId();
      hideBanner();
    });
    btnWrap.appendChild(acceptBtn);
    btnWrap.appendChild(rejectBtn);
    el.appendChild(textEl);
    el.appendChild(btnWrap);
    document.body.appendChild(el);
  }

  function hideBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function renderSettingsLink(lang) {
    if (document.getElementById(SETTINGS_LINK_ID)) return;
    var label = lang === 'ro' ? 'Cookie settings' : 'Cookie settings';
    var a = document.createElement('a');
    a.id = SETTINGS_LINK_ID;
    a.href = '#';
    a.textContent = label;
    a.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99998;font:11px system-ui,sans-serif;color:#8a8a8a;text-decoration:underline;background:rgba(250,248,245,.9);padding:2px 6px;border-radius:4px;';
    a.addEventListener('click', function (evt) {
      evt.preventDefault();
      renderBanner(lang);
    });
    document.body.appendChild(a);
  }

  function initConsentUi() {
    try {
      var lang = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);
      applyStoredConsent();
      if (!isConsentDecided(readConsent())) renderBanner(lang);
      renderSettingsLink(lang);
    } catch (e) { /* niciodata nu blocam pagina */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsentUi);
  } else {
    initConsentUi();
  }

  global.NalunaAnalytics = {
    track: track,
    onFormStarted: onFormStarted,
    getClientId: getClientId,
    getSessionId: getSessionId,
    // getOrCreateVisitorId — expus public: comanda.html il foloseste ca sa trimita visitorId
    // in payload-ul POST /api/orders (leaga evenimentele funnel pre-comanda de comanda creata).
    getOrCreateVisitorId: getOrCreateVisitorId,
    // expuse STRICT pentru teste (logica pura, fara efecte asupra paginii reale)
    _isConsentGranted: isConsentGranted,
    _isConsentDecided: isConsentDecided,
    _buildEventParams: buildEventParams,
    _postTrackEvent: postTrackEvent,
    _FUNNEL_TRACKABLE_EVENTS: FUNNEL_TRACKABLE_EVENTS,
    _updateGtagConsent: updateGtagConsent,
    _clearVisitorId: clearVisitorId
  };
})(window);
