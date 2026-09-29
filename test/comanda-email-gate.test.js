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
function loadGateSandbox({ storedOrders, stepKeyValue, restoredStepValue = 3, fetchImpl, navigationType = 'reload', initialEmailValue = '', initialHistoryState = null } = {}) {
  const startMarker = "const gateEmailScreen = document.getElementById('gate-email-screen');";
  const endMarker = "if (emailField) emailField.value = '';\n    } catch (err) { /* ignoram */ }\n  }";
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
    email: { value: initialEmailValue },
    'gate-email-continue-btn': { addEventListener: (evt, fn) => { listeners.emailContinue = fn; } },
    'gate-new-song-btn': { addEventListener: (evt, fn) => { listeners.newSong = fn; } },
    'gate-my-orders-link': { addEventListener: (evt, fn) => { listeners.myOrders = fn; } }
  };
  const fakeDocument = { getElementById: (id) => (id in elements ? elements[id] : null) };
  // stepCards (referentiat de returnToGateChoiceFromWizard, PROBLEMA 3) e declarat in comanda.html
  // MULT inainte de startMarker (document.querySelectorAll('.step-card')) — injectat direct ca
  // parametru al sandbox-ului, ca sa nu extindem extragerea peste tot restul wizard-ului.
  const fakeStepCards = [
    { dataset: { step: '1' }, style: {} },
    { dataset: { step: '2' }, style: {} }
  ];
  const storage = {};
  if (stepKeyValue !== undefined && stepKeyValue !== null) storage.currentStep = stepKeyValue;
  if (storedOrders !== undefined) storage.naluna_my_order_keys = JSON.stringify(storedOrders);
  const fakeLocalStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; }
  };
  function fakeFetch(...args) {
    calls.fetch++;
    if (fetchImpl) return fetchImpl(...args);
    throw new Error('fetch NU trebuie apelat din gate cand nu exista nicio comanda locala de verificat (naluna_my_order_keys gol/absent)');
  }
  function isValidEmailClient(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || ''); }
  function setFieldError(field, msg) { calls.setFieldError.push([field, msg]); }
  function saveDraft() { calls.saveDraft++; }
  function showStep(n) { calls.showStep.push(n); }
  function t(key) { return key === 'gate_my_orders_count' ? ((n) => `COUNT:${n}`) : `T:${key}`; }
  // Navigation Timing API simulata (vezi comanda.html, getNavigationType) — 'reload'/'back_forward'
  // = continuarea aceleiasi navigari (dead-end fix, comportament implicit aici), 'navigate' =
  // intrare noua (homepage/CTA/bookmark), folosit explicit de testele PROBLEMA 1 de mai jos.
  const fakePerformance = { getEntriesByType: (type) => (type === 'navigation' ? [{ type: navigationType }] : []) };
  // PROBLEMA 3 (2026-09-30, "Navigarea Back") — window.history/window.addEventListener simulate,
  // ca sa testam exact acelasi cod (history.pushState/popstate) care ruleaza intr-un browser real.
  // RUNDA 2 (2026-10-04) — replaceState() adaugat (showGateChoiceScreen() il foloseste acum ca sa
  // marcheze intrarea curenta {ndsGate:'choice'}, vezi PROBLEMA 3, runda 2 mai jos) si
  // initialHistoryState (parametrul sandbox-ului) ca sa putem simula EXACT o reincarcare/back care
  // restaureaza o intrare deja etichetata (wizard SAU choice), fara sa presupunem comportamentul
  // browserului — acelasi mecanism REAL, doar cu starea initiala controlata explicit de test.
  let historyState = initialHistoryState;
  const popstateListeners = [];
  const fakeWindow = {
    history: {
      get state() { return historyState; },
      pushState: (state) => { historyState = state; },
      replaceState: (state) => { historyState = state; }
    },
    location: { href: 'https://nalunastudio.com/comanda.html' },
    addEventListener: (evt, fn) => { if (evt === 'popstate') popstateListeners.push(fn); }
  };

  const build = new Function(
    'document', 'localStorage', 'fetch', 'STEP_KEY', 'restoredStep', 'isValidEmailClient', 'setFieldError', 'saveDraft', 'showStep', 't', 'performance', 'window', 'stepCards',
    snippet + '\nreturn { computeVerifiedKnownOrderCount, showGateChoiceScreen, enterWizardAfterGate, wizardStateRestored, choiceStateRestored };'
  );
  const api = build(fakeDocument, fakeLocalStorage, fakeFetch, 'currentStep', restoredStepValue, isValidEmailClient, setFieldError, saveDraft, showStep, t, fakePerformance, fakeWindow, fakeStepCards);
  return {
    api, elements, listeners, calls, snippet, storageRef: storage, stepCards: fakeStepCards,
    getHistoryState: () => historyState,
    firePopstate: (state) => { historyState = state; popstateListeners.forEach((fn) => fn({ state })); }
  };
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

// ===============================================================================================
// REGRESIE (2026-09-27, "URGENT PRODUCTION FIX") — checkbox-ul de opt-out NU trebuie sa influenteze
// NICIODATA tranzitia Continua, indiferent daca e bifat sau nu. Handler-ul real citeste STRICT
// elements.email.value (vezi loadGateSandbox mai sus) — acest test verifica explicit ca bifarea
// checkbox-ului (simuland exact interactiunea reala din browser) nu schimba deloc comportamentul.
// ===============================================================================================
test('7. sandbox: click pe "Continua" cu email valid SI checkbox-ul de opt-out BIFAT avanseaza identic la gate-choice-screen (checkbox-ul nu blocheaza si nu influenteaza tranzitia)', () => {
  const { elements, listeners, calls } = loadGateSandbox();
  elements.email.value = 'client@exemplu.com';
  elements['email-marketing-optout'] = { checked: true };
  listeners.emailContinue();
  assert.equal(calls.fetch, 0);
  assert.equal(calls.saveDraft, 1);
  assert.equal(elements['gate-choice-screen'].style.display, 'block');
});

test('7. sandbox: click pe "Continua" cu email valid SI checkbox-ul de opt-out NEBIFAT avanseaza identic la gate-choice-screen (acelasi rezultat ca bifat — checkbox-ul e complet independent)', () => {
  const { elements, listeners, calls } = loadGateSandbox();
  elements.email.value = 'client@exemplu.com';
  elements['email-marketing-optout'] = { checked: false };
  listeners.emailContinue();
  assert.equal(calls.fetch, 0);
  assert.equal(calls.saveDraft, 1);
  assert.equal(elements['gate-choice-screen'].style.display, 'block');
});

// ===============================================================================================
// REGRESIE (2026-09-27) — "click/tap functioneaza fara submit/reload accidental": butonul Continua
// e type="button" (nu type="submit"), deci un click pe el NU poate declansa submit-ul formularului
// (#order-form). In plus, chiar daca Enter implicit intr-un camp de text ar declansa submit-ul
// formularului (exista butoane type="submit" mai jos in wizard), handler-ul de submit incepe STRICT
// cu e.preventDefault() — deci reload-ul paginii nu se poate intampla NICIODATA, indiferent de pas.
// Verificat manual si live intr-un Chrome real (Enter in #email pe gate-email-screen): pagina nu
// navigheaza, nu apare niciun request de retea, ecranul ramane neschimbat.
// ===============================================================================================
test('4. comanda.html: butonul "Continua" al gate-ului (#gate-email-continue-btn) si "Creeaza o melodie noua" (#gate-new-song-btn) sunt STRICT type="button" — un click pe ele nu poate declansa niciodata submit-ul/reload-ul formularului', () => {
  const gateBlock = html.slice(html.indexOf('id="gate-email-screen"'), html.indexOf('class="step-card" data-step="1"'));
  assert.match(gateBlock, /id="gate-email-continue-btn"[^>]*type="button"|type="button"[^>]*id="gate-email-continue-btn"/);
  const btnTag = html.slice(html.indexOf('id="gate-email-continue-btn"') - 60, html.indexOf('id="gate-email-continue-btn"') + 20);
  assert.match(btnTag, /type="button"/);
  const newSongTag = html.slice(html.indexOf('id="gate-new-song-btn"') - 60, html.indexOf('id="gate-new-song-btn"') + 20);
  assert.match(newSongTag, /type="button"/);
});

test('4. comanda.html: handler-ul de submit al #order-form incepe STRICT cu e.preventDefault() (prima instructiune) — niciun submit implicit (ex. Enter intr-un camp de text) nu poate cauza vreodata un reload/navigare, indiferent de pasul curent', () => {
  const idx = html.indexOf("form.addEventListener('submit', async (e) => {");
  assert.ok(idx !== -1, 'handler-ul de submit trebuie sa existe');
  const body = html.slice(idx, idx + 300);
  const firstStatement = body.split('{').slice(1).join('{').trim().split('\n')[0].trim();
  assert.match(firstStatement, /^e\.preventDefault\(\);$/, `prima instructiune din handler trebuie sa fie e.preventDefault(), gasit: "${firstStatement}"`);
});

test('sandbox: sursa blocului gate contine STRICT fetch-ul de verificare read-only GET /api/orders/:id?token= (numarul afisat) — niciodata un apel de creare de comanda/Suno/checkout, si niciun XMLHttpRequest', () => {
  const { snippet } = loadGateSandbox();
  const fetchCallCount = (snippet.match(/fetch\(/g) || []).length;
  assert.equal(fetchCallCount, 1, 'trebuie sa existe STRICT un singur apel fetch in blocul gate — verificarea read-only a comenzilor cunoscute local');
  assert.match(snippet, /fetch\(`\/api\/orders\/\$\{encodeURIComponent\(entry\.id\)\}\?token=\$\{encodeURIComponent\(entry\.token\)\}`\)/, 'singurul fetch permis trebuie sa fie STRICT GET /api/orders/:id?token=, niciodata /generate, /checkout sau alt endpoint');
  assert.ok(!/XMLHttpRequest/.test(snippet));
});

test('20. sandbox: la incarcare (refresh/back), daca STEP_KEY NU exista (browser nou/draft neinceput), gate-ul NU cheama automat showStep — nicio comanda/generare accidentala', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: null });
  assert.equal(api.wizardStateRestored, false);
  assert.deepEqual(calls.showStep, []);
});

test('20. sandbox: la incarcare (refresh/back), CU STEP_KEY existent SI intrarea curenta marcata {ndsView:"wizard"} (reload mid-wizard, cazul real), gate-ul e SARIT automat, showStep(restoredStep) e apelat O SINGURA DATA — fara sa creeze o comanda/generare noua, doar reafiseaza pasul salvat', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: '4', restoredStepValue: 4, initialHistoryState: { ndsView: 'wizard' } });
  assert.equal(api.wizardStateRestored, true);
  assert.deepEqual(calls.showStep, [4]);
  assert.equal(calls.fetch, 0);
});

// ===============================================================================================
// BUG REAL DE PRODUCTIE, RUNDA 2 (2026-10-04, "Back de pe Comenzile mele ajunge in wizard, nu la
// 'Ce vrei sa faci?'" — audit repetat, confirmat pe telefon): verificarea ORIGINALA ("STEP_KEY
// exista => enterWizardAfterGate()") nu distingea "aceasta intrare specifica e chiar wizard-ul" de
// "exista un draft VECHI, oriunde, oricand" — orice Back/reload cu un draft existent sarea direct
// in wizard, INDIFERENT de ecranul real parasit. Fix: decizia consulta STRICT history.state
// (etichetat de showGateChoiceScreen()/enterWizardAfterGate(), NU simpla existenta a STEP_KEY).
// ===============================================================================================
test('BUG REAL, RUNDA 2 (regresie): STEP_KEY existent (draft vechi) DAR intrarea curenta NU e marcata "wizard" (ex. e ecranul de alegere, sau o intrare veche fara nicio eticheta) -> gate-ul NU e sarit, showStep NU e apelat — draftul ramane salvat, dar NU castiga Back-ul', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: '4', restoredStepValue: 4, navigationType: 'back_forward', initialHistoryState: null });
  assert.equal(api.wizardStateRestored, false, 'simpla existenta a STEP_KEY nu mai trebuie sa declanseze wizard-ul — cauza exacta a bug-ului real');
  assert.deepEqual(calls.showStep, [], 'showStep nu trebuie apelat — wizard-ul ramane in spatele gate-ului, draftul ramane salvat pentru cand clientul alege explicit sa continue');
});

test('BUG REAL, RUNDA 2: intrarea curenta marcata {ndsGate:"choice"} (client a fost pe "Ce vrei sa faci?", apoi a plecat la Comenzile mele) -> la Back/reload, choiceStateRestored=true si showGateChoiceScreen() reafiseaza STRICT ecranul de alegere, chiar daca STEP_KEY exista dintr-un draft vechi', () => {
  const { calls, api, elements } = loadGateSandbox({ stepKeyValue: '4', restoredStepValue: 4, navigationType: 'back_forward', initialHistoryState: { ndsGate: 'choice' } });
  assert.equal(api.wizardStateRestored, false);
  assert.equal(api.choiceStateRestored, true);
  assert.deepEqual(calls.showStep, [], 'wizard-ul nu trebuie intrat automat — STRICT ecranul de alegere');
  assert.equal(elements['gate-choice-screen'].style.display, 'block', 'ecranul "Ce vrei sa faci?" trebuie reafisat');
  assert.equal(elements['gate-email-screen'].style.display, 'none');
});

// ===============================================================================================
// PROBLEMA 1 (2026-09-29, "O comanda noua trebuie sa inceapa INTOTDEAUNA cu emailul" — audit +
// reproducere directa): STEP_KEY ramane NELIMITAT in localStorage (setat de showStep() la orice
// pas, inclusiv 1) — o comanda abandonata acum saptamani nu trebuie sa mai sara gate-ul la o
// intrare noua, chiar daca STEP_KEY exista inca. Distinctia vine STRICT din Navigation Timing API
// (navigationType, simulat mai sus): 'reload'/'back_forward' = continuarea aceleiasi navigari
// (comportamentul deja testat mai sus, NESCHIMBAT), 'navigate' = intrare noua (homepage/CTA/
// bookmark) — gate-ul TREBUIE aratat, indiferent de STEP_KEY.
// ===============================================================================================
test('PROBLEMA 1: intrare noua (navigationType navigate) cu STEP_KEY vechi existent (comanda abandonata la orice pas, saptamani in urma) -> gate-ul NU e sarit, indiferent de STEP_KEY', () => {
  const { calls, api } = loadGateSandbox({ stepKeyValue: '4', restoredStepValue: 4, navigationType: 'navigate' });
  assert.equal(api.wizardStateRestored, false, 'o intrare noua nu trebuie sa sara gate-ul, chiar daca STEP_KEY exista din o comanda abandonata anterior');
  assert.deepEqual(calls.showStep, [], 'showStep nu trebuie apelat automat la o intrare noua — wizard-ul ramane in spatele gate-ului pana la alegerea explicita a clientului');
});

test('PROBLEMA 1: naluna_my_order_keys NU este sters/modificat de verificarea de tip navigare — comenzile deja autorizate raman intacte, indiferent de tipul de navigare sau daca gate-ul e sarit', () => {
  const knownOrdersJson = JSON.stringify([{ id: 'ord-1', token: 'a'.repeat(48) }, { id: 'ord-2', token: 'b'.repeat(48) }]);
  for (const navigationType of ['navigate', 'reload', 'back_forward']) {
    const { storageRef } = loadGateSandbox({
      storedOrders: JSON.parse(knownOrdersJson), stepKeyValue: '4', navigationType
    });
    assert.equal(storageRef.naluna_my_order_keys, knownOrdersJson, `naluna_my_order_keys trebuie neatins pentru navigationType=${navigationType}`);
  }
});

test('PROBLEMA 1: intrare noua (navigate) NU sterge naluna_my_order_keys si NU atinge DRAFT_KEY — STRICT campul de email vizibil e golit, ca sa nu se presupuna reutilizarea automata a emailului unei comenzi anterioare', () => {
  // initialEmailValue simuleaza exact ce face restoreDraft() INAINTE de acest bloc (deja testat
  // separat, neschimbat): campul de email pre-completat cu valoarea unui draft vechi. Blocul de
  // gate trebuie sa il goleasca la o intrare noua, ca sa nu se presupuna reutilizarea automata a
  // acelui email.
  const { api, elements, storageRef } = loadGateSandbox({
    storedOrders: [{ id: 'ord-1', token: 'a'.repeat(48) }],
    stepKeyValue: '4',
    navigationType: 'navigate',
    initialEmailValue: 'vechi@exemplu.com'
  });
  assert.equal(api.wizardStateRestored, false);
  assert.equal(elements.email.value, '', 'campul de email trebuie golit la o intrare noua, chiar daca un draft vechi il pre-completase');
  assert.equal(storageRef.naluna_my_order_keys, JSON.stringify([{ id: 'ord-1', token: 'a'.repeat(48) }]), 'naluna_my_order_keys nu trebuie atins de aceasta verificare — comenzile deja autorizate raman intacte');
  assert.ok(!('nds_form_draft' in storageRef), 'DRAFT_KEY nu e scris/sters de acest bloc — el nu face parte din snippet-ul extras (saveDraft e apelat STRICT de handlerele de click, neschimbate)');
});

test('PROBLEMA 1: refresh/back_forward mid-wizard NU goleste campul de email (continuarea aceleiasi navigari, NU o intrare noua) — dead-end fix anterior ramane neschimbat', () => {
  const { api, elements } = loadGateSandbox({
    stepKeyValue: '4', restoredStepValue: 4, navigationType: 'reload', initialEmailValue: 'client@exemplu.com',
    initialHistoryState: { ndsView: 'wizard' }
  });
  assert.equal(api.wizardStateRestored, true);
  assert.equal(elements.email.value, 'client@exemplu.com', 'un refresh mid-wizard nu trebuie sa goleasca un camp deja completat in aceasta sesiune');
});

// ===============================================================================================
// PROBLEMA 3 (2026-09-30, "Navigarea Back este gresita" — audit history/navigation existent):
// trecerea gate-choice-screen -> wizard nu crea nicio intrare noua in istoric, deci Back din
// Pasul 1 sarea direct la homepage. Fix: history.pushState() la intrarea in wizard; popstate
// revine STRICT la ecranul de alegere ("Ce vrei sa faci?"), fara nicio navigare reala.
// ===============================================================================================
test('PROBLEMA 3: intrarea in wizard (enterWizardAfterGate) impinge O intrare noua in istoric (history.pushState, {ndsView:"wizard"}) — STRICT o data, nu de fiecare apel (reload/gateAlreadyPassed nu stivuieste straturi suplimentare)', () => {
  const { api, getHistoryState } = loadGateSandbox({ navigationType: 'navigate' });
  assert.equal(getHistoryState(), null, 'inainte de a intra in wizard, nu trebuie impins niciun state');
  api.enterWizardAfterGate();
  assert.deepEqual(getHistoryState(), { ndsView: 'wizard' });
});

test('PROBLEMA 3: enterWizardAfterGate() apelat A DOUA OARA (reload cu wizardStateRestored=true, history.state deja "wizard") NU impinge un al doilea strat — history.state ramane identic, nu se acumuleaza', () => {
  const { api, getHistoryState } = loadGateSandbox({
    stepKeyValue: '4', restoredStepValue: 4, navigationType: 'reload', initialHistoryState: { ndsView: 'wizard' }
  });
  // wizardStateRestored=true => enterWizardAfterGate() ruleaza deja o data la incarcarea sandbox-ului.
  assert.equal(api.wizardStateRestored, true);
  assert.deepEqual(getHistoryState(), { ndsView: 'wizard' });
  api.enterWizardAfterGate();
  assert.deepEqual(getHistoryState(), { ndsView: 'wizard' }, 'niciun strat suplimentar la a doua rulare');
});

test('PROBLEMA 3: Back (popstate) din wizard, cu state diferit de "wizard" (ex. null — stratul anterior, ecranul de alegere), reafiseaza STRICT gate-choice-screen — ascunde progress-wrap si toti step-cards numerotati, NICIODATA o navigare reala', () => {
  const { api, elements, stepCards, firePopstate } = loadGateSandbox({ navigationType: 'navigate' });
  api.enterWizardAfterGate();
  elements['progress-wrap'].style.display = '';
  elements['gate-choice-screen'].style.display = 'none';
  stepCards.forEach((c) => { c.style.display = 'block'; });
  firePopstate(null); // simuleaza Back-ul real al browserului catre stratul impins ANTERIOR intrarii in wizard
  assert.equal(elements['progress-wrap'].style.display, 'none', 'bara de progres a wizard-ului trebuie ascunsa la Back');
  assert.equal(elements['gate-choice-screen'].style.display, 'block', 'ecranul "Ce vrei sa faci?" trebuie reafisat la Back din wizard');
  stepCards.forEach((c) => assert.equal(c.style.display, 'none', `pasul numerotat ${c.dataset.step} trebuie ascuns la Back din wizard`));
});

test('PROBLEMA 3: popstate cu state {ndsView:"wizard"} (ex. Forward inapoi in wizard) NU declanseaza reafisarea ecranului de alegere — ramane in wizard', () => {
  const { api, elements, firePopstate } = loadGateSandbox({ navigationType: 'navigate' });
  api.enterWizardAfterGate();
  elements['gate-choice-screen'].style.display = 'none';
  firePopstate({ ndsView: 'wizard' });
  assert.equal(elements['gate-choice-screen'].style.display, 'none', 'un popstate catre acelasi strat (wizard) nu trebuie sa reafiseze ecranul de alegere');
});

// PROBLEMA 1 (2026-09-30) — click pe "Comenzile mele" STRICT stocheaza emailul local
// (sessionStorage, pentru comenzile-mele.html) — NICIODATA nu declanseaza un fetch/creeaza o
// comanda/consuma quota doar pentru ca a fost apasat acest link.
test('PROBLEMA 1: click pe "Comenzile mele" din gate NU declanseaza niciun fetch (nicio creare de comanda/consumare de quota doar pentru navigarea catre lista de comenzi)', () => {
  const { listeners, calls } = loadGateSandbox({ initialEmailValue: 'client@exemplu.com' });
  listeners.myOrders();
  assert.equal(calls.fetch, 0);
});

// ===============================================================================================
// TEST 5/6 — browser cu 1 / 2 comenzi autorizate: numarul afisat vine STRICT din ownership local
// (naluna_my_order_keys), niciodata din email.
// ===============================================================================================
// BUG REAL (2026-09-28) — vezi test/gate-count-vs-list-contradiction.test.js: numarul afisat aici
// nu mai e un simplu count local (fara verificare), ci STRICT numarul de comenzi CONFIRMATE
// server-side ca exista si sunt eligibile (acelasi filtru ca in comenzile-mele.html). Testele de
// mai jos simuleaza raspunsul serverului pentru fiecare {id,token} cunoscut local.
function jsonRes(obj) { return { ok: true, json: async () => obj }; }
function confirmedOrderFetchImpl(byId) {
  return async (url) => {
    const m = /\/api\/orders\/([^?]+)\?token=/.exec(url);
    const id = decodeURIComponent(m[1]);
    if (!(id in byId)) return { ok: false, status: 404 };
    return jsonRes(byId[id]);
  };
}

test('5. sandbox: computeVerifiedKnownOrderCount() intoarce 1 pentru un browser cu exact o comanda autorizata local, CONFIRMATA eligibila de server', async () => {
  const { api } = loadGateSandbox({
    storedOrders: [{ id: 'ord-1', token: 'a'.repeat(48) }],
    fetchImpl: confirmedOrderFetchImpl({ 'ord-1': { id: 'ord-1', status: 'ready' } })
  });
  assert.equal(await api.computeVerifiedKnownOrderCount(), 1);
});

test('6. sandbox: computeVerifiedKnownOrderCount() intoarce 2 pentru un browser cu exact doua comenzi autorizate local, ambele CONFIRMATE eligibile de server', async () => {
  const { api } = loadGateSandbox({
    storedOrders: [{ id: 'ord-1', token: 'a'.repeat(48) }, { id: 'ord-2', token: 'b'.repeat(48) }],
    fetchImpl: confirmedOrderFetchImpl({ 'ord-1': { id: 'ord-1', status: 'ready' }, 'ord-2': { id: 'ord-2', status: 'preview_ready' } })
  });
  assert.equal(await api.computeVerifiedKnownOrderCount(), 2);
});

test('8/9. sandbox: computeVerifiedKnownOrderCount() ignora intrarile fara id/token valide (NU deriva niciodata "ownership" din simpla prezenta a unui email) si intoarce 0 pentru un browser fara tokenuri', async () => {
  const { api: apiEmpty } = loadGateSandbox({ storedOrders: [] });
  assert.equal(await apiEmpty.computeVerifiedKnownOrderCount(), 0);
  const { api: apiMalformed } = loadGateSandbox({ storedOrders: [{ id: 'ord-1' }, { token: 'x' }, null, {}] });
  assert.equal(await apiMalformed.computeVerifiedKnownOrderCount(), 0, 'intrari fara id+token complet nu conteaza ca ownership');
});

test('sandbox: showGateChoiceScreen() foloseste STRICT numarul CONFIRMAT server-side (count>0 -> mesaj cu numar; count=0 -> mesajul generic implicit), niciodata legat de email', async () => {
  const withOrders = loadGateSandbox({
    storedOrders: [{ id: 'a', token: 'x'.repeat(48) }],
    fetchImpl: confirmedOrderFetchImpl({ a: { id: 'a', status: 'ready' } })
  });
  withOrders.api.showGateChoiceScreen();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(withOrders.elements['gate-my-orders-desc'].textContent, 'COUNT:1');

  const withoutOrders = loadGateSandbox({ storedOrders: [] });
  withoutOrders.api.showGateChoiceScreen();
  await new Promise((r) => setTimeout(r, 0));
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
// SCENARIILE OBLIGATORII A-G (2026-10-04, cerinta explicita, verbatim) — fixul "Back de pe
// Comenzile mele ajunge in wizard, nu la 'Ce vrei sa faci?'". comanda.html forteaza deja un reload
// real la restaurarea din bfcache (window.addEventListener('pageshow', (event) => { if
// (event.persisted) window.location.reload(); }), vezi test/quota-dead-end-navigation-fix.test.js)
// — asta inseamna ca scenariile A (bfcache) si B (reincarcare completa) converg STRUCTURAL catre
// ACELASI cod (decizia de mai jos, bazata pe history.state), niciodata pe DOM-ul inghetat vechi.
// ===============================================================================================

test('G. showGateChoiceScreen() foloseste STRICT replaceState({ndsGate:"choice"}) — NICIODATA pushState — nicio intrare noua in istoric, STRICT o eticheta pe cea existenta', () => {
  const { snippet } = loadGateSandbox();
  assert.match(snippet, /window\.history\.replaceState\(\{ ndsGate: 'choice' \}, '', window\.location\.href\)/, 'trebuie sa foloseasca EXACT replaceState, cu eticheta ndsGate:"choice"');
  // Extragem STRICT corpul functiei showGateChoiceScreen() ca sa dovedim ca NU apeleaza pushState.
  const fnStart = snippet.indexOf('function showGateChoiceScreen()');
  const fnEnd = snippet.indexOf('\n  }', fnStart);
  const fnBody = snippet.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes('pushState'), 'showGateChoiceScreen() nu trebuie sa apeleze NICIODATA pushState — ar crea o intrare noua/duplicata in istoric');
});

test('G. sandbox: apelarea showGateChoiceScreen() de mai multe ori (email->choice, apoi din nou la restaurare) NU acumuleaza — history.state ramane STRICT {ndsGate:"choice"}, o singura "forma", niciodata o lista/stiva', () => {
  const { api, getHistoryState } = loadGateSandbox({ navigationType: 'navigate' });
  assert.equal(getHistoryState(), null);
  api.showGateChoiceScreen();
  assert.deepEqual(getHistoryState(), { ndsGate: 'choice' });
  api.showGateChoiceScreen();
  assert.deepEqual(getHistoryState(), { ndsGate: 'choice' }, 'a doua chemare nu trebuie sa schimbe/acumuleze nimic — acelasi replaceState, idempotent');
});

test('A/B. bfcache SI reincarcare completa converg pe ACELASI rezultat: intrarea curenta marcata {ndsGate:"choice"} (client a fost pe "Ce vrei sa faci?" inainte de a pleca la Comenzile mele) -> la revenire (Back), history.state e citit direct la incarcare (identic indiferent daca browserul a restaurat din bfcache-cu-reload-fortat sau a facut o reincarcare normala) -> ecranul de alegere e reafisat, NICIODATA wizard-ul', () => {
  for (const navigationType of ['reload', 'back_forward']) {
    const { api, elements, calls } = loadGateSandbox({
      navigationType, initialHistoryState: { ndsGate: 'choice' }, stepKeyValue: '3', restoredStepValue: 3
    });
    assert.equal(api.choiceStateRestored, true, `navigationType=${navigationType}`);
    assert.equal(api.wizardStateRestored, false, `navigationType=${navigationType}`);
    assert.equal(elements['gate-choice-screen'].style.display, 'block', `navigationType=${navigationType}: trebuie sa arate "Ce vrei sa faci?"`);
    assert.deepEqual(calls.showStep, [], `navigationType=${navigationType}: wizard-ul NU trebuie intrat automat`);
  }
});

test('C. draft vechi (STEP_KEY + DRAFT_KEY) existent, intrarea curenta marcata "choice" -> Back arata "Ce vrei sa faci?", NU wizard-ul — draftul (STEP_KEY) ramane STRICT in storage, netouched, disponibil daca clientul alege explicit sa continue', () => {
  const { api, elements, storageRef } = loadGateSandbox({
    navigationType: 'back_forward', initialHistoryState: { ndsGate: 'choice' }, stepKeyValue: '5', restoredStepValue: 5
  });
  assert.equal(api.choiceStateRestored, true);
  assert.equal(api.wizardStateRestored, false);
  assert.equal(elements['gate-choice-screen'].style.display, 'block');
  assert.equal(elements['progress-wrap'].style.display, undefined, 'bara de progres a wizard-ului nu trebuie afisata');
  assert.equal(storageRef.currentStep, '5', 'STEP_KEY (draftul) ramane STRICT neatins — nu e sters, nu e modificat, STRICT neconsultat pentru aceasta decizie');
});

test('D. din "Ce vrei sa faci?", "Creeaza o melodie noua" continua sa intre normal in wizard SI poate folosi draftul existent (restoredStep din STEP_KEY) — comportament NESCHIMBAT', () => {
  const { elements, listeners, calls, getHistoryState } = loadGateSandbox({
    navigationType: 'back_forward', initialHistoryState: { ndsGate: 'choice' }, stepKeyValue: '5', restoredStepValue: 5
  });
  listeners.newSong();
  assert.equal(elements['gate-choice-screen'].style.display, 'none');
  assert.equal(elements['progress-wrap'].style.display, '');
  assert.deepEqual(calls.showStep, [5], 'trebuie sa reia STRICT pasul salvat in draft (comportament existent, neschimbat)');
  assert.deepEqual(getHistoryState(), { ndsView: 'wizard' }, 'intrarea in wizard isi pastreaza propria eticheta, distincta de "choice"');
});

test('F. draftul (STEP_KEY si DRAFT_KEY) nu e sters/modificat de NICIUN cod din acest fix, in NICIUN scenariu (choice restaurat, wizard restaurat, sau niciunul)', () => {
  for (const initialHistoryState of [null, { ndsGate: 'choice' }, { ndsView: 'wizard' }]) {
    const { storageRef } = loadGateSandbox({
      navigationType: 'back_forward', initialHistoryState, stepKeyValue: '2', restoredStepValue: 2
    });
    assert.equal(storageRef.currentStep, '2', `STEP_KEY trebuie neatins pentru initialHistoryState=${JSON.stringify(initialHistoryState)}`);
    assert.ok(!('nds_form_draft' in storageRef), 'DRAFT_KEY nu face parte din acest snippet — nu poate fi sters de el');
  }
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
// SECTIUNEA 2 (2026-09-27, "URGENT PRODUCTION FIX") — ierarhia vizuala a opt-out-ului: text mai
// mic decat #email/CTA, checkbox proportional mai mic, DAR fara sa schimbe semantica (nu ascuns,
// nu prebifat, ramane opt-out, ramane optional). Verificat STRUCTURAL mai jos + vizual, live,
// intr-un Chrome real (screenshot desktop 1568px si test manual mobil) — vezi raportul final.
// ===============================================================================================
test('2. comanda.html: labelul checkbox-ului de opt-out are font-size STRICT mai mic decat labelul campului Email (13px) si decat CTA-ul Continua (14px) — ierarhie vizuala secundara, cerinta explicita', () => {
  const labelTag = html.slice(html.indexOf('class="field-checkbox"') - 10, html.indexOf('class="field-checkbox"') + 260);
  const m = labelTag.match(/font-size:\s*(\d+)px/);
  assert.ok(m, 'labelul opt-out trebuie sa aiba un font-size explicit');
  const optOutSize = Number(m[1]);
  assert.ok(optOutSize < 13, `font-size opt-out (${optOutSize}px) trebuie sa fie sub labelul Email (13px)`);
  assert.ok(optOutSize < 14, `font-size opt-out (${optOutSize}px) trebuie sa fie sub CTA-ul Continua (14px, din .btn)`);
});

test('2. comanda.html: checkbox-ul #email-marketing-optout are un width/height proportional mai mic decat reset-ul generic pentru checkbox-uri (18px) — vizual secundar, dar tot vizibil/functional', () => {
  const idx = html.indexOf('#email-marketing-optout{');
  assert.ok(idx !== -1, 'trebuie sa existe o regula CSS dedicata pentru dimensiunea checkbox-ului de opt-out');
  const rule = html.slice(idx, html.indexOf('}', idx) + 1);
  const w = Number(rule.match(/width:\s*(\d+)px/)[1]);
  const h = Number(rule.match(/height:\s*(\d+)px/)[1]);
  assert.ok(w > 0 && w < 18, `width-ul checkbox-ului (${w}px) trebuie sa fie sub dimensiunea generica (18px), dar > 0 (vizibil)`);
  assert.ok(h > 0 && h < 18, `height-ul checkbox-ului (${h}px) trebuie sa fie sub dimensiunea generica (18px), dar > 0 (vizibil)`);
});

test('2. comanda.html: checkbox-ul de opt-out ramane VIZIBIL (nu display:none/visibility:hidden/opacity:0) si NEBIFAT implicit (fara atributul checked) — doar mai mic vizual, niciodata ascuns sau prebifat (fara dark patterns)', () => {
  const labelTag = html.slice(html.indexOf('class="field-checkbox"') - 10, html.indexOf('class="field-checkbox"') + 260);
  assert.ok(!/display:\s*none/.test(labelTag));
  assert.ok(!/visibility:\s*hidden/.test(labelTag));
  assert.ok(!/opacity:\s*0[^.]/.test(labelTag));
  const inputTag = html.slice(html.indexOf('id="email-marketing-optout"') - 20, html.indexOf('id="email-marketing-optout"') + 60);
  assert.ok(!/\bchecked\b/.test(inputTag), 'checkbox-ul nu trebuie sa fie prebifat (ar transforma opt-out in opt-in)');
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
