// PRIVACY POLICY — dezvaluire analytics (2026-09-18, corectie ceruta explicit dupa aprobarea
// FAZA 2). Inainte, privacy.html afirma "We do not use advertising or analytics cookies, and we
// do not run any tracking scripts on this site" — FALS fata de implementarea reala (GA4 +
// funnel_events + visitor_id + UTM/fbclid, toate consent-gated). Acest fisier verifica STRUCTURAL
// noua sectiune "Cookies and analytics" — acopera exact punctele cerute explicit, fara sa inventeze
// nimic (nicio perioada de retentie inventata, niciun Meta Pixel/CAPI nemetionat in cod).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const privacy = read('public/privacy.html');

test('privacy.html: afirmatia FALSA veche ("we do not use advertising or analytics cookies... no tracking scripts") NU mai exista', () => {
  assert.doesNotMatch(privacy, /do not use advertising or analytics cookies/i);
  assert.doesNotMatch(privacy, /do not run any tracking scripts/i);
});

test('privacy.html: exista o sectiune dedicata "Cookies and analytics"', () => {
  assert.match(privacy, /<h2>2\. Cookies and analytics<\/h2>/);
});

test('privacy.html: mentioneaza explicit Google Analytics 4 (GA4) ca instrument folosit', () => {
  assert.match(privacy, /Google Analytics 4.*GA4/);
});

test('privacy.html: descrie explicit ca analytics ruleaza STRICT dupa consimtamant (banner), si ca fara consimtamant nu se colecteaza nimic din aceasta sectiune', () => {
  assert.match(privacy, /only use analytics cookies.*if you give explicit consent/i);
  assert.match(privacy, /If you do not consent, none of this loads/i);
});

test('privacy.html: mentioneaza identificatorul anonim (visitor_id) — "anonymous identifier", stocat in browser, nelegat de nume/email', () => {
  assert.match(privacy, /anonymous identifier/i);
  assert.match(privacy, /not linked to your name or email/i);
});

test('privacy.html: descrie funnel analytics intern, SEPARAT de Google — masurarea pasilor din procesul de comanda', () => {
  assert.match(privacy, /our own first-party, in-house funnel measurement, entirely separate from Google/i);
  assert.match(privacy, /started the form, or reached checkout/i);
});

test('privacy.html: mentioneaza atribuirea UTM/campanie (utm_source, utm_campaign, fbclid) — STRICT ca parametri URL, NICIODATA Meta Pixel/CAPI', () => {
  assert.match(privacy, /utm_source/);
  assert.match(privacy, /utm_campaign/);
  assert.match(privacy, /fbclid/);
  assert.doesNotMatch(privacy, /Meta Pixel/i);
  assert.doesNotMatch(privacy, /Conversions API/i);
  assert.doesNotMatch(privacy, /\bCAPI\b/);
});

test('privacy.html: declara explicit scopul — masurare/imbunatatire site si intelegerea canalelor de marketing, NICIODATA advertising sau profil cross-site', () => {
  assert.match(privacy, /measure and improve how our site and ordering process work/i);
  assert.match(privacy, /never for advertising, and never to build a profile/i);
});

test('privacy.html: declara explicit ca NU se foloseste fingerprinting', () => {
  assert.match(privacy, /never be? combined with fingerprinting|never combined with fingerprinting/i);
});

test('privacy.html: declara explicit ca datele de analytics NU includ nume/email/telefon/poveste/continut din formular', () => {
  assert.match(privacy, /Never includes your name, email address, phone number, the story or details you wrote for your song/i);
});

// ACTUALIZAT (2026-09-18, runda 3): retentia de 180 de zile pentru funnel_events a fost
// implementata REAL (job zilnic, vezi server.js#purgeStaleFunnelEvents si
// test/funnel-events-retention.test.js) — textul trebuie acum sa declare exact aceasta cifra,
// nu sa mai spuna ca "nu exista un termen fix". Verificat impotriva constantei reale din
// server.js, acelasi tipar ca verificarea CONTENT_RETENTION_DAYS de mai jos in
// test/legal-consent-and-pages.test.js — niciodata un numar inventat, necorelat cu codul.
test('privacy.html: perioada de retentie pentru analytics (180 de zile) corespunde EXACT constantei reale din server.js (FUNNEL_EVENTS_RETENTION_DAYS) — nu un numar inventat', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const section = privacy.slice(privacy.indexOf('Anonymous funnel-analytics events'), privacy.indexOf('Security and error logs'));
  assert.match(section, /kept for up to <strong>180 days<\/strong>/);
  assert.match(server, /const FUNNEL_EVENTS_RETENTION_DAYS = 180;/, 'perioada declarata public trebuie sa corespunda EXACT constantei reale din server.js');
});

test('privacy.html: textul clarifica explicit ca cele 180 de zile NU se aplica atributiei UTM/fbclid stocate pe order (care urmeaza retentia comenzii, nu pe cea a evenimentelor)', () => {
  const section = privacy.slice(privacy.indexOf('Anonymous funnel-analytics events'), privacy.indexOf('Security and error logs'));
  assert.match(section, /does not apply to your order record/i);
  assert.match(section, /follow your order's own retention/i);
});

test('privacy.html: sectiunea de retentie NU sugereaza ca orders/payment/accounting au aceeasi retentie de 180 de zile ca funnel analytics — cifrele 30/5/6 (ani/zile ale comenzii) raman distincte, si "180" nu apare NICIUNDE langa ele', () => {
  assert.match(privacy, /30 days from delivery/);
  assert.match(privacy, /kept for 6 years/);
  assert.match(privacy, /kept for 5 years from the 31 January/);
  // "180" trebuie sa apara STRICT in interiorul bullet-ului de analytics (si in mentiunea din
  // "Cookies and analytics" de mai sus, daca exista) — niciodata langa bullet-urile de continut
  // comanda/consimtamant/contabilitate, unde ar sugera gresit aceeasi retentie.
  const orderContentBullet = privacy.slice(privacy.indexOf('Your order content'), privacy.indexOf('Records of the consent'));
  const consentBullet = privacy.slice(privacy.indexOf('Records of the consent'), privacy.indexOf('Payment and order records'));
  const accountingBullet = privacy.slice(privacy.indexOf('Payment and order records'), privacy.indexOf('Anonymous funnel-analytics events'));
  for (const [name, bullet] of [['order content', orderContentBullet], ['consent', consentBullet], ['accounting', accountingBullet]]) {
    assert.doesNotMatch(bullet, /180/, `bullet-ul "${name}" nu trebuie sa mentioneze 180 de zile`);
  }
});

test('privacy.html: mecanismul de retragere a consimtamantului ("Cookie settings") e descris explicit, inclusiv ce se opreste (GA4) si ce se sterge (identificatorul local)', () => {
  assert.match(privacy, /withdraw your consent at any time from the small "Cookie settings" link/i);
  assert.match(privacy, /Withdrawing stops all further analytics activity immediately, including Google Analytics/i);
  assert.match(privacy, /removes the anonymous identifier stored in your browser/i);
});

test('privacy.html: sectiunile raman numerotate secvential 1-9, fara goluri/duplicate, dupa insertia noii sectiuni', () => {
  const numbers = [...privacy.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('privacy.html: NU contine nicio referinta la "AI"/"artificial intelligence" (constrangere existenta, verificata din nou dupa editare)', () => {
  assert.ok(!/\bAI\b/.test(privacy));
  assert.doesNotMatch(privacy, /artificial intelligence/i);
});

test('privacy.html: ramane sintactic un HTML valid (fara tag-uri neinchise create de editare) — verificare minima: numarul de <h2> deschise = numarul de </h2>, la fel pentru <ul>/<li>', () => {
  const countTag = (tag) => (privacy.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
  const countCloseTag = (tag) => (privacy.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  assert.equal(countTag('h2'), countCloseTag('h2'));
  assert.equal(countTag('ul'), countCloseTag('ul'));
  assert.equal(countTag('li'), countCloseTag('li'));
  assert.equal(countTag('p'), countCloseTag('p'));
});
