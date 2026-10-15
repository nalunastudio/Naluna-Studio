// FORMULAR SPECIAL "PENTRU MINE" (2026-10-12, cerinta explicita) — occasion='pentru-mine' nu mai
// foloseste formularul generic destinatar/expeditor/relatie (ilogic pentru o melodie despre
// client insusi). Acopera STRICT buildPrompt(): (1) SELF_THEME_INSTRUCTIONS ("Ce vrei sa exprime
// melodia ta?" — 5 teme, INLOCUIESC generic OCCASION_INSTRUCTIONS['pentru-mine'], fallback sigur
// pentru comenzi vechi/fara tema), (2) suppressRecipientName ("Vrei ca numele tau sa apara in
// melodie?" — Nu => fara eticheta "Recipient:", fara numele clientului nicaieri in prompt,
// instructiune explicita "never use any name"). Validarea server-side (POST /api/orders) si
// migrarea DB (self_theme/include_name_in_song) sunt acoperite separat (verificare manuala directa,
// nu necesita acces la o baza de date reala — vezi raportul final).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8').replace(/\r\n/g, '\n');
}
function extractFn(source, signature, fromIdx) {
  const idx = source.indexOf(signature, fromIdx || 0);
  assert.ok(idx !== -1, `nu am gasit: ${signature}`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}
const server = read('server.js');
function loadBuildPrompt() {
  const startIdx = server.indexOf('const SUNO_PROMPT_MAX_LEN = 600;');
  assert.ok(startIdx !== -1);
  const fnSrc = extractFn(server, 'function buildPrompt(order, feedback, genreOverride) {');
  const endIdx = server.indexOf(fnSrc) + fnSrc.length;
  const snippet = server.slice(startIdx, endIdx);
  const sandboxSrc = `
    const { normalizeSingingText, getDictionInstruction } = require('../lib/diction.js');
    const VOICE_PREFERENCES = ['female', 'male', 'duet', 'auto'];
    const FAMILY_OCCASIONS = ['bunici', 'parinti', 'matusa-unchi', 'socri'];
    const FAMILY_RECIPIENT_ROLE_VALUES = ['grandmother', 'grandfather', 'grandparents', 'mother', 'father', 'parents', 'aunt', 'uncle', 'aunt_uncle', 'mother_in_law', 'father_in_law', 'parents_in_law', 'sister', 'brother'];
    ${snippet}
    return buildPrompt;
  `;
  return new Function('require', sandboxSrc)(require);
}
const buildPrompt = loadBuildPrompt();

const THEMES = ['putere-motivatie', 'perioada-grea', 'reusita', 'dor-iubire', 'povestea-vietii'];
const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function selfOrder(overrides) {
  return Object.assign({
    plan: 'standard', lang: 'ro', genre: 'populara', occasion: 'pentru-mine',
    recipient: 'Alexandra', selfTheme: 'reusita', includeNameInSong: true,
    voicePreference: 'auto',
    story: 'Am trecut prin multe in ultimii ani, dar am invatat sa ma iubesc mai mult si sa cred in mine.'
  }, overrides);
}

// ===================================================================================================
// 1) Fiecare din cele 5 teme produce o instructiune de ocazie DIFERITA fata de intrarea generica.
// ===================================================================================================
for (const theme of THEMES) {
  test(`buildPrompt [pentru-mine/${theme}]: foloseste instructiunea SPECIFICA temei (nu cea generica), prompt <= 600`, () => {
    const prompt = buildPrompt(selfOrder({ selfTheme: theme }), '', null);
    assert.ok(Array.from(prompt).length <= 600, `lungime: ${Array.from(prompt).length}`);
    assert.ok(!prompt.includes('addressed to themselves'), 'nu trebuie sa foloseasca textul generic cand o tema specifica e aleasa');
  });
}

// ===================================================================================================
// 2) Comanda VECHE/fara selfTheme -> fallback sigur pe intrarea generica, NU arunca.
// ===================================================================================================
test('buildPrompt [pentru-mine, fara selfTheme]: foloseste fallback-ul generic, nu arunca (comenzi vechi)', () => {
  const order = selfOrder({ selfTheme: undefined });
  assert.doesNotThrow(() => buildPrompt(order, '', null));
  const prompt = buildPrompt(order, '', null);
  assert.ok(prompt.includes('addressed to themselves') || prompt.includes('Personal message to oneself'));
});

test('buildPrompt [pentru-mine, selfTheme necunoscut/invalid]: foloseste fallback-ul generic, nu arunca', () => {
  const order = selfOrder({ selfTheme: 'ceva-care-nu-exista' });
  assert.doesNotThrow(() => buildPrompt(order, '', null));
});

// ===================================================================================================
// 3) includeNameInSong === true (sau absent) -> comportament NESCHIMBAT fata de alte ocazii
//    fara expeditor: "Recipient:" prezent, numele clientului ajunge in prompt.
// ===================================================================================================
test('buildPrompt [pentru-mine, includeNameInSong=true]: "Recipient:" prezent, numele clientului ajunge in prompt', () => {
  const prompt = buildPrompt(selfOrder({ includeNameInSong: true }), '', null);
  assert.ok(prompt.includes('Recipient: Alexandra'), prompt);
});

test('buildPrompt [pentru-mine, includeNameInSong absent/undefined]: comportament identic cu true (nesuprimat)', () => {
  const prompt = buildPrompt(selfOrder({ includeNameInSong: undefined }), '', null);
  assert.ok(prompt.includes('Recipient: Alexandra'), prompt);
});

// ===================================================================================================
// 4) includeNameInSong === false -> "Recipient:" ABSENT, numele NU apare nicaieri, instructiune
//    explicita "never use any name", in toate cele 5 teme x toate cele 8 limbi.
// ===================================================================================================
for (const theme of THEMES) {
  for (const lang of LANGS) {
    test(`buildPrompt [pentru-mine/${theme}/${lang}, includeNameInSong=false]: numele NU apare nicaieri, "Recipient:" absent, prompt <= 600`, () => {
      const order = selfOrder({ lang, selfTheme: theme, includeNameInSong: false, recipient: 'Alexandra-Gabriela' });
      const prompt = buildPrompt(order, '', null);
      assert.ok(!prompt.includes('Recipient:'), prompt);
      assert.ok(!prompt.includes('Alexandra'), prompt);
      assert.ok(/never use any name/i.test(prompt), prompt);
      assert.ok(Array.from(prompt).length <= 600, `lungime: ${Array.from(prompt).length}`);
    });
  }
}

// ===================================================================================================
// 5) suppressRecipientName NU afecteaza nicio alta ocazie, chiar daca includeNameInSong=false ar fi
//    trimis din greseala pe o comanda normala — "Recipient:" ramane prezent, neschimbat.
// ===================================================================================================
test('buildPrompt [declaratie, includeNameInSong=false din greseala]: NU are niciun efect — "Recipient:" ramane prezent (STRICT pentru pentru-mine)', () => {
  const order = {
    plan: 'standard', lang: 'ro', genre: 'pop', occasion: 'declaratie',
    recipient: 'Maria', senderName: 'Andrei', relationship: 'sotie',
    includeNameInSong: false, voicePreference: 'auto',
    story: 'O poveste de dragoste intre noi doi.'
  };
  const prompt = buildPrompt(order, '', null);
  assert.ok(prompt.includes('Recipient: Maria'), prompt);
});

// ===================================================================================================
// 6) PLASA DE SIGURANTA / BUGET: worst-case (toate 5 teme x 8 limbi, nume lung, duet, poveste
//    lunga, includeNameInSong=true) — promptul ramane <= 600, nicio exceptie.
// ===================================================================================================
test('PLASA DE SIGURANTA: worst-case pentru-mine (nume lung+duet+poveste lunga, toate temele x toate limbile) ramane <= 600', () => {
  let worst = 0;
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      const order = selfOrder({
        lang, selfTheme: theme, includeNameInSong: true,
        recipient: 'Alexandra-Gabriela-Theodorescu', voicePreference: 'duet',
        story: 'O poveste foarte lunga, cu multe detalii importante despre viata mea, greutatile prin care am trecut si cum am reusit sa merg mai departe, cu incredere si speranta, chiar si atunci cand totul parea foarte greu.'
      });
      const prompt = buildPrompt(order, '', null);
      const len = Array.from(prompt).length;
      worst = Math.max(worst, len);
      assert.ok(len <= 600, `OVER BUDGET theme=${theme} lang=${lang} len=${len}: ${prompt}`);
    }
  }
  assert.ok(worst <= 600, `worst: ${worst}`);
});

// ===================================================================================================
// 7) PLASA DE SIGURANTA: worst-case cu includeNameInSong=false (instructiune "no name" FULL, mai
//    lunga decat variantele cu nume) — ramane <= 600 in toate cele 5 teme x 8 limbi.
// ===================================================================================================
test('PLASA DE SIGURANTA: worst-case pentru-mine CU nume exclus (instructiunea "no name") ramane <= 600', () => {
  let worst = 0;
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      const order = selfOrder({
        lang, selfTheme: theme, includeNameInSong: false,
        recipient: 'Alexandra-Gabriela-Theodorescu', voicePreference: 'duet',
        story: 'O poveste foarte lunga, cu multe detalii importante despre viata mea, greutatile prin care am trecut si cum am reusit sa merg mai departe, cu incredere si speranta, chiar si atunci cand totul parea foarte greu.'
      });
      const prompt = buildPrompt(order, '', null);
      const len = Array.from(prompt).length;
      worst = Math.max(worst, len);
      assert.ok(len <= 600, `OVER BUDGET theme=${theme} lang=${lang} len=${len}: ${prompt}`);
      assert.ok(!prompt.includes('Alexandra'), prompt);
    }
  }
  assert.ok(worst <= 600, `worst: ${worst}`);
});

// ===================================================================================================
// 8) Nicio linie dubla/goala irosita cand "Recipient:" e omis (fix cosmetic, server.js).
// ===================================================================================================
test('buildPrompt [pentru-mine, includeNameInSong=false]: nu lasa spatiu dublu (". Story" nu ".  Story") dupa omiterea liniei Recipient', () => {
  const prompt = buildPrompt(selfOrder({ includeNameInSong: false }), '', null);
  assert.ok(!prompt.includes('  '), `nu trebuie sa existe spatiu dublu: ${prompt}`);
});
