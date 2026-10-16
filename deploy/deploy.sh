#!/usr/bin/env bash
# Runs ON THE SERVER after the new code was uploaded (the CI job calls it; you can also run it by hand).
# Installs dependencies, reloads the app with PM2, and checks that the API answers. Exits 1 when the check fails.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/backend}"
PORT="${PORT:-5000}"
cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "ERROR: $APP_DIR/.env is missing. Create it first (see DEPLOY.md)." >&2
  exit 1
fi

echo "==> Installing production dependencies"
npm ci --omit=dev --no-audit --no-fund

echo "==> Reloading the app"
pm2 startOrReload ecosystem.config.cjs --env production --update-env
pm2 save >/dev/null

echo "==> Waiting for the API"
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || true)"
  if [ "$code" = "200" ]; then
    echo "OK: the API answers (HTTP 200) on port ${PORT}."
    exit 0
  fi
  sleep 2
done

echo "ERROR: the API did not answer on /api/health. Last logs:" >&2
pm2 logs stitching-backend --lines 40 --nostream >&2 || true
exit 1
