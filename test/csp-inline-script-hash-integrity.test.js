// REGRESIE (2026-09-27) — INCIDENT PRODUCTIE: butonul "Continua" de pe comanda.html nu facea
// NIMIC in productie. Cauza REALA (gasita prin reproducere directa intr-un browser, NU
// presupusa): 8 caractere '\r' izolate (NEURMATE de '\n' — deci NU un CRLF normal), cate unul in
// fiecare bloc de traducere din public/comanda.html, ramase probabil dintr-o editare anterioara.
//
// lib/csp.js calculeaza hash-ul SHA-256 al fiecarui <script> inline STRICT din bytes-ii bruti ai
// fisierului de pe disc (fs.readFileSync(..., 'utf8')), o singura data, la pornirea serverului.
// Browserul insa, la parsare HTML (specificatia HTML5, "preprocessing the input stream"),
// normalizeaza ORICE \r\n SI orice \r izolat la \n INAINTE de a construi DOM-ul — si verificarea
// CSP se face pe acest text normalizat, nu pe bytes-ii bruti. Cele doua hash-uri nu mai coincid,
// iar browserul blocheaza STRICT si SILENTIOS *intregul* <script> inline (niciun eveniment CSP nu
// era vizibil in consola prin uneltele de debugging folosite) — nu doar butonul Continua, ci
// LITERALMENTE orice interactivitate de pe pagina.
//
// IMPORTANT (gasit prin testare, nu presupus) — de ce testul normalizeaza intai \r\n -> \n inainte
// de a compara: acest repo are core.autocrlf=true; pe Windows, checkout-ul local converteste
// automat \n -> \r\n pentru linii normale (asta e complet inofensiv si NU exista pe serverul de
// productie, care face checkout pe Linux, fara nicio conversie). Verificat direct: local,
// public/melodia-mea.html, se-compune.html, se-creeaza-video.html si succes.html apar cu \r\n pe
// FIECARE linie (conversie automata Windows) — dar blob-ul lor commis in git (`git show HEAD:...`)
// e 100% LF, fara nicio anomalie. Fara pasul de normalizare CRLF->LF de mai jos, testul le-ar
// raporta FALS ca sparte (fals-pozitiv cauzat de checkout-ul local al ACESTEI masini, nu de
// continutul real livrat in productie). Un \r IZOLAT (neurmat de \n) insa nu e NICIODATA introdus
// de autocrlf sau de checkout-ul normal — autocrlf doar imperecheaza \n cu un \r inaintea lui,
// niciodata nu introduce un \r fara \n dupa el — deci daca mai ramane un \r izolat DUPA ce am
// eliminat toate perechile \r\n normale, e garantat un defect real de sursa (exact ca cele 8 din
// comanda.html), niciodata un artefact de checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function hashInlineScripts(html) {
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const content = m[1];
    if (!content.trim()) continue;
    hashes.push(crypto.createHash('sha256').update(content, 'utf8').digest('base64'));
  }
  return hashes;
}

// Reprezinta continutul "de sursa" (ce e commis in git / ce serveste productia pe Linux): elimina
// STRICT perechile normale \r\n (artefact benign de checkout Windows), lasand neatins orice \r
// izolat ramas.
function stripBenignCrlf(html) {
  return html.replace(/\r\n/g, '\n');
}

// Exact algoritmul de "preprocessing the input stream" din specificatia HTML5, aplicat DUPA
// eliminarea perechilor CRLF benigne: orice \r ramas (izolat) -> \n.
function htmlNormalizeNewlines(html) {
  return stripBenignCrlf(html).replace(/\r/g, '\n');
}

const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

test('lib/csp.js: exista cel putin o pagina publica cu <script> inline (altfel acest test nu verifica nimic real)', () => {
  const anyWithScript = htmlFiles.some((f) => hashInlineScripts(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')).length > 0);
  assert.ok(anyWithScript);
});

htmlFiles.forEach((file) => {
  test(`CSP hash-integrity: public/${file} — hash-ul de sursa (dupa eliminarea CRLF-urilor benigne de checkout) coincide cu hash-ul normalizat HTML5 (ce calculeaza browserul) pentru fiecare <script> inline — deci CSP nu poate bloca silentios scriptul in productie`, () => {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const sourceHashes = hashInlineScripts(stripBenignCrlf(raw));
    const browserHashes = hashInlineScripts(htmlNormalizeNewlines(raw));
    assert.deepEqual(
      sourceHashes,
      browserHashes,
      `public/${file} contine caractere '\\r' izolate (neurmate de '\\n') care fac ca hash-ul CSP sa NU coincida cu ce ar calcula un browser real — asta ar bloca silentios scriptul in productie, exact incidentul de pe comanda.html`
    );
  });

  test(`public/${file} nu contine niciun caracter '\\r' izolat (neurmat de '\\n', deci NU parte dintr-un CRLF normal de checkout) — sursa exacta a incidentului CSP de mai sus`, () => {
    const raw = stripBenignCrlf(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
    let loneCrCount = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\r' && raw[i + 1] !== '\n') loneCrCount++;
    }
    assert.equal(loneCrCount, 0, `public/${file} are ${loneCrCount} caracter(e) '\\r' izolat(e)`);
  });
});
