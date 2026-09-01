// Deliverability (2026-09-01, dupa un test real marcat Spam de Yahoo): Resend Deliverability
// Insights semnaleaza explicit lipsa unei variante text/plain drept un motiv real de suspiciune
// pentru Gmail/Yahoo/Outlook. Acest fisier verifica STRUCTURAL ca toate cele 3 apeluri catre
// Resend (emailul de livrare + cele 2 alerte interne) includ acum un camp `text`, generat
// automat din html (niciodata scris manual per limba, ca sa nu poata diverge in timp), si ca
// htmlToPlainText() produce text corect si lizibil pentru sabloanele reale folosite de Naluna.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { htmlToPlainText } = require('../lib/email-text');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('htmlToPlainText: converteste <a href> in "text: url", pastreaza continutul <strong>, elimina tag-urile', () => {
  const html = '<p>Salut,</p><p>Cântecul tău personalizat pentru <strong>Maria</strong> e gata.</p><p><a href="https://nalunastudio.com/media/full/123?token=abc">Descarcă melodia</a></p><p>— NALUNA</p>';
  const text = htmlToPlainText(html);
  assert.ok(text.includes('Cântecul tău personalizat pentru Maria e gata.'));
  assert.ok(text.includes('Descarcă melodia: https://nalunastudio.com/media/full/123?token=abc'));
  assert.ok(text.includes('— NALUNA'));
  assert.ok(!/<[a-z]/i.test(text), 'nu trebuie sa mai ramana niciun tag HTML in text');
});

test('htmlToPlainText: decodeaza entitatile HTML introduse de escapeHtmlForEmail', () => {
  const text = htmlToPlainText('<p>Pentru &quot;Mama &amp; Tata&quot; &lt;3</p>');
  assert.ok(text.includes('Pentru "Mama & Tata" <3'));
});

test('htmlToPlainText: converteste liste <ul><li> in linii cu prefix "- "', () => {
  const text = htmlToPlainText('<ul><li>Balanta: 100</li><li>Prag: 50</li></ul>');
  assert.ok(text.includes('- Balanta: 100'));
  assert.ok(text.includes('- Prag: 50'));
});

test('htmlToPlainText: nu produce randuri goale in exces (max un rand gol intre paragrafe)', () => {
  const text = htmlToPlainText('<p>Unu</p><p>Doi</p><p>Trei</p>');
  assert.ok(!/\n{3,}/.test(text), 'nu trebuie sa existe mai mult de un rand gol consecutiv');
});

test('server.js sendDeliveryEmail(): trimite un camp text, generat din htmlToPlainText(template.html)', () => {
  const server = read('server.js');
  const start = server.indexOf('async function sendDeliveryEmail(order) {');
  assert.notEqual(start, -1);
  let depth = 1, i = start + 'async function sendDeliveryEmail(order) {'.length;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fn = server.slice(start, i + 1);
  assert.match(fn, /text:\s*htmlToPlainText\(template\.html\)/);
  assert.ok(server.includes("require('./lib/email-text')"), 'server.js trebuie sa importe htmlToPlainText din lib/email-text');
});

test('credits.js: ambele alerte interne trimit acum un camp text', () => {
  const credits = read('credits.js');
  assert.ok(credits.includes("require('./lib/email-text')"));
  const sends = [...credits.matchAll(/fetch\('https:\/\/api\.resend\.com\/emails'[\s\S]*?\}\)/g)];
  assert.equal(sends.length, 2);
  for (const m of sends) {
    assert.match(m[0], /text:/, 'fiecare alerta interna trebuie sa aiba un camp text');
  }
});
