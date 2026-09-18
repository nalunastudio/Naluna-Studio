// Comenzi — Admin NALUNA (reorganizare 2026-09-18). Inainte, GET /api/admin/orders intorcea
// TOATE comenzile si tabelul intreg era randat dintr-o singura lista incarcata in browser —
// nescalabil la sute/mii de comenzi. Acum: paginare/search/filtrare REALE, server-side —
// fiecare actiune (cautare, schimbare filtru, pagina urmatoare) cere serverului STRICT pagina
// curenta, niciodata tot tabelul.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const statusLabel = {
  draft: 'Neplătită',
  generating: 'Se compune',
  processing_provider_result: 'Se finalizează',
  preview_ready: 'Previzualizare gata',
  ready: 'Plătită și livrată',
  generation_failed: 'Eroare'
};

const PAGE_SIZE = 50;
let state = { offset: 0, status: '', q: '' };
let ordersCache = [];

const searchInput = document.getElementById('orders-search');
const statusFilter = document.getElementById('orders-status-filter');
const ordersBody = document.getElementById('orders-body');
const paginationInfo = document.getElementById('orders-pagination-info');
const prevBtn = document.getElementById('orders-prev-btn');
const nextBtn = document.getElementById('orders-next-btn');

function buildQuery() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.offset });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  return params.toString();
}

// Actiuni contextuale per comanda — Retry Extras STRICT cand backend-ul chiar l-ar accepta
// (plan platit cu extrase, status ready/preview_ready — vezi POST .../retry-extras in
// server.js), Anonimizează mereu disponibila (backend-ul refuza singur cu 409 daca exista o
// operatie activa, mesajul e afisat direct adminului).
function getOrderRowActions(order) {
  const actions = [{ id: 'anonymize', label: 'Anonimizează', variant: 'btn-danger btn-small' }];
  if ((order.plan === 'premium' || order.plan === 'video') && (order.status === 'ready' || order.status === 'preview_ready')) {
    actions.push({ id: 'retry-extras', label: 'Retry Extras', variant: 'btn-secondary btn-small' });
  }
  return actions;
}

function renderOrderRow(o) {
  const actions = getOrderRowActions(o);
  return `
    <tr data-order-id="${escapeHtml(o.id)}">
      <td>${new Date(o.createdAt).toLocaleString('ro-RO')}</td>
      <td>${escapeHtml(o.recipient)}</td>
      <td>${escapeHtml(o.email || '—')}</td>
      <td>${(o.lang || 'ro').toUpperCase()}</td>
      <td>${escapeHtml(o.occasion)}</td>
      <td>${escapeHtml(o.genre)}</td>
      <td>${escapeHtml(o.plan)}</td>
      <td>£${o.price}</td>
      <td><span class="badge b-${o.status}">${statusLabel[o.status] || o.status}</span></td>
      <td>
        <div class="orders-row-actions">
          ${actions.map(a => `<button type="button" class="${a.variant}" data-order-action="${a.id}">${a.label}</button>`).join('')}
        </div>
      </td>
    </tr>
  `;
}

function renderPagination(matchingCount) {
  const currentPage = Math.floor(state.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(matchingCount / PAGE_SIZE));
  const from = matchingCount === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + PAGE_SIZE, matchingCount);
  paginationInfo.textContent = `Afișez ${from}–${to} din ${matchingCount} · Pagina ${currentPage} din ${totalPages}`;
  prevBtn.disabled = state.offset === 0;
  nextBtn.disabled = state.offset + PAGE_SIZE >= matchingCount;
}

async function loadOrders() {
  ordersBody.innerHTML = '<tr><td colspan="10" class="empty">Se încarcă…</td></tr>';
  try {
    const res = await fetch(`/api/admin/orders?${buildQuery()}`);
    const data = await res.json();
    ordersCache = data.orders || [];

    document.getElementById('stat-count').textContent = data.totalCount;
    document.getElementById('stat-revenue').textContent = '£' + data.revenue;

    if (ordersCache.length === 0) {
      ordersBody.innerHTML = '<tr><td colspan="10" class="empty">Nicio comandă găsită</td></tr>';
    } else {
      ordersBody.innerHTML = ordersCache.map(renderOrderRow).join('');
    }
    renderPagination(data.matchingCount);
  } catch (err) {
    ordersBody.innerHTML = '<tr><td colspan="10" class="empty">Eroare la încărcarea comenzilor.</td></tr>';
  }
}

// Debounce (300ms) — cautarea nu trimite o cerere la fiecare tasta apasata, ci abia dupa o
// scurta pauza in tastare.
let searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    state.offset = 0;
    loadOrders();
  }, 300);
});

statusFilter.addEventListener('change', () => {
  state.status = statusFilter.value;
  state.offset = 0;
  loadOrders();
});

prevBtn.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadOrders();
});
nextBtn.addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  loadOrders();
});

async function handleAnonymize(orderId) {
  if (!confirm('Anonimizezi definitiv această comandă (cerere GDPR)? Șterge identitatea/contactul și toate materialele media. Acțiune IREVERSIBILĂ.')) return;
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/anonymize`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Nu am putut anonimiza comanda.'); return; }
    alert(`Comandă anonimizată. Fișiere șterse: ${data.filesDeleted}/${data.filesTotal}.`);
    loadOrders();
  } catch (err) {
    alert('Eroare de conexiune.');
  }
}

async function handleRetryExtras(orderId) {
  if (!confirm('Reîncerci generarea extraselor (WAV/video) pentru această comandă?')) return;
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/retry-extras`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Nu am putut reîncerca generarea.'); return; }
    alert(`Reîncercare finalizată — WAV: ${data.hasWav ? 'da' : 'nu'}, Video: ${data.hasVideo ? 'da' : 'nu'}${data.videoFailedReason ? ` (eroare video: ${data.videoFailedReason})` : ''}.`);
    loadOrders();
  } catch (err) {
    alert('Eroare de conexiune.');
  }
}

ordersBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-order-action]');
  if (!btn) return;
  const orderId = btn.closest('[data-order-id]').dataset.orderId;
  const action = btn.dataset.orderAction;
  if (action === 'anonymize') handleAnonymize(orderId);
  else if (action === 'retry-extras') handleRetryExtras(orderId);
});

loadOrders();
