// PUNCT (2026-09-07): compresie client-side a materialelor video mari — vezi
// public/js/media-compress.js. Acest fisier verifica STRICT caile de SIGURANTA/FALLBACK ale
// maybeCompressVideo() — cerinta explicita a clientului: "clientul nu trebuie sa piarda
// fisierele selectate, sa repete selectia sau sa ramana blocat", indiferent ce merge prost.
//
// Foloseste un <video>/document FALS, minimal, STRICT pentru a putea executa
// probeVideoMeta()/maybeCompressVideo() in Node (fara un browser real) — nu inlocuieste un test
// real pe dispozitiv pentru calea de succes (decodare/encodare WebCodecs reala), care ramane
// neverificabila din acest mediu (vezi raportul). Ceea ce se testeaza AICI, real, e ca logica de
// DECIZIE si de FALLBACK e corecta — partea cea mai critica pentru siguranta productiei.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function makeFakeVideoElement(behavior) {
  const el = {
    _listeners: {},
    muted: false,
    playsInline: false,
    preload: '',
    duration: NaN,
    videoWidth: 0,
    videoHeight: 0,
    ended: true,
    addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); },
    removeEventListener() {},
    play() { return Promise.resolve(); },
    pause() {},
    requestVideoFrameCallback: behavior.requestVideoFrameCallback || undefined,
    set src(v) {
      this._src = v;
      if (behavior.failMetadata) {
        setTimeout(() => (this._listeners.error || []).forEach(cb => cb()), 0);
        return;
      }
      this.duration = behavior.durationSeconds;
      this.videoWidth = behavior.width;
      this.videoHeight = behavior.height;
      setTimeout(() => (this._listeners.loadedmetadata || []).forEach(cb => cb()), 0);
      setTimeout(() => (this._listeners.loadeddata || []).forEach(cb => cb()), 0);
    },
    get src() { return this._src; }
  };
  return el;
}

function loadModule(fakeWindow) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'media-compress.js'), 'utf8');
  // 'document'/'URL' sunt referentiate ca globale BARE in codul de productie (exact cum ar face-o
  // orice script inline intr-un browser real, unde document/URL sunt globale adevarate) — le
  // adaugam explicit ca parametri aici, ca sa se rezolve la stub-urile noastre, nu la lipsa lor.
  const fn = new Function('window', 'globalThis', 'document', 'URL', src + '\nreturn window.NalunaMediaCompress;');
  return fn(fakeWindow, fakeWindow, fakeWindow.document, fakeWindow.URL);
}

function baseFakeWindow(videoBehavior, extra) {
  return Object.assign({
    document: {
      createElement: (tag) => {
        assert.equal(tag, 'video');
        return makeFakeVideoElement(videoBehavior);
      }
    },
    URL: {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {}
    }
  }, extra || {});
}

test('maybeCompressVideo: fisier NE-video (poza) -> intoarce STRICT originalul, motiv "nu_e_video", fara sa atinga deloc pipeline-ul de compresie', async () => {
  const mod = loadModule(baseFakeWindow({ durationSeconds: 10, width: 100, height: 100 }));
  const file = { type: 'image/jpeg', size: 5 * 1024 * 1024, name: 'poza.jpg' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'nu_e_video');
  assert.equal(result.file, file);
});

test('maybeCompressVideo: WebCodecs indisponibil in browser (fara VideoEncoder/VideoDecoder/VideoFrame) -> intoarce STRICT originalul, clientul continua normal', async () => {
  const mod = loadModule(baseFakeWindow({ durationSeconds: 300, width: 1920, height: 1080 }));
  const file = { type: 'video/quicktime', size: 800 * 1024 * 1024, name: 'video-mare.mov' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'webcodecs_indisponibil');
  assert.equal(result.file, file, 'fisierul original trebuie returnat NESCHIMBAT');
});

test('maybeCompressVideo: fisier video mic, sub pragul de beneficiu -> NU incearca compresia (chiar daca WebCodecs e "disponibil"), intoarce originalul', async () => {
  const fakeWindow = baseFakeWindow(
    { durationSeconds: 5, width: 1920, height: 1080 },
    { VideoEncoder: function () {}, VideoDecoder: function () {}, VideoFrame: function () {} }
  );
  const mod = loadModule(fakeWindow);
  const file = { type: 'video/mp4', size: 5 * 1024 * 1024, name: 'clip-mic.mp4' }; // 5MB, sub COMPRESS_MIN_BYTES
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'deja_mic');
  assert.equal(result.file, file);
});

test('maybeCompressVideo: metadata nu se incarca (fisier corupt/neobisnuit, elementul <video> declanseaza "error") -> revine STRICT la original (probeVideoMeta() intoarce null controlat, niciodata o exceptie care blocheaza coada)', async () => {
  const fakeWindow = baseFakeWindow(
    { failMetadata: true },
    { VideoEncoder: function () {}, VideoDecoder: function () {}, VideoFrame: function () {} }
  );
  const mod = loadModule(fakeWindow);
  const file = { type: 'video/mp4', size: 200 * 1024 * 1024, name: 'clip-corupt.mp4' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'metadata_timeout');
  assert.equal(result.file, file);
});

test('maybeCompressVideo: requestVideoFrameCallback indisponibil (browser cu WebCodecs dar fara aceasta API) -> eroare prinsa intern, revine la original, NU arunca', async () => {
  const fakeWindow = baseFakeWindow(
    { durationSeconds: 300, width: 1920, height: 1080 }, // fara requestVideoFrameCallback in behavior
    { VideoEncoder: function () { this.configure = () => {}; this.encode = () => {}; this.flush = () => Promise.resolve(); this.close = () => {}; }, VideoDecoder: function () {}, VideoFrame: function () {} }
  );
  const mod = loadModule(fakeWindow);
  const file = { type: 'video/quicktime', size: 800 * 1024 * 1024, name: 'video-mare.mov' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.match(result.reason, /^eroare_compresie/);
  assert.equal(result.file, file, 'fisierul original trebuie folosit — clientul nu pierde materialul');
});

test('maybeCompressVideo: VideoEncoder arunca la configure() (eroare API in timpul procesarii) -> prinsa, revine la original', async () => {
  let frameHandlerCalled = false;
  const videoBehavior = {
    durationSeconds: 300, width: 1920, height: 1080,
    requestVideoFrameCallback: function (cb) {
      if (frameHandlerCalled) return; // evita bucla infinita in test daca ceva nu opreste corect
      frameHandlerCalled = true;
      setTimeout(() => cb(0, { mediaTime: 0 }), 0);
    }
  };
  const fakeWindow = baseFakeWindow(videoBehavior, {
    VideoEncoder: function () {
      this.configure = () => { throw new Error('encoder API neasteptat de eroare'); };
      this.encode = () => {};
      this.flush = () => Promise.resolve();
      this.close = () => {};
    },
    VideoDecoder: function () {},
    VideoFrame: function () {}
  });
  const mod = loadModule(fakeWindow);
  const file = { type: 'video/quicktime', size: 800 * 1024 * 1024, name: 'video-mare.mov' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.match(result.reason, /^eroare_compresie/);
  assert.equal(result.file, file);
});

test('shouldAttemptCompression + maybeCompressVideo raman consistente: profilul EXACT al fisierului real de 841MB, cu WebCodecs indisponibil (cazul cel mai probabil pe un Safari mai vechi) -> upload-ul originalului continua neintrerupt', async () => {
  const fakeWindow = baseFakeWindow({ durationSeconds: 309.2, width: 1920, height: 1080 });
  const mod = loadModule(fakeWindow);
  const file = { type: 'video/quicktime', size: 882145640, name: 'video-real.mov' };
  const result = await mod.maybeCompressVideo(file);
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'webcodecs_indisponibil');
  assert.equal(result.file, file);
});

test('mai multe fisiere simultan: apeluri PARALELE la maybeCompressVideo (fisiere diferite) nu interfereaza intre ele — fiecare isi pastreaza propriul rezultat corect', async () => {
  const fakeWindow = baseFakeWindow(
    { durationSeconds: 5, width: 1920, height: 1080 },
    { VideoEncoder: function () {}, VideoDecoder: function () {}, VideoFrame: function () {} }
  );
  const mod = loadModule(fakeWindow);
  const photo = { type: 'image/jpeg', size: 3 * 1024 * 1024, name: 'a.jpg' };
  const smallVideo = { type: 'video/mp4', size: 5 * 1024 * 1024, name: 'b.mp4' };
  const [r1, r2] = await Promise.all([
    mod.maybeCompressVideo(photo),
    mod.maybeCompressVideo(smallVideo)
  ]);
  assert.equal(r1.reason, 'nu_e_video');
  assert.equal(r1.file, photo);
  assert.equal(r2.reason, 'deja_mic');
  assert.equal(r2.file, smallVideo);
});
