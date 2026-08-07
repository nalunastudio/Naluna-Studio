// test/media-analysis.test.js
// Teste automate, pure (fara Postgres/Stripe/Suno/R2) pentru lib/media-analysis.js —
// validarea reala a continutului fisierelor (magic bytes) si true section timing alignment.
// Ruleaza cu: npm test  (node --test, inclus nativ din Node 18+, fara dependinte noi).
//
// Acopera direct urmatoarele puncte din lista de 27 teste obligatorii cerute (relansare
// pachet "Cadou video", 2026-08-06):
//   19. Secțiunile video folosesc timestamp-uri reale.
//   20. Nu se folosește distribuția egală prezentată ca true timing.
//   21/22. Semnatura reala de fisier pentru MP4/MOV/HEIC — respinge continut care nu
//          corespunde tipului declarat.
// Restul celor 27 de scenarii (flux end-to-end, plata, webhook, DB) necesita un mediu cu
// Postgres/Stripe/Suno reale sau simulate — vezi raportul final, sectiunea teste manuale.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bufferMatchesDeclaredType,
  inferMediaType,
  normalizeSectionType,
  extractSectionMarkersFromAlignedWords,
  deriveSectionTimings,
  computeSectionAwareSegmentDurations,
  findRealWindowIndex,
  MEMORY_SECTION_ORDER,
  sortMediaBySection
} = require('../lib/media-analysis');

const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/x-adobe-dng'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];

test('bufferMatchesDeclaredType — accepta JPEG real', () => {
  const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  assert.equal(bufferMatchesDeclaredType(buf, 'image/jpeg'), true);
});

test('bufferMatchesDeclaredType — respinge un fisier PNG fals declarat JPEG', () => {
  const pngBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(bufferMatchesDeclaredType(pngBuf, 'image/jpeg'), false);
});

test('bufferMatchesDeclaredType — accepta MP4/MOV/HEIC (container ISO-BMFF "ftyp")', () => {
  const ftypBuf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]); // "....ftypisom"
  assert.equal(bufferMatchesDeclaredType(ftypBuf, 'video/mp4'), true);
  assert.equal(bufferMatchesDeclaredType(ftypBuf, 'video/quicktime'), true);
  assert.equal(bufferMatchesDeclaredType(ftypBuf, 'image/heic'), true);
});

test('bufferMatchesDeclaredType — respinge text arbitrar declarat ca orice format media', () => {
  const textBuf = Buffer.from('nu sunt deloc un fisier media, doar text simplu', 'utf8');
  for (const mime of ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'audio/wav', 'audio/mpeg']) {
    assert.equal(bufferMatchesDeclaredType(textBuf, mime), false, `ar trebui respins pentru ${mime}`);
  }
});

test('bufferMatchesDeclaredType — tip necunoscut, intotdeauna respins (allowlist stricta)', () => {
  const buf = Buffer.from([0xFF, 0xD8, 0xFF]);
  assert.equal(bufferMatchesDeclaredType(buf, 'application/x-executable'), false);
});

// Apple ProRAW/.dng — hotfix 2026-08-07, problema 2. DNG e un container TIFF; Apple scrie
// intotdeauna big-endian ("MM\0*"), dar acceptam si little-endian ("II*\0"), valabil conform
// specificatiei TIFF/DNG SDK Adobe, chiar daca fisierele Apple nu il folosesc in practica.
test('bufferMatchesDeclaredType — accepta DNG real (TIFF big-endian, "MM\\0*", scris de Apple)', () => {
  const dngBuf = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]);
  assert.equal(bufferMatchesDeclaredType(dngBuf, 'image/x-adobe-dng'), true);
});

test('bufferMatchesDeclaredType — accepta DNG cu TIFF little-endian ("II*\\0")', () => {
  const dngBuf = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
  assert.equal(bufferMatchesDeclaredType(dngBuf, 'image/x-adobe-dng'), true);
});

test('bufferMatchesDeclaredType — respinge un JPEG fals declarat DNG', () => {
  const jpegBuf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  assert.equal(bufferMatchesDeclaredType(jpegBuf, 'image/x-adobe-dng'), false);
});

test('normalizeSectionType — recunoaste marcajele standard Suno, ignora restul', () => {
  assert.equal(normalizeSectionType('Verse 1'), 'verse');
  assert.equal(normalizeSectionType('Chorus'), 'chorus');
  assert.equal(normalizeSectionType('Pre-Chorus'), 'pre_chorus');
  assert.equal(normalizeSectionType('Bridge'), 'bridge');
  assert.equal(normalizeSectionType('Outro'), 'outro');
  assert.equal(normalizeSectionType('Intro'), 'intro');
  assert.equal(normalizeSectionType('Gentle acoustic guitar fingerpicking'), null);
});

function fakeAlignedWord(word, startS, success = true) {
  return { word, startS, endS: startS + 0.3, success };
}

test('extractSectionMarkersFromAlignedWords — extrage marcajele REALE, sortate cronologic, fara duplicate', () => {
  const words = [
    fakeAlignedWord('[Intro] ', 0),
    fakeAlignedWord('La ', 1),
    fakeAlignedWord('la ', 2),
    fakeAlignedWord('[Verse]', 8),
    fakeAlignedWord('Primul ', 8.5),
    fakeAlignedWord('cuvant ', 9),
    fakeAlignedWord('[Chorus]', 30),
    fakeAlignedWord('Refren ', 30.5)
  ];
  const markers = extractSectionMarkersFromAlignedWords(words);
  assert.deepEqual(markers.map(m => m.type), ['intro', 'verse', 'chorus']);
  assert.equal(markers[0].startS, 0);
  assert.equal(markers[1].startS, 8);
  assert.equal(markers[2].startS, 30);
});

test('extractSectionMarkersFromAlignedWords — nicio eticheta -> lista goala (fara marcaje inventate)', () => {
  const words = [fakeAlignedWord('Doar ', 0), fakeAlignedWord('versuri ', 1), fakeAlignedWord('normale', 2)];
  assert.deepEqual(extractSectionMarkersFromAlignedWords(words), []);
});

test('deriveSectionTimings — cu 3+ marcaje reale, produce sectiuni "aligned" cu ferestre reale, nu egale', () => {
  const words = [
    fakeAlignedWord('[Intro]', 0),
    fakeAlignedWord('[Verse]', 10),
    fakeAlignedWord('[Chorus]', 25),
    fakeAlignedWord('[Outro]', 50)
  ];
  const durationSeconds = 60;
  const sections = deriveSectionTimings(words, durationSeconds, 'variant-abc');

  assert.equal(sections.length, 4);
  for (const s of sections) {
    assert.equal(s.alignmentStatus, 'aligned');
    assert.equal(s.source, 'suno_section_marker');
    assert.equal(s.audioVariantId, 'variant-abc');
  }
  assert.deepEqual(sections.map(s => [s.sectionType, s.startTime, s.endTime]), [
    ['intro', 0, 10],
    ['verse', 10, 25],
    ['chorus', 25, 50],
    ['outro', 50, 60]
  ]);
  // NU toate sectiunile au aceeasi durata — semnul distinctiv ca NU e o distributie egala.
  const durations = sections.map(s => s.endTime - s.startTime);
  assert.notEqual(durations[0], durations[1]);
});

test('deriveSectionTimings — FARA marcaje reale (0 sau 1), fallback CONTROLAT si CLAR ETICHETAT, niciodata "aligned"', () => {
  const noMarkers = [fakeAlignedWord('Doar ', 0), fakeAlignedWord('versuri', 1)];
  const oneMarker = [fakeAlignedWord('[Intro]', 0), fakeAlignedWord('restul ', 1), fakeAlignedWord('fara alt marcaj', 2)];

  for (const words of [noMarkers, oneMarker]) {
    const sections = deriveSectionTimings(words, 120, 'variant-xyz');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].source, 'fallback_equal');
    assert.equal(sections[0].alignmentStatus, 'fallback');
    assert.equal(sections[0].confidence, 0);
    assert.equal(sections[0].startTime, 0);
    assert.equal(sections[0].endTime, 120);
    assert.notEqual(sections[0].alignmentStatus, 'aligned'); // niciodata prezentat drept real
  }
});

// Cerinta F11: daca primul marcaj real NU incepe la secunda 0 (ex. intro instrumental de
// 8-10s inainte de primul cuvant etichetat), intervalul [0, primul marcaj) trebuie
// REPREZENTAT EXPLICIT ca propria lui sectiune — nu absorbit tacit in ultima sectiune
// (bug vechi) si nici marcajele reale nu trebuie mutate mai devreme.
test('deriveSectionTimings — pastreaza timpii absoluti cand primul marcaj NU incepe la 0', () => {
  const words = [
    fakeAlignedWord('[Verse]', 9),   // primul marcaj real la 9s, NU la 0
    fakeAlignedWord('[Chorus]', 30),
    fakeAlignedWord('[Outro]', 50)
  ];
  const durationSeconds = 60;
  const sections = deriveSectionTimings(words, durationSeconds, 'variant-gap');

  // 4 sectiuni: intervalul dedus [0,9) + cele 3 marcaje reale
  assert.equal(sections.length, 4);
  assert.deepEqual(sections.map(s => [s.sectionType, s.startTime, s.endTime]), [
    ['intro', 0, 9],
    ['verse', 9, 30],
    ['chorus', 30, 50],
    ['outro', 50, 60]
  ]);
  // sectiunea dedusa e marcata distinct (nu vine dintr-o eticheta Suno proprie), dar tot
  // 'aligned' — granitele ei sunt certe (0 = inceput real, 9 = marcaj real Suno)
  assert.equal(sections[0].source, 'leading_gap');
  assert.equal(sections[0].alignmentStatus, 'aligned');
  // marcajul real [Verse] NU a fost mutat mai devreme — startTime-ul lui ramane EXACT 9,
  // dovada ca timpul lipsa nu a fost "imprumutat" din sectiunea reala
  assert.equal(sections[1].startTime, 9);
  // suma ferestrelor acopera EXACT toata durata melodiei, fara gol si fara suprapunere
  assert.equal(sections[0].startTime, 0);
  assert.equal(sections[sections.length - 1].endTime, durationSeconds);
});

test('deriveSectionTimings — primul marcaj chiar la 0, nicio sectiune dedusa suplimentar', () => {
  const words = [fakeAlignedWord('[Intro]', 0), fakeAlignedWord('[Chorus]', 20)];
  const sections = deriveSectionTimings(words, 40, 'v1');
  assert.equal(sections.length, 2); // fara sectiune "leading_gap" — nu era niciun gol
  assert.equal(sections[0].source, 'suno_section_marker');
});

test('computeSectionAwareSegmentDurations — aloca PROPORTIONAL cu ferestrele reale, nu egal (itemi neetichetati)', () => {
  // 3 sectiuni reale: 20s, 5s, 25s (total 50s) — o sectiune scurta (5s) langa doua lungi.
  // 7 itemi FARA eticheta (section: null), deliberat un numar care NU imparte exact
  // ferestrele (evita o coincidenta numerica in care alocarea ar produce accidental
  // exact aceeasi durata per element).
  const sectionTimings = [
    { alignmentStatus: 'aligned', sectionType: 'intro', startTime: 0, endTime: 20 },
    { alignmentStatus: 'aligned', sectionType: 'chorus', startTime: 20, endTime: 25 },
    { alignmentStatus: 'aligned', sectionType: 'outro', startTime: 25, endTime: 50 }
  ];
  const mediaItems = Array.from({ length: 7 }, () => ({ section: null }));
  const xfade = 0.6;
  const durations = computeSectionAwareSegmentDurations(mediaItems, 50, sectionTimings, xfade);

  assert.equal(durations.length, 7);
  const total = durations.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - (50 + (7 - 1) * xfade)) < 1e-6, `total=${total}`);
  const uniqueDurations = new Set(durations.map(d => Math.round((d - (7 - 1) * xfade / 7) * 1000)));
  assert.ok(uniqueDurations.size > 1, `ar trebui sa existe cel putin 2 durate distincte de fereastra, gasit: ${[...uniqueDurations]}`);
});

// Cerinta F12: materialele ETICHETATE de client trebuie plasate in FEREASTRA REALA
// corespunzatoare tipului lor, nu doar sortate global si impartite proportional.
test('computeSectionAwareSegmentDurations — plaseaza materialele ETICHETATE in fereastra reala corecta', () => {
  const sectionTimings = [
    { alignmentStatus: 'aligned', sectionType: 'intro', startTime: 0, endTime: 10 },
    { alignmentStatus: 'aligned', sectionType: 'verse', startTime: 10, endTime: 30 },
    { alignmentStatus: 'aligned', sectionType: 'chorus', startTime: 30, endTime: 40 },
    { alignmentStatus: 'aligned', sectionType: 'verse', startTime: 40, endTime: 55 }, // a doua strofa reala
    { alignmentStatus: 'aligned', sectionType: 'outro', startTime: 55, endTime: 60 }
  ];
  // un singur item per eticheta — fiecare trebuie sa primeasca EXACT durata ferestrei lui
  const mediaItems = [
    { key: 'p1', section: 'beginning' },
    { key: 'p2', section: 'verse1' },
    { key: 'p3', section: 'chorus' },
    { key: 'p4', section: 'verse2' },
    { key: 'p5', section: 'ending' }
  ];
  const xfade = 0; // fara compensatie de tranzitie, ca sa verificam duratele "brute" direct
  const durations = computeSectionAwareSegmentDurations(mediaItems, 60, sectionTimings, xfade);

  assert.deepEqual(durations, [10, 20, 10, 15, 5]);
});

test('findRealWindowIndex — "verse2" prefera a DOUA aparitie reala a unei strofe', () => {
  const sections = [
    { sectionType: 'verse', startTime: 0, endTime: 10 },
    { sectionType: 'chorus', startTime: 10, endTime: 20 },
    { sectionType: 'verse', startTime: 20, endTime: 30 }
  ];
  assert.equal(findRealWindowIndex('verse1', sections), 0);
  assert.equal(findRealWindowIndex('verse2', sections), 2);
  assert.equal(findRealWindowIndex('chorus', sections), 1);
});

test('computeSectionAwareSegmentDurations — returneaza null (niciodata o presupunere tacita) fara date reale', () => {
  const items5 = Array.from({ length: 5 }, () => ({ section: null }));
  assert.equal(computeSectionAwareSegmentDurations(items5, 60, [], 0.6), null);
  assert.equal(computeSectionAwareSegmentDurations(items5, 60, null, 0.6), null);
  assert.equal(computeSectionAwareSegmentDurations(items5, 60, [{ alignmentStatus: 'fallback', startTime: 0, endTime: 60 }], 0.6), null);
});

test('sortMediaBySection — ordoneaza dupa eticheta clientului, pastreaza ordinea de incarcare in interior', () => {
  const items = [
    { key: 'a', section: 'ending' },
    { key: 'b', section: 'beginning' },
    { key: 'c', section: null },
    { key: 'd', section: 'beginning' },
    { key: 'e', section: 'chorus' }
  ];
  const sorted = sortMediaBySection(items).map(i => i.key);
  // beginning (b,d in ordinea incarcarii) -> chorus (e) -> ending (a) -> fara eticheta (c) la coada
  assert.deepEqual(sorted, ['b', 'd', 'e', 'a', 'c']);
});

test('MEMORY_SECTION_ORDER — contine exact cele 5 chei canonice folosite de UI-ul de upload', () => {
  assert.deepEqual(MEMORY_SECTION_ORDER, ['beginning', 'verse1', 'chorus', 'verse2', 'ending']);
});

// HOTFIX 2026-08-07: uploadurile de pe iPhone (Safari iOS) esuau COMPLET pentru ca serverul
// accepta STRICT mimetype-ul brut trimis de browser, gol/generic pentru HEIC sau fisiere
// nematerializate din iCloud. inferMediaType() adauga fallback pe extensie — testat izolat.
test('inferMediaType — mimetype valid de la browser, folosit direct (fara fallback)', () => {
  const r = inferMediaType('poza.jpg', 'image/jpeg', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'photo', mimetype: 'image/jpeg' });
});

test('inferMediaType — mimetype gol (Safari iOS pentru HEIC) -> fallback pe extensie', () => {
  const r = inferMediaType('IMG_1234.heic', '', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'photo', mimetype: 'image/heic' });
});

test('inferMediaType — extensie cu MAJUSCULE (IMG_1234.HEIC) -> fallback functioneaza case-insensitive', () => {
  const r = inferMediaType('IMG_1234.HEIC', 'application/octet-stream', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'photo', mimetype: 'image/heic' });
});

test('inferMediaType — MOV cu mimetype generic "application/octet-stream" -> fallback pe extensie .mov', () => {
  const r = inferMediaType('IMG_5678.MOV', 'application/octet-stream', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'video', mimetype: 'video/quicktime' });
});

test('inferMediaType — video/quicktime valid de la browser, folosit direct', () => {
  const r = inferMediaType('clip.mov', 'video/quicktime', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'video', mimetype: 'video/quicktime' });
});

test('inferMediaType — DNG (Apple ProRAW) cu mimetype generic -> fallback pe extensie .dng', () => {
  const r = inferMediaType('IMG_9999.dng', 'application/octet-stream', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'photo', mimetype: 'image/x-adobe-dng' });
});

test('inferMediaType — DNG cu mimetype real trimis de browser, folosit direct (fara fallback)', () => {
  const r = inferMediaType('poza.DNG', 'image/x-adobe-dng', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'photo', mimetype: 'image/x-adobe-dng' });
});

test('inferMediaType — nume cu mai multe puncte, extensia reala e ultima', () => {
  const r = inferMediaType('vacanta.2026.iulie.mp4', '', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'video', mimetype: 'video/mp4' });
});

test('inferMediaType — nici mimetype, nici extensie recunoscute -> null (respins), nu o presupunere', () => {
  assert.equal(inferMediaType('document.pdf', 'application/pdf', PHOTO_MIMES, VIDEO_MIMES), null);
  assert.equal(inferMediaType('fara-extensie', '', PHOTO_MIMES, VIDEO_MIMES), null);
});

test('inferMediaType — mimetype-ul brut are prioritate fata de o extensie contradictorie', () => {
  // fisier declarat explicit video/mp4 de catre browser, cu o extensie derutanta — avem
  // incredere in mimetype-ul valid, nu incercam sa "corectam" ceva ce nu e stricat.
  const r = inferMediaType('export.jpg', 'video/mp4', PHOTO_MIMES, VIDEO_MIMES);
  assert.deepEqual(r, { type: 'video', mimetype: 'video/mp4' });
});
