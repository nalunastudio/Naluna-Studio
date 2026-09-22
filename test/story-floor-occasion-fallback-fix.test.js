// BUG REAL DE PRODUCTIE (2026-09-14), comanda 400d4a20-327c-44c0-8efb-c122385bf311 (video, RO,
// gen "populara", ocazie "bunici", expeditor "Natalia" -> destinatar "Maria"): povestea clientului
// ("Te iubesc bunica mea mai mult ca orice pe lume , mulțumesc ca mai crescut") ajungea in promptul
// trimis catre Suno TAIATA la doar "Te" (2 caractere) — mesajul explicit "Te iubesc" nu ajungea
// niciodata la furnizor, versurile generate nu-l contineau, verificarea de coerenta
// (validateLyricsCoherence) respingea corect piesele (motiv: explicit_message_omitted), de doua ori
// (initial + reincercare, ambele cu ACELASI prompt trunchiat), iar comanda esua complet
// ("generation_failed" -> "Nu am putut finaliza melodia de aceasta data").
//
// CAUZA EXACTA (demonstrata direct, cu datele reale ale comenzii, nu presupusa): cascada
// `shrinkSteps` din buildPrompt() avea 5 pasi (ocazie->scurt, instructiune->scurt, voce->scurt,
// relatie->20, relatie->10) — pentru aceasta comanda, dupa TOTI cei 5 pasi, `head` ramanea la 571
// caractere (161 peste budgetForFixedPart=410), pentru ca relationClause() (parte din
// currentOccasionInstruction(), inclusa pentru ORICE ocazie de familie: bunici/parinti/
// matusa-unchi/socri) foloseste substantive de rol care pot fi lungi ("grandmother"/
// "granddaughter"), iar vocea era deja 'auto' (fara efect la scurtare) si relatia ("Nepoata") era
// deja mai scurta decat pragurile de trunchiere (fara efect). Rezultat: storyBudget calculat
// efectiv (2) cobora mult sub storyTextFloor calculat corect (72) — floor-ul era calculat corect,
// dar NIMIC nu garanta ca alocarea reala il respecta.
//
// INCERCARI RESPINSE (gasite prin testare directa, nu presupuse): eliminarea COMPLETA a
// occasionInstructionSet (textul de ton/atmosfera al ocaziei) ca ultima plasa de siguranta a
// regresat instructiuni SEMANTIC IMPORTANTE pentru alte ocazii (nunta vs botez: "today is your
// wedding/baptism day"; pierdere: interzicerea tonului festiv; frati: "sibling bond") — text
// NICIODATA doar decorativ, deci nesigur de eliminat generic. La fel, eliminarea COMPLETA a
// relationClause() a regresat identificarea relatiei (teste separate "mother"/"grandmother").
//
// REPARATIE FINALA (generica, NU specifica "bunici"/"populara"/RO/acestei comenzi): relationClause()
// primeste o a treia forma, "minimal" — pastreaza STRICT identificarea relatiei (roNoun/
// recipientNoun, ex. "grandmother"), renuntand la "never bare name"/atributia expeditorului
// ("from their X") ca ultim compromis, NICIODATA la relatia insasi. Activata STRICT cand spatiul
// CHIAR ramas dupa cei 5 pasi existenti tot nu ajunge la storyTextFloor (calculat din lungimea
// REALA a povestii, nu presupus) — niciodata mai devreme, niciodata pe seama povestii.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];
const PACKAGES = ['standard', 'premium', 'video'];

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

function loadPromptBuilders(neutralizeFix) {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 600;';
  const startIdx = server.indexOf(startMarker);
  assert.ok(startIdx !== -1);
  const exactFnSrc = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  const endIdx = server.indexOf(exactFnSrc) + exactFnSrc.length;
  let snippet = server.slice(startIdx, endIdx);
  if (neutralizeFix) {
    // Reproduce STRICT comportamentul DINAINTE de aceasta reparatie (fara plasa de siguranta
    // finala) — folosit DOAR ca baseline de comparatie in testul care demonstreaza bug-ul real,
    // nu modifica fisierul.
    const fixedGuard = `  if ((SUNO_PROMPT_MAX_LEN - head.length) < (storyTextFloor + storyLabelPlain.length) && !useMinimalRelationClause) {
    useMinimalRelationClause = true;
    head = buildFixedPart(recipient, sender, relationship);
  }`;
    assert.ok(snippet.includes(fixedGuard), 'nu am gasit plasa de siguranta finala (reparatia) — verifica ca reparatia e prezenta in server.js');
    snippet = snippet.replace(fixedGuard, '');
  }
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return { buildPrompt, buildExactLyricsRequest };
  `;
  return new Function('require', sandboxSrc)(require);
}

const { buildPrompt } = loadPromptBuilders(false);
const { buildPrompt: buildPromptBeforeFix } = loadPromptBuilders(true);

// Comanda REALA (campuri reale, poveste reala) care a produs esecul de productie.
const REAL_ORDER = {
  plan: 'video', lang: 'ro', genre: 'populara', occasion: 'bunici',
  recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
  senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Nepoata',
  voicePreference: 'auto',
  story: 'Te iubesc bunica mea mai mult ca orice pe lume , mulțumesc ca mai crescut'
};

// ===============================================================================================
// 1+2. Reproduce EXACT comanda reala — confirma bug-ul DINAINTE de reparatie (poveste = doar "Te").
//
// CORECTIE (2026-09-22, TASK naturalete versuri): relationClause() a fost scurtata separat (vezi
// server.js — "Address as X plus their name" (mecanic, cauza reala a unui bug DIFERIT, raportat
// separat — "Victor, tata") inlocuit cu "Mention naturally, once, that...") — efect secundar
// POZITIV, masurat direct: chiar si FARA plasa de siguranta (useMinimalRelationClause), bugetul
// eliberat de aceasta scurtare e acum suficient ca mesajul "Te iubesc" sa incapa ntreg pentru
// ACEASTA comanda specifica (nu mai trunchiat la "Te") — sistemul a devenit MAI ROBUST, nu doar
// "reparat prin plasa de siguranta". Testul de mai jos verifica acum EXACT asta (imbunatatire),
// NU mai reproduce trunchierea originala la 2 caractere — acoperirea protectiva a plasei de
// siguranta insasi (necesara pentru comenzi SI MAI incarcate) ramane verificata separat, in
// testul "PLASA DE SIGURANTA RAMANE NECESARA" de mai jos.
// ===============================================================================================
test('DUPA imbunatatirile de naturalete (2026-09-22): chiar FARA plasa de siguranta, mesajul "Te iubesc" al comenzii reale 400d4a20 incape intreg — relationClause() scurtata a eliberat suficient buget', () => {
  const promptBefore = buildPromptBeforeFix(REAL_ORDER, '', null);
  assert.ok(promptBefore.toLowerCase().includes('te iubesc'), `mesajul explicit "Te iubesc" trebuie sa incapa acum, chiar fara plasa de siguranta, primit: ${promptBefore}`);
  assert.ok(Array.from(promptBefore).length <= 600);
});

// PLASA DE SIGURANTA RAMANE NECESARA: pentru o comanda SI MAI incarcata decat 400d4a20 (ocazie
// "grandparents" — cel mai lung roNoun, expeditor+relatie foarte lungi, voce 'duet'), FARA plasa
// de siguranta povestea tot dispare complet din prompt — confirmat empiric (vezi raportul fazei)
// — deci reparatia din 2026-09-14 ramane cod activ, necesar, nu balast.
test('PLASA DE SIGURANTA RAMANE NECESARA: pentru o comanda si mai incarcata (grandparents+expeditor si relatie lungi+duet), FARA plasa povestea tot dispare complet', () => {
  const heavierOrder = {
    plan: 'video', lang: 'ro', genre: 'populara', occasion: 'bunici',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandparents',
    senderName: 'Ana-Maria-Elisabeta', senderRole: 'granddaughter',
    relationship: 'Nepoata draga si iubita din tot sufletul',
    voicePreference: 'duet',
    story: REAL_ORDER.story
  };
  const promptBefore = buildPromptBeforeFix(heavierOrder, '', null);
  const promptAfter = buildPrompt(heavierOrder, '', null);
  assert.ok(!promptBefore.includes('Story/details to include:'), `fara plasa de siguranta, povestea trebuie sa dispara complet pentru acest caz extrem, primit: ${promptBefore}`);
  assert.ok(promptAfter.includes('Story/details to include:'), `CU plasa de siguranta (comportamentul REAL al codului), povestea trebuie sa ramana prezenta, primit: ${promptAfter}`);
  assert.ok(Array.from(promptBefore).length <= 600);
  assert.ok(Array.from(promptAfter).length <= 600);
});

// ===============================================================================================
// 3. Dupa reparatie: mesajul explicit "Te iubesc" ajunge in prompt.
// ===============================================================================================
test('REPARAT (comanda 400d4a20): dupa reparatie, mesajul explicit "Te iubesc" ajunge in prompt', () => {
  const promptAfter = buildPrompt(REAL_ORDER, '', null);
  assert.ok(promptAfter.toLowerCase().includes('te iubesc'), `mesajul explicit "Te iubesc" trebuie sa ajunga in prompt, primit: ${promptAfter}`);
  assert.ok(Array.from(promptAfter).length <= 600);
  // Identificarea relatiei ("grandmother") ramane prezenta — doar comprimata, niciodata eliminata.
  assert.ok(promptAfter.includes('"grandmother"'), `relatia trebuie sa ramana identificabila, primit: ${promptAfter}`);
});

// ===============================================================================================
// 4+5+6. Toate cele 8 limbi x 3 pachete, povesti scurte SI lungi — povestea (sau un fragment
// semnificativ, niciodata sub floor) ajunge mereu in prompt, promptul ramane <= 600.
// ===============================================================================================
const SHORT_STORY_BY_LANG = {
  ro: 'Te iubesc mult, mulțumesc pentru tot ce ai făcut pentru mine.',
  en: 'I love you so much, thank you for everything you have done for me.',
  de: 'Ich liebe dich so sehr, danke für alles, was du für mich getan hast.',
  es: 'Te quiero mucho, gracias por todo lo que has hecho por mí.',
  it: 'Ti voglio tanto bene, grazie per tutto quello che hai fatto per me.',
  fr: 'Je t\'aime tellement, merci pour tout ce que tu as fait pour moi.',
  bg: 'Обичам те много, благодаря ти за всичко, което направи за мен.',
  tr: 'Seni çok seviyorum, benim için yaptığın her şey için teşekkür ederim.'
};
const LONG_STORY_BY_LANG = {
  ro: 'Ne-am cunoscut acum mulți ani și de atunci ai fost mereu alături de mine, în toate momentele grele și fericite, învățându-mă răbdare și iubire necondiționată. Te iubesc mult și îți mulțumesc pentru tot.',
  en: 'We met many years ago and since then you have always been by my side, through every hard and happy moment, teaching me patience and unconditional love. I love you so much and thank you for everything.',
  de: 'Wir haben uns vor vielen Jahren kennengelernt und seitdem warst du immer an meiner Seite, in jedem schweren und glücklichen Moment, und hast mir Geduld und bedingungslose Liebe beigebracht. Ich liebe dich so sehr.',
  es: 'Nos conocimos hace muchos años y desde entonces siempre has estado a mi lado, en cada momento difícil y feliz, enseñándome paciencia y amor incondicional. Te quiero mucho y gracias por todo.',
  it: 'Ci siamo conosciuti molti anni fa e da allora sei sempre stato al mio fianco, in ogni momento difficile e felice, insegnandomi pazienza e amore incondizionato. Ti voglio tanto bene e grazie di tutto.',
  fr: 'Nous nous sommes rencontrés il y a de nombreuses années et depuis tu as toujours été à mes côtés, dans chaque moment difficile et heureux, m\'apprenant la patience et l\'amour inconditionnel. Je t\'aime tellement.',
  bg: 'Запознахме се преди много години и оттогава винаги си бил до мен, във всеки труден и щастлив момент, учейки ме на търпение и безусловна любов. Обичам те много и ти благодаря за всичко.',
  tr: 'Yıllar önce tanıştık ve o zamandan beri her zor ve mutlu anda hep yanımda oldun, bana sabrı ve koşulsuz sevgiyi öğrettin. Seni çok seviyorum ve her şey için teşekkür ederim.'
};

function familyOrder(lang, plan, story, overrides) {
  return Object.assign({
    plan, lang, genre: 'populara', occasion: 'bunici',
    recipient: 'Maria', recipientMode: 'single', recipientRole: 'grandmother',
    senderName: 'Natalia', senderRole: 'granddaughter', relationship: 'Nepoata',
    voicePreference: 'auto', story
  }, overrides || {});
}

for (const lang of LANGS) {
  for (const plan of PACKAGES) {
    test(`buildPrompt [${lang}/${plan}, poveste scurta, ocazie familie grea]: promptul ramane <= 600, povestea (fragment semnificativ) ajunge`, () => {
      const order = familyOrder(lang, plan, SHORT_STORY_BY_LANG[lang]);
      const prompt = buildPrompt(order, '', null);
      assert.ok(Array.from(prompt).length <= 600, `prompt depaseste 600 pentru ${lang}/${plan}`);
      const firstWord = SHORT_STORY_BY_LANG[lang].split(/\s+/)[0];
      assert.ok(prompt.includes(firstWord), `povestea lipseste complet din prompt pentru ${lang}/${plan}, primit: ${prompt}`);
    });

    test(`buildPrompt [${lang}/${plan}, poveste lunga, ocazie familie grea]: promptul ramane <= 600, un fragment util de poveste ajunge (nu doar 1-2 caractere)`, () => {
      const order = familyOrder(lang, plan, LONG_STORY_BY_LANG[lang]);
      const prompt = buildPrompt(order, '', null);
      assert.ok(Array.from(prompt).length <= 600, `prompt depaseste 600 pentru ${lang}/${plan}`);
      // Cele 3 variante ale etichetei povestii (storyLabelPlain/Short/Full) se termina fie in
      // "to include: ", fie in "Story: " — alternativa acopera toate cele 3, indiferent care a
      // fost aleasa de pickStoryLabel() pentru aceasta comanda/limba.
      const storyMatch = (prompt.match(/(?:to include|Story): ([\s\S]*?) Occasion:/) || [])[1] || '';
      assert.ok(Array.from(storyMatch).length >= 40, `povestea lunga trebuie sa lase un fragment util (>= 40 caractere), a primit ${Array.from(storyMatch).length} pentru ${lang}/${plan}: "${storyMatch}"`);
    });
  }
}

// ===============================================================================================
// 7. Expeditor numit + relatie + ocazie + gen cu instructiuni lungi (exact combinatia care a
// cauzat bug-ul real) — testat separat pe toate cele 4 ocazii de familie (nu doar "bunici").
// ===============================================================================================
for (const occasion of ['bunici', 'parinti', 'matusa-unchi', 'socri']) {
  test(`buildPrompt [ocazie de familie "${occasion}", gen greu, expeditor+relatie]: povestea nu mai e redusa la un fragment inutil`, () => {
    const order = familyOrder('ro', 'video', 'Te iubesc mult, mulțumesc pentru tot ce ai făcut pentru mine.', { occasion, genre: 'manele_jale' });
    const prompt = buildPrompt(order, '', null);
    assert.ok(Array.from(prompt).length <= 600);
    assert.ok(prompt.toLowerCase().includes('te iubesc') || prompt.includes('Te iubesc'), `mesajul explicit trebuie sa ajunga pentru ocazia "${occasion}", primit: ${prompt}`);
  });
}

// ===============================================================================================
// NON-REGRESIE 1: reparatia e STRICT conditionata de storyTextFloor, nu de bugetul generic —
// pentru o comanda usoara (fara relatie de familie, poveste deja in siguranta), instructiunea de
// ocazie NU trebuie eliminata inutil.
// ===============================================================================================
test('NON-REGRESIE: comanda usoara (romantic/aniversare, fara relatie de familie) pastreaza instructiunea de ocazie completa', () => {
  const order = {
    lang: 'ro', plan: 'standard', genre: 'romantic', occasion: 'aniversare',
    recipient: 'Maria', senderName: 'Andrei', senderRole: 'partner', recipientRole: null,
    relationship: '', recipientMode: 'single', voicePreference: 'female',
    story: 'Ne-am cunoscut în 2015 pe malul Dunării din Brăila, într-o seară cu ploaie.'
  };
  const prompt = buildPrompt(order, '', null);
  assert.ok(prompt.includes('Clearly a birthday song with a natural birthday wish; never invents age.'), `instructiunea de ocazie nu trebuia eliminata pentru aceasta comanda usoara, primit: ${prompt}`);
  assert.ok(Array.from(prompt).length <= 600);
});

// ===============================================================================================
// NON-REGRESIE 2: continutul SEMANTIC IMPORTANT al instructiunilor de ocazie (nunta vs botez,
// interdictia de ton festiv la pierdere, legatura de frati) NU e niciodata atins de aceasta
// reparatie — doar relationClause() (identificarea relatiei) e comprimata, niciodata continutul
// tematic al ocaziei.
// ===============================================================================================
test('NON-REGRESIE: "Nuntă" vs "Botez" raman complet distincte dupa aceasta reparatie', () => {
  const base = { recipient: 'Maria', genre: 'emotional', lang: 'ro', senderName: 'Andrei', relationship: 'prieteni', voicePreference: 'auto', story: 'O poveste normala, de lungime obisnuita.' };
  const weddingPrompt = buildPrompt({ ...base, occasion: 'nunta', weddingType: 'wedding', recipientRole: 'bride', recipientMode: 'single' }, '', undefined);
  const baptismPrompt = buildPrompt({ ...base, occasion: 'nunta', weddingType: 'baptism', recipientRole: 'goddaughter', recipientMode: 'single' }, '', undefined);
  assert.ok(weddingPrompt.includes('"today is your wedding day"'), `instructiunea de nunta trebuie sa ramana intacta, primit: ${weddingPrompt}`);
  assert.ok(baptismPrompt.includes('"today is your baptism day"'), `instructiunea de botez trebuie sa ramana intacta, primit: ${baptismPrompt}`);
});

test('NON-REGRESIE: legatura de frati ("sibling bond") si interdictia de ton festiv la "pierdere" raman intacte', () => {
  const siblingPrompt = buildPrompt({ occasion: 'frati', genre: 'pop', lang: 'ro', senderName: 'Ana', relationship: 'sora', voicePreference: 'auto', story: 'O poveste scurta, obisnuita, despre fratele meu si amintirile frumoase din copilarie.', recipient: 'Maria', recipientRole: 'sister' }, '', undefined);
  assert.ok(/sibling bond/i.test(siblingPrompt), `"sibling bond" trebuie sa ramana in prompt, primit: ${siblingPrompt}`);
  const griefPrompt = buildPrompt({ occasion: 'pierdere', genre: 'emotional', lang: 'ro', senderName: 'Andrei', relationship: 'prieteni', voicePreference: 'auto', story: 'O poveste normala, de lungime obisnuita.' }, '', undefined);
  assert.ok(/never (cheerful|festive|celebratory|upbeat)/i.test(griefPrompt), `interdictia de ton festiv trebuie sa ramana, primit: ${griefPrompt}`);
});

// ===============================================================================================
// 8+9. Povestea nu mai coboara sub floor-ul intentionat, in cazul greu realist care a produs
// bug-ul real (testat mai sus, TEST 1-3) — un fragment semnificativ ajunge, niciodata doar 1-2
// caractere. Cazul si mai greu ("amandoi" + nume maxime pe ambele parti) ramane o limitare
// reziduala documentata explicit mai jos.
// ===============================================================================================

// LIMITARE REZIDUALA, de raportat explicit (preexistenta, neschimbata de aceasta reparatie —
// verificat direct ca era identic absenta si INAINTE de orice modificare din aceasta sesiune):
// destinatar "Amândoi" (recipientMode='both') SIMULTAN cu nume foarte lungi pe ambele parti SI
// relatie lunga SI cel mai lung gen muzical ramane un caz extrem neacoperit — ar necesita
// sacrificarea garantiei "Never omit either person." (deja protejata explicit), depaseste scopul
// acestei reparatii (fix generic al cauzei raportate, nu acoperirea exhaustiva a oricarei combinatii
// matematic posibile).
test('LIMITARE REZIDUALA (raportata, neschimbata de aceasta reparatie): "Amândoi" + nume foarte lungi pe ambele parti + relatie lunga + gen cu tag lung ramane un caz extrem neacoperit', () => {
  const order = {
    plan: 'video', lang: 'de', genre: 'manele_jale', occasion: 'bunici',
    recipient: 'Wolfgang und Ingrid Müller-Schmidt', recipientMode: 'both', recipientRole: 'grandparents',
    senderName: 'Alexander-Friedrich', senderRole: 'grandchild',
    relationship: 'die liebevollsten Großeltern der ganzen Familie', voicePreference: 'duet',
    story: 'Wir haben uns 2015 im kleinen Café am Münsterplatz in Freiburg kennengelernt und seitdem jedes Jahr gemeinsam Weihnachten gefeiert, mit Plätzchen backen, Geschichten erzählen und langen Spaziergängen durch den Schwarzwald, die wir nie vergessen werden, auch wenn die Jahre vergehen und wir alle älter werden.'
  };
  const prompt = buildPrompt(order, '', null);
  assert.ok(Array.from(prompt).length <= 600);
  assert.ok(prompt.includes('Never omit either person.'), 'garantia "amandoi" ramane protejata chiar si in acest caz extrem');
});

// ===============================================================================================
// 10. Indiciul de durata (3:15-3:40) ramane optional, cu prioritate mai mica decat povestea —
// neatins de aceasta reparatie.
// ===============================================================================================
test('buildPrompt: indiciul de durata ramane optional si NU ia spatiu de la poveste, dupa aceasta reparatie', () => {
  const prompt = buildPrompt(REAL_ORDER, '', null);
  assert.ok(prompt.toLowerCase().includes('te iubesc'), 'povestea trebuie sa fie prezenta');
  assert.ok(server.includes("const durationTargetClause = ' Target song length 3:15-3:40.';"), 'constanta indiciului de durata trebuie sa ramana neschimbata');
  assert.ok(server.includes('const canReserveForDuration = (remaining - storyLabel.length - reservedExtra - durationTargetClause.length) >= storyTextFloor;'), 'indiciul de durata trebuie sa ramana STRICT conditionat de storyTextFloor, neschimbat de aceasta reparatie');
});

// ===============================================================================================
// 11. Genre/voice/model raman neschimbate (byte-identice) de aceasta reparatie.
// ===============================================================================================
test('server.js: GENRE_STYLE_MAP, VOICE_INSTRUCTIONS si modelul V4_5 raman neschimbate de aceasta reparatie', () => {
  const genreKeys = ['pop', 'ballad_emotional', 'acoustic_folk', 'rnb', 'country', 'jazz', 'rock', 'hiphop', 'edm_dance', 'manele_suflet', 'manele_jale', 'populara', 'copii', 'colind', 'romantic', 'motivational'];
  const startIdx = server.indexOf('const GENRE_STYLE_MAP');
  const endIdx = server.indexOf('\n};', startIdx) + 3;
  const mapSrc = server.slice(startIdx, endIdx);
  for (const key of genreKeys) {
    assert.ok(new RegExp(`\\b${key}\\s*:`).test(mapSrc), `cheia de gen "${key}" lipseste`);
  }
  assert.ok(server.includes("female: ' Use a female lead vocal.',"));
  assert.ok(server.includes("duet: ' Use a male and female duet, with both voices clearly present.',"));
  const fn = extractFn(server, 'async function callMusicProvider(orderId, requestInput) {');
  assert.match(fn, /const musicModel = \(process\.env\.MUSIC_MODEL[\s\S]*?\) \|\| 'V4_5ALL';/);
});

test('server.js: validateLyricsCoherence() nu a fost modificat de aceasta reparatie (validatorul functiona corect — inputul era problema)', () => {
  const fn = extractFn(server, 'function validateLyricsCoherence(order, recipientSnapshot, lyricsText) {');
  assert.ok(fn.includes("reasons.push('explicit_message_omitted');"), 'logica de detectie a mesajului omis trebuie sa ramana neschimbata');
  assert.ok(fn.includes("reasons.push('sender_self_declaration');"));
  assert.ok(fn.includes("reasons.push('song_data_mixing');"));
});

test('server.js si toate fisierele modificate raman sintactic valide', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
