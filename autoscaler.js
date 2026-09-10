// autoscaler.js
// Scaleaza orizontal serviciul Railway "video-worker" in functie de adancimea cozii
// video_render_jobs — ÎN TESTARE, vezi raportul de scalabilitate. Nu ruleaza inca ca
// serviciu Railway permanent separat (ar necesita un Project Token dedicat, creat manual
// din dashboard — pas ramas pentru inainte de production cutover, vezi raportul). Pentru
// testare, acest script poate rula local/manual, autentificat prin sesiunea CLI curenta
// (railway scale) sau printr-un RAILWAY_TOKEN explicit daca e setat.
//
// Logica de scalare: citeste NUMARUL de joburi care au inca nevoie de acoperire (pending +
// claimed/active) si cere DIRECT acel numar de replici (plafonat la MAX_REPLICAS) — NU
// incremental (+1 pe tick) — ca un burst de N joburi aparute aproape simultan sa produca
// capacitate pentru N randari de la urmatoarea verificare, nu o rampa lenta. Scale-down e
// amortizat (maximum 1 replica per verificare, dupa un cooldown de inactivitate) ca sa evite
// porniri/opriri repetate quando coada oscileaza in jurul unei valori mici.
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const db = require('./db.js');

const SERVICE_NAME = process.env.VIDEO_WORKER_SERVICE_NAME || 'video-worker';
const REGION = process.env.VIDEO_WORKER_REGION || 'sfo';
const MAX_REPLICAS = Number(process.env.VIDEO_WORKER_MAX_REPLICAS || 3); // Hobby-safe implicit: 3
const POLL_INTERVAL_MS = Number(process.env.AUTOSCALER_POLL_INTERVAL_MS || 10 * 1000);
const SCALE_DOWN_COOLDOWN_MS = Number(process.env.AUTOSCALER_SCALE_DOWN_COOLDOWN_MS || 3 * 60 * 1000);

let currentReplicas = null; // necunoscut la pornire — primul tick il sincronizeaza
let lastNonZeroDemandAt = Date.now();

function log(...args) {
  console.log('[autoscaler]', ...args);
}

async function getCurrentReplicas() {
  const { stdout } = await execFileAsync('railway', ['service', 'list', '--json'], { timeout: 15000 });
  const services = JSON.parse(stdout);
  const svc = services.find(s => s.name === SERVICE_NAME);
  if (!svc) throw new Error(`Serviciul "${SERVICE_NAME}" nu a fost gasit — a fost creat?`);
  // Structura exacta a raspunsului variaza intre versiuni CLI — cautam un camp plauzibil de
  // numar de replici; daca nu-l gasim, presupunem necunoscut (null) si il stabilim prin
  // primul apel de scalare oricum (setScale e idempotent).
  return typeof svc.numReplicas === 'number' ? svc.numReplicas : null;
}

async function setReplicas(n) {
  log(`Scalez "${SERVICE_NAME}" (regiune ${REGION}) la ${n} replici...`);
  await execFileAsync('railway', ['scale', '--service', SERVICE_NAME, `${REGION}=${n}`], { timeout: 30000 });
  currentReplicas = n;
  log(`Scalat cu succes la ${n} replici.`);
}

async function tick() {
  const demand = await db.countPendingOrActiveVideoRenderJobs();
  const desired = Math.min(MAX_REPLICAS, demand);

  if (currentReplicas === null) {
    try { currentReplicas = await getCurrentReplicas(); } catch (err) {
      log('Nu am putut citi numarul curent de replici (se continua, presupun 0):', err.message);
      currentReplicas = 0;
    }
  }

  if (desired > 0) lastNonZeroDemandAt = Date.now();

  if (desired > currentReplicas) {
    // Scale-up IMEDIAT, direct la numarul necesar — niciodata incremental. Raspunde exact
    // cerintei "3 joburi aparute aproape simultan trebuie sa produca capacitate pentru 3,
    // nu doar 1": demand e citit ca intreg la fiecare tick, nu ca evenimente individuale.
    await setReplicas(desired);
  } else if (desired < currentReplicas) {
    const idleFor = Date.now() - lastNonZeroDemandAt;
    if (idleFor >= SCALE_DOWN_COOLDOWN_MS) {
      // Scale-down amortizat: maximum 1 replica per verificare, dupa cooldown — evita
      // flapping cand coada oscileaza in jurul unei valori mici.
      await setReplicas(Math.max(desired, currentReplicas - 1));
    } else {
      log(`Cerere scazuta (${demand} joburi, ${currentReplicas} replici active) dar in perioada de cooldown (${Math.round((SCALE_DOWN_COOLDOWN_MS - idleFor) / 1000)}s ramase) — nu reduc inca.`);
    }
  } else {
    log(`Stabil: ${demand} joburi in coada, ${currentReplicas} replici active — fara schimbare.`);
  }
}

async function mainLoop() {
  log(`Pornit. Serviciu="${SERVICE_NAME}", regiune="${REGION}", MAX_REPLICAS=${MAX_REPLICAS}, poll=${POLL_INTERVAL_MS}ms, cooldown scale-down=${SCALE_DOWN_COOLDOWN_MS}ms.`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log('Eroare la tick (se continua):', err.message);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  mainLoop().catch(err => {
    console.error('[autoscaler] eroare fatala:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { tick, setReplicas, getCurrentReplicas };
