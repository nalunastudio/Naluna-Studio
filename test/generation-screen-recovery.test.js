// INCIDENT PRODUCTIE (6 oct 2026) — comanda Premium reala (`0b010774...`) a ajuns preview_ready
// in backend la ~2 minute de la creare, dar tab-ul clientului a ramas vizual pe "Melodia ta se
// compune acum" cel putin 2 ore — niciun eveniment generation_completed inregistrat vreodata
// pentru acea comanda (verificat direct in funnel_events de productie). Hotfix-ul anterior
// (7 aug 2026) acoperea STRICT visibilitychange + pageshow cu event.persisted=true —
// insuficient, pentru ca iOS Safari poate suspenda timer-ele unei pagini fara sa garanteze ca
// aceste evenimente se declanseaza in toate scenariile reale.
//
// Verificare STATICA (acelasi tipar ca restul suitei pentru pagini publice — vezi
// test/admin-orders-auto-refresh.test.js, test/slow-generation-message.test.js): sursa citita
// ca text, nicio executie reala in jsdom (nu exista jsdom in acest proiect).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Normalizare CRLF->LF la citire (checkout Windows local, autocrlf — acelasi tipar documentat in
// test/csp-inline-script-hash-integrity.test.js; blob-ul real din git e 100% LF).
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'se-compune.html'), 'utf8').replace(/\r\n/g, '\n');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

test('ramane sintactic valid dupa fix', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  scripts.forEach(m => { new Function(m[1]); });
});

// -------- Scenariul 1: generare normala (generating -> preview_ready -> redirect) --------

test('Scenariul 1 — pollStatus(): initialSucceeded/regenSucceeded apeleaza finishSuccess(), altfel reprogrameaza la 4000ms (polling normal pastrat)', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  assert.match(fn, /if \(regenSucceeded \|\| initialSucceeded\) \{\s*finishSuccess\(\);/);
  assert.match(fn, /pollTimer = setTimeout\(pollStatus, 4000\);/);
});

test('Scenariul 1 — finishSuccess(): seteaza finished=true, trimite generation_completed, redirecteaza dupa 1400ms', () => {
  const fn = extractFn(html, 'function finishSuccess() {');
  assert.match(fn, /finished = true;/);
  assert.match(fn, /NalunaAnalytics\.track\('generation_completed', \{ orderId \}\);/);
  assert.match(fn, /setTimeout\(\(\) => \{\s*window\.location\.href = `\/melodia-mea\.html\?id=\$\{encodeURIComponent\(orderId\)\}&token=\$\{encodeURIComponent\(accessToken\)\}`;\s*\}, 1400\);/);
});

// -------- Scenariul 2: backend deja preview_ready la page load --------

test('Scenariul 2 — pollStatus() e apelat NECONDITIONAT, imediat dupa definirea functiei, la initializarea scriptului (fara sa astepte vreun eveniment)', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  const afterFn = html.slice(html.indexOf(fn) + fn.length);
  const nextStatement = afterFn.trimStart().split('\n')[0].trim();
  assert.equal(nextStatement, 'pollStatus();', 'prima instructiune de dupa definirea functiei trebuie sa fie apelul neconditionat pollStatus();');
});

test('Scenariul 2 — pollStatus() e apelat neconditionat la init exact o singura data cu acest indent de nivel-de-top (2 spatii) — restul aparitiilor sunt STRICT in interiorul declansatoarelor de recovery/watchdog, nu duplicate ale apelului initial', () => {
  const topLevelCalls = html.match(/\n {2}pollStatus\(\);\n/g) || [];
  assert.equal(topLevelCalls.length, 1, `asteptat exact 1 apel la nivel de top (2 spatii indent), gasit ${topLevelCalls.length}`);
});

// -------- Scenariul 3/4/5: visibilitychange / pageshow / focus --------

test('Scenariul 3 — visibilitychange: cand tab-ul redevine vizibil (!document.hidden), apeleaza pollStatus() direct', () => {
  assert.match(html, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!document\.hidden\) pollStatus\(\);\s*\}\);/);
});

test('Scenariul 4 — pageshow: apeleaza pollStatus() NECONDITIONAT (NU mai verifica event.persisted) — acopera si reload complet, nu doar restaurare din bfcache', () => {
  const idx = html.indexOf("window.addEventListener('pageshow'");
  assert.notEqual(idx, -1);
  const block = html.slice(idx, idx + 200);
  assert.match(block, /window\.addEventListener\('pageshow', \(\) => \{\s*pollStatus\(\);\s*\}\);/);
  assert.doesNotMatch(block, /event\.persisted/, 'pageshow nu mai trebuie sa fie gardat de event.persisted');
});

test('Scenariul 5 — window focus: declansator nou, apeleaza pollStatus()', () => {
  assert.match(html, /window\.addEventListener\('focus', \(\) => \{\s*pollStatus\(\);\s*\}\);/);
});

// -------- Scenariul 6: timer throttled/suspended -> watchdog --------

test('Scenariul 6 — watchdog periodic: ruleaza DOAR cand document.visibilityState === \'visible\' si DOAR daca a trecut STALE_POLL_THRESHOLD_MS de la ultima incercare de poll', () => {
  assert.match(html, /const WATCHDOG_INTERVAL_MS = 7000;/);
  assert.match(html, /const STALE_POLL_THRESHOLD_MS = 9000;/);
  const idx = html.indexOf('setInterval(() => {\n    if (finished) return;\n    if (document.visibilityState');
  assert.notEqual(idx, -1, 'watchdog-ul trebuie sa verifice finished si document.visibilityState, in aceasta ordine');
  const block = html.slice(idx, idx + 300);
  assert.match(block, /if \(document\.visibilityState !== 'visible'\) return;/);
  assert.match(block, /if \(Date\.now\(\) - lastPollAttemptAt > STALE_POLL_THRESHOLD_MS\) \{\s*pollStatus\(\);/);
  assert.match(block, /\}, WATCHDOG_INTERVAL_MS\);/);
});

test('Scenariul 6 — watchdog-ul NU actioneaza cand pagina nu e vizibila (nu interfereaza cu tab-uri in fundal)', () => {
  const idx = html.indexOf('setInterval(() => {\n    if (finished) return;\n    if (document.visibilityState');
  const block = html.slice(idx, idx + 150);
  // garda de vizibilitate trebuie sa vina INAINTE de orice apel pollStatus() din acest bloc
  const visGuardIdx = block.indexOf("document.visibilityState !== 'visible'");
  const pollCallIdx = block.indexOf('pollStatus();');
  assert.ok(visGuardIdx !== -1 && (pollCallIdx === -1 || visGuardIdx < pollCallIdx));
});

// -------- Scenariul 7: network failure temporar -> recovery dupa reconectare --------

test('Scenariul 7 — eroare de retea (catch) si raspuns HTTP non-ok reprogrameaza polling-ul la 4000ms, NU opresc bucla', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  assert.match(fn, /if \(!res\.ok\) \{\s*consecutivePollFailures\+\+;\s*if \(consecutivePollFailures >= 2\) showSoftNotice\(\);\s*pollTimer = setTimeout\(pollStatus, 4000\);\s*return;/);

  const catchIdx = fn.indexOf('} catch (err) {');
  const finallyIdx = fn.indexOf('} finally {');
  assert.ok(catchIdx !== -1 && finallyIdx !== -1 && catchIdx < finallyIdx);
  const catchBody = fn.slice(catchIdx, finallyIdx);
  assert.match(catchBody, /consecutivePollFailures\+\+;/);
  assert.match(catchBody, /if \(consecutivePollFailures >= 2\) showSoftNotice\(\);/);
  assert.match(catchBody, /pollTimer = setTimeout\(pollStatus, 4000\);/);
});

// -------- Scenariul 8: evenimente de recovery multiple aproape simultan -> un singur request activ --------

test('Scenariul 8 — pollStatus() are garda pollInFlight la inceput (inainte de orice fetch) — un al doilea declansator aproape simultan NU porneste un al doilea request', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  const guardIdx = fn.indexOf('if (pollInFlight) return;');
  const fetchIdx = fn.indexOf('await fetch(');
  assert.ok(guardIdx !== -1 && guardIdx < fetchIdx, 'garda pollInFlight trebuie sa fie INAINTE de fetch');
  assert.match(fn, /pollInFlight = true;/);
  assert.match(fn, /\} finally \{\s*pollInFlight = false;\s*\}/);
});

test('Scenariul 8 — pollStatus() anuleaza orice timer deja programat inainte sa porneasca un nou request (evita doua lanturi de polling suprapuse)', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  const clearIdx = fn.indexOf("if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }");
  const fetchIdx = fn.indexOf('await fetch(');
  assert.ok(clearIdx !== -1 && clearIdx < fetchIdx);
});

test('Scenariul 8 — toate cele 4 declansatoare de recovery (visibilitychange, pageshow, focus, watchdog) apeleaza STRICT pollStatus() — niciunul nu reimplementeaza propria logica de fetch/concurenta', () => {
  assert.doesNotMatch(html, /document\.addEventListener\('visibilitychange'[\s\S]{0,120}fetch\(/);
  assert.doesNotMatch(html, /window\.addEventListener\('pageshow'[\s\S]{0,80}fetch\(/);
  assert.doesNotMatch(html, /window\.addEventListener\('focus'[\s\S]{0,80}fetch\(/);
  assert.ok(!html.includes('function forceImmediatePoll'), 'wrapper-ul vechi forceImmediatePoll trebuie eliminat — toate declansatoarele apeleaza pollStatus() direct, de-duplicarea fiind STRICT in pollStatus()');
});

// -------- Scenariul 9: generation_completed emis o singura data --------

test('Scenariul 9 — pollStatus() are garda `if (finished) return;` ca PRIMA instructiune a corpului functiei — niciun declansator de recovery nu poate re-intra dupa finalizare', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  const body = fn.slice('async function pollStatus() {'.length).trimStart();
  assert.ok(body.startsWith('if (finished) return;'), 'if (finished) return; trebuie sa fie STRICT prima instructiune din corpul functiei');
});

test('Scenariul 9 — finishSuccess() seteaza finished=true ca PRIMA instructiune — orice re-intrare ulterioara in pollStatus() e blocata inainte de a retrimite generation_completed', () => {
  const fn = extractFn(html, 'function finishSuccess() {');
  const firstStatement = fn.replace('function finishSuccess() {', '').trimStart();
  assert.ok(firstStatement.startsWith('finished = true;'), 'finished = true trebuie sa fie STRICT prima instructiune din finishSuccess()');
});

test('Scenariul 9 — dupa raspunsul fetch, pollStatus() reverifica `finished` inainte sa proceseze rezultatul (race: alt declansator a finalizat deja cat timp acest fetch era in asteptare)', () => {
  const fn = extractFn(html, 'async function pollStatus() {');
  const fetchIdx = fn.indexOf('await fetch(');
  const postFetchGuardIdx = fn.indexOf('if (finished) return;', fetchIdx);
  assert.ok(postFetchGuardIdx !== -1 && postFetchGuardIdx > fetchIdx, 'trebuie sa existe o a doua verificare `finished` IMEDIAT dupa fetch, inainte de a citi/procesa raspunsul');
});

// -------- Scenariul 10: redirect executat o singura data --------

test('Scenariul 10 — redirect-ul catre rezultat (window.location.href) exista STRICT o singura data in interiorul finishSuccess() — functia nu poate redirectiona de doua ori', () => {
  const fn = extractFn(html, 'function finishSuccess() {');
  const matches = fn.match(/window\.location\.href = `\/melodia-mea\.html/g) || [];
  assert.equal(matches.length, 1, `asteptat exact 1 redirect in finishSuccess(), gasit ${matches.length}`);
});

test('Scenariul 10 — finishSuccess() poate fi apelata o SINGURA data per incarcare de pagina (gardata de `finished`), deci redirect-ul per total ruleaza o singura data indiferent de cate declansatoare de recovery ajung la raspuns de succes', () => {
  // Deja verificat structural: pollStatus() are `if (finished) return;` ca prima instructiune
  // (Scenariul 9) SI finishSuccess() seteaza finished=true ca prima instructiune (Scenariul 9) —
  // impreuna garanteaza ca finishSuccess() (si deci redirect-ul din interiorul ei) nu poate
  // rula de doua ori, indiferent cate declansatoare de recovery (visibilitychange/pageshow/
  // focus/watchdog) ajung sa primeasca un raspuns de succes aproape simultan.
  const pollFn = extractFn(html, 'async function pollStatus() {');
  const pollBody = pollFn.slice('async function pollStatus() {'.length).trimStart();
  const successFn = extractFn(html, 'function finishSuccess() {');
  const successBody = successFn.slice('function finishSuccess() {'.length).trimStart();
  assert.ok(pollBody.startsWith('if (finished) return;'));
  assert.ok(successBody.startsWith('finished = true;'));
});
