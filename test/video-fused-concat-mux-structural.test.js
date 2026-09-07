// PUNCT 7 (2026-09-06, continuare — "fuzioneaza ultimul nivel de concat cu mux-ul final"):
// verificari STRUCTURALE (fara randare reala — vezi test/video-fused-concat-mux-real.test.js
// pentru verificarea REALA de sincronizare/corectitudine) ca:
// - pipeline-ul VECHI (concatBatchWithCrossfades/concatWithCrossfades) ramane NESCHIMBAT, ca
//   fallback sigur — nicio linie modificata in acele doua functii;
// - fuziunea (concatFinalBatchWithMux/concatWithCrossfadesAndMux) exista, foloseste EXACT
//   aceleasi setari de calitate ca mux-ul vechi (VIDEO_FINAL_CRF, VIDEO_BT709_TAG_ARGS, AAC,
//   faststart) — nicio reducere de rezolutie/FPS/bitrate/calitate;
// - orice esec al fuziunii REVINE STRICT la pipeline-ul vechi (fallback), niciodata o eroare
//   propagata direct catre client;
// - apelantul (generateLyricVideo) sare peste mux-ul separat STRICT cand fuziunea a reusit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFn(name) {
  let idx = server.indexOf('function ' + name + '(');
  const asyncIdx = server.lastIndexOf('async ', idx);
  if (asyncIdx !== -1 && server.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;
  assert.ok(idx !== -1, `nu am gasit functia ${name} in server.js`);
  let depth = 0, i = server.indexOf('{', idx);
  const start = idx;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  return server.slice(start, i + 1);
}

test('STRUCTURAL: pipeline-ul VECHI (concatBatchWithCrossfades, concatWithCrossfades) ramane definit, NESCHIMBAT — fallback sigur, folosit direct de concatWithCrossfadesAndMux la esecul fuziunii', () => {
  assert.match(server, /async function concatBatchWithCrossfades\(segmentPaths, shots, order, batchTag\) \{/);
  assert.match(server, /async function concatWithCrossfades\(segmentPaths, shots, order\) \{/);
});

test('STRUCTURAL: concatFinalBatchWithMux() foloseste EXACT setarile de calitate ale mux-ului vechi — VIDEO_FINAL_CRF (nu INTERMEDIATE), VIDEO_BT709_TAG_ARGS, pix_fmt yuv420p, AAC 192k, faststart — nicio reducere de calitate', () => {
  const fn = extractFn('concatFinalBatchWithMux');
  assert.match(fn, /'-crf', String\(VIDEO_FINAL_CRF\)/);
  assert.match(fn, /'-pix_fmt', 'yuv420p'/);
  assert.match(fn, /\.\.\.VIDEO_BT709_TAG_ARGS/);
  assert.match(fn, /'-c:a', 'aac', '-b:a', '192k'/);
  assert.match(fn, /'-movflags', '\+faststart'/);
  assert.match(fn, /'-shortest'/);
  assert.match(fn, /subtitles='\$\{assForFilter\}'/);
  assert.match(fn, /'-preset', VIDEO_ENCODE_PRESET/);
});

test('STRUCTURAL: concatFinalBatchWithMux() foloseste ACELEASI tranzitii xfade (transitionOut/transitionDuration per-granita, MEMORY_XFADE_SECONDS ca fallback) ca si concatBatchWithCrossfades() — nicio schimbare a montajului', () => {
  const fused = extractFn('concatFinalBatchWithMux');
  const old = extractFn('concatBatchWithCrossfades');
  const extractXfadeLine = (src) => {
    const m = src.match(/filter \+= `\[\$\{lastLabel\}\]\[\$\{i\}:v\]xfade=transition=\$\{transition\}:duration=\$\{xfadeDuration\}:offset=\$\{offset\.toFixed\(3\)\}\[[^\]]*\];`;/);
    assert.ok(m, 'linia xfade trebuie gasita');
    return m[0].replace(/\[[a-zA-Z0-9]*\]`;$/, '');
  };
  assert.equal(extractXfadeLine(fused), extractXfadeLine(old));
});

test('STRUCTURAL: concatWithCrossfadesAndMux() incearca ÎNTÂI single-pass (TOATE segmentele, un singur concatFinalBatchWithMux) ÎNAINTE de arborele pe loturi — PUNCT 8, 2026-09-07', () => {
  const fn = extractFn('concatWithCrossfadesAndMux');
  // a doua aparitie — prima e ramura "un singur cadru total" (currentSegments.length === 1), care nu
  // e legata de comparatia single-pass-vs-arbore.
  const firstOccurrenceIdx = fn.indexOf('const fused = await concatFinalBatchWithMux(currentSegments, currentShots, order, audioFilePath, assForFilter);');
  const singlePassIdx = fn.indexOf('const fused = await concatFinalBatchWithMux(currentSegments, currentShots, order, audioFilePath, assForFilter);', firstOccurrenceIdx + 1);
  const whileIdx = fn.indexOf('while (currentSegments.length > 1) {');
  assert.notEqual(singlePassIdx, -1, 'apelul single-pass catre concatFinalBatchWithMux trebuie sa existe');
  assert.notEqual(whileIdx, -1);
  assert.ok(singlePassIdx < whileIdx, 'single-pass trebuie incercat INAINTE de arborele pe loturi (while), nu doar la ultimul nivel al arborelui');
  assert.match(fn, /perfLog\(order\.id, 'memory_concat_strategy', `strategie=single_pass, intrari=\$\{currentSegments\.length\}`\);/);
});

test('STRUCTURAL: daca single-pass esueaza, arborele pe loturi (NESCHIMBAT) preia — inclusiv fuziunea DOAR pentru ultimul nivel al arborelui (batchStarts.length === 1), fallback la concatBatchWithCrossfades (fundal mut) daca si ACEEA esueaza', () => {
  const fn = extractFn('concatWithCrossfadesAndMux');
  assert.match(fn, /const isLastLevel = batchStarts\.length === 1;/);
  assert.match(fn, /if \(isLastLevel\) \{/);
  assert.match(fn, /catch \(err\) \{\s*\n\s*console\.error\(`Comanda \$\{order\.id\}: fuziunea concat\+mux a esuat, revin la pipeline-ul vechi/);
  assert.match(fn, /const silentPath = await concatBatchWithCrossfades\(currentSegments, currentShots, order, `L\$\{level\}-0`\);/);
  assert.match(fn, /return \{ path: silentPath, muxed: false \};/);
});

test('STRUCTURAL: single-pass NU propaga niciodata eroarea direct — orice esec e prins, logat cu motiv (fara date personale, STRICT err.message tehnic) si urmat de arborele NESCHIMBAT', () => {
  const fn = extractFn('concatWithCrossfadesAndMux');
  const firstOccurrenceIdx = fn.indexOf('const fused = await concatFinalBatchWithMux(currentSegments, currentShots, order, audioFilePath, assForFilter);');
  const singlePassIdx = fn.indexOf('const fused = await concatFinalBatchWithMux(currentSegments, currentShots, order, audioFilePath, assForFilter);', firstOccurrenceIdx + 1);
  const body = fn.slice(Math.max(0, singlePassIdx - 200), singlePassIdx + 700);
  assert.match(body, /try \{/);
  assert.match(body, /catch \(err\) \{/);
  assert.match(body, /console\.error\(`Comanda \$\{order\.id\}: single-pass \(\$\{currentSegments\.length\} intrari\) a esuat, revin la arborele pe loturi: \$\{err\.message\}`\);/);
  assert.match(body, /perfLog\(order\.id, 'memory_concat_strategy', `strategie=arbore_fallback, intrari=\$\{currentSegments\.length\}, motiv=\$\{\(err && err\.message\) \|\| 'necunoscut'\}`\);/);
});

test('STRUCTURAL: cazul cu UN SINGUR cadru total (nicio reducere necesara) e tot fuzionat — spre deosebire de concatWithCrossfades() (care returneaza brut segmentul), aici tot se aplica subtitrari+audio+codare finala, cu acelasi fallback la esec', () => {
  const fn = extractFn('concatWithCrossfadesAndMux');
  assert.match(fn, /if \(currentSegments\.length === 1\) \{/);
});

test('STRUCTURAL: buildMemoryBackground() primeste acum assForFilter si incearca fuziunea STRICT daca are audio+subtitrari disponibile (canFuse) — altfel ramane STRICT pe pipeline-ul vechi (muxed:false), niciodata o schimbare de comportament pentru apelantii care nu furnizeaza subtitrari', () => {
  const fn = extractFn('buildMemoryBackground');
  assert.match(fn, /async function buildMemoryBackground\(order, mediaItems, durationSeconds, sectionTimings, songFilePath, assForFilter\)/);
  assert.match(fn, /const canFuse = !!\(songFilePath && assForFilter\);/);
  assert.match(fn, /concatWithCrossfadesAndMux\(segments, shotPlan, order, songFilePath, assForFilter\)/);
  assert.match(fn, /return \{ backgroundPath, cleanupPaths, muxed \};/);
});

test('STRUCTURAL: apelantul (generateLyricVideo) sare peste mux-ul separat STRICT cand memoryBackground.muxed e true — muta direct rezultatul fuzionat la calea asteptata (tempVideo), fara nicio reencodare suplimentara', () => {
  const fn = extractFn('generateLyricVideo');
  assert.match(fn, /if \(memoryBackground && memoryBackground\.muxed\) \{/);
  assert.match(fn, /fs\.renameSync\(memoryBackground\.backgroundPath, tempVideo\);/);
  // ramura veche (else) trebuie sa contina STRICT acelasi apel ffmpeg de mux ca inainte de aceasta
  // optimizare — nicio schimbare a pipeline-ului de rezerva.
  assert.match(fn, /\} else \{[\s\S]*?perfLog\(order\.id, 'final_mux_start'\);[\s\S]*?await execFfmpeg\(\[[\s\S]*?'-crf', String\(VIDEO_FINAL_CRF\)[\s\S]*?tempVideo\s*\n\s*\], \{ timeout: 600000 \}\);/);
});
