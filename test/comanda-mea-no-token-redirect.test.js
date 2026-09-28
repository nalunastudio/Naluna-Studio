// PROBLEMA 2 (2026-09-29, audit "pagina cu cod de acces care nu exista" — comentariu TikTok real,
// "dar nu primesc codul pe e-mail, dece oare"): comanda-mea.html afisa, fara ?token= in URL, un
// formular "Introdu codul de acces primit pe email" care nu poate functiona NICIODATA pentru un
// client real — niciun email Naluna nu afiseaza vreodata accessToken-ul ca text vizibil/copiabil,
// el e mereu embedat STRICT intr-un link (<a href>) care completeaza si cauta automat campul.
//
// RUNDA 2 (cerinta explicita, "NU vreau sa mai existe NICIUN scenariu in care clientului i se cere
// manual codul de acces primit pe email"): formularul manual (camp #token + buton Cauta) a fost
// ELIMINAT COMPLET, nu doar ocolit prin redirect. Acum:
//  - token valid in URL -> comportamentul actual ramane (valideaza, deschide comanda);
//  - fara token -> redirect catre /comenzile-mele.html (runda 1, neschimbat);
//  - token invalid/expirat/404/eroare de retea -> mesaj clar + CTA catre /comenzile-mele.html —
//    NICIODATA o cerere de reintroducere manuala a unui "cod".
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const html = read('public/comanda-mea.html');
const server = read('server.js');
const templates = read('lib/recovery-emails/templates.js');
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// ===================================================================================================
// STRUCTURA — redirectul (runda 1) exista, e plasat cat mai devreme, si foloseste STRICT
// /comenzile-mele.html.
// ===================================================================================================
test('comanda-mea.html: scriptul de redirect exista, verifica STRICT prezenta ?token= si redirectioneaza catre /comenzile-mele.html', () => {
  const idx = html.indexOf('data-purpose="no-token-redirect"');
  assert.ok(idx !== -1, 'lipseste scriptul de redirect');
  const scriptBody = html.slice(idx, html.indexOf('</script>', idx));
  assert.match(scriptBody, /new URLSearchParams\(window\.location\.search\)\.get\('token'\)/);
  assert.match(scriptBody, /window\.location\.replace\('\/comenzile-mele\.html'\)/);
});

test('comanda-mea.html: scriptul de redirect e plasat INAINTEA <style>/<body> — ruleaza inainte ca formularul mort sa fie randat vizibil (fara flash de continut gresit)', () => {
  const redirectIdx = html.indexOf('data-purpose="no-token-redirect"');
  const styleIdx = html.indexOf('<style>');
  const bodyIdx = html.indexOf('<body>');
  assert.ok(redirectIdx !== -1 && styleIdx !== -1 && bodyIdx !== -1);
  assert.ok(redirectIdx < styleIdx, 'redirectul trebuie sa ruleze inainte de CSS');
  assert.ok(redirectIdx < bodyIdx, 'redirectul trebuie sa ruleze inainte de body');
});

function extractRedirectSnippet() {
  const idx = html.indexOf('data-purpose="no-token-redirect"');
  const scriptStart = html.indexOf('>', idx) + 1;
  const scriptEnd = html.indexOf('</script>', scriptStart);
  return html.slice(scriptStart, scriptEnd);
}

function runRedirectSnippet(search) {
  const calls = { replace: [] };
  const fakeWindow = { location: { search, replace: (url) => calls.replace.push(url) } };
  const fn = new Function('window', 'URLSearchParams', extractRedirectSnippet());
  fn(fakeWindow, URLSearchParams);
  return calls;
}

test('sandbox: fara ?token= (URL goala) -> redirect STRICT catre /comenzile-mele.html', () => {
  assert.deepEqual(runRedirectSnippet('').replace, ['/comenzile-mele.html']);
});

test('sandbox: ?token= prezent dar gol (link trunchiat/spart) -> redirect STRICT catre /comenzile-mele.html', () => {
  assert.deepEqual(runRedirectSnippet('?token=').replace, ['/comenzile-mele.html']);
});

test('sandbox: ?token=<valoare> (linkul real din emailul de livrare) -> NICIUN redirect, fluxul existent (lookup automat) ramane neschimbat', () => {
  assert.deepEqual(runRedirectSnippet('?token=' + 'a'.repeat(48)).replace, []);
});

// ===================================================================================================
// ELIMINARE COMPLETA A FORMULARULUI MANUAL — niciun camp de input, niciun buton "Cauta", niciun
// placeholder/text despre "cod primit pe email", in NICIUN cod sursa al paginii (markup sau JS).
// ===================================================================================================
test('comanda-mea.html: formularul manual de introducere a codului a fost ELIMINAT COMPLET — niciun <input id="token">, niciun #btn-search, niciun placeholder despre "cod"', () => {
  assert.ok(!/id="token"/.test(html), 'campul manual de introducere a token-ului nu mai trebuie sa existe');
  assert.ok(!/btn-search/.test(html), 'butonul "Cauta" nu mai trebuie sa existe');
  assert.ok(!/class="field"/.test(html), 'wrapper-ul formularului manual nu mai trebuie sa existe');
  assert.ok(!/placeholder="[^"]*cod[^"]*"/i.test(html), 'niciun placeholder nu mai trebuie sa mentioneze un "cod"');
  assert.ok(!/getElementById\('token'\)/.test(html), 'JS-ul nu mai trebuie sa citeasca un camp #token inexistent');
});

test('comanda-mea.html: lookup() nu mai are niciun fallback catre un camp de input — accepta STRICT un token transmis explicit (din URL)', () => {
  assert.match(html, /async function lookup\(token\) \{/);
  assert.ok(!/tokenOverride/.test(html), 'parametrul vechi tokenOverride (cu fallback pe input) nu mai trebuie sa existe');
});

function extractTranslationsObject() {
  const idx = html.indexOf('const T = {');
  let depth = 0, i = html.indexOf('{', idx);
  const start = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}
const translationsSrc = extractTranslationsObject();

function langBlock(lang) {
  const langIdx = translationsSrc.indexOf(`${lang}: {`);
  assert.ok(langIdx !== -1, `blocul limbii ${lang} nu a fost gasit`);
  const nextLangIdx = ALLOWED_LANGS
    .map((l) => translationsSrc.indexOf(`${l}: {`, langIdx + 1))
    .filter((n) => n !== -1)
    .sort((a, b) => a - b)[0] || translationsSrc.length;
  return translationsSrc.slice(langIdx, nextLangIdx);
}

test('comanda-mea.html: cheia de traducere "search" (labelul butonului Cauta, eliminat) nu mai exista in NICIUNA dintre cele 8 limbi', () => {
  ALLOWED_LANGS.forEach((lang) => {
    const block = langBlock(lang);
    assert.ok(!/\bsearch: '/.test(block), `limba ${lang} inca are cheia search (buton eliminat)`);
  });
});

test('comanda-mea.html: NICIUNA dintre cele 8 limbi nu mai promite/mentioneaza un "cod" (de acces/confirmare) in sub/invalid/not_found — STRICT limbaj de link, niciodata de cod', () => {
  const CODE_WORD_BY_LANG = {
    ro: /\bcod\b/i, en: /\bcode\b/i, de: /\bcode\b/i, es: /\bcódigo\b/i,
    it: /\bcodice\b/i, fr: /\bcode\b/i, bg: /\bкод\b/i, tr: /\bkod\b/i
  };
  ALLOWED_LANGS.forEach((lang) => {
    const block = langBlock(lang);
    ['sub', 'invalid', 'not_found'].forEach((key) => {
      const m = block.match(new RegExp(`${key}: (['"])(?:(?!\\1).)*\\1`));
      assert.ok(m, `limba ${lang}: cheia ${key} lipseste`);
      assert.ok(!CODE_WORD_BY_LANG[lang].test(m[0]), `limba ${lang}: cheia ${key} inca mentioneaza un cod ("${m[0]}")`);
    });
  });
});

test('comanda-mea.html: toate cele 8 limbi au cheia see_my_orders (labelul CTA-ului catre fluxul curent, real)', () => {
  ALLOWED_LANGS.forEach((lang) => {
    assert.match(langBlock(lang), /see_my_orders:/, `limba ${lang} nu are cheia see_my_orders`);
  });
});

// ===================================================================================================
// CTA CLAR pentru token invalid/expirat/404/eroare de retea — mesaj + link catre comenzile-mele.html,
// NICIODATA formularul manual. Sandbox: extragem renderAccessError()+lookup() si simulam fiecare caz.
// ===================================================================================================
function buildLookupSandbox({ fetchImpl }) {
  const startMarker = '// BUG REAL (2026-09-29, audit "pagina cu cod de acces care nu exista", runda 2';
  const endMarker = "const urlToken = new URLSearchParams(window.location.search).get('token');";
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker, startIdx);
  assert.ok(startIdx !== -1 && endIdx > startIdx, 'nu am gasit blocul lookup()/renderAccessError() in comanda-mea.html');
  const snippet = html.slice(startIdx, endIdx);

  let resultsHtml = '';
  const elements = {
    results: { set innerHTML(v) { resultsHtml = v; }, get innerHTML() { return resultsHtml; } }
  };
  const fakeDocument = { getElementById: (id) => elements[id] };
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const t = { searching: 'T:searching', invalid: 'T:invalid', not_found: 'T:not_found', conn_error: 'T:conn_error', see_my_orders: 'T:see_my_orders' };

  const build = new Function('document', 'fetch', 'escapeHtml', 't', snippet + '\nreturn { lookup, renderAccessError };');
  const api = build(fakeDocument, fetchImpl, escapeHtml, t);
  return { api, getResultsHtml: () => resultsHtml, t };
}

test('sandbox: token invalid (400) -> mesaj clar + CTA catre /comenzile-mele.html, NICIODATA formularul manual', async () => {
  const { api, getResultsHtml, t } = buildLookupSandbox({ fetchImpl: async () => ({ ok: false, status: 400 }) });
  await api.lookup('a'.repeat(48));
  const out = getResultsHtml();
  assert.match(out, new RegExp(t.invalid));
  assert.match(out, /<a class="cta-btn" href="\/comenzile-mele\.html">/);
  assert.match(out, new RegExp(t.see_my_orders));
  assert.ok(!/id="token"|btn-search/.test(out), 'raspunsul de eroare nu trebuie sa reintroduca formularul manual');
});

test('sandbox: comanda inexistenta/expirata (404) -> mesaj clar + CTA catre /comenzile-mele.html', async () => {
  const { api, getResultsHtml, t } = buildLookupSandbox({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await api.lookup('a'.repeat(48));
  const out = getResultsHtml();
  assert.match(out, new RegExp(t.not_found));
  assert.match(out, /<a class="cta-btn" href="\/comenzile-mele\.html">/);
});

test('sandbox: eroare de retea (fetch arunca exceptie) -> mesaj clar + CTA catre /comenzile-mele.html, niciodata un ecran gol/mort', async () => {
  const { api, getResultsHtml, t } = buildLookupSandbox({ fetchImpl: async () => { throw new Error('network down'); } });
  await api.lookup('a'.repeat(48));
  const out = getResultsHtml();
  assert.match(out, new RegExp(t.conn_error));
  assert.match(out, /<a class="cta-btn" href="\/comenzile-mele\.html">/);
});

test('sandbox: eroare de server (5xx, raspuns care nu e 400/404 dar !res.ok) -> acelasi mesaj clar + CTA', async () => {
  const { api, getResultsHtml, t } = buildLookupSandbox({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await api.lookup('a'.repeat(48));
  const out = getResultsHtml();
  assert.match(out, new RegExp(t.conn_error));
  assert.match(out, /<a class="cta-btn" href="\/comenzile-mele\.html">/);
});

test('comanda-mea.html: renderAccessError() e apelat STRICT in cele 3 ramuri de esec (400/404/!res.ok) si in catch — NICIODATA pe fluxul de succes (dupa res.json()), care ramane cel existent, neschimbat', () => {
  const lookupIdx = html.indexOf('async function lookup(token) {');
  const lookupEnd = html.indexOf('\n  }\n\n', lookupIdx);
  const fn = html.slice(lookupIdx, lookupEnd);
  const successIdx = fn.indexOf('const o = await res.json();');
  const catchIdx = fn.indexOf('} catch (e) {');
  assert.ok(successIdx !== -1 && catchIdx !== -1 && successIdx < catchIdx);
  const beforeSuccess = fn.slice(0, successIdx);
  const successToClose = fn.slice(successIdx, catchIdx);
  const catchBlock = fn.slice(catchIdx);
  assert.equal((beforeSuccess.match(/renderAccessError\(/g) || []).length, 3, 'trebuie STRICT 3 apeluri renderAccessError inainte de succes (400/404/!res.ok)');
  assert.equal((successToClose.match(/renderAccessError\(/g) || []).length, 0, 'fluxul de succes (dupa res.json()) nu trebuie sa apeleze renderAccessError');
  assert.equal((catchBlock.match(/renderAccessError\(/g) || []).length, 1, 'catch-ul exceptiei de retea trebuie sa apeleze STRICT renderAccessError(t.conn_error)');
});

// ===================================================================================================
// FLUXUL CU TOKEN RAMANE NESCHIMBAT — acelasi mecanism (GET /api/orders/access/:token), acelasi
// auto-lookup din urlToken, acelasi header X-Access-Token pentru actiunile ulterioare (amintiri
// video), aceeasi persistenta same-browser — nimic din asta nu a fost atins.
// ===================================================================================================
test('comanda-mea.html: fluxul cu token (GET /api/orders/access/:token, auto-lookup din urlToken, X-Access-Token) ramane STRUCTURAL neschimbat', () => {
  assert.match(html, /fetch\('\/api\/orders\/access\/' \+ encodeURIComponent\(token\)\)/);
  assert.match(html, /const urlToken = new URLSearchParams\(window\.location\.search\)\.get\('token'\);/);
  assert.match(html, /if \(urlToken\) \{/);
  assert.match(html, /lookup\(urlToken\);/);
  assert.match(html, /headers: \{ 'X-Access-Token': currentToken \|\| '' \}/);
});

test('comanda-mea.html: SAME BROWSER — persistenta in naluna_my_order_keys dupa un lookup reusit ramane neschimbata (fix anterior, 2026-09-28)', () => {
  assert.match(html, /const KEY = 'naluna_my_order_keys';/);
  assert.match(html, /localStorage\.setItem\(KEY, JSON\.stringify\(list\.slice\(-50\)\)\)/);
});

// ===================================================================================================
// AUDIT — niciun email real Naluna nu afiseaza accessToken-ul ca text vizibil/copiabil: el apare
// STRICT ca parte a unui URL folosit intr-un href, niciodata randat separat ca "cod" (neschimbat
// fata de runda 1 — mecanismul tokenurilor si recovery-ul nu au fost atinse).
// ===================================================================================================
function sliceFunction(source, startMarker, endMarkers) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `nu am gasit ${startMarker}`);
  const ends = endMarkers.map((m) => source.indexOf(m, start + startMarker.length)).filter((n) => n !== -1);
  const end = Math.min(...ends);
  return source.slice(start, end);
}

test('server.js: sendDeliveryEmail (emailul de livrare, singurul care mai trimite clienti catre comanda-mea.html) construieste accessUrl STRICT ca argument de href, niciodata randat ca text separat', () => {
  const fn = sliceFunction(server, 'async function sendDeliveryEmail(order) {', ['\nasync function ', '\nfunction ']);
  assert.match(fn, /const accessUrl = `\$\{DOMAIN\}\/comanda-mea\.html\?token=\$\{order\.accessToken\}`;/);
  const accessUrlUsages = [...fn.matchAll(/\$\{accessUrl\}/g)];
  assert.ok(accessUrlUsages.length > 0);
  const rawTokenOutsideUrlLine = fn.split('\n').filter((line) => line.includes('order.accessToken') && !line.includes('const accessUrl') && !line.includes('const downloadUrl') && !line.includes('const giftUrl') && !line.includes('const premiumBonusUrl') && !line.includes('const videoUrlForEmail') && !line.includes('const wavUrl'));
  assert.deepEqual(rawTokenOutsideUrlLine, [], `accessToken nu trebuie interpolat in afara constructiei unui URL: ${JSON.stringify(rawTokenOutsideUrlLine)}`);
});

test('server.js: sendAccessRecoveryEmail (recuperare acces) construieste accessUrl STRICT ca argument de href catre comenzile-mele.html, niciodata un token randat separat ca text', () => {
  const fn = sliceFunction(server, 'async function sendAccessRecoveryEmail({ email, lang, orders }) {', ['\nasync function ', '\nfunction ']);
  assert.match(fn, /const accessUrl = `\$\{DOMAIN\}\/comenzile-mele\.html\?tokens=\$\{encodeURIComponent\(allTokens\)\}`;/);
  assert.match(fn, /<a href="\$\{accessUrl\}"/);
  assert.ok(!/o\.accessToken\}<\/|accessToken\}<\//.test(fn), 'niciun accessToken nu trebuie randat ca text vizibil in afara href-ului');
});

test('lib/recovery-emails/templates.js: buildOrderLink (folosit de toate cele 3 sabloane — preview_ready/preview_recovery/checkout_recovery) construieste STRICT un URL, accessToken apare STRICT ca parametru de query, niciodata ca text separat afisat clientului', () => {
  assert.match(templates, /function buildOrderLink\(domain, orderId, accessToken\) \{\s*\n\s*return `\$\{domain\}\/melodia-mea\.html\?id=\$\{encodeURIComponent\(orderId\)\}&token=\$\{encodeURIComponent\(accessToken\)\}`;/);
  const buildersUsingLink = ['buildPreviewReadyEmail', 'buildPreviewRecoveryEmail', 'buildCheckoutRecoveryEmail'];
  buildersUsingLink.forEach((name) => {
    const fn = sliceFunction(templates, `function ${name}(`, ['\nfunction ', '\nconst ', '\nmodule.exports']);
    assert.match(fn, /const link = buildOrderLink\(/, `${name} trebuie sa foloseasca buildOrderLink, niciodata accessToken direct`);
  });
});

test('comanda-mea.html: sintaxa scriptului ramane valida dupa eliminarea formularului manual', () => {
  const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m) => { if (m[1].trim()) assert.doesNotThrow(() => new Function(m[1])); });
});
