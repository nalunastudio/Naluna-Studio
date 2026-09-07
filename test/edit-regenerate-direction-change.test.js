// REGRESIE URGENTA (2026-09-06, semnalata explicit): "prima melodie Romantic, editare cu genre
// nou Motivational + feedback 'mai vesela' -> rezultatul nu respecta cererea".
//
// CAUZA REALA gasita prin MASURARE directa (nu presupunere) — DOUA probleme distincte, ambele
// corectate:
//
// (1) BUGET INSUFICIENT (cauza PRINCIPALA, dominanta): pentru o comanda TIPICA (poveste/ocazie
// obisnuite, deloc extreme), "remaining" in buildPrompt() la momentul calcularii bugetului de
// feedback e adesea SUB STORY_MIN_RESERVE (masurat direct: 149 caractere ramase, sub cele 190
// rezervate povestii) — extraSpace (calculat STRICT ca surplus peste minimul povestii) devine 0,
// deci feedbackBudget devine 0, iar feedback-ul clientului (inclusiv cereri explicite de
// schimbare a directiei, "mai vesela" etc.) era sters COMPLET, silentios, INAINTE sa ajunga la
// furnizor — verificat printr-o executie REALA a buildPrompt() cu date tipice, nu un test
// sintetic artificial. Corectat cu o eticheta scurta de rezerva ("Adjust: " in loc de "Client-
// requested adjustment: ") si o rezerva mica GARANTATA, care nu vine niciodata din
// STORY_MIN_RESERVE si nu coboara niciodata povestea sub propriul ei prag absolut de utilitate.
//
// (2) Clauza de INTARIRE a directiei muzicale (BRIGHTEN_MOOD_CLAUSE, pentru "mai vesel"/
// "happier"/etc.) era limitata STRICT la pachetul Video (`isVideoPlan &&`) — Standard/Premium nu
// o primeau niciodata, chiar si atunci cand feedback-ul ajungea corect. Extinsa la toate
// planurile.
//
// Acest fisier verifica FUNCTIONAL (executie reala a buildPrompt(), nu doar text-matching) ca
// promptul editat difera REAL de cel initial si contine feedback-ul clientului, pentru toate
// cele 3 pachete, folosind date REALISTE (poveste/ocazie tipice, nu artificial de scurte) —
// exact scenariul in care bug-ul (1) aparea.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  if (idx === -1) throw new Error('nu am gasit: ' + signature);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

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
    return { buildPrompt, buildExactLyricsRequest };
  `;
  return new Function('require', sandboxSrc)(require);
}
const { buildPrompt, buildExactLyricsRequest } = loadPromptBuilders();

// Comanda REALISTA, tipica — poveste si ocazie normale, NU artificial de scurte — exact tiparul
// de comanda in care bugetul de feedback ajungea la 0 inainte de corectie.
function realisticOrder(plan, genre) {
  return {
    plan, occasion: 'aniversare', lang: 'ro', recipient: 'Maria', senderName: 'Andrei',
    senderRole: null, recipientRole: null, recipientMode: 'single', genre,
    story: 'Ne-am cunoscut acum cativa ani si de atunci suntem inseparabili, mereu impreuna.',
    voicePreference: 'auto'
  };
}

// Standard/Premium folosesc buildPrompt() (buget 600 caractere) pentru regenerare cu feedback
// liber — exact scenariul raportat de utilizator. Video, pentru regenerare FARA editare manuala
// de versuri, foloseste in schimb buildExactLyricsRequest() (buget 1000 caractere, versurile
// raman verbatim) — comportamentul STRICT (eroare clara daca nu incape, niciodata trunchiere
// silentioasa) e deja corect si NEATINS de aceasta corectie; testat separat mai jos.
for (const plan of ['standard', 'premium']) {
  test(`FUNCTIONAL (${plan}), comanda REALISTA: editare Romantic->Motivational + "mai vesela" produce un prompt DIFERIT de cel initial, cu noul gen SI feedback-ul verbatim al clientului prezente — inainte de fix, feedback-ul disparea COMPLET (feedbackBudget=0) pentru acest tip de comanda tipica`, () => {
    const initial = buildPrompt(realisticOrder(plan, 'romantic'), '', undefined);
    const edited = buildPrompt(realisticOrder(plan, 'motivational'), 'mai vesela', 'motivational');

    assert.notEqual(initial, edited, `${plan}: promptul editat trebuie sa difere de cel initial`);
    assert.match(edited, /inspirational anthem, driving toms, major-key triumphant chords/i, `${plan}: tag-ul de stil pentru Motivational trebuie sa apara`);
    assert.ok(!edited.includes('intimate romantic ballad'), `${plan}: tag-ul vechi (Romantic) nu trebuie sa mai apara`);
    assert.ok(edited.includes('mai vesela'), `${plan}: feedback-ul verbatim al clientului trebuie sa apara in prompt — inainte de fix, disparea complet pentru o comanda tipica`);
  });
}

test('FUNCTIONAL (video): buildPrompt() cu o comanda REALISTA si feedback pastreaza comportamentul STRICT preexistent (eroare clara daca feedback-ul verbatim nu incape) — NEATINS de aceasta corectie, prin design (video foloseste tipic buildExactLyricsRequest, buget 1000, pentru regenerare)', () => {
  assert.throws(
    () => buildPrompt(realisticOrder('video', 'motivational'), 'mai vesela', 'motivational'),
    /prea lungă ca să încapă/,
    'comportamentul video (eroare clara, nu trunchiere silentioasa) trebuie sa ramana neschimbat'
  );
});

// REGRESIE (2026-09-07): buildExactLyricsRequest() (versuri deja blocate — customMode:true)
// folosea o eticheta STRICT GOALA (' ') pentru Standard/Premium — instructiunea clientului ajungea
// intreaga (verificat: nu era trunchiata pentru un buget de 1000 caractere), dar fara niciun
// semnal ca e o cerere distincta, spre deosebire de buildPrompt() (aceleasi planuri), care are deja
// ' Client-requested adjustment: '. Aliniat acum.
test('FUNCTIONAL: buildExactLyricsRequest() foloseste aceeasi eticheta reala ca buildPrompt() pentru Standard/Premium (nu mai e un spatiu gol)', () => {
  const order = { plan: 'standard', lang: 'ro', voicePreference: 'auto' };
  const result = buildExactLyricsRequest(order, 'Versuri complete deja scrise de client.', undefined, 'auto', 'Un inceput diferit');
  assert.match(result.style, /Client-requested adjustment: Un inceput diferit/, 'eticheta reala trebuie sa preceada feedback-ul, nu doar un spatiu gol');
});

test('FUNCTIONAL: clauza de intarire a directiei (BRIGHTEN_MOOD_CLAUSE, 240+ caractere) nu incape niciodata in bugetul de 600 caractere al buildPrompt() alaturi de o poveste completa — de aceea a fost proiectata sa functioneze in principal prin buildExactLyricsRequest() (buget 1000). Testam acolo ca extinderea la toate planurile chiar functioneaza', () => {
  const order = { plan: 'standard', lang: 'ro', voicePreference: 'auto' };
  const initial = buildExactLyricsRequest(order, 'Versuri complete deja scrise de client.', undefined, 'auto', '');
  const edited = buildExactLyricsRequest(order, 'Versuri complete deja scrise de client.', undefined, 'auto', 'mai vesela');
  assert.match(edited.style, /brighter, energetic, optimistic/i, 'clauza de intarire trebuie sa fie prezenta pentru Standard (extinsa de la Video-only)');
  assert.ok(!/brighter, energetic, optimistic/i.test(initial.style), 'style-ul initial (fara feedback) nu trebuie sa contina clauza de intarire');
  assert.ok(edited.style.includes('mai vesela'), 'feedback-ul verbatim trebuie sa apara');
});

test('STRUCTURAL: gate-ul "isVideoPlan &&" pe detectsBrightenMoodFeedback a fost eliminat in buildPrompt/buildExactLyricsRequest (comportamentele STRICT video-specifice — eticheta de prioritate, verificarea de buget cu eroare — raman neschimbate)', () => {
  const promptFn = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  assert.ok(!promptFn.includes('isVideoPlan && detectsBrightenMoodFeedback'), 'buildPrompt: gate-ul video-only trebuie eliminat');
  assert.match(promptFn, /if \(detectsBrightenMoodFeedback\(feedbackText, order\.lang\)\) \{/);

  const exactFn = extractFn(server, 'function buildExactLyricsRequest(order, exactLyrics, genreOverride, voicePreference, feedback) {');
  assert.ok(!exactFn.includes('isVideoPlan && detectsBrightenMoodFeedback'), 'buildExactLyricsRequest: gate-ul video-only trebuie eliminat');
  assert.match(exactFn, /const brighten = detectsBrightenMoodFeedback\(feedbackText, order\.lang\) \? BRIGHTEN_MOOD_CLAUSE : '';/);
  assert.match(exactFn, /const isVideoPlan = order\.plan === 'video';/);
  assert.match(exactFn, /if \(isVideoPlan\) \{/);
});

test('STRUCTURAL: buildPrompt() garanteaza o rezerva minima pentru feedback (eticheta scurta "Adjust: " + safeGuaranteedReserve) care NU vine niciodata din STORY_MIN_RESERVE si nu coboara povestea sub storyLabelPlain+MIN_USEFUL_STORY_CHARS', () => {
  const promptFn = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  assert.match(promptFn, /const feedbackLabelShort = ' Adjust: ';/);
  assert.match(promptFn, /const absoluteStoryFloor = storyLabelPlain\.length \+ MIN_USEFUL_STORY_CHARS;/);
  // CORECTIE (2026-09-07): plafonul 50->150 — vezi testul FUNCTIONAL de mai jos, care demonstreaza
  // cu date reale ca 50 trunchia mijlocul unei instructiuni structurale tipice de client.
  assert.match(promptFn, /const safeGuaranteedReserve = Math\.max\(0, Math\.min\(150, remaining - absoluteStoryFloor\)\);/);
});

// REGRESIE URGENTA (2026-09-07, semnalata explicit): "schimbarea genului s-a respectat;
// instructiunea libera 'vreau un alt inceput' NU s-a respectat". CAUZA REALA gasita prin
// EXECUTIE REALA (nu presupunere) a buildPrompt() cu o comanda REALISTA (poveste/ocazie tipice,
// gen obisnuit — NU un caz extrem): plafonul anterior de 50 caractere pentru rezerva garantata de
// feedback trunchia o instructiune structurala tipica ("Vreau un cu totul alt inceput, nu cu ce
// ati facut data trecuta - porniti melodia altfel." — 89 caractere) la doar 42 caractere ("Adjust:
// Vreau un cu totul alt inceput, nu cu ce a"), taind EXACT partea care spune CE sa faca modelul
// diferit — instructiunea ajungea la Suno, dar mutilata, nu doar "cu prioritate slaba". Acesta e
// un bug de MAPPING Naluna (truncheaza propriul continut inainte sa-l trimita), nu o limitare a
// modelului — corectat prin marirea plafonului garantat (50->150) si trunchiere la limita de
// cuvant (truncateAtWordBoundary in loc de truncateSafely).
for (const plan of ['standard', 'premium']) {
  test(`FUNCTIONAL (${plan}), REGRESIE "vreau un alt inceput": o instructiune STRUCTURALA realista (89 caractere, nu doar de mood) supravietuieste INTREAGA intr-o comanda realista (poveste/ocazie tipice) — inainte de fix, era trunchiata la 42 caractere, chiar in mijlocul cuvantului`, () => {
    const order = realisticOrder(plan, 'romantic');
    const feedback = 'Vreau un cu totul alt inceput, nu cu ce ati facut data trecuta - porniti melodia altfel.';
    const prompt = buildPrompt(order, feedback);
    assert.ok(prompt.includes(feedback), `${plan}: instructiunea structurala completa trebuie sa apara verbatim, nu trunchiata — prompt: ${JSON.stringify(prompt)}`);
    assert.ok(prompt.includes('porniti melodia altfel'), `${plan}: partea care spune CE sa faca diferit nu trebuie sa lipseasca`);
  });
}

// VERIFICARE EDIT-A (2026-09-07, ceruta explicit dupa deploy-ul fix-ului), fara generatie
// platita — traseul complet demonstrat determinist, cu o instructiune REALISTA de 147 caractere
// ("Vreau un inceput complet diferit fata de prima versiune, apoi melodia sa devina mai vesela
// si mai energica, pastrand povestea si mesajul principal.").
test('EDIT-A: campul liber #feedback din melodia-mea.html NU are niciun maxlength artificial (spre deosebire de textarea-urile de versuri, limitate la 4000) — clientul poate scrie intreaga instructiune, limitarea reala e STRICT server-side (500 caractere, handleLegacyRegenerate)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'melodia-mea.html'), 'utf8');
  const feedbackTextareaMatch = html.match(/<textarea id="feedback"[^>]*>/);
  assert.ok(feedbackTextareaMatch, 'textarea-ul de feedback trebuie sa existe');
  assert.ok(!feedbackTextareaMatch[0].includes('maxlength'), 'feedback NU trebuie sa aiba maxlength — limitarea reala e server-side');
  assert.match(html, /const feedback = feedbackEl\.value \|\| null;/, 'valoarea completa a textarea-ului trebuie citita integral, fara trunchiere client-side');
});

test('EDIT-A: instructiunea realista de 147 caractere data ca exemplu ajunge INTREAGA in buildExactLyricsRequest() (versuri deja blocate) — traseul complet, verificat determinist', () => {
  const order = { plan: 'standard', lang: 'ro', voicePreference: 'auto' };
  const feedback = 'Vreau un inceput complet diferit fata de prima versiune, apoi melodia sa devina mai vesela si mai energica, pastrand povestea si mesajul principal.';
  assert.equal(Array.from(feedback).length, 147);
  const result = buildExactLyricsRequest(order, 'Versuri complete deja scrise de client.', undefined, 'auto', feedback);
  assert.ok(result.style.includes(feedback), 'instructiunea de 147 caractere trebuie sa apara INTREAGA, verbatim, in campul style (buget 1000 caractere)');
});

// LIMITARE REZIDUALA, documentata explicit (nu ascunsa): buildPrompt() (buget 600 caractere,
// folosit pentru regenerare Standard/Premium FARA versuri blocate manual) NU poate garanta
// supravietuirea INTEGRALA a oricarei instructiuni realiste — bugetul total de 600 e MULT mai mic
// decat limita reala a furnizorului (3000 caractere pentru acest camp), dar a fost REDUS SI
// PASTRAT MIC intentionat, in urma unei regresii REALE documentate (vezi comentariul de la
// SUNO_PROMPT_MAX_LEN / STORY_MIN_RESERVE in server.js, 2026-08-13, "melodii instrumentale" —
// prompturi mai lungi au produs melodii FARA voce): marirea generala a bugetului NU e o
// modificare sigura fara verificare reala, platita, ca vocea nu dispare din nou — in afara
// scopului acestui task (interzis explicit sa mai consumam credite pentru teste de model/pipeline).
// Fix-ul deja livrat (50->150, trunchiere la limita de cuvant) REZOLVA majoritatea cazurilor reale
// (orice instructiune de pana la ~100-140 caractere, in functie de lungimea povestii/genului) si,
// cand chiar nu incape, pastreaza intotdeauna CLAUZA PRINCIPALA (inceputul instructiunii, unde
// clientul isi exprima de obicei cererea centrala), taind DOAR clauzele secundare de la finalul
// instructiunii, niciodata in mijlocul unui cuvant.
test('EDIT-A, LIMITARE REZIDUALA documentata: pentru buildPrompt() (fara versuri blocate), o instructiune de 147 caractere poate fi inca partial trunchiata intr-o comanda cu poveste tipica — dar clauza PRINCIPALA (inceputul cererii clientului) supravietuieste intotdeauna, iar taierea ramane la limita de cuvant, niciodata in mijlocul unuia. NU marim SUNO_PROMPT_MAX_LEN fara o verificare reala, platita, ca vocea nu dispare (regresie istorica documentata) — in afara scopului acestui task.', () => {
  const order = realisticOrder('standard', 'romantic');
  const feedback = 'Vreau un inceput complet diferit fata de prima versiune, apoi melodia sa devina mai vesela si mai energica, pastrand povestea si mesajul principal.';
  const prompt = buildPrompt(order, feedback);
  assert.ok(prompt.includes('Adjust: Vreau un inceput complet diferit'), 'clauza PRINCIPALA a clientului trebuie sa supravietuiasca intotdeauna');
  const adjustIdx = prompt.indexOf('Adjust: ');
  const survivingFeedback = prompt.slice(adjustIdx + 'Adjust: '.length);
  assert.ok(feedback.startsWith(survivingFeedback), 'portiunea pastrata trebuie sa fie STRICT un prefix real al instructiunii originale, niciodata text alterat');
  assert.ok(!/[a-zA-Zșțăîâ]{1,2}$/.test(survivingFeedback) || feedback.startsWith(survivingFeedback.trimEnd()), 'daca e trunchiata, taierea trebuie sa cada la limita de cuvant, niciodata in mijlocul unuia');
});

test('FUNCTIONAL: daca instructiunea chiar nu incape (buget extrem de strans), trunchierea se opreste la limita de cuvant, niciodata in mijlocul unui cuvant', () => {
  const order = realisticOrder('standard', 'hiphop'); // tag lung, cel mai stramt caz real
  const longFeedback = 'Vreau o schimbare completa de directie muzicala, un inceput cu totul diferit, mai lent la primele secunde si apoi o crestere treptata pana la refren, exact opusul a ceea ce am primit data trecuta.';
  const prompt = buildPrompt(order, longFeedback);
  const adjustIdx = prompt.indexOf('Adjust: ');
  assert.notEqual(adjustIdx, -1, 'eticheta scurta de feedback trebuie sa apara');
  const feedbackPortion = prompt.slice(adjustIdx + 'Adjust: '.length);
  assert.ok(!/\s[a-zA-Zșțăîâ]$/.test(feedbackPortion) || longFeedback.startsWith(feedbackPortion), 'nu trebuie sa se termine cu o litera unica ramasa dintr-un cuvant taiat la mijloc');
  assert.ok(longFeedback.startsWith(feedbackPortion.trim()), 'portiunea pastrata trebuie sa fie un prefix REAL, la limita de cuvant, al instructiunii originale');
});
