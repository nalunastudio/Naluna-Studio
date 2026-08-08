// server.js
// NALUNA — backend, versiune pregatita pentru productie
//
// Flux:
// 1. Clientul completeaza formularul si apasa "Genereaza previzualizarea" (GRATUIT).
// 2. POST /api/orders creeaza comanda in PostgreSQL (validare stricta, pret calculat
//    server-side dupa pachet — pretul trimis de client NU e niciodata folosit direct).
// 3. POST /api/orders/:id/generate trimite UN SINGUR apel catre SunoAPI, care returneaza
//    de obicei 2 piese per task — folosite ca cele 2 variante. Pentru fiecare, descarca
//    fisierul complet (privat), taie un preview de PREVIEW_SECONDS (40 sec) cu ffmpeg, citeste durata reala.
// 4. Clientul asculta, alege o varianta (POST /api/orders/:id/select), sau cere editari
//    (POST /api/orders/:id/regenerate) — 3 runde gratuite.
// 5. POST /api/orders/:id/checkout creeaza sesiunea Stripe — vanzare internationala, fara
//    restrictie de tara. Produs digital, fara colectare de adresa de livrare. TVA ramane
//    dezactivat implicit, activabil explicit prin STRIPE_AUTOMATIC_TAX_ENABLED=true dupa
//    ce contul Stripe e configurat corespunzator (vezi README).
// 6. Dupa plata confirmata (webhook), fisierul COMPLET devine accesibil la
//    /media/full/:orderId?token=ACCESS_TOKEN — token-ul e obligatoriu, verificat
//    timing-safe fata de order.accessToken. Comanda inexistenta, token lipsa, token
//    gresit sau de lungime diferita primesc TOATE acelasi raspuns (404, mesaj generic) —
//    nu se poate deduce daca o comanda exista doar din diferenta de status HTTP.
//    Se trimite si un email automat cu link de livrare (acelasi token inclus in link).
// 7. Clientul isi poate regasi comanda oricand la /comanda-mea.html, dar DOAR cu un
//    cod de acces unic (accessToken) primit pe email — nu prin simpla introducere a
//    adresei de email (asta ar fi permis oricui care stie emailul cuiva sa-i vada comenzile).
//
// IMPORTANT: nu exista API oficial public Suno. Aici se foloseste un provider tert
// (sunoapi.org, apiframe.ai, aimlapi.com). Schimba MUSIC_API_BASE_URL si logica din
// callMusicProvider() dupa documentatia providerului ales — vezi sectiunea de comentarii
// din jurul acelei functii pentru exact ce informatii lipsesc si trebuie confirmate.
//
// STOCARE FISIERE: melodiile (complete + preview) si materialele din reactii clienti
// merg in Cloudflare R2 / AWS S3, prin storage.js, daca variabilele S3_* din .env sunt
// completate (vezi comentariile din storage.js pentru pasii exacti de configurare).
// Fara ele completate, aplicatia foloseste automat discul local ca fallback — util
// pentru dezvoltare, dar NU recomandat in productie pe Railway: discul standard e
// efemer la fiecare redeploy, iar comenzile din PostgreSQL ar ramane fara fisierele
// audio corespunzatoare. Vezi README, sectiunea "Stocare cloud", pentru setup complet.

require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Stripe = require('stripe');
const multer = require('multer');
const { randomUUID, randomBytes, timingSafeEqual, createHash } = require('crypto');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ==========================================================================================
// HOTFIX 2026-08-08: randarea videoclipului esua intermitent cu "Command failed" desi ffmpeg
// insusi rula corect (confirmat in loguri: incadrele avansau normal, fisierul de iesire
// crestea normal) — cauza reala: execFileAsync (Node) are un maxBuffer IMPLICIT de doar 1MB
// pentru stdout+stderr combinate, iar ffmpeg tipareste pe stderr o linie de progres PENTRU
// FIECARE CADRU codat by default — pentru un encode de cateva minute (normal pentru
// concatWithCrossfades, care combina 5-10 segmente), acel text de progres singur depaseste
// usor 1MB, iar Node omoara procesul si arunca eroarea generica "Command failed", fara nicio
// legatura cu vreun fisier de intrare invalid. Wrapper unic pentru TOATE apelurile ffmpeg din
// pipeline-ul video: '-hide_banner -loglevel error -nostats' elimina aproape complet spam-ul
// de progres (pastreaza doar erorile reale), iar maxBuffer generos ramane ca plasa de
// siguranta suplimentara.
async function execFfmpeg(args, options = {}) {
  return execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', ...args], {
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
}
const db = require('./db');
const storage = require('./storage');
const credits = require('./credits');
const {
  bufferMatchesDeclaredType,
  inferMediaType,
  normalizeSectionType,
  extractSectionMarkersFromAlignedWords,
  deriveSectionTimings,
  computeSectionAwareSegmentDurations,
  MEMORY_SECTION_ORDER,
  sortMediaBySection
} = require('./lib/media-analysis');
const { getGiftVariant } = require('./lib/entitlements');

// -------- Validare stricta a variabilelor de mediu obligatorii, la pornire --------
// Mai bine esueaza clar la boot decat sa porneasca "pe jumatate" si sa pice abia la prima comanda.
const REQUIRED_ENV_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DOMAIN', 'DATABASE_URL', 'ADMIN_USER', 'ADMIN_PASSWORD'];
const missingEnvVars = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`Lipsesc variabile de mediu obligatorii: ${missingEnvVars.join(', ')}. Verifica .env sau Railway -> Variables.`);
  process.exit(1);
}
// MUSIC_API_BASE_URL / MUSIC_API_KEY / RESEND_API_KEY nu sunt in lista de mai sus —
// fara ele, generarea de melodii sau emailul de livrare esueaza controlat (eroare
// clara in log, nu crash), dar serverul tot porneste. Le recomandam completate
// inainte de a lua comenzi reale.

const app = express();
// Railway sta in spatele unui proxy. NOTA (2026-08-03, audit de securitate): nici 'trust
// proxy', 1, nici un interval CIDR presupus pentru hop-ul intern nu s-au dovedit fiabile aici
// — verificat direct ca acel hop se roteste dintr-un mic pool de IP-uri (nu e stabil si nu
// pare sa fie intr-un interval documentat). Din acest motiv, deciziile de securitate (rate
// limiting) NU se bazeaza pe req.ip/trust proxy — folosesc explicit header-ul dedicat
// X-Real-IP, setat de Railway si confirmat ca nu poate fi falsificat de client (vezi
// realClientIp() mai jos). Setarea de aici ramane doar pentru comportamentul standard
// Express (req.secure etc.), fara rol de securitate.
app.set('trust proxy', 1);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN;
const PREVIEW_SECONDS = 40;
const FREE_EDITS = 1; // prima melodie generata NU consuma nicio editare (vezi /generate, care
                       // nu atinge editsUsed) — clientul are apoi exact O SINGURA regenerare
                       // gratuita; a doua tentativa e blocata
const FETCH_TIMEOUT_MS = 25000;

// Preturile NU vin niciodata de la client. Un client care modifica payload-ul (curl/devtools)
// nu poate plati mai putin decat pretul real al pachetului ales.
const PLAN_PRICES = { standard: 15, premium: 25, video: 35 };
// REGULA FINALA A PACHETELOR (2026-08-07): sursa unica server-side pentru cate melodii
// (variante) primeste fiecare plan — nu doar text in UI. Standard = o singura melodie,
// un singur gen. Premium/Video = doua melodii COMPLETE, in doua genuri DIFERITE, alese
// explicit de client (nu "prima varianta + a doua varianta a ACELUIASI gen").
const PLAN_VARIANT_COUNT = { standard: 1, premium: 2, video: 2 };
const ALLOWED_OCCASIONS = ['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'altceva'];
const ALLOWED_GENRES = ['emotional', 'suflet', 'pop', 'acustic', 'petrecere', 'balada', 'manele', 'copii', 'populara', 'rock', 'colind', 'modern', 'hiphop', 'manele_suflet', 'motivational'];
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// Mesaje de validare traduse pentru campurile obligatorii legate de personalizare
// (destinatar, expeditor, relatie, poveste) — afisate clientului in limba aleasa de el,
// nu doar in romana. Restul mesajelor de eroare din acest fisier raman in romana
// (comportament existent, neschimbat), conform cerintei explicite doar pentru aceste 4.
const MISSING_FIELD_MESSAGES = {
  recipient: {
    ro: 'Spune-ne pentru cine este melodia',
    en: 'Tell us who the song is for',
    de: 'Sag uns, für wen das Lied ist',
    es: 'Dinos para quién es la canción',
    it: 'Dicci per chi è la canzone',
    fr: 'Dites-nous pour qui est la chanson',
    bg: 'Кажи ни за кого е песента',
    tr: 'Şarkının kimin için olduğunu söyleyin'
  },
  sender: {
    ro: 'Spune-ne din partea cui este melodia',
    en: 'Tell us who the song is from',
    de: 'Sag uns, von wem das Lied ist',
    es: 'Dinos de parte de quién es la canción',
    it: 'Dicci da parte di chi è la canzone',
    fr: 'Dites-nous de la part de qui est la chanson',
    bg: 'Кажи ни от чие име е песента',
    tr: 'Şarkının kimden geldiğini söyleyin'
  },
  relationship: {
    ro: 'Selectează relația dintre voi',
    en: 'Tell us your relationship',
    de: 'Gib eure Beziehung an',
    es: 'Indica vuestra relación',
    it: 'Indica la vostra relazione',
    fr: 'Indiquez votre relation',
    bg: 'Посочи каква е връзката ви',
    tr: 'Aranızdaki ilişkiyi belirtin'
  },
  story: {
    ro: 'Adaugă câteva detalii despre povestea voastră',
    en: 'Add a few details about your story',
    de: 'Füge ein paar Details zu eurer Geschichte hinzu',
    es: 'Añade algunos detalles sobre vuestra historia',
    it: 'Aggiungi alcuni dettagli sulla vostra storia',
    fr: 'Ajoutez quelques détails sur votre histoire',
    bg: 'Добави няколко детайла за вашата история',
    tr: 'Hikayeniz hakkında birkaç detay ekleyin'
  }
};
function missingFieldMessage(field, lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return MISSING_FIELD_MESSAGES[field][safe];
}

// Valorile interne acceptate pentru preferinta de voce — orice altceva e respins.
const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];

// Mesaj de validare tradus — varianta sursa e OBLIGATORIE la regenerare (Partea 2).
const SOURCE_VARIANT_REQUIRED_MESSAGES = {
  ro: 'Selectează varianta pe care vrei să o modifici',
  en: 'Select the version you want to change',
  de: 'Wähle die Version aus, die du ändern möchtest',
  es: 'Selecciona la versión que quieres cambiar',
  it: 'Seleziona la versione che vuoi modificare',
  fr: 'Sélectionnez la version que vous voulez modifier',
  bg: 'Избери версията, която искаш да промениш',
  tr: 'Değiştirmek istediğiniz versiyonu seçin'
};
function sourceVariantRequiredMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return SOURCE_VARIANT_REQUIRED_MESSAGES[safe];
}

// Mesaj de validare tradus — valoare de voce invalida (Partea 4).
const INVALID_VOICE_MESSAGES = {
  ro: 'Preferința de voce nu este validă',
  en: 'Voice preference is not valid',
  de: 'Die Stimmpräferenz ist ungültig',
  es: 'La preferencia de voz no es válida',
  it: 'La preferenza vocale non è valida',
  fr: "La préférence de voix n'est pas valide",
  bg: 'Предпочитанието за глас не е валидно',
  tr: 'Ses tercihi geçerli değil'
};
function invalidVoiceMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return INVALID_VOICE_MESSAGES[safe];
}

// Mesaj de validare tradus — numar de telefon invalid (selector international WhatsApp).
const INVALID_PHONE_MESSAGES = {
  ro: 'Numărul de telefon nu este valid',
  en: 'The phone number is not valid',
  de: 'Die Telefonnummer ist ungültig',
  es: 'El número de teléfono no es válido',
  it: 'Il numero di telefono non è valido',
  fr: 'Le numéro de téléphone n\'est pas valide',
  bg: 'Телефонният номер не е валиден',
  tr: 'Telefon numarası geçerli değil'
};
function invalidPhoneMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return INVALID_PHONE_MESSAGES[safe];
}

// Mesaje pentru cel de-al doilea gen muzical (Premium/Video) — obligatoriu, si diferit de
// primul. Vezi PLAN_VARIANT_COUNT si POST /api/orders.
const GENRE2_REQUIRED_MESSAGES = {
  ro: 'Alege genul muzical pentru a doua melodie.',
  en: 'Choose a musical genre for the second song.',
  de: 'Wähle ein Musikgenre für das zweite Lied.',
  es: 'Elige un género musical para la segunda canción.',
  it: 'Scegli un genere musicale per la seconda canzone.',
  fr: 'Choisissez un genre musical pour la deuxième chanson.',
  bg: 'Избери музикален жанр за втората песен.',
  tr: 'İkinci şarkı için bir müzik türü seçin.'
};
function genre2Message(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return GENRE2_REQUIRED_MESSAGES[safe];
}
const SAME_GENRE_MESSAGES = {
  ro: 'Alege două genuri muzicale diferite.',
  en: 'Choose two different musical genres.',
  de: 'Wähle zwei unterschiedliche Musikgenres.',
  es: 'Elige dos géneros musicales diferentes.',
  it: 'Scegli due generi musicali diversi.',
  fr: 'Choisissez deux genres musicaux différents.',
  bg: 'Избери два различни музикални жанра.',
  tr: 'İki farklı müzik türü seçin.'
};
function sameGenreMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return SAME_GENRE_MESSAGES[safe];
}

// Mesaj de validare tradus — gen muzical invalid la editare (hotfix 2026-08-08, schimbarea
// genului la regenerare).
const INVALID_GENRE_MESSAGES = {
  ro: 'Genul muzical ales nu este valid',
  en: 'The chosen musical genre is not valid',
  de: 'Das gewählte Musikgenre ist ungültig',
  es: 'El género musical elegido no es válido',
  it: 'Il genere musicale scelto non è valido',
  fr: "Le genre musical choisi n'est pas valide",
  bg: 'Избраният музикален жанр не е валиден',
  tr: 'Seçilen müzik türü geçerli değil'
};
function invalidGenreMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return INVALID_GENRE_MESSAGES[safe];
}

// Validare E.164 STRICT independenta de tara — NU presupune si NU forteaza niciodata un
// prefix anume (ex. +44). Accepta orice tara valida: "+" urmat de 7-15 cifre, prima cifra
// nefiind 0 (asa cum cere standardul E.164). Numarul trebuie sa fi fost deja normalizat de
// frontend (intl-tel-input) inainte sa ajunga aici — server-ul doar verifica FORMATUL,
// nu presupune sau modifica NICIODATA continutul.
function isValidE164Phone(str) {
  return typeof str === 'string' && /^\+[1-9]\d{6,14}$/.test(str.trim());
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Token "fals", generat o singura data la pornire, cu exact aceeasi forma ca un accessToken
// real (48 caractere hex). Nu corespunde niciunei comenzi reale — e folosit STRICT ca sa
// avem mereu ceva de comparat cu safeCompare(), chiar si cand comanda ceruta nu exista.
// Fara el, ramura "comanda nu exista" ar sari peste comparatie, iar timpul de raspuns
// diferit ar deveni el insusi o scurgere de informatie (vezi /media/full/:orderId).
const DUMMY_TOKEN_FOR_TIMING = randomBytes(24).toString('hex');

// -------- foldere de stocare audio (fallback local — folosite doar daca storage.js nu are cloud activat) --------
const MEDIA_FULL_DIR = path.join(__dirname, 'media', 'full');       // privat, niciodata servit direct
const MEDIA_PREVIEW_DIR = path.join(__dirname, 'media', 'preview'); // servit doar prin /media/preview/:id/:variantId
fs.mkdirSync(MEDIA_FULL_DIR, { recursive: true });
fs.mkdirSync(MEDIA_PREVIEW_DIR, { recursive: true });

// -------- folder temporar de procesare — AICI scriem mereu, indiferent daca stocarea finala
// e cloud sau locala. E doar spatiu de lucru pentru ffmpeg (care are nevoie de fisiere reale
// pe disc, nu poate lucra direct pe un obiect din R2/S3); fisierele de aici se sterg imediat
// dupa ce sunt urcate in stocarea finala. --------
const TEMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
// curatare la pornire — resturi de la generari intrerupte (crash, restart) nu se acumuleaza la nesfarsit
for (const f of fs.readdirSync(TEMP_DIR)) {
  try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) { /* ignoram, nu e critic */ }
}

const TESTIMONIAL_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-m4a']
};
const TESTIMONIAL_MAX_BYTES = 60 * 1024 * 1024; // 60MB — suficient pentru un video scurt de telefon

// -------- incarcare fotografii/videoclipuri client, pentru pachetul "video" (memorii) --------
const ORDER_MEDIA_MIME_TYPES = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/x-adobe-dng'],
  video: ['video/mp4', 'video/quicktime', 'video/webm']
};
const ORDER_MEDIA_MAX_BYTES = 150 * 1024 * 1024; // 150MB — suficient pentru un videoclip scurt de telefon la calitate buna
const ORDER_MEDIA_MAX_ITEMS = 10;
// Minimul cerut de fluxul "Cadou video" (cerinta de business, nu doar text in UI) —
// vezi POST /api/orders/:orderId/media/confirm si /checkout, care il aplica server-side.
const ORDER_MEDIA_MIN_ITEMS = 3;
// Durata maxima acceptata per videoclip incarcat de client — configurabila, ca sa poata
// fi ajustata fara redeploy de cod daca decizia de business se schimba. Documentata in
// README/.env.example. Implicit 120s (2 minute) — suficient pentru un clip de telefon,
// suficient de mic sa nu domine disproportionat durata finala a videoclipului cadou.
const ORDER_MEDIA_MAX_VIDEO_SECONDS = Number(process.env.ORDER_MEDIA_MAX_VIDEO_SECONDS) > 0
  ? Number(process.env.ORDER_MEDIA_MAX_VIDEO_SECONDS) : 120;

// Acelasi prag ca db.claimVideoRender (20 minute) — o randare video reala dureaza cateva
// minute, niciodata atat. Folosit consecvent in toate cele 3 locuri care trebuie sa stie
// daca lock-ul de randare e cu adevarat activ (checkout, create-video, starea expusa
// clientului) sau doar un rest expirat dupa un crash/redeploy — cerinta E10.
const VIDEO_LOCK_EXPIRY_MS = 20 * 60 * 1000;
function isVideoLockActive(order) {
  return !!order.videoRenderClaimedAt && (Date.now() - new Date(order.videoRenderClaimedAt).getTime()) < VIDEO_LOCK_EXPIRY_MS;
}

// STOCARE PE DISC, NU IN MEMORIE — cu memoryStorage(), pana la ORDER_MEDIA_MAX_ITEMS (10)
// fisiere de ORDER_MEDIA_MAX_BYTES (150MB) fiecare puteau ajunge simultan in RAM-ul
// procesului Node (pana la 1.5GB per cerere) — pe o instanta Railway obisnuita, asta putea
// termina procesul (OOM kill) la un singur upload nefericit. diskStorage scrie fiecare
// fisier direct pe disc (in TEMP_DIR, deja folosit ca spatiu de lucru ffmpeg), streamed,
// fara sa retina niciodata continutul complet in memorie. `fileFilter` ramane PERMISIV —
// respinge doar la nivel de extensie evident, nu de MIME — validarea REALA (magic bytes +
// decodare ffprobe, vezi ruta POST /media) se face per-fisier in handler, ca sa putem
// raporta fiecare fisier individual, fara sa aruncam tot batch-ul din cauza unuia singur
// (vezi orderMediaErrorHandler mai jos pentru cazul in care chiar Multer respinge ceva,
// ex. dimensiune peste limita).
const orderMediaUpload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (req, file, cb) => cb(null, `upload-${randomUUID()}${path.extname(file.originalname || '').slice(0, 10)}`)
  }),
  limits: { fileSize: ORDER_MEDIA_MAX_BYTES, files: ORDER_MEDIA_MAX_ITEMS }
});

// Multer, la depasirea unei limite (fisier prea mare, prea multe fisiere), arunca o eroare
// care — daca ajunge nemodificata la middleware-ul central de erori — devine un 500 generic,
// fara niciun mesaj util clientului (exact problema semnalata explicit: "nu transforma
// erorile Multer in eroare generica 500"). Acest wrapper intercepteaza EXCLUSIV erorile
// Multer si le traduce in 4xx cu mesaj clar in romana; orice alta eroare trece mai departe
// neschimbata catre error handler-ul central.
function handleOrderMediaUpload(req, res, next) {
  orderMediaUpload.array('media', ORDER_MEDIA_MAX_ITEMS)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: `Un fișier depășește limita de ${Math.round(ORDER_MEDIA_MAX_BYTES / (1024 * 1024))}MB.`,
        LIMIT_FILE_COUNT: `Poți încărca maximum ${ORDER_MEDIA_MAX_ITEMS} materiale odată.`,
        LIMIT_UNEXPECTED_FILE: 'Prea multe fișiere trimise deodată.'
      };
      return res.status(400).json({ error: messages[err.code] || 'Eroare la încărcarea fișierului.' });
    }
    return res.status(400).json({ error: 'Eroare la încărcarea fișierului. Încearcă din nou.' });
  });
}

// ==========================================================================================
// Verificare REALA de decodare, prin ffprobe — validarea de mai sus (MIME declarat + magic
// bytes) confirma doar ca fisierul are FORMATUL corect (container-ul), nu ca serverul chiar
// poate sa-l DECODEZE. Un HEIC valid ca fisier poate folosi un profil de compresie pe care
// build-ul de ffmpeg din productie nu-l suporta; un MOV/MP4 cu codec HEVC valid ca si container
// poate esua identic la decodare. FARA aceasta verificare, un asemenea fisier era acceptat la
// upload si esua abia mult mai tarziu, in tacere, la randarea videoclipului final (fallback pe
// fundal solid, fara nicio poza a clientului si fara nicio eroare vizibila lui) — exact
// scenariul pe care auditul l-a semnalat ca risc real. Acum respingem explicit, la upload,
// orice fisier pe care ffprobe nu poate sa-l citeasca, cu un mesaj clar in limba comenzii.
// ==========================================================================================
// Primeste direct CALEA fisierului de pe disc (scris deja de multer.diskStorage) — nu mai
// scrie el insusi un fisier temporar suplimentar din buffer, cum facea inainte.
async function verifyMediaDecodable(filePath, mimetype, type) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'stream=codec_type,codec_name', '-show_entries', 'format=duration',
      filePath
    ], { timeout: 20000 });
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) { return { ok: false, reason: 'raspuns ffprobe invalid' }; }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    if (type === 'photo') {
      const hasImage = streams.some(s => s.codec_type === 'video' || s.codec_type === 'image');
      if (!hasImage) return { ok: false, reason: 'niciun flux de imagine decodabil' };
      return { ok: true };
    }
    const videoStream = streams.find(s => s.codec_type === 'video');
    if (!videoStream) return { ok: false, reason: 'niciun flux video decodabil' };
    const durationSeconds = parsed.format && parsed.format.duration ? Number(parsed.format.duration) : null;
    if (durationSeconds && durationSeconds > ORDER_MEDIA_MAX_VIDEO_SECONDS) {
      return { ok: false, reason: `durata (${Math.round(durationSeconds)}s) depășește limita de ${ORDER_MEDIA_MAX_VIDEO_SECONDS}s` };
    }
    return { ok: true, durationSeconds };
  } catch (err) {
    // Diagnostic SIGUR (fara nume de fisier client, fara continut) — necesar ca sa distingem
    // "fisierul chiar e corupt" de "ffprobe/ffmpeg de pe acest mediu nu are demuxer-ul necesar
    // pentru acest tip de fisier" (ex. constructia ffmpeg din apt poate sa nu aiba suport HEIF).
    console.error(`verifyMediaDecodable: ffprobe a esuat pentru mimetype=${mimetype}, tip=${type}:`, err.message);
    return { ok: false, reason: 'fișier corupt sau imposibil de decodat' };
  }
}

// Citeste doar primii `len` octeti ai unui fisier de pe disc — suficient pentru verificarea
// de magic bytes (bufferMatchesDeclaredType se uita cel mult la primii 12 octeti), fara sa
// incarce fisierul intreg in memorie doar pentru atat.
async function readFileHeader(filePath, len = 16) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ==========================================================================================
// Suport Apple ProRAW / DNG (hotfix 2026-08-07, problema 2) — ffmpeg NU poate decodifica un
// DNG (verificat direct: niciun decodor "dng" in build-ul de productie — un DNG e raw needemo-
// zaicat, nu un format video/imagine standard). Fisierele Apple ProRAW insa includ INTOTDEAUNA
// o previzualizare JPEG completa, incorporata direct in structura TIFF a DNG-ului, la rezolutia
// integrala a senzorului — verificat direct pe un fisier real (iPhone 12 Pro, descarcat de pe
// raw.pixls.us, arhiva de referinta folosita si de dcraw/darktable pentru testare): tag-ul
// PreviewImage avea exact 4032x3024, identic cu rezolutia senzorului acelui telefon. Extragem
// aceasta previzualizare cu exiftool (singurul instrument nou adaugat — vezi nixpacks.toml) si
// o tratam mai departe ca un JPEG obisnuit — suficient pentru fundalul unui videoclip, fara
// nevoia unui demozaic RAW complet (dcraw/libraw), mult mai greu de intretinut si inutil de
// precis pentru acest scop (nu oferim print/editare profesionala a fotografiilor RAW).
// Fallback pe JpgFromRaw daca PreviewImage lipseste (unele unelte terte scriu DNG-uri cu doar
// unul din cele doua tag-uri standard de previzualizare completa).
async function extractDngPreviewToJpeg(dngPath) {
  const attemptErrors = [];
  for (const tag of ['-PreviewImage', '-JpgFromRaw']) {
    try {
      const { stdout } = await execFileAsync('exiftool', ['-b', tag, dngPath], {
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024, // previzualizarile ProRAW pot ajunge la cativa MB
        encoding: 'buffer'
      });
      if (stdout && stdout.length > 0 && stdout.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
        const outPath = `${dngPath}.preview.jpg`;
        await fs.promises.writeFile(outPath, stdout);
        return { ok: true, path: outPath };
      }
      attemptErrors.push(`${tag}: raspuns gol sau nu e JPEG (${stdout ? stdout.length : 0} octeti)`);
    } catch (err) {
      // o eroare exiftool pentru un tag LIPSA (fisierul nu are acel tag specific) e normala —
      // incearca urmatorul tag. Retinem mesajul ca sa distingem asta de un esec real (binar
      // negasit, timeout) daca AMBELE incercari esueaza — vezi logarea de mai jos.
      attemptErrors.push(`${tag}: ${err.message}`);
    }
  }
  // Diagnostic SIGUR (fara continutul fisierului, fara nume de fisier client — doar tag-urile
  // incercate si mesajele de eroare exiftool) — necesar ca sa distingem in loguri Railway intre
  // "acest DNG chiar nu are nicio previzualizare" si "exiftool nu ruleaza deloc pe acest mediu"
  // (ex. pachetul nix nu s-a instalat) — altfel esecul era complet tacut.
  console.error('extractDngPreviewToJpeg: ambele tag-uri de previzualizare au esuat —', attemptErrors.join(' | '));
  return { ok: false, reason: 'fișierul DNG nu conține o previzualizare utilizabilă' };
}

// ==========================================================================================
// Suport HEIC/HEIF (hotfix 2026-08-08) — gasit direct la testare cu un fisier HEIC REAL
// (libheif/examples/example.heic, arhiva oficiala de referinta a proiectului libheif): ffprobe
// din build-ul de productie (ffmpeg instalat prin apt) NU poate decodifica deloc HEIC/HEIF —
// comanda esueaza cu exit code diferit de zero, desi acelasi fisier trece perfect prin ffprobe
// pe un build complet (Gyan.dev) folosit doar pentru testare locala. Fisierul era respins la
// upload ca "fisier corupt", desi era perfect valid — si chiar daca respingerea la upload ar fi
// fost ocolita, randarea FINALA a videoclipului (buildMemoryBackground -> renderMemorySegment)
// foloseste acelasi ffmpeg, deci ar fi esuat identic mai tarziu, mult mai greu de diagnosticat.
//
// HEIC nu e ca DNG — nu are o previzualizare JPEG separata incorporata (verificat: niciun tag
// PreviewImage/ThumbnailImage pe fisierul de test) — imaginea IN SINE e continutul HEVC codat.
// exiftool nu poate "extrage" ce nu exista ca tag separat; e nevoie de un decodor HEIF real.
// heif-convert (pachetul apt `libheif-examples`, adaugat separat de ffmpeg/exiftool) e un
// decodor HEIF dedicat, independent de suportul HEIF al ffmpeg — converteste direct la JPEG.
async function extractHeicToJpeg(heicPath) {
  const outPath = `${heicPath}.converted.jpg`;
  // heif-convert numeroteaza fisierele de iesire ("nume-1.jpg", "nume-2.jpg", ...) cand
  // fisierul HEIC contine mai multe imagini (ex. burst, thumbnail auxiliar) — comportament
  // nedocumentat explicit in manual, verificat empiric. Pentru poza principala a clientului
  // ne intereseaza DOAR prima imagine (nici DNG nu livreaza mai mult de o poza per fisier).
  const numberedOutPath = `${heicPath}.converted-1.jpg`;
  try {
    await execFileAsync('heif-convert', [heicPath, outPath], { timeout: 30000 });
    const direct = await fs.promises.stat(outPath).catch(() => null);
    if (direct && direct.size > 0) return { ok: true, path: outPath };
    const numbered = await fs.promises.stat(numberedOutPath).catch(() => null);
    if (numbered && numbered.size > 0) return { ok: true, path: numberedOutPath };
    return { ok: false, reason: 'heif-convert nu a produs niciun fisier de iesire' };
  } catch (err) {
    console.error('extractHeicToJpeg: heif-convert a esuat —', err.message);
    return { ok: false, reason: 'fișierul HEIC/HEIF nu a putut fi convertit' };
  }
}

// memoryStorage — fisierul ajunge in req.file.buffer, ca sa-l putem urca direct in cloud
// fara sa-l scriem intai pe disc. Pentru fallback local, il scriem noi manual din buffer.
const testimonialUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TESTIMONIAL_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const allAllowed = [...TESTIMONIAL_MIME_TYPES.image, ...TESTIMONIAL_MIME_TYPES.video, ...TESTIMONIAL_MIME_TYPES.audio];
    if (allAllowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Tip de fisier neacceptat: ${file.mimetype}`));
  }
});

// -------- fetch cu timeout — un serviciu extern blocat nu trebuie sa blocheze cererea la nesfarsit --------
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ==========================================================================================
// LOGGING DE PERFORMANTA — masoara UNDE se duce timpul intr-o generare (Suno vs. descarcare
// vs. timestamp-uri vs. FFmpeg vs. storage vs. codul nostru), fara date sensibile: doar
// identificatori scurtati (comanda/task, primele 8 caractere) si durate in milisecunde.
// Niciodata token-uri, URL-uri semnate sau continut audio/text.
// ==========================================================================================
function perfLog(orderId, stage, extra = '') {
  const tag = orderId ? String(orderId).slice(0, 8) : '?';
  console.log(`[perf] comanda ${tag} | ${stage}${extra ? ' | ' + extra : ''} | ${Date.now()}`);
}

// -------- comparatie timing-safe, folosita pentru parola de admin SI pentru access token-uri --------
// Comparam DIGESTUL SHA-256 al fiecarui sir, nu sirurile brute. Motivul: timingSafeEqual()
// e constant-time DOAR cand cele doua buffere au aceeasi lungime — cere explicit lungimi
// egale, altfel arunca eroare. Varianta veche facea `if (bufA.length !== bufB.length) return false`
// inainte de comparatie, ceea ce insemna ca un sir de lungime gresita returna fals mult mai
// repede decat unul de lungime corecta dar continut gresit — o scurgere de timp reala, prin
// care cineva ar putea afla lungimea corecta a secretului inainte sa-i ghiceasca continutul.
// Hash-uind ambele siruri la o lungime fixa (32 octeti), acea ramura dispare complet: orice
// input, indiferent de lungimea lui originala, ajunge la timingSafeEqual() pe buffere de
// aceeasi dimensiune, de fiecare data — timpul de executie nu mai depinde de lungimea
// sirului primit de la client.
function safeCompare(a, b) {
  const bufA = createHash('sha256').update(String(a || '')).digest();
  const bufB = createHash('sha256').update(String(b || '')).digest();
  return timingSafeEqual(bufA, bufB);
}

// -------- validatori simpli, fara dependinte externe --------
function isValidEmail(str) {
  return typeof str === 'string' && str.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}
function isValidString(str, minLen, maxLen) {
  return typeof str === 'string' && str.trim().length >= minLen && str.length <= maxLen;
}

// ==========================================================================================
// Stripe webhook — trebuie montat INAINTE de express.json(), Stripe cere raw body pt semnatura
// ==========================================================================================
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Detaliul erorii ramane STRICT server-side (log) — raspunsul catre apelant e generic,
    // ca sa nu oferim informatii despre motivul exact al esecului de semnatura unui atacator
    // care incearca sa forjeze un webhook (chiar daca semnatura criptografica ramane oricum
    // imposibil de fortat fara STRIPE_WEBHOOK_SECRET, nu are rost sa oferim niciun indiciu).
    console.error('Webhook signature invalida:', err.message);
    return res.status(400).json({ error: 'Webhook Error: invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;

      // CERINTA D7: "checkout.session.completed" NU inseamna neaparat plata confirmata —
      // pentru metode de plata cu decontare intarziata (ex. unele transferuri bancare),
      // sesiunea se "completeaza" (clientul a terminat formularul), dar payment_status
      // ramane 'unpaid' pana la confirmarea REALA, care vine separat, prin evenimentul
      // "checkout.session.async_payment_succeeded". Livram DOAR cand payment_status==='paid' —
      // pentru celelalte cazuri (payment_status==='unpaid' pe un completed initial), nu
      // facem nimic acum; livrarea va veni din evenimentul async_payment_succeeded, cand/daca
      // plata chiar se confirma.
      if (session.payment_status !== 'paid') {
        return res.json({ received: true, awaitingAsyncPayment: true });
      }

      const outcome = await processConfirmedPayment(event, session);
      return res.status(outcome.httpStatus).json(outcome.body);
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      // Plata intarziata a esuat definitiv — nimic de livrat, doar log/dedup, ca sa nu
      // ramana un eveniment "neprocesat" reincercat la infinit de Stripe.
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.orderId;
      await db.recordStripeEventIfNew(event.id, orderId);
      console.warn(`Comanda ${orderId || '(necunoscuta)'}: plata intarziata a esuat (checkout.session.async_payment_failed).`);
      return res.json({ received: true });
    }

    res.json({ received: true });
  } catch (err) {
    // CERINTA D8: la acest punct, orice caz "intelegem evenimentul dar refuzam sa livram"
    // (suma/moneda/versiune nepotrivita, comanda inexistenta) a fost deja tratat explicit
    // in processConfirmedPayment() cu un raspuns 200 — o eroare care ajunge AICI e una
    // TRANZITORIE, neasteptata (DB indisponibila, storage picat etc). Raspundem NON-2xx
    // intentionat: Stripe va reincerca automat evenimentul mai tarziu, in loc sa-l
    // consideram "procesat" cand de fapt clientul ar ramane platit fara livrare.
    console.error('Eroare tranzitorie la procesarea webhook-ului, Stripe va reincerca:', err.message);
    res.status(500).json({ error: 'Eroare temporară la procesare — se va reîncerca automat.' });
  }
});

// ==========================================================================================
// Proceseaza un eveniment Stripe care confirma o plata REALA (payment_status==='paid'),
// fie din "checkout.session.completed" (metode instant), fie din
// "checkout.session.async_payment_succeeded" (metode cu decontare intarziata).
//
// CERINTA D8 — ATOMICITATE: dedup-ul evenimentului (processed_stripe_events) si actualizarea
// comenzii (status='ready') se intampla IN ACEEASI TRANZACTIE Postgres (db.recordPaidOrderAtomically)
// — daca actualizarea comenzii esueaza din orice motiv tranzitoriu (DB, retea), tranzactia
// intreaga se ROLLBACK, INCLUSIV dedup-ul — Stripe va vedea evenimentul ca neprocesat inca la
// urmatoarea livrare/retry, deci NU exista nicio fereastra in care "am marcat procesat, dar
// clientul a ramas neplatit in baza noastra de date, platit la Stripe".
//
// CERINTA C6/D7 — VERIFICARI DE VERSIUNE, sumă și monedă, INAINTE de a marca orice comanda
// drept platita: suma si moneda platite chiar corespund pretului asteptat; sesiunea Stripe
// e chiar CEA MAI RECENTA creata pentru aceasta comanda (checkout_session_id se potriveste);
// varianta audio si (pentru pachetul video) revizia materialelor aprobate la checkout inca
// se potrivesc cu starea CURENTA a comenzii; iar pentru pachetul video, videoclipul acelei
// variante exacte e inca valid (nu a devenit between-timp "stale"). O sesiune veche — deschisa
// pentru o versiune pe care clientul a schimbat-o intre timp in alt tab — nu poate debloca
// sau livra versiunea gresita.
// ==========================================================================================
async function processConfirmedPayment(event, session) {
  const orderId = session.metadata && session.metadata.orderId;
  if (!orderId) return { httpStatus: 200, body: { received: true, noOrderId: true } };

  const preCheckOrder = await db.getOrderById(orderId);
  if (!preCheckOrder) return { httpStatus: 200, body: { received: true, orderNotFound: true } };

  // Verificari de INTEGRITATE — respinse sigur, fara sa marcam NIMIC drept platit.
  const expectedAmount = Number(session.metadata.expectedAmount);
  const expectedCurrency = session.metadata.expectedCurrency || 'gbp';
  if (Number.isFinite(expectedAmount) && session.amount_total !== expectedAmount) {
    console.error(`Comanda ${orderId}: suma platita (${session.amount_total}) nu corespunde sumei asteptate (${expectedAmount}) — livrare refuzata.`);
    await db.recordStripeEventIfNew(event.id, orderId);
    return { httpStatus: 200, body: { received: true, rejected: 'amount_mismatch' } };
  }
  if (session.currency && session.currency.toLowerCase() !== expectedCurrency.toLowerCase()) {
    console.error(`Comanda ${orderId}: moneda platita (${session.currency}) nu corespunde monedei asteptate (${expectedCurrency}) — livrare refuzata.`);
    await db.recordStripeEventIfNew(event.id, orderId);
    return { httpStatus: 200, body: { received: true, rejected: 'currency_mismatch' } };
  }
  // Sesiunea trebuie sa fie CEA MAI RECENTA creata pentru comanda — daca checkout_session_id
  // din baza de date arata spre o alta sesiune, clientul a deschis un checkout nou (variant
  // sau materiale schimbate) DUPA aceasta sesiune — aceasta a devenit veche/invalida.
  if (preCheckOrder.checkoutSessionId && preCheckOrder.checkoutSessionId !== session.id) {
    console.error(`Comanda ${orderId}: sesiunea Stripe ${session.id} nu mai e cea curenta (curenta: ${preCheckOrder.checkoutSessionId}) — livrare refuzata, posibila versiune veche.`);
    await db.recordStripeEventIfNew(event.id, orderId);
    return { httpStatus: 200, body: { received: true, rejected: 'stale_checkout_session' } };
  }
  const sessionVariantId = session.metadata.selectedVariantId;
  if (sessionVariantId && preCheckOrder.selectedVariantId !== sessionVariantId) {
    console.error(`Comanda ${orderId}: varianta din sesiune (${sessionVariantId}) nu mai corespunde variantei curente (${preCheckOrder.selectedVariantId}) — livrare refuzata.`);
    await db.recordStripeEventIfNew(event.id, orderId);
    return { httpStatus: 200, body: { received: true, rejected: 'stale_variant' } };
  }
  if (preCheckOrder.plan === 'video') {
    const sessionMediaRevision = Number(session.metadata.mediaRevision);
    if (Number.isFinite(sessionMediaRevision) && preCheckOrder.mediaRevision !== sessionMediaRevision) {
      console.error(`Comanda ${orderId}: revizia materialelor din sesiune (${sessionMediaRevision}) nu mai corespunde reviziei curente (${preCheckOrder.mediaRevision}) — livrare refuzata.`);
      await db.recordStripeEventIfNew(event.id, orderId);
      return { httpStatus: 200, body: { received: true, rejected: 'stale_media_revision' } };
    }
    const videoVariant = (preCheckOrder.variants || []).find(v => v.id === preCheckOrder.selectedVariantId);
    if (preCheckOrder.videoStaleReason || !videoVariant || !videoVariant.videoKey) {
      console.error(`Comanda ${orderId}: videoclipul variantei curente nu (mai) e valid la momentul confirmarii platii — livrare refuzata.`);
      await db.recordStripeEventIfNew(event.id, orderId);
      return { httpStatus: 200, body: { received: true, rejected: 'video_not_valid' } };
    }
  }

  // Date de tranzactie pastrate pentru evidenta contabila si pregatire OSS — strict cele
  // returnate de Stripe, fara nicio presupunere sau calcul propriu. NU logam sesiunea Stripe
  // intreaga (contine date de client) — doar campurile specifice de care avem nevoie.
  const customerCountry = (session.customer_details && session.customer_details.address && session.customer_details.address.country) || null;
  const paymentCurrency = session.currency || null;
  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const taxAmount = (session.total_details && typeof session.total_details.amount_tax === 'number')
    ? session.total_details.amount_tax / 100
    : null;
  const stripePaymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : (session.payment_intent && session.payment_intent.id) || null;

  const result = await db.recordPaidOrderAtomically(event.id, orderId, {
    status: 'ready',
    paidAt: new Date().toISOString(),
    customerCountry,
    paymentCurrency,
    amountTotal,
    taxAmount,
    stripeSessionId: session.id,
    stripePaymentIntentId
  });

  if (!result.isNewEvent) return { httpStatus: 200, body: { received: true, duplicate: true } };
  if (!result.order) return { httpStatus: 200, body: { received: true, orderNotFound: true } };
  if (result.alreadyPaid) return { httpStatus: 200, body: { received: true, alreadyPaid: true } };

  const updated = result.order;
  sendDeliveryEmail(updated).catch(err => {
    console.error('Email de livrare esuat pentru comanda', orderId, err.message);
    // nu blocam livrarea — clientul tot poate lua melodia din pagina de succes
  });
  // Extrasul WAV (premium/video) porneste asincron dupa plata — generatePremiumExtras insasi
  // verifica order.plan si nu face nimic pentru "standard". Videoclipul (plan "video") NU
  // se genereaza aici — la acest punct e DEJA gata (relansare 2026-08-06: randarea video
  // se face automat INAINTE de plata; checkout-ul de mai sus refuza plata daca nu e gata),
  // deci aici doar WAV-ul mai poate lipsi.
  generatePremiumExtras(orderId).catch(err => {
    console.error('Generarea extraselor de pachet a esuat pentru comanda', orderId, err.message);
  });

  return { httpStatus: 200, body: { received: true } };
}

// -------- securitate: headere HTTP standard. CSP dezactivat explicit — paginile folosesc
// script/style inline, o politica CSP stricta le-ar rupe fara o refactorizare separata. --------
app.use(helmet({ contentSecurityPolicy: false }));
// Permissions-Policy: site-ul nu foloseste camera/microfon/geolocatie/plati-web-API etc. —
// blocarea lor explicita nu costa nimic functional si reduce suprafata de atac daca vreun
// script tert (sau o vulnerabilitate viitoare) ar incerca sa le acceseze.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
});

// -------- IP-ul real al clientului, pe Railway --------
// Verificat direct (2026-08-03, audit de securitate): X-Forwarded-For contine DOAR 2 IP-uri
// (clientul real + hop-ul intern Railway), dar hop-ul intern NU e stabil — se roteste
// dintr-un pool (152.233.29.2, .3, .4... vazute direct in teste), deci `trust proxy` bazat
// pe numar de hop-uri SAU pe un interval CIDR presupus produce chei diferite la cereri
// consecutive de la acelasi client real, facand rate limiting-ul nefiabil (verificat: acelasi
// IP sursa, ratelimit-remaining fluctua nemonoton intre cereri consecutive). Railway seteaza
// insa un header dedicat, X-Real-IP, cu IP-ul real al clientului — stabil, si confirmat
// direct ca nu poate fi falsificat de client (Railway il suprascrie mereu la edge, indiferent
// ce trimite clientul). Toate limiter-ele de mai jos cheie explicit pe acest header.
function realClientIp(req) {
  return req.headers['x-real-ip'] || req.ip;
}

// -------- rate limiting pe rutele care costa bani (apeleaza API-ul de muzica) sau sunt tinta de abuz --------
const orderCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: realClientIp,
  message: { error: 'Prea multe comenzi create de la această adresă. Încearcă din nou mai târziu' }
});
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  keyGenerator: realClientIp,
  message: { error: 'Prea multe generări solicitate. Încearcă din nou mai târziu' }
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: realClientIp,
  message: { error: 'Prea multe încercări. Încearcă din nou mai târziu' }
});
// Panoul de admin e cel mai privilegiat punct de acces din aplicatie (acces la toate
// comenzile/emailurile clientilor) si, spre deosebire de toate rutele de mai sus, nu avea
// NICIUN rate limiting — Basic Auth putea fi incercat la nesfarsit. skipSuccessfulRequests:
// true inseamna ca doar incercarile ESUATE (401) conteaza spre limita — adminul autentificat
// corect nu e limitat niciodata, indiferent cate cereri face panoul in sesiunea lui.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: realClientIp,
  message: { error: 'Prea multe încercări de autentificare. Încearcă din nou mai târziu' }
});

// -------- Login owner: HTTP Basic Auth pentru panoul de admin --------
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin NALUNA"');
    return res.status(401).send('Autentificare necesară');
  }

  const decoded = Buffer.from(header.split(' ')[1], 'base64').toString();
  const sepIndex = decoded.indexOf(':');
  const user = decoded.slice(0, sepIndex);
  const pass = decoded.slice(sepIndex + 1);

  if (safeCompare(user, process.env.ADMIN_USER) && safeCompare(pass, process.env.ADMIN_PASSWORD)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin NALUNA"');
  return res.status(401).send('Date de autentificare incorecte');
}

app.get('/admin', adminAuthLimiter, requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});
app.use('/api/admin', adminAuthLimiter, requireAdminAuth);

app.get('/api/admin/orders', async (req, res, next) => {
  try {
    const list = await db.listOrders();
    const revenue = await db.computeRevenue();
    res.json({ orders: list, revenue, count: list.length });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// PANOU CREDITE SUNO — vizibilitate completa asupra sistemului de protectie a creditelor
// (vezi credits.js): balanta live, rezerva de siguranta, mod de urgenta, statistici zilnice,
// estimare comenzi ramase, detectare consum neobisnuit. Protejat de acelasi middleware
// admin ca restul rutelor /api/admin (vezi app.use mai sus).
// ==========================================================================================
app.get('/api/admin/credits', async (req, res, next) => {
  try {
    const { balance, stale, unavailable } = await credits.getBalance({ forceRefresh: true });
    const baseline = unavailable ? null : await credits.getOrInitBaseline(db, balance);
    const alertLevel = credits.getAlertLevel(balance, baseline);
    const daily = await credits.getDailyStats(db);
    const anomaly = await credits.detectAnomaly(db);
    const alertState = await db.getCreditAlertState();
    const stats = balance !== null ? await credits.computeThresholdAlertStats(db, balance) : null;

    res.json({
      provider: 'sunoapi.org',
      providerConfigured: credits.providerConfigured(),
      balance,
      balanceStale: stale,
      balanceUnavailable: unavailable,
      baseline,
      alertLevel,
      emergencyMode: credits.isEmergencyMode(balance),
      safetyReserveOrders: credits.SAFETY_RESERVE_ORDERS,
      reserveCredits: credits.reserveCredits(),
      creditsPerGeneration: credits.VERIFIED_CREDITS_PER_GENERATION,
      creditsPerOrderEstimate: credits.CREDITS_PER_ORDER_ESTIMATE,
      maxGenerationAttempts: credits.MAX_GENERATION_ATTEMPTS,
      estimatedRemainingOrders: credits.estimatedRemainingOrders(balance),
      today: daily,
      anomaly,
      fixedThresholdAlert: {
        threshold: credits.FIXED_ALERT_THRESHOLD,
        recipientConfigured: !!credits.ADMIN_ALERT_EMAIL,
        armed: alertState ? alertState.armed : null,
        lastAlertSentAt: alertState ? alertState.lastAlertSentAt : null,
        lastKnownBalance: alertState ? alertState.lastBalance : null,
        estimatedRemainingOrdersBestCase: stats ? stats.bestCaseRemainingOrders : null,
        estimatedRemainingOrdersWorstCase: stats ? stats.worstCaseRemainingOrders : null,
        estimatedRemainingDays: stats ? stats.remainingDaysMessage : null
      }
    });
  } catch (err) {
    next(err);
  }
});

// Utilitar de TESTARE — permite verificarea completa a logicii de alerta la prag fix
// (vezi credits.checkFixedThresholdAlert) cu o balanta SIMULATA, fara sa consume niciun
// credit real Suno. Protejat de acelasi middleware admin ca restul rutelor /api/admin.
// Util permanent pentru retestarea sigura a sistemului de alerte, nu doar o unealta
// temporara de dezvoltare.
app.post('/api/admin/credits/test-alert', express.json(), async (req, res, next) => {
  try {
    const mockBalance = Number(req.body?.balance);
    if (!Number.isFinite(mockBalance)) {
      return res.status(400).json({ error: 'Trimite un camp numeric "balance" in corpul cererii.' });
    }
    await credits.checkFixedThresholdAlert(db, mockBalance);
    const alertState = await db.getCreditAlertState();
    res.json({ tested: true, mockBalance, alertState });
  } catch (err) {
    next(err);
  }
});

// Reincercare manuala a extraselor de pachet (WAV/video) pentru o comanda deja platita —
// util operational permanent, nu doar pentru testare: daca generatePremiumExtras esueaza
// din orice motiv tranzitoriu (retea, timeout ffmpeg etc.), altfel clientul care a platit
// deja pentru premium/video ar ramane fara extrasul lui pentru totdeauna, fara nicio cale
// de recuperare in afara unei interventii manuale in baza de date.
app.post('/api/admin/orders/:orderId/retry-extras', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comandă invalid.' });
    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu există.' });
    if (order.status !== 'ready' && order.status !== 'preview_ready') return res.status(400).json({ error: 'Comanda nu e încă plătită.' });

    // Pachetul "video" trece prin acelasi punct unic de intrare (triggerVideoGeneration),
    // cu rezervarea atomica persistenta — un admin care da retry nu trebuie sa poata porni
    // o a doua randare in paralel cu una deja in curs, declansata automat de flux.
    // generatePremiumExtras() genereaza si WAV-ul in acelasi apel (comun premium/video),
    // deci un singur retry acopera ambele extrase pentru pachetul video.
    if (order.plan === 'video' && order.selectedVariantId) {
      await triggerVideoGeneration(order.id, order.selectedVariantId);
    } else {
      await generatePremiumExtras(req.params.orderId, { forceVideo: false });
    }
    const fresh = await db.getOrderById(req.params.orderId);
    const variant = (fresh.variants || []).find(v => v.id === fresh.selectedVariantId);
    res.json({ retried: true, hasWav: !!(variant && variant.wavKey), hasVideo: !!(variant && variant.videoKey), videoFailedReason: variant ? variant.videoFailedReason || null : null });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// CERINTA G14 — curatare comenzi ABANDONATE (pachetul video, upload de materiale inceput dar
// niciodata dus la capat — client a incarcat poze, apoi a parasit pagina definitiv, comanda
// ramane 'draft' la nesfarsit, materialele raman platite in R2 fara sa fie vreodata folosite).
//
// INTENTIONAT declansata manual de admin (nu un cron automat) — o stergere gresita de date de
// client, chiar orfane, e o actiune ireversibila cu consecinte reale; un admin uman decide
// cand si daca ruleaza, dupa ce vede exact ce ar fi afectat (implicit `dryRun: true`).
//
// Criteriu: plan='video', status='draft' (melodia nu a inceput niciodata sa se genereze —
// nu atinge NICIODATA comenzi cu o melodie sau plata reala), creata cu mai mult de
// `olderThanDays` zile in urma (implicit 14). NU sterge NICIODATA comenzi 'ready' (platite)
// sau cu variante deja generate — acelea sunt livrabile valide ale unor comenzi existente,
// exact ce cerinta G14 interzice explicit sa fie sterse.
// ==========================================================================================
app.post('/api/admin/cleanup/abandoned-uploads', express.json(), async (req, res, next) => {
  try {
    const olderThanDays = Number(req.body?.olderThanDays) > 0 ? Number(req.body.olderThanDays) : 14;
    const dryRun = req.body?.dryRun !== false; // implicit TRUE — trebuie cerut explicit dryRun:false pentru stergere reala

    const allOrders = await db.listOrders();
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const candidates = allOrders.filter(o =>
      o.plan === 'video' &&
      o.status === 'draft' &&
      (o.variants || []).length === 0 &&
      (o.uploadedMedia || []).length > 0 &&
      new Date(o.createdAt).getTime() < cutoff
    );

    if (dryRun) {
      return res.json({
        dryRun: true,
        candidateCount: candidates.length,
        candidates: candidates.map(o => ({ id: o.id, createdAt: o.createdAt, mediaCount: (o.uploadedMedia || []).length }))
      });
    }

    let deletedOrders = 0;
    let deletedFiles = 0;
    for (const order of candidates) {
      const files = order.uploadedMedia || [];
      const results = await Promise.allSettled(files.map(f => storage.deletePrivateFile(f.key)));
      deletedFiles += results.filter(r => r.status === 'fulfilled').length;
      await db.updateOrder(order.id, { uploadedMedia: [] });
      deletedOrders++;
    }
    res.json({ dryRun: false, deletedOrders, deletedFiles });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// REACTII CLIENTI (testimonials) — gestionate exclusiv din /admin.
// Nu exista, in aceasta etapa, niciun formular public de upload — un client nu poate
// trimite singur o reactie. Doar administratorul adauga/editeaza/sterge, dupa ce a
// primit materialul direct de la client (WhatsApp, email etc.) si are acordul lui.
// ==========================================================================================

const TESTIMONIAL_TYPES = ['text', 'image', 'video', 'audio'];

function isTruthy(v) {
  return v === true || v === 'true' || v === 'on' || v === '1';
}

// urca fisierul unui testimonial (din buffer-ul dat de multer) — mereu in bucket-ul PUBLIC,
// pentru ca reactiile clientilor sunt continut de marketing, menit sa fie vazut de oricine
async function saveTestimonialFile(file) {
  const ext = path.extname(file.originalname).toLowerCase() || '';
  const key = `testimonials/${randomUUID()}${ext}`;
  await storage.uploadPublicBuffer(file.buffer, key, file.mimetype);
  return key;
}

async function deleteTestimonialFile(mediaKey) {
  if (!mediaKey) return;
  try {
    await storage.deletePublicFile(mediaKey);
  } catch (err) {
    console.error('Nu am putut sterge fisierul vechi de testimonial:', err.message);
  }
}

// converteste cheia stocata in DB intr-un URL utilizabil direct de browser —
// URL public din bucket-ul public (sau path local, in fallback fara cloud)
function resolveTestimonialMediaUrl(mediaKey) {
  if (!mediaKey) return null;
  return storage.getPublicUrl(mediaKey);
}

app.get('/api/admin/testimonials', async (req, res, next) => {
  try {
    const list = await db.listAllTestimonials();
    const withUrls = list.map(t => ({ ...t, mediaPath: resolveTestimonialMediaUrl(t.mediaPath) }));
    res.json({ testimonials: withUrls });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/testimonials', (req, res, next) => {
  testimonialUpload.single('media')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message });

      const { firstName, location, quote, mediaType } = req.body;
      const published = isTruthy(req.body.published);
      const consentConfirmed = isTruthy(req.body.consentConfirmed);

      if (!isValidString(firstName, 1, 80)) {
        return res.status(400).json({ error: 'Prenumele clientului este obligatoriu (max 80 caractere).' });
      }
      if (!isValidString(quote, 3, 500)) {
        return res.status(400).json({ error: 'Citatul trebuie să aibă între 3 și 500 de caractere.' });
      }
      if (!TESTIMONIAL_TYPES.includes(mediaType)) {
        return res.status(400).json({ error: 'Tip de reacție invalid.' });
      }
      if (!consentConfirmed) {
        return res.status(400).json({ error: 'Trebuie să confirmi că ai acordul clientului pentru publicare.' });
      }
      if (mediaType !== 'text' && req.file) {
        const expected = TESTIMONIAL_MIME_TYPES[mediaType] || [];
        if (!expected.includes(req.file.mimetype)) {
          return res.status(400).json({ error: `Fișierul încărcat nu corespunde tipului "${mediaType}".` });
        }
        if (!bufferMatchesDeclaredType(req.file.buffer, req.file.mimetype)) {
          return res.status(400).json({ error: 'Conținutul fișierului nu corespunde tipului declarat.' });
        }
      }

      const mediaKey = req.file ? await saveTestimonialFile(req.file) : null;

      const testimonial = await db.createTestimonial({
        id: randomUUID(),
        firstName: firstName.trim(),
        location: location ? location.trim().slice(0, 100) : null,
        quote: quote.trim(),
        mediaType,
        mediaPath: mediaKey,
        published,
        consentConfirmed
      });

      res.json({ testimonial: { ...testimonial, mediaPath: resolveTestimonialMediaUrl(testimonial.mediaPath) } });
    } catch (err) {
      next(err);
    }
  });
});

app.put('/api/admin/testimonials/:id', (req, res, next) => {
  testimonialUpload.single('media')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message });
      if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID invalid.' });

      const existing = await db.getTestimonialById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Reacția nu există.' });

      const { firstName, location, quote, mediaType } = req.body;
      const published = isTruthy(req.body.published);
      const consentConfirmed = isTruthy(req.body.consentConfirmed);

      if (!isValidString(firstName, 1, 80)) {
        return res.status(400).json({ error: 'Prenumele clientului este obligatoriu (max 80 caractere).' });
      }
      if (!isValidString(quote, 3, 500)) {
        return res.status(400).json({ error: 'Citatul trebuie să aibă între 3 și 500 de caractere.' });
      }
      if (!TESTIMONIAL_TYPES.includes(mediaType)) {
        return res.status(400).json({ error: 'Tip de reacție invalid.' });
      }
      if (!consentConfirmed) {
        return res.status(400).json({ error: 'Trebuie să confirmi că ai acordul clientului pentru publicare.' });
      }
      if (mediaType !== 'text' && req.file) {
        const expected = TESTIMONIAL_MIME_TYPES[mediaType] || [];
        if (!expected.includes(req.file.mimetype)) {
          return res.status(400).json({ error: `Fișierul încărcat nu corespunde tipului "${mediaType}".` });
        }
        if (!bufferMatchesDeclaredType(req.file.buffer, req.file.mimetype)) {
          return res.status(400).json({ error: 'Conținutul fișierului nu corespunde tipului declarat.' });
        }
      }

      const patch = {
        firstName: firstName.trim(),
        location: location ? location.trim().slice(0, 100) : null,
        quote: quote.trim(),
        mediaType,
        published,
        consentConfirmed
      };

      if (req.file) {
        patch.mediaPath = await saveTestimonialFile(req.file);
        await deleteTestimonialFile(existing.mediaPath);
      } else if (mediaType === 'text' && existing.mediaPath) {
        await deleteTestimonialFile(existing.mediaPath);
        patch.mediaPath = null;
      }

      const testimonial = await db.updateTestimonial(req.params.id, patch);
      res.json({ testimonial: { ...testimonial, mediaPath: resolveTestimonialMediaUrl(testimonial.mediaPath) } });
    } catch (err) {
      next(err);
    }
  });
});

app.delete('/api/admin/testimonials/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID invalid.' });

    const existing = await db.getTestimonialById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Reacția nu există.' });

    await deleteTestimonialFile(existing.mediaPath);
    await db.deleteTestimonial(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/testimonials/:id/move', express.json(), async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID invalid.' });
    const { direction } = req.body || {};
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: 'Direcție invalidă.' });
    }

    const testimonial = await db.moveTestimonial(req.params.id, direction);
    if (!testimonial) return res.status(404).json({ error: 'Reacția nu există.' });
    res.json({ testimonial: { ...testimonial, mediaPath: resolveTestimonialMediaUrl(testimonial.mediaPath) } });
  } catch (err) {
    next(err);
  }
});

// -------- Reactii publicate — endpoint public, folosit de homepage --------
app.get('/api/testimonials', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 12);
    const list = await db.listPublishedTestimonials(limit);
    // camp intern, nu-l expunem niciodata public
    const safe = list.map(({ consentConfirmed, ...rest }) => ({ ...rest, mediaPath: resolveTestimonialMediaUrl(rest.mediaPath) }));
    res.json({ testimonials: safe });
  } catch (err) {
    next(err);
  }
});

app.use(express.json({ limit: '20kb' })); // limita de marime — nu accepta payload-uri uriase
// Cache lung (7 zile) DOAR pentru imagini/iconite (logo, favicon, og-image) — practic nu se
// schimba niciodata, si fara asta fiecare vizita re-verifica fiecare imagine cu serverul
// (maxAge implicit al express.static e 0). Paginile HTML raman NECACHE-uite (maxAge implicit,
// nemodificat) — contin logica aplicatiei, care se poate schimba intre doua vizite, si un
// client cu o copie veche cache-uita ar rula cod cu bug-uri deja reparate.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(png|svg|ico|jpg|jpeg|webp)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// ==========================================================================================
// 1. Creeaza comanda (fara plata) — VALIDARE STRICTA + PRET CALCULAT SERVER-SIDE
// ==========================================================================================
app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {
  try {
    const { occasion, recipient, senderName, relationship, email, phone, story, genre, genre2, plan, lang, voicePreference } = req.body || {};
    const safeLang = ALLOWED_LANGS.includes(lang) ? lang : 'ro';

    if (!ALLOWED_OCCASIONS.includes(occasion)) {
      return res.status(400).json({ error: 'Ocazie invalidă.' });
    }
    if (!isValidString(recipient, 1, 60)) {
      return res.status(400).json({ error: missingFieldMessage('recipient', safeLang) });
    }
    if (!isValidString(senderName, 1, 100)) {
      return res.status(400).json({ error: missingFieldMessage('sender', safeLang) });
    }
    if (!isValidString(relationship, 1, 60)) {
      return res.status(400).json({ error: missingFieldMessage('relationship', safeLang) });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Adresa de email nu este validă.' });
    }
    // Telefonul (WhatsApp) e OPTIONAL — gol e intotdeauna acceptat. Daca e trimis, TREBUIE sa
    // fie deja format international E.164 (frontend-ul il normalizeaza inainte sa trimita) —
    // validat aici independent de orice tara anume; NU presupunem si NU inlocuim niciodata
    // cu un prefix implicit (ex. +44). Un client din orice tara poate trimite orice numar
    // international valid.
    const safePhone = (typeof phone === 'string' && phone.trim()) ? phone.trim() : null;
    if (safePhone && !isValidE164Phone(safePhone)) {
      return res.status(400).json({ error: invalidPhoneMessage(safeLang) });
    }
    if (!isValidString(story, 5, 2000)) {
      return res.status(400).json({ error: missingFieldMessage('story', safeLang) });
    }
    if (!ALLOWED_GENRES.includes(genre)) {
      return res.status(400).json({ error: 'Gen muzical invalid.' });
    }
    if (!PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Pachet invalid.' });
    }
    // REGULA FINALA A PACHETELOR (2026-08-07): Standard = o singura melodie, un singur gen.
    // Premium/Video = doua melodii COMPLETE, in doua genuri DIFERITE, alese explicit de
    // client — validate server-side, niciodata doar in UI (un client care manipuleaza
    // requestul din devtools nu poate obtine entitlement Premium platind Standard, si nici
    // nu poate forta doua melodii identice la Premium/Video).
    let safeGenre2 = null;
    if (PLAN_VARIANT_COUNT[plan] === 2) {
      if (!ALLOWED_GENRES.includes(genre2)) {
        return res.status(400).json({ error: genre2Message(safeLang) });
      }
      if (genre2 === genre) {
        return res.status(400).json({ error: sameGenreMessage(safeLang) });
      }
      safeGenre2 = genre2;
    }
    // Preferinta de voce e optionala la creare (implicit 'auto' daca lipseste), dar daca
    // e trimisa, TREBUIE sa fie una din cele 4 valori acceptate — nu acceptam orice text.
    const safeVoicePreference = (voicePreference === undefined || voicePreference === null || voicePreference === '')
      ? 'auto'
      : voicePreference;
    if (!VOICE_PREFERENCES.includes(safeVoicePreference)) {
      return res.status(400).json({ error: invalidVoiceMessage(safeLang) });
    }

    // IMPORTANT: pretul NU vine niciodata din req.body — se calculeaza aici, dupa pachetul
    // ales, indiferent ce a trimis clientul in payload. Asta previne manipularea pretului.
    const price = PLAN_PRICES[plan];

    const order = await db.createOrder({
      id: randomUUID(),
      accessToken: randomBytes(24).toString('hex'),
      occasion, recipient: recipient.trim(), email: email.trim().toLowerCase(),
      story: story.trim(), genre, genre2: safeGenre2, plan, price, lang: safeLang,
      status: 'draft', editsUsed: 0, variants: [], selectedVariantId: null,
      senderName: senderName.trim(), relationship: relationship.trim(),
      voicePreference: safeVoicePreference,
      phone: safePhone
    });

    res.json({ orderId: order.id, accessToken: order.accessToken });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// SECURITATE: toate rutele care MODIFICA o comanda (genereaza, regenereaza, salveaza versuri,
// selecteaza varianta, initiaza plata) cer OBLIGATORIU accessToken-ul comenzii — nu doar
// UUID-ul. Fara asta, oricine ar ghici/intercepta un orderId ar putea porni generari,
// consuma editari gratuite sau initia plati pentru comanda altcuiva.
//
// Token-ul e acceptat fie din header-ul dedicat X-Access-Token, fie din body ({accessToken}),
// pentru flexibilitate — dar e verificat mereu timing-safe (safeCompare) fata de
// order.accessToken. Daca lipseste sau nu se potriveste, raspunsul e generic (404, "Comanda
// nu exista"), identic cu cazul in care comanda chiar nu exista — nu se poate deduce daca
// UUID-ul e valid doar din diferenta de raspuns.
//
// Comenzile vechi nu exista fara accessToken (campul e generat la fiecare creare de comanda,
// dintotdeauna) — deci nu exista niciun caz real in care tokenul ar lipsi legitim; nu a fost
// nevoie de nicio exceptie de compatibilitate.
async function requireOrderToken(req, res, next) {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comandă invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    const token = req.get('X-Access-Token') || (req.body && req.body.accessToken) || null;

    if (!order || !token || !safeCompare(token, order.accessToken)) {
      return res.status(404).json({ error: 'Comanda nu există' });
    }

    req.order = order; // evita un al doilea SELECT in handler-ul care urmeaza
    next();
  } catch (err) {
    next(err);
  }
}

// ==========================================================================================
// 2. Genereaza o PERECHE de variante — GRATUIT, inainte de plata
// ==========================================================================================
app.post('/api/orders/:orderId/generate', generationLimiter, requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (!order) return res.status(404).json({ error: 'Comanda nu există.' });
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });

    // Fluxul obligatoriu "Cadou video": materialele trebuie incarcate SI confirmate explicit
    // ("5. Confirmă selecția materialelor") INAINTE ca generarea gratuita a melodiei sa
    // poata porni ("6. Numai după salvarea tuturor materialelor începe generarea melodiei") —
    // verificare server-side, nu doar ordine sugerata in interfata (un client care ar apela
    // acest endpoint direct, fara sa fi trecut prin UI, nu poate ocoli pasul de upload).
    if (order.plan === 'video' && !order.mediaConfirmedAt) {
      return res.status(400).json({ error: 'Încarcă și confirmă fotografiile/videoclipurile înainte de a genera melodia.' });
    }

    // Blocaj impotriva a doua generari in paralel pentru aceeasi comanda — fara asta,
    // un dublu-click sau un retry de pe client ar putea porni un al doilea task SunoAPI
    // in timp ce primul e inca activ, consumand credite degeaba pentru aceeasi comanda.
    // NU pornim un task nou — in schimb, daca exista deja un music_task_id valid, relansam
    // (in fundal, garda impotriva suprapunerii) o verificare a task-ului existent, ca
    // "plasa de siguranta" suplimentara fata de callback-ul SunoAPI. Premium/Video (doua
    // sarcini): CRITIC sa folosim resumeDualTaskPolling (asteapta+finalizeaza AMBELE sarcini),
    // nu resumeExistingTaskPolling (o singura sarcina) — altfel o comanda ramasa 'generating'
    // peste fereastra locala de polling a rundei initiale (vezi waitForDualTaskAndFinalize)
    // nu ar mai putea fi NICIODATA recuperata automat.
    if (order.status === 'generating' || order.status === 'processing_provider_result') {
      if (order.musicTaskId2) {
        resumeDualTaskPolling(order.id);
      } else if (order.musicTaskId) {
        resumeExistingTaskPolling(order.id, order.musicTaskId);
      }
      return res.status(409).json({ error: 'Generarea este deja în desfășurare.' });
    }

    // Protectie credite Suno — vezi credits.js. Doua verificari distincte:
    // 1. limita DURA de incercari per comanda (generation_attempts), impotriva reincercarilor
    //    nelimitate ale unei generari care esueaza constant;
    // 2. balanta reala a contului, cu rezerva de siguranta configurabila (implicit 10 comenzi).
    if (order.generationAttempts >= credits.MAX_GENERATION_ATTEMPTS) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_retry_limit', note: `attempts=${order.generationAttempts}` });
      return res.status(429).json({ error: 'Ai atins numărul maxim de încercări pentru această comandă. Contactează-ne pentru ajutor.' });
    }
    const guard = await credits.evaluateGuard('generation');
    if (!guard.allowed) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_low_credit', balanceAfter: guard.balance, note: guard.reason });
      return res.status(503).json({ error: 'Ne pare rău, sistemul este temporar indisponibil pentru comenzi noi. Te rugăm să încerci din nou în câteva minute.' });
    }

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;

    const claimed = await db.claimOrderForInitialGeneration(order.id, credits.MAX_GENERATION_ATTEMPTS);
    if (!claimed) {
      return res.status(409).json({ error: 'Generarea este deja în desfășurare.' });
    }
    res.json({ started: true });

    runGeneration(order.id, feedback).catch(async (err) => {
      console.error('Eroare la generare pentru comanda', order.id, err.message);
      try {
        // refundEditIfReserved e un no-op sigur aici — generarea INITIALA nu seteaza
        // niciodata edit_reserved=true (doar regenerarea o face) — dar il apelam oricum,
        // ca plasa de siguranta consistenta pe toate caile de esec ale generarii.
        await db.refundEditIfReserved(order.id);
        await markGenerationFailed(order.id, err.message || err);
      } catch (dbErr) {
        console.error('Eroare suplimentara la salvarea starii de esec:', dbErr.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 3. Regenereaza (editare) — o noua pereche de variante, limitat la FREE_EDITS
// ==========================================================================================
app.post('/api/orders/:orderId/regenerate', generationLimiter, requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;

    // Varianta sursa e OBLIGATORIE (Partea 2) — clientul trebuie sa aleaga explicit
    // varianta 1 sau 2 din melodia-mea.html. NU mai acceptam o regenerare fara variantId
    // (nu mai deducem "ultima editata", "prima varianta" sau vreo alta varianta implicita).
    const requestedVariantId = typeof req.body?.variantId === 'string' ? req.body.variantId : null;
    if (!requestedVariantId) {
      return res.status(400).json({ error: sourceVariantRequiredMessage(order.lang) });
    }
    const sourceVariant = (order.variants || []).find(v => v.id === requestedVariantId);
    if (!sourceVariant) {
      return res.status(400).json({ error: 'Varianta nu există.' });
    }

    // Preferinta de voce e OPTIONALA la regenerare (clientul o poate schimba sau o poate
    // lasa neschimbata) — dar daca e trimisa, TREBUIE sa fie una din cele 4 valori
    // acceptate. O valoare invalida respinge cererea INAINTE de a rezerva vreo editare.
    const requestedVoice = typeof req.body?.voicePreference === 'string' ? req.body.voicePreference : null;
    if (requestedVoice !== null && !VOICE_PREFERENCES.includes(requestedVoice)) {
      return res.status(400).json({ error: invalidVoiceMessage(order.lang) });
    }

    // Schimbarea genului muzical la editare (hotfix 2026-08-08) — OPTIONALA, la fel ca vocea:
    // clientul poate lasa genul neschimbat. Daca e trimis, trebuie sa fie unul din genurile
    // reale ale formularului. Pentru Premium/Video (doua genuri diferite, cate unul per
    // varianta), noul gen NU poate fi identic cu genul CELEILALTE variante (neatinsa de
    // aceasta regenerare) — cele doua genuri raman mereu diferite, cerinta explicita.
    const requestedGenre = typeof req.body?.genre === 'string' ? req.body.genre : null;
    if (requestedGenre !== null && !ALLOWED_GENRES.includes(requestedGenre)) {
      return res.status(400).json({ error: invalidGenreMessage(order.lang) });
    }
    const isDualGenrePlanForRegen = PLAN_VARIANT_COUNT[order.plan] === 2;
    if (requestedGenre !== null && isDualGenrePlanForRegen) {
      const otherVariant = (order.variants || []).find(v => v.id !== requestedVariantId);
      const otherGenre = (otherVariant && otherVariant.genre) || null;
      if (otherGenre && requestedGenre === otherGenre) {
        return res.status(400).json({ error: sameGenreMessage(order.lang) });
      }
    }

    // Protectie credite Suno — vezi credits.js. Verificata INAINTE de rezervarea atomica de
    // mai jos, care oricum aplica separat limita de incercari (generation_attempts) direct
    // in SQL — verificarea de aici doar da un mesaj clar clientului fara sa mai incerce
    // rezervarea cand stim deja ca va fi respinsa din motive de credit.
    if (order.generationAttempts >= credits.MAX_GENERATION_ATTEMPTS) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_retry_limit', note: `attempts=${order.generationAttempts}` });
      return res.status(429).json({ error: 'Ai atins numărul maxim de încercări pentru această comandă. Contactează-ne pentru ajutor.' });
    }
    const guard = await credits.evaluateGuard('generation');
    if (!guard.allowed) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_low_credit', balanceAfter: guard.balance, note: guard.reason });
      return res.status(503).json({ error: 'Ne pare rău, sistemul este temporar indisponibil pentru regenerări noi. Te rugăm să încerci din nou în câteva minute.' });
    }

    // REZERVARE ATOMICA: status -> 'generating', edits_used + 1, edit_reserved = true,
    // generation_attempts + 1, si (optional) noua preferinta de voce — toate intr-o singura
    // instructiune SQL (vezi db.claimOrderForRegeneration). Previne doua regenerari simultane,
    // depasirea editarilor gratuite, depasirea limitei DURE de incercari, si salveaza noua
    // preferinta de voce DOAR daca regenerarea chiar porneste (nu doar la o incercare respinsa).
    const claimed = await db.claimOrderForRegeneration(order.id, FREE_EDITS, requestedVoice, credits.MAX_GENERATION_ATTEMPTS);
    if (!claimed) {
      // Recitim starea curenta doar ca sa dam mesajul de eroare potrivit clientului —
      // rezervarea insasi a esuat deja atomic mai sus, deci nu exista nicio cursa aici.
      const fresh = await db.getOrderById(order.id);
      if (fresh && fresh.status === 'ready') {
        return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });
      }
      if (fresh && fresh.editsUsed >= FREE_EDITS) {
        return res.status(400).json({ error: 'Ai folosit editarea gratuită pentru această comandă. Alege varianta preferată pentru a continua.' });
      }
      if (fresh && fresh.generationAttempts >= credits.MAX_GENERATION_ATTEMPTS) {
        return res.status(429).json({ error: 'Ai atins numărul maxim de încercări pentru această comandă. Contactează-ne pentru ajutor.' });
      }
      if (fresh && (fresh.status === 'generating' || fresh.status === 'processing_provider_result')) {
        if (fresh.musicTaskId2) {
          resumeDualTaskPolling(order.id);
        } else if (fresh.musicTaskId) {
          resumeExistingTaskPolling(order.id, fresh.musicTaskId);
        }
      }
      return res.status(409).json({ error: 'Generarea este deja în desfășurare.' });
    }

    // Pachetul "video": daca varianta care tocmai a fost inlocuita avea un videoclip gata,
    // marcam explicit comanda ca avand un videoclip depasit — vezi cerinta 10 a fluxului
    // obligatoriu ("editarea melodiei invalidează videoclipul vechi"). variants[] va fi
    // inlocuit COMPLET la finalul acestei regenerari (finalizeVariantsIfNeeded), deci
    // referinta veche la videoKey oricum dispare din order.variants — acest flag doar face
    // explicit, imediat (inainte ca regenerarea sa se termine), ca plata trebuie blocata.
    if (order.plan === 'video' && sourceVariant.videoKey) {
      await db.updateOrder(order.id, { videoStaleReason: 'song_regenerated' });
    }

    // Daca varianta aleasa are versuri editate manual (melodia-mea.html), le folosim ca
    // instructiune puternica pentru urmatoarea generare. IMPORTANT (vezi si comentariul
    // din extractSunoTracks): SunoAPI, in configuratia confirmata (customMode:false), NU
    // accepta versuri exacte trimise de noi — Suno scrie singur versurile, pornind de la
    // un prompt descriptiv de max. 500 caractere. Nu putem deci garanta ca noua generare
    // va reproduce exact textul editat — il folosim ca ghidaj, nu ca versuri impuse. Daca
    // varianta aleasa NU are versuri editate, folosim doar feedback-ul general si datele
    // comenzii (comportamentul implicit dinainte). Nu folosim niciodata versurile altei
    // variante decat cea aleasa explicit.
    const editedLyrics = typeof sourceVariant.editedLyrics === 'string' ? sourceVariant.editedLyrics.trim() : '';
    let combinedFeedback = feedback;
    if (editedLyrics) {
      const lyricsInstruction = `Try to follow lyrics close to this rewritten version: ${editedLyrics}`;
      combinedFeedback = feedback ? `${lyricsInstruction}. Also: ${feedback}` : lyricsInstruction;
    }

    // Daca clientul a cerut si o schimbare de gen, actualizam ACUM coloana corecta din DB
    // (genre pentru Standard sau varianta 1, genre2 pentru varianta 2 la Premium/Video) —
    // runGeneration reciteste comanda din DB chiar la inceput, deci noul gen ajunge automat in
    // prompt-ul trimis furnizorului, fara sa mai fie nevoie sa-l trecem separat prin optiuni.
    // sourceVariant.genre lipseste doar pe comenzi Standard vechi (o singura varianta, fara
    // gen per-varianta) — acolo genul se schimba mereu pe coloana principala (genre). Validarea
    // "cele doua genuri raman diferite" a rulat deja mai sus — aici comparam DOAR cu genul
    // CURENT al variantei editate, ca sa nu facem o scriere inutila cand genul de fapt nu s-a
    // schimbat.
    const currentGenreOfEditedVariant = (sourceVariant && sourceVariant.genre) || order.genre;
    if (requestedGenre !== null && requestedGenre !== currentGenreOfEditedVariant) {
      const editingGenre2Slot = isDualGenrePlanForRegen && sourceVariant.genre && sourceVariant.genre === order.genre2;
      await db.updateOrder(order.id, editingGenre2Slot ? { genre2: requestedGenre } : { genre: requestedGenre });
    }

    // Standard (Partea 2, hotfix 2026-08-08): editarea NU mai inlocuieste varianta initiala —
    // clientul trebuie sa poata asculta AMBELE (initiala + editata) si sa aleaga explicit
    // inainte de plata. Persistat in DB (nu doar in memorie) — vezi comentariul de la
    // regenerate_keep_original in db.js pentru motivul (reluarile asincrone de polling au
    // nevoie de aceasta intentie chiar daca ruleaza independent de aceasta cerere HTTP).
    const keepOriginalForStandardEdit = PLAN_VARIANT_COUNT[order.plan] === 1;
    // Job de regenerare NOU — progres separat, pornit explicit de la 10% (vezi
    // recordRegenerationProgress/REGENERATION_PHASE_PERCENT). NICIODATA mosteneste procentul
    // ramas de la generarea initiala sau de la o incercare anterioara.
    const regenerationJobId = randomUUID();
    await db.updateOrder(order.id, {
      regenerateSourceVariantId: requestedVariantId,
      regenerateKeepOriginal: keepOriginalForStandardEdit
    });
    await db.startRegenerationJob(order.id, regenerationJobId);
    res.json({ started: true, regenerationJobId });

    // Premium/Video: variantId cerut mai sus e OBLIGATORIU si identifica exact varianta de
    // reeditat -> regenerare PARTIALA (doar acel gen). Standard: PASTREAZA varianta initiala
    // ca alternativa (nu mai inlocuieste intreg array-ul).
    const regenOptions = (PLAN_VARIANT_COUNT[order.plan] === 2)
      ? { replaceVariantId: requestedVariantId, regenerationJobId }
      : { keepOriginalAsAlternative: true, regenerationJobId };
    runGeneration(order.id, combinedFeedback, regenOptions).catch(async (err) => {
      console.error('Eroare la regenerare pentru comanda', order.id, err.message);
      try {
        // Generarea a esuat — restituim ATOMIC editarea gratuita rezervata mai sus, DOAR
        // daca inca era marcata ca rezervata (vezi comentariul din db.refundEditIfReserved
        // despre de ce e sigur sa fie apelata din mai multe locuri, chiar aproape simultan).
        await db.refundEditIfReserved(order.id);
        await markGenerationFailed(order.id, err.message || err, undefined, regenerationJobId);
      } catch (dbErr) {
        console.error('Eroare suplimentara la salvarea starii de esec:', dbErr.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 3b. Salveaza versurile editate manual de client pentru o varianta (nu porneste nicio
// regenerare — doar salveaza textul, cu marcaj de timp). Regenerarea efectiva ramane un
// pas separat si explicit (POST .../regenerate), care poate folosi optional aceste
// versuri editate ca ghidaj (vezi mai sus).
// ==========================================================================================
app.post('/api/orders/:orderId/variants/:variantId/lyrics', express.json(), requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });

    const { variantId } = req.params;
    const variants = order.variants || [];
    const variantIndex = variants.findIndex(v => v.id === variantId);
    if (variantIndex === -1) return res.status(400).json({ error: 'Varianta nu există.' });

    const lyricsText = typeof req.body?.lyrics === 'string' ? req.body.lyrics.trim() : '';
    if (!isValidString(lyricsText, 1, 4000)) {
      return res.status(400).json({ error: 'Versurile nu pot fi goale (max 4000 caractere).' });
    }

    const updatedVariants = variants.map((v, i) => i === variantIndex
      ? { ...v, editedLyrics: lyricsText, lyricsUpdatedAt: new Date().toISOString() }
      : v);

    await db.updateOrder(order.id, { variants: updatedVariants });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 4. Alege varianta preferata (inainte de plata)
// ==========================================================================================
app.post('/api/orders/:orderId/select', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;

    const { variantId } = req.body || {};
    const newVariant = (order.variants || []).find(v => v.id === variantId);
    if (!newVariant) return res.status(400).json({ error: 'Varianta nu există.' });

    const patch = { selectedVariantId: variantId };

    // Pachetul "video": schimbarea variantei audio active poate lasa un videoclip deja gata
    // "in urma" — legat inca de varianta PARASITA, nu de cea nou aleasa. Vezi cerinta 10 a
    // fluxului obligatoriu: "Dacă utilizatorul schimbă varianta... videoclipul anterior este
    // marcat ca depășit". Fisierul videoclipului vechi ramane neatins (stocat sub cheia
    // variantei vechi, in variants[]) — doar marcam explicit, la nivel de comanda, ca nu mai
    // poate fi livrat/platit ca fiind "al variantei curente", si declansam automat o randare
    // noua pentru varianta nou aleasa.
    if (order.plan === 'video') {
      const oldVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);
      const oldHadVideo = !!(oldVariant && oldVariant.videoKey);
      const newAlreadyHasVideo = !!newVariant.videoKey;
      if (order.videoStaleReason === 'media_changed') {
        // Materialele (poze/video client) s-au schimbat DUPA ultima randare — niciun
        // videoclip existent, pentru NICIO varianta, nu mai reflecta selectia curenta de
        // materiale. Schimbarea variantei (inclusiv re-selectarea acceleasi variante, facuta
        // AUTOMAT de client la fiecare incarcare/reincarcare a paginii — vezi selectVariant()
        // in melodia-mea.html, apelat necondiționat din renderContent()) nu rezolva aceasta
        // staleness si NU trebuie sa o stearga silentios, altfel un client care doar
        // reincarca pagina dupa ce a schimbat pozele ar vedea din nou videoclipul VECHI
        // marcat "gata", desi el nu a fost niciodata regenerat. Ramane 'media_changed' pana
        // la reconfirmarea explicita (POST /media/confirm), singura care declanseaza randarea
        // reala pentru selectia noua.
      } else if (newAlreadyHasVideo) {
        // clientul revine la o varianta care avea deja un videoclip gata (ex. comuta inainte
        // si inapoi intre cele 2 variante) — redevine valabil imediat, nimic de regenerat.
        patch.videoStaleReason = null;
      } else if (oldHadVideo) {
        patch.videoStaleReason = 'variant_changed';
      }
    }

    await db.updateOrder(order.id, patch);

    if (order.plan === 'video' && patch.videoStaleReason === 'variant_changed') {
      triggerVideoGeneration(order.id, variantId).catch(err => {
        console.error('Regenerarea videoclipului dupa schimbarea variantei a esuat pentru comanda', order.id, err.message);
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 5. Status comanda (polling din frontend).
//
// TOKEN OBLIGATORIU — verificat direct (2026-08-03, audit de securitate) ca a nu cere
// tokenul aici insemna ca oricine obtine/vede vreodata un orderId (istoric browser,
// captura de ecran, log de server, referrer scurs etc.) putea citi datele complete ale
// comenzii ALTCUIVA, inclusiv versurile complete ale melodiei — text adesea personal/sensibil
// (declaratii, doliu etc.). Protectia bazata doar pe faptul ca orderId e un UUID v4
// negasibil e insuficienta ca unic control de acces pentru date de aceasta sensibilitate
// (exact tiparul OWASP A01 Broken Access Control / "security through obscurity"). Toate
// paginile curente au deja tokenul disponibil in acel moment (se-compune.html si succes.html
// il citesc deja din URL/localStorage pentru alte apeluri) — cerinta tokenului aici nu rupe
// niciun flux existent.
// ==========================================================================================
app.get('/api/orders/:orderId', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comandă invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    if (!order || !safeCompare(providedToken, expectedToken)) {
      return res.status(404).json({ error: 'Comanda nu există.' });
    }

    // niciodata nu trimitem calea fisierelor complete catre client inainte de plata.
    // Versurile (originale/editate) sunt continut text, nu fisiere audio — sigur de
    // expus pre-plata, e nevoie de ele in melodia-mea.html pentru afisare si editare.
    const safeVariants = (order.variants || []).map(v => ({
      id: v.id, previewUrl: v.previewUrl, durationSeconds: v.durationSeconds,
      originalLyrics: v.originalLyrics || null,
      editedLyrics: v.editedLyrics || null,
      lyricsUpdatedAt: v.lyricsUpdatedAt || null,
      // genul asociat variantei — necesar pentru afisarea "genul X" langa fiecare player
      // in pachetele Premium/Video (doua genuri diferite, alese de client, fara cadru "cadou").
      genre: v.genre || order.genre || null,
      // niciodata cheile de storage insele (interne, nu au ce cauta in raspuns) — doar
      // daca extrasul de pachet (WAV/video, vezi generatePremiumExtras) e deja gata.
      hasWav: !!v.wavKey,
      hasVideo: !!v.videoKey,
      videoFailedReason: v.videoFailedReason || null,
      // Standard, fluxul de editare cu alegere (Partea 2, hotfix 2026-08-08) — fara acest
      // camp, melodia-mea.html nu poate distinge "Versiunea inițială" de "Versiunea editată"
      // (gasit direct la testarea reala: ambele carduri aparea etichetate "inițială", pentru
      // ca acest camp lipsea din whitelist-ul de raspuns, desi era scris corect in DB).
      isEditedAlternative: !!v.isEditedAlternative
    }));

    // Stare video derivata, expusa explicit clientului — vezi cerinta "A. Arhitectura si
    // starile comenzii" (starea videoclipului separata de starea platii). 'stale' ia
    // prioritate (chiar daca un videoKey vechi mai exista pe alta varianta, nu mai e
    // valabil pentru cea curenta); 'generating' reflecta rezervarea atomica persistenta
    // (db.claimVideoRender), nu o stare doar in memorie.
    const currentVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    let videoStatus = 'none';
    if (order.plan === 'video') {
      if (isVideoLockActive(order)) videoStatus = 'generating';
      else if (order.videoStaleReason) videoStatus = 'stale';
      else if (currentVariant && currentVariant.videoKey) videoStatus = 'ready';
      else if (currentVariant && currentVariant.videoFailedReason) videoStatus = 'failed';
      else if (order.videoRenderClaimedAt) videoStatus = 'failed'; // lock expirat fara rezultat -> recuperabil, nu "generating" etern
    }

    // IMPORTANT: raspuns construit explicit, camp cu camp — NU facem spread pe `order`.
    // Un spread complet ar fi scurs accessToken si email-ul catre oricine stie/ghiceste
    // UUID-ul comenzii (cand nu s-a trimis token). recipient/senderName/relationship NU
    // sunt secrete (sunt afisate deja pe pagina publica de destinatie melodia-mea.html
    // ca "Melodia pentru X, din partea Y"), dar email-ul si accessToken raman excluse.
    res.json({
      id: order.id,
      recipient: order.recipient,
      senderName: order.senderName || null,
      relationship: order.relationship || null,
      voicePreference: order.voicePreference,
      plan: order.plan,
      lang: order.lang,
      status: order.status,
      editsUsed: order.editsUsed,
      selectedVariantId: order.selectedVariantId || null,
      error: order.error,
      price: order.price,
      genre: order.genre || null,
      genre2: order.genre2 || null,
      // Progres real, pe baza de milestone-uri (nu timer) — vezi recordGenerationProgress.
      // generationPhase e un cod stabil (submitted/processing/first_stream/finalizing/ready/
      // video_processing/video_ready), generationPhasePercent e procentul asociat afisat direct.
      generationPhase: order.generationPhase || null,
      generationPhasePercent: order.generationPhasePercent != null ? order.generationPhasePercent : null,
      // Progres de REGENERARE — SEPARAT complet de generationPhase/generationPhasePercent de
      // mai sus (hotfix 2026-08-08, vezi recordRegenerationProgress). regenerationStatus e
      // singurul semnal fiabil de succes/esec al unei regenerari — order.status revine la
      // 'preview_ready' in ambele cazuri (vezi markGenerationFailed), deci nu poate fi folosit
      // singur ca sa decida daca regenerarea a reusit.
      regenerationStatus: order.regenerationStatus || null,
      regenerationPhase: order.regenerationPhase || null,
      regenerationProgress: order.regenerationProgress != null ? order.regenerationProgress : null,
      variants: safeVariants,
      // tip+sectiune per element, NICIODATA cheia de storage — clientul are nevoie sa vada
      // ce a incarcat deja (ca sa poata sterge dupa index) inainte sa apese "creeaza videoclipul"
      uploadedMedia: (order.uploadedMedia || []).map(m => ({ type: m.type, section: m.section || null })),
      mediaConfirmedAt: order.mediaConfirmedAt || null,
      mediaMinItems: ORDER_MEDIA_MIN_ITEMS,
      mediaMaxItems: ORDER_MEDIA_MAX_ITEMS,
      videoStatus,
      createdAt: order.createdAt
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 6. Creeaza sesiunea de plata pentru varianta selectata.
// Vanzare internationala — fara restrictie de tara. Produs digital: nu se colecteaza
// adresa de livrare (nu exista ce sa se livreze fizic). TVA ramane dezactivat implicit,
// controlat explicit prin STRIPE_AUTOMATIC_TAX_ENABLED — vezi comentariul de mai jos.
// ==========================================================================================
app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.status === 'ready') {
      return res.status(400).json({ error: 'Comanda a fost deja plătită.' });
    }
    if (order.status !== 'preview_ready') {
      return res.status(400).json({ error: 'Generează o previzualizare înainte de plată.' });
    }
    if (!order.selectedVariantId) {
      return res.status(400).json({ error: 'Alege o variantă înainte de plată.' });
    }

    // ======================================================================================
    // Fluxul obligatoriu "Cadou video" — cerinta 11: plata e permisa NUMAI cand: varianta
    // audio finala e selectata (verificat mai sus, comun tuturor pachetelor); videoclipul
    // ACELEI variante e finalizat; videoclipul nu e marcat depasit; toate materialele sunt
    // salvate fara erori. Aceasta e bariera server-side care inlocuieste vechea conditie
    // gresita ("status==='ready'" = platit) — vezi comentariul din create-video/webhook
    // pentru contextul complet al schimbarii.
    // ======================================================================================
    if (order.plan === 'video') {
      if (!order.mediaConfirmedAt) {
        return res.status(400).json({ error: 'Confirmă fotografiile/videoclipurile înainte de a plăti.' });
      }
      const mediaCount = (order.uploadedMedia || []).length;
      if (mediaCount < ORDER_MEDIA_MIN_ITEMS || mediaCount > ORDER_MEDIA_MAX_ITEMS) {
        return res.status(400).json({ error: `Numărul de materiale salvate trebuie să fie între ${ORDER_MEDIA_MIN_ITEMS} și ${ORDER_MEDIA_MAX_ITEMS}.` });
      }
      if (isVideoLockActive(order)) {
        return res.status(409).json({ error: 'Videoclipul se creează chiar acum — te rugăm încearcă din nou în câteva momente.' });
      }
      if (order.videoStaleReason) {
        return res.status(409).json({ error: 'Videoclipul se regenerează după ultima modificare — te rugăm încearcă din nou în câteva momente.' });
      }
      const videoVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);
      if (!videoVariant || !videoVariant.videoKey) {
        return res.status(400).json({ error: 'Videoclipul tău nu este încă gata. Te rugăm așteaptă finalizarea lui înainte de a plăti.' });
      }
    }

    // Protectie credite Suno — vezi credits.js. Aceasta comanda specifica NU mai are nevoie
    // de niciun apel catre Suno (previzualizarea a reusit deja, melodia completa vine din
    // acelasi fisier deja descarcat) — verificarea de aici e un intrerupator global: daca
    // balanta a scazut sub rezerva de siguranta INTRE momentul previzualizarii si acum (alte
    // comenzi concurente), preferam sa nu acceptam plati noi pana clarificam situatia
    // creditelor, mai degraba decat sa lasam clientii sa plateasca intr-un moment nesigur.
    const checkoutGuard = await credits.evaluateGuard('checkout');
    if (!checkoutGuard.allowed) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_low_credit', balanceAfter: checkoutGuard.balance, note: `checkout: ${checkoutGuard.reason}` });
      return res.status(503).json({ error: 'Ne pare rău, plățile sunt temporar indisponibile. Te rugăm să încerci din nou în câteva minute.' });
    }

    // TVA: dezactivat implicit. Se activeaza DOAR daca STRIPE_AUTOMATIC_TAX_ENABLED=true
    // in .env — si asta doar dupa ce contul Stripe e configurat si verificat pentru
    // calcul automat de taxe (Stripe Tax activat din Dashboard, inregistrari fiscale
    // relevante puse la punct). Nu schimba aceasta valoare fara acea configurare prealabila.
    const automaticTaxEnabled = process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true';

    // ======================================================================================
    // Cerinta C6 — sesiunea Stripe trebuie legata de VERSIUNEA EXACTA aprobata acum, nu doar
    // de orderId. Amprenta = (selectedVariantId, mediaRevision) — salvata atat in metadata
    // Stripe (verificabila la webhook fara sa ai incredere doar in baza de date), CAT SI in
    // baza de date (checkout_session_id/variant_id/media_revision), ca sa putem detecta la
    // webhook o sesiune DEVENITA VECHE intre timp (clientul a deschis checkout, s-a intors,
    // a ales alta varianta sau a modificat materialele, apoi incearca sa plateasca link-ul
    // vechi — vezi verificarea explicita din /api/webhook).
    //
    // Idempotency key VERSIONATA (nu doar orderId): un dublu-click sau retry pe ACEEASI
    // versiune tot returneaza aceeasi sesiune Stripe (fara taxare dubla). Dar dupa ce
    // versiunea aprobata se schimba, o cerere noua de checkout TREBUIE sa produca o sesiune
    // Stripe noua, distincta — cu cheia veche (doar orderId), Stripe ar fi returnat din nou
    // sesiunea originala, pentru VECHEA versiune, chiar daca clientul between-timp a ales
    // alta varianta.
    // ======================================================================================
    const versionFingerprint = `${order.selectedVariantId}-${order.mediaRevision}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // FARA payment_method_types fixat la ['card']: neprecizat, Checkout ofera automat
      // metodele de plata activate in Stripe Dashboard, relevante pentru tara clientului
      // (exact comportamentul "Stripe decide singur" descris in README) — inainte, ['card']
      // fortat aici bloca acel comportament indiferent de configurarea din Dashboard.
      customer_email: order.email,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `NALUNA — pachet ${order.plan} — cantec pentru ${order.recipient}`
          },
          unit_amount: Math.round(order.price * 100)
        },
        quantity: 1
      }],
      // Colectam adresa de facturare — Stripe o cere oricum pentru anumite metode de plata
      // si e utila pentru evidenta contabila (tara clientului, vezi webhook). 'auto' inseamna
      // ca Stripe decide cand chiar e necesara, in loc sa o ceara mereu, indiferent de caz.
      billing_address_collection: 'auto',
      // Fara shipping_address_collection — produsul e digital (livrare prin email), nu
      // exista nimic de expediat fizic, deci nu exista niciun motiv sa cerem sau sa
      // restrictionam o adresa de livrare. Asta elimina si blocajul tehnic care limita
      // anterior cumpararea doar la clienti din UK.
      automatic_tax: { enabled: automaticTaxEnabled },
      metadata: {
        orderId: order.id,
        selectedVariantId: order.selectedVariantId,
        mediaRevision: String(order.mediaRevision),
        expectedAmount: String(Math.round(order.price * 100)),
        expectedCurrency: 'gbp'
      },
      success_url: `${DOMAIN}/succes.html?order=${order.id}&token=${order.accessToken}`,
      // plata abandonata sau esuata -> revine la pagina dedicata melodiei (nu la formular),
      // cu comanda deja generata si token-ul de acces inclus
      cancel_url: `${DOMAIN}/melodia-mea.html?id=${order.id}&token=${order.accessToken}&resume=1`
    }, {
      // Idempotency key legata de comanda SI de versiunea aprobata (vezi comentariul de mai
      // sus) — un dublu-click, un al doilea tab, sau un retry client dupa o eroare de retea,
      // PENTRU ACEEASI versiune, tot nu mai creeaza o a doua sesiune Stripe independenta.
      idempotencyKey: `checkout-${order.id}-${versionFingerprint}`
    });

    // Salvam amprenta EXACT a sesiunii create — folosita la webhook pentru a respinge sigur
    // orice sesiune care nu mai corespunde versiunii curente a comenzii.
    await db.updateOrder(order.id, {
      checkoutSessionId: session.id,
      checkoutVariantId: order.selectedVariantId,
      checkoutMediaRevision: order.mediaRevision
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Eroare la initierea platii:', err.message);
    res.status(502).json({ error: 'Eroare la inițierea plății. Încearcă din nou în câteva momente' });
  }
});

// ==========================================================================================
// 6b. Fotografii/videoclipuri client pentru pachetul "video" (videoclip cu memorii).
//
// RELANSARE 2026-08-06: incarcarea trebuie sa poata incepe INAINTE ca melodia sa fie
// generata (fluxul obligatoriu cere upload -> confirmare -> ABIA APOI generarea melodiei
// gratuita) — deci acceptam si status 'draft', nu doar 'preview_ready'/'ready'. Ramane
// respins doar in timpul unei generari efective (status-uri in care variants/selectedVariantId
// se pot schimba sub picioarele clientului) — 'generating' si 'processing_provider_result'.
//
// PER-FISIER, NU TOT-SAU-NIMIC: fiecare fisier din batch e validat si urcat independent —
// fisierele valide raman salvate chiar daca alte fisiere din aceeasi cerere esueaza (format
// neacceptat, continut care nu corespunde tipului declarat, sau nedecodabil real de ffprobe).
// Raspunsul intoarce explicit ce a reusit si ce nu, cu motiv, ca frontend-ul sa poata arata
// fiecare fisier cu starea lui reala, fara sa piarda restul batch-ului.
const ORDER_MEDIA_UPLOADABLE_STATUSES = ['draft', 'preview_ready', 'generation_failed', 'ready'];
app.post('/api/orders/:orderId/media', requireOrderToken, handleOrderMediaUpload, async (req, res, next) => {
  const files = req.files || [];
  // curatare INCONDITIONATA a fisierelor temporare de pe disc la iesire — reusite (deja
  // urcate in R2, copia locala nu mai e necesara) sau esuate deopotriva. Fara asta, fisiere
  // respinse/esuate s-ar acumula la nesfarsit in TEMP_DIR.
  const cleanup = () => files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { /* best-effort */ } });

  try {
    const order = req.order;
    if (order.plan !== 'video') { cleanup(); return res.status(400).json({ error: 'Doar pachetul video acceptă fotografii/videoclipuri.' }); }
    if (!ORDER_MEDIA_UPLOADABLE_STATUSES.includes(order.status)) {
      cleanup();
      return res.status(403).json({ error: 'Nu poți încărca materiale în acest moment — melodia se generează chiar acum.' });
    }
    if (files.length === 0) { cleanup(); return res.status(400).json({ error: 'Niciun fișier primit.' }); }

    // "sections" (optional) vine ca un camp text unic in form-data, continand un array JSON
    // de string-uri — ex. '["Copilarie","Prieteni"]' — cate un element per fisier incarcat,
    // in aceeasi ordine. Absent sau invalid -> toate fisierele raman neorganizate (section: null),
    // distribuite automat mai tarziu la randare.
    let sections = [];
    if (typeof req.body?.sections === 'string' && req.body.sections.trim()) {
      try {
        const parsed = JSON.parse(req.body.sections);
        if (Array.isArray(parsed)) sections = parsed;
      } catch (e) { /* ramane [] — organizare automata */ }
    }

    // Validare (magic bytes + decodare ffprobe REALA de pe disc) — inainte de orice scriere
    // in baza de date, deci nu blocheaza tranzactia atomica de mai jos cu I/O lent.
    //
    // HOTFIX 2026-08-07: tipul (photo/video) NU se mai decide STRICT dupa Content-Type-ul
    // trimis de browser — Safari iOS poate trimite un mimetype gol sau generic
    // ("application/octet-stream") pentru HEIC/HEIF sau pentru fisiere inca nematerializate
    // din iCloud, desi fisierul e perfect valid; inainte, un asemenea fisier era respins
    // INSTANT, fara nicio verificare de continut. inferMediaType() incearca intai mimetype-ul
    // brut, apoi extensia numelui de fisier (case-insensitive) — extensia NU inlocuieste
    // validarea reala de continut de mai jos (bufferMatchesDeclaredType/ffprobe), doar alege
    // ce semnatura sa verificam.
    const uploaded = [];
    const failed = [];
    // fisierele derivate (previzualizarea JPEG extrasa dintr-un DNG) nu fac parte din `files`
    // (scrise de multer) — trebuie curatate separat, dupa cleanup() de mai jos.
    const derivedPaths = [];
    let rejectedNoType = 0;
    let rejectedBadContent = 0;
    let rejectedUndecodable = 0;
    let rejectedStorageError = 0;
    let rejectedConversionFailed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = file.originalname || `fișier ${i + 1}`;
      const inferred = inferMediaType(file.originalname, file.mimetype, ORDER_MEDIA_MIME_TYPES.photo, ORDER_MEDIA_MIME_TYPES.video);
      if (!inferred) {
        rejectedNoType++;
        failed.push({ filename: label, reason: `Tip de fișier neacceptat. Sunt acceptate: JPG, PNG, WEBP, HEIC/HEIF, DNG (Apple ProRAW) pentru fotografii și MP4, MOV, WEBM pentru videoclipuri.` });
        continue;
      }
      let { type, mimetype: effectiveMimetype } = inferred;
      let uploadPath = file.path;
      const wasDng = effectiveMimetype === 'image/x-adobe-dng';
      const wasHeic = effectiveMimetype === 'image/heic' || effectiveMimetype === 'image/heif';

      const header = await readFileHeader(file.path, 16);
      if (!bufferMatchesDeclaredType(header, effectiveMimetype)) {
        rejectedBadContent++;
        failed.push({ filename: label, reason: 'Conținutul fișierului nu corespunde tipului declarat.' });
        continue;
      }

      // DNG (Apple ProRAW): ffmpeg nu poate decodifica raw-ul de senzor direct — extragem
      // previzualizarea JPEG completa incorporata (vezi extractDngPreviewToJpeg) si tratam
      // REZULTATUL ca fotografia efectiv incarcata mai departe (verificare de decodabilitate,
      // stocare, extensie) — clientul nu vede nicio diferenta, doar ca fotografia lui RAW e
      // acum salvata/livrata ca JPEG la rezolutie completa.
      if (wasDng) {
        const extracted = await extractDngPreviewToJpeg(file.path);
        if (!extracted.ok) {
          rejectedConversionFailed++;
          failed.push({ filename: label, reason: `Fotografia RAW (.dng) nu a putut fi procesată (${extracted.reason}).` });
          continue;
        }
        derivedPaths.push(extracted.path);
        uploadPath = extracted.path;
        effectiveMimetype = 'image/jpeg';
      }

      // HEIC/HEIF: build-ul de ffmpeg din productie nu poate decodifica deloc acest format
      // (verificat cu un fisier HEIC real — vezi extractHeicToJpeg) — nici la validare, nici
      // mai tarziu la randarea videoclipului. Convertim la JPEG ACUM, o singura data, cu
      // heif-convert (decodor HEIF dedicat) — restul pipeline-ului (validare, stocare,
      // randare video) nu mai intalneste niciodata HEIC direct.
      if (wasHeic) {
        const converted = await extractHeicToJpeg(file.path);
        if (!converted.ok) {
          rejectedConversionFailed++;
          failed.push({ filename: label, reason: `Fotografia HEIC/HEIF nu a putut fi procesată (${converted.reason}).` });
          continue;
        }
        derivedPaths.push(converted.path);
        uploadPath = converted.path;
        effectiveMimetype = 'image/jpeg';
      }

      const decodable = await verifyMediaDecodable(uploadPath, effectiveMimetype, type);
      if (!decodable.ok) {
        rejectedUndecodable++;
        failed.push({ filename: label, reason: `Fișierul nu poate fi procesat (${decodable.reason}). Încearcă alt fișier sau alt format.` });
        continue;
      }
      const ext = (wasDng || wasHeic) ? '.jpg' : (path.extname(file.originalname).toLowerCase() || (type === 'photo' ? '.jpg' : '.mp4'));
      const key = `orders/memories/${order.id}/${randomUUID()}${ext}`;
      try {
        await storage.uploadPrivateFile(uploadPath, key, effectiveMimetype);
      } catch (err) {
        rejectedStorageError++;
        failed.push({ filename: label, reason: 'Eroare la salvare — te rugăm încearcă din nou.' });
        continue;
      }
      uploaded.push({ key, type, section: (typeof sections[i] === 'string' && sections[i].trim()) ? sections[i].trim() : null, filename: label });
    }
    cleanup();
    derivedPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) { /* best-effort */ } });

    // Diagnostic SIGUR (fara token, URL semnat, cheie de storage sau nume de fisier client) —
    // gasit lipsind exact in incidentul care a cauzat acest hotfix: uploadul esua complet, pe
    // iPhone, fara NICIUN log server-side care sa explice de ce (vezi comentariul hotfix de mai
    // sus). orderId trunchiat la 8 caractere, acelasi tipar ca perfLog().
    if (failed.length > 0 || uploaded.length > 0) {
      perfLog(order.id, 'media_upload', `primite=${files.length}, reusite=${uploaded.length}, esuate=${failed.length}` +
        (rejectedNoType ? `, tip_neacceptat=${rejectedNoType}` : '') +
        (rejectedBadContent ? `, continut_invalid=${rejectedBadContent}` : '') +
        (rejectedUndecodable ? `, nedecodabil=${rejectedUndecodable}` : '') +
        (rejectedConversionFailed ? `, conversie_esuata=${rejectedConversionFailed}` : '') +
        (rejectedStorageError ? `, eroare_storage=${rejectedStorageError}` : ''));
    }

    if (uploaded.length === 0) {
      return res.json({ uploaded: [], failed, total: (order.uploadedMedia || []).length });
    }

    // PERSISTENTA ATOMICA — SELECT ... FOR UPDATE (vezi db.mutateOrderMediaAtomically)
    // serializeaza aceasta scriere fata de orice alta mutatie concurenta a acestei comenzi
    // (alt fisier din acelasi lot, sau o stergere/reordonare aproape simultana), citind
    // starea REALA chiar in momentul scrierii — nu mai exista cursa in care doua cereri
    // citesc acelasi uploadedMedia "vechi" si una suprascrie rezultatul celeilalte.
    const mutation = await db.mutateOrderMediaAtomically(order.id, (current) => {
      const existing = current.uploadedMedia || [];
      const room = ORDER_MEDIA_MAX_ITEMS - existing.length;
      if (room <= 0) return null; // deja plin — nimic din acest lot nu mai incape
      const accepted = uploaded.slice(0, room);
      const overflow = uploaded.slice(room);
      overflow.forEach(u => failed.push({ filename: u.filename, reason: `Ai atins limita de ${ORDER_MEDIA_MAX_ITEMS} materiale.` }));
      return { uploadedMedia: [...existing, ...accepted] };
    });

    if (!mutation.ok) {
      // limita era deja atinsa de o alta cerere concurenta intre timp — fisierele erau deja
      // urcate in R2 (irosite, dar nu corupem nimic); le stergem din storage.
      uploaded.forEach(u => storage.deletePrivateFile(u.key).catch(() => {}));
      uploaded.forEach(u => failed.push({ filename: u.filename, reason: `Ai atins limita de ${ORDER_MEDIA_MAX_ITEMS} materiale.` }));
      return res.json({ uploaded: [], failed, total: (order.uploadedMedia || []).length });
    }

    res.json({
      uploaded: uploaded.filter(u => (mutation.order.uploadedMedia || []).some(m => m.key === u.key)).map(u => ({ type: u.type, filename: u.filename, section: u.section })),
      failed,
      total: mutation.order.uploadedMedia.length
    });
  } catch (err) {
    cleanup();
    next(err);
  }
});

// URL semnat, de scurta durata (5 minute), pentru PREVIZUALIZAREA unui material deja
// incarcat (thumbnail poza / player video) — materialele raman intotdeauna in bucket-ul
// PRIVAT (amintiri personale ale clientului), deci un preview real necesita un URL semnat
// generat la cerere, nu un URL public direct. Acelasi requireOrderToken ca restul rutelor
// de materiale — nimeni fara access token-ul comenzii nu poate vedea aceste fisiere.
app.get('/api/orders/:orderId/media/:index/preview-url', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    const idx = Number(req.params.index);
    const existing = order.uploadedMedia || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length) {
      return res.status(400).json({ error: 'Index invalid.' });
    }
    if (!storage.CLOUD_ENABLED) {
      return res.status(503).json({ error: 'Previzualizarea necesită stocare cloud activată.' });
    }
    const item = existing[idx];
    const url = await storage.getSignedDownloadUrl(item.key, 300);
    res.json({ url, type: item.type });
  } catch (err) {
    next(err);
  }
});

// Toate cele 3 rute de mai jos (eliminare/schimbare sectiune/reordonare) trec acum prin
// db.mutateOrderMediaAtomically — aceeasi rezervare SELECT ... FOR UPDATE ca la upload,
// deci nu mai pot rula "peste" un upload concurent aflat in curs. Fiecare mutatie reusita
// creste automat media_revision, sterge media_confirmed_at (cere reconfirmare) si marcheaza
// video_stale_reason='media_changed' daca exista deja un videoclip gata — vezi cerinta B3.
app.delete('/api/orders/:orderId/media/:index', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video are fotografii/videoclipuri.' });
    const idx = Number(req.params.index);

    let removed = null;
    const mutation = await db.mutateOrderMediaAtomically(order.id, (current) => {
      const existing = current.uploadedMedia || [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length) return null;
      removed = existing[idx];
      return { uploadedMedia: existing.filter((_, i) => i !== idx) };
    });
    if (!mutation.ok) return res.status(400).json({ error: 'Index invalid.' });
    if (removed && removed.key) {
      storage.deletePrivateFile(removed.key).catch(err => console.error('Nu am putut sterge fisierul de amintiri:', err.message));
    }
    res.json({ ok: true, total: mutation.order.uploadedMedia.length });
  } catch (err) {
    next(err);
  }
});

// Actualizeaza eticheta de sectiune a unui material DEJA incarcat — clientul poate eticheta
// materialul fie inainte, fie oricand dupa upload, pana la confirmarea finala a selectiei.
app.put('/api/orders/:orderId/media/:index/section', express.json(), requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video are fotografii/videoclipuri.' });
    const idx = Number(req.params.index);
    const section = (typeof req.body?.section === 'string' && req.body.section.trim()) ? req.body.section.trim() : null;

    const mutation = await db.mutateOrderMediaAtomically(order.id, (current) => {
      const existing = current.uploadedMedia || [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length) return null;
      return { uploadedMedia: existing.map((m, i) => i === idx ? { ...m, section } : m) };
    });
    if (!mutation.ok) return res.status(400).json({ error: 'Index invalid.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Reordoneaza materialele deja incarcate — clientul trimite indexii curenti in noua ordine
// dorita (ex. [2,0,1]). Validam ca e o PERMUTARE completa a indexilor existenti — nu accepta
// adaugare/eliminare pe aceasta cale (asta ramane treaba rutelor POST/DELETE de mai sus).
app.put('/api/orders/:orderId/media/reorder', express.json(), requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video are fotografii/videoclipuri.' });
    const newOrder = Array.isArray(req.body?.order) ? req.body.order : null;

    const mutation = await db.mutateOrderMediaAtomically(order.id, (current) => {
      const existing = current.uploadedMedia || [];
      if (!newOrder || newOrder.length !== existing.length) return null;
      const seen = new Set();
      for (const idx of newOrder) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length || seen.has(idx)) return null;
        seen.add(idx);
      }
      return { uploadedMedia: newOrder.map(idx => existing[idx]) };
    });
    if (!mutation.ok) return res.status(400).json({ error: 'Ordine invalidă.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Confirma explicit selectia de materiale — pasul obligatoriu ("5. Confirmă selecția
// materialelor") DUPA care, si NUMAI dupa care, poate porni generarea gratuita a melodiei
// pentru pachetul video (vezi verificarea order.mediaConfirmedAt in POST /generate mai jos).
// Cere intre ORDER_MEDIA_MIN_ITEMS si ORDER_MEDIA_MAX_ITEMS materiale deja salvate cu succes —
// re-confirmabil oricand (ex. clientul mai adauga/elimina materiale si confirma din nou).
// Foloseste SELECT ... FOR UPDATE (transactie dedicata) — confirmarea trebuie sa vada
// numarul REAL de materiale, nu unul citit inainte ca un upload concurent sa se termine.
app.post('/api/orders/:orderId/media/confirm', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video necesită confirmarea materialelor.' });

    const result = await db.confirmMediaSelection(order.id, ORDER_MEDIA_MIN_ITEMS, ORDER_MEDIA_MAX_ITEMS);

    if (!result.ok) {
      const count = result.count ?? (order.uploadedMedia || []).length;
      return res.status(400).json({ error: `Ai nevoie de între ${ORDER_MEDIA_MIN_ITEMS} și ${ORDER_MEDIA_MAX_ITEMS} materiale pentru a continua (ai ${count}).` });
    }

    // Cerinta B3: reconfirmarea materialelor, cand melodia e DEJA generata (comanda nu mai e
    // 'draft'), trebuie sa declanseze regenerarea videoclipului pentru selectia noua — clientul
    // a modificat materialele DUPA ce videoclipul initial exista deja, apoi a reconfirmat.
    // Daca melodia inca nu exista (status 'draft'), nu e nimic de declansat aici — /generate
    // porneste totul, imediat ce clientul apasa "Continua si creeaza cadoul".
    if (result.order.status === 'preview_ready' && result.order.selectedVariantId) {
      triggerVideoGeneration(result.order.id, result.order.selectedVariantId).catch(err => {
        console.error('Regenerarea videoclipului dupa reconfirmarea materialelor a esuat pentru comanda', order.id, err.message);
      });
    }

    res.json({ ok: true, confirmed: true, total: result.order.uploadedMedia.length });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// Declanseaza (sau reia) crearea videoclipului cu memorii pentru varianta audio SELECTATA
// ACUM. Idempotent si sigur la reincercare/dublu-click/multi-instanta: foloseste o rezervare
// ATOMICA persistenta in Postgres (db.claimVideoRender), nu o garda in memoria procesului —
// vezi comentariul din db.js pentru motiv exact. Daca videoclipul exista deja pentru varianta
// curenta si nu e marcat depasit, e un no-op sigur (raspunde imediat, nu porneste o randare).
//
// RELANSARE 2026-08-06: acceptat la 'preview_ready' (INAINTE de plata) — nu doar la 'ready'
// (dupa plata, cum era inainte). E chemat automat de restul fluxului (dupa confirmarea
// materialelor + generarea melodiei, dupa schimbarea variantei, sau dupa o editare a
// melodiei — vezi triggerVideoGeneration mai jos), dar ramane apelabil si manual, ca
// mecanism de reincercare explicita daca o randare anterioara a esuat.
// ==========================================================================================
app.post('/api/orders/:orderId/create-video', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video poate crea un videoclip.' });
    if (!['preview_ready', 'ready'].includes(order.status)) {
      return res.status(403).json({ error: 'Generează mai întâi o previzualizare a melodiei.' });
    }
    if (!order.selectedVariantId) {
      return res.status(400).json({ error: 'Alege o variantă audio înainte de a crea videoclipul.' });
    }
    const mediaCount = (order.uploadedMedia || []).length;
    if (!order.mediaConfirmedAt && mediaCount < ORDER_MEDIA_MIN_ITEMS) {
      return res.status(400).json({ error: `Încarcă și confirmă cel puțin ${ORDER_MEDIA_MIN_ITEMS} materiale înainte de a crea videoclipul.` });
    }

    const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    if (variant && variant.videoKey && !order.videoStaleReason) {
      return res.json({ started: false, alreadyReady: true });
    }
    if (isVideoLockActive(order)) {
      return res.status(409).json({ error: 'Videoclipul este deja în curs de creare.' });
    }

    res.json({ started: true });
    triggerVideoGeneration(order.id, order.selectedVariantId).catch(err => {
      console.error('Crearea videoclipului cu memorii a esuat pentru comanda', order.id, err.message);
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// Declanseaza randarea video cu rezervare ATOMICA persistenta (vezi db.claimVideoRender) —
// punct UNIC de intrare pentru orice randare video, apelat automat de:
//   1) finalizeVariantsIfNeeded(), dupa ce melodia (initiala SAU regenerata) ajunge
//      'preview_ready' pentru un pachet "video" cu materiale deja confirmate;
//   2) POST /select, cand clientul schimba varianta audio activa;
//   3) POST /create-video, ca reincercare manuala explicita.
// Idempotent: daca lock-ul e deja detinut (randare activa) sau videoclipul curent e deja
// valabil pentru variantId cerut, nu porneste o a doua randare.
// ==========================================================================================
async function triggerVideoGeneration(orderId, variantId) {
  const orderAtStart = await db.getOrderById(orderId);
  if (!orderAtStart) return;
  const mediaRevisionAtStart = orderAtStart.mediaRevision;

  // Lock-ul e legat de (orderId, variantId, mediaRevision) — vezi cerinta E9 ("un render
  // pentru A nu poate sterge staleReason pentru B"). Rezultatul acestei randari va fi scris
  // DOAR daca aceasta tripleta inca reprezinta versiunea curenta la momentul finalizarii —
  // verificat explicit in generatePremiumExtras() inainte de orice scriere a videoKey.
  const claimedOrder = await db.claimVideoRender(orderId, variantId, mediaRevisionAtStart);
  if (!claimedOrder) return; // randare deja activa (lock neexpirat) — no-op sigur

  // Problema 1 — faza 2 pentru pachetul Video ("Realizăm videoclipul și îl sincronizăm"):
  // audio-ul e deja gata la acest punct (altfel randarea nici nu ar fi putut porni), doar
  // videoclipul mai ramane. Vezi PHASE_PROGRESS/melodia-mea.html pentru afisarea distincta.
  recordGenerationProgress(orderId, 'video_processing').catch(() => {});

  let versionChangedDuringRender = false;
  try {
    await generatePremiumExtras(orderId, { forceVideo: true, forVariantId: variantId, forMediaRevision: mediaRevisionAtStart });

    const stillCurrent = await db.isVideoClaimStillCurrent(orderId, variantId, mediaRevisionAtStart);
    if (!stillCurrent) {
      versionChangedDuringRender = true;
    } else {
      const fresh = await db.getOrderById(orderId);
      const variant = fresh && (fresh.variants || []).find(v => v.id === variantId);
      if (variant && variant.videoKey) {
        // succes, si versiunea inca e cea curenta: videoclipul redevine valabil —
        // orice marcaj anterior de "depasit" nu mai are sens, il curatam.
        await db.updateOrder(orderId, { videoStaleReason: null });
        recordGenerationProgress(orderId, 'video_ready').catch(() => {});
      }
    }
  } catch (err) {
    console.error(`Comanda ${orderId}: triggerVideoGeneration a esuat pentru varianta ${variantId}:`, err.message);
  } finally {
    await db.releaseVideoRender(orderId);
  }

  // Cerinta E9/E10: dupa eliberarea lock-ului, reevaluam versiunea CURENTA (clientul a
  // putut schimba varianta sau materialele cat randarea era in desfasurare) si pornim
  // automat randarea necesara pentru ea, daca nu exista deja un videoclip valid.
  if (versionChangedDuringRender) {
    const current = await db.getOrderById(orderId);
    if (current && current.plan === 'video' && current.selectedVariantId && current.mediaConfirmedAt) {
      const currentVariant = (current.variants || []).find(v => v.id === current.selectedVariantId);
      if (!currentVariant || !currentVariant.videoKey) {
        triggerVideoGeneration(orderId, current.selectedVariantId).catch(err => {
          console.error(`Comanda ${orderId}: re-randare dupa schimbare de versiune a esuat:`, err.message);
        });
      }
    }
  }
}

// ==========================================================================================
// 7. Fisierul PREVIEW (PREVIEW_SECONDS = 40 sec) al unei variante — accesibil oricui, fara plata (era deja
// gratuit). In modul cloud, fisierul e in bucket-ul PUBLIC — redirectionam catre URL-ul
// public, reconstituit din previewKey, si nu atingem deloc discul local al serverului.
// In fallback local (fara storage cloud configurat), servim direct de pe disc, ca inainte.
// ==========================================================================================
app.get('/media/preview/:orderId/:variantId', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).send('ID comandă invalid.');

    const order = await db.getOrderById(req.params.orderId);
    if (!order || order.status === 'draft' || order.status === 'generating') {
      return res.status(404).send('Preview indisponibil.');
    }

    const variant = (order.variants || []).find(v => v.id === req.params.variantId);
    if (!variant) return res.status(404).send('Varianta nu există.');

    if (storage.CLOUD_ENABLED) {
      // NU cautam niciodata pe disc local cand cloud e activ — fisierul pur si simplu nu e acolo.
      const url = variant.previewKey ? storage.getPublicUrl(variant.previewKey) : variant.previewUrl;
      if (!url) return res.status(404).send('Preview indisponibil.');
      return res.redirect(302, url);
    }

    const filePath = path.join(MEDIA_PREVIEW_DIR, `${order.id}-${variant.id}.mp3`);
    if (!fs.existsSync(filePath)) return res.status(404).send('Preview indisponibil.');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 8. Fisierul COMPLET (varianta selectata) — DOAR dupa plata confirmata SI cu token valid.
//
// Raspuns UNIC (404, acelasi mesaj generic) pentru orice forma de acces neautorizat:
// ID de comanda malformat, comanda inexistenta, token lipsa, token gresit, token de
// lungime diferita fata de cel real. Nu exista nicio combinatie dintre acestea care sa
// produca un status sau un mesaj diferit — altfel, cineva care incearca UUID-uri la
// intamplare ar putea deduce care exista doar din diferenta intre "404" si "403".
//
// Comparatia se face MEREU, chiar si cand comanda nu exista — folosind DUMMY_TOKEN_FOR_TIMING
// in locul unui accessToken real. Fara asta, ramura "comanda nu exista" ar iesi din functie
// mai devreme (fara sa apeleze safeCompare), iar acel timp de raspuns mai scurt ar fi el
// insusi o scurgere de informatie, chiar daca statusul HTTP e identic. safeCompare() e
// timing-safe indiferent de lungimea sirurilor primite (hash-uieste ambele parti la o
// lungime fixa inainte de comparatie) — vezi comentariul de la definitia ei.
//
// Odata ce comanda si tokenul sunt confirmate valide, mesajele redevin specifice
// (ex: "melodia se deblocheaza dupa plata") — in acel punct, existenta comenzii e deja
// stabilita legitim de catre cel care detine tokenul corect, nu mai e nimic de ascuns.
//
// Cu stocare cloud: redirect catre un URL semnat, temporar (expira in 10 minute).
// Fara stocare cloud (fallback local): serveste direct de pe disc, ca inainte.
// ==========================================================================================
// "Melodia cadou" = cealaltă variantă audio decât cea aleasă ca principală — livrată la
// TOATE cele trei pachete (Standard/Premium/Video) după plată, nu doar audio-ul principal.
// Logica (getGiftVariant) e in lib/entitlements.js — pura, testata izolat in test/.
app.get('/media/full/:orderId', async (req, res, next) => {
  try {
    const denyGeneric = () => res.status(404).send('Resursa nu este disponibilă');

    if (!UUID_RE.test(req.params.orderId)) return denyGeneric();

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';

    // comparam mereu — cu tokenul real daca ordinul exista, cu unul fals altfel —
    // ca timpul de executie sa fie acelasi in ambele cazuri
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    const tokenValid = safeCompare(providedToken, expectedToken);

    if (!order || !tokenValid) return denyGeneric();

    if (order.status !== 'ready') {
      return res.status(403).send('Melodia completă se deblochează după plată');
    }

    const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);

    if (storage.CLOUD_ENABLED && variant && variant.fullKey) {
      const signedUrl = await storage.getSignedDownloadUrl(variant.fullKey, 600);
      return res.redirect(302, signedUrl);
    }

    // fallback local — fara stocare cloud configurata
    const filePath = path.join(MEDIA_FULL_DIR, `${order.id}-${order.selectedVariantId}.mp3`);
    if (!fs.existsSync(filePath)) return res.status(404).send('Fișier indisponibil');
    res.download(filePath, `cantec-${order.recipient}.mp3`);
  } catch (err) {
    next(err);
  }
});

// Fisierul complet al melodiei CADOU (cealalta varianta, nealeasa ca principala) — acelasi
// tipar de securitate ca /media/full de mai sus. Livrat la toate cele trei pachete.
app.get('/media/full/:orderId/gift', async (req, res, next) => {
  try {
    const denyGeneric = () => res.status(404).send('Resursa nu este disponibilă');

    if (!UUID_RE.test(req.params.orderId)) return denyGeneric();

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    const tokenValid = safeCompare(providedToken, expectedToken);

    if (!order || !tokenValid) return denyGeneric();

    if (order.status !== 'ready') {
      return res.status(403).send('Melodia cadou se deblochează după plată');
    }

    const giftVariant = getGiftVariant(order);

    if (storage.CLOUD_ENABLED && giftVariant && giftVariant.fullKey) {
      const signedUrl = await storage.getSignedDownloadUrl(giftVariant.fullKey, 600);
      return res.redirect(302, signedUrl);
    }

    const filePath = giftVariant ? path.join(MEDIA_FULL_DIR, `${order.id}-${giftVariant.id}.mp3`) : null;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Fișier indisponibil');
    res.download(filePath, `cantec-cadou-${order.recipient}.mp3`);
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// Fisierul WAV (pachete premium + video) si videoclipul cu versuri (doar pachetul video) —
// ACELASI tipar de securitate ca /media/full de mai sus (token obligatoriu, timing-safe,
// 404 generic identic pentru comanda inexistenta/token gresit/extras neeligibil pentru
// pachet — niciuna dintre aceste situatii nu trebuie sa se poata distinge de celelalte din
// raspuns). Generate ASINCRON dupa plata (vezi generatePremiumExtras) — daca nu sunt inca
// gata, raspundem 202 (nu 404: comanda si extra-ul EXISTA, doar nu s-a terminat inca).
// ==========================================================================================
app.get('/media/wav/:orderId', async (req, res, next) => {
  try {
    const denyGeneric = () => res.status(404).send('Resursa nu este disponibilă');
    if (!UUID_RE.test(req.params.orderId)) return denyGeneric();

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    if (!order || !safeCompare(providedToken, expectedToken)) return denyGeneric();

    if (order.status !== 'ready') return res.status(403).send('Fișierul WAV se deblochează după plată');
    if (order.plan !== 'premium' && order.plan !== 'video') return denyGeneric();

    const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    if (!variant || !variant.wavKey) return res.status(202).json({ status: 'processing' });

    const signedUrl = await storage.getSignedDownloadUrl(variant.wavKey, 600);
    return res.redirect(302, signedUrl);
  } catch (err) {
    next(err);
  }
});

app.get('/media/video/:orderId', async (req, res, next) => {
  try {
    const denyGeneric = () => res.status(404).send('Resursa nu este disponibilă');
    if (!UUID_RE.test(req.params.orderId)) return denyGeneric();

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    if (!order || !safeCompare(providedToken, expectedToken)) return denyGeneric();

    // DECIZIE FINALA (hotfix 2026-08-08): videoclipul se GENEREAZA inainte de plata, dar NU
    // se poate reda inainte de plata — nicio previzualizare video. Incercarea anterioara de a
    // permite un preview video pre-plata (redirect catre URL semnat R2, cross-origin) e
    // suspectata ca substrat al unui simptom mult mai grav raportat direct de client
    // ("Page Unresponsive" — pagina intreaga bloca, nu doar playerul) — eliminata complet.
    // Inainte de plata, aceasta ruta NU trimite absolut nimic util (fara URL semnat, fara
    // redirect, fara fragment din fisier) — doar 403. Clientul asculta/editeaza DOAR cele
    // doua previzualizari audio de 40 de secunde (v.previewUrl, neschimbat).
    if (order.status !== 'ready') return res.status(403).send('Videoclipul se deblochează după plată');
    if (order.plan !== 'video') return denyGeneric();

    const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    if (!variant || !variant.videoKey) return res.status(202).json({ status: 'processing' });

    const signedUrl = await storage.getSignedDownloadUrl(variant.videoKey, 600);
    return res.redirect(302, signedUrl);
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// Acces comanda prin COD UNIC (accessToken) — inlocuieste vechea cautare dupa email.
// Cautarea dupa email permitea oricui stia adresa de email a cuiva sa-i vada toate
// comenzile si povestile private. Acum accesul se face DOAR cu token-ul primit pe email,
// care e un sir aleator de 48 caractere hex — imposibil de ghicit.
// ==========================================================================================
app.get('/api/orders/access/:token', lookupLimiter, async (req, res, next) => {
  try {
    const token = req.params.token;
    if (typeof token !== 'string' || !/^[0-9a-f]{48}$/i.test(token)) {
      return res.status(400).json({ error: 'Cod de acces invalid.' });
    }

    const order = await db.getOrderByToken(token);
    if (!order) return res.status(404).json({ error: 'Nicio comandă găsită pentru acest cod.' });

    // hasWav/hasVideo ale variantei ALESE — niciodata cheile de storage insele — necesare
    // ca pagina "comanda mea" sa poata arata extrasele de pachet (WAV/video) cand sunt gata,
    // fara sa expuna nimic in plus fata de ce era deja expus aici. hasGiftAudio la fel, pentru
    // "melodia cadou" (cealalta varianta) — livrata la toate cele trei pachete dupa plata.
    const selectedVariant = (order.variants || []).find(v => v.id === order.selectedVariantId);
    const giftVariant = getGiftVariant(order);

    res.json({
      id: order.id, recipient: order.recipient, status: order.status,
      createdAt: order.createdAt,
      plan: order.plan,
      hasWav: !!(selectedVariant && selectedVariant.wavKey),
      hasVideo: !!(selectedVariant && selectedVariant.videoKey),
      hasGiftAudio: !!(giftVariant && giftVariant.fullKey),
      uploadedMedia: (order.uploadedMedia || []).map(m => ({ type: m.type, section: m.section || null }))
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// POST /api/music/callback — SunoAPI trimite aici rezultatul, in paralel cu polling-ul
// nostru (vezi pollForResult mai jos). Cele doua mecanisme pot ajunge la rezultat aproape
// simultan — finalizeVariantsIfNeeded() are o garda explicita (verifica statusul comenzii
// inainte de a scrie) ca sa nu procesam aceeasi generare de doua ori (descarcare + upload
// dublu in R2/S3). Raspundem mereu 200 catre Suno, ca sa nu retrimita webhook-ul la infinit.
// ==========================================================================================
app.post('/api/music/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || body;
    // IMPORTANT: documentatia reala SunoAPI (verificata direct, docs.sunoapi.org) foloseste
    // "task_id" (snake_case) in payload-ul de CALLBACK — diferit de "taskId" (camelCase)
    // folosit de raspunsul endpoint-ului de POLLING (record-info). Verificam ambele forme,
    // defensiv, dar task_id e forma reala documentata pentru acest payload specific.
    const taskId = data.task_id || data.taskId || body.taskId;

    if (!taskId || typeof taskId !== 'string') {
      console.warn('Callback SunoAPI primit fara taskId recunoscut.');
      return res.status(200).json({ received: true });
    }

    const order = await db.getOrderByAnyMusicTaskId(taskId);
    if (!order) {
      console.warn(`Callback SunoAPI pentru un taskId necunoscut in baza de date: ${taskId}`);
      return res.status(200).json({ received: true });
    }

    // IMPORTANT: payload-ul de callback NU are un camp "status" (spre deosebire de
    // record-info, folosit de polling) — foloseste "callbackType" ('text' | 'first' |
    // 'complete' | 'error'), plus campul radacina "code" (200 succes, 400/451/500 eroare).
    // Tratate distinct de SUNO_SUCCESS_STATUS/SUNO_ERROR_STATUSES (acelea raman valabile
    // DOAR pentru raspunsul de polling, care chiar are un camp "status").
    const callbackType = data.callbackType;
    const callbackCode = typeof body.code === 'number' ? body.code : null;
    perfLog(order.id, 'callback_received', `callbackType=${callbackType || 'necunoscut'}, code=${callbackCode}, taskId=${taskId.slice(0, 8)}`);

    // Progres real, expus clientului (Problema 1 — procentul de generare) — actualizat pentru
    // ORICE callback recunoscut, indiferent daca declanseaza sau nu finalizarea mai jos.
    const CALLBACK_TYPE_TO_PHASE = { text: 'processing', first: 'first_stream', complete: 'finalizing' };
    if (CALLBACK_TYPE_TO_PHASE[callbackType]) {
      recordGenerationProgress(order.id, CALLBACK_TYPE_TO_PHASE[callbackType]).catch(() => {});
    }

    // Comenzile cu DOUA sarcini Suno (Premium/Video, doua genuri diferite — musicTaskId2
    // setat) NU pot fi finalizate de un callback individual: Suno trimite un callback PER
    // SARCINA, iar un callback pentru O SINGURA sarcina nu poate sti daca CEALALTA sarcina
    // (celalalt gen) e deja gata. Finalizarea combinata a ambelor genuri se face STRICT prin
    // polling, in runGeneration (vezi Promise.all acolo) — apelarea prematura a
    // finalizeVariantsIfNeeded aici ar scrie doar UN gen ca rezultat final, incalcand
    // promisiunea "exact doua melodii" a pachetului.
    if (order.musicTaskId2) {
      res.status(200).json({ received: true });
      return;
    }

    if (callbackType === 'complete' && callbackCode === 200) {
      const tracks = extractSunoTracks(body);
      // Aceeasi logica de gen/inlocuire partiala ca in resumeExistingTaskPolling (vezi
      // comentariul de acolo) — necesara pentru ca acest cod ruleaza si pentru regenerari
      // partiale Premium/Video (musicTaskId2 e null in acel caz, deci trece garda de mai sus).
      // Genul se afla PRIN ELIMINARE (vezi comentariul din runGeneration) — NICIODATA din
      // sourceVariant.genre (VECHI, dinainte de o eventuala schimbare de gen la editare).
      const isDualGenrePlan = PLAN_VARIANT_COUNT[order.plan] === 2;
      const sourceVariant = (isDualGenrePlan && order.regenerateSourceVariantId)
        ? (order.variants || []).find(v => v.id === order.regenerateSourceVariantId)
        : null;
      const siblingVariant = sourceVariant ? (order.variants || []).find(v => v.id !== sourceVariant.id) : null;
      const siblingGenre = siblingVariant ? siblingVariant.genre : null;
      const genreToUse = sourceVariant
        ? ((siblingGenre && siblingGenre === order.genre) ? order.genre2 : order.genre)
        : order.genre;
      // Standard, editare in curs (regenerateKeepOriginal, persistat in DB de POST
      // /regenerate — vezi comentariul de acolo): pastreaza originalul, nu inlocui array-ul.
      const replaceOptions = sourceVariant
        ? { replaceVariantId: sourceVariant.id }
        : (order.regenerateKeepOriginal ? { keepOriginalAsAlternative: true } : {});
      if (order.regenerationJobId) replaceOptions.regenerationJobId = order.regenerationJobId;
      await finalizeVariantsIfNeeded(order.id, [{ tracks, genre: genreToUse, taskId }], replaceOptions).catch(err => {
        console.error(`Callback SunoAPI: eroare la finalizarea comenzii ${order.id}:`, err.message);
      });
    } else if (callbackType === 'error' || (callbackCode !== null && callbackCode !== 200)) {
      const current = await db.getOrderById(order.id);
      if (current && !['preview_ready', 'ready', 'generation_failed'].includes(current.status)) {
        // Suno a raportat direct un esec prin callback (fara sa treaca prin
        // finalizeVariantsIfNeeded) — tot trebuie sa restituim atomic editarea rezervata,
        // daca esecul a aparut in timpul unei regenerari.
        await db.refundEditIfReserved(order.id).catch(refundErr => {
          console.error(`Eroare la restituirea editarii pentru comanda ${order.id}:`, refundErr.message);
        });
        await markGenerationFailed(order.id, `Suno callback: ${body.msg || callbackType || 'eroare necunoscuta'}`, current.variants, current.regenerationJobId);
      }
    }
    // callbackType 'text' / 'first' (etape intermediare) -> nu facem nimic aici,
    // polling-ul (pollForResult) continua sa verifice independent

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Eroare la procesarea callback-ului SunoAPI:', err.message);
    res.status(200).json({ received: true }); // 200 oricum — nu vrem retrimiteri la infinit
  }
});

// ==========================================================================================
// GENERARE — integrare SunoAPI.org, verificata contra documentatiei oficiale.
//
// UN SINGUR apel catre POST /api/v1/generate produce ambele variante (SunoAPI returneaza
// de obicei 2 piese per task) — NU facem 2 apeluri separate, ca sa nu consumam credite duble
// pentru ceva ce vine deja intr-un singur raspuns.
// ==========================================================================================

// Problema 1 (hotfix 2026-08-07): procentul numeric de generare, legat de milestone-uri
// REALE (niciodata un timer artificial incrementat orb). "video_processing" e mai mic decat
// "ready" ca procent brut, dar frontend-ul il trateaza ca o FAZA SEPARATA pentru pachetul
// Video (vezi t.videoPhaseLabel in melodia-mea.html/se-compune.html) — audio-ul e deja gata
// si ascultabil in acel moment, doar videoclipul mai continua in fundal.
const GENERATION_PHASE_PERCENT = {
  submitted: 10,
  processing: 30,
  first_stream: 55,
  finalizing: 80,
  ready: 100,
  video_processing: 90,
  video_ready: 100
};
async function recordGenerationProgress(orderId, phase) {
  if (!Object.prototype.hasOwnProperty.call(GENERATION_PHASE_PERCENT, phase)) return;
  try {
    await db.updateGenerationPhaseIfLater(orderId, phase, GENERATION_PHASE_PERCENT[phase]);
  } catch (err) {
    console.error(`Nu am putut inregistra progresul (${phase}) pentru comanda ${orderId}:`, err.message);
  }
}

// Progres de REGENERARE — SEPARAT complet de GENERATION_PHASE_PERCENT/recordGenerationProgress
// de mai sus (hotfix 2026-08-08, "FINISAJ FINAL PACHET STANDARD"). Bug real gasit prin
// verificare directa a codului: cele doua foloseau ACEEASI coloana (generation_phase_percent),
// iar updateGenerationPhaseIfLater scrie DOAR daca noul procent e mai mare — o comanda ajunsa
// deja 100% (generarea initiala) facea ca milestone-ul "submitted"=10% al unei regenerari
// ulterioare sa fie respins tacit (10 < 100), lasand procentul afisat inghetat la 100% pe tot
// parcursul regenerarii, desi jobul abia incepuse.
//
// jobId (regenerationJobId, generat cu randomUUID() la fiecare POST /regenerate) e OBLIGATORIU
// aici — fara el nu scriem nimic. Reluarile asincrone (resumeExistingTaskPolling, callback-ul
// SunoAPI) citesc acest jobId din DB (order.regenerationJobId), nu dintr-o variabila locala a
// cererii HTTP originale, care ar disparea la un restart de server.
const REGENERATION_PHASE_PERCENT = {
  submitted: 10,      // cererea de editare a fost salvata si jobul a fost creat
  prepared: 25,       // noile instructiuni si genul au fost pregatite (prompt construit)
  dispatched: 40,      // jobul a fost trimis furnizorului (Suno)
  processing: 60,      // furnizorul proceseaza noua versiune
  audio_ready: 80,      // noul fisier audio e disponibil (Suno a intors piese)
  preview_saved: 90,   // previewul e procesat si salvat (trimAudio + upload)
  ready: 100            // previewul nou exista, verificat, poate fi redat
};
async function recordRegenerationProgress(orderId, jobId, phase) {
  if (!jobId) return; // fara jobId (ex. generarea initiala) -> nimic de facut aici
  if (!Object.prototype.hasOwnProperty.call(REGENERATION_PHASE_PERCENT, phase)) return;
  try {
    await db.updateRegenerationPhaseIfLater(orderId, jobId, phase, REGENERATION_PHASE_PERCENT[phase]);
  } catch (err) {
    console.error(`Nu am putut inregistra progresul de regenerare (${phase}) pentru comanda ${orderId}:`, err.message);
  }
}

const SUNO_SUCCESS_STATUS = 'SUCCESS';
const SUNO_ERROR_STATUSES = ['CREATE_TASK_FAILED', 'GENERATE_AUDIO_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR'];
const SUNO_CONTINUE_STATUSES = ['PENDING', 'TEXT_SUCCESS', 'FIRST_SUCCESS'];

// Garda in-memory (per proces) impotriva reluarii de mai multe ori in paralel a
// polling-ului pentru ACEEASI comanda — daca utilizatorul apasa "Incearca din nou" de
// mai multe ori rapid cat timp comanda e deja 'generating', nu vrem sa lansam mai multe
// bucle de polling concurente pentru acelasi taskId (inofensiv, dar risipa de cereri).
const activePollResumptions = new Set();

// Reia verificarea unui task Suno DEJA EXISTENT (nu creeaza un task nou — asta previne
// generarile duplicate, cerinta explicita). Folosita cand clientul reincearca ("Incearca
// din nou") sau reincarca pagina cat timp comanda e deja 'generating' cu un music_task_id
// valid — ofera o "verificare ulterioara" activa, in completarea callback-ului SunoAPI
// (care poate sau nu sa ajunga, de exemplu daca reteaua Railway->noi are o problema
// tranzitorie chiar in acel moment).
async function resumeExistingTaskPolling(orderId, taskId) {
  if (activePollResumptions.has(orderId)) return; // deja se verifica in alta parte
  activePollResumptions.add(orderId);
  try {
    const order = await db.getOrderById(orderId);
    if (!order) return;

    // Comenzile cu DOUA sarcini Suno active (Premium/Video, generare initiala completa)
    // intrerupte INAINTE de finalizare (ex. un restart/redeploy de server chiar in fereastra
    // dintre "ambele genuri au reusit pe Suno" si "finalizeVariantsIfNeeded a terminat de
    // descarcat/taiat/urcat ambele piese") ramaneau anterior BLOCATE definitiv in 'generating'
    // — runGeneration-ul original care astepta ambele task-uri cu Promise.all murise odata cu
    // procesul, si aceasta functie doar "impingea" o SINGURA sarcina inainte, fara sa
    // finalizeze niciodata (gasit direct la testarea reala in staging: o comanda Premium a
    // ramas 'generating'/'finalizing' peste 5 minute dupa un redeploy in timpul generarii).
    // Reluam acum AMBELE sarcini in paralel — exact ca in runGeneration — si finalizam noi
    // insine daca ambele sunt deja gata pe Suno.
    if (order.musicTaskId2) {
      const [r1, r2] = await Promise.all([
        pollForResult(order.musicTaskId, orderId),
        pollForResult(order.musicTaskId2, orderId)
      ]);
      const fresh = await db.getOrderById(orderId);
      if (!fresh || ['preview_ready', 'ready', 'generation_failed'].includes(fresh.status)) return;
      if (r1.status === 'LOCAL_POLL_TIMEOUT' || r2.status === 'LOCAL_POLL_TIMEOUT') return; // ramane 'generating', se reia
      if (r1.status !== SUNO_SUCCESS_STATUS || r2.status !== SUNO_SUCCESS_STATUS) {
        if (SUNO_ERROR_STATUSES.includes(r1.status) || SUNO_ERROR_STATUSES.includes(r2.status)) {
          console.error(`Reluare polling dual: comanda ${orderId} a esuat (gen1="${order.genre}": ${r1.status}, gen2="${order.genre2}": ${r2.status}).`);
          await db.refundEditIfReserved(orderId);
          await markGenerationFailed(orderId, `Suno: gen1=${r1.status}, gen2=${r2.status}`, fresh.variants, fresh.regenerationJobId);
        }
        return;
      }
      await finalizeVariantsIfNeeded(orderId, [
        { tracks: r1.tracks, genre: order.genre, taskId: order.musicTaskId },
        { tracks: r2.tracks, genre: order.genre2, taskId: order.musicTaskId2 }
      ]);
      return;
    }

    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK' || finalStatus === 'LOCAL_POLL_TIMEOUT') {
      // Fie callback-ul a preluat-o deja, fie e tot in lucru — in ambele cazuri nu mai
      // avem nimic de facut aici.
      return;
    }
    if (finalStatus === SUNO_SUCCESS_STATUS) {
      // Regenerare partiala (Premium/Video, o singura varianta reeditata): foloseste genul
      // deja asociat variantei sursa si inlocuieste DOAR acea varianta — niciodata sora ei.
      // Standard, editare in curs: regenerateKeepOriginal (persistat in DB) pastreaza
      // originalul in loc sa inlocuiasca array-ul intreg. Pentru o generare INITIALA,
      // niciuna din cele doua nu se aplica — inlocuitor COMPLET (array-ul e oricum gol).
      // Genul se afla PRIN ELIMINARE (vezi comentariul din runGeneration) — NICIODATA din
      // sourceVariant.genre (VECHI, dinainte de o eventuala schimbare de gen la editare).
      const isDualGenrePlan = PLAN_VARIANT_COUNT[order.plan] === 2;
      const sourceVariant = (isDualGenrePlan && order.regenerateSourceVariantId)
        ? (order.variants || []).find(v => v.id === order.regenerateSourceVariantId)
        : null;
      const siblingVariant = sourceVariant ? (order.variants || []).find(v => v.id !== sourceVariant.id) : null;
      const siblingGenre = siblingVariant ? siblingVariant.genre : null;
      const genreToUse = sourceVariant
        ? ((siblingGenre && siblingGenre === order.genre) ? order.genre2 : order.genre)
        : order.genre;
      const replaceOptions = sourceVariant
        ? { replaceVariantId: sourceVariant.id }
        : (order.regenerateKeepOriginal ? { keepOriginalAsAlternative: true } : {});
      if (order.regenerationJobId) replaceOptions.regenerationJobId = order.regenerationJobId;
      await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: genreToUse, taskId }], replaceOptions);
      return;
    }
    if (SUNO_ERROR_STATUSES.includes(finalStatus)) {
      console.error(`Reluare polling: task ${taskId} (comanda ${orderId}) a esuat cu status "${finalStatus}".`);
      await db.refundEditIfReserved(orderId);
      await markGenerationFailed(orderId, `Suno: ${finalStatus}`, order.variants, order.regenerationJobId);
    }
  } catch (err) {
    console.error(`Eroare la reluarea polling-ului pentru comanda ${orderId}, taskId ${taskId}:`, err.message);
  } finally {
    activePollResumptions.delete(orderId);
  }
}

// Marcheaza o generare/regenerare esuata — dar NICIODATA aruncand la gunoi o varianta deja
// existenta si vandabila. Cerinta explicita a fluxului de editare cu alegere (Partea 2,
// hotfix 2026-08-08): "daca regenerarea esueaza, versiunea initiala ramane disponibila/
// selectabila". O comanda care avea deja variante gata inainte de aceasta incercare (adica
// aceasta era o REGENERARE, nu prima generare) revine la 'preview_ready' — variants/
// selectedVariantId raman neatinse (editarea gratuita e restituita SEPARAT de apelant, vezi
// db.refundEditIfReserved) — cu mesajul de eroare atasat doar informativ, pentru un eventual
// banner in interfata. O comanda FARA nicio varianta inca (prima generare a esuat, nimic de
// aratat/vandut) ramane 'generation_failed', ca pana acum — pagina dedicata de eroare
// (se-compune.html/melodia-mea.html) e singura optiune corecta in acel caz.
//
// knownVariants (optional): daca apelantul are deja starea DINAINTE de aceasta incercare
// (ex. finalizeVariantsIfNeeded, care a preluat atomic comanda si stie exact ce continea
// inainte sa inceapa procesarea curenta), o poate trece direct — evita un SELECT suplimentar
// si evita orice ambiguitate daca starea din DB s-ar fi schimbat intre timp.
//
// regenerationJobId (optional, hotfix 2026-08-08): daca esecul a aparut in timpul unei
// REGENERARI (nu al generarii initiale), marcheaza explicit jobul de regenerare ca 'failed' —
// singurul semnal pe care se-compune.html (in modul de regenerare) il poate folosi ca sa arate
// starea de eroare + retry, de vreme ce order.status revine la 'preview_ready' mai jos (nu mai
// ramane 'generation_failed'), identic cu starea de SUCCES a unei regenerari.
async function markGenerationFailed(orderId, errMessage, knownVariants, regenerationJobId) {
  const safeError = String(errMessage || 'Eroare necunoscuta').slice(0, 500);
  let hasSellableVariants;
  if (Array.isArray(knownVariants)) {
    hasSellableVariants = knownVariants.length > 0;
  } else {
    const fresh = await db.getOrderById(orderId);
    hasSellableVariants = !!(fresh && fresh.variants && fresh.variants.length > 0);
  }
  if (hasSellableVariants) {
    await db.updateOrder(orderId, { status: 'preview_ready', error: safeError });
    if (regenerationJobId) {
      await db.markRegenerationStatus(orderId, regenerationJobId, 'failed').catch(err => {
        console.error(`Eroare la marcarea esecului jobului de regenerare pentru comanda ${orderId}:`, err.message);
      });
    }
  } else {
    await db.updateOrder(orderId, { status: 'generation_failed', error: safeError });
  }
}

async function runGeneration(orderId, feedback, options = {}) {
  const order = await db.getOrderById(orderId);
  if (!order) throw new Error('Comanda a dispărut în timpul generării');

  perfLog(orderId, 'generation_start');
  recordGenerationProgress(orderId, 'submitted').catch(() => {});

  const isDualGenrePlan = PLAN_VARIANT_COUNT[order.plan] === 2;

  // Regenerare PARTIALA (doar Premium/Video): clientul a ales explicit sa reediteze O SINGURA
  // varianta existenta (POST .../regenerate cere variantId obligatoriu) — regeneram DOAR genul
  // acelei variante, cealalta ramane complet neatinsa (nu risipim un al doilea apel Suno pentru
  // un gen pe care clientul nu l-a cerut sa fie schimbat). Standard foloseste ramura de mai
  // jos, care PASTREAZA originalul si adauga varianta editata alaturi (options.keepOriginalAsAlternative,
  // vezi finalizeVariantsIfNeeded) — niciodata inlocuire completa la o editare.
  //
  // Genul de folosit: NICIODATA citit direct din sourceVariant.genre (VECHI — e valoarea
  // dinainte de editare, ramane neschimbata pana variantele sunt inlocuite la finalul acestei
  // generari) — daca clientul a cerut o schimbare de gen (hotfix 2026-08-08), POST /regenerate
  // a scris deja noua valoare in order.genre/genre2 INAINTE sa apeleze aceasta functie. Aflam
  // ce coloana ii corespunde variantei editate PRIN ELIMINARE, uitandu-ne la varianta SORA
  // (neatinsa, deci genul ei curent e mereu corect/actual): oricare din order.genre/genre2 NU
  // apartine surorii e genul de folosit acum.
  if (options.replaceVariantId && isDualGenrePlan) {
    const siblingVariant = (order.variants || []).find(v => v.id !== options.replaceVariantId);
    const siblingGenre = siblingVariant ? siblingVariant.genre : null;
    const genreToUse = (siblingGenre && siblingGenre === order.genre) ? order.genre2 : order.genre;
    recordRegenerationProgress(orderId, options.regenerationJobId, 'prepared').catch(() => {});
    const prompt = buildPrompt(order, feedback, genreToUse);
    const taskId = await callMusicProvider(orderId, prompt);
    recordRegenerationProgress(orderId, options.regenerationJobId, 'dispatched').catch(() => {});
    await db.updateOrder(orderId, { musicTaskId: taskId, musicTaskId2: null });
    recordRegenerationProgress(orderId, options.regenerationJobId, 'processing').catch(() => {});
    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK') {
      perfLog(orderId, 'polling_stopped_early_callback_won');
      return;
    }
    if (finalStatus === 'LOCAL_POLL_TIMEOUT') return;
    if (finalStatus !== SUNO_SUCCESS_STATUS) {
      throw new Error(`Suno a raportat un status de eroare: ${finalStatus}`);
    }
    recordRegenerationProgress(orderId, options.regenerationJobId, 'audio_ready').catch(() => {});
    await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: genreToUse, taskId }], { replaceVariantId: options.replaceVariantId, regenerationJobId: options.regenerationJobId });
    return;
  }

  // Standard: un singur gen, o singura cerere Suno. La o GENERARE INITIALA (fara variante
  // inca), inlocuieste normal (array-ul e oricum gol). La o EDITARE (options.keepOriginalAsAlternative,
  // setat de POST /regenerate), PASTREAZA originalul si adauga varianta editata alaturi —
  // clientul alege explicit intre ele (Partea 2, hotfix 2026-08-08).
  if (!isDualGenrePlan) {
    recordRegenerationProgress(orderId, options.regenerationJobId, 'prepared').catch(() => {});
    const prompt = buildPrompt(order, feedback);
    const taskId = await callMusicProvider(orderId, prompt);
    recordRegenerationProgress(orderId, options.regenerationJobId, 'dispatched').catch(() => {});
    await db.updateOrder(orderId, { musicTaskId: taskId, musicTaskId2: null });
    recordRegenerationProgress(orderId, options.regenerationJobId, 'processing').catch(() => {});
    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK') {
      perfLog(orderId, 'polling_stopped_early_callback_won');
      return;
    }
    if (finalStatus === 'LOCAL_POLL_TIMEOUT') return;
    if (finalStatus !== SUNO_SUCCESS_STATUS) {
      throw new Error(`Suno a raportat un status de eroare: ${finalStatus}`);
    }
    recordRegenerationProgress(orderId, options.regenerationJobId, 'audio_ready').catch(() => {});
    const standardOptions = options.keepOriginalAsAlternative ? { keepOriginalAsAlternative: true, regenerationJobId: options.regenerationJobId } : {};
    await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: order.genre, taskId }], standardOptions);
    return;
  }

  // Premium/Video: DOUA genuri diferite alese de client -> DOUA cereri Suno INDEPENDENTE,
  // pornite in PARALEL (nu secvential — reduce la jumatate timpul de asteptare fata de doua
  // cereri secventiale). Fiecare foloseste EXACT aceeasi poveste/destinatar/ocazie/voce —
  // doar stilul muzical difera intre ele (vezi buildPrompt, genreOverride).
  //
  // IMPORTANT — de ce NU folosim callback-ul ca sa finalizam aici: Suno trimite un callback
  // PER SARCINA (task), nu per comanda. Daca am lasa callback-ul sa apeleze
  // finalizeVariantsIfNeeded imediat ce O SINGURA sarcina termina, am risca sa scriem doar
  // UN gen ca rezultat final inainte ca CEALALTA sarcina sa fi terminat — incalcand direct
  // promisiunea "exact doua melodii" a pachetului. Vezi POST /api/music/callback: pentru
  // comenzi cu musicTaskId2 setat, callback-ul NU declanseaza finalizarea — doar polling-ul
  // (de mai jos, care asteapta explicit AMBELE sarcini) o face.
  const promptGenre1 = buildPrompt(order, feedback, order.genre);
  const promptGenre2 = buildPrompt(order, feedback, order.genre2);
  const [taskId1, taskId2] = await Promise.all([
    callMusicProvider(orderId, promptGenre1),
    callMusicProvider(orderId, promptGenre2)
  ]);
  await db.updateOrder(orderId, { musicTaskId: taskId1, musicTaskId2: taskId2 });
  perfLog(orderId, 'dual_genre_tasks_created', `gen1=${order.genre}, gen2=${order.genre2}`);

  await waitForDualTaskAndFinalize(orderId, taskId1, order.genre, taskId2, order.genre2);
}

// Extras din runGeneration (Premium/Video) — asteapta AMBELE sarcini Suno independente si
// finalizeaza doar daca AMBELE reusesc. Reutilizat si de reluarea polling-ului (vezi
// resumeDualTaskPolling mai jos): fereastra locala de polling a unei SINGURE treceri prin
// pollForResult (90 incercari * 6s = 9 minute, vezi maxAttempts implicit) poate sa nu fie
// suficienta pentru DOUA generari Suno simultane — daca ambele Promise.all(...) din
// pollForResult ajung la 'LOCAL_POLL_TIMEOUT' inainte ca furnizorul sa raporteze un status
// final, runGeneration se termina fara sa finalizeze NIMIC, lasand comanda 'generating' la
// nesfarsit — DECAT daca exista o cale explicita de reluare care sa apeleze din nou aceasta
// functie, cu ACEIASI doi taskId (nu cream niciodata sarcini Suno noi la o reluare — doar
// verificam din nou statusul celor deja pornite). Inainte de acest hotfix, plasa de siguranta
// (POST /generate si /regenerate, ramura "deja in desfasurare") relua polling-ul DOAR pentru
// musicTaskId (prima sarcina), niciodata musicTaskId2 — o comanda Premium/Video ramasa
// blocata dupa expirarea ferestrei locale nu putea fi niciodata recuperata automat.
async function waitForDualTaskAndFinalize(orderId, taskId1, genre1, taskId2, genre2) {
  const [r1, r2] = await Promise.all([
    pollForResult(taskId1, orderId),
    pollForResult(taskId2, orderId)
  ]);

  // Comanda cu doua sarcini nu poate fi "deja finalizata de callback" (callback-ul e un
  // no-op pentru ea, vezi mai sus) — dar tot verificam starea reala, ca sa nu continuam daca
  // intre timp comanda a fost stearsa/anulata sau marcata esuata pe alta cale.
  const fresh = await db.getOrderById(orderId);
  if (!fresh || ['preview_ready', 'ready', 'generation_failed'].includes(fresh.status)) return;

  if (r1.status === 'LOCAL_POLL_TIMEOUT' || r2.status === 'LOCAL_POLL_TIMEOUT') return; // ramane 'generating', se reia

  if (r1.status !== SUNO_SUCCESS_STATUS || r2.status !== SUNO_SUCCESS_STATUS) {
    throw new Error(`Generare esuata pentru unul din cele doua genuri (gen1="${genre1}": ${r1.status}, gen2="${genre2}": ${r2.status}).`);
  }

  await finalizeVariantsIfNeeded(orderId, [
    { tracks: r1.tracks, genre: genre1, taskId: taskId1 },
    { tracks: r2.tracks, genre: genre2, taskId: taskId2 }
  ]);
}

// Reluare pentru comenzi Premium/Video (doua sarcini) ramase 'generating' peste fereastra
// locala de polling — simetrica cu resumeExistingTaskPolling (comenzi cu o singura sarcina),
// dar asteapta din nou AMBELE sarcini existente (fara sa creeze niciuna noua) si finalizeaza
// atomic prin acelasi waitForDualTaskAndFinalize folosit si la generarea initiala.
async function resumeDualTaskPolling(orderId) {
  if (activePollResumptions.has(orderId)) return; // deja se verifica in alta parte
  activePollResumptions.add(orderId);
  let orderBeforeAttempt = null;
  try {
    const order = await db.getOrderById(orderId);
    orderBeforeAttempt = order;
    if (!order || !order.musicTaskId || !order.musicTaskId2) return;
    await waitForDualTaskAndFinalize(orderId, order.musicTaskId, order.genre, order.musicTaskId2, order.genre2);
  } catch (err) {
    console.error(`Reluare polling dual pentru comanda ${orderId}:`, err.message);
    await db.refundEditIfReserved(orderId).catch(refundErr => {
      console.error(`Eroare la restituirea editarii pentru comanda ${orderId}:`, refundErr.message);
    });
    await markGenerationFailed(orderId, err.message || err, orderBeforeAttempt ? orderBeforeAttempt.variants : undefined).catch(dbErr => {
      console.error('Eroare suplimentara la salvarea starii de esec:', dbErr.message);
    });
  } finally {
    activePollResumptions.delete(orderId);
  }
}

// Descarca+taie+urca in stocare fiecare piesa primita de la Suno, si scrie variantele
// finale pe comanda — DAR doar daca reuseste sa "preia" comanda atomic (vezi
// db.claimOrderForProviderFinalization). Polling-ul si callback-ul pot ajunge la SUCCESS
// aproape simultan; fara preluare atomica la nivel de baza de date, o simpla verificare
// "e deja procesata?" facuta separat de fiecare ar lasa o fereastra reala in care ambele
// trec de verificare inainte sa apuce vreuna sa scrie — ambele ar descarca si urca fisierele,
// dublu cost, dublu risc. UPDATE...WHERE...RETURNING e o singura operatie atomica in
// Postgres: doar una dintre cererile concurente poate "castiga" preluarea.
// requestsInfo: un element per cerere SEPARATA facuta catre Suno — [{ tracks, genre, taskId }].
// Standard: un singur element (un gen, o cerere). Premium/Video: doua elemente (doua genuri
// diferite alese de client, doua cereri Suno independente, pornite in paralel — vezi
// runGeneration). Fiecare cerere contribuie STRICT o singura varianta finala (prima piesa
// valida; a doua piesa a ACELEIASI cereri, daca exista, e doar fallback tehnic daca prima
// esueaza la procesare — niciodata livrata separat).
//
// options.replaceVariantId (optional): regenerare PARTIALA (Premium/Video, editarea unei
// singure variante existente) — inlocuieste DOAR acea varianta in array-ul existent,
// cealalta ramane complet neatinsa ("o revizie pastreaza genul variantei editate", "retry-ul
// unei variante nu regenereaza inutil cealalta"). Absent -> generare COMPLETA, variants[]
// inlocuit in intregime (generare initiala, sau regenerare Standard).
async function finalizeVariantsIfNeeded(orderId, requestsInfo, options = {}) {
  const claimed = await db.claimOrderForProviderFinalization(orderId);
  if (!claimed) {
    return false; // alta cerere (polling sau callback) a preluat-o deja — nu procesam a doua oara
  }

  const finalizeStart = Date.now();
  const totalTracks = requestsInfo.reduce((n, r) => n + (r.tracks ? r.tracks.length : 0), 0);
  perfLog(orderId, 'finalize_start', `cereri=${requestsInfo.length}, piese=${totalTracks}`);
  recordGenerationProgress(orderId, 'finalizing').catch(() => {});

  try {
    const builtVariants = [];
    const requestFailures = [];
    for (const { tracks, genre, taskId } of requestsInfo) {
      if (!tracks || tracks.length === 0) {
        requestFailures.push(`genul "${genre}": Suno nu a intors nicio piesa cu audioUrl`);
        continue;
      }
      let built = null;
      let lastErr = null;
      // incearca prima piesa; daca EA esueaza la procesare (descarcare/ffmpeg/upload), a
      // doua piesa a ACELEIASI cereri devine fallback tehnic — niciodata livrata separat.
      for (const track of tracks.slice(0, 2)) {
        try {
          built = await buildVariantFromTrack(orderId, randomUUID().slice(0, 8), track, taskId);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (built) {
        built.genre = genre;
        builtVariants.push(built);
      } else {
        requestFailures.push(`genul "${genre}": ${lastErr ? lastErr.message : 'motiv necunoscut'}`);
      }
    }

    if (builtVariants.length === 0) {
      throw new Error(`Toate cererile au esuat la procesare: ${requestFailures.join(' | ')}`);
    }
    // buildVariantFromTrack verifica deja explicit accesibilitatea reala a preview-ului
    // (verifyPreviewReachable) inainte sa returneze cu succes — la acest punct, fisierul
    // e deja taiat/reincodat SI incarcat in storage, deci "previewul e procesat si salvat".
    recordRegenerationProgress(orderId, options.regenerationJobId, 'preview_saved').catch(() => {});
    // Pentru Premium/Video, "exact doua melodii" e o promisiune ferma a pachetului — daca UNA
    // din cele doua cereri a esuat definitiv, NU livram tacit o singura melodie sub un pachet
    // care promite doua; tratam esecul PARTIAL ca esec TOTAL, ca ambele genuri sa poata fi
    // reincercate impreuna (clientul nu pierde nimic — nimic nu s-a marcat 'preview_ready').
    if (requestsInfo.length > 1 && builtVariants.length < requestsInfo.length && !options.replaceVariantId) {
      throw new Error(`Doar ${builtVariants.length} din ${requestsInfo.length} melodii au reusit: ${requestFailures.join(' | ')}`);
    }
    if (requestFailures.length > 0) {
      console.warn(`Comanda ${orderId}: ${requestFailures.length} cerere(i) esuata(e), continui cu ${builtVariants.length} varianta(e). Motiv: ${requestFailures.join(' | ')}`);
    }

    let variants;
    let newSelectedVariantId;
    let replacedOldVariants;
    if (options.replaceVariantId) {
      const existing = claimed.variants || [];
      const replaced = builtVariants[0];
      variants = existing.map(v => v.id === options.replaceVariantId ? replaced : v);
      newSelectedVariantId = options.keepSelectedVariantId || claimed.selectedVariantId;
      replacedOldVariants = existing.filter(v => v.id === options.replaceVariantId);
    } else if (options.keepOriginalAsAlternative) {
      // Standard, fluxul de editare cu alegere (Partea 2, hotfix 2026-08-08): editarea NU
      // inlocuieste originalul — il PASTREAZA, si adauga varianta noua alaturi, ca alegere
      // alternativa. Clientul TREBUIE sa aleaga explicit intre cele doua (POST /select)
      // inainte ca plata sa devina posibila — de aceea newSelectedVariantId ramane null aici
      // (POST /checkout respinge deja orice cerere fara selectedVariantId). Nu stergem NIMIC
      // din storage (replacedOldVariants ramane gol) — originalul trebuie sa ramana complet
      // functional/livrabil daca editarea esueaza sau daca clientul alege pana la urma sa
      // pastreze originalul.
      const existing = claimed.variants || [];
      const edited = builtVariants[0];
      edited.isEditedAlternative = true;
      variants = [...existing, edited];
      newSelectedVariantId = null;
      replacedOldVariants = [];
    } else {
      variants = builtVariants;
      newSelectedVariantId = variants[0]?.id || null;
      replacedOldVariants = claimed.variants || [];
    }

    await db.updateOrder(orderId, {
      status: 'preview_ready',
      variants,
      selectedVariantId: newSelectedVariantId,
      generatedAt: new Date().toISOString(),
      // succes: eliberam marcajul de rezervare a editarii (daca exista) FARA sa atingem
      // edits_used — editarea a fost folosita legitim, ramane consumata definitiv. Pentru
      // o generare INITIALA, editReserved era deja false — actualizarea e un no-op sigur.
      editReserved: false,
      // Stergem orice mesaj de eroare ramas de la o incercare anterioara esuata — altfel ar
      // ramane afisat/expus indefinit dupa un succes ulterior (vezi markGenerationFailed).
      error: null
    });
    // 'ready' aici = ambele melodii (sau singura, pentru Standard) gata si redabile — NU
    // 100% pentru pachetul Video, care mai are o a doua faza (videoclipul) dupa aceasta; vezi
    // triggerVideoGeneration/generatePremiumExtras pentru 'video_processing'/'video_ready'.
    recordGenerationProgress(orderId, 'ready').catch(() => {});
    if (options.regenerationJobId) {
      // "previewul nou exista, este verificat si poate fi redat" — exact acum, dupa ce
      // scrierea in DB a reusit (variants/status/selectedVariantId sunt deja persistate).
      recordRegenerationProgress(orderId, options.regenerationJobId, 'ready').catch(() => {});
      db.markRegenerationStatus(orderId, options.regenerationJobId, 'ready').catch(err => {
        console.error(`Eroare la marcarea succesului jobului de regenerare pentru comanda ${orderId}:`, err.message);
      });
    }

    // Fluxul obligatoriu "Cadou video" (cerintele 6-9): imediat ce melodia (initiala SAU
    // regenerata dupa o editare) ajunge 'preview_ready', si DOAR daca materialele au fost
    // deja confirmate, declansam AUTOMAT randarea videoclipului pentru varianta curenta —
    // inainte de plata, fara sa astepte niciun buton aditional. Complet asincron (nu
    // blocheaza raspunsul catre client, care vede preview-ul audio imediat); esecul aici
    // se vede in videoStaleReason/lipsa videoKey si poate fi reincercat din /create-video.
    if (claimed.plan === 'video' && newSelectedVariantId) {
      const freshOrder = await db.getOrderById(orderId);
      if (freshOrder && freshOrder.mediaConfirmedAt) {
        triggerVideoGeneration(orderId, newSelectedVariantId).catch(err => {
          console.error(`Comanda ${orderId}: randarea automata a videoclipului a esuat:`, err.message);
        });
      }
    }

    // ======================================================================================
    // CERINTA G14 — politica de curatare pentru versiuni audio inlocuite. La o REGENERARE
    // (nu la generarea initiala, unde claimed.variants e []), variantele vechi tocmai
    // inlocuite mai sus raman orfane in bucket-urile R2/S3 daca nu le stergem explicit —
    // nimic altceva nu le mai atinge vreodata. Stergem acum fullKey/previewKey SI wavKey/
    // videoKey — un videoclip/WAV al unei variante INLOCUITE nu mai poate fi livrat legitim
    // niciodata. La regenerare PARTIALA (replaceVariantId), stergem DOAR fisierele variantei
    // efectiv inlocuite, niciodata pe cele ale surorii ei neatinse.
    //
    // Curatare best-effort, DUPA ce noile variante sunt deja salvate cu succes, si niciodata
    // pentru comenzi deja 'ready' (regenerarea e blocata dupa plata). Doar bucket-urile cloud.
    // ======================================================================================
    if (storage.CLOUD_ENABLED && replacedOldVariants && replacedOldVariants.length > 0) {
      const oldVariants = replacedOldVariants;
      Promise.allSettled(oldVariants.flatMap(v => [
        v.fullKey ? storage.deletePrivateFile(v.fullKey) : null,
        v.previewKey ? storage.deletePublicFile(v.previewKey) : null,
        v.wavKey ? storage.deletePrivateFile(v.wavKey) : null,
        v.videoKey ? storage.deletePrivateFile(v.videoKey) : null
      ].filter(Boolean))).then(results => {
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          console.error(`Comanda ${orderId}: ${failed.length} fisier(e) vechi nu au putut fi sterse din storage dupa regenerare:`, failed.map(f => f.reason && f.reason.message).join(' | '));
        }
      });
    }

    perfLog(orderId, 'finalize_done', `${Date.now() - finalizeStart}ms, variante_reusite=${builtVariants.length}`);
    // durata totala de la crearea comenzii pana la 'preview_ready' — util ca sa vedem cat
    // din timpul perceput de client vine de fapt din asteptarea inainte de generare
    // (crearea comenzii, formular etc.) fata de generarea efectiva
    if (claimed.createdAt) {
      const totalMs = Date.now() - new Date(claimed.createdAt).getTime();
      perfLog(orderId, 'total_since_order_created', `${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);
    }
    return true;
  } catch (err) {
    // Am apucat sa marcam comanda "processing_provider_result" (am preluat-o), dar
    // procesarea a esuat la mijloc (descarcare, ffmpeg, verificare durata, upload, salvare
    // etc). NU o lasam blocata acolo permanent — o marcam explicit esuata, cu un mesaj de
    // eroare sigur (trunchiat, fara detalii interne sensibile).
    console.error(`Eroare la finalizarea comenzii ${orderId} dupa preluare:`, err.message);
    try {
      // Restituire ATOMICA si IDEMPOTENTA a editarii gratuite, DOAR daca era rezervata
      // (adica esecul a aparut in timpul unei regenerari, nu al generarii initiale).
      // Acest cod ruleaza indiferent daca finalizarea a fost declansata de polling sau
      // de callback-ul SunoAPI — acelasi mecanism acopera ambele cai.
      await db.refundEditIfReserved(orderId);
    } catch (refundErr) {
      console.error(`Eroare suplimentara la restituirea editarii pentru comanda ${orderId}:`, refundErr.message);
    }
    await markGenerationFailed(orderId, err.message || err, claimed.variants, options.regenerationJobId).catch(dbErr => {
      console.error(`Eroare suplimentara la marcarea esecului pentru comanda ${orderId}:`, dbErr.message);
    });
    throw err;
  }
}

// Proceseaza O SINGURA piesa primita de la Suno (deja avem URL-ul audio): descarcare,
// taiere preview cu ffmpeg, citire durata, urcare in stocare (cloud sau fallback local).
// Identic ca logica de stocare cu versiunea anterioara — doar decuplat de apelul catre provider.
// ==========================================================================================
// PREVIEW-UL PASTREAZA UN INTRO INSTRUMENTAL NATURAL (~8-10 sec) INAINTE DE VOCE, NU SARE
// DIRECT LA PRIMUL CUVANT — daca vocea porneste deja devreme in melodie, preview-ul incepe
// pur si simplu de la secunda 0 (nimic de mutat); daca vocea porneste tarziu, preview-ul e
// mutat inainte astfel incat vocea sa ajunga sa se auda in jurul secundei 9 din preview.
//
// Foloseste endpoint-ul OFICIAL, deja documentat, al furnizorului actual (sunoapi.org):
// POST /api/v1/generate/get-timestamped-lyrics — verificat direct in documentatia lor,
// returneaza `alignedWords`: cuvinte cu timp de start/sfarsit exact (secunde), plus un
// flag `success` per cuvant. Aceasta e sursa de adevar REALA, nu o presupunere audio.
//
// Fisierul COMPLET (platit) nu e atins in niciun fel de aceasta functie — doar decide DE
// UNDE incepe taierea preview-ului (trimAudio). Orice esec, la orice pas, cade automat pe
// previewStart = 0 (comportamentul de dinainte) — nicio generare nu esueaza din cauza asta.
// ==========================================================================================
const TIMESTAMPED_LYRICS_TIMEOUT_MS = 8000; // timeout scurt — nu tinem procesarea in loc
const TARGET_VOICE_POSITION_S = 9;          // pozitia dorita a vocii IN preview (secunda 8-10)
const PREVIEW_START_MAX_S = 25;             // plafon dur — niciodata mai mult de 25 sec sarite

// Eticheta structurala intre paranteze patrate (ex. "[Verse]", "[Chorus]") nu e un cuvant
// cantat efectiv — o eliminam ca sa vedem daca ramane text real dupa ea (uneori raspunsul
// providerului concateneaza eticheta cu primul cuvant in acelasi camp).
function stripStructuralTagsFromWord(word) {
  return String(word || '').replace(/\[[^[\]]*\]/g, '').trim();
}

// Un singur apel HTTP, cu maximum o reincercare — DOAR pentru timeout sau erori 5xx
// (probleme temporare ale furnizorului). O eroare 4xx (ex. audioId invalid) nu se
// reincearca, pentru ca repetarea ei nu ar schimba rezultatul.
async function fetchTimestampedLyricsOnce(taskId, audioId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `${process.env.MUSIC_API_BASE_URL}/api/v1/generate/get-timestamped-lyrics`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.MUSIC_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ taskId, audioId })
        },
        TIMESTAMPED_LYRICS_TIMEOUT_MS
      );
      if (res.ok) return { ok: true, res };
      if (res.status >= 500 && attempt === 0) continue; // eroare temporara -> o singura reincercare
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      if (attempt === 0) continue; // timeout/eroare de retea -> o singura reincercare
      return { ok: false, reason: `timeout/retea: ${err.message}` };
    }
  }
  return { ok: false, reason: 'necunoscut' };
}

async function getPreviewStartFromLyrics(taskId, audioId, orderId) {
  // identificatori scurtati pentru loguri — niciodata tokenul API, niciodata date sensibile
  const orderTag = orderId ? String(orderId).slice(0, 8) : '?';
  const taskTag = taskId ? String(taskId).slice(0, 8) : '?';
  const logPrefix = `[preview-start] comanda ${orderTag}, task ${taskTag}`;

  function fallback(reason) {
    console.log(`${logPrefix}: fallback la previewStart=0 (motiv: ${reason})`);
    return 0;
  }

  if (!taskId || !audioId) {
    return fallback('taskId sau audioId lipsa');
  }

  let outcome;
  try {
    outcome = await fetchTimestampedLyricsOnce(taskId, audioId);
  } catch (err) {
    return fallback(`eroare neasteptata: ${err.message}`);
  }
  if (!outcome.ok) {
    return fallback(outcome.reason);
  }

  let body;
  try {
    body = await outcome.res.json();
  } catch (err) {
    return fallback('raspuns invalid (nu e JSON)');
  }

  if (!body || body.code !== 200 || !body.data || !Array.isArray(body.data.alignedWords)) {
    return fallback('structura raspuns neasteptata');
  }

  const words = body.data.alignedWords;
  if (words.length === 0) {
    return fallback('alignedWords gol');
  }

  const firstReal = words.find(w =>
    w && w.success === true &&
    typeof w.startS === 'number' && Number.isFinite(w.startS) && w.startS >= 0 &&
    stripStructuralTagsFromWord(w.word).length > 0
  );

  if (!firstReal) {
    return fallback('niciun cuvant real cu success:true gasit');
  }

  // Formula: pastram un intro instrumental natural in preview — nu mutam preview-ul
  // pana la primul cuvant (asta ar face vocea sa intre BRUSC, din prima secunda), ci
  // calculam un punct de start astfel incat vocea sa ajunga sa se auda in jurul secundei
  // TARGET_VOICE_POSITION_S in interiorul preview-ului. Daca vocea porneste deja devreme
  // in melodie (<= 9s), previewStart ramane 0 — nu mutam nimic, se pastreaza inceputul
  // original (vocea se va auzi pur si simplu mai devreme de secunda 9, ceea ce e in regula).
  let previewStart = firstReal.startS - TARGET_VOICE_POSITION_S;
  previewStart = Math.max(0, previewStart);
  previewStart = Math.min(previewStart, PREVIEW_START_MAX_S);

  console.log(
    `${logPrefix}: primul cuvant real la ${firstReal.startS.toFixed(2)}s -> ` +
    `previewStart=${previewStart.toFixed(2)}s (fallback: nu)`
  );
  return previewStart;
}

// Verifica DUPA upload ca preview-ul e chiar accesibil public la URL-ul construit din
// S3_PUBLIC_BASE_URL. Un raspuns 200/206 de la PutObjectCommand catre R2/S3 NU garanteaza
// ca fisierul e livrat corect prin domeniul public configurat — Custom Domain-ul Cloudflare
// neconectat/neconfigurat cu DNS proxied, un S3_PUBLIC_BASE_URL gresit, sau bucket-ul fara
// acces public activat sunt toate probleme complet in afara controlului acestui cod, dar
// care lasa exact urma unui "player audio care afiseaza Eroare": comanda ajunge legitim la
// 'preview_ready', cu un previewUrl care ARATA valid, dar care nu se poate incarca de fapt
// in browser. Verificarea foloseste un Range request pentru primii 2 octeti — testeaza in
// aceeasi cerere atat existenta/accesibilitatea fisierului, cat si suportul pentru Range
// (necesar pentru Safari). Un singur retry, doar pentru esec tranzitoriu de retea/timeout,
// ca sa nu marcam o comanda buna drept esuata din cauza unui blip temporar de retea.
// DACA verificarea esueaza, aruncam o eroare clara — variant-ul e tratat ca esuat prin
// acelasi mecanism ca un esec de download/ffmpeg/upload (Promise.allSettled in
// finalizeVariantsIfNeeded), deci comanda devine explicit 'generation_failed', cu eroarea
// REALA in logul serverului, in loc sa ramana 'preview_ready' cu un URL nefunctional.
async function verifyPreviewReachable(orderId, variantId, previewUrl) {
  const vTag = `varianta=${variantId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(previewUrl, { headers: { Range: 'bytes=0-1' } }, 10000);
      const contentType = res.headers.get('content-type') || '(lipsa)';
      const contentLength = res.headers.get('content-length') || '(lipsa)';
      // previewUrl e PUBLIC prin design (nu e semnat, nu e privat) — sigur de logat integral,
      // e exact URL-ul pe care browserul clientului il va incerca oricum.
      perfLog(orderId, 'preview_verify', `${vTag}, status=${res.status}, content-type=${contentType}, content-length=${contentLength}, url=${previewUrl}`);

      if (!res.ok) {
        throw new Error(`Preview urcat cu succes in storage, dar URL-ul public raspunde cu HTTP ${res.status} la ${previewUrl} — verifica S3_PUBLIC_BASE_URL, Custom Domain-ul Cloudflare (trebuie DNS proxied) si accesul public pe bucket.`);
      }
      if (!contentType.toLowerCase().startsWith('audio/')) {
        throw new Error(`Preview accesibil la ${previewUrl}, dar Content-Type raspuns e "${contentType}" in loc de audio/mpeg — verifica configuratia bucket-ului/CDN-ului.`);
      }
      return; // succes
    } catch (err) {
      const transient = err.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err.message));
      if (transient && attempt === 0) continue; // o singura reincercare, doar pt. esec tranzitoriu
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

async function buildVariantFromTrack(orderId, variantId, track, taskId) {
  if (!track.audioUrl) {
    throw new Error(`Piesa primita de la Suno (id: ${track.id || 'necunoscut'}) nu are audioUrl/audio_url.`);
  }

  const tempFull = path.join(TEMP_DIR, `${orderId}-${variantId}-full.mp3`);
  const tempPreview = path.join(TEMP_DIR, `${orderId}-${variantId}-preview.mp3`);
  const vTag = `varianta=${variantId}`;

  // Descarcarea fisierului si cererea de timestamp-uri NU depind una de cealalta (ambele
  // au nevoie doar de taskId/track.id, disponibile deja) — le rulam in PARALEL, nu una
  // dupa alta, ca sa nu adaugam timpul lor unul peste celalalt in "drumul critic" al
  // generarii. Fisierul COMPLET (tempFull) ramane neschimbat de acest pas — descarcarea e
  // singura operatie care il atinge.
  const downloadStart = Date.now();
  const timestampStart = Date.now();
  perfLog(orderId, 'download_start', vTag);
  perfLog(orderId, 'timestamp_fetch_start', vTag);
  const [, previewStart] = await Promise.all([
    downloadFile(track.audioUrl, tempFull).then(() => {
      perfLog(orderId, 'download_done', `${vTag}, ${Date.now() - downloadStart}ms`);
    }),
    getPreviewStartFromLyrics(taskId, track.id, orderId).then(v => {
      perfLog(orderId, 'timestamp_fetch_done', `${vTag}, ${Date.now() - timestampStart}ms`);
      return v;
    })
  ]);

  // Taierea preview-ului (FFmpeg, doar copiere de stream — deja cea mai rapida optiune
  // posibila pentru asta, fara reincodare) si citirea duratei fisierului complet (ffprobe)
  // NU depind una de cealalta — ambele au nevoie doar de tempFull, deja descarcat. Le
  // rulam de asemenea in paralel.
  const ffmpegStart = Date.now();
  perfLog(orderId, 'ffmpeg_start', vTag);
  const [, durationSeconds] = await Promise.all([
    trimAudio(tempFull, tempPreview, PREVIEW_SECONDS, previewStart).then(() => {
      perfLog(orderId, 'ffmpeg_done', `${vTag}, ${Date.now() - ffmpegStart}ms`);
    }),
    getAudioDuration(tempFull)
  ]);

  const fullKey = `orders/full/${orderId}-${variantId}.mp3`;
  const previewKey = `orders/preview/${orderId}-${variantId}.mp3`;

  let previewUrl;
  let storedFullKey = null;
  let storedPreviewKey = null;
  const uploadStart = Date.now();

  if (storage.CLOUD_ENABLED) {
    // fisierul complet merge STRICT in bucket-ul privat (naluna-private) — nu exista nicio
    // functie in storage.js care sa-l poata trimite din greseala in bucket-ul public.
    // Accesul se face doar prin URL semnat, generat la cerere, dupa ce verificam plata.
    // Cele doua upload-uri sunt independente (fisiere si bucket-uri diferite) — le rulam
    // in paralel.
    await Promise.all([
      storage.uploadPrivateFile(tempFull, fullKey, 'audio/mpeg'),
      storage.uploadPublicFile(tempPreview, previewKey, 'audio/mpeg')
    ]);
    previewUrl = storage.getPublicUrl(previewKey);
    // Verificam ca preview-ul e chiar accesibil public INAINTE sa consideram varianta
    // reusita — vezi comentariul de la verifyPreviewReachable() pentru motiv.
    await verifyPreviewReachable(orderId, variantId, previewUrl);
    storedFullKey = fullKey;
    storedPreviewKey = previewKey;
    fs.unlinkSync(tempFull);
    fs.unlinkSync(tempPreview);
  } else {
    // fallback local — fara stocare cloud configurata, pastram comportamentul de dinainte
    fs.renameSync(tempFull, path.join(MEDIA_FULL_DIR, `${orderId}-${variantId}.mp3`));
    fs.renameSync(tempPreview, path.join(MEDIA_PREVIEW_DIR, `${orderId}-${variantId}.mp3`));
    previewUrl = `/media/preview/${orderId}/${variantId}`;
  }
  perfLog(orderId, 'upload_save_done', `${vTag}, ${Date.now() - uploadStart}ms`);

  return {
    id: variantId,
    previewUrl,
    durationSeconds,
    fullKey: storedFullKey,       // null in fallback local; folosit de /media/full cand storage.CLOUD_ENABLED
    previewKey: storedPreviewKey, // null in fallback local; folosit de /media/preview cand storage.CLOUD_ENABLED
    // ID-ul REAL Suno al piesei (UUID complet, diferit de variantId-ul nostru scurt/aleator
    // de mai sus) — necesar pentru a putea cere din nou versurile cu marcaj de timp
    // (get-timestamped-lyrics) DUPA plata, la generarea video-ului cu versuri (pachetul
    // "video"). Fara el, nu am avea cum sa asociem inapoi varianta aleasa cu piesa reala
    // Suno o data ce am trecut de acest moment.
    sunoTrackId: track.id || null,
    // Versurile ORIGINALE, asa cum au fost extrase din raspunsul Suno (vezi caveatul din
    // extractSunoTracks — poate fi null daca providerul nu a inclus acest camp). editedLyrics
    // ramane null pana cand clientul salveaza o editare explicita (vezi endpoint-ul dedicat
    // POST /api/orders/:orderId/variants/:variantId/lyrics).
    originalLyrics: track.lyrics || null,
    editedLyrics: null,
    lyricsUpdatedAt: null
  };
}

// ==========================================================================================
// EXTRASE PACHET PLATIT — WAV (premium + video) si videoclip cu versuri sincronizate (doar
// video). Pornite ASINCRON DUPA confirmarea platii (webhook) — niciodata inainte (o comanda
// neplatita/abandonata la checkout nu trebuie sa consume procesare pentru extrase pe care
// clientul nu le-a platit inca). Nu blochează livrarea imediata a MP3-ului (deja dovedita) —
// emailul de livrare mentioneaza ca aceste extrase apar in cateva minute la pagina comenzii.
//
// Verificat direct (2026-08-03, audit pachete): inainte de asta, cele 3 pachete (standard/
// premium/video) erau IDENTICE in spate — order.plan nu influenta nimic in afara de pret.
// Premium promitea WAV, Video promitea un videoclip — niciunul nu exista in cod.
// ==========================================================================================

// options.forceVideo: DOAR apelul explicit al clientului (POST .../create-video) trimite
// true aici. Webhook-ul de plata NU mai declanseaza automat videoclipul (spre deosebire de
// WAV, care ramane mereu automat) — motivul e sa nu existe nicio cursa intre "clientul inca
// incarca poze/videoclipuri" si randarea care ar porni oricum, fara ele, daca ar fi automata.
async function generatePremiumExtras(orderId, options = {}) {
  const { forceVideo = false, forVariantId = null, forMediaRevision = null } = options;
  const order = await db.getOrderById(orderId);
  if (!order || order.plan === 'standard') return; // standard nu are extrase de generat
  if (!storage.CLOUD_ENABLED) {
    console.warn(`Comanda ${orderId}: extrase premium/video sarite — storage cloud nu e activat.`);
    return;
  }
  const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);
  if (!variant || !variant.fullKey) {
    console.error(`Comanda ${orderId}: nu pot genera extrase — varianta aleasa nu are fullKey.`);
    return;
  }

  const tempFull = path.join(TEMP_DIR, `${orderId}-extras-full.mp3`);
  try {
    const signedUrl = await storage.getSignedDownloadUrl(variant.fullKey, 600);
    await downloadFile(signedUrl, tempFull);
    perfLog(orderId, 'extras_source_downloaded');

    const patch = {};

    if ((order.plan === 'premium' || order.plan === 'video') && !variant.wavKey) {
      try {
        patch.wavKey = await generateWavExtra(orderId, variant.id, tempFull);
        perfLog(orderId, 'wav_ready', `varianta=${variant.id}`);
      } catch (err) {
        console.error(`Comanda ${orderId}: generarea WAV a esuat:`, err.message);
      }
    }

    if (order.plan === 'video' && forceVideo && !variant.videoKey) {
      try {
        const videoResult = await generateLyricVideo(order, variant, tempFull);
        patch.videoKey = videoResult.videoKey;
        patch.sectionTimings = videoResult.sectionTimings;
        patch.videoFailedReason = null;
        perfLog(orderId, 'video_ready', `varianta=${variant.id}`);
      } catch (err) {
        console.error(`Comanda ${orderId}: generarea videoclipului a esuat:`, err.message);
        patch.videoFailedReason = String(err.message || err).slice(0, 300);
      }
    }

    if (Object.keys(patch).length > 0) {
      // Cerinta E9: daca acest apel a fost facut PENTRU o versiune specifica (variantId +
      // mediaRevision, vezi triggerVideoGeneration), verificam ca acea versiune INCA e
      // cea curenta inainte de a scrie rezultatul — un randare care se termina dupa ce
      // clientul a schimbat deja varianta sau materialele NU are voie sa scrie peste
      // versiunea noua. WAV-ul (nu depinde de materiale/mediaRevision) se scrie oricum;
      // doar videoKey/sectionTimings/videoFailedReason sunt conditionate de versiune.
      let allowVideoWrite = true;
      if (forVariantId !== null && forMediaRevision !== null) {
        allowVideoWrite = await db.isVideoClaimStillCurrent(orderId, forVariantId, forMediaRevision);
        if (!allowVideoWrite) {
          console.warn(`Comanda ${orderId}: rezultatul video pentru varianta ${forVariantId}/revizia ${forMediaRevision} a fost aruncat — versiunea nu mai e cea curenta.`);
        }
      }
      const videoOnlyKeys = ['videoKey', 'sectionTimings', 'videoFailedReason'];
      const finalPatch = allowVideoWrite ? patch : Object.fromEntries(Object.entries(patch).filter(([k]) => !videoOnlyKeys.includes(k)));

      if (Object.keys(finalPatch).length > 0) {
        const fresh = await db.getOrderById(orderId);
        if (fresh) {
          const updatedVariants = (fresh.variants || []).map(v =>
            v.id === order.selectedVariantId ? { ...v, ...finalPatch } : v
          );
          await db.updateOrder(orderId, { variants: updatedVariants });
        }
      }
    }
  } catch (err) {
    console.error(`Comanda ${orderId}: eroare generala la generarea extraselor platite:`, err.message);
  } finally {
    try { if (fs.existsSync(tempFull)) fs.unlinkSync(tempFull); } catch (e) { /* best-effort */ }
  }
}

async function generateWavExtra(orderId, variantId, tempFullMp3Path) {
  const tempWav = path.join(TEMP_DIR, `${orderId}-${variantId}-full.wav`);
  await execFfmpeg(['-y', '-i', tempFullMp3Path, tempWav]);
  const wavKey = `orders/full-wav/${orderId}-${variantId}.wav`;
  await storage.uploadPrivateFile(tempWav, wavKey, 'audio/wav');
  try { fs.unlinkSync(tempWav); } catch (e) { /* best-effort */ }
  return wavKey;
}

// Elimina segmente [Section] SAU (note de productie, ex. "(Gentle acoustic guitar
// fingerpicking)") care se pot intinde pe MAI MULTE token-uri de cuvant — verificat direct
// pe date reale Suno: "[Intro]\n\n\n(" ... "Gentle " ... "strums)\n\n\n", parantezele nu
// sunt niciodata continute intr-un singur token. O masina de stari simpla urmareste daca
// suntem "in interiorul" unei paranteze pe masura ce parcurgem cuvintele, ca acel text
// (niciodata cantat efectiv) sa nu ajunga afisat in subtitrare ca si cum ar fi versuri.
function stripSpanningNotes(alignedWords) {
  const out = [];
  let depth = 0;
  for (const w of alignedWords) {
    if (!w || typeof w.word !== 'string') { out.push(w); continue; }
    const text = w.word.replace(/\[[^[\]]*\]/g, '');
    let visible = '';
    for (const ch of text) {
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) visible += ch;
    }
    out.push({ ...w, word: visible });
  }
  return out;
}

function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msRem, 3)}`;
}

// Grupeaza cuvintele aliniate in linii de caption, folosind salturile de linie naturale
// din versuri (nu o limita fixa de cuvinte) — citeste mai natural, respecta structura
// reala a versurilor scrise de Suno.
function buildCaptionLines(rawAlignedWords, recipient) {
  const alignedWords = stripSpanningNotes(rawAlignedWords);
  const lines = [];
  let buffer = [];
  let bufferStart = null;
  let lastRealEnd = null;

  function flush(endS) {
    if (buffer.length === 0) return;
    // join('') NU join(' ') — fiecare token Suno isi contine deja propriul spatiu final
    // acolo unde e cazul ("the ", "morning ") — un join fortat cu spatiu ar produce
    // "you' ve" in loc de "you've" la contractii, verificat direct pe date reale.
    const text = buffer.join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ start: bufferStart, end: endS, text });
    buffer = [];
    bufferStart = null;
  }

  for (const w of alignedWords) {
    if (!w || w.success !== true || typeof w.startS !== 'number') continue;
    const hasNewline = /\n/.test(w.word);
    const clean = w.word.replace(/\n/g, ' ');
    if (clean.trim()) {
      if (bufferStart === null) bufferStart = w.startS;
      buffer.push(clean);
      lastRealEnd = w.endS;
    }
    if (hasNewline) flush(w.endS);
  }
  flush(lastRealEnd || bufferStart);

  const introEnd = lines.length > 0 ? lines[0].start : 3;
  const result = [];
  if (introEnd > 1) {
    result.push({ start: 0, end: Math.min(introEnd, 5), text: `For ${recipient}` });
  }
  result.push(...lines);

  // preveni suprapunerea: end-ul unei linii nu trece peste start-ul urmatoarei
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].end > result[i + 1].start) result[i].end = result[i + 1].start;
  }
  // plasa de siguranta impotriva anomaliilor de aliniere Suno — verificat direct pe date
  // reale ca API-ul poate raporta un endS aberant pentru un cuvant (un singur cuvant cu
  // startS=0.58, endS=14.04 — aproape sigur un artefact, nu o nota reala tinuta 13+ secunde).
  // Fara aceasta limita, o astfel de anomalie ar "inghetha" o linie de subtitrare pe ecran
  // mult mai mult decat e firesc pentru cate cuvinte contine.
  const MAX_LINE_DISPLAY_S = 7;
  for (const l of result) {
    if (l.end - l.start > MAX_LINE_DISPLAY_S) l.end = l.start + MAX_LINE_DISPLAY_S;
  }
  return result;
}

function toSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${srtTimestamp(l.start)} --> ${srtTimestamp(l.end)}\n${l.text}\n`).join('\n');
}

// ==========================================================================================
// TRUE SECTION TIMING ALIGNMENT — implementarea (normalizeSectionType,
// extractSectionMarkersFromAlignedWords, deriveSectionTimings,
// computeSectionAwareSegmentDurations) traieste acum in lib/media-analysis.js, importata mai
// sus — extrasa acolo ca sa fie testabila izolat (vezi test/media-analysis.test.js), fara
// Postgres/Stripe/Suno pornite. Sursa datelor ramane aceeasi: marcajele de structura ([Verse],
// [Chorus], [Intro], [Bridge], [Outro] etc.) pe care Suno le include DIRECT in fluxul de
// cuvinte aliniate (alignedWords) intors de get-timestamped-lyrics — acelasi raspuns folosit
// deja pentru pozitionarea preview-ului si pentru caption-uri. Fiecare granita de sectiune
// vine dintr-un cuvant cu timestamp confirmat de Suno, cu propriul flag `success` — NU o
// distributie egala a duratei. Daca o melodie nu contine deloc astfel de etichete, apelantul
// (deriveSectionTimings) intra explicit intr-un fallback controlat si clar etichetat,
// niciodata in tacere.
// ==========================================================================================

// Culoare de fundal si stil de subtitrare aliniate la identitatea vizuala Naluna (crem/auriu
// pe fond cald inchis — vezi paleta din public/index.html: --gold-deep:#8B6D3F, text pe
// fond deschis #2B2B2B). Pentru un fundal video am ales o varianta INCHISA a acelorasi
// tonuri calde (nu fundalul deschis al site-ului) — text deschis pe fond inchis se citeste
// mult mai bine intr-un videoclip decat invers, mai ales pe telefon.
const VIDEO_BG_COLOR = '0x2B2016'; // maro cald inchis, din aceeasi familie ca --gold-deep
const VIDEO_TEXT_STYLE = "FontName=Arial,FontSize=18,PrimaryColour=&H00E8F0F6,OutlineColour=&H0016202B,BorderStyle=1,Outline=2,Alignment=2,MarginV=150";

// ==========================================================================================
// Videoclip cinematic cu memorii (poze/videoclipuri incarcate de client) — Faza 1.
//
// Arhitectura in 3 treceri separate, fiecare cu un ffmpeg simplu si usor de depanat, in loc
// de un singur filter_complex urias (mai rapid de scris, dar mult mai fragil pe un CPU lent
// ca cel de pe Railway — o eroare intr-un lant complex e mult mai greu de izolat):
//   1) fiecare element (poza/videoclip) -> un segment TACUT, durata fixa, cu efect Ken Burns
//      (poze) sau scalare/decupare/bucla (videoclipuri) — renderMemorySegment()
//   2) segmentele -> UN singur fundal video tacut, cu tranzitii crossfade intre ele,
//      durata TOTALA exact egala cu durata melodiei — concatWithCrossfades()
//   3) fundalul + audio-ul real + subtitrarile sincronizate -> videoclipul final (aceeasi
//      trecere finala ca la fundalul solid, doar sursa video difera)
//
// Daca ORICE pas de mai sus esueaza (element corupt, timeout, ffmpeg indisponibil etc.),
// generateLyricVideo() prinde eroarea si trece automat pe fundalul solid dovedit — clientul
// primeste intotdeauna un videoclip, chiar daca nu cel cinematic. Aceasta e prioritatea
// explicita a clientului: robustete inainte de efecte avansate.
//
// Faza 2 (IMPLEMENTATA — 2026-08-06): aliniere reala pe sectiuni ([Verse 1], [Chorus] etc,
// cu marcaje de timp reale din alignedWords), in loc de distributia egala folosita ca
// fallback in Faza 1. Vezi deriveSectionTimings/computeSectionAwareSegmentDurations in
// lib/media-analysis.js — MEMORY_SECTION_ORDER de mai jos ramane folosit pentru a ORDONA
// elementele dupa eticheta aleasa de client la incarcare; ferestrele REALE de timp vin acum
// din sectiunile detectate de Suno, nu doar din ordine.
// ==========================================================================================

const MEMORY_VIDEO_WIDTH = 720;
const MEMORY_VIDEO_HEIGHT = 1280;
const MEMORY_VIDEO_FPS = 25;
const MEMORY_XFADE_SECONDS = 0.6; // tranzitie scurta — eleganta, fara sa incarce randarea

// Descarca toate elementele uploadedMedia ale comenzii din bucket-ul PRIVAT, in fisiere
// locale temporare. O eroare la orice element opreste tot pipeline-ul cinematic — apelantul
// (generateLyricVideo) trateaza asta ca semnal sa treaca pe fundalul solid.
async function downloadOrderMedia(order, items) {
  const localItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ext = path.extname(item.key) || (item.type === 'video' ? '.mp4' : '.jpg');
    const localPath = path.join(TEMP_DIR, `${order.id}-memory-src-${i}${ext}`);
    const signedUrl = await storage.getSignedDownloadUrl(item.key, 600);
    await downloadFile(signedUrl, localPath);
    localItems.push({ ...item, localPath });
  }
  return localItems;
}

// Randeaza UN element ca segment TACUT, durata fixa exacta, la rezolutia finala a
// videoclipului (720x1280). Pozele primesc un zoom lent si subtil (efect Ken Burns, de la
// 1.0x la 1.12x, centrat) — suficient de discret sa nu para agresiv pe o amintire.
// Videoclipurile sunt scalate/decupate la acelasi format si repetate in bucla (-stream_loop)
// daca sunt mai scurte decat durata alocata, ca sa umple exact intervalul.
async function renderMemorySegment(item, index, segDurationSeconds, order) {
  const outPath = path.join(TEMP_DIR, `${order.id}-memory-seg-${index}.mp4`);
  const frames = Math.max(1, Math.round(segDurationSeconds * MEMORY_VIDEO_FPS));

  if (item.type === 'photo') {
    // pre-scalare la 2x rezolutia finala (acelasi raport 9:16) — da zoompan-ului suficient
    // "spatiu" sa faca un zoom lent si neted, fara sa mareasca artificial o poza mica
    const zoomExpr = 'min(zoom+0.0012,1.12)';
    await execFfmpeg([
      '-y', '-loop', '1', '-i', item.localPath,
      '-t', String(segDurationSeconds),
      '-vf', `scale=${MEMORY_VIDEO_WIDTH * 2}:${MEMORY_VIDEO_HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${MEMORY_VIDEO_WIDTH * 2}:${MEMORY_VIDEO_HEIGHT * 2},zoompan=z='${zoomExpr}':d=${frames}:s=${MEMORY_VIDEO_WIDTH}x${MEMORY_VIDEO_HEIGHT}:fps=${MEMORY_VIDEO_FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-an',
      outPath
    ], { timeout: 180000 });
  } else {
    await execFfmpeg([
      '-y', '-stream_loop', '-1', '-i', item.localPath,
      '-t', String(segDurationSeconds),
      '-vf', `scale=${MEMORY_VIDEO_WIDTH}:${MEMORY_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${MEMORY_VIDEO_WIDTH}:${MEMORY_VIDEO_HEIGHT},fps=${MEMORY_VIDEO_FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-an',
      outPath
    ], { timeout: 180000 });
  }
  return outPath;
}

// Concateneaza segmentele tacute intr-un singur fundal, cu tranzitii crossfade (xfade) intre
// elemente consecutive. Fiecare segment e alocat exact (total + (N-1)*tranzitie) / N secunde
// (vezi buildMemoryBackground) — asta compenseaza suprapunerea introdusa de fiecare tranzitie,
// ca durata FINALA a fundalului sa fie exact egala cu durata melodiei, nu mai scurta.
async function concatWithCrossfades(segmentPaths, segDurations, order) {
  if (segmentPaths.length === 1) return segmentPaths[0];

  const outPath = path.join(TEMP_DIR, `${order.id}-memory-background.mp4`);
  const inputArgs = [];
  segmentPaths.forEach(p => inputArgs.push('-i', p));

  let filter = '';
  let lastLabel = '0:v';
  let cumulative = segDurations[0];
  for (let i = 1; i < segmentPaths.length; i++) {
    const offset = Math.max(0, cumulative - MEMORY_XFADE_SECONDS);
    const outLabel = i === segmentPaths.length - 1 ? 'vout' : `x${i}`;
    filter += `[${lastLabel}][${i}:v]xfade=transition=fade:duration=${MEMORY_XFADE_SECONDS}:offset=${offset.toFixed(3)}[${outLabel}];`;
    lastLabel = outLabel;
    cumulative += segDurations[i] - MEMORY_XFADE_SECONDS;
  }
  filter = filter.replace(/;$/, '');

  await execFfmpeg([
    '-y', ...inputArgs,
    '-filter_complex', filter,
    '-map', `[${lastLabel}]`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
    outPath
  ], { timeout: 900000 });

  return outPath;
}

// Construieste fundalul cinematic complet (tacut) pentru comanda — descarca elementele,
// randeaza fiecare segment, le concateneaza cu tranzitii. Curata singura toate fisierele
// intermediare proprii (sursele descarcate, segmentele) inainte sa iasa, indiferent de
// rezultat — doar fundalul final ramane (returnat apelantului, care il curata la randul lui).
async function buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings) {
  const ordered = sortMediaBySection(mediaItems);
  const cleanupPaths = [];
  try {
    const downloaded = await downloadOrderMedia(order, ordered);
    downloaded.forEach(d => cleanupPaths.push(d.localPath));

    const n = downloaded.length;
    // Faza 2 (implementata): daca exista sectiuni REALE (marcaje Suno, nu presupuneri),
    // plasam fiecare material CU eticheta de sectiune in fereastra reala corespunzatoare
    // (cerinta F12 — nu doar sortate global si impartite proportional cu marimea
    // ferestrelor) — vezi computeSectionAwareSegmentDurations(). FARA date reale
    // suficiente, revenim explicit la distributia egala, clar etichetata in log ca
    // fallback, niciodata prezentata drept aliniere reala pe sectiuni.
    let segDurations = computeSectionAwareSegmentDurations(downloaded, durationSeconds, sectionTimings, MEMORY_XFADE_SECONDS);
    const usedRealTiming = !!segDurations;
    if (!segDurations) {
      const equalDuration = (durationSeconds + (n - 1) * MEMORY_XFADE_SECONDS) / n;
      segDurations = new Array(n).fill(equalDuration);
    }
    perfLog(order.id, 'memory_segment_timing', usedRealTiming ? 'sursa=sectiuni_reale_suno' : 'sursa=distributie_egala_fallback');

    const segments = [];
    for (let i = 0; i < downloaded.length; i++) {
      const segPath = await renderMemorySegment(downloaded[i], i, segDurations[i], order);
      segments.push(segPath);
      cleanupPaths.push(segPath);
    }

    const backgroundPath = await concatWithCrossfades(segments, segDurations, order);
    // fundalul final nu trebuie sters aici daca a fost produs de concat (dar TREBUIE sters
    // daca era un singur segment, caz in care concatWithCrossfades a returnat direct
    // segmentul — deja in cleanupPaths, l-am scoate de acolo ca sa nu-l stergem prea devreme)
    const finalIndex = cleanupPaths.indexOf(backgroundPath);
    if (finalIndex !== -1) cleanupPaths.splice(finalIndex, 1);

    return { backgroundPath, cleanupPaths };
  } catch (err) {
    cleanupPaths.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best-effort */ } });
    throw err;
  }
}

async function generateLyricVideo(order, variant, tempFullMp3Path) {
  if (!variant.sunoTrackId || !order.musicTaskId) {
    throw new Error('Lipseste sunoTrackId sau musicTaskId — nu pot cere versurile cu marcaj de timp.');
  }

  const outcome = await fetchTimestampedLyricsOnce(order.musicTaskId, variant.sunoTrackId);
  if (!outcome.ok) {
    throw new Error(`Nu am putut obtine versurile cu marcaj de timp: ${outcome.reason}`);
  }
  const body = await outcome.res.json();
  if (!body || body.code !== 200 || !body.data || !Array.isArray(body.data.alignedWords) || body.data.alignedWords.length === 0) {
    throw new Error('Raspunsul cu versuri sincronizate e gol sau are o structura neasteptata.');
  }

  const captionLines = buildCaptionLines(body.data.alignedWords, order.recipient || '');
  if (captionLines.length === 0) {
    throw new Error('Nicio linie de caption construita din versurile sincronizate.');
  }

  const srtPath = path.join(TEMP_DIR, `${order.id}-${variant.id}-captions.srt`);
  fs.writeFileSync(srtPath, toSrt(captionLines), 'utf8');

  const durationSeconds = Math.max(1, Math.ceil(variant.durationSeconds || await getAudioDuration(tempFullMp3Path)));

  // TRUE SECTION TIMING ALIGNMENT — deriva sectiunile REALE (sau fallback controlat, clar
  // etichetat) din ACELASI raspuns alignedWords deja obtinut mai sus pentru caption-uri —
  // nicio cerere suplimentara catre Suno. Recalculat la FIECARE generare de videoclip, deci
  // o melodie editata/regenerata primeste automat propriile ei timestamp-uri noi (variant.id
  // diferit -> sunoTrackId diferit -> alignedWords diferit), niciodata pe cele vechi.
  const sectionTimings = deriveSectionTimings(body.data.alignedWords, durationSeconds, variant.id);
  perfLog(order.id, 'section_timing_derived', `varianta=${variant.id}, sectiuni=${sectionTimings.length}, sursa=${sectionTimings[0] ? sectionTimings[0].source : 'n/a'}`);
  const tempVideo = path.join(TEMP_DIR, `${order.id}-${variant.id}-video.mp4`);
  // subtitles= foloseste propria sintaxa cu ':' ca separator de optiuni — calea trebuie
  // sa foloseasca '/' (nu '\'), iar orice ':' din cale (litera de disc pe Windows, irelevant
  // pe Linux-ul de productie, dar sigur oricum) trebuie scapat explicit.
  const srtForFilter = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  let memoryBackground = null;
  try {
    const mediaItems = order.uploadedMedia || [];
    if (mediaItems.length > 0) {
      // CERINTA B4: pentru pachetul "video", clientul a incarcat materiale reale — un
      // videoclip cu fundal solid (fara pozele/filmarile lui) NU e un rezultat acceptabil
      // ca livrabil final, indiferent cat de robust ar parea tehnic. Daca pipeline-ul
      // cinematic esueaza, NU mai facem fallback silentios pe fundal solid — aruncam mai
      // departe, generateLyricVideo esueaza complet, iar generatePremiumExtras marcheaza
      // explicit videoStatus='failed' cu motiv, pastreaza melodia si permite retry doar
      // pentru video. Fundalul solid ramane folosit DOAR cand clientul chiar nu are
      // materiale incarcate (mediaItems.length === 0) — caz limita pentru comenzi vechi,
      // nu un fallback de eroare.
      memoryBackground = await buildMemoryBackground(order, mediaItems, durationSeconds, sectionTimings);
      perfLog(order.id, 'memory_background_ready', `elemente=${mediaItems.length}`);
    }

    // Verificat direct pe Railway (2026-08-03, comanda 59ae99f9, plata reala): libass,
    // subtitrarile si fonturile functioneaza corect pe containerul de productie — encodarea
    // CHIAR pornea si avansa (frame=45, fps~15) cand a fost omorata de limita de 180000ms.
    // CPU-ul containerului Railway e mult mai lent decat masina locala de test (unde acelasi
    // videoclip a durat ~40s) — la ~15fps reale, un videoclip de 4 minute la 25fps/1080x1920
    // are nevoie de 400+ secunde, nu 180. Solutie: rezolutie mai mica (720x1280 — mult mai
    // putini pixeli de encodat, tot suficient de buna pentru telefon/social), preset
    // "ultrafast" (semnificativ mai rapid decat "veryfast", cu compresie usor mai slaba —
    // acceptabil, viteza conteaza mai mult decat marimea fisierului aici), si un timeout
    // mult mai generos (10 minute) — sigur, ruleaza complet asincron, nu blocheaza nimic.
    const videoInputArgs = memoryBackground
      ? ['-i', memoryBackground.backgroundPath]
      : ['-f', 'lavfi', '-i', `color=c=${VIDEO_BG_COLOR}:s=${MEMORY_VIDEO_WIDTH}x${MEMORY_VIDEO_HEIGHT}:d=${durationSeconds}`];

    await execFfmpeg([
      '-y',
      ...videoInputArgs,
      '-i', tempFullMp3Path,
      '-vf', `subtitles='${srtForFilter}':force_style='${VIDEO_TEXT_STYLE}'`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      tempVideo
    ], { timeout: 600000 });
  } finally {
    try { fs.unlinkSync(srtPath); } catch (e) { /* best-effort */ }
    if (memoryBackground) {
      memoryBackground.cleanupPaths.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best-effort */ } });
      try { if (fs.existsSync(memoryBackground.backgroundPath)) fs.unlinkSync(memoryBackground.backgroundPath); } catch (e) { /* best-effort */ }
    }
  }

  const videoKey = `orders/full-video/${order.id}-${variant.id}.mp4`;
  await storage.uploadPrivateFile(tempVideo, videoKey, 'video/mp4');
  try { fs.unlinkSync(tempVideo); } catch (e) { /* best-effort */ }
  return { videoKey, sectionTimings };
}

// Citeste raspunsul unei cereri esuate ca text simplu, trunchiat, pentru loguri utile —
// NICIODATA nu include header-ele cererii (deci nici Authorization/MUSIC_API_KEY).
async function safeReadBody(res, maxLen = 500) {
  try {
    const text = await res.text();
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  } catch (e) {
    return '(nu am putut citi corpul raspunsului)';
  }
}

// Extrage piesele generate dintr-un raspuns Suno (polling SAU callback). Primeste
// payload-ul BRUT (raspunsul JSON complet, nedespachetat), pentru ca structura difera
// intre endpoint-ul de polling si webhook-ul de callback, si documentatia disponibila
// nu e perfect consistenta intre cele doua. Verificam explicit, in ordine, toate
// formele documentate:
//   payload.data.response.sunoData
//   payload.data.response.data
//   payload.data.data
//   payload.data                    (daca e deja array, direct)
//   payload.response.sunoData / payload.response.data   (daca payload e deja "data"-ul despachetat)
//   payload.sunoData                (fallback suplimentar)
// Accepta ambele denumiri de camp pentru URL audio: audioUrl (camelCase) sau audio_url (snake_case).
function extractSunoTracks(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const data = payload.data;

  const candidates = [
    data && data.response && data.response.sunoData,
    data && data.response && data.response.data,
    data && data.data,
    data,
    payload.response && payload.response.sunoData,
    payload.response && payload.response.data,
    payload.sunoData
  ];

  const rawTracks = candidates.find(c => Array.isArray(c)) || [];

  return rawTracks
    .map(t => ({
      id: t.id,
      audioUrl: t.audioUrl || t.audio_url,
      title: t.title,
      duration: t.duration,
      // VERSURI: sunoapi.org (customMode:false) NU primeste versuri exacte de la noi —
      // Suno le scrie singur, pornind de la promptul descriptiv (vezi buildPrompt()).
      // Raspunsul per-piesa contine de obicei textul generat efectiv in campul "prompt"
      // (asa functioneaza acest tip de wrapper Suno, dupa cunostintele disponibile la
      // momentul scrierii acestui cod) — NU am putut verifica acest camp cu un apel real,
      // pentru ca acest mediu nu are acces la retea (vezi README, aceeasi limitare
      // mentionata si la extractSunoTracks() in general). Verificam defensiv mai multe
      // nume de camp posibile; daca niciunul nu exista in raspuns, versurile raman null,
      // iar UI-ul din melodia-mea.html trateaza explicit acest caz (nu blocheaza pagina).
      lyrics: t.prompt || t.lyric || t.lyrics || null
    }))
    .filter(t => !!t.audioUrl);
}

// ==========================================================================================
// POST /api/v1/generate — creeaza task-ul, o singura data per runda (initiala sau editare).
// Salveaza taskId-ul pe comanda IMEDIAT, inainte de polling — ca /api/music/callback (care
// poate ajunge oricand, chiar in paralel cu polling-ul) sa poata identifica ce comanda
// corespunde raspunsului primit de la Suno.
// ==========================================================================================
async function callMusicProvider(orderId, prompt) {
  // validare explicita inainte de request — desi buildPrompt() deja arunca eroare pentru
  // un prompt gol, verificam din nou aici, la locul unde chiar pleaca cererea catre Suno
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt invalid sau gol — cererea catre SunoAPI nu a fost trimisa.');
  }

  // Model configurabil prin variabila de mediu MUSIC_MODEL — vezi .env.example pentru
  // valorile acceptate de furnizor (V4_5ALL, V4, V4_5, V4_5PLUS, V5). Daca variabila lipseste
  // sau e goala, ramanem pe V4_5ALL (modelul folosit dintotdeauna) — schimbarea modelului e
  // deci strict opt-in, niciodata automata. Verificat direct in documentatia oficiala
  // sunoapi.org: toate aceste modele accepta acelasi prompt de max. 500 caractere in
  // customMode:false, deci buildPrompt() nu are nevoie de nicio ajustare la schimbarea
  // modelului.
  const musicModel = (process.env.MUSIC_MODEL && process.env.MUSIC_MODEL.trim()) || 'V4_5ALL';

  const requestBody = {
    prompt,
    customMode: false,
    instrumental: false,
    model: musicModel,
    callBackUrl: `${DOMAIN}/api/music/callback`
  };

  const createRes = await fetchWithTimeout(`${process.env.MUSIC_API_BASE_URL}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MUSIC_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  }, 30000);

  if (!createRes.ok) {
    const bodyText = await safeReadBody(createRes);
    console.error(`SunoAPI /api/v1/generate a raspuns cu eroare HTTP ${createRes.status}. Corp raspuns: ${bodyText}`);
    throw new Error(`SunoAPI a raspuns cu status HTTP ${createRes.status} la crearea task-ului.`);
  }

  const createData = await createRes.json();
  if (createData.code !== 200) {
    console.error(`SunoAPI /api/v1/generate: cod ${createData.code}, mesaj furnizor: "${createData.msg || 'necunoscut'}"`);
    throw new Error(`SunoAPI: ${createData.msg || 'eroare necunoscuta la crearea task-ului'}`);
  }

  const taskId = createData.data && createData.data.taskId;
  if (!taskId) {
    console.error('SunoAPI /api/v1/generate: raspuns 200 dar fara data.taskId. Corp raspuns:', JSON.stringify(createData).slice(0, 500));
    throw new Error('Raspunsul SunoAPI nu contine data.taskId.');
  }

  await db.updateOrder(orderId, { musicTaskId: taskId });
  perfLog(orderId, 'suno_task_created', `taskId=${taskId.slice(0, 8)}, model=${musicModel}`);

  // Jurnalizarea consumului de credite se face AICI, imediat dupa ce Suno confirma crearea
  // task-ului — verificat direct (2026-08-02) ca exact in acest moment se debiteaza creditele
  // real (12 credite/apel, model V4_5ALL), indiferent daca task-ul reuseste sau esueaza ulterior.
  // Nu asteptam rezultatul final al generarii pentru a jurnaliza — pana atunci creditul e deja cheltuit.
  const balanceAfter = await credits.getBalance({ forceRefresh: true });
  db.logCreditEvent({
    orderId,
    eventType: 'generation_attempt',
    creditsSpent: credits.VERIFIED_CREDITS_PER_GENERATION,
    balanceAfter: balanceAfter.balance
  }).catch(err => console.error('[credits] Eroare la jurnalizarea consumului de credite:', err.message));
  credits.checkThresholdsAndAlert(db).catch(err => console.error('[credits] Eroare la verificarea pragurilor de alerta:', err.message));
  if (balanceAfter.balance !== null) {
    credits.checkFixedThresholdAlert(db, balanceAfter.balance).catch(err => console.error('[credits] Eroare la verificarea pragului fix de alerta:', err.message));
  }

  return taskId;
}

// ==========================================================================================
// GET /api/v1/generate/record-info?taskId=... — polling pana la un status final.
// SUCCESS = gata (extragem piesele). CREATE_TASK_FAILED / GENERATE_AUDIO_FAILED /
// CALLBACK_EXCEPTION / SENSITIVE_WORD_ERROR = eroare definitiva. PENDING / TEXT_SUCCESS /
// FIRST_SUCCESS = inca in lucru, continuam polling-ul.
//
// 90 incercari * 6 secunde = 540 secunde (~9 minute) — marit fata de cele 3 minute
// anterioare (30*6s), care s-au dovedit insuficiente pentru unele generari reale (Suno
// a acceptat si a lucrat la ele, dar nu a apucat sa raspunda inauntrul celor 3 minute).
//
// CALLBACK-UL E MECANISMUL PRINCIPAL — polling-ul e doar fallback/recuperare. La fiecare
// iteratie, INAINTE de a mai face un apel catre Suno, verificam daca comanda a fost deja
// finalizata (de catre callback, care poate ajunge oricand independent de aceasta bucla).
// Daca da, iesim IMEDIAT — nu mai asteptam restul buclei de 9 minute degeaba si nu mai
// facem apeluri HTTP inutile catre Suno.
//
// IMPORTANT: daca se epuizeaza toate incercarile FARA ca Suno sa fi raportat explicit
// SUCCESS sau o eroare, NU aruncam o exceptie — un timeout LOCAL de polling nu inseamna ca
// Suno a esuat, doar ca noi am renuntat sa mai asteptam sincron. Intoarcem un status distinct
// ('LOCAL_POLL_TIMEOUT'), pe care apelantul (runGeneration) il trateaza explicit ca "inca in
// lucru", nu ca eroare — statusul comenzii ramane 'generating', fara refund, fara sa stearga
// music_task_id. Callback-ul SunoAPI (configurat cu callBackUrl la crearea task-ului) poate
// finaliza comanda oricand mai tarziu, independent de aceasta bucla locala.
// ==========================================================================================
// maxAttempts implicit 150 * intervalMs 6s = 15 minute — marit fata de valoarea initiala
// (9 minute) dupa un test real Premium (doua genuri, generate in paralel) care a depasit
// 9 minute per sarcina fara nicio eroare Suno reala, doar generare mai lenta decat o
// singura sarcina. Fereastra locala e oricum doar un "cel mai probabil" — vezi
// waitForDualTaskAndFinalize/resumeDualTaskPolling pentru reluarea REALA cand nici 15
// minute nu sunt suficiente.
async function pollForResult(taskId, orderId, maxAttempts = 150, intervalMs = 6000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));

    // Callback-ul e calea principala — daca a ajuns deja si a finalizat comanda (succes
    // SAU esec), nu mai continuam polling-ul. Verificare ieftina (un SELECT), facuta
    // INAINTE de apelul HTTP catre Suno, ca sa evitam cereri inutile odata ce stim ca
    // exista deja un rezultat.
    if (orderId) {
      const current = await db.getOrderById(orderId).catch(() => null);
      if (current && ['preview_ready', 'ready', 'generation_failed'].includes(current.status)) {
        return { status: 'ALREADY_FINALIZED_BY_CALLBACK', tracks: [] };
      }
    }

    const res = await fetchWithTimeout(
      `${process.env.MUSIC_API_BASE_URL}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { 'Authorization': `Bearer ${process.env.MUSIC_API_KEY}` } },
      15000
    );

    if (!res.ok) {
      const bodyText = await safeReadBody(res);
      console.error(`SunoAPI record-info a raspuns cu eroare HTTP ${res.status} pentru taskId ${taskId}. Corp raspuns: ${bodyText}`);
      continue; // eroare tranzitorie — reincercam la urmatorul poll, nu abandonam imediat
    }

    const body = await res.json();
    if (body.code !== 200) {
      console.error(`SunoAPI record-info: cod ${body.code}, mesaj furnizor: "${body.msg || 'necunoscut'}" pentru taskId ${taskId}`);
      continue;
    }

    const statusName = body.data && body.data.status;

    if (statusName === SUNO_SUCCESS_STATUS) {
      const tracks = extractSunoTracks(body);
      return { status: statusName, tracks };
    }
    if (SUNO_ERROR_STATUSES.includes(statusName)) {
      console.error(`SunoAPI record-info: task ${taskId} a esuat cu status "${statusName}".`);
      return { status: statusName, tracks: [] };
    }
    if (!SUNO_CONTINUE_STATUSES.includes(statusName)) {
      console.warn(`SunoAPI record-info: status necunoscut "${statusName}" pentru taskId ${taskId} — continui polling-ul.`);
    }
    // Progres real din POLLING (nu doar din callback) — daca webhook-ul Suno intarzie sau nu
    // ajunge deloc, clientul tot vede procentul avansa pe baza starii reale raportate direct
    // de furnizor la fiecare verificare, niciodata pe baza unui timer.
    if (orderId && statusName === 'TEXT_SUCCESS') recordGenerationProgress(orderId, 'processing').catch(() => {});
    if (orderId && statusName === 'FIRST_SUCCESS') recordGenerationProgress(orderId, 'first_stream').catch(() => {});
    // PENDING / TEXT_SUCCESS / FIRST_SUCCESS (sau orice status necunoscut) -> continuam bucla
  }
  console.warn(`Polling local epuizat pentru taskId ${taskId} dupa ${maxAttempts} incercari — Suno nu a raportat inca un status final. Comanda ramane 'generating'; callback-ul sau o reluare ulterioara o pot finaliza.`);
  return { status: 'LOCAL_POLL_TIMEOUT', tracks: [] };
}

async function downloadFile(url, destPath) {
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok || !res.body) throw new Error('Nu am putut descărca fișierul audio complet');
  await pipeline(res.body, fs.createWriteStream(destPath));
}

// startSeconds (optional, implicit 0) — punctul de la care incepe taierea preview-ului.
// Cand e 0 (comportamentul dintotdeauna), NU adaugam deloc flag-ul -ss, ca sa pastram
// exact aceeasi comanda ffmpeg de dinainte. Fisierul COMPLET (tempFull, folosit pentru
// descarcarea platita) nu trece NICIODATA prin aceasta functie — doar preview-ul.
// HOTFIX 2026-08-07: previewurile ramaneau blocate la "--:--" — cauza REALA (gasita ulterior,
// 2026-08-08) a fost o bucla infinita de re-randare in JS (melodia-mea.html), nu formatul
// fisierului. Reincodarea (in loc de "-acodec copy") a ramas totusi, ca imbunatatire corecta
// independenta — elimina orice ambiguitate de aliniere la o granita de cadru MP3 la un punct
// de taiere arbitrar.
//
// HOTFIX 2026-08-08 (sunet "gajait"/distorsionat la inceputul preview-urilor): comparat direct
// fisierul complet (nemodificat, ~identic cu ce trimite furnizorul) cu preview-ul — sursa e
// curata (verificat: fara clipping, Peak level sub -1.9dB, Flat factor 0 chiar la tranzientul
// initial). Problema era in REINCODARE: (1) bitrate fix 128kbps, mai mic decat cele ~192kbps
// ale sursei — MP3 la bitrate redus se descurca cel mai prost exact pe TRANZIENTE bruste (un
// instrument/o voce care incepe brusc din liniste, exact cum incep majoritatea preview-urilor
// noastre) — fenomen cunoscut ("pre-echo"/artefacte de tip "sub apa") — nu clipping, deci nu
// aparea in verificarile de nivel; (2) reesantionare fortata la 44100Hz cand sursa Suno e la
// 48000Hz — un pas de procesare in plus, complet inutil (Safari nu are nicio problema reala cu
// 48kHz), eliminat. Solutie: VBR calitate maxima (-q:a 0, ~220-260kbps mediu — aloca mai multi
// biti exact pe tranziente, unde CBR redus esueaza) + pastram sample rate-ul nativ al sursei.
// Suplimentar (NU inlocuieste fixul de mai sus): un fade-in de 15ms — doar atat cat sa elimine
// un eventual "click" de esantion daca taietura (-ss) nu cade exact pe zero-crossing; 15ms e
// mult prea scurt ca sa masce vreo distorsiune reala, doar rotunjeste tranzitia bruta silence->sunet.
async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {
  const safeStart = Math.max(0, Number(startSeconds) || 0);
  const args = ['-y'];
  if (safeStart > 0) args.push('-ss', String(safeStart));
  args.push('-i', srcPath, '-t', String(seconds), '-af', 'afade=t=in:st=0:d=0.015', '-c:a', 'libmp3lame', '-q:a', '0', destPath);
  await execFfmpeg(args);
}

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]);
  return Math.round(parseFloat(stdout.trim()));
}

// SunoAPI, in customMode:false, accepta un SINGUR camp "prompt" — nu exista campuri
// separate pentru stil muzical si versuri. Combinam totul intr-un singur text descriptiv:
// stilul (tags), instructiunea explicita de limba, si povestea/ocazia/destinatarul.
//
// LIMITA SUNOAPI: cu customMode:false, campul "prompt" e limitat la 500 caractere.
// Prioritate la trunchiere (partea fixa nu se taie niciodata):
//   1. limba + stilul + ocazia + destinatarul — obligatorii, intacte
//   2. feedback-ul de editare (daca exista) — i se rezerva spatiu, dar limitat
//   3. povestea — umple spatiul ramas, prima taiata daca nu incape tot
// Taierea se face pe caractere Unicode complete (code points), nu pe unitati UTF-16,
// ca sa nu rupem niciodata un caracter multi-byte (emoji, litere in afara BMP) la mijloc.
const SUNO_PROMPT_MAX_LEN = 500;

// imparte corect pe caractere Unicode si taie fara sa rupa vreunul la mijloc
function truncateSafely(str, maxLen) {
  if (!str) return '';
  if (maxLen <= 0) return '';
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen).join('').trimEnd();
}

// Mapare ocazie -> descriere semantica scurta, in engleza (trimisa catre SunoAPI). Valorile
// interne (dor, onomastica, pentru-mine etc.) sunt identificatori tehnici din UI, fara niciun
// inteles pentru model daca sunt trimise ca atare — inlocuite aici cu o eticheta clara si
// deliberat compacta (fiecare caracter conteaza in bugetul de 500).
const OCCASION_LABELS = {
  dor: 'missing someone',
  onomastica: 'name day',
  aniversare: 'birthday',
  declaratie: 'declaration of love',
  nunta: 'wedding',
  pierdere: 'in loving memory',
  'pentru-mine': 'a song for oneself',
  altceva: 'a personal occasion'
};

// Instructiune de ATMOSFERA/TON pentru fiecare ocazie — separata de OCCASION_LABELS (care e
// doar eticheta scurta "Occasion: X."). Fara aceasta, ocazia era doar mentionata, nu si
// folosita ca directie reala pentru versuri (cerinta explicita). Valorile interne ale
// ocaziei (cheile acestui obiect) raman EXACT cele deja folosite in formular — nu s-a
// schimbat nimic in ce trimite clientul, doar cum foloseste server-ul aceasta valoare.
// Fiecare ocazie are o forma FULL (calitate mai buna) si una SHORT (folosita doar daca
// bugetul de 500 caractere e foarte stramtorat — vezi cascada de scurtare din buildPrompt).
const OCCASION_INSTRUCTIONS = {
  dor: {
    full: 'Convey deep longing for someone missed — evoke shared memories and quiet nostalgia throughout.',
    short: 'Deep longing and nostalgia.'
  },
  onomastica: {
    full: 'Warm, celebratory mood — express appreciation, wishes and joy for their special name day.',
    short: 'Warm, celebratory, joyful wishes.'
  },
  aniversare: {
    full: 'Personal, warm birthday mood — heartfelt wishes and real memories, not a generic birthday song.',
    short: 'Personal birthday warmth, heartfelt.'
  },
  declaratie: {
    full: 'Sincere romantic declaration — express love and gratitude, personal and direct, like a real confession.',
    short: 'Sincere romantic declaration.'
  },
  nunta: {
    full: 'Loving, joyful atmosphere of promise and togetherness for a wedding — solemn and moving, never sad.',
    short: 'Loving, joyful wedding mood.'
  },
  pierdere: {
    full: 'Gentle, respectful, deeply emotional remembrance — comfort and lasting love, never cheerful or upbeat.',
    short: 'Gentle, respectful remembrance.'
  },
  'pentru-mine': {
    full: 'Reflective, healing, personal tone — a message to oneself; let the story below guide the mood.',
    short: 'Reflective, healing, personal tone.'
  },
  altceva: {
    full: 'Infer the mood and atmosphere from the story below rather than assuming any specific occasion.',
    short: 'Infer the mood from the story.'
  }
};
// Fallback pentru comenzi vechi/valoare necunoscuta de ocazie (Partea 2, punctul 11) —
// neutru, nu blocheaza generarea, lasa povestea sa conduca tonul.
const OCCASION_INSTRUCTION_FALLBACK = {
  full: 'Let the story below guide the mood and atmosphere of the song.',
  short: 'Let the story guide the mood.'
};

// Lungimi maxime pentru campurile de personalizare — validate deja la creare (vezi POST
// /api/orders), dar re-aplicate defensiv aici si pentru comenzi mai vechi care ar putea
// avea valori mai lungi salvate sub reguli anterioare.
const RECIPIENT_MAX_LEN = 60;
const SENDER_MAX_LEN = 100;
const RELATIONSHIP_MAX_LEN = 60;

// Garantam intotdeauna cel putin acest spatiu pentru poveste — partea cea mai importanta
// pentru personalizare (Partea 4) nu trebuie sa poata fi eliminata complet de un nume,
// expeditor, relatie sau instructiune de ocazie/voce mai lunga, sau de instructiuni
// repetitive. 160 e limita inferioara a intervalului 160-180 cerut explicit — redusa de la
// 180 DOAR ca sa faca loc garantiei ca vocea aleasa explicit de client nu mai e eliminata
// niciodata complet din prompt (cerinta explicita).
const STORY_MIN_RESERVE = 160;

function buildPrompt(order, feedback, genreOverride) {
  // Rescris complet (2026-08-03, audit de calitate muzicala) — versiunea anterioara folosea
  // mai ales cuvinte de atmosfera/mood, care se suprapuneau prea mult intre genuri inrudite
  // (verificat direct: clientul a raportat ca "Manele de jale" si "Manele de suflet" sunau
  // aproape identic). Fiecare descriere de mai jos foloseste acum INSTRUMENTATIE si TEHNICA
  // VOCALA concrete (numele instrumentelor, tipul de scara/tonalitate, tehnica de ornamentare)
  // — semnale mult mai puternice pentru un model de generare muzicala bazat pe prompt text
  // decat adjective de atmosfera. Testat exhaustiv local impotriva logicii reale de trunchiere
  // din buildPrompt() (45 combinatii: toate cele 15 genuri x cele mai grele 3 ocazii x campuri
  // la lungime maxima x voce duet) — toate raman sub 500 caractere SI pastreaza intotdeauna
  // povestea clientului. "manele" ramane mapat pe identitatea "Manele de jale" (asa cum e deja
  // afisat clientului in comanda.html), distinct de "manele_suflet" ("Manele de suflet").
  //
  // LIMITARE CUNOSCUTA, de raportat explicit: nu putem verifica prin ascultare directa daca
  // Suno reda autentic un gen regional de nisa precum manele — modelul poate avea date de
  // antrenament mult mai limitate pentru manele decat pentru pop/rock/hip-hop mainstream.
  // Aceasta rescriere imbunatateste semnificativ SPECIFICITATEA promptului trimis catre model
  // (verificat: genul selectat chiar ajunge, corect si complet, in promptul final), dar nu
  // poate garanta autenticitate muzicala perfecta daca modelul insusi nu are capacitatea sa
  // o produca — o limitare a providerului, nu a codului.
  const genreMap = {
    emotional: 'cinematic orchestral ballad, swelling strings and piano, rubato build, breathy vulnerable vocal, tearful climax',
    suflet: 'intimate de suflet ballad, sparse guitar or piano, close warm vocal, quiet confessional unpolished mood',
    pop: 'commercial pop, 100-120bpm, verse-chorus-bridge, synth hook, polished vocal, radio-ready energy',
    acustic: 'unplugged acoustic folk, fingerpicked guitar, light percussion, natural room sound, plain sincere vocal',
    petrecere: 'fast Romanian party beat, 130+bpm, syncopated dance rhythm, horns and synth stabs, shouted chorus, club energy',
    balada: 'slow rubato piano ballad, sustained strings, no beat, dramatic dynamic swells, powerful sustained vocal',
    manele: 'Romanian manele de jale, oriental scale, mournful clarinet, melismatic vocal slides, minor key grief',
    copii: 'cheerful childrens song, simple major-key melody, glockenspiel and ukulele, bouncy rhythm, bright vocal',
    populara: 'Romanian muzica populara, taraf violin and accordion, rustic dance rhythm, unornamented vocal, no autotune',
    rock: 'driving rock, distorted electric guitar riff, live drums, powerful chest-voice vocal, big anthemic chorus',
    colind: 'traditional Romanian carol, sleigh bells and choir, warm acoustic guitar, gentle festive reverent vocal',
    modern: 'sleek modern pop-electronic, deep 808 sub bass, glossy synth pads, vocal chops, minimalist premium production',
    hiphop: 'modern hip-hop, punchy 808 kick, hi-hat rolls, rap-sung flow, ad-libs, no ballad melody',
    manele_suflet: 'Romanian manele de suflet, oriental scale, romantic clarinet, warm melismatic vocal, devoted love build',
    motivational: 'inspirational anthem, driving toms, major-key triumphant chords, confident vocal, uplifting final chorus'
  };

  const languageNames = {
    ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish',
    it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish'
  };
  const lyricsLanguage = languageNames[order.lang] || 'Romanian';
  // genreOverride: folosit pentru a doua cerere Suno (Premium/Video, al doilea gen ales de
  // client) — restul promptului (poveste, destinatar, ocazie, voce) ramane IDENTIC intre
  // cele doua cereri; DOAR stilul muzical difera, ca ambele melodii sa fie despre aceeasi
  // poveste reala, in doua interpretari muzicale reale, distincte.
  const styleTags = genreMap[genreOverride || order.genre] || 'pop, warm vocals';
  const occasionLabel = OCCASION_LABELS[order.occasion] || order.occasion;

  // Instructiunea de atmosfera/ton pentru ocazia aleasa — comenzi vechi sau o valoare
  // necunoscuta de ocazie NU blocheaza generarea (Partea 2, punctul 11): folosim fallback-ul
  // neutru, bazat pe poveste.
  const occasionInstructionSet = OCCASION_INSTRUCTIONS[order.occasion] || OCCASION_INSTRUCTION_FALLBACK;
  let useShortOccasionInstruction = false;
  let includeOccasionInstruction = true;
  function currentOccasionInstruction() {
    if (!includeOccasionInstruction) return '';
    return ' ' + (useShortOccasionInstruction ? occasionInstructionSet.short : occasionInstructionSet.full);
  }

  // Comenzile vechi (dinainte de sender/relationship) nu au aceste campuri — tratate optional.
  const hasSender = typeof order.senderName === 'string' && order.senderName.trim().length > 0;
  const hasRelationship = hasSender && typeof order.relationship === 'string' && order.relationship.trim().length > 0;

  // Trunchiere defensiva — chiar daca validarea la creare limiteaza deja lungimea, aplicam
  // din nou aici, sigur, pe caractere Unicode complete.
  let recipient = truncateSafely(String(order.recipient || '').trim(), RECIPIENT_MAX_LEN);
  let sender = hasSender ? truncateSafely(order.senderName.trim(), SENDER_MAX_LEN) : '';
  let relationship = hasRelationship ? truncateSafely(order.relationship.trim(), RELATIONSHIP_MAX_LEN) : '';

  // Instructiunea de voce e SEPARATA de personalizare (nume, relatie, poveste) — o propozitie
  // proprie, scurta, niciodata amestecata in aceeasi fraza cu destinatarul/expeditorul/relatia.
  // 'auto' inseamna explicit "nicio instructiune" — lasam serviciul sa aleaga liber.
  //
  // IMPORTANT (corectie explicita): daca clientul a ALES explicit o voce (female/male/duet),
  // instructiunea de voce NU se elimina NICIODATA complet din prompt, indiferent cat de
  // stramtorat e bugetul — se poate doar COMPRIMA la forma scurta (VOICE_INSTRUCTIONS_SHORT).
  // Anterior, pasul `includeVoiceInstruction = false` din cascada de scurtare putea elimina
  // complet alegerea clientului — asta nu mai e permis.
  const VOICE_INSTRUCTIONS_FULL = {
    female: ' Use a female lead vocal.',
    male: ' Use a male lead vocal.',
    duet: ' Use a male and female duet, with both voices clearly present.',
    auto: ''
  };
  const VOICE_INSTRUCTIONS_SHORT = {
    female: ' Female vocal.',
    male: ' Male vocal.',
    duet: ' Male-female duet.',
    auto: ''
  };
  const requestedVoicePref = VOICE_PREFERENCES.includes(order.voicePreference) ? order.voicePreference : 'auto';
  let useShortVoiceInstruction = false;
  function currentVoiceInstruction() {
    if (requestedVoicePref === 'auto') return '';
    return useShortVoiceInstruction ? VOICE_INSTRUCTIONS_SHORT[requestedVoicePref] : VOICE_INSTRUCTIONS_FULL[requestedVoicePref];
  }

  // Doua variante de instructiune: completa (calitate mai buna a personalizarii) si una
  // scurta, folosita DOAR daca partea fixa tot nu incape in buget dupa scurtarea campurilor
  // — evita ca instructiunile repetitive sa manance tot spatiul (cerinta explicita), fara sa
  // renunte la cele doua cerinte esentiale: numele destinatarului de 2 ori, expeditorul o data.
  // Instructiune permanenta (Partea noua, ceruta explicit): intro instrumental foarte scurt,
  // vocea sa intre aproape imediat — integrata DIRECT in instructiunile de personalizare deja
  // existente (nu adaugata separat, ca sa nu duplicam si sa nu umflam bugetul de 500 caractere
  // mai mult decat strict necesar). Se aplica identic la generarea initiala SI la regenerari,
  // pentru ca ambele folosesc aceeasi functie buildPrompt() -> currentInstruction() de mai jos.
  const instructionWithSenderFull = ' Write this as a personal song from the sender to the recipient. Use a short natural instrumental intro. Start the vocals around 8-10 seconds, never immediately and never after a long instrumental opening. Name the recipient early and again in the chorus. Mention the sender once. Use only real details from the story — invent nothing.';
  const instructionWithSenderShort = ' Short natural intro; start vocals around 8-10 seconds; name the recipient early and again in the chorus; mention the sender once. Use real story details only.';
  const instructionNoSenderFull = ' Use a short natural instrumental intro. Start the vocals around 8-10 seconds, never immediately and never after a long instrumental opening. Address the recipient by name naturally in the lyrics. Use only real details from the story — invent nothing.';
  const instructionNoSenderShort = ' Short natural intro; start vocals around 8-10 seconds. Address the recipient by name naturally. Use real story details only.';

  let useShortInstruction = false;
  function currentInstruction() {
    if (hasSender) return useShortInstruction ? instructionWithSenderShort : instructionWithSenderFull;
    return useShortInstruction ? instructionNoSenderShort : instructionNoSenderFull;
  }

  // Structura NEUTRA, tip "eticheta: valoare" — nu mai construim propozitii posesive in
  // engleza (ex. "Andrei's sotie") care amestecau gramatica engleza cu textul relatiei
  // introdus de client, uneori intr-o alta limba. O lista de etichete e neutra fata de
  // limba textului din campurile recipient/sender/relationship. Instructiunea de voce
  // vine ULTIMA, dupa personalizare — separata clar, propria ei propozitie.
  function buildFixedPart(rec, snd, rel) {
    let lines = `Recipient: ${rec}.`;
    // IMPORTANT: verificam valoarea CURENTA (snd/rel, care pot fi golite de cascada de
    // scurtare de mai jos), nu flag-urile fixe hasSender/hasRelationship calculate o
    // singura data la inceput — altfel, o relatie golita explicit tot ar aparea ca
    // "Relationship: ." (segment gol, in loc sa fie omis complet, irosind spatiu).
    if (hasSender && snd) lines += ` Sender: ${snd}.`;
    if (hasRelationship && rel) lines += ` Relationship: ${rel}.`;
    return `${styleTags}. Write the song lyrics entirely in ${lyricsLanguage}. Occasion: ${occasionLabel}.${currentOccasionInstruction()} ${lines}${currentInstruction()}${currentVoiceInstruction()}`;
  }

  let head = buildFixedPart(recipient, sender, relationship);

  // Daca partea fixa tot nu lasa spatiul minim garantat pentru poveste (campuri foarte lungi
  // combinate cu un gen muzical/ocazie cu descriere mai lunga), scurtam progresiv, IN ACEASTA
  // ORDINE EXPLICITA (corectie fata de versiunea anterioara):
  //   1. instructiunea de ocazie -> forma scurta;
  //   2. instructiunea de personalizare/intro -> forma scurta;
  //   3. instructiunea de voce -> forma scurta (NICIODATA eliminata complet daca s-a ales
  //      explicit o voce — vezi comentariul de la VOICE_INSTRUCTIONS_SHORT mai sus);
  //   4. relatia, apoi expeditorul, apoi destinatarul — scurtate progresiv, NICIODATA
  //      eliminate complet.
  // Povestea insasi nu e scurtata aici — bugetul ei se calculeaza separat mai jos, cu o
  // rezerva minima garantata (STORY_MIN_RESERVE, 160-180 caractere utile).
  const budgetForFixedPart = SUNO_PROMPT_MAX_LEN - STORY_MIN_RESERVE;
  const shrinkSteps = [
    () => { useShortOccasionInstruction = true; },
    () => { useShortInstruction = true; },
    () => { useShortVoiceInstruction = true; },
    () => { relationship = truncateSafely(relationship, 20); },
    () => { sender = truncateSafely(sender, 30); },
    () => { recipient = truncateSafely(recipient, 30); },
    () => { relationship = truncateSafely(relationship, 10); },
    () => { sender = truncateSafely(sender, 15); },
    () => { recipient = truncateSafely(recipient, 15); },
    () => { sender = truncateSafely(sender, 8); },
    () => { recipient = truncateSafely(recipient, 10); }
  ];
  for (const step of shrinkSteps) {
    if (head.length <= budgetForFixedPart) break;
    step();
    head = buildFixedPart(recipient, sender, relationship);
  }
  // In cazuri extreme (foarte rare — necesita simultan campuri la lungime maxima SI cel mai
  // lung gen muzical SI cea mai lunga ocazie), pasii de mai sus pot sa nu ajunga exact la
  // budgetForFixedPart — dar il aduc suficient de aproape incat povestea tot primeste in
  // jur de 180+ caractere (calculat mai jos din spatiul chiar ramas, nu presupus).

  const storyLabel = ' Story/details to include: ';
  const feedbackLabel = ' Client-requested adjustment: ';
  const feedbackText = feedback ? String(feedback).trim() : '';

  let remaining = SUNO_PROMPT_MAX_LEN - head.length;
  if (remaining < 0) remaining = 0;

  // Feedback-ul (editari cerute de client, inclusiv versuri editate manual — vezi
  // /api/orders/:id/regenerate) poate consuma DOAR spatiul care depaseste rezerva minima
  // garantata pentru poveste — niciodata rezerva insasi. Povestea are prioritate mai mare
  // decat orice formulare repetitiva (cerinta explicita).
  let feedbackFull = '';
  if (feedbackText) {
    const extraSpace = Math.max(0, remaining - STORY_MIN_RESERVE);
    const feedbackBudget = Math.max(0, Math.floor(extraSpace * 0.6) - feedbackLabel.length);
    const feedbackTrimmed = truncateSafely(feedbackText, feedbackBudget);
    if (feedbackTrimmed) {
      feedbackFull = `${feedbackLabel}${feedbackTrimmed}`;
      remaining -= feedbackFull.length;
    }
  }
  if (remaining < 0) remaining = 0;

  // povestea umple spatiul ramas (cel putin STORY_MIN_RESERVE, cu exceptia cazului extrem
  // in care head-ul singur ar depasi deja limita totala — practic imposibil dupa scurtarile
  // de mai sus, dar tratat sigur oricum)
  let storyFull = '';
  const storyBudget = remaining - storyLabel.length;
  if (storyBudget > 0) {
    const storyTrimmed = truncateSafely(order.story, storyBudget);
    if (storyTrimmed) {
      storyFull = `${storyLabel}${storyTrimmed}`;
    }
  }

  let prompt = `${head}${storyFull}${feedbackFull}`;

  // plasa de siguranta — in teorie nu ar trebui sa se intample, dat fiind bugetul calculat mai sus,
  // dar nu trimitem niciodata catre Suno un prompt mai lung decat limita documentata
  if (prompt.length > SUNO_PROMPT_MAX_LEN) {
    prompt = truncateSafely(prompt, SUNO_PROMPT_MAX_LEN);
  }

  if (!prompt || !prompt.trim()) {
    throw new Error('Promptul construit pentru SunoAPI este gol — comanda nu are date suficiente pentru generare');
  }

  return prompt;
}

// ==========================================================================================
// EMAIL DE LIVRARE — Resend. Link cu access token, nu doar "cauta cu emailul tau".
// ==========================================================================================
// Escape HTML-uri simplu, pentru text interpolat in corpul HTML al emailurilor de livrare —
// order.recipient e text liber introdus de client (nu are alt fel de validare/enum care sa-l
// restrictioneze), deci trebuie tratat ca neincrezator oriunde ajunge in HTML randat. NU se
// aplica pe subject (subiectul emailului e text simplu, nu HTML — escaparea acolo ar afisa
// gresit caractere ca &amp; direct in subiect, in loc sa previna ceva).
function escapeHtmlForEmail(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendDeliveryEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY lipsa din .env — email de livrare NU a fost trimis.');
    return;
  }

  const downloadUrl = `${DOMAIN}/media/full/${order.id}?token=${order.accessToken}`;
  const accessUrl = `${DOMAIN}/comanda-mea.html?token=${order.accessToken}`;
  const safeRecipient = escapeHtmlForEmail(order.recipient);

  // "Melodia cadou" (cealalta varianta, nealeasa ca principala) — livrata la TOATE cele trei
  // pachete, nu doar Premium/Video (vezi getGiftVariant si /media/full/:orderId/gift). Ambele
  // fullKey (principal + cadou) exista deja din momentul preview_ready (inainte de plata) —
  // singurul caz in care lipseste e o procesare partial esuata (foarte rar), tratat simplu
  // prin omiterea liniei, niciodata printr-un link catre un fisier inexistent.
  const giftVariant = getGiftVariant(order);
  const hasGift = !!(giftVariant && giftVariant.fullKey);
  const giftUrl = `${DOMAIN}/media/full/${order.id}/gift?token=${order.accessToken}`;
  const GIFT_LINE = {
    ro: `<p>🎵 <a href="${giftUrl}">Descarcă și a doua melodie completă</a>.</p>`,
    en: `<p>🎵 <a href="${giftUrl}">Download your second complete song too</a>.</p>`,
    de: `<p>🎵 <a href="${giftUrl}">Lade auch dein zweites vollständiges Lied herunter</a>.</p>`,
    es: `<p>🎵 <a href="${giftUrl}">Descarga también tu segunda canción completa</a>.</p>`,
    it: `<p>🎵 <a href="${giftUrl}">Scarica anche la tua seconda canzone completa</a>.</p>`,
    fr: `<p>🎵 <a href="${giftUrl}">Téléchargez aussi votre deuxième chanson complète</a>.</p>`,
    bg: `<p>🎵 <a href="${giftUrl}">Изтегли и втората си пълна песен</a>.</p>`,
    tr: `<p>🎵 <a href="${giftUrl}">İkinci tam şarkınızı da indirin</a>.</p>`
  };
  const giftLine = hasGift ? (GIFT_LINE[order.lang] || GIFT_LINE.ro) : '';

  // Videoclipul (pachetul "video") e DEJA gata in acest moment — relansarea 2026-08-06 muta
  // randarea lui INAINTE de plata (checkout-ul refuza plata daca nu e gata, vezi
  // processConfirmedPayment) — deci, spre deosebire de WAV (generat asincron DUPA plata),
  // link-ul securizat catre videoclipul final poate fi trimis direct in acest email, nu doar
  // promis "in cateva minute".
  const videoVariantForEmail = order.plan === 'video'
    ? (order.variants || []).find(v => v.id === order.selectedVariantId)
    : null;
  const hasVideoForEmail = !!(videoVariantForEmail && videoVariantForEmail.videoKey);
  const videoUrlForEmail = `${DOMAIN}/media/video/${order.id}?token=${order.accessToken}`;
  const VIDEO_LINE = {
    ro: `<p>🎬 <a href="${videoUrlForEmail}">Descarcă videoclipul final</a>.</p>`,
    en: `<p>🎬 <a href="${videoUrlForEmail}">Download the final video</a>.</p>`,
    de: `<p>🎬 <a href="${videoUrlForEmail}">Lade das fertige Video herunter</a>.</p>`,
    es: `<p>🎬 <a href="${videoUrlForEmail}">Descarga el video final</a>.</p>`,
    it: `<p>🎬 <a href="${videoUrlForEmail}">Scarica il video finale</a>.</p>`,
    fr: `<p>🎬 <a href="${videoUrlForEmail}">Téléchargez la vidéo finale</a>.</p>`,
    bg: `<p>🎬 <a href="${videoUrlForEmail}">Изтегли финалното видео</a>.</p>`,
    tr: `<p>🎬 <a href="${videoUrlForEmail}">Son videoyu indirin</a>.</p>`
  };
  const videoLine = hasVideoForEmail ? (VIDEO_LINE[order.lang] || VIDEO_LINE.ro) : '';

  // Nota despre WAV (premium/video) — generat ASINCRON dupa acest email (poate dura pana la
  // cateva minute, vezi generatePremiumExtras), deci NU il promitem ca fiind deja disponibil
  // in acest moment, doar ca va aparea la pagina comenzii. "standard" nu are nicio nota
  // suplimentara. Termenul tehnic "WAV" apare NUMAI dupa o explicatie in limbaj simplu
  // (aceeasi regula ca pe cardul de pachet Premium din comanda.html) — niciodata neexplicat,
  // izolat. Videoclipul (plan "video") NU mai apare aici — e livrat direct prin videoLine.
  const EXTRAS_NOTE = {
    premium: {
      ro: ` Vei primi și fișierul audio la calitate înaltă (WAV) — păstrează mai bine claritatea sunetului, potrivit pentru păstrare sau editare. Apare în câteva minute la <a href="${accessUrl}">pagina comenzii tale</a>.`,
      en: ` You'll also get the high-quality audio file (WAV) — it keeps the sound clearer and is better for keeping or editing. It'll appear within a few minutes at <a href="${accessUrl}">your order page</a>.`,
      de: ` Du erhältst außerdem die hochwertige Audiodatei (WAV) — sie klingt klarer und eignet sich besser zum Aufbewahren oder Bearbeiten. Sie erscheint in wenigen Minuten auf <a href="${accessUrl}">deiner Bestellseite</a>.`,
      es: ` También recibirás el archivo de audio de alta calidad (WAV) — conserva mejor la claridad del sonido y es adecuado para guardar o editar. Aparecerá en unos minutos en <a href="${accessUrl}">la página de tu pedido</a>.`,
      it: ` Riceverai anche il file audio ad alta qualità (WAV) — mantiene il suono più chiaro ed è adatto per conservare o modificare. Apparirà tra qualche minuto nella <a href="${accessUrl}">pagina del tuo ordine</a>.`,
      fr: ` Vous recevrez aussi le fichier audio haute qualité (WAV) — un son plus clair, adapté pour la conservation ou le montage. Il apparaîtra dans quelques minutes sur <a href="${accessUrl}">la page de votre commande</a>.`,
      bg: ` Ще получиш и аудио файла с високо качество (WAV) — запазва по-добре яснотата на звука, подходящ за съхранение или редактиране. Ще се появи след няколко минути на <a href="${accessUrl}">страницата на поръчката ти</a>.`,
      tr: ` Ayrıca yüksek kaliteli ses dosyasını da (WAV) alacaksınız — sesi daha net tutar, saklamak veya düzenlemek için uygundur. Birkaç dakika içinde <a href="${accessUrl}">sipariş sayfanızda</a> görünecek.`
    },
    video: {
      ro: ` Vei primi și fișierul audio la calitate înaltă (WAV) pentru varianta principală. Apare în câteva minute la <a href="${accessUrl}">pagina comenzii tale</a>.`,
      en: ` You'll also get the high-quality audio file (WAV) for the main version. It'll appear within a few minutes at <a href="${accessUrl}">your order page</a>.`,
      de: ` Du erhältst außerdem die hochwertige Audiodatei (WAV) für die Hauptversion. Sie erscheint in wenigen Minuten auf <a href="${accessUrl}">deiner Bestellseite</a>.`,
      es: ` También recibirás el archivo de audio de alta calidad (WAV) de la versión principal. Aparecerá en unos minutos en <a href="${accessUrl}">la página de tu pedido</a>.`,
      it: ` Riceverai anche il file audio ad alta qualità (WAV) della versione principale. Apparirà tra qualche minuto nella <a href="${accessUrl}">pagina del tuo ordine</a>.`,
      fr: ` Vous recevrez aussi le fichier audio haute qualité (WAV) de la version principale. Il apparaîtra dans quelques minutes sur <a href="${accessUrl}">la page de votre commande</a>.`,
      bg: ` Ще получиш и аудио файла с високо качество (WAV) на основната версия. Ще се появи след няколко минути на <a href="${accessUrl}">страницата на поръчката ти</a>.`,
      tr: ` Ayrıca ana versiyon için yüksek kaliteli ses dosyasını da (WAV) alacaksınız. Birkaç dakika içinde <a href="${accessUrl}">sipariş sayfanızda</a> görünecek.`
    }
  };
  const extrasNote = (EXTRAS_NOTE[order.plan] && EXTRAS_NOTE[order.plan][order.lang]) || '';

  const templates = {
    ro: { subject: `Cântecul tău pentru ${order.recipient} e gata`,
      html: `<p>Salut,</p><p>Cântecul tău personalizat pentru <strong>${safeRecipient}</strong> e gata.</p><p><a href="${downloadUrl}">Descarcă melodia</a></p>${giftLine}${videoLine}<p>Le poți regăsi oricând la <a href="${accessUrl}">acest link</a>.${extrasNote}</p><p>— NALUNA</p>` },
    en: { subject: `Your song for ${order.recipient} is ready`,
      html: `<p>Hi,</p><p>Your personalised song for <strong>${safeRecipient}</strong> is ready.</p><p><a href="${downloadUrl}">Download your song</a></p>${giftLine}${videoLine}<p>You can find them anytime at <a href="${accessUrl}">this link</a>.${extrasNote}</p><p>— NALUNA</p>` },
    de: { subject: `Dein Lied für ${order.recipient} ist fertig`,
      html: `<p>Hallo,</p><p>Dein persönliches Lied für <strong>${safeRecipient}</strong> ist fertig.</p><p><a href="${downloadUrl}">Lied herunterladen</a></p>${giftLine}${videoLine}<p>Du findest sie jederzeit über <a href="${accessUrl}">diesen Link</a>.${extrasNote}</p><p>— NALUNA</p>` },
    es: { subject: `Tu canción para ${order.recipient} está lista`,
      html: `<p>Hola,</p><p>Tu canción personalizada para <strong>${safeRecipient}</strong> está lista.</p><p><a href="${downloadUrl}">Descargar la canción</a></p>${giftLine}${videoLine}<p>Puedes encontrarlas siempre en <a href="${accessUrl}">este enlace</a>.${extrasNote}</p><p>— NALUNA</p>` },
    it: { subject: `La tua canzone per ${order.recipient} è pronta`,
      html: `<p>Ciao,</p><p>La tua canzone personalizzata per <strong>${safeRecipient}</strong> è pronta.</p><p><a href="${downloadUrl}">Scarica la canzone</a></p>${giftLine}${videoLine}<p>Puoi trovarle sempre su <a href="${accessUrl}">questo link</a>.${extrasNote}</p><p>— NALUNA</p>` },
    fr: { subject: `Votre chanson pour ${order.recipient} est prête`,
      html: `<p>Bonjour,</p><p>Votre chanson personnalisée pour <strong>${safeRecipient}</strong> est prête.</p><p><a href="${downloadUrl}">Télécharger la chanson</a></p>${giftLine}${videoLine}<p>Vous pouvez les retrouver à tout moment via <a href="${accessUrl}">ce lien</a>.${extrasNote}</p><p>— NALUNA</p>` },
    bg: { subject: `Твоята песен за ${order.recipient} е готова`,
      html: `<p>Здравей,</p><p>Твоята персонализирана песен за <strong>${safeRecipient}</strong> е готова.</p><p><a href="${downloadUrl}">Изтегли песента</a></p>${giftLine}${videoLine}<p>Можеш да ги намериш винаги на <a href="${accessUrl}">този линк</a>.${extrasNote}</p><p>— NALUNA</p>` },
    tr: { subject: `${order.recipient} için şarkınız hazır`,
      html: `<p>Merhaba,</p><p><strong>${safeRecipient}</strong> için kişiselleştirilmiş şarkınız hazır.</p><p><a href="${downloadUrl}">Şarkınızı indirin</a></p>${giftLine}${videoLine}<p><a href="${accessUrl}">Bu bağlantıdan</a> her zaman ulaşabilirsiniz.${extrasNote}</p><p>— NALUNA</p>` }
  };

  const template = templates[order.lang] || templates.ro;

  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: order.email, subject: template.subject, html: template.html
    })
  }, 15000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend a raspuns cu status ${res.status}: ${body}`);
  }
}

// -------- 404 pentru orice ruta necunoscuta (dupa fisierele statice si toate rutele API) --------
app.use((req, res) => {
  res.status(404).json({ error: 'Rută inexistentă.' });
});

// -------- error handler central — nicio eroare nescapata nu trebuie sa opreasca serverul --------
app.use((err, req, res, next) => {
  console.error('Eroare necapturata pe o cerere:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'A apărut o eroare neașteptată. Încearcă din nou' });
});

// -------- siguranta la nivel de proces: loga, nu lasa serverul intr-o stare nedefinita --------
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, serverul se opreste pentru un restart curat:', err);
  process.exit(1); // Railway reporneste automat procesul
});

// -------- verificare FFmpeg la pornire — STRICT informativa, nu opreste serverul indiferent
// de rezultat. Utila ca sa vezi imediat in log-urile Railway daca binarul e gasit pe PATH,
// fara sa astepti prima comanda reala ca sa afli. --------
async function checkFfmpegAvailability() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    console.log('FFmpeg disponibil');
  } catch (err) {
    console.error('FFmpeg indisponibil —', err.message);
  }
}

// Aceeasi verificare, pentru exiftool (hotfix 2026-08-07, suport DNG/Apple ProRAW) — vezi
// extractDngPreviewToJpeg. Fara aceasta, o eroare "binar negasit" la extragere ar fi rezultat
// doar in respingerea tacuta a fiecarui DNG in parte, fara niciun indiciu in loguri DE CE.
async function checkExiftoolAvailability() {
  try {
    const { stdout } = await execFileAsync('exiftool', ['-ver']);
    console.log('exiftool disponibil, versiune', stdout.trim());
  } catch (err) {
    console.error('exiftool indisponibil — suportul DNG/Apple ProRAW nu va functiona:', err.message);
  }
}

// Aceeasi verificare, pentru heif-convert (hotfix 2026-08-08, suport real HEIC/HEIF) — vezi
// extractHeicToJpeg. heif-convert nu are un flag simplu de versiune confirmat — apelat fara
// argumente iese oricum cu cod diferit de zero (lipsesc fisierele de intrare/iesire), dar asta
// confirma ca binarul CHIAR EXISTA si porneste; doar ENOENT inseamna ca lipseste cu adevarat.
async function checkHeifConvertAvailability() {
  try {
    await execFileAsync('heif-convert', []);
    console.log('heif-convert disponibil');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('heif-convert indisponibil — suportul HEIC/HEIF nu va functiona:', err.message);
    } else {
      console.log('heif-convert disponibil (a raspuns cu cod de iesire diferit de zero fara argumente, asteptat)');
    }
  }
}

// -------- pornire: verificam intai conexiunea la baza de date --------
db.initDb()
  .then(() => {
    checkFfmpegAvailability(); // fire-and-forget — nu blocheaza si nu conditioneaza pornirea
    checkExiftoolAvailability(); // fire-and-forget, acelasi motiv
    checkHeifConvertAvailability(); // fire-and-forget, acelasi motiv
    app.listen(PORT, () => {
      console.log(`NALUNA ruleaza pe ${DOMAIN}`);
    });
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la PostgreSQL la pornire:', err.message);
    process.exit(1);
  });
