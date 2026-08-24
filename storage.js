// storage.js
// Stocare fisiere media — Cloudflare R2 sau AWS S3, in DOUA bucket-uri complet separate.
//
// De ce doua bucket-uri, nu unul singur cu prefixe de folder: daca ai un singur bucket si
// activezi acces public pe el (necesar pentru preview-uri si testimoniale), TOT bucket-ul
// devine potential accesibil prin acel domeniu public — inclusiv melodiile complete, daca
// cineva ar afla vreodata cheia exacta a unui fisier. Cu doua bucket-uri, separarea e
// structurala, nu doar conventie de denumire: bucket-ul privat nu are NICIODATA acces
// public activat, indiferent ce se intampla cu celalalt.
//
// - naluna-private: melodiile complete (orders/full/...). Fara acces public. Singurul mod
//   de a ajunge la un fisier e un URL semnat (presigned), generat la cerere, expira in 10 minute.
// - naluna-public: preview-uri (orders/preview/...) si reactii clienti (testimonials/...).
//   Acces public prin Custom Domain Cloudflare — continut menit sa fie vazut de oricine.
//
// FARA variabilele de mai jos setate, aplicatia foloseste automat discul local ca fallback —
// util pentru dezvoltare, dar NU recomandat in productie pe Railway (fisierele se pierd
// la fiecare redeploy, exact problema pe care stocarea cloud o rezolva).
//
// ============================================================================
// SETUP CLOUDFLARE R2 — doua bucket-uri
// ============================================================================
// 1. dash.cloudflare.com -> R2 Object Storage -> Create bucket, de DOUA ori:
//      - "naluna-private"  (sau orice nume alegi)
//      - "naluna-public"
// 2. R2 -> Overview -> Manage API Tokens -> Create API token -> permisiuni
//    "Object Read & Write" -> scop "Apply to specific buckets only" -> selectezi
//    AMBELE bucket-uri (acelasi token poate avea acces la ambele, e un singur cont R2).
//    Copiezi Access Key ID si Secret Access Key — apar o singura data.
// 3. Doar pe "naluna-public": Settings -> Public Access -> Custom Domains -> Connect Domain
//    (ex: media.nalunastudio.com). NU activezi niciun fel de acces public pe "naluna-private".
// 4. Endpoint-ul (S3_ENDPOINT) il gasesti in Settings -> sectiunea "S3 API", pe oricare
//    din cele doua bucket-uri — e acelasi pentru tot contul (contine account_id, nu numele bucket-ului).
// 5. Completezi in .env:
//    S3_PRIVATE_BUCKET=naluna-private
//    S3_PUBLIC_BUCKET=naluna-public
//    S3_ACCESS_KEY_ID=...
//    S3_SECRET_ACCESS_KEY=...
//    S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
//    S3_REGION=auto
//    S3_PUBLIC_BASE_URL=https://media.nalunastudio.com
//
// ============================================================================
// SETUP AWS S3 (alternativa) — doua bucket-uri
// ============================================================================
// 1. S3 -> Create bucket, de doua ori: "naluna-private" si "naluna-public", aceeasi regiune
// 2. IAM -> Create user -> policy limitata la PutObject/GetObject/DeleteObject pe ambele bucket-uri
// 3. Doar pe "naluna-public": pui CloudFront in fata lui (recomandat), URL-ul CloudFront
//    merge la S3_PUBLIC_BASE_URL. "naluna-private" ramane fara niciun acces public configurat.
// 4. Completezi in .env:
//    S3_PRIVATE_BUCKET=naluna-private
//    S3_PUBLIC_BUCKET=naluna-public
//    S3_ACCESS_KEY_ID=...
//    S3_SECRET_ACCESS_KEY=...
//    S3_REGION=eu-west-2
//    S3_ENDPOINT=              (lasi gol — SDK-ul foloseste endpoint-ul regional AWS implicit)
//    S3_PUBLIC_BASE_URL=https://d111111abcdef8.cloudfront.net
//
// ============================================================================

const fs = require('fs');
const path = require('path');

// Cele 5 variabile de mai jos sunt un TOT unitar — fara S3_PUBLIC_BASE_URL, uploadurile ar
// reusi (nu au nevoie de ea), dar orice preview ar esua imediat dupa, la prima generare
// reala, cand getPublicUrl() arunca eroare ("S3_PUBLIC_BASE_URL lipseste"). Asta ar insemna
// "porneste pe jumatate si pica la prima comanda" — exact ce REQUIRED_ENV_VARS din server.js
// evita explicit pentru celelalte variabile obligatorii. Validam deci strict: TOATE cele 5
// setate -> cloud activat; NICIUNA setata -> fallback local (comportamentul de pana acum,
// neschimbat); orice combinatie PARTIALA -> esec clar la boot, nu la prima comanda.
const S3_CONFIG_VARS = {
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_PRIVATE_BUCKET: process.env.S3_PRIVATE_BUCKET,
  S3_PUBLIC_BUCKET: process.env.S3_PUBLIC_BUCKET,
  S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL
};
const s3VarsSet = Object.entries(S3_CONFIG_VARS).filter(([, v]) => !!v).map(([k]) => k);
const s3VarsMissing = Object.entries(S3_CONFIG_VARS).filter(([, v]) => !v).map(([k]) => k);

if (s3VarsSet.length > 0 && s3VarsMissing.length > 0) {
  console.error(
    `Storage: configurare S3/R2 incompleta — lipsesc: ${s3VarsMissing.join(', ')}. ` +
    `Fie completezi TOATE variabilele S3_* (vezi comentariile din storage.js), fie le lasi ` +
    `pe TOATE necompletate ca sa folosesti fallback-ul local. O configurare partiala nu ` +
    `porneste — ar rula cu upload-uri reusite dar preview-uri care esueaza la prima comanda reala.`
  );
  process.exit(1);
}

const CLOUD_ENABLED = s3VarsSet.length === Object.keys(S3_CONFIG_VARS).length;

const PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
const PUBLIC_BUCKET = process.env.S3_PUBLIC_BUCKET;

let s3Client = null;
let PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, getSignedUrl;
let CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetBucketCorsCommand;

if (CLOUD_ENABLED) {
  const {
    S3Client, PutObjectCommand: POC, GetObjectCommand: GOC, DeleteObjectCommand: DOC, HeadObjectCommand: HOC,
    CreateMultipartUploadCommand: CMU, UploadPartCommand: UPC,
    CompleteMultipartUploadCommand: CMPU, AbortMultipartUploadCommand: AMU,
    GetBucketCorsCommand: GBC
  } = require('@aws-sdk/client-s3');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  PutObjectCommand = POC;
  GetObjectCommand = GOC;
  DeleteObjectCommand = DOC;
  HeadObjectCommand = HOC;
  CreateMultipartUploadCommand = CMU;
  UploadPartCommand = UPC;
  CompleteMultipartUploadCommand = CMPU;
  AbortMultipartUploadCommand = AMU;
  GetBucketCorsCommand = GBC;

  s3Client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
  console.log(`Storage: cloud activat (privat: "${PRIVATE_BUCKET}", public: "${PUBLIC_BUCKET}").`);
} else {
  console.warn(
    'Storage: S3_PRIVATE_BUCKET / S3_PUBLIC_BUCKET nesetate — folosesc discul local ca fallback. ' +
    'Pe Railway, fara Volume persistent, fisierele audio/testimoniale se pierd la fiecare redeploy. ' +
    'Vezi comentariile din storage.js pentru pasii de configurare R2/S3.'
  );
}

// foldere locale, folosite DOAR daca stocarea cloud nu e configurata — pastram aceeasi
// separare privat/public si in fallback, ca sa nu existe surprize cand treci pe cloud
const LOCAL_PRIVATE_DIR = path.join(__dirname, 'local-storage-private');
const LOCAL_PUBLIC_DIR = path.join(__dirname, 'public', 'local-storage');
if (!CLOUD_ENABLED) {
  fs.mkdirSync(LOCAL_PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_PUBLIC_DIR, { recursive: true });
}

// ============================================================================
// UPLOAD — API separat pentru privat/public, ca sa fie imposibil sa urci din greseala
// un fisier privat in bucket-ul public sau invers.
// ============================================================================

async function uploadPrivateFile(localFilePath, key, contentType) {
  if (CLOUD_ENABLED) {
    const stats = fs.statSync(localFilePath);
    await s3Client.send(new PutObjectCommand({
      Bucket: PRIVATE_BUCKET,
      Key: key,
      Body: fs.createReadStream(localFilePath),
      ContentType: contentType,
      ContentLength: stats.size
    }));
  } else {
    const dest = path.join(LOCAL_PRIVATE_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localFilePath, dest);
  }
  return { key };
}

async function uploadPublicFile(localFilePath, key, contentType) {
  if (CLOUD_ENABLED) {
    const stats = fs.statSync(localFilePath);
    await s3Client.send(new PutObjectCommand({
      Bucket: PUBLIC_BUCKET,
      Key: key,
      Body: fs.createReadStream(localFilePath),
      ContentType: contentType,
      ContentLength: stats.size
    }));
  } else {
    const dest = path.join(LOCAL_PUBLIC_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localFilePath, dest);
  }
  return { key };
}

// urca direct dintr-un buffer in memorie (folosit pentru upload-urile din admin, via multer)
// — testimonialele sunt intotdeauna publice, deci merg mereu in bucket-ul public
async function uploadPublicBuffer(buffer, key, contentType) {
  if (CLOUD_ENABLED) {
    await s3Client.send(new PutObjectCommand({
      Bucket: PUBLIC_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType
    }));
  } else {
    const dest = path.join(LOCAL_PUBLIC_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  }
  return { key };
}

// urca direct dintr-un buffer in memorie, in bucket-ul PRIVAT — folosit pentru fotografiile/
// videoclipurile incarcate de client pentru pachetul "video" (amintiri personale, niciodata
// publice, la fel de private ca melodia completa).
async function uploadPrivateBuffer(buffer, key, contentType) {
  if (CLOUD_ENABLED) {
    await s3Client.send(new PutObjectCommand({
      Bucket: PRIVATE_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType
    }));
  } else {
    const dest = path.join(LOCAL_PRIVATE_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  }
  return { key };
}

// ============================================================================
// ACCES — URL public direct (bucket public) sau URL semnat, temporar (bucket privat)
// ============================================================================

// URL public, direct, pentru fisiere din bucket-ul PUBLIC (preview-uri, testimoniale)
function getPublicUrl(key) {
  if (CLOUD_ENABLED) {
    if (!process.env.S3_PUBLIC_BASE_URL) {
      throw new Error('S3_PUBLIC_BASE_URL lipseste din .env — necesar pentru URL-uri catre bucket-ul public.');
    }
    return `${process.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
  }
  return `/local-storage/${key}`; // fallback local, servit de express.static din public/local-storage
}

// URL temporar, semnat, pentru fisiere din bucket-ul PRIVAT (melodia completa — doar dupa plata)
// Expira automat dupa expirySeconds — nu poate fi refolosit la nesfarsit odata generat.
async function getSignedDownloadUrl(key, expirySeconds = 600) {
  if (!CLOUD_ENABLED) {
    throw new Error('getSignedDownloadUrl() a fost apelat fara stocare cloud activata — folosirea fallback-ului local se face pe alta cale, nu prin URL semnat.');
  }
  const command = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
}

// ============================================================================
// UPLOAD MULTIPART DIRECT DIN BROWSER (2026-08-14) — Cadou video, videoclipuri mari.
//
// De ce: relansarea anterioara (upload "fragmentat" prin server, vezi comentariul istoric din
// server.js) tot retransmitea INTREGUL continut video prin Railway — doar in bucati mai mici,
// secvential. Pentru un videoclip de 500MB, asta insemna ~84 cereri succesive prin acelasi
// server, exact tiparul lent semnalat live. Aici browserul trimite fragmentele DIRECT catre R2
// (prin URL-uri semnate, cate unul per fragment) — Railway nu mai vede niciodata bytes video,
// doar autorizeaza, initiaza sesiunea multipart si o finalizeaza la final.
// ============================================================================

async function createPrivateMultipartUpload(key, contentType) {
  if (!CLOUD_ENABLED) {
    throw new Error('createPrivateMultipartUpload() necesita stocare cloud activata.');
  }
  const res = await s3Client.send(new CreateMultipartUploadCommand({
    Bucket: PRIVATE_BUCKET, Key: key, ContentType: contentType
  }));
  return res.UploadId;
}

// URL semnat, de scurta durata, pentru UN SINGUR fragment (PUT direct din browser catre R2) —
// clientul primeste cate unul per fragment, chiar inainte sa-l trimita (nu toate deodata),
// ca sa ramana valid (expira in expirySeconds).
async function getSignedUploadPartUrl(key, uploadId, partNumber, expirySeconds = 900) {
  if (!CLOUD_ENABLED) {
    throw new Error('getSignedUploadPartUrl() necesita stocare cloud activata.');
  }
  const command = new UploadPartCommand({ Bucket: PRIVATE_BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber });
  return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
}

// parts: [{ partNumber, etag }, ...] — ETag-ul e cel intors de R2 la fiecare PUT direct de
// fragment (header de raspuns, citit de client), necesar EXACT in aceasta forma pentru ca R2
// sa poata reasambla obiectul final. Idempotent la nivelul apelantului (server.js) — vezi
// session.completed acolo.
async function completePrivateMultipartUpload(key, uploadId, parts) {
  if (!CLOUD_ENABLED) {
    throw new Error('completePrivateMultipartUpload() necesita stocare cloud activata.');
  }
  return s3Client.send(new CompleteMultipartUploadCommand({
    Bucket: PRIVATE_BUCKET, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) }
  }));
}

// Abandoneaza o sesiune multipart neterminata — R2 (ca orice S3) NU elibereaza automat
// fragmentele deja urcate pentru un upload multipart abandonat; fara acest apel explicit,
// fragmentele orfane ar ramane facturate la nesfarsit. Apelat atat la anulare explicita din
// client, cat si de curatarea periodica a sesiunilor abandonate (server.js).
async function abortPrivateMultipartUpload(key, uploadId) {
  if (!CLOUD_ENABLED) return;
  try {
    await s3Client.send(new AbortMultipartUploadCommand({ Bucket: PRIVATE_BUCKET, Key: key, UploadId: uploadId }));
  } catch (err) {
    // best-effort — o sesiune deja finalizata/expirata la R2 arunca eroare aici, ignorata intentionat
  }
}

// VERIFICA (STRICT citire, NICIODATA scriere) daca bucket-ul PRIVAT are deja CORS configurat
// pentru PUT direct din browser catre R2, cu header-ul ETag expus — necesar ca uploadul
// multipart (fragmentele de upload) sa functioneze. Apelat o singura data la pornirea
// serverului, best-effort, nefatal.
//
// CORECȚIE (2026-08-14, "am actualizat si salvat regula CORS existenta manual"): initial,
// aceasta functie folosea PutBucketCorsCommand pentru a configura CORS automat — dupa ce
// clientul a configurat manual regula corecta (PUT adaugat, GET/HEAD pastrate, ExposeHeaders
// cu ETag), am descoperit ca PutBucketCors INLOCUIESTE intreaga configurare CORS a bucket-ului
// (nu adauga reguli) — daca aceasta functie ar mai fi rulat vreodata cu succes (ex. daca
// permisiunile token-ului R2 s-ar schimba ulterior), ar fi STERS silentios regulile GET/HEAD
// configurate manual de client, inlocuindu-le cu o regula STRICT PUT. Pentru a nu risca
// niciodata sa suprascrie o configurare facuta manual, aceasta functie acum DOAR CITESTE
// configurarea existenta si verifica daca e suficienta — nu scrie niciodata in ea.
// Intoarce { ok: true } daca a putut confirma o regula suficienta, { ok: false, verified: true,
// reason } daca a putut citi configurarea dar aceasta NU e suficienta, sau { ok: false,
// verified: false, reason } daca citirea insasi a esuat (token-ul R2 "Object Read & Write" poate
// sa NU aiba voie sa citeasca nici macar configurarea bucket-ului, un permisiune STRICT
// administrativa, separata de operatiile pe obiecte) — in acest ultim caz NU inseamna ca
// uploadul e stricat, doar ca acest server nu poate verifica singur; apelantul trebuie sa
// distinga explicit cele doua cazuri, nu sa presupuna "esec la citire" == "CORS insuficient".
async function checkUploadCors(origins) {
  if (!CLOUD_ENABLED) return { ok: false, verified: true, reason: 'stocare cloud dezactivata' };
  try {
    const res = await s3Client.send(new GetBucketCorsCommand({ Bucket: PRIVATE_BUCKET }));
    const rules = res.CORSRules || [];
    const sufficient = rules.some(rule => {
      const allowedOrigins = rule.AllowedOrigins || [];
      const allowedMethods = rule.AllowedMethods || [];
      const exposeHeaders = (rule.ExposeHeaders || []).map(h => h.toLowerCase());
      const originOk = allowedOrigins.includes('*') || origins.some(o => allowedOrigins.includes(o));
      const putOk = allowedMethods.includes('PUT');
      const etagOk = exposeHeaders.includes('etag');
      return originOk && putOk && etagOk;
    });
    return sufficient
      ? { ok: true }
      : { ok: false, verified: true, reason: 'bucket-ul are CORS configurat, dar nicio regula nu permite PUT + expune ETag pentru originea site-ului' };
  } catch (err) {
    return { ok: false, verified: false, reason: err.message || String(err) };
  }
}

// ADAUGAT (2026-08-24, "iPhone: fotografiile/videoclipurile pentru preview folosesc direct
// fisierul original"): verifica STRICT existenta unui fisier in bucket-ul PRIVAT, fara sa-l
// descarce — folosit pentru cache-ul de thumbnailuri mici generate la cerere (vezi
// ensureMediaThumbnail in server.js), ca sa nu regeneram acelasi thumbnail la fiecare vizualizare.
async function privateFileExists(key) {
  if (!CLOUD_ENABLED) {
    return fs.existsSync(path.join(LOCAL_PRIVATE_DIR, key));
  }
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// STERGERE — tot cu API separat privat/public
// ============================================================================

async function deletePrivateFile(key) {
  if (CLOUD_ENABLED) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
  } else {
    const filePath = path.join(LOCAL_PRIVATE_DIR, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function deletePublicFile(key) {
  if (CLOUD_ENABLED) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key }));
  } else {
    const filePath = path.join(LOCAL_PUBLIC_DIR, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

module.exports = {
  CLOUD_ENABLED,
  uploadPrivateFile,
  uploadPublicFile,
  uploadPublicBuffer,
  uploadPrivateBuffer,
  getPublicUrl,
  getSignedDownloadUrl,
  privateFileExists,
  deletePrivateFile,
  deletePublicFile,
  createPrivateMultipartUpload,
  getSignedUploadPartUrl,
  completePrivateMultipartUpload,
  abortPrivateMultipartUpload,
  checkUploadCors
};
