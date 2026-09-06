// CERINTA 1 (2026-08-31, "schimbarea etichetei Te iubesc, pe note"): verifica STRICT eticheta
// vizibila noua in toate cele 8 limbi, ca identificatorul intern `declaratie` (payload, comenzi
// vechi, drafturi) sa ramana NESCHIMBAT, si ca descrierea/ordinea cardurilor nu au fost atinse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda.html'), 'utf8');

test('comanda.html: identificatorul intern "declaratie" ramane neschimbat (data-theme + ALL_OCCASIONS_ORDERED)', () => {
  assert.match(html, /data-theme="declaratie"/);
  assert.match(html, /ALL_OCCASIONS_ORDERED = \[[^\]]*'declaratie'[^\]]*\]/);
});

test('comanda.html: cardul static (markup RO implicit) foloseste noua eticheta "Te iubesc", nu vechea "Te iubesc, pe note"', () => {
  assert.match(html, /data-i18n="theme_declaratie_name">Te iubesc</);
  assert.ok(!html.includes('Te iubesc, pe note'), 'vechea eticheta nu mai trebuie sa apara nicaieri');
});

test('comanda.html: descrierea "Cand mesajul nu ajunge" (RO) a fost inlocuita explicit (2026-09-06, ceruta de utilizator — "nu exprima clar ideea de iubire") cu "Spune-i ce simti" si echivalentele ei naturale in toate cele 8 limbi; nimic altceva de pe card (nume, ordine, layout) nu a fost atins', () => {
  const oldDescriptions = [
    'Când mesajul nu ajunge', 'When words are not enough.', 'Wenn Worte nicht reichen.',
    'Cuando las palabras no bastan.', 'Quando le parole non bastano.', 'Quand les mots ne suffisent pas.',
    'Когато думите не стигат.', 'Kelimeler yetmediğinde.'
  ];
  oldDescriptions.forEach(desc => {
    assert.ok(!html.includes(desc), `vechea descriere "${desc}" nu mai trebuie sa apara nicaieri`);
  });
  const newDescriptions = [
    'Spune-i ce simți', 'Tell them how you feel.', 'Sag, was du fühlst.',
    'Dile lo que sientes.', 'Dì cosa provi.', 'Dis-lui ce que tu ressens.',
    'Кажи какво чувстваш.', 'Ona ne hissettiğini söyle.'
  ];
  newDescriptions.forEach(desc => {
    assert.ok(html.includes(`theme_declaratie_desc: '${desc}'`) || html.includes(`data-i18n="theme_declaratie_desc">${desc}<`),
      `noua descriere "${desc}" trebuie sa fie prezenta`);
  });
});

const EXPECTED_LABELS = {
  ro: 'Te iubesc',
  en: 'I love you',
  de: 'Ich liebe dich',
  es: 'Te quiero',
  it: 'Ti amo',
  fr: "Je t'aime",
  bg: 'Обичам те',
  tr: 'Seni seviyorum'
};

Object.entries(EXPECTED_LABELS).forEach(([lang, label]) => {
  test(`comanda.html: eticheta noua "${label}" (${lang}) e prezenta o singura data, ca valoare theme_declaratie_name`, () => {
    const escaped = label.replace(/'/g, "\\'");
    const pattern = `theme_declaratie_name: '${escaped}',`;
    const occurrences = html.split(pattern).length - 1;
    assert.equal(occurrences, 1, `asteptat exact 1 aparitie pentru "${pattern}", gasit ${occurrences}`);
  });
});

test('comanda.html: ramane sintactic valid dupa aceasta corectie', () => {
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length > 0);
  scriptMatches.forEach(m => {
    assert.doesNotThrow(() => new Function(m[1]));
  });
});
