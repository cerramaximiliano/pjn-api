Hace deploy de pjn-api en worker_01 y reinicia el proceso PM2.

## 1. Cargar credenciales

```bash
export $(grep -v '^#' /home/mcerra/www/pjn-api/.env.local | xargs)
```

## 2. Verificar conectividad

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "echo 'Conexión OK'"
```

Si falla, informá al usuario y abortá.

## 3. Mostrar estado actual del proceso

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "$PM2_BIN show 'pjn/api' | grep -E 'status|uptime|restarts|memory'"
```

## 4. Hacer git pull en el servidor

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "cd $SSH_PROJECT_DIR && git pull origin \$(git branch --show-current)"
```

Si dice "Already up to date", preguntale al usuario si igualmente quiere reiniciar. Si hubo cambios, continuá.

## 5. Verificar si cambió package.json

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "cd $SSH_PROJECT_DIR && git diff HEAD@{1} HEAD -- package.json"
```

Si hay diferencias:

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "cd $SSH_PROJECT_DIR && npm install --omit=dev"
```

## 6. Reiniciar el proceso PM2

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "$PM2_BIN restart 'pjn/api' && $PM2_BIN save"
```

## 7. Verificar que levantó correctamente

```bash
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST "sleep 3 && $PM2_BIN show 'pjn/api' | grep -E 'status|uptime|restarts'"
```

## 8. Resumen final

Informá: commit deployado (`git rev-parse --short HEAD`), rama, si se reinstalaron dependencias, y estado del proceso. Si hay errores sugerí `/logs`.
