// lib/media-analysis.js
// Logica PURA (fara I/O, fara retea, fara baza de date) folosita de server.js pentru:
//   - validarea reala a continutului fisierelor incarcate de clienti (magic bytes);
//   - true section timing alignment (derivarea sectiunilor REALE ale unei melodii din
//     marcajele Suno, cu fallback controlat si etichetat cand nu exista date reale);
//   - alocarea duratelor segmentelor video cinematice pe baza acelor sectiuni reale;
//   - ordonarea materialelor client dupa eticheta de sectiune aleasa.
//
// Extras intentionat intr-un modul separat de server.js (2026-08-06, relansare pachet
// "Cadou video") — aceleasi functii, acelasi comportament, dar acum testabile izolat, fara
// sa necesite Postgres/Stripe/Suno pornite (vezi test/media-analysis.test.js).

// ============================================================================
// VALIDARE MIME REALA ("magic bytes")
// ============================================================================
// Validarea prin Content-Type declarat de client e usor de falsificat (verificat direct
// intr-un audit de securitate anterior: un fisier arbitrar cu Content-Type "image/png"
// declarat manual trece validarea, indiferent de continutul real). Aceasta functie citeste
// primii octeti REALI ai fisierului si confirma ca formatul declarat chiar corespunde
// continutului. Nu inlocuieste validarea de mimetype, o completeaza.
function bufferMatchesDeclaredType(buffer, mimetype) {
  const sig = (bytes) => bytes.every((b, i) => buffer[i] === b);
  switch (mimetype) {
    case 'image/jpeg': return sig([0xFF, 0xD8, 0xFF]);
    case 'image/png': return sig([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    case 'image/webp': return sig([0x52, 0x49, 0x46, 0x46]) && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    case 'video/webm': return sig([0x1A, 0x45, 0xDF, 0xA3]);
    case 'video/mp4':
    case 'video/quicktime':
    case 'image/heic':
    case 'image/heif':
    case 'audio/mp4':
    case 'audio/x-m4a': return buffer.slice(4, 8).toString('ascii') === 'ftyp'; // container ISO-BMFF comun (MP4/MOV/HEIC/HEIF)
    case 'audio/wav': return sig([0x52, 0x49, 0x46, 0x46]) && buffer.slice(8, 12).toString('ascii') === 'WAVE';
    case 'audio/mpeg': return sig([0x49, 0x44, 0x33]) || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0);
    default: return false;
  }
}

// ============================================================================
// TRUE SECTION TIMING ALIGNMENT
// ============================================================================
// Sursa REALA: marcajele de structura ([Verse], [Chorus], [Intro], [Bridge], [Outro] etc.)
// pe care Suno le include DIRECT in fluxul de cuvinte aliniate (alignedWords) intors de
// get-timestamped-lyrics — acelasi raspuns folosit si pentru pozitionarea preview-ului si
// pentru caption-uri. Fiecare granita de sectiune vine dintr-un cuvant cu timestamp
// confirmat de Suno, cu propriul flag `success` — nu o presupunere sau o distributie egala.
const SECTION_TYPE_PATTERNS = [
  [/pre.?chorus/i, 'pre_chorus'],
  [/chorus|refren/i, 'chorus'],
  [/bridge/i, 'bridge'],
  [/outro|final/i, 'outro'],
  [/intro|inceput/i, 'intro'],
  [/verse|strofa|strofă/i, 'verse']
];

function normalizeSectionType(rawLabel) {
  const label = String(rawLabel || '').trim();
  for (const [pattern, type] of SECTION_TYPE_PATTERNS) {
    if (pattern.test(label)) return type;
  }
  return null; // eticheta necunoscuta (ex. note de productie) — ignorata ca marcaj de sectiune
}

function extractSectionMarkersFromAlignedWords(alignedWords) {
  const markers = [];
  for (const w of (alignedWords || [])) {
    if (!w || typeof w.word !== 'string' || typeof w.startS !== 'number') continue;
    const tagMatches = w.word.match(/\[([^[\]]+)\]/g);
    if (!tagMatches) continue;
    for (const raw of tagMatches) {
      const rawLabel = raw.slice(1, -1).trim();
      const type = normalizeSectionType(rawLabel);
      if (!type) continue;
      markers.push({ type, rawLabel, startS: w.startS, wordSuccess: w.success === true });
    }
  }
  // pastram DOAR prima aparitie a fiecarui (type, startS aproximativ) — Suno poate repeta
  // eticheta pe cuvinte succesive daca a fost concatenata cu mai multe token-uri consecutive
  const seen = new Set();
  return markers.filter(m => {
    const key = `${m.type}@${Math.round(m.startS)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.startS - b.startS);
}

// Construieste lista finala de sectiuni cu startTime/endTime REALE (endTime = startTime al
// urmatorului marcaj, sau durata totala pentru ultima sectiune). Daca NU exista niciun
// marcaj real (0 sau 1 — un singur marcaj nu defineste nicio granita utila), returneaza un
// FALLBACK controlat si CLAR ETICHETAT: o singura "sectiune" acoperind toata durata, cu
// source='fallback_equal', confidence=0, alignmentStatus='fallback' — niciodata prezentat
// drept aliniere reala, niciodata folosit tacit ca daca ar fi identic cu marcajele Suno.
function deriveSectionTimings(alignedWords, durationSeconds, audioVariantId) {
  const markers = extractSectionMarkersFromAlignedWords(alignedWords);
  if (markers.length < 2) {
    return [{
      sectionType: 'full_song',
      sectionIndex: 0,
      startTime: 0,
      endTime: durationSeconds,
      audioVariantId,
      source: 'fallback_equal',
      confidence: 0,
      alignmentStatus: 'fallback'
    }];
  }
  return markers.map((m, i) => ({
    sectionType: m.type,
    sectionIndex: i,
    startTime: Number(m.startS.toFixed(3)),
    endTime: Number((i < markers.length - 1 ? markers[i + 1].startS : durationSeconds).toFixed(3)),
    audioVariantId,
    source: 'suno_section_marker',
    confidence: m.wordSuccess ? 1 : 0.5,
    alignmentStatus: 'aligned'
  }));
}

// Aloca duratele segmentelor video PROPORTIONAL cu ferestrele REALE de sectiune (nu egal) —
// vezi deriveSectionTimings mai sus pentru sursa. Returneaza null (niciodata o presupunere
// tacita) daca nu exista suficiente sectiuni reale ('aligned') pentru a construi ferestre
// utile — apelantul (buildMemoryBackground in server.js) revine atunci la distributia egala,
// explicit etichetata ca fallback (Faza 1), niciodata amestecata fara sa se stie care e care.
//
// xfadeSeconds: durata tranzitiei crossfade dintre segmente consecutive (vezi
// concatWithCrossfades in server.js) — necesara aici doar pentru compensatia finala de
// durata, ca suma segmentelor RANDATE (nu a ferestrelor reale) sa ramana exact egala cu
// durata melodiei dupa suprapunerile de tranzitie.
function computeSectionAwareSegmentDurations(n, durationSeconds, sectionTimings, xfadeSeconds) {
  const realSections = (sectionTimings || []).filter(s => s.alignmentStatus === 'aligned');
  if (n <= 0 || realSections.length < 2) return null;

  const windows = [...realSections]
    .sort((a, b) => a.startTime - b.startTime)
    .map(s => ({ start: s.startTime, end: s.endTime }))
    .filter(w => w.end > w.start);
  if (windows.length === 0) return null;

  const totalReal = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
  if (totalReal <= 0) return null;

  // "largest remainder": fiecare fereastra primeste podeaua alocarii ei proportionale cu
  // durata ei reala; resturile cele mai mari primesc materialele ramase, pana se aloca
  // exact n materiale in total.
  const raw = windows.map(w => ((w.end - w.start) / totalReal) * n);
  const counts = raw.map(Math.floor);
  let assigned = counts.reduce((a, b) => a + b, 0);
  const remainders = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; assigned < n && remainders.length > 0; k++, assigned++) {
    counts[remainders[k % remainders.length].i]++;
  }
  // nicio fereastra nu ramane complet goala (evita un "salt" vizual peste o sectiune intreaga)
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0) {
      const maxI = counts.indexOf(Math.max(...counts));
      if (counts[maxI] > 1) { counts[maxI]--; counts[i] = 1; }
    }
  }

  const rawDurations = [];
  windows.forEach((w, i) => {
    const c = counts[i];
    if (c === 0) return;
    const each = (w.end - w.start) / c;
    for (let k = 0; k < c; k++) rawDurations.push(each);
  });
  if (rawDurations.length !== n) return null; // plasa de siguranta — nu ar trebui sa ajunga aici

  // corectie de rotunjire: suma exacta a ferestrelor reale trebuie sa ramana durationSeconds
  const sum = rawDurations.reduce((a, b) => a + b, 0);
  rawDurations[rawDurations.length - 1] += (durationSeconds - sum);

  // compensatie pentru tranzitiile crossfade — fiecare tranzitie "fura" xfadeSeconds din
  // durata vizibila finala, deci fiecare segment trebuie randat putin mai lung decat
  // fereastra lui reala, ca durata TOTALA finala (dupa suprapunerile de tranzitie) sa ramana
  // exact egala cu durata melodiei — identic ca principiu cu formula uniforma anterioara,
  // doar aplicat pe alocarea REALA, nu una egala.
  const compensationPerSegment = ((n - 1) * xfadeSeconds) / n;
  return rawDurations.map(d => d + compensationPerSegment);
}

// ============================================================================
// ORDONAREA MATERIALELOR CLIENT dupa eticheta de sectiune aleasa la upload
// ============================================================================
const MEMORY_SECTION_ORDER = ['beginning', 'verse1', 'chorus', 'verse2', 'ending'];

function sortMediaBySection(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = a.item.section ? MEMORY_SECTION_ORDER.indexOf(a.item.section) : -1;
      const rb = b.item.section ? MEMORY_SECTION_ORDER.indexOf(b.item.section) : -1;
      const ea = ra === -1 ? MEMORY_SECTION_ORDER.length : ra;
      const eb = rb === -1 ? MEMORY_SECTION_ORDER.length : rb;
      if (ea !== eb) return ea - eb;
      return a.i - b.i;
    })
    .map(x => x.item);
}

module.exports = {
  bufferMatchesDeclaredType,
  SECTION_TYPE_PATTERNS,
  normalizeSectionType,
  extractSectionMarkersFromAlignedWords,
  deriveSectionTimings,
  computeSectionAwareSegmentDurations,
  MEMORY_SECTION_ORDER,
  sortMediaBySection
};
