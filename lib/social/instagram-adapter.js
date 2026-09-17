// lib/social/instagram-adapter.js
// Integrare Instagram — STRICT fluxul "Instagram API with Instagram Login" (lansat de Meta
// in iulie 2024), NU Instagram Graph API prin Facebook Login. Diferenta e esentiala si
// documentata explicit de Meta:
//   - host-ul TUTUROR cererilor e graph.instagram.com (nu graph.facebook.com);
//   - contul Instagram NU trebuie sa fie legat de o Pagina Facebook;
//   - permisiunile sunt instagram_business_basic + instagram_business_content_publish
//     (nu instagram_basic / instagram_content_publish / pages_read_engagement, folosite
//     de fluxul vechi prin Facebook Login).
// Confirmat direct din documentatia oficiala Meta (developers.facebook.com/docs/
// instagram-platform/instagram-api-with-instagram-login/), septembrie 2026.
//
// Autentificat STRICT cu META_INSTAGRAM_ACCESS_TOKEN — complet separat de
// META_FACEBOOK_PAGE_ACCESS_TOKEN (vezi facebook-adapter.js). Nu amesteca cele doua.

const { fetchWithTimeout } = require('../fetch-with-timeout');

const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.instagram.com/${API_VERSION}`;

class InstagramApiError extends Error {
  constructor(message, apiError) {
    super(message);
    this.name = 'InstagramApiError';
    this.apiError = apiError || null;
  }
}

async function parseGraphResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new InstagramApiError(
      (body.error && body.error.message) || `Instagram API a raspuns cu status ${res.status}`,
      body.error || null
    );
  }
  return body;
}

// Tokenul Instagram Login -> ID-ul contului Instagram profesional autentificat (user_id).
// Acesta e ID-ul folosit mai jos pentru /media si /media_publish — NU instagram_business_account
// legat de o Pagina (acela apartine fluxului Facebook Login, nu celui de aici).
async function getInstagramUserId({ accessToken }) {
  if (!accessToken) throw new Error('getInstagramUserId: accessToken lipseste');
  const url = `${BASE_URL}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithTimeout(url);
  const body = await parseGraphResponse(res);
  return { igUserId: body.user_id, username: body.username };
}

// Pasul 1 din publicare: creeaza un container media (nepublicat inca). Containerul expira
// dupa 24h daca nu e publicat. Pentru un post standard de imagine/video in feed NU se trimite
// media_type (valorile CAROUSEL/REELS/STORIES sunt explicite, dar nu sunt nevoie aici — nu au
// fost cerute pentru etapa curenta).
async function createMediaContainer({ accessToken, igUserId, mediaType, mediaUrl, caption }) {
  if (!accessToken) throw new Error('createMediaContainer: accessToken lipseste');
  if (!igUserId) throw new Error('createMediaContainer: igUserId lipseste');
  if (!mediaUrl) throw new Error('createMediaContainer: mediaUrl lipseste');
  if (mediaType !== 'image' && mediaType !== 'video') {
    throw new Error(`createMediaContainer: mediaType necunoscut "${mediaType}" (accepta "image" sau "video")`);
  }

  const params = new URLSearchParams({ access_token: accessToken });
  if (caption) params.set('caption', caption);
  if (mediaType === 'image') params.set('image_url', mediaUrl);
  else params.set('video_url', mediaUrl);

  const res = await fetchWithTimeout(`${BASE_URL}/${igUserId}/media`, { method: 'POST', body: params });
  const body = await parseGraphResponse(res);
  return { containerId: body.id };
}

// Pasul 2 (verificare): status_code al containerului — IN_PROGRESS, FINISHED, ERROR, EXPIRED
// sau PUBLISHED. Imaginile devin de obicei FINISHED aproape instant; videoclipurile pot
// ramane IN_PROGRESS cateva secunde pana la cateva minute.
async function getContainerStatus({ accessToken, containerId }) {
  if (!accessToken) throw new Error('getContainerStatus: accessToken lipseste');
  if (!containerId) throw new Error('getContainerStatus: containerId lipseste');
  const url = `${BASE_URL}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithTimeout(url);
  const body = await parseGraphResponse(res);
  return body.status_code;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Interogheaza status_code la interval regulat pana devine FINISHED (gata de publicare),
// pana la maxAttempts incercari, sau arunca imediat daca Meta raporteaza ERROR/EXPIRED.
// sleepFn e injectabil STRICT pentru teste (ca sa nu astepte cu adevarat intervalMs).
async function waitForContainerReady({ accessToken, containerId, maxAttempts = 10, intervalMs = 3000, sleepFn = defaultSleep }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await getContainerStatus({ accessToken, containerId });
    if (status === 'FINISHED') return status;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new InstagramApiError(`Containerul media Instagram a esuat cu status ${status}`, { status_code: status });
    }
    if (attempt < maxAttempts) await sleepFn(intervalMs);
  }
  throw new InstagramApiError('Containerul media Instagram nu a devenit FINISHED in timpul alocat', { timeout: true });
}

// Pasul 3: publica efectiv containerul deja pregatit (status FINISHED).
async function publishContainer({ accessToken, igUserId, containerId }) {
  if (!accessToken) throw new Error('publishContainer: accessToken lipseste');
  if (!igUserId) throw new Error('publishContainer: igUserId lipseste');
  if (!containerId) throw new Error('publishContainer: containerId lipseste');
  const params = new URLSearchParams({ access_token: accessToken, creation_id: containerId });
  const res = await fetchWithTimeout(`${BASE_URL}/${igUserId}/media_publish`, { method: 'POST', body: params });
  const body = await parseGraphResponse(res);
  return { postId: body.id };
}

// Orchestreaza cei 3 pasi (container -> asteapta FINISHED -> publish) intr-un singur apel,
// folosit de serviciul central de publishing (social-publisher.js).
async function publishToInstagram({ accessToken, igUserId, mediaType, mediaUrl, caption, pollOptions }) {
  const { containerId } = await createMediaContainer({ accessToken, igUserId, mediaType, mediaUrl, caption });
  await waitForContainerReady({ accessToken, containerId, ...pollOptions });
  const { postId } = await publishContainer({ accessToken, igUserId, containerId });
  return { postId, containerId };
}

// Reinnoieste un token long-lived existent (trebuie sa aiba cel putin 24h vechime si sa nu fi
// expirat inca — impus de Meta, nu verificat aici). Intoarce un token NOU, valabil inca 60 zile
// de la momentul refresh-ului — NU extinde tokenul vechi, il inlocuieste. Functie PURA, STATELESS
// (nu scrie nicaieri noul token) — persistenta lui e responsabilitatea apelantului; vezi nota
// de arhitectura din raportul de etapa pentru cum va fi folosita in etapa de scheduling.
async function refreshInstagramAccessToken({ accessToken }) {
  if (!accessToken) throw new Error('refreshInstagramAccessToken: accessToken lipseste');
  const url = `${BASE_URL}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithTimeout(url);
  const body = await parseGraphResponse(res);
  return { accessToken: body.access_token, expiresIn: body.expires_in, tokenType: body.token_type };
}

module.exports = {
  API_VERSION,
  BASE_URL,
  InstagramApiError,
  getInstagramUserId,
  createMediaContainer,
  getContainerStatus,
  waitForContainerReady,
  publishContainer,
  publishToInstagram,
  refreshInstagramAccessToken
};
