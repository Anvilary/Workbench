#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$INFRA_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

CTRL_TOKEN="${CONTROLLER_AUTH_TOKEN:-}"

echo "=== MAW Neko Browser Runtime Status ==="
if ! docker ps --format '{{.Names}}' | grep -q '^maw-neko$'; then
  echo "Status: STOPPED (maw-neko container is not running)"
  exit 0
fi

echo "Container: RUNNING (maw-neko)"

if [ -n "$CTRL_TOKEN" ]; then
  HEALTH=$(curl -s -H "Authorization: Bearer $CTRL_TOKEN" http://127.0.0.1:9223/health 2>/dev/null || echo '{"status":"offline"}')
  echo "Tab Controller Health: $HEALTH"

  echo ""
  echo "=== Loaded Tabs ==="
  curl -s -H "Authorization: Bearer $CTRL_TOKEN" http://127.0.0.1:9223/tabs 2>/dev/null | python3 -m json.tool || echo "Could not list tabs"
else
  echo "Tab Controller: CONTROLLER_AUTH_TOKEN not set in environment or .env"
fi

echo ""
echo "=== Chromium Sandboxing Status ==="
docker exec maw-neko sh -c '
for p in $(pgrep -f "type=renderer" | head -n 3); do
    echo "Renderer PID $p Seccomp: $(grep -s Seccomp /proc/$p/status | tr "\n" " ") (Active)"
done
' 2>/dev/null || echo "No active renderers to inspect"

echo ""
echo "=== Chromium Process Memory Summary ==="
docker exec maw-neko ps -eo rss,vsz,comm,args 2>/dev/null | python3 -c '
import sys
total_rss = 0
count = 0
for line in sys.stdin:
    parts = line.strip().split(None, 3)
    if len(parts) >= 4 and ("chromium" in parts[2] or "chromium" in parts[3]):
        count += 1
        total_rss += int(parts[0])
print(f"Total Chromium processes: {count}")
print(f"Total Chromium RSS memory: {round(total_rss / 1024, 2)} MB")
' || echo "Could not calculate memory"
