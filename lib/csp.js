// LAUNCH SAFETY (2026-09-01): Content-Security-Policy stricta, construita din resursele REALE
// folosite de site (verificate direct in cod, nu presupuse) — vezi raportul de audit pentru
// lista completa. Fara wildcard-uri, fara 'unsafe-eval'. 'unsafe-inline' ramane STRICT pe
// style-src (zeci de atribute style="" inline pe paginile existente — eliminarea lor ar fi un
// refactor masiv, explicit exclus din scop; riscul practic al CSS inline, fara posibilitate de
// executie de cod, e mult sub cel al JS inline).
//
// script-src NU foloseste 'unsafe-inline' — fiecare pagina isi are hash-urile SHA-256 ale
// propriilor blocuri <script> calculate AUTOMAT, la pornirea serverului, direct din fisierele
// reale de pe disc (functia loadPageScriptHashes de mai jos). Asta inseamna ca hash-urile se
// actualizeaza singure la fiecare deploy — nu exista nicio valoare hardcodata de intretinut
// manual, care ar fi ramas STALE la urmatoarea editare a unui <script> si ar fi blocat silentios
// site-ul. Singurele 2 atribute onclick="" din tot codul au fost eliminate (mutate pe
// addEventListener) tocmai ca sa nu fie nevoie de nicio exceptie suplimentara pentru handlere
// inline de evenimente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function hashInlineScripts(html) {
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const content = m[1];
    if (!content.trim()) continue;
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
    hashes.push(`'sha256-${hash}'`);
  }
  return hashes;
}

// Citit O SINGURA DATA la incarcarea acestui modul (deci la fiecare pornire/deploy al
// serverului) — daca fisierele nu exista inca (ex. rulat dintr-un alt working directory la
// teste), esueaza silentios catre o harta goala, nu blocheaza pornirea.
function loadPageScriptHashes() {
  const map = {};
  let files = [];
  try {
    files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  } catch (err) {
    return map;
  }
  for (const file of files) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      map['/' + file] = hashInlineScripts(html);
    } catch (err) {
      map['/' + file] = [];
    }
  }
  if (map['/index.html']) map['/'] = map['/index.html'];
  return map;
}

const PAGE_SCRIPT_HASHES = loadPageScriptHashes();

function scriptHashesForPath(reqPath) {
  const hashes = PAGE_SCRIPT_HASHES[reqPath];
  return hashes && hashes.length ? hashes.join(' ') : '';
}

// Gazdele reale de stocare (R2), derivate din variabilele de mediu configurate — niciodata
// hardcodate — ca sa ramana corecte automat daca bucket-ul/contul se schimba vreodata.
function resolveStorageHosts() {
  const hosts = [];
  try {
    if (process.env.S3_PUBLIC_BASE_URL) {
      hosts.push(new URL(process.env.S3_PUBLIC_BASE_URL).origin);
    }
  } catch (err) { /* ignora, valoare invalida in env */ }
  try {
    if (process.env.S3_ENDPOINT && process.env.S3_PRIVATE_BUCKET) {
      const endpointHost = new URL(process.env.S3_ENDPOINT).host;
      hosts.push(`https://${process.env.S3_PRIVATE_BUCKET}.${endpointHost}`);
    }
  } catch (err) { /* ignora, valoare invalida in env */ }
  return hosts;
}

function buildCspDirectives() {
  const storageHosts = resolveStorageHosts();

  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', (req) => scriptHashesForPath(req.path)],
      // 'unsafe-inline' STRICT pe style — vezi comentariul de sus. Fara 'unsafe-eval' nicaieri.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // https://cdnjs.cloudflare.com: intl-tel-input (selectorul de prefix telefonic din
      // comanda.html) incarca si un sprite de steaguri (flags.png) de acolo — descoperit prin
      // testare REALA intr-un browser (Playwright), nu doar din citirea codului sursa.
      imgSrc: ["'self'", 'blob:', 'https://cdnjs.cloudflare.com', ...storageHosts],
      mediaSrc: ["'self'", 'blob:', ...storageHosts],
      connectSrc: ["'self'", ...storageHosts],
      // Fara iframe-uri, fara WebSocket-uri — verificat direct in tot codul client.
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: []
    }
  };
}

module.exports = { buildCspDirectives, scriptHashesForPath, PAGE_SCRIPT_HASHES };
