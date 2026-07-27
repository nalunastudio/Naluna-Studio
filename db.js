// db.js
// Strat de acces la baza de date PostgreSQL pentru comenzi.
// Inlocuieste fisierul orders.json folosit anterior — elimina riscul de coruptie
// la scrieri concurente si de pierdere a datelor la fiecare redeploy pe Railway.
//
// RAILWAY: adaugi un serviciu PostgreSQL din dashboard (New -> Database -> Add PostgreSQL).
// Railway injecteaza automat variabila DATABASE_URL in serviciul tau Node — nu trebuie
// sa faci nimic manual in afara de a adauga acel serviciu din dashboard.
//
// LOCAL: instalezi Postgres (sau folosesti Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=parola postgres`),
// si setezi DATABASE_URL in .env, ex: postgres://postgres:parola@localhost:5432/postgres

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL lipseste din variabilele de mediu. ' +
    'Pe Railway: adauga un serviciu PostgreSQL din dashboard (New -> Database -> PostgreSQL). ' +
    'Local: seteaza DATABASE_URL in .env catre un Postgres local sau catre baza de pe Railway.'
  );
}

// Railway (si majoritatea gazduirilor Postgres externe) cer SSL. Local, de obicei nu.
const isLocal = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

// O conexiune idle care pica nu trebuie sa opreasca tot serverul.
pool.on('error', (err) => {
  console.error('Eroare neasteptata pe o conexiune Postgres idle:', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      access_token TEXT UNIQUE NOT NULL,
      occasion TEXT NOT NULL,
      recipient TEXT NOT NULL,
      email TEXT NOT NULL,
      story TEXT NOT NULL,
      genre TEXT NOT NULL,
      plan TEXT NOT NULL,
      price NUMERIC NOT NULL,
      lang TEXT NOT NULL DEFAULT 'ro',
      status TEXT NOT NULL DEFAULT 'draft',
      edits_used INTEGER NOT NULL DEFAULT 0,
      variants JSONB NOT NULL DEFAULT '[]'::jsonb,
      selected_variant_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      generated_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_access_token ON orders(access_token);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);

  // ALTER separat (nu doar in CREATE TABLE) — ca baza de date sa se actualizeze corect
  // si pentru instalari deja existente, unde tabela orders exista deja fara aceasta coloana
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS music_task_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_music_task_id ON orders(music_task_id);`);

  // Date de tranzactie Stripe, salvate la confirmarea platii (webhook) — strict cele
  // returnate de Stripe, pentru evidenta contabila si pregatire pentru inregistrare OSS
  // ulterioara. Migrare sigura: ADD COLUMN IF NOT EXISTS nu atinge randurile existente,
  // comenzile deja platite raman intacte, doar cu aceste campuri goale (NULL) retroactiv.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_country TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_currency TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_total NUMERIC;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;`);

  // Personalizare puternica a versurilor: cine ofera melodia si relatia cu destinatarul.
  // Coloane NULLABLE (fara NOT NULL) — migrare sigura, comenzile vechi raman valide cu
  // aceste campuri goale (NULL), buildPrompt() le trateaza ca optionale pentru compatibilitate.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_name TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS relationship TEXT;`);

  // Urmarire: din ce varianta (versuri editate de client) a pornit ultima regenerare —
  // pentru transparenta/audit. Versurile originale/editate/data ultimei editari per
  // varianta se salveaza in JSON-ul deja existent al coloanei `variants` (vezi
  // buildVariantFromTrack() si endpoint-ul de salvare a versurilor din server.js) —
  // nu au fost necesare coloane noi pentru acelea.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_source_variant_id TEXT;`);

  // edit_reserved: TRUE cat timp o regenerare are o editare gratuita rezervata dar
  // inca neconfirmata (generarea e in desfasurare). Permite diferentierea clara intre
  // generarea INITIALA (niciodata nu seteaza acest flag, niciodata nu modifica edits_used)
  // si o REGENERARE (seteaza flag-ul atomic la pornire, il curata la succes FARA sa
  // atinga edits_used, sau declanseaza un refund atomic-idempotent la orice esec — vezi
  // db.claimOrderForRegeneration() si db.refundEditIfReserved() mai jos).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS edit_reserved BOOLEAN NOT NULL DEFAULT false;`);

  // voice_preference: preferinta de voce pentru generare — 'female' | 'male' | 'duet' | 'auto'.
  // NULL pentru comenzile existente (dinainte de aceasta coloana) — aplicatia trateaza
  // NULL identic cu 'auto' peste tot (vezi rowToOrder mai jos si buildPrompt in server.js),
  // deci comenzile vechi continua sa functioneze neschimbate, fara nicio migrare de date.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS voice_preference TEXT;`);

  // phone: numarul WhatsApp optional, salvat INTOTDEAUNA in format international E.164
  // (ex. +447920728215, +40721234567, +8613812345678) — niciodata fara prefix, niciodata
  // presupunand vreo tara implicita. NULL cand clientul nu il completeaza (ramane optional).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS testimonials (
      id UUID PRIMARY KEY,
      first_name TEXT NOT NULL,
      location TEXT,
      quote TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'text',
      media_path TEXT,
      published BOOLEAN NOT NULL DEFAULT false,
      display_order INTEGER NOT NULL DEFAULT 0,
      consent_confirmed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_testimonials_published_order ON testimonials(published, display_order);`);

  console.log('Postgres: schema orders verificata/creata.');
}

// converteste un rand din baza de date (snake_case) in formatul folosit de restul aplicatiei (camelCase)
function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    accessToken: row.access_token,
    occasion: row.occasion,
    recipient: row.recipient,
    email: row.email,
    story: row.story,
    genre: row.genre,
    plan: row.plan,
    price: Number(row.price),
    lang: row.lang,
    status: row.status,
    editsUsed: row.edits_used,
    variants: row.variants || [],
    selectedVariantId: row.selected_variant_id,
    musicTaskId: row.music_task_id,
    error: row.error,
    createdAt: row.created_at,
    generatedAt: row.generated_at,
    paidAt: row.paid_at,
    customerCountry: row.customer_country,
    paymentCurrency: row.payment_currency,
    amountTotal: row.amount_total !== null && row.amount_total !== undefined ? Number(row.amount_total) : null,
    taxAmount: row.tax_amount !== null && row.tax_amount !== undefined ? Number(row.tax_amount) : null,
    stripeSessionId: row.stripe_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    senderName: row.sender_name,
    relationship: row.relationship,
    regenerateSourceVariantId: row.regenerate_source_variant_id,
    editReserved: row.edit_reserved,
    // NULL (comenzi vechi, dinainte de aceasta coloana) devine 'auto' aici, o singura
    // data, central — restul aplicatiei (buildPrompt, API, comanda.html, melodia-mea.html)
    // nu mai trebuie sa trateze separat cazul NULL.
    voicePreference: row.voice_preference || 'auto',
    phone: row.phone || null
  };
}

async function createOrder(order) {
  const result = await pool.query(
    `INSERT INTO orders
      (id, access_token, occasion, recipient, email, story, genre, plan, price, lang, status, edits_used, variants, selected_variant_id, sender_name, relationship, voice_preference, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      order.id, order.accessToken, order.occasion, order.recipient, order.email,
      order.story, order.genre, order.plan, order.price, order.lang,
      order.status, order.editsUsed, JSON.stringify(order.variants || []), order.selectedVariantId,
      order.senderName || null, order.relationship || null, order.voicePreference || 'auto',
      order.phone || null
    ]
  );
  return rowToOrder(result.rows[0]);
}

async function getOrderById(id) {
  const result = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rowToOrder(result.rows[0]);
}

async function getOrderByToken(token) {
  const result = await pool.query(`SELECT * FROM orders WHERE access_token = $1`, [token]);
  return rowToOrder(result.rows[0]);
}

// folosita de POST /api/music/callback — identifica ce comanda corespunde unui taskId
// primit de la SunoAPI, ca sa stim ce inregistrare sa actualizam
async function getOrderByMusicTaskId(taskId) {
  const result = await pool.query(`SELECT * FROM orders WHERE music_task_id = $1`, [taskId]);
  return rowToOrder(result.rows[0]);
}

// ==================================================================================
// PRELUARE ATOMICA a unei comenzi pentru procesare (descarcare + upload), inainte sa
// atingem vreun fisier. Polling-ul si callback-ul SunoAPI pot ajunge la SUCCESS aproape
// simultan — daca ambele ar verifica "e deja procesata?" separat, apoi ar proceda separat,
// exista o fereastra reala in care ambele trec de verificare inainte ca vreuna sa apuce
// sa scrie noul status (clasica cursa "check-then-act"). UPDATE ... WHERE ... RETURNING
// e o singura instructiune atomica in Postgres: daca doua cereri o executa "simultan",
// baza de date le serializeaza intern (row-level lock) — doar UNA poate vedea starea
// veche si actualiza, cealalta gaseste deja starea noua in clauza WHERE si nu returneaza
// niciun rand. Nu exista fereastra de timp intre citire si scriere, pentru ca sunt
// aceeasi operatie.
// ==================================================================================
async function claimOrderForProviderFinalization(orderId) {
  const result = await pool.query(
    `UPDATE orders
     SET status = 'processing_provider_result'
     WHERE id = $1
       AND status NOT IN ('processing_provider_result', 'preview_ready', 'ready', 'generation_failed')
     RETURNING *`,
    [orderId]
  );
  return rowToOrder(result.rows[0]); // null daca alta cerere a preluat-o deja (sau era deja finalizata)
}

// ==================================================================================
// PRELUARE ATOMICA pentru o regenerare (editare gratuita). Rezerva ATOMIC, intr-o
// singura instructiune SQL, statusul 'generating', incrementarea edits_used SI flag-ul
// edit_reserved=true — previne TREI probleme simultan:
//   1. doua cereri de regenerare in paralel pentru aceeasi comanda (dublu-click, retry) —
//      doar una poate "castiga" tranzitia de status, cealalta gaseste deja 'generating'.
//   2. depasirea celor 3 editari gratuite printr-o cursa intre citire si scriere — verificarea
//      edits_used < $2 e parte din ACEEASI instructiune UPDATE, nu un pas separat inainte.
//   3. o generare INITIALA (fara editare rezervata) sa fie confundata cu o regenerare —
//      edit_reserved=true se seteaza DOAR aici, niciodata la /generate (generarea initiala).
// Editarea e doar REZERVATA aici — daca generarea esueaza ulterior (in orice etapa: creare
// task, polling, callback, descarcare, ffmpeg, durata, upload, salvare), apelantul TREBUIE
// sa o restituie explicit prin refundEditIfReserved() (vezi mai jos), niciodata printr-un
// simplu "edits_used - 1" manual.
//
// voicePreference (optional): daca clientul schimba preferinta de voce inainte de
// regenerare, noua valoare se salveaza ATOMIC, in ACEEASI instructiune — deci NUMAI daca
// regenerarea chiar e acceptata de server (nu doar incercata). Daca nu e trimisa
// (null/undefined), COALESCE pastreaza valoarea existenta neschimbata.
// ==================================================================================
async function claimOrderForRegeneration(orderId, maxEdits, voicePreference) {
  const result = await pool.query(
    `UPDATE orders
     SET status = 'generating',
         edits_used = edits_used + 1,
         edit_reserved = true,
         voice_preference = COALESCE($3, voice_preference)
     WHERE id = $1
       AND status NOT IN ('generating', 'processing_provider_result', 'ready')
       AND edits_used < $2
     RETURNING *`,
    [orderId, maxEdits, voicePreference || null]
  );
  return rowToOrder(result.rows[0]); // null daca deja in curs, deja platita, sau limita atinsa
}

// ==================================================================================
// RESTITUIRE ATOMICA SI IDEMPOTENTA a unei editari rezervate. Se apeleaza la ORICE esec
// al unei regenerari, indiferent de etapa (creare task Suno, polling, callback, download,
// ffmpeg, verificare durata, upload, salvare in baza de date) si indiferent CINE detecteaza
// esecul (ruta /regenerate, callback-ul SunoAPI, sau finalizeVariantsIfNeeded).
//
// Conditia "AND edit_reserved = true" din WHERE face restituirea sigura de apelat de
// MAI MULTE ORI sau din MAI MULTE LOCURI pentru aceeasi comanda (ex. polling-ul si
// callback-ul detecteaza acelasi esec aproape simultan): primul apel care ajunge la
// Postgres gaseste edit_reserved=true, scade edits_used si seteaza edit_reserved=false,
// intr-o singura operatie atomica; orice apel ulterior gaseste deja edit_reserved=false,
// clauza WHERE nu se potriveste, UPDATE-ul nu afecteaza niciun rand — NU se scade
// edits_used a doua oara. GREATEST(...,0) e o plasa de siguranta suplimentara, sa nu
// scada niciodata sub zero chiar si intr-un scenariu neprevazut.
//
// O generare INITIALA (nu o regenerare) are intotdeauna edit_reserved=false, deci un
// esec la generarea initiala nu are ce sa restituie — apelul e un no-op sigur.
// ==================================================================================
async function refundEditIfReserved(orderId) {
  const result = await pool.query(
    `UPDATE orders
     SET edits_used = GREATEST(edits_used - 1, 0), edit_reserved = false
     WHERE id = $1 AND edit_reserved = true
     RETURNING *`,
    [orderId]
  );
  return rowToOrder(result.rows[0]); // null daca nu era nimic de restituit (deja restituita, sau generare initiala)
}

// mapare camelCase (folosit in restul aplicatiei) -> nume coloana in DB,
// ca sa putem construi un UPDATE dinamic dintr-un obiect partial (patch)
const COLUMN_MAP = {
  status: 'status',
  editsUsed: 'edits_used',
  variants: 'variants',
  selectedVariantId: 'selected_variant_id',
  musicTaskId: 'music_task_id',
  error: 'error',
  generatedAt: 'generated_at',
  paidAt: 'paid_at',
  customerCountry: 'customer_country',
  paymentCurrency: 'payment_currency',
  amountTotal: 'amount_total',
  taxAmount: 'tax_amount',
  stripeSessionId: 'stripe_session_id',
  stripePaymentIntentId: 'stripe_payment_intent_id',
  regenerateSourceVariantId: 'regenerate_source_variant_id',
  editReserved: 'edit_reserved',
  voicePreference: 'voice_preference'
};

async function updateOrder(id, patch) {
  const keys = Object.keys(patch).filter(k => COLUMN_MAP[k]);
  if (keys.length === 0) return getOrderById(id);

  const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map(k => (k === 'variants' ? JSON.stringify(patch[k]) : patch[k]));

  const result = await pool.query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rowToOrder(result.rows[0]);
}

async function listOrders() {
  const result = await pool.query(`SELECT * FROM orders ORDER BY created_at DESC`);
  return result.rows.map(rowToOrder);
}

async function computeRevenue() {
  const result = await pool.query(`SELECT COALESCE(SUM(price), 0) AS total FROM orders WHERE status = 'ready'`);
  return Number(result.rows[0].total);
}

// ==================================================================================
// TESTIMONIALS — reactii clienti, gestionate exclusiv din panoul de admin
// ==================================================================================

function rowToTestimonial(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    location: row.location,
    quote: row.quote,
    mediaType: row.media_type,
    mediaPath: row.media_path,
    published: row.published,
    displayOrder: row.display_order,
    consentConfirmed: row.consent_confirmed,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createTestimonial(t) {
  // noua reactie intra la finalul listei (cel mai mare display_order + 1)
  const maxRes = await pool.query(`SELECT COALESCE(MAX(display_order), -1) AS max_order FROM testimonials`);
  const nextOrder = Number(maxRes.rows[0].max_order) + 1;

  const result = await pool.query(
    `INSERT INTO testimonials
      (id, first_name, location, quote, media_type, media_path, published, display_order, consent_confirmed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [t.id, t.firstName, t.location || null, t.quote, t.mediaType, t.mediaPath || null, t.published, nextOrder, t.consentConfirmed]
  );
  return rowToTestimonial(result.rows[0]);
}

async function getTestimonialById(id) {
  const result = await pool.query(`SELECT * FROM testimonials WHERE id = $1`, [id]);
  return rowToTestimonial(result.rows[0]);
}

const TESTIMONIAL_COLUMN_MAP = {
  firstName: 'first_name',
  location: 'location',
  quote: 'quote',
  mediaType: 'media_type',
  mediaPath: 'media_path',
  published: 'published',
  displayOrder: 'display_order',
  consentConfirmed: 'consent_confirmed'
};

async function updateTestimonial(id, patch) {
  const keys = Object.keys(patch).filter(k => TESTIMONIAL_COLUMN_MAP[k]);
  if (keys.length === 0) return getTestimonialById(id);

  const setClauses = keys.map((k, i) => `${TESTIMONIAL_COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map(k => patch[k]);

  const result = await pool.query(
    `UPDATE testimonials SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rowToTestimonial(result.rows[0]);
}

async function deleteTestimonial(id) {
  const result = await pool.query(`DELETE FROM testimonials WHERE id = $1 RETURNING *`, [id]);
  return rowToTestimonial(result.rows[0]);
}

async function listAllTestimonials() {
  const result = await pool.query(`SELECT * FROM testimonials ORDER BY display_order ASC`);
  return result.rows.map(rowToTestimonial);
}

async function listPublishedTestimonials(limit) {
  const result = await pool.query(
    `SELECT * FROM testimonials WHERE published = true ORDER BY display_order ASC LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToTestimonial);
}

// interschimba display_order intre o reactie si vecina ei (sus/jos), pentru reordonare manuala
async function moveTestimonial(id, direction) {
  const current = await getTestimonialById(id);
  if (!current) return null;

  const comparator = direction === 'up' ? '<' : '>';
  const orderDirection = direction === 'up' ? 'DESC' : 'ASC';

  const neighborRes = await pool.query(
    `SELECT * FROM testimonials WHERE display_order ${comparator} $1 ORDER BY display_order ${orderDirection} LIMIT 1`,
    [current.displayOrder]
  );
  const neighbor = rowToTestimonial(neighborRes.rows[0]);
  if (!neighbor) return current; // deja la capat, nimic de miscat

  await pool.query(`UPDATE testimonials SET display_order = $1 WHERE id = $2`, [neighbor.displayOrder, current.id]);
  await pool.query(`UPDATE testimonials SET display_order = $1 WHERE id = $2`, [current.displayOrder, neighbor.id]);

  return getTestimonialById(id);
}

module.exports = {
  pool, initDb, createOrder, getOrderById, getOrderByToken, getOrderByMusicTaskId,
  claimOrderForProviderFinalization, claimOrderForRegeneration, refundEditIfReserved,
  updateOrder, listOrders, computeRevenue,
  createTestimonial, getTestimonialById, updateTestimonial, deleteTestimonial,
  listAllTestimonials, listPublishedTestimonials, moveTestimonial
};
