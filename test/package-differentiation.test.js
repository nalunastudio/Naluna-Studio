// Teste de regresie STATICE (citesc direct sursa, fara server/DB) pentru regula finala a
// pachetelor (hotfix 2026-08-07): Standard = 1 melodie/1 gen; Premium/Video = 2 melodii
// complete, 2 genuri DIFERITE alese de client, fara cadru de "cadou din partea noastra".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('PLAN_VARIANT_COUNT: Standard=1 varianta, Premium/Video=2 variante', () => {
  const server = read('server.js');
  assert.match(
    server,
    /PLAN_VARIANT_COUNT\s*=\s*\{\s*standard:\s*1,\s*premium:\s*2,\s*video:\s*2\s*\}/,
    'PLAN_VARIANT_COUNT trebuie sa mapeze exact standard->1, premium->2, video->2'
  );
});

test('POST /api/orders: genre2 e cerut si validat ca diferit de genre pentru Premium/Video', () => {
  const server = read('server.js');
  assert.ok(server.includes('PLAN_VARIANT_COUNT[plan] === 2'), 'validarea genre2 trebuie sa se aplice doar planurilor cu 2 variante');
  assert.ok(server.includes('genre2Message'), 'trebuie sa existe un mesaj de eroare tradus pentru genre2 lipsa');
  assert.ok(server.includes('sameGenreMessage'), 'trebuie sa existe un mesaj de eroare tradus pentru genuri identice');
});

test('runGeneration: Premium/Video lanseaza doua cereri Suno in paralel (Promise.all), niciodata secvential', () => {
  const server = read('server.js');
  assert.ok(
    /Promise\.all\(\[\s*callMusicProvider\(orderId, promptGenre1\),\s*callMusicProvider\(orderId, promptGenre2\)\s*\]\)/.test(server),
    'cele doua genuri trebuie generate in paralel, nu secvential'
  );
});

test('finalizeVariantsIfNeeded: suporta inlocuire PARTIALA (o singura varianta), pastreaza sora neatinsa', () => {
  const server = read('server.js');
  assert.ok(server.includes('options.replaceVariantId'), 'trebuie sa existe suportul pentru replaceVariantId');
  assert.ok(
    server.includes('variants = existing.map(v => v.id === options.replaceVariantId ? replaced : v)'),
    'inlocuirea partiala trebuie sa pastreze toate celelalte variante neatinse'
  );
});

test('POST /api/orders/:orderId/regenerate: Premium/Video regenereaza DOAR varianta ceruta, niciodata ambele genuri deodata', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("PLAN_VARIANT_COUNT[order.plan] === 2) ? { replaceVariantId: requestedVariantId } : {}"),
    'regenerarea Premium/Video trebuie sa treaca replaceVariantId catre runGeneration'
  );
});

test('Comenzile Premium/Video ramase "generating" pot fi reluate SI finalizate pentru AMBELE sarcini, nu doar prima', () => {
  const server = read('server.js');
  assert.ok(server.includes('async function resumeDualTaskPolling(orderId)'), 'trebuie sa existe o reluare dedicata pentru comenzi cu doua sarcini Suno');
  assert.ok(server.includes('async function waitForDualTaskAndFinalize('), 'logica de asteptare+finalizare duala trebuie extrasa intr-o functie reutilizabila');
  assert.match(
    server,
    /if \(order\.musicTaskId2\) \{\s*resumeDualTaskPolling\(order\.id\);/,
    'ruta POST /generate trebuie sa reia AMBELE sarcini (resumeDualTaskPolling) pentru comenzi cu musicTaskId2, nu doar prima'
  );
  assert.match(
    server,
    /if \(fresh\.musicTaskId2\) \{\s*resumeDualTaskPolling\(order\.id\);/,
    'ruta POST /regenerate trebuie sa reia AMBELE sarcini (resumeDualTaskPolling) pentru comenzi cu musicTaskId2, nu doar prima'
  );
});

test('POST /api/music/callback: comenzile cu doua sarcini (musicTaskId2) nu se finalizeaza dintr-un singur callback', () => {
  const server = read('server.js');
  assert.ok(
    server.includes('if (order.musicTaskId2) {'),
    'callback-ul trebuie sa refuze finalizarea prematura pentru comenzile cu doua sarcini Suno active'
  );
});

test('GET /api/orders/:orderId expune genre, genre2, generationPhase si generationPhasePercent', () => {
  const server = read('server.js');
  assert.ok(server.includes('genre: order.genre || null,'), 'raspunsul trebuie sa expuna genul principal');
  assert.ok(server.includes('genre2: order.genre2 || null,'), 'raspunsul trebuie sa expuna al doilea gen');
  assert.ok(server.includes('generationPhase: order.generationPhase || null,'), 'raspunsul trebuie sa expuna faza curenta de generare');
  assert.ok(server.includes('generationPhasePercent:'), 'raspunsul trebuie sa expuna procentul curent de generare');
});

test('recordGenerationProgress: procentele sunt milestone-uri fixe, niciodata un timer', () => {
  const server = read('server.js');
  assert.ok(
    /GENERATION_PHASE_PERCENT\s*=\s*\{[^}]*submitted:\s*10[^}]*processing:\s*30[^}]*first_stream:\s*55[^}]*finalizing:\s*80[^}]*ready:\s*100/s.test(server),
    'milestone-urile de progres trebuie sa fie valori fixe asociate unor evenimente reale'
  );
});

test('comanda.html: campul de-al doilea gen exista si e ascuns implicit', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('id="genre2-grid"'), 'trebuie sa existe grila de-al doilea gen');
  assert.ok(html.includes('id="genre2-field" style="display:none;"'), 'campul trebuie sa fie ascuns implicit (doar Standard e implicit)');
  assert.ok(html.includes("planNeedsGenre2"), 'vizibilitatea trebuie sa depinda de planul ales (premium/video)');
});

test('comanda.html: validarea blocheaza trimiterea daca genurile sunt identice sau genre2 lipseste', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes("t('val_genre2_required')"), 'trebuie sa existe eroare pentru genre2 lipsa');
  assert.ok(html.includes("t('val_genre_same')"), 'trebuie sa existe eroare pentru genuri identice');
});

test('comanda.html: Standard nu mai promite "a doua melodie cadou"', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('cadou din partea noastră'), 'niciun pachet nu mai trebuie sa foloseasca formularea de "cadou din partea noastra"');
});

test('melodia-mea.html: genul e afisat langa fiecare player (tag vizibil) pentru variantele noi', () => {
  const html = read('public/melodia-mea.html');
  assert.ok(html.includes('variant-genre-tag'), 'trebuie sa existe un tag vizibil pentru gen langa player');
  assert.ok(html.includes('variant_second_label'), 'eticheta neutra pentru a doua melodie trebuie sa existe (fara cadru de cadou)');
});

test('nixpacks.toml: exiftool e declarat ca dependinta de build (necesar pentru extractia previzualizarii DNG)', () => {
  const nixpacks = read('nixpacks.toml');
  assert.ok(nixpacks.includes('exiftool'), 'exiftool trebuie sa fie in nixPkgs, altfel extractDngPreviewToJpeg esueaza in productie');
});

test('server.js: DNG e extras la o previzualizare JPEG utilizabila inainte de verificarea de decodabilitate', () => {
  const server = read('server.js');
  assert.ok(server.includes('extractDngPreviewToJpeg'), 'trebuie sa existe extractia previzualizarii DNG');
  assert.ok(server.includes("wasDng = effectiveMimetype === 'image/x-adobe-dng'"), 'DNG trebuie detectat explicit inainte de restul pipeline-ului de upload');
});

test('se-compune.html: procentul de progres afisat e REAL (din generationPhasePercent), niciodata dintr-un timer', () => {
  const html = read('public/se-compune.html');
  assert.ok(html.includes('order.generationPhasePercent'), 'progresul afisat trebuie sa vina din campul real expus de server');
  assert.ok(html.includes('updateRealProgress'), 'trebuie sa existe o functie dedicata care actualizeaza bara/procentul din raspunsul real al serverului');
  assert.ok(
    !/estimatePillEl\.textContent\s*=.*elapsed/.test(html),
    'procentul afisat nu mai trebuie calculat din timp scurs (elapsed)'
  );
});
