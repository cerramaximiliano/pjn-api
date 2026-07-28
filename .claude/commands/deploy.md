Deploy de pjn-api.

> **⚠️ Arquitectura dual — UN proyecto, DOS implementaciones en producción con deploys DISTINTOS y desacoplados:**
>
> | Instancia | Server | Rol | Deploy |
> |---|---|---|---|
> | **Hub** ("Atlas") | 🔵 `15.229.93.121` | API pública `api.lawanalytics.app`, Mongo Atlas | **Automático** — GitHub Actions al pushear a `main` (`.github/workflows/deploy.yml`) |
> | **worker_01** ("Local") | 🟢 `100.111.73.56` (Tailscale) | Caché PJN en Mongo local + workers del box (sentencias, escritos, liquidaciones) | **Manual** — `bash scripts/deploy-worker01.sh` (worker_01 es inalcanzable desde runners de GitHub) |
>
> **REGLA DE ORO: después de CADA `git push origin main`, correr `bash scripts/deploy-worker01.sh`.** El hub se actualiza solo; worker_01 no — si te olvidás, quedan en commits distintos.

## Flujo

### 1. Push (despliega el hub automáticamente)

```bash
git push origin main
# seguir el run:
gh run list --workflow=deploy.yml --limit 1
gh run watch <run-id> --exit-status
```

### 2. Desplegar worker_01

```bash
bash scripts/deploy-worker01.sh
```

El script hace: `git reset --hard origin/main`, `npm ci` **solo si cambió el lock** (en staging dir + swap atómico de `node_modules` — nunca in-place con la app viva), y `pm2 restart` **sin** `--update-env` (preserva `NODE_ENV=local`; con `--update-env` la instancia local podría terminar apuntando a Atlas).

### 3. Verificar que ambas quedaron en el mismo commit

```bash
echo "HUB:"; ssh -i /home/mcerra/www/lawanalytics.app.pem ubuntu@15.229.93.121 'git -C /var/www/pjn-api rev-parse --short HEAD'
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
echo "WORKER_01:"; sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST 'git -C /var/www/pjn-api rev-parse --short HEAD'
```

### 4. Health check

```bash
curl -sS -o /dev/null -w "HTTP %{http_code} en %{time_total}s\n" https://api.lawanalytics.app/api/causas/test --max-time 10
```

## Cosas que NO hacer

- **NO hacer `git pull` + `npm install` a mano en los servers** — usar los dos flujos de arriba. Un `npm ci`/`npm install` in-place con la app viva causa crash-loop `MODULE_NOT_FOUND` (por eso ambos flujos instalan en staging y swapean atómico).
- **NO refrescar `pjn-models` con `npm install pjn-models@github:...` suelto** — desde 2026-07-17 está **pineado a un tag** en `package.json` (`#vX.Y.Z`). Para bumpearlo: taggear en el repo pjn-models, cambiar el ref en `package.json`, `npm install`, commit + push + deploy de ambas instancias (ver skill `monitor-pjn-api` §2.5).
- **NO usar `pm2 restart --update-env` en worker_01** — pisa `NODE_ENV=local`.
- **NO reactivar `watch` en `ecosystem.config.js`** — causaba crash-loops en cada deploy del hub.
