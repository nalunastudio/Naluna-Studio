// lib/social/social-publisher.js
// SERVICIUL CENTRAL de social publishing — singurul punct prin care Naluna publica pe retele
// sociale, indiferent daca declansarea vine dintr-o actiune manuala din Naluna Admin sau, mai
// tarziu, dintr-un job de scheduling care publica automat la ora programata. Nu exista si nu
// trebuie sa existe un al doilea flux de publicare separat — orice cod nou (ruta manuala, job
// programat) trebuie sa apeleze STRICT publishPost() de aici, niciodata adaptoarele Facebook/
// Instagram direct.
//
// De ce Promise.all + rezultate separate per platforma, niciodata "esec total daca una pica":
// cerinta explicita e sa vezi succesul/eroarea SEPARAT pentru Facebook si Instagram — o postare
// catre 2 platforme unde una reuseste si cealalta pica NU e un esec total, e un rezultat
// "partially_failed" (starea aceea, ca eticheta de status, apartine insa stratului de deasupra —
// vezi nota despre scheduling mai jos).
//
// Acest fisier e intentionat STATELESS — nu scrie nimic in baza de date, nu tine cont de
// "postari" ca entitati, nu previne duplicate. Acelea sunt responsabilitatea stratului urmator
// (ruta manuala din admin + tabela de postari programate cu status draft/scheduled/publishing/
// published/partially_failed/failed si idempotency key), care va INVELI acest serviciu, nu il
// va inlocui. Separarea e intentionata: logica de "cum vorbim cu Meta" nu trebuie sa stie nimic
// despre "cum tinem evidenta postarilor in Naluna".

const { getFacebookPageId, publishToFacebookPage } = require('./facebook-adapter');
const { getInstagramUserId, publishToInstagram } = require('./instagram-adapter');

const SUPPORTED_PLATFORMS = ['facebook', 'instagram'];

// Sursa implicita a credentialelor: variabilele de mediu (Railway in productie). Acceptam
// override explicit prin parametrul `credentials` al publishPost() — asta lasa loc, mai tarziu,
// unei surse persistente (ex. token Instagram reinnoit automat si citit din DB), fara sa
// schimbe semnatura publica a functiei sau adaptoarele.
function resolveCredentials(overrides = {}) {
  return {
    facebookAccessToken: overrides.facebookAccessToken || process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN || null,
    instagramAccessToken: overrides.instagramAccessToken || process.env.META_INSTAGRAM_ACCESS_TOKEN || null
  };
}

async function publishOneToFacebook({ mediaType, mediaUrl, caption, accessToken }) {
  if (!accessToken) {
    throw new Error('META_FACEBOOK_PAGE_ACCESS_TOKEN lipseste — nu se poate publica pe Facebook');
  }
  const { pageId } = await getFacebookPageId({ accessToken });
  const { postId } = await publishToFacebookPage({ accessToken, pageId, mediaType, mediaUrl, caption });
  return { status: 'success', platform: 'facebook', postId };
}

async function publishOneToInstagram({ mediaType, mediaUrl, caption, accessToken, pollOptions }) {
  if (!accessToken) {
    throw new Error('META_INSTAGRAM_ACCESS_TOKEN lipseste — nu se poate publica pe Instagram');
  }
  const { igUserId } = await getInstagramUserId({ accessToken });
  const { postId, containerId } = await publishToInstagram({ accessToken, igUserId, mediaType, mediaUrl, caption, pollOptions });
  return { status: 'success', platform: 'instagram', postId, containerId };
}

// platforms: subset din ['facebook', 'instagram']. mediaType: 'image' | 'video'. mediaUrl:
// URL HTTPS public (vezi storage.js getPublicUrl() — necesar mai ales pentru Instagram, care
// cere ca media sa fie deja publica la momentul cererii). caption: optional, acelasi text
// trimis catre ambele platforme (variatie per-platforma nu a fost ceruta pentru etapa curenta).
//
// Intoarce un obiect cu o cheie per platforma ceruta, NICIODATA arunca pentru un esec izolat
// pe o singura platforma — ex: { facebook: {status:'success', postId}, instagram: {status:
// 'error', message, apiError} }. Arunca doar pentru erori de validare a cererii insasi
// (platforme necunoscute, mediaType invalid, mediaUrl lipsa) — acelea sunt greseli ale
// apelantului, nu esecuri de publicare.
async function publishPost({ platforms, mediaType, mediaUrl, caption, credentials, instagramPollOptions }) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('publishPost: platforms trebuie sa fie un array nevid (ex. ["facebook"], ["instagram"], sau ambele)');
  }
  const unknownPlatforms = platforms.filter((p) => !SUPPORTED_PLATFORMS.includes(p));
  if (unknownPlatforms.length > 0) {
    throw new Error(`publishPost: platforma necunoscuta: ${unknownPlatforms.join(', ')} (suportate: ${SUPPORTED_PLATFORMS.join(', ')})`);
  }
  if (mediaType !== 'image' && mediaType !== 'video') {
    throw new Error(`publishPost: mediaType necunoscut "${mediaType}" (accepta "image" sau "video")`);
  }
  if (!mediaUrl) {
    throw new Error('publishPost: mediaUrl lipseste');
  }

  const creds = resolveCredentials(credentials);
  const results = {};

  await Promise.all(platforms.map(async (platform) => {
    try {
      if (platform === 'facebook') {
        results.facebook = await publishOneToFacebook({ mediaType, mediaUrl, caption, accessToken: creds.facebookAccessToken });
      } else if (platform === 'instagram') {
        results.instagram = await publishOneToInstagram({
          mediaType, mediaUrl, caption, accessToken: creds.instagramAccessToken, pollOptions: instagramPollOptions
        });
      }
    } catch (err) {
      results[platform] = {
        status: 'error',
        platform,
        message: err.message,
        apiError: err.apiError || null
      };
    }
  }));

  return results;
}

module.exports = { publishPost, SUPPORTED_PLATFORMS };
