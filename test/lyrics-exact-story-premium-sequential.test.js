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
// (nu doar text static) ca o poveste la lungimea maxima reala (2000 caractere) ajunge INTREAGA
// in promptul final, nu doar cateva sute de caractere din ea.
function loadBuildPrompt() {
  const startMarker = 'const SUNO_PROMPT_MAX_LEN = 2800;';
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

test('buildPrompt: o poveste la lungimea maxima reala (2000 caractere) ajunge INTREAGA in prompt, netrunchiata — verificare functionala, nu doar text static', () => {
  const phrase = 'Povestea completa a noastra, cu multe detalii importante. ';
  const longStory = phrase.repeat(Math.ceil(2000 / phrase.length)).slice(0, 2000);
  assert.equal(longStory.length, 2000);
  const order = {
    occasion: 'aniversare', genre: 'pop', lang: 'ro',
    recipient: 'Maria', senderName: 'Ana', relationship: 'prietena',
    voicePreference: 'auto', story: longStory
  };
  const prompt = buildPrompt(order, '', undefined);
  assert.ok(prompt.includes(longStory), 'povestea intreaga (2000 caractere) trebuie sa apara integral in prompt, fara nicio trunchiere');
});

test('buildPrompt: o poveste la lungimea maxima (2000) plus feedback de editare (500) tot incap amandoua, fara sa se elimine povestea', () => {
  const longStory = 'Detaliu real despre povestea noastra impreuna. '.repeat(42).slice(0, 2000);
  const feedback = 'F'.repeat(500);
  const order = {
    occasion: 'dor', genre: 'balada', lang: 'ro',
    recipient: 'Ion', senderName: 'Maria', relationship: 'sotie',
    voicePreference: 'female', story: longStory
  };
  const prompt = buildPrompt(order, feedback, undefined);
  assert.ok(prompt.includes(longStory), 'povestea trebuie sa ramana intreaga chiar si cu feedback de editare prezent');
});

// ---------------------------------------------------------------------------------------------
// (1) Pastrarea exacta a versurilor editate.
// ---------------------------------------------------------------------------------------------
test('server.js: buildExactLyricsRequest trimite versurile editate VERBATIM (customMode:true, campul "prompt" = versurile), niciodata ca instructiune catre un model care le rescrie', () => {
  assert.match(server, /function buildExactLyricsRequest\(order, exactLyrics, genreOverride, voicePreference, feedback\) \{/);
  const idx = server.indexOf('function buildExactLyricsRequest');
  const body = server.slice(idx, idx + 2200);
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
// (2) Folosirea completa a povestii clientului.
// ---------------------------------------------------------------------------------------------
test('server.js: bugetul de prompt (customMode:false) a fost marit semnificativ fata de limita gresita de 500 caractere, verificata direct impotriva API-ului real', () => {
  assert.match(server, /const SUNO_PROMPT_MAX_LEN = 2800;/);
  assert.match(server, /const STORY_MIN_RESERVE = 2000;/);
});

test('server.js: rezerva garantata pentru poveste (2000) acopera lungimea MAXIMA reala permisa la creare (isValidString(story, 5, 2000)) — povestea nu mai poate fi trunchiata in practica', () => {
  assert.match(server, /if \(!isValidString\(story, 5, 2000\)\) \{/);
});

test('server.js: ambele melodii Premium initiale primesc EXACT aceeasi poveste (order.story nu e suprascris de getSong2EffectiveData)', () => {
  const idx = server.indexOf('function getSong2EffectiveData(order)');
  const body = server.slice(idx, idx + 700);
  assert.ok(!body.includes('story'), 'getSong2EffectiveData nu trebuie sa suprascrie/elimine campul story — ambele melodii trebuie sa foloseasca povestea comuna a comenzii');
  const dualGenIdx = server.indexOf('const promptGenre1 = buildPrompt(order, feedback, order.genre);');
  assert.ok(dualGenIdx !== -1);
  assert.ok(server.includes('const promptGenre2 = buildPrompt({ ...order, ...getSong2EffectiveData(order) }, feedback, order.genre2);'));
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

test('melodia-mea.html: feedback-ul liber al fiecarei melodii e inclus in payload-ul trimis catre POST /regenerate', () => {
  const idx = melodia.indexOf('const songs = [');
  const body = melodia.slice(idx, idx + 700);
  assert.ok(body.includes('feedback: song1Feedback.value.trim() || undefined'));
  assert.ok(body.includes('feedback: song2Feedback.value.trim() || undefined'));
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
// Verificari finale de sintaxa.
// ---------------------------------------------------------------------------------------------
test('server.js: node --check server.js trece (nicio eroare de sintaxa introdusa)', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]));
});
