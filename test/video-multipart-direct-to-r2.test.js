// Runda 6 (2026-08-14), "codul live nu demonstreaza un upload multipart direct din browser
// catre R2 — pentru un videoclip de 500MB rezulta ~84 de cereri succesive [prin Railway]" —
// dovada explicita a clientului, dupa ce a inspectat codul live: mecanismul din Runda 5
// (upload "fragmentat") inca retransmitea INTREGUL continut video prin acest server (Railway),
// doar in bucati mai mici, secvential. Acest fisier verifica STRUCTURAL ca inlocuirea e reala:
// fragmentele video mari se trimit acum DIRECT catre R2, printr-un PUT catre un URL semnat,
// niciodata printr-o ruta a acestui server; Railway ramane STRICT pentru autorizare, initiere
// si finalizare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// CORECȚIE (2026-08-29, "pagina separata pentru selectarea si incarcarea media"): uploaderul
// multipart direct-catre-R2 testat aici pentru pachetul Cadou video a fost MUTAT din
// melodia-mea.html in public/amintiri-video.html — retargetat STRICT aceasta pagina;
// comanda-mea.html si succes.html au propriile copii NEATINSE ale aceluiasi mecanism, folosite
// de fluxuri complet distincte (neschimbate in aceasta corectie).
const PAGES = {
  'amintiri-video.html': read('public/amintiri-video.html'),
  'comanda-mea.html': read('public/comanda-mea.html'),
  'succes.html': read('public/succes.html')
};
const server = read('server.js');
const storage = read('storage.js');

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

for (const [name, html] of Object.entries(PAGES)) {
  // -----------------------------------------------------------------------------------------
  // 1. Nicio urma a mecanismului vechi (relansat prin Railway) — dispatcher-ul foloseste acum
  //    multipart direct pentru videoclipurile mari.
  // -----------------------------------------------------------------------------------------
  test(`${name}: mecanismul vechi de relansare prin server (chunked) nu mai exista in cod`, () => {
    assert.ok(!/chunked/i.test(html), `${name} nu mai trebuie sa contina nicio referinta la mecanismul de upload "chunked" (relansat prin Railway)`);
  });

  test(`${name}: startUpload() foloseste uploadul multipart direct STRICT pentru videoclipuri peste MEM_MULTIPART_THRESHOLD_BYTES, restul prin startSingleUpload`, () => {
    const src = extractFunction(html, 'function startUpload(entry) {');
    assert.ok(src.includes('isVideoFile(entry.file) && entry.file.size > MEM_MULTIPART_THRESHOLD_BYTES'));
    assert.ok(src.includes('startMultipartUpload(entry)'));
  });

  test(`${name}: MEM_MULTIPART_THRESHOLD_BYTES (client) e IDENTIC cu ORDER_MEDIA_MULTIPART_THRESHOLD_BYTES (server) — 20MB`, () => {
    assert.ok(html.includes('const MEM_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;'));
  });

  // -----------------------------------------------------------------------------------------
  // 2. Fragmentele merg DIRECT catre R2 — PUT catre URL-ul semnat intors de server, nu catre
  //    o ruta a acestui server; niciun header al aplicatiei (X-Access-Token) nu se trimite pe
  //    acel PUT (autentificarea e STRICT prin semnatura din URL).
  // -----------------------------------------------------------------------------------------
  test(`${name}: uploadOnePart() cere STRICT un URL semnat de la server, apoi face PUT DIRECT catre acel URL (nu catre o ruta a acestui server)`, () => {
    const src = extractFunction(html, 'function uploadOnePart(');
    assert.ok(src.includes('/media/multipart/${entry.multipartSessionId}/part-url'), 'trebuie sa ceara un URL semnat de la server, per fragment');
    assert.ok(src.includes("xhr.open('PUT', urlData.url)"), 'PUT-ul efectiv trebuie sa mearga catre URL-ul semnat intors de server, nu catre server');
    assert.ok(!/\/media\/multipart\/\$\{entry\.multipartSessionId\}\/chunk/.test(src), 'nu mai trebuie sa existe nicio ruta de tip "chunk" pe acest server');
  });

  test(`${name}: PUT-ul direct catre R2 NU trimite niciun header al aplicatiei (X-Access-Token) — autentificarea e STRICT prin semnatura din URL`, () => {
    const src = extractFunction(html, 'function uploadOnePart(');
    const putIdx = src.indexOf("xhr.open('PUT', urlData.url)");
    const sendIdx = src.indexOf('xhr.send(blob)', putIdx);
    assert.notEqual(putIdx, -1);
    assert.notEqual(sendIdx, -1);
    const between = src.slice(putIdx, sendIdx);
    assert.ok(!between.includes('X-Access-Token'), 'PUT-ul direct catre R2 nu trebuie sa poarte token-ul de acces al aplicatiei');
  });

  test(`${name}: ETag-ul fragmentului e citit din raspunsul R2 (header expus prin CORS) — necesar la finalizare`, () => {
    const src = extractFunction(html, 'function uploadOnePart(');
    assert.ok(src.includes("xhr.getResponseHeader('ETag')"));
  });

  // CORECȚIE (2026-08-30, "IMG_6810.mov — Încărcarea a eșuat"): inainte, un PUT reusit (2xx) fara
  // ETag citibil in raspuns (CORS-ul bucket-ului nu expune header-ul ETag) era tratat STRICT ca
  // esec, reincercand la nesfarsit ACELASI PUT — inutil, pentru ca problema nu e tranzitorie.
  // Acum, un asemenea caz apeleaza intai fallback-ul server-side (independent de CORS) inainte
  // sa reincerce PUT-ul insusi.
  test(`${name}: un PUT reusit (2xx) FARA ETag in raspuns apeleaza fallback-ul server-side (independent de CORS) inainte sa reincerce PUT-ul`, () => {
    const src = extractFunction(html, 'function uploadOnePart(');
    assert.match(src, /fetchPartEtagFallback\w*\(/, 'trebuie sa incerce fallback-ul server-side cand ETag lipseste din raspunsul PUT');
    assert.ok(!src.includes('if (!etag) { retryOrFail(); return; }'), 'nu mai trebuie sa reincerce ORB PUT-ul la un ETag lipsa — fallback-ul are prioritate');
  });

  test(`${name}: fetchPartEtagFallback() apeleaza noul endpoint server-side GET .../part-etag, cu token de acces, si intoarce null (nu arunca) daca fragmentul chiar nu exista inca la R2`, () => {
    const fnSrc = extractFunction(html, 'async function fetchPartEtagFallback(');
    assert.ok(fnSrc.includes('/media/multipart/${') && fnSrc.includes('}/part-etag?partNumber=${partNumber}'));
    assert.match(fnSrc, /'X-Access-Token': (accessToken|currentToken)/);
    assert.ok(fnSrc.includes('if (!res.ok) return null;'));
  });

  // -----------------------------------------------------------------------------------------
  // 3. Maximum 2 fragmente simultan (nu strict secvential, nu nelimitat), niciodata base64/
  //    FileReader/arrayBuffer() pe fisierul intreg.
  // -----------------------------------------------------------------------------------------
  test(`${name}: MEM_MAX_PARALLEL_PARTS = 2 — maximum doua fragmente simultan, masurabil si configurabil`, () => {
    assert.ok(html.includes('const MEM_MAX_PARALLEL_PARTS = 2;'));
    const src = extractFunction(html, 'async function startMultipartUpload(entry) {');
    assert.ok(src.includes('active < MEM_MAX_PARALLEL_PARTS'));
  });

  test(`${name}: startMultipartUpload() foloseste Blob.slice() pentru fragmente — niciodata FileReader.readAsDataURL, niciodata arrayBuffer() pe fisierul intreg, niciodata conversie base64`, () => {
    const src = extractFunction(html, 'async function startMultipartUpload(entry) {');
    assert.ok(src.includes('entry.file.slice('));
    assert.ok(!src.includes('readAsDataURL'));
    assert.ok(!src.includes('.arrayBuffer()'));
    assert.ok(!/btoa\(|base64/i.test(src));
  });

  test(`${name}: fragmentele NU se trimit strict unul cate unul — pump() porneste pana la MEM_MAX_PARALLEL_PARTS deodata, nu asteapta un fragment sa termine inainte sa inceapa urmatorul`, () => {
    const src = extractFunction(html, 'async function startMultipartUpload(entry) {');
    assert.ok(/while\s*\(\s*active\s*<\s*MEM_MAX_PARALLEL_PARTS\s*&&\s*nextPartNumber\s*<=\s*totalParts\s*\)/.test(src), 'trebuie sa porneasca fragmente in paralel, nu un while sincron pe un singur fragment');
  });

  // -----------------------------------------------------------------------------------------
  // 4. Retry STRICT per fragment (nu de la inceputul fisierului), finalizare o singura data,
  //    dupa TOATE fragmentele.
  // -----------------------------------------------------------------------------------------
  test(`${name}: uploadOnePart() reincearca STRICT fragmentul esuat, cu limita si backoff — niciodata reluare de la inceputul fisierului`, () => {
    const src = extractFunction(html, 'function uploadOnePart(');
    assert.ok(src.includes('MEM_PART_RETRY_LIMIT'));
    assert.ok(src.includes('setTimeout(tryOnce,'));
  });

  test(`${name}: finalizarea (complete) e apelata o singura data, dupa ce TOATE fragmentele au fost confirmate — trimite lista partilor (partNumber+etag), sortata`, () => {
    const src = extractFunction(html, 'async function startMultipartUpload(entry) {');
    const pumpIdx = src.indexOf('const completedParts = await new Promise');
    const completeIdx = src.indexOf('/complete`', pumpIdx);
    assert.ok(pumpIdx !== -1 && completeIdx !== -1 && completeIdx > pumpIdx, 'finalizarea trebuie sa vina STRICT dupa ce toate fragmentele au fost confirmate');
    assert.ok(src.includes('completedParts.sort((a, b) => a.partNumber - b.partNumber)'));
    assert.ok(src.includes('body: JSON.stringify({ parts: completedParts })'));
  });

  test(`${name}: eliminarea unui material in timpul unui upload multipart opreste TOATE fragmentele active (nu doar unul) si abandoneaza sesiunea la R2`, () => {
    const wireSrc = extractFunction(html, 'function wireQueueRow(row, entry) {');
    assert.ok(wireSrc.includes('entry.abortRequested = true;'));
    assert.ok(wireSrc.includes('entry.activePartXhrs'), 'trebuie sa opreasca toate PUT-urile de fragment active, nu doar entry.xhr');
    assert.ok(wireSrc.includes('/media/multipart/${') && wireSrc.match(/method:\s*['"]DELETE['"]/), 'eliminarea trebuie sa abandoneze explicit sesiunea multipart la R2 (DELETE)');
  });
}

// -------------------------------------------------------------------------------------------
// 5. storage.js: functiile multipart si CORS exista si folosesc SDK-ul deja existent
//    (@aws-sdk/client-s3) — niciun storage/serviciu nou.
// -------------------------------------------------------------------------------------------
test('storage.js: expune createPrivateMultipartUpload/getSignedUploadPartUrl/completePrivateMultipartUpload/abortPrivateMultipartUpload/checkUploadCors', () => {
  for (const fn of ['createPrivateMultipartUpload', 'getSignedUploadPartUrl', 'completePrivateMultipartUpload', 'abortPrivateMultipartUpload', 'checkUploadCors']) {
    assert.ok(storage.includes(`async function ${fn}(`), `storage.js trebuie sa defineasca ${fn}()`);
    assert.ok(new RegExp(`\\b${fn}\\b`).test(storage.slice(storage.indexOf('module.exports'))), `${fn} trebuie exportat din storage.js`);
  }
});

test('storage.js: foloseste STRICT comenzile @aws-sdk/client-s3 deja folosite de restul fisierului — niciun pachet/storage nou', () => {
  assert.ok(storage.includes('CreateMultipartUploadCommand'));
  assert.ok(storage.includes('UploadPartCommand'));
  assert.ok(storage.includes('CompleteMultipartUploadCommand'));
  assert.ok(storage.includes('AbortMultipartUploadCommand'));
  assert.ok(storage.includes('GetBucketCorsCommand'));
  assert.ok(storage.includes("require('@aws-sdk/client-s3')"));
  assert.ok(!/require\(['"](?!@aws-sdk|fs|path)/.test(storage), 'niciun alt pachet de storage nou nu trebuie introdus');
});

// CORECȚIE (2026-08-14, "am actualizat si salvat regula CORS existenta manual"): PutBucketCors
// INLOCUIESTE intreaga configurare CORS a bucket-ului — o functie care l-ar mai apela ar risca
// sa stearga silentios regulile GET/HEAD adaugate manual de client. checkUploadCors() foloseste
// acum STRICT GetBucketCorsCommand (citire) — niciodata PutBucketCorsCommand.
test('storage.js: checkUploadCors() DOAR citeste configurarea CORS existenta (GetBucketCorsCommand) — nu o modifica niciodata (niciun PutBucketCorsCommand ramas in fisier)', () => {
  const src = extractFunction(storage, 'async function checkUploadCors(origins) {');
  assert.ok(src.includes('new GetBucketCorsCommand('));
  assert.ok(!storage.includes('new PutBucketCorsCommand('), 'storage.js nu mai trebuie sa instantieze PutBucketCorsCommand — risc de suprascriere a unei configurari facute manual (comentariile care documenteaza istoricul acestei decizii pot mentiona numele, codul activ nu)');
});

test('storage.js: checkUploadCors() verifica ca exista o regula cu PUT permis, originea site-ului si ETag expus, fara sa presupuna forma exacta a regulii (client a putut adauga PUT la o regula GET/HEAD existenta)', () => {
  const src = extractFunction(storage, 'async function checkUploadCors(origins) {');
  assert.ok(src.includes("allowedMethods.includes('PUT')"));
  assert.ok(src.includes("exposeHeaders.includes('etag')"));
  assert.ok(!/S3_SECRET_ACCESS_KEY|accessKeyId|secretAccessKey/.test(src), 'nicio credentiala nu trebuie expusa in verificarea CORS');
});

test('storage.js: getSignedUploadPartUrl() semneaza STRICT un UploadPartCommand — clientul nu primeste niciodata cheile R2, doar un URL temporar per fragment', () => {
  const src = extractFunction(storage, 'async function getSignedUploadPartUrl(key, uploadId, partNumber, expirySeconds = 900) {');
  assert.ok(src.includes('new UploadPartCommand('));
  assert.ok(src.includes('getSignedUrl(s3Client, command'));
});

// -------------------------------------------------------------------------------------------
// 6. server.js: cele 4 rute multipart exista, protejate de token; Railway NU vede continutul
//    video (nicio ruta nu primeste body de fisier/octet-stream pentru fragmente); finalizarea
//    e idempotenta; sesiunile abandonate sunt curatate (inclusiv la R2, nu doar local).
// -------------------------------------------------------------------------------------------
test('server.js: cele 5 rute de upload multipart exista, toate protejate de requireOrderToken', () => {
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/init', mediaUploadLimiter, requireOrderToken/);
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId\/part-url', requireOrderToken/);
  // CORECȚIE (2026-08-30, "IMG_6810.mov"): ruta noua de rezerva, independenta de CORS, pentru
  // citirea ETag-ului unui fragment deja urcat direct de la R2.
  assert.match(server, /app\.get\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId\/part-etag', requireOrderToken/);
  assert.match(server, /app\.post\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId\/complete', requireOrderToken/);
  assert.match(server, /app\.delete\('\/api\/orders\/:orderId\/media\/multipart\/:sessionId', requireOrderToken/);
});

test('server.js: NICIO ruta multipart nu accepta un body de fisier/octet-stream — Railway nu mai vede niciodata continutul video (doar JSON: filename/size/mimeType/partNumber/parts)', () => {
  assert.ok(!/express\.raw\(\s*\{\s*type:\s*['"]application\/octet-stream['"]/.test(server), 'nu mai trebuie sa existe nicio ruta care primeste octeti bruti de fisier pe acest server');
  const initSrc = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/init', mediaUploadLimiter, requireOrderToken, async (req, res, next) => {");
  assert.ok(initSrc.includes('const { filename, size, mimeType, section } = req.body'));
});

test('server.js: /part-url intoarce STRICT un URL semnat (Railway autorizeaza, nu retransmite) — foloseste storage.getSignedUploadPartUrl', () => {
  const routeIdx = server.indexOf("app.post('/api/orders/:orderId/media/multipart/:sessionId/part-url'");
  const nextRouteIdx = server.indexOf("app.post('/api/orders/:orderId/media/multipart/:sessionId/complete'", routeIdx);
  const src = server.slice(routeIdx, nextRouteIdx);
  assert.ok(src.includes('storage.getSignedUploadPartUrl('));
  assert.ok(src.includes('res.json({ url })'));
});

test('server.js: /complete e idempotent — o sesiune deja finalizata (session.completed) intoarce STRICT acelasi rezultat, fara sa re-finalizeze la R2', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  const idx = src.indexOf('if (session.completed)');
  assert.notEqual(idx, -1);
  assert.ok(src.slice(idx, idx + 60).includes('return res.json(session.result)'));
});

test('server.js: /complete foloseste storage.completePrivateMultipartUpload() cu parts (partNumber+etag) primite de la client', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  assert.ok(src.includes('storage.completePrivateMultipartUpload(session.key, session.uploadId, parts)'));
});

test('server.js: /complete verifica decodabilitatea DIRECT dintr-un URL semnat R2 (ffprobe), fara sa descarce fisierul pentru sine mai intai — Railway nu retransmite continutul', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  assert.ok(src.includes('storage.getSignedDownloadUrl(session.key'));
  assert.ok(src.includes('verifyMediaDecodable(signedUrl, session.mimetype'));
});

test('server.js: init valideaza dimensiunea, tipul (STRICT video) si stocarea cloud inainte de a crea o sesiune multipart la R2', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/init', mediaUploadLimiter, requireOrderToken, async (req, res, next) => {");
  assert.ok(src.includes('ORDER_MEDIA_MAX_BYTES'));
  assert.ok(src.includes("inferredForInit.type !== 'video'"));
  assert.ok(src.includes('storage.CLOUD_ENABLED'));
  assert.ok(src.includes('storage.createPrivateMultipartUpload('));
});

test('server.js: sesiunile multipart abandonate (idle) sunt curatate periodic prin abandonarea REALA la R2 (storage.abortPrivateMultipartUpload), nu doar sterse local', () => {
  assert.match(server, /MULTIPART_SESSION_IDLE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  assert.ok(server.includes('storage.abortPrivateMultipartUpload(session.key, session.uploadId)') && server.includes('multipartSessions.delete(sessionId)'));
});

test('server.js: eroarea la finalizare (ex. ETag invalid) abandoneaza explicit sesiunea multipart la R2, nu o lasa orfana', () => {
  const src = extractFunction(server, "app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {");
  assert.ok(src.includes('storage.abortPrivateMultipartUpload(session.key, session.uploadId)'));
});

test('server.js: la pornire, se verifica (best-effort, nefatal, STRICT citire) daca bucket-ul privat are deja CORS suficient pentru originea DOMAIN — succesul/esecul se raporteaza explicit in log, fara sa modifice vreodata configurarea', () => {
  assert.ok(server.includes('function checkUploadCorsAtBoot()'));
  assert.ok(server.includes('storage.checkUploadCors(origins)'));
  assert.ok(server.includes('checkUploadCorsAtBoot();'), 'trebuie apelata efectiv la pornirea serverului');
});

test('server.js: nicio ruta multipart nu ocoleste requireOrderToken si nicio cheie R2 nu e trimisa catre client (doar URL-uri semnate, temporare)', () => {
  assert.ok(!server.includes('S3_SECRET_ACCESS_KEY') || server.match(/S3_SECRET_ACCESS_KEY/g).length <= 1, 'server.js nu trebuie sa manipuleze direct cheia secreta R2 (asta ramane in storage.js)');
});

test('server.js, amintiri-video.html, comanda-mea.html, succes.html, storage.js: raman sintactic valide dupa corectiile Rundei 6', () => {
  assert.doesNotThrow(() => { require('node:child_process').execSync(`node --check "${path.join(__dirname, '..', 'server.js')}"`); });
  assert.doesNotThrow(() => { require('node:child_process').execSync(`node --check "${path.join(__dirname, '..', 'storage.js')}"`); });
  for (const [name, html] of Object.entries(PAGES)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach(m => { new Function(m[1]); });
  }
});

test('server.js: PLAN_PRICES si PLAN_VARIANT_COUNT raman neschimbate — Standard/Premium neatinse in aceasta corectie', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});
