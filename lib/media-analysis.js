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
    // DNG e un container TIFF (verificat direct pe un fisier real Apple ProRAW, iPhone 12 Pro,
    // descarcat de pe raw.pixls.us: "MM\0*" big-endian — Apple scrie intotdeauna big-endian).
    // Acceptam ambele ordini de octeti valabile TIFF (DNG SDK-ul Adobe permite si little-endian
    // "II*\0", desi fisierele Apple nu il folosesc niciodata in practica).
    case 'image/x-adobe-dng': return sig([0x4D, 0x4D, 0x00, 0x2A]) || sig([0x49, 0x49, 0x2A, 0x00]);
    default: return false;
  }
}

// ============================================================================
// FALLBACK PE EXTENSIE, cand Content-Type-ul trimis de browser nu e util
// ============================================================================
// Gasit direct intr-un incident live (HOTFIX 2026-08-07): uploadurile de pe iPhone (Safari
// iOS) esuau COMPLET (0 din 6 materiale salvate) pentru ca server.js accepta STRICT
// mimetype-ul raportat de browser, fara fallback. Safari iOS poate trimite un Content-Type
// gol sau generic ("application/octet-stream") pentru fotografii HEIC/HEIF sau pentru
// fisiere care nu sunt inca "materializate" local (poze/video salvate doar in iCloud) —
// fisierul e perfect valid, doar ca eticheta MIME oferita de browser nu e de incredere.
// Cand mimetype-ul brut nu se potriveste cu nimic din listele acceptate, incercam extensia
// numelui fisierului (case-insensitive, ca sa acopere si extensii scrise cu majuscule,
// ex. "IMG_1234.HEIC") ca sa deducem tipul SI un mimetype "canonic" de folosit mai departe
// pentru verificarea REALA de continut (bufferMatchesDeclaredType, mai sus) — extensia
// singura NU e niciodata suficienta pentru acceptare, doar alege ce semnatura sa verificam.
const EXTENSION_TO_CANONICAL_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif',
  '.dng': 'image/x-adobe-dng',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
};

function inferMediaType(originalname, browserMimetype, photoMimeTypes, videoMimeTypes) {
  if (photoMimeTypes.includes(browserMimetype)) return { type: 'photo', mimetype: browserMimetype };
  if (videoMimeTypes.includes(browserMimetype)) return { type: 'video', mimetype: browserMimetype };

  const match = String(originalname || '').match(/\.[^./\\]+$/);
  const ext = match ? match[0].toLowerCase() : '';
  const inferredMime = EXTENSION_TO_CANONICAL_MIME[ext];
  if (!inferredMime) return null;
  if (photoMimeTypes.includes(inferredMime)) return { type: 'photo', mimetype: inferredMime };
  if (videoMimeTypes.includes(inferredMime)) return { type: 'video', mimetype: inferredMime };
  return null;
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
//
// CORECTIE (2026-08-06, cerinta F11): daca primul marcaj real NU incepe la secunda 0 (ex.
// un intro instrumental de 8-10s inainte de primul cuvant etichetat [Verse]/[Chorus]),
// intervalul [0, primul marcaj) e acum REPREZENTAT EXPLICIT ca propria lui sectiune —
// NU e absorbit tacit in ultima sectiune (bug anterior: eroarea de acoperire dintre
// durationSeconds si suma ferestrelor detectate era adaugata la ultima sectiune, "mutand"
// artificial timp acolo unde nu apartinea) si NICI sectiunile detectate nu sunt mutate mai
// devreme pentru a "acoperi" acest interval — timpii marcajelor raman exact cei raportati
// de Suno. Granitele acestui interval sunt amandoua CERTE (0 = inceputul real al piesei;
// startS-ul primului marcaj = un timestamp real Suno) — clasificat 'aligned', nu 'fallback',
// dar cu `source` distinct ('leading_gap') ca sa ramana clar ca nu provine dintr-o eticheta
// Suno proprie, ci e dedus din diferenta fata de primul marcaj real.
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

  const sections = markers.map((m, i) => ({
    sectionType: m.type,
    startTime: Number(m.startS.toFixed(3)),
    endTime: Number((i < markers.length - 1 ? markers[i + 1].startS : durationSeconds).toFixed(3)),
    audioVariantId,
    source: 'suno_section_marker',
    confidence: m.wordSuccess ? 1 : 0.5,
    alignmentStatus: 'aligned'
  }));

  if (sections[0].startTime > 0) {
    sections.unshift({
      sectionType: 'intro',
      startTime: 0,
      endTime: sections[0].startTime,
      audioVariantId,
      source: 'leading_gap',
      confidence: 1,
      alignmentStatus: 'aligned'
    });
  }

  return sections.map((s, i) => ({ ...s, sectionIndex: i }));
}

// ============================================================================
// ORDONAREA MATERIALELOR CLIENT dupa eticheta de sectiune aleasa la upload
// ============================================================================
const MEMORY_SECTION_ORDER = ['beginning', 'verse1', 'chorus', 'verse2', 'ending'];

// Cerinta F12: eticheta aleasa de client ("Inceput"/"Strofa 1"/"Refren"/"Strofa 2"/"Final")
// trebuie sa mapeze la tipul REAL de sectiune detectat de Suno — nu doar sa determine
// ordinea globala de randare (asta face deja sortMediaBySection). "verse2" prefera a DOUA
// aparitie reala a unei strofe (`indices[1]`), daca exista; altfel cade pe bridge, apoi pe
// aceeasi strofa ca "verse1" (mai bine langa strofa 1 decat complet neplasat).
const CLIENT_SECTION_TO_REAL_TYPES = {
  beginning: ['intro', 'leading_gap'],
  verse1: ['verse'],
  chorus: ['chorus'],
  verse2: ['verse', 'bridge'],
  ending: ['outro']
};

function findRealWindowIndex(clientSection, realSections) {
  const candidateTypes = CLIENT_SECTION_TO_REAL_TYPES[clientSection];
  if (!candidateTypes) return null;
  for (const type of candidateTypes) {
    const indices = realSections.map((w, i) => (w.sectionType === type ? i : -1)).filter(i => i !== -1);
    if (indices.length === 0) continue;
    if (clientSection === 'verse2' && indices.length > 1) return indices[1];
    return indices[0];
  }
  return null;
}

// Aloca duratele segmentelor video folosind ferestrele REALE de sectiune (nu egal) —
// vezi deriveSectionTimings mai sus pentru sursa. Materialele CU eticheta de sectiune sunt
// plasate in fereastra REALA corespunzatoare tipului lor (cerinta F12) — nu doar sortate
// global si impartite proportional cu marimea ferestrelor, cum se intampla anterior.
// Materialele FARA eticheta (sau cu eticheta fara corespondent real detectat) sunt alocate
// ferestrelor ramase, proportional cu durata fiecareia ("largest remainder"), acelasi
// principiu ca inainte, dar aplicat DOAR lor — nu deranjeaza plasarea exacta a celor
// etichetate. Returneaza null (niciodata o presupunere tacita) daca nu exista nicio
// sectiune reala ('aligned') utila — apelantul (buildMemoryBackground in server.js) revine
// atunci la distributia egala, explicit etichetata ca fallback, niciodata amestecata fara
// sa se stie care e care.
//
// `mediaItems`: lista de {section} in ORDINEA in care vor fi randate segmentele (deja
// sortata de sortMediaBySection, apelat de catre server.js inainte de aceasta functie).
// xfadeSeconds: durata tranzitiei crossfade dintre segmente consecutive (vezi
// concatWithCrossfades in server.js) — necesara aici doar pentru compensatia finala de
// durata, ca suma segmentelor RANDATE sa ramana exact egala cu durata melodiei dupa
// suprapunerile de tranzitie.
function computeSectionAwareSegmentDurations(mediaItems, durationSeconds, sectionTimings, xfadeSeconds) {
  const n = mediaItems.length;
  const realSections = (sectionTimings || [])
    .filter(s => s.alignmentStatus === 'aligned')
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .filter(w => w.endTime > w.startTime);
  if (n <= 0 || realSections.length === 0) return null;

  const totalReal = realSections.reduce((sum, w) => sum + (w.endTime - w.startTime), 0);
  if (totalReal <= 0) return null;

  // 1) materialele CU eticheta -> indexul ferestrei reale corespunzatoare (sau null daca
  //    eticheta nu are corespondent real detectat, tratate apoi ca neetichetate)
  const windowIndexByItem = mediaItems.map(item =>
    item.section ? findRealWindowIndex(item.section, realSections) : null
  );

  // 2) materialele FARA fereastra gasita — alocate proportional cu durata fiecarei ferestre
  //    ("largest remainder"), acelasi principiu folosit inainte pentru toate materialele.
  const unassignedPositions = windowIndexByItem.map((w, i) => (w === null ? i : -1)).filter(i => i !== -1);
  if (unassignedPositions.length > 0) {
    const raw = realSections.map(w => ((w.endTime - w.startTime) / totalReal) * unassignedPositions.length);
    const counts = raw.map(Math.floor);
    let assignedCount = counts.reduce((a, b) => a + b, 0);
    const remainders = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; assignedCount < unassignedPositions.length && remainders.length > 0; k++, assignedCount++) {
      counts[remainders[k % remainders.length].i]++;
    }
    let cursor = 0;
    counts.forEach((c, winIdx) => {
      for (let k = 0; k < c && cursor < unassignedPositions.length; k++, cursor++) {
        windowIndexByItem[unassignedPositions[cursor]] = winIdx;
      }
    });
  }

  // 3) numara cati itemi (etichetati + neetichetati alocati) au ajuns in fiecare fereastra —
  //    determina cat de mult se imparte durata acelei ferestre.
  const countPerWindow = new Array(realSections.length).fill(0);
  windowIndexByItem.forEach(w => { if (w !== null) countPerWindow[w]++; });

  const rawDurations = mediaItems.map((item, i) => {
    const w = windowIndexByItem[i];
    if (w === null || countPerWindow[w] === 0) return totalReal / n; // plasa de siguranta
    const win = realSections[w];
    return (win.endTime - win.startTime) / countPerWindow[w];
  });

  // corectie de rotunjire (eroare sub-milisecunda dupa fix-ul leading-gap din
  // deriveSectionTimings — ferestrele reale acopera acum intreaga durata a melodiei)
  const sum = rawDurations.reduce((a, b) => a + b, 0);
  rawDurations[rawDurations.length - 1] += (durationSeconds - sum);

  // compensatie pentru tranzitiile crossfade — fiecare tranzitie "fura" xfadeSeconds din
  // durata vizibila finala, deci fiecare segment trebuie randat putin mai lung decat
  // fereastra lui reala, ca durata TOTALA finala (dupa suprapunerile de tranzitie) sa ramana
  // exact egala cu durata melodiei.
  const compensationPerSegment = ((n - 1) * xfadeSeconds) / n;
  return rawDurations.map(d => d + compensationPerSegment);
}

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
  inferMediaType,
  SECTION_TYPE_PATTERNS,
  normalizeSectionType,
  extractSectionMarkersFromAlignedWords,
  deriveSectionTimings,
  computeSectionAwareSegmentDurations,
  CLIENT_SECTION_TO_REAL_TYPES,
  findRealWindowIndex,
  MEMORY_SECTION_ORDER,
  sortMediaBySection
};
