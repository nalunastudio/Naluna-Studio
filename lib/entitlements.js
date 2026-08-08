// ==========================================================================================
// "Melodia cadou" — logica PURA (fara acces la DB/storage/retea), extrasa aici ca sa poata fi
// testata izolat. server.js importa getGiftVariant() ca SINGURA sursa a acestei reguli —
// vezi comentariul de la getGiftVariant in server.js pentru contextul complet.
//
// Regula: Suno genereaza intotdeauna 2 piese per generare, iar order.variants[] e INLOCUIT
// COMPLET la fiecare regenerare (finalizeVariantsIfNeeded) — deci "celalalt element din
// variants[]" e mereu, garantat, generatia CURENTA aprobata, niciodata o varianta veche
// dintr-o generare anterioara. "Melodia cadou" e livrata la Premium/Video (doua genuri
// diferite, DOUA melodii complete distincte, promisiunea ferma a pachetului).
//
// HOTFIX 2026-08-08 (fluxul de editare cu alegere Standard): Standard NU mai livreaza
// niciodata o "melodie cadou". De cand editarea Standard poate pastra ambele variante
// (varianta initiala + varianta editata a ACELEIASI melodii, vezi finalizeVariantsIfNeeded
// options.keepOriginalAsAlternative) exista si pentru Standard comenzi cu 2 elemente in
// variants[] — dar ele NU sunt doua melodii diferite, ci doua variante ALE ACELEIASI melodii,
// din care clientul alege UNA singura inainte de plata. Livrarea celeilalte ca "bonus" ar
// incalca exact cerinta explicita a clientului ("Standard ramane o singura melodie finala").
// ==========================================================================================

function getGiftVariant(order) {
  if (!order || order.plan === 'standard') return null;
  const variants = order.variants || [];
  const selectedId = order.selectedVariantId;
  return variants.find(v => v.id !== selectedId) || null;
}

module.exports = { getGiftVariant };
