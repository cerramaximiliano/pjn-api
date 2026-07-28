---
name: monitor-pjn-api
description: Carga contexto operacional de pjn-api (1 proceso PM2 con 30+ routers agrupados en ~7 dominios funcionales: causas, sentencias, scraping/manager, configuración, captcha, movimientos, stuck/failover). Úsalo cuando vayas a inspeccionar el servicio o se invoque /monitor-pjn-api. Se actualiza al final de cada corrida con patrones nuevos.
---

# Skill — monitor-pjn-api

Contexto operacional vivo de **pjn-api**, la API REST principal de causas PJN. Lo lee `/monitor-pjn-api` antes de inspeccionar; se va llenando con cada corrida.

> **Convención**: append-only en secciones `<!-- APPEND HERE -->`. Curado manual cuando supere ~15kb.

## 1. Cuándo activar

- Antes de inspeccionar pjn-api (vía `/monitor-pjn-api` o ad-hoc).
- Cuando el front (`law-analytics-front`) reporta errores en consume de `api.lawanalytics.com.ar`.
- Cuando un worker (pjn-workers, pjn-workers-scraping, mis-causas) falla en alguna llamada de configuración a pjn-api.
- Para entender qué dominio funcional cubre cada router antes de tocar `src/routes/*` o `src/controllers/*`.

## 2. Arquitectura del servicio (DUAL)

`pjn-api` corre como **1 proceso PM2 `pjn/api`** en **DOS servers distintos**, cada uno con propósito diferente. Ver [[ecosystem-topology]] para el mapa completo.

### Instancia "Atlas" (pública)
- Server: 🔵 hub `15.229.93.121` (key auth + ubuntu+sudo)
- Path: `/var/www/pjn-api` (verificar)
- PM2 bin: `/usr/bin/pm2` (global)
- DB: Mongo Atlas (la BD principal del ecosistema)
- Consumidores: `law-analytics-front`, workers PJN (consultan configuración), otros servicios.
- URL pública: `api.lawanalytics.com.ar`.

### Instancia "Local" (interna)
- Server: 🟢 worker_01 `100.111.73.56` (sshpass + worker_01)
- Path: `/var/www/pjn-api`
- PM2 bin: `~worker_01/.npm-global/bin/pm2`
- DB: Mongo local de worker_01 (cache de documentos de causas)
- Consumidores: workers internos del mismo box (sentencias, escritos, etc.) que necesitan acceso rápido al cache.

**El `.env.local` actual del repo apunta SOLO a la instancia Local.** El comando `/monitor-pjn-api` está adaptado para inspeccionar ambas (hardcoded las credenciales del hub para Atlas, ver el comando para detalles).

- Express.js + Mongoose + JWT. Puerto **8083** en ambos servers.
- Entry: `src/server.js`.
- Routing principal: monta `app.use('/api', indexRoutes)`. Todos los routers cuelgan de `/api`.
- **PM2 watch = OFF en ambos** desde 2026-07-28 (`watch: false` en `ecosystem.config.js`, commit `27f8e11`). Un edit de `src/` NO auto-restartea → el deploy debe hacer restart explícito. Históricamente el hub tenía `watch: ["src"]`, lo que causaba crash-loops `MODULE_NOT_FOUND` en cada deploy (ver §8) — no volver a activarlo.
- Max memory restart: 1GB.
- **Env en runtime**: `server.js` baja secrets de AWS, los escribe a `.env` y recién ahí corre `dotenv.config()` — DESPUÉS de `require('./routes/index')`. ⇒ cualquier `const X = process.env.FOO` evaluado al cargar un módulo (top-level) queda con el env VACÍO. Los flags que dependen del env (ej. `VECTOR_BACKEND`, `QDRANT_URL`) deben leerse en tiempo de ejecución, no al cargar el módulo. Ver gotcha en §5.

### 2.1 Dominios funcionales (agrupamiento de routers)

| Dominio | Routers | Endpoints típicos |
|---|---|---|
| **Causas / fueros** | `causasRoutes`, `causasUpdateRoutes`, `causasElegiblesUpdateRoutes`, `causasServiceRoutes` | `/api/causas/:fuero/*`, `/api/causas/stats`, `/api/causas/verified` |
| **Sentencias** | `sentenciasCapturadasRoutes`, `sentenciasSearchRoutes`, `saijSentenciasRoutes` | `/api/sentencias-capturadas/*`, `/api/sentencias-search/*`, `/api/saij/*` |
| **Configuración de workers** | `configuracionAppUpdateRoutes`, `configuracionEmailVerificationRoutes`, `configuracionScrapingRoutes`, `configuracionScrapingHistoryRoutes`, `configuracionSemanticWorkerRoutes`, `configuracionSentenciasCollectorRoutes`, `configuracionUpdateMovimientosRoutes`, `configuracionVerificacionRoutes` | `/api/configuracion/*` |
| **Scraping manager** | `scrapingManagerRoutes`, `scrapingWorkerManagerRoutes`, `scrapingStatsRoutes` | `/api/scraping/*` |
| **Captcha (dataset)** | `captchaDatasetRoutes` | `/api/captcha-dataset/*` |
| **Movimientos** | `judicialMovementsRoutes` | `/api/judicial-movements/*` |
| **Intervinientes / juzgados** | `intervinientesRoutes` (+ controllers `juzgados`) | `/api/intervinientes/*` |
| **Stuck / failover / drift** | `stuckDocumentsRoutes`, `failoverRoutes`, `htmlDriftRoutes` | `/api/stuck-documents/*`, `/api/failover/*`, `/api/html-drift/*` |
| **Worker stats / logs** | `workerLogRoutes`, `workerStatsRoutes`, `workerLogRoutes` | `/api/worker-stats/*`, `/api/worker-logs/*` |
| **Server / utilitarios** | `serverRoutes`, `cleanupConfigRoutes`, `extraInfoConfigRoutes`, `syncResetRoutes` | `/api/server/*`, `/api/cleanup/*` |
| **Manager config** | `managerConfigRoutes` | `/api/manager-config/*` |

> Tabla viva: si aparece un router nuevo o uno se renombra, actualizar acá.

### 2.2 Consumidores

- **`law-analytics-front`** consume directo (via `VITE_CAUSAS_URL`).
- **`pjn-workers`**, **`pjn-workers-scraping`**, **`pjn-mis-causas`**: consultan configuración (`/api/configuracion/*`) al arrancar y periódicamente.
- **`law-analytics-admin`**: configura los services de sentencias (`/api/configuracion/sentencias*`).
- **`pjn-rag-api`**: cruza datos al hacer publicaciones de sentencias.

URLs públicas conocidas:
- Prod: `https://api.lawanalytics.com.ar` (según `.env.production` de law-analytics-front).
- Dev/staging: `https://api.lawanalytics.app` (según `.env` de law-analytics-front — confirmar con el usuario qué entorno apunta).

### 2.3 Dependencias externas

- **MongoDB Atlas** (causas, sentencias, configs, workers stats — modelos en `pjn-models`).
- **AWS SES** (`src/controllers/aws-ses.js`) — emails desde la API en algunos flujos.
- **Auth**: JWT firmado por `law-analytics-server`. Si el server hub está caído o roto, este servicio sigue corriendo pero las requests autenticadas fallan con 401.
- **`pjn-models`** (librería compartida): dep git **pineada** a un tag (ver §2.5). El código de pjn-api usa modelos de varias versiones (`NotifWorkerConfig` ≥1.16.0, campo `trayectoria` ≥1.17). Si un server corre una versión vieja, esos endpoints crashean (ej. `/api/notif-worker-config` → 500 `Cannot read properties of undefined (reading 'getOrCreate')`).

### 2.4 Deploy — DUAL, dos flujos DISTINTOS (CRÍTICO)

Las dos instancias se despliegan por mecanismos **diferentes y desacoplados**. Este es el punto que más genera drift/atrasos: un push actualiza el hub solo, pero worker_01 queda viejo hasta que lo desplegás a mano.

| | Instancia HUB (Atlas) | Instancia LOCAL (worker_01) |
|---|---|---|
| Server | 🔵 `15.229.93.121` (EC2 público) | 🟢 `100.111.73.56` (Tailscale privada) |
| Deploy | **Automático** — GitHub Actions `.github/workflows/deploy.yml` on push a `main` (`git reset --hard origin/main` + `npm ci --production` + `pm2 reload`) | **Manual** — `bash scripts/deploy-worker01.sh` desde una máquina en la Tailnet |
| Por qué así | runner de GitHub puede SSH al EC2 público | worker_01 está en red privada Tailscale → **inalcanzable** desde runners de GitHub. No se puede meter en CI. |
| Auth | key (`ubuntu`, sudo, pm2 root `/usr/bin/pm2`) | password/sshpass (`.env.local`), pm2 de usuario (`~worker_01/.npm-global/bin/pm2`) |
| NODE_ENV | (default) → `URLDB` = **Atlas** | `local` → `URLDB_LOCAL` = **Mongo local** |

**⇒ REGLA DE ORO: después de CADA `git push origin main` de pjn-api, correr `bash scripts/deploy-worker01.sh`.** El hub se actualiza solo; worker_01 no. Si te olvidás, quedan en commits distintos.

Verificar que ambos quedaron en el mismo commit tras un deploy:
```bash
# hub
ssh -i /home/mcerra/www/lawanalytics.app.pem ubuntu@15.229.93.121 'git -C /var/www/pjn-api rev-parse --short HEAD'
# worker_01
sshpass -p "$SSH_PASSWORD" ssh worker_01@100.111.73.56 'git -C /var/www/pjn-api rev-parse --short HEAD'
```

El CI del hub se puede ver con `gh run list --workflow=deploy.yml --limit 1` / `gh run watch <id>` (repo `cerramaximiliano/pjn-api`). Nota: el hub hace `git clean -fd` → borra untracked (ej. `.claude/settings.local.json`) en cada deploy, es esperado.

### 2.5 `pjn-models` pineado a tag (evitar drift de versión)

`package.json` declara `"pjn-models": "github:cerramaximiliano/pjn-models#v1.20.0"` — **pineado a un tag**, NO flotante. Antes estaba sin ref (`github:cerramaximiliano/pjn-models`), y como es dep git, cada `npm install` re-resolvía al HEAD del branch → los dos servers terminaban en versiones distintas (el hub en 1.14.0 vía `npm ci`, worker_01 en 1.19.1 vía `npm install` manual). Eso rompía `/api/notif-worker-config` en el hub (§4). Con el pin, `npm ci` en ambos resuelve al mismo commit.

**Flujo para bumpear `pjn-models`:**
1. En el repo `pjn-models`: commitear, subir `version` en `package.json`, y **taggear**:
   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z" && git push origin vX.Y.Z
   ```
2. En `pjn-api`: cambiar el ref en `package.json` a `#vX.Y.Z`, `npm install` (regenera el lock al commit del tag), verificar (`node -e "console.log(require('pjn-models').NuevoModelo)"`), commit + push.
3. Desplegar **ambos**: el push dispara el hub; correr `scripts/deploy-worker01.sh` para worker_01.

Cambios de `pjn-models` son siempre **aditivos** (modelos/campos/enums nuevos) → pinear ambos servers a la misma versión es seguro; cada instancia usa los modelos relevantes a su DB y los demás simplemente existen sin usarse.

## 3. Endpoint de health

`/api/causas/test` (definido en `causasRoutes.js` como `router.get('/test', ...)`).

```bash
curl -sS -o /dev/null -w "HTTP %{http_code} en %{time_total}s\n" \
  "https://api.lawanalytics.app/api/causas/test" --max-time 10
```

⚠️ Verificado 2026-07-28: `api.lawanalytics.com.ar` NO resuelve (ni siquiera desde el hub) — el dominio público real es `api.lawanalytics.app`. Desde dentro del hub también sirve `http://localhost:8083/api/causas/test`.

## 4. Errores conocidos
<!-- Cada entrada: descripción + patrón grep + dominio afectado + acción típica -->
<!-- APPEND HERE -->

### `/api/notif-worker-config` → 500 por `pjn-models` viejo
<!-- detectado: 2026-07-17 | dominio: config workers -->
**Síntoma**: `{"success":false,"error":"Cannot read properties of undefined (reading 'getOrCreate')"}` en `/api/notif-worker-config`.
**Causa**: el server corre una versión de `pjn-models` sin `NotifWorkerConfig` (agregado en 1.16.0). Pasaba en el hub cuando el lock estaba flotante y desincronizado (hub 1.14.0 vs worker_01 1.19.1).
**Patrón de detección**: `grep -i "reading 'getOrCreate'"` en los logs; o comparar `require('pjn-models/package.json').version` entre ambos servers.
**Acción**: alinear `pjn-models` (ya pineado a tag, §2.5). Verificar `node -e "console.log(typeof require('pjn-models').NotifWorkerConfig)"` → `function`. Redesplegar ambos.

## 5. Endpoints con comportamiento especial
<!-- Endpoints que requieren consideraciones especiales (rate limit, timeouts largos, side-effects) -->
<!-- APPEND HERE -->

### Búsqueda de sentencias (`/api/sentencias/ask`, `/buscar`, `/buscar/similar`, `/:id/chunks`)
<!-- detectado: 2026-07-17 | dominio: sentencias -->
- **Corpus SIEMPRE en Atlas + Qdrant**, aunque la instancia corra en local. El vector store es Qdrant (`VECTOR_BACKEND=qdrant`, `QDRANT_URL` = `http://100.111.73.56:6333`, colección `sentencias`, ~1.58M puntos); el enrichment lee `sentencias-capturadas` de **Atlas** (240k+ docs). La Mongo local casi no tiene sentencias.
  - Por eso `sentenciasSearchService.js` usa `getSentenciasDb()` — una conexión **dedicada a Atlas** (`URLDB`), NO la conexión mongoose por defecto. En worker_01 (NODE_ENV=local) la default apunta a `URLDB_LOCAL` y el enrichment fallaría (0 resultados) sin esa conexión dedicada.
  - El hub alcanza el Qdrant de worker_01 por Tailscale (verificado, ~74ms). Si worker_01 (o su Qdrant) está caído, la búsqueda de sentencias del hub también falla.
- **Load-order del backend vectorial**: `useQdrant()` y `qdrantConfig()` se evalúan en runtime (no al cargar el módulo) porque `dotenv.config()` corre después de requerir las rutas. Si se "optimiza" a `const USE_QDRANT = ...` top-level, vuelve a caer a Pinecone (key rechazada) → 500. No tocar.
- **Query planner** (`/ask`): gated por `configuracion-semantic-worker.searchQueryPlanner.enabled` (en **Atlas**). Con `enabled=true`, interpreta el prompt con LLM y deriva filtros (juzgado/sala/fecha). Toggle en la UI admin: vista *Recursos → Jurisprudencia → PJN /ask* (toggle rápido) y *Workers → Sentencias* (config canónica). Cache del flag: 30s.
- La vista admin `/recursos/jurisprudencia/pjn-ask` consume `/ask` vía `VITE_WORKERS_URL` (ngrok → worker_01). La vista vieja `/recursos/jurisprudencia/pjn` usa `pjn-rag-api` (`/rag/sentencias/buscar`, sin filtro por juzgado).

## 6. Queries útiles
<!-- Snippets SSH / pm2 / mongo -->
<!-- APPEND HERE -->

### Top endpoints en out.log (frecuencia de requests)
```bash
$SSH_CMD "tail -n 500 <out-log> | grep -oE '/api/[a-z-]+' | sort | uniq -c | sort -rn | head -10"
```

### Errores 5xx por dominio
```bash
$SSH_CMD "tail -n 1000 <out-log> | grep -E ' (5[0-9]{2}) ' | grep -oE '/api/[a-z-]+|HTTP [0-9]+' | sort | uniq -c | sort -rn"
```

### Tail con filtro por dominio (ej. causas)
```bash
$SSH_CMD "tail -n 200 <out-log> | grep '/api/causas'"
```

### Memoria del proceso a lo largo del tiempo
```bash
$SSH_CMD "$PM2_BIN describe pjn/api | grep -E 'used heap|heap size|memory'"
```

### ¿Están sincronizados hub y worker_01? (commit + versión de pjn-models)
```bash
echo "HUB:"; ssh -i /home/mcerra/www/lawanalytics.app.pem ubuntu@15.229.93.121 \
  'cd /var/www/pjn-api; git rev-parse --short HEAD; node -e "console.log(require(\"./node_modules/pjn-models/package.json\").version)"'
echo "WORKER_01:"; sshpass -p "$SSH_PASSWORD" ssh worker_01@100.111.73.56 \
  'cd /var/www/pjn-api; git rev-parse --short HEAD; node -e "console.log(require(\"./node_modules/pjn-models/package.json\").version)"'
# Deben coincidir. Si no → correr scripts/deploy-worker01.sh (worker_01 quedó atrás).
```

## 7. Métricas baseline
<!-- Valores esperables en operación normal -->
<!-- APPEND HERE -->

### Baseline 2026-07-28 (post-fix watch)
- **Hub**: online, ~127 MB RAM (límite 1 GB), CPU ~0.3%, restarts acumulados = **325** (al 2026-07-28 21:31 UTC; contador NO se resetea con reload; +1 esperado por cada deploy del CI). `unstable_restarts` = 0.
- **worker_01**: online, restarts acumulados = **35**.
- Health `https://api.lawanalytics.app/api/causas/test` → 200 en ~0.25s (público) / ~2ms (localhost:8083 desde el hub).
- Ruido normal en logs: WARNs `jwt expired` (tokens vencidos de clientes, cada ~30 min), 404 de scanners (`/server.key`, `/.env`, etc.), warnings de Mongoose por schema paths reservados al arrancar.
- Días sin push a main = 0 arranques del proceso; días con pushes = 1 arranque por deploy.

## 8. Patrones de incidente
<!-- Síntoma → diagnóstico -->
<!-- APPEND HERE -->

### Restarts altos en el hub + crash-loop `MODULE_NOT_FOUND` durante deploys
<!-- detectado: 2026-07-28 | dominio: infra/deploy -->
**Síntoma**: `pm2 jlist` muestra restarts acumulados altos (291 al 2026-07-28) en el hub; el error log llena de `Error: Cannot find module './route'` / `MODULE_NOT_FOUND` con requireStack dentro de `node_modules/express`. En el caso del 2026-07-28 hubo ~30 min sin servir (19:15→19:49 UTC) tras un deploy, con el CI reportando success igual (su health check solo greppea `pjn/api.*online` en `pm2 status`, que puede dar online entre intentos de crash).
**Causa**: `ecosystem.config.js` tiene `watch: ["src"]` y el CI hace `git reset --hard` (toca src → watch restartea YA) seguido de `npm ci --production` (borra/reconstruye node_modules). El proceso re-arranca con express a medio instalar → crash-loop hasta que `npm ci` termina y el `pm2 reload` final lo levanta limpio. Los restarts acumulados correlacionan 1:1 con días de deploy (0 arranques en días sin push; 4-9 en días con pushes múltiples). `unstable_restarts` queda en 0 porque se resetea en cada reload.
**Patrón de detección**: `grep -c MODULE_NOT_FOUND /root/.pm2/logs/pjn-api-error-5.log` > 0; cruzar `grep "Server listening"` del out log con `gh run list --workflow=deploy.yml`.
**Acción**: en operación normal NO es crash del servicio — verificar que el último arranque coincida con un run de CI y que después haya tráfico normal. **RESUELTO 2026-07-28 en DOS pasos** (el primero solo no alcanzó):
1. `27f8e11` — `watch: false` en `ecosystem.config.js`. Necesario pero insuficiente: el crash-loop persistió porque `npm ci` in-place borra `node_modules` con la app viva, y cualquier require lazy bajo tráfico (`kareem` de mongoose, p.ej.) crashea el proceso → PM2 lo relanza contra un árbol a medio instalar.
2. `1bc465d` — `npm ci` en `.deps-staging/` + swap atómico de `node_modules` con `mv`, tanto en `.github/workflows/deploy.yml` como en `scripts/deploy-worker01.sh`.

Verificado post-fix: deploy = exactamente +1 restart, 0 `MODULE_NOT_FOUND` nuevos. Baseline hub: restarts=325 (2026-07-28 21:31 UTC). Si el patrón reaparece → chequear que watch siga OFF y que el workflow siga usando el staging dir.

### sshd del hub colgado (sin banner) con HTTP sirviendo normal
<!-- detectado: 2026-07-28 | dominio: infra -->
**Síntoma**: SSH al hub falla con "Connection timed out during banner exchange" (TCP conecta, sshd no responde) desde CUALQUIER origen, pero la API pública sigue 200 y el puerto 443 abierto. Duró ~30 min y se recuperó solo (saturación transitoria de sshd, probablemente MaxStartups por scanners — los logs muestran scanning constante).
**Patrón de detección**: desde worker_01: `timeout 5 bash -c 'exec 3<>/dev/tcp/15.229.93.121/22; head -c 60 <&3'` → vacío = sshd colgado global; con banner = problema local/ban de IP.
**Acción**: NO reiniciar nada — si HTTP sirve, el box está sano y solo está afectada la administración. Usar worker_01 (Tailscale) como punto de observación alternativo (`curl https://api.lawanalytics.app/...` desde ahí) y reintentar SSH cada 1 min hasta que vuelva.

## 9. Cosas que NO hacer

- **No restartear `pjn/api` sin razón clara**: cualquier worker / front conectado pierde su flow en curso. Si hay duda, primero capturar evidencia (logs, métricas) y después decidir.
- **No editar `src/` directamente en el server**: el watch está OFF, así que ni siquiera se refleja hasta un restart. Cambios van por git + deploy (§2.4).
- **No pushear a `main` sin desplegar también worker_01**: el hub se actualiza solo (CI), worker_01 NO. Correr `scripts/deploy-worker01.sh` tras cada push, o quedan en commits distintos (§2.4).
- **No usar `pm2 restart pjn/api --update-env` en worker_01**: el shell no-interactivo puede pisar `NODE_ENV=local` y hacer que la instancia local apunte a Atlas. El script de deploy usa `pm2 restart` a secas a propósito.
- **No mover a top-level los reads de env del backend vectorial** (`useQdrant()`/`qdrantConfig()` en `sentenciasSearchService`/`qdrantSentencias`): `dotenv.config()` corre después de requerir las rutas; leerlos al cargar el módulo los deja vacíos → cae a Pinecone (§5).
- **No dejar `pjn-models` sin pin**: `package.json` debe apuntar a un tag `#vX.Y.Z` (§2.5). Sin ref, cada `npm install` re-flota y desincroniza los servers.
- **No asumir que un 401 es bug del server**: la mayoría son tokens expirados de clientes; verificar el JWT del request en cuestión.
- **No usar el password SSH en argv loggeable**: usar `sshpass -f` o key-based auth cuando sea posible.

## 10. Cómo se actualiza este skill

`/monitor-pjn-api` al cierre puede:
- Agregar entradas en `## 4. Errores conocidos` (con grep pattern para auto-detectar).
- Agregar entradas en `## 5. Endpoints con comportamiento especial`.
- Agregar snippets en `## 6. Queries útiles`.
- Agregar baselines en `## 7. Métricas baseline`.
- Agregar patrones en `## 8. Patrones de incidente`.

Formato de entrada nueva (igual a [[monitor-pjn-workers-skill]]):
```markdown
### <título corto>
<!-- detectado: YYYY-MM-DD | dominio: <dominio> -->
**Síntoma**: <una línea>
**Patrón de detección**: `<grep o regex>`
**Acción**: <qué hacer>
```

## 11. Relacionados

- [[monitor-pjn-workers]] — los workers consumen `/api/configuracion/*` de este servicio
- [[monitor-pjn-liquidacion-worker]] — la instancia Local (worker_01) escribe a la misma DB Mongo local que este worker consume (`previsional-liquidacion-urls`)
- [[deploy]] — pjn-api **NO** usa el `/deploy` genérico: el hub va por CI (GitHub Actions) y worker_01 por `scripts/deploy-worker01.sh` (§2.4). El `.env.local` (formato viejo `SSH_HOST`/`SSH_PASSWORD`/`PM2_BIN`/`PM2_PROCESSES`, no `DEPLOY_*`) lo consume ese script, no el skill `/deploy`.
- `pjn-models` (repo) — define los schemas Mongoose que esta API expone (incluye `previsional-liquidacion-urls` para pjn-liquidacion-worker). Pineado a tag en `package.json` (§2.5).
- `pjn-rag-api` (repo) — servicio hermano que cruza datos con éste en flujos de sentencias
