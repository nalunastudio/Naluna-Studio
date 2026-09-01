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
const { randomUUID } = require('crypto');

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
  // FARA index explicit pe access_token: constraintul UNIQUE de mai sus (access_token TEXT
  // UNIQUE NOT NULL) creeaza deja automat un index btree unic pe aceasta coloana
  // (orders_access_token_key) — un al doilea index explicit pe aceeasi coloana ar fi pur
  // redundant (dublu cost de scriere la fiecare INSERT/UPDATE, fara niciun beneficiu la
  // citire). DROP IF EXISTS, idempotent, curata si instalarile mai vechi care il au deja.
  await pool.query(`DROP INDEX IF EXISTS idx_orders_access_token;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);

  // ALTER separat (nu doar in CREATE TABLE) — ca baza de date sa se actualizeze corect
  // si pentru instalari deja existente, unde tabela orders exista deja fara aceasta coloana
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS music_task_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_music_task_id ON orders(music_task_id);`);

  // HOTFIX 2026-08-07 — regula finala a pachetelor: Premium/Video cer DOUA genuri muzicale
  // diferite, alese explicit de client, transformate in DOUA cereri SEPARATE catre Suno
  // (fiecare cu propriul style prompt) — nu mai e "un singur apel, doua piese ale ACELUIASI
  // prompt". music_task_id_2/genre2 raman NULL pentru Standard (o singura melodie, un singur
  // gen) si pentru comenzile vechi dinainte de aceasta relansare — tratate optional peste tot
  // (compatibilitate, vezi rowToOrder si finalizeVariantsIfNeeded).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS music_task_id_2 TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS genre2 TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_music_task_id_2 ON orders(music_task_id_2);`);

  // Problema 1 (hotfix 2026-08-07): procentul numeric de generare disparuse — clientul avea
  // impresia ca pagina s-a blocat. generation_phase/generation_phase_percent reflecta
  // milestone-uri REALE (job trimis, furnizorul proceseaza, primul stream, finalizare,
  // gata), niciodata un timer artificial. Vezi recordGenerationProgress in server.js.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_phase TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_phase_percent INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_phase_updated_at TIMESTAMPTZ;`);

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
  // "Pentru bunica sau bunicul" (ULTIMELE MODIFICĂRI STRICTE, hotfix 2026-08-08) — 'grandmother'
  // sau 'grandfather', obligatoriu DOAR pentru occasion='bunici' (validat la POST /api/orders),
  // null pentru orice alta ocazie/comanda veche.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS grandparent_type TEXT;`);

  // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): sistem generalizat de relatii
  // de familie/nunta-botez, care inlocuieste/extinde tiparul ingust "grandparent_type" de mai
  // sus (pastrat neschimbat, nefolosit pentru comenzi noi, doar pentru comenzile create in
  // fereastra scurta cat a fost singura relatie disponibila). Toate coloanele sunt NULLABLE —
  // migrare aditiva, comenzile vechi raman valide cu aceste campuri goale (NULL).
  // recipient_role: relatia DESTINATARULUI, aleasa explicit de client, NICIODATA dedusa din
  // nume/voce — 'grandmother'|'grandfather'|'mother'|'father'|'aunt'|'uncle'|'mother_in_law'|
  // 'father_in_law' pentru ocaziile de familie (si pentru 'aniversare' cand clientul alege o
  // relatie in loc de "Alta persoana"), sau una din cele 9 valori de nunta/botez
  // ('groom'|'bride'|'couple'|'godson'|'goddaughter'|'godchildren'|'godfather'|'godmother'|
  // 'godparents') pentru occasion='nunta'. Vezi server.js, ALLOWED_RECIPIENT_ROLES.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_role TEXT;`);
  // sender_role: relatia persoanei care OFERA melodia fata de destinatar — 'daughter'|'son'|
  // 'granddaughter'|'grandson'|'niece'|'nephew'|'daughter_in_law'|'son_in_law' pentru relatiile
  // de familie, sau aceleasi 9 valori de nunta/botez + 'other' pentru occasion='nunta'.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_role TEXT;`);
  // recipient_mode: 'single'|'both' — relevant DOAR pentru occasion='nunta' (Miri/Fini/Nasi
  // pot fi un singur nume sau "Amandoi"). NULL pentru orice alta ocazie.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_mode TEXT;`);
  // recipient_names: {name1, name2} — populat DOAR cand recipient_mode='both' (doua nume
  // distincte, niciodata combinate intr-un singur camp). NULL in rest; coloana `recipient`
  // existenta ramane sursa unica pentru orice alt caz (inclusiv un string combinat afisabil,
  // ex. "Maria si Andrei", generat de frontend cand recipient_mode='both').
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_names JSONB;`);
  // wedding_type: 'wedding'|'baptism' — OBLIGATORIU pentru occasion='nunta' (validat strict la
  // POST /api/orders), NULL pentru orice alta ocazie SI pentru comenzile de nunta create INAINTE
  // de aceasta coloana (fereastra scurta cat "Nuntă/Botez" nu distingea explicit intre cele
  // doua — vezi buildPrompt in server.js pentru fallback-ul defensiv pe acele comenzi vechi).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS wedding_type TEXT;`);

  // MODIFICARE STRICTĂ — fluxul pachetului Premium £25 (hotfix 2026-08-09, CORECȚIE STRICTĂ
  // 2026-08-10): a doua melodie (genre2) poate fi acum pentru o OCAZIE si un destinatar DIFERITE
  // de primele, alese pe un ecran dedicat ("Configurează a doua melodie"), care reutilizeaza
  // ÎNTREAGA pagina de ocazie (toate cele 13 optiuni, exact aceleasi reguli). Toate coloanele
  // sunt NULLABLE, populate STRICT server-side DOAR pentru plan='premium' cu alegerea explicita
  // "Pentru altă persoană" (validat la POST /api/orders) — NULL pentru Standard, pentru Video
  // (flux neschimbat, ambele melodii raman pentru aceeasi ocazie/destinatar ca inainte) si
  // pentru Premium cu "Aceeași persoană" (a doua melodie foloseste direct occasion/recipient/
  // recipientRole/senderRole/recipientMode/recipientNames/weddingType de mai sus, neschimbate).
  // song2_target: 'same'|'other' — alegerea explicita a clientului, OBLIGATORIE pentru
  // plan='premium', niciodata implicita.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS song2_target TEXT;`);
  // occasion_2: ocazia celei de-a doua melodii — oricare din ALLOWED_OCCASIONS (server.js),
  // aleasa independent de occasion-ul comenzii (clientul poate alege orice ocazie pentru a doua
  // melodie, ex. "bunici", chiar daca prima melodie e pentru occasion='parinti').
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS occasion_2 TEXT;`);
  // recipient_role_2: relatia celei de-a doua persoane — orice valoare din
  // FAMILY_OCCASION_RECIPIENT_ROLES[occasion_2] sau, pentru occasion_2='nunta', una din cele 9
  // valori de nunta/botez — NULL pentru ocaziile generice (fara relatie structurata).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_role_2 TEXT;`);
  // sender_role_2: relatia expeditorului fata de a doua persoana — "Tu ești: ..." — populat DOAR
  // cand occasion_2 e o ocazie de familie CARE are acest concept (nu si pentru 'frati').
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_role_2 TEXT;`);
  // recipient_mode_2: 'single'|'both' — 'both' DOAR daca recipient_role_2 e in FAMILY_BOTH_ROLES
  // sau in WEDDING_RECIPIENT_ROLES_BOTH (dupa caz).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_mode_2 TEXT;`);
  // recipient_names_2: {name1, name2} — populat DOAR cand recipient_mode_2='both'.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_names_2 JSONB;`);
  // recipient_2: numele complet (sau numele combinate afisabile, la "Amândoi") ale celei de-a
  // doua persoane — analog coloanei `recipient` existente, dar STRICT pentru a doua melodie.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_2 TEXT;`);
  // wedding_type_2: 'wedding'|'baptism' — OBLIGATORIU DOAR cand occasion_2='nunta'.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS wedding_type_2 TEXT;`);

  // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2 (Premium, "Pentru altă
  // persoană"): pana acum, senderName/relationship/story erau GLOBALE — a doua melodie folosea
  // mereu povestea/expeditorul/relatia primei melodii, chiar daca destinatarul era complet
  // diferit (ex. melodia 2 pentru bunica ar fi folosit din greseala povestea despre nași).
  // Aceste trei coloane noi permit separarea COMPLETA a datelor celor doua melodii — populate
  // STRICT cand plan='premium' SI song2Target='other' (vezi POST /api/orders), NULL in orice
  // alt caz (Standard/Video neatinse, sau Premium cu "Pentru aceeași persoană").
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_name_2 TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS relationship_2 TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS story_2 TEXT;`);

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

  // uploaded_media: fotografii/videoclipuri incarcate de client pentru pachetul "video"
  // (vezi POST /api/orders/:orderId/media) — array JSON, fiecare element
  // {key, type: 'photo'|'video', section: string|null}. NICIODATA in bucket-ul public —
  // amintiri personale ale clientului, la fel de private ca melodia completa. section
  // ramane null daca clientul nu organizeaza manual (server-ul distribuie automat).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS uploaded_media JSONB NOT NULL DEFAULT '[]'::jsonb;`);

  // ==================================================================================
  // RELANSARE "CADOU VIDEO" (2026-08-06) — separa explicit starea materialelor, a
  // randarii video si a platii, in loc sa suprascarca semantica lui `status` (care
  // ramane, neschimbat, pentru ciclul de generare a melodiei: draft/generating/
  // processing_provider_result/preview_ready/generation_failed/ready). Coloane noi,
  // toate aditive si NULL/DEFAULT sigure pentru comenzile existente — nicio comanda
  // veche nu se rupe, pur si simplu nu are inca aceste campuri populate.
  //
  // media_confirmed_at: momentul in care clientul a confirmat explicit selectia de
  // materiale (POST /api/orders/:orderId/media/confirm) — DUPA aceasta, si NUMAI dupa
  // aceasta, poate porni generarea melodiei pentru pachetul "video" (vezi POST /generate).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS media_confirmed_at TIMESTAMPTZ;`);

  // video_render_claimed_at / video_render_variant_id: rezervare ATOMICA, persistenta
  // in Postgres, pentru randarea videoclipului cu memorii — inlocuieste garda anterioara
  // `activeVideoRenders` (un Set doar in memoria procesului Node), care nu proteja
  // impotriva a doua randari simultane daca Railway ar rula vreodata mai multe instante.
  // Lock-ul expira automat dupa 20 minute (vezi db.claimVideoRender) — daca procesul
  // pica la mijlocul unei randari, comanda nu ramane blocata permanent.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_render_claimed_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_render_variant_id TEXT;`);

  // video_stale_reason: NULL = videoclipul curent (daca exista) e valabil pentru
  // varianta audio selectata acum. Se seteaza explicit ('song_regenerated' sau
  // 'variant_changed') exact in momentul in care clientul schimba varianta audio sau
  // cere o editare a melodiei DUPA ce un videoclip fusese deja gata — semnal clar,
  // persistent, ca videoclipul anterior nu mai poate fi livrat/platit, chiar daca
  // fisierul lui ramane inca in storage (pastrat pentru rollback, nu sters imediat).
  // Se sterge (NULL) cand un videoclip nou, pentru varianta curenta, devine gata.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_stale_reason TEXT;`);

  // ==================================================================================
  // RELANSARE 2026-08-06 (partea 2) — reparatii de concurenta/versionare descoperite
  // dupa revizia initiala. Toate coloanele de mai jos sunt aditive, NULL/DEFAULT sigure.
  //
  // media_revision: contor care creste la FIECARE mutatie a materialelor (upload/
  // stergere/reordonare/schimbare sectiune) — vezi db.mutateOrderMediaAtomically().
  // Nu identifica DOAR "ce s-a schimbat", ci serveste ca token de concurenta optimista:
  // orice job (randare video) sau sesiune de plata pornita pentru o anumita revizie
  // devine detectabil ca STALE daca media_revision a mai crescut intre timp.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS media_revision INTEGER NOT NULL DEFAULT 0;`);

  // video_render_media_revision: media_revision EXACT in momentul in care randarea video
  // curenta a fost rezervata (vezi db.claimVideoRender) — impreuna cu video_render_variant_id,
  // formeaza cheia completa de versiune a randarii active. Un rezultat care se intoarce
  // dupa ce media_revision a crescut intre timp (clientul a mai modificat materialele cat
  // randarea era in curs) NU mai e acceptat ca rezultat valid — vezi triggerVideoGeneration.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_render_media_revision INTEGER;`);

  // checkout_session_id / checkout_variant_id / checkout_media_revision: "amprenta"
  // EXACTA a sesiunii Stripe Checkout create ultima — varianta audio, revizia materialelor
  // si sesiunea insasi, toate salvate ATOMIC in acelasi moment (vezi POST /checkout).
  // La webhook, livrarea se face DOAR daca aceasta amprenta inca se potriveste cu starea
  // curenta a comenzii — o sesiune veche (client a schimbat varianta/materialele dupa ce
  // a deschis checkout-ul, apoi incearca sa plateasca vechiul link) nu mai poate debloca
  // sau livra o versiune care nu mai e cea aprobata.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_session_id TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_variant_id TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_media_revision INTEGER;`);

  // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva + comparare finala (hotfix
  // 2026-08-10 runda 3). Premium poate acum edita o melodie, cealalta, sau ambele intr-o
  // SINGURA runda gratuita de editare — versiunile editate se ADAUGA alaturi de cele
  // initiale (niciodata nu le inlocuiesc), la fel ca la Standard (regenerate_keep_original),
  // dar pentru 1 SAU 2 melodii simultan. Clientul alege apoi explicit EXACT doua variante
  // (din cele 2-4 disponibile) inainte de plata — de aceea avem nevoie de un AL DOILEA slot
  // de selectie/amprenta Stripe, in oglinda cu cele deja existente pentru primul.
  //
  // regenerate_edit_variant_ids: JSONB, array cu 1-2 ID-uri de variante aflate in curs de
  // editare (setat DOAR pentru plan='premium', prin noul corp {songs:[...]} al POST
  // /regenerate) — semnaleaza reluarilor asincrone (callback SunoAPI, reluare polling dupa
  // restart) sa ADAUGE rezultatul ca alternativa noua, NICIODATA sa inlocuiasca varianta
  // sursa (vezi finalizeVariantsIfNeeded, options.editVariantIds). Absent/null pentru orice
  // alta regenerare (Standard/Video/Premium vechi) — comportamentul lor ramane neschimbat.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_edit_variant_ids JSONB;`);

  // selected_variant_id_2 / checkout_variant_id_2: oglinda EXACTA a selected_variant_id /
  // checkout_variant_id de mai sus, pentru A DOUA melodie aleasa la finalul comparatiei
  // Premium — NULL pentru orice alt pachet (Standard/Video folosesc STRICT campurile
  // singulare existente, neschimbate). Ambele trebuie completate (POST /select extins,
  // doar pentru premium) inainte ca POST /checkout sa accepte plata — vezi validarea acolo.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selected_variant_id_2 TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_variant_id_2 TEXT;`);

  // processed_stripe_events: dedup persistent, la nivel de eveniment Stripe individual
  // (event.id, ex. "evt_1Abc..."), NU doar la nivel de comanda. Garda existenta
  // (`status !== 'ready'` in handler-ul webhook-ului) ramane si ea — protejeaza corect
  // impotriva reincercarilor Stripe care ajung SECVENTIAL, dupa ce prima a fost deja
  // procesata. Tabela de mai jos acopera in plus fereastra teoretica de cursa in care
  // Stripe ar trimite (foarte rar, dar posibil) doua livrari ale ACELUIASI eveniment
  // aproape simultan: INSERT ... ON CONFLICT (event_id) DO NOTHING e o operatie atomica
  // unica in Postgres — a doua livrare gaseste deja randul si stie sigur ca nu mai are
  // nimic de procesat, indiferent de starea curenta a comenzii in acel moment exact.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_stripe_events (
      event_id TEXT PRIMARY KEY,
      order_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // LAUNCH SAFETY (2026-09-01, Faza 6 — bounce/complaint handling): dedup persistent la nivel
  // de eveniment Resend individual (svix-id), pe modelul EXACT verificat deja pentru webhook-ul
  // Stripe (processed_stripe_events, vezi comentariul de mai sus) — svix (biblioteca de semnare
  // folosita de Resend) poate reincerca livrarea aceluiasi eveniment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_resend_events (
      event_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // email_suppressions: adrese catre care NU mai trimitem automat, dupa un bounce PERMANENT
  // (email.bounced — Resend documenteaza explicit acest eveniment ca fiind STRICT respingere
  // permanenta, distinct de email.delivery_delayed pentru probleme temporare — deci NU
  // suprimam niciodata pe baza unei intarzieri temporare) sau o plangere de spam
  // (email.complained). `reason` retine STRICT valoarea evenimentului Resend care a declansat
  // suprimarea, pentru audit — niciodata inventata.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_suppressions (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

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

  // generation_attempts: contor DUR, NICIODATA restituit (spre deosebire de edits_used,
  // care are semantica de "editare gratuita" cu refund la esec) — protejeaza impotriva
  // consumului nelimitat de credite Suno prin reincercari repetate ale unei generari care
  // esueaza constant. Vezi credits.js, MAX_GENERATION_ATTEMPTS.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_attempts INTEGER NOT NULL DEFAULT 0;`);

  // regenerate_keep_original: HOTFIX 2026-08-08 — fluxul de editare Standard cu alegere.
  // Setat de POST /regenerate DOAR pentru Standard (o singura melodie, o singura varianta
  // inainte de editare): semnaleaza ca regenerarea in curs trebuie sa PASTREZE varianta
  // initiala ca alternativa (nu sa inlocuiasca intreg array-ul, cum se intampla implicit).
  // Persistat in DB (nu doar in memorie) pentru ca reluarile asincrone ale polling-ului
  // (resumeExistingTaskPolling, callback-ul SunoAPI) pot rula independent de cererea HTTP
  // originala — chiar si dupa un restart de server — si au nevoie sa afle aceasta intentie
  // din starea persistenta a comenzii, nu dintr-o variabila locala disparuta odata cu procesul.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_keep_original BOOLEAN NOT NULL DEFAULT false;`);

  // CORECȚIE (2026-08-30, "Mai veselă nu ajungea la furnizor" — Cadou video): feedback-ul liber
  // al clientului (POST /regenerate) traia STRICT ca argument in memorie, transmis fire-and-forget
  // catre runGeneration — daca procesul repornea intre rezervarea editarii si apelul catre
  // furnizor, instructiunea se pierdea definitiv, fara nicio urma. Persistat AICI, sincron,
  // INAINTE de a porni jobul asincron (acelasi tipar ca regenerate_source_variant_id de mai sus).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_feedback TEXT;`);

  // Progres de REGENERARE, SEPARAT complet de progresul generarii initiale (hotfix 2026-08-08,
  // "FINISAJ FINAL PACHET STANDARD"). Bug real gasit: generation_phase_percent era partajat
  // intre generarea initiala SI regenerare — o comanda ajunsa deja 100% (generare initiala)
  // facea ca updateGenerationPhaseIfLater sa respinga TACIT noul milestone "submitted"=10 al
  // regenerarii (10 < 100), lasand procentul inghetat la 100% pe tot parcursul regenerarii.
  // regeneration_job_id: identifica FIECARE incercare de regenerare in parte — reluarile
  // asincrone (resumeExistingTaskPolling, callback SunoAPI) si finalizarea scriu progresul
  // DOAR daca jobId-ul lor inca se potriveste cu cel curent al comenzii, altfel raspunsul e
  // considerat "vechi" (dintr-o incercare anterioara/abandonata) si ignorat silentios.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regeneration_job_id TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regeneration_status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regeneration_phase TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regeneration_progress INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS regeneration_updated_at TIMESTAMPTZ;`);

  // credit_events: jurnal complet al fiecarui apel real catre providerul de muzica (Suno),
  // plus fiecare blocare de generare/checkout facuta de sistemul de protectie a creditelor —
  // baza pentru statistici zilnice, estimarea comenzilor ramase si detectarea consumului
  // neobisnuit (vezi credits.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_events (
      id UUID PRIMARY KEY,
      order_id UUID,
      event_type TEXT NOT NULL,
      credits_spent NUMERIC,
      balance_after NUMERIC,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_events_created_at ON credit_events(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_events_order_id ON credit_events(order_id);`);

  // app_settings: setari simple cheie-valoare, persistente intre restarturi/redeploy-uri —
  // folosit in prezent doar pentru credit_baseline (valoarea de referinta 100% fata de care
  // se calculeaza pragurile de alerta 30/15/10/5%, vezi credits.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // credit_alert_state: rand SINGLETON (id fixat la 1) care tine starea "armat/dezarmat" a
  // alertei de prag fix de credite (implicit 248) — persistenta in Postgres, NICIODATA doar
  // in memorie, ca sa supravietuiasca restarturilor/redeploy-urilor Railway. "armed=true"
  // inseamna "nu am trimis inca alerta pentru scaderea curenta sub prag" — trecerea la
  // "armed=false" (si trimiterea alertei) se face ATOMIC, cu SELECT ... FOR UPDATE (vezi
  // db.claimCreditAlertTransition), ca doua comenzi finalizate simultan sa nu poata trimite
  // niciodata doua emailuri pentru aceeasi scadere sub prag.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_alert_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      armed BOOLEAN NOT NULL DEFAULT true,
      last_balance NUMERIC,
      last_alert_sent_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT credit_alert_state_singleton CHECK (id = 1)
    );
  `);
  await pool.query(`INSERT INTO credit_alert_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

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
    genre2: row.genre2 || null,
    generationPhase: row.generation_phase || null,
    generationPhasePercent: row.generation_phase_percent !== null && row.generation_phase_percent !== undefined ? Number(row.generation_phase_percent) : null,
    generationPhaseUpdatedAt: row.generation_phase_updated_at || null,
    regenerationJobId: row.regeneration_job_id || null,
    regenerationStatus: row.regeneration_status || null,
    regenerationPhase: row.regeneration_phase || null,
    regenerationProgress: row.regeneration_progress !== null && row.regeneration_progress !== undefined ? Number(row.regeneration_progress) : null,
    regenerationUpdatedAt: row.regeneration_updated_at || null,
    plan: row.plan,
    price: Number(row.price),
    lang: row.lang,
    status: row.status,
    editsUsed: row.edits_used,
    variants: row.variants || [],
    selectedVariantId: row.selected_variant_id,
    musicTaskId: row.music_task_id,
    musicTaskId2: row.music_task_id_2 || null,
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
    grandparentType: row.grandparent_type,
    recipientRole: row.recipient_role || null,
    senderRole: row.sender_role || null,
    recipientMode: row.recipient_mode || null,
    recipientNames: row.recipient_names || null,
    weddingType: row.wedding_type || null,
    // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09, CORECȚIE 2026-08-10):
    // configurarea celei de-a doua melodii, populata DOAR pentru plan='premium' cu "Pentru
    // altă persoană" — ocazie completa, nu doar destinatar.
    song2Target: row.song2_target || null,
    occasion2: row.occasion_2 || null,
    recipientRole2: row.recipient_role_2 || null,
    senderRole2: row.sender_role_2 || null,
    recipientMode2: row.recipient_mode_2 || null,
    recipientNames2: row.recipient_names_2 || null,
    recipient2: row.recipient_2 || null,
    weddingType2: row.wedding_type_2 || null,
    // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2: expeditorul, relația și
    // povestea PROPRII melodiei 2, complet separate de senderName/relationship/story (melodia 1).
    senderName2: row.sender_name_2 || null,
    relationship2: row.relationship_2 || null,
    story2: row.story_2 || null,
    regenerateSourceVariantId: row.regenerate_source_variant_id,
    regenerateKeepOriginal: !!row.regenerate_keep_original,
    regenerateFeedback: row.regenerate_feedback || null,
    editReserved: row.edit_reserved,
    // NULL (comenzi vechi, dinainte de aceasta coloana) devine 'auto' aici, o singura
    // data, central — restul aplicatiei (buildPrompt, API, comanda.html, melodia-mea.html)
    // nu mai trebuie sa trateze separat cazul NULL.
    voicePreference: row.voice_preference || 'auto',
    phone: row.phone || null,
    generationAttempts: row.generation_attempts || 0,
    uploadedMedia: row.uploaded_media || [],
    mediaConfirmedAt: row.media_confirmed_at || null,
    videoRenderClaimedAt: row.video_render_claimed_at || null,
    videoRenderVariantId: row.video_render_variant_id || null,
    videoStaleReason: row.video_stale_reason || null,
    mediaRevision: row.media_revision || 0,
    videoRenderMediaRevision: row.video_render_media_revision !== null && row.video_render_media_revision !== undefined ? Number(row.video_render_media_revision) : null,
    checkoutSessionId: row.checkout_session_id || null,
    checkoutVariantId: row.checkout_variant_id || null,
    checkoutMediaRevision: row.checkout_media_revision !== null && row.checkout_media_revision !== undefined ? Number(row.checkout_media_revision) : null,
    // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva + comparare finala (hotfix
    // 2026-08-10 runda 3).
    regenerateEditVariantIds: row.regenerate_edit_variant_ids || null,
    selectedVariantId2: row.selected_variant_id_2 || null,
    checkoutVariantId2: row.checkout_variant_id_2 || null
  };
}

async function createOrder(order) {
  const result = await pool.query(
    `INSERT INTO orders
      (id, access_token, occasion, recipient, email, story, genre, genre2, plan, price, lang, status, edits_used, variants, selected_variant_id, sender_name, relationship, voice_preference, phone, grandparent_type, recipient_role, sender_role, recipient_mode, recipient_names, wedding_type, song2_target, occasion_2, recipient_role_2, sender_role_2, recipient_mode_2, recipient_names_2, recipient_2, wedding_type_2, sender_name_2, relationship_2, story_2)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
     RETURNING *`,
    [
      order.id, order.accessToken, order.occasion, order.recipient, order.email,
      order.story, order.genre, order.genre2 || null, order.plan, order.price, order.lang,
      order.status, order.editsUsed, JSON.stringify(order.variants || []), order.selectedVariantId,
      order.senderName || null, order.relationship || null, order.voicePreference || 'auto',
      order.phone || null, order.grandparentType || null,
      order.recipientRole || null, order.senderRole || null, order.recipientMode || null,
      order.recipientNames ? JSON.stringify(order.recipientNames) : null,
      order.weddingType || null,
      order.song2Target || null, order.occasion2 || null, order.recipientRole2 || null, order.senderRole2 || null, order.recipientMode2 || null,
      order.recipientNames2 ? JSON.stringify(order.recipientNames2) : null,
      order.recipient2 || null, order.weddingType2 || null,
      // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2.
      order.senderName2 || null, order.relationship2 || null, order.story2 || null
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

// La fel ca getOrderByMusicTaskId, dar cauta si in music_task_id_2 — necesar pentru
// Premium/Video, care fac DOUA cereri separate catre Suno (cate una per gen ales de
// client), deci callback-ul poate sosi pentru oricare din cele doua taskId-uri.
// Actualizeaza faza de generare DOAR daca procentul nou e MAI MARE decat cel deja salvat —
// evita ca un callback/poll intarziat, dintr-o etapa mai veche, sa suprascrie un progres deja
// mai avansat (ex. un "text" intarziat sosit dupa ce "complete" a ajuns deja). Best-effort,
// pur informativa pentru UI — nicio logica de business nu depinde de aceasta coloana.
async function updateGenerationPhaseIfLater(orderId, phase, percent) {
  await pool.query(
    `UPDATE orders SET generation_phase = $2, generation_phase_percent = $3, generation_phase_updated_at = now()
     WHERE id = $1 AND (generation_phase_percent IS NULL OR generation_phase_percent < $3)`,
    [orderId, phase, percent]
  );
}

// Porneste un job de REGENERARE nou — reseteaza explicit progresul la primul milestone (10%),
// NICIODATA mostenind procentul ramas de la generarea initiala sau de la o regenerare
// anterioara (vezi comentariul de la migrarea regeneration_* de mai sus). jobId e generat de
// apelant (randomUUID) si scris necondiționat aici — stabileste "jobul curent" fata de care
// toate scrierile ulterioare de progres se vor valida (updateRegenerationPhaseIfLater).
async function startRegenerationJob(orderId, jobId) {
  await pool.query(
    `UPDATE orders SET regeneration_job_id = $2, regeneration_status = 'running',
       regeneration_phase = 'submitted', regeneration_progress = 10, regeneration_updated_at = now()
     WHERE id = $1`,
    [orderId, jobId]
  );
}

// Simetric cu updateGenerationPhaseIfLater, dar cu o garda SUPLIMENTARA: jobId trebuie sa se
// potriveasca EXACT cu regeneration_job_id curent al comenzii. Fara aceasta garda, raspunsul
// intarziat al unui job vechi/abandonat (ex. reluarea polling-ului dupa un restart de server)
// ar putea suprascrie progresul unui job NOU, mai recent — cerinta explicita: "raspunsurile
// intarziate ale vechiului job nu pot modifica noul progres".
async function updateRegenerationPhaseIfLater(orderId, jobId, phase, percent) {
  await pool.query(
    `UPDATE orders SET regeneration_phase = $3, regeneration_progress = $4, regeneration_updated_at = now()
     WHERE id = $1 AND regeneration_job_id = $2
       AND (regeneration_progress IS NULL OR regeneration_progress < $4)`,
    [orderId, jobId, phase, percent]
  );
}

// Marcheaza explicit rezultatul FINAL al unui job de regenerare ('ready' sau 'failed') —
// folosit de se-compune.html (in modul de regenerare) ca sa decida cand sa redirectioneze
// clientul, respectiv cand sa arate starea de eroare cu buton de reincercare. La fel ca mai
// sus, scrie DOAR daca jobId-ul inca se potriveste cu cel curent.
async function markRegenerationStatus(orderId, jobId, status) {
  await pool.query(
    `UPDATE orders SET regeneration_status = $3, regeneration_updated_at = now()
     WHERE id = $1 AND regeneration_job_id = $2`,
    [orderId, jobId, status]
  );
}

async function getOrderByAnyMusicTaskId(taskId) {
  const result = await pool.query(
    `SELECT * FROM orders WHERE music_task_id = $1 OR music_task_id_2 = $1`,
    [taskId]
  );
  return rowToOrder(result.rows[0]);
}

// LAUNCH SAFETY (2026-09-01, "risc de pierdere a comenzilor"): la o repornire a serverului
// (deploy Railway) exact in mijlocul unui polling Suno, reluarea era pana acum STRICT reactiva
// — necesita ca clientul sa revina chiar pe se-compune.html, singura pagina care re-declanseaza
// resumeExistingTaskPolling/resumeDualTaskPolling. Daca inchide tab-ul definitiv (asteapta doar
// emailul) si repornirea a picat exact in acea fereastra, comanda ramanea 'generating' la
// nesfarsit, fara nicio reluare automata, indiferent daca era o generare initiala GRATUITA sau
// o REGENERARE deja PLATITA. Folosita la pornirea serverului (vezi finalul acestui fisier) —
// gaseste STRICT comenzile cu un task Suno real, deja pornit, dar niciodata finalizat.
async function getStuckInFlightOrders() {
  const result = await pool.query(
    `SELECT * FROM orders WHERE status IN ('generating', 'processing_provider_result') AND music_task_id IS NOT NULL`
  );
  return result.rows.map(rowToOrder);
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
async function claimOrderForRegeneration(orderId, maxEdits, voicePreference, maxAttempts) {
  const result = await pool.query(
    `UPDATE orders
     SET status = 'generating',
         edits_used = edits_used + 1,
         edit_reserved = true,
         generation_attempts = generation_attempts + 1,
         voice_preference = COALESCE($3, voice_preference)
     WHERE id = $1
       AND status NOT IN ('generating', 'processing_provider_result', 'ready')
       AND edits_used < $2
       AND generation_attempts < $4
     RETURNING *`,
    [orderId, maxEdits, voicePreference || null, maxAttempts]
  );
  return rowToOrder(result.rows[0]); // null daca deja in curs, deja platita, limita de editari SAU limita de incercari atinsa
}

// ==================================================================================
// PRELUARE ATOMICA pentru generarea INITIALA (prima generare gratuita a unei comenzi).
// Foloseste generation_attempts (contor DUR, niciodata restituit — vezi comentariul
// coloanei in initDb) ca plasa de siguranta impotriva reincercarilor nelimitate ale
// unei generari care esueaza constant (fiecare incercare reala catre Suno consuma
// credite reale, indiferent de rezultat — vezi credits.js). Verificarile de status
// facute deja in ruta /generate raman ca prima linie de aparare; asta e a doua,
// atomica, la nivel de baza de date.
// ==================================================================================
async function claimOrderForInitialGeneration(orderId, maxAttempts) {
  const result = await pool.query(
    `UPDATE orders
     SET status = 'generating',
         generation_attempts = generation_attempts + 1
     WHERE id = $1
       AND status NOT IN ('generating', 'processing_provider_result', 'ready')
       AND generation_attempts < $2
     RETURNING *`,
    [orderId, maxAttempts]
  );
  return rowToOrder(result.rows[0]); // null daca deja in curs, deja platita, sau limita de incercari atinsa
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

// ==================================================================================
// PRELUARE ATOMICA, PERSISTENTA IN POSTGRES, a randarii videoclipului cu memorii —
// inlocuieste garda anterioara bazata pe un Set in memoria procesului Node (sigura doar
// pe o singura instanta a serverului). UPDATE ... WHERE ... RETURNING e o singura
// instructiune atomica: doua cereri "simultane" (dublu-click, retry, sau doua instante
// separate ale serverului) sunt serializate de Postgres — doar una poate "castiga"
// tranzitia, cealalta gaseste deja un lock activ si nu returneaza niciun rand.
//
// Lock-ul expira SINGUR dupa 20 de minute (o randare video reala dureaza cateva minute,
// niciodata atat) — daca procesul pica la mijlocul unei randari, comanda nu ramane
// blocata permanent; o cerere ulterioara poate relua randarea in siguranta.
// ==================================================================================
// variantId + mediaRevision impreuna formeaza cheia COMPLETA de versiune a randarii —
// vezi comentariul coloanei video_render_media_revision in initDb(). Un apelant care
// termina o randare TREBUIE sa verifice, inainte sa scrie rezultatul, ca aceasta pereche
// se mai potriveste cu starea curenta a comenzii (vezi isVideoClaimStillCurrent mai jos).
async function claimVideoRender(orderId, variantId, mediaRevision) {
  const result = await pool.query(
    `UPDATE orders
     SET video_render_claimed_at = now(), video_render_variant_id = $2, video_render_media_revision = $3
     WHERE id = $1
       AND (video_render_claimed_at IS NULL OR video_render_claimed_at < now() - interval '20 minutes')
     RETURNING *`,
    [orderId, variantId, mediaRevision]
  );
  return rowToOrder(result.rows[0]); // null daca o randare e deja activa (lock neexpirat)
}

// Elibereaza lock-ul de randare video, INDIFERENT de rezultat (succes sau esec) — apelantul
// (generatePremiumExtras / triggerVideoGeneration in server.js) il apeleaza mereu intr-un
// bloc finally. Idempotent: eliberarea unui lock deja eliberat e un no-op sigur.
async function releaseVideoRender(orderId) {
  await pool.query(
    `UPDATE orders SET video_render_claimed_at = NULL, video_render_variant_id = NULL, video_render_media_revision = NULL WHERE id = $1`,
    [orderId]
  );
}

// Adevarat DOAR daca (variantId, mediaRevision) date inca reprezinta varianta/materialele
// CURENTE ale comenzii — apelat DUPA ce o randare video (posibil lunga, minute intregi) s-a
// terminat, INAINTE de a scrie rezultatul ei peste variants[]. Daca clientul a schimbat
// varianta sau a modificat materialele cat randarea era in desfasurare, rezultatul vechi
// e aruncat (nu se scrie videoKey), iar apelantul (triggerVideoGeneration) porneste o
// randare noua pentru versiunea curenta.
async function isVideoClaimStillCurrent(orderId, variantId, mediaRevision) {
  const order = await getOrderById(orderId);
  if (!order) return false;
  return order.selectedVariantId === variantId && order.mediaRevision === mediaRevision;
}

// ==================================================================================
// MUTATIE ATOMICA a materialelor comenzii (upload/stergere/reordonare/schimbare sectiune) —
// SELECT ... FOR UPDATE blocheaza randul comenzii pe durata tranzactiei: doua mutatii
// "simultane" (ex. doua fisiere din acelasi upload, sau un upload si o stergere aproape
// concomitente) sunt serializate de Postgres, niciodata procesate pe baza aceleiasi citiri
// "vechi" — elimina exact cursa in care a doua scriere suprascrie complet prima.
//
// `mutatorFn(currentOrder)` primeste comanda CURENTA (citita sub lock, garantat proaspata)
// si trebuie sa returneze fie:
//   - un obiect patch, ex. { uploadedMedia: [...], mediaConfirmedAt: null }, aplicat atomic
//     impreuna cu incrementarea media_revision si invalidarea video (vezi mai jos);
//   - `null`, pentru a abandona mutatia fara nicio scriere (ex. ar depasi limita maxima).
//
// Orice mutatie reusita: creste media_revision cu 1, sterge media_confirmed_at (clientul
// trebuie sa reconfirme selectia dupa orice schimbare), si — daca varianta audio SELECTATA
// ACUM are deja un videoKey — marcheaza explicit video_stale_reason='media_changed'.
// ==================================================================================
// Confirma selectia de materiale sub acelasi lock de rand (SELECT ... FOR UPDATE) — vede
// numarul REAL de materiale, niciodata unul citit inainte ca un upload concurent sa se
// termine (ex. clientul apasa "Continuă" chiar in clipa in care ultimul fisier din batch
// tocmai a fost confirmat de server, dar raspunsul HTTP inca nu a ajuns la client).
async function confirmMediaSelection(orderId, minItems, maxItems) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const current = rowToOrder(rows[0]);
    if (!current) return { ok: false, count: 0 };
    const count = (current.uploadedMedia || []).length;
    if (count < minItems || count > maxItems) return { ok: false, count };
    const result = await client.query(`UPDATE orders SET media_confirmed_at = now() WHERE id = $1 RETURNING *`, [orderId]);
    return { ok: true, order: rowToOrder(result.rows[0]) };
  });
}

async function mutateOrderMediaAtomically(orderId, mutatorFn) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const current = rowToOrder(rows[0]);
    if (!current) return { ok: false, reason: 'not_found', order: null };

    const patch = mutatorFn(current);
    if (!patch) return { ok: false, reason: 'rejected', order: current };

    const selectedVariant = (current.variants || []).find(v => v.id === current.selectedVariantId);
    const currentVideoIsReady = !!(selectedVariant && selectedVariant.videoKey);

    const setClauses = ['media_revision = media_revision + 1', 'media_confirmed_at = NULL'];
    const values = [orderId];
    let i = 2;
    if (Object.prototype.hasOwnProperty.call(patch, 'uploadedMedia')) {
      setClauses.push(`uploaded_media = $${i}`);
      values.push(JSON.stringify(patch.uploadedMedia));
      i++;
    }
    if (currentVideoIsReady) {
      setClauses.push(`video_stale_reason = 'media_changed'`);
    }

    const result = await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    return { ok: true, order: rowToOrder(result.rows[0]) };
  });
}

// ==================================================================================
// DEDUP ATOMIC, la nivel de eveniment Stripe individual (event.id) — vezi comentariul
// coloanei/tabelei processed_stripe_events in initDb() pentru motivul exact. Foloseste
// INSERT ... ON CONFLICT DO NOTHING: primul apel pentru un event_id dat insereaza randul
// si returneaza true (eveniment nou, de procesat); orice apel ulterior pentru ACELASI
// event_id gaseste conflictul, nu insereaza nimic, returneaza false (deja procesat).
//
// Folosita de fluxuri care NU scriu si starea comenzii in acelasi pas (ex.
// checkout.session.async_payment_failed, care doar logheaza/notifica). Pentru evenimente
// care SI marcheaza comanda platita, vezi recordPaidOrderAtomically() mai jos — acolo
// dedup-ul si actualizarea comenzii sunt in ACEEASI tranzactie, nu doua operatii separate.
// ==================================================================================
async function recordStripeEventIfNew(eventId, orderId) {
  const result = await pool.query(
    `INSERT INTO processed_stripe_events (event_id, order_id) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, orderId || null]
  );
  return result.rows.length > 0; // true = eveniment nou (de procesat), false = deja procesat
}

// LAUNCH SAFETY (2026-09-01, Faza 6): acelasi tipar exact ca recordStripeEventIfNew de mai sus,
// pentru webhook-ul Resend (svix poate reincerca livrarea aceluiasi eveniment).
async function recordResendEventIfNew(eventId) {
  const result = await pool.query(
    `INSERT INTO processed_resend_events (event_id) VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId]
  );
  return result.rows.length > 0;
}

async function addEmailSuppression(email, reason) {
  await pool.query(
    `INSERT INTO email_suppressions (email, reason) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()`,
    [email.toLowerCase().trim(), reason]
  );
}

async function isEmailSuppressed(email) {
  const result = await pool.query(
    `SELECT 1 FROM email_suppressions WHERE email = $1`,
    [String(email || '').toLowerCase().trim()]
  );
  return result.rows.length > 0;
}

// ==================================================================================
// PROCESARE ATOMICA a unui eveniment Stripe de plata reusita: dedup (processed_stripe_events)
// SI actualizarea comenzii (status='ready', paid_at, date de tranzactie) in ACEEASI
// tranzactie Postgres — vezi cerinta "D8. Fa procesarea Stripe atomica si recuperabila".
//
// De ce conteaza: daca am marca evenimentul procesat INAINTE sa stim ca actualizarea
// comenzii a reusit (cum era inainte — INSERT separat, apoi UPDATE separat), o eroare
// tranzitorie DB intre cele doua pasi ar lasa evenimentul "marcat procesat" DAR comanda
// neplatita — Stripe NU ar mai reincerca (crede ca am procesat cu succes), iar clientul
// ar ramane platit fara livrare, PERMANENT. Cu totul intr-o tranzactie: daca UPDATE-ul
// comenzii esueaza din orice motiv, ROLLBACK anuleaza si INSERT-ul de dedup — Stripe vede
// evenimentul ca neprocesat inca la urmatoarea livrare/retry, exact comportamentul corect.
//
// SELECT ... FOR UPDATE pe randul comenzii, in aceeasi tranzactie — daca doua evenimente
// (webhook retry + livrare originala aproape simultana) ar trece amandoua de dedup din
// motive improbabile, actualizarea comenzii tot ramane serializata corect.
//
// Returneaza:
//   { isNewEvent: false }                         — eveniment deja procesat, nimic de facut
//   { isNewEvent: true, order: null }              — eveniment nou, dar comanda nu exista
//   { isNewEvent: true, order, alreadyPaid: true } — eveniment nou, dar comanda era deja 'ready'
//   { isNewEvent: true, order }                    — eveniment nou, comanda actualizata cu succes
// ==================================================================================
async function recordPaidOrderAtomically(eventId, orderId, patch) {
  return withTransaction(async (client) => {
    const dedupRes = await client.query(
      `INSERT INTO processed_stripe_events (event_id, order_id) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, orderId || null]
    );
    if (dedupRes.rows.length === 0) return { isNewEvent: false };

    if (!orderId) return { isNewEvent: true, order: null };
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const current = rowToOrder(rows[0]);
    if (!current) return { isNewEvent: true, order: null };
    if (current.status === 'ready') return { isNewEvent: true, order: current, alreadyPaid: true };

    const keys = Object.keys(patch).filter(k => COLUMN_MAP[k]);
    const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
    const values = keys.map(k => ((k === 'variants' || k === 'uploadedMedia' || k === 'regenerateEditVariantIds') ? JSON.stringify(patch[k]) : patch[k]));
    const result = await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [orderId, ...values]
    );
    return { isNewEvent: true, order: rowToOrder(result.rows[0]) };
  });
}

// ==================================================================================
// SISTEM DE PROTECTIE A CREDITELOR — jurnal de evenimente + setari persistente.
// Vezi credits.js pentru logica de decizie (praguri, alerte, mod de urgenta);
// functiile de mai jos sunt strict acces la date, fara nicio logica de business.
// ==================================================================================
async function logCreditEvent({ orderId, eventType, creditsSpent, balanceAfter, note }) {
  await pool.query(
    `INSERT INTO credit_events (id, order_id, event_type, credits_spent, balance_after, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId || null, eventType, creditsSpent ?? null, balanceAfter ?? null, note || null]
  );
}

async function getCreditEventsSince(since) {
  const result = await pool.query(
    `SELECT * FROM credit_events WHERE created_at >= $1 ORDER BY created_at ASC`,
    [since]
  );
  return result.rows;
}

async function getSetting(key) {
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return result.rows[0] ? result.rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

// ==================================================================================
// TRANZITIE ATOMICA a alertei de prag fix de credite (implicit 248, vezi credits.js).
// SELECT ... FOR UPDATE blocheaza randul singleton pe durata tranzactiei — o a doua
// chemare concurenta (ex. doua generari care se termina aproape simultan, ambele sub
// prag) asteapta pana cand prima tranzactie face COMMIT, apoi vede STAREA DEJA ACTUALIZATA
// (armed=false), deci NU mai poate "castiga" ea insasi trimiterea alertei — exact
// mecanismul cerut explicit: o singura alerta per scadere sub prag, indiferent de cate
// comenzi se finalizeaza simultan chiar in acel moment.
//
// Returneaza intotdeauna previousBalance (valoarea dinainte de aceasta verificare) si
// action: 'send_alert' | 'suppressed' | 'rearmed' | 'none' — apelantul (credits.js)
// decide ce sa faca mai departe (trimite email doar la 'send_alert').
// ==================================================================================
async function claimCreditAlertTransition(currentBalance, threshold) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM credit_alert_state WHERE id = 1 FOR UPDATE');
    const state = rows[0];
    const previousBalance = state.last_balance !== null ? Number(state.last_balance) : null;
    const wasArmed = state.armed;

    if (currentBalance > threshold) {
      if (!wasArmed) {
        await client.query(
          `UPDATE credit_alert_state SET armed = true, last_balance = $1, updated_at = now() WHERE id = 1`,
          [currentBalance]
        );
        return { action: 'rearmed', previousBalance };
      }
      await client.query(`UPDATE credit_alert_state SET last_balance = $1, updated_at = now() WHERE id = 1`, [currentBalance]);
      return { action: 'none', previousBalance };
    }

    // currentBalance <= threshold
    if (wasArmed) {
      await client.query(
        `UPDATE credit_alert_state SET armed = false, last_balance = $1, last_alert_sent_at = now(), updated_at = now() WHERE id = 1`,
        [currentBalance]
      );
      return { action: 'send_alert', previousBalance };
    }
    await client.query(`UPDATE credit_alert_state SET last_balance = $1, updated_at = now() WHERE id = 1`, [currentBalance]);
    return { action: 'suppressed', previousBalance };
  });
}

async function getCreditAlertState() {
  const result = await pool.query('SELECT * FROM credit_alert_state WHERE id = 1');
  const row = result.rows[0];
  if (!row) return null;
  return {
    armed: row.armed,
    lastBalance: row.last_balance !== null ? Number(row.last_balance) : null,
    lastAlertSentAt: row.last_alert_sent_at
  };
}

// Comenzi FINALIZATE (platite, status='ready') din ultimele `days` zile — folosit pentru
// statisticile din emailul de alerta si din panoul admin. paid_at (nu created_at) e reperul
// corect: o comanda poate fi creata cu zile inainte sa fie efectiv platita.
async function getCompletedOrdersSince(days) {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE status = 'ready' AND paid_at >= now() - ($1 || ' days')::interval`,
    [days]
  );
  return result.rows[0].n;
}

// Media reala de credite consumate per comanda FINALIZATA (platita) — calculata din
// jurnalul real de evenimente (credit_events), nu din estimarea statica CREDITS_PER_ORDER_ESTIMATE.
// Mai precisa: reflecta cate comenzi platite chiar au folosit regenerarea gratuita.
async function getAverageCreditsPerCompletedOrder() {
  const result = await pool.query(`
    SELECT AVG(order_total)::numeric AS avg_credits, COUNT(*)::int AS order_count
    FROM (
      SELECT ce.order_id, SUM(ce.credits_spent) AS order_total
      FROM credit_events ce
      JOIN orders o ON o.id = ce.order_id
      WHERE ce.event_type = 'generation_attempt' AND o.status = 'ready'
      GROUP BY ce.order_id
    ) per_order
  `);
  const row = result.rows[0];
  return {
    averageCredits: row.avg_credits !== null ? Number(row.avg_credits) : null,
    sampleSize: row.order_count
  };
}

// mapare camelCase (folosit in restul aplicatiei) -> nume coloana in DB,
// ca sa putem construi un UPDATE dinamic dintr-un obiect partial (patch)
const COLUMN_MAP = {
  status: 'status',
  editsUsed: 'edits_used',
  variants: 'variants',
  selectedVariantId: 'selected_variant_id',
  musicTaskId: 'music_task_id',
  musicTaskId2: 'music_task_id_2',
  // HOTFIX 2026-08-08: 'genre' lipsea complet din aceasta mapare — genul era setat o
  // singura data la crearea comenzii (INSERT direct in createOrder) si niciodata considerat
  // "editabil" pana la cerinta noua de schimbare a genului la regenerare. db.updateOrder
  // filtreaza silentios orice cheie absenta din COLUMN_MAP (fara nicio eroare) — gasit direct
  // la testare reala pe staging: POST /regenerate raspundea "started:true" si regenerarea
  // chiar rula, dar db.updateOrder(id, {genre: nouGen}) era un no-op TACUT — runGeneration
  // (care reciteste comanda din DB imediat dupa) prelua tot vechiul order.genre, deci prompt-ul
  // trimis catre Suno folosea genul VECHI, nu cel ales de client, iar eticheta afisata clientului
  // ramanea la fel de gresita.
  genre: 'genre',
  genre2: 'genre2',
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
  regenerateKeepOriginal: 'regenerate_keep_original',
  regenerateFeedback: 'regenerate_feedback',
  editReserved: 'edit_reserved',
  voicePreference: 'voice_preference',
  generationAttempts: 'generation_attempts',
  uploadedMedia: 'uploaded_media',
  mediaConfirmedAt: 'media_confirmed_at',
  videoStaleReason: 'video_stale_reason',
  checkoutSessionId: 'checkout_session_id',
  checkoutVariantId: 'checkout_variant_id',
  checkoutMediaRevision: 'checkout_media_revision',
  // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva + comparare finala (hotfix
  // 2026-08-10 runda 3).
  regenerateEditVariantIds: 'regenerate_edit_variant_ids',
  selectedVariantId2: 'selected_variant_id_2',
  checkoutVariantId2: 'checkout_variant_id_2'
};

async function updateOrder(id, patch) {
  const keys = Object.keys(patch).filter(k => COLUMN_MAP[k]);
  if (keys.length === 0) return getOrderById(id);

  const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map(k => ((k === 'variants' || k === 'uploadedMedia' || k === 'regenerateEditVariantIds') ? JSON.stringify(patch[k]) : patch[k]));

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

// Helper de tranzactie, folosit de createTestimonial/moveTestimonial mai jos — ambele
// citesc o stare (MAX(display_order), respectiv vecinul curent) si apoi scriu pe baza
// acelei citiri, in pasi separati. Fara o tranzactie reala, doua actiuni concurente
// (doi admini, sau doua click-uri rapide) pot citi aceeasi stare "veche" inainte ca
// vreuna sa scrie, rezultand in valori duplicate/pierdute de display_order — reprodus
// empiric la verificare (8 creari concurente -> valori duplicate). LOCK TABLE ... IN
// SHARE ROW EXCLUSIVE MODE serializeaza scrierile concurente pe acest tabel (mic,
// folosit doar din admin) — cost neglijabil, corectitudine garantata.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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
  return withTransaction(async (client) => {
    await client.query('LOCK TABLE testimonials IN SHARE ROW EXCLUSIVE MODE');

    // noua reactie intra la finalul listei (cel mai mare display_order + 1) — citirea
    // MAX(display_order) si INSERT-ul ruleaza acum in aceeasi tranzactie, cu tabelul
    // blocat impotriva altor scrieri concurente intre cele doua.
    const maxRes = await client.query(`SELECT COALESCE(MAX(display_order), -1) AS max_order FROM testimonials`);
    const nextOrder = Number(maxRes.rows[0].max_order) + 1;

    const result = await client.query(
      `INSERT INTO testimonials
        (id, first_name, location, quote, media_type, media_path, published, display_order, consent_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [t.id, t.firstName, t.location || null, t.quote, t.mediaType, t.mediaPath || null, t.published, nextOrder, t.consentConfirmed]
    );
    return rowToTestimonial(result.rows[0]);
  });
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

// interschimba display_order intre o reactie si vecina ei (sus/jos), pentru reordonare manuala.
// Citirea vecinului si cele doua UPDATE-uri de swap ruleaza acum intr-o singura tranzactie
// (tabelul blocat pe durata ei) — fara asta, doua reordonari concurente puteau citi acelasi
// vecin "vechi" inainte ca vreuna sa scrie, rezultand valori duplicate de display_order
// (reprodus empiric la verificare: 8 randuri, 7 valori unice dupa reordonari concurente).
async function moveTestimonial(id, direction) {
  return withTransaction(async (client) => {
    // Lock-ul se ia INAINTE de orice citire (nu doar inainte de vecin) — altfel ramane o
    // fereastra intre citirea lui "current" si obtinerea lock-ului in care o alta tranzactie
    // concurenta ar putea inca citi aceeasi stare veche.
    await client.query('LOCK TABLE testimonials IN SHARE ROW EXCLUSIVE MODE');

    const currentRes = await client.query(`SELECT * FROM testimonials WHERE id = $1`, [id]);
    const current = rowToTestimonial(currentRes.rows[0]);
    if (!current) return null;

    const comparator = direction === 'up' ? '<' : '>';
    const orderDirection = direction === 'up' ? 'DESC' : 'ASC';

    const neighborRes = await client.query(
      `SELECT * FROM testimonials WHERE display_order ${comparator} $1 ORDER BY display_order ${orderDirection} LIMIT 1`,
      [current.displayOrder]
    );
    const neighbor = rowToTestimonial(neighborRes.rows[0]);
    if (!neighbor) return current; // deja la capat, nimic de miscat

    await client.query(`UPDATE testimonials SET display_order = $1 WHERE id = $2`, [neighbor.displayOrder, current.id]);
    await client.query(`UPDATE testimonials SET display_order = $1 WHERE id = $2`, [current.displayOrder, neighbor.id]);

    const finalRes = await client.query(`SELECT * FROM testimonials WHERE id = $1`, [id]);
    return rowToTestimonial(finalRes.rows[0]);
  });
}

module.exports = {
  pool, initDb, createOrder, getOrderById, getOrderByToken, getOrderByMusicTaskId, getOrderByAnyMusicTaskId,
  getStuckInFlightOrders,
  updateGenerationPhaseIfLater,
  startRegenerationJob, updateRegenerationPhaseIfLater, markRegenerationStatus,
  claimOrderForProviderFinalization, claimOrderForRegeneration, claimOrderForInitialGeneration,
  refundEditIfReserved,
  claimVideoRender, releaseVideoRender, recordStripeEventIfNew, recordPaidOrderAtomically,
  recordResendEventIfNew, addEmailSuppression, isEmailSuppressed,
  isVideoClaimStillCurrent, mutateOrderMediaAtomically, confirmMediaSelection,
  updateOrder, listOrders, computeRevenue,
  logCreditEvent, getCreditEventsSince, getSetting, setSetting,
  claimCreditAlertTransition, getCreditAlertState, getCompletedOrdersSince, getAverageCreditsPerCompletedOrder,
  createTestimonial, getTestimonialById, updateTestimonial, deleteTestimonial,
  listAllTestimonials, listPublishedTestimonials, moveTestimonial
};
