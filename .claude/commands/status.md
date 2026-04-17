Muestra el estado completo de pjn-api en worker_01.

## 1. Cargar credenciales

```bash
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
```

## 2. Obtener toda la información en una sola conexión

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "
echo '=== SERVIDOR ==='
echo \"Host: \$(hostname) | IP: $SSH_HOST | Usuario: $SSH_USER\"
echo \"Uptime:\$(uptime -p) | Fecha: \$(date '+%Y-%m-%d %H:%M:%S')\"
echo ''
echo '=== RECURSOS ==='
free -h | awk 'NR==2{printf \"RAM: %s usada / %s total (libre: %s)\n\", \$3, \$2, \$4}'
df -h $SSH_PROJECT_DIR | awk 'NR==2{printf \"Disco: %s usados / %s total (%s usado)\n\", \$3, \$2, \$5}'
echo \"CPU: \$(top -bn1 | grep 'Cpu(s)' | awk '{print \$2}')% en uso\"
echo ''
echo '=== PROCESOS PM2 ==='
$PM2_BIN list | grep -E 'pjn/api'
echo ''
echo '=== COMMIT ACTUAL ==='
cd $SSH_PROJECT_DIR && echo \"Rama: \$(git branch --show-current) | Commit: \$(git rev-parse --short HEAD) | \$(git log -1 --format='%s')\"
"
```

## 3. Presentar la información al usuario

Mostrá los datos organizados destacando:
- En qué servidor está corriendo el proceso (host e IP)
- Si el proceso está en `errored` o `stopped`
- Si tiene muchos reinicios (↺ alto puede indicar crasheos)
- Si la RAM o el disco superan el 85% de uso, advertí al usuario
- El commit deployado actualmente vs el local para saber si hay cambios pendientes de deploy
