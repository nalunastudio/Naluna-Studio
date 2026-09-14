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

  // ==========================================================================================
  // API PUBLIC — folosit de paginile individuale (comanda.html, melodia-mea.html etc.)
  // ==========================================================================================

  // Trimite un eveniment GA4 — no-op silentios daca: consimtamantul nu e 'granted', gtag nu
  // exista (blocat/inca neincarcat) sau orice alta eroare neasteptata.
  function track(eventName, extraParams) {
    try {
      if (!isConsentGranted(readConsent())) return;
      if (typeof global.gtag !== 'function') return;
      global.gtag('event', eventName, buildEventParams(extraParams));
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
      hideBanner();
    });
    rejectBtn.addEventListener('click', function () {
      writeConsent('denied');
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
    // expuse STRICT pentru teste (logica pura, fara efecte asupra paginii reale)
    _isConsentGranted: isConsentGranted,
    _isConsentDecided: isConsentDecided,
    _buildEventParams: buildEventParams
  };
})(window);
