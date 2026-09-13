// Prioritatea 1 (Legal/Contact, 2026-09-01): emailul de livrare catre client trebuie sa aiba
// Reply-To: contact@nalunastudio.com, ca raspunsul clientului sa ajunga la adresa publica de
// suport, nu la adresa tehnica de trimitere automata (comenzi@nalunastudio.com, nemonitorizata
// pentru raspunsuri). Alertele interne din credits.js raman STRICT interne (catre admin), fara
// niciun motiv sa aiba Reply-To catre client — verificat explicit ca raman neschimbate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

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

const server = read('server.js');
const credits = read('credits.js');

test('server.js sendDeliveryEmail(): trimite reply_to explicit catre contact@nalunastudio.com', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  assert.match(fn, /reply_to:\s*'contact@nalunastudio\.com'/, 'lipseste reply_to explicit catre contact@nalunastudio.com');
});

test('server.js sendDeliveryEmail(): from foloseste in continuare STRICT adresa din RESEND_FROM_EMAIL (aceeasi configurare Resend, neschimbata)', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  assert.match(fn, /const rawFromAddress = process\.env\.RESEND_FROM_EMAIL \|\| 'onboarding@resend\.dev';/, 'adresa trebuie sa vina in continuare STRICT din RESEND_FROM_EMAIL — schimbare neceruta a configurarii Resend');
  assert.match(fn, /from:\s*fromWithDisplayName/);
});

// CERINTA (2026-09-13, runda 3): numele afisat "Naluna Studio" — aceeasi adresa/configurare
// Resend, doar numele vizibil clientului in "From" se schimba.
test('server.js sendDeliveryEmail(): numele expeditorului afisat e "Naluna Studio", pastrand adresa neschimbata (format "Naluna Studio <adresa>")', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  assert.match(fn, /const fromWithDisplayName = rawFromAddress\.includes\('<'\) \? rawFromAddress : `Naluna Studio <\$\{rawFromAddress\}>`;/);
});

test('credits.js: ambele alerte interne (prag procentual si prag fix) folosesc acelasi nume de expeditor "Naluna Studio", pastrand RESEND_FROM_EMAIL neschimbat', () => {
  const occurrences = (credits.match(/rawFromAddress\w*\.includes\('<'\) \? rawFromAddress\w* : `Naluna Studio <\$\{rawFromAddress\w*\}>`;/g) || []).length;
  assert.equal(occurrences, 2, `trebuie sa existe exact 2 alerte cu numele de expeditor corectat, gasite ${occurrences}`);
  const envRefs = (credits.match(/process\.env\.RESEND_FROM_EMAIL \|\| 'onboarding@resend\.dev'/g) || []).length;
  assert.equal(envRefs, 2, 'ambele alerte trebuie sa citeasca in continuare STRICT RESEND_FROM_EMAIL, fara nicio schimbare de configurare');
});

test('credits.js: alertele interne de credite (prag procentual si prag fix) NU au reply_to — sunt STRICT interne, catre admin', () => {
  const sends = [...credits.matchAll(/fetch\('https:\/\/api\.resend\.com\/emails'[\s\S]*?\}\)/g)];
  assert.ok(sends.length >= 2, 'ar trebui sa existe cele doua apeluri de alerta cunoscute');
  for (const m of sends) {
    assert.ok(!/reply_to/.test(m[0]), 'alertele interne nu trebuie sa capete reply_to — nu sunt corespondenta cu clientul');
  }
});

// FUNCTIONAL: executie REALA a logicii de wrapping (nu doar text-matching) — aceeasi expresie
// folosita in ambele fisiere (server.js + credits.js x2).
function computeFromWithDisplayName(rawFromAddress) {
  return rawFromAddress.includes('<') ? rawFromAddress : `Naluna Studio <${rawFromAddress}>`;
}

test('FUNCTIONAL: adresa simpla (fara nume) primeste "Naluna Studio <adresa>"', () => {
  assert.equal(computeFromWithDisplayName('comenzi@nalunastudio.com'), 'Naluna Studio <comenzi@nalunastudio.com>');
});

test('FUNCTIONAL: fallback-ul implicit (RESEND_FROM_EMAIL nesetat) primeste tot numele "Naluna Studio"', () => {
  assert.equal(computeFromWithDisplayName('onboarding@resend.dev'), 'Naluna Studio <onboarding@resend.dev>');
});

test('FUNCTIONAL: daca variabila de mediu contine deja un nume explicit ("Nume <adresa>"), nu e dublata/suprascrisa', () => {
  assert.equal(computeFromWithDisplayName('Altceva <comenzi@nalunastudio.com>'), 'Altceva <comenzi@nalunastudio.com>');
});

test('server.js si credits.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'credits.js')]));
});
