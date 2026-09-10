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
// Vezi raportul pentru implicatiile asupra modelului de cost "idle = $0".
//
// Logica de scalare: citeste NUMARUL de joburi care au inca nevoie de acoperire (pending +
// claimed/active) si cere DIRECT acel numar de replici (plafonat la MAX_REPLICAS, minim 1 —
// vezi limita de mai sus) — NU incremental (+1 pe tick) — ca un burst de N joburi aparute
// aproape simultan sa produca capacitate pentru N randari de la urmatoarea verificare, nu o
// rampa lenta. Scale-down e amortizat (maximum 1 replica per verificare, dupa un cooldown de
// inactivitate) ca sa evite porniri/opriri repetate cand coada oscileaza in jurul unei valori mici.
// Apeluri DIRECTE HTTPS catre API-ul public Railway (fetch, deja disponibil nativ in Node
// 20+) — NU shell-out catre binarul CLI `railway` (nu exista garantat in interiorul unui
// container deployat, si oricum s-ar autentifica prin sesiunea CLI interactiva a autorului,
// nu printr-un credential propriu al serviciului). Autentificare printr-un Project Token
// dedicat acestui proiect (variabila RAILWAY_TOKEN), pus explicit pe serviciul "autoscaler"
// — NICIODATA acelasi token ca alte automatizari, conform recomandarii oficiale Railway
// ("Project token scoped to the target environment").
const db = require('./db.js');

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || null;
const SERVICE_ID = process.env.VIDEO_WORKER_SERVICE_ID || 'db5fc1a6-477a-44d7-83ee-199c542b5cdc';
const ENVIRONMENT_ID = process.env.RAILWAY_PRODUCTION_ENVIRONMENT_ID || 'c8c51f79-de40-474a-a0b3-7a3e389a2a14';
const REGION = process.env.VIDEO_WORKER_REGION || 'us-west2';
const MAX_REPLICAS = Number(process.env.VIDEO_WORKER_MAX_REPLICAS || 3); // Hobby-safe implicit: 3
const MIN_REPLICAS = 1; // podea reala de platforma, confirmata — vezi comentariul de mai jos
const POLL_INTERVAL_MS = Number(process.env.AUTOSCALER_POLL_INTERVAL_MS || 10 * 1000);
const SCALE_DOWN_COOLDOWN_MS = Number(process.env.AUTOSCALER_SCALE_DOWN_COOLDOWN_MS || 3 * 60 * 1000);

let currentReplicas = null; // necunoscut la pornire — primul tick il sincronizeaza
let lastNonZeroDemandAt = Date.now();

function log(...args) {
  console.log('[autoscaler]', ...args);
}

async function railwayGraphQL(query, variables) {
  if (!RAILWAY_TOKEN) {
    throw new Error('RAILWAY_TOKEN lipseste — vezi raportul, e singurul pas manual ramas (Project Token creat din dashboard).');
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

async function setReplicas(n) {
  const target = Math.max(MIN_REPLICAS, n);
  log(`Scalez serviciul (regiune ${REGION}) la ${target} replici (fara redeploy)...`);
  await railwayGraphQL(
    `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
    { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, input: { multiRegionConfig: { [REGION]: { numReplicas: target } } } }
  );
  currentReplicas = target;
  log(`Scalat cu succes la ${target} replici.`);
}

async function tick() {
  const demand = await db.countPendingOrActiveVideoRenderJobs();
  // MIN_REPLICAS: podeaua reala de platforma (vezi comentariul de sus) — nu putem cere
  // niciodata mai putin de 1, chiar daca demand=0 (coada goala).
  const desired = Math.max(MIN_REPLICAS, Math.min(MAX_REPLICAS, demand));

  if (currentReplicas === null) {
    // Nu exista un query simplu, direct, pentru "cate replici sunt active acum" — la
    // pornire, sincronizam starea printr-un apel de scalare explicit (idempotent, sigur
    // chiar daca valoarea reala e deja cea dorita) in loc sa presupunem o valoare.
    await setReplicas(desired);
    return;
  }

  // BUG CORECTAT: verifica `demand` (adancimea reala a cozii), NU `desired` — `desired` e
  // mereu >= MIN_REPLICAS (podeaua de platforma), deci "desired > 0" era mereu adevarat,
  // iar cronometrul de cooldown nu pornea niciodata cu adevarat de la 0 cerere reala.
  if (demand > 0) lastNonZeroDemandAt = Date.now();

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
  log(`Pornit. Serviciu=${SERVICE_ID}, regiune="${REGION}", MIN_REPLICAS=${MIN_REPLICAS}, MAX_REPLICAS=${MAX_REPLICAS}, poll=${POLL_INTERVAL_MS}ms, cooldown scale-down=${SCALE_DOWN_COOLDOWN_MS}ms.`);
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

module.exports = { tick, setReplicas };
