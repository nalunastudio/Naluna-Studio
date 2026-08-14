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
// REGULA FINALA A PACHETELOR (2026-08-14, corectata — vezi si comentariul de la
// getGiftVariant in lib/entitlements.js): sursa unica server-side pentru cate melodii
// (variante) primeste fiecare plan — nu doar text in UI. Standard SI Video = o singura
// melodie initiala, un singur gen, cu O SINGURA editare/regenerare gratuita care PASTREAZA
// originalul si adauga varianta editata alaturi (vezi options.keepOriginalAsAlternative in
// finalizeVariantsIfNeeded) — clientul alege apoi explicit intre cele doua inainte de plata.
// DOAR Premium ramane pachetul cu doua melodii COMPLETE, in doua genuri DIFERITE, alese
// explicit de client de la inceput. Video NU mai e tratat ca un plan cu doua genuri initiale
// (corectie 2026-08-14 — anterior PLAN_VARIANT_COUNT.video era gresit setat la 2, ceea ce
// facea "Cadou video" sa ceara doua genuri de la inceput, exact ca Premium).
const PLAN_VARIANT_COUNT = { standard: 1, premium: 2, video: 1 };
const ALLOWED_OCCASIONS = ['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'altceva', 'bunici', 'parinti', 'matusa-unchi', 'socri', 'frati'];
const ALLOWED_GENRES = ['emotional', 'suflet', 'pop', 'acustic', 'petrecere', 'balada', 'manele', 'copii', 'populara', 'rock', 'colind', 'modern', 'hiphop', 'manele_suflet', 'motivational'];
const ALLOWED_LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

// MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): sistem generalizat de relatii de
// familie si nunta/botez. Ocaziile de mai jos cer o relatie EXPLICITA a destinatarului
// (recipientRole), aleasa de client, NICIODATA dedusa din nume/voce — si, in oglinda, relatia
// persoanei care ofera melodia (senderRole), pentru formulari corecte precum "din partea
// nepotului Andrei". 'aniversare' foloseste ACELASI set de relatii de familie, dar OPTIONAL
// (clientul poate alege in continuare "Altă persoană", pastrand comportamentul generic actual).
// CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): 'frati' adaugat aici DOAR ca sa foloseasca
// aceeasi ramura de adresare relatie+nume din relationClause() (mai jos) — spre deosebire de
// celelalte 4, NU are niciun concept de senderRole (vezi FAMILY_RECIPIENT_TO_SENDER_ROLES, care
// NU are intrari pentru sister/brother — POST /api/orders trateaza absenta lor ca "acest rol nu
// cere senderRole", fara sa modifice validarea pentru rolurile existente).
const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri', 'frati'];

// recipientRole permise per ocazie de familie. CONTINUARE — personalizarea reala a versurilor
// (hotfix 2026-08-08): "Amândoi" adaugat pentru parinti/matusa-unchi/socri. CONTINUARE (hotfix
// 2026-08-09): "Amândoi" adaugat acum si pentru bunici — reutilizeaza EXACT acelasi mecanism
// recipientMode='both'+recipientNames deja construit pentru Nuntă/Botez, niciun sistem paralel.
// CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): 'frati' are DOAR 2 optiuni, niciodata "Amândoi"
// (cerinta explicita) — de aceea 'sister'/'brother' NU apar in FAMILY_BOTH_ROLES mai jos.
const FAMILY_OCCASION_RECIPIENT_ROLES = {
  bunici: ['grandmother', 'grandfather', 'grandparents'],
  parinti: ['mother', 'father', 'parents'],
  'matusa-unchi': ['aunt', 'uncle', 'aunt_uncle'],
  socri: ['mother_in_law', 'father_in_law', 'parents_in_law'],
  frati: ['sister', 'brother']
};
// CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): toate valorile posibile de
// recipientRole pentru orice categorie de familie, indiferent de occasion — necesar pentru a
// doua melodie Premium, unde clientul poate alege ORICE categorie de relatie de familie pentru
// noul destinatar, independent de occasion-ul comenzii (ex. prima melodie occasion='parinti',
// a doua melodie recipientRole2='grandmother', o categorie complet diferita). Folosita si de
// relationClause() (mai jos) — gateway-ul "adreseaza ca relatie+nume" trebuie sa se activeze
// dupa ROLUL ales, nu dupa occasion, ca sa functioneze corect si pentru recipientRole2.
const FAMILY_RECIPIENT_ROLE_VALUES = Object.values(FAMILY_OCCASION_RECIPIENT_ROLES).flat();
// Valorile de recipientRole care reprezinta "Amândoi" pentru ocaziile de familie — analog cu
// WEDDING_RECIPIENT_ROLES_BOTH de mai jos.
const FAMILY_BOTH_ROLES = ['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'];
// senderRole permise, in functie de recipientRole ales — acelasi selector "Tu ești: ..." e
// reutilizat pentru bunici SI matusa-unchi (romana foloseste identic "Nepoată"/"Nepot" pentru
// ambele relatii), dar valorile interne raman distincte, ca buildPrompt sa poata scrie
// conceptul corect in engleza (Suno traduce apoi natural, la fel ca restul promptului). Rolurile
// "Amândoi" (grandparents/parents/aunt_uncle/parents_in_law) folosesc ACELASI expeditor ca
// varianta lor individuala — relatia expeditorului nu se schimba dupa cate persoane sunt
// destinatare.
const FAMILY_RECIPIENT_TO_SENDER_ROLES = {
  grandmother: ['granddaughter', 'grandson'],
  grandfather: ['granddaughter', 'grandson'],
  grandparents: ['granddaughter', 'grandson'],
  mother: ['daughter', 'son'],
  father: ['daughter', 'son'],
  parents: ['daughter', 'son'],
  aunt: ['niece', 'nephew'],
  uncle: ['niece', 'nephew'],
  aunt_uncle: ['niece', 'nephew'],
  mother_in_law: ['daughter_in_law', 'son_in_law'],
  father_in_law: ['daughter_in_law', 'son_in_law'],
  parents_in_law: ['daughter_in_law', 'son_in_law']
};

// "Nuntă/Botez" (occasion='nunta' — valoarea interna ramane neschimbata, doar eticheta
// afisata s-a schimbat in comanda.html, pentru compatibilitate deplina cu comenzile vechi).
// Trei niveluri (Miri/Fini/Nași), fiecare cu rol individual SAU "Amândoi" (grup).
const WEDDING_RECIPIENT_ROLES_SINGLE = ['groom', 'bride', 'godson', 'goddaughter', 'godfather', 'godmother'];
const WEDDING_RECIPIENT_ROLES_BOTH = ['couple', 'godchildren', 'godparents'];
// CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): "Nuntă" si "Botez" erau
// pana acum ambigue in cazul "Nași" (nasii pot fi de nunta SAU de botez, acelasi cuvant) —
// weddingType e alegerea EXPLICITA, separata, care distinge cele doua teme complet diferite.
// Rolurile permise sunt filtrate dupa tip: "Miri" apartine strict nuntii, "Fini" strict
// botezului, "Nași" ambelor (motiv pentru care exista si in wedding SI in baptism mai jos).
const WEDDING_TYPE_ALLOWED_ROLES = {
  wedding: ['groom', 'bride', 'couple', 'godfather', 'godmother', 'godparents'],
  baptism: ['godson', 'goddaughter', 'godchildren', 'godfather', 'godmother', 'godparents']
};

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
  },
  // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): relatiile de familie/nunta-botez.
  recipientRole: {
    ro: 'Alege exact pentru cine este cântecul',
    en: 'Choose exactly who the song is for',
    de: 'Wähle genau, für wen das Lied ist',
    es: 'Elige exactamente para quién es la canción',
    it: 'Scegli esattamente per chi è la canzone',
    fr: 'Choisissez exactement pour qui est la chanson',
    bg: 'Избери точно за кого е песента',
    tr: 'Şarkının tam olarak kimin için olduğunu seçin'
  },
  senderRole: {
    ro: 'Alege ce relație ai tu cu destinatarul',
    en: 'Choose your relationship to the recipient',
    de: 'Wähle deine Beziehung zur empfangenden Person',
    es: 'Elige tu relación con el destinatario',
    it: 'Scegli il tuo rapporto con il destinatario',
    fr: 'Choisissez votre relation avec le destinataire',
    bg: 'Избери каква е твоята връзка с получателя',
    tr: 'Alıcıyla olan ilişkinizi seçin'
  },
  recipientNames: {
    ro: 'Completează ambele nume',
    en: 'Fill in both names',
    de: 'Gib beide Namen ein',
    es: 'Completa ambos nombres',
    it: 'Inserisci entrambi i nomi',
    fr: 'Renseignez les deux prénoms',
    bg: 'Попълни и двете имена',
    tr: 'Her iki ismi de girin'
  },
  // CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08).
  weddingType: {
    ro: 'Alege dacă este vorba despre o nuntă sau un botez',
    en: 'Choose whether this is a wedding or a christening',
    de: 'Wähle, ob es sich um eine Hochzeit oder eine Taufe handelt',
    es: 'Elige si se trata de una boda o un bautizo',
    it: 'Scegli se si tratta di un matrimonio o di un battesimo',
    fr: 'Choisissez s\'il s\'agit d\'un mariage ou d\'un baptême',
    bg: 'Избери дали е сватба или кръщене',
    tr: 'Düğün mü yoksa vaftiz mi olduğunu seçin'
  },
  // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): alegerea obligatorie
  // "Pentru aceeași persoană" / "Pentru altă persoană" pentru a doua melodie.
  song2Target: {
    ro: 'Alege pentru cine este a doua melodie',
    en: 'Choose who the second song is for',
    de: 'Wähle, für wen das zweite Lied ist',
    es: 'Elige para quién es la segunda canción',
    it: 'Scegli per chi è la seconda canzone',
    fr: 'Choisissez pour qui est la deuxième chanson',
    bg: 'Избери за кого е втората песен',
    tr: 'İkinci şarkının kimin için olduğunu seçin'
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
// Ocazia "Pentru bunica sau bunicul" (ULTIMELE MODIFICĂRI STRICTE, hotfix 2026-08-08) — alegerea
// e OBLIGATORIE cand occasion='bunici', niciodata dedusa din nume/voce. Vezi POST /api/orders.
const GRANDPARENT_TYPE_REQUIRED_MESSAGES = {
  ro: 'Alege pentru cine e cântecul: bunica sau bunicul.',
  en: 'Choose who the song is for: grandmother or grandfather.',
  de: 'Wähle, für wen das Lied ist: Oma oder Opa.',
  es: 'Elige para quién es la canción: abuela o abuelo.',
  it: 'Scegli per chi è la canzone: nonna o nonno.',
  fr: 'Choisis pour qui est la chanson : grand-mère ou grand-père.',
  bg: 'Избери за кого е песента: баба или дядо.',
  tr: 'Şarkının kimin için olduğunu seçin: anneanne/babaanne mi, dede mi.'
};
function grandparentTypeRequiredMessage(lang) {
  const safe = ALLOWED_LANGS.includes(lang) ? lang : 'ro';
  return GRANDPARENT_TYPE_REQUIRED_MESSAGES[safe];
}
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
// CORECȚIE (2026-08-14, "elimină plafonul artificial de 150MB"): 150MB era un plafon ARBITRAR,
// nelegat de vreo constrangere reala de infrastructura — respingea exact videoclipurile normale
// de 1-2 minute pe care pachetul le promite explicit (un videoclip iPhone 4K la bitrate inalt,
// STRICT sub limita de ORDER_MEDIA_MAX_VIDEO_SECONDS=120s, poate ajunge realist la 400-600MB).
// Configurabil prin env (ca ORDER_MEDIA_MAX_VIDEO_SECONDS mai jos), fara redeploy de cod daca
// decizia de business se schimba. Implicit 700MB — acopera generos si cel mai incarcat caz
// real (4K60 HEVC, 2 minute), ramanand o limita EXPLICITA (nu upload "nelimitat") — restul
// pipeline-ului (multer diskStorage, streaming catre R2 cu fs.createReadStream) NU tine
// niciodata fisierul intreg in memorie, indiferent de dimensiune — vezi storage.uploadPrivateFile.
const ORDER_MEDIA_MAX_BYTES = (Number(process.env.ORDER_MEDIA_MAX_MB) > 0 ? Number(process.env.ORDER_MEDIA_MAX_MB) : 700) * 1024 * 1024;
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
// fisiere de ORDER_MEDIA_MAX_BYTES fiecare puteau ajunge simultan in RAM-ul procesului Node
// (multi GB per cerere, mai ales dupa marirea plafonului la 700MB) — pe o instanta Railway
// obisnuita, asta putea termina procesul (OOM kill) la un singur upload nefericit. diskStorage scrie fiecare
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
//
// RELANSARE (2026-08-14, upload multipart direct catre R2): `filePath` poate fi acum si un URL
// http(s) semnat (ffprobe accepta un URL ca argument, identic cu o cale locala) — folosit STRICT
// la finalizarea unui upload multipart, ca sa verificam decodabilitatea fara sa mai descarcam
// noi insine fisierul intreg prin Railway (contrazice exact cerinta "Railway ramane doar pentru
// autorizare/initiere/finalizare", nu pentru continut). timeoutMs implicit ramane 20s (calea
// locala, neschimbata); apelantul multipart foloseste un timeout mai generos, pentru variabilitatea
// retelei la citirea directa dintr-un URL R2.
async function verifyMediaDecodable(filePath, mimetype, type, timeoutMs = 20000) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'stream=codec_type,codec_name', '-show_entries', 'format=duration',
      filePath
    ], { timeout: timeoutMs });
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
  // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda 3):
  // aceeasi verificare, pentru a doua varianta aleasa — DOAR pentru Premium (session.metadata.
  // selectedVariantId2 e mereu string gol pentru orice alt pachet, vezi POST /checkout).
  const sessionVariantId2 = session.metadata.selectedVariantId2;
  if (preCheckOrder.plan === 'premium' && sessionVariantId2 && preCheckOrder.selectedVariantId2 !== sessionVariantId2) {
    console.error(`Comanda ${orderId}: a doua varianta din sesiune (${sessionVariantId2}) nu mai corespunde variantei curente (${preCheckOrder.selectedVariantId2}) — livrare refuzata.`);
    await db.recordStripeEventIfNew(event.id, orderId);
    return { httpStatus: 200, body: { received: true, rejected: 'stale_variant2' } };
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
    const {
      occasion, recipient, senderName, relationship, email, phone, story, genre, genre2, plan, lang, voicePreference,
      grandparentType, recipientRole, senderRole, recipientMode, recipientNames, weddingType,
      song2Target, occasion2, recipientRole2, senderRole2, recipientMode2, recipientNames2, recipient2, weddingType2,
      // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2 (Premium): expeditorul,
      // relația și povestea PROPRII melodiei 2 — complet separate de senderName/relationship/story.
      senderName2, relationship2, story2
    } = req.body || {};
    const safeLang = ALLOWED_LANGS.includes(lang) ? lang : 'ro';

    if (!ALLOWED_OCCASIONS.includes(occasion)) {
      return res.status(400).json({ error: 'Ocazie invalidă.' });
    }

    // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): relatia destinatarului
    // (recipientRole) si a expeditorului (senderRole), validate STRICT server-side, NICIODATA
    // deduse din nume/voce. `grandparentType` (campul original, ingust, al feature-ului
    // "bunica/bunicul") ramane acceptat pentru compatibilitate, dar e acum doar o OGLINDA a
    // recipientRole pentru occasion='bunici' — sursa de adevar e sistemul generalizat de mai jos.
    let safeGrandparentType = null;
    let safeRecipientRole = null;
    let safeSenderRole = null;
    let safeRecipientMode = null;
    let safeRecipientNames = null;
    let safeWeddingType = null;

    if (FAMILY_OCCASIONS.includes(occasion)) {
      const allowedRecipientRoles = FAMILY_OCCASION_RECIPIENT_ROLES[occasion];
      if (!allowedRecipientRoles.includes(recipientRole)) {
        return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
      }
      // CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): FAMILY_RECIPIENT_TO_SENDER_ROLES nu are
      // nicio intrare pentru 'sister'/'brother' — acest rol nu cere niciun senderRole (nu exista
      // niciun control "Tu ești: ..." in UI pentru el, cerinta explicita). Pentru toate celelalte
      // roluri (care AU o intrare in acest tabel), comportamentul ramane STRICT neschimbat:
      // senderRole ramane obligatoriu si validat exact ca inainte.
      const allowedSenderRoles = FAMILY_RECIPIENT_TO_SENDER_ROLES[recipientRole];
      if (allowedSenderRoles) {
        if (!allowedSenderRoles.includes(senderRole)) {
          return res.status(400).json({ error: missingFieldMessage('senderRole', safeLang) });
        }
        safeSenderRole = senderRole;
      }
      // CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): "Amândoi" pentru
      // parinti/matusa-unchi/socri — ACELASI mecanism ca "Amândoi" de la Nuntă/Botez mai jos
      // (recipientMode='both' + doua nume complete, distincte, validate identic). 'frati' nu
      // apare niciodata in FAMILY_BOTH_ROLES, deci isFamilyBothRole e mereu false pentru el.
      const isFamilyBothRole = FAMILY_BOTH_ROLES.includes(recipientRole);
      if (isFamilyBothRole) {
        if (recipientMode !== 'both') {
          return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
        }
        // CORECȚIE (2026-08-13, runda 8, "elimină câmpurile duplicate de nume la Amândoi"):
        // recipientNames (doua nume separate, introduse pe pasul 1) NU mai e cerut — clientul
        // introduce ambele nume O SINGURA DATA, in campul unic `recipient` (validat mai jos, la
        // fel ca la orice alta comanda — isValidString(recipient, 1, 60)). Pastrat STRICT optional
        // aici, pentru compatibilitate cu un draft vechi din localStorage care ar putea inca
        // trimite acest camp — daca lipseste (comportamentul nou, asteptat), pur si simplu nu se
        // seteaza, fara nicio eroare.
        if (recipientNames && typeof recipientNames === 'object') {
          const name1 = typeof recipientNames.name1 === 'string' ? recipientNames.name1.trim() : '';
          const name2 = typeof recipientNames.name2 === 'string' ? recipientNames.name2.trim() : '';
          if (isValidString(name1, 1, 60) && isValidString(name2, 1, 60)) {
            safeRecipientNames = { name1, name2 };
          }
        }
        safeRecipientMode = 'both';
      } else {
        safeRecipientMode = 'single';
      }
      safeRecipientRole = recipientRole;
      // grandparent_type (campul original, ingust) reprezinta DOAR 'grandmother'/'grandfather' —
      // ramane null pentru 'grandparents' ("Amândoi", hotfix 2026-08-09), care nu are echivalent
      // in acel camp vechi; sursa de adevar completa ramane recipientRole/recipientNames.
      if (occasion === 'bunici' && recipientRole !== 'grandparents') safeGrandparentType = recipientRole;
      // CORECȚIE STRICTĂ (hotfix 2026-08-08, punctul 1): submeniul de relatie de la "E ziua
      // lui/ei" a fost ELIMINAT COMPLET — occasion === 'aniversare' nu mai are nicio ramura
      // speciala aici, se comporta identic cu orice ocazie generica (dor, declaratie etc.):
      // recipientRole/senderRole raman null, indiferent ce ar trimite un client vechi din
      // devtools sau dintr-un draft localStorage neactualizat.
    } else if (occasion === 'nunta') {
      // CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): weddingType
      // (wedding/baptism) e acum OBLIGATORIU si distinge explicit cele doua teme, care nu mai
      // sunt amestecate — "Nași" (godparents) e singurul rol permis in AMBELE tipuri, pentru ca
      // in traditia romaneasca nasii pot fi de nunta SAU de botez.
      if (weddingType !== 'wedding' && weddingType !== 'baptism') {
        return res.status(400).json({ error: missingFieldMessage('weddingType', safeLang) });
      }
      const allowedRolesForType = WEDDING_TYPE_ALLOWED_ROLES[weddingType];
      const isSingleRole = WEDDING_RECIPIENT_ROLES_SINGLE.includes(recipientRole) && allowedRolesForType.includes(recipientRole);
      const isBothRole = WEDDING_RECIPIENT_ROLES_BOTH.includes(recipientRole) && allowedRolesForType.includes(recipientRole);
      if (!isSingleRole && !isBothRole) {
        return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
      }
      const expectedMode = isBothRole ? 'both' : 'single';
      if (recipientMode !== expectedMode) {
        return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
      }
      // CORECȚIE (2026-08-13, runda 8): vezi comentariul identic de la ramura de familie mai sus
      // — recipientNames ramane STRICT optional, niciodata cerut.
      if (expectedMode === 'both' && recipientNames && typeof recipientNames === 'object') {
        const name1 = typeof recipientNames.name1 === 'string' ? recipientNames.name1.trim() : '';
        const name2 = typeof recipientNames.name2 === 'string' ? recipientNames.name2.trim() : '';
        if (isValidString(name1, 1, 60) && isValidString(name2, 1, 60)) {
          safeRecipientNames = { name1, name2 };
        }
      }
      // CORECȚIE STRICTĂ (hotfix 2026-08-08, punctul 2): "Din partea cui este melodia?" a fost
      // ELIMINAT COMPLET pentru comenzile NOI Nuntă/Botez — senderRole NU mai e cerut si NU
      // mai e salvat (ramane null), indiferent ce ar trimite clientul. Comenzile VECHI care au
      // deja sender_role salvat in DB (create inainte de aceasta corectie) isi pastreaza exact
      // valoarea si comportamentul (vezi melodia-mea.html, composePersonalizedHeading).
      safeRecipientRole = recipientRole;
      safeRecipientMode = expectedMode;
      safeWeddingType = weddingType;
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
    // REGULA FINALA A PACHETELOR (corectata 2026-08-14): Standard SI Video = o singura
    // melodie initiala, un singur gen (Video primeste apoi o singura editare gratuita, care
    // pastreaza originalul si adauga alaturi varianta editata — vezi PLAN_VARIANT_COUNT).
    // DOAR Premium cere doua genuri diferite de la inceput — validat server-side, niciodata
    // doar in UI (un client care manipuleaza requestul din devtools nu poate obtine
    // entitlement Premium platind Standard/Video, si nici nu poate forta doua melodii
    // identice la Premium).
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

    // MODIFICARE STRICTĂ — fluxul pachetului Premium £25 (hotfix 2026-08-09): a doua melodie
    // poate fi acum pentru un destinatar DIFERIT de primul — alegere STRICT obligatorie pentru
    // plan='premium' ("Aceeași persoană" / "Pentru altă persoană", niciodata implicita), validata
    // server-side, niciodata doar in UI. Video ramane COMPLET neschimbat: nu trimite niciodata
    // aceste campuri, deci ramane pe ramura implicita — a doua melodie foloseste automat exact
    // recipient/recipientRole/senderRole/recipientMode/recipientNames de mai sus, ca inainte.
    // CORECȚIE STRICTĂ — configurarea pachetului Premium (hotfix 2026-08-10): a doua melodie
    // foloseste acum ÎNTREAGA pagina de ocazie ("Pentru ce moment vrei cântecul?") — toate cele
    // 13 optiuni, cu EXACT aceleasi reguli ca ocazia principala (mai sus), aplicate aici pentru
    // campurile *2. Niciun tabel de relatii nou — reutilizeaza STRICT FAMILY_OCCASIONS,
    // FAMILY_OCCASION_RECIPIENT_ROLES, FAMILY_RECIPIENT_TO_SENDER_ROLES, FAMILY_BOTH_ROLES,
    // WEDDING_TYPE_ALLOWED_ROLES, WEDDING_RECIPIENT_ROLES_SINGLE/BOTH — aceleasi constante
    // folosite mai sus pentru ocazia principala, sursa unica de adevar pentru ambele melodii.
    let safeSong2Target = null;
    let safeOccasion2 = null;
    let safeRecipientRole2 = null;
    let safeSenderRole2 = null;
    let safeRecipientMode2 = null;
    let safeRecipientNames2 = null;
    let safeRecipient2 = null;
    let safeWeddingType2 = null;
    // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2: expeditorul, relația și
    // povestea PROPRII melodiei 2. NICIODATA copiate din senderName/relationship/story
    // (melodia 1) — validate STRICT cu aceleasi reguli ca acele campuri (isValidString,
    // aceleasi limite de lungime), obligatorii DOAR cand plan='premium' SI song2Target='other'.
    let safeSenderName2 = null;
    let safeRelationship2 = null;
    let safeStory2 = null;
    if (plan === 'premium') {
      if (song2Target !== 'same' && song2Target !== 'other') {
        return res.status(400).json({ error: missingFieldMessage('song2Target', safeLang) });
      }
      safeSong2Target = song2Target;
      if (song2Target === 'other') {
        if (!ALLOWED_OCCASIONS.includes(occasion2)) {
          return res.status(400).json({ error: 'Ocazie invalidă pentru a doua melodie.' });
        }
        safeOccasion2 = occasion2;

        if (FAMILY_OCCASIONS.includes(occasion2)) {
          const allowedRecipientRoles2 = FAMILY_OCCASION_RECIPIENT_ROLES[occasion2];
          if (!allowedRecipientRoles2.includes(recipientRole2)) {
            return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
          }
          const allowedSenderRoles2 = FAMILY_RECIPIENT_TO_SENDER_ROLES[recipientRole2];
          if (allowedSenderRoles2) {
            if (!allowedSenderRoles2.includes(senderRole2)) {
              return res.status(400).json({ error: missingFieldMessage('senderRole', safeLang) });
            }
            safeSenderRole2 = senderRole2;
          }
          const isFamilyBothRole2 = FAMILY_BOTH_ROLES.includes(recipientRole2);
          if (isFamilyBothRole2) {
            if (recipientMode2 !== 'both') {
              return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
            }
            // CORECȚIE (2026-08-13, runda 8): vezi comentariul identic de la melodia 1 mai sus —
            // recipientNames2 ramane STRICT optional, niciodata cerut (numele vin din recipient2).
            if (recipientNames2 && typeof recipientNames2 === 'object') {
              const name1_2 = typeof recipientNames2.name1 === 'string' ? recipientNames2.name1.trim() : '';
              const name2_2 = typeof recipientNames2.name2 === 'string' ? recipientNames2.name2.trim() : '';
              if (isValidString(name1_2, 1, 60) && isValidString(name2_2, 1, 60)) {
                safeRecipientNames2 = { name1: name1_2, name2: name2_2 };
              }
            }
            safeRecipientMode2 = 'both';
          } else {
            safeRecipientMode2 = 'single';
          }
          safeRecipientRole2 = recipientRole2;
        } else if (occasion2 === 'nunta') {
          if (weddingType2 !== 'wedding' && weddingType2 !== 'baptism') {
            return res.status(400).json({ error: missingFieldMessage('weddingType', safeLang) });
          }
          const allowedRolesForType2 = WEDDING_TYPE_ALLOWED_ROLES[weddingType2];
          const isSingleRole2 = WEDDING_RECIPIENT_ROLES_SINGLE.includes(recipientRole2) && allowedRolesForType2.includes(recipientRole2);
          const isBothRole2 = WEDDING_RECIPIENT_ROLES_BOTH.includes(recipientRole2) && allowedRolesForType2.includes(recipientRole2);
          if (!isSingleRole2 && !isBothRole2) {
            return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
          }
          const expectedMode2 = isBothRole2 ? 'both' : 'single';
          if (recipientMode2 !== expectedMode2) {
            return res.status(400).json({ error: missingFieldMessage('recipientRole', safeLang) });
          }
          // CORECȚIE (2026-08-13, runda 8): vezi comentariul identic de mai sus.
          if (expectedMode2 === 'both' && recipientNames2 && typeof recipientNames2 === 'object') {
            const name1_2 = typeof recipientNames2.name1 === 'string' ? recipientNames2.name1.trim() : '';
            const name2_2 = typeof recipientNames2.name2 === 'string' ? recipientNames2.name2.trim() : '';
            if (isValidString(name1_2, 1, 60) && isValidString(name2_2, 1, 60)) {
              safeRecipientNames2 = { name1: name1_2, name2: name2_2 };
            }
          }
          safeRecipientRole2 = recipientRole2;
          safeRecipientMode2 = expectedMode2;
          safeWeddingType2 = weddingType2;
        }
        // Pentru orice alta ocazie (generica: dor/onomastica/aniversare/declaratie/pierdere/
        // pentru-mine/altceva), recipientRole2/senderRole2/recipientMode2/recipientNames2/
        // weddingType2 raman null — DOAR numele destinatarului (recipient2) e necesar, exact ca
        // la ocazia principala pentru aceleasi 7 ocazii generice.

        if (!isValidString(recipient2, 1, 60)) {
          return res.status(400).json({ error: missingFieldMessage('recipient', safeLang) });
        }
        safeRecipient2 = recipient2.trim();

        // ADAUGAT (2026-08-13) — mini-pagina dedicata datelor persoanei 2: aceleasi reguli de
        // validare ca senderName/relationship/story (melodia 1), aplicate STRICT campurilor
        // proprii melodiei 2 — niciodata un fallback catre valorile melodiei 1.
        if (!isValidString(senderName2, 1, 100)) {
          return res.status(400).json({ error: missingFieldMessage('sender', safeLang) });
        }
        safeSenderName2 = senderName2.trim();
        if (!isValidString(relationship2, 1, 60)) {
          return res.status(400).json({ error: missingFieldMessage('relationship', safeLang) });
        }
        safeRelationship2 = relationship2.trim();
        if (!isValidString(story2, 5, 2000)) {
          return res.status(400).json({ error: missingFieldMessage('story', safeLang) });
        }
        safeStory2 = story2.trim();
      }
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
      phone: safePhone,
      grandparentType: safeGrandparentType,
      recipientRole: safeRecipientRole,
      senderRole: safeSenderRole,
      recipientMode: safeRecipientMode,
      recipientNames: safeRecipientNames,
      weddingType: safeWeddingType,
      song2Target: safeSong2Target,
      occasion2: safeOccasion2,
      recipientRole2: safeRecipientRole2,
      senderRole2: safeSenderRole2,
      recipientMode2: safeRecipientMode2,
      recipientNames2: safeRecipientNames2,
      recipient2: safeRecipient2,
      weddingType2: safeWeddingType2,
      senderName2: safeSenderName2,
      relationship2: safeRelationship2,
      story2: safeStory2
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
// MODIFICARE STRICTĂ — fluxul Premium: editare selectiva pe pagina dedicata (hotfix 2026-08-10
// runda 3): clientul alege explicit "Editez prima melodie" / "Editez a doua melodie" / ambele,
// cu propriile campuri (feedback, gen) per melodie SELECTATA. Reutilizeaza EXACT acelasi
// mecanism ca editarea Standard (variantele editate se ADAUGA alaturi de cele initiale,
// niciodata nu le inlocuiesc — vezi finalizeVariantsIfNeeded, options.editVariantIds) si
// ACEEASI singura editare gratuita per comanda (db.claimOrderForRegeneration, un singur claim
// indiferent daca se editeaza 1 sau 2 melodii in aceeasi cerere). Complet separat de ramura de
// mai jos (variantId singular), folosita in continuare NESCHIMBAT de Standard si Video.
app.post('/api/orders/:orderId/regenerate', generationLimiter, requireOrderToken, async (req, res, next) => {
  if (req.order.plan === 'premium' && Array.isArray(req.body?.songs)) {
    return handlePremiumSelectiveRegenerate(req, res, next);
  }
  return handleLegacyRegenerate(req, res, next);
});

async function handlePremiumSelectiveRegenerate(req, res, next) {
  try {
    const order = req.order;
    if (order.status === 'ready') return res.status(400).json({ error: 'Comanda e deja plătită și finalizată.' });

    const songsInput = req.body.songs;
    if (songsInput.length < 1 || songsInput.length > 2) {
      return res.status(400).json({ error: 'Trebuie editată cel puțin o melodie, cel mult două.' });
    }
    const existingVariants = order.variants || [];
    if (existingVariants.length !== 2) {
      return res.status(400).json({ error: 'Comanda nu are exact două melodii inițiale.' });
    }

    const requestedVoice = typeof req.body?.voicePreference === 'string' ? req.body.voicePreference : null;
    if (requestedVoice !== null && !VOICE_PREFERENCES.includes(requestedVoice)) {
      return res.status(400).json({ error: invalidVoiceMessage(order.lang) });
    }

    const seenIds = new Set();
    const parsedSongs = [];
    for (const entry of songsInput) {
      const variantId = typeof entry?.variantId === 'string' ? entry.variantId : null;
      if (!variantId) return res.status(400).json({ error: sourceVariantRequiredMessage(order.lang) });
      if (seenIds.has(variantId)) return res.status(400).json({ error: 'Aceeași melodie a fost trimisă de două ori.' });
      seenIds.add(variantId);
      const sourceVariant = existingVariants.find(v => v.id === variantId);
      if (!sourceVariant) return res.status(400).json({ error: 'Varianta nu există.' });
      const feedback = typeof entry?.feedback === 'string' ? entry.feedback.slice(0, 500) : null;
      const requestedGenre = typeof entry?.genre === 'string' ? entry.genre : null;
      if (requestedGenre !== null && !ALLOWED_GENRES.includes(requestedGenre)) {
        return res.status(400).json({ error: invalidGenreMessage(order.lang) });
      }
      // MODIFICARE STRICTĂ — editare secventiala, pe rand, pentru ambele melodii (hotfix, runda
      // 4): versurile editate manual (camp precompletat cu versurile curente, editabil direct)
      // si vocea aleasa, ACUM per melodie — nu mai exista un camp global de feedback in noul
      // flux Premium. Cate un obiect per melodie, independent, exact ca genul.
      const lyricsInput = typeof entry?.lyrics === 'string' ? truncateAtWordBoundary(entry.lyrics.trim(), 4000) : null;
      const songVoice = typeof entry?.voicePreference === 'string' ? entry.voicePreference : null;
      if (songVoice !== null && !VOICE_PREFERENCES.includes(songVoice)) {
        return res.status(400).json({ error: invalidVoiceMessage(order.lang) });
      }
      parsedSongs.push({ variantId, sourceVariant, feedback, requestedGenre, lyricsInput, songVoice });
    }

    // Genurile finale (dupa orice schimbare ceruta) trebuie sa ramana diferite intre ele —
    // aceeasi regula ca la comanda initiala, verificata acum indiferent daca se editeaza una
    // sau ambele melodii in aceasta cerere.
    const finalGenreByVariantId = new Map(existingVariants.map(v => [v.id, v.genre]));
    for (const song of parsedSongs) {
      if (song.requestedGenre) finalGenreByVariantId.set(song.variantId, song.requestedGenre);
    }
    const finalGenres = existingVariants.map(v => finalGenreByVariantId.get(v.id));
    if (finalGenres[0] && finalGenres[1] && finalGenres[0] === finalGenres[1]) {
      return res.status(400).json({ error: sameGenreMessage(order.lang) });
    }

    if (order.generationAttempts >= credits.MAX_GENERATION_ATTEMPTS) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_retry_limit', note: `attempts=${order.generationAttempts}` });
      return res.status(429).json({ error: 'Ai atins numărul maxim de încercări pentru această comandă. Contactează-ne pentru ajutor.' });
    }
    const guard = await credits.evaluateGuard('generation');
    if (!guard.allowed) {
      await db.logCreditEvent({ orderId: order.id, eventType: 'blocked_low_credit', balanceAfter: guard.balance, note: guard.reason });
      return res.status(503).json({ error: 'Ne pare rău, sistemul este temporar indisponibil pentru regenerări noi. Te rugăm să încerci din nou în câteva minute.' });
    }

    // REZERVARE ATOMICA — exact acelasi mecanism ca editarea Standard/Video (un singur claim,
    // indiferent daca se editeaza 1 sau 2 melodii in aceasta cerere — "o singura runda gratuita
    // de editare", cerinta explicita). Previne dublul-click/reincercarile duplicate.
    const claimed = await db.claimOrderForRegeneration(order.id, FREE_EDITS, requestedVoice, credits.MAX_GENERATION_ATTEMPTS);
    if (!claimed) {
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

    // Scriem genurile noi (daca s-au cerut) INAINTE de a porni generarea — runGeneration
    // reciteste comanda din DB chiar la inceput, deci noul gen ajunge automat in prompt.
    // Coloana corecta (genre vs genre2) se afla dupa POZITIA variantei in array-ul initial —
    // vezi premiumEditSlotForVariant.
    const genrePatch = {};
    for (const song of parsedSongs) {
      if (!song.requestedGenre) continue;
      const { isSong2Slot } = premiumEditSlotForVariant(order, song.variantId);
      genrePatch[isSong2Slot ? 'genre2' : 'genre'] = song.requestedGenre;
    }
    if (Object.keys(genrePatch).length > 0) {
      await db.updateOrder(order.id, genrePatch);
    }

    // MODIFICARE STRICTĂ — editare secventiala (hotfix, runda 4): daca versurile trimise difera
    // de versurile efective CURENTE ale variantei sursa (editedLyrics existent, sau originalLyrics
    // daca inca nu a fost editata), le salvam ACUM pe varianta sursa — inainte de a porni
    // regenerarea, ca modificarea manuala sa nu se piarda niciodata, nici daca regenerarea
    // esueaza (acelasi comportament ca POST /variants/:variantId/lyrics, aplicat aici inline).
    const lyricsPatches = [];
    for (const song of parsedSongs) {
      if (!song.lyricsInput) continue;
      const currentEffective = (typeof song.sourceVariant.editedLyrics === 'string' && song.sourceVariant.editedLyrics.trim())
        ? song.sourceVariant.editedLyrics.trim()
        : (song.sourceVariant.originalLyrics || '').trim();
      if (song.lyricsInput !== currentEffective) {
        lyricsPatches.push({ variantId: song.variantId, lyrics: song.lyricsInput });
      }
    }
    if (lyricsPatches.length > 0) {
      const updatedVariants = existingVariants.map(v => {
        const patch = lyricsPatches.find(p => p.variantId === v.id);
        return patch ? { ...v, editedLyrics: patch.lyrics, lyricsUpdatedAt: new Date().toISOString() } : v;
      });
      await db.updateOrder(order.id, { variants: updatedVariants });
    }

    const editVariantIds = parsedSongs.map(s => s.variantId);
    const regenerationJobId = randomUUID();
    await db.updateOrder(order.id, {
      regenerateEditVariantIds: editVariantIds,
      // regenerateSourceVariantId ramane null aici — apartine STRICT vechii ramuri
      // (replaceVariantId, Video/Standard) si nu trebuie sa influenteze reluarile editarii
      // selective Premium (vezi verificarea regenerateEditVariantIds INAINTEA lui in codul de
      // reluare/callback).
    });
    await db.startRegenerationJob(order.id, regenerationJobId);
    res.json({ started: true, regenerationJobId });

    // Versuri editate + feedback liber, per melodie — versurile trimise ACUM au prioritate
    // (clientul tocmai le-a rescris direct), cu fallback la orice versuri salvate anterior.
    // MODIFICARE STRICTĂ (runda 4): vocea e acum SI ea per melodie (songVoice), aplicata direct
    // la construirea prompt-ului (vezi runPremiumEditGeneration) — niciodata doar la nivel de
    // comanda intreaga, ca inainte.
    // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate"): `exactLyrics`, cand
    // exista, NU mai e amestecat in `feedback` ca o "instructiune de a incerca sa urmeze"
    // versurile (SunoAPI, customMode:false, nu garanta deloc reproducerea exacta — Suno isi
    // putea rescrie propriile versuri). Transmis SEPARAT catre runPremiumEditGeneration, care
    // il trimite verbatim prin customMode:true (vezi buildExactLyricsRequest) — `feedback`
    // ramane STRICT observatia libera a clientului (voce/gen/alte cereri), niciodata versuri.
    const editSongsForGeneration = parsedSongs.map(song => {
      const exactLyrics = song.lyricsInput || (typeof song.sourceVariant.editedLyrics === 'string' ? song.sourceVariant.editedLyrics.trim() : '');
      return { variantId: song.variantId, feedback: song.feedback, exactLyrics: exactLyrics || null, voicePreference: song.songVoice };
    });

    runPremiumEditGeneration(order.id, editSongsForGeneration, regenerationJobId).catch(async (err) => {
      console.error('Eroare la editarea selectivă Premium pentru comanda', order.id, err.message);
      try {
        await db.refundEditIfReserved(order.id);
        await markGenerationFailed(order.id, err.message || err, undefined, regenerationJobId);
      } catch (dbErr) {
        console.error('Eroare suplimentară la salvarea stării de eșec:', dbErr.message);
      }
    });
  } catch (err) {
    next(err);
  }
}

async function handleLegacyRegenerate(req, res, next) {
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

    // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate"): daca varianta aleasa are
    // versuri editate manual (melodia-mea.html), le trimitem VERBATIM catre Suno, prin
    // customMode:true (vezi buildExactLyricsRequest, folosit mai jos in runGeneration cand
    // options.exactLyrics e prezent) — niciodata ca "ghidaj" amestecat in feedback-ul general,
    // care nu garanta nicio reproducere exacta (SunoAPI, in customMode:false, isi scrie singur
    // versurile din promptul descriptiv). `feedback` ramane STRICT observatia libera a
    // clientului (voce/gen/alte cereri), niciodata versuri. Nu folosim niciodata versurile
    // altei variante decat cea aleasa explicit.
    const exactLyrics = typeof sourceVariant.editedLyrics === 'string' ? sourceVariant.editedLyrics.trim() : '';

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
      ? { replaceVariantId: requestedVariantId, regenerationJobId, exactLyrics: exactLyrics || null }
      : { keepOriginalAsAlternative: true, regenerationJobId, exactLyrics: exactLyrics || null };
    runGeneration(order.id, feedback, regenOptions).catch(async (err) => {
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
}

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
// MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda 3):
// clientul trebuie sa aleaga EXACT doua din cele 2-4 variante reale disponibile (2 daca n-a
// editat nimic, 3 daca a editat o singura melodie, 4 daca a editat ambele) — niciodata mai
// mult/mai putin. Body dedicat, doar pentru plan='premium': {variantId, variantId2}, ambele
// obligatorii, distincte, si validate ca apartin STRICT acestei comenzi (niciodata ID-uri din
// alta comanda). Standard/Video raman STRICT pe ramura originala de mai jos (un singur
// variantId) — comportamentul lor ramane byte-identic.
app.post('/api/orders/:orderId/select', requireOrderToken, async (req, res, next) => {
  if (req.order.plan === 'premium' && req.body && typeof req.body.variantId2 === 'string') {
    return handlePremiumSelectTwo(req, res, next);
  }
  return handleSelectOne(req, res, next);
});

async function handlePremiumSelectTwo(req, res, next) {
  try {
    const order = req.order;
    const { variantId, variantId2 } = req.body;
    if (typeof variantId !== 'string' || typeof variantId2 !== 'string') {
      return res.status(400).json({ error: 'Trebuie alese exact două variante.' });
    }
    if (variantId === variantId2) {
      return res.status(400).json({ error: 'Cele două variante alese trebuie să fie diferite.' });
    }
    const variants = order.variants || [];
    const v1 = variants.find(v => v.id === variantId);
    const v2 = variants.find(v => v.id === variantId2);
    if (!v1 || !v2) return res.status(400).json({ error: 'Varianta nu există.' });

    await db.updateOrder(order.id, { selectedVariantId: variantId, selectedVariantId2: variantId2 });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function handleSelectOne(req, res, next) {
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
}

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
      isEditedAlternative: !!v.isEditedAlternative,
      // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda
      // 3): songSlot (1/2, stabil, NICIODATA dedus din genre) — grupeaza cardurile pe pagina de
      // comparare dupa melodia CĂREIA îi aparțin, indiferent de câte editări au avut loc.
      // recipient: numele persoanei pentru care e ACEASTA melodie — poate diferi intre cele doua
      // melodii ("Pentru altă persoană"), afisat explicit pe fiecare card, cerinta explicita.
      songSlot: v.songSlot || null,
      recipient: v.recipient || order.recipient || null,
      // ADAUGAT (2026-08-13, runda 3, "afiseaza persoana corecta pentru fiecare melodie in
      // meniul de editare Premium"): cauza reala a bug-ului — v.relationship era deja calculat
      // si stocat corect per varianta (getSong2EffectiveData, la generarea initiala), dar
      // LIPSEA din acest whitelist, deci melodia-mea.html primea mereu `undefined` pentru
      // AMBELE variante si cadea pe fallback-ul order.relationship (relatia melodiei 1) pentru
      // amandoua butoanele — niciodata o eroare de UI, o eroare de date netransmise. Nu e
      // secreta (acelasi motiv ca `recipient`, deja expus mai sus si la nivelul comenzii).
      relationship: v.relationship || order.relationship || null
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
      // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): la fel ca recipient/
      // senderName/relationship mai sus, NU sunt secrete — necesare in melodia-mea.html
      // pentru antetul personalizat ("Melodia pentru bunica Maria, din partea nepotului
      // Andrei"). Fara ele in acest whitelist explicit, composePersonalizedHeading()
      // primeste mereu undefined si antetul personalizat nu s-ar afisa niciodata.
      occasion: order.occasion || null,
      recipientRole: order.recipientRole || null,
      senderRole: order.senderRole || null,
      // CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): recipientMode/
      // recipientNames sunt necesare in melodia-mea.html pentru antetul cu DOUA nume distincte
      // ("Melodia pentru mama Maria și tata Ion") — fara ele aici, composePersonalizedHeading()
      // ar primi mereu undefined, la fel cum s-a intamplat cu occasion/recipientRole/senderRole
      // inainte de corectia anterioara. weddingType distinge Nuntă de Botez in antet.
      recipientMode: order.recipientMode || null,
      recipientNames: order.recipientNames || null,
      weddingType: order.weddingType || null,
      voicePreference: order.voicePreference,
      plan: order.plan,
      lang: order.lang,
      status: order.status,
      editsUsed: order.editsUsed,
      selectedVariantId: order.selectedVariantId || null,
      // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10
      // runda 3): a doua selectie finala — null pentru orice alt pachet. Necesar in
      // melodia-mea.html ca selectia sa persiste dupa refresh, fara sa fie pierduta.
      selectedVariantId2: order.selectedVariantId2 || null,
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
    // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda
    // 3): Premium livreaza DOUA melodii — plata nu poate incepe pana nu sunt alese explicit
    // AMBELE (POST /select, {variantId, variantId2}), niciodata doar implicit prima varianta
    // din array. Standard/Video nu au niciodata selectedVariantId2 (raman neatinse).
    if (order.plan === 'premium' && !order.selectedVariantId2) {
      return res.status(400).json({ error: 'Alege exact două melodii înainte de plată.' });
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
    // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10 runda
    // 3): amprenta include si a doua varianta aleasa, pentru Premium — o schimbare a ORICAREIA
    // din cele doua selectii invalideaza un link de plata vechi, la fel ca la selectedVariantId
    // singular (Standard/Video, neschimbat).
    const versionFingerprint = order.plan === 'premium'
      ? `${order.selectedVariantId}-${order.selectedVariantId2}-${order.mediaRevision}`
      : `${order.selectedVariantId}-${order.mediaRevision}`;

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
        // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10
        // runda 3): a doua varianta aleasa, verificabila la webhook fara sa ai incredere doar
        // in baza de date — string gol (nu null/undefined, Stripe metadata cere string) pentru
        // orice comanda care nu e Premium.
        selectedVariantId2: order.selectedVariantId2 || '',
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
      checkoutVariantId2: order.selectedVariantId2 || null,
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

// ==========================================================================================
// UPLOAD MULTIPART DIRECT DIN BROWSER CATRE R2 — Cadou video, RELANSARE 2026-08-14 ("codul live
// nu demonstreaza un upload multipart direct din browser catre R2 — pentru un videoclip de
// 500MB rezulta ~84 de cereri succesive [prin Railway]"). CORECT: mecanismul anterior (upload
// "fragmentat", vezi istoricul din git) inca retransmitea INTREGUL continut video prin acest
// server, doar in bucati mai mici, secvential — exact problema semnalata. Inlocuit complet:
// browserul trimite fragmentele DIRECT catre R2, prin URL-uri semnate (multipart upload S3,
// suportat nativ de R2). Railway ramane STRICT pentru autorizare (validare comanda/token/tip/
// dimensiune), initierea sesiunii multipart la R2, si finalizarea ei — bytes video NU mai trec
// niciodata prin acest server. Fotografiile si videoclipurile mici raman pe ruta simpla de mai
// sus (un singur POST, deja izolata per fisier) — pragul de mai jos desparte cele doua rute.
//
// LIMITA ONESTA: sesiunile sunt tinute STRICT in memoria procesului (Map), nu in baza de date —
// un restart de server (deploy, crash) pierde sesiunile in curs; clientul detecteaza asta (sesiune
// negasita la cererea URL-ului urmatorului fragment) si reia acel fisier de la inceput, curat.
// Necesita CORS configurat MANUAL pe bucket-ul R2 privat pentru originea site-ului (verificat,
// STRICT citire, la pornirea serverului — vezi checkUploadCorsAtBoot mai jos) — fara acea
// configurare (PUT permis + header-ul ETag expus), uploadul direct nu functioneaza.
// ==========================================================================================
const ORDER_MEDIA_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB — sub asta, un singur POST e suficient de rapid/fiabil
const ORDER_MEDIA_MULTIPART_PART_BYTES = 10 * 1024 * 1024; // 10MB per fragment (in intervalul 8-16MB cerut, peste minimul R2 de 5MB/parte)
const MULTIPART_SESSION_IDLE_MS = 30 * 60 * 1000; // sesiuni abandonate (tab inchis, pagina parasita) curatate dupa 30 min
const multipartSessions = new Map(); // sessionId -> { orderId, key, uploadId, totalBytes, mimetype, originalname, section, completed, result, lastActivityAt }

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of multipartSessions.entries()) {
    if (now - session.lastActivityAt > MULTIPART_SESSION_IDLE_MS) {
      storage.abortPrivateMultipartUpload(session.key, session.uploadId).catch(() => {});
      multipartSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000).unref();

app.post('/api/orders/:orderId/media/multipart/init', requireOrderToken, async (req, res, next) => {
  try {
    const order = req.order;
    if (order.plan !== 'video') return res.status(400).json({ error: 'Doar pachetul video acceptă fotografii/videoclipuri.' });
    if (!ORDER_MEDIA_UPLOADABLE_STATUSES.includes(order.status)) {
      return res.status(403).json({ error: 'Nu poți încărca materiale în acest moment — melodia se generează chiar acum.' });
    }
    if (!storage.CLOUD_ENABLED) {
      return res.status(503).json({ error: 'Upload direct necesită stocare cloud activată.' });
    }
    const { filename, size, mimeType, section } = req.body || {};
    const totalBytes = Number(size);
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > ORDER_MEDIA_MAX_BYTES) {
      return res.status(400).json({ error: `Dimensiune invalidă (maximum ${Math.round(ORDER_MEDIA_MAX_BYTES / (1024 * 1024))}MB).` });
    }
    if (totalBytes < ORDER_MEDIA_MULTIPART_THRESHOLD_BYTES) {
      return res.status(400).json({ error: 'Acest fișier nu necesită upload multipart — folosește ruta standard.' });
    }
    // uploadul multipart e rezervat videoclipurilor — fotografiile nu ating niciodata acest prag
    const inferredForInit = inferMediaType(filename, mimeType, ORDER_MEDIA_MIME_TYPES.photo, ORDER_MEDIA_MIME_TYPES.video);
    if (!inferredForInit || inferredForInit.type !== 'video') {
      return res.status(400).json({ error: 'Upload multipart disponibil doar pentru videoclipuri.' });
    }
    const ext = path.extname(String(filename || '')).toLowerCase() || '.mp4';
    const key = `orders/memories/${order.id}/${randomUUID()}${ext}`;
    const uploadId = await storage.createPrivateMultipartUpload(key, inferredForInit.mimetype);
    const sessionId = randomUUID();
    multipartSessions.set(sessionId, {
      orderId: order.id,
      key,
      uploadId,
      totalBytes,
      mimetype: inferredForInit.mimetype,
      originalname: filename || 'video',
      section: (typeof section === 'string' && section.trim()) ? section.trim() : null,
      completed: false,
      result: null,
      lastActivityAt: Date.now()
    });
    res.json({ sessionId, partSize: ORDER_MEDIA_MULTIPART_PART_BYTES, totalParts: Math.ceil(totalBytes / ORDER_MEDIA_MULTIPART_PART_BYTES) });
  } catch (err) {
    next(err);
  }
});

// URL semnat, per fragment — clientul cere unul chiar inainte sa-l trimita (nu toate deodata),
// ca sa ramana valid (expira in 15 minute). Railway NU vede niciodata continutul fragmentului —
// doar autorizeaza cererea si intoarce un URL catre care browserul face PUT direct.
app.post('/api/orders/:orderId/media/multipart/:sessionId/part-url', requireOrderToken, async (req, res, next) => {
  try {
    const session = multipartSessions.get(req.params.sessionId);
    if (!session || session.orderId !== req.order.id) {
      return res.status(404).json({ error: 'Sesiune de upload inexistentă sau expirată — reia fișierul de la început.' });
    }
    if (session.completed) return res.status(409).json({ error: 'Această sesiune a fost deja finalizată.' });
    const partNumber = Number(req.body?.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return res.status(400).json({ error: 'Număr de fragment invalid.' });
    }
    const url = await storage.getSignedUploadPartUrl(session.key, session.uploadId, partNumber, 900);
    session.lastActivityAt = Date.now();
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders/:orderId/media/multipart/:sessionId/complete', requireOrderToken, async (req, res, next) => {
  const order = req.order;
  const session = multipartSessions.get(req.params.sessionId);
  if (!session || session.orderId !== order.id) {
    return res.status(404).json({ error: 'Sesiune de upload inexistentă sau expirată — reia fișierul de la început.' });
  }
  // Finalizare IDEMPOTENTA: o a doua cerere de finalizare pentru aceeasi sesiune (retry de
  // retea dupa un raspuns pierdut) NU re-finalizeaza la R2, NU re-persista — intoarce STRICT
  // acelasi rezultat calculat prima data.
  if (session.completed) return res.json(session.result);
  const label = session.originalname;
  const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
  if (parts.length === 0) return res.status(400).json({ error: 'Niciun fragment confirmat.' });

  let completedAtR2 = false;
  try {
    await storage.completePrivateMultipartUpload(session.key, session.uploadId, parts);
    completedAtR2 = true;

    // Verificare de decodabilitate DIRECT din R2 (ffprobe citeste dintr-un URL semnat) — Railway
    // NU descarca aici fisierul intreg pentru sine, doar cere ffprobe-ului sa-l citeasca de la
    // sursa; consistent cu cerinta ca acest server sa nu mai retransmita continutul video.
    const signedUrl = await storage.getSignedDownloadUrl(session.key, 600);
    const decodable = await verifyMediaDecodable(signedUrl, session.mimetype, 'video', 60000);
    if (!decodable.ok) {
      session.completed = true;
      await storage.deletePrivateFile(session.key).catch(() => {});
      session.result = { uploaded: [], failed: [{ filename: label, reason: `Fișierul nu poate fi procesat (${decodable.reason}). Încearcă alt fișier sau alt format.` }], total: (order.uploadedMedia || []).length };
      return res.json(session.result);
    }

    const mutation = await db.mutateOrderMediaAtomically(order.id, (current) => {
      const existing = current.uploadedMedia || [];
      if (existing.length >= ORDER_MEDIA_MAX_ITEMS) return null;
      return { uploadedMedia: [...existing, { key: session.key, type: 'video', section: session.section, filename: label }] };
    });

    session.completed = true;
    if (!mutation.ok) {
      await storage.deletePrivateFile(session.key).catch(() => {});
      session.result = { uploaded: [], failed: [{ filename: label, reason: `Ai atins limita de ${ORDER_MEDIA_MAX_ITEMS} materiale.` }], total: (order.uploadedMedia || []).length };
      return res.json(session.result);
    }
    perfLog(order.id, 'media_upload_multipart', `reusit, bytes=${session.totalBytes}, parti=${parts.length}`);
    session.result = { uploaded: [{ type: 'video', filename: label, section: session.section }], failed: [], total: mutation.order.uploadedMedia.length };
    res.json(session.result);
  } catch (err) {
    session.completed = true;
    if (!completedAtR2) {
      // finalizarea la R2 insasi a esuat (ex. un ETag lipsa/gresit) — sesiunea multipart ramane
      // orfana la R2 daca nu o abandonam explicit aici.
      await storage.abortPrivateMultipartUpload(session.key, session.uploadId).catch(() => {});
    } else {
      await storage.deletePrivateFile(session.key).catch(() => {});
    }
    session.result = { uploaded: [], failed: [{ filename: label, reason: 'Eroare la finalizarea uploadului — te rugăm încearcă din nou.' }], total: (order.uploadedMedia || []).length };
    res.json(session.result);
  }
});

app.delete('/api/orders/:orderId/media/multipart/:sessionId', requireOrderToken, async (req, res) => {
  const session = multipartSessions.get(req.params.sessionId);
  if (session && session.orderId === req.order.id) {
    await storage.abortPrivateMultipartUpload(session.key, session.uploadId).catch(() => {});
    multipartSessions.delete(req.params.sessionId);
  }
  res.json({ ok: true });
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
    // polling, in runGeneration/runPremiumEditGeneration — apelarea prematura a
    // finalizeVariantsIfNeeded aici ar scrie doar UN gen ca rezultat final, incalcand
    // promisiunea "exact doua melodii" a pachetului.
    // CORECȚIE (2026-08-13, "editare secventiala"): editarea Premium a 2 melodii dispecerizeaza
    // ACUM sarcinile Suno STRICT pe rand (musicTaskId2 ramane null cat timp prima melodie inca
    // se genereaza) — in acest interval, un callback pentru prima sarcina NU trebuie sa
    // finalizeze nimic (ar declansa exact bug-ul descris mai sus: "inlocuire completa", ca la o
    // generare initiala, stergand variantele existente). regenerateEditVariantIds.length===2
    // (setat de POST /regenerate INAINTE de a porni prima sarcina, sters abia dupa finalizarea
    // AMBELOR melodii) identifica sigur aceasta fereastra, indiferent de musicTaskId2.
    if (order.musicTaskId2 || (order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 2)) {
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
      // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): vezi
      // comentariul echivalent din resumeExistingTaskPolling — prioritate fata de ramura de mai
      // jos, DOAR pentru editarea unei singure melodii din noul flux Premium.
      if (isDualGenrePlan && order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 1) {
        const [editVariantId] = order.regenerateEditVariantIds;
        const { genreToUse: editGenreToUse, isSong2Slot: editIsSong2Slot } = premiumEditSlotForVariant(order, editVariantId);
        const editOptions = { editVariantIds: [editVariantId] };
        if (order.regenerationJobId) editOptions.regenerationJobId = order.regenerationJobId;
        await finalizeVariantsIfNeeded(order.id, [{ tracks, genre: editGenreToUse, taskId, songSlot: editIsSong2Slot ? 2 : 1 }], editOptions).catch(err => {
          console.error(`Callback SunoAPI: eroare la finalizarea comenzii ${order.id}:`, err.message);
        });
        res.status(200).json({ received: true });
        return;
      }
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
      // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): vezi
      // comentariul echivalent din resumeDualTaskPolling.
      const dualFinalizeOptions = (order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 2)
        ? { editVariantIds: order.regenerateEditVariantIds, regenerationJobId: order.regenerationJobId }
        : {};
      await finalizeVariantsIfNeeded(orderId, [
        { tracks: r1.tracks, genre: order.genre, taskId: order.musicTaskId, songSlot: 1 },
        { tracks: r2.tracks, genre: order.genre2, taskId: order.musicTaskId2, songSlot: 2 }
      ], dualFinalizeOptions);
      return;
    }

    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK' || finalStatus === 'LOCAL_POLL_TIMEOUT') {
      // Fie callback-ul a preluat-o deja, fie e tot in lucru — in ambele cazuri nu mai
      // avem nimic de facut aici.
      return;
    }
    if (finalStatus === SUNO_SUCCESS_STATUS) {
      // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3):
      // regenerate_edit_variant_ids (setat DOAR de noul corp {songs:[...]}) are prioritate —
      // semnaleaza ADAUGARE (append), niciodata inlocuire, pentru editarea unei SINGURE melodii
      // Premium din noul flux. Ramura de mai jos (regenerateSourceVariantId, prin eliminare)
      // ramane STRICT neschimbata pentru Video si pentru orice comanda Premium veche.
      const isDualGenrePlan = PLAN_VARIANT_COUNT[order.plan] === 2;
      if (isDualGenrePlan && order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 1) {
        const [editVariantId] = order.regenerateEditVariantIds;
        const { genreToUse, isSong2Slot } = premiumEditSlotForVariant(order, editVariantId);
        const editOptions = { editVariantIds: [editVariantId] };
        if (order.regenerationJobId) editOptions.regenerationJobId = order.regenerationJobId;
        await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: genreToUse, taskId, songSlot: isSong2Slot ? 2 : 1 }], editOptions);
        return;
      }
      // CORECȚIE (2026-08-13, "editare secventiala") — editarea selectiva Premium a AMBELOR
      // melodii dispecerizeaza acum sarcinile Suno STRICT pe rand (vezi runPremiumEditGeneration):
      // daca serverul a fost repornit exact in fereastra in care prima melodie inca se genera
      // (musicTaskId2 inca null, regenerateEditVariantIds are 2 elemente), taskId de mai sus e
      // STRICT primul dintre cele doua. NU finalizam cu o singura varianta noua aici (ar declansa
      // exact bug-ul descris la /api/music/callback mai sus) — dispecerizam acum a doua melodie
      // (cu genul/versurile deja persistate, aceleasi surse canonice folosite si initial) si
      // finalizam ATOMIC abia dupa ce si ea reuseste, exact ca la traseul normal, neintrerupt.
      if (isDualGenrePlan && order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 2) {
        const [editVariantId1, editVariantId2] = order.regenerateEditVariantIds;
        const { genreToUse: genre1, isSong2Slot: isSong2Slot1 } = premiumEditSlotForVariant(order, editVariantId1);
        const { genreToUse: genre2, isSong2Slot: isSong2Slot2 } = premiumEditSlotForVariant(order, editVariantId2);
        const recipientSnapshot2 = isSong2Slot2 ? getSong2EffectiveData(order) : getSong1EffectiveData(order);
        const variant2 = (order.variants || []).find(v => v.id === editVariantId2);
        const exactLyrics2 = variant2 && typeof variant2.editedLyrics === 'string' ? variant2.editedLyrics.trim() : '';
        const requestPayload2 = exactLyrics2
          ? buildExactLyricsRequest({ ...order, ...recipientSnapshot2 }, exactLyrics2, genre2, order.voicePreference)
          : buildPrompt({ ...order, ...recipientSnapshot2 }, null, genre2);
        const taskId2 = await callMusicProvider(orderId, requestPayload2);
        await db.updateOrder(orderId, { musicTaskId: taskId, musicTaskId2: taskId2 });
        if (order.regenerationJobId) recordRegenerationProgress(orderId, order.regenerationJobId, 'dispatched_song2').catch(() => {});
        const r2 = await pollForResult(taskId2, orderId);
        if (r2.status === 'ALREADY_FINALIZED_BY_CALLBACK' || r2.status === 'LOCAL_POLL_TIMEOUT') return;
        if (r2.status !== SUNO_SUCCESS_STATUS) {
          console.error(`Reluare editare secventiala Premium: comanda ${orderId} a esuat la a doua melodie: ${r2.status}.`);
          await db.refundEditIfReserved(orderId);
          await markGenerationFailed(orderId, `Suno: ${r2.status}`, order.variants, order.regenerationJobId);
          return;
        }
        const editOptions2 = { editVariantIds: [editVariantId1, editVariantId2] };
        if (order.regenerationJobId) editOptions2.regenerationJobId = order.regenerationJobId;
        await finalizeVariantsIfNeeded(orderId, [
          { tracks, genre: genre1, taskId, songSlot: isSong2Slot1 ? 2 : 1 },
          { tracks: r2.tracks, genre: genre2, taskId: taskId2, recipientSnapshot: recipientSnapshot2, songSlot: isSong2Slot2 ? 2 : 1 }
        ], editOptions2);
        return;
      }
      // Regenerare partiala (Premium/Video, o singura varianta reeditata): foloseste genul
      // deja asociat variantei sursa si inlocuieste DOAR acea varianta — niciodata sora ei.
      // Standard, editare in curs: regenerateKeepOriginal (persistat in DB) pastreaza
      // originalul in loc sa inlocuiasca array-ul intreg. Pentru o generare INITIALA,
      // niciuna din cele doua nu se aplica — inlocuitor COMPLET (array-ul e oricum gol).
      // Genul se afla PRIN ELIMINARE (vezi comentariul din runGeneration) — NICIODATA din
      // sourceVariant.genre (VECHI, dinainte de o eventuala schimbare de gen la editare).
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
    // CORECȚIE (2026-08-13, investigatie regresie critica): o editare Premium selectiva
    // esuata (una sau ambele melodii) revine la 'preview_ready' PASTRAND variantele existente
    // — dar fara aceasta linie, regenerateEditVariantIds ramanea "agatat" (stale), setat de
    // POST /regenerate inainte de esec. Efect real: garda de la POST /api/music/callback
    // (regenerateEditVariantIds.length===2 -> ignora callback-ul) ramanea activa si dupa esec,
    // putand ignora din greseala un callback complet nelegat de acea editare, pentru orice
    // sarcina Suno pornita ulterior pe aceeasi comanda. Curatat explicit aici, indiferent daca
    // era sau nu setat (no-op sigur cand nu era).
    await db.updateOrder(orderId, { status: 'preview_ready', error: safeError, regenerateEditVariantIds: null });
    if (regenerationJobId) {
      await db.markRegenerationStatus(orderId, regenerationJobId, 'failed').catch(err => {
        console.error(`Eroare la marcarea esecului jobului de regenerare pentru comanda ${orderId}:`, err.message);
      });
    }
  } else {
    await db.updateOrder(orderId, { status: 'generation_failed', error: safeError });
  }
}

// MODIFICARE STRICTĂ — fluxul pachetului Premium £25 (hotfix 2026-08-09, CORECȚIE 2026-08-10):
// datele EFECTIVE pentru fiecare din cele doua melodii (genre/genre2) — ocazie, relatie
// (destinatar SI expeditor), mod, nume. Prima melodie foloseste INTOTDEAUNA campurile
// principale ale comenzii, neschimbate. A doua melodie foloseste ACELEASI campuri principale
// DECAT daca order.song2Target === 'other' (ales explicit doar pentru plan='premium') — caz in
// care foloseste in schimb occasion2/recipientRole2/senderRole2/recipientMode2/recipientNames2/
// recipient2/weddingType2, validate separat la POST /api/orders, cu EXACT aceleasi reguli ca
// ocazia principala (inclusiv "Tu ești: ..." pentru ocaziile de familie care il au, si
// Nuntă/Botez cu propriul weddingType). Pentru Video (si Premium cu "Aceeași persoană"),
// getSong2EffectiveData() returneaza EXACT aceleasi valori ca getSong1EffectiveData() —
// comportament identic cu cel dinaintea acestei modificari, niciun risc pentru fluxul Video.
function getSong1EffectiveData(order) {
  return {
    occasion: order.occasion,
    weddingType: order.weddingType,
    recipient: order.recipient,
    recipientRole: order.recipientRole,
    senderRole: order.senderRole,
    recipientMode: order.recipientMode,
    recipientNames: order.recipientNames
  };
}
function getSong2EffectiveData(order) {
  if (order.plan === 'premium' && order.song2Target === 'other' && order.occasion2) {
    return {
      occasion: order.occasion2,
      weddingType: order.weddingType2,
      recipient: order.recipient2,
      recipientRole: order.recipientRole2,
      senderRole: order.senderRole2,
      recipientMode: order.recipientMode2,
      recipientNames: order.recipientNames2,
      // ADAUGAT (2026-08-13) — cauza reala a "amestecarii povestilor": pana acum, aceasta functie
      // NU returna senderName/relationship/story — buildPrompt() (apelat cu
      // {...order, ...getSong2EffectiveData(order)}) folosea deci INTOTDEAUNA senderName/
      // relationship/story ale comenzii principale (melodia 1) pentru AMBELE melodii, chiar si
      // cand destinatarul melodiei 2 era complet diferit. Acum, cand "Pentru altă persoană" a
      // fost ales, melodia 2 foloseste STRICT propriile ei date (order.senderName2/relationship2/
      // story2, completate pe mini-pagina dedicata) — niciodata cele ale melodiei 1, niciodata
      // un fallback intre ele.
      senderName: order.senderName2,
      relationship: order.relationship2,
      story: order.story2
    };
  }
  return getSong1EffectiveData(order);
}

// MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): slotul
// (melodia 1 sau 2) unei variante aflate in curs de editare selectiva se afla STRICT dupa
// POZITIA ei in order.variants — la crearea initiala, variants[0] corespunde INTOTDEAUNA lui
// order.genre (melodia 1) si variants[1] lui order.genre2 (melodia 2), vezi
// waitForDualTaskAndFinalize mai jos. Functia ramane corecta chiar daca AMBELE melodii isi
// schimba genul in aceeasi cerere de editare (caz in care nu exista niciun "sibling neatins"
// de folosit ca ancora, spre deosebire de logica "prin eliminare" folosita pentru regenerarea
// partiala unica mai veche, options.replaceVariantId, ramasa neschimbata pentru Video).
function premiumEditSlotForVariant(order, variantId) {
  const variants = order.variants || [];
  const idx = variants.findIndex(v => v.id === variantId);
  const isSong2Slot = idx === 1;
  const genreToUse = isSong2Slot ? order.genre2 : order.genre;
  return { isSong2Slot, genreToUse };
}

// MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): reediteaza
// DOAR melodia sau melodiile explicit selectate de client pe pagina dedicata de editare —
// niciodata cealalta, neselectata. Rezultatele se ADAUGA alaturi de variantele initiale
// (options.editVariantIds, vezi finalizeVariantsIfNeeded), niciodata nu le inlocuiesc — clientul
// alege apoi explicit intre ele pe pagina de comparare. editSongs: [{variantId, feedback}],
// 1 sau 2 elemente.
async function runPremiumEditGeneration(orderId, editSongs, regenerationJobId) {
  const order = await db.getOrderById(orderId);
  if (!order) throw new Error('Comanda a dispărut în timpul generării');

  perfLog(orderId, 'premium_edit_start', `melodii=${editSongs.length}`);
  recordRegenerationProgress(orderId, regenerationJobId, 'prepared').catch(() => {});

  // Sortate dupa slot (melodia 1 inaintea melodiei 2), INDIFERENT de ordinea in care clientul
  // le-a trimis — waitForDualTaskAndFinalize (mai jos) presupune STRICT dispatches[0]=melodia 1,
  // dispatches[1]=melodia 2 (deriva recipientSnapshot din getSong1/getSong2EffectiveData in
  // aceasta ordine fixa); fara aceasta sortare, editarea "doar melodia 2" trimisa inaintea
  // "melodiei 1" intr-un request cu ambele ar amesteca datele de destinatar intre cele doua.
  const dispatches = editSongs
    .map(song => {
      const { isSong2Slot, genreToUse } = premiumEditSlotForVariant(order, song.variantId);
      const recipientSnapshot = isSong2Slot ? getSong2EffectiveData(order) : getSong1EffectiveData(order);
      // MODIFICARE STRICTĂ — editare secventiala, ambele melodii (hotfix, runda 4): vocea aleasa
      // pentru ACEASTA melodie (song.voicePreference) suprascrie voicePreference-ul comenzii
      // DOAR pentru acest prompt — acelasi tipar deja folosit pentru recipientSnapshot (obiect
      // nou construit prin spread, order.voicePreference original ramane neatins in DB decat
      // daca vreo alta cale il actualizeaza explicit).
      const effectiveVoice = VOICE_PREFERENCES.includes(song.voicePreference) ? song.voicePreference : order.voicePreference;
      // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate"): cand clientul a editat
      // manual versurile ACESTEI melodii (song.exactLyrics), le trimitem VERBATIM catre Suno
      // prin customMode:true (buildExactLyricsRequest) — niciodata prin buildPrompt(), care le-ar
      // fi trecut doar ca un "ghidaj" text, fara nicio garantie de reproducere exacta.
      const requestPayload = song.exactLyrics
        ? buildExactLyricsRequest({ ...order, ...recipientSnapshot }, song.exactLyrics, genreToUse, effectiveVoice, song.feedback)
        : buildPrompt({ ...order, ...recipientSnapshot, voicePreference: effectiveVoice }, song.feedback, genreToUse);
      return { variantId: song.variantId, isSong2Slot, genreToUse, recipientSnapshot, requestPayload };
    })
    .sort((a, b) => Number(a.isSong2Slot) - Number(b.isSong2Slot));

  if (dispatches.length === 1) {
    const [d] = dispatches;
    const taskId = await callMusicProvider(orderId, d.requestPayload);
    recordRegenerationProgress(orderId, regenerationJobId, 'dispatched').catch(() => {});
    await db.updateOrder(orderId, { musicTaskId: taskId, musicTaskId2: null });
    recordRegenerationProgress(orderId, regenerationJobId, 'processing').catch(() => {});
    const { status: finalStatus, tracks } = await pollForResult(taskId, orderId);

    if (finalStatus === 'ALREADY_FINALIZED_BY_CALLBACK') {
      perfLog(orderId, 'polling_stopped_early_callback_won');
      return;
    }
    if (finalStatus === 'LOCAL_POLL_TIMEOUT') return;
    if (finalStatus !== SUNO_SUCCESS_STATUS) {
      throw new Error(`Suno a raportat un status de eroare: ${finalStatus}`);
    }
    recordRegenerationProgress(orderId, regenerationJobId, 'audio_ready').catch(() => {});
    await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: d.genreToUse, taskId, recipientSnapshot: d.recipientSnapshot, songSlot: d.isSong2Slot ? 2 : 1 }], {
      editVariantIds: [d.variantId],
      regenerationJobId
    });
    return;
  }

  // MODIFICARE STRICTĂ (2026-08-13, "editare secventiala") — cerinta explicita: cele doua
  // melodii se proceseaza STRICT pe rand ("nu regenera ambele simultan", "nu avansa la
  // următoarea melodie până când regenerarea celei curente nu s-a încheiat cu succes").
  // INAINTE: cele doua sarcini Suno erau pornite in PARALEL (Promise.all) — schimbat aici la
  // dispatch SECVENTIAL real: sarcina melodiei 2 nu pleaca deloc catre Suno decat DUPA ce
  // sarcina melodiei 1 a raportat SUCCES. O eroare la melodia 1 opreste totul imediat (melodia
  // 2 nu porneste niciodata) — variantele existente raman complet neatinse. Finalizarea
  // (adaugarea celor doua variante noi in comanda) ramane INSA atomica, intr-un singur apel la
  // finalizeVariantsIfNeeded, dupa AMBELE succese — pastreaza neschimbata garantia "exact doua
  // melodii noi, niciodata doar una" si logica de reluare existenta (musicTaskId2 e setat abia
  // dupa ce melodia 1 s-a confirmat, niciodata inainte).
  const [d1, d2] = dispatches;
  const taskId1 = await callMusicProvider(orderId, d1.requestPayload);
  await db.updateOrder(orderId, { musicTaskId: taskId1, musicTaskId2: null });
  recordRegenerationProgress(orderId, regenerationJobId, 'dispatched').catch(() => {});
  perfLog(orderId, 'premium_edit_song1_dispatched', `gen1=${d1.genreToUse}`);
  const r1 = await pollForResult(taskId1, orderId);
  if (r1.status === 'ALREADY_FINALIZED_BY_CALLBACK') {
    perfLog(orderId, 'polling_stopped_early_callback_won');
    return;
  }
  if (r1.status === 'LOCAL_POLL_TIMEOUT') return; // ramane 'generating'; reluat de resumeExistingTaskPolling
  if (r1.status !== SUNO_SUCCESS_STATUS) {
    throw new Error(`Suno a raportat un status de eroare pentru prima melodie: ${r1.status}`);
  }

  const taskId2 = await callMusicProvider(orderId, d2.requestPayload);
  await db.updateOrder(orderId, { musicTaskId: taskId1, musicTaskId2: taskId2 });
  recordRegenerationProgress(orderId, regenerationJobId, 'dispatched_song2').catch(() => {});
  perfLog(orderId, 'premium_edit_song2_dispatched', `gen2=${d2.genreToUse}`);
  const r2 = await pollForResult(taskId2, orderId);
  if (r2.status === 'ALREADY_FINALIZED_BY_CALLBACK') {
    perfLog(orderId, 'polling_stopped_early_callback_won');
    return;
  }
  if (r2.status === 'LOCAL_POLL_TIMEOUT') return; // ramane 'generating'; reluat de resumeDualTaskPolling
  if (r2.status !== SUNO_SUCCESS_STATUS) {
    throw new Error(`Suno a raportat un status de eroare pentru a doua melodie: ${r2.status}`);
  }

  recordRegenerationProgress(orderId, regenerationJobId, 'audio_ready').catch(() => {});
  await finalizeVariantsIfNeeded(orderId, [
    { tracks: r1.tracks, genre: d1.genreToUse, taskId: taskId1, recipientSnapshot: d1.recipientSnapshot, songSlot: d1.isSong2Slot ? 2 : 1 },
    { tracks: r2.tracks, genre: d2.genreToUse, taskId: taskId2, recipientSnapshot: d2.recipientSnapshot, songSlot: d2.isSong2Slot ? 2 : 1 }
  ], {
    editVariantIds: [d1.variantId, d2.variantId],
    regenerationJobId
  });
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
    // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): editarea/regenerarea
    // trebuie sa foloseasca datele de destinatar ale SLOTULUI editat (genre vs genre2), nu
    // intotdeauna datele principale ale comenzii — altfel, editarea celei de-a doua melodii ar
    // reveni tacit la destinatarul primei, pierzand "Pentru altă persoană" ales initial. Pentru
    // Video (si Premium cu "Aceeași persoană"), getSong2EffectiveData() returneaza EXACT
    // aceleasi date ca getSong1EffectiveData() — comportament identic cu inainte.
    const isSong2Slot = genreToUse === order.genre2 && order.genre2 !== order.genre;
    const recipientSnapshot = isSong2Slot ? getSong2EffectiveData(order) : getSong1EffectiveData(order);
    recordRegenerationProgress(orderId, options.regenerationJobId, 'prepared').catch(() => {});
    // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate"): daca sursa are versuri
    // editate manual (options.exactLyrics), trimitem VERBATIM catre Suno prin customMode:true —
    // niciodata prin buildPrompt(), care nu garanteaza nicio reproducere exacta.
    const requestPayload = options.exactLyrics
      ? buildExactLyricsRequest({ ...order, ...recipientSnapshot }, options.exactLyrics, genreToUse, order.voicePreference, feedback)
      : buildPrompt({ ...order, ...recipientSnapshot }, feedback, genreToUse);
    const taskId = await callMusicProvider(orderId, requestPayload);
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
    await finalizeVariantsIfNeeded(orderId, [{ tracks, genre: genreToUse, taskId, recipientSnapshot }], { replaceVariantId: options.replaceVariantId, regenerationJobId: options.regenerationJobId });
    return;
  }

  // Standard: un singur gen, o singura cerere Suno. La o GENERARE INITIALA (fara variante
  // inca), inlocuieste normal (array-ul e oricum gol). La o EDITARE (options.keepOriginalAsAlternative,
  // setat de POST /regenerate), PASTREAZA originalul si adauga varianta editata alaturi —
  // clientul alege explicit intre ele (Partea 2, hotfix 2026-08-08).
  if (!isDualGenrePlan) {
    recordRegenerationProgress(orderId, options.regenerationJobId, 'prepared').catch(() => {});
    // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate") — vezi comentariul
    // identic din ramura Premium/Video de mai sus.
    const requestPayload = options.exactLyrics
      ? buildExactLyricsRequest(order, options.exactLyrics, order.genre, order.voicePreference, feedback)
      : buildPrompt(order, feedback);
    const taskId = await callMusicProvider(orderId, requestPayload);
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
  // cereri secventiale). Fiecare foloseste EXACT aceeasi poveste/ocazie/voce — doar stilul
  // muzical difera intre ele (vezi buildPrompt, genreOverride). CONTINUARE — fluxul pachetului
  // Premium £25 (hotfix 2026-08-09): destinatarul poate acum diferi intre cele doua melodii
  // (getSong2EffectiveData), DOAR pentru plan='premium' cu "Pentru altă persoană" ales explicit
  // — pentru Video (si Premium cu "Aceeași persoană"), getSong2EffectiveData() returneaza EXACT
  // aceleasi date ca prima melodie, deci promptGenre2 ramane byte-identic cu inainte.
  //
  // IMPORTANT — de ce NU folosim callback-ul ca sa finalizam aici: Suno trimite un callback
  // PER SARCINA (task), nu per comanda. Daca am lasa callback-ul sa apeleze
  // finalizeVariantsIfNeeded imediat ce O SINGURA sarcina termina, am risca sa scriem doar
  // UN gen ca rezultat final inainte ca CEALALTA sarcina sa fi terminat — incalcand direct
  // promisiunea "exact doua melodii" a pachetului. Vezi POST /api/music/callback: pentru
  // comenzi cu musicTaskId2 setat, callback-ul NU declanseaza finalizarea — doar polling-ul
  // (de mai jos, care asteapta explicit AMBELE sarcini) o face.
  const promptGenre1 = buildPrompt(order, feedback, order.genre);
  const promptGenre2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, feedback, order.genre2);
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
// finalizeOptions (optional): transmise NESCHIMBATE catre finalizeVariantsIfNeeded — absent
// (implicit) pentru generarea INITIALA (inlocuire completa, comportament original,
// neschimbat); { editVariantIds: [...], regenerationJobId } pentru editarea selectiva Premium
// (adauga alaturi, niciodata nu inlocuieste — vezi runPremiumEditGeneration mai sus).
async function waitForDualTaskAndFinalize(orderId, taskId1, genre1, taskId2, genre2, finalizeOptions = {}) {
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

  // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): recalculam snapshot-urile
  // de destinatar din comanda proaspat citita (`fresh`), nu dintr-un parametru transmis prin
  // lantul de apeluri (mai robust la reluari — vezi resumeDualTaskPolling, care apeleaza direct
  // aceasta functie fara sa mai treaca prin runGeneration). Pentru Video/Premium-"Aceeași
  // persoană", cele doua snapshot-uri sunt identice — niciun comportament nou pentru ele.
  await finalizeVariantsIfNeeded(orderId, [
    { tracks: r1.tracks, genre: genre1, taskId: taskId1, recipientSnapshot: getSong1EffectiveData(fresh), songSlot: 1 },
    { tracks: r2.tracks, genre: genre2, taskId: taskId2, recipientSnapshot: getSong2EffectiveData(fresh), songSlot: 2 }
  ], finalizeOptions);
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
    // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): daca
    // reluarea prinde o editare selectiva Premium a AMBELOR melodii (nu o generare initiala),
    // finalizarea trebuie sa ADAUGE rezultatele, niciodata sa le inlocuiasca — semnalul e
    // regenerate_edit_variant_ids, persistat de POST /regenerate inainte de a porni cele doua
    // sarcini Suno.
    const finalizeOptions = (order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 2)
      ? { editVariantIds: order.regenerateEditVariantIds, regenerationJobId: order.regenerationJobId }
      : {};
    await waitForDualTaskAndFinalize(orderId, order.musicTaskId, order.genre, order.musicTaskId2, order.genre2, finalizeOptions);
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
// CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): verificare NEBLOCANTA
// (doar avertisment in log, pentru monitorizare) ca versurile intoarse de Suno chiar contin
// numele complete asteptate. LIMITARE ARHITECTURALA de raportat explicit: SunoAPI genereaza
// versurile SI audio-ul in ACELASI apel — nu exista niciun pas separat "doar versuri" pe care
// aplicatia sa-l poata intercepta INAINTE de generarea audio, deci nu putem bloca/regenera
// automat inainte ca audio-ul sa existe deja, fara o schimbare arhitecturala majora (in afara
// scopului "modificare minima" al acestei cereri). Garantia REALA impotriva numelor
// omise/prescurtate ramane la nivelul promptului (vezi effectiveRecipientRole/relationClause/
// recipientIsProtectedCombo mai sus) — aceasta verificare ofera in plus vizibilitate directa
// in loguri daca, in ciuda promptului corect, Suno tot a omis un nume, pentru urmarire manuala.
// CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): daca varianta are propriul
// snapshot de destinatar (recipient/recipientMode/recipientNames, salvate separat pentru a doua
// melodie — vezi finalizeVariantsIfNeeded), verificam impotriva ACELUIA, nu a datelor principale
// ale comenzii — altfel, o a doua melodie "Pentru altă persoană" ar fi verificata gresit
// impotriva numelui PRIMEI persoane. Variantele fara snapshot propriu (Standard, Video, Premium
// cu "Aceeași persoană", si orice varianta veche creata inainte de aceasta functionalitate)
// folosesc automat datele principale ale comenzii, exact ca inainte.
function checkLyricsContainExpectedNames(order, variant) {
  if (!variant || !variant.originalLyrics) return;
  const namesToCheck = [];
  const mode = variant.recipientMode !== undefined && variant.recipientMode !== null ? variant.recipientMode : order.recipientMode;
  const names = variant.recipientNames || order.recipientNames;
  const recipient = variant.recipient || order.recipient;
  if (mode === 'both' && names) {
    if (names.name1) namesToCheck.push(names.name1);
    if (names.name2) namesToCheck.push(names.name2);
  } else if (recipient) {
    namesToCheck.push(recipient);
  }
  const lyricsLower = variant.originalLyrics.toLowerCase();
  namesToCheck.forEach(name => {
    const nameLower = String(name).trim().toLowerCase();
    if (nameLower && !lyricsLower.includes(nameLower)) {
      console.warn(`Comanda ${order.id}: numele "${name}" nu a fost gasit in versurile generate (varianta ${variant.id}) — verifica manual.`);
    }
  });
}

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
    // CORECȚIE (2026-08-13, "pastrarea exacta a versurilor editate"): versurile AFISATE langa
    // o varianta noua, rezultata dintr-o editare, trebuie sa fie EXACT cele trimise de client —
    // niciodata cele intoarse de Suno (vezi buildVariantFromTrack, care altfel ar folosi
    // track.lyrics, un camp al raspunsului furnizorului). Recalculam sursa canonica AICI, citind
    // direct `claimed.variants` (varianta sursa, cu editedLyrics deja salvat de POST /regenerate
    // INAINTE de a porni generarea) — functioneaza identic si la o reluare dupa restart
    // (resumeDualTaskPolling/resumeExistingTaskPolling), pentru ca citeste starea reala din DB,
    // nu un parametru transmis prin lantul de apeluri, care s-ar pierde la un restart al
    // procesului. Un array PARALEL cu requestsInfo — index cu index — pentru ca ordinea
    // requestsInfo/builtVariants e mereu aceeasi ordine in care au fost dispecerizate cererile
    // (vezi runPremiumEditGeneration/runGeneration: editVariantIds si dispatches sunt construite
    // din aceeasi sursa, in aceeasi ordine).
    const sourceVariantIdsInOrder = options.editVariantIds
      ? options.editVariantIds
      : options.replaceVariantId
        ? [options.replaceVariantId]
        : (options.keepOriginalAsAlternative && claimed.regenerateSourceVariantId)
          ? [claimed.regenerateSourceVariantId]
          : [];
    function canonicalEditedLyricsFor(sourceVariantId) {
      if (!sourceVariantId) return null;
      const src = (claimed.variants || []).find(v => v.id === sourceVariantId);
      if (!src) return null;
      return (typeof src.editedLyrics === 'string' && src.editedLyrics.trim()) ? src.editedLyrics.trim() : null;
    }

    const builtVariants = [];
    const requestFailures = [];
    let requestIndex = -1;
    for (const { tracks, genre, taskId, recipientSnapshot, songSlot } of requestsInfo) {
      requestIndex += 1;
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
        // MODIFICARE STRICTĂ — fluxul Premium: pagina finala de comparare (hotfix 2026-08-10
        // runda 3): songSlot (1 sau 2) identifica STABIL carei melodii apartine varianta —
        // NICIODATA dedus din genre (care se poate schimba la editare, deci nu mai
        // corespunde consistent cu order.genre/order.genre2 dupa o schimbare de gen).
        // Absent pentru Standard (nefolosit acolo).
        if (songSlot) built.songSlot = songSlot;
        // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): salveaza SEPARAT, pe
        // fiecare varianta, destinatarul/relatia/numele folosite pentru EA — necesar pentru ca
        // o a doua melodie "Pentru altă persoană" sa nu piarda aceasta informatie la o editare
        // ulterioara (vezi checkLyricsContainExpectedNames si runGeneration, ramura
        // options.replaceVariantId). Pentru Standard/Video/Premium-"Aceeași persoană",
        // recipientSnapshot e identic cu datele principale ale comenzii — nicio schimbare
        // practica fata de inainte.
        if (recipientSnapshot) Object.assign(built, recipientSnapshot);
        // CORECȚIE (2026-08-13): daca aceasta varianta rezulta dintr-o editare cu versuri
        // exacte, fortam versurile afisate sa fie EXACT textul canonic salvat — niciodata
        // ce a intors Suno (track.lyrics, deja atribuit de buildVariantFromTrack mai sus).
        const canonicalLyrics = canonicalEditedLyricsFor(sourceVariantIdsInOrder[requestIndex]);
        if (canonicalLyrics) {
          built.originalLyrics = canonicalLyrics;
          built.editedLyrics = null;
          built.lyricsUpdatedAt = new Date().toISOString();
        } else if (!built.originalLyrics || !built.originalLyrics.trim()) {
          // CORECȚIE (2026-08-13, "verifica inainte de trimitere ca versurile nu sunt goale"):
          // DOAR pentru versurile scrise de Suno insusi (customMode:false — fara canonicalLyrics,
          // deci nu e o editare cu versuri exacte ale clientului), o SINGURA reincercare
          // controlata daca raspunsul nu contine deloc versuri — nu un ciclu nelimitat, nu un
          // serviciu extern nou, doar acelasi apel catre furnizor, o singura data in plus.
          // Verificarile de continut/gramatica (cuvinte taiate, propozitii fara sens) NU pot fi
          // detectate fiabil aici, fara analiza semantica reala (risc mare de fals-pozitive care
          // ar dubla costul in credite fara beneficiu cert) — mitigate DOAR preventiv, prin
          // instructiunile explicite de mai sus (currentInstruction: "complete words only, no
          // shortening"), niciodata printr-o reincercare oarba pe baza unei euristici nesigure.
          console.warn(`Comanda ${orderId}: versuri goale primite de la furnizor pentru genul "${genre}" — reincerc o singura data.`);
          try {
            const retryOrder = recipientSnapshot ? { ...claimed, ...recipientSnapshot } : claimed;
            const retryPrompt = buildPrompt(retryOrder, '', genre);
            const retryTaskId = await callMusicProvider(orderId, retryPrompt);
            const retryResult = await pollForResult(retryTaskId, orderId);
            if (retryResult.status === SUNO_SUCCESS_STATUS && retryResult.tracks && retryResult.tracks.length) {
              for (const retryTrack of retryResult.tracks.slice(0, 2)) {
                if (retryTrack.lyrics && retryTrack.lyrics.trim()) {
                  const retryBuilt = await buildVariantFromTrack(orderId, randomUUID().slice(0, 8), retryTrack, retryTaskId);
                  if (retryBuilt.originalLyrics && retryBuilt.originalLyrics.trim()) {
                    built = retryBuilt;
                    built.genre = genre;
                    if (songSlot) built.songSlot = songSlot;
                    if (recipientSnapshot) Object.assign(built, recipientSnapshot);
                    break;
                  }
                }
              }
            }
          } catch (retryErr) {
            console.error(`Comanda ${orderId}: reincercarea pentru versuri goale a esuat (${retryErr.message}) — continui cu rezultatul original.`);
          }
        }
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
    builtVariants.forEach(v => checkLyricsContainExpectedNames(claimed, v));

    let variants;
    let newSelectedVariantId;
    let replacedOldVariants;
    if (options.replaceVariantId) {
      const existing = claimed.variants || [];
      const replaced = builtVariants[0];
      variants = existing.map(v => v.id === options.replaceVariantId ? replaced : v);
      newSelectedVariantId = options.keepSelectedVariantId || claimed.selectedVariantId;
      replacedOldVariants = existing.filter(v => v.id === options.replaceVariantId);
    } else if (options.editVariantIds) {
      // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3):
      // 1 SAU 2 melodii au fost reeditate explicit de client (vezi POST /regenerate,
      // {songs:[...]}) — la fel ca la Standard (options.keepOriginalAsAlternative de mai jos),
      // NU inlocuim variantele sursa, le PASTRAM si adaugam rezultatele noi alaturi, ca
      // alternative. Clientul alege apoi EXACT doua variante din cele 2-4 disponibile
      // (POST /select extins, doar pentru premium) inainte ca plata sa devina posibila —
      // de aceea selectedVariantId RAMANE null aici (si selectedVariantId2, mai jos, in
      // apelul catre db.updateOrder). Nimic nu se sterge din storage (replacedOldVariants
      // ramane gol) — originalele raman complet functionale/livrabile daca clientul alege
      // pana la urma sa le pastreze pe ele.
      // CORECȚIE (2026-08-13, "versiunea inițială și versiunea editată afișează aceleași
      // versuri"): variantele SURSA (existing) au primit `editedLyrics` = textul din editor
      // MAI SUS, in POST /regenerate (linia ~1949), STRICT ca sa poata fi transmis mai departe
      // ca `exactLyrics` catre Suno (vezi canonicalEditedLyricsFor, folosit deja pentru
      // `built.originalLyrics` mai sus) — dar acel camp NU era niciodata curatat dupa ce
      // editarea se finaliza. Rezultat: varianta ORIGINALA ramanea, pe ecran, cu editedLyrics
      // inca setat la textul editat — iar UI-ul (lyricsTextRaw = v.editedLyrics || v.originalLyrics)
      // afisa exact acelasi text si la "versiunea inițială" si la "versiunea editată". Golim
      // AICI editedLyrics pe variantele sursa (dupa ce a fost deja citit si folosit mai sus),
      // ca originalul sa isi arate din nou PROPRIUL text neschimbat.
      const sourceIdSet = new Set(sourceVariantIdsInOrder.filter(Boolean));
      const existing = (claimed.variants || []).map(v =>
        sourceIdSet.has(v.id) ? { ...v, editedLyrics: null } : v);
      const edited = builtVariants.map(v => ({ ...v, isEditedAlternative: true }));
      variants = [...existing, ...edited];
      newSelectedVariantId = null;
      replacedOldVariants = [];
    } else if (options.keepOriginalAsAlternative) {
      // Standard, fluxul de editare cu alegere (Partea 2, hotfix 2026-08-08): editarea NU
      // inlocuieste originalul — il PASTREAZA, si adauga varianta noua alaturi, ca alegere
      // alternativa. Clientul TREBUIE sa aleaga explicit intre cele doua (POST /select)
      // inainte ca plata sa devina posibila — de aceea newSelectedVariantId ramane null aici
      // (POST /checkout respinge deja orice cerere fara selectedVariantId). Nu stergem NIMIC
      // din storage (replacedOldVariants ramane gol) — originalul trebuie sa ramana complet
      // functional/livrabil daca editarea esueaza sau daca clientul alege pana la urma sa
      // pastreze originalul.
      // CORECȚIE (2026-08-13): acelasi motiv ca la ramura Premium de mai sus — golim
      // editedLyrics pe varianta sursa dupa ce a fost deja citita/folosita, ca originalul sa
      // isi arate din nou propriul text, nu textul editat lasat acolo de POST /regenerate.
      const sourceIdSet = new Set(sourceVariantIdsInOrder.filter(Boolean));
      const existing = (claimed.variants || []).map(v =>
        sourceIdSet.has(v.id) ? { ...v, editedLyrics: null } : v);
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

    const finalizePatch = {
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
    };
    // MODIFICARE STRICTĂ — fluxul Premium: editare selectiva (hotfix 2026-08-10 runda 3): a
    // doua selectie finala e resetata la null in ACELASI moment ca prima, ca sa oblige
    // alegerea explicita pe pagina de comparare. Marcajul regenerate_edit_variant_ids nu mai
    // e necesar dupa finalizare cu succes — curatat aici. Pentru orice alta regenerare
    // (options.editVariantIds absent), ambele campuri raman complet neatinse.
    if (options.editVariantIds) {
      finalizePatch.selectedVariantId2 = null;
      finalizePatch.regenerateEditVariantIds = null;
    }
    await db.updateOrder(orderId, finalizePatch);
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

// Durata REALA a unui videoclip sursa (secunde) — folosita STRICT ca sa alegem un punct de
// start mai bun in renderMemorySegment (vezi mai jos), niciodata pentru validare (asta ramane
// treaba lui verifyMediaDecodable, la upload). Esec/timeout -> null, apelantul revine automat
// la comportamentul vechi (start de la 0) — nicio eroare aici nu trebuie sa opreasca randarea.
async function getVideoSourceDurationSeconds(localPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', localPath
    ], { timeout: 15000 });
    const d = parseFloat(stdout);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (err) {
    return null;
  }
}

// CORECȚIE (2026-08-14, "nu selecta accidental numai primul fragment al fiecarui clip"):
// functie PURA (fara I/O), extrasa separat ca sa poata fi testata izolat, fara ffmpeg —
// pentru un videoclip SURSA mai lung decat durata alocata (frecvent pentru clipurile de
// 1-2 minute de pe iPhone), nu mai extragem intotdeauna DE LA INCEPUT (adesea exact
// momentul in care telefonul e ridicat/pornit, instabil) — alegem un punct de start
// DETERMINIST (nu aleator — acelasi rezultat la o re-randare), care evita primele ~8% si
// ultimele ~5% din clip si variaza intre materiale succesive (dupa indexul elementului),
// folosind pasul de aur pentru o distributie uniforma, nu repetitiva. Pentru un videoclip
// MAI SCURT decat durata alocata (sau daca durata sursei e necunoscuta — ffprobe a esuat),
// pastram EXACT comportamentul anterior — bucla completa de la inceput (-stream_loop -1),
// dovedit robust in productie.
function computeVideoSegmentStartOffset(index, sourceDurationSeconds, segDurationSeconds) {
  if (!sourceDurationSeconds || sourceDurationSeconds <= segDurationSeconds) {
    return { useLoop: true, startOffset: 0 };
  }
  const usableSpan = sourceDurationSeconds - segDurationSeconds;
  const marginStart = sourceDurationSeconds * 0.08;
  const marginEnd = sourceDurationSeconds * 0.05;
  const safeSpan = Math.max(0, usableSpan - marginStart - marginEnd);
  const GOLDEN_RATIO_CONJUGATE = 0.61803398875; // distributie uniforma, deterministă, per index
  const fraction = safeSpan > 0 ? ((index * GOLDEN_RATIO_CONJUGATE) % 1) : 0;
  const startOffset = Math.max(0, Math.min(marginStart + fraction * safeSpan, usableSpan));
  return { useLoop: false, startOffset };
}

// Randeaza UN element ca segment TACUT, durata fixa exacta, la rezolutia finala a
// videoclipului (720x1280). Pozele primesc un zoom lent si subtil (efect Ken Burns, de la
// 1.0x la 1.12x, centrat) — suficient de discret sa nu para agresiv pe o amintire.
// Videoclipurile sunt scalate/decupate la acelasi format — vezi computeVideoSegmentStartOffset
// mai sus pentru alegerea punctului de start.
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
    const sourceDuration = await getVideoSourceDurationSeconds(item.localPath);
    const { useLoop, startOffset } = computeVideoSegmentStartOffset(index, sourceDuration, segDurationSeconds);
    const inputArgs = useLoop
      ? ['-stream_loop', '-1', '-i', item.localPath]
      : ['-ss', startOffset.toFixed(2), '-i', item.localPath];
    await execFfmpeg([
      '-y', ...inputArgs,
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
// requestInput: fie un STRING (comportamentul original — customMode:false, Suno scrie
// versurile din promptul descriptiv), fie un OBIECT {style, title, lyrics} (adaugat
// 2026-08-13, cerinta "pastrarea exacta a versurilor editate") — customMode:true, campul
// "prompt" trimis catre Suno devine EXACT textul din `lyrics`, folosit verbatim ca versuri
// cantate ("The prompt will be strictly used as the lyrics and sung in the generated
// track." — docs.sunoapi.org). Foloseste ACEEASI functie/acelasi endpoint pentru ambele
// cazuri, ca sa nu duplicam logica de creare a task-ului/gestionare erori.
async function callMusicProvider(orderId, requestInput) {
  const isCustomLyrics = requestInput && typeof requestInput === 'object';
  const prompt = isCustomLyrics ? requestInput.lyrics : requestInput;

  // validare explicita inainte de request — desi buildPrompt()/buildExactLyricsRequest()
  // arunca deja eroare pentru campuri goale, verificam din nou aici, la locul unde chiar
  // pleaca cererea catre Suno
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt invalid sau gol — cererea catre SunoAPI nu a fost trimisa.');
  }
  if (isCustomLyrics && (!requestInput.style || !requestInput.style.trim())) {
    throw new Error('Stilul muzical (style) e gol — cererea customMode:true catre SunoAPI nu a fost trimisa.');
  }

  // Model configurabil prin variabila de mediu MUSIC_MODEL — vezi .env.example pentru
  // valorile acceptate de furnizor (V4_5ALL, V4, V4_5, V4_5PLUS, V5). Daca variabila lipseste
  // sau e goala, ramanem pe V4_5ALL (modelul folosit dintotdeauna) — schimbarea modelului e
  // deci strict opt-in, niciodata automata.
  const musicModel = (process.env.MUSIC_MODEL && process.env.MUSIC_MODEL.trim()) || 'V4_5ALL';

  const requestBody = isCustomLyrics
    ? {
        prompt,                 // versurile EXACTE, verbatim — cantate ca atare de Suno (customMode:true)
        style: requestInput.style,
        title: requestInput.title || 'Naluna',
        customMode: true,
        instrumental: false,
        model: musicModel,
        callBackUrl: `${DOMAIN}/api/music/callback`
      }
    : {
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
// CORECȚIE (2026-08-13, regresie critica "melodii instrumentale"): pragul de 2800 (marit
// intr-o runda anterioara, ca sa incapa povestea completa) a fost adus INAPOI la 500 —
// verificat direct impotriva unor comenzi reale de productie ca prompturile lungi (pana la
// 2800 caractere, cu pana la 2000 caractere de poveste bruta) coreleaza puternic cu piese
// generate integral instrumental de catre furnizor (customMode:false, unde promptul e
// interpretat ca un "brief" scurt, nu ca text narativ lung). Un prompt scurt, concis, este
// configuratia dovedita, stabila, folosita de acest produs inainte de acea schimbare.
// Corectia principala a regresiei ramane insa eliminarea cuvantului "instrumental" din
// instructiunile de mai jos (vezi currentInstruction()) — acest revert de lungime e o masura
// suplimentara de siguranta, nu inlocuieste acea corectie.
//
// CORECȚIE (2026-08-13, runda "mesajele clientului dispar din versuri"): 500 s-a dovedit
// insuficient pentru comenzi reale cu ocazie+relatie lungi (ex. Nuntă/Botez cu nași) SI un
// mesaj explicit scris de client (ex. "La mulți ani din partea nașilor Andrei și Mara") —
// verificat empiric ca `head` (stil+ocazie+destinatar+expeditor+relatie+voce), desi deja
// scurtat maximal de cascada de mai jos, poate singur ajunge la 420+ caractere pentru
// asemenea comenzi, lasand sub 80 caractere pentru poveste — insuficient sa incapa un mesaj
// explicit care nu se afla chiar la inceputul textului scris de client. Marit la 600 (crestere
// MODESTA, +20%, NU o revenire la 2800) — testat exhaustiv (vezi
// test/lyrics-exact-story-premium-sequential.test.js) ca (a) cuvantul "instrumental"
// tot nu apare in niciun caz, (b) mesaje explicite realiste supravietuiesc netrunchiate chiar
// si pe ocazia cea mai incarcata (nuntă/botez). Corectia principala ramane tot eliminarea
// cuvantului "instrumental" — aceasta crestere e mult sub pragul (2800/2000) care a corelat
// anterior cu regresia, si ramane o masura suplimentara, nu inlocuitoare.
// Prioritate la trunchiere (partea fixa nu se taie niciodata):
//   1. limba + stilul + ocazia + destinatarul — obligatorii, intacte
//   2. feedback-ul de editare (daca exista) — i se rezerva spatiu, dar limitat
//   3. povestea — umple spatiul ramas, prima taiata daca nu incape tot
// Taierea se face pe caractere Unicode complete (code points), nu pe unitati UTF-16,
// ca sa nu rupem niciodata un caracter multi-byte (emoji, litere in afara BMP) la mijloc.
const SUNO_PROMPT_MAX_LEN = 600;

// imparte corect pe caractere Unicode si taie fara sa rupa vreunul la mijloc
function truncateSafely(str, maxLen) {
  if (!str) return '';
  if (maxLen <= 0) return '';
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen).join('').trimEnd();
}

// CORECȚIE (2026-08-13, "nu taia niciun cuvant la mijloc"): folosita STRICT pentru versuri
// scrise/editate de client (POST /regenerate, {songs:[{lyrics}]}) — plasa de siguranta
// server-side pentru un text care depaseste maxlength=4000 al textarea-ului din UI (rar
// declansata in practica, dar posibila — camp trimis direct, fara UI). Un simplu .slice(0,4000)
// putea taia exact in mijlocul unui cuvant sau al unei propozitii; aceasta varianta se retrage
// pana la ultima limita completa de cuvant/vers (spatiu sau linie noua) in interiorul limitei,
// niciodata mai departe decat maxLen.
function truncateAtWordBoundary(str, maxLen) {
  if (!str) return '';
  if (maxLen <= 0) return '';
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  const cut = chars.slice(0, maxLen).join('');
  const lastBoundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  // daca nu exista niciun spatiu/linie noua in interiorul limitei (un singur "cuvant" foarte
  // lung), pastram taierea bruta — nu exista o limita de cuvant mai buna disponibila.
  return (lastBoundary > 0 ? cut.slice(0, lastBoundary) : cut).trimEnd();
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
  nunta: 'wedding or christening',
  pierdere: 'in loving memory',
  'pentru-mine': 'a song for oneself',
  altceva: 'a personal occasion',
  // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): etichete generice de rezerva
  // pentru ocaziile de familie — folosite doar daca recipientRole lipseste (nu ar trebui sa se
  // intample, validat strict la POST /api/orders). Relatia EXACTA (bunica/bunicul/mama/tata/
  // etc.) e adaugata separat, natural, de buildRelationInstruction() mai jos.
  bunici: 'a tribute to a grandparent',
  parinti: 'a tribute to a parent',
  'matusa-unchi': 'a tribute to an aunt or uncle',
  socri: 'a tribute to an in-law',
  // CONTINUARE (hotfix 2026-08-09, "Soră/Frate").
  frati: 'a tribute to a sibling'
};

// MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): substantivele de relatie (concept
// in engleza, trimis catre model) pentru destinatar si, respectiv, pentru expeditor. Suno scrie
// versurile in limba comenzii (lyricsLanguage) si traduce natural conceptul in cuvantul potrivit
// ("bunica"/"bunicul" in romana, "abuela"/"abuelo" in spaniola etc.), la fel ca pentru toate
// celelalte ocazii/genuri deja existente — nici Suno, nici acest prompt, nu scriu niciodata
// literal cuvantul englezesc in versuri. Foloseste ACELASI mecanism pentru toate relatiile de
// familie SI de nunta/botez (inlocuieste ramura ingusta anterioara, specifica doar lui 'bunici').
const RELATION_NOUNS = {
  grandmother: 'grandmother', grandfather: 'grandfather', grandparents: 'both grandmother and grandfather',
  mother: 'mother', father: 'father', parents: 'both parents, mother and father',
  aunt: 'aunt', uncle: 'uncle', aunt_uncle: 'both aunt and uncle',
  mother_in_law: 'mother-in-law', father_in_law: 'father-in-law', parents_in_law: 'both parents-in-law',
  groom: 'groom', bride: 'bride', couple: 'the couple (bride and groom)',
  godson: 'godson', goddaughter: 'goddaughter', godchildren: 'the godchildren',
  godfather: 'godfather', godmother: 'godmother', godparents: 'the godparents',
  // CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): posesivul "my" e inclus direct in conceptul
  // englezesc (spre deosebire de bunica/mama/matusa/soacra, care nu il au) — cerinta explicita
  // pentru aceasta relatie cere formulari precum "my sister Maria"/"my brother Vasile" in orice
  // limba, nu doar "sister Maria". Suno traduce apoi natural "my sister"/"my brother" in limba
  // versurilor (ex. "ma sœur" in franceza, "meine Schwester" in germana), la fel ca restul.
  sister: 'my sister', brother: 'my brother'
};
// CONTINUARE — relatie + nume impreuna, nu doar prenume (hotfix 2026-08-09): perechile de
// substantive pentru "Amândoi" la cele 4 categorii de familie — cate un substantiv distinct
// pentru fiecare nume (spre deosebire de substantivul colectiv unic folosit la Nuntă/Botez).
const FAMILY_BOTH_PAIR_KEYS = {
  grandparents: ['grandmother', 'grandfather'],
  parents: ['mother', 'father'],
  aunt_uncle: ['aunt', 'uncle'],
  parents_in_law: ['mother_in_law', 'father_in_law']
};
// Forma romaneasca EXACTA pentru "soacra"/"socru" — DOAR pentru aceasta pereche, folosita cand
// versurile sunt in romana (lyricsLanguage === 'Romanian'). Bunica/bunicul, mama/tata,
// matusa/unchiul sunt cuvinte simple, traduse deja natural si fiabil de Suno direct din
// conceptul in engleza (RELATION_NOUNS), fara sa fie nevoie de un ghidaj explicit aici (acelasi
// mecanism folosit deja pentru toate celelalte ocazii/genuri) — DOAR forma compusa "mama-soacră"/
// "tata-socru" nu ar rezulta previzibil doar din conceptul englezesc "mother-in-law", de aceea
// e singura hintata explicit, ca sa ramana cat mai scurt bugetul suplimentar de prompt.
// CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): "sora mea"/"fratele meu" sunt forma EXACTA
// ceruta explicit — hintate aici, la fel ca mama-soacră/tata-socru mai sus, ca sa nu depinda
// de cat de fiabil traduce Suno posesivul "my" din RELATION_NOUNS direct in romana.
const RO_RELATION_NAME_FORMS = {
  mother_in_law: 'mama-soacră', father_in_law: 'tata-socru',
  sister: 'sora mea', brother: 'fratele meu'
};
const SENDER_RELATION_NOUNS = {
  daughter: 'daughter', son: 'son',
  granddaughter: 'granddaughter', grandson: 'grandson',
  niece: 'niece', nephew: 'nephew',
  daughter_in_law: 'daughter-in-law', son_in_law: 'son-in-law',
  groom: 'groom', bride: 'bride', couple: 'the couple',
  godson: 'godson', goddaughter: 'goddaughter', godchildren: 'the godchildren',
  godfather: 'godfather', godmother: 'godmother', godparents: 'the godparents'
  // 'other' lipseste deliberat -> nicio clauza de expeditor (client a ales "Altă persoană").
};

// Instructiune de ATMOSFERA/TON pentru fiecare ocazie — separata de OCCASION_LABELS (care e
// doar eticheta scurta "Occasion: X."). Fara aceasta, ocazia era doar mentionata, nu si
// folosita ca directie reala pentru versuri (cerinta explicita). Valorile interne ale
// ocaziei (cheile acestui obiect) raman EXACT cele deja folosite in formular — nu s-a
// schimbat nimic in ce trimite clientul, doar cum foloseste server-ul aceasta valoare.
// Fiecare ocazie are o forma FULL (calitate mai buna) si una SHORT (folosita doar daca
// bugetul de 500 caractere e foarte stramtorat — vezi cascada de scurtare din buildPrompt).
// CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): instructiunile de mai jos
// au fost intarite explicit sa previna CONFUZII SEMANTICE frecvente intre ocazii inrudite
// (dor vs pierdere, onomastica vs aniversare, nunta vs botez) — fiecare cere acum EXPLICIT ce
// idee centrala trebuie sa transmita SI ce anume nu are voie sa presupuna/inventeze, verificat
// direct impotriva cerintei clientului pentru fiecare ocazie in parte.
const OCCASION_INSTRUCTIONS = {
  dor: {
    full: 'The idea, mood and chorus must center on missing someone who is alive but far away or absent — shared memories, distance, and longing to reunite. Never imply the person has died; that meaning belongs strictly to a different occasion (in loving memory) and must never be used here.',
    short: 'Missing someone alive but far away; never implies death.'
  },
  onomastica: {
    full: 'The idea, mood and chorus must center on their name day / saint\'s day — celebration and warm wishes tied to their name, not their birth date. Never treat this as a birthday, never say things like "another year older", and never invent or imply their age.',
    short: 'Name day celebration, not a birthday; never mention age.'
  },
  aniversare: {
    full: 'The idea, mood and chorus must clearly center on their BIRTHDAY — include a natural, heartfelt birthday wish (the natural equivalent of "Happy Birthday" in the lyrics language) and real memories, not a generic birthday song. Never invent or state their age unless an age is explicitly given in the story below.',
    short: 'Clearly a birthday song with a natural birthday wish; never invents age.'
  },
  declaratie: {
    full: 'The idea, mood and chorus must be a sincere, direct romantic declaration — express love, closeness, gratitude and genuine feelings for this specific person, personal and direct, like a real confession, not a generic love song.',
    short: 'Sincere, direct romantic declaration for this specific person.'
  },
  // 'nunta' ramane fallback-ul pentru comenzi VECHI create inainte de weddingType (nu ar trebui
  // sa mai existe comenzi noi in aceasta stare, weddingType e acum obligatoriu — vezi
  // WEDDING_TYPE_INSTRUCTIONS mai jos, folosit in loc de aceasta intrare ori de cate ori
  // order.weddingType exista).
  nunta: {
    full: 'Loving, joyful atmosphere of promise and togetherness for a wedding — solemn and moving, never sad.',
    short: 'Loving, joyful wedding mood.'
  },
  pierdere: {
    full: 'The idea, mood and chorus must respectfully convey that this person is no longer present — longing, cherished memories, and the lasting bond that remains. Gentle, respectful, deeply emotional remembrance; never cheerful, festive, celebratory, or upbeat language anywhere in the song.',
    short: 'Respectful remembrance of someone who has passed; never festive.'
  },
  'pentru-mine': {
    full: 'The idea, mood and chorus must be about the client themselves — a personal, introspective or encouraging message addressed to themselves. Never invent a recipient, a family member, or any relationship; let the story below guide the specific message.',
    short: 'Personal message to oneself; never invents a recipient or relationship.'
  },
  altceva: {
    full: 'The story below must become the central context and idea of the song — infer the mood and atmosphere strictly from it, never replace it with a generic occasion theme.',
    short: 'Story below is the central context; never a generic theme.'
  },
  // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): toate cele 4 ocazii de familie
  // impartasesc aceeasi atmosfera de baza — relatia EXACTA (bunica/mama/matusa/soacra etc.) e
  // adaugata separat, natural, de relationClause() mai jos, nu aici.
  //
  // CORECȚIE (2026-08-13, runda 4, "versurile contin detalii inventate" — ex. real, raportat
  // live: "Țin minte mâinile tale cum făceau ceaiul" pentru o matusa a carei poveste NU mentiona
  // ceaiul deloc): "cherished memories", lasat deschis/nespecificat, era o invitatie implicita
  // pentru model sa INVENTEZE o amintire plauzibila (ceai, bucatarie etc.) ori de cate ori
  // povestea clientului era scurta sau nu continea o amintire concreta — modelul "completa"
  // atmosfera ceruta cu propriile idei. Ancorat acum EXPLICIT la povestea de mai jos ("from the
  // story below"/"only what the story below actually says") — atmosfera calda ramane ceruta,
  // dar sursa amintirilor devine STRICT povestea, niciodata imaginatia modelului.
  bunici: {
    full: 'Warm, loving family tribute — express gratitude using only the memories and details from the story below, never invented ones.',
    short: 'Warm family tribute, gratitude — only the story\'s own memories, never invented.'
  },
  parinti: {
    full: 'Warm, loving family tribute — express gratitude using only the memories and details from the story below, never invented ones.',
    short: 'Warm family tribute, gratitude — only the story\'s own memories, never invented.'
  },
  'matusa-unchi': {
    full: 'Warm, loving family tribute — express gratitude using only the memories and details from the story below, never invented ones.',
    short: 'Warm family tribute, gratitude — only the story\'s own memories, never invented.'
  },
  socri: {
    full: 'Warm, respectful family tribute — full of gratitude and appreciation, never generic.',
    short: 'Warm family tribute, gratitude and appreciation.'
  },
  // CONTINUARE (hotfix 2026-08-09, "Soră/Frate"): o singura instructiune de atmosfera, comuna
  // pentru Soră SI Frate — combina explicit apropierea/iubirea familiala (ceruta pentru Soră) cu
  // increderea/sprijinul (cerute pentru Frate), ca sa acopere natural ambele formulari cerute.
  // Adresarea EXACTA ("sora mea"/"fratele meu" + nume) e adaugata separat de relationClause().
  frati: {
    full: 'The idea, mood and chorus must center on the bond between siblings — closeness, family love, trust, mutual support, using only the shared memories actually described in the story below, never invented ones. This must feel distinctly like a sibling relationship, never a romantic or a simple friendship song.',
    short: 'Sibling bond — closeness, trust, support; only the story\'s own memories, never invented; never romantic.'
  }
};
// CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): "Nuntă" si "Botez" sunt
// acum teme COMPLET DISTINCTE (weddingType obligatoriu la creare) — niciodata amestecate.
// Fiecare cere explicit o formulare naturala de tipul "astazi este nunta ta/voastra" respectiv
// "astazi este botezul tau" (conceptul in engleza, tradus natural de Suno in limba versurilor,
// la fel ca restul promptului).
const WEDDING_TYPE_INSTRUCTIONS = {
  wedding: {
    full: 'The idea, mood and chorus must clearly center on a WEDDING — love, marriage, union, and the beginning of a life together. Naturally include a phrase like "today is your wedding day" (translated naturally into the lyrics language, addressing one or both partners as fits the recipient). Never mention a baptism, a christening, or a child joining the family.',
    short: 'Clearly a wedding song — marriage and union; "today is your wedding day"; never baptism.'
  },
  baptism: {
    full: 'The idea, mood and chorus must clearly center on a BAPTISM/CHRISTENING — the child joining the family, blessing, joy, and a new beginning. Naturally include a phrase like "today is your baptism day" (translated naturally into the lyrics language). Never mention a wedding or a marriage.',
    short: 'Clearly a baptism song — blessing and new beginning; "today is your baptism day"; never wedding.'
  }
};
// CORECȚIE (2026-08-13, runda 4, "versurile contin detalii inventate" — ex. real, raportat live:
// "Nașilor le bate glasul tare când vă văd aici, în lumina asta", pentru povestea "Mulțumim că
// ne-ați ales nași, vă iubim"): WEDDING_TYPE_INSTRUCTIONS de mai sus cerea INTOTDEAUNA fraza
// "today is your wedding day"/"today is your baptism day", adresata destinatarului ca si cum EL
// ar fi cel sarbatorit (mire/mireasa la nunta, respectiv copilul botezat) — corect in acel caz,
// dar GRESIT/contradictoriu cand destinatarul e nașii (multumiti DE cuplu/familie, nu cei
// sarbatoriti) — modelul, incercand sa impace o instructiune fara sens pentru acest destinatar,
// umplea golul cu versuri vagi, fara legatura cu povestea reala ("in lumina asta"). IMPORTANT:
// DOAR nas/nasa (godfather/godmother/godparents) apartin acestei liste — fin/fina/finii
// (godson/goddaughter/godchildren) sunt EXACT copilul botezat, deci EI sunt cei sarbatoriti la
// botez ("today is your baptism day" e corect pentru ei, la fel ca mireasa/mirele la nunta) —
// niciodata incluse aici.
const WEDDING_NONCOUPLE_ROLES = ['godfather', 'godmother', 'godparents'];
const WEDDING_TYPE_INSTRUCTIONS_NONCOUPLE = {
  wedding: {
    full: 'The idea, mood and chorus must clearly center on a WEDDING — the couple thanking and honoring the recipient for their role and support (e.g. as godparents), never addressing the recipient as if they themselves are the ones getting married. Never mention a baptism, a christening, or a child joining the family.',
    // fereastra SCURTA trebuie sa ramana comparabila ca lungime cu originalul WEDDING_TYPE_INSTRUCTIONS.wedding.short
    // (~88 caractere) — o versiune mai lunga aici a impins `head` mult peste buget pentru comenzi
    // cu nume lungi + voce duet, lasand ZERO spatiu pentru poveste (regresie gasita empiric, prin
    // testare directa a acestui exact scenariu, inainte de a fi trimisa in productie).
    short: 'Wedding: honors recipient\'s role, never as if it is their own wedding; never baptism.'
  },
  baptism: {
    full: 'The idea, mood and chorus must clearly center on a BAPTISM/CHRISTENING — thanking and honoring the recipient for their role and support (e.g. as godparents), never addressing the recipient as if the baptism/christening is about them. Never mention a wedding or a marriage.',
    short: 'Baptism: honors recipient\'s role, never as if the baptism is about them; never wedding.'
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
// CORECȚIE (2026-08-13, regresie critica "melodii instrumentale"): adusa inapoi la 160 —
// vezi comentariul de la SUNO_PROMPT_MAX_LEN. Povestea NU mai e garantata completa (limitare
// reala, de raportat explicit) — un prompt scurt, concis, e configuratia dovedita sa produca
// melodii cu voce, in mod fiabil.
// CORECȚIE (2026-08-13, runda "mesajele clientului dispar din versuri"): marita proportional
// la 190 (SUNO_PROMPT_MAX_LEN 500->600, deci rezerva creste cu acelasi raport) — vezi
// comentariul de la SUNO_PROMPT_MAX_LEN pentru motiv si testare.
const STORY_MIN_RESERVE = 190;

// Extras la scop de modul (2026-08-13) — mutate din interiorul buildPrompt() ca sa poata fi
// reutilizate si de buildExactLyricsRequest() (campul "style" pentru customMode:true), fara
// sa duplicam cele 15 descrieri de gen. Continutul ramane byte-identic cu inainte.
// CORECȚIE (2026-08-13, runda 7, "Hip-Hop și Rock nu erau suficient de recognoscibile"):
// descrierile hiphop/rock au fost rescrise, DOAR pentru aceste doua chei — celelalte 13 genuri
// raman byte-identice. Linkurile TikTok trimise ca referinta NU au putut fi accesate/redate in
// acest mediu (verificat direct — pagina TikTok necesita randare JS, doar coaja generica a
// aplicatiei e disponibila prin fetch text, fara continut audio/video real) — folosite in schimb
// profilurile muzicale OBLIGATORII furnizate explicit. Fiecare descriere foloseste ACELASI stil
// concis, cu instrumentatie/tehnica concreta (nu adjective de atmosfera), consecvent cu restul
// mapei — testat empiric (sandbox local) ca ramane sub bugetul de 600 caractere chiar si in cel
// mai incarcat scenariu real (nume maxime, ocazie nunta, voce duet). Niciun nume de artist,
// piesa sau link TikTok in text — doar caracteristici muzicale generale.
const GENRE_STYLE_MAP = {
  emotional: 'cinematic orchestral ballad, swelling strings and piano, rubato build, breathy vulnerable vocal, tearful climax',
  suflet: 'intimate de suflet ballad, sparse guitar or piano, close warm vocal, quiet confessional unpolished mood',
  pop: 'commercial pop, 100-120bpm, verse-chorus-bridge, synth hook, polished vocal, radio-ready energy',
  acustic: 'unplugged acoustic folk, fingerpicked guitar, light percussion, natural room sound, plain sincere vocal',
  petrecere: 'fast Romanian party beat, 130+bpm, syncopated dance rhythm, horns and synth stabs, shouted chorus, club energy',
  balada: 'slow rubato piano ballad, sustained strings, no beat, dramatic dynamic swells, powerful sustained vocal',
  manele: 'Romanian manele de jale, oriental scale, mournful clarinet, melismatic vocal slides, minor key grief',
  copii: 'cheerful childrens song, simple major-key melody, glockenspiel and ukulele, bouncy rhythm, bright vocal',
  populara: 'Romanian muzica populara, taraf violin and accordion, rustic dance rhythm, unornamented vocal, no autotune',
  rock: 'live rock sound, distorted electric guitar riff, power chords, electric bass, energetic drums, strong vocal, dynamic verses building to a big chorus, guitar and vocal upfront',
  colind: 'traditional Romanian carol, sleigh bells and choir, warm acoustic guitar, gentle festive reverent vocal',
  modern: 'sleek modern pop-electronic, deep 808 sub bass, glossy synth pads, vocal chops, minimalist premium production',
  hiphop: 'modern hip-hop, punchy kick, firm snare/clap, syncopated hi-hats, deep bass, short repeatable hook, rhythmic near-rap verses, clear diction, melodic chorus, clean modern mix',
  manele_suflet: 'Romanian manele de suflet, oriental scale, romantic clarinet, warm melismatic vocal, devoted love build',
  motivational: 'inspirational anthem, driving toms, major-key triumphant chords, confident vocal, uplifting final chorus'
};
const LYRICS_LANGUAGE_NAMES = {
  ro: 'Romanian', en: 'English', de: 'German', es: 'Spanish',
  it: 'Italian', fr: 'French', bg: 'Bulgarian', tr: 'Turkish'
};

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
  const lyricsLanguage = LYRICS_LANGUAGE_NAMES[order.lang] || 'Romanian';
  // genreOverride: folosit pentru a doua cerere Suno (Premium/Video, al doilea gen ales de
  // client) — restul promptului (poveste, destinatar, ocazie, voce) ramane IDENTIC intre
  // cele doua cereri; DOAR stilul muzical difera, ca ambele melodii sa fie despre aceeasi
  // poveste reala, in doua interpretari muzicale reale, distincte.
  const styleTags = GENRE_STYLE_MAP[genreOverride || order.genre] || 'pop, warm vocals';
  // MODIFICARE STRICTĂ — pagina de ocazie (hotfix 2026-08-08): relatia EXACTA (recipientRole/
  // senderRole), aleasa explicit de client la creare — NICIODATA dedusa aici din nume/voce.
  // Fallback pentru comenzi vechi cu occasion='bunici' create in fereastra scurta cat a existat
  // doar campul ingust grandparentType, fara inca recipientRole (nu ar trebui sa existe comenzi
  // noi in aceasta situatie, validat strict la POST /api/orders) — foloseste grandparentType,
  // sau implicit 'grandmother', ca sa nu blocheze generarea (acelasi spirit defensiv ca
  // fallback-ul general de mai jos).
  const effectiveRecipientRole = order.recipientRole
    || (order.occasion === 'bunici' ? (order.grandparentType === 'grandfather' ? 'grandfather' : 'grandmother') : null);
  // CONTINUARE — personalizarea reala a versurilor (hotfix 2026-08-08): eticheta ocaziei devine
  // si ea weddingType-aware ("wedding" SAU "christening", niciodata ambigua ca eticheta veche
  // "wedding or christening") — evita un "Occasion:" contradictoriu langa instructiunea
  // dedicata, care deja spune explicit "never baptism"/"never wedding".
  const occasionLabel = (order.occasion === 'nunta' && (order.weddingType === 'wedding' || order.weddingType === 'baptism'))
    ? (order.weddingType === 'wedding' ? 'wedding' : 'christening/baptism')
    : (OCCASION_LABELS[order.occasion] || order.occasion);

  // Instructiunea de atmosfera/ton pentru ocazia aleasa — comenzi vechi sau o valoare
  // necunoscuta de ocazie NU blocheaza generarea (Partea 2, punctul 11): folosim fallback-ul
  // neutru, bazat pe poveste. CONTINUARE (hotfix 2026-08-08): pentru occasion='nunta' CU
  // weddingType cunoscut, folosim instructiunea DEDICATA (nunta SAU botez, niciodata amestecate)
  // in loc de instructiunea generica 'nunta' de mai sus — care ramane doar fallback pentru
  // comenzile vechi, create inainte ca weddingType sa devina obligatoriu.
  // CORECȚIE (2026-08-13, runda 4): pentru nași/fini (destinatar DIN AFARA cuplului la o
  // nunta/botez — vezi WEDDING_TYPE_INSTRUCTIONS_NONCOUPLE mai sus), folosim varianta care nu
  // ii adreseaza gresit ca si cum EI s-ar casatori/boteza.
  const isWeddingNonCoupleRecipient = order.occasion === 'nunta' && WEDDING_NONCOUPLE_ROLES.includes(effectiveRecipientRole);
  const occasionInstructionSet = (order.occasion === 'nunta' && WEDDING_TYPE_INSTRUCTIONS[order.weddingType])
    ? (isWeddingNonCoupleRecipient ? WEDDING_TYPE_INSTRUCTIONS_NONCOUPLE[order.weddingType] : WEDDING_TYPE_INSTRUCTIONS[order.weddingType])
    : (OCCASION_INSTRUCTIONS[order.occasion] || OCCASION_INSTRUCTION_FALLBACK);
  let useShortOccasionInstruction = false;
  let includeOccasionInstruction = true;
  // Clauza de relatie — mentioneaza NATURAL, o singura data, relatia exacta a destinatarului
  // si (daca e cunoscuta) a expeditorului. NICIODATA eliminata complet de cascada de scurtare
  // (acelasi tratament ca vocea aleasa explicit) — doar comprimata la forma scurta, pentru ca
  // e cerinta explicita ("relatia trebuie mentionata natural cel putin o data"). Urarea de
  // "La mulți ani" pentru 'aniversare' NU mai depinde de relatie — e acum parte din
  // OCCASION_INSTRUCTIONS.aniversare de mai sus, asa ca se aplica INTOTDEAUNA, nu doar cand
  // exista o relatie de familie aleasa (submeniul de relatie de la aniversare a fost eliminat).
  //
  // CONTINUARE — relatie + nume impreuna, nu doar prenume (hotfix 2026-08-09): pentru
  // Bunică/Bunic, Mamă/Tată, Mătușă/Unchi, Soacră/Socru, generatorul nu mai are voie sa se
  // adreseze destinatarului doar prin prenume. IMPORTANT: aceasta cerinta e REFORMULATA in
  // clauza de baza de mai jos (nu ADAUGATA ca propozitie separata) — bugetul de prompt e deja
  // extrem de strans (verificat direct: chiar si o comanda scurta, tipica, ajunge aproape de
  // limita de 500 caractere doar cu clauza de relatie existenta) — o propozitie suplimentara
  // ar fi fost eliminata de cascada de scurtare in aproape toate comenzile reale, facand
  // cerinta inutila in practica. Pentru Nuntă/Botez (in afara scopului acestei runde),
  // formularea ramane EXACT cea originala, neschimbata. Numele efectiv NU e repetat aici (Suno
  // il are deja din linia "Recipient:"/"Sender:", protejata separat de trunchiere) — daca ar fi
  // repetat, un nume de 60 caractere la "Amândoi" ar fi putut impinge acea linie dincolo de
  // limita finala de 500, exact riscul pe care recipientIsProtectedCombo il elimina.
  function relationClause() {
    const recipientNoun = RELATION_NOUNS[effectiveRecipientRole];
    if (!recipientNoun) return '';
    const senderNoun = SENDER_RELATION_NOUNS[order.senderRole];
    // CONTINUARE — fluxul pachetului Premium £25 (hotfix 2026-08-09): gateway-ul foloseste acum
    // ROLUL ales (effectiveRecipientRole), NU order.occasion — pentru comenzile obisnuite cele
    // doua erau mereu echivalente (recipientRole e validat strict impotriva
    // FAMILY_OCCASION_RECIPIENT_ROLES[occasion] la creare, deci un rol de familie implica
    // intotdeauna un occasion de familie si invers), deci acest refactor NU schimba
    // comportamentul pentru nicio comanda existenta. Diferenta conteaza DOAR pentru a doua
    // melodie Premium, unde recipientRole2 poate fi o categorie de familie complet diferita
    // de occasion-ul comenzii (ex. occasion='parinti', recipientRole2='grandmother') — acolo
    // adresarea "relatie+nume" trebuie sa se activeze dupa rolul ALES pentru acea melodie, nu
    // dupa occasion-ul comun al comenzii.
    if (!FAMILY_RECIPIENT_ROLE_VALUES.includes(effectiveRecipientRole)) {
      // Comportament ORIGINAL, neschimbat, pentru Nuntă/Botez.
      return useShortOccasionInstruction
        ? (senderNoun
            ? ` Mention once: recipient's ${recipientNoun}, song from their ${senderNoun}.`
            : ` Mention once: dedicated to recipient as their ${recipientNoun}.`)
        : (senderNoun
            ? ` Mention naturally, once, that the recipient is their ${recipientNoun} and the song is from their ${senderNoun}.`
            : ` Mention naturally, once, that this song is dedicated to the recipient as their ${recipientNoun}.`);
    }
    const roForm = RO_RELATION_NAME_FORMS[effectiveRecipientRole];
    const roNoun = (lyricsLanguage === 'Romanian' && roForm) ? `"${roForm}"` : `"${recipientNoun}"`;
    const bothKeys = FAMILY_BOTH_PAIR_KEYS[effectiveRecipientRole];
    // CORECȚIE (2026-08-13, runda 8, "elimină câmpurile duplicate de nume la Amândoi"): NU mai
    // depinde de order.recipientNames (doua nume separate) — clientul introduce acum ambele
    // nume o singura data, in campul unic `recipient` (pasul 2/mini-pagina pasul 8) — semnalul
    // "Amândoi" ramane STRICT recipientMode==='both', suficient si pentru comenzile vechi (care
    // au si recipientNames, ignorat aici acum) si pentru cele noi (care nu il mai au deloc).
    const isBoth = bothKeys && order.recipientMode === 'both';
    let clause = useShortOccasionInstruction
      ? (senderNoun
          ? ` Address as ${roNoun}+name, never bare name (from their ${senderNoun}).`
          : ` Address as ${roNoun}+name, never bare name.`)
      : (senderNoun
          ? ` Always address the recipient as ${roNoun} plus their name (never bare first name); the song is from their ${senderNoun}.`
          : ` Always address the recipient as ${roNoun} plus their name, never by first name alone.`);
    if (isBoth) clause += ' Never omit either person.';
    return clause;
  }
  function currentOccasionInstruction() {
    if (!includeOccasionInstruction) return '';
    return ' ' + (useShortOccasionInstruction ? occasionInstructionSet.short : occasionInstructionSet.full) + relationClause();
  }

  // Comenzile vechi (dinainte de sender/relationship) nu au aceste campuri — tratate optional.
  const hasSender = typeof order.senderName === 'string' && order.senderName.trim().length > 0;
  const hasRelationship = hasSender && typeof order.relationship === 'string' && order.relationship.trim().length > 0;

  // CORECȚIE STRICTĂ (hotfix 2026-08-08, punctul 3): pentru "Nuntă/Botez" (si ocaziile de
  // familie) cu "Amândoi", `recipient` poate contine DOUA nume complete (ex. "Alina și Andrei")
  // — NICIODATA trunchiata mai jos, indiferent de buget. Fara aceasta protectie, cascada de
  // scurtare (mai jos) putea reduce al doilea nume la o initiala ("Alina și A."), exact bug-ul
  // raportat — recipient e tratat ca UN SINGUR nume normal (max 60 caractere) in toate celelalte
  // cazuri, inclusiv rolurile individuale de nunta (Mireasă/Mire/Fin/Fină/Naș/Nașă), care raman
  // supuse cascadei ca orice alt nume.
  // CORECȚIE (2026-08-13, runda 8): NU mai depinde de order.recipientNames — vezi comentariul
  // identic de la isBoth mai sus. recipientMode==='both' ramane singurul semnal necesar.
  const recipientIsProtectedCombo = order.recipientMode === 'both';

  // Trunchiere defensiva — chiar daca validarea la creare limiteaza deja lungimea, aplicam
  // din nou aici, sigur, pe caractere Unicode complete. Pentru un combo protejat, plafonul e
  // mult mai mare (doua nume de maxim 60 caractere fiecare + conjunctia), niciodata cel al
  // unui singur nume (RECIPIENT_MAX_LEN) — ar taia al doilea nume chiar la acest prim pas.
  let recipient = truncateSafely(String(order.recipient || '').trim(), recipientIsProtectedCombo ? 140 : RECIPIENT_MAX_LEN);
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
  // CORECȚIE (2026-08-13, regresie critica "melodii instrumentale"): cuvantul "instrumental"
  // aparea LITERAL de doua ori in fiecare instructiune completa ("instrumental intro",
  // "instrumental opening") — desi gramatical corect ("un intro SCURT, instrumental, apoi
  // intra vocea"), prezenta cuvantului insusi in promptul trimis furnizorului poate influenta
  // decizia acestuia de a genera o piesa integral instrumentala, mai ales pe un prompt lung.
  // Eliminat complet — formularile de mai jos raman identice ca sens (intro scurt, vocea
  // incepe la 8-10 secunde), fara sa mai contina niciodata cuvantul "instrumental".
  // CORECȚIE (2026-08-13, "povestea din prima strofă"): clauza de deschidere a primului vers
  // NU e adaugata separat/suplimentar (asta ar consuma buget in plus fata de instructiunea deja
  // existenta si ar fi prima sacrificata de cascada de scurtare — testat empiric, ramanea
  // eliminata aproape mereu). In schimb, ESTE INTEGRATA direct in instructiune, INLOCUIND text
  // redundant ("Use a short natural intro" / "never after a long opening" se suprapun oricum cu
  // "start vocals around 8-10 seconds") — lungimea totala ramane egala sau mai mica decat
  // inainte, deci supravietuieste in `head` la fel de fiabil ca instructiunea originala, pentru
  // orice comanda reala unde instructiunea originala ar fi supravietuit. "never invented" preia
  // rolul clauzei vechi "Use only real details from the story — invent nothing" (pastrata ca
  // cerinta, doar reformulata mai scurt ca sa incapa alaturi de clauza noua de prim vers).
  //
  // CORECȚIE (2026-08-13, runda "cuvinte taiate/versuri incorecte gramatical" — ex. real,
  // raportat live: "ești totul pentru mi" in loc de "ești totul pentru mine"): am verificat
  // exhaustiv codul propriu (extractSunoTracks, buildVariantFromTrack, afisarea din
  // melodia-mea.html, schema DB — variants e JSONB, fara nicio limita de tip VARCHAR) — NU
  // exista nicio trunchiere proprie a versurilor generate; taierea/forma incorecta provine din
  // felul in care furnizorul (Suno, customMode:false, isi scrie singur versurile din promptul
  // descriptiv) alege sa comprime cuvinte pentru rima/ritm. Singura parghie reala disponibila e
  // o instructiune explicita, care cere clar cuvinte intregi si gramatica corecta — adaugata
  // aici (bugetul marit la 600 face loc acestei clauze fara sa elimine povestea).
  const instructionWithSenderFull = ' Write this as a personal song from the sender to the recipient, opening the first verse with a real, specific, never-invented detail from the story — never a generic line. Use only complete, grammatically correct words in the target language — never a shortened or invented word form. Start the vocals around 8-10 seconds, never immediately. Name the recipient early and again in the chorus. Mention the sender once.';
  // fereastra SCURTA trebuie sa ramana chiar scurta (folosita cand bugetul fix, `head`, tot nu
  // incape — daca ea insasi devine lunga, cascada de scurtare isi pierde sensul, exact bug-ul
  // gasit empiric aici la runda "cuvinte taiate": adaugarea clauzei de gramatica ca text simplu
  // concatenat umfla forma "scurta" la 200+ caractere, impingand `head` mult peste buget chiar
  // si pentru comenzi tipice, scurte).
  const instructionWithSenderShort = ' Short intro; verse 1: real, not invented, story detail; complete words only, no shortening; name recipient early+chorus; mention sender once.';
  const instructionNoSenderFull = ' Open the first verse with a real, specific, never-invented detail from the story — never a generic line. Use only complete, grammatically correct words in the target language — never a shortened or invented word form. Start the vocals around 8-10 seconds, never immediately. Address the recipient by name naturally in the lyrics.';
  const instructionNoSenderShort = ' Short intro; verse 1: real, not invented, story detail. Address recipient by name naturally, complete words only, no shortening.';

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
  //
  // CORECȚIE (2026-08-13, runda 3, "construiește melodia din povestea clientului, începând
  // cu primele versuri"): promptul complet e ACUM impartit in DOUA bucati (headPart1/headPart2)
  // ca povestea sa poata fi plasata INTRE ele — imediat dupa stil+limba+CINE (destinatar/
  // expeditor/relatie), inaintea instructiunilor de ocazie/personalizare/voce. Motivul: desi
  // clauza "open verse 1 with a real detail" exista deja in instructiune (currentInstruction()),
  // povestea insasi aparea mereu ULTIMA in promptul trimis catre Suno — dupa toate etichetele
  // tehnice — ceea ce (verificat pe comenzi reale de productie) o facea sa para material
  // secundar, nu subiectul principal al melodiei. Mutata acum imediat langa "cine e melodia
  // asta despre", inaintea instructiunilor "cum s-o construiesti" — model comun, eficient, de
  // structurare a promptului (context intai, instructiuni de folosire a lui dupa). Lungimea
  // totala a `head` (headPart1+headPart2) ramane IDENTICA cu inainte — doar ORDINEA in promptul
  // final se schimba (vezi mai jos); cascada de scurtare de mai jos ramane neschimbata (masoara
  // acelasi total).
  function buildHeadPart1(rec, snd, rel) {
    let lines = `Recipient: ${rec}.`;
    // IMPORTANT: verificam valoarea CURENTA (snd/rel, care pot fi golite de cascada de
    // scurtare de mai jos), nu flag-urile fixe hasSender/hasRelationship calculate o
    // singura data la inceput — altfel, o relatie golita explicit tot ar aparea ca
    // "Relationship: ." (segment gol, in loc sa fie omis complet, irosind spatiu).
    if (hasSender && snd) lines += ` Sender: ${snd}.`;
    if (hasRelationship && rel) lines += ` Relationship: ${rel}.`;
    return `${styleTags}. Write the song lyrics entirely in ${lyricsLanguage}. ${lines}`;
  }
  function buildHeadPart2() {
    return ` Occasion: ${occasionLabel}.${currentOccasionInstruction()}${currentInstruction()}${currentVoiceInstruction()}`;
  }
  function buildFixedPart(rec, snd, rel) {
    return buildHeadPart1(rec, snd, rel) + buildHeadPart2();
  }

  let head = buildFixedPart(recipient, sender, relationship);

  // Daca partea fixa tot nu lasa spatiul minim garantat pentru poveste (campuri foarte lungi
  // combinate cu un gen muzical/ocazie cu descriere mai lunga), scurtam progresiv, IN ACEASTA
  // ORDINE EXPLICITA (corectie fata de versiunea anterioara):
  //   1. instructiunea de ocazie -> forma scurta;
  //   2. instructiunea de personalizare/intro -> forma scurta;
  //   3. instructiunea de voce -> forma scurta (NICIODATA eliminata complet daca s-a ales
  //      explicit o voce — vezi comentariul de la VOICE_INSTRUCTIONS_SHORT mai sus);
  //   4. relatia (text liber, descriptiv, NU un nume propriu) — scurtata progresiv, NICIODATA
  //      eliminata complet.
  // Povestea insasi nu e scurtata aici — bugetul ei se calculeaza separat mai jos, cu o
  // rezerva minima garantata (STORY_MIN_RESERVE, 160-180 caractere utile).
  //
  // CORECȚIE (2026-08-13, runda 6, "numele proprii sunt imuabile" — ex. real, raportat live:
  // numele expeditorului "Alexandru" aparea in versuri ca "Alexandr"): pasii care trunchiau
  // `sender`/`recipient` la 30/15/8-10 caractere AU FOST ELIMINAȚI COMPLET — un nume real de 9+
  // caractere ("Alexandru") putea fi taiat exact la mijloc de pasul final ("sender", 8 caractere),
  // pierzand ultima litera. NUMELE PROPRII (destinatar, expeditor) nu se mai trunchiaza NICIODATA
  // in aceasta cascada — acelasi tratament ca recipientIsProtectedCombo ("Amândoi", deja protejat
  // complet) extins acum la TOATE numele, in toate cazurile. In scenariile extreme (nume foarte
  // lungi SI ocazie/gen cu descriere lunga), `head` poate depasi usor budgetForFixedPart — accepta
  // deliberat, ca in orice alt caz extrem documentat mai sus: povestea primeste corespunzator mai
  // putin spatiu, NICIODATA numele.
  const budgetForFixedPart = SUNO_PROMPT_MAX_LEN - STORY_MIN_RESERVE;
  const shrinkSteps = [
    () => { useShortOccasionInstruction = true; },
    () => { useShortInstruction = true; },
    () => { useShortVoiceInstruction = true; },
    () => { relationship = truncateSafely(relationship, 20); },
    () => { relationship = truncateSafely(relationship, 10); }
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

  // CORECȚIE (2026-08-13, "povestea din prima strofă"): pe langa clauza integrata deja in
  // `currentInstruction()` (care nu consuma buget suplimentar fata de instructiunea originala),
  // adaugam AICI un al doilea semnal, direct langa povestea insasi — dar DOAR daca bugetul
  // ramas ii face loc fara sa fure spatiu util din continutul povestii propriu-zise. Trei
  // variante, alese in cascada dupa spatiul chiar disponibil (`remaining`, calculat mai jos):
  // eticheta completa (cu instructiune), eticheta scurta (instructiune minimala), sau eticheta
  // simpla originala (fara instructiune) — niciodata mai putin generoasa cu povestea decat
  // varianta dinainte de aceasta corectie. Continutul povestii ramane prioritar fata de
  // formularea instructiunii (cerinta explicita — nu sacrificam informatii reale din poveste
  // ca sa incapa text explicativ suplimentar).
  // CORECȚIE (2026-08-13, "mesajele clientului dispar din versuri" — ex. real, raportat live:
  // "La mulți ani din partea nașilor Andrei și Mara" lipsea complet din versuri): etichetele
  // Full/Short cer acum explicit reproducerea CUVANT CU CUVANT a oricarui mesaj/urare scrisa
  // explicit de client in poveste — nu doar folosirea "unor detalii" din ea. Ramane totusi
  // subordonata continutului real al povestii (vezi MIN_USEFUL_STORY_CHARS mai jos): daca
  // bugetul nu face loc etichetei, cade pe eticheta simpla, niciodata pe eliminarea povestii.
  // CORECȚIE (2026-08-13, runda 4, "versurile contin detalii inventate" — ex. real, raportat
  // live: "Țin minte mâinile tale cum făceau ceaiul" pentru o poveste care NU mentiona ceaiul):
  // clauza "include any explicit message word-for-word" a fost inlocuita in eticheta SCURTA cu
  // "invent nothing beyond it" — mai scurta (deci supravietuieste mai des cascadei de scurtare)
  // SI directa la cauza principala raportata acum (inventia, nu doar omiterea mesajelor). Forma
  // COMPLETA pastreaza ambele cerinte (mesaj exact + fara inventii), folosita cand bugetul chiar
  // permite.
  const storyLabelPlain = ' Story/details to include: ';
  const storyLabelShort = ' Verse 1 opens with a real story detail — invent nothing beyond it. Story: ';
  const storyLabelFull = ' First verse must open with a real detail from this story, never a generic line; include any explicit written message exactly; invent nothing beyond what is written here. Story: ';
  const MIN_USEFUL_STORY_CHARS = 40;
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
  // de mai sus, dar tratat sigur oricum). Alegem eticheta cea mai instructiva care tot lasa
  // cel putin MIN_USEFUL_STORY_CHARS pentru continutul real al povestii.
  let storyLabel = storyLabelFull;
  if (remaining - storyLabel.length < MIN_USEFUL_STORY_CHARS) storyLabel = storyLabelShort;
  if (remaining - storyLabel.length < MIN_USEFUL_STORY_CHARS) storyLabel = storyLabelPlain;

  let storyFull = '';
  const storyBudget = remaining - storyLabel.length;
  if (storyBudget > 0) {
    const storyTrimmed = truncateSafely(order.story, storyBudget);
    if (storyTrimmed) {
      storyFull = `${storyLabel}${storyTrimmed}`;
    }
  }

  // CORECȚIE (2026-08-13, runda 3): povestea (storyFull) e plasata ACUM intre cele doua
  // bucati ale partii fixe — imediat dupa stil+limba+CINE (headPart1), inaintea ocaziei si
  // instructiunilor de personalizare/voce (headPart2) — vezi comentariul de la buildHeadPart1/2
  // de mai sus. `head` (folosit doar pentru calculul bugetului, mai sus) ramane byte-identic ca
  // lungime cu buildHeadPart1(...) + buildHeadPart2() — doar promptul FINAL trimis catre Suno
  // are ordinea schimbata.
  let prompt = `${buildHeadPart1(recipient, sender, relationship)}${storyFull}${buildHeadPart2()}${feedbackFull}`;

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
// ADAUGAT (2026-08-13) — cerinta "pastrarea exacta a versurilor editate": construieste cererea
// customMode:true pentru SunoAPI, folosita STRICT cand clientul a editat manual versurile unei
// melodii (editor -> POST /regenerate). Spre deosebire de buildPrompt() (customMode:false, Suno
// scrie singur versurile dintr-un prompt descriptiv), aici campul "prompt" trimis catre Suno
// devine EXACT `exactLyrics`, verbatim — Suno il canta ca atare, fara sa il rescrie ("The
// prompt will be strictly used as the lyrics and sung in the generated track.", confirmat
// direct in documentatia oficiala docs.sunoapi.org). Nu mai trecem povestea/ocazia/destinatarul
// aici — versurile deja editate de client CONTIN toata personalizarea ceruta; repetarea lor
// intr-un camp separat ar fi doar zgomot si ar concura inutil cu bugetul de caractere.
// Returneaza {style, title, lyrics} — vezi callMusicProvider() pentru cum sunt trimise mai
// departe catre furnizor.
function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {
  const lyrics = String(exactLyrics || '').trim();
  if (!lyrics) {
    throw new Error('Versurile editate sunt goale — cererea cu versuri exacte nu poate fi trimisa.');
  }

  const lyricsLanguage = LYRICS_LANGUAGE_NAMES[order.lang] || 'Romanian';
  const styleTags = GENRE_STYLE_MAP[genreOverride || order.genre] || 'pop, warm vocals';

  const VOICE_STYLE_NOTE = {
    female: ' Female lead vocal.',
    male: ' Male lead vocal.',
    duet: ' Male and female duet, both voices clearly present.',
    auto: ''
  };
  const effectiveVoice = VOICE_PREFERENCES.includes(voicePreference) ? voicePreference : 'auto';

  // Stilul (max. 1000 caractere pentru V4_5ALL, verificat in documentatia oficiala) — DOAR
  // directie muzicala/vocala, niciodata versuri sau poveste (acelea sunt deja in `lyrics`).
  // Feedback-ul liber al clientului ("Nu este exact cum îți dorești?", ex: "mai vesel, mai
  // lent") e despre STIL/interpretare, niciodata versuri — merge aici, niciodata amestecat in
  // campul `lyrics` (care ramane STRICT textul editat, verbatim, nimic altceva adaugat).
  // CORECȚIE (2026-08-13, regresie critica "melodii instrumentale"): eliminat cuvantul
  // "instrumental" din text (vezi comentariul identic din buildPrompt) si adaugata o afirmare
  // explicita, pozitiva, ca melodia are voce pe tot parcursul — niciodata doar formularea
  // negativa/ambigua de dinainte.
  // CORECȚIE (2026-08-13, runda 6, "audio-ul canta alte cuvinte decat versurile afisate"):
  // investigat exhaustiv traseul audio<->versuri (taskId, track.id, variantId, extractSunoTracks,
  // polling, callback, finalizeVariantsIfNeeded) — fiecare pas e corect scopat pe identificatori
  // stabili, fara nicio asociere gresita gasita in codul propriu. Suno promite explicit ("The
  // prompt will be strictly used as the lyrics and sung", docs.sunoapi.org) ca respecta exact
  // versurile la customMode:true, dar promisiunea nu era intarita EXPLICIT in campul `style`
  // (folosit doar pentru directie muzicala) — adaugata aici o cerere directa, ca semnal
  // suplimentar catre furnizor, fara sa schimbe contractul (versurile raman STRICT in `lyrics`,
  // niciodata duplicate/alterate aici).
  const feedbackText = feedback ? String(feedback).trim() : '';
  let style = `${styleTags}. Sing entirely in ${lyricsLanguage}. Short natural intro, vocals starting around 8-10 seconds. Fully sung vocal performance throughout.${VOICE_STYLE_NOTE[effectiveVoice]} Sing these exact lyrics precisely as written, word for word — never paraphrase, alter, skip, or add words.`;
  if (feedbackText) style += ` ${feedbackText}`;
  style = truncateSafely(style, 1000);

  // Titlu scurt (max. 80 caractere pentru V4_5ALL) — derivat din destinatar, fara sa expuna
  // niciun detaliu din poveste; simplu fallback daca destinatarul lipseste.
  const recipient = String(order.recipient || '').trim();
  const title = truncateSafely(recipient ? `Song for ${recipient}` : 'Naluna', 80);

  return { style, title, lyrics };
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

// RELANSARE (2026-08-14, upload multipart direct catre R2): fara CORS configurat pe bucket-ul
// PRIVAT pentru originea site-ului, orice PUT direct din browser catre R2 (fragmentele de
// upload) e blocat silentios de browser (preflight CORS respins) — necesar ca uploadul de
// videoclipuri mari sa functioneze cu adevarat "direct", nu doar in cod.
//
// CORECȚIE (2026-08-14, "am actualizat si salvat regula CORS existenta manual"): initial,
// aceasta functie INCERCA sa configureze CORS automat (PutBucketCors) la fiecare pornire —
// dupa ce clientul a configurat manual regula corecta direct in Cloudflare, am descoperit ca
// PutBucketCors INLOCUIESTE intreaga configurare CORS (nu adauga reguli); daca ar mai fi rulat
// vreodata cu succes, ar fi sters silentios regulile GET/HEAD adaugate manual. Acum DOAR
// verifica (citire, niciodata scriere) daca bucket-ul are deja o regula suficienta — fire-and-
// forget, nefatal, raporteaza explicit in log daca lipseste, dar nu mai modifica NICIODATA
// configurarea CORS a bucket-ului din cod.
function checkUploadCorsAtBoot() {
  if (!storage.CLOUD_ENABLED) return;
  const origins = [DOMAIN].filter(Boolean);
  storage.checkUploadCors(origins).then(result => {
    if (result.ok) {
      console.log(`Storage: CORS pe bucket-ul privat permite deja upload direct pentru originea ${origins.join(', ')}.`);
    } else if (result.verified === false) {
      // NU inseamna ca uploadul e stricat — doar ca token-ul R2 "Object Read & Write" nu are
      // voie sa CITEASCA nici macar configurarea bucket-ului (o permisiune administrativa,
      // separata de operatiile pe obiecte). Verificarea reala a functionarii se face manual/
      // printr-un upload real, nu prin acest log.
      console.warn(
        `Storage: nu am putut CITI configurarea CORS a bucket-ului privat, ca sa o verific automat — ${result.reason}. ` +
        `Asta nu inseamna ca uploadul direct e nefunctional (token-ul poate avea totusi voie sa faca operatii pe obiecte, ` +
        `doar nu sa citeasca setarile bucket-ului) — verifica printr-un upload real daca ai dubii.`
      );
    } else {
      console.error(
        `Storage: CORS pe bucket-ul privat NU permite (inca) upload direct — ${result.reason}. ` +
        `Uploadul multipart direct catre R2 (videoclipuri mari, Cadou video) nu va functiona pana la o ` +
        `configurare manuala CORS pe bucket-ul privat (dashboard R2/Cloudflare), permitand PUT de la ${origins.join(', ')} si expunand header-ul ETag.`
      );
    }
  }).catch(err => {
    console.error('Storage: verificarea CORS a esuat neasteptat:', err.message);
  });
}

// -------- pornire: verificam intai conexiunea la baza de date --------
db.initDb()
  .then(() => {
    checkFfmpegAvailability(); // fire-and-forget — nu blocheaza si nu conditioneaza pornirea
    checkExiftoolAvailability(); // fire-and-forget, acelasi motiv
    checkHeifConvertAvailability(); // fire-and-forget, acelasi motiv
    checkUploadCorsAtBoot(); // fire-and-forget, acelasi motiv
    app.listen(PORT, () => {
      console.log(`NALUNA ruleaza pe ${DOMAIN}`);
    });
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la PostgreSQL la pornire:', err.message);
    process.exit(1);
  });
