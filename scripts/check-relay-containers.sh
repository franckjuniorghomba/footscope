#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
export RELAY_TOKEN=FICTIONAL-RELAY-TOKEN-ONLY-000000000000
export RELAY_DOMAIN=localhost
project="bis203-${RANDOM}-${RANDOM}"
compose=(docker compose --project-name "$project" -f deploy/relay/compose.yml -f "$work/local.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# Aucun port public et aucune autorité de certification externe pour ce test.
cat > "$work/local.yml" <<'YAML'
services:
  https:
    ports: !override
      - '127.0.0.1::443'
YAML
"${compose[@]}" build
"${compose[@]}" up -d --wait --wait-timeout 90
for service in relay https; do
  id=$("${compose[@]}" ps -q "$service")
  test "$(docker exec "$id" id -u)" != 0
  test "$(docker inspect --format '{{.State.Running}}' "$id")" = true
done
https_id=$("${compose[@]}" ps -q https)
docker cp "$https_id:/usr/bin/caddy" "$work/caddy"
chmod +x "$work/caddy"
CADDY_BIN="$work/caddy" node scripts/test-relay-security.mjs
address=$("${compose[@]}" port https 443)
# -k est réservé au certificat interne de localhost, jamais au VPS.
for attempt in {1..30}; do
  if curl --silent --fail --insecure "https://$address/health" > "$work/health"; then
    break
  fi
  sleep 1
done
node -e 'const fs = require("node:fs"); if (JSON.parse(fs.readFileSync(process.argv[1])).ready !== true) process.exit(1)' "$work/health"
printf '%s\n' 'PASS : images construites, deux utilisateurs non-root, Compose sain, /health HTTPS local.'
