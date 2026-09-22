// lib/preview-selection.js
// SMART PREVIEW (2026-09-22, revizuit 2026-09-22 runda 2 — DECIZIE FINALA CLIENT) — selectia
// preview-ului gratuit NU mai e un scor compus intre Chorus/Pre-Chorus/Verse/energie/personalizare
// (versiunea anterioara alegea prea des refrenul, comportament nedorit explicit de client).
//
// REGULA NOUA, DETERMINISTA: preview-ul incepe STRICT de la PRIMA STROFA (Verse 1) a melodiei —
// mai exact, de la inceputul primei linii EFECTIV CANTATE din acea strofa. Daca inaintea primei
// strofe apare un Chorus/Pre-Chorus, acesta e ignorat — nu concureaza niciodata cu Verse 1.
//
// Sursa REALA: structura melodiei (deriveSectionTimings, lib/media-analysis.js — deja foloseste
// marcajele [Verse]/[Strofa] emise de Suno in alignedWords, identic in toate cele 8 limbi, pentru
// ca Suno emite marcaje de structura in engleza indiferent de limba versurilor) + liniile cantate
// reale (captionLines, produse de buildCaptionLines — server.js, NEATINSA, trecuta aici ca date).
//
// Logica PURA (fara I/O, fara retea, fara ffmpeg, fara analiza audio) — testabila izolat. NU mai
// foloseste onset-uri/energie audio (semnalul de energie a fost eliminat complet — vezi server.js,
// unde extractAudioOnsets nu mai ruleaza pre-plata pentru Smart Preview) si NU mai foloseste
// recipient/story (scoring-ul de personalizare a fost eliminat complet, cerinta explicita).
//
// GARANTIE DE SIGURANTA: aceasta functie NU ARUNCA NICIODATA in afara — orice date lipsa/
// neasteptate produc un fallback controlat (vezi selectPreviewStart), niciodata o exceptie care
// ar putea bloca generarea comenzii.

const { deriveSectionTimings } = require('./media-analysis');

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// Cat de departe (secunde) cauta snapToLineStart() o linie cantata reala, inainte sa renunte si
// sa foloseasca punctul brut (nesnapped) — folosit STRICT ca ultim pas, cand clamparea la fereastra
// finala (durationSeconds - previewMaxSeconds) muta punctul ales departe de o granita reala de
// linie (piesa foarte scurta / strofa foarte aproape de final).
const SNAP_TOLERANCE_SECONDS = 3;

// Muta un candidat la inceputul celei mai apropiate linii REAL cantate (buildCaptionLines), daca
// exista una suficient de aproape — evita sa inceapa preview-ul la mijlocul unui cuvant/unei idei.
// Fara linii disponibile, sau fara una suficient de aproape, pastreaza punctul brut.
function snapToLineStart(startTime, captionLines, maxStart) {
  if (!Array.isArray(captionLines) || captionLines.length === 0) return startTime;
  let best = null;
  let bestDelta = Infinity;
  for (const line of captionLines) {
    if (!line || typeof line.start !== 'number' || !Number.isFinite(line.start)) continue;
    if (line.start > maxStart + 0.001) continue;
    const delta = Math.abs(line.start - startTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = line.start;
    }
  }
  if (best !== null && bestDelta <= SNAP_TOLERANCE_SECONDS) return best;
  return startTime;
}

// Prima sectiune REALA (alignmentStatus === 'aligned', niciodata fallback_equal) de tip 'verse' —
// sectionTimings e deja in ordine cronologica (deriveSectionTimings sorteaza marcajele dupa
// startS), deci primul 'verse' gasit AICI e garantat primul cronologic — "daca exista mai multe
// Verse-uri, alege primul" e satisfacut direct de ordinea buclei, fara logica suplimentara.
function findFirstVerseSection(sectionTimings) {
  for (const s of (sectionTimings || [])) {
    if (s && s.alignmentStatus === 'aligned' && s.sectionType === 'verse') return s;
  }
  return null;
}

// Prima linie cantata (captionLines, deja ordonate) cu inceputul in [windowStart, windowEnd) —
// windowEnd optional (fara limita superioara cand cautam "oriunde in cantec", pentru fallback-ul
// de linie 2 mai jos). Rezultatul e MEREU inceputul unei linii reale, deci mereu inceputul unui
// cuvant real — niciodata mid-word/mid-linie.
function firstCaptionLineStartInWindow(captionLines, windowStart, windowEnd) {
  let best = null;
  for (const line of (captionLines || [])) {
    if (!line || typeof line.start !== 'number' || !Number.isFinite(line.start)) continue;
    if (line.start < windowStart - 0.001) continue;
    if (typeof windowEnd === 'number' && line.start >= windowEnd) continue;
    if (best === null || line.start < best) best = line.start;
  }
  return best;
}

// Fallback cand nu exista deloc captionLines utile (rar — buildCaptionLines esueaza doar daca
// alignedWords insusi e gol, caz deja exclus mai sus) — primul cuvant REAL (success:true) din
// fereastra, direct din alignedWords. Tot un punct real, cantat, niciodata mid-word.
function firstRealWordStartInWindow(alignedWords, windowStart, windowEnd) {
  let best = null;
  for (const w of (alignedWords || [])) {
    if (!w || w.success !== true || typeof w.startS !== 'number' || !Number.isFinite(w.startS)) continue;
    if (w.startS < windowStart - 0.001) continue;
    if (typeof windowEnd === 'number' && w.startS >= windowEnd) continue;
    if (best === null || w.startS < best) best = w.startS;
  }
  return best;
}

// ==========================================================================================
// PUNCT DE INTRARE PRINCIPAL
//
// Lant de fallback, in ORDINEA CERUTA EXPLICIT:
//   1. first_verse                — prima strofa REALA identificata, inceputul primei ei linii
//                                    efectiv cantate (sau, daca acea strofa nu are nicio linie de
//                                    caption utila, primul cuvant real din fereastra strofei).
//   2. first_vocal_line_fallback  — nicio strofa identificabila (structura fallback/fara Verse),
//                                    dar exista linii/cuvinte cantate reale — folosim prima linie
//                                    cantata din TOT cantecul (tot deterministic, tot un punct
//                                    real de start, niciodata Chorus ales prin scor).
//   3. vocal_onset_fallback       — timestamped lyrics/alignment indisponibil sau fara niciun
//                                    continut real utilizabil — mecanismul vocal-onset EXISTENT
//                                    (calculat de apelant, server.js, NEATINS).
//   4. start_zero_fallback        — nici vocal-onset nu e disponibil — previewStart = 0.
//
// `vocalOnsetStartSeconds` e STRICT calculat de apelant (server.js), reutilizand functiile PURE
// deja existente si NEATINSE (findFirstRealWordStartS + TARGET_VOICE_POSITION_S/PREVIEW_START_MAX_S).
// `captionLines` e STRICT iesirea buildCaptionLines(alignedWords) (server.js, neatinsa), trecuta
// aici ca date.
// ==========================================================================================
function selectPreviewStart({ alignedWords, captionLines, durationSeconds, previewMaxSeconds, vocalOnsetStartSeconds }) {
  if (typeof vocalOnsetStartSeconds !== 'number' || !Number.isFinite(vocalOnsetStartSeconds)) {
    return { previewStartSeconds: 0, selectionReason: 'start_zero_fallback', signals: null };
  }
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
  if (typeof previewMaxSeconds !== 'number' || !Number.isFinite(previewMaxSeconds) || previewMaxSeconds <= 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
  // alignedWords lipsa/goale: nu exista NIMIC de analizat (nicio strofa, nicio linie reala) —
  // eticheta corecta e vocal_onset_fallback, niciodata first_verse/first_vocal_line_fallback,
  // chiar daca rezultatul NUMERIC ar coincide oricum cu vocalOnsetStartSeconds.
  if (!Array.isArray(alignedWords) || alignedWords.length === 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }

  try {
    const sectionTimings = deriveSectionTimings(alignedWords, durationSeconds, null);
    const lines = Array.isArray(captionLines) ? captionLines : [];
    const maxStart = Math.max(0, durationSeconds - previewMaxSeconds);

    let rawStart = null;
    let reason = null;
    let anchorType = null;

    const verseSection = findFirstVerseSection(sectionTimings);
    if (verseSection) {
      const lineStart = firstCaptionLineStartInWindow(lines, verseSection.startTime, verseSection.endTime);
      if (lineStart !== null) {
        rawStart = lineStart;
        reason = 'first_verse';
        anchorType = 'verse';
      } else {
        const wordStart = firstRealWordStartInWindow(alignedWords, verseSection.startTime, verseSection.endTime);
        if (wordStart !== null) {
          rawStart = wordStart;
          reason = 'first_verse';
          anchorType = 'verse';
        }
      }
    }

    if (rawStart === null) {
      // Nicio strofa reala identificata (structura fallback, sau strofa gasita fara continut
      // cantat propriu — foarte rar) — prima linie/cuvant cantat REAL din TOT cantecul, niciodata
      // o alegere prin scor intre sectiuni.
      const lineStart = firstCaptionLineStartInWindow(lines, 0, null);
      if (lineStart !== null) {
        rawStart = lineStart;
        reason = 'first_vocal_line_fallback';
        anchorType = 'first_line';
      } else {
        const wordStart = firstRealWordStartInWindow(alignedWords, 0, null);
        if (wordStart !== null) {
          rawStart = wordStart;
          reason = 'first_vocal_line_fallback';
          anchorType = 'first_word';
        }
      }
    }

    if (rawStart === null) {
      return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
    }

    let previewStart = clamp(rawStart, 0, maxStart);
    if (previewStart !== rawStart) {
      // Clampat departe de granita reala aleasa (strofa/linia era prea aproape de finalul
      // piesei ca sa incapa fereastra de previewMaxSeconds) — reancoram la cea mai apropiata
      // linie reala cantata, ca sa nu inceapa totusi mid-word/mid-idee.
      previewStart = snapToLineStart(previewStart, lines, maxStart);
    }

    return {
      previewStartSeconds: previewStart,
      selectionReason: reason,
      // Semnale de debugging/audit — STRICT numere/enum-uri, NICIODATA text brut (fara story,
      // fara versuri, fara nume) — sigur de persistat/logat.
      signals: {
        anchorType,
        rawStart: Number(rawStart.toFixed(3)),
        clamped: previewStart !== rawStart
      }
    };
  } catch (err) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
}

module.exports = {
  snapToLineStart,
  findFirstVerseSection,
  firstCaptionLineStartInWindow,
  firstRealWordStartInWindow,
  selectPreviewStart
};
