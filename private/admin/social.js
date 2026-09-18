// Social Media — Admin NALUNA (mutat 1:1 din vechiul private/admin.html, Etapa 4 din istoric,
// ca parte a reorganizarii Admin-ului in pagini separate — 2026-09-18). Nicio schimbare de
// logica sau de endpoint fata de varianta anterioara.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Config declarativ — adaugarea unei platforme noi (ex. TikTok, cand backend-ul o va
// suporta) inseamna un rand nou aici, NU rescrierea logicii de mai jos: checkbox-urile de
// platforma, badge-urile din lista/detaliu si actiunile de retry sunt TOATE generate din
// aceasta lista, nu hardcodate separat pentru Facebook/Instagram.
const PLATFORM_DEFS = [
  { id: 'facebook', label: 'Facebook', icon: '📘' },
  { id: 'instagram', label: 'Instagram', icon: '📷' }
];

const STATUS_LABELS = {
  draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published',
  partially_failed: 'Partially failed', failed: 'Failed', cancelled: 'Cancelled'
};

// TREBUIE sa ramana sincronizat cu SOCIAL_MEDIA_MIME_TYPES / SOCIAL_MEDIA_MAX_BYTES din
// server.js (verificat automat de test/social-admin-ui.test.js) — validarea de aici e STRICT
// o comoditate (feedback instant, fara sa astepti raspunsul serverului), serverul ramane
// sursa reala a adevarului si revalideaza identic orice ar trimite clientul.
const SOCIAL_MEDIA_LIMITS = {
  image: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 60 * 1024 * 1024 },
  video: { types: ['video/mp4', 'video/webm', 'video/quicktime'], maxBytes: 60 * 1024 * 1024 }
};

// ---------- Functii PURE (fara acces la DOM) — testate izolat in test/social-admin-ui.test.js ----------

function validateSmForm({ platforms, hasFile, fileType, fileSize, mediaType, captionLength, mode, scheduledAtMs, nowMs }) {
  if (!platforms || platforms.length === 0) return 'Selectează cel puțin o platformă (Facebook sau Instagram).';
  if (!hasFile) return 'Adaugă un fișier media (imagine sau video).';
  const limits = SOCIAL_MEDIA_LIMITS[mediaType];
  if (!limits.types.includes(fileType)) {
    return `Format neacceptat pentru ${mediaType === 'image' ? 'imagine' : 'video'} (primit: ${fileType || 'necunoscut'}).`;
  }
  if (fileSize > limits.maxBytes) {
    return `Fișierul depășește limita de ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`;
  }
  if (captionLength > 2200) return 'Caption prea lung (maximum 2200 caractere).';
  if (mode === 'schedule') {
    if (!scheduledAtMs || Number.isNaN(scheduledAtMs)) return 'Alege data și ora programării.';
    if (scheduledAtMs <= nowMs) return 'Ora programată trebuie să fie în viitor.';
  }
  return null;
}

function computeSmStats(posts) {
  return {
    scheduled: posts.filter(p => p.status === 'scheduled').length,
    published: posts.filter(p => p.status === 'published').length,
    attention: posts.filter(p => p.status === 'failed' || p.status === 'partially_failed').length
  };
}

function matchesSmFilter(post, filter) {
  if (filter === 'all') return true;
  if (filter === 'attention') return post.status === 'failed' || post.status === 'partially_failed';
  return post.status === filter;
}

// Actiuni contextuale disponibile pentru o postare — declarativ, nu un if/else fix per
// platforma. O platforma deja publicata cu succes (status 'success') NU primeste NICIODATA
// o actiune de retry, indiferent de statusul general al postarii.
function getSmContextualActions(post) {
  const actions = [];
  if (post.status === 'scheduled') {
    actions.push({ id: 'cancel', label: 'Cancel Schedule', variant: 'btn-danger' });
  }
  if (post.status === 'failed' || post.status === 'partially_failed') {
    for (const p of PLATFORM_DEFS) {
      if (post.platforms.includes(p.id) && post[p.id + 'Status'] === 'error') {
        actions.push({ id: 'retry:' + p.id, label: `Retry ${p.label}`, variant: 'btn-primary' });
      }
    }
  }
  return actions;
}

// Aparare STRICT suplimentara la afisare — backend-ul deja garanteaza ca facebookError/
// instagramError contin STRICT mesajul Graph API (niciodata un token), dar mascam oricum
// orice secventa lunga alfanumerica ce ar putea semana cu un token/secret, ca plasa de
// siguranta in plus la nivel de UI, niciodata singura linie de aparare.
function redactSecrets(str) {
  return String(str || '').replace(/[A-Za-z0-9_-]{24,}/g, '[ascuns]');
}

function captionFragment(caption) {
  if (!caption) return '(fără caption)';
  const oneLine = caption.replace(/\s+/g, ' ').trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
}

function renderSubmitResultMessage(data) {
  if (data.duplicate) return 'Această postare a fost deja trimisă (retrimitere detectată și ignorată).';
  const post = data.post;
  if (post.status === 'scheduled') return `Programată cu succes pentru ${new Date(post.scheduledAt).toLocaleString('ro-RO')}.`;
  const parts = PLATFORM_DEFS
    .filter(p => post.platforms.includes(p.id))
    .map(p => `${p.label}: ${post[p.id + 'Status'] === 'success' ? 'succes' : 'eroare'}`);
  return `Rezultat — ${parts.join(', ')}.`;
}

// ---------- Stare + glue DOM ----------

let smMode = 'now'; // 'now' | 'schedule'
let smPreviewUrl = null;
let smPostsCache = [];
let smActiveFilter = 'all';
let smOpenPostId = null;
let smPollTimer = null;
const SM_POLL_INTERVAL_MS = 15000; // 15s — suficient de des ca sa vezi scheduled->publishing->published fara refresh manual, fara sa fie polling agresiv

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const smPlatformRow = document.getElementById('sm-platform-row');
smPlatformRow.innerHTML = PLATFORM_DEFS.map(p => `
  <label class="sm-check-pill">
    <input type="checkbox" class="sm-platform-checkbox" value="${p.id}"> ${p.icon} ${p.label}
  </label>
`).join('');

function getSelectedPlatforms() {
  return Array.from(document.querySelectorAll('.sm-platform-checkbox:checked')).map(el => el.value);
}

const smTabNow = document.getElementById('sm-tab-now');
const smTabSchedule = document.getElementById('sm-tab-schedule');
const smScheduleFields = document.getElementById('sm-schedule-fields');
const smSubmitBtn = document.getElementById('sm-submit-btn');
const smTzNote = document.getElementById('sm-tz-note');

function updateSmModeUI() {
  smTabNow.classList.toggle('active', smMode === 'now');
  smTabSchedule.classList.toggle('active', smMode === 'schedule');
  smScheduleFields.style.display = smMode === 'schedule' ? 'block' : 'none';
  smSubmitBtn.textContent = smMode === 'schedule' ? 'Schedule Post' : 'Post Now';
}
smTabNow.addEventListener('click', () => { smMode = 'now'; updateSmModeUI(); });
smTabSchedule.addEventListener('click', () => { smMode = 'schedule'; updateSmModeUI(); });

// Fusul orar al browserului admin-ului, afisat clar — programarea se trimite mereu ca
// timestamp ISO absolut (new Date(...).toISOString()), deci nu conteaza unde ruleaza
// serverul; important e ca ADMINUL sa stie exact ce inseamna "14:00" pe care il alege.
smTzNote.textContent = `Fusul orar folosit: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

const smMediaTypeSel = document.getElementById('sm-media-type');
const smMediaFileInput = document.getElementById('sm-media-file');
const smPreviewEl = document.getElementById('sm-preview');

function syncMediaAccept() {
  smMediaFileInput.setAttribute('accept', SOCIAL_MEDIA_LIMITS[smMediaTypeSel.value].types.join(','));
}
smMediaTypeSel.addEventListener('change', syncMediaAccept);
syncMediaAccept();

smMediaFileInput.addEventListener('change', () => {
  if (smPreviewUrl) { URL.revokeObjectURL(smPreviewUrl); smPreviewUrl = null; }
  const file = smMediaFileInput.files[0];
  if (!file) { smPreviewEl.style.display = 'none'; smPreviewEl.innerHTML = ''; return; }
  smPreviewUrl = URL.createObjectURL(file);
  const isImage = file.type.startsWith('image/');
  smPreviewEl.innerHTML = (isImage ? `<img src="${smPreviewUrl}" alt="">` : `<video src="${smPreviewUrl}" controls></video>`)
    + `<div class="sm-preview-name">${escapeHtml(file.name)} — ${(file.size / (1024 * 1024)).toFixed(1)}MB</div>`;
  smPreviewEl.style.display = 'block';
});

const smCaptionEl = document.getElementById('sm-caption');
const smCharCounter = document.getElementById('sm-char-counter');
smCaptionEl.addEventListener('input', () => {
  const len = smCaptionEl.value.length;
  smCharCounter.textContent = `${len} / 2200`;
  smCharCounter.classList.toggle('over', len > 2200);
});

function collectSmFormState() {
  const file = smMediaFileInput.files[0];
  let scheduledAtMs = null;
  if (smMode === 'schedule') {
    const dateVal = document.getElementById('sm-schedule-date').value;
    const timeVal = document.getElementById('sm-schedule-time').value;
    scheduledAtMs = (dateVal && timeVal) ? new Date(`${dateVal}T${timeVal}`).getTime() : NaN;
  }
  return {
    platforms: getSelectedPlatforms(),
    hasFile: !!file,
    fileType: file ? file.type : '',
    fileSize: file ? file.size : 0,
    mediaType: smMediaTypeSel.value,
    captionLength: smCaptionEl.value.length,
    mode: smMode,
    scheduledAtMs,
    nowMs: Date.now()
  };
}

function resetSmForm() {
  document.getElementById('sm-form').reset();
  document.querySelectorAll('.sm-platform-checkbox').forEach(el => { el.checked = false; });
  if (smPreviewUrl) { URL.revokeObjectURL(smPreviewUrl); smPreviewUrl = null; }
  smPreviewEl.style.display = 'none';
  smPreviewEl.innerHTML = '';
  smCharCounter.textContent = '0 / 2200';
  smCharCounter.classList.remove('over');
}

const smFormMsg = document.getElementById('sm-form-msg');

document.getElementById('sm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Previne submit multiplu: un buton deja dezactivat nu (re)intra niciodata in handler —
  // verificarea si dezactivarea propriu-zisa (mai jos) ruleaza SINCRON, fara niciun await
  // intre ele, deci un al doilea click/submit "aproape simultan" gaseste mereu butonul deja
  // dezactivat, indiferent de viteza dublu-click-ului.
  if (smSubmitBtn.disabled) return;

  const validationError = validateSmForm(collectSmFormState());
  if (validationError) {
    smFormMsg.textContent = validationError;
    smFormMsg.className = 't-form-msg err';
    return;
  }

  const platforms = getSelectedPlatforms();
  const platformLabels = PLATFORM_DEFS.filter(p => platforms.includes(p.id)).map(p => p.label).join(' și ');
  const confirmMsg = smMode === 'schedule'
    ? `Programezi această postare pentru ${platformLabels}?`
    : `Publici ACUM pe ${platformLabels}?`;
  if (!confirm(confirmMsg)) return;

  smSubmitBtn.disabled = true;
  const originalLabel = smSubmitBtn.textContent;
  smSubmitBtn.textContent = smMode === 'schedule' ? 'Se programează...' : 'Se publică...';
  smFormMsg.textContent = '';
  smFormMsg.className = 't-form-msg';

  try {
    // idempotencyKey generat PROASPAT la fiecare submit REAL (dupa confirmarea de mai sus,
    // dupa ce butonul a fost deja dezactivat) — un dublu-click nu ajunge niciodata aici de
    // doua ori (guard-ul de mai sus il opreste), deci nu genereaza niciodata doua chei
    // pentru aceeasi actiune a adminului. O retrimitere DELIBERATA (adminul apasa din nou
    // dupa o eroare reala) primeste corect o cheie NOUA — nu ramane blocata la nesfarsit
    // de raspunsul vechi, esuat.
    const idempotencyKey = crypto.randomUUID();
    const fd = new FormData();
    fd.append('platforms', JSON.stringify(platforms));
    fd.append('mediaType', smMediaTypeSel.value);
    fd.append('caption', smCaptionEl.value);
    fd.append('idempotencyKey', idempotencyKey);
    fd.append('media', smMediaFileInput.files[0]);

    let url = '/api/admin/social/publish';
    if (smMode === 'schedule') {
      url = '/api/admin/social/schedule';
      const dateVal = document.getElementById('sm-schedule-date').value;
      const timeVal = document.getElementById('sm-schedule-time').value;
      fd.append('scheduledAt', new Date(`${dateVal}T${timeVal}`).toISOString());
    }

    // NICIUN retry automat aici — o singura cerere. Backend-ul gestioneaza deja retry-ul
    // (Etapa 3, workerul de fundal) pentru esecurile reale de platforma.
    // X-Requested-With: protectia CSRF existenta pentru /api/admin/* (vezi server.js) — un
    // formular HTML simplu cross-origin NU poate seta acest header custom.
    const res = await fetch(url, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
    const data = await res.json();

    if (!res.ok) {
      smFormMsg.textContent = data.error || 'Eroare la trimitere.';
      smFormMsg.className = 't-form-msg err';
      return;
    }

    smFormMsg.textContent = renderSubmitResultMessage(data);
    smFormMsg.className = 't-form-msg ok';
    resetSmForm();
    loadSocialPosts();
  } catch (err) {
    smFormMsg.textContent = 'Eroare de conexiune — nu s-a putut trimite postarea.';
    smFormMsg.className = 't-form-msg err';
  } finally {
    smSubmitBtn.disabled = false;
    smSubmitBtn.textContent = originalLabel;
  }
});

// ---------- Lista de postari ----------

function renderSmPlatformDots(post) {
  return PLATFORM_DEFS.map(p => {
    const active = post.platforms.includes(p.id);
    return `<span class="sm-platform-dot ${active ? '' : 'inactive'}" title="${p.label}${active ? '' : ' (neselectat)'}">${p.icon}</span>`;
  }).join('');
}

function renderSmCard(post) {
  const thumb = post.mediaType === 'image' && post.mediaUrl ? `<img src="${escapeHtml(post.mediaUrl)}" alt="">` : '🎬';
  const dateLabel = post.status === 'scheduled' ? `Programat: ${formatDate(post.scheduledAt)}`
    : post.publishedAt ? `Publicat: ${formatDate(post.publishedAt)}`
    : `Creat: ${formatDate(post.createdAt)}`;
  const attempts = (post.facebookAttemptCount || 0) + (post.instagramAttemptCount || 0);

  return `
    <button type="button" class="sm-card" data-sm-open="${escapeHtml(post.id)}">
      <div class="sm-card-media">${thumb}</div>
      <div class="sm-card-body">
        <div class="sm-card-caption">${escapeHtml(captionFragment(post.caption))}</div>
        <div class="sm-card-meta">
          ${renderSmPlatformDots(post)}
          <span>${dateLabel}</span>
          ${attempts > 0 ? `<span>${attempts} încercări</span>` : ''}
        </div>
      </div>
      <div class="sm-card-right">
        <span class="sm-status-badge sm-s-${post.status}">${STATUS_LABELS[post.status] || post.status}</span>
      </div>
    </button>
  `;
}

function renderSmList(posts) {
  const listEl = document.getElementById('sm-list');
  listEl.innerHTML = posts.length === 0 ? '<div class="empty">Nicio postare</div>' : posts.map(renderSmCard).join('');
}

async function loadSocialPosts(opts) {
  opts = opts || {};
  try {
    const res = await fetch('/api/admin/social/posts?limit=100');
    const data = await res.json();
    smPostsCache = data.posts || [];
  } catch (err) {
    if (!opts.silent) document.getElementById('sm-list').innerHTML = '<div class="empty">Eroare la încărcarea postărilor.</div>';
    return;
  }

  const stats = computeSmStats(smPostsCache);
  document.querySelector('#sm-stat-scheduled .value').textContent = stats.scheduled;
  document.querySelector('#sm-stat-published .value').textContent = stats.published;
  document.querySelector('#sm-stat-attention .value').textContent = stats.attention;

  renderSmList(smPostsCache.filter(p => matchesSmFilter(p, smActiveFilter)));

  // daca modalul de detaliu e deschis, il actualizam LIVE cu datele proaspete — asta e
  // mecanismul prin care se vede scheduled -> publishing -> published fara sa inchizi/
  // redeschizi manual fereastra de detalii.
  if (smOpenPostId) {
    const fresh = smPostsCache.find(p => p.id === smOpenPostId);
    if (fresh) renderSmModal(fresh); else closeSmModal();
  }
}

function setSmFilter(filter) {
  smActiveFilter = filter;
  document.querySelectorAll('.sm-filter-btn').forEach(el => el.classList.toggle('active', el.dataset.status === filter));
  document.querySelectorAll('.sm-stat').forEach(el => el.classList.toggle('active', el.dataset.filter === filter));
  renderSmList(smPostsCache.filter(p => matchesSmFilter(p, smActiveFilter)));
}

document.getElementById('sm-stat-scheduled').addEventListener('click', () => setSmFilter('scheduled'));
document.getElementById('sm-stat-published').addEventListener('click', () => setSmFilter('published'));
document.getElementById('sm-stat-attention').addEventListener('click', () => setSmFilter('attention'));
document.getElementById('sm-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.sm-filter-btn');
  if (btn) setSmFilter(btn.dataset.status);
});

// ---------- Detaliu postare (modal) ----------

function renderSmModal(post) {
  smOpenPostId = post.id;
  const media = post.mediaType === 'image'
    ? `<img src="${escapeHtml(post.mediaUrl)}" alt="">`
    : `<video src="${escapeHtml(post.mediaUrl)}" controls></video>`;

  const platformBlocks = PLATFORM_DEFS.filter(p => post.platforms.includes(p.id)).map(p => {
    const status = post[p.id + 'Status'];
    const postId = post[p.id + 'PostId'];
    const error = post[p.id + 'Error'];
    const attemptCount = post[p.id + 'AttemptCount'] || 0;
    const nextAttempt = post[p.id + 'NextAttemptAt'];
    return `
      <div class="sm-detail-platform">
        <div class="sm-detail-platform-head">
          ${p.icon} ${p.label}
          <span class="sm-status-badge sm-s-${status || 'draft'}">${status ? (status === 'success' ? 'Success' : 'Error') : 'Pending'}</span>
        </div>
        ${postId ? `<div class="sm-detail-row"><span>Post ID</span><span>${escapeHtml(postId)}</span></div>` : ''}
        <div class="sm-detail-row"><span>Încercări</span><span>${attemptCount}</span></div>
        ${error ? `<div class="sm-detail-row err"><span>Ultima eroare</span><span>${escapeHtml(redactSecrets(error))}</span></div>` : ''}
        ${nextAttempt ? `<div class="sm-detail-row"><span>Următoarea reîncercare</span><span>${formatDate(nextAttempt)}</span></div>` : ''}
      </div>
    `;
  }).join('');

  const actions = getSmContextualActions(post);
  const actionsHtml = actions.length === 0 ? '' : `
    <div class="sm-detail-actions">
      ${actions.map(a => `<button type="button" class="${a.variant}" data-sm-action="${a.id}">${a.label}</button>`).join('')}
    </div>
  `;

  document.getElementById('sm-modal-root').innerHTML = `
    <div class="sm-modal-backdrop" data-sm-backdrop>
      <div class="sm-modal">
        <button type="button" class="sm-modal-close" data-sm-close>✕</button>
        <div class="sm-detail-media">${media}</div>
        <div class="sm-detail-caption">${escapeHtml(post.caption || '(fără caption)')}</div>
        <div class="sm-detail-row"><span>Status general</span><span class="sm-status-badge sm-s-${post.status}">${STATUS_LABELS[post.status] || post.status}</span></div>
        ${post.scheduledAt ? `<div class="sm-detail-row"><span>Programat pentru</span><span>${formatDate(post.scheduledAt)}</span></div>` : ''}
        ${post.publishedAt ? `<div class="sm-detail-row"><span>Publicat la</span><span>${formatDate(post.publishedAt)}</span></div>` : ''}
        ${platformBlocks}
        ${actionsHtml}
      </div>
    </div>
  `;
}

// Functii normale, NU atasate pe window — CSP (script-src, fara 'unsafe-inline') blocheaza
// atributele onclick="" inline, deci interactivitatea din elementele generate dinamic
// (carduri, modal) foloseste STRICT delegare de evenimente (addEventListener pe containerul
// stabil #sm-list / #sm-modal-root + data-atribute), niciodata onclick="" in HTML-ul produs.
function openSmPostDetail(id) {
  const post = smPostsCache.find(p => p.id === id);
  if (post) renderSmModal(post);
}

function closeSmModal() {
  smOpenPostId = null;
  document.getElementById('sm-modal-root').innerHTML = '';
}

async function handleSmAction(postId, actionId) {
  if (actionId === 'cancel') {
    if (!confirm('Anulezi programarea acestei postări? Nu va mai fi publicată automat.')) return;
    try {
      const res = await fetch(`/api/admin/social/posts/${postId}/cancel`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Nu am putut anula programarea.'); return; }
      await loadSocialPosts();
      const fresh = smPostsCache.find(p => p.id === postId);
      if (fresh) renderSmModal(fresh);
    } catch (err) {
      alert('Eroare de conexiune.');
    }
    return;
  }

  if (actionId.startsWith('retry:')) {
    const platform = actionId.split(':')[1];
    const label = (PLATFORM_DEFS.find(p => p.id === platform) || {}).label || platform;
    if (!confirm(`Reîncerci publicarea pe ${label} pentru această postare?`)) return;
    try {
      const res = await fetch(`/api/admin/social/posts/${postId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ platform })
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Nu am putut porni reîncercarea.'); return; }
      await loadSocialPosts();
      const fresh = smPostsCache.find(p => p.id === postId);
      if (fresh) renderSmModal(fresh);
    } catch (err) {
      alert('Eroare de conexiune.');
    }
  }
}

document.getElementById('sm-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-sm-open]');
  if (card) openSmPostDetail(card.dataset.smOpen);
});

// Delegat pe #sm-modal-root (containerul STABIL, niciodata el insusi inlocuit — doar
// continutul lui, la fiecare renderSmModal) — functioneaza indiferent de cate ori se
// redeseneaza modalul (ex. la fiecare auto-refresh cat modalul e deschis).
document.getElementById('sm-modal-root').addEventListener('click', (e) => {
  if (e.target.closest('[data-sm-close]')) { closeSmModal(); return; }
  if (e.target.matches('[data-sm-backdrop]')) { closeSmModal(); return; } // click STRICT pe fundal, nu pe continutul modalului
  const actionBtn = e.target.closest('[data-sm-action]');
  if (actionBtn && smOpenPostId) handleSmAction(smOpenPostId, actionBtn.dataset.smAction);
});

// ---------- Auto-refresh — se opreste cand tab-ul nu e activ ----------

function startSmPolling() {
  if (smPollTimer) clearInterval(smPollTimer);
  smPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadSocialPosts({ silent: true });
  }, SM_POLL_INTERVAL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadSocialPosts({ silent: true });
});

updateSmModeUI();
loadSocialPosts();
startSmPolling();
