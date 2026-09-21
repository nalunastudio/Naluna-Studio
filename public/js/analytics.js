// ANALYTICS NALUNA (2026-09-14, extins 2026-09-21 — Consent + Privacy pentru Meta Ads) — Google
// Analytics 4, STRICT dupa consimtamant explicit. Modulul PARTAJAT deține ACUM și întregul model
// de consimtamant al site-ului (nu doar GA4): trei categorii — Necessary (mereu activa),
// Analytics (controleaza GA4 + funnel_events/visitor_id) si Marketing (pregatita, dar NEFOLOSITA
// inca de niciun cod — rezervata explicit pentru viitorul Meta Pixel/CAPI, care NU exista inca in
// acest fisier sau oriunde in site).
//
// Modul PARTAJAT (incarcat de toate paginile publice relevante), acelasi tipar ca
// media-compress.js — un singur fisier, incarcat static din /js/, fara build step.
//
// PRINCIPIU DE BAZA (UK/UE — GDPR/PECR): gtag.js NU se incarca deloc, si niciun cookie de
// analytics NU se seteaza, inainte ca utilizatorul sa apese explicit "Accept all" (sau sa
// activeze Analytics din "Manage preferences") pe bannerul de mai jos. Analytics si Marketing
// sunt independente — acceptarea uneia NU inseamna niciodata acceptarea celeilalte (nici in
// bannerul principal, nici in migrarea alegerii vechi, vezi parseConsentState mai jos). Alegerea
// se retine in localStorage — bannerul nu mai reapare dupa ce AMBELE categorii au o decizie
// explicita, dar poate fi redeschis oricand din link-ul mic "Cookie settings".
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

  // SCHEMA CONSIMTAMANT (v2, 2026-09-21) — aceeasi cheie localStorage ca inainte (fara migrare
  // "in umbra", fara chei duplicate ramase orfane), dar valoarea devine un obiect JSON
  // {"analytics":true|false,"marketing":true|false} in loc de un string simplu. Schema veche
  // (v1) — STRICT stringul 'granted'/'denied', o singura categorie (Analytics) — e citita si
  // migrata TRANSPARENT de parseConsentState() de mai jos, prima data cand cineva citeste
  // consimtamantul; scrierea urmatoare (accept all/reject/save preferences) o inlocuieste
  // definitiv cu schema noua. Vezi parseConsentState pentru regula EXACTA de migrare.
  var CONSENT_KEY = 'naluna_consent';
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
  // valori necunoscute/corupte. PASTRATA (schema v1): parseConsentState() de mai jos o foloseste
  // STRICT pentru migrarea valorii vechi — logica NOUA (isAnalyticsConsentGranted/
  // isMarketingConsentGranted) nu mai citeste niciodata un string brut direct.
  function isConsentGranted(rawConsentValue) {
    return rawConsentValue === 'granted';
  }

  // true STRICT pentru 'granted'/'denied' — orice altceva (null, string gol, valoare corupta)
  // inseamna "inca nedecis". PASTRATA (schema v1) STRICT pentru migrare — vezi isConsentGranted.
  function isConsentDecided(rawConsentValue) {
    return rawConsentValue === 'granted' || rawConsentValue === 'denied';
  }

  // ==========================================================================================
  // SCHEMA NOUA (v2) — starea de consimtamant ca obiect cu doua categorii independente.
  // { analytics: true|false|null, marketing: true|false|null } — null STRICT inseamna "inca
  // nedecis pentru acea categorie" (diferit de false = "refuzat explicit").
  // ==========================================================================================

  // Migrare TRANSPARENTA schema v1 -> v2, functie PURA (nu atinge storage-ul — vezi
  // readConsentState mai jos pentru citirea reala). Regula OBLIGATORIE (cerinta explicita a
  // migrarii): un consimtamant vechi pentru Analytics NU devine NICIODATA un consimtamant
  // implicit pentru Marketing — Marketing ramane STRICT null (nedecis) pentru orice utilizator
  // migrat dintr-o schema v1, indiferent daca Analytics fusese acceptat sau refuzat. Asta face
  // ca bannerul sa reapara O SINGURA DATA pentru utilizatorii vechi (Marketing nedecis =
  // consimtamant incomplet), dar NU reseteaza si NU re-cere niciodata alegerea deja facuta pentru
  // Analytics (vezi isAnalyticsConsentGranted/renderBanner — GA4 continua sa functioneze imediat,
  // fara nicio intrerupere, pe baza valorii migrate).
  function parseConsentState(raw) {
    if (isConsentDecided(raw)) {
      return { analytics: isConsentGranted(raw), marketing: null };
    }
    if (typeof raw === 'string' && raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            analytics: typeof parsed.analytics === 'boolean' ? parsed.analytics : null,
            marketing: typeof parsed.marketing === 'boolean' ? parsed.marketing : null
          };
        }
      } catch (e) { /* valoare corupta -> tratata ca nedecisa, niciodata o eroare */ }
    }
    return { analytics: null, marketing: null };
  }

  // O categorie e "acordata" STRICT daca valoarea e explicit true — null (nedecis) sau false
  // (refuzat) inseamna amandoua "nepermis", niciodata un fallback permisiv.
  function isCategoryGranted(value) {
    return value === true;
  }

  // Bannerul se ascunde STRICT cand AMBELE categorii au o decizie explicita (true SAU false) —
  // o singura categorie nedecisa (ex. Marketing dupa migrarea unui consimtamant vechi doar-
  // Analytics) inseamna ca bannerul tot trebuie aratat, ca utilizatorul sa poata decide explicit
  // si pentru categoria noua.
  function isStateFullyDecided(state) {
    return typeof state.analytics === 'boolean' && typeof state.marketing === 'boolean';
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
  function readConsentState() {
    var raw = null;
    try { raw = global.localStorage.getItem(CONSENT_KEY); } catch (e) { return { analytics: null, marketing: null }; }
    return parseConsentState(raw);
  }
  // Scrie STRICT schema noua (v2) — ambele categorii, mereu boolean explicit (niciodata null):
  // apelata doar din decizii reale ale utilizatorului (accept all/reject optional/save
  // preferences), unde ambele categorii sunt prin definitie decise in acel moment.
  function writeConsentState(analyticsGranted, marketingGranted) {
    try {
      global.localStorage.setItem(CONSENT_KEY, JSON.stringify({ analytics: !!analyticsGranted, marketing: !!marketingGranted }));
    } catch (e) { /* best-effort */ }
  }

  // SURSA UNICA DE ADEVAR pentru codul din afara acestui fisier (alte pagini, si viitorul cod
  // Meta) — niciun apelant nu trebuie sa citeasca vreodata localStorage sau sa interpreteze
  // schema de mai sus direct. STRICT true/false, niciodata null expus in afara.
  function isAnalyticsConsentGranted() {
    return isCategoryGranted(readConsentState().analytics);
  }
  function isMarketingConsentGranted() {
    return isCategoryGranted(readConsentState().marketing);
  }

  // Anonim, generat DOAR dupa consimtamant Analytics, persistat local — refuzul/revocarea
  // consimtamantului face aceasta functie sa returneze mereu null, fara sa citeasca sau sa scrie
  // vreo valoare veche ramasa in storage dintr-o eventuala acceptare anterioara.
  function getOrCreateVisitorId() {
    try {
      if (!isAnalyticsConsentGranted()) return null;
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
    if (isAnalyticsConsentGranted()) loadGtagIfNeeded();
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
      if (!isAnalyticsConsentGranted()) return;
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
        if (!isAnalyticsConsentGranted() || typeof global.gtag !== 'function' || !GA_ID) {
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
        if (!isAnalyticsConsentGranted() || typeof global.gtag !== 'function' || !GA_ID) {
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
  // BANNER DE CONSIMTAMANT (v2, 2026-09-21) — injectat o singura data (nu duplica markup in
  // fiecare pagina HTML). TREI categorii: Necessary (mereu activa, fara toggle), Analytics
  // (toggle), Marketing (toggle) — Accept all / Reject optional / Manage preferences pe ecranul
  // principal, Save preferences pe ecranul de gestionare. Niciun dark pattern: Accept all si
  // Reject optional sunt la fel de vizibile/accesibile (acelasi rand, aceeasi marime), Marketing
  // NU e niciodata prebifat.
  // ==========================================================================================
  var BANNER_ID = 'naluna-cookie-banner';
  var SETTINGS_LINK_ID = 'naluna-cookie-settings-link';

  // Traduceri complete (cele 8 limbi ale site-ului) — verificate structural in
  // test/analytics-consent-model.test.js (toate cheile prezente in toate limbile).
  var BANNER_COPY = {
    en: {
      text: 'We use analytics cookies, and optionally marketing cookies for future advertising, only with your consent. You can change your choice anytime from the "Cookie settings" link.',
      acceptAll: 'Accept all', rejectOptional: 'Reject optional', managePreferences: 'Manage preferences',
      panelTitle: 'Cookie preferences',
      necessaryLabel: 'Necessary', necessaryDesc: 'Always active — required for the site to work.',
      analyticsLabel: 'Analytics', analyticsDesc: 'Helps us understand how the site is used (Google Analytics).',
      marketingLabel: 'Marketing', marketingDesc: 'Optional, for future advertising tools (for example Meta/Facebook Ads). Not active yet — used only once you give this consent.',
      savePreferences: 'Save preferences', settingsLink: 'Cookie settings'
    },
    ro: {
      text: 'Folosim cookie-uri de analiză și, opțional, cookie-uri de marketing pentru viitoare reclame, doar cu acordul tău. Poți schimba oricând alegerea din link-ul „Setări cookie-uri”.',
      acceptAll: 'Accept tot', rejectOptional: 'Refuz opționale', managePreferences: 'Gestionează preferințele',
      panelTitle: 'Preferințe cookie-uri',
      necessaryLabel: 'Necesare', necessaryDesc: 'Mereu active — necesare pentru funcționarea site-ului.',
      analyticsLabel: 'Analiză', analyticsDesc: 'Ne ajută să înțelegem cum este folosit site-ul (Google Analytics).',
      marketingLabel: 'Marketing', marketingDesc: 'Opțional, pentru viitoare instrumente publicitare (de exemplu Meta/Facebook Ads). Nu este încă activ — va fi folosit doar după acest acord.',
      savePreferences: 'Salvează preferințele', settingsLink: 'Setări cookie-uri'
    },
    de: {
      text: 'Wir verwenden Analyse-Cookies und optional Marketing-Cookies für zukünftige Werbung, nur mit deiner Zustimmung. Du kannst deine Wahl jederzeit über den Link „Cookie-Einstellungen“ ändern.',
      acceptAll: 'Alle akzeptieren', rejectOptional: 'Optionale ablehnen', managePreferences: 'Einstellungen verwalten',
      panelTitle: 'Cookie-Einstellungen',
      necessaryLabel: 'Notwendig', necessaryDesc: 'Immer aktiv — für die Funktion der Website erforderlich.',
      analyticsLabel: 'Analyse', analyticsDesc: 'Hilft uns zu verstehen, wie die Website genutzt wird (Google Analytics).',
      marketingLabel: 'Marketing', marketingDesc: 'Optional, für zukünftige Werbetools (zum Beispiel Meta/Facebook Ads). Noch nicht aktiv — wird erst nach dieser Zustimmung verwendet.',
      savePreferences: 'Einstellungen speichern', settingsLink: 'Cookie-Einstellungen'
    },
    es: {
      text: 'Usamos cookies de análisis y, opcionalmente, cookies de marketing para futura publicidad, solo con tu consentimiento. Puedes cambiar tu elección en cualquier momento desde el enlace «Configuración de cookies».',
      acceptAll: 'Aceptar todo', rejectOptional: 'Rechazar opcionales', managePreferences: 'Gestionar preferencias',
      panelTitle: 'Preferencias de cookies',
      necessaryLabel: 'Necesarias', necessaryDesc: 'Siempre activas — necesarias para el funcionamiento del sitio.',
      analyticsLabel: 'Analítica', analyticsDesc: 'Nos ayuda a entender cómo se usa el sitio (Google Analytics).',
      marketingLabel: 'Marketing', marketingDesc: 'Opcional, para futuras herramientas publicitarias (por ejemplo Meta/Facebook Ads). Aún no está activo — se usará solo tras este consentimiento.',
      savePreferences: 'Guardar preferencias', settingsLink: 'Configuración de cookies'
    },
    it: {
      text: 'Utilizziamo cookie di analisi e, facoltativamente, cookie di marketing per future pubblicità, solo con il tuo consenso. Puoi cambiare la tua scelta in qualsiasi momento dal link «Impostazioni cookie».',
      acceptAll: 'Accetta tutto', rejectOptional: 'Rifiuta opzionali', managePreferences: 'Gestisci preferenze',
      panelTitle: 'Preferenze cookie',
      necessaryLabel: 'Necessari', necessaryDesc: 'Sempre attivi — necessari per il funzionamento del sito.',
      analyticsLabel: 'Analisi', analyticsDesc: 'Ci aiuta a capire come viene usato il sito (Google Analytics).',
      marketingLabel: 'Marketing', marketingDesc: 'Facoltativo, per futuri strumenti pubblicitari (ad esempio Meta/Facebook Ads). Non ancora attivo — sarà usato solo dopo questo consenso.',
      savePreferences: 'Salva preferenze', settingsLink: 'Impostazioni cookie'
    },
    fr: {
      text: "Nous utilisons des cookies d'analyse et, en option, des cookies marketing pour une future publicité, uniquement avec votre consentement. Vous pouvez modifier votre choix à tout moment via le lien « Paramètres des cookies ».",
      acceptAll: 'Tout accepter', rejectOptional: 'Refuser les optionnels', managePreferences: 'Gérer les préférences',
      panelTitle: 'Préférences de cookies',
      necessaryLabel: 'Nécessaires', necessaryDesc: 'Toujours actifs — nécessaires au fonctionnement du site.',
      analyticsLabel: 'Analyse', analyticsDesc: "Nous aide à comprendre comment le site est utilisé (Google Analytics).",
      marketingLabel: 'Marketing', marketingDesc: 'Facultatif, pour de futurs outils publicitaires (par exemple Meta/Facebook Ads). Pas encore actif — utilisé seulement après ce consentement.',
      savePreferences: 'Enregistrer les préférences', settingsLink: 'Paramètres des cookies'
    },
    bg: {
      text: 'Използваме бисквитки за анализ и, по избор, бисквитки за маркетинг за бъдещи реклами, само с вашето съгласие. Можете да промените избора си по всяко време от връзката „Настройки на бисквитките“.',
      acceptAll: 'Приеми всички', rejectOptional: 'Откажи незадължителните', managePreferences: 'Управление на предпочитанията',
      panelTitle: 'Предпочитания за бисквитки',
      necessaryLabel: 'Необходими', necessaryDesc: 'Винаги активни — необходими за работата на сайта.',
      analyticsLabel: 'Анализ', analyticsDesc: 'Помага ни да разберем как се използва сайтът (Google Analytics).',
      marketingLabel: 'Маркетинг', marketingDesc: 'По избор, за бъдещи рекламни инструменти (например Meta/Facebook Ads). Все още не е активно — ще се използва само след това съгласие.',
      savePreferences: 'Запази предпочитанията', settingsLink: 'Настройки на бисквитките'
    },
    tr: {
      text: 'Analiz çerezlerini ve isteğe bağlı olarak ileride kullanılacak reklam çerezlerini yalnızca onayınızla kullanıyoruz. Seçiminizi istediğiniz zaman "Çerez ayarları" bağlantısından değiştirebilirsiniz.',
      acceptAll: 'Tümünü kabul et', rejectOptional: 'İsteğe bağlı olanları reddet', managePreferences: 'Tercihleri yönet',
      panelTitle: 'Çerez tercihleri',
      necessaryLabel: 'Gerekli', necessaryDesc: 'Her zaman etkin — sitenin çalışması için gereklidir.',
      analyticsLabel: 'Analiz', analyticsDesc: 'Sitenin nasıl kullanıldığını anlamamıza yardımcı olur (Google Analytics).',
      marketingLabel: 'Pazarlama', marketingDesc: 'İsteğe bağlı, ileride kullanılacak reklam araçları için (örneğin Meta/Facebook Ads). Henüz etkin değil — yalnızca bu onaydan sonra kullanılacaktır.',
      savePreferences: 'Tercihleri kaydet', settingsLink: 'Çerez ayarları'
    }
  };

  // Aplica o decizie completa (ambele categorii, mereu boolean explicit) — SINGURUL loc care
  // scrie in storage din banner, folosit de toate cele 3 actiuni (accept all/reject optional/
  // save preferences), ca sa nu existe 3 implementari usor divergente ale acelorasi efecte.
  function applyConsentDecision(analyticsGranted, marketingGranted) {
    writeConsentState(analyticsGranted, marketingGranted);
    if (analyticsGranted) {
      loadGtagIfNeeded();
      // Acopera si cazul "revocare, apoi re-acceptare, pe aceeasi incarcare de pagina": gtag.js
      // era deja incarcat (gaLoadStarted=true), deci loadGtagIfNeeded() de mai sus e un no-op —
      // fara acest apel explicit, biblioteca ar ramane "oprita" din update-ul de la refuz.
      updateGtagConsent(true);
    } else {
      // Opreste orice trimitere ULTERIOARA a bibliotecii gtag.js deja incarcate (inclusiv
      // ping-uri automate de "user engagement", nu doar apelurile noastre track()) si sterge
      // visitor_id-ul local deja creat.
      updateGtagConsent(false);
      clearVisitorId();
    }
    // Marketing NU are inca niciun efect de aplicat (niciun Meta Pixel/CAPI in acest fisier) —
    // scrierea de mai sus e STRICT persistenta deciziei, pentru citire ulterioara de
    // isMarketingConsentGranted() de catre viitorul cod Meta.
    hideBanner();
  }

  function renderBanner(lang) {
    if (document.getElementById(BANNER_ID)) return;
    var c = BANNER_COPY[lang] || BANNER_COPY.en;
    var state = readConsentState();

    var el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#2B2016;color:#F3ECE0;padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:center;font:14px/1.4 system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.15);max-height:80vh;overflow:auto;';

    // ------------------------------------------------------------------------------------
    // Ecran principal — text + Accept all / Reject optional / Manage preferences.
    // ------------------------------------------------------------------------------------
    var mainView = document.createElement('div');
    mainView.id = 'naluna-consent-main-view';
    mainView.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:center;width:100%;';
    var textEl = document.createElement('span');
    textEl.style.cssText = 'max-width:640px;';
    textEl.textContent = c.text;
    var btnWrap = document.createElement('span');
    btnWrap.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;';

    function makeButton(id, label, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = id;
      btn.textContent = label;
      btn.style.cssText = primary
        ? 'background:#8B6D3F;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font:inherit;'
        : 'background:transparent;color:#F3ECE0;border:1px solid #F3ECE0;padding:8px 16px;border-radius:6px;cursor:pointer;font:inherit;';
      return btn;
    }

    var acceptAllBtn = makeButton('naluna-consent-accept-all', c.acceptAll, true);
    var rejectOptionalBtn = makeButton('naluna-consent-reject-optional', c.rejectOptional, false);
    var manageBtn = makeButton('naluna-consent-manage', c.managePreferences, false);

    acceptAllBtn.addEventListener('click', function () { applyConsentDecision(true, true); });
    rejectOptionalBtn.addEventListener('click', function () { applyConsentDecision(false, false); });

    btnWrap.appendChild(acceptAllBtn);
    btnWrap.appendChild(rejectOptionalBtn);
    btnWrap.appendChild(manageBtn);
    mainView.appendChild(textEl);
    mainView.appendChild(btnWrap);

    // ------------------------------------------------------------------------------------
    // Ecran "Manage preferences" — Necessary (mereu activ, fara toggle) + Analytics/Marketing
    // (toggle-uri independente) + Save preferences. Ascuns implicit; Marketing NU e niciodata
    // prebifat (nici pentru un utilizator nou, nici pentru unul migrat dintr-o schema veche).
    // ------------------------------------------------------------------------------------
    var panelView = document.createElement('div');
    panelView.id = 'naluna-consent-panel-view';
    panelView.style.cssText = 'display:none;flex-direction:column;gap:10px;width:100%;max-width:520px;';

    var panelTitleEl = document.createElement('strong');
    panelTitleEl.textContent = c.panelTitle;

    function makeRow(labelText, descText, toggleId, checked, disabled) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;';
      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = toggleId;
      toggle.checked = !!checked;
      toggle.disabled = !!disabled;
      var textWrap = document.createElement('span');
      var labelEl = document.createElement('strong');
      labelEl.textContent = labelText;
      var descEl = document.createElement('div');
      descEl.style.cssText = 'font-weight:normal;opacity:.85;font-size:13px;';
      descEl.textContent = descText;
      textWrap.appendChild(labelEl);
      textWrap.appendChild(descEl);
      row.appendChild(toggle);
      row.appendChild(textWrap);
      return { row: row, toggle: toggle };
    }

    var necessaryRow = makeRow(c.necessaryLabel, c.necessaryDesc, 'naluna-consent-necessary-toggle', true, true);
    // Analytics reflecta alegerea deja salvata (inclusiv una migrata dintr-o schema veche) —
    // NICIODATA resetata la reafisarea panoului. Marketing reflecta STRICT o alegere EXPLICITA
    // anterioara (true) — null (nedecis) sau false raman amandoua neselectate.
    var analyticsRow = makeRow(c.analyticsLabel, c.analyticsDesc, 'naluna-consent-analytics-toggle', state.analytics === true, false);
    var marketingRow = makeRow(c.marketingLabel, c.marketingDesc, 'naluna-consent-marketing-toggle', state.marketing === true, false);

    var saveBtn = makeButton('naluna-consent-save', c.savePreferences, true);
    saveBtn.addEventListener('click', function () {
      applyConsentDecision(!!analyticsRow.toggle.checked, !!marketingRow.toggle.checked);
    });

    panelView.appendChild(panelTitleEl);
    panelView.appendChild(necessaryRow.row);
    panelView.appendChild(analyticsRow.row);
    panelView.appendChild(marketingRow.row);
    panelView.appendChild(saveBtn);

    manageBtn.addEventListener('click', function () {
      mainView.style.display = 'none';
      panelView.style.display = 'flex';
    });

    el.appendChild(mainView);
    el.appendChild(panelView);
    document.body.appendChild(el);
  }

  function hideBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function renderSettingsLink(lang) {
    if (document.getElementById(SETTINGS_LINK_ID)) return;
    var c = BANNER_COPY[lang] || BANNER_COPY.en;
    var a = document.createElement('a');
    a.id = SETTINGS_LINK_ID;
    a.href = '#';
    a.textContent = c.settingsLink;
    a.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99998;font:11px system-ui,sans-serif;color:#8a8a8a;text-decoration:underline;background:rgba(250,248,245,.9);padding:2px 6px;border-radius:4px;';
    a.addEventListener('click', function (evt) {
      evt.preventDefault();
      // "Cookie settings" reafiseaza mereu bannerul (redeschis ca ecran principal) — daca
      // fusese deja ascuns (hideBanner()), getElementById(BANNER_ID) e din nou null, deci
      // renderBanner il reconstruieste, citind starea CURENTA din storage pentru panou.
      renderBanner(lang);
    });
    document.body.appendChild(a);
  }

  function initConsentUi() {
    try {
      var lang = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);
      applyStoredConsent();
      // Bannerul reapare STRICT cand cel putin o categorie nu are inca o decizie explicita —
      // acopera atat vizitatorul complet nou (ambele null), CAT SI utilizatorul migrat dintr-o
      // schema veche doar-Analytics (Marketing ramane null pana decide explicit), fara sa
      // resetaze NICIODATA alegerea Analytics deja aplicata mai sus de applyStoredConsent().
      if (!isStateFullyDecided(readConsentState())) renderBanner(lang);
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
    // SURSA UNICA DE ADEVAR pentru consimtamant (2026-09-21, Consent + Privacy pentru Meta Ads) —
    // orice cod viitor (inclusiv Meta Pixel/CAPI, cand va exista) trebuie sa intrebe STRICT prin
    // aceste doua functii, niciodata sa citeasca localStorage sau schema interna direct.
    isAnalyticsConsentGranted: isAnalyticsConsentGranted,
    isMarketingConsentGranted: isMarketingConsentGranted,
    // expuse STRICT pentru teste (logica pura, fara efecte asupra paginii reale)
    _isConsentGranted: isConsentGranted,
    _isConsentDecided: isConsentDecided,
    _parseConsentState: parseConsentState,
    _isStateFullyDecided: isStateFullyDecided,
    _buildEventParams: buildEventParams,
    _postTrackEvent: postTrackEvent,
    _FUNNEL_TRACKABLE_EVENTS: FUNNEL_TRACKABLE_EVENTS,
    _updateGtagConsent: updateGtagConsent,
    _clearVisitorId: clearVisitorId,
    _BANNER_COPY: BANNER_COPY
  };
})(window);
