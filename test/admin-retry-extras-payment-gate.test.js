// Admin "Retry Extras" — regresie pentru un fals-pozitiv real (2026-09-25): o comanda FR/premium
// (id 4c3e2634-...) aparea cu butonul "Retry Extras" desi NU fusese platita niciodata
// (paid_at NULL, status 'preview_ready' din prima generare, nu dintr-o regenerare esuata).
//
// Root cause: atat getOrderRowActions (private/admin/orders.js) cat si guard-ul din
// POST /api/admin/orders/:orderId/retry-extras (server.js) foloseau STRICT status-ul
// ('ready'/'preview_ready'), fara sa verifice paid_at. Insa 'preview_ready' e ambiguu pentru
// premium: poate insemna (a) comanda DEJA PLATITA a carei editare/regenerare a esuat si a
// revenit la 'preview_ready' PASTRAND paid_at (vezi markGenerationFailed, server.js) — retry
// legitim — sau (b) comanda NICIODATA platita, inca in previzualizarea initiala — niciun extras
// de reincercat, WAV-ul nu trebuie generat inainte de plata. Pentru "video" nu exista aceasta
// ambiguitate: randarea video e INTENTIONAT pre-plata (vezi POST .../create-video), deci statusul
// singur ramane suficient acolo — comportamentul video NU trebuie sa se schimba.
//
// Extragere TEXTUALA (acelasi tipar ca test/admin-orders-date-helpers.test.js pentru orders.js,
// si tiparul general al suitei pentru server.js — fara Postgres real disponibil local).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin', 'orders.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFrontendEligibility() {
  const re = /function getOrderRowActions\(order\) \{[\s\S]*?\n\}/;
  const match = ordersSrc.match(re);
  assert.ok(match, 'getOrderRowActions lipseste sau s-a schimbat structural in orders.js');
  const wrapperSrc = `(function () {\n${match[0]}\nreturn getOrderRowActions;\n})`;
  return new Function('return ' + wrapperSrc)()();
}

function extractBackendEligibility() {
  const startMarker = "const extrasEligible = order.status === 'ready'";
  const startIdx = serverSrc.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'guard-ul extrasEligible lipseste sau s-a schimbat structural in server.js');
  const endIdx = serverSrc.indexOf(';', startIdx);
  const line = serverSrc.slice(startIdx, endIdx + 1);
  const wrapperSrc = `(function (order) {\n${line}\nreturn extrasEligible;\n})`;
  return new Function('return ' + wrapperSrc)();
}

// ================================================================================================
// Matrice comuna de scenarii — front-end si back-end TREBUIE sa fie de acord (aceeasi decizie).
// ================================================================================================
const scenarios = [
  {
    name: 'premium, ready, platita — extras eligibil (caz normal, dupa livrare)',
    order: { plan: 'premium', status: 'ready', paidAt: '2026-09-20T10:00:00.000Z' },
    eligible: true
  },
  {
    name: 'premium, preview_ready, paidAt SETAT — regenerare/editare esuata dupa plata, extras eligibil',
    order: { plan: 'premium', status: 'preview_ready', paidAt: '2026-09-20T10:00:00.000Z' },
    eligible: true
  },
  {
    name: 'REGRESIE REALA: premium, preview_ready, paidAt NULL (niciodata platita) — extras NU trebuie oferit',
    order: { plan: 'premium', status: 'preview_ready', paidAt: null },
    eligible: false
  },
  {
    name: 'video, preview_ready, paidAt NULL — randare video pre-plata, prin design, extras ramane eligibil (comportament NESCHIMBAT)',
    order: { plan: 'video', status: 'preview_ready', paidAt: null },
    eligible: true
  },
  {
    name: 'video, ready, platita — extras eligibil',
    order: { plan: 'video', status: 'ready', paidAt: '2026-09-20T10:00:00.000Z' },
    eligible: true
  },
  {
    name: 'standard, preview_ready, paidAt NULL — planul standard nu are extrase, niciodata eligibil',
    order: { plan: 'standard', status: 'preview_ready', paidAt: null },
    eligible: false
  },
  {
    name: 'premium, generating — status neterminat, niciodata eligibil indiferent de plata',
    order: { plan: 'premium', status: 'generating', paidAt: '2026-09-20T10:00:00.000Z' },
    eligible: false
  },
  {
    name: 'premium, generation_failed — status esuat definitiv (nu preview_ready), niciodata eligibil pentru retry-extras',
    order: { plan: 'premium', status: 'generation_failed', paidAt: null },
    eligible: false
  }
];

for (const { name, order, eligible } of scenarios) {
  test(`getOrderRowActions (frontend): ${name}`, () => {
    const getOrderRowActions = extractFrontendEligibility();
    const actions = getOrderRowActions(order);
    const hasRetry = actions.some((a) => a.id === 'retry-extras');
    assert.equal(hasRetry, eligible);
    assert.ok(actions.some((a) => a.id === 'anonymize'), 'Anonimizează trebuie sa ramana mereu disponibila');
  });

  test(`retry-extras guard (backend): ${name}`, () => {
    const isEligible = extractBackendEligibility();
    assert.equal(isEligible(order), eligible);
  });
}

test('frontend si backend sunt de acord pentru TOATE scenariile (nicio divergenta de comportament intre UI si API)', () => {
  const getOrderRowActions = extractFrontendEligibility();
  const isEligible = extractBackendEligibility();
  for (const { order } of scenarios) {
    const frontend = getOrderRowActions(order).some((a) => a.id === 'retry-extras');
    const backend = isEligible(order);
    assert.equal(frontend, backend, `divergenta pentru ${JSON.stringify(order)}`);
  }
});

// ================================================================================================
// Comanda REALA gasita in productie (4c3e2634-..., FR/premium) — regresie directa, fara PII.
// ================================================================================================
test('comanda reala FR/premium (preview_ready, paid_at null, ambele variante cu audio dar fara WAV) NU mai primeste "Retry Extras"', () => {
  const getOrderRowActions = extractFrontendEligibility();
  const realOrderShape = { plan: 'premium', status: 'preview_ready', paidAt: null };
  const actions = getOrderRowActions(realOrderShape);
  assert.ok(!actions.some((a) => a.id === 'retry-extras'));
});

// ================================================================================================
// Izolare — generatePremiumExtras si triggerVideoGeneration NU au fost modificate de acest fix
// (fix-ul e STRICT la nivelul gate-ului de eligibilitate, nu la logica de generare in sine).
// ================================================================================================
test('server.js: generatePremiumExtras ramane apelata neschimbat (forceVideo: false) din retry-extras', () => {
  assert.match(serverSrc, /await generatePremiumExtras\(req\.params\.orderId, \{ forceVideo: false \}\);/);
});

test('server.js: triggerVideoGeneration ramane apelata neschimbat pentru planul video din retry-extras', () => {
  const idx = serverSrc.indexOf("app.post('/api/admin/orders/:orderId/retry-extras'");
  const end = serverSrc.indexOf('\n});', idx);
  const block = serverSrc.slice(idx, end);
  assert.match(block, /if \(order\.plan === 'video' && order\.selectedVariantId\) \{\s*await triggerVideoGeneration\(order\.id, order\.selectedVariantId\);/);
});

test('server.js si private/admin/orders.js raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'private', 'admin', 'orders.js')]);
});
