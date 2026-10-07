// Harness de simulare: executa CODUL REAL extras din public/se-compune.html intr-un sandbox
// Node (modulul vm, parte din Node — nicio dependenta noua), cu document/window/fetch/
// localStorage/timere FALSE, controlate manual din teste. Scopul: verifica comportamentul
// REAL al control-flow-ului de polling (concurenta, timeout, recovery) sub conditii care nu
// pot fi validate prin simpla inspectie statica a sursei (ex. "se reseteaza pollInFlight dupa
// un abort?" e o proprietate de RUNTIME, nu un pattern de text).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(__dirname, '..', '..', 'public', 'se-compune.html');

function loadScriptSrc() {
  const html = fs.readFileSync(SRC_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('nu am gasit <script> in public/se-compune.html');
  return m[1];
}

// ---------- Fake timer scheduler (control manual, fara asteptare reala) ----------
function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { fireAt, fn, interval (ms sau null) }

  function setTimeoutFake(fn, ms) {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, fn, interval: null });
    return id;
  }
  function setIntervalFake(fn, ms) {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, fn, interval: ms });
    return id;
  }
  function clearTimeoutFake(id) { timers.delete(id); }

  // Avanseaza timpul pas cu pas, declansand orice timer scadent, in ordine cronologica.
  // IMPORTANT: NU asteapta promisiunea intoarsa de callback — exact ca intr-un browser real,
  // schedulerul de timere APELEAZA callback-ul, nu asteapta ca lantul lui async intern (care
  // poate programa alte timere mult mai departe in timp) sa se termine complet.
  async function advance(ms) {
    const target = now + ms;
    let safety = 0;
    while (true) {
      if (++safety > 5000) throw new Error('fake clock: prea multe iteratii (posibil loop infinit) — oprit defensiv');
      let earliest = null;
      for (const [id, t] of timers) {
        if (t.fireAt <= target && (earliest === null || t.fireAt < earliest.fireAt)) earliest = { id, ...t };
      }
      if (!earliest) break;
      now = earliest.fireAt;
      if (earliest.interval == null) timers.delete(earliest.id);
      else timers.set(earliest.id, { ...timers.get(earliest.id), fireAt: now + earliest.interval });
      try { earliest.fn(); } catch (e) { console.error('eroare sincrona in callback de timer:', e); }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = target;
  }
  return { setTimeoutFake, setIntervalFake, clearTimeoutFake, advance, getNow: () => now };
}

// ---------- Fake DOM minimal ----------
function makeFakeElement() {
  const classes = new Set();
  return {
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    style: {},
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else { force ? classes.add(c) : classes.delete(c); } }
    },
    appendChild: () => {},
    disabled: false,
    addEventListener: () => {}
  };
}

function buildSandbox({ fetchImpl, initialSearch = '?id=test-order-id&token=test-token-abc' }) {
  const clock = makeFakeClock();
  const elements = new Map();
  const log = { analytics: [], redirects: [] };

  const fakeDocument = {
    documentElement: { lang: '' },
    hidden: false,
    visibilityState: 'visible',
    _visHandlers: [],
    addEventListener(type, cb) { if (type === 'visibilitychange') this._visHandlers.push(cb); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeFakeElement());
      return elements.get(id);
    },
    createElement: () => makeFakeElement(),
  };

  const fakeWindow = {
    location: { search: initialSearch, _href: '', set href(v) { this._href = v; log.redirects.push(v); }, get href() { return this._href; } },
    addEventListener(type, cb) { fakeWindow['_' + type + 'Handlers'] = fakeWindow['_' + type + 'Handlers'] || []; fakeWindow['_' + type + 'Handlers'].push(cb); },
    NalunaAnalytics: { track: (name, data) => log.analytics.push({ name, data }) },
    document: fakeDocument,
  };

  const storage = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const ctx = {
    document: fakeDocument,
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    URLSearchParams,
    fetch: (...args) => fetchImpl(...args),
    setTimeout: clock.setTimeoutFake,
    clearTimeout: clock.clearTimeoutFake,
    setInterval: clock.setIntervalFake,
    clearInterval: clock.clearTimeoutFake, // acelasi Map de timere, stergerea e identica pt. ambele tipuri
    Date,
    console,
    encodeURIComponent,
    Math,
    AbortController,
  };
  vm.createContext(ctx);

  function run() {
    vm.runInContext(loadScriptSrc(), ctx, { filename: 'se-compune-inline.js' });
  }

  return { ctx, clock, elements, log, fakeDocument, fakeWindow, run };
}

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj };
}

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

module.exports = { buildSandbox, jsonResponse, flushMicrotasks, SRC_PATH };
