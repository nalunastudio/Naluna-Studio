// lib/preview-selection.js
// SMART PREVIEW (2026-09-22) — selectia determinista a punctului de start al preview-ului
// gratuit, dintr-un set de candidati REALI derivati din structura melodiei (deriveSectionTimings,
// lib/media-analysis.js) si din liniile cantate reale (buildCaptionLines, server.js — trecute
// aici ca date, NU importate, ca sa nu atingem functia folosita azi de caption-urile video).
//
// Logica PURA (fara I/O, fara retea, fara ffmpeg) — testabila izolat, acelasi principiu ca
// lib/media-analysis.js/lib/social/social-retry.js. NU introduce niciun furnizor extern, niciun
// AI/API nou — STRICT semnale deja disponibile din alignedWords (Suno, get-timestamped-lyrics,
// deja cerut o singura data de server.js), din analiza audio locala existenta (extractAudioOnsets/
// detectOnsets) si din campurile comenzii (recipient/story).
//
// GARANTIE DE SIGURANTA: aceasta functie NU ARUNCA NICIODATA in afara — orice date lipsa/
// neasteptate produc un fallback controlat (vezi selectPreviewStart), niciodata o exceptie care
// ar putea bloca generarea comenzii.

const { deriveSectionTimings } = require('./media-analysis');

// ==========================================================================================
// PONDERI — CONSERVATOARE, documentate, usor de ajustat ulterior pe baza datelor reale de
// conversie (nu pretind a fi optimizate statistic). Ordinea de prioritate ceruta explicit:
// PERSONALIZARE REALA (nume+poveste) > CONTINUT VOCAL > STRUCTURA > ENERGIE — reflectata direct
// in marimea relativa a ponderilor de mai jos (numele singur poate depasi orice combinatie de
// structura+energie; o poveste bine reprezentata poate rivaliza sau depasi numele).
// ==========================================================================================
const WEIGHTS = {
  name: 3,                 // bonus FIX (boolean) — prezenta numelui, nu repetitia lui
  storyTokenEach: 0.5,      // per token distinctiv din poveste, gasit in fereastra
  storyTokenMaxMatches: 4,  // plafon — o fereastra foarte lunga nu trebuie sa castige doar acoperind mecanic mai mult text
  vocalDensity: 1.5,        // normalizat [0,1]
  structureChorus: 1.0,
  structurePreChorus: 0.6,
  energy: 0.75,             // normalizat [0,1] — STRICT secundar, nu poate depasi numele (3) sau o poveste bine reprezentata
  introOutroPenalty: 2.0    // per fractie de suprapunere [0,1] cu intro/leading_gap/outro
};

const STRUCTURE_BONUS_BY_TYPE = {
  chorus: WEIGHTS.structureChorus,
  pre_chorus: WEIGHTS.structurePreChorus
};

// Vocal onset "tinta" — un vers cantat normal, obisnuit, in limba engleza, are in jur de 2
// cuvinte/secunda (aproximare deliberat conservatoare — nu pretinde precizie muzicologica).
const TARGET_WORDS_PER_SECOND = 2;

// Cat de departe (secunde) cauta snapToLineStart() o linie cantata reala, inainte sa renunte si
// sa foloseasca punctul brut (nesnapped) — mica, deliberat: nu vrem sa mutam candidatul prea
// departe de intentia lui structurala (inceputul unei sectiuni) doar ca sa gaseasca o linie.
const SNAP_TOLERANCE_SECONDS = 3;

// Doi candidati mai aproape de atat unul de celalalt sunt considerati acelasi punct — evita
// scorarea redundanta a unor ferestre practic identice (ex. vocal-onset si inceputul primului
// vers cad adesea foarte aproape).
const CANDIDATE_DEDUPE_SECONDS = 1.5;

// Token de poveste "distinctiv": numeric (an, varsta, data) INTOTDEAUNA; altfel lungime minima
// (dupa normalizare) SAU capitalizat undeva in mijlocul textului (semnal slab de nume propriu,
// niciodata primul cuvant al povestii, care e mereu capitalizat gramatical indiferent de sens).
const MIN_STORY_TOKEN_LENGTH = 4;
const MAX_STORY_TOKENS = 20; // plafon superior de procesare, pentru povesti foarte lungi

// ==========================================================================================
// NORMALIZARE TEXT — Unicode-safe, tolerant la diacritice si punctuatie, case-insensitive.
// NFKD + eliminarea marcajelor combinate (diacritice) inseamna ca "Ștefan"/"Stefan",
// "über"/"uber", variante cu/fara diacritice se compara egal — cerinta explicita de tolerant.
// LIMITARE CUNOSCUTA (documentata, acceptata): "İstanbul" (I turcesc cu punct) se normalizeaza
// la "istanbul" (i latin obisnuit), nu la "ıstanbul" (i turcesc fara punct) — regula completa
// de case-folding turceasca (ECMA-402 toLocaleLowerCase('tr')) ar rezolva asta, dar pentru un
// sistem de BONUS (nu o poarta stricta de acces), tolerant > perfect aici.
// NOTA tehnica: clasa de caractere de mai jos contine literal intervalul U+0300-U+036F (marcaje
// diacritice combinate Unicode) — verificat direct, comportament identic cu ̀-ͯ
// (testat pe RO/DE/BG/TR: "Ștefan"->"stefan", "über"->"uber", "Мария"->"мария" neschimbat,
// "İstanbul"->"istanbul").
// ==========================================================================================
function normalizeForMatch(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Tokenizare Unicode-safe: litere+cifre din ORICE script (Latin extins, chirilic bulgar,
// caractere turcesti) — \p{L}/\p{N} cu flag-ul 'u', nu un regex ASCII-only.
function tokenizeRaw(text) {
  return String(text || '').match(/[\p{L}\p{N}]+/gu) || [];
}

function tokenize(text) {
  return tokenizeRaw(text).map(normalizeForMatch).filter(Boolean);
}

// ==========================================================================================
// STOPWORDS — liste COMPACTE (cuvinte de legatura foarte frecvente), STRICT date statice locale,
// niciun NLP extern, nicio biblioteca noua. Deja normalizate (fara diacritice, minuscule) ca sa
// se compare direct cu iesirea normalizeForMatch(). Scopul e prudent, nu exhaustiv — elimina
// cele mai comune cuvinte de legatura (articole/pronume/prepozitii/conjunctii), nu construieste
// un dictionar lingvistic complet.
// ==========================================================================================
const STOPWORDS_BY_LANG = {
  ro: new Set(['si', 'sau', 'dar', 'la', 'cu', 'de', 'din', 'pe', 'in', 'un', 'o', 'ai', 'am', 'are', 'este', 'sunt', 'ca', 'ce', 'nu', 'da', 'mai', 'prea', 'atat', 'acest', 'aceasta', 'acesta', 'aceea', 'acel', 'acea', 'care', 'cine', 'cum', 'unde', 'cand', 'pentru', 'fara', 'prin', 'catre', 'spre', 'langa', 'sub', 'peste', 'intre', 'dupa', 'inainte', 'atunci', 'acum', 'aici', 'acolo', 'eu', 'tu', 'el', 'ea', 'noi', 'voi', 'ei', 'ele', 'mi', 'ti', 'ii', 'se', 'sa', 'va', 'ma', 'te', 'ne', 'te', 'lui', 'ei']),
  en: new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'me', 'him', 'them', 'us', 'not', 'no', 'so', 'as', 'if', 'then', 'than', 'too', 'very', 'just', 'do', 'does', 'did', 'have', 'has', 'had']),
  de: new Set(['der', 'die', 'das', 'und', 'oder', 'aber', 'von', 'zu', 'in', 'an', 'auf', 'fur', 'mit', 'bei', 'ist', 'sind', 'war', 'waren', 'sein', 'dieser', 'diese', 'dieses', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mein', 'dein', 'unser', 'euer', 'mich', 'dich', 'ihn', 'uns', 'euch', 'nicht', 'kein', 'so', 'als', 'wenn', 'dann', 'auch', 'sehr', 'nur', 'nach', 'vor', 'uber', 'unter', 'zwischen']),
  es: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'y', 'o', 'pero', 'de', 'a', 'en', 'por', 'para', 'con', 'es', 'son', 'era', 'eran', 'ser', 'este', 'esta', 'estos', 'estas', 'yo', 'tu', 'el', 'ella', 'nosotros', 'vosotros', 'ellos', 'ellas', 'mi', 'su', 'nuestro', 'vuestro', 'me', 'te', 'lo', 'no', 'si', 'muy', 'mas', 'tan', 'cuando', 'donde', 'que', 'quien', 'como']),
  it: new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'e', 'o', 'ma', 'di', 'a', 'in', 'su', 'per', 'con', 'da', 'e', 'sono', 'era', 'erano', 'essere', 'questo', 'questa', 'questi', 'queste', 'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'tuo', 'suo', 'nostro', 'vostro', 'mi', 'ti', 'non', 'si', 'molto', 'piu', 'tanto', 'quando', 'dove', 'che', 'chi', 'come']),
  fr: new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'mais', 'de', 'a', 'en', 'sur', 'pour', 'avec', 'par', 'est', 'sont', 'etait', 'etaient', 'etre', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'mon', 'ton', 'son', 'notre', 'votre', 'leur', 'me', 'te', 'se', 'ne', 'pas', 'non', 'oui', 'tres', 'plus', 'trop', 'quand', 'ou', 'que', 'qui', 'comment']),
  bg: new Set(['и', 'или', 'но', 'на', 'за', 'в', 'с', 'от', 'до', 'при', 'е', 'са', 'беше', 'бяха', 'съм', 'си', 'този', 'тази', 'това', 'тези', 'аз', 'ти', 'той', 'тя', 'ние', 'вие', 'те', 'мой', 'твой', 'негов', 'неин', 'наш', 'ваш', 'техен', 'ме', 'го', 'я', 'не', 'да', 'много', 'повече', 'когато', 'къде', 'че', 'кой', 'как']),
  tr: new Set(['ve', 'veya', 'ama', 'bir', 'bu', 'şu', 'o', 'ile', 'için', 'gibi', 'de', 'da', 'mi', 'mı', 'mu', 'mü', 'ben', 'sen', 'biz', 'siz', 'onlar', 'benim', 'senin', 'onun', 'bizim', 'sizin', 'onların', 'değil', 'evet', 'hayır', 'çok', 'daha', 'nerede', 'ki', 'kim', 'nasıl', 'var', 'yok'].map(normalizeForMatch))
};
// Fallback (limba lipsa/necunoscuta) — reuniunea celor mai comune conectori din toate cele 8,
// mica si sigura, niciodata folosita ca substitut complet al unei liste per-limba reale.
const STOPWORDS_FALLBACK = new Set([].concat(...Object.values(STOPWORDS_BY_LANG).map((s) => Array.from(s))));

function stopwordsFor(lang) {
  return STOPWORDS_BY_LANG[lang] || STOPWORDS_FALLBACK;
}

// ==========================================================================================
// NUME DESTINATAR — tokeni relevanti (fara conectori de tip "și"/"and", care ar aparea in
// aproape orice fereastra si ar face bonusul inutil pentru comenzile "Amândoi").
// ==========================================================================================
function buildNameTokens(recipient, lang) {
  const stopwords = stopwordsFor(lang);
  const tokens = [];
  for (const raw of tokenizeRaw(recipient)) {
    const normalized = normalizeForMatch(raw);
    if (!normalized || normalized.length < 2) continue;
    if (stopwords.has(normalized)) continue;
    tokens.push(normalized);
  }
  return tokens;
}

// ==========================================================================================
// POVESTE — tokeni "distinctivi": numerele (ani/varste/date) intotdeauna; altfel cuvinte destul
// de lungi SAU capitalizate in mijlocul textului (semnal slab de nume propriu/loc — niciodata
// primul cuvant, mereu capitalizat gramatical indiferent de continut). NU foloseste NLP extern —
// STRICT stopwords + lungime + capitalizare, verificat generic pe orice script cu majuscule
// (comparatie caracter cu forma lui minuscula, functioneaza identic pentru Latin/chirilic).
// ==========================================================================================
function isCapitalizedToken(raw) {
  const first = raw.charAt(0);
  if (!first) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

function extractDistinctiveStoryTokens(story, lang) {
  const text = String(story || '').trim();
  if (!text) return [];
  const stopwords = stopwordsFor(lang);
  const rawTokens = tokenizeRaw(text);
  const seen = new Set();
  const distinctive = [];
  rawTokens.forEach((raw, idx) => {
    const normalized = normalizeForMatch(raw);
    if (!normalized || seen.has(normalized)) return;
    if (stopwords.has(normalized)) return;
    const isNumeric = /^[0-9]+$/.test(normalized);
    const isDistinctiveShape = isNumeric || normalized.length >= MIN_STORY_TOKEN_LENGTH || (idx > 0 && isCapitalizedToken(raw));
    if (!isDistinctiveShape) return;
    seen.add(normalized);
    distinctive.push(normalized);
  });
  return distinctive.slice(0, MAX_STORY_TOKENS);
}

// ==========================================================================================
// FEREASTRA DE TIMP — cuvinte reale (success:true) in [windowStart, windowEnd), text curatat de
// etichete structurale ([Chorus] etc., pot fi concatenate de Suno cu primul cuvant al liniei).
// ==========================================================================================
function stripBracketTags(word) {
  return String(word || '').replace(/\[[^[\]]*\]/g, '');
}

function wordsInWindow(alignedWords, windowStart, windowEnd) {
  return (alignedWords || []).filter((w) => w && w.success === true && typeof w.startS === 'number' && Number.isFinite(w.startS) && w.startS >= windowStart && w.startS < windowEnd);
}

function windowTokenSet(alignedWords, windowStart, windowEnd) {
  const set = new Set();
  for (const w of wordsInWindow(alignedWords, windowStart, windowEnd)) {
    for (const t of tokenize(stripBracketTags(w.word))) set.add(t);
  }
  return set;
}

// ==========================================================================================
// SEMNALE INDIVIDUALE
// ==========================================================================================
function vocalDensitySignal(alignedWords, windowStart, windowEnd) {
  const words = wordsInWindow(alignedWords, windowStart, windowEnd);
  const durationS = Math.max(0.001, windowEnd - windowStart);
  const wordsPerSecond = words.length / durationS;
  return Math.min(1, wordsPerSecond / TARGET_WORDS_PER_SECOND);
}

// onsets: lista de momente (secunde, in cantecul INTREG) — vezi extractAudioOnsets/detectOnsets,
// server.js/lib/media-analysis.js. Normalizat relativ la densitatea MEDIE a intregului cantec —
// o fereastra cu densitate de impulsuri DE 2X mai mare decat media cantecului primeste scorul
// maxim (1.0); fara onsets deloc (analiza indisponibila/esuata), semnalul e neutru (0), niciodata
// o eroare.
const ENERGY_NORMALIZATION_RATIO = 2;
function energySignal(onsets, windowStart, windowEnd, durationSeconds) {
  if (!Array.isArray(onsets) || onsets.length === 0 || !(durationSeconds > 0)) return 0;
  const windowDur = Math.max(0.001, windowEnd - windowStart);
  const inWindow = onsets.filter((t) => typeof t === 'number' && t >= windowStart && t < windowEnd).length;
  const windowRate = inWindow / windowDur;
  const songRate = onsets.length / durationSeconds;
  if (songRate <= 0) return 0;
  return Math.min(1, (windowRate / songRate) / ENERGY_NORMALIZATION_RATIO);
}

function structuralBonusForAnchor(anchorType) {
  return STRUCTURE_BONUS_BY_TYPE[anchorType] || 0;
}

// Fractia din fereastra care se suprapune cu sectiuni de tip intro/leading_gap/outro (STRICT
// 'aligned' — niciodata fallback_equal, care nu e o granita reala) — penalizeaza, NU interzice:
// o fereastra care are nevoie de putin context dintr-un intro scurt tot poate castiga daca restul
// semnalelor ei sunt suficient de puternice.
function introOutroOverlapFraction(sectionTimings, windowStart, windowEnd) {
  let overlap = 0;
  for (const s of (sectionTimings || [])) {
    if (!s || s.alignmentStatus !== 'aligned') continue;
    if (s.sectionType !== 'intro' && s.sectionType !== 'leading_gap' && s.sectionType !== 'outro') continue;
    const start = Math.max(windowStart, s.startTime);
    const end = Math.min(windowEnd, s.endTime);
    if (end > start) overlap += (end - start);
  }
  const windowDur = Math.max(0.001, windowEnd - windowStart);
  return Math.min(1, overlap / windowDur);
}

// ==========================================================================================
// CANDIDATI — ancore din sectiunile reale (chorus/pre_chorus/verse/bridge — NICIODATA
// intro/leading_gap/outro ca punct de PORNIRE propus, desi raman evaluabile prin overlap daca o
// fereastra ajunge sa le atinga la margine) + candidatul curent bazat pe vocal-onset (garantat
// prezent, sursa lui de adevar e neschimbata fata de mecanismul actual).
// ==========================================================================================
function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// Muta un candidat la inceputul celei mai apropiate linii REAL cantate (buildCaptionLines),
// daca exista una suficient de aproape (SNAP_TOLERANCE_SECONDS) — evita sa inceapa preview-ul
// la mijlocul unui cuvant/unei idei. Fara linii disponibile, sau fara una suficient de aproape,
// pastreaza punctul brut (tot un punct valid, doar mai putin "perfect aliniat").
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

function buildCandidates({ sectionTimings, captionLines, vocalOnsetStartSeconds, durationSeconds, previewMaxSeconds }) {
  const maxStart = Math.max(0, durationSeconds - previewMaxSeconds);
  const raw = [];
  if (typeof vocalOnsetStartSeconds === 'number' && Number.isFinite(vocalOnsetStartSeconds)) {
    raw.push({ startTime: vocalOnsetStartSeconds, anchorType: 'vocal_onset' });
  }
  for (const s of (sectionTimings || [])) {
    if (!s || s.alignmentStatus !== 'aligned') continue;
    if (s.sectionType === 'intro' || s.sectionType === 'leading_gap' || s.sectionType === 'outro') continue;
    if (typeof s.startTime !== 'number' || !Number.isFinite(s.startTime)) continue;
    raw.push({ startTime: s.startTime, anchorType: s.sectionType });
  }

  const snapped = raw
    .map((c) => ({ ...c, startTime: snapToLineStart(clamp(c.startTime, 0, maxStart), captionLines, maxStart) }))
    .sort((a, b) => a.startTime - b.startTime);

  const deduped = [];
  for (const c of snapped) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(c.startTime - prev.startTime) < CANDIDATE_DEDUPE_SECONDS) continue;
    deduped.push(c);
  }
  return deduped;
}

// ==========================================================================================
// SCOR — combina toate semnalele intr-un singur numar, comparabil intre candidati. A se vedea
// WEIGHTS mai sus pentru ponderile exacte si ordinea de prioritate ceruta (personalizare >
// continut vocal > structura > energie).
// ==========================================================================================
function scoreCandidate(candidate, ctx) {
  const { alignedWords, sectionTimings, onsets, durationSeconds, previewMaxSeconds, nameTokens, storyTokens } = ctx;
  const windowStart = candidate.startTime;
  const windowEnd = Math.min(durationSeconds, windowStart + previewMaxSeconds);
  const tokens = windowTokenSet(alignedWords, windowStart, windowEnd);

  const nameMatch = nameTokens.length > 0 && nameTokens.some((t) => tokens.has(t));
  const storyTokenMatches = Math.min(storyTokens.filter((t) => tokens.has(t)).length, WEIGHTS.storyTokenMaxMatches);
  const structureBonus = structuralBonusForAnchor(candidate.anchorType);
  const vocalDensity = vocalDensitySignal(alignedWords, windowStart, windowEnd);
  const energy = energySignal(onsets, windowStart, windowEnd, durationSeconds);
  const introOutroOverlap = introOutroOverlapFraction(sectionTimings, windowStart, windowEnd);

  const score = (nameMatch ? WEIGHTS.name : 0)
    + storyTokenMatches * WEIGHTS.storyTokenEach
    + structureBonus
    + vocalDensity * WEIGHTS.vocalDensity
    + energy * WEIGHTS.energy
    - introOutroOverlap * WEIGHTS.introOutroPenalty;

  return {
    startTime: windowStart,
    anchorType: candidate.anchorType,
    score,
    // Semnale de debugging/audit — STRICT numere/booleene/enum-uri, NICIODATA text brut
    // (fara story, fara versuri, fara nume) — sigur de persistat/logat.
    signals: {
      anchorType: candidate.anchorType,
      nameMatch,
      storyTokenMatches,
      structureBonus,
      vocalDensity: Number(vocalDensity.toFixed(3)),
      energy: Number(energy.toFixed(3)),
      introOutroOverlap: Number(introOutroOverlap.toFixed(3)),
      score: Number(score.toFixed(3))
    }
  };
}

// ==========================================================================================
// PUNCT DE INTRARE PRINCIPAL
//
// Fallback in 3 trepte, NICIODATA o exceptie in afara (try/catch acopera tot ce ar putea esua
// neasteptat — deriveSectionTimings, scorarea):
//   1. smart_score          — scorarea a rulat complet, un castigator a fost ales pe merit.
//   2. vocal_onset_fallback — date insuficiente/eroare in timpul scorarii, dar vocal-onset
//                             (mecanismul actual, calculat de apelant din alignedWords) exista.
//   3. start_zero_fallback  — nici vocal-onset nu e disponibil — previewStart = 0, comportamentul
//                             de dinainte de orice optimizare.
//
// `vocalOnsetStartSeconds` e STRICT calculat de apelant (server.js), reutilizand functiile PURE
// deja existente si NEATINSE (findFirstRealWordStartS + constantele TARGET_VOICE_POSITION_S/
// PREVIEW_START_MAX_S) — acest modul nu duplica acel algoritm, il primeste ca semnal/candidat.
// `captionLines` e STRICT iesirea buildCaptionLines(alignedWords) (server.js, neatinsa) — trecuta
// aici ca date, ca sa nu importam/modificam acea functie (folosita si de caption-urile video).
// ==========================================================================================
function selectPreviewStart({ alignedWords, captionLines, durationSeconds, previewMaxSeconds, vocalOnsetStartSeconds, onsets, recipient, story, lang }) {
  if (typeof vocalOnsetStartSeconds !== 'number' || !Number.isFinite(vocalOnsetStartSeconds)) {
    return { previewStartSeconds: 0, selectionReason: 'start_zero_fallback', signals: null };
  }
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
  if (typeof previewMaxSeconds !== 'number' || !Number.isFinite(previewMaxSeconds) || previewMaxSeconds <= 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
  // alignedWords lipsa/goale: nu exista NIMIC de scorat (niciun cuvant, nicio sectiune reala) —
  // eticheta corecta e vocal_onset_fallback (nicio analiza reala nu a avut loc), niciodata
  // smart_score, chiar daca rezultatul NUMERIC ar fi coincis oricum cu vocalOnsetStartSeconds.
  if (!Array.isArray(alignedWords) || alignedWords.length === 0) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }

  try {
    const sectionTimings = deriveSectionTimings(Array.isArray(alignedWords) ? alignedWords : [], durationSeconds, null);
    const candidates = buildCandidates({
      sectionTimings,
      captionLines: Array.isArray(captionLines) ? captionLines : [],
      vocalOnsetStartSeconds,
      durationSeconds,
      previewMaxSeconds
    });
    if (candidates.length === 0) {
      return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
    }

    const nameTokens = buildNameTokens(recipient, lang);
    const storyTokens = extractDistinctiveStoryTokens(story, lang);
    const ctx = {
      alignedWords: Array.isArray(alignedWords) ? alignedWords : [],
      sectionTimings,
      onsets: Array.isArray(onsets) ? onsets : [],
      durationSeconds,
      previewMaxSeconds,
      nameTokens,
      storyTokens
    };

    const scored = candidates.map((c) => scoreCandidate(c, ctx));
    let winner = scored[0];
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].score > winner.score) winner = scored[i];
    }
    return { previewStartSeconds: winner.startTime, selectionReason: 'smart_score', signals: winner.signals };
  } catch (err) {
    return { previewStartSeconds: vocalOnsetStartSeconds, selectionReason: 'vocal_onset_fallback', signals: null };
  }
}

module.exports = {
  WEIGHTS,
  normalizeForMatch,
  tokenize,
  buildNameTokens,
  extractDistinctiveStoryTokens,
  snapToLineStart,
  buildCandidates,
  scoreCandidate,
  selectPreviewStart,
  STOPWORDS_BY_LANG
};
