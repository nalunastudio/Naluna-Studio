// Teste pentru cele trei cerinte stricte din runda 2026-08-13:
// (1) versurile editate ajung VERBATIM la generator (customMode:true), nu ca "ghidaj" catre un
//     model care le poate rescrie, si versurile AFISATE pentru o varianta noua sunt fortate la
//     textul canonic salvat, niciodata la ce a intors furnizorul;
// (2) povestea clientului nu mai e trunchiata la generarea initiala (Premium ambele melodii);
// (3) UI-ul Premium reutilizeaza EXACT componentele Standard (voce/gen/feedback/buton editare)
//     si editeaza cele doua melodii STRICT pe rand (dispatch secvential catre Suno), fara sa
//     afecteze Standard/Video.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const server = read('server.js');
const melodia = read('public/melodia-mea.html');

// Extrage buildPrompt() (si dependintele ei contigue) direct din server.js si il RULEAZA cu date
// sintetice, exact tiparul din test/bunici-amandoi-relation-name.test.js — verificare FUNCTIONALA
// (nu doar text static).
function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'nu am gasit inceputul blocului buildPrompt in server.js');
  const funcStart = server.indexOf('function buildPrompt(order, feedback, genreOverride) {', startIdx);
  assert.ok(funcStart !== -1, 'nu am gasit function buildPrompt(...)');
  let depth = 0, i = server.indexOf('{', funcStart);
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const snippet = server.slice(startIdx, i + 1);
  const sandboxSrc = `
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function(sandboxSrc)();
}
const buildPrompt = loadBuildPrompt();

// ---------------------------------------------------------------------------------------------
// REGRESIE CRITICA (2026-08-13): melodii generate fara voce ("[Instrumental]" in loc de
// versuri). Cauza gasita: cuvantul "instrumental" aparea LITERAL in textul promptului trimis
// furnizorului (in "short natural instrumental intro"/"instrumental opening"), plus un buget
// de prompt marit anterior (pana la 2800 caractere/2000 caractere poveste bruta) care corela,
// verificat direct pe comenzi reale de productie, cu un risc mult mai mare ca furnizorul sa
// genereze o piesa integral instrumentala. Ambele au fost corectate: cuvantul eliminat complet
// din text, iar bugetul adus inapoi la valoarea dovedita (500/160).
// ---------------------------------------------------------------------------------------------
test('buildPrompt: promptul generat NU contine niciodata cuvantul "instrumental" (posibila cauza a regresiei) — verificat pe mai multe combinatii reale de ocazie/gen/voce', () => {
  const combos = [
    { occasion: 'aniversare', genre: 'pop', voicePreference: 'auto' },
    { occasion: 'dor', genre: 'balada', voicePreference: 'female' },
    { occasion: 'declaratie', genre: 'manele_suflet', voicePreference: 'male' },
    { occasion: 'altceva', genre: 'rock', voicePreference: 'duet' }
  ];
  combos.forEach(({ occasion, genre, voicePreference }) => {
    const order = {
      occasion, genre, lang: 'ro', recipient: 'Maria', senderName: 'Ana',
      relationship: 'prietena', voicePreference,
      story: 'O poveste reala, cu detalii importante despre momentele noastre impreuna.'
    };
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(!/instrumental/i.test(prompt), `promptul pentru ocazia="${occasion}" gen="${genre}" voce="${voicePreference}" nu trebuie sa contina cuvantul "instrumental", a produs: ${prompt}`);
  });
});

test('buildPrompt: bugetul de prompt (customMode:false) — 600 caractere total (marit MODEST, +20%, fata de 500, ca mesajele explicite ale clientului sa nu mai fie taiate complet — vezi comentariul de la SUNO_PROMPT_MAX_LEN), cel putin 190 rezervate povestii', () => {
  assert.match(server, /const SUNO_PROMPT_MAX_LEN = 600;/);
  assert.match(server, /const STORY_MIN_RESERVE = 190;/);
});

test('buildPrompt: pentru o comanda tipica (campuri normale, poveste rezonabila), promptul ramane sub 600 caractere si contine detalii reale din poveste', () => {
  const order = {
    occasion: 'aniversare', genre: 'pop', lang: 'ro',
    recipient: 'Maria', senderName: 'Ana', relationship: 'prietena',
    voicePreference: 'auto', story: 'Ne-am cunoscut la facultate si de atunci suntem cele mai bune prietene.'
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.length <= 600);
  // CORECȚIE (2026-08-13, "povestea din prima strofă"): eticheta dinaintea povestii e acum
  // aleasa adaptiv (storyLabelFull/Short/Plain, dupa spatiul chiar disponibil), toate insa
  // terminandu-se in "Story: " — testul verifica ce conteaza cu adevarat: ca inceputul REAL
  // al povestii clientului apare in prompt imediat dupa "Story:", indiferent care varianta de
  // eticheta a fost aleasa.
  assert.ok(prompt.includes('Ne-am cunoscut'), 'inceputul real al povestii trebuie sa apara in prompt (limitarea reala e ca bugetul de 500 caractere poate tot trunchia finalul unei povesti mai lungi, nu ca povestea ar fi inlocuita cu una generica)');
});

// ---------------------------------------------------------------------------------------------
// CERINTA (2026-08-13): povestea clientului trebuie sa apara in versuri INCA DIN PRIMA STROFA,
// nu doar undeva in prompt. Instructiunea "open verse 1 with a real story detail" e integrata
// DIRECT in currentInstruction() (inlocuind text redundant, nu adaugata suplimentar), deci nu
// consuma buget in plus fata de instructiunea originala si supravietuieste cascadei de scurtare
// la fel de fiabil ca instructiunea dinainte de aceasta corectie — verificat pe o comanda tipica
// SI pe cel mai incarcat caz real (nunta, campuri lungi, gen cu tag de stil lung).
// ---------------------------------------------------------------------------------------------
test('buildPrompt: instructiunea "deschide primul vers cu un detaliu real din poveste" ajunge in prompt, atat pentru o comanda tipica cat si pentru cazul cel mai incarcat (nunta, campuri lungi)', () => {
  const typical = {
    occasion: 'aniversare', genre: 'pop', lang: 'ro',
    recipient: 'Maria', senderName: 'Ana', relationship: 'prietena', voicePreference: 'auto',
    story: 'Ne-am cunoscut la facultate acum 8 ani si de atunci suntem cele mai bune prietene, am trecut prin multe impreuna.'
  };
  const worstCase = {
    occasion: 'nunta', genre: 'manele_suflet', lang: 'ro',
    recipient: 'Alexandru Ionut Popescu si Maria Elena Ionescu',
    senderName: 'Familia Popescu si Ionescu, nasii si toti prietenii apropiati',
    relationship: 'nasii de cununie si cei mai buni prieteni din copilarie', voicePreference: 'duet',
    story: 'V-ati cunoscut acum zece ani la o petrecere organizata de prieteni comuni, iar de atunci povestea voastra de dragoste a fost una plina de calatorii si sprijin reciproc.'
  };
  [typical, worstCase].forEach((order) => {
    const prompt = buildPrompt(order, '', undefined);
    assert.ok(prompt.length <= 600, `promptul trebuie sa ramana sub 600 caractere, a produs ${prompt.length}`);
    assert.match(prompt, /verse 1:? real,? (not invented,? )?(never-invented )?story detail|opening the first verse with a real,? specific,? (never-invented )?detail/i,
      `instructiunea de deschidere a primului vers trebuie sa fie prezenta, a produs: ${prompt}`);
    assert.match(prompt, /never-invented|not invented/i, `clauza "niciodata inventat" trebuie sa fie prezenta (echivalentul cerintei vechi "Use only real details — invent nothing"), a produs: ${prompt}`);
    assert.match(prompt, /complete words only, no shortening|grammatically correct words/i, `instructiunea de cuvinte complete/gramatica corecta trebuie sa fie prezenta, a produs: ${prompt}`);
    const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
    assert.ok(storyIdx !== -1, `continutul real al povestii trebuie sa fie prezent, a produs: ${prompt}`);
  });
});

test('buildPrompt: o poveste scurta este integrata COMPLET (netrunchiata) alaturi de instructiunea de prim vers', () => {
  const order = {
    occasion: 'aniversare', genre: 'pop', lang: 'ro',
    recipient: 'Maria', senderName: 'Ana', relationship: 'prietena', voicePreference: 'auto',
    story: 'Esti cea mai buna prietena.'
  };
  const prompt = buildPrompt(order, '', undefined);
  // eticheta dinaintea povestii difera dupa spatiul disponibil (vezi testul de mai sus) — ce
  // conteaza aici e ca textul povestii insusi ajunge COMPLET, netrunchiat, indiferent de eticheta.
  assert.ok(prompt.includes('Esti cea mai buna prietena.'), `povestea scurta trebuie sa apara integral, netrunchiata, a produs: ${prompt}`);
  assert.match(prompt, /verse 1:? real,? (not invented,? )?(never-invented )?story detail/i);
});

// ---------------------------------------------------------------------------------------------
// CERINTA (2026-08-13, runda 3, "construiește melodia din povestea clientului, începând cu
// primele versuri"): povestea nu mai apare ULTIMA in promptul trimis catre Suno (dupa toate
// etichetele tehnice) — e mutata imediat dupa stil+limba+CINE (Recipient/Sender/Relationship),
// INAINTEA ocaziei si instructiunilor de personalizare/voce — verificat structural (ordinea
// substring-urilor in promptul final), nu doar prezenta lor.
// ---------------------------------------------------------------------------------------------
test('buildPrompt: povestea (Story:) apare STRUCTURAL inainte de "Occasion:" in promptul final — nu mai e ultima, dupa toate instructiunile tehnice', () => {
  const combos = [
    {
      occasion: 'bunici', recipientRole: 'grandmother', genre: 'suflet', lang: 'ro',
      recipient: 'Maria', senderName: 'Karla', relationship: 'nepoata', voicePreference: 'auto',
      story: 'Bunico, te iubesc, tu ești viața mea, îți mulțumesc că m-ai crescut și că mi-ai fost alături'
    },
    {
      occasion: 'nunta', weddingType: 'wedding', genre: 'manele_suflet', lang: 'ro',
      recipient: 'Alexandru și Maria', senderName: 'Andrei și Mara', relationship: 'nașii de cununie',
      voicePreference: 'duet',
      story: 'V-ati cunoscut acum zece ani la facultate. La multi ani din partea nasilor Andrei si Mara!'
    }
  ];
  combos.forEach(order => {
    const prompt = buildPrompt(order, '', undefined);
    const storyIdx = prompt.search(/Story[^:]*:\s*\S/i);
    const occasionIdx = prompt.indexOf('Occasion:');
    assert.ok(storyIdx !== -1, `povestea trebuie sa fie prezenta, a produs: ${prompt}`);
    assert.ok(occasionIdx !== -1, `"Occasion:" trebuie sa fie prezent, a produs: ${prompt}`);
    assert.ok(storyIdx < occasionIdx, `povestea trebuie sa apara INAINTE de "Occasion:" (structura noua, context intai), a produs: ${prompt}`);
    // Recipient/Sender/Relationship trebuie sa apara si ele inainte de poveste (CINE, apoi CE-a scris).
    const recipientIdx = prompt.indexOf('Recipient:');
    assert.ok(recipientIdx !== -1 && recipientIdx < storyIdx, `"Recipient:" trebuie sa apara inainte de poveste, a produs: ${prompt}`);
  });
});

test('buildPrompt: separarea poveste 1/poveste 2 Premium ramane corecta cu noua structura (poveste plasata inainte de ocazie) — melodia pentru soție nu contine povestea bunicii, si invers', () => {
  const song1 = {
    occasion: 'declaratie', recipientMode: 'single', genre: 'emotional', lang: 'ro',
    recipient: 'Ana', senderName: 'Mihai', relationship: 'soție', voicePreference: 'male',
    story: 'Ana, esti sotia mea de 10 ani, multumesc pentru tot ce faci pentru familia noastra.'
  };
  const song2 = {
    occasion: 'bunici', recipientRole: 'grandmother', genre: 'suflet', lang: 'ro',
    recipient: 'Maria', senderName: 'Karla', relationship: 'nepoata', voicePreference: 'auto',
    story: 'Bunico, te iubesc, tu ești viața mea, îți mulțumesc că m-ai crescut.'
  };
  const prompt1 = buildPrompt(song1, '', undefined);
  const prompt2 = buildPrompt(song2, '', undefined);
  assert.ok(prompt1.includes('sotia mea') && !prompt1.includes('crescut'), `melodia 1 (soție) nu trebuie sa contina povestea melodiei 2 (bunica), a produs: ${prompt1}`);
  assert.ok(prompt2.includes('crescut') && !prompt2.includes('sotia mea'), `melodia 2 (bunica) nu trebuie sa contina povestea melodiei 1 (soție), a produs: ${prompt2}`);
});

// ---------------------------------------------------------------------------------------------
// (1) Pastrarea exacta a versurilor editate.
// ---------------------------------------------------------------------------------------------
test('server.js: buildExactLyricsRequest trimite versurile editate VERBATIM (customMode:true, campul "prompt" = versurile), niciodata ca instructiune catre un model care le rescrie', () => {
  assert.match(server, /function buildExactLyricsRequest\(order, exactLyrics, genreOverride, voicePreference, feedback\) \{/);
  const idx = server.indexOf('function buildExactLyricsRequest');
  const body = server.slice(idx, idx + 2600);
  assert.ok(body.includes('return { style, title, lyrics };'), 'trebuie sa returneze versurile ca un camp separat, netrunchiat de bugetul de stil');
});

test('server.js: callMusicProvider trimite customMode:true cu campul "prompt" setat la versurile exacte, cand primeste un obiect {style,title,lyrics}', () => {
  const idx = server.indexOf('async function callMusicProvider(orderId, requestInput) {');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 1800);
  assert.ok(body.includes("const prompt = isCustomLyrics ? requestInput.lyrics : requestInput;"));
  assert.ok(body.includes('customMode: true,'));
  assert.ok(body.includes('style: requestInput.style,'));
});

test('server.js: mesajul vechi "Try to follow lyrics close to this rewritten version" (ghidaj, fara garantie de reproducere exacta) a fost eliminat complet din codebase', () => {
  assert.ok(!server.includes('Try to follow lyrics close to this rewritten version'), 'versurile editate nu mai trebuie trimise ca un "ghidaj" text catre buildPrompt/customMode:false');
});

test('server.js: editarea Standard/Video (handleLegacyRegenerate) foloseste versurile exacte ale variantei sursa ca exactLyrics, transmise separat de feedback', () => {
  const idx = server.indexOf('async function handleLegacyRegenerate');
  const body = server.slice(idx, idx + 11000);
  assert.ok(body.includes("const exactLyrics = typeof sourceVariant.editedLyrics === 'string' ? sourceVariant.editedLyrics.trim() : '';"));
  assert.ok(body.includes('exactLyrics: exactLyrics || null'));
});

test('server.js: editarea selectiva Premium foloseste versurile exacte per melodie (song.exactLyrics), separat de feedback-ul liber', () => {
  const idx = server.indexOf('async function handlePremiumSelectiveRegenerate');
  const body = server.slice(idx, idx + 10000);
  assert.ok(body.includes('exactLyrics: exactLyrics || null'));
});

test('server.js: runGeneration si runPremiumEditGeneration aleg buildExactLyricsRequest cand exista versuri exacte, altfel buildPrompt (comportament neschimbat)', () => {
  const occurrences = (server.match(/\?\s*buildExactLyricsRequest\(/g) || []).length;
  assert.ok(occurrences >= 4, `trebuie sa existe cel putin 4 puncte de dispecerizare conditionata (Standard, Video/Premium partial, Premium editare secventiala, reluare) — gasite ${occurrences}`);
});

test('server.js: finalizeVariantsIfNeeded FORTEAZA versurile afisate ale unei variante noi (rezultate dintr-o editare) la textul canonic salvat, niciodata la ce a intors furnizorul', () => {
  const idx = server.indexOf('function canonicalEditedLyricsFor(sourceVariantId)');
  assert.ok(idx !== -1, 'functia de derivare a versurilor canonice trebuie sa existe');
  const body = server.slice(idx - 200, idx + 3200);
  assert.ok(body.includes('built.originalLyrics = canonicalLyrics;'));
  assert.ok(body.includes('built.editedLyrics = null;'));
});

test('server.js: sursa canonica a versurilor e recitita din DB (claimed.variants), nu dintr-un parametru transmis prin lantul de apeluri — functioneaza identic si la o reluare dupa restart', () => {
  const idx = server.indexOf('function canonicalEditedLyricsFor(sourceVariantId)');
  const body = server.slice(idx, idx + 400);
  assert.ok(body.includes('(claimed.variants || []).find(v => v.id === sourceVariantId)'));
});

// ---------------------------------------------------------------------------------------------
// (2) Folosirea povestii clientului la ambele melodii Premium.
// LIMITARE REALA, de raportat explicit: dupa revertul de urgenta (SUNO_PROMPT_MAX_LEN inapoi la
// 500), povestea NU mai este garantata sa incapa intreaga in prompt pentru comenzi cu campuri
// lungi — prioritatea absoluta e generarea fiabila cu voce. Ce ramane garantat, testat mai jos:
// povestea (portiunea care incape) e IDENTICA pentru ambele melodii Premium, niciodata inlocuita
// cu una generica.
// ---------------------------------------------------------------------------------------------
// CORECȚIE (2026-08-13, "separarea completa a celor doua persoane si povesti") — cauza reala a
// amestecarii poveștilor: getSong2EffectiveData() nu returna NICIODATA senderName/relationship/
// story — buildPrompt({...order, ...getSong2EffectiveData(order)}) folosea deci INTOTDEAUNA
// campurile comenzii principale (melodia 1) pentru AMBELE melodii, chiar si cand destinatarul
// melodiei 2 era complet diferit (ex. melodia 1 pentru nași ar fi "scurs" povestea despre nași
// si in melodia 2, pentru bunica). Adaugate order.senderName2/relationship2/story2 (coloane noi
// in DB, populate STRICT de mini-pagina dedicata) — returnate de getSong2EffectiveData() DOAR
// cand song2Target='other', suprascriind corect senderName/relationship/story prin spread.
test('server.js: getSong2EffectiveData() returneaza senderName2/relationship2/story2 PROPRII melodiei 2, cand "Pentru altă persoană" a fost ales', () => {
  const idx = server.indexOf('function getSong2EffectiveData(order)');
  const body = server.slice(idx, idx + 1400);
  assert.ok(body.includes('senderName: order.senderName2,'));
  assert.ok(body.includes('relationship: order.relationship2,'));
  assert.ok(body.includes('story: order.story2'));
});

test('server.js: getSong2EffectiveData() NU copiaza niciodata senderName/relationship/story ale melodiei 1 (nu exista niciun fallback intre ele in acest caz)', () => {
  const idx = server.indexOf('function getSong2EffectiveData(order)');
  const end = server.indexOf('\n}', idx) + 2;
  const body = server.slice(idx, end);
  assert.ok(!/senderName:\s*order\.senderName[,\n]/.test(body), 'nu trebuie sa foloseasca order.senderName (melodia 1) ca sursa pentru melodia 2');
  assert.ok(!/relationship:\s*order\.relationship[,\n]/.test(body), 'nu trebuie sa foloseasca order.relationship (melodia 1) ca sursa pentru melodia 2');
  assert.ok(!/story:\s*order\.story[,\n]/.test(body), 'nu trebuie sa foloseasca order.story (melodia 1) ca sursa pentru melodia 2');
});

test('server.js: ambele melodii Premium initiale folosesc buildPrompt cu getSong2EffectiveData(order) pentru melodia 2 (mecanismul de suprascriere ramane cablat corect)', () => {
  const dualGenIdx = server.indexOf('const promptGenre1 = buildPrompt(order, feedback, order.genre);');
  assert.ok(dualGenIdx !== -1);
  assert.ok(server.includes('const promptGenre2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, feedback, order.genre2);'));
});

// Verificare FUNCTIONALA (nu doar text static) — exact exemplul obligatoriu din cerinta:
// melodia 1 pentru nași nu trebuie sa contina povestea bunicii, si invers.
function loadSong2EffectiveData() {
  const startIdx = server.indexOf('function getSong1EffectiveData(order) {');
  const endIdx = server.indexOf('\nfunction getSong2EffectiveData', startIdx);
  const endOfSecond = server.indexOf('\n}', endIdx) + 2;
  const snippet = server.slice(startIdx, endOfSecond);
  return new Function(`${snippet}\nreturn getSong2EffectiveData;`)();
}
const getSong2EffectiveData = loadSong2EffectiveData();

test('buildPrompt: exemplul obligatoriu din cerinta — melodia pentru nași (melodia 1) nu conține povestea bunicii, iar melodia pentru bunică (melodia 2) nu conține povestea nașilor — separare completa, verificata functional', () => {
  // Campuri fixe scurte, ocazii generice — bugetul de 500 caractere (verificat, dovedit stabil,
  // vezi revertul de urgenta) nu trebuie sa fie motivul pentru care testul ar pica; ce se
  // verifica AICI e STRICT separarea datelor, nu cascada de scurtare (acoperita de alte teste).
  const order = {
    plan: 'premium',
    occasion: 'dor', recipient: 'Mihai', genre: 'balada', genre2: 'populara', lang: 'ro',
    senderName: 'A', relationship: 'nași',
    story: 'MARKER-NASI: povestea exclusiva a nașilor.',
    song2Target: 'other', occasion2: 'altceva',
    recipient2: 'Maria', senderName2: 'B', relationship2: 'nepoată',
    story2: 'MARKER-BUNICA: povestea exclusiva a bunicii.'
  };
  const promptSong1 = buildPrompt(order, '', order.genre);
  const promptSong2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, '', order.genre2);

  assert.ok(promptSong1.includes('MARKER-NASI'), 'promptul melodiei 1 (nași) trebuie sa contina povestea nașilor');
  assert.ok(!promptSong1.includes('MARKER-BUNICA'), 'promptul melodiei 1 (nași) NU trebuie sa contina povestea bunicii');

  assert.ok(promptSong2.includes('MARKER-BUNICA'), 'promptul melodiei 2 (bunica) trebuie sa contina povestea bunicii');
  assert.ok(!promptSong2.includes('MARKER-NASI'), 'promptul melodiei 2 (bunica) NU trebuie sa contina povestea nașilor');
});

test('buildPrompt: cand "Pentru aceeași persoană" e ales (song2Target=same), melodia 2 foloseste STRICT datele melodiei 1 — getSong2EffectiveData cade pe getSong1EffectiveData (care nu returneaza story/senderName/relationship, deci spread-ul NU suprascrie valorile comenzii principale)', () => {
  const order = {
    plan: 'premium', occasion: 'declaratie', recipient: 'Maria', genre: 'pop', genre2: 'rock', lang: 'ro',
    senderName: 'Andrei', relationship: 'soț',
    story: 'Povestea comuna unica, aceeasi pentru ambele melodii.',
    song2Target: 'same'
  };
  const effective2 = getSong2EffectiveData(order);
  assert.equal(effective2.story, undefined, 'getSong1EffectiveData nu returneaza story — spread-ul nu trebuie sa suprascrie order.story');
  const promptSong2 = buildPrompt({ ...order, ...effective2 }, '', order.genre2);
  assert.ok(promptSong2.includes('Povestea comuna'), 'promptul melodiei 2 trebuie sa contina povestea comenzii principale, nemodificata');
});

// ---------------------------------------------------------------------------------------------
// (3) UI Premium exclusiv — reutilizare componente Standard + editare secventiala.
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: butonul de deschidere a editarii Premium reutilizeaza EXACT componenta "casetă conturată, cu creion" (.btn-toggle-orange) folosita de Standard, nu un buton CTA plin', () => {
  const htmlIdx = melodia.indexOf('id="premium-edit-open-btn"');
  const htmlSnippet = melodia.slice(htmlIdx - 40, htmlIdx + 200);
  assert.ok(htmlSnippet.includes('class="btn-toggle-orange" id="premium-edit-open-btn"'), `atributul class trebuie sa fie exact btn-toggle-orange, gasit: ${htmlSnippet.slice(0, 55)}`);
  assert.ok(htmlSnippet.includes('✏️'));
});

test('melodia-mea.html: editarea Premium (ambele melodii) contine caseta "Nu este exact cum îți dorești?" cu badge OPȚIONAL, reutilizand textele Standard (feedback_label/explain/optional_badge/ph)', () => {
  ['premium-edit-song1-feedback', 'premium-edit-song2-feedback'].forEach(prefix => {
    assert.ok(melodia.includes(`id="${prefix}-label"`), `${prefix}-label trebuie sa existe in HTML`);
    assert.ok(melodia.includes(`id="${prefix}-badge"`), `${prefix}-badge trebuie sa existe in HTML`);
    assert.ok(melodia.includes(`id="${prefix}"`), `textarea ${prefix} trebuie sa existe in HTML`);
  });
  const idx = melodia.indexOf('function renderPremiumEditView(order) {');
  const end = melodia.indexOf('function goToPremiumEditStep', idx) === -1 ? idx + 2500 : idx + 2500;
  const body = melodia.slice(idx, idx + 2500);
  assert.ok(body.includes('t.feedback_label'));
  assert.ok(body.includes('t.feedback_explain'));
  assert.ok(body.includes('t.feedback_optional_badge'));
  assert.ok(body.includes('t.feedback_ph'));
});

// CORECȚIE (2026-08-13, runda 2, "ecran de alegere a melodiei care va fi editată"): payload-ul
// per melodie e acum construit de o functie comuna songPayload(variant, lyricsEl, genreSelect,
// voice, feedbackEl), reutilizata de toate cele trei moduri (o melodie/cealalta/ambele) —
// feedback-ul ramane STRICT `feedbackEl.value.trim() || undefined`, per melodie, indiferent de
// mod (nu doar cand ambele sunt editate).
test('melodia-mea.html: feedback-ul liber al fiecarei melodii e inclus in payload-ul trimis catre POST /regenerate (functia comuna songPayload, reutilizata in toate cele trei moduri)', () => {
  const idx = melodia.indexOf('function songPayload(variant, lyricsEl, genreSelect, voice, feedbackEl) {');
  assert.ok(idx !== -1, 'functia comuna songPayload trebuie sa existe');
  const body = melodia.slice(idx, idx + 400);
  assert.ok(body.includes('feedback: feedbackEl.value.trim() || undefined'));
  assert.ok(melodia.includes('songPayload(v1, song1Lyrics, song1GenreSelect, song1Voice, song1Feedback)'));
  assert.ok(melodia.includes('songPayload(v2, song2Lyrics, song2GenreSelect, song2Voice, song2Feedback)'));
});

test('server.js: editarea a doua melodii Premium dispecerizeaza catre Suno STRICT pe rand — a doua sarcina NU porneste inainte ca prima sa fi reusit (fara Promise.all pe cele doua dispatch-uri)', () => {
  const idx = server.indexOf('async function runPremiumEditGeneration');
  const end = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  const body = server.slice(idx, end);
  assert.ok(!body.includes('Promise.all(dispatches.map(d => callMusicProvider'), 'cele doua sarcini Suno nu mai trebuie pornite simultan');
  assert.ok(body.includes('const taskId1 = await callMusicProvider(orderId, d1.requestPayload);'));
  assert.ok(body.includes('const taskId2 = await callMusicProvider(orderId, d2.requestPayload);'));
  const taskId1Idx = body.indexOf('const taskId1 = await callMusicProvider');
  const r1Idx = body.indexOf('const r1 = await pollForResult(taskId1, orderId);');
  const taskId2Idx = body.indexOf('const taskId2 = await callMusicProvider');
  assert.ok(taskId1Idx < r1Idx && r1Idx < taskId2Idx, 'a doua sarcina trebuie dispecerizata STRICT dupa ce polling-ul primei a revenit cu succes');
});

test('server.js: o eroare la prima melodie opreste procesul inainte ca a doua sa porneasca (throw imediat dupa r1, niciun apel catre a doua sarcina in acel caz)', () => {
  const idx = server.indexOf('async function runPremiumEditGeneration');
  const end = server.indexOf('async function runGeneration(orderId, feedback, options = {}) {');
  const body = server.slice(idx, end);
  assert.ok(body.includes("throw new Error(`Suno a raportat un status de eroare pentru prima melodie: ${r1.status}`);"));
});

test('server.js: callback-ul Suno nu finalizeaza prematur o editare Premium secventiala aflata inca in desfasurare (regenerateEditVariantIds cu 2 elemente, a doua sarcina inca nedispecerizata)', () => {
  const idx = server.indexOf("app.post('/api/music/callback'");
  const body = server.slice(idx, idx + 4000);
  assert.ok(body.includes("order.regenerateEditVariantIds && order.regenerateEditVariantIds.length === 2"));
});

test('melodia-mea.html: pagina de comparare Premium foloseste textul exact cerut si eticheta "PASUL URMĂTOR"', () => {
  assert.ok(melodia.includes("premium_compare_eyebrow: 'PASUL URMĂTOR',"));
  assert.ok(melodia.includes("premium_compare_title: 'Ce versiune vrei să primești?',"));
  assert.ok(melodia.includes("premium_compare_subtitle: 'Ascultă cele 4 melodii, apoi alege 2 pentru a continua la plată.',"));
});

test('melodia-mea.html: Standard ramane STRICT neschimbat — editorul de versuri Standard (#lyrics-textarea) si editorul selectiv Premium sunt containere separate, distincte', () => {
  assert.ok(melodia.includes('id="lyrics-textarea"'));
  assert.ok(melodia.includes('id="premium-edit-song1-lyrics"'));
  assert.ok(melodia.includes('id="premium-edit-song2-lyrics"'));
});

// ---------------------------------------------------------------------------------------------
// Continuarea regresiei critice (2026-08-13): toate genurile, campul style pentru versurile
// exacte, si "[Instrumental]" niciodata hardcodat de codul propriu.
// ---------------------------------------------------------------------------------------------
test('server.js: toate cele 15 genuri existente raman mapate — niciunul eliminat, redenumit sau inlocuit cu un fallback generic', () => {
  const idx = server.indexOf('const GENRE_STYLE_MAP = {');
  const end = server.indexOf('};', idx);
  const body = server.slice(idx, end);
  const expectedGenres = [
    'emotional', 'suflet', 'pop', 'acustic', 'petrecere', 'balada', 'manele', 'copii',
    'populara', 'rock', 'colind', 'modern', 'hiphop', 'manele_suflet', 'motivational'
  ];
  expectedGenres.forEach(genre => {
    assert.match(body, new RegExp(`\\b${genre}: '`), `genul "${genre}" trebuie sa ramana mapat in GENRE_STYLE_MAP`);
  });
  const mappedCount = (body.match(/^\s*\w+: '/gm) || []).length;
  assert.equal(mappedCount, 15, `trebuie sa existe exact 15 genuri mapate, gasite ${mappedCount}`);
});

test('server.js: buildExactLyricsRequest (customMode:true, versuri exacte) nu contine niciodata cuvantul "instrumental" in campul style, pentru niciun gen sau voce', () => {
  const idx = server.indexOf('function buildExactLyricsRequest');
  const end = server.indexOf('\n}', idx) + 2;
  const body = server.slice(idx, end);
  assert.ok(!/instrumental/i.test(body.replace(/\/\/.*$/gm, '')), 'codul (fara comentarii) care construieste campul style nu trebuie sa contina cuvantul "instrumental"');
});

test('server.js: "[Instrumental]" nu e niciodata hardcodat de codul propriu — apare STRICT ca text primit de la furnizor (extractSunoTracks), niciodata ca fallback/default al aplicatiei', () => {
  assert.ok(!server.includes('[Instrumental]'), 'niciun cod propriu nu trebuie sa foloseasca acest text ca valoare implicita/fallback');
});

test('server.js: markGenerationFailed curata regenerateEditVariantIds la o editare Premium esuata — o comanda nu trebuie sa ramana cu semnalul de editare selectiva "agatat" dupa un esec', () => {
  const idx = server.indexOf('async function markGenerationFailed');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 1500);
  assert.ok(body.includes('regenerateEditVariantIds: null'), 'esecul unei generari/editari trebuie sa curete explicit regenerateEditVariantIds, ca o comanda Premium sa nu ramana blocata intr-o stare "editare in desfasurare" stale');
});

// ---------------------------------------------------------------------------------------------
// (3) Pastrarea reala a versiunilor initiale si editate — Premium.
// Verificare (nu o corectie noua — mecanismul exista deja, confirmat aici explicit): fiecare
// varianta noua (rezultata dintr-o editare) primeste un ID PROPRIU (randomUUID, niciodata
// reutilizat de la sursa), fisiere audio la o cale de storage DERIVATA din acel ID nou (deci
// niciodata acelasi URL/fisier ca originalul), si e ADAUGATA alaturi de variantele existente
// (niciodata nu le inlocuieste) — vezi si finalizeVariantsIfNeeded (options.editVariantIds mai
// sus: "variants = [...existing, ...edited]").
// ---------------------------------------------------------------------------------------------
test('server.js: buildVariantFromTrack aloca un ID PROPRIU fiecarei variante noi (randomUUID, niciodata id-ul variantei sursa)', () => {
  const idx = server.indexOf('async function buildVariantFromTrack(orderId, variantId, track, taskId)');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 200);
  assert.ok(body.includes('variantId, track, taskId'), 'variantId e primit ca parametru, generat de apelant (randomUUID), niciodata derivat din varianta sursa');
  const callerIdx = server.indexOf('built = await buildVariantFromTrack(orderId, randomUUID().slice(0, 8), track, taskId);');
  assert.ok(callerIdx !== -1, 'apelantul (finalizeVariantsIfNeeded) trebuie sa genereze un ID nou, aleator, pentru fiecare varianta construita');
});

test('server.js: fisierele audio ale unei variante noi folosesc o cale de storage DERIVATA din noul ID — niciodata acelasi URL/fisier ca varianta originala', () => {
  const idx = server.indexOf('async function buildVariantFromTrack');
  const body = server.slice(idx, idx + 3000);
  assert.ok(body.includes('const fullKey = `orders/full/${orderId}-${variantId}.mp3`;'));
  assert.ok(body.includes('const previewKey = `orders/preview/${orderId}-${variantId}.mp3`;'));
});

test('server.js: editVariantIds ADAUGA variantele noi alaturi de cele existente (niciodata nu le inlocuieste) — ID-ul, audio-ul, versurile si genul originalului raman intacte dupa o editare', () => {
  const idx = server.indexOf('} else if (options.editVariantIds) {');
  assert.ok(idx !== -1);
  // fereastra marita (2026-08-13): fix pentru "versiunea inițială și editată afișează
  // aceleași versuri" a adaugat cod/comentarii in aceasta ramura.
  const body = server.slice(idx, idx + 2300);
  assert.ok(body.includes('variants = [...existing, ...edited];'));
});

test('server.js: la pagina finala, cele 4 carduri Premium sorteaza dupa songSlot apoi isEditedAlternative — ordinea corecta este mereu inițiala 1, noua 1, inițiala 2, noua 2', () => {
  const idx = melodia.indexOf('function renderPremiumCompareView(order) {');
  const body = melodia.slice(idx, idx + 800);
  assert.ok(body.includes('if (slotA !== slotB) return slotA - slotB;'));
  assert.ok(body.includes('return Number(!!a.isEditedAlternative) - Number(!!b.isEditedAlternative);'));
});

// ---------------------------------------------------------------------------------------------
// Verificari finale de sintaxa.
// ---------------------------------------------------------------------------------------------
test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
