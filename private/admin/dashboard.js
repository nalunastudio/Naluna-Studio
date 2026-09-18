// Dashboard — Admin NALUNA (2026-09-18, reorganizare Admin). Overview operational STRICT —
// NU dubleaza paginile complete Comenzi/Social Media/Website/Sistem, doar un rezumat +
// scurtaturi catre ele. Toate cifrele vin dintr-un SINGUR endpoint agregat
// (GET /api/admin/dashboard-summary), care foloseste interogari agregate (COUNT/SUM) si liste
// mici plafonate — niciodata liste complete incarcate doar ca sa fie numarate.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const ORDER_STATUS_LABEL = {
  draft: 'Neplătită', generating: 'Se compune', processing_provider_result: 'Se finalizează',
  preview_ready: 'Previzualizare gata', ready: 'Plătită și livrată', generation_failed: 'Eroare'
};
const SOCIAL_STATUS_LABEL = {
  draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published',
  partially_failed: 'Partially failed', failed: 'Failed', cancelled: 'Cancelled'
};

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/admin/dashboard-summary');
    const data = await res.json();

    document.getElementById('dash-orders-count').textContent = data.orders.totalCount;
    document.getElementById('dash-orders-revenue').textContent = '£' + data.orders.revenue;
    document.getElementById('dash-social-scheduled').textContent = data.social.stats.scheduled;
    document.getElementById('dash-credits-balance').textContent = data.credits.balanceUnavailable ? '—' : (data.credits.balance ?? '—');

    renderAlertBanner(data);
    renderRecentOrders(data.orders.recent);
    renderRecentSocial(data.social.recent);
  } catch (err) {
    document.getElementById('dash-recent-orders').innerHTML = '<div class="empty">Eroare la încărcarea datelor.</div>';
    document.getElementById('dash-recent-social').innerHTML = '<div class="empty">Eroare la încărcarea datelor.</div>';
  }
}

function renderAlertBanner(data) {
  const bannerEl = document.getElementById('dash-alert-banner');
  const problems = [];
  if (data.credits.emergencyMode) problems.push('mod urgență credite Suno activ');
  if (data.orders.attentionCount > 0) problems.push(`${data.orders.attentionCount} comenzi cu eroare de generare`);
  if (data.social.stats.attention > 0) problems.push(`${data.social.stats.attention} postări social media eșuate`);

  bannerEl.innerHTML = problems.length === 0 ? '' :
    `<div class="dash-alert-banner">⚠️ Necesită atenție: ${problems.join(' · ')}.</div>`;
}

function renderRecentOrders(orders) {
  const el = document.getElementById('dash-recent-orders');
  if (!orders || orders.length === 0) { el.innerHTML = '<div class="empty">Nicio comandă încă</div>'; return; }
  el.innerHTML = orders.map(o => `
    <div class="dash-mini-row">
      <span>${escapeHtml(o.recipient)} <span class="dash-mini-meta">£${o.price}</span></span>
      <span class="badge b-${o.status}">${ORDER_STATUS_LABEL[o.status] || o.status}</span>
    </div>
  `).join('');
}

function renderRecentSocial(posts) {
  const el = document.getElementById('dash-recent-social');
  if (!posts || posts.length === 0) { el.innerHTML = '<div class="empty">Nicio postare încă</div>'; return; }
  el.innerHTML = posts.map(p => {
    const caption = (p.caption || '(fără caption)').replace(/\s+/g, ' ').trim();
    const frag = caption.length > 60 ? caption.slice(0, 60) + '…' : caption;
    return `
      <div class="dash-mini-row">
        <span>${escapeHtml(frag)} <span class="dash-mini-meta">${fmtDate(p.publishedAt || p.scheduledAt || p.createdAt)}</span></span>
        <span class="sm-status-badge sm-s-${p.status}">${SOCIAL_STATUS_LABEL[p.status] || p.status}</span>
      </div>
    `;
  }).join('');
}

loadDashboard();
