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

// ============================================================================
// SHOT PLAN — storyboard cinematografic determinist (2026-08-24, versiunea initiala;
// RESCRISA 2026-08-31, Cerinta 1B-F: "nu e suficient sa cresti limita la 30 de materiale —
// reconstruieste planul de montaj real")
// ============================================================================
// Inlocuieste modelul vechi (UN singur segment lung per material, cate o data fiecare) cu un
// PLAN DE CADRE separat de lista materialelor — un material poate furniza mai multe cadre
// SCURTE, neconsecutive, pe parcursul melodiei. Ritmul (durata fiecarui cadru) e determinat de:
//   1) o "zona de prioritate" fortat scurta si densa la INCEPUTUL melodiei (primele
//      SHOT_PLAN_PREVIEW_PRIORITY_SECONDS secunde, extinsa pana la SHOT_PLAN_PREVIEW_WINDOW_
//      SECONDS) — garanteaza ca toate materialele apar devreme si ca exista suficiente
//      schimbari vizuale in cele 25s ale previzualizarii gratuite (cerinta testata explicit:
//      minimum 8 schimbari in primele 25s, niciun material singur nu domina).
//   2) tipul REAL al sectiunii curente (din sectionTimings, derivat din marcajele Suno —
//      vezi deriveSectionTimings mai sus) pentru restul melodiei — sectiuni energice
//      (refren/bridge) primesc cadre mai scurte si taieturi mai dese, sectiuni calme
//      (strofa/intro/final) cadre mai lungi, miscari mai line. FARA marcaje reale (fallback
//      "full_song", o singura sectiune), ramane pe ritmul calm implicit.
//
// STORYBOARD PE "TURE" (laps) — inlocuieste ciclul mecanic vechi (itemCursor % n, adica
// 0,1,2,...,n-1,0,1,2,... identic la infinit, motivul exact pentru care montajul se simtea
// "de baza si repetitiv"): TURA 0 foloseste STRICT ordinea aleasa de client (materialul 0,
// apoi 1, apoi 2, ...) — satisface simultan:
//   1) toate materialele apar cel putin o data inainte de orice repetare;
//   2) cat timp exista un material neutilizat, niciunul deja aratat nu se repeta;
//   3) doua cadre consecutive nu folosesc niciodata acelasi material;
//   4) ordinea/naratiunea aleasa de client ramane baza (macar pentru prima aparitie a
//      fiecarui material, cea mai importanta narativ).
// TURELE URMATOARE (2, 3, ...) NU mai repeta identic tura 0 — alterneaza sensul
// (inainte/inapoi dupa paritatea turei) si aplica o rotatie determinista (hash raport de aur
// pe indexul turei), ca reluarea materialelor sa nu se simta ca un ciclu mecanic previzibil,
// ramanand 100% deterministe (cerinta 6: aceeasi comanda + aceleasi materiale + aceeasi
// melodie => exact acelasi plan la o reincercare). Complet DETERMINIST — niciun Math.random()
// nicaieri.
// ============================================================================

const SHOT_PLAN_PREVIEW_PRIORITY_SECONDS = 12; // toate materialele trebuie sa apara pana aici
const SHOT_PLAN_PREVIEW_WINDOW_SECONDS = 25;   // fereastra completa a previzualizarii gratuite
const SHOT_PLAN_PREVIEW_SHOT_SECONDS = 2.2;    // durata cadrelor in zona de prioritate (0-12s)
const SHOT_PLAN_PREVIEW_TAIL_SHOT_SECONDS = 2.7; // durata cadrelor intre 12s si 25s
const SHOT_PLAN_ENERGETIC_SHOT_SECONDS = 2.6;  // refren/bridge, dupa fereastra de previzualizare
const SHOT_PLAN_CALM_SHOT_SECONDS = 3.9;       // strofa/intro/final/fallback, dupa fereastra
const SHOT_PLAN_MAX_SHOTS = 50;                // plafon — pastreaza filter_complex-ul marginit
const SHOT_PLAN_MIN_SHOT_SECONDS = 1.1;        // niciun cadru mai scurt de atat, dupa scalare

const ENERGETIC_SECTION_TYPES = new Set(['chorus', 'bridge']);
// Cerinta E ("intro/outro cadre mai lungi, mai calme") — granitele langa aceste sectiuni
// primesc o tranzitie usor mai lunga, discreta (vezi chooseTransitionDuration mai jos).
const ENDCAP_SECTION_TYPES = new Set(['intro', 'outro', 'leading_gap']);

function sectionTypeAt(sectionTimings, timeSeconds) {
  for (const s of sectionTimings) {
    if (timeSeconds >= s.startTime && timeSeconds < s.endTime) return s.sectionType;
  }
  return sectionTimings.length > 0 ? sectionTimings[sectionTimings.length - 1].sectionType : 'full_song';
}

// KEN BURNS — 4 variante scurte, SIGURE (fara sa impinga niciodata cadrul de decupare in
// afara imaginii sursa, verificat matematic: offset-ul vertical variaza cu maximum ±15% fata
// de centrul deja calculat, mult sub marginea disponibila la zoom-ul maxim folosit). Fara
// deformare — toate variantele pastreaza raportul de aspect (doar z/x/y pentru zoompan,
// nicio scalare separata pe axe).
const KEN_BURNS_VARIANTS = [
  { id: 'zoom_in_center', z: 'min(zoom+0.0018,1.15)', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
  { id: 'zoom_in_up', z: 'min(zoom+0.0016,1.15)', x: 'iw/2-(iw/zoom/2)', y: '(ih/2-(ih/zoom/2))*0.85' },
  { id: 'zoom_out_center', z: 'if(eq(on,1),1.15,max(zoom-0.0018,1.0))', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
  { id: 'zoom_in_down', z: 'min(zoom+0.0016,1.15)', x: 'iw/2-(iw/zoom/2)', y: '(ih/2-(ih/zoom/2))*1.15' }
];

// Pastrata pentru compatibilitate externa (era exportata) — cicleaza STRICT dupa numarul
// aparitiei ACELUIASI material. NU mai e folosita intern de buildShotPlan (vezi
// pickKenBurnsVariant mai jos) — insuficienta acum ca variatie, pentru ca majoritatea
// materialelor au o singura aparitie (variatia trebuie sa fie GLOBALA, intre cadre
// consecutive, nu doar per-material).
function kenBurnsVariantFor(occurrenceIndex) {
  return KEN_BURNS_VARIANTS[occurrenceIndex % KEN_BURNS_VARIANTS.length];
}

// Alegere GLOBALA (cerinta C) — candidatul initial e determinist (`preferredIndex`, ales de
// apelant — de regula (itemIndex+occurrence) pentru un cadru obisnuit, sau STRICT 0 pentru
// ultimul cadru al planului, cerinta 5 "miscarea cea mai discreta la final"), dar daca ar
// coincide cu miscarea cadrului ANTERIOR din plan (indiferent de material — doua materiale
// diferite, alaturate, nu trebuie sa primeasca aceeasi miscare de zoom), se avanseaza
// determinist la urmatoarea varianta din lista (maximum 3 incercari — cu doar 4 variante, dupa
// 3 avansari e imposibil sa mai coincida cu ea insasi). Un `preferredIndex` FIX (0) pentru
// ultimul cadru trece prin ACEEASI logica de evitare a coliziunii — altfel doua cadre finale
// consecutive ar putea ambele "cadea" pe aceeasi varianta implicita.
function pickKenBurnsVariant(preferredIndex, previousVariantId) {
  let idx = ((preferredIndex % KEN_BURNS_VARIANTS.length) + KEN_BURNS_VARIANTS.length) % KEN_BURNS_VARIANTS.length;
  for (let attempt = 0; attempt < KEN_BURNS_VARIANTS.length - 1; attempt++) {
    if (KEN_BURNS_VARIANTS[idx].id !== previousVariantId) break;
    idx = (idx + 1) % KEN_BURNS_VARIANTS.length;
  }
  return KEN_BURNS_VARIANTS[idx];
}

// TRANZITII (cerinta E, 2026-08-31) — elimina complet vechiul efect de alunecare (folosit
// repetitiv pe toate momentele energice inainte de aceasta corectie). 'fade' (cross-dissolve)
// ramane SINGURUL tip de tranzitie folosit oriunde — insa DURATA variaza dupa context, ca
// marea majoritate a granitelor sa citeasca vizual drept taieturi curate, nu ca un efect
// vizibil aplicat peste tot ca intr-un slideshow:
//   - CUT: durata aproape nula — indistinguibila de o taietura seaca, data fiind durata unui
//     cadru (1.1-3.9s) — folosita la MAJORITATEA granitelor.
//   - DISSOLVE: cross-dissolve scurt, discret — langa cadre calme (strofa/fallback).
//   - ENDCAP: fade usor mai lung, discret — STRICT la cele SHOT_PLAN_ENDCAP_BOUNDARY_COUNT
//     granite de la inceputul/finalul intregului plan, sau langa o sectiune intro/outro/
//     leading_gap (chiar si pe o melodie fara nicio sectiune reala detectata).
const SHOT_PLAN_CUT_XFADE_SECONDS = 0.12;
const SHOT_PLAN_DISSOLVE_XFADE_SECONDS = 0.45;
const SHOT_PLAN_ENDCAP_XFADE_SECONDS = 0.7;
const SHOT_PLAN_ENDCAP_BOUNDARY_COUNT = 2;

function chooseTransitionDuration(shots, boundaryIndex) {
  const a = shots[boundaryIndex];
  const b = shots[boundaryIndex + 1];
  const isEndcapByPosition = boundaryIndex < SHOT_PLAN_ENDCAP_BOUNDARY_COUNT ||
    boundaryIndex >= shots.length - 1 - SHOT_PLAN_ENDCAP_BOUNDARY_COUNT;
  const isEndcapByType = ENDCAP_SECTION_TYPES.has(a.sectionType) || ENDCAP_SECTION_TYPES.has(b.sectionType);
  if (isEndcapByPosition || isEndcapByType) return SHOT_PLAN_ENDCAP_XFADE_SECONDS;
  if (a.energy === 'calm' || b.energy === 'calm') return SHOT_PLAN_DISSOLVE_XFADE_SECONDS;
  return SHOT_PLAN_CUT_XFADE_SECONDS;
}

// Determinist: combina indexul materialului cu numarul aparitiei intr-un singur "seed".
// PASTRATA pentru compatibilitate externa (era exportata) — campul pe care il alimenta
// (videoOffsetFraction) era deja cod mort inainte de aceasta corectie (nimic nu il citea).
const GOLDEN_RATIO_CONJUGATE = 0.61803398875;
function shotDeterministicFraction(itemIndex, occurrence) {
  const seed = itemIndex * 3 + occurrence * 7;
  return (seed * GOLDEN_RATIO_CONJUGATE) % 1;
}

// Construieste ordinea materialelor pentru TURA `lapIndex` (0 = ordinea clientului, exacta).
// Turele impare inverseaza sensul; toate turele >0 se rotesc determinist (hash raport de aur
// pe indexul turei) — nu au voie sa inceapa mereu din acelasi loc, altfel reluarea ar arata
// tot ca un ciclu mecanic, doar inversat.
function buildLapOrder(n, lapIndex) {
  const base = Array.from({ length: n }, (_, i) => i);
  if (lapIndex === 0 || n <= 1) return base;
  const reversed = lapIndex % 2 === 1;
  let order = reversed ? base.slice().reverse() : base.slice();
  const rotate = 1 + Math.floor(((lapIndex * GOLDEN_RATIO_CONJUGATE) % 1) * (n - 1));
  if (rotate > 0 && rotate < n) order = order.slice(rotate).concat(order.slice(0, rotate));
  return order;
}

// ============================================================================
// ANALIZA AUDIO REALĂ, LOCALĂ, DETERMINISTĂ (2026-08-24) — cerinta "reelul dinamic sincronizat
// cu melodia": pana acum, ritmul taieturilor foloseste STRICT tipul de sectiune (refren/strofa)
// si durate fixe (SHOT_PLAN_ENERGETIC_SHOT_SECONDS/CALM) — nicio analiza a semnalului audio
// REAL al melodiei alese. Functiile de mai jos adauga o detectie de impulsuri (onset detection)
// usoara, PUR LOCALA (fara niciun serviciu extern platit, fara nicio biblioteca noua — doar
// PCM brut, deja extractibil cu ffmpeg, care e deja o dependinta a proiectului) — energie RMS
// pe cadre scurte + flux (crestere fata de o medie mobila exponentiala) + alegere de maxime
// locale peste un prag statistic, cu un interval minim garantat intre doua impulsuri acceptate.
// Rezultatul (o lista de momente in secunde) e folosit STRICT ca AJUSTARE fina a granitelor deja
// calculate de logica de sectiuni/durate de mai sus (vezi snapShotBoundariesToOnsets) — niciodata
// nu inlocuieste sectionTimings/alignedWords, care raman ghidul si fallback-ul principal (cerinta
// explicita: "pastrand alignedWords/section timing ca ghid/fallback"). Complet DETERMINIST —
// aceeasi melodie produce EXACT aceleasi impulsuri la o reincercare.
// ============================================================================

const ONSET_FRAME_SECONDS = 0.02;          // cadre de 20ms — suficient de fin pentru un atac muzical
const ONSET_MIN_INTERVAL_SECONDS = 0.25;   // niciodata doua impulsuri acceptate mai aproape de 250ms
// prag = medie + 4 * deviatie standard a fluxului — verificat empiric (test/audio-onset-sync.test.js):
// sub acest prag, zgomot de fundal PUR (fara niciun impuls real) produce fals-pozitive (un
// prag de 1.5 stdev, incercat initial, gasea 11 "impulsuri" intr-un clip de zgomot constant de
// 5s); la 3.5-4 stdev, zgomotul de fundal nu mai produce nicio detectie falsa, iar impulsurile
// reale (mult mai puternice ca amplitudine relativa) raman detectate exact, fara nicio pierdere.
const ONSET_FLUX_THRESHOLD_STDEV = 4;
const ONSET_EMA_ALPHA = 0.15;              // cat de repede "uita" media mobila nivelul vechi de energie

// Detecteaza impulsuri (onsets) intr-un semnal audio MONO, PCM 16-bit deja decodat (Int16Array
// sau orice array-like cu valori in [-32768, 32767]). PURA — nu atinge niciun fisier, nu apeleaza
// ffmpeg; apelantul (server.js) decodeaza fisierul audio REAL al comenzii separat. Returneaza o
// lista de momente in secunde, in ordine crescatoare. Deterministă (fara Math.random()).
function detectOnsets(samples, sampleRate, opts) {
  if (!samples || samples.length === 0 || !(sampleRate > 0)) return [];
  const frameSeconds = (opts && opts.frameSeconds > 0) ? opts.frameSeconds : ONSET_FRAME_SECONDS;
  const minInterval = (opts && opts.minIntervalSeconds > 0) ? opts.minIntervalSeconds : ONSET_MIN_INTERVAL_SECONDS;
  const thresholdStdev = (opts && typeof opts.thresholdStdev === 'number') ? opts.thresholdStdev : ONSET_FLUX_THRESHOLD_STDEV;

  const frameSize = Math.max(1, Math.round(sampleRate * frameSeconds));
  const frameCount = Math.floor(samples.length / frameSize);
  if (frameCount < 3) return [];

  // 1) Energie RMS per cadru.
  const rms = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sumSq = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[base + i] / 32768;
      sumSq += s * s;
    }
    rms[f] = Math.sqrt(sumSq / frameSize);
  }

  // 2) Flux = crestere pozitiva fata de o medie mobila exponentiala (raspunde rapid la un atac
  // brusc — o lovitura de tobă, o intrare vocala — si "uita" treptat nivelul general de volum,
  // deci functioneaza si pe pasaje cu volum general mai ridicat/scazut, nu doar in liniste).
  const flux = new Array(frameCount).fill(0);
  let movingAvg = rms[0];
  for (let f = 1; f < frameCount; f++) {
    flux[f] = Math.max(0, rms[f] - movingAvg);
    movingAvg = ONSET_EMA_ALPHA * rms[f] + (1 - ONSET_EMA_ALPHA) * movingAvg;
  }

  // 3) Prag statistic (medie + k * deviatie standard a fluxului) + alegere de maxime locale,
  // cu un interval minim garantat intre doua impulsuri acceptate consecutiv.
  const mean = flux.reduce((a, b) => a + b, 0) / frameCount;
  const variance = flux.reduce((a, b) => a + (b - mean) * (b - mean), 0) / frameCount;
  const threshold = mean + thresholdStdev * Math.sqrt(variance);
  const minIntervalFrames = Math.max(1, Math.round(minInterval / frameSeconds));

  const onsets = [];
  let lastOnsetFrame = -Infinity;
  for (let f = 1; f < frameCount - 1; f++) {
    if (flux[f] <= threshold) continue;
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue; // maxim local strict
    if (f - lastOnsetFrame < minIntervalFrames) continue;
    onsets.push(f * frameSeconds);
    lastOnsetFrame = f;
  }
  return onsets;
}

const SHOT_PLAN_ONSET_MAX_SNAP_SECONDS = 0.35; // cat de departe cauta un impuls pentru o granita

// Rezolva durata de tranzitie pentru granita `boundaryIndex` — accepta ATAT un scalar (o
// singura durata uniforma pentru toate granitele, comportamentul istoric, folosit inca de
// apelanti externi/teste care nu au nevoie de variatie per-granita) CAT SI un array (durata
// REALA per-granita, folosit intern de buildShotPlan de la cerinta E incoace — tranzitiile nu
// mai sunt uniforme). Pastreaza comportamentul vechi byte-cu-byte cand se primeste un scalar.
function resolveBoundaryXfade(xfadeOrArray, boundaryIndex, fallback) {
  if (Array.isArray(xfadeOrArray)) {
    const v = xfadeOrArray[boundaryIndex];
    return (typeof v === 'number' && v >= 0) ? v : fallback;
  }
  return (typeof xfadeOrArray === 'number' && xfadeOrArray >= 0) ? xfadeOrArray : fallback;
}

// CORECȚIE (audit independent, 2026-08-24, runda 2, "sincronizarea video cu audio") — bug REAL
// gasit: versiunea anterioara compara impulsurile cu shots[i].end, CUMULATIVA NAIVA a duratelor
// DUPA compensarea de crossfade — dar aceea NU e pozitia reala din fisierul video FINAL unde
// taietura chiar apare. concatWithCrossfades() reduce planul pe NIVELURI (loturi de maximum
// CONCAT_BATCH_SIZE, vezi server.js) — la fiecare tranzitie xfade, output-ul se comprima cu
// durata acelei tranzitii fata de suma bruta a duratelor de intrare, iar aceasta pierdere se
// COMPUNE ierarhic pe niveluri, NU liniar.
//
// Functia de mai jos MIRRORS EXACT algoritmul real de reducere din concatWithCrossfades/
// concatBatchWithCrossfades (grupare in loturi CONTIGUE de maximum batchSize, la fiecare nivel,
// pana ramane un singur nod) — dar PUR pe durate (niciun fisier, niciun ffmpeg), deci
// deterministic si testabil izolat. Returneaza, pentru fiecare granita INTERIOARA (intre cadrul
// i si i+1, i=0..n-2), pozitia REALA (in secunde, in fisierul FINAL) unde TRANZITIA dintre ele
// INCEPE (nu unde se termina).
//
// CORECȚIE (2026-08-31, cerinta E, "tranzitii variate, nu acelasi xfade peste tot"): `xfade`
// accepta acum si un ARRAY de durate per-granita (una per boundaryIndex, 0..n-2) — fiecare punct
// de imbinare din arbore corespunde EXACT unei singure granite originale intre frunze (boundary
// index = group[j].start - 1, adica granita dintre ULTIMA frunza a subarborelui stang si PRIMA
// frunza a subarborelui drept) — deci foloseste durata REALA a ACELEI granite, nu o valoare
// globala. Scalar ramane acceptat neschimbat, pentru apelantii vechi.
function computeRealBoundaryPositions(shots, xfade, batchSize) {
  const n = shots.length;
  if (n < 2) return [];
  const size = (typeof batchSize === 'number' && batchSize >= 2) ? Math.floor(batchSize) : 5;
  const fallback = 0.6;
  // fiecare "nod" reprezinta un interval CONTIGUU [start, end) din planul original (o frunza la
  // inceput, un lot deja combinat mai departe), cu durata lui totala.
  let nodes = shots.map((s, i) => ({ start: i, end: i + 1, duration: s.duration }));
  // pozitia REALA acumulata (compusa pe niveluri) unde fiecare cadru original devine "pur"
  // (complet vizibil, fara amestec cu vecinul) in fisierul FINAL.
  const leafPureStart = new Array(n).fill(0);

  while (nodes.length > 1) {
    const nextNodes = [];
    for (let g = 0; g < nodes.length; g += size) {
      const group = nodes.slice(g, g + size);
      let cumulative = group[0].duration; // S_0 — durata primului nod din grup, neschimbata
      for (let j = 1; j < group.length; j++) {
        // granita ORIGINALA (intre frunze) corespunzatoare acestei imbinari — indiferent la ce
        // nivel al arborelui are loc imbinarea, e mereu granita dintre ultima frunza a
        // subarborelui anterior (group[j].start - 1) si prima frunza a acestuia (group[j].start).
        const boundaryIndex = group[j].start - 1;
        const xfadeHere = resolveBoundaryXfade(xfade, boundaryIndex, fallback);
        const localPureStart = cumulative; // S_{j-1} — pozitia LOCALA (in acest grup) unde nodul j devine pur
        for (let leaf = group[j].start; leaf < group[j].end; leaf++) {
          leafPureStart[leaf] += localPureStart;
        }
        cumulative += group[j].duration - xfadeHere; // actualizeaza S_j pentru urmatoarea iteratie
      }
      const mergedDuration = group.length > 1 ? cumulative : group[0].duration;
      nextNodes.push({ start: group[0].start, end: group[group.length - 1].end, duration: mergedDuration });
    }
    nodes = nextNodes;
  }

  // granita interioara i (intre cadrul i si i+1) = INCEPUTUL tranzitiei catre cadrul i+1 —
  // valabil la ORICE nivel al ierarhiei (tranzitia are mereu durata proprie granitei i,
  // indiferent unde apare in arbore), deci scaderea de mai jos e corecta universal.
  const boundaries = [];
  for (let i = 0; i < n - 1; i++) {
    boundaries.push(Math.max(0, leafPureStart[i + 1] - resolveBoundaryXfade(xfade, i, fallback)));
  }
  return boundaries;
}

// Ajusteaza granitele INTERIOARE ale planului de cadre deja calculat la cel mai apropiat impuls
// detectat, DOAR daca exista unul suficient de aproape (<= maxSnapSeconds) de pozitia REALA
// (vezi computeRealBoundaryPositions mai sus — NICIODATA suma cumulativa naiva) — NICIODATA prima
// granita (inceputul primului cadru, mereu 0) sau ultima (finalul ultimului cadru, mereu
// durationSeconds), si NICIODATA dincolo de un cadru vecin (pastreaza SHOT_PLAN_MIN_SHOT_SECONDS
// ca durata minima pe ambele parti) — numarul total de cadre si durata totala raman EXACT
// neschimbate (fiecare ajustare e o pereche +delta/-delta pe cadrele i/i+1, suma constanta),
// doar POZITIA taieturii se muta usor pe impuls. Pozitiile REALE sunt RECALCULATE dupa fiecare
// ajustare — o modificare langa o granita de lot (CONCAT_BATCH_SIZE) poate deplasa usor pozitia
// reala a granitelor urmatoare, deci fiecare decizie foloseste starea CURENTA, nu una invechita.
// Fara impulsuri (melodie fara analiza reusita, sau nicio potrivire suficient de aproape), planul
// ramane STRICT cel calculat de durate/sectiuni — acesta e fallback-ul.
//
// `xfade` accepta scalar SAU array per-granita (vezi computeRealBoundaryPositions) — trecut mai
// departe neschimbat, fara nicio presupunere aici despre forma lui.
function snapShotBoundariesToOnsets(shots, onsetTimes, xfade, batchSize, maxSnapSeconds) {
  if (!onsetTimes || onsetTimes.length === 0 || !shots || shots.length < 2) return shots;
  const maxSnap = (typeof maxSnapSeconds === 'number' && maxSnapSeconds > 0) ? maxSnapSeconds : SHOT_PLAN_ONSET_MAX_SNAP_SECONDS;
  const x = Array.isArray(xfade) ? xfade : ((typeof xfade === 'number' && xfade >= 0) ? xfade : 0.6);
  const sorted = onsetTimes.slice().sort((a, b) => a - b);

  function nearestOnsetWithin(t) {
    let best = null;
    let bestDist = Infinity;
    for (const o of sorted) {
      const d = Math.abs(o - t);
      if (d < bestDist) { bestDist = d; best = o; }
      if (o > t + maxSnap) break; // sortat crescator — niciun candidat mai bun mai departe
    }
    return (best !== null && bestDist <= maxSnap) ? best : null;
  }

  for (let i = 0; i < shots.length - 1; i++) {
    const realBoundaries = computeRealBoundaryPositions(shots, x, batchSize);
    const currentReal = realBoundaries[i];
    const target = nearestOnsetWithin(currentReal);
    if (target === null) continue;
    const delta = target - currentReal;
    const proposedI = shots[i].duration + delta;
    const proposedI1 = shots[i + 1].duration - delta;
    if (proposedI < SHOT_PLAN_MIN_SHOT_SECONDS || proposedI1 < SHOT_PLAN_MIN_SHOT_SECONDS) continue;
    shots[i].duration = proposedI;
    shots[i + 1].duration = proposedI1;
  }

  // start/end cumulative NAIVE, recalculate DOAR pentru consecventa interna (sectionTypeAt,
  // orice cod/test care le citeste) — randarea reala foloseste STRICT shots[i].duration, nu
  // aceste campuri (concatBatchWithCrossfades isi calculeaza singur offset-urile, de la zero).
  let running = 0;
  shots.forEach(sh => { sh.start = running; sh.end = running + sh.duration; running = sh.end; });
  return shots;
}

// Construieste planul complet de cadre pentru intreaga melodie. `mediaItems` — lista in
// ORDINEA aleasa de client (deja trecuta prin sortMediaBySection de catre apelant, ca la
// modelul vechi) — necesita STRICT metadate usoare (`.type`, folosit pentru alternanta
// poze/video si Ken Burns — vezi mai jos), NU fisierele descarcate local (buildMemoryBackground,
// server.js, construieste acest plan INAINTE de a descarca vreo sursa, cerinta F).
// `xfadeSeconds` — pastrat STRICT pentru compatibilitatea semnaturii (apelanti vechi/teste care
// transmit MEMORY_XFADE_SECONDS) — nu mai e sursa de adevar a duratei de tranzitie (vezi
// chooseTransitionDuration mai sus, cerinta E) — durata reala variaza acum per-granita.
// Returneaza [] daca nu exista materiale sau daca durationSeconds nu e un numar pozitiv valid
// — apelantul (server.js) trateaza asta ca fallback pe fundal solid, exact ca inainte.
function buildShotPlan(mediaItems, durationSeconds, sectionTimings, xfadeSeconds, onsetTimes, concatBatchSize) {
  const n = mediaItems.length;
  if (n === 0 || !(durationSeconds > 0)) return [];
  const timings = (sectionTimings && sectionTimings.length > 0) ? sectionTimings : [];

  // ---- PASUL 1a: sloturi PRIORITARE (0-25s), NEPLAFONATE — garanteaza minimum 8 schimbari in
  // primele 25s ale previzualizarii gratuite (cerinta testata explicit cu ffprobe). ----
  const previewSlots = [];
  let t = 0;
  while (t < Math.min(SHOT_PLAN_PREVIEW_PRIORITY_SECONDS, durationSeconds)) {
    const d = Math.min(SHOT_PLAN_PREVIEW_SHOT_SECONDS, durationSeconds - t);
    previewSlots.push({ duration: d, energy: 'calm' });
    t += d;
  }
  while (t < Math.min(SHOT_PLAN_PREVIEW_WINDOW_SECONDS, durationSeconds)) {
    const d = Math.min(SHOT_PLAN_PREVIEW_TAIL_SHOT_SECONDS, durationSeconds - t);
    previewSlots.push({ duration: d, energy: 'calm' });
    t += d;
  }

  // ---- PASUL 1b: restul melodiei, ritm dupa tipul REAL al sectiunii curente. ----
  const mainSlots = [];
  if (t < durationSeconds) {
    let cursor = t;
    while (cursor < durationSeconds) {
      const type = sectionTypeAt(timings, cursor);
      const energetic = ENERGETIC_SECTION_TYPES.has(type);
      const base = energetic ? SHOT_PLAN_ENERGETIC_SHOT_SECONDS : SHOT_PLAN_CALM_SHOT_SECONDS;
      const dur = Math.min(base, durationSeconds - cursor);
      mainSlots.push({ duration: dur, energy: energetic ? 'energetic' : 'calm' });
      cursor += dur;
    }
  }

  // ---- PASUL 2 (cerinta 7 — "cel putin atatea cadre cate materiale, pentru melodii suficient
  // de lungi"): daca planul natural (previzualizare + restul) are mai putine sloturi decat
  // materiale, dar melodia e suficient de lunga ca fiecare material sa primeasca macar un cadru
  // (durationSeconds >= n * SHOT_PLAN_MIN_SHOT_SECONDS), "impartim" deterministic cele mai
  // lungi sloturi din RESTUL melodiei (zona de previzualizare ramane neschimsa — deja suficient
  // de densa) pana ajungem la n sloturi totale, sau pana niciunul nu mai poate fi impartit fara
  // sa coboare sub SHOT_PLAN_MIN_SHOT_SECONDS.
  const naturalTotal = previewSlots.length + mainSlots.length;
  if (naturalTotal < n && n <= SHOT_PLAN_MAX_SHOTS && durationSeconds >= n * SHOT_PLAN_MIN_SHOT_SECONDS) {
    // CORECȚIE (gasita direct prin testare, in timpul acestei dezvoltari): restrictionarea
    // divizarii STRICT la `mainSlots` (asa cum sugera comentariul initial, "zona de
    // previzualizare ramane neschimbata") produce un plan cu MAI PUTINE cadre decat materiale
    // pentru o melodie scurta (~30s) cu multe materiale (~20-30) — toata "grasimea" divizabila
    // e concentrata in zona de previzualizare (sloturi de 2.2-2.7s), in timp ce restul melodiei
    // poate contine un singur slot, prea scurt sa fie divizat suficient de multe ori singur.
    // Cautam deci cel mai lung slot divizabil din ORICARE dintre cele doua faze — previzualizarea
    // ramane la fel de DENSA (nu se schimba NUMARUL ei minim de cadre garantat de pasul 1a, doar
    // se pot adauga cadre suplimentare acolo cand chiar e nevoie ca sa acoperim toate materialele).
    // Retine STRICT jumatatea A DOUA a ULTIMEI divizari facute — foloseste-o mai jos ca sa
    // decidem daca finalul planului chiar a fost taiat abrupt de ACEASTA logica (nu de un rest
    // scurt, complet normal, produs deja de faza principala inainte de orice divizare — o
    // melodie ale carei sectiuni nu impart exact la SHOT_PLAN_CALM_SHOT_SECONDS produce oricum
    // un ultim cadru mai scurt, comportament vechi, neschimbat, niciodata problema aici).
    let lastSplitHalf = null;
    while (previewSlots.length + mainSlots.length < n) {
      let best = null, bestDur = -1;
      for (const slot of previewSlots) {
        if (slot.duration / 2 >= SHOT_PLAN_MIN_SHOT_SECONDS && slot.duration > bestDur) { bestDur = slot.duration; best = { list: previewSlots, slot }; }
      }
      for (const slot of mainSlots) {
        if (slot.duration / 2 >= SHOT_PLAN_MIN_SHOT_SECONDS && slot.duration > bestDur) { bestDur = slot.duration; best = { list: mainSlots, slot }; }
      }
      if (!best) break;
      const { list, slot } = best;
      const idx = list.indexOf(slot);
      const half = slot.duration / 2;
      const energy = slot.energy;
      const halfA = { duration: half, energy };
      const halfB = { duration: half, energy };
      list.splice(idx, 1, halfA, halfB);
      lastSplitHalf = halfB;
    }
    // Cerinta 5 ("finalul trebuie sa fie stabil, nu o taietura abrupta") — STRICT daca ultimul
    // slot al INTREGULUI plan este chiar jumatatea creata de ULTIMA divizare de mai sus (adica
    // divizarea a produs efectiv taietura abrupta de la final), se reuneste cu vecinul sau
    // imediat anterior DIN ACEEASI LISTA. Un rest scurt PRE-EXISTENT (niciodata atins de
    // divizare) ramane neschimbat — nu e o problema introdusa de aceasta corectie.
    const lastList = mainSlots.length > 0 ? mainSlots : previewSlots;
    if (lastSplitHalf && lastList.length >= 2 && lastList[lastList.length - 1] === lastSplitHalf) {
      const last = lastList[lastList.length - 1];
      const prev = lastList[lastList.length - 2];
      if (last.duration < SHOT_PLAN_MIN_SHOT_SECONDS * 1.5) {
        prev.duration += last.duration;
        lastList.pop();
      }
    }
  }

  // ---- PASUL 3: plafon SHOT_PLAN_MAX_SHOTS — STRICT pe restul melodiei (previzualizarea nu
  // e afectata niciodata de acest plafon, garantand densitatea ei). ----
  const budget = Math.max(1, SHOT_PLAN_MAX_SHOTS - previewSlots.length);
  let finalMainSlots = mainSlots;
  if (mainSlots.length > budget) {
    // Bucketizare PROPORTIONALA pe index (nu un prag de numarare acumulat) — garanteaza
    // EXACT `budget` grupuri, indiferent de raportul fractionar dintre mainSlots.length si
    // budget.
    const merged = [];
    for (let i = 0; i < mainSlots.length; i++) {
      const groupIdx = Math.min(budget - 1, Math.floor((i * budget) / mainSlots.length));
      if (!merged[groupIdx]) merged[groupIdx] = { duration: 0, energy: mainSlots[i].energy };
      merged[groupIdx].duration += mainSlots[i].duration;
    }
    finalMainSlots = merged.filter(Boolean).map(m => ({ duration: Math.max(SHOT_PLAN_MIN_SHOT_SECONDS, m.duration), energy: m.energy }));
  }

  const shots = previewSlots.concat(finalMainSlots);
  if (shots.length === 0) return [];

  // start/end/sectionType BRUTE (inainte de orice compensatie de tranzitie) — necesare pentru
  // chooseTransitionDuration() (tipul de sectiune al fiecarui cadru) mai jos.
  {
    let running = 0;
    shots.forEach(s => {
      s.start = running;
      s.end = running + s.duration;
      running = s.end;
      s.sectionType = sectionTypeAt(timings, s.start);
    });
  }

  // Corectie de rotunjire — suma BRUTA a cadrelor trebuie sa ramana identica cu durata
  // melodiei — ÎNAINTE de atribuirea materialelor/compensatia pentru tranzitii de mai jos.
  {
    const sum = shots.reduce((s, sh) => s + sh.duration, 0);
    const diff = durationSeconds - sum;
    shots[shots.length - 1].duration += diff;
    shots[shots.length - 1].end += diff;
  }

  // Cerinta 5 ("finalul trebuie sa ofere un final stabil, nu o taietura abrupta/aleatorie") —
  // ultimul cadru al INTREGULUI plan devine STRICT calm, indiferent de sectiunea reala in care
  // cade (o melodie care se termina chiar intr-un refren nu trebuie sa taie pe un cadru rapid).
  shots[shots.length - 1].energy = 'calm';

  // ---- PASUL 4: atribuirea materialului pe TURE (lap model) — vezi buildLapOrder mai sus. ----
  const occurrenceCountByItem = new Array(n).fill(0);
  let lapIndexCounter = 0;
  let posInLap = n;
  let currentLapOrder = [];
  let previousItemIndex = -1;
  const lapRanges = [];

  for (let i = 0; i < shots.length; i++) {
    if (posInLap >= n) {
      let attempt = 0;
      let candidate = buildLapOrder(n, lapIndexCounter);
      // Regula 3 la granita dintre doua ture — daca prima pozitie a turei noi ar coincide cu
      // ultimul cadru deja plasat, rotim tura cu inca o pozitie (maximum n-1 incercari,
      // suficient — garantat sa rezolve pentru n>=2, singurul caz in care coliziunea e posibila).
      while (n > 1 && candidate[0] === previousItemIndex && attempt < n - 1) {
        candidate = candidate.slice(1).concat(candidate.slice(0, 1));
        attempt++;
      }
      currentLapOrder = candidate;
      lapIndexCounter++;
      posInLap = 0;
      lapRanges.push({ start: i, end: i });
    }
    const itemIndex = currentLapOrder[posInLap];
    posInLap++;
    const occurrence = occurrenceCountByItem[itemIndex]++;
    shots[i].itemIndex = itemIndex;
    shots[i].occurrence = occurrence;
    lapRanges[lapRanges.length - 1].end = i + 1;
    previousItemIndex = itemIndex;
  }

  // ---- PASUL 5 (cerinta 5 — "mijlocul alterneaza poze si video") — trecere UNICA,
  // determinista, best-effort: sparge sirurile de 3+ cadre consecutive de ACELASI tip media in
  // mijlocul planului (exclude primul si ultimul cadru din TOT planul), STRICT prin
  // interschimbarea (itemIndex, occurrence) a doua POZITII din ACEEASI TURA (niciodata intre
  // ture diferite — ar putea strica regulile 1/2, "toate materialele aparute inainte de orice
  // repetare", care sunt garantate STRICT per-tura de constructia de mai sus) — si STRICT daca
  // interschimbarea nu creeaza nicio repetare consecutiva noua (regula 3) la niciuna dintre
  // cele 4 perechi de vecini afectate. Fara niciun schimb sigur, sirul ramane neschimbat —
  // cerinta explicita: "nu forta, nu relaxa regulile 1-3 pentru asta".
  if (n > 1) {
    const mediaTypeAt = (idx) => {
      const item = mediaItems[shots[idx].itemIndex];
      return item && item.type;
    };
    const breaksRule3After = (idx, otherItemIndex) => {
      const leftOk = idx === 0 || shots[idx - 1].itemIndex !== otherItemIndex;
      const rightOk = idx === shots.length - 1 || shots[idx + 1].itemIndex !== otherItemIndex;
      return !(leftOk && rightOk);
    };
    lapRanges.forEach(({ start, end }) => {
      const loStart = Math.max(start, 1);
      const hiEndExclusive = Math.min(end, shots.length - 1); // exclude ultimul cadru din tot planul
      for (let i = loStart; i + 2 < hiEndExclusive; i++) {
        const t0 = mediaTypeAt(i), t1 = mediaTypeAt(i + 1), t2 = mediaTypeAt(i + 2);
        if (!t0 || t0 !== t1 || t1 !== t2) continue;
        for (let j = start; j < end; j++) {
          const posA = i + 1, posB = j;
          if (posB === posA || Math.abs(posA - posB) === 1) continue; // adiacente — sarim, prea riscant/inutil
          if (mediaTypeAt(posB) === t0) continue; // acelasi tip, nu ajuta
          const itemA = shots[posA].itemIndex, occA = shots[posA].occurrence;
          const itemB = shots[posB].itemIndex, occB = shots[posB].occurrence;
          if (breaksRule3After(posA, itemB) || breaksRule3After(posB, itemA)) continue;
          shots[posA].itemIndex = itemB; shots[posA].occurrence = occB;
          shots[posB].itemIndex = itemA; shots[posB].occurrence = occA;
          break;
        }
      }
    });
  }

  // ---- PASUL 6 (cerinta C) — Ken Burns GLOBAL (doar cadre foto; niciodata aceeasi miscare de
  // doua ori la rand, indiferent de material) — ultimul cadru, daca e o poza, primeste STRICT
  // varianta cea mai discreta (cerinta 5, "final stabil"). ----
  let previousKenBurnsId = null;
  shots.forEach((shot, i) => {
    const item = mediaItems[shot.itemIndex];
    if (item && item.type === 'photo') {
      const isLast = i === shots.length - 1;
      const kb = pickKenBurnsVariant(isLast ? 0 : (shot.itemIndex + shot.occurrence), previousKenBurnsId);
      shot.kenBurns = kb;
      previousKenBurnsId = kb.id;
    } else {
      shot.kenBurns = null;
      previousKenBurnsId = null;
    }
  });

  // ---- PASUL 7 (cerinta E) — durata de tranzitie PER GRANITA + compensatie. ----
  const boundaryDurations = [];
  for (let i = 0; i < shots.length - 1; i++) {
    boundaryDurations.push(chooseTransitionDuration(shots, i));
  }
  shots.forEach((s, i) => {
    s.transitionOut = i < boundaryDurations.length ? 'fade' : null;
    s.transitionDuration = i < boundaryDurations.length ? boundaryDurations[i] : null;
  });

  if (shots.length > 1) {
    // Fiecare granita "fura" durata proprie din pozitia vizibila finala (cadrele se suprapun in
    // timpul tranzitiei) — distribuim JUMATATE din fiecare granita pe cadrul din stanga, jumatate
    // pe cel din dreapta (acelasi principiu de distributie egala ca inainte, aplicat acum per-
    // granita, nu cu o valoare unica globala) — suma totala adaugata ramane EXACT suma duratelor
    // de tranzitie, deci durata FINALA (dupa suprapunerile reale) ramane exact durationSeconds.
    const compensationPerShot = new Array(shots.length).fill(0);
    boundaryDurations.forEach((d, i) => {
      compensationPerShot[i] += d / 2;
      compensationPerShot[i + 1] += d / 2;
    });
    let running = 0;
    shots.forEach((s, i) => {
      s.duration += compensationPerShot[i];
      s.start = running;
      s.end = running + s.duration;
      running = s.end;
    });
  }

  // ALINIERE LA IMPULS — vezi comentariul detaliat de la computeRealBoundaryPositions/
  // snapShotBoundariesToOnsets mai sus. Aplicata AICI, DUPA compensatia tehnica de mai sus.
  // Foloseste ACUM duratele REALE per-granita (boundaryDurations, aceleasi shots[i].
  // transitionDuration) — NU un scalar global — ca simularea sa corespunda EXACT cu randarea
  // reala (concatWithCrossfades, server.js). Fara onsetTimes (analiza audio indisponibila/
  // esuata), shots ramane NESCHIMBAT — exact planul bazat pe sectiuni/durate de mai sus,
  // fallback-ul explicit cerut.
  if (onsetTimes && onsetTimes.length > 0) {
    snapShotBoundariesToOnsets(shots, onsetTimes, boundaryDurations, concatBatchSize);
  }

  return shots;
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
  sortMediaBySection,
  buildShotPlan,
  KEN_BURNS_VARIANTS,
  kenBurnsVariantFor,
  pickKenBurnsVariant,
  chooseTransitionDuration,
  SHOT_PLAN_PREVIEW_PRIORITY_SECONDS,
  SHOT_PLAN_PREVIEW_WINDOW_SECONDS,
  SHOT_PLAN_MAX_SHOTS,
  SHOT_PLAN_MIN_SHOT_SECONDS,
  SHOT_PLAN_CUT_XFADE_SECONDS,
  SHOT_PLAN_DISSOLVE_XFADE_SECONDS,
  SHOT_PLAN_ENDCAP_XFADE_SECONDS,
  detectOnsets,
  snapShotBoundariesToOnsets,
  computeRealBoundaryPositions,
  SHOT_PLAN_ONSET_MAX_SNAP_SECONDS
};
