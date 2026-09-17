// lib/social/facebook-adapter.js
// Integrare Facebook Page — Graph API "clasic", pe host graph.facebook.com, autentificat
// STRICT cu Page Access Token (META_FACEBOOK_PAGE_ACCESS_TOKEN). Acest fisier NU stie nimic
// despre Instagram — cele doua platforme au fluxuri de autentificare diferite (vezi
// instagram-adapter.js, host graph.instagram.com, Instagram Login) si nu trebuie amestecate.
//
// Pagina Naluna Studio nu are un Page ID hardcodat aici: se rezolva dinamic, la fiecare
// publicare, din tokenul curent (GET /me — cu un Page Access Token, /me e Pagina insasi, nu
// utilizatorul care a generat tokenul). Asta evita sa tinem un ID static care ar putea
// deveni incorect daca tokenul e vreodata regenerat pentru alta Pagina.

const { fetchWithTimeout } = require('../fetch-with-timeout');

const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

class FacebookApiError extends Error {
  constructor(message, apiError) {
    super(message);
    this.name = 'FacebookApiError';
    this.apiError = apiError || null;
  }
}

async function parseGraphResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new FacebookApiError(
      (body.error && body.error.message) || `Facebook Graph API a raspuns cu status ${res.status}`,
      body.error || null
    );
  }
  return body;
}

// Page Access Token -> ID-ul Paginii careia ii apartine tokenul.
async function getFacebookPageId({ accessToken }) {
  if (!accessToken) throw new Error('getFacebookPageId: accessToken lipseste');
  const url = `${BASE_URL}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithTimeout(url);
  const body = await parseGraphResponse(res);
  return { pageId: body.id, name: body.name };
}

// Publica o singura imagine sau un singur videoclip pe Pagina Facebook. Nu suporta inca
// carusel/album — nu a fost ceruta aceasta functionalitate pentru etapa curenta.
async function publishToFacebookPage({ accessToken, pageId, mediaType, mediaUrl, caption }) {
  if (!accessToken) throw new Error('publishToFacebookPage: accessToken lipseste');
  if (!pageId) throw new Error('publishToFacebookPage: pageId lipseste');
  if (!mediaUrl) throw new Error('publishToFacebookPage: mediaUrl lipseste');
  if (mediaType !== 'image' && mediaType !== 'video') {
    throw new Error(`publishToFacebookPage: mediaType necunoscut "${mediaType}" (accepta "image" sau "video")`);
  }

  const endpoint = mediaType === 'image' ? 'photos' : 'videos';
  const params = new URLSearchParams({ access_token: accessToken });
  if (mediaType === 'image') {
    params.set('url', mediaUrl);
    if (caption) params.set('caption', caption);
  } else {
    params.set('file_url', mediaUrl);
    if (caption) params.set('description', caption);
  }

  const res = await fetchWithTimeout(`${BASE_URL}/${pageId}/${endpoint}`, { method: 'POST', body: params });
  const body = await parseGraphResponse(res);
  return { postId: body.post_id || body.id, raw: body };
}

module.exports = {
  API_VERSION,
  BASE_URL,
  FacebookApiError,
  getFacebookPageId,
  publishToFacebookPage
};
