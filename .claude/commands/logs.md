Muestra logs del proceso pjn/api.

> **⚠️ Arquitectura dual — UN proyecto, DOS implementaciones en producción:**
> - **Hub** (🔵 `15.229.93.121`): instancia "Atlas" — API pública, Mongo Atlas. Logs en `/root/.pm2/logs/pjn-api-{out,error}-5.log` (leer con sudo).
> - **worker_01** (🟢 `100.111.73.56`, Tailscale): instancia "Local" — caché PJN + workers del box. Logs del pm2 de usuario.
>
> Los logs son independientes por instancia: un error del front/API pública se busca en el **hub**; un error de workers de sentencias/escritos consultando el caché se busca en **worker_01**.

## 1. Preguntar al usuario qué quiere ver

Preguntale:
- ¿De qué instancia? (hub / worker_01 / ambas — si el contexto ya lo indica, no preguntes)
- ¿Cuántas líneas? (default: 50)
- ¿Solo errores o todo el log?

## 2a. Instancia LOCAL (worker_01)

```bash
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
# path del log:
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "$PM2_BIN show 'pjn/api' | grep -E 'error log path|out log path'"
# tail:
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "tail -<N> <log_path>"
```

## 2b. Instancia HUB (Atlas)

```bash
ssh -i /home/mcerra/www/lawanalytics.app.pem ubuntu@15.229.93.121 "sudo tail -n <N> /root/.pm2/logs/pjn-api-error-5.log"   # errores
ssh -i /home/mcerra/www/lawanalytics.app.pem ubuntu@15.229.93.121 "sudo tail -n <N> /root/.pm2/logs/pjn-api-out-5.log"     # todo
```

## 3. Analizar

Analizá el contenido. Si hay errores o excepciones, resaltáselos y explicá brevemente qué significan. Ruido normal (NO alarmar): WARNs `jwt expired` (tokens vencidos de clientes), 404 de scanners (`/server.key`, `/.env`, etc.), warnings de Mongoose por schema paths reservados al arrancar. Ver patrones conocidos en el skill `monitor-pjn-api`.

## 4. Preguntar si quiere ver más líneas, el otro tipo de log o la otra instancia
