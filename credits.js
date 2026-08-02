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
          html: `<p>${message}</p>`
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

module.exports = {
  VERIFIED_CREDITS_PER_GENERATION,
  CREDITS_PER_ORDER_ESTIMATE,
  SAFETY_RESERVE_ORDERS,
  MAX_GENERATION_ATTEMPTS,
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
  getDailyStats
};
