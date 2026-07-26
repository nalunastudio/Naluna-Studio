// server.js
// NALUNA — backend, versiune pregatita pentru productie
//
// Flux:
// 1. Clientul completeaza formularul si apasa "Genereaza previzualizarea" (GRATUIT).
// 2. POST /api/orders creeaza comanda in PostgreSQL (validare stricta, pret calculat
//    server-side dupa pachet — pretul trimis de client NU e niciodata folosit direct).
// 3. POST /api/orders/:id/generate genereaza 2 VARIANTE in paralel, descarca fiecare
//    fisier complet (privat), taie un preview de 55 sec cu ffmpeg, citeste durata reala.
// 4. Clientul asculta, alege o varianta (POST /api/orders/:id/select), sau cere editari
//    (POST /api/orders/:id/regenerate) — 3 runde gratuite.
// 5. POST /api/orders/:id/checkout creeaza sesiunea Stripe, RESTRICTIONATA tehnic la
//    clienti din UK (shipping_address_collection.allowed_countries), fara calcul automat
//    de TVA (automatic_tax dezactivat — sole trader UK, neinregistrat TVA).
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
const PREVIEW_SECONDS = 55;
const FREE_EDITS = 3;
const FETCH_TIMEOUT_MS = 25000;

// Preturile NU vin niciodata de la client. Un client care modifica payload-ul (curl/devtools)
// nu poate plati mai putin decat pretul real al pachetului ales.
const PLAN_PRICES = { standard: 15, premium: 25, video: 35 };
const ALLOWED_OCCASIONS = ['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'altceva'];
const ALLOWED_GENRES = ['emotional', 'suflet', 'pop', 'acustic', 'petrecere', 'balada', 'manele', 'copii'];
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
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
          const updated = await db.updateOrder(orderId, { status: 'ready', paidAt: new Date().toISOString() });
          sendDeliveryEmail(updated).catch(err => {
            console.error('Email de livrare esuat pentru comanda', orderId, err.message);
            // nu blocam livrarea — clientul tot poate lua melodia din pagina de succes
          });
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Eroare la procesarea webhook-ului:', err);
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
  message: { error: 'Prea multe comenzi create de la aceasta adresa. Incearca din nou mai tarziu.' }
});
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Prea multe generari solicitate. Incearca din nou mai tarziu.' }
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Prea multe incercari. Incearca din nou mai tarziu.' }
});

// -------- Login owner: HTTP Basic Auth pentru panoul de admin --------
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin NALUNA"');
    return res.status(401).send('Autentificare necesara.');
  }

  const decoded = Buffer.from(header.split(' ')[1], 'base64').toString();
  const sepIndex = decoded.indexOf(':');
  const user = decoded.slice(0, sepIndex);
  const pass = decoded.slice(sepIndex + 1);

  if (safeCompare(user, process.env.ADMIN_USER) && safeCompare(pass, process.env.ADMIN_PASSWORD)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin NALUNA"');
  return res.status(401).send('Date de autentificare incorecte.');
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
        return res.status(400).json({ error: 'Citatul trebuie sa aiba intre 3 si 500 de caractere.' });
      }
      if (!TESTIMONIAL_TYPES.includes(mediaType)) {
        return res.status(400).json({ error: 'Tip de reactie invalid.' });
      }
      if (!consentConfirmed) {
        return res.status(400).json({ error: 'Trebuie sa confirmi ca ai acordul clientului pentru publicare.' });
      }
      if (mediaType !== 'text' && req.file) {
        const expected = TESTIMONIAL_MIME_TYPES[mediaType] || [];
        if (!expected.includes(req.file.mimetype)) {
          return res.status(400).json({ error: `Fisierul incarcat nu corespunde tipului "${mediaType}".` });
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
      if (!existing) return res.status(404).json({ error: 'Reactia nu exista.' });

      const { firstName, location, quote, mediaType } = req.body;
      const published = isTruthy(req.body.published);
      const consentConfirmed = isTruthy(req.body.consentConfirmed);

      if (!isValidString(firstName, 1, 80)) {
        return res.status(400).json({ error: 'Prenumele clientului este obligatoriu (max 80 caractere).' });
      }
      if (!isValidString(quote, 3, 500)) {
        return res.status(400).json({ error: 'Citatul trebuie sa aiba intre 3 si 500 de caractere.' });
      }
      if (!TESTIMONIAL_TYPES.includes(mediaType)) {
        return res.status(400).json({ error: 'Tip de reactie invalid.' });
      }
      if (!consentConfirmed) {
        return res.status(400).json({ error: 'Trebuie sa confirmi ca ai acordul clientului pentru publicare.' });
      }
      if (mediaType !== 'text' && req.file) {
        const expected = TESTIMONIAL_MIME_TYPES[mediaType] || [];
        if (!expected.includes(req.file.mimetype)) {
          return res.status(400).json({ error: `Fisierul incarcat nu corespunde tipului "${mediaType}".` });
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
    if (!existing) return res.status(404).json({ error: 'Reactia nu exista.' });

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
      return res.status(400).json({ error: 'Directie invalida.' });
    }

    const testimonial = await db.moveTestimonial(req.params.id, direction);
    if (!testimonial) return res.status(404).json({ error: 'Reactia nu exista.' });
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
    const { occasion, recipient, email, story, genre, plan, lang } = req.body || {};

    if (!ALLOWED_OCCASIONS.includes(occasion)) {
      return res.status(400).json({ error: 'Ocazie invalida.' });
    }
    if (!isValidString(recipient, 1, 100)) {
      return res.status(400).json({ error: 'Numele destinatarului este obligatoriu (max 100 caractere).' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Adresa de email nu este valida.' });
    }
    if (!isValidString(story, 5, 2000)) {
      return res.status(400).json({ error: 'Povestea trebuie sa aiba intre 5 si 2000 de caractere.' });
    }
    if (!ALLOWED_GENRES.includes(genre)) {
      return res.status(400).json({ error: 'Gen muzical invalid.' });
    }
    if (!PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Pachet invalid.' });
    }

    const safeLang = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
    // IMPORTANT: pretul NU vine niciodata din req.body — se calculeaza aici, dupa pachetul
    // ales, indiferent ce a trimis clientul in payload. Asta previne manipularea pretului.
    const price = PLAN_PRICES[plan];

    const order = await db.createOrder({
      id: randomUUID(),
      accessToken: randomBytes(24).toString('hex'),
      occasion, recipient: recipient.trim(), email: email.trim().toLowerCase(),
      story: story.trim(), genre, plan, price, lang: safeLang,
      status: 'draft', editsUsed: 0, variants: [], selectedVariantId: null
    });

    res.json({ orderId: order.id, accessToken: order.accessToken });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 2. Genereaza o PERECHE de variante — GRATUIT, inainte de plata
// ==========================================================================================
app.post('/api/orders/:orderId/generate', generationLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comanda invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu exista.' });
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja platita si finalizata.' });

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;

    await db.updateOrder(order.id, { status: 'generating' });
    res.json({ started: true });

    runGeneration(order.id, feedback).catch(async (err) => {
      console.error('Eroare la generare pentru comanda', order.id, err.message);
      try {
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
app.post('/api/orders/:orderId/regenerate', generationLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comanda invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu exista.' });
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja platita si finalizata.' });
    if (order.editsUsed >= FREE_EDITS) {
      return res.status(400).json({ error: `Ai folosit toate cele ${FREE_EDITS} editari gratuite.` });
    }

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 500) : null;

    await db.updateOrder(order.id, { status: 'generating', editsUsed: order.editsUsed + 1 });
    res.json({ started: true });

    runGeneration(order.id, feedback).catch(async (err) => {
      console.error('Eroare la regenerare pentru comanda', order.id, err.message);
      try {
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
// 4. Alege varianta preferata (inainte de plata)
// ==========================================================================================
app.post('/api/orders/:orderId/select', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comanda invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu exista.' });

    const { variantId } = req.body || {};
    const exists = (order.variants || []).some(v => v.id === variantId);
    if (!exists) return res.status(400).json({ error: 'Varianta nu exista.' });

    await db.updateOrder(order.id, { selectedVariantId: variantId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ==========================================================================================
// 5. Status comanda (polling din frontend) — accesul e implicit protejat de faptul ca
// orderId e un UUID v4 (122 biti de entropie), nu e listat/ghicit nicaieri.
// ==========================================================================================
app.get('/api/orders/:orderId', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comanda invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu exista.' });

    // niciodata nu trimitem calea fisierelor complete catre client inainte de plata
    const safeVariants = (order.variants || []).map(v => ({
      id: v.id, previewUrl: v.previewUrl, durationSeconds: v.durationSeconds
    }));

    // IMPORTANT: raspuns construit explicit, camp cu camp — NU facem spread pe `order`.
    // Acest endpoint nu cere niciun token (orderId-ul singur e suficient, e folosit constant
    // in timpul fluxului gratuit de preview, inainte sa existe vreun token de verificat).
    // Un spread complet ar fi scurs accessToken, email si povestea clientului catre oricine
    // stie/ghiceste UUID-ul comenzii — exact contrariul protectiei adaugate la /media/full.
    res.json({
      id: order.id,
      recipient: order.recipient,
      plan: order.plan,
      lang: order.lang,
      status: order.status,
      editsUsed: order.editsUsed,
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
// 6. Creeaza sesiunea de plata pentru varianta selectata
// TVA: dezactivat (sole trader UK, neinregistrat TVA). UK-only: blocaj tehnic la nivel
// de tara permisa pentru "livrare" (produs digital, dar campul e refolosit ca filtru de tara).
// ==========================================================================================
app.post('/api/orders/:orderId/checkout', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).json({ error: 'ID comanda invalid.' });

    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Comanda nu exista.' });
    if (order.status !== 'preview_ready') {
      return res.status(400).json({ error: 'Genereaza o previzualizare inainte de plata.' });
    }
    if (!order.selectedVariantId) {
      return res.status(400).json({ error: 'Alege o varianta inainte de plata.' });
    }

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
      // Colectam adresa de facturare ca dovada suplimentara de UK — nu pentru TVA (dezactivat mai jos).
      billing_address_collection: 'required',
      // BLOCAJ TEHNIC: vanzare doar catre UK. Produsul e digital, nu se livreaza fizic
      // nimic, dar folosim campul de "livrare" ca sa restrictionam ce tari poate alege
      // clientul la checkout — daca nu poate selecta UK, nu poate finaliza plata.
      shipping_address_collection: { allowed_countries: ['GB'] },
      // TVA DEZACTIVAT explicit: sole trader in UK, neinregistrat TVA momentan.
      // Cand te inregistrezi TVA (dupa ce depasesti pragul de ~£90.000/an sau optezi
      // voluntar mai devreme), activezi Stripe Tax din Dashboard SI schimbi valoarea
      // de mai jos in true — pana atunci, ramane false, nu se calculeaza si nu se
      // colecteaza TVA de la clienti.
      automatic_tax: { enabled: false },
      metadata: { orderId: order.id },
      success_url: `${DOMAIN}/succes.html?order=${order.id}&token=${order.accessToken}`,
      // plata abandonata sau esuata -> revine pe pagina principala cu comanda deja salvata
      cancel_url: `${DOMAIN}/index.html?resume=${order.id}`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Eroare la initierea platii:', err.message);
    res.status(502).json({ error: 'Eroare la initierea platii. Incearca din nou in cateva momente.' });
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
    if (!UUID_RE.test(req.params.orderId)) return res.status(400).send('ID comanda invalid.');

    const order = await db.getOrderById(req.params.orderId);
    if (!order || order.status === 'draft' || order.status === 'generating') {
      return res.status(404).send('Preview indisponibil.');
    }

    const variant = (order.variants || []).find(v => v.id === req.params.variantId);
    if (!variant) return res.status(404).send('Varianta nu exista.');

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
    const denyGeneric = () => res.status(404).send('Resursa nu este disponibila.');

    if (!UUID_RE.test(req.params.orderId)) return denyGeneric();

    const order = await db.getOrderById(req.params.orderId);
    const providedToken = typeof req.query.token === 'string' ? req.query.token : '';

    // comparam mereu — cu tokenul real daca ordinul exista, cu unul fals altfel —
    // ca timpul de executie sa fie acelasi in ambele cazuri
    const expectedToken = order ? order.accessToken : DUMMY_TOKEN_FOR_TIMING;
    const tokenValid = safeCompare(providedToken, expectedToken);

    if (!order || !tokenValid) return denyGeneric();

    if (order.status !== 'ready') {
      return res.status(403).send('Melodia completa se deblocheaza dupa plata.');
    }

    const variant = (order.variants || []).find(v => v.id === order.selectedVariantId);

    if (storage.CLOUD_ENABLED && variant && variant.fullKey) {
      const signedUrl = await storage.getSignedDownloadUrl(variant.fullKey, 600);
      return res.redirect(302, signedUrl);
    }

    // fallback local — fara stocare cloud configurata
    const filePath = path.join(MEDIA_FULL_DIR, `${order.id}-${order.selectedVariantId}.mp3`);
    if (!fs.existsSync(filePath)) return res.status(404).send('Fisier indisponibil.');
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
    if (!order) return res.status(404).json({ error: 'Nicio comanda gasita pentru acest cod.' });

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

    if (statusName === SUNO_SUCCESS_STATUS) {
      const tracks = extractSunoTracks(body);
      await finalizeVariantsIfNeeded(order.id, tracks).catch(err => {
        console.error(`Callback SunoAPI: eroare la finalizarea comenzii ${order.id}:`, err.message);
      });
    } else if (SUNO_ERROR_STATUSES.includes(statusName)) {
      const current = await db.getOrderById(order.id);
      if (current && !['preview_ready', 'ready', 'generation_failed'].includes(current.status)) {
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

async function runGeneration(orderId, feedback) {
  const order = await db.getOrderById(orderId);
  if (!order) throw new Error('Comanda a disparut in timpul generarii.');

  const prompt = buildPrompt(order, feedback);

  const taskId = await callMusicProvider(orderId, prompt);
  const { status: finalStatus, tracks } = await pollForResult(taskId);

  if (finalStatus !== SUNO_SUCCESS_STATUS) {
    throw new Error(`Suno a raportat un status de eroare: ${finalStatus}`);
  }

  // ghidat de acelasi mecanism folosit si de /api/music/callback — daca ambele au ajuns
  // aproape simultan la rezultat, doar primul care ajunge aici proceseaza efectiv fisierele
  await finalizeVariantsIfNeeded(orderId, tracks);
}

// Descarca+taie+urca in stocare fiecare piesa primita de la Suno, si scrie variantele
// finale pe comanda — DAR doar daca reuseste sa "preia" comanda atomic (vezi
// db.claimOrderForProviderFinalization). Polling-ul si callback-ul pot ajunge la SUCCESS
// aproape simultan; fara preluare atomica la nivel de baza de date, o simpla verificare
// "e deja procesata?" facuta separat de fiecare ar lasa o fereastra reala in care ambele
// trec de verificare inainte sa apuce vreuna sa scrie — ambele ar descarca si urca fisierele,
// dublu cost, dublu risc. UPDATE...WHERE...RETURNING e o singura operatie atomica in
// Postgres: doar una dintre cererile concurente poate "castiga" preluarea.
async function finalizeVariantsIfNeeded(orderId, tracks) {
  const claimed = await db.claimOrderForProviderFinalization(orderId);
  if (!claimed) {
    return false; // alta cerere (polling sau callback) a preluat-o deja — nu procesam a doua oara
  }

  try {
    if (!tracks || tracks.length === 0) {
      throw new Error('Suno a raportat SUCCESS, dar nu am gasit nicio piesa cu audioUrl in raspuns.');
    }
    if (tracks.length !== 2) {
      console.warn(`SunoAPI a returnat ${tracks.length} piese in loc de 2, pentru comanda ${orderId}. Continui cu cate au venit.`);
    }

    const variants = await Promise.all(
      tracks.map(track => buildVariantFromTrack(orderId, randomUUID().slice(0, 8), track))
    );

    await db.updateOrder(orderId, {
      status: 'preview_ready',
      variants,
      selectedVariantId: variants[0]?.id || null,
      generatedAt: new Date().toISOString()
    });
    return true;
  } catch (err) {
    // Am apucat sa marcam comanda "processing_provider_result" (am preluat-o), dar
    // procesarea a esuat la mijloc (descarcare, ffmpeg, upload etc). NU o lasam blocata
    // acolo permanent — o marcam explicit esuata, cu un mesaj de eroare sigur (trunchiat,
    // fara detalii interne sensibile).
    console.error(`Eroare la finalizarea comenzii ${orderId} dupa preluare:`, err.message);
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
async function buildVariantFromTrack(orderId, variantId, track) {
  if (!track.audioUrl) {
    throw new Error(`Piesa primita de la Suno (id: ${track.id || 'necunoscut'}) nu are audioUrl/audio_url.`);
  }

  const tempFull = path.join(TEMP_DIR, `${orderId}-${variantId}-full.mp3`);
  const tempPreview = path.join(TEMP_DIR, `${orderId}-${variantId}-preview.mp3`);

  await downloadFile(track.audioUrl, tempFull);
  await trimAudio(tempFull, tempPreview, PREVIEW_SECONDS);
  const durationSeconds = await getAudioDuration(tempFull);

  const fullKey = `orders/full/${orderId}-${variantId}.mp3`;
  const previewKey = `orders/preview/${orderId}-${variantId}.mp3`;

  let previewUrl;
  let storedFullKey = null;
  let storedPreviewKey = null;

  if (storage.CLOUD_ENABLED) {
    // fisierul complet merge STRICT in bucket-ul privat (naluna-private) — nu exista nicio
    // functie in storage.js care sa-l poata trimite din greseala in bucket-ul public.
    // Accesul se face doar prin URL semnat, generat la cerere, dupa ce verificam plata.
    await storage.uploadPrivateFile(tempFull, fullKey, 'audio/mpeg');
    await storage.uploadPublicFile(tempPreview, previewKey, 'audio/mpeg');
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

  return {
    id: variantId,
    previewUrl,
    durationSeconds,
    fullKey: storedFullKey,       // null in fallback local; folosit de /media/full cand storage.CLOUD_ENABLED
    previewKey: storedPreviewKey  // null in fallback local; folosit de /media/preview cand storage.CLOUD_ENABLED
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
      duration: t.duration
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

  const requestBody = {
    prompt,
    customMode: false,
    instrumental: false,
    model: 'V4_5ALL',
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

  return taskId;
}

// ==========================================================================================
// GET /api/v1/generate/record-info?taskId=... — polling pana la un status final.
// SUCCESS = gata (extragem piesele). CREATE_TASK_FAILED / GENERATE_AUDIO_FAILED /
// CALLBACK_EXCEPTION / SENSITIVE_WORD_ERROR = eroare definitiva. PENDING / TEXT_SUCCESS /
// FIRST_SUCCESS = inca in lucru, continuam polling-ul.
// ==========================================================================================
async function pollForResult(taskId, maxAttempts = 30, intervalMs = 6000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));

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
  throw new Error('Timeout: melodia nu a fost gata in timpul asteptat.');
}

async function downloadFile(url, destPath) {
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok || !res.body) throw new Error('Nu am putut descarca fisierul audio complet.');
  await pipeline(res.body, fs.createWriteStream(destPath));
}

async function trimAudio(srcPath, destPath, seconds) {
  await execFileAsync('ffmpeg', ['-y', '-i', srcPath, '-t', String(seconds), '-acodec', 'copy', destPath]);
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

function buildPrompt(order, feedback) {
  const genreMap = {
    emotional: 'emotional ballad-pop, tender vocals, heartfelt',
    suflet: 'romanian "de suflet" style, soulful acoustic instruments, raw emotional delivery',
    pop: 'upbeat pop, warm vocals',
    acustic: 'acoustic folk, guitar-led, intimate',
    petrecere: 'party music, energetic, danceable',
    balada: 'emotional ballad, piano-led, slow build',
    manele: 'romanian manele style, live instruments',
    copii: 'children\'s song, playful, simple melody, cheerful upbeat tempo, friendly vocals'
  };

  const languageNames = {
    ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish',
    it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish'
  };
  const lyricsLanguage = languageNames[order.lang] || 'Romanian';
  const styleTags = genreMap[order.genre] || 'pop, warm vocals';

  // partea FIXA — limba, stilul, ocazia, destinatarul — niciodata trunchiata
  const head = `${styleTags}. Write the song lyrics entirely in ${lyricsLanguage}. Occasion: ${order.occasion}. Dedicated to ${order.recipient}.`;

  const storyLabel = ' Story/details to include: ';
  const feedbackLabel = ' Client-requested adjustment: ';
  const feedbackText = feedback ? String(feedback).trim() : '';

  let remaining = SUNO_PROMPT_MAX_LEN - head.length;
  if (remaining < 0) remaining = 0;

  // rezervam spatiu pentru feedback (max 40% din ce a ramas dupa partea fixa),
  // ca sa nu consume tot bugetul si sa nu mai ramana loc deloc pentru poveste
  let feedbackFull = '';
  if (feedbackText) {
    const feedbackBudget = Math.max(0, Math.floor(remaining * 0.4) - feedbackLabel.length);
    const feedbackTrimmed = truncateSafely(feedbackText, feedbackBudget);
    if (feedbackTrimmed) {
      feedbackFull = `${feedbackLabel}${feedbackTrimmed}`;
      remaining -= feedbackFull.length;
    }
  }
  if (remaining < 0) remaining = 0;

  // povestea umple spatiul ramas
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
    throw new Error('Promptul construit pentru SunoAPI este gol — comanda nu are date suficiente pentru generare.');
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
    ro: { subject: `Cantecul tau pentru ${order.recipient} e gata`,
      html: `<p>Salut,</p><p>Cantecul tau personalizat pentru <strong>${order.recipient}</strong> e gata.</p><p><a href="${downloadUrl}">Descarca melodia</a></p><p>O poti regasi oricand la <a href="${accessUrl}">acest link</a>.</p><p>— NALUNA</p>` },
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
  res.status(404).json({ error: 'Ruta inexistenta.' });
});

// -------- error handler central — nicio eroare nescapata nu trebuie sa opreasca serverul --------
app.use((err, req, res, next) => {
  console.error('Eroare necapturata pe o cerere:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'A aparut o eroare neasteptata. Incearca din nou.' });
});

// -------- siguranta la nivel de proces: loga, nu lasa serverul intr-o stare nedefinita --------
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, serverul se opreste pentru un restart curat:', err);
  process.exit(1); // Railway reporneste automat procesul
});

// -------- pornire: verificam intai conexiunea la baza de date --------
db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NALUNA ruleaza pe ${DOMAIN}`);
    });
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la PostgreSQL la pornire:', err.message);
    process.exit(1);
  });
