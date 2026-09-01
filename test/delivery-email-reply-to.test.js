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

test('server.js sendDeliveryEmail(): from ramane comenzi@nalunastudio.com (RESEND_FROM_EMAIL), neschimbat', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  assert.match(fn, /from:\s*process\.env\.RESEND_FROM_EMAIL/, 'FROM nu mai citeste RESEND_FROM_EMAIL — schimbare neceruta');
});

test('credits.js: alertele interne de credite (prag procentual si prag fix) NU au reply_to — sunt STRICT interne, catre admin', () => {
  const sends = [...credits.matchAll(/fetch\('https:\/\/api\.resend\.com\/emails'[\s\S]*?\}\)/g)];
  assert.ok(sends.length >= 2, 'ar trebui sa existe cele doua apeluri de alerta cunoscute');
  for (const m of sends) {
    assert.ok(!/reply_to/.test(m[0]), 'alertele interne nu trebuie sa capete reply_to — nu sunt corespondenta cu clientul');
  }
});
