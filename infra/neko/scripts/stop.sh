#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Stopping MAW Neko Browser Runtime ==="
docker compose -f "$INFRA_DIR/docker-compose.yml" down
echo "Services stopped successfully."
