// ============================================================================================
// BUG REAL DE PRODUCTIE (2026-09-30, "In pagina comenzii reale, unele melodii existente afiseaza
// 'Eroare' in player" — audit read-only, FARA nicio regenerare/Suno/stergere din storage).
//
// AUDIT: pentru 5 comenzi reale 'ready' (verificate direct, GET cu Range catre URL-ul semnat
// R2), fisierele sunt intacte — 206 Partial Content, content-type audio/mpeg, accept-ranges:
// bytes, dimensiuni reale corecte. NU e o problema de fisier/storage/CORS/range — confirmat
// direct, nu presupus.
//
// CAUZA REALA: comanda-mea.html poate fi deschisa STRICT prin accessToken-ul permanent (linkul
// din emailul de livrare) SAU printr-un resume-token (2026-09-28, "Continua cu aceasta comanda"
// din comenzile-mele.html — vezi resumeUrlFor/buildResumeToken in server.js, STRICT 60 de
// minute). lookup(token, orderId) foloseste acelasi `token` din URL, NESCHIMBAT, pentru
// construirea fullUrl (<audio src>, link de descarcare) — vezi test/order-resume-continue.test.js
// (MATRICE: /media/full+gift+bonus+wav+video accepta resume-token, STRICT pentru ca 'ready' e
// destinatia de resume pentru comenzi platite). Daca resume-tokenul expira CAT TIMP pagina ramane
// deschisa (sau linkul e revizitat mai tarziu), /media/full/:id il respinge (403/404, vezi
// isValidOrderCredential) — playerul <audio> nativ ajunge STRICT intr-o stare de eroare
// silentioasa, fara nicio explicatie sau recuperare (comanda-mea.html nu avea NICIUN handler de
// eroare pe <audio>, spre deosebire de playerul de previzualizare din melodia-mea.html).
//
// NU e o problema specifica unor comenzi/fisiere vechi — e un bug GENERAL, care poate afecta
// ORICE comanda 'ready' accesata prin resume-by-email, daca playback-ul/descarcarea e incercata
// dupa expirarea celor 60 de minute ale resume-tokenului.
//
// FIX: STRICT o reactie clara la evenimentul 'error' REAL al elementului <audio> (acelasi tipar
// deja folosit pentru .variant-audio-error din melodia-mea.html) — mesaj + link inapoi la
// Comenzile mele, ca sa poata cere un link proaspat. NU modifica TTL/formatul/matricea resume-v2,
// NU atinge storage/fisiere/retentie/pricing/Stripe/Meta CAPI/Suno.
// ============================================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const comandaMea = read('public/comanda-mea.html');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

test('comanda-mea.html: elementul .audio-link-expired-msg exista imediat dupa <audio>, ascuns implicit (stare normala, fara eroare)', () => {
  assert.match(
    comandaMea,
    /<audio controls src="\$\{fullUrl\}"><\/audio>\s*\n\s*<p class="audio-link-expired-msg" style="display:none;[^"]*"><\/p>/,
    'mesajul de eroare trebuie sa existe STRICT langa player, ascuns implicit'
  );
});

test('comanda-mea.html: <audio> primeste un listener de "error" REAL, o singura data ({ once: true }) — nu presupune eroarea, reactioneaza STRICT la evenimentul real al elementului', () => {
  assert.match(comandaMea, /audioEl\.addEventListener\('error', \(\) => \{/);
  assert.match(comandaMea, /\}, \{ once: true \}\);/);
});

test('comanda-mea.html: handler-ul de eroare foloseste STRICT t.audio_link_expired + un link real catre /comenzile-mele.html (t.see_my_orders) — nicio afirmatie despre cauza exacta (ar putea fi orice esec real de incarcare, nu doar expirarea resume-tokenului)', () => {
  assert.match(
    comandaMea,
    /expiredMsgEl\.innerHTML = `\$\{escapeHtml\(t\.audio_link_expired\)\} <a href="\/comenzile-mele\.html">\$\{escapeHtml\(t\.see_my_orders\)\}<\/a>`;/
  );
});

test('comanda-mea.html: wiring-ul erorii ruleaza STRICT pentru comenzi ready si neexpirate (accessExpired deja tratat separat, mai sus, fara player deloc)', () => {
  assert.match(comandaMea, /if \(o\.status === 'ready' && !accessExpired\) \{\s*\n\s*const audioEl = results\.querySelector\('audio'\);/);
});

for (const lang of ALLOWED_LANGS) {
  test(`comanda-mea.html: limba ${lang} are cheia audio_link_expired, nevida`, () => {
    const idx = comandaMea.indexOf(`    ${lang}: {`);
    assert.ok(idx !== -1, `blocul de limba ${lang} lipseste`);
    const end = comandaMea.indexOf('\n    },', idx);
    const block = comandaMea.slice(idx, end);
    const m = block.match(/audio_link_expired: (['"])((?:(?!\1).)*)\1/);
    assert.ok(m && m[2].trim().length > 0, `[${lang}] audio_link_expired lipseste/gol`);
  });
}

// FUNCTIONAL: extragem STRICT blocul de wiring al erorii (fara sa reimplementam logica in test)
// si il evaluam izolat, cu un <audio> mock care trimite un eveniment 'error' REAL — dovedim ca
// mesajul + linkul apar STRICT dupa eroare, niciodata inainte, si ca alte stari (draft/generating/
// accessExpired) nu declanseaza wiring-ul deloc.
function extractErrorWiringBlock() {
  const startMarker = "if (o.status === 'ready' && !accessExpired) {";
  const start = comandaMea.indexOf(startMarker);
  if (start === -1) throw new Error('marker de start negasit — codul real s-a schimbat?');
  const endMarker = "      if (o.status === 'ready' && !accessExpired) wireMemoriesEvents(o.id);";
  const end = comandaMea.indexOf(endMarker, start);
  if (end === -1) throw new Error('marker de sfarsit negasit — codul real s-a schimbat?');
  return comandaMea.slice(start, end);
}

function makeAudioMock() {
  const listeners = {};
  return {
    addEventListener(evt, fn, opts) { listeners[evt] = { fn, opts }; },
    __fireError() { listeners.error.fn(); }
  };
}
function makeMsgMock() {
  return { style: {}, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; } };
}

function runWiring({ status, accessExpired, audioEl, expiredMsgEl, t }) {
  const block = extractErrorWiringBlock();
  const fn = new Function('o', 'accessExpired', 'results', 't', 'escapeHtml',
    block + '\nreturn { fired: typeof audioEl !== "undefined" };'
  );
  const resultsMock = {
    querySelector: (sel) => (sel === 'audio' ? audioEl : sel === '.audio-link-expired-msg' ? expiredMsgEl : null)
  };
  const escapeHtml = (s) => String(s);
  fn({ status }, accessExpired, resultsMock, t, escapeHtml);
}

test('sandbox: comanda ready, neexpirata — <audio> primeste listener; INAINTE de orice eroare, mesajul ramane ascuns si gol', () => {
  const audioEl = makeAudioMock();
  const expiredMsgEl = makeMsgMock();
  runWiring({ status: 'ready', accessExpired: false, audioEl, expiredMsgEl, t: { audio_link_expired: 'A expirat.', see_my_orders: 'Vezi comenzile mele' } });
  assert.equal(expiredMsgEl.style.display, undefined, 'inainte de eroare, display nu trebuie atins');
  assert.equal(expiredMsgEl.innerHTML, '', 'inainte de eroare, niciun text nu trebuie scris');
});

test('sandbox: dupa un eveniment "error" REAL pe <audio> (ex. resume-token expirat, /media/full respinge cererea) — mesajul devine vizibil, cu textul tradus + link catre /comenzile-mele.html', () => {
  const audioEl = makeAudioMock();
  const expiredMsgEl = makeMsgMock();
  const t = { audio_link_expired: 'Acest link de ascultare a expirat.', see_my_orders: 'Vezi comenzile mele' };
  runWiring({ status: 'ready', accessExpired: false, audioEl, expiredMsgEl, t });
  audioEl.__fireError();
  assert.equal(expiredMsgEl.style.display, '', 'mesajul trebuie facut vizibil dupa eroare');
  assert.equal(expiredMsgEl.innerHTML, 'Acest link de ascultare a expirat. <a href="/comenzile-mele.html">Vezi comenzile mele</a>');
});

test('sandbox: al doilea eveniment "error" (ex. un al doilea click pe play, dupa ce mesajul e deja afisat) nu arunca — listener-ul e { once: true }, deja verificat structural mai sus; aici verificam ca prima declansare nu lasa starea inconsistenta pentru un re-render ulterior', () => {
  const audioEl = makeAudioMock();
  const expiredMsgEl = makeMsgMock();
  const t = { audio_link_expired: 'A expirat.', see_my_orders: 'Vezi comenzile mele' };
  runWiring({ status: 'ready', accessExpired: false, audioEl, expiredMsgEl, t });
  audioEl.__fireError();
  assert.equal(expiredMsgEl.style.display, '');
  assert.match(expiredMsgEl.innerHTML, /A expirat\./);
});

test('sandbox: comanda NU e "ready" (ex. generation_failed/preview_ready) — wiring-ul nu se aplica deloc (querySelector nu e apelat, nimic de legat — sectiunea audio nici nu exista in acest caz)', () => {
  let queried = false;
  const resultsMock = { querySelector: () => { queried = true; return null; } };
  const block = extractErrorWiringBlock();
  const fn = new Function('o', 'accessExpired', 'results', 't', 'escapeHtml', block);
  fn({ status: 'generation_failed' }, false, resultsMock, {}, (s) => s);
  assert.equal(queried, false, 'pentru o comanda care nu e ready, nu trebuie cautat deloc elementul <audio>');
});

test('sandbox: acces expirat (accessExpired:true) pe o comanda altfel ready — wiring-ul nu se aplica (sectiunea audio nu exista, inlocuita de mesajul de acces expirat)', () => {
  let queried = false;
  const resultsMock = { querySelector: () => { queried = true; return null; } };
  const block = extractErrorWiringBlock();
  const fn = new Function('o', 'accessExpired', 'results', 't', 'escapeHtml', block);
  fn({ status: 'ready' }, true, resultsMock, {}, (s) => s);
  assert.equal(queried, false, 'accessExpired trebuie sa opreasca wiring-ul, la fel ca sectiunea audio, care nu mai e randata in acest caz');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa) — fixul nu a atins deloc server.js', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
