#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$INFRA_DIR/.env"

echo "=== Starting MAW Neko Browser Runtime ==="

# Load environment configuration if present
if [ -f "$ENV_FILE" ]; then
  # Source .env securely without printing
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# Validate mandatory secrets exist and are non-empty (Fail Closed)
USER_PW="${NEKO_PASSWORD:-}"
ADMIN_PW="${NEKO_ADMIN_PASSWORD:-}"
CTRL_TOKEN="${CONTROLLER_AUTH_TOKEN:-}"

if [ -z "$USER_PW" ] || [ -z "$ADMIN_PW" ] || [ -z "$CTRL_TOKEN" ]; then
  echo "FATAL: Missing mandatory credentials." >&2
  echo "NEKO_PASSWORD, NEKO_ADMIN_PASSWORD, and CONTROLLER_AUTH_TOKEN must be configured in .env or the environment." >&2
  echo "See $INFRA_DIR/.env.example for requirements." >&2
  exit 1
fi

if [ "${#USER_PW}" -lt 16 ] || [ "${#ADMIN_PW}" -lt 16 ]; then
  echo "FATAL: NEKO_PASSWORD and NEKO_ADMIN_PASSWORD must each be at least 16 characters long." >&2
  exit 1
fi

if [ "${#CTRL_TOKEN}" -lt 32 ]; then
  echo "FATAL: CONTROLLER_AUTH_TOKEN must be at least 32 characters long." >&2
  exit 1
fi

# Reject known default strings
case "$USER_PW" in
  neko|admin|password|123456|12345678|changeme)
    echo "FATAL: Insecure default NEKO_PASSWORD detected." >&2
    exit 1
    ;;
esac

case "$ADMIN_PW" in
  admin|neko|password|123456|12345678|changeme)
    echo "FATAL: Insecure default NEKO_ADMIN_PASSWORD detected." >&2
    exit 1
    ;;
esac

docker compose -f "$INFRA_DIR/docker-compose.yml" up -d

echo "Waiting for services to become healthy..."
MAX_ATTEMPTS=30
ATTEMPT=0
READY=0
HEALTH_STATUS=""

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  HEALTH_STATUS=$(curl -s -H "Authorization: Bearer $CTRL_TOKEN" http://127.0.0.1:9223/health 2>/dev/null || true)
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
  echo "  - Authentication:             Mandatory Bearer Token Enforced"
  echo "  - Chromium Sandboxing:        Active (User Namespace + BPF Seccomp)"
else
  echo "Timeout waiting for Neko browser runtime readiness."
  docker compose -f "$INFRA_DIR/docker-compose.yml" logs --tail 30
  exit 1
fi
