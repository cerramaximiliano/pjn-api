Muestra logs del proceso pjn/api en worker_01.

## 1. Cargar credenciales

```bash
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
```

## 2. Preguntar al usuario qué quiere ver

Preguntale:
- ¿Cuántas líneas? (default: 50)
- ¿Solo errores o todo el log?

Esperá su respuesta antes de continuar.

## 3. Obtener path del log

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "$PM2_BIN show 'pjn/api' | grep -E 'error log path|out log path'"
```

## 4. Mostrar el log

Si quiere solo errores, usá el error log path. Si quiere todo, usá el out log path:

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "tail -<N> <log_path>"
```

Analizá el contenido. Si hay errores o excepciones, resaltáselos y explicá brevemente qué significan.

## 5. Preguntar si quiere ver más líneas o el otro tipo de log
