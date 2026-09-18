// Website — Reactii clienti / testimoniale — Admin NALUNA (mutat 1:1 din vechiul
// private/admin.html, ca parte a reorganizarii Admin-ului in pagini separate — 2026-09-18).
// Nicio schimbare de logica sau de endpoint fata de varianta anterioara.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const typeIcons = { text: '💬', image: '🖼️', video: '🎬', audio: '🎧' };
let testimonialsCache = [];

const tFileField = document.getElementById('t-file-field');
function syncFileFieldVisibility() {
  tFileField.style.display = tType.value === 'text' ? 'none' : 'block';
}

const tForm = document.getElementById('t-form');
const tEditId = document.getElementById('t-edit-id');
const tName = document.getElementById('t-name');
const tLocation = document.getElementById('t-location');
const tQuote = document.getElementById('t-quote');
const tType = document.getElementById('t-type');
const tFile = document.getElementById('t-file');
const tPublished = document.getElementById('t-published');
const tConsent = document.getElementById('t-consent');
const tSubmitBtn = document.getElementById('t-submit-btn');
const tCancelBtn = document.getElementById('t-cancel-btn');
const tFormMsg = document.getElementById('t-form-msg');
const tList = document.getElementById('t-list');

function resetTForm() {
  tForm.reset();
  tEditId.value = '';
  tSubmitBtn.textContent = 'Salvează reacția';
  tCancelBtn.style.display = 'none';
  tFormMsg.textContent = '';
  tFormMsg.className = 't-form-msg';
  syncFileFieldVisibility();
}

tType.addEventListener('change', syncFileFieldVisibility);
syncFileFieldVisibility();
tCancelBtn.addEventListener('click', resetTForm);

async function loadTestimonials() {
  const res = await fetch('/api/admin/testimonials');
  const data = await res.json();
  const items = data.testimonials || [];
  testimonialsCache = items; // pastram datele intr-o variabila, ca sa nu le injectam in atribute HTML (risc de rupere la ghilimele/apostrof din citate)

  if (items.length === 0) {
    tList.innerHTML = '<div class="empty">Nicio reacție adăugată încă</div>';
    return;
  }

  tList.innerHTML = items.map((t, i) => {
    const mediaPreview = t.mediaType === 'image' && t.mediaPath
      ? `<img src="${escapeHtml(t.mediaPath)}" alt="">`
      : typeIcons[t.mediaType] || '💬';

    return `
      <div class="t-card">
        <div class="t-card-media">${mediaPreview}</div>
        <div class="t-card-body">
          <div class="t-card-name">${escapeHtml(t.firstName)}${t.location ? ' · ' + escapeHtml(t.location) : ''}</div>
          <div class="t-card-quote">"${escapeHtml(t.quote)}"</div>
        </div>
        <span class="t-status-badge ${t.published ? 't-status-published' : 't-status-hidden'}">${t.published ? 'Publicată' : 'Ascunsă'}</span>
        <div class="t-card-actions">
          <button class="icon-btn" title="Mută în sus" ${i === 0 ? 'disabled' : ''} data-t-action="move-up" data-t-id="${escapeHtml(t.id)}">↑</button>
          <button class="icon-btn" title="Mută în jos" ${i === items.length - 1 ? 'disabled' : ''} data-t-action="move-down" data-t-id="${escapeHtml(t.id)}">↓</button>
          <button class="icon-btn" title="Editează" data-t-action="edit" data-t-id="${escapeHtml(t.id)}">✎</button>
          <button class="icon-btn" title="Șterge" data-t-action="delete" data-t-id="${escapeHtml(t.id)}">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

// REGRESIE REPARATA (audit pre-deploy): aceste 3 actiuni foloseau onclick="" pana acum si
// erau STRICT nefunctionale sub politica CSP live (script-src fara 'unsafe-inline') — click-ul
// era blocat silentios de browser, fara nicio eroare vizibila in UI. Interactivitatea
// foloseste acum delegare de evenimente (addEventListener pe containerul stabil #t-list +
// data-atribute), exact tiparul deja folosit pentru Social Media — DAR functiile raman atasate
// pe obiectul global (neschimbat fata de inainte), pentru ca un test existent (protectia CSRF,
// adaugata separat) le localizeaza explicit dupa acele nume complete ca sa verifice header-ul
// trimis — redenumirea lor ar fi stricat acel test fara niciun beneficiu real (CSP blocheaza
// atributul onclick="" din HTML, nu existenta unei proprietati globale).
window.editTestimonial = function(id) {
  const t = testimonialsCache.find(x => x.id === id);
  if (!t) return;
  tEditId.value = t.id;
  tName.value = t.firstName;
  tLocation.value = t.location || '';
  tQuote.value = t.quote;
  tType.value = t.mediaType;
  syncFileFieldVisibility();
  tPublished.checked = t.published;
  tConsent.checked = t.consentConfirmed;
  tSubmitBtn.textContent = 'Salvează modificările';
  tCancelBtn.style.display = 'inline-block';
  tFormMsg.textContent = t.mediaPath ? 'Fișier existent păstrat, decât dacă încarci altul nou' : '';
  tFormMsg.className = 't-form-msg';
  tForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteTestimonial = async function(id) {
  if (!confirm('Ștergi definitiv această reacție?')) return;
  const res = await fetch(`/api/admin/testimonials/${id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (res.ok) loadTestimonials();
  else alert('Eroare la ștergere');
};

window.moveTestimonial = async function(id, direction) {
  await fetch(`/api/admin/testimonials/${id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ direction })
  });
  loadTestimonials();
};

tList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-t-action]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.tId;
  const action = btn.dataset.tAction;
  if (action === 'move-up') moveTestimonial(id, 'up');
  else if (action === 'move-down') moveTestimonial(id, 'down');
  else if (action === 'edit') editTestimonial(id);
  else if (action === 'delete') deleteTestimonial(id);
});

tForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  tFormMsg.textContent = 'Se salvează...';
  tFormMsg.className = 't-form-msg';

  const formData = new FormData();
  formData.append('firstName', tName.value);
  formData.append('location', tLocation.value);
  formData.append('quote', tQuote.value);
  formData.append('mediaType', tType.value);
  formData.append('published', tPublished.checked);
  formData.append('consentConfirmed', tConsent.checked);
  if (tFile.files[0]) formData.append('media', tFile.files[0]);

  const editId = tEditId.value;
  const url = editId ? `/api/admin/testimonials/${editId}` : '/api/admin/testimonials';
  const method = editId ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, { method, headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: formData });
    const data = await res.json();

    if (!res.ok) {
      tFormMsg.textContent = data.error || 'Eroare la salvare';
      tFormMsg.className = 't-form-msg err';
      return;
    }

    resetTForm();
    loadTestimonials();
  } catch (err) {
    tFormMsg.textContent = 'Eroare de conexiune';
    tFormMsg.className = 't-form-msg err';
  }
});

loadTestimonials();
