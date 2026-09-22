// BUTON "Editează versurile" -> "Editează versurile sau schimbă genul muzical" (2026-09-22) —
// cerinta explicita: STRICT textul/label-ul butonului se schimba, in toate cele 8 limbi, oriunde
// e folosit (Standard, Premium, Video) — functionalitatea/destinatia butonului raman neatinse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const melodia = read('public/melodia-mea.html');

const EXPECTED_TEXT = {
  ro: 'Editează versurile sau schimbă genul muzical',
  en: 'Edit the lyrics or change the music genre',
  de: 'Text bearbeiten oder Musikgenre ändern',
  es: 'Editar la letra o cambiar el género musical',
  it: 'Modifica il testo o cambia il genere musicale',
  fr: 'Modifier les paroles ou changer le genre musical',
  bg: 'Редактирай текста или смени музикалния жанр',
  tr: 'Sözleri düzenle veya müzik türünü değiştir'
};

// ================================================================================================
// 1) Textul exact, in toate cele 8 limbi — o singura cheie de traducere (edit_lyrics_btn),
// reutilizata peste tot (Standard/Video, Premium, meniul de editare).
// ================================================================================================
for (const [lang, text] of Object.entries(EXPECTED_TEXT)) {
  test(`[${lang}] edit_lyrics_btn = "${text}" (exact)`, () => {
    assert.ok(
      melodia.includes(`edit_lyrics_btn: '${text}',`),
      `traducerea [${lang}] lipseste sau nu e exacta`
    );
  });
}

test('EXACT 8 aparitii ale cheii edit_lyrics_btn in dictionarul de traduceri — una per limba, fara duplicate', () => {
  const matches = melodia.match(/edit_lyrics_btn: '[^']+',/g) || [];
  assert.equal(matches.length, 8, `trebuie sa existe STRICT 8 traduceri, gasite ${matches.length}`);
});

test('niciuna dintre cele 8 traduceri nu mai contine STRICT vechiul text scurt (fara "sau schimba genul")', () => {
  const OLD_TEXT = {
    ro: 'Editează versurile', en: 'Edit the lyrics', de: 'Text bearbeiten', es: 'Editar la letra',
    it: 'Modifica il testo', fr: 'Modifier les paroles', bg: 'Редактирай текста', tr: 'Sözleri düzenle'
  };
  for (const [lang, oldText] of Object.entries(OLD_TEXT)) {
    assert.ok(
      !melodia.includes(`edit_lyrics_btn: '${oldText}',`),
      `[${lang}] vechiul text scurt nu mai trebuie sa existe ca valoare exacta a cheii`
    );
  }
});

// ================================================================================================
// 2) Oriunde e folosita cheia (Standard/Video, meniul de editare, Premium) — 3 puncte de folosire,
// toate neschimbate structural (STRICT eticheta s-a schimbat, prin valoarea centralizata a cheii).
// ================================================================================================
test('Standard/Video (renderVariants, per-varianta): butonul foloseste STRICT t.edit_lyrics_btn, cu data-variant-id neschimbat', () => {
  assert.match(
    melodia,
    /<button type="button" class="btn btn-ghost btn-small edit-lyrics-btn" data-variant-id="\$\{v\.id\}">\$\{t\.edit_lyrics_btn\}<\/button>/,
    'markup-ul butonului (inclusiv data-variant-id, folosit de click handler) trebuie sa ramana neschimbat'
  );
});

test('meniul de editare (toggle): eticheta foloseste STRICT t.edit_lyrics_btn cand meniul e inchis', () => {
  assert.match(melodia, /editMenuToggleLabel\.textContent = menuExpanded \? t\.edit_menu_close_btn : t\.edit_lyrics_btn;/);
});

test('Premium: butonul de deschidere a editarii foloseste STRICT t.edit_lyrics_btn', () => {
  assert.match(melodia, /document\.getElementById\('premium-edit-open-btn-label'\)\.textContent = t\.edit_lyrics_btn;/);
});

// ================================================================================================
// 3) Functionalitatea butonului (destinatie/logica de editare) ramane NEATINSA — verificam ca
// handler-ele de click/deschidere a editorului nu au fost modificate de aceasta corectie.
// ================================================================================================
test('click pe cardul de varianta deschide editorul STRICT prin .edit-lyrics-btn (handler neschimbat)', () => {
  assert.match(melodia, /e\.target\.closest\('\.edit-lyrics-btn'\)/);
});

test('Premium: functia de deschidere a editarii (premiumEditChoiceOpen) ramane neschimbata ca nume/comportament', () => {
  assert.match(melodia, /premiumEditChoiceOpen/);
});

test('server.js: POST /api/orders/:orderId/regenerate accepta in continuare schimbarea genului (functionalitatea din spatele butonului, neatinsa de aceasta corectie)', () => {
  const server = read('server.js');
  assert.ok(server.includes('const requestedGenre = typeof req.body?.genre'), 'regenerate trebuie sa citeasca in continuare genre din body');
});

test('melodia-mea.html ramane sintactic valid', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const fs = require('fs');
    const html = fs.readFileSync(${JSON.stringify(path.join(__dirname, '..', 'public', 'melodia-mea.html'))}, 'utf8');
    const start = html.indexOf('<script>');
    const end = html.lastIndexOf('</script>');
    const inline = html.slice(start + '<script>'.length, end);
    new Function(inline);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script]));
});
