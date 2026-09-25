// public/privacy.html — corectia PECR soft opt-in (2026-09-25): verifica STATIC ca politica NU mai
// pretinde ca "legitimate interests" singur justifica emailurile de recovery/marketing, ca separa
// explicit emailul operational de cel de recovery, si ca descrie corect mecanismul de soft opt-in
// (optiune clara la colectare + unsubscribe in fiecare mesaj). Plus: auditul clasificarii emailului
// operational (lib/recovery-emails/templates.js) — STRICT acces, fara reduceri/upsell/indemnuri
// promotionale, in toate cele 8 limbi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const privacy = fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8');

test('privacy.html: mentioneaza explicit PECR (Privacy and Electronic Communications Regulations)', () => {
  assert.match(privacy, /PECR/);
});

test('privacy.html: afirma EXPLICIT ca legitimate interest NU e, prin el insusi, suficient pentru emailurile de recovery/marketing', () => {
  assert.match(privacy, /is\s*<strong>not, by itself, a sufficient basis<\/strong>\s*to email you for this purpose/);
});

test('privacy.html: descrie mecanismul soft opt-in — optiune clara la colectarea emailului SI unsubscribe in fiecare mesaj', () => {
  assert.match(privacy, /clear and simple opportunity to refuse/);
  assert.match(privacy, /both when we first collect your email and in every message afterwards/);
});

test('privacy.html: checkbox-ul descris ca NEBIFAT implicit si NICIODATA obligatoriu pentru comanda', () => {
  assert.match(privacy, /unticked by default, never required to place your order/);
});

test('privacy.html: separa explicit emailul OPERATIONAL de cel de RECOVERY/marketing, in doi <li> distincti', () => {
  assert.match(privacy, /<li><strong>Operational email — "your song is ready":<\/strong>/);
  assert.match(privacy, /<li><strong>Recovery\/reminder email \(direct marketing\):<\/strong>/);
});

test('privacy.html: emailul operational e descris STRICT ca acces — "no discounts, no upsells, no promotional content"', () => {
  assert.match(privacy, /no discounts, no upsells, no promotional content/);
});

test('privacy.html: forward-only — orice comanda dinainte de introducerea checkbox-ului NU primeste NICIODATA reminder emails', () => {
  assert.match(privacy, /you were never shown that choice, so you do not receive reminder emails from us at all, regardless of anything else — it is never applied retroactively/);
});

test('privacy.html: sectiunea "Why we process your data" NU mai afirma legitimate interest ca UNICA baza pentru remindere — foloseste "together with" (nu "based on legitimate interest" izolat)', () => {
  const idx = privacy.indexOf('<h2>3. Why we process your data</h2>');
  const end = privacy.indexOf('</ul>', idx);
  const section = privacy.slice(idx, end);
  assert.match(section, /together with.*not instead of.*the clear opportunity to refuse/s);
});

// ================================================================================================
// AUDIT — clasificarea emailului operational (cerinta 5): STRICT "melodia e gata" + link de acces,
// fara reduceri/upsell/indemnuri promotionale suplimentare, in toate cele 8 limbi.
// ================================================================================================
const { buildPreviewReadyEmail, LANGS } = require('../lib/recovery-emails/templates');

const PROMO_PATTERNS = [
  /discount/i, /reducer/i, /off\b.*%/i, /\d+%\s*off/i, /coupon/i, /cupon/i,
  /upgrade/i, /upsell/i, /buy now/i, /cumpără acum/i, /limited time/i, /ofertă/i, /offer\b/i,
  /special price/i, /preț special/i, /save \d+/i
];

for (const lang of LANGS) {
  test(`AUDIT preview_ready/${lang}: emailul operational nu contine niciun termen promotional/upsell/reducere`, () => {
    const result = buildPreviewReadyEmail({ lang, domain: 'https://nalunastudio.com', orderId: 'o1', accessToken: 'tok', recipientName: 'Ana' });
    const fullText = result.subject + ' ' + result.html;
    for (const pattern of PROMO_PATTERNS) {
      assert.ok(!pattern.test(fullText), `${lang}: gasit termen promotional suspect (${pattern}) in emailul operational`);
    }
  });
}

test('AUDIT preview_ready: NU contine link de unsubscribe (confirmat — operational, nu marketing)', () => {
  for (const lang of LANGS) {
    const result = buildPreviewReadyEmail({ lang, domain: 'https://nalunastudio.com', orderId: 'o1', accessToken: 'tok' });
    assert.ok(!result.html.includes('unsubscribe'));
  }
});
