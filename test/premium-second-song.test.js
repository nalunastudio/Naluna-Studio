// Teste pentru "MODIFICARE STRICTĂ — FLUXUL PACHETULUI PREMIUM £25" (hotfix 2026-08-09):
// (1) selectarea Premium deschide un ecran dedicat de sumar (pasul 5), fara pachetele
// Standard/Cadou video sau vreun selector de configurare; (2) "Generează previzualizarea
// gratuită" deschide un al doilea ecran dedicat (pasul 6) de configurare a celei de-a doua
// melodii, FARA sa porneasca generarea; (3) genul celei de-a doua melodii, obligatoriu si diferit
// de primul; (4) "Pentru cine este a doua melodie?" — aceeași persoană (reutilizeaza datele
// principale) sau altă persoană (reutilizeaza componenta existentă de relatie de familie,
// independent de occasion-ul comenzii); (5) datele celor doua melodii nu se amestecă niciodata;
// (6) Standard si Cadou video raman STRICT neschimbate. Acopera cele 17 teste obligatorii cerute
// explicit de client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const comanda = read('public/comanda.html');
const dbjs = read('db.js');

// buildPrompt() + getSong1EffectiveData/getSong2EffectiveData — functii PURE, extrase textual
// din server.js si evaluate intr-un sandbox, acelasi tipar stabilit in rundele anterioare.
function loadPremiumHelpers() {
  const startIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const buildPromptSnippet = server.slice(startIdx, i + 1);

  const famStart = server.indexOf('const FAMILY_OCCASIONS = ');
  const famEnd = server.indexOf('const WEDDING_RECIPIENT_ROLES_SINGLE');
  assert.ok(famStart !== -1 && famEnd !== -1, 'nu am gasit constantele de familie');
  const familyConstants = server.slice(famStart, famEnd);

  const song1Start = server.indexOf('function getSong1EffectiveData');
  const song2End = server.indexOf('async function runGeneration');
  assert.ok(song1Start !== -1 && song2End !== -1, 'nu am gasit getSong1EffectiveData/getSong2EffectiveData');
  const song2Funcs = server.slice(song1Start, song2End);

  const sandboxSrc = `
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    ${familyConstants}
    ${buildPromptSnippet}
    ${song2Funcs}
    return { buildPrompt, getSong1EffectiveData, getSong2EffectiveData };
  `;
  return new Function(sandboxSrc)();
}

const { buildPrompt, getSong1EffectiveData, getSong2EffectiveData } = loadPremiumHelpers();

function premiumOrder(overrides) {
  return Object.assign({
    occasion: 'parinti',
    genre: 'pop', genre2: 'balada', lang: 'ro',
    senderName: 'Ana', relationship: 'fiica',
    voicePreference: 'auto',
    story: 'O poveste calda despre familia noastra si amintirile impreuna.',
    recipient: 'Maria', recipientRole: 'mother', senderRole: 'daughter',
    recipientMode: 'single', recipientNames: null,
    plan: 'premium'
  }, overrides);
}

// ---------------------------------------------------------------------------------------------
// TEST 1 (CORECȚIE 2026-08-23) — selectarea Premium ramane pe pagina comuna (pasul 4) si
// afiseaza beneficiile INLINE, in acelasi bloc folosit de Standard/Cadou video — ecranul separat
// "Pachet Premium" (fostul pas 5) a fost eliminat complet.
// ---------------------------------------------------------------------------------------------
test('comanda.html: selectPlan() NU mai navigheaza automat catre niciun ecran separat pentru Premium (fara showStep(5) redundant)', () => {
  const start = comanda.indexOf('function selectPlan(p) {');
  const end = comanda.indexOf('\n  }', start);
  const snippet = comanda.slice(start, end);
  assert.ok(!snippet.includes('showStep('), 'selectPlan() nu trebuie sa apeleze showStep() pentru niciun plan');
  assert.ok(!snippet.includes('renderPremiumSummaryBenefits'), 'functia veche a fost eliminata complet');
  assert.ok(snippet.includes('renderBenefits(selectedPlan.id);'), 'renderBenefits() ramane singura sursa, comuna tuturor pachetelor');
});

test('comanda.html: nu mai exista niciun ecran/functie/element dedicat sumarului Premium separat (renderPremiumSummaryBenefits, #premium-summary-benefits, premium_summary_title ca h1 de ecran)', () => {
  assert.ok(!comanda.includes('renderPremiumSummaryBenefits'), 'functia veche trebuie eliminata');
  assert.ok(!comanda.includes('premium-summary-benefits'), 'elementul dedicat vechi trebuie eliminat');
  assert.ok(!comanda.includes('<h1 data-i18n="premium_summary_title">'), 'ecranul separat "Pachet Premium" nu mai trebuie sa existe in HTML');
});

test('comanda.html: beneficiile Premium se randeaza in ACELASI bloc comun (#benefits-list) ca Standard si Cadou video, folosind aceeasi functie renderBenefits()', () => {
  assert.match(comanda, /function renderBenefits\(planId\) \{\s*const key = `benefits_\$\{planId\}`;/);
  assert.match(comanda, /<div class="benefits-list" id="benefits-list"><\/div>/);
});

// CORECȚIE (2026-08-29, "pachetul Standard — conținut vizibil din prima"): versiunea anterioara
// ascundea intentionat beneficiile la incarcare (planExplicitlySelected=false), desi cardul
// Standard e deja vizual activ in HTML (.plan.active, aria-selected="true") si selectedPlan
// porneste implicit pe 'standard' — clientul trebuia sa dea un al doilea click doar ca sa vada
// ce include pachetul deja "ales". Flag-ul planExplicitlySelected a fost eliminat complet;
// renderBenefits(selectedPlan.id) se apeleaza acum NECONDIȚIONAT la initializare (dupa
// restoreDraft(), care poate schimba selectedPlan la Premium/Video inainte de acest apel).
test('comanda.html: la incarcarea initiala, beneficiile planului CURENT SELECTAT (Standard implicit, sau planul restaurat din draft) sunt vizibile IMEDIAT, fara niciun click', () => {
  assert.ok(!comanda.includes('planExplicitlySelected'), 'flag-ul vechi, care intarzia afisarea beneficiilor, nu mai trebuie sa existe');
  assert.match(comanda, /applyLang\(currentLang\);\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*renderBenefits\(selectedPlan\.id\);/, 'renderBenefits(selectedPlan.id) trebuie apelat neconditionat la initializare, dupa applyLang()');
  // selectPlan() (click/Enter/Space) randeaza direct beneficiile, fara niciun flag intermediar.
  const start = comanda.indexOf('function selectPlan(p) {');
  const snippet = comanda.slice(start, start + 700);
  assert.match(snippet, /renderBenefits\(selectedPlan\.id\);/);
  assert.ok(!snippet.includes('planExplicitlySelected'));
});

test('comanda.html: cardul Standard e activ implicit in HTML (.plan.active, aria-selected="true") si selectedPlan porneste pe "standard" — sursa reala a beneficiilor vizibile din prima', () => {
  assert.match(comanda, /<div class="plan active" data-plan="standard" data-price="15" role="radio" aria-selected="true"/);
  assert.match(comanda, /let selectedPlan = \{ id: 'standard', price: 15, label: 'Standard' \};/);
});

test('comanda.html: restaurarea unui draft cu Premium/Video randeaza beneficiile ACELUI pachet la initializare (fara ecranul vechi de sumar), fara niciun flag intermediar', () => {
  const start = comanda.indexOf('function restoreDraft() {');
  const end = comanda.indexOf('\n  }', comanda.indexOf('updateGenerateButtonLabel();', start));
  const snippet = comanda.slice(start, end);
  assert.ok(!snippet.includes('planExplicitlySelected'));
  assert.ok(!snippet.includes('renderPremiumSummaryBenefits'), 'restaurarea nu mai trebuie sa deschida fostul sumar Premium');
  // restoreDraft() insusi NU apeleaza renderBenefits() (doar seteaza selectedPlan) — apelul
  // neconditionat de la initializare (testat mai sus) ruleaza DUPA restoreDraft(), deci foloseste
  // deja planul corect restaurat.
  assert.match(snippet, /selectedPlan = \{\s*id: planEl\.dataset\.plan,/);
});

// ---------------------------------------------------------------------------------------------
// TEST 2/3 (CORECȚIE 2026-08-23) — click/Enter/Space pe cardul Premium au acelasi comportament
// (toate trec prin selectPlan()), iar butonul "Generează..." de pe pasul 4 e cel care avanseaza
// explicit spre configurarea celei de-a doua melodii — fara sa porneasca generarea imediat.
// ---------------------------------------------------------------------------------------------
test('comanda.html: click SI keydown (Enter/Space) pe un card de plan apeleaza identic selectPlan(p)', () => {
  assert.match(comanda, /p\.addEventListener\('click', \(\) => selectPlan\(p\)\);/);
  assert.match(comanda, /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); selectPlan\(p\); \}/);
});

test('comanda.html: submit handler porneste generarea DOAR la pasul final (getTotalSteps()), niciodata mai devreme', () => {
  assert.match(comanda, /if \(currentStep !== getTotalSteps\(\)\) \{/);
});

test('comanda.html: pe pasul 4, cu Premium selectat, butonul "Generează..." avanseaza direct la pasul 5 (prima configurare obligatorie a melodiei 2 — genul), fara sa trimita comanda si fara sa schimbe URL-ul', () => {
  assert.match(comanda, /if \(selectedPlan\.id === 'premium' && currentStep === 4\) \{\s*showStep\(5\);\s*return;\s*\}/);
});

// MODIFICARE STRICTĂ — separarea configurarii Premium in doi pasi (hotfix 2026-08-10 runda 2),
// CORECȚIE 2026-08-23 (eliminarea ecranului separat "Pachet Premium"): genul (pasul 5) si
// destinatarul (pasul 6) raman ecrane SEPARATE — Premium are acum 6 sau 7 pasi in total
// (pasul 5 al vechiului flux, sumarul, a fost eliminat), nu 7/8.
test('comanda.html: getTotalSteps() e 6 sau 7 pentru premium (7 STRICT cand "Pentru altă persoană" a fost ales — mini-pagina dedicata), 4 pentru orice alt pachet (Standard/Video neschimbate)', () => {
  assert.match(comanda, /function getTotalSteps\(\) \{\s*if \(selectedPlan\.id !== 'premium'\) return 4;\s*return song2TargetInput\.value === 'other' \? 7 : 6;\s*\}/);
});

test('comanda.html: pasul 5 (genul) si pasul 6 (destinatarul) sunt ecrane distincte, fiecare cu propriul step-card — pasul 4 este pagina comuna cu pachetele', () => {
  assert.match(comanda, /<div class="step-card" data-step="5" style="display:none;">/);
  assert.match(comanda, /<div class="step-card" data-step="6" style="display:none;">/);
  const idx5 = comanda.indexOf('data-step="5"');
  const idx6 = comanda.indexOf('data-step="6"', idx5);
  const step5Html = comanda.slice(idx5, idx6);
  assert.ok(step5Html.includes('song2_genre_section_title'), 'pasul 5 trebuie sa contina sectiunea de gen');
  assert.ok(!step5Html.includes('song2_target_section_title'), 'pasul 5 NU trebuie sa contina sectiunea de destinatar');
  assert.match(step5Html, /data-next="6" data-validate="5"/, 'pasul 5 trebuie sa aiba un buton Continuă catre pasul 6, cu validare');
});

test('comanda.html: butonul "Înapoi" din configurarea Premium (pasul 5, genul melodiei 2) revine la pagina comuna cu pachetele (pasul 4)', () => {
  const idx5 = comanda.indexOf('data-step="5"');
  const idx6 = comanda.indexOf('data-step="6"', idx5);
  const step5Html = comanda.slice(idx5, idx6);
  assert.match(step5Html, /data-prev="4"/);
});

test('comanda.html: validateStep(5) cere genre2 obligatoriu si diferit de genre, inainte de a trece la pasul 6', () => {
  const idx = comanda.indexOf('if (n === 5) {');
  const snippet = comanda.slice(idx, idx + 500);
  assert.ok(snippet.includes("t('val_genre2_required')"));
  assert.ok(snippet.includes("t('val_genre_same')"));
});

test('comanda.html: butonul "Înapoi" de pe pasul 6 (destinatarul) pastreaza genul ales pe pasul 5 (revine la pasul 5, nu reseteaza genre2Input)', () => {
  const idx6 = comanda.indexOf('data-step="6"');
  const idx7 = comanda.indexOf('data-step="7"', idx6);
  const step6Html = comanda.slice(idx6, idx7);
  assert.match(step6Html, /data-prev="5"/);
});

// ---------------------------------------------------------------------------------------------
// TEST 4: sectiunea genului e vizibila si marcata obligatorie.
// ---------------------------------------------------------------------------------------------
test('comanda.html: sectiunea genului de pe pasul 5 e intr-un .mandatory-section, cu marcaj badge_required', () => {
  const idx = comanda.indexOf('song2_genre_section_title');
  const context = comanda.slice(idx - 400, idx + 50);
  assert.ok(context.includes('mandatory-section'), 'sectiunea genului trebuie sa fie in interiorul unui .mandatory-section');
  assert.ok(context.includes('badge_required'), 'sectiunea genului trebuie sa aiba marcajul "Obligatoriu"');
});

test('comanda.html: "Prima melodie: [gen]" e afisat pe pasul 5, actualizat din cardul real de gen (nu dintr-o cheie inexistenta gen_<val>)', () => {
  assert.match(comanda, /id="song1-genre-display"/);
  assert.match(comanda, /function updateSong1GenreDisplay\(\) \{\s*const card = document\.querySelector\(`\.genre-card\[data-genre="\$\{genreInput\.value\}"\]:not\(\.genre2-card\)`\);/);
});

// ---------------------------------------------------------------------------------------------
// TEST 5: backend-ul respinge un gen identic cu primul.
// ---------------------------------------------------------------------------------------------
test('server.js: POST /api/orders respinge genre2 identic cu genre pentru orice plan cu 2 variante (Premium inclus, neschimbat)', () => {
  assert.match(server, /if \(genre2 === genre\) \{\s*return res\.status\(400\)\.json\(\{ error: sameGenreMessage\(safeLang\) \}\);/);
});

test('comanda.html: click pe un card genre2 identic cu genre e blocat DOAR pentru Premium (Video ramane exact neschimbat, blocat doar la trimitere)', () => {
  assert.match(comanda, /if \(selectedPlan\.id === 'premium' && c\.dataset\.genre === genreInput\.value\) \{\s*setFieldError\('genre2', t\('val_genre_same'\)\);\s*return;\s*\}/);
});

// ---------------------------------------------------------------------------------------------
// TEST 6: sectiunea destinatarului e vizibila si obligatorie.
// ---------------------------------------------------------------------------------------------
test('comanda.html: sectiunea "Pentru cine este a doua melodie?" e intr-un .mandatory-section, cu marcaj badge_required, exact doua optiuni', () => {
  const idx = comanda.indexOf('song2_target_section_title');
  const context = comanda.slice(idx - 400, idx + 1500);
  assert.ok(context.includes('mandatory-section'));
  assert.ok(context.includes('badge_required'));
  assert.ok(context.includes('song2_same_person'));
  assert.ok(context.includes('song2_other_person'));
  assert.ok(!context.includes('nunta_both'), 'nu trebuie sa existe o a treia optiune "Amândoi" pentru alegerea persoanei');
});

test('server.js: POST /api/orders cere song2Target explicit ("same"/"other") pentru plan="premium", fara valoare implicita', () => {
  assert.match(server, /if \(plan === 'premium'\) \{\s*if \(song2Target !== 'same' && song2Target !== 'other'\) \{/);
});

// MODIFICARE STRICTĂ — cardurile "Aceeași persoană"/"Altă persoană" (hotfix 2026-08-10 runda 2):
// ambele folosesc nuanta portocaliu-deschis (.song2-choice-card, aceleasi valori rgba deja
// folosite in Standard), iar cel selectat se distinge printr-un chenar mai puternic + bifa —
// niciodata sa nu para ca ambele sunt selectate simultan.
test('comanda.html: cardurile same/other folosesc .song2-choice-card (nuanta portocalie pentru ambele) si au fiecare o bifa .song2-choice-check', () => {
  assert.match(comanda, /<div class="theme-card theme-subcard song2-choice-card" id="song2-same-card" data-song2-target="same">\s*<span class="song2-choice-check">✓<\/span>/);
  assert.match(comanda, /<div class="theme-card theme-subcard song2-choice-card" id="song2-other-card" data-song2-target="other">\s*<span class="song2-choice-check">✓<\/span>/);
});

test('comanda.html: .song2-choice-card are fundal portocaliu-deschis mereu vizibil, iar .song2-choice-card.active are chenar mai puternic (2px, gold-deep) si bifa vizibila', () => {
  assert.match(comanda, /\.song2-choice-card\{\s*background:rgba\(168,131,75,\.07\); border:1px solid rgba\(168,131,75,\.35\); position:relative;/);
  assert.match(comanda, /\.song2-choice-card\.active\{\s*border:2px solid var\(--gold-deep\); background:rgba\(168,131,75,\.16\);\s*\}/);
  assert.match(comanda, /\.song2-choice-card\.active \.song2-choice-check\{ display:flex; \}/);
});

// ---------------------------------------------------------------------------------------------
// TEST 7: "Aceeași persoană" reutilizeaza corect primul destinatar.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: song2Target="same" foloseste EXACT recipient/recipientRole/senderRole/recipientMode/recipientNames ale primei melodii', () => {
  const order = premiumOrder({ song2Target: 'same' });
  const song2Data = getSong2EffectiveData(order);
  assert.deepEqual(song2Data, getSong1EffectiveData(order));
  const prompt2 = buildPrompt({ ...order, ...song2Data }, '', order.genre2);
  assert.ok(prompt2.includes('Recipient: Maria.'), `promptul melodiei 2 trebuie sa contina Recipient: Maria., a produs: ${prompt2}`);
  assert.ok(prompt2.includes('"mother"'), 'promptul melodiei 2 trebuie sa foloseasca relatia "mother"');
});

test('server.js: getSong2EffectiveData returneaza datele principale ale comenzii pentru orice plan care NU e premium (Video/Standard neschimbate)', () => {
  const orderVideo = premiumOrder({ plan: 'video', song2Target: null });
  assert.deepEqual(getSong2EffectiveData(orderVideo), getSong1EffectiveData(orderVideo));
});

// ---------------------------------------------------------------------------------------------
// TEST 8: "Altă persoană" salveaza relatia si numele separat.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: song2Target="other" foloseste occasion2/recipientRole2/senderRole2/recipient2, NICIODATA datele primei melodii', () => {
  const order = premiumOrder({
    song2Target: 'other', occasion2: 'bunici', recipientRole2: 'grandmother', senderRole2: 'granddaughter',
    recipient2: 'Elena', recipientMode2: 'single', recipientNames2: null
  });
  const song2Data = getSong2EffectiveData(order);
  assert.equal(song2Data.recipient, 'Elena');
  assert.equal(song2Data.recipientRole, 'grandmother');
  assert.equal(song2Data.occasion, 'bunici');
  assert.equal(song2Data.senderRole, 'granddaughter', 'senderRole2 e reutilizat pentru a doua melodie, exact ca la ocazia principala');
  const prompt2 = buildPrompt({ ...order, ...song2Data }, '', order.genre2);
  assert.ok(prompt2.includes('Recipient: Elena.'), `a produs: ${prompt2}`);
  assert.ok(prompt2.includes('"grandmother"'));
});

test('buildPrompt: song2Target="other" cu ocazie fara concept de senderRole (frati) — senderRole ramane undefined/fals, niciun senderRole2 cerut', () => {
  const order = premiumOrder({
    song2Target: 'other', occasion2: 'frati', recipientRole2: 'sister', recipient2: 'Ioana',
    recipientMode2: 'single', recipientNames2: null
  });
  const song2Data = getSong2EffectiveData(order);
  assert.ok(!song2Data.senderRole, 'frati nu are concept de senderRole (Tu ești: ...)');
  const prompt2 = buildPrompt({ ...order, ...song2Data }, '', order.genre2);
  assert.ok(prompt2.includes('Recipient: Ioana.'), `a produs: ${prompt2}`);
});

// CORECȚIE STRICTĂ — configurarea pachetului Premium (hotfix 2026-08-10): a doua melodie
// foloseste acum ÎNTREAGA pagina de ocazie (13 optiuni), deci recipientRole2 e validat
// SCOPED la occasion2 (FAMILY_OCCASION_RECIPIENT_ROLES[occasion2]), exact ca ocazia
// principala — nu mai e validat impotriva listei generice, nescoped, FAMILY_RECIPIENT_ROLE_VALUES.
test('server.js: POST /api/orders valideaza recipientRole2 impotriva FAMILY_OCCASION_RECIPIENT_ROLES[occasion2] (scoped la ocazia aleasa pentru a doua melodie)', () => {
  const idx = server.indexOf("if (song2Target === 'other') {");
  const snippet = server.slice(idx, idx + 900);
  assert.match(snippet, /const allowedRecipientRoles2 = FAMILY_OCCASION_RECIPIENT_ROLES\[occasion2\];/);
  assert.match(snippet, /if \(!allowedRecipientRoles2\.includes\(recipientRole2\)\) \{/);
});

test('server.js: FAMILY_RECIPIENT_ROLE_VALUES include toate rolurile din toate cele 5 categorii de familie (bunici/parinti/matusa-unchi/socri/frati) — ramane definita pentru relationClause(), desi nu mai e folosita pentru validarea recipientRole2', () => {
  assert.match(server, /const FAMILY_RECIPIENT_ROLE_VALUES = Object\.values\(FAMILY_OCCASION_RECIPIENT_ROLES\)\.flat\(\);/);
});

test('comanda.html: al doilea ecran ofera TOATE cele 13 optiuni de ocazie (identice cu pagina "Pentru ce moment vrei cântecul?") pentru "altă persoană"', () => {
  assert.match(comanda, /const ALL_OCCASIONS_ORDERED = \['dor', 'onomastica', 'aniversare', 'declaratie', 'nunta', 'pierdere', 'pentru-mine', 'bunici', 'parinti', 'matusa-unchi', 'socri', 'frati', 'altceva'\];/);
  assert.match(comanda, /function renderSong2OccasionGrid\(\) \{/);
});

// ---------------------------------------------------------------------------------------------
// TEST 9: numele si relatiile celor doua melodii nu se amesteca niciodata.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: melodia 1 (mama Maria, ocazia "parinti") si melodia 2 (bunica Elena, ocazia proprie "bunici") nu se amesteca — fiecare foloseste STRICT propriile date, INCLUSIV propria ocazie', () => {
  const order = premiumOrder({
    song2Target: 'other', occasion2: 'bunici', recipientRole2: 'grandmother', recipient2: 'Elena',
    recipientMode2: 'single', recipientNames2: null
  });
  const prompt1 = buildPrompt(order, '', order.genre);
  const prompt2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, '', order.genre2);

  assert.ok(prompt1.includes('Recipient: Maria.'));
  assert.ok(prompt1.includes('"mother"'));
  assert.ok(!prompt1.includes('Elena'), 'melodia 1 nu trebuie sa contina numele celei de-a doua persoane');
  assert.ok(!prompt1.includes('"grandmother"'), 'melodia 1 nu trebuie sa contina relatia celei de-a doua persoane');

  assert.ok(prompt2.includes('Recipient: Elena.'));
  assert.ok(prompt2.includes('"grandmother"'));
  assert.ok(!prompt2.includes('Recipient: Maria'), 'melodia 2 nu trebuie sa contina numele primei persoane');
  assert.ok(!prompt2.includes('"mother"'), 'melodia 2 nu trebuie sa contina relatia primei persoane');

  // CORECȚIE STRICTĂ (hotfix 2026-08-10): fiecare melodie poate avea acum PROPRIA ocazie —
  // melodia 1 ramane pe ocazia comenzii ("parinti"), melodia 2 foloseste STRICT occasion2 ("bunici").
  assert.ok(prompt1.includes('Occasion: a tribute to a parent.'));
  assert.ok(!prompt1.includes('Occasion: a tribute to a grandparent.'));
  assert.ok(prompt2.includes('Occasion: a tribute to a grandparent.'));
  assert.ok(!prompt2.includes('Occasion: a tribute to a parent.'));
});

test('server.js: finalizeVariantsIfNeeded salveaza recipientSnapshot SEPARAT pe fiecare varianta, niciodata amestecat', () => {
  assert.match(server, /if \(recipientSnapshot\) Object\.assign\(built, recipientSnapshot\);/);
});

test('server.js: checkLyricsContainExpectedNames verifica impotriva snapshot-ului PROPRIU al variantei, cu fallback la datele comenzii (compatibilitate variante vechi)', () => {
  const idx = server.indexOf('function checkLyricsContainExpectedNames');
  const snippet = server.slice(idx, idx + 700);
  assert.match(snippet, /const mode = variant\.recipientMode !== undefined && variant\.recipientMode !== null \? variant\.recipientMode : order\.recipientMode;/);
  assert.match(snippet, /const names = variant\.recipientNames \|\| order\.recipientNames;/);
  assert.match(snippet, /const recipient = variant\.recipient \|\| order\.recipient;/);
});

test('server.js: regenerarea PARTIALA (editarea unei singure variante Premium) foloseste snapshot-ul CORECT (song1 sau song2) dupa slotul editat', () => {
  const idx = server.indexOf('if (options.replaceVariantId && isDualGenrePlan) {');
  const snippet = server.slice(idx, idx + 1200);
  assert.match(snippet, /const isSong2Slot = genreToUse === order\.genre2 && order\.genre2 !== order\.genre;/);
  assert.match(snippet, /const recipientSnapshot = isSong2Slot \? getSong2EffectiveData\(order\) : getSong1EffectiveData\(order\);/);
});

// ---------------------------------------------------------------------------------------------
// TEST 10: pentru "Amândoi" sunt pastrate ambele nume complete.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: song2 "Amândoi" (grandparents) pastreaza AMBELE nume complete, chiar si in cel mai rau caz de buget', () => {
  const name1 = 'A'.repeat(60);
  const name2 = 'B'.repeat(60);
  const order = premiumOrder({
    genre: 'manele', senderName: 'I'.repeat(100), relationship: 'R'.repeat(60), voicePreference: 'duet',
    story: 'S'.repeat(2000),
    song2Target: 'other', occasion2: 'bunici', recipientRole2: 'grandparents', recipient2: `${name1} și ${name2}`,
    recipientMode2: 'both', recipientNames2: { name1, name2 }
  });
  const prompt2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, '', order.genre2);
  assert.ok(prompt2.includes(name1), 'primul nume (60 caractere) trebuie sa apara intreg');
  assert.ok(prompt2.includes(name2), 'al doilea nume (60 caractere) trebuie sa apara intreg');
  assert.ok(prompt2.includes('Never omit either person.'));
});

// REVIZUIT (2026-08-13, runda "Amândoi" fara campuri duplicate): recipientNames2 a devenit STRICT
// optional — server.js nu mai cere name1_2/name2_2, numele vin exclusiv din campul unic recipient2.
test('server.js: POST /api/orders cere recipientMode2="both" cand recipientRole2 e in FAMILY_BOTH_ROLES, dar recipientNames2 ramane optional', () => {
  const idx = server.indexOf("if (song2Target === 'other') {");
  const snippet = server.slice(idx, idx + 1600);
  assert.match(snippet, /const isFamilyBothRole2 = FAMILY_BOTH_ROLES\.includes\(recipientRole2\);/);
  assert.match(snippet, /if \(recipientMode2 !== 'both'\) \{/);
  assert.ok(!/if \(!isValidString\(name1_2, 1, 60\) \|\| !isValidString\(name2_2, 1, 60\)\) \{\s*return res\.status\(400\)/.test(snippet), 'server.js nu mai trebuie sa respinga comanda pentru lipsa name1_2/name2_2');
});

test('db.js: recipient_names_2 e coloana JSONB, nullable, adaugata aditiv (ADD COLUMN IF NOT EXISTS)', () => {
  assert.match(dbjs, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_names_2 JSONB;/);
});

// ---------------------------------------------------------------------------------------------
// TEST 11: butonul final ramane blocat pana la completarea tuturor alegerilor.
// ---------------------------------------------------------------------------------------------
test('comanda.html: butonul "Continuă..." incepe disabled si e controlat DOAR de song2AllValid()', () => {
  assert.match(comanda, /<button type="submit" class="btn btn-primary" id="song2-continue-btn" disabled/);
  assert.match(comanda, /function song2AllValid\(\) \{/);
});

// MODIFICARE (2026-08-13, runda "Amândoi" fara campuri duplicate): numele (fie individual, fie
// "Amândoi", ex. "Maria și Victor") se introduce acum O SINGURA DATA, pe mini-pagina dedicata
// (pasul 7, song2-recipient-name) — song2AllValid() (pasul 6) NU mai valideaza niciun nume,
// indiferent daca rolul e "both" sau individual.
test('comanda.html: song2AllValid() (pasul 6) verifica genul (diferit de primul), alegerea same/other, SI (daca "other") ocazia si relatia/nunta — NU mai valideaza niciun nume (mutat integral in song2DetailsAllValid())', () => {
  const start = comanda.indexOf('function song2AllValid() {');
  const snippet = comanda.slice(start, start + 1400);
  assert.ok(snippet.includes("if (!genre2Input.value || genre2Input.value === genreInput.value) return false;"));
  assert.ok(snippet.includes("if (target !== 'same' && target !== 'other') return false;"));
  assert.ok(snippet.includes("if (!occasion) return false;"));
  assert.ok(snippet.includes("if (!song2WeddingTypeInput.value) return false;"));
  assert.ok(snippet.includes("if (!song2NuntaGroup) return false;"));
  assert.ok(snippet.includes("if (!song2RecipientRoleInput.value) return false;"));
  assert.ok(snippet.includes("const needsSenderRole = !!SENDER_ROLE_OPTIONS[song2RecipientRoleInput.value];"));
  assert.ok(!snippet.includes("if (!song2Name1Input.value.trim() || !song2Name2Input.value.trim()) return false;"), 'validarea "Amândoi" (name1/name2) NU mai trebuie sa fie in song2AllValid()');
  assert.ok(!snippet.includes("} else if (!song2RecipientNameInput.value.trim()) {"), 'verificarea numelui individual NU mai trebuie sa fie in song2AllValid() — s-a mutat in song2DetailsAllValid()');
});

test('comanda.html: song2DetailsAllValid() (mini-pagina, pasul 7) verifica numele (individual sau "Amândoi", necondiționat), expeditorul, relatia si povestea — toate proprii melodiei 2', () => {
  const start = comanda.indexOf('function song2DetailsAllValid() {');
  assert.ok(start !== -1);
  const snippet = comanda.slice(start, start + 700);
  assert.ok(snippet.includes('if (!song2RecipientNameInput.value.trim()) return false;'));
  assert.ok(snippet.includes('if (!song2SenderNameInput.value.trim()) return false;'));
  assert.ok(snippet.includes('if (!song2RelationshipInput.value.trim()) return false;'));
  assert.ok(snippet.includes('if (!song2StoryInput.value.trim()) return false;'));
});

// ---------------------------------------------------------------------------------------------
// TEST 12: refresh-ul pastreaza datele.
// ---------------------------------------------------------------------------------------------
test('comanda.html: saveDraft() persista toate campurile song2 (target, ocazie, rol, sender, mod, nunta, nume)', () => {
  const start = comanda.indexOf('function saveDraft() {');
  const snippet = comanda.slice(start, start + 1800);
  assert.ok(snippet.includes('song2Target: song2TargetInput.value,'));
  assert.ok(snippet.includes('occasion2: song2OccasionInput.value,'));
  assert.ok(snippet.includes('recipientRole2: song2RecipientRoleInput.value,'));
  assert.ok(snippet.includes('senderRole2: song2SenderRoleInput.value,'));
  assert.ok(snippet.includes('recipientMode2: song2RecipientModeInput.value,'));
  assert.ok(snippet.includes('weddingType2: song2WeddingTypeInput.value,'));
  assert.ok(snippet.includes('song2NuntaType: song2NuntaType,'));
  assert.ok(snippet.includes('song2NuntaGroup: song2NuntaGroup,'));
  assert.ok(snippet.includes('song2RecipientName: song2RecipientNameInput.value,'));
  assert.ok(snippet.includes('song2Name1: song2Name1Input.value,'));
  assert.ok(snippet.includes('song2Name2: song2Name2Input.value'));
});

test('comanda.html: restoreDraft() reface toate campurile song2 INAINTE de refreshSong2OtherUI()', () => {
  const start = comanda.indexOf('function restoreDraft() {');
  const end = comanda.indexOf('refreshSong2OtherUI();', start);
  assert.ok(start !== -1 && end !== -1);
  const snippet = comanda.slice(start, end);
  assert.ok(snippet.includes("if (draft.song2Target) song2TargetInput.value = draft.song2Target;"));
  assert.ok(snippet.includes('if (draft.occasion2) song2OccasionInput.value = draft.occasion2;'));
  assert.ok(snippet.includes('if (draft.recipientRole2) song2RecipientRoleInput.value = draft.recipientRole2;'));
  assert.ok(snippet.includes('if (draft.senderRole2) song2SenderRoleInput.value = draft.senderRole2;'));
  assert.ok(snippet.includes('if (draft.weddingType2) song2WeddingTypeInput.value = draft.weddingType2;'));
});

test('comanda.html: numarul pasului salvat (STEP_KEY) foloseste getTotalSteps() ca limita, deci pasul 5/6 poate fi restaurat corect pentru Premium', () => {
  assert.match(comanda, /if \(savedStep >= 1 && savedStep <= getTotalSteps\(\)\) restoredStep = savedStep;/);
});

// ---------------------------------------------------------------------------------------------
// TEST 13: dublul click nu creeaza joburi duplicate.
// ---------------------------------------------------------------------------------------------
test('server.js: claimOrderForInitialGeneration (preluare atomica) ramane neschimbata — protejeaza si comenzile Premium noi', () => {
  assert.match(server, /const claimed = await db\.claimOrderForInitialGeneration\(order\.id, credits\.MAX_GENERATION_ATTEMPTS\);\s*if \(!claimed\) \{\s*return res\.status\(409\)/);
});

test('db.js: claimOrderForInitialGeneration foloseste UPDATE...WHERE...RETURNING atomic, exclude comenzi deja in curs/gata', () => {
  assert.match(dbjs, /async function claimOrderForInitialGeneration\(orderId, maxAttempts\) \{/);
  const start = dbjs.indexOf('async function claimOrderForInitialGeneration');
  const snippet = dbjs.slice(start, start + 500);
  assert.match(snippet, /WHERE id = \$1\s*AND status NOT IN \('generating', 'processing_provider_result', 'ready'\)/);
});

test('comanda.html: butonul de trimitere e dezactivat imediat la primul click (previne dublul-click, comportament existent, neschimbat)', () => {
  assert.match(comanda, /activeBtn\.disabled = true;/);
});

// ---------------------------------------------------------------------------------------------
// TEST 14: Premium genereaza exact doua melodii.
// ---------------------------------------------------------------------------------------------
// REVIZUIT (2026-08-14): PLAN_VARIANT_COUNT.premium ramane neschimbat (2); video a fost
// corectat intentionat de la 2 la 1 ("Cadou video: o singura melodie initiala + o editare",
// vezi test/video-single-song-edit.test.js) — nu afecteaza Premium.
test('server.js: PLAN_VARIANT_COUNT.premium ramane exact 2 (neschimbat)', () => {
  assert.match(server, /const PLAN_VARIANT_COUNT = \{ standard: 1, premium: 2, video: 1 \};/);
});

test('server.js: runGeneration dual-genre porneste exact DOUA cereri Suno in paralel, cu snapshot-uri distincte per melodie', () => {
  assert.match(server, /const promptGenre1 = buildPrompt\(order, feedback, order\.genre\);/);
  assert.match(server, /const promptGenre2 = buildPrompt\(\{ \.\.\.order, \.\.\.getSong2EffectiveData\(order\) \}, feedback, order\.genre2\);/);
  assert.match(server, /const \[taskId1, taskId2\] = await Promise\.all\(\[/);
});

// ---------------------------------------------------------------------------------------------
// TEST 15: dupa plata simulata, ambele melodii sunt livrate.
// ---------------------------------------------------------------------------------------------
test('server.js: waitForDualTaskAndFinalize construieste doua variante finale, fiecare cu recipientSnapshot propriu', () => {
  const idx = server.indexOf('async function waitForDualTaskAndFinalize');
  const snippet = server.slice(idx, idx + 1800);
  assert.match(snippet, /\{ tracks: r1\.tracks, genre: genre1, taskId: taskId1, recipientSnapshot: getSong1EffectiveData\(fresh\), songSlot: 1 \}/);
  assert.match(snippet, /\{ tracks: r2\.tracks, genre: genre2, taskId: taskId2, recipientSnapshot: getSong2EffectiveData\(fresh\), songSlot: 2 \}/);
});

test('server.js: Premium/Video esecul PARTIAL (o singura melodie reusita) e tratat ca esec TOTAL — "exact doua melodii" ramane o promisiune ferma, neschimbata', () => {
  assert.match(server, /if \(requestsInfo\.length > 1 && builtVariants\.length < requestsInfo\.length && !options\.replaceVariantId\) \{/);
});

// ---------------------------------------------------------------------------------------------
// TEST 16: toate textele exista in cele 8 limbi.
// ---------------------------------------------------------------------------------------------
[
  'premium_summary_title', 'song2_config_title', 'badge_required', 'song2_genre_section_title',
  'song2_first_genre_label', 'song2_target_section_title', 'song2_same_person', 'song2_other_person',
  'song2_recipient_name_label', 'val_song2_target', 'val_song2_recipient_name', 'song2_continue_btn'
].forEach(key => {
  test(`comanda.html: cheia "${key}" exista exact de 8 ori (o data per limba)`, () => {
    const re = new RegExp(`\\n\\s*${key}:`, 'g');
    assert.equal((comanda.match(re) || []).length, 8, `"${key}" trebuie sa existe o data per limba`);
  });
});

test('comanda.html: benefits_premium (lista de beneficii) reflecta cerintele adevarate ale pachetului, in toate cele 8 limbi', () => {
  assert.equal((comanda.match(/benefits_premium: \[/g) || []).length, 8);
});

test('server.js: MISSING_FIELD_MESSAGES.song2Target exista in toate cele 8 limbi', () => {
  const start = server.indexOf('song2Target: {');
  const snippet = server.slice(start, start + 400);
  ['ro:', 'en:', 'de:', 'es:', 'it:', 'fr:', 'bg:', 'tr:'].forEach(langKey => {
    assert.ok(snippet.includes(langKey), `lipseste mesajul pentru limba ${langKey}`);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 17: Standard si Cadou video au ramas neschimbate.
// ---------------------------------------------------------------------------------------------
test('server.js: PLAN_PRICES ramane exact neschimbat', () => {
  assert.match(server, /const PLAN_PRICES = \{ standard: 15, premium: 25, video: 35 \};/);
});

// REVIZUIT (2026-08-14, "Cadou video: o singura melodie initiala + o editare"): Video nu mai
// are nevoie de un al doilea gen la crearea comenzii — vezi test/video-single-song-edit.test.js.
test('comanda.html: planNeedsGenre2 e acum STRICT Premium (Video nu mai cere al doilea gen la validarea finala)', () => {
  assert.match(comanda, /function planNeedsGenre2\(planId\) \{\s*return planId === 'premium';\s*\}/);
});

test('comanda.html: genre2Field revine la locul lui original (pasul 4) pentru orice plan diferit de premium — Video foloseste EXACT acelasi camp, in acelasi loc, ca inainte', () => {
  assert.match(comanda, /const genre2FieldOriginalParent = genre2Field\.parentElement;/);
  assert.match(comanda, /if \(genre2Field\.parentElement !== genre2FieldOriginalParent\) \{\s*genre2FieldOriginalParent\.appendChild\(genre2Field\);\s*\}/);
});

test('buildPrompt: Video (fara song2Target) foloseste identic datele principale pentru AMBELE melodii, exact ca inainte de aceasta modificare', () => {
  const order = premiumOrder({ plan: 'video', song2Target: null, recipientRole2: null, recipient2: null });
  const prompt1 = buildPrompt(order, '', order.genre);
  const prompt2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, '', order.genre2);
  assert.ok(prompt1.includes('Recipient: Maria.') && prompt2.includes('Recipient: Maria.'));
  assert.ok(prompt1.includes('"mother"') && prompt2.includes('"mother"'));
});

test('server.js: FAMILY_OCCASION_RECIPIENT_ROLES / FAMILY_BOTH_ROLES / relatiile familiale existente raman EXACT neschimbate', () => {
  assert.match(server, /bunici: \['grandmother', 'grandfather', 'grandparents'\]/);
  assert.match(server, /parinti: \['mother', 'father', 'parents'\]/);
  assert.match(server, /'matusa-unchi': \['aunt', 'uncle', 'aunt_uncle'\]/);
  assert.match(server, /socri: \['mother_in_law', 'father_in_law', 'parents_in_law'\]/);
  assert.match(server, /frati: \['sister', 'brother'\]/);
  assert.match(server, /const FAMILY_BOTH_ROLES = \['grandparents', 'parents', 'aunt_uncle', 'parents_in_law'\];/);
});

// ---------------------------------------------------------------------------------------------
// TESTE NOI — CORECȚIE STRICTĂ, configurarea pachetului Premium (hotfix 2026-08-10).
// ---------------------------------------------------------------------------------------------

test('comanda.html: culorile celor doua sectiuni obligatorii (.mandatory-section/.required-badge) folosesc EXACT valorile deja existente in Standard (rgba(168,131,75,.07)/.12 + var(--gold)/var(--gold-deep)), nicio culoare noua', () => {
  assert.match(comanda, /\.mandatory-section\{\s*background:rgba\(168,131,75,\.07\); border:1px solid var\(--gold\); border-radius:14px;/);
  assert.match(comanda, /\.required-badge\{\s*display:inline-block; background:rgba\(168,131,75,\.12\); color:var\(--gold-deep\);/);
  // Aceleasi valori exacte deja folosite de starea "activ" a cardurilor Standard.
  assert.match(comanda, /\.theme-card\.active\{ border-color:var\(--gold\); background:rgba\(168,131,75,\.07\); \}/);
});

test('comanda.html: refreshSong2OtherUI() comuta explicit cardurile same\\/other SI vizibilitatea panoului (regresie: fara aceste linii, "Pentru altă persoană" nu afiseaza niciodata panoul)', () => {
  const start = comanda.indexOf('function refreshSong2OtherUI() {');
  const snippet = comanda.slice(start, start + 300);
  assert.ok(snippet.includes("song2SameCard.classList.toggle('active', song2TargetInput.value === 'same');"));
  assert.ok(snippet.includes("song2OtherCard.classList.toggle('active', song2TargetInput.value === 'other');"));
  assert.ok(snippet.includes("song2OtherPanel.style.display = song2TargetInput.value === 'other' ? 'block' : 'none';"));
});

test('comanda.html/server.js: nicio referinta ramasa la variabila/functia vechi song2Category / refreshSong2UI (inlocuite complet de sistemul cu 13 ocazii)', () => {
  assert.ok(!comanda.includes('song2Category'), 'song2Category nu mai trebuie sa existe nicaieri — ar produce ReferenceError la saveDraft()');
  assert.ok(!comanda.includes('refreshSong2UI()'), 'functia veche a fost redenumita refreshSong2OtherUI()');
  assert.ok(!comanda.includes('SONG2_CATEGORIES'), 'lista veche de 5 categorii a fost inlocuita de ALL_OCCASIONS_ORDERED');
});

test('buildPrompt + getSong2EffectiveData: occasion2="nunta" foloseste weddingType2/recipientRole2 proprii pentru a doua melodie, independent de ocazia principala', () => {
  const order = premiumOrder({
    song2Target: 'other', occasion2: 'nunta', weddingType2: 'wedding', recipientRole2: 'bride',
    recipient2: 'Elena', recipientMode2: 'single', recipientNames2: null
  });
  const song2Data = getSong2EffectiveData(order);
  assert.equal(song2Data.occasion, 'nunta');
  assert.equal(song2Data.weddingType, 'wedding');
  const prompt2 = buildPrompt({ ...order, ...song2Data }, '', order.genre2);
  assert.ok(prompt2.includes('Recipient: Elena.'), `a produs: ${prompt2}`);
});

test('server.js: POST /api/orders valideaza weddingType2/recipientRole2 pentru occasion2="nunta" cu EXACT aceleasi reguli ca ocazia principala (WEDDING_TYPE_ALLOWED_ROLES)', () => {
  const idx = server.indexOf("} else if (occasion2 === 'nunta') {");
  assert.ok(idx !== -1, 'ramura nunta pentru occasion2 trebuie sa existe');
  const snippet = server.slice(idx, idx + 700);
  assert.match(snippet, /if \(weddingType2 !== 'wedding' && weddingType2 !== 'baptism'\) \{/);
  assert.match(snippet, /const allowedRolesForType2 = WEDDING_TYPE_ALLOWED_ROLES\[weddingType2\];/);
});

test('buildPrompt + getSong2EffectiveData: occasion2 generic (ex. "dor") nu cere recipientRole2/senderRole2 — doar numele destinatarului', () => {
  const order = premiumOrder({
    song2Target: 'other', occasion2: 'dor', recipientRole2: null, senderRole2: null,
    recipient2: 'Vasile', recipientMode2: null, recipientNames2: null
  });
  const song2Data = getSong2EffectiveData(order);
  assert.equal(song2Data.occasion, 'dor');
  assert.equal(song2Data.recipient, 'Vasile');
  const prompt2 = buildPrompt({ ...order, ...song2Data }, '', order.genre2);
  assert.ok(prompt2.includes('Recipient: Vasile.'), `a produs: ${prompt2}`);
  assert.ok(prompt2.includes('Occasion: missing someone.'));
});

test('server.js: getSong2EffectiveData() se activeaza pe baza lui order.occasion2 (nu order.recipientRole2) — ocaziile generice, fara recipientRole2, tot trebuie sa isi foloseasca propriile date', () => {
  const idx = server.indexOf('function getSong2EffectiveData(order) {');
  const snippet = server.slice(idx, idx + 200);
  assert.match(snippet, /if \(order\.plan === 'premium' && order\.song2Target === 'other' && order\.occasion2\) \{/);
});

test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});

test('db.js: node --check db.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'db.js')]));
});
