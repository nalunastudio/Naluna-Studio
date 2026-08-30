// Teste pentru CORECȚIA 2026-08-30 (Cadou video, Cerința 1):
// (1) CTA-ul "Adaugă amintirile" foloseste acum o SINGURA regula centralizata de vizibilitate
//     (updateMemoriesCta in melodia-mea.html), bazata pe starea reala (plan, editor deschis,
//     alegere de varianta in asteptare, statusul videoclipului) — nicio alta functie nu mai
//     scrie direct pe #memories-cta.
// (2) Feedback-ul liber al clientului ("Mai veselă" etc.) primeste acum, STRICT pentru Video,
//     o formulare explicita de prioritate fata de stilul genului si, pentru cererile
//     recunoscute de "mai vesel/optimist", o clauza suplimentara care neutralizeaza descriptori
//     contradictorii (ex. "tearful climax"). Standard/Premium raman neschimbate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const server = read('server.js');
const melodia = read('public/melodia-mea.html');

function extractFn(source, signature) {
  assert.ok(signature.trim().endsWith('{'), `semnatura trebuie sa se termine cu "{": "${signature}"`);
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  // Pornim NUMARATOAREA de acolade chiar DUPA acolada finala a semnaturii insesi (nu cautam
  // primul "{" din tot textul de la idx incolo) — o semnatura cu parametru implicit gen
  // "options = {}" contine deja o pereche completa de acolade INAINTE de acolada reala de
  // deschidere a corpului functiei, care ar termina gresit numararea prematur.
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

// ===============================================================================================
// PARTEA 1 — CTA "Adaugă amintirile": regula centralizata, testata FUNCTIONAL (executata, nu doar
// cautata in text). Extragem updateMemoriesCta() verbatim din melodia-mea.html si o rulam
// intr-un sandbox minimal (stub pentru document.getElementById + menuExpanded/editingVariantId
// injectate ca variabile externe, exact rolul lor real in fisierul sursa).
// ===============================================================================================
function loadUpdateMemoriesCta() {
  const fnSrc = extractFn(melodia, 'function updateMemoriesCta(order, pendingVariantChoice) {');
  const sandboxSrc = `
    let menuExpanded = false;
    let editingVariantId = null;
    const ctaEl = { display: 'block' };
    const document = { getElementById: (id) => { if (id !== 'memories-cta') throw new Error('unexpected id ' + id); return { style: ctaEl }; } };
    ${fnSrc}
    return {
      updateMemoriesCta,
      setMenuExpanded: (v) => { menuExpanded = v; },
      setEditingVariantId: (v) => { editingVariantId = v; },
      getDisplay: () => ctaEl.display
    };
  `;
  return new Function(sandboxSrc)();
}

test('updateMemoriesCta: vizibil pentru Video, editor inchis, fara alegere in asteptare, video nu e ready', () => {
  const mod = loadUpdateMemoriesCta();
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'block');
});

test('updateMemoriesCta: ascuns cat timp meniul mare de editare e deschis (menuExpanded=true)', () => {
  const mod = loadUpdateMemoriesCta();
  mod.setMenuExpanded(true);
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none');
});

test('updateMemoriesCta: ascuns cat timp editorul separat de versuri e deschis (editingVariantId setat)', () => {
  const mod = loadUpdateMemoriesCta();
  mod.setEditingVariantId('variant-123');
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none');
});

test('updateMemoriesCta: reapare dupa ce editorul mare se inchide (Renunță) — menuExpanded revine la false', () => {
  const mod = loadUpdateMemoriesCta();
  mod.setMenuExpanded(true);
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none');
  mod.setMenuExpanded(false); // echivalentul lui "Renunță"
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'block');
});

test('updateMemoriesCta: ramane ascuns in timpul alegerii intre varianta initiala si cea editata (pendingVariantChoice=true), chiar cu editorul inchis', () => {
  const mod = loadUpdateMemoriesCta();
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, true);
  assert.equal(mod.getDisplay(), 'none');
});

test('updateMemoriesCta: reapare dupa alegerea variantei finale (pendingVariantChoice devine false), daca videoclipul nu e deja pornit/gata', () => {
  const mod = loadUpdateMemoriesCta();
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, true);
  assert.equal(mod.getDisplay(), 'none');
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'block');
});

test('updateMemoriesCta: ramane ascuns dupa ce videoclipul e ready, chiar cu editorul inchis si fara alegere in asteptare (pagina finala)', () => {
  const mod = loadUpdateMemoriesCta();
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'ready' }, false);
  assert.equal(mod.getDisplay(), 'none');
});

test('updateMemoriesCta: Standard/Premium raman intotdeauna ascunse, indiferent de editor/alegere', () => {
  const mod = loadUpdateMemoriesCta();
  mod.updateMemoriesCta({ plan: 'standard', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none');
  mod.updateMemoriesCta({ plan: 'premium', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none');
});

test('updateMemoriesCta: simuleaza EXACT bug-ul raportat — re-randare completa (renderContent) cat meniul mare e deschis nu mai reafiseaza CTA-ul', () => {
  const mod = loadUpdateMemoriesCta();
  mod.setMenuExpanded(true);
  // updateStandardEditMenuVisibility() ar fi apelat updateMemoriesCta o data (meniul deschis)...
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none', 'stare intermediara: ascuns, meniul e deschis');
  // ...apoi, INAINTE de fix, renderContent() apela A DOUA OARA updateMemoriesCta NECONDITIONAT
  // (fara sa stie de menuExpanded) — simuland exact acelasi apel repetat, cu ACEEASI stare reala
  // (menuExpanded inca true), rezultatul trebuie sa ramana ascuns, niciodata reaparut.
  mod.updateMemoriesCta({ plan: 'video', videoStatus: 'none' }, false);
  assert.equal(mod.getDisplay(), 'none', 'un al doilea apel, cu aceeasi stare reala, nu trebuie sa reafiseze CTA-ul');
});

// ===============================================================================================
// PARTEA 1b — verificare STRUCTURALA: nicio alta functie din melodia-mea.html nu mai scrie
// direct pe #memories-cta in afara lui updateMemoriesCta (sursa unica de adevar), si fiecare loc
// care schimba o stare relevanta (menuExpanded/editingVariantId/pendingVariantChoice/videoStatus)
// re-invoca updateMemoriesCta dupa aceea.
// ===============================================================================================
test("melodia-mea.html: NICIO functie in afara de updateMemoriesCta nu scrie direct style.display pe elementul #memories-cta", () => {
  const directWrites = [...melodia.matchAll(/getElementById\('memories-cta'\)\.style\.display\s*=/g)];
  // Singura scriere directa ramasa e cea DIN INTERIORUL updateMemoriesCta insasi, plus
  // renderPremiumFlow (ramura Premium, complet separata, care ascunde neconditionat — nu
  // interactioneaza niciodata cu starea Video).
  assert.ok(directWrites.length <= 2, `prea multe scrieri directe pe #memories-cta gasite (${directWrites.length}) — vezi comentariul de la updateMemoriesCta`);
});

test('melodia-mea.html: updateStandardEditMenuVisibility apeleaza updateMemoriesCta o singura data, la inceputul functiei (acopera toate ramurile/return-urile)', () => {
  const fnSrc = extractFn(melodia, 'function updateStandardEditMenuVisibility(order, pendingVariantChoice) {');
  const occurrences = (fnSrc.match(/updateMemoriesCta\(/g) || []).length;
  assert.equal(occurrences, 1, `updateStandardEditMenuVisibility trebuie sa apeleze updateMemoriesCta EXACT o data — gasite ${occurrences}`);
  const firstLineIdx = fnSrc.indexOf('updateMemoriesCta(');
  const bodyStartIdx = fnSrc.indexOf('{') + 1;
  assert.ok(firstLineIdx - bodyStartIdx < 400, 'apelul trebuie sa fie foarte aproape de inceputul functiei, inainte de orice return timpuriu');
});

test('melodia-mea.html: openLyricsEditor si closeLyricsEditor apeleaza updateMemoriesCta dupa ce schimba editingVariantId', () => {
  const openSrc = extractFn(melodia, 'function openLyricsEditor(variant) {');
  const closeSrc = extractFn(melodia, 'function closeLyricsEditor() {');
  assert.ok(openSrc.includes('updateMemoriesCta('), 'openLyricsEditor trebuie sa reevalueze CTA-ul dupa ce deschide editorul');
  assert.ok(closeSrc.includes('updateMemoriesCta('), 'closeLyricsEditor trebuie sa reevalueze CTA-ul dupa ce inchide editorul');
});

test('melodia-mea.html: refreshVideoStatusOnly() (refresh-ul USOR de polling) apeleaza updateMemoriesCta — CTA-ul trebuie sa dispara la videoStatus="ready" chiar fara reincarcare completa', () => {
  const fnSrc = extractFn(melodia, 'async function refreshVideoStatusOnly() {');
  assert.ok(fnSrc.includes('updateMemoriesCta('), 'refresh-ul usor de polling trebuie sa reevalueze CTA-ul, nu doar updateVideoStatusUI');
});

test('melodia-mea.html: renderContent() apeleaza updateMemoriesCta NECONDITIONAT (o singura data), niciodata cu ramuri separate pentru video/non-video', () => {
  const fnSrc = extractFn(melodia, 'function renderContent(order) {');
  const occurrences = (fnSrc.match(/updateMemoriesCta\(/g) || []).length;
  assert.equal(occurrences, 1, `renderContent trebuie sa apeleze updateMemoriesCta EXACT o data — gasite ${occurrences}`);
});

// ===============================================================================================
// PARTEA 2 — "Mai veselă" ajunge in payload-ul REAL trimis furnizorului, cu prioritate fata de
// stilul genului, fara instructiuni contradictorii nete, si cu versurile pastrate exact. Testat
// FUNCTIONAL: extragem buildPrompt()/buildExactLyricsRequest() din server.js si le RULAM cu date
// sintetice — exact tiparul deja folosit in test/lyrics-exact-story-premium-sequential.test.js.
// ===============================================================================================
function loadPromptBuilders() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const exactEnd = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactEnd) + exactEnd.length;
  const snippet = server.slice(startIdx, endIdx);
  const sandboxSrc = `
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return { buildPrompt, buildExactLyricsRequest, detectsBrightenMoodFeedback, BRIGHTEN_MOOD_CLAUSE, VIDEO_FEEDBACK_PRIORITY_LABEL };
  `;
  return new Function(sandboxSrc)();
}
const { buildPrompt, buildExactLyricsRequest, detectsBrightenMoodFeedback, BRIGHTEN_MOOD_CLAUSE, VIDEO_FEEDBACK_PRIORITY_LABEL } = loadPromptBuilders();

const BASE_VIDEO_ORDER = {
  plan: 'video', lang: 'ro', occasion: 'aniversare', recipient: 'Maria',
  senderName: 'Andrei', senderRole: null, recipientRole: null, recipientMode: 'single',
  genre: 'emotional', story: 'Ne-am cunoscut la facultate si de atunci suntem nedespartiti.',
  voicePreference: 'auto'
};

test('CAZUL REAL: Video + gen "Emoțional" + feedback "Mai veselă" — buildExactLyricsRequest (versuri deja alese) include feedback-ul VERBATIM, cu eticheta de prioritate, si clauza de luminozitate, fara "tearful climax" necontrat', () => {
  const order = { ...BASE_VIDEO_ORDER };
  const exactLyrics = 'Vers 1: Te iubesc de cand te stiu.\\nRefren: Esti lumina mea.';
  const req = buildExactLyricsRequest(order, exactLyrics, null, 'auto', 'Mai veselă');
  assert.ok(req.style.includes('Mai veselă'), `feedback-ul verbatim trebuie sa apara in payload, a produs: ${req.style}`);
  assert.ok(req.style.includes(VIDEO_FEEDBACK_PRIORITY_LABEL.trim()), 'trebuie sa foloseasca eticheta explicita de prioritate pentru Video');
  assert.ok(req.style.includes('brighter') && req.style.includes('major-key') && req.style.includes('upbeat'), `clauza de luminozitate trebuie sa fie prezenta, a produs: ${req.style}`);
  assert.ok(req.style.includes('REPLACES any somber'), 'clauza trebuie sa neutralizeze explicit descriptorii opusi');
  // pozitia: clauza de prioritate + luminozitate trebuie sa vina DUPA descrierea de stil a
  // genului (styleTags), niciodata inaintea ei — feedback-ul e un ADAOS cu prioritate declarata,
  // nu o inlocuire a textului.
  assert.ok(req.style.indexOf('Mai veselă') > req.style.indexOf('cinematic orchestral ballad'));
  // versurile raman EXACT cele alese de client — nicio schimbare de atmosfera nu le atinge.
  assert.equal(req.lyrics, exactLyrics);
});

test('buildExactLyricsRequest: descriptorul trist al genului "emotional" ("tearful climax") ramane in style (nu il stergem), dar e neutralizat explicit de clauza adaugata cand feedback-ul cere un ton vesel', () => {
  const order = { ...BASE_VIDEO_ORDER };
  const req = buildExactLyricsRequest(order, 'Vers exact.', null, 'auto', 'Mai veselă');
  assert.ok(req.style.includes('tearful climax'), 'stilul genului original nu trebuie sters (doar neutralizat de o clauza explicita)');
  assert.ok(req.style.indexOf('REPLACES any somber') > req.style.indexOf('tearful climax'), 'clauza de neutralizare trebuie sa vina DUPA descriptorul trist, ca sa il suprascrie explicit in ordinea citirii');
});

// DESCOPERIT in timpul scrierii acestui test (nu presupus): SUNO_PROMPT_MAX_LEN=600 e o valoare
// DELIBERAT stransa (comentariul de la declararea ei documenteaza o regresie reala anterioara —
// un buget mai mare de prompt corela cu piese generate integral instrumental de furnizor) — nu o
// putem mari, nici doar pentru Video, fara sa riscam exact acea regresie deja descoperita si
// reparata. Consecinta REALA, verificata direct: pentru aproape orice comanda reala (ocazie +
// destinatar + expeditor + poveste), bugetul ramas pentru feedback dupa rezerva minima a
// povestii (STORY_MIN_RESERVE) e deja aproape de zero — INAINTE de aceasta corectie, acel
// feedback ar fi fost trunchiat SILENTIOS la aproape nimic (exact bug-ul raportat de client).
// Corectia aplicata (mai jos) respecta STRICT cerinta explicita: "nu tăia și nu elimina în
// tăcere instrucțiunea din cauza bugetului promptului... oferă o eroare clară" — arunca eroare
// in loc sa trimita o cerere care ar ignora tacit cuvintele clientului. In PRACTICA, aceasta
// ramura (buildPrompt, fara exactLyrics) e acum rar/niciodata atinsa de Video, dupa corectia
// separata care face ca exactLyrics sa foloseasca intotdeauna originalLyrics ca fallback (vezi
// handleLegacyRegenerate) — testat separat mai jos, cu buildExactLyricsRequest (bugetul generos
// de 1000 caractere), calea REALA folosita de Video in productie.
test('buildPrompt (ramura rara, fara exactLyrics): pentru o comanda REALA (ocazie+destinatar+expeditor+poveste), bugetul ramas pentru feedback e aproape mereu zero — Video arunca eroare clara in loc sa trunchieze silentios "Mai veselă"', () => {
  const order = { ...BASE_VIDEO_ORDER };
  assert.throws(() => buildPrompt(order, 'Mai veselă', null), /prea lungă/, 'trebuie sa refuze explicit, nu sa trimita o cerere care ignora feedback-ul clientului');
});

test('buildPrompt: cu un feedback GOL (fara nicio cerere de stil), comanda reala functioneaza normal — eroarea apare STRICT cand exista feedback de trimis, nu mereu', () => {
  const order = { ...BASE_VIDEO_ORDER };
  const prompt = buildPrompt(order, null, null);
  assert.ok(prompt && prompt.length > 0);
  assert.ok(!prompt.includes(VIDEO_FEEDBACK_PRIORITY_LABEL.trim()));
});

test('detectsBrightenMoodFeedback: recunoaste cererea de "mai vesel" in toate cele 8 limbi ale site-ului (text real, natural)', () => {
  const casesByLang = {
    ro: 'Aș vrea să fie mai veselă, te rog',
    en: 'Can you make it happier please',
    de: 'Kannst du es fröhlicher machen',
    es: 'Puedes hacerla más alegre por favor',
    it: 'Puoi renderla più allegra per favore',
    fr: 'Peux-tu la rendre plus joyeuse',
    bg: 'Може ли да е по-весела',
    tr: 'Daha neşeli yapabilir misin'
  };
  for (const [lang, text] of Object.entries(casesByLang)) {
    assert.ok(detectsBrightenMoodFeedback(text, lang), `nu a recunoscut cererea de veselie in limba ${lang}: "${text}"`);
  }
});

test('detectsBrightenMoodFeedback: feedback neutru (nu cere schimbare de atmosfera) NU declanseaza clauza suplimentara', () => {
  assert.equal(detectsBrightenMoodFeedback('Te rog adauga mai multa chitara acustica', 'ro'), false);
  assert.equal(detectsBrightenMoodFeedback('', 'ro'), false);
  assert.equal(detectsBrightenMoodFeedback(null, 'ro'), false);
});

test('Standard/Premium: feedback-ul NU primeste eticheta de prioritate sau clauza suplimentara — comportament byte-identic cu inainte de aceasta corectie', () => {
  const standardOrder = { ...BASE_VIDEO_ORDER, plan: 'standard' };
  const req = buildExactLyricsRequest(standardOrder, 'Vers exact.', null, 'auto', 'Mai veselă');
  assert.ok(req.style.includes(' Mai veselă'), 'textul verbatim tot trebuie sa ajunga (comportament vechi neschimbat)');
  assert.ok(!req.style.includes(VIDEO_FEEDBACK_PRIORITY_LABEL.trim()), 'Standard nu trebuie sa primeasca eticheta de prioritate STRICT-Video');
  assert.ok(!req.style.includes(BRIGHTEN_MOOD_CLAUSE.trim().slice(0, 20)), 'Standard nu trebuie sa primeasca clauza suplimentara STRICT-Video');

  const premiumOrder = { ...BASE_VIDEO_ORDER, plan: 'premium' };
  const promptPremium = buildPrompt(premiumOrder, 'Mai veselă', null);
  assert.ok(!promptPremium.includes(VIDEO_FEEDBACK_PRIORITY_LABEL.trim()));
});

test('buildExactLyricsRequest: instructiune de stil extrem de lunga, care nu ar incapea verbatim in bugetul de 1000 caractere — Video arunca o eroare CLARA, in loc sa trunchieze silentios feedback-ul clientului', () => {
  const order = { ...BASE_VIDEO_ORDER, story: '' };
  const veryLongFeedback = 'Mai veselă, '.repeat(120); // >> 1000 caractere
  assert.throws(() => buildExactLyricsRequest(order, 'Vers scurt.', null, 'auto', veryLongFeedback), /prea lungă/);
});

test('buildPrompt: instructiune de stil extrem de lunga — Video arunca eroare clara (nu trunchiaza silentios) inainte de a trimite cererea', () => {
  const order = { ...BASE_VIDEO_ORDER };
  const veryLongFeedback = 'Mai veselă si mai energica, te rog foarte mult, '.repeat(30);
  assert.throws(() => buildPrompt(order, veryLongFeedback, null), /prea lungă/);
});

// ===============================================================================================
// PARTEA 3 — persistenta feedback-ului INAINTE de jobul asincron (supravietuieste unui restart).
// ===============================================================================================
test('db.js: coloana regenerate_feedback exista (migratie idempotenta, acelasi tipar ca regenerate_source_variant_id)', () => {
  const dbjs = read('db.js');
  assert.match(dbjs, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS regenerate_feedback TEXT;/);
  assert.match(dbjs, /regenerateFeedback:\s*row\.regenerate_feedback/);
  assert.match(dbjs, /regenerateFeedback:\s*'regenerate_feedback'/);
});

test('server.js: handleLegacyRegenerate scrie regenerateFeedback in DB INAINTE de a porni jobul asincron (runGeneration), in acelasi apel care scrie regenerateSourceVariantId', () => {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, idx + 12000);
  const updateIdx = body.indexOf('regenerateSourceVariantId: requestedVariantId');
  const runGenIdx = body.indexOf('runGeneration(order.id, feedback, regenOptions)');
  assert.ok(updateIdx !== -1 && runGenIdx !== -1);
  assert.ok(updateIdx < runGenIdx, 'scrierea in DB trebuie sa se intample INAINTE de pornirea jobului asincron');
  const updatePatch = body.slice(updateIdx, body.indexOf(');', updateIdx));
  assert.ok(updatePatch.includes('regenerateFeedback: feedback'), 'acelasi apel updateOrder trebuie sa persiste si feedback-ul');
});

test('server.js: runGeneration() preferă feedback-ul persistat pe comanda (order.regenerateFeedback) fata de parametrul primit — supravietuieste unui restart intre claim si dispatch', () => {
  const fnSrc = extractFn(server, 'async function runGeneration(orderId, feedback, options = {}) {');
  assert.match(fnSrc, /const effectiveFeedback = \(order\.regenerateFeedback !== null && order\.regenerateFeedback !== undefined\)\s*\n\s*\? order\.regenerateFeedback\s*\n\s*: feedback;/);
  // simulare FUNCTIONALA a preluarii: daca DB are deja regenerateFeedback (scris sincron
  // inainte de acest job), acela e cel folosit, INDIFERENT de parametrul primit — exact
  // scenariul "procesul a repornit, parametrul din memorie a disparut, dar DB inca il are".
  const sandboxSrc = `
    ${fnSrc.replace(/^async function runGeneration/, 'function runGeneration')}
    return runGeneration;
  `;
  // nu rulam functia completa (are dependinte grele de retea) — verificam STRICT expresia
  // effectiveFeedback izolat, ca sandbox minimal.
  const exprMatch = fnSrc.match(/const effectiveFeedback = \([\s\S]*?: feedback;/);
  assert.ok(exprMatch);
  const evalFn = new Function('order', 'feedback', `${exprMatch[0]}\nreturn effectiveFeedback;`);
  assert.equal(evalFn({ regenerateFeedback: 'Mai veselă (din DB, dupa restart)' }, null), 'Mai veselă (din DB, dupa restart)');
  assert.equal(evalFn({ regenerateFeedback: null }, 'Mai veselă (parametru normal)'), 'Mai veselă (parametru normal)');
});

test('node --check server.js si db.js trec (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
