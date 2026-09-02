// LAUNCH SAFETY (2026-09-02, revizuire audit initial): auditul initial de lansare (Marketing
// Skills / JTBD / Frontend Design) a gasit doua goluri MUST HAVE care nu fusesera inca
// implementate cand a fost reluat auditul: (1) niciun pret vizibil pe homepage, (2) linkul
// "Comanda mea" dispare complet din navigare pe mobil sub 860px (nav-links{display:none}),
// fara nicio alternativa — un client care revine pe mobil, fara emailul la indemana, nu are
// cum sa-si gaseasca comanda. Acest fisier blocheaza recurenta ambelor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const index = read('public/index.html');
const comanda = read('public/comanda.html');

test('index.html: exista o sectiune de preturi reale (£15/£25/£35), reutilizand EXACT preturile server-side (PLAN_PRICES), nu cifre inventate', () => {
  const server = read('server.js');
  const m = server.match(/const PLAN_PRICES = \{ standard: (\d+), premium: (\d+), video: (\d+) \};/);
  assert.ok(m, 'nu am putut citi PLAN_PRICES din server.js pentru comparatie');
  const [, std, prem, vid] = m;
  assert.ok(index.includes(`£${std}`), `index.html trebuie sa afiseze pretul Standard real (£${std})`);
  assert.ok(index.includes(`£${prem}`), `index.html trebuie sa afiseze pretul Premium real (£${prem})`);
  assert.ok(index.includes(`£${vid}`), `index.html trebuie sa afiseze pretul Video real (£${vid})`);
});

test('index.html: sectiunea de preturi reutilizeaza EXACT numele/subtitlurile/descrierile pachetelor din comanda.html (aceleasi chei data-i18n), nu texte de marketing noi si divergente', () => {
  const keys = ['plan_standard_name', 'plan_standard_subtitle', 'plan_standard_desc',
    'plan_premium_name', 'plan_premium_subtitle', 'plan_premium_desc',
    'plan_video_name', 'plan_video_subtitle', 'plan_video_desc'];
  for (const key of keys) {
    assert.ok(index.includes(`data-i18n="${key}"`), `index.html trebuie sa foloseasca cheia ${key} (aceeasi ca in comanda.html)`);
    assert.ok(comanda.includes(`${key}:`), `comanda.html trebuie sa aiba definita cheia ${key} (sursa de adevar pentru text)`);
  }
});

test('index.html: sectiunea de preturi are chei de traducere definite in toate cele 8 limbi (pricing_eyebrow/title/sub + cele 9 chei de pachet)', () => {
  const keys = ['pricing_eyebrow', 'pricing_title', 'pricing_sub',
    'plan_standard_name', 'plan_standard_subtitle', 'plan_standard_desc',
    'plan_premium_name', 'plan_premium_subtitle', 'plan_premium_desc',
    'plan_video_name', 'plan_video_subtitle', 'plan_video_desc'];
  for (const key of keys) {
    const count = (index.match(new RegExp(`${key}:`, 'g')) || []).length;
    assert.equal(count, 8, `cheia ${key} trebuie sa existe de exact 8 ori (o data per limba) in index.html, gasit ${count}`);
  }
});

test('index.html: linkul catre "Comanda mea" ramane accesibil pe mobil (sub 860px), in bara fixa de jos — nu doar in .nav-links, care e ascuns complet la acea latime', () => {
  const stickyIdx = index.indexOf('class="mobile-sticky-cta"');
  assert.notEqual(stickyIdx, -1, 'trebuie sa existe bara fixa mobila');
  const stickyBlockEnd = index.indexOf('</div>\n</div>', stickyIdx);
  const searchWindow = index.slice(stickyIdx, stickyIdx + 600);
  assert.ok(searchWindow.includes('href="/comanda-mea.html"'), 'bara fixa mobila trebuie sa contina un link catre /comanda-mea.html, altfel un client de pe mobil nu are nicio cale sa-si gaseasca comanda dupa ce .nav-links e ascuns');
});

test('index.html: .nav-links (unde e si linkul original catre Comanda mea) e intr-adevar ascuns complet sub 860px — confirma DE CE era nevoie de alternativa in bara mobila', () => {
  assert.match(index, /@media \(max-width: 860px\)\{[\s\S]{0,200}\.nav-links\{ display:none; \}/);
});
