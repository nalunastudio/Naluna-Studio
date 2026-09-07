// PUNCT: reducerea timpului de pregatire/upload al materialelor foto/video (Cadou video),
// 2026-09-07 — vezi raportul de investigatie/prototip discutat cu clientul inainte de aceasta
// implementare. Modul PARTAJAT (incarcat de amintiri-video.html, comanda-mea.html, succes.html —
// singurele 3 pagini cu coada proprie de upload media), STRICT pentru compresia client-side a
// materialelor VIDEO mari, inainte de upload.
//
// DE CE doar video, niciodata poze: fotografiile din testul real de productie erau deja mici
// (JPEG cateva MB) — nu exista niciun beneficiu de comprimat imagini aici.
//
// DE CE fara track audio in fisierul comprimat: verificat DIRECT in server.js (renderShot()) —
// AMBELE ramuri (poza si video) folosesc explicit `-an` la randarea fiecarui cadru — audio-ul
// materialelor incarcate de client NU e FOLOSIT NICIODATA in videoclipul cadou final (audio-ul
// final vine STRICT din melodia Suno, adaugata abia la mux-ul final). Eliminarea completa a
// track-ului audio din fisierul comprimat e deci sigura si simplifica enorm implementarea
// (fara demultiplexare/reencodare audio, fara sincronizare A/V de gestionat).
//
// ARHITECTURA (aleasa dupa cercetare reala, nu presupunere — vezi raportul):
//   - WebCodecs (VideoEncoder) e SINGURA metoda cu suport real, documentat, pe Safari/iOS pentru
//     fisiere de aceasta dimensiune (400-850MB) — ffmpeg.wasm are OOM documentat la doar 200MB;
//     canvas+MediaRecorder(captureStream) are bug-uri documentate, specifice iOS.
//   - Decodarea sursei foloseste un element <video> ASCUNS (demultiplexor/decodor NATIV al
//     browserului, robust, deja folosit de toate playerele video de pe web) — NICIODATA un
//     demultiplexor scris de mana. Cadrele sunt extrase prin requestVideoFrameCallback (API
//     matur, disponibil din iOS 15) — NU prin captureStream() (calea cu bug-uri documentate).
//   - Fiecare cadru extras devine un VideoFrame, incodat cu VideoEncoder la un bitrate/FPS tinta
//     — REZOLUTIA NU e niciodata redusa (vezi justificarea in raport: matematica de crop a
//     serverului e limitata de INALTIMEA sursei, nu de latime — reducerea rezolutiei ar pierde
//     real detaliu; reducerea FPS/bitrate nu pierde NIMIC vizibil in produsul final).
//   - Fisierul .mp4 de iesire (STRICT video, fara audio) e asamblat de muxer-ul minimal de mai
//     jos — scris special pentru acest caz (un singur track video, fara fragmentare) si validat
//     direct cu ffprobe/ffmpeg (vezi test/media-compress-muxer.test.js) inainte de a fi folosit
//     vreodata intr-un browser real.
//   - SIGURANTA: orice esec, in orice pas (API lipsa, eroare de decodare/encodare, timeout,
//     fisier rezultat prea mare/nu suficient de mic ca sa merite) revine STRICT la incarcarea
//     fisierului ORIGINAL, neschimbat — clientul nu pierde niciodata materialul selectat.
(function (global) {
  'use strict';

  // ============================================================================================
  // MUXER MP4 MINIMAL — STRICT un singur track video (H.264/avc1), FARA audio, FARA fragmentare
  // (moov scris complet la sfarsit, dupa ce toate cadrele au fost incodate). Functie PURA — nu
  // atinge DOM/API-uri de browser — testabila complet in Node, validata direct cu ffprobe.
  //
  // Parametri:
  //   width, height: dimensiuni video (neschimbate fata de sursa)
  //   fps: cadre pe secunda TINTA (constant, pentru simplitate — stts foloseste o singura
  //     intrare, durata fixa per esantion)
  //   description: Uint8Array — AVCDecoderConfigurationRecord (exact ce ofera WebCodecs in
  //     metadata.decoderConfig.description pentru avc.format:'avc') — devine payload-ul avcC.
  //   samples: array de { data: Uint8Array, isKey: boolean } — cate un element per cadru incodat,
  //     in ordine de afisare/decodare (CFR simplu, fara B-frames reordonate — vezi mai jos).
  function muxVideoOnlyMp4({ width, height, fps, description, samples }) {
    if (!samples || samples.length === 0) throw new Error('muxVideoOnlyMp4: niciun esantion de incodat');
    const TIMESCALE = Math.round(fps * 512); // multiplu comod, evita rotunjiri pe durata per esantion
    const sampleDelta = Math.round(TIMESCALE / fps);
    const durationUnits = sampleDelta * samples.length;

    const enc = new TextEncoder();

    function u8(n) { return new Uint8Array([n & 0xff]); }
    function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
    function u24(n) { return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]); }
    function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
    function i16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }
    function concatBytes(parts) {
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    }
    function box(type, ...payloadParts) {
      const payload = concatBytes(payloadParts);
      const size = 8 + payload.length;
      return concatBytes([u32(size), enc.encode(type), payload]);
    }
    function fullBox(type, version, flags, ...payloadParts) {
      return box(type, u8(version), u24(flags), ...payloadParts);
    }
    // Matrice unitate standard QuickTime/ISO (fixed-point 16.16 / 2.30) — nicio rotatie/scalare.
    const UNITY_MATRIX = concatBytes([
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000)
    ]);

    const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isom'), enc.encode('iso2'), enc.encode('avc1'), enc.encode('mp41'));

    // --- mdat: esantioanele concatenate, in ordine — offset-urile din stco se calculeaza fata
    // de INCEPUTUL fisierului, deci trebuie stiute DIMENSIUNILE cutiilor dinaintea lui mdat.
    const sampleSizes = samples.map(s => s.data.length);
    const mdatPayloadSize = sampleSizes.reduce((a, b) => a + b, 0);
    const mdatHeaderSize = 8; // marime standard (fara varianta pe 64 de biti — sub 4GB garantat aici)

    // --- stbl: stsd (avc1 + avcC), stts, stsc, stsz, stco, stss ---
    const avcC = box('avcC', description);
    // Structura avc1 (SampleEntry + VisualSampleEntry), conform ISO/IEC 14496-12/14496-15.
    const avc1 = box('avc1',
      new Uint8Array(6), // reserved[6]
      u16(1), // data_reference_index
      u16(0), u16(0), // pre_defined + reserved
      u32(0), u32(0), u32(0), // pre_defined[3]
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), // horiz/vert resolution, 72dpi
      u32(0), // reserved
      u16(1), // frame_count
      new Uint8Array(32), // compressorname (gol)
      u16(0x0018), // depth
      i16(-1), // pre_defined
      avcC
    );

    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
    const stts = fullBox('stts', 0, 0, u32(1), u32(samples.length), u32(sampleDelta));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)); // un esantion per "chunk"
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...sampleSizes.map(u32));

    // Offset-urile stco depind de marimea EXACTA a lui moov (care contine stco insusi!) — le
    // calculam DUPA ce stim marimea completa a lui moov, printr-o a doua trecere (vezi mai jos).
    function buildMoovWithStco(stcoOffsets) {
      const stco = fullBox('stco', 0, 0, u32(stcoOffsets.length), ...stcoOffsets.map(u32));
      const keySampleIndexes = [];
      samples.forEach((s, i) => { if (s.isKey) keySampleIndexes.push(i + 1); });
      const stss = keySampleIndexes.length > 0 && keySampleIndexes.length < samples.length
        ? fullBox('stss', 0, 0, u32(keySampleIndexes.length), ...keySampleIndexes.map(u32))
        : new Uint8Array(0); // daca TOATE cadrele sunt cheie (sau niciunul detectat), stss e omisa — valid conform spec (implica toate sincron)

      const stbl = box('stbl', stsd, stts, stsc, stsz, stco, stss);
      const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
      const url = fullBox('url ', 0, 1);
      const dref = fullBox('dref', 0, 0, u32(1), url);
      const dinf = box('dinf', dref);
      const minf = box('minf', vmhd, dinf, stbl);
      const hdlr = fullBox('hdlr', 0, 0, u32(0), enc.encode('vide'), u32(0), u32(0), u32(0), enc.encode('VideoHandler'), u8(0));
      const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(durationUnits), u16(0x55c4), u16(0));
      const mdia = box('mdia', mdhd, hdlr, minf);
      const tkhd = fullBox('tkhd', 0, 0x7, u32(0), u32(0), u32(1), u32(0), u32(durationUnits),
        u32(0), u32(0), i16(0), i16(0), i16(0), i16(0),
        UNITY_MATRIX, u32(width << 16), u32(height << 16));
      const trak = box('trak', tkhd, mdia);
      const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(durationUnits),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
        UNITY_MATRIX,
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined[6]
        u32(2)); // next_track_ID
      return box('moov', mvhd, trak);
    }

    // Trecerea 1: moov cu offset-uri placeholder (0), STRICT ca sa-i aflam marimea reala.
    const moovProbe = buildMoovWithStco(new Array(samples.length).fill(0));
    const mdatStart = ftyp.length + moovProbe.length + mdatHeaderSize;
    const stcoOffsets = [];
    let cursor = mdatStart;
    for (const size of sampleSizes) { stcoOffsets.push(cursor); cursor += size; }
    const moovFinal = buildMoovWithStco(stcoOffsets);
    if (moovFinal.length !== moovProbe.length) {
      // Nu ar trebui sa se intample (offset-urile reale au aceeasi lungime ca placeholder-ul 0
      // codat pe 4 octeti fixi) — plasa de siguranta, nu lasa niciodata un fisier cu offset-uri
      // gresite sa iasa din functie.
      throw new Error('muxVideoOnlyMp4: nepotrivire interna de dimensiune moov — abandonez muxarea, NU un fisier posibil corupt');
    }

    const mdatHeader = concatBytes([u32(mdatHeaderSize + mdatPayloadSize), enc.encode('mdat')]);
    const mdatBody = concatBytes(samples.map(s => s.data));
    return concatBytes([ftyp, moovFinal, mdatHeader, mdatBody]);
  }

  // ============================================================================================
  // DECIZIE ADAPTIVA — merita comprimat acest fisier? PURA (fara I/O), testabila direct.
  //
  // Reguli, justificate prin masuratori reale (vezi raportul de prototip):
  //   - STRICT video (pozele deja mici, niciun beneficiu real).
  //   - Sub COMPRESS_MIN_BYTES: prea mic ca sa merite costul de procesare pe telefon.
  //   - Bitrate estimat (marime*8/durata) sub COMPRESS_MIN_BITRATE_BPS: deja eficient, un
  //     re-encode ar castiga prea putin (posibil chiar sa creasca marimea pe continut deja bine
  //     comprimat) ca sa merite timpul/bateria consumate.
  // ============================================================================================
  const COMPRESS_MIN_BYTES = 40 * 1024 * 1024; // 40MB
  const COMPRESS_MIN_BITRATE_BPS = 10 * 1000 * 1000; // 10 Mbps
  const COMPRESS_TARGET_BITRATE_BPS = 8 * 1000 * 1000; // 8 Mbps — vezi raportul: SSIM~0.96/PSNR~40dB
  const COMPRESS_TARGET_FPS = 30; // identic cu MEMORY_VIDEO_FPS din server.js — 60fps sursa oricum
                                   // pierdut la jumatate de serverul, la randare (vezi raportul)
  const COMPRESS_MIN_SAVINGS_RATIO = 0.7; // rezultatul trebuie sa fie sub 70% din original ca sa
                                           // merite inlocuirea — altfel pastram originalul
  const COMPRESS_MAX_MS_PER_SECOND_OF_VIDEO = 3000; // buget dur: max 3s procesare per secunda de
                                                     // video sursa (o incodare hardware reala ar
                                                     // trebui sa fie MULT sub asta — daca il
                                                     // depaseste, ceva nu merge bine, abandonam)

  function shouldAttemptCompression(file, meta) {
    if (!file || !meta || !meta.durationSeconds || meta.durationSeconds <= 0) {
      return { attempt: false, reason: 'metadata_lipsa' };
    }
    if (file.size < COMPRESS_MIN_BYTES) {
      return { attempt: false, reason: 'deja_mic' };
    }
    const estimatedBitrate = (file.size * 8) / meta.durationSeconds;
    if (estimatedBitrate <= COMPRESS_MIN_BITRATE_BPS) {
      return { attempt: false, reason: 'deja_eficient' };
    }
    if (!meta.width || !meta.height) {
      return { attempt: false, reason: 'dimensiuni_necunoscute' };
    }
    return { attempt: true, reason: 'beneficiu_estimat', estimatedBitrate };
  }

  function isWebCodecsSupported() {
    try {
      return typeof global.VideoEncoder === 'function' &&
        typeof global.VideoDecoder === 'function' &&
        typeof global.VideoFrame === 'function';
    } catch (e) {
      return false;
    }
  }

  // ============================================================================================
  // Extrage metadate (durata/dimensiuni) STRICT prin elementul <video> nativ — niciun
  // demultiplexor propriu. Timeout de siguranta — un fisier neobisnuit care nu declanseaza
  // niciodata 'loadedmetadata' nu trebuie sa blocheze coada la infinit.
  // ============================================================================================
  function probeVideoMeta(file, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const videoEl = document.createElement('video');
      videoEl.preload = 'metadata';
      videoEl.muted = true;
      videoEl.playsInline = true;
      const url = URL.createObjectURL(file);
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignora */ }
        videoEl.src = '';
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs || 8000);
      videoEl.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        finish({
          durationSeconds: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
          width: videoEl.videoWidth || 0,
          height: videoEl.videoHeight || 0
        });
      }, { once: true });
      videoEl.addEventListener('error', () => { clearTimeout(timer); finish(null); }, { once: true });
      videoEl.src = url;
    });
  }

  // ============================================================================================
  // Pipeline-ul REAL de compresie — decodeaza sursa prin <video>, extrage cadre prin
  // requestVideoFrameCallback (NICIODATA captureStream — vezi comentariul din capul fisierului),
  // reincodeaza cu VideoEncoder la FPS/bitrate tinta, muxeaza cu functia PURA de mai sus.
  //
  // Arunca la orice eroare — apelantul (maybeCompressVideo, mai jos) prinde STRICT aici si
  // revine la fisierul original; aceasta functie NU are voie sa fie apelata direct in productie
  // fara acel invelis de siguranta.
  // ============================================================================================
  async function compressVideoInternal(file, meta, onPhase) {
    const hardBudgetMs = Math.min(120000, Math.max(15000, meta.durationSeconds * 1000 * COMPRESS_MAX_MS_PER_SECOND_OF_VIDEO / 1000));
    const startedAt = Date.now();
    function checkBudget() {
      if (Date.now() - startedAt > hardBudgetMs) {
        throw new Error('buget de timp depasit — abandonez compresia pentru acest fisier');
      }
    }

    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    const objectUrl = URL.createObjectURL(file);
    videoEl.src = objectUrl;

    const samples = [];
    let descriptionBytes = null;
    let encodeError = null;

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout la incarcarea sursei video')), 10000);
        videoEl.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
        videoEl.addEventListener('error', () => { clearTimeout(t); reject(new Error('eroare la decodarea sursei video')); }, { once: true });
      });

      if (typeof videoEl.requestVideoFrameCallback !== 'function') {
        throw new Error('requestVideoFrameCallback indisponibil in acest browser');
      }

      const encoder = new global.VideoEncoder({
        output: (chunk, metadata) => {
          if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !descriptionBytes) {
            const desc = metadata.decoderConfig.description;
            descriptionBytes = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          samples.push({ data, isKey: chunk.type === 'key' });
        },
        error: (err) => { encodeError = err; }
      });
      encoder.configure({
        codec: 'avc1.640028',
        width: meta.width,
        height: meta.height,
        bitrate: COMPRESS_TARGET_BITRATE_BPS,
        framerate: COMPRESS_TARGET_FPS,
        avc: { format: 'avc' }
      });

      const minFrameIntervalMs = 1000 / COMPRESS_TARGET_FPS;
      let lastCapturedMs = -Infinity;
      let frameCount = 0;
      let stopped = false;

      await videoEl.play().catch(() => { /* unele browsere cer play() dupa un gest — daca esueaza, oprim curat mai jos */ });

      await new Promise((resolve, reject) => {
        function onEnded() { stopped = true; }
        videoEl.addEventListener('ended', onEnded, { once: true });

        function frameHandler(_now, metadata) {
          if (stopped) { resolve(); return; }
          try {
            checkBudget();
            if (encodeError) throw encodeError;
            const mediaTimeMs = metadata.mediaTime * 1000;
            if (mediaTimeMs - lastCapturedMs >= minFrameIntervalMs - 1) {
              lastCapturedMs = mediaTimeMs;
              const frame = new global.VideoFrame(videoEl, { timestamp: Math.round(metadata.mediaTime * 1e6) });
              encoder.encode(frame, { keyFrame: frameCount % (COMPRESS_TARGET_FPS * 2) === 0 });
              frame.close();
              frameCount++;
              if (typeof onPhase === 'function') onPhase({ framesEncoded: frameCount, estimatedTotalFrames: Math.ceil(meta.durationSeconds * COMPRESS_TARGET_FPS) });
            }
            if (videoEl.ended) { resolve(); return; }
            videoEl.requestVideoFrameCallback(frameHandler);
          } catch (err) {
            reject(err);
          }
        }
        videoEl.requestVideoFrameCallback(frameHandler);
      });

      videoEl.pause();
      await encoder.flush();
      encoder.close();
      if (encodeError) throw encodeError;
      if (!descriptionBytes) throw new Error('encoder-ul nu a produs o configuratie de decodare (avcC) — sursa nu poate fi muxata');
      if (samples.length === 0) throw new Error('niciun cadru incodat');

      const muxed = muxVideoOnlyMp4({
        width: meta.width,
        height: meta.height,
        fps: COMPRESS_TARGET_FPS,
        description: descriptionBytes,
        samples
      });
      return new Blob([muxed], { type: 'video/mp4' });
    } finally {
      try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignora */ }
      videoEl.src = '';
    }
  }

  // ============================================================================================
  // PUNCT DE INTRARE PUBLIC — NU aruncă niciodată. Rezolvă mereu cu un rezultat utilizabil:
  // fie fișierul comprimat, fie fișierul original — apelantul (coada de upload) nu trebuie să
  // gestioneze separat cazul de eroare, doar să folosească rezultatul întors.
  // ============================================================================================
  // CORECTIE (2026-09-07, "un video real de ~841MB a fost incarcat necomprimat"): verificarea
  // de tip folosea STRICT file.type ('video/...'). iOS Safari livreaza uneori fisiere .mov cu
  // file.type GOL (comportament documentat/cunoscut, nu o presupunere) — un astfel de fisier
  // cadea imediat pe 'nu_e_video', fara sa ajunga NICIODATA la verificarea WebCodecs, indiferent
  // cat de mare/eficient de comprimat ar fi fost. Aliniat acum la EXACT aceeasi logica deja
  // folosita de isVideoFile() (amintiri-video.html/comanda-mea.html/succes.html) — extensie ca
  // rezerva STRICT cand file.type e gol, niciodata cand type e prezent dar nu incepe cu 'video'.
  const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];
  function looksLikeVideoFile(file) {
    if (typeof file.type === 'string' && file.type.length > 0) return file.type.indexOf('video') === 0;
    const match = String(file.name || '').match(/\.[^./\\]+$/);
    return !!match && VIDEO_EXTENSIONS.includes(match[0].toLowerCase());
  }

  async function maybeCompressVideo(file, options) {
    const onPhase = options && options.onPhase;
    const startedAt = Date.now();
    const isVideo = looksLikeVideoFile(file);
    if (!isVideo) return { file, compressed: false, reason: 'nu_e_video', durationMs: Date.now() - startedAt };
    const webCodecsAvailable = isWebCodecsSupported();
    if (!webCodecsAvailable) return { file, compressed: false, reason: 'webcodecs_indisponibil', durationMs: Date.now() - startedAt };

    let meta;
    try {
      meta = await probeVideoMeta(file, 8000);
    } catch (e) {
      return { file, compressed: false, reason: 'metadata_eroare', durationMs: Date.now() - startedAt };
    }
    if (!meta) return { file, compressed: false, reason: 'metadata_timeout', durationMs: Date.now() - startedAt };

    const decision = shouldAttemptCompression(file, meta);
    if (!decision.attempt) return { file, compressed: false, reason: decision.reason, durationMs: Date.now() - startedAt };

    try {
      const blob = await compressVideoInternal(file, meta, onPhase);
      if (!blob || blob.size === 0) return { file, compressed: false, reason: 'rezultat_gol', durationMs: Date.now() - startedAt };
      if (blob.size > file.size * COMPRESS_MIN_SAVINGS_RATIO) {
        return { file, compressed: false, reason: 'beneficiu_insuficient', durationMs: Date.now() - startedAt, originalSize: file.size, compressedSize: blob.size };
      }
      const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, '') + '-optimizat.mp4', { type: 'video/mp4' });
      return { file: compressedFile, compressed: true, reason: 'ok', originalSize: file.size, compressedSize: compressedFile.size, durationMs: Date.now() - startedAt };
    } catch (e) {
      return { file, compressed: false, reason: 'eroare_compresie: ' + (e && e.message || String(e)), durationMs: Date.now() - startedAt };
    }
  }

  global.NalunaMediaCompress = {
    muxVideoOnlyMp4,
    shouldAttemptCompression,
    isWebCodecsSupported,
    looksLikeVideoFile,
    probeVideoMeta,
    maybeCompressVideo,
    // constante expuse STRICT pentru teste — niciodata pentru a fi modificate din afara acestui fisier
    _constants: {
      COMPRESS_MIN_BYTES,
      COMPRESS_MIN_BITRATE_BPS,
      COMPRESS_TARGET_BITRATE_BPS,
      COMPRESS_TARGET_FPS,
      COMPRESS_MIN_SAVINGS_RATIO
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
