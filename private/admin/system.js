// Sistem — Admin NALUNA (2026-09-18, reorganizare Admin). Expune UI minimal pentru unelte care
// existau DEJA ca rute /api/admin/* functionale, dar fara nicio interfata (accesibile doar prin
// curl/Postman): panoul de credite Suno, cele 3 rute de retentie GDPR si curatarea comenzilor
// abandonate. Nicio logica noua — STRICT randare + apeluri catre endpoint-urile existente.
//
// enqueue-video-render-job-TEST-ONLY ramane INTENTIONAT fara buton aici — e o unealta STRICT
// pentru testarea arhitecturii video-worker (vezi comentariul din server.js), nu un instrument
// de operare zilnica.

function fmtNum(n) {
  return n === null || n === undefined ? '—' : new Intl.NumberFormat('ro-RO').format(n);
}
function fmtDate(v) {
  return v ? new Date(v).toLocaleString('ro-RO') : '—';
}

async function loadCredits() {
  const rowsEl = document.getElementById('credits-rows');
  const bannerEl = document.getElementById('system-emergency-banner');
  try {
    const res = await fetch('/api/admin/credits');
    const d = await res.json();

    bannerEl.innerHTML = d.emergencyMode
      ? `<div class="emergency-banner">⚠️ Mod urgență activ — balanța de credite Suno e sub rezerva de siguranță (${fmtNum(d.safetyReserveOrders)} comenzi).</div>`
      : '';

    if (d.balanceUnavailable) {
      rowsEl.innerHTML = `<div class="system-row"><span>Balanță</span><span>Indisponibilă (furnizor neconfigurat sau eroare)</span></div>`;
      return;
    }

    const rows = [
      ['Balanță curentă', fmtNum(d.balance) + (d.balanceStale ? ' (valoare veche, refresh eșuat)' : '')],
      ['Baseline (100%)', fmtNum(d.baseline)],
      ['Nivel alertă', d.alertLevel ? `sub ${Math.round(d.alertLevel * 100)}%` : 'niciunul activ'],
      ['Rezervă siguranță', `${fmtNum(d.reserveCredits)} credite (${fmtNum(d.safetyReserveOrders)} comenzi)`],
      ['Comenzi estimate rămase', fmtNum(d.estimatedRemainingOrders)],
      ['Generări astăzi', fmtNum(d.today?.generationsToday)],
      ['Credite consumate astăzi', fmtNum(d.today?.creditsSpentToday)],
      ['Încercări blocate astăzi', fmtNum(d.today?.blockedAttemptsToday)],
      ['Activitate neobișnuită (ultima oră)', d.anomaly?.anomalous ? `DA — ${fmtNum(d.anomaly.lastHourCount)} generări (medie: ${fmtNum(d.anomaly.hourlyAverage24h)}/h)` : 'Nu'],
      ['Alertă prag fix', `${fmtNum(d.fixedThresholdAlert?.threshold)} credite — ${d.fixedThresholdAlert?.armed ? 'armată' : 'dezarmată'}${d.fixedThresholdAlert?.recipientConfigured ? '' : ' (fără destinatar configurat)'}`],
      ['Ultima alertă trimisă', fmtDate(d.fixedThresholdAlert?.lastAlertSentAt)]
    ];
    rowsEl.innerHTML = rows.map(([label, value]) => `<div class="system-row"><span>${label}</span><span>${value}</span></div>`).join('');
  } catch (err) {
    rowsEl.innerHTML = '<div class="system-row"><span>Eroare la încărcarea datelor de credite.</span></div>';
  }
}

document.getElementById('credits-test-btn').addEventListener('click', async () => {
  const input = document.getElementById('credits-test-balance');
  const balance = Number(input.value);
  const resultEl = document.getElementById('credits-test-result');
  if (!Number.isFinite(balance)) { alert('Introdu o balanță numerică validă.'); return; }
  if (!confirm(`Testezi logica de alertă cu o balanță SIMULATĂ de ${balance}? Nu se consumă niciun credit real.`)) return;
  try {
    const res = await fetch('/api/admin/credits/test-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ balance })
    });
    const data = await res.json();
    resultEl.style.display = 'block';
    resultEl.textContent = res.ok ? JSON.stringify(data, null, 2) : (data.error || 'Eroare la testare.');
  } catch (err) {
    resultEl.style.display = 'block';
    resultEl.textContent = 'Eroare de conexiune.';
  }
});

// ---------- Retentie GDPR ----------

const RETENTION_ACTIONS = {
  'retention-purge-btn': { url: '/api/admin/retention/purge-source-media', confirmMsg: 'Rulezi curățarea materialelor sursă expirate (peste 30 de zile de la plată)? Fișierele reale sunt șterse din storage.' },
  'retention-expire-btn': { url: '/api/admin/retention/expire-final-media', confirmMsg: 'Rulezi expirarea produsului final (peste 30 de zile de la plată)? Fișierele reale (melodie/video) sunt șterse din storage.' },
  'retention-anonymize-btn': { url: '/api/admin/retention/anonymize-stale-stories', confirmMsg: 'Rulezi anonimizarea poveștilor vechi (peste 30 de zile de la plată)?' }
};

for (const [btnId, cfg] of Object.entries(RETENTION_ACTIONS)) {
  document.getElementById(btnId).addEventListener('click', async () => {
    if (!confirm(cfg.confirmMsg)) return;
    const resultEl = document.getElementById('retention-result');
    resultEl.style.display = 'block';
    resultEl.textContent = 'Se rulează...';
    try {
      const res = await fetch(cfg.url, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const data = await res.json();
      resultEl.textContent = res.ok ? JSON.stringify(data, null, 2) : (data.error || 'Eroare la rulare.');
    } catch (err) {
      resultEl.textContent = 'Eroare de conexiune.';
    }
  });
}

// ---------- Cleanup comenzi abandonate ----------

document.getElementById('cleanup-run-btn').addEventListener('click', async () => {
  const days = Number(document.getElementById('cleanup-days').value) || 14;
  const real = document.getElementById('cleanup-real').checked;
  const resultEl = document.getElementById('cleanup-result');

  if (real && !confirm(`Ștergi DEFINITIV materialele comenzilor abandonate mai vechi de ${days} zile? Acțiune ireversibilă.`)) return;

  resultEl.style.display = 'block';
  resultEl.textContent = 'Se rulează...';
  try {
    const res = await fetch('/api/admin/cleanup/abandoned-uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ olderThanDays: days, dryRun: !real })
    });
    const data = await res.json();
    resultEl.textContent = res.ok ? JSON.stringify(data, null, 2) : (data.error || 'Eroare la rulare.');
  } catch (err) {
    resultEl.textContent = 'Eroare de conexiune.';
  }
});

loadCredits();
