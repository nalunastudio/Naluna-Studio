// server.js
// NALUNA — backend, versiune pregatita pentru productie
//
// Flux:
// 1. Clientul completeaza formularul si apasa "Genereaza previzualizarea" (GRATUIT).
// 2. POST /api/orders creeaza comanda in PostgreSQL (validare stricta, pret calculat
//    server-side dupa pachet — pretul trimis de client NU e niciodata folosit direct).
// 3. POST /api/orders/:id/generate trimite UN SINGUR apel catre SunoAPI, care returneaza
//    de obicei 2 piese per task — folosite ca cele 2 variante. Pentru fiecare, descarca
//    fisierul complet (privat), taie un preview de 55 sec cu ffmpeg, citeste durata reala.
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
const db = require('./db');
const storage = require('./storage');

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
app.set('trust proxy', 1); // Railway sta in spatele unui proxy — necesar ca rate limiting sa vada IP-ul real

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN;
const PREVIEW_SECONDS = 35;
const FREE_EDITS = 2; // prima melodie generata NU consuma nicio editare (vezi /generate, care
                       // nu atinge editsUsed) — clientul are apoi exact 2 regenerari gratuite
const FETCH_TIMEOUT_MS = 25000;

// Preturile NU vin niciodata de la client. Un client care modifica payload-ul (curl/devtools)
// nu poate plati mai putin decat pretul real al pachetului ales.
const PLAN_PRICES = { standard: 15, premium: 25, video: 35 };
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
    console.error('Webhook signature invalida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.orderId;
      if (orderId) {
        const order = await db.getOrderById(orderId);
        if (order && order.status !== 'ready') {
          // Date de tranzactie pastrate pentru evidenta contabila si pregatire OSS —
          // strict cele returnate de Stripe, fara nicio presupunere sau calcul propriu.
          // NU logam sesiunea Stripe intreaga (contine date de client) — doar campurile
          // specifice de care avem nevoie, si niciodata cheia secreta sau date de card.
          const customerCountry = (session.customer_details && session.customer_details.address && session.customer_details.address.country) || null;
          const paymentCurrency = session.currency || null;
          const amountTotal = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
          const taxAmount = (session.total_details && typeof session.total_details.amount_tax === 'number')
            ? session.total_details.amount_tax / 100
            : null;
          const stripeSessionId = session.id || null;
          const stripePaymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent && session.payment_intent.id) || null;

          const updated = await db.updateOrder(orderId, {
            status: 'ready',
            paidAt: new Date().toISOString(),
            customerCountry,
            paymentCurrency,
            amountTotal,
            taxAmount,
            stripeSessionId,
            stripePaymentIntentId
          });
          sendDeliveryEmail(updated).catch(err => {
            console.error('Email de livrare esuat pentru comanda', orderId, err.message);
            // nu blocam livrarea — clientul tot poate lua melodia din pagina de succes
          });
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Eroare la procesarea webhook-ului:', err.message);
    // raspundem 200 catre Stripe ca sa nu reincerce la infinit un eveniment pe care
    // oricum nu il putem procesa corect fara interventie; eroarea ramane in log.
    res.json({ received: true, processedWithError: true });
  }
});

// -------- securitate: headere HTTP standard. CSP dezactivat explicit — paginile folosesc
// script/style inline, o politica CSP stricta le-ar rupe fara o refactorizare separata. --------
app.use(helmet({ contentSecurityPolicy: false }));

// -------- rate limiting pe rutele care costa bani (apeleaza API-ul de muzica) sau sunt tinta de abuz --------
const orderCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Prea multe comenzi create de la această adresă. Încearcă din nou mai târziu' }
});
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Prea multe generări solicitate. Încearcă din nou mai târziu' }
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Prea multe încercări. Încearcă din nou mai târziu' }
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

app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});
app.use('/api/admin', requireAdminAuth);

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
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================================================
// 1. Creeaza comanda (fara plata) — VALIDARE STRICTA + PRET CALCULAT SERVER-SIDE
// ==========================================================================================
app.post('/api/orders', orderCreationLimiter, async (req, res, next) => {
  try {
    const { occasion, recipient, senderName, relationship, email, phone, story, genre, plan, lang, voicePreference } = req.body || {};
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
      story: story.trim(), genre, plan, price, lang: safeLang,
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

    // Blocaj impotriva a doua generari in paralel pentru aceeasi comanda — fara asta,
    // un dublu-click sau un retry de pe client ar putea porni un al doilea task SunoAPI
    // in timp ce primul e inca activ, consumand credite degeaba pentru aceeasi comanda.
    // NU pornim un task nou — in schimb, daca exista deja un music_task_id valid, relansam
    // (in fundal, garda impotriva suprapunerii) o verificare a task-ului existent, ca
    // "plasa de siguranta" suplimentara fata de callback-ul SunoAPI.
    if (order.status === 'generating' || order.status === 'processing_provider_result') {
      if (order.musicTaskId) {
        resumeExistingTaskPolling(order.id, order.musicTaskId);
      }
      return res.status(409).json({ error: 'Generarea este deja în desfășurare.' });
    }

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;

    await db.updateOrder(order.id, { status: 'generating' });
    res.json({ started: true });

    runGeneration(order.id, feedback).catch(async (err) => {
      console.error('Eroare la generare pentru comanda', order.id, err.message);
      try {
        // refundEditIfReserved e un no-op sigur aici — generarea INITIALA nu seteaza
        // niciodata edit_reserved=true (doar regenerarea o face) — dar il apelam oricum,
        // ca plasa de siguranta consistenta pe toate caile de esec ale generarii.
        await db.refundEditIfReserved(order.id);
        await db.updateOrder(order.id, { status: 'generation_failed', error: String(err.message || err).slice(0, 500) });
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

    // REZERVARE ATOMICA: status -> 'generating', edits_used + 1, edit_reserved = true,
    // si (optional) noua preferinta de voce — toate intr-o singura instructiune SQL (vezi
    // db.claimOrderForRegeneration). Previne doua regenerari simultane, depasirea celor 3
    // editari gratuite, si salveaza noua preferinta de voce DOAR daca regenerarea chiar
    // porneste (nu doar la o incercare respinsa).
    const claimed = await db.claimOrderForRegeneration(order.id, FREE_EDITS, requestedVoice);
    if (!claimed) {
      // Recitim starea curenta doar ca sa dam mesajul de eroare potrivit clientului —
      // rezervarea insasi a esuat deja atomic mai sus, deci nu exista nicio cursa aici.
      const fresh = await db.getOrderById(order.id);
      if (fresh && fresh.status === 'ready') {
        return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });
      }
      if (fresh && fresh.editsUsed >= FREE_EDITS) {
        return res.status(400).json({ error: 'Ai folosit toate editările gratuite pentru această comandă. Dacă dorești o melodie nouă, creează o comandă nouă.' });
      }
      if (fresh && (fresh.status === 'generating' || fresh.status === 'processing_provider_result') && fresh.musicTaskId) {
        resumeExistingTaskPolling(order.id, fresh.musicTaskId);
      }
      return res.status(409).json({ error: 'Generarea este deja în desfășurare.' });
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

    await db.updateOrder(order.id, { regenerateSourceVariantId: requestedVariantId });
    res.json({ started: true });

    runGeneration(order.id, combinedFeedback).catch(async (err) => {
      console.error('Eroare la regenerare pentru comanda', order.id, err.message);
      try {
        // Generarea a esuat — restituim ATOMIC editarea gratuita rezervata mai sus, DOAR
        // daca inca era marcata ca rezervata (vezi comentariul din db.refundEditIfReserved
        // despre de ce e sigur sa fie apelata din mai multe locuri, chiar aproape simultan).
        await db.refundEditIfReserved(order.id);
        await db.updateOrder(order.id, { status: 'generation_failed', error: String(err.message || err).slice(0, 500) });
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
    const exists = (order.variants || []).some(v => v.id === variantId);
    if (!exists) return res.status(400).json({ error: 'Varianta nu există.' });

    await db.updateOrder(order.id, { selectedVariantId: variantId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 5. Status comanda (polling din frontend) — accesul e implicit protejat de faptul ca
// orderId e un UUID v4 (122 biti de entropie), nu e listat/ghicit nicaieri.
//
// TOKEN OPTIONAL: daca cererea include ?token=, acesta TREBUIE sa corespunda
// order.accessToken (comparatie timing-safe), altfel raspundem 404 generic — foloseste
// acelasi tipar de securitate ca /media/full. Pagina melodia-mea.html trimite intotdeauna
// acest token. Paginile mai vechi (index.html/se-compune.html), care nu trimit token,
// pastreaza comportamentul anterior neschimbat — nu se blocheaza nimic retroactiv.
// ==========================================================================================
app.get('/api/orders/:orderId', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comandă invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu există.' });

    const providedToken = typeof req.query.token === 'string' ? req.query.token : null;
    if (providedToken !== null && !safeCompare(providedToken, order.accessToken)) {
      return res.status(404).json({ error: 'Comanda nu există.' });
    }

    // niciodata nu trimitem calea fisierelor complete catre client inainte de plata.
    // Versurile (originale/editate) sunt continut text, nu fisiere audio — sigur de
    // expus pre-plata, e nevoie de ele in melodia-mea.html pentru afisare si editare.
    const safeVariants = (order.variants || []).map(v => ({
      id: v.id, previewUrl: v.previewUrl, durationSeconds: v.durationSeconds,
      originalLyrics: v.originalLyrics || null,
      editedLyrics: v.editedLyrics || null,
      lyricsUpdatedAt: v.lyricsUpdatedAt || null
    }));

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
      variants: safeVariants,
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
    if (order.status !== 'preview_ready') {
      return res.status(400).json({ error: 'Generează o previzualizare înainte de plată.' });
    }
    if (!order.selectedVariantId) {
      return res.status(400).json({ error: 'Alege o variantă înainte de plată.' });
    }

    // TVA: dezactivat implicit. Se activeaza DOAR daca STRIPE_AUTOMATIC_TAX_ENABLED=true
    // in .env — si asta doar dupa ce contul Stripe e configurat si verificat pentru
    // calcul automat de taxe (Stripe Tax activat din Dashboard, inregistrari fiscale
    // relevante puse la punct). Nu schimba aceasta valoare fara acea configurare prealabila.
    const automaticTaxEnabled = process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
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
      metadata: { orderId: order.id },
      success_url: `${DOMAIN}/succes.html?order=${order.id}&token=${order.accessToken}`,
      // plata abandonata sau esuata -> revine la pagina dedicata melodiei (nu la formular),
      // cu comanda deja generata si token-ul de acces inclus
      cancel_url: `${DOMAIN}/melodia-mea.html?id=${order.id}&token=${order.accessToken}&resume=1`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Eroare la initierea platii:', err.message);
    res.status(502).json({ error: 'Eroare la inițierea plății. Încearcă din nou în câteva momente' });
  }
});

// ==========================================================================================
// 7. Fisierul PREVIEW (55 sec) al unei variante — accesibil oricui, fara plata (era deja
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

    res.json({
      id: order.id, recipient: order.recipient, status: order.status,
      createdAt: order.createdAt
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
    const taskId = data.taskId || body.taskId;

    if (!taskId || typeof taskId !== 'string') {
      console.warn('Callback SunoAPI primit fara taskId recunoscut.');
      return res.status(200).json({ received: true });
    }

    const order = await db.getOrderByMusicTaskId(taskId);
    if (!order) {
      console.warn(`Callback SunoAPI pentru un taskId necunoscut in baza de date: ${taskId}`);
      return res.status(200).json({ received: true });
    }

    const statusName = data.status || body.status;
    perfLog(order.id, 'callback_received', `status=${statusName || 'necunoscut'}`);

    if (statusName === SUNO_SUCCESS_STATUS) {
      const tracks = extractSunoTracks(body);
      await finalizeVariantsIfNeeded(order.id, tracks, taskId).catch(err => {
        console.error(`Callback SunoAPI: eroare la finalizarea comenzii ${order.id}:`, err.message);
      });
    } else if (SUNO_ERROR_STATUSES.includes(statusName)) {
      const current = await db.getOrderById(order.id);
      if (current && !['preview_ready', 'ready', 'generation_failed'].includes(current.status)) {
        // Suno a raportat direct un status de eroare prin callback (fara sa treaca prin
        // finalizeVariantsIfNeeded) — tot trebuie sa restituim atomic editarea rezervata,
        // daca esecul a aparut in timpul unei regenerari.
        await db.refundEditIfReserved(order.id).catch(refundErr => {
          console.error(`Eroare la restituirea editarii pentru comanda ${order.id}:`, refundErr.message);
        });
        await db.updateOrder(order.id, { status: 'generation_failed', error: `Suno: ${statusName}` });
      }
    }
    // PENDING / TEXT_SUCCESS / FIRST_SUCCESS / status necunoscut -> nu facem nimic aici,
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
    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK' || finalStatus === 'LOCAL_POLL_TIMEOUT') {
      // Fie callback-ul a preluat-o deja, fie e tot in lucru — in ambele cazuri nu mai
      // avem nimic de facut aici.
      return;
    }
    if (finalStatus === SUNO_SUCCESS_STATUS) {
      await finalizeVariantsIfNeeded(orderId, tracks, taskId);
      return;
    }
    if (SUNO_ERROR_STATUSES.includes(finalStatus)) {
      console.error(`Reluare polling: task ${taskId} (comanda ${orderId}) a esuat cu status "${finalStatus}".`);
      await db.refundEditIfReserved(orderId);
      await db.updateOrder(orderId, { status: 'generation_failed', error: `Suno: ${finalStatus}` });
    }
  } catch (err) {
    console.error(`Eroare la reluarea polling-ului pentru comanda ${orderId}, taskId ${taskId}:`, err.message);
  } finally {
    activePollResumptions.delete(orderId);
  }
}

async function runGeneration(orderId, feedback) {
  const order = await db.getOrderById(orderId);
  if (!order) throw new Error('Comanda a dispărut în timpul generării');

  const prompt = buildPrompt(order, feedback);

  perfLog(orderId, 'generation_start');
  const taskId = await callMusicProvider(orderId, prompt);
  const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

  if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK') {
    // Callback-ul SunoAPI (mecanismul PRINCIPAL) a ajuns si a finalizat deja comanda, in
    // timp ce noi asteptam la polling — nu mai e nimic de facut, evitam sa procesam a
    // doua oara acelasi rezultat (garda atomica din finalizeVariantsIfNeeded ar fi
    // prevenit oricum o dubla procesare, dar aici nici nu mai incercam).
    perfLog(orderId, 'polling_stopped_early_callback_won');
    return;
  }

  if (finalStatus === 'LOCAL_POLL_TIMEOUT') {
    // Polling-ul NOSTRU local a expirat — asta NU inseamna ca Suno a esuat sau ca a
    // renuntat la generare. Iesim linistit, FARA sa aruncam o eroare: statusul comenzii
    // ramane 'generating', music_task_id ramane neschimbat, nicio editare nu se restituie.
    // Callback-ul SunoAPI (sau o reluare ulterioara a polling-ului, vezi ruta /generate)
    // vor finaliza comanda cand Suno chiar termina.
    return;
  }

  if (finalStatus !== SUNO_SUCCESS_STATUS) {
    throw new Error(`Suno a raportat un status de eroare: ${finalStatus}`);
  }

  // ghidat de acelasi mecanism folosit si de /api/music/callback — daca ambele au ajuns
  // aproape simultan la rezultat, doar primul care ajunge aici proceseaza efectiv fisierele
  await finalizeVariantsIfNeeded(orderId, tracks, taskId);
}

// Descarca+taie+urca in stocare fiecare piesa primita de la Suno, si scrie variantele
// finale pe comanda — DAR doar daca reuseste sa "preia" comanda atomic (vezi
// db.claimOrderForProviderFinalization). Polling-ul si callback-ul pot ajunge la SUCCESS
// aproape simultan; fara preluare atomica la nivel de baza de date, o simpla verificare
// "e deja procesata?" facuta separat de fiecare ar lasa o fereastra reala in care ambele
// trec de verificare inainte sa apuce vreuna sa scrie — ambele ar descarca si urca fisierele,
// dublu cost, dublu risc. UPDATE...WHERE...RETURNING e o singura operatie atomica in
// Postgres: doar una dintre cererile concurente poate "castiga" preluarea.
async function finalizeVariantsIfNeeded(orderId, tracks, taskId) {
  const claimed = await db.claimOrderForProviderFinalization(orderId);
  if (!claimed) {
    return false; // alta cerere (polling sau callback) a preluat-o deja — nu procesam a doua oara
  }

  const finalizeStart = Date.now();
  perfLog(orderId, 'finalize_start', `piese=${tracks ? tracks.length : 0}`);

  try {
    if (!tracks || tracks.length === 0) {
      throw new Error('Suno a raportat SUCCESS, dar nu am gasit nicio piesa cu audioUrl in raspuns.');
    }
    if (tracks.length !== 2) {
      console.warn(`SunoAPI a returnat ${tracks.length} piese in loc de 2, pentru comanda ${orderId}. Continui cu cate au venit.`);
    }

    // Promise.allSettled (nu Promise.all): daca o varianta esueaza la procesare
    // (descarcare/timestamp/ffmpeg/upload), NU intrerupe si NU corupe procesarea celeilalte
    // variante, care poate continua complet independent pana la capat. Deciziile de mai
    // jos (esec total vs. partial) se iau abia dupa ce AMBELE s-au terminat, indiferent
    // de rezultat.
    const settled = await Promise.allSettled(
      tracks.map(track => buildVariantFromTrack(orderId, randomUUID().slice(0, 8), track, taskId))
    );

    const variants = [];
    const failures = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') variants.push(result.value);
      else failures.push(result.reason);
    }

    if (variants.length === 0) {
      const detail = failures.map(e => (e && e.message) || String(e)).join(' | ');
      throw new Error(`Ambele variante au esuat la procesare: ${detail}`);
    }
    if (failures.length > 0) {
      console.warn(
        `Comanda ${orderId}: o varianta a esuat la procesare, continui cu ${variants.length} varianta(e) reusita(e). ` +
        `Motiv: ${(failures[0] && failures[0].message) || String(failures[0])}`
      );
    }

    await db.updateOrder(orderId, {
      status: 'preview_ready',
      variants,
      selectedVariantId: variants[0]?.id || null,
      generatedAt: new Date().toISOString(),
      // succes: eliberam marcajul de rezervare a editarii (daca exista) FARA sa atingem
      // edits_used — editarea a fost folosita legitim, ramane consumata definitiv. Pentru
      // o generare INITIALA, editReserved era deja false — actualizarea e un no-op sigur.
      editReserved: false
    });

    perfLog(orderId, 'finalize_done', `${Date.now() - finalizeStart}ms, variante_reusite=${variants.length}`);
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
    await db.updateOrder(orderId, {
      status: 'generation_failed',
      error: String(err.message || err).slice(0, 500)
    }).catch(dbErr => {
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
    // Versurile ORIGINALE, asa cum au fost extrase din raspunsul Suno (vezi caveatul din
    // extractSunoTracks — poate fi null daca providerul nu a inclus acest camp). editedLyrics
    // ramane null pana cand clientul salveaza o editare explicita (vezi endpoint-ul dedicat
    // POST /api/orders/:orderId/variants/:variantId/lyrics).
    originalLyrics: track.lyrics || null,
    editedLyrics: null,
    lyricsUpdatedAt: null
  };
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
async function pollForResult(taskId, orderId, maxAttempts = 90, intervalMs = 6000) {
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
async function trimAudio(srcPath, destPath, seconds, startSeconds = 0) {
  const safeStart = Math.max(0, Number(startSeconds) || 0);
  const args = ['-y'];
  if (safeStart > 0) args.push('-ss', String(safeStart));
  args.push('-i', srcPath, '-t', String(seconds), '-acodec', 'copy', destPath);
  await execFileAsync('ffmpeg', args);
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

function buildPrompt(order, feedback) {
  const genreMap = {
    emotional: 'emotional ballad-pop, tender vocals, heartfelt',
    suflet: 'romanian "de suflet" style, soulful acoustic instruments, raw emotional delivery',
    pop: 'upbeat pop, warm vocals',
    acustic: 'acoustic folk, guitar-led, intimate',
    petrecere: 'party music, energetic, danceable',
    balada: 'emotional ballad, piano-led, slow build',
    manele: 'romanian manele style, live instruments',
    copii: 'children\'s song, playful, simple melody, cheerful upbeat tempo, friendly vocals',
    populara: 'romanian popular folk-pop, traditional instruments blended with modern production, upbeat',
    rock: 'rock, driving electric guitars, powerful vocals, energetic',
    colind: 'modern christmas song, clear natural vocal, warm delivery, piano, bells, no choir, no robotic vocals',
    modern: 'modern pop-electronic, contemporary production, catchy synths',
    hiphop: 'hip-hop, rhythmic vocal delivery, modern beat, confident',
    manele_suflet: 'modern romanian manele, style of leading manele artists, expressive vocals, themes of family, love, longing',
    motivational: 'motivational anthem, uplifting and empowering, building energy, inspiring vocals'
  };

  const languageNames = {
    ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish',
    it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish'
  };
  const lyricsLanguage = languageNames[order.lang] || 'Romanian';
  const styleTags = genreMap[order.genre] || 'pop, warm vocals';
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
async function sendDeliveryEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY lipsa din .env — email de livrare NU a fost trimis.');
    return;
  }

  const downloadUrl = `${DOMAIN}/media/full/${order.id}?token=${order.accessToken}`;
  const accessUrl = `${DOMAIN}/comanda-mea.html?token=${order.accessToken}`;

  const templates = {
    ro: { subject: `Cântecul tău pentru ${order.recipient} e gata`,
      html: `<p>Salut,</p><p>Cântecul tău personalizat pentru <strong>${order.recipient}</strong> e gata.</p><p><a href="${downloadUrl}">Descarcă melodia</a></p><p>O poți regăsi oricând la <a href="${accessUrl}">acest link</a>.</p><p>— NALUNA</p>` },
    en: { subject: `Your song for ${order.recipient} is ready`,
      html: `<p>Hi,</p><p>Your personalised song for <strong>${order.recipient}</strong> is ready.</p><p><a href="${downloadUrl}">Download your song</a></p><p>You can find it anytime at <a href="${accessUrl}">this link</a>.</p><p>— NALUNA</p>` },
    de: { subject: `Dein Lied für ${order.recipient} ist fertig`,
      html: `<p>Hallo,</p><p>Dein persönliches Lied für <strong>${order.recipient}</strong> ist fertig.</p><p><a href="${downloadUrl}">Lied herunterladen</a></p><p>Du findest es jederzeit über <a href="${accessUrl}">diesen Link</a>.</p><p>— NALUNA</p>` },
    es: { subject: `Tu canción para ${order.recipient} está lista`,
      html: `<p>Hola,</p><p>Tu canción personalizada para <strong>${order.recipient}</strong> está lista.</p><p><a href="${downloadUrl}">Descargar la canción</a></p><p>Puedes encontrarla siempre en <a href="${accessUrl}">este enlace</a>.</p><p>— NALUNA</p>` },
    it: { subject: `La tua canzone per ${order.recipient} è pronta`,
      html: `<p>Ciao,</p><p>La tua canzone personalizzata per <strong>${order.recipient}</strong> è pronta.</p><p><a href="${downloadUrl}">Scarica la canzone</a></p><p>Puoi trovarla sempre su <a href="${accessUrl}">questo link</a>.</p><p>— NALUNA</p>` },
    fr: { subject: `Votre chanson pour ${order.recipient} est prête`,
      html: `<p>Bonjour,</p><p>Votre chanson personnalisée pour <strong>${order.recipient}</strong> est prête.</p><p><a href="${downloadUrl}">Télécharger la chanson</a></p><p>Vous pouvez la retrouver à tout moment via <a href="${accessUrl}">ce lien</a>.</p><p>— NALUNA</p>` },
    bg: { subject: `Твоята песен за ${order.recipient} е готова`,
      html: `<p>Здравей,</p><p>Твоята персонализирана песен за <strong>${order.recipient}</strong> е готова.</p><p><a href="${downloadUrl}">Изтегли песента</a></p><p>Можеш да я намериш винаги на <a href="${accessUrl}">този линк</a>.</p><p>— NALUNA</p>` },
    tr: { subject: `${order.recipient} için şarkınız hazır`,
      html: `<p>Merhaba,</p><p><strong>${order.recipient}</strong> için kişiselleştirilmiş şarkınız hazır.</p><p><a href="${downloadUrl}">Şarkınızı indirin</a></p><p><a href="${accessUrl}">Bu bağlantıdan</a> her zaman ulaşabilirsiniz.</p><p>— NALUNA</p>` }
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

// -------- pornire: verificam intai conexiunea la baza de date --------
db.initDb()
  .then(() => {
    checkFfmpegAvailability(); // fire-and-forget — nu blocheaza si nu conditioneaza pornirea
    app.listen(PORT, () => {
      console.log(`NALUNA ruleaza pe ${DOMAIN}`);
    });
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la PostgreSQL la pornire:', err.message);
    process.exit(1);
  });
