// FUNCTIONALITATE NOUA (2026-09-27, cerinta explicita — "Comenzile mele inainte de generare"):
// emailul e cerut acum ca PRIM PAS pe comanda.html (inaintea wizard-ului numerotat 1-8, complet
// neschimbat), urmat de un ecran de alegere explicita: "Comenzile mele" (acces la comenzile deja
// create, NICIODATA conditionat de limita 3/7) sau "Creeaza o melodie noua" (continua wizard-ul
// normal). Simpla introducere a emailului NU creeaza order, NU consuma quota, NU apeleaza Suno,
// NU creeaza sesiune Stripe — pana la finalul wizard-ului nu exista niciun fetch catre server.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const html = read('public/comanda.html');
const index = read('public/index.html');
const server = read('server.js');
const db = read('db.js');
const analytics = read('public/js/analytics.js');
const attribution = read('public/js/attribution.js');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function lastInlineScript(source) {
  const matches = [...source.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  return matches[matches.length - 1][1];
}

// ===============================================================================================
// TEST 1 — email este primul pas dupa "Comanda acum" (Homepage -> comanda.html neschimbat;
// gate-email-screen e primul element vizibil, INAINTEA pasului 1 numerotat).
// ===============================================================================================
test('1. index.html: toate CTA-urile "Comandă acum"/"Comanda" continua sa duca la /comanda.html, neschimbat', () => {
  const ctaLinks = [...index.matchAll(/<a href="\/comanda\.html"/g)];
  assert.ok(ctaLinks.length >= 4, 'homepage trebuie sa aiba mai multe CTA-uri catre comanda.html (hero, nav, sticky mobil, pricing etc.)');
});

test('1. comanda.html: gate-email-screen apare STRICT inaintea gate-choice-screen, care apare STRICT inaintea pasului 1 numerotat (ordinea DOM = ordinea vazuta la incarcare)', () => {
  const idxEmail = html.indexOf('id="gate-email-screen"');
  const idxChoice = html.indexOf('id="gate-choice-screen"');
  const idxStep1 = html.indexOf('class="step-card" data-step="1"');
  assert.ok(idxEmail !== -1 && idxChoice !== -1 && idxStep1 !== -1);
  assert.ok(idxEmail < idxChoice && idxChoice < idxStep1);
});

test('1. comanda.html: gate-email-screen e vizibil implicit (fara style="display:none"), iar pasul 1 numerotat e ascuns implicit (style="display:none") — gate-ul e STRICT primul lucru vazut, fara JS', () => {
  const emailScreenTag = html.slice(html.indexOf('<div class="step-card" data-step="0" id="gate-email-screen">'), html.indexOf('<div class="step-card" data-step="0" id="gate-email-screen">') + 80);
  assert.ok(!emailScreenTag.includes('display:none'), 'gate-email-screen nu trebuie ascuns implicit');
  const step1Tag = html.slice(html.indexOf('class="step-card" data-step="1"') - 20, html.indexOf('class="step-card" data-step="1"') + 60);
  assert.match(step1Tag, /style="display:none;"/, 'pasul 1 numerotat trebuie ascuns implicit — gate-ul e primul vazut');
});

// ===============================================================================================
// SANDBOX — extragem STRICT logica gate-ului (fara restul wizard-ului, acelasi tipar deja folosit
// in test/wizard-step-renumbering.test.js), cu document/localStorage/fetch simulate.
// ===============================================================================================
function loadGateSandbox({ storedOrders, stepKeyValue, restoredStepValue = 3 } = {}) {
  const startMarker = "const gateEmailScreen = document.getElementById('gate-email-screen');";
  const endMarker = 'if (gateAlreadyPassed) {\n    enterWizardAfterGate();\n  }';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker, startIdx) + endMarker.length;
  assert.ok(startIdx !== -1 && endIdx > startIdx, 'nu am gasit blocul JS al gate-ului in comanda.html');
  const snippet = html.slice(startIdx, endIdx);

  const calls = { fetch: 0, saveDraft: 0, showStep: [], setFieldError: [] };
  const listeners = {};
  const elements = {
    'gate-email-screen': { style: {} },
    'gate-choice-screen': { style: {} },
    'progress-wrap': { style: {} },
    'gate-my-orders-desc': { textContent: '' },
    email: { value: '' },
    'gate-email-continue-btn': { addEventListener: (evt, fn) => { listeners.emailContinue = fn; } },
    'gate-new-song-btn': { addEventListener: (evt, fn) => { listeners.newSong = fn; } }
  };
  const fakeDocument = { getElementById: (id) => (id in elements ? elements[id] : null) };
  const storage = {};
  if (stepKeyValue !== undefined && stepKeyValue !== null) storage.currentStep = stepKeyValue;
  if (storedOrders !== undefined) storage.naluna_my_order_keys = JSON.stringify(storedOrders);
  const fakeLocalStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  function fakeFetch() { calls.fetch++; throw new Error('fetch NU trebuie apelat din gate — simpla introducere a emailului nu poate atinge reteaua'); }
  function isValidEmailClient(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || ''); }
  function setFieldError(field, msg) { calls.setFieldError.push([field, msg]); }
  function saveDraft() { calls.saveDraft++; }
  function showStep(n) { calls.showStep.push(n); }
  function t(key) { return key === 'gate_my_orders_count' ? ((n) => `COUNT:${n}`) : `T:${key}`; }

  const build = new Function(
    'document', 'localStorage', 'fetch', 'STEP_KEY', 'restoredStep', 'isValidEmailClient', 'setFieldError', 'saveDraft', 'showStep', 't',
    snippet + '\nreturn { computeLocalKnownOrderCount, showGateChoiceScreen, enterWizardAfterGate, gateAlreadyPassed };'
  );
  const api = build(fakeDocument, fakeLocalStorage, fakeFetch, 'currentStep', restoredStepValue, isValidEmailClient, setFieldError, saveDraft, showStep, t);
  return { api, elements, listeners, calls, snippet };
}

test('sandbox: blocul JS al gate-ului exista si e sintactic valid, izolat', () => {
  assert.doesNotThrow(() => loadGateSandbox());
});

// ===============================================================================================
// TEST 2/3/4/20 — simpla introducere a emailului NU creeaza order, NU apeleaza Suno, NU consuma
// quota (niciun fetch), inclusiv la refresh/back (gate-ul e STRICT local, fara reteaua).
// ===============================================================================================
test('2/3/4. sandbox: click pe "Continua" cu email VALID nu declanseaza NICIUN fetch (nicio creare de order, niciun apel Suno, nicio consumare de quota) — doar validare de format + salvare locala', () => {
  const { elements, listeners, calls } = loadGateSandbox();
  elements.email.value = 'client@exemplu.com';
  listeners.emailContinue();
  assert.equal(calls.fetch, 0, 'NICIUN fetch nu trebuie declansat de simpla introducere a emailului');
  assert.equal(calls.saveDraft, 1, 'draftul local trebuie salvat (NU trimis catre server)');
  assert.deepEqual(calls.setFieldError[0], ['email', '']);
  assert.equal(elements['gate-email-screen'].style.display, 'none');
  assert.equal(elements['gate-choice-screen'].style.display, 'block');
});

test('2/3/4. sandbox: click pe "Continua" cu email INVALID nu declanseaza NICIUN fetch, NU salveaza draftul, NU trece la ecranul de alegere — afiseaza eroarea de validare', () => {
  const { elements, listeners, calls } = loadGateSandbox();
  elements.email.value = 'nu-e-un-email';
  listeners.emailContinue();
  assert.equal(calls.fetch, 0);
  assert.equal(calls.saveDraft, 0, 'draftul nu trebuie salvat cu un email invalid');
  assert.notEqual(calls.setFieldError[0][1], '', 'trebuie afisat un mesaj de eroare');
  assert.notEqual(elements['gate-choice-screen'].style.display, 'block', 'nu trebuie sa avanseze la ecranul de alegere');
});

test('sandbox: sursa blocului gate NU contine niciun apel fetch/XMLHttpRequest — garantie structurala suplimentara, independenta de simulare', () => {
  const { snippet } = loadGateSandbox();
  assert.ok(!/fetch\(/.test(snippet));
  assert.ok(!/XMLHttpRequest/.test(snippet));
});

test('20. sandbox: la incarcare (refresh/back), daca STEP_KEY NU exista (browser nou/draft neinceput), gate-ul NU cheama automat showStep — nicio comanda/generare accidentala', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: null });
  assert.equal(api.gateAlreadyPassed, false);
  assert.deepEqual(calls.showStep, []);
});

test('20. sandbox: la incarcare (refresh/back) cu STEP_KEY deja existent (draft mid-wizard), gate-ul e SARIT automat, showStep(restoredStep) e apelat O SINGURA DATA — fara sa creeze o comanda/generare noua, doar reafiseaza pasul salvat', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: '4', restoredStepValue: 4 });
  assert.equal(api.gateAlreadyPassed, true);
  assert.deepEqual(calls.showStep, [4]);
  assert.equal(calls.fetch, 0);
});

// ===============================================================================================
// TEST 5/6 — browser cu 1 / 2 comenzi autorizate: numarul afisat vine STRICT din ownership local
// (naluna_my_order_keys), niciodata din email.
// ===============================================================================================
test('5. sandbox: computeLocalKnownOrderCount() intoarce 1 pentru un browser cu exact o comanda autorizata local', () => {
  const { api } = loadGateSandbox({ storedOrders: [{ id: 'ord-1', token: 'a'.repeat(48) }] });
  assert.equal(api.computeLocalKnownOrderCount(), 1);
});

test('6. sandbox: computeLocalKnownOrderCount() intoarce 2 pentru un browser cu exact doua comenzi autorizate local', () => {
  const { api } = loadGateSandbox({ storedOrders: [{ id: 'ord-1', token: 'a'.repeat(48) }, { id: 'ord-2', token: 'b'.repeat(48) }] });
  assert.equal(api.computeLocalKnownOrderCount(), 2);
});

test('8/9. sandbox: computeLocalKnownOrderCount() ignora intrarile fara id/token valide (NU deriva niciodata "ownership" din simpla prezenta a unui email) si intoarce 0 pentru un browser fara tokenuri', () => {
  const { api: apiEmpty } = loadGateSandbox({ storedOrders: [] });
  assert.equal(apiEmpty.computeLocalKnownOrderCount(), 0);
  const { api: apiMalformed } = loadGateSandbox({ storedOrders: [{ id: 'ord-1' }, { token: 'x' }, null, {}] });
  assert.equal(apiMalformed.computeLocalKnownOrderCount(), 0, 'intrari fara id+token complet nu conteaza ca ownership');
});

test('sandbox: showGateChoiceScreen() foloseste STRICT numarul calculat local (count>0 -> mesaj cu numar; count=0 -> mesajul generic implicit), niciodata legat de email', () => {
  const withOrders = loadGateSandbox({ storedOrders: [{ id: 'a', token: 'x'.repeat(48) }] });
  withOrders.api.showGateChoiceScreen();
  assert.equal(withOrders.elements['gate-my-orders-desc'].textContent, 'COUNT:1');

  const withoutOrders = loadGateSandbox({ storedOrders: [] });
  withoutOrders.api.showGateChoiceScreen();
  assert.equal(withoutOrders.elements['gate-my-orders-desc'].textContent, 'T:gate_my_orders_desc');
});

// ===============================================================================================
// TEST 11 — "Creeaza o melodie noua" continua formularul normal (showStep(restoredStep), pasii
// 1-8 complet neschimbati).
// ===============================================================================================
test('11. sandbox: click pe "Creeaza o melodie noua" ascunde ambele ecrane gate, reafiseaza bara de progres si cheama showStep(restoredStep) — wizard-ul normal, NESCHIMBAT', () => {
  const { elements, listeners, calls } = loadGateSandbox({ restoredStepValue: 1 });
  listeners.newSong();
  assert.equal(elements['gate-email-screen'].style.display, 'none');
  assert.equal(elements['gate-choice-screen'].style.display, 'none');
  assert.equal(elements['progress-wrap'].style.display, '');
  assert.deepEqual(calls.showStep, [1]);
  assert.equal(calls.fetch, 0);
});

// ===============================================================================================
// TEST 7/10/12/13/15 — retentie/quota/recovery/UTM raman neatinse (server ramane autoritatea;
// aceasta modificare e STRICT client-side, pe comanda.html).
// ===============================================================================================
test('7/10/12/13. server.js si db.js NU au fost modificate de aceasta schimbare — nicio referinta noua la gate/email-first in server-side (motorul de quota/retentie/recovery ramane STRICT cel deja auditat)', () => {
  assert.ok(!server.includes('gate_email_title') && !server.includes('gate-email-screen'));
  assert.ok(!db.includes('gate_email_title') && !db.includes('gate-email-screen'));
});

test('12/13. db.js: claimOrderForInitialGeneration ramane singura autoritate pentru quota (3/7, istoric inclus) — noul entry point client-side nu poate ocoli acest control, pentru ca e STRICT server-side, apelat abia la /generate, mult dupa gate', () => {
  assert.match(db, /async function claimOrderForInitialGeneration\(orderId, maxAttempts, emailKey, skipQuota\) \{/);
  assert.match(db, /FREE_GENERATION_LIMIT = 3/);
  assert.match(db, /FREE_GENERATION_WINDOW_DAYS = 7/);
});

test('15. public/js/attribution.js si public/js/analytics.js NU au fost modificate — UTM/fbclid/visitor_id continua sa functioneze neschimbat', () => {
  assert.ok(!attribution.includes('gate_email_title'));
  assert.ok(!analytics.includes('gate_email_title'));
  assert.match(attribution, /var UTM_KEYS = \['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'\];/);
});

// ===============================================================================================
// TEST 14 — emailul NU ajunge niciodata in GA/Meta (nu e trimis prin track()).
// ===============================================================================================
test('14. comanda.html: NalunaAnalytics.track(...) nu e apelat niciodata cu valoarea emailului — order_page_viewed/form_started raman fara PII, neschimbate', () => {
  const trackCalls = [...html.matchAll(/NalunaAnalytics\.track\('([^']+)',\s*(\{[^}]*\})?/g)];
  assert.ok(trackCalls.length > 0, 'trebuie sa existe cel putin un apel track() (order_page_viewed)');
  trackCalls.forEach(([, eventName, paramsSrc]) => {
    if (paramsSrc) assert.ok(!/getElementById\('email'\)/.test(paramsSrc), `evenimentul ${eventName} nu trebuie sa trimita emailul`);
  });
});

test('14. sandbox: blocul gate-ului nu apeleaza NalunaAnalytics/track niciodata cu emailul — introducerea emailului e complet netrackuita catre GA/Meta', () => {
  const { snippet } = loadGateSandbox();
  assert.ok(!/NalunaAnalytics/.test(snippet), 'blocul gate nu trebuie sa apeleze analytics deloc — order_page_viewed/form_started acopera deja momentul, la incarcarea paginii');
});

// ===============================================================================================
// TEST 16 — checkbox/consent (email-marketing-optout) ramane corect: optional, nu blocheaza
// continuarea, semantica PECR soft opt-in neschimbata.
// ===============================================================================================
test('16. comanda.html: checkbox-ul email-marketing-optout a fost MUTAT (nu duplicat) in gate-email-screen — un SINGUR element in tot fisierul, ramane necompletat implicit (soft opt-in) si nu e validat ca obligatoriu', () => {
  const matches = [...html.matchAll(/id="email-marketing-optout"/g)];
  assert.equal(matches.length, 1, 'trebuie sa existe STRICT un singur checkbox in tot fisierul (mutat, nu duplicat)');
  const gateBlock = html.slice(html.indexOf('id="gate-email-screen"'), html.indexOf('id="gate-choice-screen"'));
  assert.match(gateBlock, /id="email-marketing-optout"/);
  assert.ok(!/id="email-marketing-optout"[^>]*required/.test(html), 'checkbox-ul nu trebuie sa fie required');
});

test('16. comanda.html: validateStep(2) nu mai revalideaza emailul (mutat la gate) — recipient/sender/relationship/story/phone raman validate neschimbat', () => {
  const idx = html.indexOf('if (n === 2) {');
  const end = html.indexOf('if (n === 3) {');
  const body = html.slice(idx, end);
  assert.ok(!/getElementById\('email'\)/.test(body), 'emailul nu mai trebuie citit/validat in validateStep(2)');
  assert.match(body, /recipient/);
  assert.match(body, /validatePhoneField/);
});

// ===============================================================================================
// TEST 17 — toate cele 8 limbi.
// ===============================================================================================
function extractTranslationsObject() {
  const idx = html.indexOf('const translations = {');
  let depth = 0, i = html.indexOf('{', idx);
  const start = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}
const translationsSrc = extractTranslationsObject();

test('17. comanda.html: toate cele 8 chei noi (gate_email_title, gate_email_subtitle, gate_choice_title, gate_my_orders_title, gate_my_orders_desc, gate_my_orders_btn, gate_new_song_btn) exista in TOATE cele 8 limbi', () => {
  const GATE_KEYS = [
    'gate_email_title', 'gate_email_subtitle', 'gate_choice_title', 'gate_my_orders_title',
    'gate_my_orders_desc', 'gate_my_orders_btn', 'gate_new_song_btn'
  ];
  ALLOWED_LANGS.forEach((lang) => {
    const langIdx = translationsSrc.indexOf(`${lang}: {`);
    assert.ok(langIdx !== -1, `blocul limbii ${lang} nu a fost gasit`);
    const nextLangIdx = ALLOWED_LANGS
      .map((l) => translationsSrc.indexOf(`${l}: {`, langIdx + 1))
      .filter((n) => n !== -1)
      .sort((a, b) => a - b)[0] || translationsSrc.length;
    const block = translationsSrc.slice(langIdx, nextLangIdx);
    GATE_KEYS.forEach((key) => {
      assert.match(block, new RegExp(`${key}:`), `limba ${lang} nu are cheia ${key}`);
    });
  });
});

test('17. comanda.html: gate_my_orders_count e o functie (n) => string, definita in toate cele 8 limbi, si produce text diferit pentru n=1 vs n=2 (unde limba are plural)', () => {
  ALLOWED_LANGS.forEach((lang) => {
    const langIdx = translationsSrc.indexOf(`${lang}: {`);
    const nextLangIdx = ALLOWED_LANGS
      .map((l) => translationsSrc.indexOf(`${l}: {`, langIdx + 1))
      .filter((n) => n !== -1)
      .sort((a, b) => a - b)[0] || translationsSrc.length;
    const block = translationsSrc.slice(langIdx, nextLangIdx);
    assert.match(block, /gate_my_orders_count: \(n\) => `[^`]+`/, `limba ${lang}: gate_my_orders_count trebuie sa fie o functie (n) => \`...\``);
  });
});

// ===============================================================================================
// TEST 18/19 — mobil/desktop: gate-ul reutilizeaza EXACT clasele CSS existente (step-card, btn,
// btn-primary, btn-ghost, wizard-nav, field) — acelasi responsive design ca restul wizard-ului,
// niciun element/latime fixa noua.
// ===============================================================================================
test('18/19. comanda.html: gate-email-screen si gate-choice-screen reutilizeaza EXACT clasele CSS existente (step-card, field, btn, btn-primary, btn-ghost, wizard-nav) — acelasi comportament responsive ca restul wizard-ului, fara markup nou needitat', () => {
  const gateBlock = html.slice(html.indexOf('id="gate-email-screen"') - 40, html.indexOf('class="step-card" data-step="1"'));
  ['class="step-card"', 'class="field"', 'btn btn-primary btn-continue', 'btn btn-ghost', 'class="wizard-nav single"'].forEach((cls) => {
    assert.ok(gateBlock.includes(cls), `gate-ul trebuie sa refoloseasca "${cls}"`);
  });
  assert.ok(!/width:\s*\d+px/.test(gateBlock), 'gate-ul nu trebuie sa introduca latimi fixe in pixeli (ar rupe layout-ul responsive mobil)');
});

// ===============================================================================================
// Sintaxa finala.
// ===============================================================================================
test('comanda.html: scriptul inline ramane sintactic valid dupa introducerea gate-ului', () => {
  assert.doesNotThrow(() => new Function(lastInlineScript(html)));
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
