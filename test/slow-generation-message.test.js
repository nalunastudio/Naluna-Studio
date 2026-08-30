// Teste pentru CORECȚIA 2026-08-30 — mesajul de "generare/randare dureaza mai mult decat de
// obicei" a fost inlocuit cu un mesaj fix, pe exact 3 randuri, identic ca STRUCTURA (linia 1 si
// linia 3) pentru melodie (public/se-compune.html) si videoclip (public/se-creeaza-video.html),
// cu linia 2 specifica fiecarui context. Mesajul ramane STRICT legat de starea "inca in
// procesare, confirmata de server" — niciodata o stare de eroare — si foloseste noduri text
// sigure (.textContent), nu innerHTML cu traduceri interpolate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

const LINE1_BY_LANG = {
  ro: 'Naluna Studio este foarte solicitat în acest moment ✨',
  en: 'Naluna Studio is in very high demand right now ✨',
  de: 'Naluna Studio ist im Moment sehr gefragt ✨',
  es: 'Naluna Studio tiene una gran demanda en este momento ✨',
  it: 'Naluna Studio è molto richiesto in questo momento ✨',
  fr: 'Naluna Studio est très sollicité en ce moment ✨',
  bg: 'Naluna Studio е много търсено в момента ✨',
  tr: 'Naluna Studio şu anda çok yoğun talep görüyor ✨'
};
const LINE3_BY_LANG = {
  ro: 'Rămâi pe pagină — este aproape gata.',
  en: 'Stay on this page — it’s almost ready.',
  de: 'Bleib auf dieser Seite — es ist fast fertig.',
  es: 'Quédate en esta página — ya casi está lista.',
  it: 'Rimani su questa pagina — è quasi pronta.',
  fr: 'Restez sur cette page — elle est presque prête.',
  bg: 'Остани на тази страница — почти е готова.',
  tr: 'Bu sayfada kalın — neredeyse hazır.'
};
const SONG_LINE2_BY_LANG = {
  ro: 'Melodia ta poate avea nevoie de puțin mai mult timp pentru procesare.',
  en: 'Your song may need a little more time to process.',
  de: 'Dein Lied benötigt möglicherweise etwas mehr Zeit für die Verarbeitung.',
  es: 'Tu canción puede necesitar un poco más de tiempo para procesarse.',
  it: 'La tua canzone potrebbe richiedere un po’ più di tempo per l’elaborazione.',
  fr: 'Votre chanson peut nécessiter un peu plus de temps de traitement.',
  bg: 'Песента ти може да се нуждае от още малко време за обработка.',
  tr: 'Şarkınızın işlenmesi biraz daha uzun sürebilir.'
};
const VIDEO_LINE2_BY_LANG = {
  ro: 'Videoclipul tău poate avea nevoie de puțin mai mult timp pentru procesare.',
  en: 'Your video may need a little more time to process.',
  de: 'Dein Video benötigt möglicherweise etwas mehr Zeit für die Verarbeitung.',
  es: 'Tu video puede necesitar un poco más de tiempo para procesarse.',
  it: 'Il tuo video potrebbe richiedere un po’ più di tempo per l’elaborazione.',
  fr: 'Votre vidéo peut nécessiter un peu plus de temps de traitement.',
  bg: 'Видеото ти може да се нуждае от още малко време за обработка.',
  tr: 'Videonuzun işlenmesi biraz daha uzun sürebilir.'
};

function loadTranslations(html) {
  const start = html.indexOf('const T = ');
  const idx = start !== -1 ? start : html.indexOf('const translations = ');
  assert.notEqual(idx, -1, 'obiectul de traduceri trebuie sa existe');
  let depth = 0, i = html.indexOf('{', idx);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  const varName = start !== -1 ? 'T' : 'translations';
  const src = html.slice(idx, i + 1);
  return new Function(`${src}\nreturn ${varName};`)();
}

for (const [file, line2Map, label, failedFnName] of [
  ['public/se-compune.html', SONG_LINE2_BY_LANG, 'melodie', 'handleGenerationFailed'],
  ['public/se-creeaza-video.html', VIDEO_LINE2_BY_LANG, 'video', 'handleFailed']
]) {
  const html = read(file);

  test(`${file}: markup-ul #long-notice contine EXACT 3 elemente text (titlu/sub/linia 3), fara alte modificari de structura`, () => {
    assert.match(html, /<div class="soft-notice" id="long-notice" style="text-align:center;">\s*<strong id="long-notice-title"><\/strong><br>\s*<span id="long-notice-sub"><\/span><br>\s*<span id="long-notice-line3"><\/span>\s*<\/div>/);
  });

  test(`${file}: cele 3 randuri sunt scrise STRICT prin .textContent (noduri text sigure), niciodata innerHTML`, () => {
    assert.match(html, /document\.getElementById\('long-notice-title'\)\.textContent = t\.longTitle;/);
    assert.match(html, /document\.getElementById\('long-notice-sub'\)\.textContent = t\.longSub;/);
    assert.match(html, /document\.getElementById\('long-notice-line3'\)\.textContent = t\.longLine3;/);
    assert.ok(!html.includes("getElementById('long-notice-title').innerHTML"));
    assert.ok(!html.includes("getElementById('long-notice-sub').innerHTML"));
    assert.ok(!html.includes("getElementById('long-notice-line3').innerHTML"));
  });

  test(`${file}: textul (${label}) e exact cel cerut, in toate cele 8 limbi`, () => {
    const T = loadTranslations(html);
    for (const lang of LANGS) {
      assert.equal(T[lang].longTitle, LINE1_BY_LANG[lang], `linia 1 (${lang}) trebuie sa fie identica intre melodie si video`);
      assert.equal(T[lang].longSub, line2Map[lang], `linia 2 (${lang}, ${label}) trebuie sa fie textul specific ${label}`);
      assert.equal(T[lang].longLine3, LINE3_BY_LANG[lang], `linia 3 (${lang}) trebuie sa fie identica intre melodie si video`);
    }
  });

  test(`${file}: vechiul mesaj ("dureaza putin mai mult decat de obicei") nu mai exista in nicio limba`, () => {
    assert.ok(!/dureaz[ăa] pu[țt]in mai mult decât de obicei|is taking a little longer than usual|braucht etwas länger als sonst|está tardando un poco más de lo habitual|sta impiegando un po. più del solito|prend un peu plus de temps que d.habitude|отнема малко повече време от обичайното|her zamankinden biraz daha uzun sürüyor/i.test(html));
  });

  test(`${file}: mesajul ramane STRICT legat de starea "inca in procesare" — ascuns explicit la starea finala de esec, niciodata transformat in mesaj de eroare`, () => {
    assert.match(html, /function hideLongNotice\(\) \{[\s\S]{0,120}longNoticeEl\.style\.display = 'none';[\s\S]{0,20}\}/);
    const failIdx = html.indexOf(`function ${failedFnName}() {`);
    assert.notEqual(failIdx, -1, `${file} trebuie sa aiba un handler dedicat starii finale de esec (${failedFnName})`);
    const failEnd = html.indexOf('\n  }', failIdx);
    const failBody = html.slice(failIdx, failEnd);
    assert.match(failBody, /hideLongNotice\(\);/, 'starea de esec trebuie sa ascunda explicit mesajul de "dureaza mai mult" — nu trebuie sa devina el insusi mesajul de eroare');
  });

  test(`${file}: ramane sintactic valid dupa aceasta corectie`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 1);
    scripts.forEach(m => { new Function(m[1]); });
  });
}

test('public/se-compune.html si public/se-creeaza-video.html: linia 1 si linia 3 sunt IDENTICE intre cele doua pagini, in toate cele 8 limbi (reutilizarea explicita ceruta)', () => {
  const songHtml = read('public/se-compune.html');
  const videoHtml = read('public/se-creeaza-video.html');
  const songT = loadTranslations(songHtml);
  const videoT = loadTranslations(videoHtml);
  for (const lang of LANGS) {
    assert.equal(songT[lang].longTitle, videoT[lang].longTitle, `linia 1 (${lang}) trebuie sa fie identica`);
    assert.equal(songT[lang].longLine3, videoT[lang].longLine3, `linia 3 (${lang}) trebuie sa fie identica`);
    assert.notEqual(songT[lang].longSub, videoT[lang].longSub, `linia 2 (${lang}) trebuie sa fie DIFERITA (melodie vs. video)`);
  }
});
