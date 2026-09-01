// credits.js
// Sistem de protectie a creditelor providerului de muzica (Suno, prin sunoapi.org).
//
// CONTEXT VERIFICAT DIRECT (2026-08-02), nu presupus din documentatie:
// - Un apel POST /api/v1/generate (model V4_5ALL, customMode:false) costa exact 12 credite,
//   debitate IMEDIAT la crearea task-ului, indiferent daca task-ul reuseste sau esueaza.
//   Masurat empiric: balanta a scazut de la 554.0 la 542.0 credite imediat dupa creare,
//   fara nicio scadere suplimentara dupa finalizarea task-ului.
// - Un singur apel produce AMBELE variante (preview + full song, ambele derivate din
//   aceleasi 2 piese audio primite) — nu exista niciun apel suplimentar ascuns.
// - O comanda normala consuma 1 apel (generarea initiala) sau 2 apeluri (initiala + 1
//   regenerare gratuita, FREE_EDITS=1 in server.js) = 12 sau 24 credite.
// - INAINTE de acest sistem, nu exista nicio limita a numarului de reincercari posibile
//   dupa un esec (/generate si /regenerate raman apelabile indefinit cat timp comanda
//   nu e 'ready' sau 'generating' — singura frana era rate-limiter-ul generic per IP,
//   care NU e un mecanism de protectie a creditelor). Acest fisier inchide acea gaura.
//
// NU putem verifica din API costul in USD/GBP per credit — sunoapi.org nu expune niciun
// endpoint care sa raporteze planul/tariful contului (verificat: pagina lor de "Account
// Management" nu exista/nu e publica). Acel numar depinde strict de planul cumparat de
// proprietarul contului si trebuie confirmat din dashboard-ul/factura sunoapi.org — vezi
// raportul final pentru cum e tratat acest gol, explicit, fara sa fie inlocuit cu o
// presupunere prezentata ca fapt verificat.

const { htmlToPlainText } = require('./lib/email-text');

const VERIFIED_CREDITS_PER_GENERATION = 12; // masurat direct, vezi comentariul de mai sus

// Configurabil prin variabile de mediu — toate cu valori implicite rezonabile, verificate
// impotriva comportamentului real al aplicatiei (vezi server.js, FREE_EDITS).
const CREDITS_PER_ORDER_ESTIMATE = parseInt(process.env.CREDITS_PER_ORDER_ESTIMATE, 10) || (VERIFIED_CREDITS_PER_GENERATION * 2); // 24 — scenariul cel mai costisitor normal (initiala + 1 regenerare)
const SAFETY_RESERVE_ORDERS = parseInt(process.env.CREDIT_SAFETY_RESERVE_ORDERS, 10) || 10;
// MAX_GENERATION_ATTEMPTS > 2 (numarul de runde legitime posibile intr-o comanda normala:
// generare initiala + 1 regenerare gratuita) — diferenta permite EXACT o reincercare dupa un
// esec real (nu vina clientului) pentru fiecare dintre cele doua runde, fara sa permita
// reincercari nelimitate. Vezi credits.js si server.js pentru unde e aplicat.
const MAX_GENERATION_ATTEMPTS = parseInt(process.env.MAX_GENERATION_ATTEMPTS, 10) || 4;
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || null;

// Pragul FIX (in credite, nu procent) pentru alerta principala — cerinta explicita: alerta
// trebuie sa se declanseze la trecerea PESTE->SUB acest numar exact de credite, indiferent
// de cat de mare a fost baseline-ul initial. Complet separat de ALERT_THRESHOLDS de mai jos
// (acelea sunt procentuale, relative la baseline — cele doua sisteme coexista).
const FIXED_ALERT_THRESHOLD = parseInt(process.env.CREDIT_ALERT_THRESHOLD, 10) || 248;
const SUNOAPI_DASHBOARD_URL = 'https://sunoapi.org/'; // nu exista, verificat, niciun link documentat mai specific catre o pagina de sold anume
const INSUFFICIENT_DATA_MESSAGE = 'Insufficient sales data to estimate remaining days.';
const MIN_ORDERS_FOR_ESTIMATE = 3; // sub acest numar de comenzi finalizate in ultimele 30 zile, o rata zilnica ar fi nesigura/instabila

const ALERT_THRESHOLDS = [0.30, 0.15, 0.10, 0.05]; // procente din baseline, verificate in ordine descrescatoare

let cachedBalance = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60000; // 60s — suficient sa evite sute de apeluri redundante intr-un trafic normal, suficient de scurt sa ramana relevant

let lastAlertedThreshold = null; // in-memory (per proces) — se reseteaza la restart, acceptabil: mai buna o alerta re-trimisa decat una pierduta definitiv

function providerConfigured() {
  return !!(process.env.MUSIC_API_BASE_URL && process.env.MUSIC_API_KEY);
}

async function fetchLiveBalance() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${process.env.MUSIC_API_BASE_URL}/api/v1/generate/credit`, {
      headers: { 'Authorization': `Bearer ${process.env.MUSIC_API_KEY}` },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`SunoAPI /generate/credit a raspuns cu HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== 200 || typeof body.data !== 'number') {
      throw new Error(`SunoAPI /generate/credit: raspuns neasteptat: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Balanta curenta, cu cache scurt si fallback la ultima valoare cunoscuta daca API-ul
// providerului e temporar indisponibil — o eroare tranzitorie la SunoAPI NU trebuie sa
// blocheze tot site-ul daca avem deja o valoare recenta suficient de buna.
async function getBalance({ forceRefresh = false } = {}) {
  if (!providerConfigured()) {
    return { balance: null, stale: false, unavailable: true };
  }
  const now = Date.now();
  if (!forceRefresh && cachedBalance !== null && (now - cachedAt) < CACHE_TTL_MS) {
    return { balance: cachedBalance, stale: false, unavailable: false };
  }
  try {
    const fresh = await fetchLiveBalance();
    cachedBalance = fresh;
    cachedAt = now;
    return { balance: fresh, stale: false, unavailable: false };
  } catch (err) {
    if (cachedBalance !== null) {
      console.error('[credits] Nu am putut reimprospata balanta SunoAPI, folosesc ultima valoare cunoscuta:', err.message);
      return { balance: cachedBalance, stale: true, unavailable: false };
    }
    console.error('[credits] Nu am putut obtine balanta SunoAPI si nu exista nicio valoare anterioara cunoscuta:', err.message);
    return { balance: null, stale: false, unavailable: true };
  }
}

// Baseline-ul (valoarea 100% fata de care se calculeaza procentele de alerta) e persistent
// in Postgres, NU doar in memorie — altfel s-ar reseta la fiecare redeploy Railway, facand
// pragurile de alerta sa fluctueze artificial de fiecare data cand aplicatia reporneste.
// Se initializeaza o singura data, la prima verificare, cu balanta reala de atunci.
async function getOrInitBaseline(db, currentBalance) {
  const existing = await db.getSetting('credit_baseline');
  if (existing !== null) return Number(existing);
  if (currentBalance === null) return null;
  await db.setSetting('credit_baseline', currentBalance);
  return currentBalance;
}

// Permite resetarea explicita a baseline-ului (de folosit dupa fiecare reincarcare de
// credite la providerul real — altfel un top-up ar aparea, incorect, ca fiind sub prag).
async function resetBaseline(db, newBaseline) {
  await db.setSetting('credit_baseline', newBaseline);
}

function getAlertLevel(balance, baseline) {
  if (!baseline || baseline <= 0 || balance === null) return null;
  const pct = balance / baseline;
  for (const t of ALERT_THRESHOLDS) {
    if (pct <= t) return t;
  }
  return null;
}

function reserveCredits() {
  return SAFETY_RESERVE_ORDERS * CREDITS_PER_ORDER_ESTIMATE;
}

function estimatedRemainingOrders(balance) {
  if (balance === null) return null;
  return Math.max(0, Math.floor(balance / CREDITS_PER_ORDER_ESTIMATE));
}

// Emergency mode: balanta a scazut sub rezerva de siguranta configurata. In acest mod,
// generarile noi si checkout-ul sunt blocate — vezi evaluateGuard().
function isEmergencyMode(balance) {
  if (balance === null) return true; // fail-safe: daca nu stim balanta deloc, ne comportam ca si cum am fi in urgenta
  return balance < reserveCredits();
}

// Decizia centrala: poate porni o generare noua / poate fi creat un checkout nou chiar
// acum? Foloseste ACEEASI logica pentru ambele cazuri ('generation' si 'checkout') —
// diferenta e doar in mesajul de eroare, nu in prag.
async function evaluateGuard(purpose) {
  const { balance, stale, unavailable } = await getBalance();

  if (unavailable) {
    // Nu stim balanta si nu avem nicio valoare anterioara — blocam, fail-safe. E preferabil
    // sa refuzam temporar o comanda noua decat sa riscam sa acceptam plati pe care nu le
    // putem confirma ca avem cu ce sa le onoram.
    return {
      allowed: false,
      reason: 'credit_balance_unavailable',
      balance: null,
      emergencyMode: true
    };
  }

  const emergency = isEmergencyMode(balance);
  const remainingAfterThisOrder = balance - CREDITS_PER_ORDER_ESTIMATE;
  const wouldBreachReserve = remainingAfterThisOrder < reserveCredits();

  return {
    allowed: !wouldBreachReserve,
    reason: wouldBreachReserve ? 'below_safety_reserve' : null,
    balance,
    stale,
    emergencyMode: emergency,
    reserveCredits: reserveCredits(),
    estimatedRemainingOrders: estimatedRemainingOrders(balance)
  };
}

// Verifica pragurile de alerta si trimite un email real (daca ADMIN_ALERT_EMAIL e
// configurat si RESEND_API_KEY functioneaza) DOAR cand se trece un prag NOU (nu la fiecare
// verificare) — evita spam-ul de alerte la fiecare comanda cat timp balanta ramane in
// aceeasi banda. Se apeleaza dupa fiecare consum real de credite.
async function checkThresholdsAndAlert(db) {
  const { balance, unavailable } = await getBalance();
  if (unavailable) return;

  const baseline = await getOrInitBaseline(db, balance);
  const level = getAlertLevel(balance, baseline);

  if (level === null) {
    if (lastAlertedThreshold !== null) lastAlertedThreshold = null; // balanta a urcat inapoi peste toate pragurile (reincarcare) — reseteaza
    return;
  }
  if (level === lastAlertedThreshold) return; // deja alertat pentru acest prag, nu retrimite

  lastAlertedThreshold = level;
  const pctLabel = `${Math.round(level * 100)}%`;
  const remaining = estimatedRemainingOrders(balance);
  const message = `[NALUNA] Credite SunoAPI sub ${pctLabel} din baseline. Balanta curenta: ${balance} credite (baseline: ${baseline}). Estimat: ${remaining} comenzi ramase la ${CREDITS_PER_ORDER_ESTIMATE} credite/comanda.`;

  console.error(message);

  if (ADMIN_ALERT_EMAIL && process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
          to: ADMIN_ALERT_EMAIL,
          subject: `Naluna: credite SunoAPI sub ${pctLabel}`,
          html: `<p>${message}</p>`,
          text: message
        })
      });
      if (!res.ok) {
        console.error('[credits] Alerta email nu a putut fi trimisa:', res.status, await res.text());
      }
    } catch (err) {
      console.error('[credits] Alerta email a esuat:', err.message);
    }
  } else {
    console.warn('[credits] ADMIN_ALERT_EMAIL nu e configurat — alerta a fost doar logata, nu si trimisa prin email.');
  }
}

// Detectare simpla de consum neobisnuit: compara numarul de generari reale (event_type =
// 'generation_attempt') din ULTIMA ORA cu media orara din ultimele 24h. Un raport > 3x
// media e semnalat — poate insemna trafic real neasteptat de mare, DAR si un bug sau abuz
// (exact gaura de reincercari nelimitate inchisa mai sus, daca ar exista undeva o cale
// neacoperita). Threshold generos (3x) intentionat, ca sa nu semnaleze fals la trafic normal variabil.
async function detectAnomaly(db) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const events = await db.getCreditEventsSince(oneDayAgo);
  const generationEvents = events.filter(e => e.event_type === 'generation_attempt');

  const lastHourCount = generationEvents.filter(e => new Date(e.created_at) >= oneHourAgo).length;
  const hourlyAverage24h = generationEvents.length / 24;

  const anomalous = hourlyAverage24h > 0 && lastHourCount > hourlyAverage24h * 3 && lastHourCount >= 5;

  return {
    anomalous,
    lastHourCount,
    hourlyAverage24h: Math.round(hourlyAverage24h * 100) / 100
  };
}

// Statistici de consum pentru "azi" (de la miezul noptii UTC) — folosite in panoul admin.
async function getDailyStats(db) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const events = await db.getCreditEventsSince(startOfDay);
  const generationEvents = events.filter(e => e.event_type === 'generation_attempt');
  const blockedEvents = events.filter(e => e.event_type.startsWith('blocked_'));

  const creditsSpentToday = generationEvents.reduce((sum, e) => sum + (Number(e.credits_spent) || 0), 0);

  return {
    generationsToday: generationEvents.length,
    creditsSpentToday,
    blockedAttemptsToday: blockedEvents.length,
    ordersAffectedToday: new Set(generationEvents.map(e => e.order_id).filter(Boolean)).size
  };
}

function formatUkTimestamp(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short'
  }).format(date);
}

// Calculeaza toate cifrele cerute explicit in emailul de alerta. Foloseste media REALA
// de credite per comanda finalizata (nu doar estimarea statica CREDITS_PER_ORDER_ESTIMATE)
// pentru "zile ramase", cand exista suficiente date — mai precisa pentru o afacere reala.
async function computeThresholdAlertStats(db, currentBalance) {
  const [avgResult, completed7d, completed30d] = await Promise.all([
    db.getAverageCreditsPerCompletedOrder(),
    db.getCompletedOrdersSince(7),
    db.getCompletedOrdersSince(30)
  ]);

  const avgOrdersPerDay30d = completed30d / 30;
  const bestCaseRemainingOrders = estimatedRemainingOrders(currentBalance); // foloseste 12 credite/comanda (VERIFIED_CREDITS_PER_GENERATION)
  const worstCaseRemainingOrders = Math.max(0, Math.floor(currentBalance / CREDITS_PER_ORDER_ESTIMATE)); // 24 credite/comanda

  let remainingDaysMessage;
  if (completed30d < MIN_ORDERS_FOR_ESTIMATE || avgOrdersPerDay30d <= 0 || !avgResult.averageCredits) {
    remainingDaysMessage = INSUFFICIENT_DATA_MESSAGE;
  } else {
    const realisticRemainingOrders = currentBalance / avgResult.averageCredits;
    const remainingDays = Math.floor(realisticRemainingOrders / avgOrdersPerDay30d);
    remainingDaysMessage = `${remainingDays} zile (estimare bazata pe media reala din ultimele 30 de zile)`;
  }

  return {
    bestCaseRemainingOrders,
    worstCaseRemainingOrders,
    averageCreditsPerOrder: avgResult.averageCredits !== null ? Math.round(avgResult.averageCredits * 100) / 100 : null,
    averageCreditsSampleSize: avgResult.sampleSize,
    completed7d,
    completed30d,
    avgOrdersPerDay30d: Math.round(avgOrdersPerDay30d * 100) / 100,
    remainingDaysMessage
  };
}

async function sendThresholdAlertEmail({ currentBalance, previousBalance, stats }) {
  if (!ADMIN_ALERT_EMAIL) {
    console.warn('[credits] ADMIN_ALERT_EMAIL nu e configurat — alerta de prag fix NU a putut fi trimisa prin email (doar logata).');
    return { sent: false, reason: 'no_recipient_configured' };
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('[credits] RESEND_API_KEY lipseste — alerta de prag fix NU a putut fi trimisa prin email (doar logata).');
    return { sent: false, reason: 'no_resend_key' };
  }

  const timestamp = formatUkTimestamp(new Date());
  const html = `
    <p>Balanta de credite SunoAPI a scazut la sau sub pragul de ${FIXED_ALERT_THRESHOLD}.</p>
    <ul>
      <li>Balanta curenta: ${currentBalance} credite</li>
      <li>Balanta anterioara: ${previousBalance !== null ? previousBalance : 'necunoscuta (prima verificare)'} credite</li>
      <li>Comenzi ramase estimate (best case, 12 credite/comanda): ${stats.bestCaseRemainingOrders}</li>
      <li>Comenzi ramase estimate (worst case, 24 credite/comanda): ${stats.worstCaseRemainingOrders}</li>
      <li>Media reala de credite per comanda finalizata: ${stats.averageCreditsPerOrder !== null ? stats.averageCreditsPerOrder : 'date insuficiente'} (${stats.averageCreditsSampleSize} comenzi analizate)</li>
      <li>Comenzi finalizate in ultimele 7 zile: ${stats.completed7d}</li>
      <li>Comenzi finalizate in ultimele 30 zile: ${stats.completed30d}</li>
      <li>Media comenzilor finalizate pe zi (ultimele 30 zile): ${stats.avgOrdersPerDay30d}</li>
      <li>Zile ramase estimate pana la epuizarea creditelor: ${stats.remainingDaysMessage}</li>
    </ul>
    <p>Dashboard SunoAPI: <a href="${SUNOAPI_DASHBOARD_URL}">${SUNOAPI_DASHBOARD_URL}</a></p>
    <p>Data/ora (UK): ${timestamp}</p>
  `;

  const attempt = async () => fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: ADMIN_ALERT_EMAIL,
      subject: `Naluna Alert: Credits Reached ${FIXED_ALERT_THRESHOLD}`,
      html,
      text: htmlToPlainText(html)
    })
  });

  // Reincercarea de mai jos priveste STRICT trimiterea email-ului (starea de alerta a fost
  // deja "consumata" atomic in Postgres INAINTE sa ajungem aici — vezi checkFixedThresholdAlert)
  // — deci o reincercare aici NU poate niciodata produce un al doilea email pentru aceeasi
  // scadere sub prag, doar creste sansa ca UNUL sa ajunga cu succes.
  for (let attemptNum = 1; attemptNum <= 2; attemptNum++) {
    try {
      const res = await attempt();
      if (res.ok) {
        if (attemptNum > 1) console.log(`[credits] alert_sent (retry_success) dupa ${attemptNum} incercari`);
        else console.log('[credits] alert_sent la prima incercare');
        return { sent: true };
      }
      const body = await res.text();
      console.error(`[credits] email_failure (incercarea ${attemptNum}/2): HTTP ${res.status} — ${body}`);
    } catch (err) {
      console.error(`[credits] email_failure (incercarea ${attemptNum}/2): ${err.message}`);
    }
  }
  return { sent: false, reason: 'send_failed_after_retry' };
}

// Punctul de intrare principal — apelat dupa fiecare consum real de credite (vezi
// callMusicProvider in server.js). Toata logica de decizie (crossing, dedup, re-arm) e
// delegata catre db.claimCreditAlertTransition, care e ATOMICA in Postgres — functia de
// aici doar reactioneaza la rezultat si trimite emailul cand e cazul.
async function checkFixedThresholdAlert(db, currentBalance) {
  console.log(`[credits] balance_checked: ${currentBalance} (prag fix: ${FIXED_ALERT_THRESHOLD})`);

  const { action, previousBalance } = await db.claimCreditAlertTransition(currentBalance, FIXED_ALERT_THRESHOLD);

  if (action === 'none') return;

  if (action === 'rearmed') {
    console.log(`[credits] alert_re-armed: balanta a urcat inapoi peste ${FIXED_ALERT_THRESHOLD} (${previousBalance} -> ${currentBalance})`);
    return;
  }

  if (action === 'suppressed') {
    console.log(`[credits] alert_suppressed: balanta ramane sub ${FIXED_ALERT_THRESHOLD} (${currentBalance}), alerta deja trimisa pentru aceasta scadere`);
    return;
  }

  // action === 'send_alert'
  console.log(`[credits] threshold_crossed: ${previousBalance} -> ${currentBalance} (prag: ${FIXED_ALERT_THRESHOLD})`);
  const stats = await computeThresholdAlertStats(db, currentBalance);
  const result = await sendThresholdAlertEmail({ currentBalance, previousBalance, stats });
  if (!result.sent) {
    console.error(`[credits] alerta de prag fix NU a putut fi trimisa prin email (motiv: ${result.reason}) — starea 'armed=false' ramane setata in Postgres, deci NU se va retrimite automat pana la o reincarcare de credite si o noua scadere sub prag. Verifica manual daca e nevoie.`);
  }
}

module.exports = {
  VERIFIED_CREDITS_PER_GENERATION,
  CREDITS_PER_ORDER_ESTIMATE,
  SAFETY_RESERVE_ORDERS,
  MAX_GENERATION_ATTEMPTS,
  FIXED_ALERT_THRESHOLD,
  ADMIN_ALERT_EMAIL,
  SUNOAPI_DASHBOARD_URL,
  providerConfigured,
  getBalance,
  getOrInitBaseline,
  resetBaseline,
  getAlertLevel,
  reserveCredits,
  estimatedRemainingOrders,
  isEmergencyMode,
  evaluateGuard,
  checkThresholdsAndAlert,
  detectAnomaly,
  getDailyStats,
  computeThresholdAlertStats,
  checkFixedThresholdAlert
};
