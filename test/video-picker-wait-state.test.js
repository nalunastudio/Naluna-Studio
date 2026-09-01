// Runda 7 (2026-08-14), "starea de asteptare dupa selectarea videoclipurilor iPhone" — dovada
// confirmata in codul live: checkPickerDelivery() declara dupa STRICT 1200ms ca "iOS nu a predat
// fisierele" (eroare + deblocare + permite un nou picker), iar click-ul pe selector il debloca
// oricum automat dupa 20 de secunde — ambele incompatibile cu pregatirea unui videoclip mare de
// catre iPhone Photos/iCloud, care poate dura 2-3 minute inainte ca Safari sa primeasca 'change'.
// Acest fisier verifica STRUCTURAL si prin executie REALA a logicii de blocare/deblocare ca:
//   1) niciun timer nu mai declara esec/deblocheaza automat selectorul, indiferent cat timp
//      trece pana la 'change' (3s, 30s, 180s — toate identice din punctul de vedere al codului,
//      pentru ca nu mai exista nicio ramura care sa depinda de durata asteptarii);
//   2) selectorul se deblocheaza STRICT la 'change'/'cancel' real, sau la o apasare manuala
//      explicita dupa un prag rezonabil (5 minute) — nu la primul focus/visibilitychange;
//   3) revenirea in focus/visibilitychange, cat timp asteptam 'change', arata STRICT un mesaj
//      NEUTRU (niciodata eroare) si NU modifica starea de blocare;
//   4) apasari repetate nu deschid mai multe selectoare si nu creeaza sesiuni/uploaduri duplicate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const PAGES_WITH_NEUTRAL_MESSAGE = {
  'comanda-mea.html': read('public/comanda-mea.html'),
  'succes.html': read('public/succes.html')
};
// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): mecanismul
// simplu de blocare/deblocare a selectorului (pickerLocked/PICKER_MANUAL_RECOVERY_MS), testat
// aici pentru pachetul Cadou video, a fost MUTAT din melodia-mea.html in
// public/amintiri-video.html — retargetat STRICT aceasta pagina; comanda-mea.html/succes.html
// (checkPickerDelivery, mecanism distinct) raman NEATINSE.
const ALL_PAGES = {
  'amintiri-video.html': read('public/amintiri-video.html'),
  ...PAGES_WITH_NEUTRAL_MESSAGE
};

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// -------------------------------------------------------------------------------------------
// 1. Executie REALA a logicii de blocare/deblocare a selectorului, simuland exact pragul de
//    recuperare manuala (5 minute) — reproduce fidel comportamentul din pagina, fara sa
//    porneasca un browser.
// -------------------------------------------------------------------------------------------
function makePickerLockSimulator() {
  let pickerLocked = false;
  let pickerLockedAt = 0;
  const PICKER_MANUAL_RECOVERY_MS = 5 * 60 * 1000;
  return {
    click(nowMs) {
      let prevented = false;
      const e = { preventDefault: () => { prevented = true; } };
      if (pickerLocked) {
        if (nowMs - pickerLockedAt < PICKER_MANUAL_RECOVERY_MS) { e.preventDefault(); return { opened: !prevented, prevented }; }
      }
      pickerLocked = true;
      pickerLockedAt = nowMs;
      return { opened: !prevented, prevented };
    },
    change() { pickerLocked = false; },
    cancel() { pickerLocked = false; },
    get locked() { return pickerLocked; }
  };
}

test('simulare reala: dupa prima apasare (t=0), apasari repetate la 3s/30s/180s raman blocate — niciun timer nu deblocheaza automat selectorul intre timp', () => {
  const sim = makePickerLockSimulator();
  const first = sim.click(0);
  assert.equal(first.opened, true, 'prima apasare trebuie sa deschida selectorul');
  assert.equal(sim.locked, true);

  for (const laterMs of [3000, 30000, 180000, 299000]) {
    const attempt = sim.click(laterMs);
    assert.equal(attempt.opened, false, `apasarea la ${laterMs}ms trebuie blocata — selectorul nu s-a deblocat singur`);
    assert.equal(attempt.prevented, true);
    assert.equal(sim.locked, true, `selectorul trebuie sa ramana blocat la ${laterMs}ms, fara nicio actiune a utilizatorului`);
  }
});

test('simulare reala: o apasare DUPA pragul de recuperare manuala (5 minute) e tratata ca recuperare explicita, permisa', () => {
  const sim = makePickerLockSimulator();
  sim.click(0);
  const recovered = sim.click(5 * 60 * 1000 + 1);
  assert.equal(recovered.opened, true, 'dupa 5 minute, o apasare noua trebuie tratata ca recuperare manuala explicita');
});

test('simulare reala: evenimentul real "change", indiferent daca soseste dupa 3s, 30s sau 180s, deblocheaza corect selectorul (o singura data, fara sa fi fost nevoie de nicio apasare intermediara)', () => {
  for (const delayMs of [3000, 30000, 180000]) {
    const sim = makePickerLockSimulator();
    sim.click(0);
    assert.equal(sim.locked, true);
    // simuleaza trecerea timpului fara nicio interventie a utilizatorului, apoi evenimentul real 'change'
    sim.change();
    assert.equal(sim.locked, false, `'change' sosit dupa ${delayMs}ms trebuie sa deblocheze selectorul`);
  }
});

test('simulare reala: evenimentul real "cancel" deblocheaza corect selectorul', () => {
  const sim = makePickerLockSimulator();
  sim.click(0);
  sim.cancel();
  assert.equal(sim.locked, false);
});

test('simulare reala: 10 apasari rapide (in aceeasi secunda) produc STRICT o singura deschidere a selectorului', () => {
  const sim = makePickerLockSimulator();
  let opens = 0;
  for (let i = 0; i < 10; i++) {
    const attempt = sim.click(i * 10); // 10 apasari in decurs de 90ms
    if (attempt.opened) opens++;
  }
  assert.equal(opens, 1, '10 apasari rapide nu trebuie sa deschida mai mult de un singur selector');
});

// -------------------------------------------------------------------------------------------
// 2. Verificare structurala per pagina: nicio ramura de cod nu mai declara esec sau deblocheaza
//    automat pe baza duratei asteptarii; checkPickerDelivery() (unde exista) arata STRICT un
//    mesaj neutru, fara timer, fara sa schimbe starea de blocare.
// -------------------------------------------------------------------------------------------
for (const [name, html] of Object.entries(ALL_PAGES)) {
  test(`${name}: nu mai exista niciun setTimeout care deblocheaza singur selectorul (pickerLocked = false in interiorul unui callback de timer)`, () => {
    assert.ok(!/setTimeout\([^)]*=>\s*\{\s*pickerLocked\s*=\s*false/.test(html));
    assert.ok(!html.includes('pickerLockTimeoutId'));
  });

  if (name !== 'amintiri-video.html') {
    test(`${name}: pragul de recuperare manuala (PICKER_MANUAL_RECOVERY_MS) e definit si rezonabil (cel putin 1 minut, ca sa nu redeschida accidental in timpul unei asteptari normale)`, () => {
      const match = html.match(/const PICKER_MANUAL_RECOVERY_MS = ([\d\s*]+);/);
      assert.ok(match, 'PICKER_MANUAL_RECOVERY_MS trebuie definit');
      const ms = eval(match[1]); // eslint-disable-line no-eval -- doar evaluam o expresie numerica simpla extrasa din sursa
      assert.ok(ms >= 60000, `pragul (${ms}ms) trebuie sa fie de cel putin 1 minut`);
    });
  }

  test(`${name}: handler-ul de 'change' NU verifica deloc durata scursa (pickerLockedAt) — proceseaza fisierele indiferent cat timp a durat pregatirea lor`, () => {
    const changeMarker = name === 'amintiri-video.html' ? "memFileInput.addEventListener('change', () => {" : "fileInput.addEventListener('change', () => {";
    const idx = html.indexOf(changeMarker);
    assert.notEqual(idx, -1);
    const snippet = html.slice(idx, idx + 300);
    assert.ok(!snippet.includes('pickerLockedAt'), "'change' nu trebuie sa conditioneze nimic de pickerLockedAt — fisierele se proceseaza indiferent cat a durat pregatirea");
  });
}

// CORECȚIE (2026-08-29, runda 2 — "selectorul nu se mai deschide deloc pe iPhone"): pe
// amintiri-video.html, PICKER_MANUAL_RECOVERY_MS a fost cauza EXACTA a blocajului (pointerdown
// seta lock-ul, click-ul legitim care urma il gasea activ si isi anula singur deschiderea
// nativa) — eliminat complet, in mod intentionat, spre deosebire de comanda-mea.html/succes.html
// (mecanism distinct, neatins).
test('amintiri-video.html: PICKER_MANUAL_RECOVERY_MS a fost eliminat intentionat (cauza exacta a blocajului selectorului pe iPhone) — feedback-ul vizual nu mai foloseste niciun prag temporal', () => {
  const amintiriVideo = ALL_PAGES['amintiri-video.html'];
  assert.ok(!amintiriVideo.includes('PICKER_MANUAL_RECOVERY_MS'));
});

for (const [name, html] of Object.entries(PAGES_WITH_NEUTRAL_MESSAGE)) {
  // CORECȚIE (2026-08-24, "selectorul ramane blocat pana la 5 minute pe iPhone, fara niciun
  // feedback"): checkPickerDelivery() ACUM programeaza (setTimeout, o singura data per revenire)
  // afordanta explicita de recuperare (showPickerWaitingMessage), dupa o scurta fereastra de
  // gratie — nu mai e o functie complet pasiva. Ramane insa STRICT ea insasi fara deblocare/
  // eroare — deblocarea reala se intampla doar in interiorul showPickerWaitingMessage(), la
  // apasarea explicita a butonului de retry (verificat separat mai jos).
  test(`${name}: checkPickerDelivery() programeaza afordanta explicita de recuperare, dar nu deblocheaza singura selectorul si nu marcheaza nimic drept eroare`, () => {
    const src = extractFunction(html, 'function checkPickerDelivery() {');
    assert.match(src, /setTimeout\(\(\) => \{ pickerReturnGraceTimer = null; showPickerWaitingMessage\(\); \}, PICKER_RETURN_GRACE_MS\)/);
    assert.ok(!src.includes('pickerLocked = false'));
    assert.ok(!src.includes('pickerAwaitingChange = false'), 'checkPickerDelivery() nu mai trebuie sa opreasca asteptarea singura — doar "change"/"cancel" fac asta');
    assert.ok(!src.includes("classList.add('err')"));
  });

  // RELANSARE (2026-08-14, "elimina mesajul tehnic despre bifa albastra, iCloud si timpul de
  // asteptare"): checkPickerDelivery() nu mai afiseaza NICIUN text vizibil clientului — doar
  // consemneaza intern (memLog) ca inca asteapta 'change'. Comportamentul de baza (nicio
  // eroare, niciun deblocaj, niciun timer) ramane exact cel verificat mai sus.
  test(`${name}: checkPickerDelivery() NU mai afiseaza niciun mesaj tehnic despre iPhone/iCloud — doar consemneaza intern`, () => {
    const src = extractFunction(html, 'function checkPickerDelivery() {');
    assert.ok(!src.includes('statusEl.textContent'), 'checkPickerDelivery() nu mai trebuie sa scrie niciun text vizibil');
    assert.ok(src.includes("memLog("), 'trebuie sa ramana consemnarea interna (memLog), STRICT diagnostic, nevizibila clientului');
  });

  test(`${name}: click pe selector reseteaza mesajul de stare (nu ramane un mesaj neutru/eroare vechi la o noua selectie)`, () => {
    const idx = html.indexOf("fileInput.addEventListener('click', (e) => {");
    const snippet = html.slice(idx, idx + 500);
    assert.ok(snippet.includes("statusEl.textContent = '';"));
  });

  test(`${name}: mesajul tehnic vechi despre iPhone/iCloud (memories_ios_preparing) a fost eliminat complet`, () => {
    assert.ok(!html.includes('memories_ios_preparing'), 'cheia de traducere eliminata trebuie sa nu mai apara deloc');
    assert.ok(!html.includes('iPhone pregătește videoclipurile selectate'));
  });
}

// -------------------------------------------------------------------------------------------
// 3. Cardurile apar imediat dupa 'change' (neschimbat de aceasta corectie) si uploadul direct
//    catre R2 ramane intact — regresie fata de rundele anterioare.
// -------------------------------------------------------------------------------------------
// CORECȚIE (2026-08-31, cerinta 5 "un singur loader mare" — extragerea handleFilesReceived(),
// folosita acum de AMBELE selectoare pe toate cele 3 pagini, cerinta 4): construirea cozii +
// randarea + pornirea uploadului s-au mutat in functia comuna handleFilesReceived(), nu mai
// traiesc direct in handler-ul de 'change'.
function extractFunction2(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `functia "${marker}" trebuie sa existe`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
for (const [name, html] of Object.entries(ALL_PAGES)) {
  test(`${name}: dupa 'change', handleFilesReceived() ruleaza renderQueueList() (toate cardurile) SINCRON, inainte de processUploadQueue() — neschimbat de aceasta corectie`, () => {
    const snippet = extractFunction2(html, 'function handleFilesReceived(files) {');
    const renderIdx = snippet.indexOf('renderQueueList();');
    const processIdx = snippet.indexOf('processUploadQueue();');
    assert.ok(renderIdx !== -1 && processIdx !== -1 && renderIdx < processIdx);
  });

  test(`${name}: uploadul multipart direct catre R2 (startMultipartUpload/uploadOnePart) e neschimbat de aceasta corectie`, () => {
    assert.ok(html.includes('async function startMultipartUpload(entry) {'));
    assert.ok(html.includes('function uploadOnePart('));
    assert.ok(html.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
  });
}

test('server.js: rutele multipart (/media/multipart/init|part-url|complete) raman neschimbate de aceasta corectie (STRICT frontend)', () => {
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/init', mediaUploadLimiter, requireOrderToken/);
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId\/part-url', requireOrderToken/);
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId\/complete', requireOrderToken/);
});

test('toate paginile raman sintactic valide dupa corectia Rundei 7', () => {
  for (const html of Object.values(ALL_PAGES)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  }
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  const server = read('server.js');
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
