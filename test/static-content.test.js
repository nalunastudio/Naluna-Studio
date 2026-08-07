// Teste de regresie STATICE (citesc direct sursa, fara server/DB) — verifica scenariile 1
// (textul de contact eliminat), 4 (pasul media inainte de generare pentru Video) si aspecte
// din 13/14/16 (livrabilele mentionate corect) care nu necesita un backend rulat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const CONTACT_PROMISE_FRAGMENTS = [
  'te contactăm pentru remediere sau rambursare',
  "we'll contact you to fix it or refund you",
  'wir melden uns bei dir, um es zu beheben',
  'te contactamos para solucionarlo',
  'ti contattiamo per risolverlo',
  'nous vous contactons pour',
  'ще се свържем с теб',
  'sizinle iletişime geçip sorunu çözer'
];

test('scenariul 1: promisiunea de contact manual nu mai apare in comanda.html', () => {
  const html = read('public/comanda.html').toLowerCase();
  for (const fragment of CONTACT_PROMISE_FRAGMENTS) {
    assert.ok(!html.includes(fragment.toLowerCase()), `fragment gasit inca in comanda.html: "${fragment}"`);
  }
});

test('scenariul 1: promisiunea de contact manual nu mai apare in index.html (FAQ)', () => {
  const html = read('public/index.html').toLowerCase();
  for (const fragment of CONTACT_PROMISE_FRAGMENTS) {
    assert.ok(!html.includes(fragment.toLowerCase()), `fragment gasit inca in index.html: "${fragment}"`);
  }
  assert.ok(!html.includes('faq_q5'), 'intrebarea FAQ #5 (despre contact/rambursare) ar trebui eliminata complet');
});

test('scenariul 1: promisiunea de contact manual nu mai apare in succes.html', () => {
  const html = read('public/succes.html').toLowerCase();
  for (const fragment of CONTACT_PROMISE_FRAGMENTS) {
    assert.ok(!html.includes(fragment.toLowerCase()), `fragment gasit inca in succes.html: "${fragment}"`);
  }
});

test('scenariul 1: eroarea de generare din succes.html ramane un mesaj util, doar fara promisiunea de contact', () => {
  const html = read('public/succes.html');
  assert.ok(html.includes('error_sub'), 'mesajul de eroare la esecul generarii trebuie sa ramana');
});

test('regula WAV: comanda.html nu mai foloseste termenul tehnic "WAV" neexplicat (inlocuit cu "versiune audio la calitate inalta")', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('WAV'), 'termenul "WAV" nu ar trebui sa mai apara in comanda.html');
  assert.ok(html.includes('calitate înaltă'), 'formularea inlocuitoare ("versiune/fisier audio la calitate inalta") trebuie sa fie prezenta');
});

test('scenariul 4: pachetul Video foloseste un buton dedicat catre pasul media, nu "genereaza previzualizarea"', () => {
  const html = read('public/comanda.html');
  assert.ok(html.includes('btn_continue_media'), 'trebuie sa existe cheia de traducere btn_continue_media');
  assert.ok(html.includes('updateGenerateButtonLabel'), 'eticheta butonului trebuie sa fie actualizata dinamic in functie de planul ales');
  assert.ok(
    html.includes("selectedPlan.id === 'video'") && html.includes('melodia-mea.html?id='),
    'planul video trebuie sa redirectioneze direct catre melodia-mea.html, fara sa apeleze /generate'
  );
});

test('scenariul 5: backend-ul refuza /generate pentru Video fara materiale confirmate', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("order.plan === 'video' && !order.mediaConfirmedAt"),
    'ruta POST /generate trebuie sa verifice explicit mediaConfirmedAt pentru planul video'
  );
});

test('scenariul 13/16: toate cele trei pachete proceseaza ambele variante Suno (fara trunchiere la 1 pentru Standard)', () => {
  const server = read('server.js');
  assert.ok(
    !/claimed\.plan === 'standard' \? tracks\.slice\(0, 1\) : tracks/.test(server),
    'Standard nu mai trebuie sa arunce a doua varianta Suno'
  );
});

test('scenariul 14/15: exista un endpoint dedicat pentru descarcarea melodiei cadou, protejat identic cu /media/full', () => {
  const server = read('server.js');
  assert.ok(server.includes("/media/full/:orderId/gift"), 'trebuie sa existe ruta /media/full/:orderId/gift');
  assert.ok(server.includes('getGiftVariant'), 'ruta trebuie sa foloseasca getGiftVariant din lib/entitlements');
});

test('scenariul 17: emailul de livrare include un link catre melodia cadou, pentru toate planurile', () => {
  const server = read('server.js');
  assert.ok(server.includes('giftLine'), 'sablonul de email trebuie sa includa giftLine');
  assert.ok(server.includes('${giftLine}${videoLine}'), 'giftLine trebuie inserat in corpul emailului pentru toate limbile');
});

test('scenariul 17: emailul de livrare include link direct catre videoclip pentru pachetul Video (deja gata la momentul platii)', () => {
  const server = read('server.js');
  assert.ok(server.includes('videoUrlForEmail'), 'emailul trebuie sa construiasca un link direct catre videoclip');
  assert.ok(server.includes('hasVideoForEmail'), 'linkul catre videoclip trebuie sa fie conditionat de existenta lui reala');
});
