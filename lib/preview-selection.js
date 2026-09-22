// lib/preview-selection.js
// SMART PREVIEW (2026-09-22, runda 3 — DECIZIE FINALA, dupa un test audio real in productie) —
// preview-ul gratuit trebuie sa inceapa STRICT cu ~1-2 secunde de context muzical inainte de
// PRIMUL CUVANT REAL CANTAT — nu la inceputul sectiunii "Verse" (runda 2, respinsa dupa testare
// reala) si nu cu 9 secunde de context (formula vocal-onset originala, prea lunga pentru scopul
// comercial al unui preview de vanzare).
//
// RUNDA 4 (2026-09-22, cerinta explicita: "nu mai vreau NICAIERI regula -9 secunde pentru
// preview"): fallback-ul B (vocal_onset_fallback) folosea PANA ACUM un `vocalOnsetStartSeconds`
// deja ajustat de apelant cu vechea formula (-9s, cap 25s — server.js#computeVocalOnsetPreviewStart,
// stearsa acum). Obiectivul comercial e IDENTIC in ambele fallback-uri (clientul trebuie sa auda
// vocea aproape imediat) — nu mai exista niciun motiv sa foloseasca o constanta diferita. Acum
// `vocalOnsetStartSeconds` e STRICT timestamp-ul BRUT, neajustat, al unui semnal de vocal-onset
// (apelantul il calculeaza direct din findFirstRealWordStartS(), FARA nicio scadere) — ACEST
// modul aplica el insusi ACELASI VOCAL_LEAD_IN_SECONDS (2s) peste el, exact ca la fallback-ul A.
// O singura constanta, un singur obiectiv, niciodata doua valori diferite pentru acelasi scop.
//
// AUDIT — de ce runda 2 ("first_verse") a produs ~30s de instrumental intr-un test real:
// runda 2 folosea deriveSectionTimings() (lib/media-analysis.js) pentru a gasi fereastra primei
// sectiuni de tip 'verse', apoi cauta prima "linie" cantata REALA STRICT in interiorul acelei
// ferestre [verse.startTime, verse.endTime). Problema: verse.startTime vine din timestamp-ul
// oricarui TOKEN care contine textual eticheta "[Verse]" in alignedWords — un timestamp STRUCTURAL
// (unde Suno considera ca incepe conceptual sectiunea), NU neaparat momentul in care vocea
// principala, inteligibila, chiar incepe sa cante. Genuri cu preambul instrumental/ad-libs extinse
// chiar in interiorul sectiunii nominale de vers (manele fiind un exemplu tipic — introduceri
// instrumentale/taraf lungi sunt o caracteristica de gen, nu o exceptie) pot avea un cuvant real
// izolat (ad-lib/ornament vocal scurt) devreme in acea fereastra, la care algoritmul se ancora,
// desi continutul vocal SUBSTANTIAL (versurile personalizate propriu-zise) nu incepe decat mult
// mai tarziu — exact tiparul "~30 din 40 secunde instrumental" raportat. Pe scurt: ancorarea pe
// GRANITA DE SECTIUNE (structurala) a fost o presupunere gresita — timestamp-ul VOCII conteaza,
// nu timestamp-ul SECTIUNII. Mecanismul EXISTENT, mai simplu, de dinainte de orice Smart Preview
// (findFirstRealWordStartS, server.js — cauta STRICT primul cuvant cu success:true in TOT
// alignedWords, fara nicio fereastra de sectiune) nu avea aceasta problema — de aceea aceasta
// runda revine la acelasi principiu simplu (scanare directa, fara sectiuni), doar cu un lead-in
// de 2 secunde in loc de 9.
//
// Logica PURA (fara I/O, fara retea, fara ffmpeg, fara analiza audio, fara deriveSectionTimings) —
// testabila izolat. NU foloseste onset-uri/energie audio, NU foloseste recipient/story (eliminate
// runda 2), NU mai foloseste sectiuni de structura/linii de caption (eliminate acum, runda 3) —
// STRICT alignedWords, scanat direct.
//
// GARANTIE DE SIGURANTA: aceasta functie NU ARUNCA NICIODATA in afara — orice date lipsa/
// neasteptate produc un fallback controlat (vezi selectPreviewStart), niciodata o exceptie care
// ar putea bloca generarea comenzii.

// ~1-2 secunde de context muzical inainte de prima voce reala — cerinta explicita, comerciala:
// clientul trebuie sa auda vocea si personalizarea APROAPE IMEDIAT in preview-ul gratuit de 40s.
const VOCAL_LEAD_IN_SECONDS = 2;

// Eticheta structurala intre paranteze patrate (ex. "[Verse]", "[Chorus]", "[Strofa]", "[Refren]")
// nu e un cuvant cantat efectiv — o eliminam ca sa vedem daca ramane text real dupa ea (uneori
// raspunsul providerului concateneaza eticheta cu primul cuvant in acelasi camp). IDENTICA ca
// logica cu stripStructuralTagsFromWord (server.js) — Unicode/limba-agnostica prin constructie
// (elimina orice text intre paranteze patrate, indiferent de continut/limba), nu cauta cuvinte
// romanesti sau engleze specifice.
function stripStructuralTagsFromWord(word) {
  return String(word || '').replace(/\[[^[\]]*\]/g, '').trim();
}

// Primul cuvant REAL cantat — scanare DIRECTA a intregului alignedWords, fara nicio fereastra de
// sectiune. success===true (confirmat de Suno) + text real ramas dupa eliminarea marcajelor
// structurale. Ordinea array-ului alignedWords e deja cronologica (garantata de furnizor) — primul
// gasit e primul cronologic.
function findFirstRealVocalStart(alignedWords) {
  for (const w of (alignedWords || [])) {
    if (!w || w.success !== true) continue;
    if (typeof w.startS !== 'number' || !Number.isFinite(w.startS) || w.startS < 0) continue;
    if (stripStructuralTagsFromWord(w.word).length === 0) continue;
    return w.startS;
  }
  return null;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// ==========================================================================================
// PUNCT DE INTRARE PRINCIPAL
//
// Lant de fallback, in ORDINEA CERUTA EXPLICIT — ACELASI VOCAL_LEAD_IN_SECONDS (2s) in AMBELE
// cai cu semnal real (A si B), niciodata doua constante diferite pentru acelasi obiectiv comercial:
//   A. first_vocal_word     — alignedWords disponibile, cu cel putin un cuvant real cantat:
//                             previewStart = max(0, firstRealVocalStart - 2), clampat sa incapa
//                             in durata melodiei (previewMaxSeconds).
//   B. vocal_onset_fallback — alignedWords indisponibile/fara niciun cuvant real gasit, dar
//                             apelantul (server.js) a putut totusi calcula un semnal BRUT de
//                             vocal-onset independent (`vocalOnsetStartSeconds`, NEAJUSTAT de
//                             apelant): previewStart = max(0, vocalOnsetStartSeconds - 2) — ACEEASI
//                             formula ca A, aplicata AICI, niciodata -9s.
//   C. start_zero_fallback  — nicio informatie utila disponibila — previewStart = 0.
//
// `vocalOnsetStartSeconds`: semnal OPTIONAL, BRUT (timestamp neajustat), calculat de apelant
// (server.js) — acest modul aplica singurul lead-in existent (VOCAL_LEAD_IN_SECONDS) peste el,
// nu il foloseste ca atare.
// ==========================================================================================
function selectPreviewStart({ alignedWords, durationSeconds, previewMaxSeconds, vocalOnsetStartSeconds }) {
  const durationValid = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0;
  const maxValid = typeof previewMaxSeconds === 'number' && Number.isFinite(previewMaxSeconds) && previewMaxSeconds > 0;

  function clampToDuration(startSeconds) {
    if (!durationValid || !maxValid) return startSeconds;
    const maxStart = Math.max(0, durationSeconds - previewMaxSeconds);
    return clamp(startSeconds, 0, maxStart);
  }

  try {
    if (Array.isArray(alignedWords) && alignedWords.length > 0) {
      const firstRealVocalStart = findFirstRealVocalStart(alignedWords);
      if (firstRealVocalStart !== null) {
        const previewStart = clampToDuration(Math.max(0, firstRealVocalStart - VOCAL_LEAD_IN_SECONDS));
        return {
          previewStartSeconds: previewStart,
          selectionReason: 'first_vocal_word',
          // Semnale de debugging/audit — STRICT numere, NICIODATA text brut (fara versuri).
          signals: { firstRealVocalStart: Number(firstRealVocalStart.toFixed(3)), leadInSeconds: VOCAL_LEAD_IN_SECONDS }
        };
      }
    }
  } catch (err) {
    // niciodata nu blocam generarea — cade pe fallback-ul de mai jos, la fel ca orice alta eroare
  }

  if (typeof vocalOnsetStartSeconds === 'number' && Number.isFinite(vocalOnsetStartSeconds)) {
    const previewStart = clampToDuration(Math.max(0, vocalOnsetStartSeconds - VOCAL_LEAD_IN_SECONDS));
    return {
      previewStartSeconds: previewStart,
      selectionReason: 'vocal_onset_fallback',
      signals: { vocalOnsetStartSeconds: Number(vocalOnsetStartSeconds.toFixed(3)), leadInSeconds: VOCAL_LEAD_IN_SECONDS }
    };
  }

  return { previewStartSeconds: 0, selectionReason: 'start_zero_fallback', signals: null };
}

module.exports = {
  VOCAL_LEAD_IN_SECONDS,
  findFirstRealVocalStart,
  selectPreviewStart
};
