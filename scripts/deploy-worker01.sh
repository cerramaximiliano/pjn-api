#!/usr/bin/env bash
#
# deploy-worker01.sh — Despliega pjn-api en la instancia LOCAL (worker_01).
#
# CONTEXTO (arquitectura dual de pjn-api):
#   - Instancia HUB (Atlas, EC2 público 15.229.93.121): se despliega SOLA por
#     GitHub Actions al pushear a `main` (.github/workflows/deploy.yml).
#   - Instancia LOCAL (worker_01, Mongo local, IP Tailscale 100.111.73.56): NO
#     tiene CI/CD porque está en red privada Tailscale, inalcanzable desde los
#     runners de GitHub. Hay que desplegarla a mano, desde una máquina que esté
#     en la Tailnet.
#
# ⇒ REGLA: después de CADA `git push origin main` de pjn-api, corré este script.
#   Si no, worker_01 queda atrasado respecto del hub (código divergente).
#
# Auth: password (sshpass) — worker_01 NO acepta la key del hub. pm2 es de
# usuario (~worker_01/.npm-global/bin/pm2), NO root. Todo esto sale de .env.local.
#
# Uso:  bash scripts/deploy-worker01.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "ABORT: falta .env.local (config de deploy de worker_01)"; exit 1; }
set -a; # shellcheck disable=SC1091
source .env.local; set +a

: "${SSH_HOST:?falta SSH_HOST en .env.local}"
: "${SSH_USER:?falta SSH_USER en .env.local}"
: "${SSH_PASSWORD:?falta SSH_PASSWORD en .env.local}"
: "${SSH_PROJECT_DIR:?falta SSH_PROJECT_DIR en .env.local}"
: "${PM2_BIN:?falta PM2_BIN en .env.local}"
: "${PM2_PROCESSES:?falta PM2_PROCESSES en .env.local}"

command -v sshpass >/dev/null || { echo "ABORT: sshpass no instalado en esta máquina"; exit 1; }

# Sanity: el commit local de main debería estar pusheado (worker_01 hace reset a origin/main)
LOCAL_SHA=$(git rev-parse --short main 2>/dev/null || echo "?")
echo "→ Deploy pjn-api LOCAL: ${SSH_USER}@${SSH_HOST}:${SSH_PROJECT_DIR}  (proc: ${PM2_PROCESSES}, local main @ ${LOCAL_SHA})"

sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
  SSH_PROJECT_DIR="$SSH_PROJECT_DIR" PM2_BIN="$PM2_BIN" PM2_PROCESSES="$PM2_PROCESSES" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$SSH_PROJECT_DIR"

BEFORE=$(git rev-parse --short HEAD)
git fetch origin -q
git reset --hard origin/main
AFTER=$(git rev-parse --short HEAD)
echo "commit: $BEFORE -> $AFTER"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "(sin cambios de código respecto de lo desplegado)"
fi

# npm ci SOLO si cambió el lock (deps deterministas gracias al pin de pjn-models).
if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  echo "package-lock.json cambió → npm ci --omit=dev"
  npm ci --omit=dev
else
  echo "package-lock.json sin cambios → skip npm ci"
fi

# worker_01: watch OFF ⇒ restart explícito. SIN --update-env: preserva NODE_ENV=local
# (la instancia local lee URLDB_LOCAL; con --update-env el shell no-interactivo
#  podría pisar NODE_ENV y hacerla apuntar a Atlas por error).
"$PM2_BIN" restart "$PM2_PROCESSES"
sleep 3
"$PM2_BIN" describe "$PM2_PROCESSES" | grep -E "status|restarts|uptime" | head -3
# Verificar que arrancó en ambiente local (no Atlas)
"$PM2_BIN" logs "$PM2_PROCESSES" --lines 20 --nostream 2>/dev/null | grep -iE "ambiente|listening" | tail -2 || true
REMOTE

echo "✓ Deploy worker_01 completado. Recordá: el hub ya se actualizó solo con el push."
