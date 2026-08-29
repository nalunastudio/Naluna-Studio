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

// RELANSARE (2026-08-14, "materialele se incarca DUPA ce melodia finala e stabilita"):
// pachetul Video nu mai sare peste generarea melodiei — foloseste acum EXACT acelasi buton si
// acelasi apel /generate ca Standard/Premium, imediat dupa crearea comenzii. Materialele se
// incarca abia dupa ce melodia finala e aleasa, pe melodia-mea.html.
test('scenariul 4 (relansat): pachetul Video foloseste EXACT acelasi buton "genereaza previzualizarea" ca Standard/Premium, fara ramura separata', () => {
  const html = read('public/comanda.html');
  assert.ok(!html.includes('btn_continue_media'), 'cheia de traducere veche (buton separat catre materiale) nu mai trebuie sa existe');
  assert.ok(html.includes('updateGenerateButtonLabel'), 'functia ramane, dar foloseste acum necondiTionat btn_generate');
  assert.ok(
    html.includes("label.setAttribute('data-i18n', 'btn_generate');") && html.includes("label.textContent = t('btn_generate');"),
    'eticheta butonului trebuie sa fie STRICT btn_generate, indiferent de planul ales'
  );
  assert.ok(
    !html.includes("if (selectedPlan.id === 'video') {") || !html.includes('window.location.href = `/melodia-mea.html?id=${currentOrderId}&token=${tokenParam}`;'),
    'nu mai trebuie sa existe o ramura separata care redirectioneaza planul video direct catre melodia-mea.html, ocolind /generate'
  );
});

test('scenariul 5 (relansat): backend-ul NU mai conditioneaza /generate de materiale confirmate pentru Video', () => {
  const server = read('server.js');
  assert.ok(
    !server.includes("order.plan === 'video' && !order.mediaConfirmedAt"),
    'gate-ul vechi (mediaConfirmedAt obligatoriu inainte de generare) trebuie eliminat complet din POST /generate'
  );
  // Checkout ramane STRICT gatat pe materiale confirmate + videoclip gata — neschimbat.
  assert.ok(
    server.includes("if (order.plan === 'video') {") && server.includes("if (!order.mediaConfirmedAt) {"),
    'checkout-ul trebuie sa ramana gatat pe mediaConfirmedAt (neschimbat) — doar generarea melodiei nu mai e'
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

// ==========================================================================================
// HOTFIX 2026-08-07 — upload iPhone si generare Premium blocata (root cause confirmat prin
// investigatie live in productie, vezi raportul hotfix pentru detalii complete).
// ==========================================================================================

// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): coada de
// incarcare testata aici a fost MUTATA din melodia-mea.html in public/amintiri-video.html.
test('hotfix upload iPhone: coada de incarcare limiteaza concurenta explicit (nu porneste toate fisierele deodata)', () => {
  const html = read('public/amintiri-video.html');
  assert.ok(html.includes('MAX_CONCURRENT_UPLOADS'), 'trebuie sa existe o limita explicita de uploaduri simultane');
  assert.ok(html.includes('processUploadQueue'), 'trebuie sa existe o functie care porneste doar cate un numar limitat de uploaduri deodata');
  assert.ok(
    !/files\.forEach\(file => \{[\s\S]{0,300}startUpload\(entry\);/.test(html),
    'selectarea fisierelor NU mai trebuie sa apeleze startUpload() direct, sincron, pentru fiecare fisier'
  );
});

test('hotfix upload iPhone: fiecare upload are un timeout explicit, niciodata spinner etern', () => {
  const html = read('public/amintiri-video.html');
  assert.ok(html.includes('xhr.timeout'), 'trebuie setat un timeout explicit pe XMLHttpRequest');
  assert.ok(html.includes('xhr.ontimeout'), 'timeoutul trebuie sa produca o stare finala de eroare, nu ramane blocat');
});

test('hotfix upload iPhone: backend accepta fallback pe extensie cand mimetype-ul de la browser lipseste/e generic', () => {
  const server = read('server.js');
  assert.ok(server.includes('inferMediaType'), 'ruta de upload trebuie sa foloseasca inferMediaType (fallback pe extensie)');
});

test('hotfix upload iPhone: ruta de upload logheaza diagnostic sigur (fara token/URL semnat/nume de fisier)', () => {
  const server = read('server.js');
  assert.ok(/perfLog\(order\.id, 'media_upload'/.test(server), 'trebuie sa existe un log de diagnostic pentru fiecare cerere de upload');
});

test('hotfix Premium blocat: pagina de asteptare reverifica statusul imediat la revenirea din fundal', () => {
  const html = read('public/se-compune.html');
  assert.ok(html.includes("visibilitychange"), 'trebuie sa existe un listener pentru revenirea tab-ului in prim-plan');
  assert.ok(html.includes('forceImmediatePoll'), 'revenirea in prim-plan trebuie sa forteze o verificare imediata a starii reale');
});
