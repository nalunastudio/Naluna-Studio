// lib/recovery-emails/templates.js — cele 8 limbi (RO/EN/DE/ES/IT/FR/BG/TR) x 3 tipuri de
// notificare. Verifica exhaustiv: nicio limba valida NU cade pe fallback RO (cerinta explicita —
// "Nu lasa fallback-uri romanesti vizibile unui client care a comandat in alta limba"), linkul de
// acces e corect, unsubscribe apare STRICT la tipurile 2/3, escaparea HTML a numelui.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LANGS, resolveLang, buildOrderLink, buildUnsubscribeLink,
  buildPreviewReadyEmail, buildPreviewRecoveryEmail, buildCheckoutRecoveryEmail, buildNotificationEmail
} = require('../lib/recovery-emails/templates');

const ALL_TYPES = ['preview_ready', 'preview_recovery', 'checkout_recovery'];
const BUILDER_BY_TYPE = {
  preview_ready: buildPreviewReadyEmail,
  preview_recovery: buildPreviewRecoveryEmail,
  checkout_recovery: buildCheckoutRecoveryEmail
};

test('LANGS: exact cele 8 limbi suportate de comenzi (ALLOWED_LANGS din server.js), lowercase', () => {
  assert.deepEqual(LANGS, ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr']);
});

test('resolveLang: limba necunoscuta/corupta cade pe "ro" — orice limba din LANGS ramane neschimbata', () => {
  assert.equal(resolveLang('xx'), 'ro');
  assert.equal(resolveLang(null), 'ro');
  for (const l of LANGS) assert.equal(resolveLang(l), l);
});

const baseParams = { domain: 'https://nalunastudio.com', orderId: 'order-1', accessToken: 'tok123', recipientName: 'Ana', email: 'ana@exemplu.com', unsubscribeToken: 'unsub-abc' };

for (const type of ALL_TYPES) {
  for (const lang of LANGS) {
    test(`${type}/${lang}: subject si html exista, NU e identic cu varianta RO (fara fallback ascuns) — exceptie STRICT lang==='ro'`, () => {
      const result = BUILDER_BY_TYPE[type]({ ...baseParams, lang });
      assert.ok(result.subject && result.subject.length > 0, `subject lipseste pentru ${type}/${lang}`);
      assert.ok(result.html && result.html.length > 0, `html lipseste pentru ${type}/${lang}`);
      assert.ok(result.text && result.text.length > 0, `text (plain) lipseste pentru ${type}/${lang}`);
      if (lang !== 'ro') {
        const roResult = BUILDER_BY_TYPE[type]({ ...baseParams, lang: 'ro' });
        assert.notEqual(result.subject, roResult.subject, `${type}/${lang}: subject e IDENTIC cu RO — suspect de fallback ascuns`);
      }
    });
  }
}

test('buildOrderLink: format identic cu linkurile deja trimise de sendDeliveryEmail (melodia-mea.html?id=...&token=...)', () => {
  const link = buildOrderLink('https://nalunastudio.com', 'abc-123', 'tok-xyz');
  assert.equal(link, 'https://nalunastudio.com/melodia-mea.html?id=abc-123&token=tok-xyz');
});

test('buildUnsubscribeLink: contine emailul si tokenul, encodate', () => {
  const link = buildUnsubscribeLink('https://nalunastudio.com', 'a b@x.com', 'tok+/=');
  assert.match(link, /^https:\/\/nalunastudio\.com\/api\/email-marketing\/unsubscribe\?email=/);
  assert.ok(link.includes(encodeURIComponent('a b@x.com')));
  assert.ok(link.includes(encodeURIComponent('tok+/=')));
});

test('preview_ready: NU contine link de unsubscribe (operational, nu marketing)', () => {
  const result = buildPreviewReadyEmail({ ...baseParams, lang: 'en' });
  assert.ok(!result.html.includes('/api/email-marketing/unsubscribe'), 'preview_ready nu trebuie sa aiba link de unsubscribe');
});

test('preview_recovery si checkout_recovery: CONTIN link de unsubscribe, pentru toate cele 8 limbi', () => {
  for (const type of ['preview_recovery', 'checkout_recovery']) {
    for (const lang of LANGS) {
      const result = BUILDER_BY_TYPE[type]({ ...baseParams, lang });
      assert.ok(result.html.includes('/api/email-marketing/unsubscribe'), `${type}/${lang} trebuie sa contina link de unsubscribe`);
    }
  }
});

test('preview_recovery: formularea e NEUTRA — nu contine nicio presupunere gen "nu ti-a placut"', () => {
  const roResult = buildPreviewRecoveryEmail({ ...baseParams, lang: 'ro' });
  assert.ok(!/nu ți-a plăcut|nu ti-a placut/i.test(roResult.subject + roResult.html));
});

test('recipientName e escapat HTML (previne injectie prin campul liber "Pentru")', () => {
  const result = buildPreviewReadyEmail({ ...baseParams, lang: 'en', recipientName: '<script>alert(1)</script>' });
  assert.ok(!result.html.includes('<script>alert(1)</script>'));
  assert.ok(result.html.includes('&lt;script&gt;'));
});

test('buildNotificationEmail: dispecerizeaza corect pe cele 3 tipuri, arunca pentru un tip necunoscut', () => {
  for (const type of ALL_TYPES) {
    const result = buildNotificationEmail(type, { ...baseParams, lang: 'ro' });
    assert.ok(result.subject);
  }
  assert.throws(() => buildNotificationEmail('nonexistent_type', baseParams), /necunoscut/);
});

test('orderId si accessToken sunt URI-encodate in link (comanda cu caractere speciale in token nu rupe URL-ul)', () => {
  const result = buildPreviewReadyEmail({ ...baseParams, lang: 'ro', orderId: 'a/b', accessToken: 'tok&x=1' });
  assert.ok(result.html.includes(encodeURIComponent('a/b')));
  assert.ok(result.html.includes(encodeURIComponent('tok&x=1')));
});
