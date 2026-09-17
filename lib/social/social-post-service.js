// lib/social/social-post-service.js
// Orchestrarea cererilor admin de social publishing — publicare MANUALA instant (Etapa 2) SI
// programare (Etapa 3) — extrasa din rutele server.js ca sa poata fi testata izolat, fara
// Postgres real si fara Express pornit. Acelasi motiv exact ca lib/entitlements.js si
// lib/media-analysis.js (vezi comentariile lor) — server.js NU mai duplica aceasta logica,
// o importa de aici ca singura sursa a ei. Parsarea HTTP propriu-zisa (multer, coduri de
// status, extragerea fisierului din request) ramane STRICT in server.js.
//
// `db` si `publishPost` sunt injectate explicit de apelant, niciodata importate direct aici —
// testele dau mock-uri (fara Postgres, fara cereri reale catre Meta); server.js da instantele
// reale (./db, lib/social/social-publisher). Workerul (lib/social/social-worker.js) foloseste
// ACEEASI functie computeAttemptPatch (lib/social/social-retry.js) pentru calculul statusului
// dupa o incercare — publicarea manuala si cea programata/retry NU au doua implementari
// separate ale acestei logici.

const { randomUUID } = require('crypto');
const { SUPPORTED_PLATFORMS } = require('./social-publisher');
const { computeAttemptPatch } = require('./social-retry');

// Validari comune, sincrone, fara I/O — partajate intre publicarea instant si programare.
function validateCommonFields({ platforms, mediaType, caption, idempotencyKey, hasFile, mediaKey }) {
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((p) => !SUPPORTED_PLATFORMS.includes(p))) {
    return `Platforme invalide. Accepta: ${SUPPORTED_PLATFORMS.join(', ')}.`;
  }
  if (mediaType !== 'image' && mediaType !== 'video') {
    return 'mediaType trebuie sa fie "image" sau "video".';
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
    return 'idempotencyKey lipseste sau e invalid (necesar pentru a preveni publicarea duplicata).';
  }
  if (caption !== undefined && caption !== null && caption !== '') {
    if (typeof caption !== 'string' || caption.trim().length < 1 || caption.length > 2200) {
      return 'Caption invalid (maximum 2200 caractere).';
    }
  }
  if (!hasFile && (typeof mediaKey !== 'string' || mediaKey.trim().length < 1 || mediaKey.length > 500)) {
    return 'Trimite fie un fișier media, fie un mediaKey existent.';
  }
  return null;
}

function validatePublishRequest(fields) {
  return validateCommonFields(fields);
}

// La fel ca validatePublishRequest, plus scheduledAt: trebuie sa fie o data valida STRICT in
// viitor (o "programare" pentru acum/trecut nu are sens — ar trebui sa foloseasca publicarea
// instant). `scheduledAt` e deja un obiect Date (parsat de apelant din string ISO).
function validateScheduleRequest(fields) {
  const commonError = validateCommonFields(fields);
  if (commonError) return commonError;
  const { scheduledAt, now = new Date() } = fields;
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
    return 'scheduledAt lipseste sau nu e o data valida.';
  }
  if (scheduledAt.getTime() <= now.getTime()) {
    return 'scheduledAt trebuie sa fie in viitor.';
  }
  return null;
}

// Presupune ca `mediaKey` e deja rezolvat (fisier nou urcat DEJA in storage de apelant, sau
// o cheie existenta transmisa direct) — acest fisier nu face niciun upload, doar orchestreaza
// idempotenta + publicarea + persistenta.
//
// Publicarea instant ATACA toate platformele cerute chiar acum (attemptedPlatforms = platforms)
// — spre deosebire de worker (lib/social/social-worker.js), care ataca STRICT platformele
// scadente. Ambele folosesc EXACT acelasi computeAttemptPatch() pentru calculul rezultatului,
// deci o postare instant care esueaza partial intra AUTOMAT in acelasi ciclu de retry/backoff
// ca o postare programata — nu exista un tratament special "postarile instant nu se reincearca".
async function executeSocialPublish({ platforms, mediaType, mediaKey, caption, idempotencyKey, db, publishPost, getPublicUrl, credentials }) {
  // Verificare rapida, NEATOMICA — evita un apel inutil catre publishPost() in cazul comun
  // (retrimitere dupa ce prima cerere a apucat deja sa se termine). Garantia REALA anti-
  // duplicat vine din INSERT ... ON CONFLICT de mai jos (db.createSocialPostIfNew).
  const existingEarly = await db.getSocialPostByIdempotencyKey(idempotencyKey);
  if (existingEarly) return { duplicate: true, post: existingEarly };

  const created = await db.createSocialPostIfNew({
    id: randomUUID(),
    idempotencyKey,
    status: 'publishing',
    platforms,
    mediaType,
    mediaKey,
    caption: caption || null
  });

  if (!created) {
    // Pierdut cursa cu o cerere concurenta care avea EXACT acelasi idempotencyKey — randul ei
    // e sursa unica a adevarului, nu mai publicam a doua oara.
    const existing = await db.getSocialPostByIdempotencyKey(idempotencyKey);
    return { duplicate: true, post: existing };
  }

  const mediaUrl = getPublicUrl(mediaKey);
  const results = await publishPost({ platforms, mediaType, mediaUrl, caption: caption || undefined, credentials });

  const patch = computeAttemptPatch({ post: created, attemptedPlatforms: platforms, results });
  const finalized = await db.finalizeSocialPost(created.id, patch);

  return { duplicate: false, post: finalized };
}

// Creeaza o postare PROGRAMATA — NU publica nimic acum. status='scheduled',
// next_attempt_at = scheduledAt, exact momentul de la care workerul o poate prelua (vezi
// db.claimDueSocialPost). Acelasi mecanism anti-duplicat (idempotencyKey) ca la publicarea
// instant — o retrimitere accidentala a formularului de programare nu creeaza o a doua postare.
async function createScheduledPost({ platforms, mediaType, mediaKey, caption, idempotencyKey, scheduledAt, db }) {
  const existingEarly = await db.getSocialPostByIdempotencyKey(idempotencyKey);
  if (existingEarly) return { duplicate: true, post: existingEarly };

  const created = await db.createSocialPostIfNew({
    id: randomUUID(),
    idempotencyKey,
    status: 'scheduled',
    platforms,
    mediaType,
    mediaKey,
    caption: caption || null,
    scheduledAt,
    nextAttemptAt: scheduledAt
  });

  if (!created) {
    const existing = await db.getSocialPostByIdempotencyKey(idempotencyKey);
    return { duplicate: true, post: existing };
  }

  return { duplicate: false, post: created };
}

module.exports = { validatePublishRequest, validateScheduleRequest, executeSocialPublish, createScheduledPost };
