// AUDIT (2026-09-25) — selectorul de limba din header (public/index.html) ajungea sa se randeze
// pe mobil ca STRICT o sageata (fara steag/cod vizibile). Cauza demonstrata (vezi raportul catre
// user, verificat live intr-un browser real, la 320/360/375/390/414/430/860/1080px, in toate cele
// 8 limbi): regula generica `input, select, textarea{ width:100% }` (destinata unui formular care
// NU exista pe aceasta pagina) se aplica accidental si peste #lang-select, iar in nav (flex, fara
// protectie flex-shrink), selectorul se comprima sub presiunea CTA-ului lung pe ecrane inguste.
//
// Verificare STATICA (acelasi tipar ca restul suitei pentru fisiere HTML statice — sursa citita
// ca text, nicio randare reala jsdom/browser in acest fisier; verificarea vizuala reala a fost
// facuta separat, live, intr-un Chrome real, inaintea acestui commit).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const FLAGS = { ro: '🇷🇴', en: '🇬🇧', de: '🇩🇪', es: '🇪🇸', it: '🇮🇹', fr: '🇫🇷', bg: '🇧🇬', tr: '🇹🇷' };

// Extrage un bloc {...} prin numarare de acolade (nu primul "}" gasit — comentariile din acest
// fisier chiar contin acolade literale, ca extrase de cod, care ar inchide prematur o cautare
// naiva cu indexOf). `signature` trebuie sa se termine chiar cu acolada de deschidere. `fromIndex`
// (implicit 0) — OBLIGATORIU cand `signature` NU e unic in fisier (ex. "@media (max-width: 860px){"
// apare de 3 ori) — altfel indexOf gaseste mereu PRIMA aparitie, niciodata cea intentionata.
function extractBlock(source, signature, fromIndex = 0) {
  const idx = source.indexOf(signature, fromIndex);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

test('CAUZA: regula generica "input, select, textarea{ width:100% }" ramane in fisier (nu a fost stearsa — poate fi legitima pentru alte pagini/sabloane), dar NU mai are ultimul cuvant asupra selectorului de limba', () => {
  assert.match(html, /input, select, textarea\{\s*\n?\s*width:100%;/);
});

test('FIX (cauza radacina): .lang-select are width:auto — anuleaza EXPLICIT width:100% mostenit de la regula generica de mai sus, pentru elementul select-ului insusi', () => {
  const rule = extractBlock(html, '.lang-select{');
  assert.match(rule, /width:auto;/, 'width:auto trebuie sa fie declarat EXPLICIT in regula .lang-select, ca sa castige fata de regula generica select{width:100%} (ambele au specificitate diferita, dar fara aceasta declaratie width:100% ar castiga implicit, fiind singura care seteaza width)');
});

test('FIX (protectie flex): .lang-switch (div-ul care e flex item DIRECT in nav, nu select-ul) are flex-shrink:0 — selectorul nu mai poate fi comprimat de flexbox sub presiune de spatiu, indiferent de CTA/logo', () => {
  assert.ok(html.includes('.lang-switch{'), '.lang-switch trebuie sa aiba propria regula CSS dedicata (nu doar stil inline)');
  const rule = extractBlock(html, '.lang-switch{');
  assert.match(rule, /flex-shrink:0;/);
});

test('FIX (protectie logo): .logo are de asemenea flex-shrink:0 — logo-ul nu poate fi comprimat/taiat pentru a face loc altor elemente din nav', () => {
  const rule = extractBlock(html, '.logo{');
  assert.match(rule, /flex-shrink:0;/);
});

// Fisierul are MAI MULTE blocuri "@media (max-width: 860px){...}" separate (pricing, testimonial
// grid, si blocul principal al paginii — hero/nav/lang-switch/CTA/bara sticky). Gasim STRICT
// blocul principal, ancorat pe un continut unic al lui (.nav-links{ display:none; }) — extragem
// FIECARE bloc media prin numarare de acolade si pastram STRICT pe cel al carui continut chiar
// contine ancora (nu doar "cel mai apropiat inainte", care poate fi un bloc mic, nelegat, ce se
// inchide inainte sa ajunga la ancora).
function extractMainMobileMediaBlock() {
  const signature = '@media (max-width: 860px){';
  let searchFrom = 0;
  while (true) {
    const mediaStart = html.indexOf(signature, searchFrom);
    assert.ok(mediaStart !== -1, 'nu am gasit blocul media principal (.nav-links{display:none} trebuie sa fie continut de unul din blocurile @media (max-width:860px))');
    const mediaBlock = extractBlock(html, signature, mediaStart);
    if (mediaBlock.includes('.nav-links{ display:none; }')) {
      return { mediaStart, mediaBlock };
    }
    searchFrom = mediaStart + signature.length;
  }
}

test('FIX (spatiu eliberat pe mobil): CTA-ul redundant din nav (.btn-ghost, deja duplicat de .mobile-sticky-cta) e ascuns STRICT in interiorul @media (max-width:860px) — niciodata global', () => {
  const { mediaStart, mediaBlock } = extractMainMobileMediaBlock();
  assert.match(mediaBlock, /nav \.btn-ghost\{ display:none; \}/, 'ascunderea CTA-ului trebuie sa fie STRICT in interiorul media query-ului mobil');

  // In afara blocului media (desktop), NU trebuie sa existe nicio regula globala care ascunde
  // CTA-ul — desktop-ul trebuie sa il pastreze vizibil intotdeauna.
  const outsideMedia = html.slice(0, mediaStart) + html.slice(mediaStart + mediaBlock.length);
  assert.doesNotMatch(outsideMedia, /nav \.btn-ghost\{ display:none; \}/);
});

test('toate cele 8 limbi: #lang-select are EXACT 8 <option>, in ordinea RO/EN/DE/ES/IT/FR/BG/TR, fiecare cu STRICT formatul [steag] [cod]', () => {
  const selectStart = html.indexOf('<select id="lang-select"');
  const selectEnd = html.indexOf('</select>', selectStart);
  const selectBlock = html.slice(selectStart, selectEnd);
  const optionMatches = [...selectBlock.matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)];
  assert.equal(optionMatches.length, 8, `asteptate 8 optiuni, gasite ${optionMatches.length}`);
  optionMatches.forEach(([, value, label], i) => {
    assert.equal(value, ALLOWED_LANGS[i], `optiunea ${i} trebuie sa fie "${ALLOWED_LANGS[i]}", gasit "${value}"`);
    assert.ok(label.includes(FLAGS[value]), `optiunea "${value}" trebuie sa contina steagul ${FLAGS[value]}`);
    assert.ok(label.includes(value.toUpperCase()), `optiunea "${value}" trebuie sa contina codul de limba in majuscule`);
  });
});

test('#lang-select: niciun atribut "hidden"/"disabled" pe vreo optiune — toate cele 8 raman accesibile in dropdown', () => {
  const selectStart = html.indexOf('<select id="lang-select"');
  const selectEnd = html.indexOf('</select>', selectStart);
  const selectBlock = html.slice(selectStart, selectEnd);
  assert.ok(!selectBlock.includes('hidden'));
  assert.ok(!selectBlock.includes('disabled'));
});

// ================================================================================================
// FAZA 4 — bara sticky mobila: deficit real de padding-bottom, demonstrat prin masurare directa
// (getBoundingClientRect) intr-un Chrome real — bara (~114px, FARA safe-area) depasea vechiul
// body{padding-bottom:84px}, riscand sa acopere ultimii ~30-64px de continut real la scroll jos.
// ================================================================================================

test('FIX bara sticky: body{padding-bottom} creste la calc(120px + env(safe-area-inset-bottom)) — acopera inaltimea REALA masurata a barei (~114px fara safe-area) cu marja, si creste ODATA cu safe-area, ca bara insasi', () => {
  const idx = html.indexOf('body{ padding-bottom:');
  assert.ok(idx !== -1);
  const end = html.indexOf('}', idx);
  const rule = html.slice(idx, end + 1);
  assert.match(rule, /padding-bottom:calc\(120px \+ env\(safe-area-inset-bottom\)\);/);
});

test('bara sticky (.mobile-sticky-cta) isi pastreaza padding-ul propriu cu safe-area, NESCHIMBAT de aceasta corectie', () => {
  assert.match(html, /padding:12px 16px calc\(12px \+ env\(safe-area-inset-bottom\)\);/);
});

test('body{padding-bottom} e STRICT in interiorul @media (max-width:860px) — desktop-ul (fara bara sticky) nu primeste padding-bottom suplimentar inutil', () => {
  const { mediaBlock } = extractMainMobileMediaBlock();
  assert.match(mediaBlock, /body\{ padding-bottom:calc\(120px \+ env\(safe-area-inset-bottom\)\); \}/);
});

// ================================================================================================
// Sintaxa si izolare.
// ================================================================================================

test('index.html: scriptul inline ramane sintactic valid', () => {
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length > 0);
  for (const [, code] of scriptMatches) {
    const tmpFile = path.join(require('node:os').tmpdir(), `index-inline-script-check-${Date.now()}.js`);
    fs.writeFileSync(tmpFile, code);
    try {
      execFileSync(process.execPath, ['--check', tmpFile]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }
});

test('izolare: niciun alt fisier HTML din public/ nu contine #lang-select — selectorul de limba ramane STRICT pe index.html, corectia nu s-a extins accidental in alte pagini', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
  for (const f of files) {
    const content = fs.readFileSync(path.join(publicDir, f), 'utf8');
    assert.ok(!content.includes('id="lang-select"'), `${f} nu ar trebui sa contina selectorul de limba`);
  }
});
