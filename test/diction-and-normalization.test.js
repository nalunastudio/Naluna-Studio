// CERINTA 3 (2026-08-31, "pronuntie naturala in cele 8 limbi"): teste pentru functia centralizata
// de instructiuni de dictie + normalizarea sigura de text din lib/diction.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DICTION_INSTRUCTIONS, getDictionInstruction, normalizeSingingText, normalizePunctuationSafely } = require('../lib/diction.js');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

test('DICTION_INSTRUCTIONS: exista o intrare {full, short} pentru toate cele 8 limbi ale site-ului', () => {
  LANGS.forEach(lang => {
    assert.ok(DICTION_INSTRUCTIONS[lang], `lipseste instructiunea de dictie pentru "${lang}"`);
    assert.ok(DICTION_INSTRUCTIONS[lang].full.length > 20, `forma "full" pentru "${lang}" pare goala/prea scurta`);
    assert.ok(DICTION_INSTRUCTIONS[lang].short.length > 10, `forma "short" pentru "${lang}" pare goala/prea scurta`);
    assert.ok(DICTION_INSTRUCTIONS[lang].short.length < DICTION_INSTRUCTIONS[lang].full.length, `forma "short" trebuie sa fie mai compacta decat "full" pentru "${lang}"`);
  });
});

test('DICTION_INSTRUCTIONS: fiecare limba mentioneaza explicit legarea naturala/lipsa robotizarii — tema centrala a cerintei', () => {
  LANGS.forEach(lang => {
    const { full } = DICTION_INSTRUCTIONS[lang];
    assert.match(full, /robotic/i, `"${lang}" trebuie sa interzica explicit pronuntia robotica`);
    assert.match(full, /natur/i, `"${lang}" trebuie sa ceara explicit dictie/legare naturala`);
  });
});

test('DICTION_INSTRUCTIONS: fiecare limba interzice explicit prelungirea gresita a silabelor (cazul "miiii...e dor de tine")', () => {
  LANGS.forEach(lang => {
    const { full } = DICTION_INSTRUCTIONS[lang];
    assert.match(full, /stretch/i, `"${lang}" trebuie sa interzica explicit prelungirea gresita a unei silabe`);
  });
});

test('DICTION_INSTRUCTIONS: fiecare limba cere pastrarea pronuntiei naturale a numelor proprii', () => {
  LANGS.forEach(lang => {
    const { full } = DICTION_INSTRUCTIONS[lang];
    assert.match(full, /name/i, `"${lang}" trebuie sa mentioneze pronuntia numelor proprii`);
  });
});

test('DICTION_INSTRUCTIONS.ro: exemplul obligatoriu "mi-e" e mentionat explicit ca legatura naturala (forma "full", bogata)', () => {
  // CORECȚIE (2026-08-31, a doua rescriere — regresie reala de buget, vezi comentariul din
  // lib/diction.js): forma "short" a fost comprimata drastic (~45 caractere) ca sa incapa in
  // bugetul strans al buildPrompt() chiar si pentru comenzi normale — detaliul fonetic bogat
  // ("mi-e") ramane STRICT in forma "full" (camp `style`, buget generos, 1000 caractere).
  assert.match(DICTION_INSTRUCTIONS.ro.full, /mi-e/);
});

test('getDictionInstruction(): returneaza forma corecta (full/short) si cade pe engleza pentru un cod necunoscut', () => {
  assert.equal(getDictionInstruction('ro'), DICTION_INSTRUCTIONS.ro.full);
  assert.equal(getDictionInstruction('ro', 'short'), DICTION_INSTRUCTIONS.ro.short);
  assert.equal(getDictionInstruction('xx'), DICTION_INSTRUCTIONS.en.full);
  assert.equal(getDictionInstruction('xx', 'short'), DICTION_INSTRUCTIONS.en.short);
});

test('normalizeSingingText(): aplica NFC (diacritice descompuse -> punct de cod compus)', () => {
  const decomposed = 'a' + String.fromCharCode(0x0301); // "a" + accent combinator (NFD-style)
  const result = normalizeSingingText(decomposed);
  assert.equal(result, 'á'.normalize('NFC'));
  assert.equal(result.length, 1, 'forma NFC trebuie sa fie UN singur punct de cod pentru a-accent');
});

test('normalizeSingingText(): elimina caracterele invizibile (zero-width space/joiner, LRM/RLM, word joiner, BOM, soft hyphen)', () => {
  const invisibles = [0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF, 0x00AD];
  invisibles.forEach(code => {
    const input = 'Ma' + String.fromCharCode(code) + 'ria';
    assert.equal(normalizeSingingText(input), 'Maria', `codul invizibil 0x${code.toString(16)} trebuie eliminat`);
  });
});

test('normalizeSingingText(): elimina controale C0, dar PASTREAZA tab/newline/carriage-return (text pe mai multe randuri ramane valid)', () => {
  for (let code = 0; code < 0x20; code++) {
    if (code === 0x09 || code === 0x0A || code === 0x0D) continue;
    const input = 'a' + String.fromCharCode(code) + 'b';
    assert.equal(normalizeSingingText(input), 'ab', `controlul 0x${code.toString(16)} trebuie eliminat`);
  }
  assert.equal(normalizeSingingText('linia1\nlinia2'), 'linia1\nlinia2', 'newline-ul trebuie pastrat');
  assert.equal(normalizeSingingText('a\tb'), 'a\tb', 'tab-ul trebuie pastrat');
  assert.equal(normalizeSingingText('a\rb'), 'a\rb', 'carriage-return-ul trebuie pastrat');
});

test('normalizeSingingText(): corecteaza ș/ț vechi cu sedila (ş/ţ) la forma corecta cu virgula, ambele capitalizari', () => {
  assert.equal(normalizeSingingText('şi ţie'), 'și ție');
  assert.equal(normalizeSingingText('Ştefan'), 'Ștefan');
  assert.equal(normalizeSingingText('Ţara'), 'Țara');
});

test('normalizeSingingText(): NU rescrie fonetic numele proprii — un nume corect ramane byte-identic (in afara de cedilla/NFC/invizibile)', () => {
  const names = ['Alexandru', 'Ioana-Maria', 'Wilhelm', 'François', 'Zülal', 'Þórdís'];
  names.forEach(name => {
    assert.equal(normalizeSingingText(name), name.normalize('NFC'), `numele "${name}" nu trebuie alterat fonetic`);
  });
});

test('normalizePunctuationSafely(): reduce spatiile multiple si elimina spatiul dinaintea punctuatiei, fara sa atinga ghilimelele', () => {
  assert.equal(normalizePunctuationSafely('a    b'), 'a b');
  assert.equal(normalizePunctuationSafely('Salut , ce faci ? Bine !'), 'Salut, ce faci? Bine!');
  assert.equal(normalizePunctuationSafely('"citat direct"'), '"citat direct"');
});

test('normalizeSingingText(): text gol/non-string trece prin neschimbat (nu arunca eroare)', () => {
  assert.equal(normalizeSingingText(''), '');
  assert.equal(normalizeSingingText(null), null);
  assert.equal(normalizeSingingText(undefined), undefined);
  assert.equal(normalizeSingingText(42), 42);
});

// ===============================================================================================
// Seturi reprezentative per limba (contractii/diacritice/nume proprii) — verifica functional
// ca normalizarea nu strica textul REAL, pentru toate cele 8 limbi.
// ===============================================================================================
const REPRESENTATIVE_SAMPLES = {
  ro: 'Maria, mi-e dor de tine.',
  en: "I'm so glad you're here, Sarah.",
  de: 'Ich hab\'s dir gesagt, Björn.',
  es: '¿Cómo estás, José?',
  it: 'L\'amore è tutto, Giulia.',
  fr: "C'est l'amour, François.",
  bg: 'Здравей, Иван.',
  tr: 'Nasılsın, Zülal?'
};
Object.entries(REPRESENTATIVE_SAMPLES).forEach(([lang, sample]) => {
  test(`normalizeSingingText(): setul reprezentativ pentru "${lang}" ramane intact dupa normalizare`, () => {
    assert.equal(normalizeSingingText(sample), sample.normalize('NFC'));
  });
});

test('node --check lib/diction.js trece', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'diction.js')]));
});
