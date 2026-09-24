// BUTON DE EDITARE — istoric: (2026-09-22) textul a devenit "Editează versurile sau schimbă genul
// muzical" pe toate cele 3 aparitii ale cheii edit_lyrics_btn (CTA mic per-varianta, toggle-ul
// Standard/Video, butonul mare Premium). REVIZUIT STRICT (2026-09-24, cerinta explicita, dupa
// verificarea fluxului real): CTA-ul mic (.edit-lyrics-btn) si butonul mare NU fac acelasi lucru —
// mic = openLyricsEditor() (editare LIBERA a textului versurilor, salvare directa, FARA regenerare
// si FARA schimbare de gen); mare = #edit-menu-fields / #premium-edit-view (schimbare voce/gen +
// feedback -> regenerare). Nu mai sunt fuzionate sub aceeasi eticheta:
//  - edit_lyrics_btn (text SCURT, revenit la forma dinainte de 2026-09-22) — STRICT pentru CTA-ul
//    mic, vizibil DOAR cat timp meniul mare e deschis (nu mai apare pe prima stare, dupa generare).
//  - edit_lyrics_btn_line1/2/3 (chei noi) — STRICT pentru butonul mare, randat pe 3 randuri
//    centrate (creionul ramane pe randul 1), folosite de editLyricsBtnStackHtml().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const melodia = read('public/melodia-mea.html');

const EXPECTED_SHORT = {
  ro: 'Editează versurile',
  en: 'Edit the lyrics',
  de: 'Text bearbeiten',
  es: 'Editar la letra',
  it: 'Modifica il testo',
  fr: 'Modifier les paroles',
  bg: 'Редактирай текста',
  tr: 'Sözleri düzenle'
};

const EXPECTED_LINES = {
  ro: ['Editează Versurile', 'sau', 'Schimbă Genul Muzical'],
  en: ['Edit the lyrics', 'or', 'Change the music genre'],
  de: ['Text bearbeiten', 'oder', 'Musikgenre ändern'],
  es: ['Editar la letra', 'o', 'Cambiar el género musical'],
  it: ['Modifica il testo', 'o', 'Cambia il genere musicale'],
  fr: ['Modifier les paroles', 'ou', 'Changer le genre musical'],
  bg: ['Редактирай текста', 'или', 'Смени музикалния жанр'],
  tr: ['Sözleri düzenle', 'veya', 'Müzik türünü değiştir']
};

// ================================================================================================
// 1) edit_lyrics_btn (CTA MIC) — text scurt, exact, in toate cele 8 limbi.
// ================================================================================================
for (const [lang, text] of Object.entries(EXPECTED_SHORT)) {
  test(`[${lang}] edit_lyrics_btn (CTA mic) = "${text}" (exact, forma scurta)`, () => {
    assert.ok(
      melodia.includes(`edit_lyrics_btn: '${text}',`),
      `traducerea scurta [${lang}] lipseste sau nu e exacta`
    );
  });
}

test('EXACT 8 aparitii ale cheii edit_lyrics_btn in dictionarul de traduceri — una per limba, fara duplicate', () => {
  const matches = melodia.match(/edit_lyrics_btn: '[^']+',/g) || [];
  assert.equal(matches.length, 8, `trebuie sa existe STRICT 8 traduceri, gasite ${matches.length}`);
});

// ================================================================================================
// 2) edit_lyrics_btn_line1/2/3 (BUTONUL MARE, 3 randuri) — text exact, in toate cele 8 limbi.
// ================================================================================================
for (const [lang, [line1, line2, line3]] of Object.entries(EXPECTED_LINES)) {
  test(`[${lang}] butonul mare pe 3 randuri: line1="${line1}", line2="${line2}", line3="${line3}" (exact)`, () => {
    assert.ok(melodia.includes(`edit_lyrics_btn_line1: '${line1}',`), `[${lang}] line1 lipseste sau nu e exact`);
    assert.ok(melodia.includes(`edit_lyrics_btn_line2: '${line2}',`), `[${lang}] line2 lipseste sau nu e exact`);
    assert.ok(melodia.includes(`edit_lyrics_btn_line3: '${line3}',`), `[${lang}] line3 lipseste sau nu e exact`);
  });
}

for (const key of ['edit_lyrics_btn_line1', 'edit_lyrics_btn_line2', 'edit_lyrics_btn_line3']) {
  test(`EXACT 8 aparitii ale cheii ${key} — una per limba, fara duplicate`, () => {
    const matches = melodia.match(new RegExp(`${key}: '[^']+',`, 'g')) || [];
    assert.equal(matches.length, 8, `trebuie sa existe STRICT 8 traduceri pentru ${key}, gasite ${matches.length}`);
  });
}

test('nicio traducere de linie nu contine <br> sau alt markup HTML in text — layout-ul e STRICT in HTML/JS, traducerile raman text simplu', () => {
  for (const lang of Object.keys(EXPECTED_LINES)) {
    for (const key of ['edit_lyrics_btn_line1', 'edit_lyrics_btn_line2', 'edit_lyrics_btn_line3']) {
      const re = new RegExp(`${key}: '([^']*)',`);
      // cautam O SINGURA aparitie relevanta per limba nu e direct posibil fara a delimita blocul
      // de limba — verificam in schimb GLOBAL ca niciuna dintre valorile extrase nu contine '<'.
      const matches = melodia.match(new RegExp(`${key}: '([^']*)',`, 'g')) || [];
      for (const m of matches) {
        assert.ok(!m.includes('<'), `${key} nu trebuie sa contina markup HTML: ${m}`);
      }
    }
  }
});

// ================================================================================================
// 3) CTA-ul mic (.edit-lyrics-btn) — randat STRICT in renderVariants() (Standard/Video), ascuns
// implicit (CSS), vizibil DOAR cat timp meniul mare e deschis (menuExpanded). Functionalitatea
// (openLyricsEditor) ramane NEATINSA.
// ================================================================================================
test('CSS: .edit-lyrics-btn e ascuns implicit (display:none) — nu mai apare pe prima stare, dupa generare', () => {
  assert.match(melodia, /\.edit-lyrics-btn\{[^}]*display:none;?[^}]*\}/);
});

test('Standard/Video (renderVariants, per-varianta): markup-ul butonului mic ramane STRICT neschimbat (inclusiv data-variant-id, folosit de click handler) — foloseste t.edit_lyrics_btn (forma scurta)', () => {
  assert.match(
    melodia,
    /<button type="button" class="btn btn-ghost btn-small edit-lyrics-btn" data-variant-id="\$\{v\.id\}">\$\{t\.edit_lyrics_btn\}<\/button>/,
    'markup-ul butonului mic trebuie sa ramana neschimbat'
  );
});

test('updateStandardEditMenuVisibility(): toate .edit-lyrics-btn devin vizibile STRICT cand menuExpanded===true, ascunse altfel (FIX 2026-09-24: valoare explicita "inline-flex", NU string gol — vezi test/edit-lyrics-btn-visibility-toggle-fix.test.js pentru cauza exacta si verificarea executabila)', () => {
  assert.match(
    melodia,
    /document\.querySelectorAll\('\.edit-lyrics-btn'\)\.forEach\(\(btn\) => \{\s*btn\.style\.display = menuExpanded \? 'inline-flex' : 'none';\s*\}\);/
  );
});

test('click pe CTA-ul mic deschide STRICT openLyricsEditor (functionalitatea originala, neatinsa)', () => {
  assert.match(melodia, /e\.target\.closest\('\.edit-lyrics-btn'\)/);
  assert.match(melodia, /editLyricsBtn\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);\s*openLyricsEditor\(v\);\s*\}\);/);
});

test('dupa salvarea unei editari de versuri (editorSaveBtn), vizibilitatea CTA-ului mic e resincronizata (updateStandardEditMenuVisibility) — ramane vizibil daca meniul mare era deja deschis', () => {
  assert.match(
    melodia,
    /renderVariants\(currentOrder\);\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*updateStandardEditMenuVisibility\(currentOrder, computePendingVariantChoice\(currentOrder\)\);\s*closeLyricsEditor\(\);/
  );
});

// ================================================================================================
// 4) Butonul mare (Standard/Video: #edit-menu-toggle-btn; Premium: #premium-edit-open-btn) —
// pe 3 randuri STRICT in starea "inchis"/"deschide editorul"; creionul ramane STRICT pe randul 1,
// nu se adauga un al doilea icon. Functionalitatea (handler-ele de click/deschidere) NEATINSA.
// ================================================================================================
test('markup: #edit-menu-toggle-btn si #premium-edit-open-btn folosesc STRICT un singur container-stiva pentru eticheta (fara span de icon separat in HTML static — creionul e construit dinamic, pe randul 1)', () => {
  assert.match(melodia, /<button type="button" id="edit-menu-toggle-btn" class="btn-toggle-orange"[^>]*>\s*<span class="edit-toggle-label-stack" id="edit-menu-toggle-label"><\/span>\s*<\/button>/);
  assert.match(melodia, /<button type="button" class="btn-toggle-orange" id="premium-edit-open-btn"[^>]*>\s*<span class="edit-toggle-label-stack" id="premium-edit-open-btn-label"><\/span>\s*<\/button>/);
});

test('editLyricsBtnStackHtml(): helper unic, refolosit de ambele butoane mari, construieste 3 randuri (creion STRICT pe randul 1, din t.edit_lyrics_btn_line1/2/3)', () => {
  assert.match(melodia, /function editLyricsBtnStackHtml\(\)\s*\{/);
  assert.match(melodia, /aria-hidden="true">✏️<\/span> \$\{escapeHtml\(t\.edit_lyrics_btn_line1\)\}/);
  assert.match(melodia, /escapeHtml\(t\.edit_lyrics_btn_line2\)/);
  assert.match(melodia, /escapeHtml\(t\.edit_lyrics_btn_line3\)/);
});

test('Standard/Video: editMenuToggleLabel foloseste editLyricsBtnStackHtml() cand meniul e inchis, si textul de inchidere (neschimbat) cand e deschis', () => {
  assert.match(
    melodia,
    /editMenuToggleLabel\.innerHTML = menuExpanded\s*\n\s*\? `<span class="etl-line"><span aria-hidden="true">✏️<\/span> \$\{escapeHtml\(t\.edit_menu_close_btn\)\}<\/span>`\s*\n\s*: editLyricsBtnStackHtml\(\);/
  );
});

test('Premium: premium-edit-open-btn-label foloseste STRICT editLyricsBtnStackHtml()', () => {
  assert.match(melodia, /document\.getElementById\('premium-edit-open-btn-label'\)\.innerHTML = editLyricsBtnStackHtml\(\);/);
});

test('Premium: functia de deschidere a editarii (premiumEditChoiceOpen) ramane neschimbata ca nume/comportament', () => {
  assert.match(melodia, /premiumEditChoiceOpen/);
});

test('server.js: POST /api/orders/:orderId/regenerate accepta in continuare schimbarea genului (functionalitatea din spatele butonului mare, neatinsa de aceasta corectie)', () => {
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
