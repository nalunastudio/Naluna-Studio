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
    error: row.error,
    createdAt: row.created_at,
    generatedAt: row.generated_at,
    paidAt: row.paid_at
  };
}

async function createOrder(order) {
  const result = await pool.query(
    `INSERT INTO orders
      (id, access_token, occasion, recipient, email, story, genre, plan, price, lang, status, edits_used, variants, selected_variant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      order.id, order.accessToken, order.occasion, order.recipient, order.email,
      order.story, order.genre, order.plan, order.price, order.lang,
      order.status, order.editsUsed, JSON.stringify(order.variants || []), order.selectedVariantId
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

// mapare camelCase (folosit in restul aplicatiei) -> nume coloana in DB,
// ca sa putem construi un UPDATE dinamic dintr-un obiect partial (patch)
const COLUMN_MAP = {
  status: 'status',
  editsUsed: 'edits_used',
  variants: 'variants',
  selectedVariantId: 'selected_variant_id',
  error: 'error',
  generatedAt: 'generated_at',
  paidAt: 'paid_at'
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
  pool, initDb, createOrder, getOrderById, getOrderByToken,
  updateOrder, listOrders, computeRevenue,
  createTestimonial, getTestimonialById, updateTestimonial, deleteTestimonial,
  listAllTestimonials, listPublishedTestimonials, moveTestimonial
};
