Muestra el estado completo de pjn-api.

> **⚠️ Arquitectura dual — UN proyecto, DOS implementaciones en producción:**
> - **Hub** (🔵 `15.229.93.121`): instancia "Atlas" — la API pública (`api.lawanalytics.app`), contra Mongo Atlas. Acceso: key `/home/mcerra/www/lawanalytics.app.pem`, user `ubuntu`, pm2 root (`/usr/bin/pm2` con sudo).
> - **worker_01** (🟢 `100.111.73.56`, Tailscale): instancia "Local" — el caché PJN en Mongo local, consumida por los workers del box (sentencias, escritos, liquidaciones, etc.). Acceso: sshpass con credenciales de `.env.local`, pm2 de usuario (`~worker_01/.npm-global/bin/pm2`).
>
> Mismo repo, mismo proceso PM2 `pjn/api`, mismo puerto 8083 — pero DBs, consumidores y mecanismos de deploy distintos. Salvo que el usuario pida una sola, mostrá el estado de **ambas** instancias.

## 1. Cargar credenciales (worker_01)

```bash
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
```

## 2. Instancia LOCAL (worker_01) — una sola conexión

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "
echo '=== SERVIDOR (worker_01 — caché PJN local) ==='
echo \"Host: \$(hostname) | IP: $SSH_HOST | Usuario: $SSH_USER\"
echo \"Uptime:\$(uptime -p) | Fecha: \$(date '+%Y-%m-%d %H:%M:%S')\"
echo ''
echo '=== RECURSOS ==='
free -h | awk 'NR==2{printf \"RAM: %s usada / %s total (libre: %s)\n\", \$3, \$2, \$4}'
df -h $SSH_PROJECT_DIR | awk 'NR==2{printf \"Disco: %s usados / %s total (%s usado)\n\", \$3, \$2, \$5}'
echo \"CPU: \$(top -bn1 | grep 'Cpu(s)' | awk '{print \$2}')% en uso\"
echo ''
echo '=== PROCESO PM2 ==='
$PM2_BIN list | grep -E 'pjn/api'
echo ''
echo '=== COMMIT ACTUAL ==='
cd $SSH_PROJECT_DIR && echo \"Rama: \$(git branch --show-current) | Commit: \$(git rev-parse --short HEAD) | \$(git log -1 --format='%s')\"
"
```

## 3. Instancia HUB (Atlas, API pública) — una sola conexión

```bash
ssh -i /home/mcerra/www/lawanalytics.app.pem -o ConnectTimeout=10 ubuntu@15.229.93.121 "
echo '=== SERVIDOR (hub — API pública / Atlas) ==='
echo \"Host: \$(hostname) | Fecha: \$(date '+%Y-%m-%d %H:%M:%S')\"
echo ''
echo '=== PROCESO PM2 ==='
sudo /usr/bin/pm2 list | grep -E 'pjn/api'
echo ''
echo '=== COMMIT ACTUAL ==='
cd /var/www/pjn-api && echo \"Commit: \$(git rev-parse --short HEAD) | \$(git log -1 --format='%s')\"
echo ''
echo '=== HEALTH ==='
curl -s -o /dev/null -w 'localhost:8083/api/causas/test -> HTTP %{http_code} en %{time_total}s\n' http://localhost:8083/api/causas/test --max-time 10
"
```

## 4. Presentar la información al usuario

Mostrá los datos de ambas instancias, destacando:
- Si alguna instancia está en `errored` o `stopped`
- **Si los commits de hub y worker_01 difieren** → worker_01 quedó atrás; sugerir `bash scripts/deploy-worker01.sh`
- Los restarts acumulados NO son crashes: suben +1 por cada deploy (baseline al 2026-07-28: hub=325, worker_01=35). Solo alarma si suben sin deploys de por medio.
- Si la RAM o el disco superan el 85% de uso, advertí al usuario
