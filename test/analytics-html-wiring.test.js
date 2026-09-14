// ANALYTICS (2026-09-14) — teste structurale: verifica ca fiecare pagina publica relevanta
// incarca analytics.js, si ca evenimentele de funnel sunt plasate EXACT la punctele corecte din
// fluxul real (nu mai devreme, nu mai tarziu) — fara sa afecteze fluxul normal de checkout/
// comanda, care ramane complet neschimbat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readHtml(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
}

const PAGES_WITH_ANALYTICS = [
  'index.html', 'comanda.html', 'se-compune.html', 'melodia-mea.html', 'succes.html',
  'comanda-mea.html', 'amintiri-video.html', 'se-creeaza-video.html'
];

for (const page of PAGES_WITH_ANALYTICS) {
  test(`${page}: incarca /js/config.js SI /js/analytics.js, in aceasta ordine, ambele NEDEFERATE (garanteaza ca window.NalunaAnalytics exista deja cand scriptul inline de la finalul paginii ruleaza)`, () => {
    const html = readHtml(page);
    const configIdx = html.indexOf('<script src="/js/config.js">');
    const analyticsIdx = html.indexOf('<script src="/js/analytics.js">');
    assert.ok(configIdx !== -1, `${page}: lipseste /js/config.js`);
    assert.ok(analyticsIdx !== -1, `${page}: lipseste /js/analytics.js`);
    assert.ok(configIdx < analyticsIdx, `${page}: config.js trebuie sa fie inclus INAINTE de analytics.js`);
    // niciun defer/async pe aceste doua — trebuie sa execute sincron, in ordine, inainte de
    // orice script inline de mai jos in pagina.
    const configTag = html.slice(configIdx, html.indexOf('</script>', configIdx));
    const analyticsTag = html.slice(analyticsIdx, html.indexOf('</script>', analyticsIdx));
    assert.ok(!/defer|async/.test(configTag), `${page}: config.js nu trebuie sa fie defer/async`);
    assert.ok(!/defer|async/.test(analyticsTag), `${page}: analytics.js nu trebuie sa fie defer/async`);
  });
}

test('comanda.html: start_order + form_started sunt declansate langa initializarea formularului, INAINTE de orice submit', () => {
  const html = readHtml('comanda.html');
  const idx = html.indexOf("window.NalunaAnalytics.track('start_order')");
  assert.ok(idx !== -1);
  assert.ok(html.indexOf("window.NalunaAnalytics.onFormStarted('#order-form')") > idx);
  // trebuie sa apara INAINTE de handler-ul de submit (care contine apelul catre POST /api/orders).
  const submitIdx = html.indexOf("fetch('/api/orders'");
  assert.ok(idx < submitIdx, 'start_order trebuie sa fie langa initializare, inaintea submit-ului');
});

test('comanda.html: form_completed se trimite STRICT in ramura "!currentOrderId" (comanda noua creata cu succes), NICIODATA inainte de validare sau pentru un retry pe o comanda deja creata', () => {
  const html = readHtml('comanda.html');
  const branchStart = html.indexOf('if (!currentOrderId) {');
  const branchEnd = html.indexOf('\n      }', html.indexOf("fetch('/api/orders'", branchStart));
  assert.ok(branchStart !== -1 && branchEnd !== -1);
  const branch = html.slice(branchStart, branchEnd);
  assert.match(branch, /createData\.orderId/, 'trebuie sa fie dupa ce raspunsul serverului a fost citit');
  assert.match(branch, /form_completed/);
  // form_completed trebuie sa vina DUPA verificarea "if (!createData.orderId) { ... return; }"
  // (esec de creare) — niciodata inainte.
  const idxFailureReturn = branch.indexOf('if (!createData.orderId)');
  const idxFormCompleted = branch.indexOf('form_completed');
  assert.ok(idxFailureReturn !== -1 && idxFailureReturn < idxFormCompleted, 'form_completed trebuie sa fie dupa garda de esec a crearii comenzii, niciodata inainte');
});

test('melodia-mea.html: begin_checkout se trimite STRICT dupa confirmarea "data.url" (sesiune Stripe reala creata), niciodata la simplul click pe buton', () => {
  const html = readHtml('melodia-mea.html');
  const idxIf = html.indexOf('if (data.url) {');
  const idxTrack = html.indexOf("window.NalunaAnalytics.track('begin_checkout'", idxIf);
  const idxRedirect = html.indexOf('window.location.href = data.url;', idxIf);
  assert.ok(idxIf !== -1 && idxTrack !== -1 && idxRedirect !== -1);
  assert.ok(idxIf < idxTrack && idxTrack < idxRedirect, 'begin_checkout trebuie sa fie STRICT intre confirmarea data.url si redirectul real');
});

test('melodia-mea.html: gaClientId SI gaSessionId sunt capturate (in paralel) INAINTE de cererea catre /checkout si transmise in body — flow-ul de checkout ramane STRICT acelasi (acelasi endpoint, acelasi X-Access-Token)', () => {
  const html = readHtml('melodia-mea.html');
  const idxGetClientId = html.indexOf('window.NalunaAnalytics.getClientId()');
  const idxGetSessionId = html.indexOf('window.NalunaAnalytics.getSessionId()');
  const idxFetch = html.indexOf('fetch(`/api/orders/${orderId}/checkout`');
  assert.ok(idxGetClientId !== -1 && idxGetSessionId !== -1 && idxFetch !== -1);
  assert.ok(idxGetClientId < idxFetch, 'client_id-ul trebuie capturat inainte de a fi trimis in cerere');
  assert.ok(idxGetSessionId < idxFetch, 'session_id-ul trebuie capturat inainte de a fi trimis in cerere');
  assert.match(html, /body:\s*JSON\.stringify\(\{\s*gaClientId:[^,]*,\s*gaSessionId:/, 'body-ul cererii trebuie sa contina AMBELE campuri');
  assert.match(html, /'X-Access-Token':\s*accessToken/, 'autentificarea comenzii (X-Access-Token) trebuie sa ramana STRICT neschimbata');
});

test('se-compune.html: generation_completed/generation_failed sunt trimise STRICT in interiorul functiilor deja existente (finishSuccess/handleGenerationFailed), protejate de flag-ul "finished" existent — nicio logica noua de polling', () => {
  const html = readHtml('se-compune.html');
  const successStart = html.indexOf('function finishSuccess() {');
  const successEnd = html.indexOf('\n  }', successStart);
  const successBody = html.slice(successStart, successEnd);
  assert.match(successBody, /finished = true;[\s\S]*generation_completed/, 'generation_completed trebuie sa fie DUPA finished=true, in aceeasi functie');

  const failStart = html.indexOf('function handleGenerationFailed() {');
  const failEnd = html.indexOf('\n  }', failStart);
  const failBody = html.slice(failStart, failEnd);
  assert.match(failBody, /finished = true;[\s\S]*generation_failed/, 'generation_failed trebuie sa fie DUPA finished=true, in aceeasi functie');
});

test('succes.html: NU contine niciun eveniment "purchase" client-side (sursa unica e server-side, Measurement Protocol, vezi analytics-server.test.js)', () => {
  const html = readHtml('succes.html');
  assert.doesNotMatch(html, /NalunaAnalytics\.track\(\s*['"]purchase['"]/, 'purchase NU trebuie trimis niciodata din pagina de succes — refresh/revizitare ar dubla evenimentul');
});

test('niciuna dintre paginile modificate nu trimite date PII catre track() — verificare structurala pe toate apelurile track(...) gasite', () => {
  const forbiddenParamPattern = /\b(name|email|story|recipient|sender|lyrics)\s*:/i;
  for (const page of PAGES_WITH_ANALYTICS) {
    const html = readHtml(page);
    const trackCalls = html.match(/NalunaAnalytics\.track\([^)]*\)/g) || [];
    for (const call of trackCalls) {
      assert.doesNotMatch(call, forbiddenParamPattern, `${page}: apel track() suspect de PII: ${call}`);
    }
  }
});
