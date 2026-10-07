// RESTAURARE (7 oct 2026, "restore: september real generation progress" — known-good-ul corect
// e commitul 7a0f12b, 14 sept 2026, NU lansarea 6699abe din 26 iulie). Afisarea procentului
// revine STRICT la updateRealProgress(order), citind order.generationPhasePercent/
// order.regenerationProgress — formula de timp scurs introdusa gresit in ba371b9 a fost
// eliminata complet. Teste suplimentare fata de test/generation-screen-fetch-timeout.test.js
// (care acopera deja secventa 10/30/55/80/100 si recovery-ul), STRICT pentru cele doua cerinte
// care nu aveau inca o verificare explicita separata.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSandbox, jsonResponse } = require('./helpers/se-compune-dom-sandbox.js');

function loadReal(fetchImpl, search) {
  const sandbox = buildSandbox({ fetchImpl, initialSearch: search });
  sandbox.run();
  return sandbox;
}

test('pill NU este controlat de timp scurs — fara niciun raspuns de la server, procentul ramane gol/ascuns oricat timp simulat ar trece', async () => {
  const sandbox = loadReal(async () => new Promise(() => {})); // fetch-ul nu se rezolva niciodata
  const pill = sandbox.elements.get('estimate-pill');
  assert.equal(pill.textContent, '', 'la page load, fara raspuns real, pill-ul trebuie sa ramana gol (nu 0%, nu niciun procent calculat din timp)');
  await sandbox.clock.advance(120000); // 2 minute simulate, fara niciun raspuns
  assert.equal(pill.textContent, '', 'procentul nu trebuie sa avanseze NICIODATA doar pentru ca a trecut timp — trebuie sa vina STRICT din backend');
});

test('bara de progres (progress-fill width) urmeaza EXACT procentul primit din backend (generationPhasePercent), nu o estimare', async () => {
  const sandbox = loadReal(async () => jsonResponse({ status: 'generating', generationPhasePercent: 55, plan: 'standard' }));
  await sandbox.clock.advance(4000);
  const progressFill = sandbox.elements.get('progress-fill');
  assert.equal(progressFill.style.width, '55%');
  assert.equal(progressFill.classList.contains('real'), true);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '55%');
});

test('regenerare: procentul vine STRICT din order.regenerationProgress, separat de generationPhasePercent', async () => {
  const sandbox = loadReal(
    async () => jsonResponse({ status: 'generating', regenerationStatus: 'generating', generationPhasePercent: 100, regenerationProgress: 30, plan: 'standard' }),
    '?id=test-order-id&token=test-token-abc&mode=regenerate'
  );
  await sandbox.clock.advance(4000);
  assert.equal(sandbox.elements.get('estimate-pill').textContent, '30%', 'in regenerare, generationPhasePercent (100, ramas de la generarea initiala) nu trebuie citit — doar regenerationProgress');
});
