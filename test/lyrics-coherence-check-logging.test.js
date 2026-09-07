// PUNCT (2026-09-07, "nu modifica criteriile de validare pana cand nu cunoastem motivele reale
// de respingere"): adauga logging privacy-safe in jurul validateLyricsCoherence(), STRICT cod de
// motiv (enumerare fixa) + index piesa + faza (initial/retry) — niciodata versuri, poveste sau
// nume. Verifica de asemenea ca regula de retry deja existenta (retry COMPLET STRICT daca AMBELE
// piese initiale esueaza; o piesa valida se pastreaza fara retry) NU a fost modificata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function attemptBody() {
  const fnIdx = server.indexOf('async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.notEqual(fnIdx, -1);
  const innerIdx = server.indexOf('async function attempt(candidateTracks, candidateTaskId, phase) {', fnIdx);
  assert.notEqual(innerIdx, -1);
  const endIdx = server.indexOf('\n  }\n\n  const first = await attempt(', innerIdx);
  assert.notEqual(endIdx, -1);
  return server.slice(innerIdx, endIdx);
}

test('obtainAcceptableVariant: attempt() primeste un parametru "phase" (initial/retry), folosit STRICT pentru etichetarea logului, niciodata pentru schimbarea deciziei de acceptare', () => {
  const body = attemptBody();
  assert.match(body, /async function attempt\(candidateTracks, candidateTaskId, phase\) \{/);
});

test('lyrics_coherence_check: logheaza faza, indexul piesei si motivele (enumerare fixa), STRICT prin perfLog, imediat dupa calculul coherence', () => {
  const body = attemptBody();
  assert.match(body, /perfLog\(orderId, 'lyrics_coherence_check', `faza=\$\{phase\}, piesa=\$\{trackIndex\}, ok=\$\{coherence\.ok\}, motive=\$\{coherence\.reasons\.length \? coherence\.reasons\.join\('\|'\) : 'niciunul'\}`\);/);
});

test('lyrics_coherence_check: NU include niciodata versurile, povestea sau numele destinatarului — STRICT cele 4 campuri numerice/enum permise', () => {
  const body = attemptBody();
  const logLineIdx = body.indexOf("perfLog(orderId, 'lyrics_coherence_check'");
  assert.notEqual(logLineIdx, -1);
  const logLine = body.slice(logLineIdx, body.indexOf(';', logLineIdx) + 1);
  assert.doesNotMatch(logLine, /originalLyrics|recipient|story|poveste/i, 'linia de log nu trebuie sa refere niciun camp cu continut personal');
});

test('obtainAcceptableVariant: apelurile catre attempt() transmit explicit faza corecta ("initial" la prima incercare, "retry" la reincercare)', () => {
  const fnIdx = server.indexOf('async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  const body = server.slice(fnIdx, fnIdx + 3000);
  assert.match(body, /const first = await attempt\(tracks, taskId, 'initial'\);/);
  assert.match(body, /const second = await attempt\(retryResult\.tracks, retryTaskId, 'retry'\);/);
});

test('REGRESIE: regula de retry NU a fost modificata — o reincercare COMPLETA a intregii generari se declanseaza STRICT daca prima incercare nu a produs nicio piesa acceptabila (first.built e null)', () => {
  const fnIdx = server.indexOf('async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  const body = server.slice(fnIdx, fnIdx + 3000);
  assert.match(body, /if \(first\.built \|\| canonicalLyrics\) return first;/, 'o piesa valida obtinuta la prima incercare trebuie pastrata, fara reincercare completa');
  assert.match(body, /const retryTaskId = await callMusicProvider\(orderId, retryPrompt\);/);
  assert.match(body, /const retryResult = await pollForResult\(retryTaskId, orderId\);/);
});

test('REGRESIE: attempt() continua la urmatoarea piesa (fara "break") cand o piesa procesata tehnic cu succes e totusi incoerenta/goala — bugul original ramane fixat', () => {
  const body = attemptBody();
  assert.match(body, /if \(coherence\.ok\) return \{ built: candidate, lastErr: null \};/);
  assert.doesNotMatch(body.slice(body.indexOf('if (coherence.ok)'), body.indexOf('return { built: null, lastErr };')), /\bbreak;/);
});
