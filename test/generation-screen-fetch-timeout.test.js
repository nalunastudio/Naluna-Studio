// FIX (incident real, 7 oct 2026) — REGRESIE confirmata prin executia reala a codului (nu
// presupunere): c7daa3f a introdus pollInFlight ca garda de concurenta pentru polling, dar
// fetch() nu are niciun timeout implicit. Daca o conexiune ramane blocata fara raspuns (nici
// rezolvata, nici respinsa), await-ul fetch-ului nu trece NICIODATA mai departe — pollInFlight
// ramane true PERMANENT, iar toate declansatoarele de recovery (visibilitychange/pageshow/
// focus/watchdog) devin inerte, pentru ca toate verifica STRICT acelasi pollInFlight. Codul
// VECHI (inainte de c7daa3f), desi fara nicio garda de concurenta, era accidental rezilient la
// exact acest scenariu — fiecare declansator pornea un fetch nou, independent.
//
// Fixul: AbortController cu timeout de 10s pe fetch — o conexiune blocata e fortat abandonata,
// intra in catch-ul existent (neschimbat), elibereaza pollInFlight in finally, polling-ul
// normal la 4s continua.
//
// Verificare prin EXECUTIE REALA (nu doar inspectie statica a sursei): codul exact din
// public/se-compune.html ruleaza intr-un sandbox Node (vm, built-in — nicio dependenta noua),
// cu document/window/fetch/timere false, controlate manual. O proprietate ca "pollInFlight se
// reseteaza dupa un timeout" e o proprietate de RUNTIME — nu poate fi demonstrata prin regex.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSandbox, jsonResponse, flushMicrotasks } = require('./helpers/se-compune-dom-sandbox.js');

function loadReal(fetchImpl, search) {
  const sandbox = buildSandbox({ fetchImpl, initialSearch: search });
  sandbox.run();
  return sandbox;
}

function abortableHang() {
  return async (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
  });
}

test('1) normal: generating (backend trimite generationPhasePercent, dar NU mai e citit pentru afisare) -> preview_ready -> 100% -> redirect, cate un singur fetch per tick de 4s', async () => {
  // RESTAURARE (restore: original generation progress display): afisarea pillei NU mai depinde
  // de order.generationPhasePercent (simulat mai jos identic ca inainte, ca sa confirmam ca NU
  // mai are efect) — e STRICT formula de timp scurs din 6699abe. generationPhasePercent ramane
  // disponibil in raspunsul API (backend neschimbat), doar nu mai e citit pentru UI.
  const seq = [10, 30, 55, 80].map(p => ({ status: 'generating', generationPhasePercent: p, plan: 'standard' }));
  seq.push({ status: 'preview_ready', generationPhasePercent: 100, plan: 'standard' });
  let i = 0;
  const sandbox = loadReal(async () => jsonResponse(seq[Math.min(i++, seq.length - 1)]));
  const pill = sandbox.elements.get('estimate-pill');
  const seen = [];
  for (let k = 0; k < seq.length; k++) { await sandbox.clock.advance(4000); seen.push(pill.textContent); }
  await sandbox.clock.advance(1500); // redirect-ul e programat la 1400ms dupa finishSuccess()
  assert.deepEqual(seen, ['2%', '5%', '7%', '10%', '100%']); // round(elapsed/165000*100) la fiecare tick de 4s, apoi 100% fortat de finishSuccess()
  assert.equal(sandbox.log.redirects.length, 1);
  assert.equal(sandbox.log.analytics.filter(a => a.name === 'generation_completed').length, 1);
});

test('2) primul fetch ramane pending -> abort la 10s -> pollInFlight revine false -> retry -> procentul vizual (bazat pe timp) continua sa avanseze, neintrerupt de timeout', async () => {
  let call = 0;
  const hang = abortableHang();
  const sandbox = loadReal(async (url, opts) => {
    call++;
    if (call === 1) return hang(url, opts);
    return jsonResponse({ status: 'generating', generationPhasePercent: 30, plan: 'standard' });
  });
  await sandbox.clock.advance(15000); // 10s abort + 4s delay retry = al doilea fetch la t=14s
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '9%'); // round(15000/165000*100) — neatins de timeout-ul de fetch
  assert.equal(call, 2);
});

test('3) fetch pending, backend devine preview_ready intre timp -> timeout -> retry -> 100% -> redirect', async () => {
  let call = 0;
  const hang = abortableHang();
  const sandbox = loadReal(async (url, opts) => {
    call++;
    if (call === 1) return hang(url, opts);
    return jsonResponse({ status: 'preview_ready', generationPhasePercent: 100, plan: 'standard' });
  });
  await sandbox.clock.advance(15000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '100%');
  await sandbox.clock.advance(1500);
  assert.equal(sandbox.log.redirects.length, 1);
  assert.equal(sandbox.log.analytics.filter(a => a.name === 'generation_completed').length, 1);
});

test('4) eroare de retea (reject) -> reincearca normal la 4s, nu se opreste', async () => {
  let call = 0;
  const sandbox = loadReal(async () => { call++; throw new Error('network'); });
  await sandbox.clock.advance(20000);
  assert.equal(call, 5);
});

test('5) HTTP 401/403 -> nu blocheaza definitiv polling-ul, continua sa reincerce', async () => {
  let call = 0;
  const sandbox = loadReal(async () => { call++; return jsonResponse({}, false, 401); });
  await sandbox.clock.advance(20000);
  assert.equal(call, 5);
});

test('6) JSON invalid -> prins de catch, reincearca normal', async () => {
  let call = 0;
  const sandbox = loadReal(async () => { call++; return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } }; });
  await sandbox.clock.advance(20000);
  assert.equal(call, 5);
});

test('7) focus/pageshow/visibilitychange in timpul unui fetch normal (nu pending) -> fara request-uri duplicate', async () => {
  let call = 0;
  let resolveFirst;
  const pending = new Promise(r => { resolveFirst = r; });
  const sandbox = loadReal(async () => {
    call++;
    if (call === 1) await pending;
    return jsonResponse({ status: 'generating', generationPhasePercent: 30, plan: 'standard' });
  });
  await flushMicrotasks();
  sandbox.fakeWindow._focusHandlers[0]();
  sandbox.fakeWindow._pageshowHandlers[0]();
  sandbox.fakeDocument._visHandlers[0]();
  await flushMicrotasks();
  assert.equal(call, 1, 'niciun declansator nu trebuie sa porneasca un al doilea fetch cat timp primul e inca activ');
});

test('8) focus/pageshow DUPA un timeout -> recovery functioneaza (pollInFlight nu a ramas blocat); procentul vizual ramane bazat pe timp, neatins de raspunsul backend', async () => {
  let call = 0;
  const hang = abortableHang();
  const sandbox = loadReal(async (url, opts) => {
    call++;
    if (call === 1) return hang(url, opts);
    return jsonResponse({ status: 'generating', generationPhasePercent: 55, plan: 'standard' });
  });
  await sandbox.clock.advance(10000); // declanseaza abort-ul primului fetch
  await flushMicrotasks();
  sandbox.fakeWindow._focusHandlers[0]();
  await flushMicrotasks();
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '6%'); // round(10000/165000*100)
});

test('9) watchdog dupa un timeout -> recovery functioneaza fara niciun declansator manual; procentul vizual ramane bazat pe timp', async () => {
  let call = 0;
  const hang = abortableHang();
  const sandbox = loadReal(async (url, opts) => {
    call++;
    if (call === 1) return hang(url, opts);
    return jsonResponse({ status: 'generating', generationPhasePercent: 80, plan: 'standard' });
  });
  await sandbox.clock.advance(20000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '12%'); // round(20000/165000*100)
});

test('10/11) generation_completed si redirect exact o singura data, chiar si cu un timeout in mijlocul secventei', async () => {
  let call = 0;
  const hang = abortableHang();
  const sandbox = loadReal(async (url, opts) => {
    call++;
    if (call === 1) return hang(url, opts);
    if (call === 2) return jsonResponse({ status: 'generating', generationPhasePercent: 55, plan: 'standard' });
    return jsonResponse({ status: 'preview_ready', generationPhasePercent: 100, plan: 'standard' });
  });
  await sandbox.clock.advance(25000);
  await sandbox.clock.advance(1500);
  assert.equal(sandbox.log.analytics.filter(a => a.name === 'generation_completed').length, 1);
  assert.equal(sandbox.log.redirects.length, 1);
});

test('12) estimate-pill afiseaza procentul bazat pe timp la fiecare tick, apoi 100% la preview_ready (nu valorile generationPhasePercent din backend)', async () => {
  const seq = [10, 30, 55, 80].map(p => ({ status: 'generating', generationPhasePercent: p, plan: 'standard' }));
  seq.push({ status: 'preview_ready', generationPhasePercent: 100, plan: 'standard' });
  let i = 0;
  const sandbox = loadReal(async () => jsonResponse(seq[Math.min(i++, seq.length - 1)]));
  const pill = sandbox.elements.get('estimate-pill');
  const seen = [];
  for (let k = 0; k < seq.length; k++) { await sandbox.clock.advance(4000); seen.push(pill.textContent); }
  assert.deepEqual(seen, ['2%', '5%', '7%', '10%', '100%']);
});
