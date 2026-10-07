// RESTAURARE (7 oct 2026, "restore: original generation progress display" — decizie explicita
// a clientului, dupa comparatie directa cu commit-ul de lansare 6699abe din 26 iul 2026):
// procentul vizibil revine la formula ORIGINALA de atunci — STRICT pe baza de timp scurs de la
// pornirea paginii, plafonata la 99%, NICIODATA din order.generationPhasePercent (care ramane
// disponibil, neschimbat, in raspunsul API — doar nu mai controleaza afisarea).
//
// Verificare prin EXECUTIE REALA a codului din public/se-compune.html (modulul vm, built-in —
// nicio dependenta noua), nu doar inspectie statica — "la 82.5s e ~50%" e o proprietate de
// RUNTIME, nu un pattern de text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSandbox, jsonResponse, flushMicrotasks } = require('./helpers/se-compune-dom-sandbox.js');

function loadReal(fetchImpl, search) {
  const sandbox = buildSandbox({ fetchImpl, initialSearch: search });
  sandbox.run();
  return sandbox;
}

test('1) la page load, pill-ul NU este gol si NU este ascuns', () => {
  const sandbox = loadReal(async () => new Promise(() => {})); // fetch-ul nici macar nu conteaza aici
  const pill = sandbox.elements.get('estimate-pill');
  assert.notEqual(pill.textContent, '');
  assert.equal(pill.classList.contains('hidden'), false);
});

test('2) procentul porneste imediat la 0% (nu asteapta niciun tick/fetch)', () => {
  const sandbox = loadReal(async () => new Promise(() => {}));
  const pill = sandbox.elements.get('estimate-pill');
  assert.equal(pill.textContent, '0%');
});

test('3) la ~82.5 secunde (jumatate din ESTIMATE_MS=165000) este ~50%', async () => {
  const sandbox = loadReal(async () => new Promise(() => {}));
  await sandbox.clock.advance(82500);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '50%');
});

test('4) la 165 de secunde ajunge la maximum 99%, NICIODATA 100% pe cont propriu', async () => {
  const sandbox = loadReal(async () => new Promise(() => {}));
  await sandbox.clock.advance(165000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '99%');
});

test('5) dupa 165 secunde ramane plafonat la 99% (nu depaseste, nu scade) pana la rezultat', async () => {
  const sandbox = loadReal(async () => new Promise(() => {}));
  await sandbox.clock.advance(165000);
  await sandbox.clock.advance(300000); // inca 5 minute simulate
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '99%');
});

test('6) fetch/polling failure (reject) NU opreste procentajul vizual — continua sa avanseze', async () => {
  const sandbox = loadReal(async () => { throw new Error('network'); });
  await sandbox.clock.advance(10000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '6%'); // round(10000/165000*100)
});

test('7) fetch pending (nu se rezolva niciodata) NU opreste procentajul vizual — ruleaza independent de retea', async () => {
  const sandbox = loadReal(async () => new Promise(() => {})); // atarna la nesfarsit
  await sandbox.clock.advance(20000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '12%'); // round(20000/165000*100)
});

test('8) preview_ready/ready -> procentul sare la 100% (prin finishSuccess, clasa CSS .done)', async () => {
  const sandbox = loadReal(async () => jsonResponse({ status: 'preview_ready', plan: 'standard' }));
  await sandbox.clock.advance(4000); // primul raspuns real al pollStatus()
  const progressFill = sandbox.elements.get('progress-fill');
  assert.equal(progressFill.classList.contains('done'), true);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '100%');
  assert.equal(sandbox.elements.get('estimate-pill').classList.contains('hidden'), true);
});

test('9) finishSuccess() redirectioneaza o singura data catre pagina de rezultat', async () => {
  const sandbox = loadReal(async () => jsonResponse({ status: 'preview_ready', plan: 'standard' }));
  await sandbox.clock.advance(4000);
  await sandbox.clock.advance(1500); // redirectul e programat la 1400ms dupa finishSuccess
  assert.equal(sandbox.log.redirects.length, 1);
  assert.match(sandbox.log.redirects[0], /^\/melodia-mea\.html\?id=/);
  assert.equal(sandbox.log.analytics.filter(a => a.name === 'generation_completed').length, 1);
});

test('10) polling/recovery actual ramane complet functional: pollInFlight, AbortController 10s, retry la 4s, visibilitychange/pageshow/focus/watchdog', async () => {
  // 10a) retry normal la eroare de retea (mecanism neatins)
  let callsA = 0;
  const sbA = loadReal(async () => { callsA++; throw new Error('network'); });
  await sbA.clock.advance(20000);
  assert.equal(callsA, 5, 'polling-ul normal la 4s trebuie sa continue neschimbat');

  // 10b) fetch blocat -> abort la 10s -> pollInFlight elibereaza -> retry
  let callsB = 0;
  const sbB = loadReal(async (url, opts) => {
    callsB++;
    if (callsB === 1) return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('Abort'), { name: 'AbortError' }))));
    return jsonResponse({ status: 'generating', plan: 'standard' });
  });
  await sbB.clock.advance(15000);
  assert.equal(callsB, 2, 'AbortController + timeout 10s trebuie sa elibereze pollInFlight si sa permita retry');

  // 10c) visibilitychange/pageshow/focus raman cablate la pollStatus()
  const sbC = loadReal(async () => jsonResponse({ status: 'generating', plan: 'standard' }));
  assert.ok(sbC.fakeDocument._visHandlers.length >= 1, 'visibilitychange trebuie sa ramana inregistrat');
  assert.ok(sbC.fakeWindow._pageshowHandlers && sbC.fakeWindow._pageshowHandlers.length >= 1, 'pageshow trebuie sa ramana inregistrat');
  assert.ok(sbC.fakeWindow._focusHandlers && sbC.fakeWindow._focusHandlers.length >= 1, 'focus trebuie sa ramana inregistrat');
});
