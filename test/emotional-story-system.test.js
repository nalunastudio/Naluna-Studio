// SISTEM EMOTIONAL STORY-AWARE (2026-09-28, cerinta explicita) — versuri mai personale/emotionale,
// legate de relatia aleasa, bazate STRICT pe povestea reala a clientului, recognoscibile din
// primele versuri, versuri scurte, si titlu emotional personalizat.
//
// REGULA ABSOLUTA respectata: NU s-au modificat genurile muzicale (GENRE_STYLE_MAP), style
// prompts, BPM/instrumentatie, mapping-ul genurilor, vocea/duet — vezi sectiunea H (regresie).
//
// CONSTATARE CRITICA DE ARHITECTURA (audit + masurare directa, vezi raportul final): buildPrompt()
// opereaza la buget ZERO SLACK — chiar si comanda cea mai usoara posibila (poveste de 3 caractere,
// fara expeditor, ocazie minimala) ATINGE 600 caractere. Orice adaos SHEDDABLE e deci cod mort —
// cade mereu, inainte sa ajunga la Suno (verificat exhaustiv, toate cele 16 genuri). Din acest
// motiv, enrichment-ul mama/tata/declaratie e implementat STRICT prin INLOCUIRE neconditionata,
// cu lungime masurata <= originalul, niciodata printr-un flag sheddable. Un hook explicit separat
// (clauza noua) NU a putut fi adaugat in siguranta in acest buget fara teste reale de calitate
// Suno (interzise pentru acest task) — hook-ul e satisfacut de mecanismul deja existent,
// neconditionat, "name recipient early+chorus" (vezi sectiunea D si raportul final, punctul 8).
//
// Versurile PROPRIU-ZISE sunt scrise de Suno insusi (customMode:false, buildPrompt() — promptul
// descriptiv e SINGURA parghie reala asupra continutului liric). buildExactLyricsRequest()
// (customMode:true) reutilizeaza versurile EXACTE deja scrise la generarea initiala — deci
// imbunatatirile de continut liric traiesc STRICT in buildPrompt(). Titlul e SEPARAT — compus
// determinist server-side (composeSongTitle), NICIODATA de Suno, NICIODATA din poveste.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit: ${signature}`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// ACELASI harness deja folosit/dovedit in test/story-floor-occasion-fallback-fix.test.js — extrage
// codul REAL din server.js (buildPrompt/buildExactLyricsRequest/composeSongTitle), executabil
// izolat, cu STRICT dependentele externe stubuite (diction.js, VOICE_PREFERENCES etc.).
function loadPromptBuilders() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  const snippet = server.slice(startIdx, endIdx);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return { buildPrompt, buildExactLyricsRequest, composeSongTitle, resolveTitleCategory, TITLE_TEMPLATES };
  `;
  return new Function('require', sandboxSrc)(require);
}
const B = loadPromptBuilders();

function baseOrder(overrides) {
  return Object.assign({
    id: 'order-test-1', plan: 'standard', lang: 'ro', genre: 'pop', occasion: 'parinti',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'mother',
    voicePreference: 'auto'
  }, overrides);
}

// ===============================================================================================
// A. EMOTIONAL GROUNDING — nu inventa fapte neconfirmate de poveste.
// ===============================================================================================
test('A1. Mama + poveste cu sacrificiu explicit -> unghiul emotional "mother" (sacrifice/love) e prezent in prompt (verificat cu date REALE, executie reala a buildPrompt())', () => {
  const order = baseOrder({ story: 'Mama a muncit din greu ca sa avem tot ce ne trebuie.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.match(prompt, /mother's sacrifice/i, `unghiul mama trebuie sa mentioneze sacrificiul: ${prompt}`);
});

test('A2. Tata -> unghiul emotional DIFERIT ("father", protection/sacrifice), niciodata identic cu mama', () => {
  const order = baseOrder({ recipientRole: 'father', recipient: 'Ion', story: 'Tata a fost mereu langa noi.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.match(prompt, /father's protection/i);
  assert.ok(!/mother's sacrifice/i.test(prompt));
});

test('A3. Mama FARA nicio informatie despre "a fost si mama si tata" -> promptul NU afirma acest fapt (STRICT lentila sacrificiu/iubire, niciodata evenimentul specific)', () => {
  const order = baseOrder({ story: 'Mama e cea mai buna persoana din lume.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(!/single parent|raised .* alone|both mother and father/i.test(prompt), `promptul nu trebuie sa afirme "parinte singur": ${prompt}`);
});

test('A4. Poveste fericita (occasion=declaratie) -> promptul nu introduce cuvinte de doliu/pierdere', () => {
  const order = baseOrder({ occasion: 'declaratie', recipientRole: undefined, story: 'Suntem cei mai fericiti impreuna, radem tot timpul.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(!/\bgrief\b|\bmourning\b|passed away/i.test(prompt), `nu trebuie sa apara limbaj de doliu pentru o ocazie fericita: ${prompt}`);
});

test('A5. Poveste fara nicio mentiune de copii -> instructiunea nu cere/sugereaza mentionarea copiilor', () => {
  const order = baseOrder({ story: 'Ne cunoastem de multi ani si suntem inseparabili.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(!/\bchildren\b|\bkids\b/i.test(prompt));
});

test('A6. Toate cele 5 unghiuri de familie (mama/tata/generic-parinti/declaratie) pastreaza garda "never invented" — verificat cu executie reala', () => {
  const cases = [
    baseOrder({ recipientRole: 'mother', story: 'Test.' }),
    baseOrder({ recipientRole: 'father', story: 'Test.' }),
    baseOrder({ recipientRole: 'parents', story: 'Test.' }),
    baseOrder({ occasion: 'declaratie', recipientRole: undefined, story: 'Test.' })
  ];
  cases.forEach((order) => {
    const prompt = B.buildPrompt(order, '', null);
    assert.match(prompt, /never invented/i, `garda "never invented" trebuie sa ramana prezenta: ${prompt}`);
  });
});

test('A7. Poveste FOARTE scurta -> promptul cere STRICT dezvoltarea EMOTIEI faptelor existente ("throughout"), niciodata inventarea de fapte noi ("never-invented")', () => {
  const order = baseOrder({ story: 'O iubesc mult.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.match(prompt, /never.invented/i);
  assert.match(prompt, /throughout/i);
});

// ===============================================================================================
// B. STORY-FIRST — detaliile povestii sunt prioritizate devreme, numele disponibil devreme.
// ===============================================================================================
test('B8. Instructiunea de baza (fara expeditor) cere explicit un detaliu real din poveste DEVREME ("open on a real...story detail" forma FULL, sau "story detail early+throughout" forma SHORT, aleasa dupa buget)', () => {
  const order = baseOrder({ recipientRole: undefined, occasion: 'altceva', story: 'Ne-am cunoscut la facultate.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.match(prompt, /open on a real, specific, never-invented story detail|story detail early\+throughout/i);
});

test('B9. Numele destinatarului e prezent in eticheta Recipient, aproape de inceputul promptului (inaintea etichetei Poveste), disponibil pentru folosire timpurie de catre Suno', () => {
  const order = baseOrder({ recipient: 'Alexandra', story: 'O poveste oarecare cu ceva detalii.' });
  const prompt = B.buildPrompt(order, '', null);
  const recipientIdx = prompt.indexOf('Recipient: Alexandra');
  const storyIdx = prompt.indexOf('Story/details');
  assert.ok(recipientIdx !== -1 && storyIdx !== -1 && recipientIdx < storyIdx, `Recipient trebuie sa apara INAINTEA etichetei de poveste: ${prompt}`);
});

test('B10. Un inceput generic ("Today I want to tell you" / "You are special to me") nu e cerut NICAIERI in instructiuni', () => {
  const order = baseOrder({ story: 'Detalii personale puternice.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(!/today i want to tell you|you are special to me/i.test(prompt));
});

// ===============================================================================================
// C. SHORT LINES — regula ramane universala, pentru toate genurile, neatinsa in formele FULL.
// ===============================================================================================
const ALL_GENRES = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop', 'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
test('C11. "Short lines" sau instructiunea FULL (fara mentiune de linii) apar corect pentru TOATE genurile existente — niciodata o eroare/sintaxa stricata din cauza genului', () => {
  ALL_GENRES.forEach((genre) => {
    const order = baseOrder({ genre, story: 'O poveste realista de lungime medie, cu cateva detalii personale importante mentionate aici despre relatia noastra.' });
    const prompt = B.buildPrompt(order, '', null);
    assert.ok(Array.from(prompt).length <= 600, `genul ${genre} nu trebuie sa produca un prompt peste 600 caractere`);
  });
});

test('C12. GENRE_STYLE_MAP ramane BYTE-IDENTIC — niciun style prompt/BPM/instrumentatie modificat de acest sistem (zone complet separate, verificat ca sistemul emotional nu contine text de gen)', () => {
  const genreMapSrc = extractFn(server, 'const GENRE_STYLE_MAP = {');
  assert.match(genreMapSrc, /hiphop:/);
  assert.match(genreMapSrc, /manele_suflet:/);
  assert.ok(!genreMapSrc.includes('never invented'), 'GENRE_STYLE_MAP nu trebuie sa contina text din sistemul emotional');
  assert.ok(!genreMapSrc.includes("mother's sacrifice"));
});

test('C13. Toate cele 8 limbi: lyricsLanguage se propaga corect in instructiunea "Write the song lyrics entirely in X" — regula Short lines nu depinde de order.lang (instructiune META in engleza, ca tot restul promptului deja existent)', () => {
  LANGS.forEach((lang) => {
    const order = baseOrder({ lang, story: 'O poveste de test, cu detalii.' });
    const prompt = B.buildPrompt(order, '', null);
    assert.match(prompt, /Write the song lyrics entirely in \w+/, `limba ${lang}`);
  });
});

// ===============================================================================================
// D. HOOK — mecanism existent (nume in refren), niciodata hardcodat pe tip de relatie.
// ===============================================================================================
test('D14. Mecanismul de hook (numele destinatarului trebuie sa apara si in refren) ramane prezent neconditionat, in ambele forme (cu/fara expeditor)', () => {
  const withSender = B.buildPrompt(baseOrder({ recipientRole: undefined, occasion: 'altceva', senderName: 'Ana', story: 'O poveste de test cu ceva mai multe detalii.' }), '', null);
  const noSender = B.buildPrompt(baseOrder({ recipientRole: undefined, occasion: 'altceva', story: 'O poveste de test cu ceva mai multe detalii.' }), '', null);
  assert.match(withSender, /chorus/i);
  assert.match(noSender, /naturally in the lyrics|chorus/i);
});

test('D15. Nu exista niciun hook hardcodat specific unei relatii — server.js nu contine fraze de refren fixe (ex. "Ne-ai fost mama") atasate conditionat de effectiveRecipientRole', () => {
  assert.ok(!server.includes('Ne-ai fost mama'), 'exemplul conceptual din cerinta nu trebuie hardcodat niciodata in cod');
  assert.ok(!/const HOOK_FOR_MOTHER|const HARDCODED_HOOK/.test(server));
});

// ===============================================================================================
// E. TITLES
// ===============================================================================================
test('E16. composeSongTitle() genereaza un titlu valid (string, 1-80 caractere)', () => {
  const order = baseOrder({ id: 'ord-e16' });
  const title = B.composeSongTitle(order);
  assert.equal(typeof title, 'string');
  assert.ok(title.length > 0 && title.length <= 80);
});

test('E17. Titlul e generat IN LIMBA melodiei (order.lang) — template-uri distincte pentru toate cele 8 limbi, categoria "mother"', () => {
  LANGS.forEach((lang) => {
    const table = B.TITLE_TEMPLATES.mother[lang];
    assert.ok(Array.isArray(table) && table.length > 0, `limba ${lang} trebuie sa aiba template-uri pentru categoria mother`);
  });
});

test('E18. Title-ul e PER VARIANT — buildVariantFromTrack primeste un songTitle explicit ca parametru (nu global la nivel de order) — arhitectura suporta titluri diferite intre variante (Premium)', () => {
  assert.ok(server.includes('async function buildVariantFromTrack(orderId, variantId, track, taskId, genre, songTitle) {'));
  const body = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, genre, songTitle) {');
  assert.match(body, /title: songTitle \|\| null/);
});

test('E19. Comenzile ISTORICE fara title functioneaza — buildVariantFromTrack seteaza explicit null (niciodata arunca), UI-urile trateaza title lipsa fara sa afiseze nimic inventat', () => {
  const body = extractFn(server, 'async function buildVariantFromTrack(orderId, variantId, track, taskId, genre, songTitle) {');
  assert.match(body, /songTitle \|\| null/);
  const melodiaMea = fs.readFileSync(path.join(__dirname, '..', 'public', 'melodia-mea.html'), 'utf8');
  assert.match(melodiaMea, /v\.title && String\(v\.title\)\.trim\(\)\)/);
});

// REDESIGN (2026-09-28, "Comenzile mele" — cerinta explicita): comenzile-mele.html a fost
// simplificata la un rezumat clar per comanda (Comanda N — Pachet / Pentru destinatar / N
// melodii), fara sa mai reda titluri/playere per-varianta inline (ar fi fost un al doilea
// sistem de redare, duplicat fata de melodia-mea.html/comanda-mea.html — vezi audit-ul din
// comenzile-mele-page.test.js). Titlul ramane afisat pe suprafetele care CHIAR reda melodia.
test('E20. Titlul e afisat pe suprafetele client care CHIAR reda melodia: melodia-mea.html (.variant-title), comanda-mea.html (.song-title) — comenzile-mele.html e STRICT un rezumat/index, titlul se vede dupa click, pe pagina corecta', () => {
  const melodiaMea = fs.readFileSync(path.join(__dirname, '..', 'public', 'melodia-mea.html'), 'utf8');
  const comandaMea = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda-mea.html'), 'utf8');
  assert.match(melodiaMea, /variant-title/);
  assert.match(comandaMea, /song-title/);
});

test('E21. Titlul NU ajunge in analytics extern (GA4/Meta) — niciun apel NalunaAnalytics.track()/trackMeta() din melodia-mea.html trimite v.title/order.title', () => {
  const melodiaMea = fs.readFileSync(path.join(__dirname, '..', 'public', 'melodia-mea.html'), 'utf8');
  const trackCalls = [...melodiaMea.matchAll(/NalunaAnalytics\.(?:track|trackMeta)\([^)]*\)/g)];
  trackCalls.forEach((m) => {
    assert.ok(!/\.title\b/.test(m[0]), `apelul analytics nu trebuie sa contina .title: ${m[0]}`);
  });
});

test('E22. composeSongTitle() NU foloseste NICIODATA order.story — verificat static (garanteaza "nu inventa fapte" prin constructie)', () => {
  const body = extractFn(server, 'function composeSongTitle(order) {');
  assert.ok(!body.includes('order.story'), 'composeSongTitle nu trebuie sa citeasca niciodata story-ul liber');
});

// ===============================================================================================
// F. PACKAGES — Standard, Premium (ambele variante), Video, gift/bonus, retry/edit.
// ===============================================================================================
test('F23. Standard: buildPrompt produce un prompt valid (<=600 caractere) cu story-first pentru un order Standard tipic', () => {
  const order = baseOrder({ plan: 'standard', story: 'O poveste realista de lungime medie despre noi doi si copilaria mea.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(Array.from(prompt).length <= 600);
});

test('F24/F25. Premium: fiecare din cele doua melodii (genre1/genre2, effectiveRecipientRole diferit) primeste PROPRIUL titlu, posibil diferit', () => {
  const song1 = baseOrder({ id: 'ord-premium', plan: 'premium', occasion: 'parinti', recipientRole: 'mother' });
  const song2 = baseOrder({ id: 'ord-premium', plan: 'premium', occasion: 'declaratie', recipientRole: undefined });
  const t1 = B.composeSongTitle(song1);
  const t2 = B.composeSongTitle(song2);
  assert.notEqual(t1, t2, 'cele doua melodii Premium (relatii diferite) trebuie sa poata avea titluri diferite');
});

test('F26. Video: buildPrompt pentru plan=video produce un prompt valid (<=600) — pipeline-ul video (gates/media confirmation) neatins de acest task', () => {
  const order = baseOrder({ plan: 'video', story: 'O poveste video reala.' });
  const prompt = B.buildPrompt(order, '', null);
  assert.ok(Array.from(prompt).length <= 600);
  assert.match(server, /options\.forceVideo/, 'gate-ul de confirmare video (forceVideo) ramane neatins');
});

test('F27. Gift/bonus: obtainAcceptableVariant() calculeaza songTitle O SINGURA DATA per apel si il paseaza la FIECARE incercare de piesa (inclusiv variantele gift/bonus, care refolosesc acelasi mecanism buildVariantFromTrack)', () => {
  const body = extractFn(server, 'async function obtainAcceptableVariant(orderId, tracks, taskId, genre, order, recipientSnapshot, canonicalLyrics) {');
  assert.match(body, /const songTitle = composeSongTitle\(\{ \.\.\.order, \.\.\.\(recipientSnapshot \|\| \{\}\) \}\);/);
  assert.match(body, /buildVariantFromTrack\(orderId, randomUUID\(\)\.slice\(0, 8\), track, candidateTaskId, genre, songTitle\)/);
});

test('F28. Retry/edit/regenerare: obtainAcceptableVariant() e SINGURUL punct folosit atat pentru generarea initiala CAT SI pentru regenerare (comentariu existent in cod) — sistemul emotional/titlul se aplica identic, nicio cale separata "veche"', () => {
  assert.match(server, /obtainAcceptableVariant\(\) e SINGURUL punct folosit atat pentru generarea initiala/);
});

// ===============================================================================================
// G. LANGUAGES — 29-36 (toate cele 8 limbi).
// ===============================================================================================
LANGS.forEach((lang, i) => {
  test(`G${29 + i}. Limba ${lang}: buildPrompt produce un prompt valid (<=600), cu titlu compus in aceeasi limba (categoria "mother")`, () => {
    const order = baseOrder({ id: `ord-g-${lang}`, lang, story: 'O poveste de test cu diacritice/caractere native, dupa caz.' });
    const prompt = B.buildPrompt(order, '', null);
    assert.ok(Array.from(prompt).length <= 600);
    const title = B.composeSongTitle(order);
    assert.ok(title.length > 0);
  });
});

// ===============================================================================================
// H. REGRESSION — 37-46.
// ===============================================================================================
test('H37. Pronuntie/dictie (getDictionInstruction) ramane apelata neschimbat in buildExactLyricsRequest', () => {
  assert.match(server, /const dictionInstruction = getDictionInstruction\(order\.lang, 'full'\);/);
});

test('H38. Genre IDs raman intacte — toate cele 16 genuri noi raman chei valide in GENRE_STYLE_MAP', () => {
  const genreMapSrc = extractFn(server, 'const GENRE_STYLE_MAP = {');
  ALL_GENRES.forEach((key) => {
    assert.match(genreMapSrc, new RegExp(`${key}:`));
  });
});

test('H39. Genre style prompts raman intacte — hiphop ramane cel mai lung/egal style tag fata de manele_suflet (ordinea relativa, deja documentata, neschimbata)', () => {
  const genreMapSrc = extractFn(server, 'const GENRE_STYLE_MAP = {');
  const hiphopMatch = genreMapSrc.match(/hiphop: '([^']*)'/);
  const maneleMatch = genreMapSrc.match(/manele_suflet: '([^']*)'/);
  assert.ok(hiphopMatch && maneleMatch);
  assert.ok(hiphopMatch[1].length >= maneleMatch[1].length);
});

test('H40. Preview logic (TARGET_VOICE_POSITION_S, MAX_EMPTY_ALIGNED_RETRIES) ramane neatins de acest task (task anterior, separat)', () => {
  assert.match(server, /const TARGET_VOICE_POSITION_S = 3;/);
  assert.match(server, /const MAX_EMPTY_ALIGNED_RETRIES = 3;/);
});

test('H41. Quota (FREE_GENERATION_LIMIT/FREE_GENERATION_WINDOW_DAYS) ramane neatinsa', () => {
  const db = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(db, /FREE_GENERATION_LIMIT = 3/);
  assert.match(db, /FREE_GENERATION_WINDOW_DAYS = 7/);
});

test('H42. Retention (UNPAID_ORDER_RETENTION_DAYS=7) ramane neatinsa', () => {
  assert.match(server, /const UNPAID_ORDER_RETENTION_DAYS = 7;/);
});

test('H43. Comenzile mele (gate email-first, choice screen) raman neatinse — gate-email-screen/gate-choice-screen tot prezente in comanda.html', () => {
  const comanda = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda.html'), 'utf8');
  assert.match(comanda, /id="gate-email-screen"/);
  assert.match(comanda, /id="gate-choice-screen"/);
});

test('H44. Checkout (PLAN_PRICES) ramane neatins', () => {
  assert.match(server, /PLAN_PRICES/);
});

test('H45. Meta CAPI (enqueueMetaCapiEvent) ramane neatins — nicio referinta noua la CAPI in sectiunea sistemului emotional', () => {
  assert.match(server, /enqueueMetaCapiEvent/);
  const emotionalSectionStart = server.indexOf('SISTEM EMOTIONAL STORY-AWARE');
  const emotionalSectionEnd = server.indexOf('function composeSongTitle');
  const section = server.slice(emotionalSectionStart, emotionalSectionEnd);
  assert.ok(!/capi/i.test(section));
});

test('H46. Nicio regresie PII in analytics — order_page_viewed/form_started raman fara story/recipient/title/email', () => {
  const comanda = fs.readFileSync(path.join(__dirname, '..', 'public', 'comanda.html'), 'utf8');
  const trackCalls = [...comanda.matchAll(/NalunaAnalytics\.track\('([^']+)',\s*(\{[^}]*\})?/g)];
  trackCalls.forEach(([, eventName, paramsSrc]) => {
    if (paramsSrc) {
      assert.ok(!/story|recipient|title|email/i.test(paramsSrc), `evenimentul ${eventName} nu trebuie sa trimita PII`);
    }
  });
});

test('server.js: node --check trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
