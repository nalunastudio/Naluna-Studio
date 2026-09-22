// SMART PREVIEW ANALYTICS (2026-09-22) — comportamentul playerului de preview in
// public/melodia-mea.html: preview_played, preview_progress_25/50/75/100, preview_completed,
// preview_replayed. Executie REALA a functiilor extrase din pagina (acelasi tipar ca
// test/amintiri-video-iphone-ux.test.js — stub-uri minimale de DOM, fara jsdom).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
const page = read('public/melodia-mea.html');
const server = read('server.js');
const analyticsJs = read('public/js/analytics.js');

function extractFn(name) {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `functia ${name} trebuie sa existe in melodia-mea.html`);
  let depth = 0, i = page.indexOf('{', start);
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') { depth--; if (depth === 0) break; }
  }
  return page.slice(start, i + 1);
}

function extractConst(name) {
  const idx = page.indexOf(`var ${name} =`);
  assert.ok(idx !== -1, `constanta ${name} trebuie sa existe`);
  const end = page.indexOf(';', idx);
  return page.slice(idx, end + 1);
}

function makeFakeAudioEl(overrides) {
  const listeners = {};
  return Object.assign({
    currentTime: 0,
    duration: 100,
    addEventListener(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    _trigger(evt) { (listeners[evt] || []).forEach((fn) => fn()); }
  }, overrides || {});
}

function loadModule(orderIdValue) {
  const src = [
    typeof orderIdValue === 'undefined' ? '' : `var orderId = ${JSON.stringify(orderIdValue)};`,
    extractConst('PREVIEW_REPLAY_RESTART_THRESHOLD_SECONDS'),
    extractConst('PREVIEW_SUBSTANTIAL_LISTEN_FRACTION'),
    extractFn('previewStartBucket'),
    extractFn('isGenuineReplayStart'),
    extractFn('newlyReachedProgressMilestones'),
    'var previewAnalyticsState = {};',
    extractFn('attachPreviewAnalytics')
  ].join('\n');
  const sandboxSrc = `${src}\nreturn { previewStartBucket, isGenuineReplayStart, newlyReachedProgressMilestones, attachPreviewAnalytics, previewAnalyticsState };`;
  return new Function('window', sandboxSrc);
}

function loadFresh(fakeWindow, orderIdValue) {
  return loadModule(orderIdValue)(fakeWindow);
}

function makeFakeWindow() {
  const calls = [];
  return {
    calls,
    NalunaAnalytics: { track: (eventName, meta) => calls.push({ eventName, meta }) }
  };
}

// ================================================================================================
// previewStartBucket
// ================================================================================================
test('previewStartBucket: intervale corecte, fara cardinalitate mare (bucket-uri, nu secunde exacte)', () => {
  const { previewStartBucket } = loadFresh(makeFakeWindow());
  assert.equal(previewStartBucket(0), '0');
  assert.equal(previewStartBucket(0.9), '0');
  assert.equal(previewStartBucket(1), '1-5');
  assert.equal(previewStartBucket(4.9), '1-5');
  assert.equal(previewStartBucket(5), '5-15');
  assert.equal(previewStartBucket(14.9), '5-15');
  assert.equal(previewStartBucket(15), '15-30');
  assert.equal(previewStartBucket(29.9), '15-30');
  assert.equal(previewStartBucket(30), '30-60');
  assert.equal(previewStartBucket(59.9), '30-60');
  assert.equal(previewStartBucket(60), '60+');
  assert.equal(previewStartBucket(200), '60+');
});

test('previewStartBucket: input invalid -> "unknown", fara eroare', () => {
  const { previewStartBucket } = loadFresh(makeFakeWindow());
  assert.equal(previewStartBucket(null), 'unknown');
  assert.equal(previewStartBucket(undefined), 'unknown');
  assert.equal(previewStartBucket(NaN), 'unknown');
  assert.equal(previewStartBucket('5'), 'unknown');
});

// ================================================================================================
// isGenuineReplayStart — cerinta explicita: pause->play NU e replay
// ================================================================================================
test('isGenuineReplayStart: dupa ascultare substantiala, restart de la aproape 0 = replay real', () => {
  const { isGenuineReplayStart } = loadFresh(makeFakeWindow());
  assert.equal(isGenuineReplayStart(0, true), true);
  assert.equal(isGenuineReplayStart(0.5, true), true);
});

test('isGenuineReplayStart: pauza -> play imediat (currentTime neschimbat, NU aproape de 0) NU e replay', () => {
  const { isGenuineReplayStart } = loadFresh(makeFakeWindow());
  assert.equal(isGenuineReplayStart(20, true), false, 'reluarea de la 20s dupa o pauza nu trebuie considerata replay');
  assert.equal(isGenuineReplayStart(35.2, true), false);
});

test('isGenuineReplayStart: restart de la 0 FARA ascultare substantiala anterioara NU e replay (e doar primul play real)', () => {
  const { isGenuineReplayStart } = loadFresh(makeFakeWindow());
  assert.equal(isGenuineReplayStart(0, false), false);
});

// ================================================================================================
// newlyReachedProgressMilestones
// ================================================================================================
test('newlyReachedProgressMilestones: fiecare prag STRICT o data — nu se retrimite dupa ce alreadyFired e setat', () => {
  const { newlyReachedProgressMilestones } = loadFresh(makeFakeWindow());
  const state = { p25: false, p50: false, p75: false, p100: false };
  assert.deepEqual(newlyReachedProgressMilestones(25, 100, state), ['25']);
  state.p25 = true;
  assert.deepEqual(newlyReachedProgressMilestones(26, 100, state), [], 'pragul 25 deja atins nu trebuie retrimis');
  assert.deepEqual(newlyReachedProgressMilestones(50, 100, state), ['50']);
});

test('newlyReachedProgressMilestones: sare direct la 100% (seek) -> raporteaza TOATE pragurile netrimise deodata, o singura data fiecare', () => {
  const { newlyReachedProgressMilestones } = loadFresh(makeFakeWindow());
  const state = { p25: false, p50: false, p75: false, p100: false };
  const milestones = newlyReachedProgressMilestones(100, 100, state);
  assert.deepEqual(milestones, ['25', '50', '75', '100']);
});

test('newlyReachedProgressMilestones: durata invalida/lipsa -> [] fara eroare', () => {
  const { newlyReachedProgressMilestones } = loadFresh(makeFakeWindow());
  const state = { p25: false, p50: false, p75: false, p100: false };
  assert.deepEqual(newlyReachedProgressMilestones(10, NaN, state), []);
  assert.deepEqual(newlyReachedProgressMilestones(10, 0, state), []);
  assert.deepEqual(newlyReachedProgressMilestones(10, undefined, state), []);
  assert.deepEqual(newlyReachedProgressMilestones(NaN, 100, state), []);
});

// ================================================================================================
// attachPreviewAnalytics — comportament complet, cu <audio> fals
// ================================================================================================
test('attachPreviewAnalytics: preview_played trimis O SINGURA DATA la primul play, cu selectionReason+startBucket', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 0 });
  attachPreviewAnalytics(audio, { variantId: 'v1', plan: 'standard', selectionReason: 'first_vocal_word', previewStartSeconds: 12 });
  audio._trigger('play');
  audio._trigger('play'); // al doilea play, fara ascultare substantiala intre timp -> nu mai retrimite preview_played, nici replay (currentTime tot 0 dar wasSubstantiallyListened=false)
  const playedCalls = win.calls.filter((c) => c.eventName === 'preview_played');
  assert.equal(playedCalls.length, 1);
  assert.deepEqual(playedCalls[0].meta, { variantId: 'v1', plan: 'standard', selectionReason: 'first_vocal_word', startBucket: '5-15' });
});

test('attachPreviewAnalytics: pragurile de progres 25/50/75/100 se trimit STRICT o data fiecare, in ordine, prin timeupdate', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 0, duration: 40 });
  attachPreviewAnalytics(audio, { variantId: 'v2', plan: 'standard', previewStartSeconds: 0 });
  audio._trigger('play');
  for (const pct of [0.1, 0.25, 0.3, 0.5, 0.6, 0.75, 0.8, 1.0, 1.0]) {
    audio.currentTime = 40 * pct;
    audio._trigger('timeupdate');
  }
  const progressEvents = win.calls.filter((c) => c.eventName.startsWith('preview_progress_')).map((c) => c.eventName);
  assert.deepEqual(progressEvents, ['preview_progress_25', 'preview_progress_50', 'preview_progress_75', 'preview_progress_100']);
  for (const c of win.calls.filter((c) => c.eventName.startsWith('preview_progress_'))) {
    assert.deepEqual(c.meta, { variantId: 'v2', plan: 'standard' }, 'evenimentele de progres nu trebuie sa contina alte chei (fara PII)');
  }
});

test('attachPreviewAnalytics: preview_completed trimis STRICT o data, la evenimentul nativ "ended"', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 40, duration: 40 });
  attachPreviewAnalytics(audio, { variantId: 'v3', plan: 'video', previewStartSeconds: 0 });
  audio._trigger('play');
  audio._trigger('ended');
  audio._trigger('ended'); // nu se poate intampla real de doua ori, dar verificam robustetea dedup-ului
  const completedCalls = win.calls.filter((c) => c.eventName === 'preview_completed');
  assert.equal(completedCalls.length, 1);
  assert.deepEqual(completedCalls[0].meta, { variantId: 'v3', plan: 'video' });
});

test('attachPreviewAnalytics: preview_replayed NU se trimite la o simpla pauza->play (continuarea aceleiasi ascultari)', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 0, duration: 40 });
  attachPreviewAnalytics(audio, { variantId: 'v4', plan: 'standard', previewStartSeconds: 0 });
  audio._trigger('play'); // preview_played
  audio.currentTime = 32; // 80% — ascultare substantiala
  audio._trigger('timeupdate');
  audio.currentTime = 20; // pauza si reluare de la 20s (NU de la 0) — continuare, nu replay
  audio._trigger('play');
  const replayedCalls = win.calls.filter((c) => c.eventName === 'preview_replayed');
  assert.equal(replayedCalls.length, 0, 'reluarea de la 20s dupa pauza nu trebuie sa produca un replay fals');
});

test('attachPreviewAnalytics: preview_replayed SE trimite cand redarea reincepe de la 0 dupa o ascultare substantiala reala', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 0, duration: 40 });
  attachPreviewAnalytics(audio, { variantId: 'v5', plan: 'standard', previewStartSeconds: 0 });
  audio._trigger('play'); // preview_played
  audio.currentTime = 40; // asculta pana la capat
  audio._trigger('timeupdate');
  audio._trigger('ended');
  audio.currentTime = 0; // clientul apasa din nou play, de la inceput
  audio._trigger('play');
  const replayedCalls = win.calls.filter((c) => c.eventName === 'preview_replayed');
  assert.equal(replayedCalls.length, 1);
  assert.deepEqual(replayedCalls[0].meta, { variantId: 'v5', plan: 'standard' });
});

test('attachPreviewAnalytics: fara variantId -> nu face nimic (nu arunca, nu atinge window.NalunaAnalytics)', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl();
  assert.doesNotThrow(() => attachPreviewAnalytics(audio, { plan: 'standard' }));
  audio._trigger('play');
  assert.equal(win.calls.length, 0);
});

test('attachPreviewAnalytics: NICIODATA nu trimite PII (story/lyrics/recipient/sender/email) — verificare structurala a chieilor trimise pe TOATE evenimentele', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win);
  const audio = makeFakeAudioEl({ currentTime: 0, duration: 40 });
  attachPreviewAnalytics(audio, { variantId: 'v6', plan: 'premium', selectionReason: 'vocal_onset_fallback', previewStartSeconds: 3 });
  audio._trigger('play');
  audio.currentTime = 40;
  audio._trigger('timeupdate');
  audio._trigger('ended');
  audio.currentTime = 0;
  audio._trigger('play');
  const forbiddenKeys = ['story', 'lyrics', 'recipient', 'senderName', 'sender', 'email', 'name'];
  for (const call of win.calls) {
    for (const key of Object.keys(call.meta)) {
      assert.ok(!forbiddenKeys.includes(key), `cheia interzisa "${key}" a aparut in evenimentul ${call.eventName}`);
    }
    const allowedKeys = ['variantId', 'plan', 'selectionReason', 'startBucket'];
    for (const key of Object.keys(call.meta)) {
      assert.ok(allowedKeys.includes(key), `cheie neasteptata "${key}" in evenimentul ${call.eventName}`);
    }
  }
});

// ================================================================================================
// orderId — corelare ulterioara in Admin ("checkout dupa preview"), aceeasi cheie rezervata
// folosita deja de checkout_clicked/checkout_returned_unpaid (bypasseaza TRACK_META_ALLOWLIST,
// vezi postTrackEvent din analytics.js).
// ================================================================================================
test('attachPreviewAnalytics: cand orderId exista in scope-ul paginii, e inclus in payload (necesar pentru corelarea checkout dupa preview)', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win, 'ord_abc123');
  const audio = makeFakeAudioEl({ currentTime: 0 });
  attachPreviewAnalytics(audio, { variantId: 'v7', plan: 'standard', previewStartSeconds: 0 });
  audio._trigger('play');
  const playedCalls = win.calls.filter((c) => c.eventName === 'preview_played');
  assert.equal(playedCalls.length, 1);
  assert.equal(playedCalls[0].meta.orderId, 'ord_abc123');
});

test('attachPreviewAnalytics: fara orderId in scope (pagina fara comanda incarcata inca) — nicio cheie orderId falsy trimisa', () => {
  const win = makeFakeWindow();
  const { attachPreviewAnalytics } = loadFresh(win); // fara al doilea argument -> orderId ramane undefined in sandbox
  const audio = makeFakeAudioEl({ currentTime: 0 });
  attachPreviewAnalytics(audio, { variantId: 'v8', plan: 'standard', previewStartSeconds: 0 });
  audio._trigger('play');
  const playedCalls = win.calls.filter((c) => c.eventName === 'preview_played');
  assert.ok(!('orderId' in playedCalls[0].meta));
});

// ================================================================================================
// CABLARE — ambele puncte de montare (Standard/Video si Premium) apeleaza attachPreviewAnalytics.
// ================================================================================================
test('cablare: mountAudio() (Standard/Video, renderVariants) apeleaza attachPreviewAnalytics cu v.id/order.plan/v.previewSelectionReason/v.previewStartSeconds', () => {
  assert.match(page, /attachPreviewAnalytics\(audioEl, \{ variantId: v\.id, plan: order\.plan, selectionReason: v\.previewSelectionReason, previewStartSeconds: v\.previewStartSeconds \}\)/);
});

test('cablare: createPremiumAudioPlayer() apeleaza attachPreviewAnalytics cu plan STRICT \'premium\'', () => {
  const fn = extractFn('createPremiumAudioPlayer');
  assert.match(fn, /attachPreviewAnalytics\(audioEl, \{ variantId: variantId, plan: 'premium', selectionReason: selectionReason, previewStartSeconds: previewStartSeconds \}\)/);
});

test('cablare: ambele apeluri createPremiumAudioPlayer(...) transmit v.id/v.previewStartSeconds/v.previewSelectionReason', () => {
  const matches = page.match(/createPremiumAudioPlayer\(v\.previewUrl, v\.durationSeconds, v\.id, v\.previewStartSeconds, v\.previewSelectionReason\)/g) || [];
  assert.ok(matches.length >= 2, `trebuie sa existe cel putin 2 apeluri (Premium result-view + compare-view), gasit ${matches.length}`);
});

// ================================================================================================
// SERVER — TRACKABLE_EVENTS / TRACK_META_ALLOWLIST includ cele 7 evenimente noi, fara PII in
// listele de chei permise.
// ================================================================================================
test('server.js: TRACKABLE_EVENTS include toate cele 7 evenimente noi de preview', () => {
  const match = server.match(/const TRACKABLE_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match);
  for (const ev of ['preview_played', 'preview_progress_25', 'preview_progress_50', 'preview_progress_75', 'preview_progress_100', 'preview_completed', 'preview_replayed']) {
    assert.ok(match[1].includes(`'${ev}'`), `lipseste evenimentul: ${ev}`);
  }
});

test('server.js: TRACK_META_ALLOWLIST pentru evenimentele de preview contine STRICT variantId/plan/selectionReason/startBucket — niciodata o cheie in plus', () => {
  const match = server.match(/const TRACK_META_ALLOWLIST = \{([\s\S]*?)\n\};/);
  assert.ok(match);
  const body = match[1];
  assert.match(body, /preview_played:\s*\['variantId', 'plan', 'selectionReason', 'startBucket'\]/);
  for (const ev of ['preview_progress_25', 'preview_progress_50', 'preview_progress_75', 'preview_progress_100', 'preview_completed', 'preview_replayed']) {
    assert.match(body, new RegExp(`${ev}:\\s*\\['variantId', 'plan'\\]`), `${ev} trebuie sa aiba STRICT ['variantId','plan']`);
  }
});

test('public/js/analytics.js: FUNNEL_TRACKABLE_EVENTS include toate cele 7 evenimente noi (aceleasi ca server.js — deja verificat identic de test/analytics-server.test.js)', () => {
  for (const ev of ['preview_played', 'preview_progress_25', 'preview_progress_50', 'preview_progress_75', 'preview_progress_100', 'preview_completed', 'preview_replayed']) {
    assert.ok(analyticsJs.includes(`'${ev}'`), `lipseste evenimentul: ${ev} din FUNNEL_TRACKABLE_EVENTS`);
  }
});

// RESTAURARE AUDIO (2026-09-22, revenire la comportamentul din be5b700 — Smart Preview anulat):
// safeVariants NU mai expune previewStartSeconds/previewSelectionReason (optiunea A, aleasa
// explicit) — acele campuri existau STRICT pentru mecanismul de selectie Smart Preview, eliminat.
// Playerul si analytics-ul functioneaza in continuare: attachPreviewAnalytics() (mai jos, KEPT)
// trateaza deja lipsa lor ca 'unknown' (previewStartBucket/selectionReason), fara nicio schimbare
// de cod necesara acolo — vezi testele de mai jos care confirma exact acest comportament gracios.
test('server.js: variantele NU mai expun previewStartSeconds/previewSelectionReason/previewSignals catre client (safeVariants) — restaurate la be5b700, optiunea A', () => {
  const idx = server.indexOf('const safeVariants = (order.variants || []).map(v => ({');
  assert.ok(idx !== -1);
  let depth = 0, i = server.indexOf('({', idx) + 1;
  for (; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = server.slice(idx, i + 1);
  assert.ok(!/previewStartSeconds\s*:/.test(body), 'previewStartSeconds nu mai trebuie expus — mecanismul Smart Preview a fost eliminat');
  assert.ok(!/previewSelectionReason\s*:/.test(body), 'previewSelectionReason nu mai trebuie expus — mecanismul Smart Preview a fost eliminat');
  assert.ok(!/previewSignals\s*:/.test(body), 'previewSignals nu a fost niciodata expus client-side, ramane asa');
});
