// UI-ul Social Media din Naluna Admin (private/admin.html, Etapa 4) — admin.html nu poate fi
// executat intr-un DOM real (fara jsdom/puppeteer in acest proiect — vezi restul suitei, care
// testeaza fisierele HTML fie structural (text/regex), fie prin extragerea unei functii PURE
// din scriptul inline si evaluarea ei izolat cu new Function(), exact tiparul din
// test/wizard-step-renumbering.test.js). Functiile de business logic din sectiunea Social Media
// au fost scrise intentionat PURE (fara acces direct la DOM) tocmai ca sa poata fi testate asa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(source, signature, fromIndex) {
  const idx = source.indexOf(signature, fromIndex || 0);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return { text: source.slice(idx, i + 1), endIndex: i + 1 };
}

// Incarca TOATE functiile pure ale sectiunii Social Media intr-un sandbox izolat — de la
// declararea PLATFORM_DEFS pana la finalul lui renderSubmitResultMessage (ultima functie pura
// din bloc), fara nimic legat de DOM.
function loadSocialAdminLogic() {
  const startIdx = html.indexOf('const PLATFORM_DEFS = [');
  assert.notEqual(startIdx, -1, 'PLATFORM_DEFS trebuie sa existe in admin.html');
  const renderSubmitResult = extractFn(html, 'function renderSubmitResultMessage(data) {', startIdx);
  const snippet = html.slice(startIdx, renderSubmitResult.endIndex);
  const sandboxSrc = `
    ${snippet}
    return { PLATFORM_DEFS, STATUS_LABELS, SOCIAL_MEDIA_LIMITS, validateSmForm, computeSmStats, matchesSmFilter, getSmContextualActions, redactSecrets, captionFragment, renderSubmitResultMessage };
  `;
  return new Function(sandboxSrc)();
}
const sm = loadSocialAdminLogic();

// ============================================================================
// Sincronizare cu limitele REALE ale backend-ului (server.js) — daca cineva schimba
// SOCIAL_MEDIA_MIME_TYPES/SOCIAL_MEDIA_MAX_BYTES in server.js fara sa actualizeze si
// SOCIAL_MEDIA_LIMITS din admin.html, validarea client-side ar da un feedback GRESIT
// (accepta/respinge altceva decat accepta/respinge serverul) — acest test prinde divergenta.
// ============================================================================
test('SOCIAL_MEDIA_LIMITS (admin.html) e IDENTIC cu SOCIAL_MEDIA_MIME_TYPES/SOCIAL_MEDIA_MAX_BYTES (server.js)', () => {
  const mimeMatch = server.match(/const SOCIAL_MEDIA_MIME_TYPES = \{([\s\S]*?)\};/);
  assert.ok(mimeMatch, 'SOCIAL_MEDIA_MIME_TYPES trebuie sa existe in server.js');
  const imageTypes = [...mimeMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(t => t.startsWith('image/'));
  const videoTypes = [...mimeMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(t => t.startsWith('video/'));
  assert.deepEqual(sm.SOCIAL_MEDIA_LIMITS.image.types, imageTypes);
  assert.deepEqual(sm.SOCIAL_MEDIA_LIMITS.video.types, videoTypes);

  const maxBytesMatch = server.match(/const SOCIAL_MEDIA_MAX_BYTES = ([^;]+);/);
  assert.ok(maxBytesMatch);
  // eslint-disable-next-line no-eval
  const serverMaxBytes = eval(maxBytesMatch[1]);
  assert.equal(sm.SOCIAL_MEDIA_LIMITS.image.maxBytes, serverMaxBytes);
  assert.equal(sm.SOCIAL_MEDIA_LIMITS.video.maxBytes, serverMaxBytes);
});

// ============================================================================
// PLATFORM_DEFS — pregatire pentru scalare (TikTok etc.)
// ============================================================================
test('PLATFORM_DEFS contine exact Facebook si Instagram (structura declarativa, nu hardcodata)', () => {
  const ids = sm.PLATFORM_DEFS.map(p => p.id);
  assert.deepEqual(ids, ['facebook', 'instagram']);
});

// ============================================================================
// validateSmForm — selectare platforme, validare formular, upload, programare in trecut
// ============================================================================
function validFields(overrides) {
  return Object.assign({
    platforms: ['facebook'], hasFile: true, fileType: 'image/jpeg', fileSize: 1000,
    mediaType: 'image', captionLength: 10, mode: 'now', scheduledAtMs: null, nowMs: Date.now()
  }, overrides);
}

test('validateSmForm: cerere valida (Post Now) -> null', () => {
  assert.equal(sm.validateSmForm(validFields()), null);
});

test('validateSmForm: nicio platforma selectata -> eroare', () => {
  assert.match(sm.validateSmForm(validFields({ platforms: [] })), /platformă/);
});

test('validateSmForm: fara fisier -> eroare', () => {
  assert.match(sm.validateSmForm(validFields({ hasFile: false })), /fișier media/);
});

test('validateSmForm: format neacceptat (upload) -> eroare', () => {
  assert.match(sm.validateSmForm(validFields({ fileType: 'image/gif' })), /Format neacceptat/);
});

test('validateSmForm: fisier peste limita de dimensiune (upload) -> eroare', () => {
  const err = sm.validateSmForm(validFields({ fileSize: 61 * 1024 * 1024 }));
  assert.match(err, /depășește limita/);
});

test('validateSmForm: video valid trece daca fileType/mediaType corespund', () => {
  assert.equal(sm.validateSmForm(validFields({ mediaType: 'video', fileType: 'video/mp4' })), null);
});

test('validateSmForm: caption peste 2200 caractere -> eroare', () => {
  assert.match(sm.validateSmForm(validFields({ captionLength: 2201 })), /Caption prea lung/);
});

test('validateSmForm: caption exact 2200 caractere -> valid (limita existenta, nu mai stransa)', () => {
  assert.equal(sm.validateSmForm(validFields({ captionLength: 2200 })), null);
});

test('validateSmForm: Schedule fara data/ora -> eroare', () => {
  const err = sm.validateSmForm(validFields({ mode: 'schedule', scheduledAtMs: NaN }));
  assert.match(err, /data și ora/);
});

test('validateSmForm: programare in TRECUT e respinsa', () => {
  const now = Date.now();
  const err = sm.validateSmForm(validFields({ mode: 'schedule', scheduledAtMs: now - 60000, nowMs: now }));
  assert.match(err, /viitor/);
});

test('validateSmForm: programare in viitor e acceptata', () => {
  const now = Date.now();
  const err = sm.validateSmForm(validFields({ mode: 'schedule', scheduledAtMs: now + 60 * 60 * 1000, nowMs: now }));
  assert.equal(err, null);
});

// ============================================================================
// Rezultat Post Now — succes ambele platforme / succes partial / esec
// ============================================================================
test('renderSubmitResultMessage: succes pe ambele platforme', () => {
  const msg = sm.renderSubmitResultMessage({
    post: { status: 'published', platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'success' }
  });
  assert.match(msg, /Facebook: succes/);
  assert.match(msg, /Instagram: succes/);
});

test('renderSubmitResultMessage: succes partial — un mesaj clar pentru fiecare platforma', () => {
  const msg = sm.renderSubmitResultMessage({
    post: { status: 'partially_failed', platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'error' }
  });
  assert.match(msg, /Facebook: succes/);
  assert.match(msg, /Instagram: eroare/);
});

test('renderSubmitResultMessage: esec total', () => {
  const msg = sm.renderSubmitResultMessage({
    post: { status: 'failed', platforms: ['facebook'], facebookStatus: 'error' }
  });
  assert.match(msg, /Facebook: eroare/);
});

test('renderSubmitResultMessage: postare programata -> mesaj distinct, fara "succes"/"eroare" per platforma', () => {
  const msg = sm.renderSubmitResultMessage({
    post: { status: 'scheduled', scheduledAt: new Date().toISOString(), platforms: ['facebook'] }
  });
  assert.match(msg, /Programată cu succes/);
});

test('renderSubmitResultMessage: duplicat detectat -> mesaj distinct, nicio confuzie cu un succes nou', () => {
  const msg = sm.renderSubmitResultMessage({ duplicate: true, post: { status: 'published', platforms: [] } });
  assert.match(msg, /deja trimisă/);
});

// ============================================================================
// computeSmStats / matchesSmFilter — afisarea statusurilor in dashboard si lista
// ============================================================================
test('computeSmStats: numara corect scheduled/published/needs-attention', () => {
  const posts = [
    { status: 'scheduled' }, { status: 'scheduled' },
    { status: 'published' },
    { status: 'failed' }, { status: 'partially_failed' },
    { status: 'draft' }, { status: 'cancelled' }, { status: 'publishing' }
  ];
  const stats = sm.computeSmStats(posts);
  assert.deepEqual(stats, { scheduled: 2, published: 1, attention: 2 });
});

test('matchesSmFilter: "attention" acopera STRICT failed + partially_failed', () => {
  assert.equal(sm.matchesSmFilter({ status: 'failed' }, 'attention'), true);
  assert.equal(sm.matchesSmFilter({ status: 'partially_failed' }, 'attention'), true);
  assert.equal(sm.matchesSmFilter({ status: 'published' }, 'attention'), false);
  assert.equal(sm.matchesSmFilter({ status: 'cancelled' }, 'attention'), false);
});

test('matchesSmFilter: "all" accepta orice status', () => {
  for (const status of Object.keys(sm.STATUS_LABELS)) {
    assert.equal(sm.matchesSmFilter({ status }, 'all'), true);
  }
});

test('STATUS_LABELS acopera toate cele 7 statusuri cerute', () => {
  assert.deepEqual(Object.keys(sm.STATUS_LABELS).sort(), [
    'cancelled', 'draft', 'failed', 'partially_failed', 'published', 'publishing', 'scheduled'
  ].sort());
});

test('CSS: exista un badge vizual distinct pentru fiecare din cele 7 statusuri', () => {
  for (const status of Object.keys(sm.STATUS_LABELS)) {
    assert.ok(html.includes(`.sm-s-${status}{`), `lipseste clasa CSS .sm-s-${status}`);
  }
});

// ============================================================================
// Retry — doar platforma esuata, niciodata o platforma deja publicata cu succes
// ============================================================================
test('getSmContextualActions: succes partial -> retry DOAR pentru platforma esuata (Instagram)', () => {
  const post = { status: 'partially_failed', platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'error' };
  const actions = sm.getSmContextualActions(post);
  const ids = actions.map(a => a.id);
  assert.ok(ids.includes('retry:instagram'));
  assert.ok(!ids.includes('retry:facebook'), 'Facebook a reusit deja — NU trebuie sa apara vreo actiune de retry pentru el');
});

test('getSmContextualActions: simetric — Instagram reusit, retry doar pentru Facebook', () => {
  const post = { status: 'partially_failed', platforms: ['facebook', 'instagram'], facebookStatus: 'error', instagramStatus: 'success' };
  const ids = sm.getSmContextualActions(post).map(a => a.id);
  assert.ok(ids.includes('retry:facebook'));
  assert.ok(!ids.includes('retry:instagram'));
});

test('getSmContextualActions: postare COMPLET publicata -> nicio actiune de retry disponibila', () => {
  const post = { status: 'published', platforms: ['facebook', 'instagram'], facebookStatus: 'success', instagramStatus: 'success' };
  assert.deepEqual(sm.getSmContextualActions(post), []);
});

test('getSmContextualActions: scheduled -> STRICT actiunea Cancel Schedule, fara retry', () => {
  const post = { status: 'scheduled', platforms: ['facebook'], facebookStatus: null, instagramStatus: null };
  const actions = sm.getSmContextualActions(post);
  assert.deepEqual(actions.map(a => a.id), ['cancel']);
});

test('getSmContextualActions: postare publicata NU ofera niciodata Cancel Schedule', () => {
  const post = { status: 'published', platforms: ['facebook'], facebookStatus: 'success', instagramStatus: null };
  const ids = sm.getSmContextualActions(post).map(a => a.id);
  assert.ok(!ids.includes('cancel'));
});

// ============================================================================
// Sanitizarea erorilor la afisare
// ============================================================================
test('redactSecrets: mascheaza secvente lungi alfanumerice (potential token), pastreaza mesajul lizibil', () => {
  const masked = sm.redactSecrets('Invalid OAuth access token: EAABsbCS1iHgBAaaaaaaaaaaaaaaaaaaaaaaaaZZZZ expired');
  assert.ok(!masked.includes('EAABsbCS1iHgBAaaaaaaaaaaaaaaaaaaaaaaaaZZZZ'));
  assert.match(masked, /Invalid OAuth access token/);
  assert.match(masked, /expired/);
});

test('redactSecrets: mesaj normal, fara token, ramane neschimbat', () => {
  assert.equal(sm.redactSecrets('Media container creation failed'), 'Media container creation failed');
});

test('redactSecrets: gol/null nu arunca', () => {
  assert.equal(sm.redactSecrets(null), '');
  assert.equal(sm.redactSecrets(undefined), '');
});

test('captionFragment: trunchiaza la 90 caractere cu elipsa', () => {
  const long = 'x'.repeat(150);
  const frag = sm.captionFragment(long);
  assert.equal(frag.length, 91); // 90 + '…'
  assert.ok(frag.endsWith('…'));
});

test('captionFragment: caption gol -> text placeholder, nu string gol', () => {
  assert.equal(sm.captionFragment(''), '(fără caption)');
  assert.equal(sm.captionFragment(null), '(fără caption)');
});

// ============================================================================
// Structura HTML — Create Post, dashboard, filtre
// ============================================================================
test('admin.html: sectiunea Social Media exista, cu dashboard-ul cerut (Scheduled/Published/Needs Attention)', () => {
  assert.match(html, /Social Media/);
  assert.match(html, /id="sm-stat-scheduled"/);
  assert.match(html, /id="sm-stat-published"/);
  assert.match(html, /id="sm-stat-attention"/);
});

test('admin.html: formularul Create Post are camp de platforme, media, caption cu limita 2200', () => {
  assert.match(html, /id="sm-platform-row"/);
  assert.match(html, /id="sm-media-type"/);
  assert.match(html, /id="sm-media-file"/);
  assert.match(html, /id="sm-caption"[^>]*maxlength="2200"/);
});

test('admin.html: campurile de Schedule (data, ora, nota fus orar) exista', () => {
  assert.match(html, /type="date" id="sm-schedule-date"/);
  assert.match(html, /type="time" id="sm-schedule-time"/);
  assert.match(html, /id="sm-tz-note"/);
});

test('admin.html: filtrele din lista (Toate/Scheduled/Published/Failed) exista', () => {
  assert.match(html, /data-status="scheduled"/);
  assert.match(html, /data-status="published"/);
  assert.match(html, /data-status="attention"/);
});

// ============================================================================
// Endpoint-uri folosite — trebuie sa fie EXACT cele existente din Etapele 2-3, niciun endpoint nou
// ============================================================================
test('admin.html foloseste STRICT endpoint-urile existente /api/admin/social/*', () => {
  assert.match(html, /fetch\('\/api\/admin\/social\/posts\?limit=100'\)/);
  assert.match(html, /url = '\/api\/admin\/social\/publish'/);
  assert.match(html, /url = '\/api\/admin\/social\/schedule'/);
  assert.match(html, /fetch\(`\/api\/admin\/social\/posts\/\$\{postId\}\/cancel`/);
  assert.match(html, /fetch\(`\/api\/admin\/social\/posts\/\$\{postId\}\/retry`/);
});

// ============================================================================
// IdempotencyKey + prevenirea submit-ului multiplu
// ============================================================================
test('submit handler: genereaza idempotencyKey cu crypto.randomUUID() la fiecare trimitere REALA', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  assert.notEqual(start, -1);
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  assert.match(handler, /crypto\.randomUUID\(\)/);
  assert.match(handler, /idempotencyKey/);
});

test('submit handler: verifica butonul dezactivat INAINTE de orice alta logica (guard sincron impotriva dublu-click)', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  const guardIdx = handler.indexOf('if (smSubmitBtn.disabled) return;');
  const validateIdx = handler.indexOf('validateSmForm(');
  const disableIdx = handler.indexOf('smSubmitBtn.disabled = true;');
  assert.ok(guardIdx !== -1 && validateIdx !== -1 && disableIdx !== -1);
  assert.ok(guardIdx < validateIdx, 'guard-ul trebuie verificat INAINTE de validare');
  assert.ok(validateIdx < disableIdx, 'butonul se dezactiveaza DUPA validare/confirmare, nu inainte');
});

test('submit handler: reactiveaza butonul in finally (nu ramane blocat la eroare)', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  const finallyIdx = handler.lastIndexOf('finally');
  assert.notEqual(finallyIdx, -1);
  const finallyBlock = handler.slice(finallyIdx);
  assert.match(finallyBlock, /smSubmitBtn\.disabled = false/);
});

test('submit handler: NU face niciun retry automat de fetch (o singura cerere per submit)', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  const fetchCalls = handler.match(/await fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, 'trebuie sa existe STRICT un singur apel fetch in handler-ul de submit');
});

// ============================================================================
// Confirmari explicite (Post Now / Cancel Schedule / Retry)
// ============================================================================
test('confirmare explicita inainte de Post Now/Schedule, cu platformele mentionate clar', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  assert.match(handler, /confirm\(confirmMsg\)/);
  assert.match(handler, /platformLabels/);
});

test('confirmare explicita inainte de Cancel Schedule', () => {
  const start = html.indexOf('async function handleSmAction(postId, actionId) {');
  const fn = extractFn(html, 'async function handleSmAction(postId, actionId) {', start).text;
  const cancelBranch = fn.slice(0, fn.indexOf("actionId.startsWith('retry:')"));
  assert.match(cancelBranch, /confirm\('Anulezi programarea/);
});

test('confirmare explicita inainte de Retry manual', () => {
  const start = html.indexOf('async function handleSmAction(postId, actionId) {');
  const fn = extractFn(html, 'async function handleSmAction(postId, actionId) {', start).text;
  const retryBranch = fn.slice(fn.indexOf("actionId.startsWith('retry:')"));
  assert.match(retryBranch, /confirm\(`Reîncerci publicarea pe/);
});

// ============================================================================
// Nu expune secrete — nicaieri in sectiunea Social Media nu apare vreun camp de tip token
// ============================================================================
test('SECURITATE: sectiunea Social Media nu citeste/afiseaza niciodata accessToken/stack/apiError brut', () => {
  const start = html.indexOf('SOCIAL MEDIA (Etapa 4)');
  const section = html.slice(start);
  assert.ok(!/accessToken/i.test(section));
  assert.ok(!/\.stack\b/.test(section));
  assert.ok(!/apiError/.test(section), 'trebuie afisat STRICT post.facebookError/instagramError (deja sanitizate de backend), niciodata obiectul brut apiError');
});

// ============================================================================
// Auto-refresh — interval rezonabil, oprit cand tab-ul nu e activ
// ============================================================================
test('auto-refresh: interval rezonabil (>= 5s), verifica document.visibilityState inainte de fiecare reimprospatare', () => {
  const start = html.indexOf('function startSmPolling()');
  const fn = extractFn(html, 'function startSmPolling() {', start).text;
  assert.match(fn, /document\.visibilityState === 'visible'/);
  const intervalMatch = html.match(/const SM_POLL_INTERVAL_MS = (\d+)/);
  assert.ok(intervalMatch);
  assert.ok(Number(intervalMatch[1]) >= 5000, 'polling-ul nu trebuie sa fie mai agresiv de o data la 5 secunde');
});

test('auto-refresh: reactioneaza la revenirea pe tab (visibilitychange), fara sa astepte urmatorul tick', () => {
  assert.match(html, /addEventListener\('visibilitychange'/);
});

// ============================================================================
// CSP — descoperit in timpul Etapei 4: /admin nu avea NICIUN hash de script inregistrat
// (loadPageScriptHashes scana STRICT public/, admin.html traieste in private/), ceea ce ar fi
// blocat COMPLET scriptul inline al admin.html sub politica CSP existenta (server.js aplica
// helmet cu contentSecurityPolicy: buildCspDirectives() global, inclusiv pe /admin). Corectat
// in lib/csp.js. Teste de regresie pentru ambele jumatati ale corectiei:
// (1) /admin primeste acum un hash real pentru blocul <script>;
// (2) elementele generate dinamic in sectiunea Social Media NU folosesc onclick="" inline —
//     un hash de <script> NU acopera atribute de eveniment inline, care raman blocate de CSP
//     fara 'unsafe-inline'; de-aceea interactivitatea foloseste STRICT delegare de evenimente.
// ============================================================================
test('CSP: scriptHashesForPath("/admin") intoarce un hash real, nu mai e gol', () => {
  const { scriptHashesForPath } = require('../lib/csp');
  const hash = scriptHashesForPath('/admin');
  assert.notEqual(hash, '');
  assert.match(hash, /^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test('CSP: hash-ul pentru /admin corespunde EXACT continutului real al blocului <script> din admin.html', () => {
  const { scriptHashesForPath } = require('../lib/csp');
  const crypto = require('node:crypto');
  const scriptMatch = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch);
  const expectedHash = `'sha256-${crypto.createHash('sha256').update(scriptMatch[1], 'utf8').digest('base64')}'`;
  assert.equal(scriptHashesForPath('/admin'), expectedHash);
});

test('REGRESIE CSP: sectiunea Social Media nu foloseste niciun atribut onclick="" inline (blocat de CSP fara unsafe-inline)', () => {
  const start = html.indexOf('SOCIAL MEDIA (Etapa 4)');
  const end = html.indexOf('</script>', start);
  const codeOnly = html.slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//')) // exclude comentariile care doar MENTIONEAZA cuvantul, ca in acest fisier de teste
    .join('\n');
  assert.ok(!/\bonclick\s*=\s*"/.test(codeOnly), 'interactivitatea trebuie sa foloseasca STRICT delegare de evenimente (addEventListener), nu onclick="" inline');
});

test('REGRESIE CSP (audit pre-deploy): admin.html INTREG — inclusiv testimonialele preexistente — nu mai are niciun onclick="" inline', () => {
  const codeOnly = html
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/\bonclick\s*=\s*"/.test(codeOnly), 'admin.html nu mai trebuie sa contina onclick="" inline nicaieri, testimoniale incluse');
});

test('testimoniale: move up/down, edit, delete folosesc delegare de evenimente pe #t-list, cu payload din data-atribute', () => {
  assert.match(html, /data-t-action="move-up"/);
  assert.match(html, /data-t-action="move-down"/);
  assert.match(html, /data-t-action="edit"/);
  assert.match(html, /data-t-action="delete"/);
  assert.match(html, /tList\.addEventListener\('click'/);
});

test('testimoniale: fix-ul CSP nu schimba comportamentul functional (aceleasi 3 functii, acelasi efect: edit populeaza formularul, delete confirma+sterge, move trimite directia)', () => {
  const start = html.indexOf('window.editTestimonial = function(id)');
  assert.notEqual(start, -1);
  const end = html.indexOf('tList.addEventListener', start);
  const block = html.slice(start, end);
  assert.match(block, /tEditId\.value = t\.id/);
  assert.match(block, /confirm\('Ștergi definitiv această reacție\?'\)/);
  assert.match(block, /body: JSON\.stringify\(\{ direction \}\)/);
});

test('interactivitatea din carduri/modal foloseste delegare de evenimente pe containere stabile', () => {
  assert.match(html, /document\.getElementById\('sm-list'\)\.addEventListener\('click'/);
  assert.match(html, /document\.getElementById\('sm-modal-root'\)\.addEventListener\('click'/);
});

// ============================================================================
// CSRF (audit pre-deploy): protectia existenta in server.js (middleware /api/admin/*, cere
// header X-Requested-With pe orice request mutativ) trebuie respectata de TOATE cele 4
// actiuni mutative Social Media — publish, schedule, cancel, retry. Fara acest header,
// serverul respinge cererea cu 403, indiferent cat de corecta e restul cererii.
// ============================================================================
test('CSRF: Post Now / Schedule (fetch(url, ...)) trimite X-Requested-With: XMLHttpRequest', () => {
  const start = html.indexOf("document.getElementById('sm-form').addEventListener('submit'");
  const handler = extractFn(html, "addEventListener('submit', async (e) => {", start).text;
  assert.match(handler, /fetch\(url,\s*\{\s*method:\s*'POST',\s*headers:\s*\{\s*'X-Requested-With':\s*'XMLHttpRequest'\s*\},\s*body:\s*fd\s*\}\)/);
});

test('CSRF: Cancel Schedule trimite X-Requested-With: XMLHttpRequest', () => {
  const start = html.indexOf('async function handleSmAction(postId, actionId) {');
  const fn = extractFn(html, 'async function handleSmAction(postId, actionId) {', start).text;
  const cancelBranch = fn.slice(0, fn.indexOf("actionId.startsWith('retry:')"));
  assert.match(cancelBranch, /fetch\(`\/api\/admin\/social\/posts\/\$\{postId\}\/cancel`,\s*\{\s*method:\s*'POST',\s*headers:\s*\{\s*'X-Requested-With':\s*'XMLHttpRequest'\s*\}\s*\}\)/);
});

test('CSRF: Retry manual trimite X-Requested-With: XMLHttpRequest (alaturi de Content-Type existent)', () => {
  const start = html.indexOf('async function handleSmAction(postId, actionId) {');
  const fn = extractFn(html, 'async function handleSmAction(postId, actionId) {', start).text;
  const retryBranch = fn.slice(fn.indexOf("actionId.startsWith('retry:')"));
  assert.match(retryBranch, /headers:\s*\{\s*'Content-Type':\s*'application\/json',\s*'X-Requested-With':\s*'XMLHttpRequest'\s*\}/);
});

test('CSRF: GET-urile Social Media (lista postarilor) NU au fost modificate inutil — fara header CSRF pe cereri de citire', () => {
  assert.match(html, /await fetch\('\/api\/admin\/social\/posts\?limit=100'\);/);
});

test('CSRF: middleware-ul din server.js chiar exista si se aplica inaintea rutelor social (nu doar presupus)', () => {
  const csrfIdx = server.indexOf("if (req.get('X-Requested-With') !== 'XMLHttpRequest')");
  const routeIdx = server.indexOf("app.post('/api/admin/social/publish'");
  assert.notEqual(csrfIdx, -1, 'middleware-ul CSRF trebuie sa existe in server.js');
  assert.ok(csrfIdx < routeIdx, 'middleware-ul CSRF trebuie inregistrat INAINTE de rutele social, ca sa li se aplice');
});
