// public/comanda.html — UI de opt-out PECR soft opt-in (2026-09-25, corectie), la locul exact
// unde se colecteaza emailul (pasul 2). Verifica STATIC (acelasi tipar ca restul suitei pentru
// HTML): checkbox-ul exista, e neobligatoriu, complet separat de Analytics/Marketing, textul
// exista in toate cele 8 limbi, si e corect legat de collectPayload/saveDraft/loadDraft.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda.html'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

test('checkbox-ul "email-marketing-optout" exista, IMEDIAT dupa campul de email (pasul 2), tip checkbox', () => {
  const emailFieldIdx = html.indexOf('<input type="email" id="email"');
  assert.ok(emailFieldIdx !== -1);
  const nearby = html.slice(emailFieldIdx, emailFieldIdx + 1500);
  assert.match(nearby, /<input type="checkbox" id="email-marketing-optout"/);
  assert.match(nearby, /data-i18n="label_email_marketing_optout"/);
});

test('checkbox-ul NU e "required" si NU e "checked" implicit (soft opt-in: implicit eligibil, refuzul e o actiune explicita)', () => {
  const idx = html.indexOf('<input type="checkbox" id="email-marketing-optout"');
  const tag = html.slice(idx, html.indexOf('>', idx) + 1);
  assert.ok(!tag.includes('required'));
  assert.ok(!tag.includes('checked'));
});

test('checkbox-ul NU e mentionat in nicio functie validateStep — bifarea/nebifarea lui NU poate bloca trecerea la pasul urmator', () => {
  const idx = html.indexOf('function validateStep(');
  assert.ok(idx !== -1, 'validateStep trebuie sa existe');
  let depth = 0, i = html.indexOf('{', idx);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fn = html.slice(idx, i + 1);
  assert.ok(!fn.includes('email-marketing-optout'), 'validateStep nu trebuie sa verifice deloc acest checkbox');
});

test('checkbox-ul e COMPLET SEPARAT de Analytics/Marketing IN COD (JS) — id-ul lui nu apare in nicio functie/apel legat de NalunaAnalytics, consimtamant sau Pixel (mentiunile din comentariul HTML explicativ, care descrie tocmai aceasta separare, sunt acceptabile)', () => {
  const scriptStart = html.indexOf('<script>', html.indexOf('id="email-marketing-optout"'));
  const scriptEnd = html.indexOf('</script>', scriptStart);
  const jsSource = html.slice(scriptStart, scriptEnd);
  const occurrences = [...jsSource.matchAll(/.{80}email-marketing-optout.{80}/gs)];
  for (const [context] of occurrences) {
    assert.ok(!context.includes('NalunaAnalytics'), `context suspect (NalunaAnalytics): ${context}`);
    assert.ok(!/[Pp]ixel/.test(context), `context suspect (Pixel): ${context}`);
    assert.ok(!/consent/i.test(context), `context suspect (consent): ${context}`);
  }
});

// Textul EXACT asteptat per limba (autorul acestor traduceri) — verificare directa, mai fiabila
// decat o extragere regex generica peste blocuri de limba.
const EXPECTED_TEXT = {
  ro: 'Nu vreau emailuri de reamintire dacă nu finalizez comanda',
  en: "I don't want reminder emails if I don't complete my order",
  de: 'Ich möchte keine Erinnerungs-E-Mails, falls ich meine Bestellung nicht abschließe',
  es: 'No quiero recibir correos de recordatorio si no completo mi pedido',
  it: 'Non voglio email di promemoria se non completo il mio ordine',
  fr: "Je ne veux pas recevoir d'e-mails de rappel si je ne finalise pas ma commande",
  bg: 'Не искам напомнящи имейли, ако не завърша поръчката си',
  tr: 'Siparişimi tamamlamazsam hatırlatma e-postası almak istemiyorum'
};

for (const lang of LANGS) {
  test(`label_email_marketing_optout: traducerea "${lang}" e prezenta EXACT ca text, imediat langa cheia in sursa`, () => {
    assert.ok(html.includes(`label_email_marketing_optout: '${EXPECTED_TEXT[lang]}'`) || html.includes(`label_email_marketing_optout: "${EXPECTED_TEXT[lang]}"`), `textul pentru "${lang}" lipseste sau nu se potriveste exact`);
  });
}

test('exact 8 aparitii ale label_email_marketing_optout (una per limba), niciuna goala', () => {
  const matches = [...html.matchAll(/label_email_marketing_optout: (['"])((?:(?!\1)[^\\]|\\.)*)\1,/g)];
  assert.equal(matches.length, 8, `asteptate 8 traduceri, gasite ${matches.length}`);
  for (const m of matches) {
    assert.ok(m[2] && m[2].trim().length > 0, 'niciun text tradus nu trebuie sa fie gol');
  }
});

test('niciuna din cele 8 traduceri nu e identica cu varianta romana (fara fallback ascuns) — exceptie STRICT limba ro insasi', () => {
  const matches = [...html.matchAll(/label_email_marketing_optout: (['"])((?:(?!\1)[^\\]|\\.)*)\1,/g)].map((m) => m[2]);
  const [ro, ...rest] = matches;
  for (const text of rest) {
    assert.notEqual(text, ro, 'o traducere non-RO e identica cu RO — suspect de fallback ascuns/necompletat');
  }
});

test('collectPayload(): trimite emailMarketingOptOut STRICT ca boolean (.checked), langa campul email', () => {
  const idx = html.indexOf('function collectPayload() {');
  const end = html.indexOf('\n  }', idx);
  const fn = html.slice(idx, end);
  assert.match(fn, /emailMarketingOptOut: document\.getElementById\('email-marketing-optout'\)\.checked,/);
});

test('saveDraft(): salveaza emailMarketingOptOut in draft (persistat in localStorage, supravietuieste unui refresh de pagina)', () => {
  const idx = html.indexOf('function saveDraft() {');
  const end = html.indexOf('\n  }', idx);
  const fn = html.slice(idx, end);
  assert.match(fn, /emailMarketingOptOut: document\.getElementById\('email-marketing-optout'\)\.checked,/);
});

test('restaurarea draftului seteaza .checked din draft.emailMarketingOptOut, STRICT daca e boolean (typeof check, nu doar truthy)', () => {
  assert.match(html, /if \(typeof draft\.emailMarketingOptOut === 'boolean'\) document\.getElementById\('email-marketing-optout'\)\.checked = draft\.emailMarketingOptOut;/);
});
