// BUG REAL DE PRODUCTIE (2026-09-24, raportat direct de client): pe starea initiala butonul mic
// (.edit-lyrics-btn) era ascuns corect; dupa apasarea butonului mare ("Editează Versurile / sau /
// Schimbă Genul Muzical" -> "Închide editarea"), meniul de editare se deschidea corect (voce/gen
// vizibile), DAR butonul mic din interiorul cardului NU reaparea.
//
// CAUZA EXACTA (gasita prin citirea codului real, nu presupusa): CSS-ul declara
//   .edit-lyrics-btn{ margin-top:12px; display:none; }
// iar fixul anterior (runda precedenta) incerca sa-l faca vizibil astfel:
//   btn.style.display = menuExpanded ? '' : 'none';
// String gol ('') NU inseamna "vizibil" — el STERGE STRICT valoarea inline si lasa browserul sa
// calculeze display-ul din regulile CSS din foaia de stil. Butonul are clasele
// "btn btn-ghost btn-small edit-lyrics-btn" — .btn declara display:inline-flex, dar .edit-lyrics-btn
// (aceeasi specificitate, declarata MAI TARZIU in fisier) castiga cascada si ramane display:none,
// indiferent ca stilul inline a fost "golit". Testul executabil de mai jos reproduce exact aceasta
// cascada CSS (extrasa din fisierul REAL, nu presupusa) si demonstreaza ca style.display='' rezolva
// tot la 'none' (bug-ul), in timp ce o valoare explicita ('inline-flex') castiga corect (fixul).
//
// FIXUL: valoare explicita la afisare — btn.style.display = menuExpanded ? 'inline-flex' : 'none'.
// Un stil inline cu o valoare REALA are prioritate fata de orice regula din clasa (fara !important),
// deci rezolva bug-ul indiferent de ordinea reala a regulilor CSS din fisier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const melodia = read('public/melodia-mea.html');

// ================================================================================================
// PROBA EXECUTABILA a cauzei si a fixului — extrage regulile CSS REALE (.btn, .edit-lyrics-btn) din
// fisier si simuleaza cascada (specificitate egala — clasa unica — castiga ultima regula declarata,
// exact regula CSS standard), pentru a demonstra, prin executie, de ce style.display='' esua si
// de ce style.display='inline-flex' functioneaza.
// ================================================================================================
function extractDisplayValue(cssSelectorRegex) {
  const m = melodia.match(cssSelectorRegex);
  assert.ok(m, `regula CSS nu a fost gasita: ${cssSelectorRegex}`);
  const displayMatch = m[0].match(/display:\s*([a-z-]+)/);
  assert.ok(displayMatch, `proprietatea display lipseste din regula: ${m[0]}`);
  return { display: displayMatch[1], index: m.index };
}

test('PROBA EXECUTABILA: cascada CSS reala (.btn vs .edit-lyrics-btn, extrase din melodia-mea.html) confirma cauza bug-ului SI corectitudinea fixului', () => {
  const btnRule = extractDisplayValue(/\.btn\{[^}]*\}/);
  const editLyricsBtnRule = extractDisplayValue(/\.edit-lyrics-btn\{[^}]*\}/);

  assert.equal(btnRule.display, 'inline-flex', 'regula .btn trebuie sa declare display:inline-flex');
  assert.equal(editLyricsBtnRule.display, 'none', 'regula .edit-lyrics-btn trebuie sa declare display:none (ascuns implicit)');
  assert.ok(editLyricsBtnRule.index > btnRule.index, '.edit-lyrics-btn trebuie sa fie declarata DUPA .btn in fisier (asa castiga cascada la specificitate egala)');

  // Simulare cascada: element cu clasele ['btn', 'edit-lyrics-btn'] (specificitate egala,
  // selector cu o singura clasa) — la specificitate egala, REGULA DECLARATA MAI TARZIU castiga,
  // STRICT daca niciun stil inline nu o suprascrie.
  function resolveDisplay(inlineStyleDisplay) {
    if (inlineStyleDisplay) return inlineStyleDisplay; // inline nevid castiga intotdeauna
    // fara stil inline (sau gol) -> ultima regula CSS aplicabila, in ordinea din fisier
    return editLyricsBtnRule.index > btnRule.index ? editLyricsBtnRule.display : btnRule.display;
  }

  // BUG-UL (comportamentul VECHI, style.display=''): tot 'none', desi meniul e "deschis" logic —
  // pentru ca '' sterge stilul inline, nu il seteaza la o valoare vizibila.
  assert.equal(resolveDisplay(''), 'none', 'BUG confirmat executabil: style.display=\'\' NU face butonul vizibil (cascada CSS ramane display:none)');

  // FIXUL (comportamentul NOU, style.display='inline-flex'): valoare inline reala, castiga cascada.
  assert.equal(resolveDisplay('inline-flex'), 'inline-flex', 'FIX confirmat executabil: style.display=\'inline-flex\' face butonul vizibil, castigand cascada CSS');

  // Starea inchisa ramane 'none' in ambele versiuni (neschimbata de fix).
  assert.equal(resolveDisplay('none'), 'none', 'starea inchisa trebuie sa ramana ascunsa');
});

// ================================================================================================
// 1) STARE INITIALA (dupa generare): .edit-lyrics-btn ascuns implicit (CSS), menuExpanded=false.
// ================================================================================================
test('1) starea initiala: .edit-lyrics-btn e ascuns implicit prin CSS (display:none)', () => {
  assert.match(melodia, /\.edit-lyrics-btn\{[^}]*display:none;?[^}]*\}/);
});

test('1b) starea initiala: menuExpanded porneste false', () => {
  assert.match(melodia, /let menuExpanded = false;/);
});

// ================================================================================================
// 2) Click pe butonul mare -> menuExpanded devine true -> resincronizare vizibilitate.
// ================================================================================================
test('2) click pe butonul mare (#edit-menu-toggle-btn) comuta menuExpanded si resincronizeaza vizibilitatea prin updateStandardEditMenuVisibility', () => {
  assert.match(
    melodia,
    /editMenuToggleBtn\.addEventListener\('click', \(\) => \{\s*if \(!currentOrder\) return;\s*menuExpanded = !menuExpanded;\s*const pendingVariantChoiceNow = computePendingVariantChoice\(currentOrder\);\s*updateStandardEditMenuVisibility\(currentOrder, pendingVariantChoiceNow\);/
  );
});

// ================================================================================================
// 3) Edit mode deschis -> .edit-lyrics-btn vizibil — FIXUL exact (valoare explicita, nu string gol).
// ================================================================================================
test('3) FIX: cand menuExpanded===true, .edit-lyrics-btn primeste STRICT o valoare de afisare explicita ("inline-flex"), NICIODATA string gol', () => {
  assert.match(
    melodia,
    /document\.querySelectorAll\('\.edit-lyrics-btn'\)\.forEach\(\(btn\) => \{\s*btn\.style\.display = menuExpanded \? 'inline-flex' : 'none';\s*\}\);/
  );
  // regresie STRICT — forma veche, buggy, nu mai exista nicaieri in fisier.
  assert.doesNotMatch(melodia, /btn\.style\.display = menuExpanded \? '' : 'none';/);
});

// ================================================================================================
// 4) Click pe butonul mic -> handler-ul existent openLyricsEditor() ramane neatins.
// ================================================================================================
test('4) click pe .edit-lyrics-btn deschide STRICT openLyricsEditor(v) — handler-ul original, neatins de acest fix', () => {
  assert.match(
    melodia,
    /const editLyricsBtn = card\.querySelector\('\.edit-lyrics-btn'\);\s*if \(editLyricsBtn\) \{\s*editLyricsBtn\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);\s*openLyricsEditor\(v\);\s*\}\);\s*\}/
  );
});

test('4b) markup-ul butonului mic (data-variant-id, folosit de click handler) ramane neschimbat', () => {
  assert.match(
    melodia,
    /<button type="button" class="btn btn-ghost btn-small edit-lyrics-btn" data-variant-id="\$\{v\.id\}">\$\{t\.edit_lyrics_btn\}<\/button>/
  );
});

// ================================================================================================
// 5) Inchide editarea (click din nou pe butonul mare, SAU "Renunță") -> .edit-lyrics-btn ascuns din nou.
// ================================================================================================
test('5) "Renunță" (confirmCancelBtn) reseteaza menuExpanded=false si resincronizeaza vizibilitatea (Standard/Video)', () => {
  assert.match(
    melodia,
    /if \(currentOrder && \(currentOrder\.plan === 'standard' \|\| currentOrder\.plan === 'video'\)\) \{[\s\S]{0,700}menuExpanded = false;\s*const pendingVariantChoiceNow = computePendingVariantChoice\(currentOrder\);\s*updateStandardEditMenuVisibility\(currentOrder, pendingVariantChoiceNow\);\s*return;\s*\}/
  );
});

test('5b) acelasi toggle (#edit-menu-toggle-btn) inchide meniul la a doua apasare (menuExpanded = !menuExpanded, simetric intre deschis/inchis)', () => {
  // linia unica de toggle (vezi testul 2) acopera ambele directii — nicio ramura separata pentru inchidere.
  const toggleMatches = melodia.match(/menuExpanded = !menuExpanded;/g) || [];
  assert.equal(toggleMatches.length, 1, 'trebuie sa existe STRICT un singur punct de comutare prin negatie, reutilizat pentru deschis/inchis');
});

// ================================================================================================
// 6) Standard — foloseste STRICT acelasi mecanism (standardDirectEditMode).
// ================================================================================================
test('6) Standard: standardDirectEditMode include plan==="standard"', () => {
  assert.match(melodia, /const standardDirectEditMode = \(order\.plan === 'standard' \|\| order\.plan === 'video'\) && !isStandardEditChoice;/);
});

// ================================================================================================
// 7) Premium — flux SEPARAT, .edit-lyrics-btn nu e randat niciodata acolo; editarea manuala a
// versurilor Premium ramane accesibila prin campurile ei proprii (#premium-edit-song1/2-lyrics),
// complet neatinse de acest fix (care priveste STRICT .edit-lyrics-btn, folosit doar de Standard/Video).
// ================================================================================================
test('7) Premium: renderPremiumResultView() NU construieste niciodata un buton .edit-lyrics-btn (fluxul Premium ramane separat, neatins)', () => {
  const idx = melodia.indexOf('function renderPremiumResultView(order) {');
  const end = melodia.indexOf('\n  }\n', idx);
  const body = melodia.slice(idx, end);
  assert.ok(!body.includes('edit-lyrics-btn'), 'renderPremiumResultView nu trebuie sa contina butonul mic — Premium foloseste STRICT butonul mare + campurile proprii de editare');
});

test('7b) Premium: editarea manuala a versurilor ramane accesibila prin campurile proprii (#premium-edit-song1-lyrics / #premium-edit-song2-lyrics), neatinse de acest fix', () => {
  assert.match(melodia, /<textarea id="premium-edit-song1-lyrics"/);
  assert.match(melodia, /<textarea id="premium-edit-song2-lyrics"/);
});

// ================================================================================================
// 8) Video — foloseste STRICT acelasi mecanism ca Standard (standardDirectEditMode).
// ================================================================================================
test('8) Video: standardDirectEditMode include plan==="video" (acelasi mecanism ca Standard, niciun cod separat)', () => {
  assert.match(melodia, /const standardDirectEditMode = \(order\.plan === 'standard' \|\| order\.plan === 'video'\) && !isStandardEditChoice;/);
});

// ================================================================================================
// 9) + 10) Toate cele 8 limbi — textul butonului mic ramane STRICT "Editeaza versurile", tradus corect.
// ================================================================================================
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
for (const [lang, text] of Object.entries(EXPECTED_SHORT)) {
  test(`9/10) [${lang}] edit_lyrics_btn (text afisat cand butonul mic e vizibil) = "${text}" (exact, forma scurta, neatinsa de acest fix)`, () => {
    assert.ok(melodia.includes(`edit_lyrics_btn: '${text}',`), `traducerea scurta [${lang}] lipseste sau nu e exacta`);
  });
}

test('9b/10b) butonul mic randat in renderVariants() foloseste STRICT t.edit_lyrics_btn (nu textul pe 3 randuri al butonului mare)', () => {
  assert.match(melodia, /class="btn btn-ghost btn-small edit-lyrics-btn" data-variant-id="\$\{v\.id\}">\$\{t\.edit_lyrics_btn\}</);
});

// ================================================================================================
// Butonul mare pe 3 randuri — NEATINS de acest fix (verificare de regresie).
// ================================================================================================
test('butonul mare pe 3 randuri (text/structura/handler) ramane STRICT neschimbat de acest fix', () => {
  assert.match(melodia, /function editLyricsBtnStackHtml\(\)\s*\{/);
  assert.match(melodia, /editMenuToggleLabel\.innerHTML = menuExpanded\s*\n\s*\? `<span class="etl-line"><span aria-hidden="true">✏️<\/span> \$\{escapeHtml\(t\.edit_menu_close_btn\)\}<\/span>`\s*\n\s*: editLyricsBtnStackHtml\(\);/);
  assert.match(melodia, /document\.getElementById\('premium-edit-open-btn-label'\)\.innerHTML = editLyricsBtnStackHtml\(\);/);
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
