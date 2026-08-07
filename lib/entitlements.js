// ==========================================================================================
// "Melodia cadou" — logica PURA (fara acces la DB/storage/retea), extrasa aici ca sa poata fi
// testata izolat. server.js importa getGiftVariant() ca SINGURA sursa a acestei reguli —
// vezi comentariul de la getGiftVariant in server.js pentru contextul complet.
//
// Regula: Suno genereaza intotdeauna 2 piese per generare, iar order.variants[] e INLOCUIT
// COMPLET la fiecare regenerare (finalizeVariantsIfNeeded) — deci "celalalt element din
// variants[]" e mereu, garantat, generatia CURENTA aprobata, niciodata o varianta veche
// dintr-o generare anterioara. "Melodia cadou" e livrata la toate cele trei pachete
// (Standard/Premium/Video), nu doar la varianta principala.
// ==========================================================================================

function getGiftVariant(order) {
  const variants = (order && order.variants) || [];
  const selectedId = order && order.selectedVariantId;
  return variants.find(v => v.id !== selectedId) || null;
}

module.exports = { getGiftVariant };
