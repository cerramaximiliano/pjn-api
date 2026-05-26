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

- Express.js + Mongoose + JWT.
- Entry: `src/server.js`.
- Routing principal: monta `app.use('/api', indexRoutes)`. Todos los routers cuelgan de `/api`.
- Watch activo sobre `src/` → cualquier edit triggea PM2 restart (impacta el `↺` count sin ser crash).
- Max memory restart: 1GB.

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

## 3. Endpoint de health

`/api/causas/test` (definido en `causasRoutes.js` como `router.get('/test', ...)`).

```bash
curl -sS -o /dev/null -w "HTTP %{http_code} en %{time_total}s\n" \
  "https://api.lawanalytics.com.ar/api/causas/test" --max-time 10
```

## 4. Errores conocidos
<!-- Cada entrada: descripción + patrón grep + dominio afectado + acción típica -->
<!-- APPEND HERE -->

_(Sin entradas todavía — primer monitoreo lo poblará.)_

## 5. Endpoints con comportamiento especial
<!-- Endpoints que requieren consideraciones especiales (rate limit, timeouts largos, side-effects) -->
<!-- APPEND HERE -->

_(Sin entradas todavía.)_

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

## 7. Métricas baseline
<!-- Valores esperables en operación normal -->
<!-- APPEND HERE -->

_(Sin baselines todavía. Capturables en primer monitoreo: req/min promedio, RAM estable de la API, latencia p95 de endpoints calientes.)_

## 8. Patrones de incidente
<!-- Síntoma → diagnóstico -->
<!-- APPEND HERE -->

_(Vacío — se llenará con incidentes reales.)_

## 9. Cosas que NO hacer

- **No restartear `pjn/api` sin razón clara**: cualquier worker / front conectado pierde su flow en curso. Si hay duda, primero capturar evidencia (logs, métricas) y después decidir.
- **No editar `src/` directamente en el server**: el watch de PM2 triggea restart automático. Cambios deben ir por git + `/deploy`.
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
- [[deploy]] — mismo `.env.local` reutilizado para SSH
- `pjn-models` (repo) — define los schemas Mongoose que esta API expone (incluye `previsional-liquidacion-urls` para pjn-liquidacion-worker)
- `pjn-rag-api` (repo) — servicio hermano que cruza datos con éste en flujos de sentencias
