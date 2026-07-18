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
//    (ex: media.naluna.co.uk). NU activezi niciun fel de acces public pe "naluna-private".
// 4. Endpoint-ul (S3_ENDPOINT) il gasesti in Settings -> sectiunea "S3 API", pe oricare
//    din cele doua bucket-uri — e acelasi pentru tot contul (contine account_id, nu numele bucket-ului).
// 5. Completezi in .env:
//    S3_PRIVATE_BUCKET=naluna-private
//    S3_PUBLIC_BUCKET=naluna-public
//    S3_ACCESS_KEY_ID=...
//    S3_SECRET_ACCESS_KEY=...
//    S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
//    S3_REGION=auto
//    S3_PUBLIC_BASE_URL=https://media.naluna.co.uk
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

const CLOUD_ENABLED = !!(
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY &&
  process.env.S3_PRIVATE_BUCKET &&
  process.env.S3_PUBLIC_BUCKET
);

const PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
const PUBLIC_BUCKET = process.env.S3_PUBLIC_BUCKET;

let s3Client = null;
let PutObjectCommand, GetObjectCommand, DeleteObjectCommand, getSignedUrl;

if (CLOUD_ENABLED) {
  const { S3Client, PutObjectCommand: POC, GetObjectCommand: GOC, DeleteObjectCommand: DOC } = require('@aws-sdk/client-s3');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  PutObjectCommand = POC;
  GetObjectCommand = GOC;
  DeleteObjectCommand = DOC;

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
  getPublicUrl,
  getSignedDownloadUrl,
  deletePrivateFile,
  deletePublicFile
};
