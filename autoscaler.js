// autoscaler.js
// Scaleaza orizontal serviciul Railway "video-worker" in functie de adancimea cozii
// video_render_jobs — ÎN TESTARE, vezi raportul de scalabilitate. Pentru actiunea efectiva
// de scalare foloseste DIRECT mutatia GraphQL serviceInstanceUpdate cu campul
// `multiRegionConfig` (obiect JSON, cheie = regiune) — NU `railway scale`/campul plat
// `numReplicas` de pe ServiceInstanceUpdateInput. Verificat direct, cu dovezi din
// deploymentId neschimbat inainte/dupa apel: forma NESTATA (multiRegionConfig) e singura
// care schimba STRICT numarul de replici, fara sa declanseze un redeploy — `railway scale`
// (CLI) si campul plat `numReplicas` DECLANSEAZA amandoua un ciclu complet de build+deploy,
// ceea ce ar intrerupe inutil randari deja in curs pe replicile existente.
//
// LIMITA REALA DE PLATFORMA, confirmata direct (eroare server-side explicita la incercare):
// numReplicas pe o regiune configurata NU poate fi 0 — minim 1. Un serviciu activ nu poate
// fi redus la exact 0 replici prin acest API; podeaua practica e 1 replica ruland continuu.
//
// CORECȚIE CRITICĂ (gasita direct printr-un test real de 5 replici): un apel de scalare care
// raspunde "succes" NU garanteaza ca platforma a pornit efectiv replicile cerute — am observat
// direct un caz real in care cererea de 5 replici a fost acceptata, dar starea REALA a ramas
// blocata la 1 ruland + 1 "crashed" (replica crashed nu a produs NICIUN log, niciodata —
// dovada ca nu a apucat sa porneasca aplicatia deloc, nu un OOM in timpul randarii). Din acest
// motiv, `setReplicas` NU mai presupune succesul unui apel — VERIFICA starea reala a
// platformei (query serviceInstances -> latestDeployment -> instances[].status) dupa fiecare
// cerere, cu reincercari cu backoff (nu re-hammering imediat), si NICIODATA nu seteaza
// `currentReplicas` la valoarea CERUTA — doar la valoarea REAL observata.
const db = require('./db.js');

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || null;
const SERVICE_ID = process.env.VIDEO_WORKER_SERVICE_ID || 'db5fc1a6-477a-44d7-83ee-199c542b5cdc';
const ENVIRONMENT_ID = process.env.RAILWAY_PRODUCTION_ENVIRONMENT_ID || 'c8c51f79-de40-474a-a0b3-7a3e389a2a14';
const REGION = process.env.VIDEO_WORKER_REGION || 'us-west2';
const MAX_REPLICAS = Number(process.env.VIDEO_WORKER_MAX_REPLICAS || 3); // Hobby-safe implicit: 3
const MIN_REPLICAS = 1; // podea reala de platforma, confirmata — vezi comentariul de sus
const POLL_INTERVAL_MS = Number(process.env.AUTOSCALER_POLL_INTERVAL_MS || 10 * 1000);
const SCALE_DOWN_COOLDOWN_MS = Number(process.env.AUTOSCALER_SCALE_DOWN_COOLDOWN_MS || 3 * 60 * 1000);

// Verificarea starii reale dupa o cerere de scalare: NU re-trimite mutatia in bucla (ar fi
// hammering inutil — cererea a fost deja acceptata de API) — doar RE-CITESTE starea reala,
// cu backoff intre citiri, ca sa dea platformei timp sa termine programarea replicilor.
const VERIFY_ATTEMPTS = Number(process.env.AUTOSCALER_VERIFY_ATTEMPTS || 5);
const VERIFY_BASE_DELAY_MS = Number(process.env.AUTOSCALER_VERIFY_BASE_DELAY_MS || 8000);
const VERIFY_MAX_DELAY_MS = Number(process.env.AUTOSCALER_VERIFY_MAX_DELAY_MS || 45000);

// Anti-thrashing: daca o cerere de scalare la un anumit nivel a esuat sa fie onorata real de
// platforma, NU o reincercam la fiecare tick (ar hammering API-ul de scalare la nesfarsit
// pentru ceva ce tocmai am dovedit ca platforma nu poate onora acum) — asteptam acest interval
// inainte de a mai incerca sa urcam la ACELASI nivel sau mai sus.
const SCALE_UP_RETRY_COOLDOWN_MS = Number(process.env.AUTOSCALER_SCALE_UP_RETRY_COOLDOWN_MS || 60 * 1000);

let currentReplicas = null; // starea REALA cunoscuta, niciodata doar "ce am cerut"
let lastNonZeroDemandAt = Date.now();
let lastFailedScaleUpTarget = null;
let lastFailedScaleUpAt = 0;

function log(...args) {
  console.log('[autoscaler]', ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function railwayGraphQL(query, variables) {
  if (!RAILWAY_TOKEN) {
    throw new Error('RAILWAY_TOKEN lipseste — Project Token creat din dashboard, vezi raportul.');
  }
  const res = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': RAILWAY_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json();
  if (body.errors) throw new Error(`Railway API: ${body.errors.map(e => e.message).join('; ')}`);
  return body.data;
}

// Starea REALA a platformei — NU presupusa, interogata direct. Returneaza numarul de
// instante RUNNING/CRASHED/total din ultimul deployment al serviciului, pentru mediul curent.
async function getRealReplicaState() {
  const data = await railwayGraphQL(
    `query($id: String!) { service(id: $id) { serviceInstances { edges { node { environmentId latestDeployment { id status instances { id status } } } } } } }`,
    { id: SERVICE_ID }
  );
  const edge = (data.service.serviceInstances.edges || []).find(e => e.node.environmentId === ENVIRONMENT_ID);
  if (!edge || !edge.node.latestDeployment) return { running: 0, crashed: 0, total: 0, deploymentId: null, deploymentStatus: null };
  const dep = edge.node.latestDeployment;
  const instances = dep.instances || [];
  const running = instances.filter(i => i.status === 'RUNNING').length;
  const crashed = instances.filter(i => i.status === 'CRASHED').length;
  return { running, crashed, total: instances.length, deploymentId: dep.id, deploymentStatus: dep.status };
}

// Cere scalarea la `n` replici, apoi VERIFICA (nu presupune) ca platforma a onorat cererea.
// Returneaza starea reala finala observata — apelantul (tick) e responsabil sa actualizeze
// `currentReplicas` STRICT pe baza acestei valori reale, niciodata pe baza lui `n` cerut.
async function requestReplicas(n) {
  const target = Math.max(MIN_REPLICAS, n);
  log(`Cer ${target} replici (regiune ${REGION}, fara redeploy)...`);
  await railwayGraphQL(
    `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
    { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, input: { multiRegionConfig: { [REGION]: { numReplicas: target } } } }
  );

  let delay = VERIFY_BASE_DELAY_MS;
  let lastState = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    await sleep(delay);
    lastState = await getRealReplicaState();
    if (lastState.running >= target) {
      log(`Confirmat REAL: ${lastState.running}/${target} replici active (verificare directa platforma).`);
      return { ok: true, target, ...lastState };
    }
    log(`DISCREPANTA cerut vs real: cerut=${target}, real running=${lastState.running}, crashed=${lastState.crashed}, total=${lastState.total} (verificare ${attempt}/${VERIFY_ATTEMPTS}, urmatoarea in ${Math.round(Math.min(delay * 2, VERIFY_MAX_DELAY_MS) / 1000)}s)`);
    delay = Math.min(delay * 2, VERIFY_MAX_DELAY_MS);
  }
  log(`NEREUSIT sa confirm ${target} replici dupa ${VERIFY_ATTEMPTS} verificari — platforma ramane la ${lastState.running} reale, ${lastState.crashed} crashed. NU presupun succesul cererii.`);
  return { ok: false, target, ...lastState };
}

async function tick() {
  const demand = await db.countPendingOrActiveVideoRenderJobs();
  const desired = Math.max(MIN_REPLICAS, Math.min(MAX_REPLICAS, demand));

  if (currentReplicas === null) {
    const state = await getRealReplicaState();
    currentReplicas = state.running || MIN_REPLICAS;
    log(`Sincronizare initiala: ${currentReplicas} replici reale gasite la pornire.`);
  }

  if (demand > 0) lastNonZeroDemandAt = Date.now();

  if (desired > currentReplicas) {
    // Anti-thrashing: daca am incercat deja recent sa ajungem la un nivel >= desired si
    // platforma nu l-a onorat, nu re-hammering API-ul de scalare la fiecare tick — asteptam
    // cooldown-ul, cu exceptia cazului in care cererea a scazut sub pragul care esuase.
    if (lastFailedScaleUpTarget !== null && desired <= lastFailedScaleUpTarget &&
        Date.now() - lastFailedScaleUpAt < SCALE_UP_RETRY_COOLDOWN_MS) {
      const waitS = Math.round((SCALE_UP_RETRY_COOLDOWN_MS - (Date.now() - lastFailedScaleUpAt)) / 1000);
      log(`Cerere de ${desired} replici, dar ${lastFailedScaleUpTarget} a esuat recent — astept cooldown (${waitS}s) inainte sa reincerc, ca sa nu bat la usa platformei degeaba.`);
      return;
    }
    const result = await requestReplicas(desired);
    currentReplicas = result.running; // STRICT valoarea reala, niciodata `desired`
    if (!result.ok) {
      lastFailedScaleUpTarget = desired;
      lastFailedScaleUpAt = Date.now();
    } else {
      lastFailedScaleUpTarget = null;
    }
  } else if (desired < currentReplicas) {
    const idleFor = Date.now() - lastNonZeroDemandAt;
    if (idleFor >= SCALE_DOWN_COOLDOWN_MS) {
      const result = await requestReplicas(Math.max(desired, currentReplicas - 1));
      currentReplicas = result.running;
    } else {
      log(`Cerere scazuta (${demand} joburi, ${currentReplicas} replici active) dar in perioada de cooldown (${Math.round((SCALE_DOWN_COOLDOWN_MS - idleFor) / 1000)}s ramase) — nu reduc inca.`);
    }
  } else {
    log(`Stabil: ${demand} joburi in coada, ${currentReplicas} replici active (verificat real) — fara schimbare.`);
  }
}

async function mainLoop() {
  log(`Pornit. Serviciu=${SERVICE_ID}, regiune="${REGION}", MIN_REPLICAS=${MIN_REPLICAS}, MAX_REPLICAS=${MAX_REPLICAS}, poll=${POLL_INTERVAL_MS}ms, cooldown scale-down=${SCALE_DOWN_COOLDOWN_MS}ms, cooldown retry scale-up=${SCALE_UP_RETRY_COOLDOWN_MS}ms.`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log('Eroare la tick (se continua):', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

if (require.main === module) {
  mainLoop().catch(err => {
    console.error('[autoscaler] eroare fatala:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { tick, requestReplicas, getRealReplicaState };
