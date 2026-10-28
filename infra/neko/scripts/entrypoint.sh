#!/bin/sh
set -e

# Ensure Chromium profile directory structure exists and is owned by neko
CHROMIUM_DIR="/home/neko/.config/chromium"
mkdir -p "$CHROMIUM_DIR/Default"
chown -R neko:neko "$CHROMIUM_DIR" 2>/dev/null || true

# Remove stale Singleton lock files left from previous container runs
rm -f "$CHROMIUM_DIR/SingletonLock" \
      "$CHROMIUM_DIR/SingletonCookie" \
      "$CHROMIUM_DIR/SingletonSocket"

# Seed Preferences with persistent cookie policy (cookies: 1 = Allow) if not present
PREFS_FILE="$CHROMIUM_DIR/Default/Preferences"
if [ ! -f "$PREFS_FILE" ]; then
    cat << 'EOF' > "$PREFS_FILE"
{
  "profile": {
    "default_content_setting_values": {
      "cookies": 1
    }
  }
}
EOF
    chown neko:neko "$PREFS_FILE" 2>/dev/null || true
else
    # Update cookies setting to 1 if it is currently session-only (4)
    python3 -c "
import json, os
path = '$PREFS_FILE'
try:
    with open(path, 'r') as f:
        data = json.load(f)
    prof = data.setdefault('profile', {})
    settings = prof.setdefault('default_content_setting_values', {})
    if settings.get('cookies') != 1:
        settings['cookies'] = 1
        with open(path, 'w') as f:
            json.dump(data, f)
except Exception:
    pass
" 2>/dev/null || true
fi

# Run the passed command (default: supervisord)
exec "$@"
