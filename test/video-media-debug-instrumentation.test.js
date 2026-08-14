// Round 9 ("STOP orice modificare pe ghicite" — masurare exacta a intervalului dintre
// selectorul nativ iPhone si revenirea paginii): mod de diagnostic STRICT local, activat
// EXCLUSIV prin ?mediaDebug=1, care NU exista si NU influenteaza clientii normali. Nicio
// remediere de comportament nu face parte din aceasta runda — STRICT instrumentare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const PAGES = {
  'melodia-mea.html': read('public/melodia-mea.html'),
  'comanda-mea.html': read('public/comanda-mea.html'),
  'succes.html': read('public/succes.html')
};

const REQUIRED_EVENTS = [
  'file_input_pointerdown', 'file_input_click', 'window_blur', 'visibility_hidden',
  'window_focus', 'pageshow', 'visibility_visible', 'input_event', 'change_event',
  'filelist_snapshot_start', 'filelist_snapshot_complete', 'queue_render_start',
  'queue_dom_inserted', 'queue_first_paint', 'multipart_init_start', 'multipart_init_complete',
  'first_r2_put_start', 'first_r2_progress'
];

for (const [name, html] of Object.entries(PAGES)) {
  test(`${name}: activarea e STRICT prin query param mediaDebug=1, nimic altceva`, () => {
    assert.match(html, /const MEDIA_DEBUG_ENABLED = new URLSearchParams\(location\.search\)\.get\('mediaDebug'\) === '1';/);
  });

  test(`${name}: toate cele 18 evenimente cerute sunt inregistrate`, () => {
    for (const ev of REQUIRED_EVENTS) {
      assert.ok(html.includes(`'${ev}'`), `lipseste evenimentul ${ev} in ${name}`);
    }
  });

  test(`${name}: fiecare eveniment window/document e inregistrat O SINGURA DATA (nu se dubleaza la fiecare re-randare)`, () => {
    // Evenimentele de nivel window/document trebuie inregistrate STRICT in blocul de la
    // nivel de modul (langa definitia mediaDebugLog), nu si in interiorul vreunei functii
    // care se poate re-executa (ex. wireMemoriesEvents() dupa fiecare lookup()).
    const windowFocusRegistrations = (html.match(/addEventListener\('focus', \(\) => mediaDebugLog\('window_focus'\)\)/g) || []).length;
    const windowBlurRegistrations = (html.match(/addEventListener\('blur', \(\) => mediaDebugLog\('window_blur'\)\)/g) || []).length;
    const pageshowRegistrations = (html.match(/addEventListener\('pageshow', \(\) => mediaDebugLog\('pageshow'\)\)/g) || []).length;
    const visibilityRegistrations = (html.match(/mediaDebugLog\(document\.visibilityState === 'visible' \? 'visibility_visible' : 'visibility_hidden'\)/g) || []).length;
    assert.equal(windowFocusRegistrations, 1, `window_focus trebuie inregistrat o singura data in ${name}`);
    assert.equal(windowBlurRegistrations, 1, `window_blur trebuie inregistrat o singura data in ${name}`);
    assert.equal(pageshowRegistrations, 1, `pageshow trebuie inregistrat o singura data in ${name}`);
    assert.equal(visibilityRegistrations, 1, `visibility_visible/hidden trebuie inregistrat o singura data in ${name}`);
  });

  test(`${name}: mediaDebugLog este no-op imediat cand MEDIA_DEBUG_ENABLED e fals`, () => {
    assert.match(html, /function mediaDebugLog\(eventName, extra\) \{\s*if \(!MEDIA_DEBUG_ENABLED\) return;/);
  });

  function mediaDebugModuleSource() {
    const moduleStart = html.indexOf('MEDIA_DEBUG_ENABLED = new URLSearchParams');
    const endMarker = `'visibility_visible' : 'visibility_hidden'`;
    const endIdx = html.indexOf(endMarker, moduleStart);
    const moduleEnd = endIdx > moduleStart ? html.indexOf('}', endIdx) + 1 : moduleStart + 6000;
    return html.slice(moduleStart, moduleEnd);
  }

  test(`${name}: fiecare inregistrare retine STRICT numarul si dimensiunea totala a fisierelor, niciodata nume de fisier`, () => {
    assert.ok(html.includes('filesCount: (extra && typeof extra.filesCount'));
    assert.ok(html.includes('totalBytes: (extra && typeof extra.totalBytes'));
    // Nicaieri in modulul de diagnostic nu se citeste .name de pe un File/Blob pentru logare.
    const moduleSrc = mediaDebugModuleSource();
    assert.ok(!/f\.name|file\.name|\.filename/.test(moduleSrc), `modulul diagnostic din ${name} nu trebuie sa citeasca nume de fisier`);
  });

  test(`${name}: timeline-ul e pastrat STRICT in sessionStorage, cu cheia dedicata`, () => {
    assert.ok(html.includes("const MEDIA_DEBUG_STORAGE_KEY = 'naluna_media_debug_timeline';"));
    assert.ok(html.includes('sessionStorage.setItem(MEDIA_DEBUG_STORAGE_KEY'));
    assert.ok(html.includes('sessionStorage.getItem(MEDIA_DEBUG_STORAGE_KEY)'));
  });

  test(`${name}: panoul de diagnostic exista STRICT cand MEDIA_DEBUG_ENABLED, cu buton "Copiază diagnosticul"`, () => {
    assert.match(html, /function mediaDebugRenderPanel\(\) \{\s*if \(!MEDIA_DEBUG_ENABLED \|\| !document\.body\) return;/);
    assert.ok(html.includes("copyBtn.textContent = 'Copiază diagnosticul';"));
  });

  test(`${name}: nu se creeaza niciun endpoint nou si nu se trimite date catre vreun serviciu extern`, () => {
    const moduleSrc = mediaDebugModuleSource();
    assert.ok(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(moduleSrc), `modulul diagnostic din ${name} nu trebuie sa faca vreo cerere de retea`);
  });

  test(`${name}: build-ul servit e expus prin meta tag, injectat de server (nu hardcodat)`, () => {
    assert.ok(html.includes('<meta name="naluna-build" content="__NALUNA_BUILD__">'));
    assert.ok(html.includes(`document.querySelector('meta[name="naluna-build"]')`));
  });

  test(`${name}: sintaxa scriptului ramane valida dupa instrumentare`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  });
}

// -------------------------------------------------------------------------------------------
// server.js: injectarea build-ului foloseste EXACT cele 3 URL-uri statice existente — nicio
// ruta noua, niciun endpoint nou pentru datele de diagnostic.
// -------------------------------------------------------------------------------------------
test('server.js: injectarea __NALUNA_BUILD__ nu adauga nicio ruta noua, STRICT cele 3 pagini existente', () => {
  const server = read('server.js');
  assert.match(server, /const MEDIA_DEBUG_INJECT_FILES = new Set\(\['\/melodia-mea\.html', '\/comanda-mea\.html', '\/succes\.html'\]\);/);
  assert.ok(server.includes("if (req.method !== 'GET' || !MEDIA_DEBUG_INJECT_FILES.has(req.path)) return next();"));
  assert.ok(!/app\.(get|post|put|delete)\(['"`]\/api\/.*mediaDebug/i.test(server), 'nu trebuie sa existe un endpoint API nou pentru mediaDebug');
});

test('server.js: build-ul injectat vine din RAILWAY_GIT_COMMIT_SHA, cu fallback "dev" local', () => {
  const server = read('server.js');
  assert.match(server, /const MEDIA_DEBUG_BUILD = \(process\.env\.RAILWAY_GIT_COMMIT_SHA \|\| 'dev'\)\.slice\(0, 12\);/);
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium/Video neatinse in aceasta runda', () => {
  const server = read('server.js');
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

// -------------------------------------------------------------------------------------------
// Regresie: uploadul direct catre R2, CORS-ul, timeout-urile si logica de blocare a
// selectorului raman STRICT neschimbate de instrumentarea de diagnostic.
// -------------------------------------------------------------------------------------------
for (const [name, html] of Object.entries(PAGES)) {
  test(`${name}: uploadul multipart direct catre R2 ramane neschimbat`, () => {
    assert.ok(html.includes('async function startMultipartUpload(entry) {'));
    assert.ok(html.includes('function uploadOnePart('));
    assert.ok(html.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
  });

  test(`${name}: logica de blocare/deblocare a selectorului (picker lock) ramane neschimbata`, () => {
    assert.ok(html.includes('const PICKER_MANUAL_RECOVERY_MS = 5 * 60 * 1000;'));
    assert.ok(!html.includes('pickerLockTimeoutId'));
  });

  test(`${name}: mesajul static de asteptare iPhone (Round 8) ramane neschimbat`, () => {
    assert.ok(html.includes('memories_ios_wait_hint'));
  });
}

test('storage.js: functiile multipart/CORS raman neschimbate', () => {
  const storage = read('storage.js');
  assert.ok(storage.includes('async function createPrivateMultipartUpload('));
  assert.ok(storage.includes('async function checkUploadCors('));
});
