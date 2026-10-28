#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Starting MAW Neko Browser Runtime ==="
docker compose -f "$INFRA_DIR/docker-compose.yml" up -d

echo "Waiting for services to become healthy..."
MAX_ATTEMPTS=30
ATTEMPT=0
READY=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  HEALTH_STATUS=$(curl -s http://127.0.0.1:9223/health 2>/dev/null || true)
  if echo "$HEALTH_STATUS" | grep -q '"status": "healthy"'; then
    READY=1
    break
  fi
  sleep 1
done

if [ $READY -eq 1 ]; then
  echo "MAW Neko browser runtime is READY!"
  echo "  - Neko WebRTC UI:             http://127.0.0.1:8085"
  echo "  - Restricted Tab Controller:  http://127.0.0.1:9223"
  echo "  - Health Status:              $HEALTH_STATUS"
else
  echo "Timeout waiting for Neko browser runtime readiness."
  docker compose -f "$INFRA_DIR/docker-compose.yml" logs --tail 30
  exit 1
fi
