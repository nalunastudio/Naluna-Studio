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
//
// MODIFICARE STRICTĂ — fluxul Premium: editare selectiva + comparare finala (hotfix 2026-08-10
// runda 3): Premium poate acum avea 3 sau 4 variante reale (dupa editarea uneia sau ambelor
// melodii, care ADAUGA rezultatele noi alaturi de cele initiale, niciodata nu le inlocuieste
// — vezi finalizeVariantsIfNeeded, options.editVariantIds). "Cealalta varianta" (gasita prin
// simpla eliminare a lui selectedVariantId) devine AMBIGUA in acest caz — poate fi oricare din
// 2-3 variante ramase, nu neaparat cea aleasa explicit de client pe pagina de comparare. Pentru
// Premium cu selectedVariantId2 completat (obligatoriu inainte de plata, vezi POST /checkout),
// folosim STRICT acea a doua selectie explicita. Video (niciodata selectedVariantId2, mereu
// exact 2 variante) si comenzile Premium foarte vechi (dinainte de aceasta migrare, fara
// selectedVariantId2) raman pe regula originala "cealalta varianta", byte-identica.
// ==========================================================================================

function getGiftVariant(order) {
  if (!order || order.plan === 'standard') return null;
  const variants = order.variants || [];
  if (order.plan === 'premium' && order.selectedVariantId2) {
    return variants.find(v => v.id === order.selectedVariantId2) || null;
  }
  const selectedId = order.selectedVariantId;
  return variants.find(v => v.id !== selectedId) || null;
}

module.exports = { getGiftVariant };
