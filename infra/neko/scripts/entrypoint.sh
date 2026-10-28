#!/bin/sh
set -e

# ==============================================================================
# Security & Credential Validation (Fail Closed)
# ==============================================================================
USER_PW="${NEKO_MEMBER_MULTIUSER_USER_PASSWORD:-}"
ADMIN_PW="${NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:-}"
CTRL_TOKEN="${CONTROLLER_AUTH_TOKEN:-}"

# Check presence
if [ -z "$USER_PW" ] || [ -z "$ADMIN_PW" ] || [ -z "$CTRL_TOKEN" ]; then
    echo "FATAL [entrypoint]: Missing mandatory credentials. NEKO_PASSWORD, NEKO_ADMIN_PASSWORD, and CONTROLLER_AUTH_TOKEN must all be set." >&2
    exit 1
fi

# Check against known weak/default strings
case "$USER_PW" in
    neko|admin|password|123456|12345678|changeme|default)
        echo "FATAL [entrypoint]: Insecure NEKO_PASSWORD detected. Default/weak passwords are prohibited." >&2
        exit 1
        ;;
esac

case "$ADMIN_PW" in
    admin|neko|password|123456|12345678|changeme|default)
        echo "FATAL [entrypoint]: Insecure NEKO_ADMIN_PASSWORD detected. Default/weak passwords are prohibited." >&2
        exit 1
        ;;
esac

case "$CTRL_TOKEN" in
    changeme|token|secret|test|admin|default)
        echo "FATAL [entrypoint]: Insecure CONTROLLER_AUTH_TOKEN detected. Default/weak tokens are prohibited." >&2
        exit 1
        ;;
esac

# Enforce minimum lengths
if [ "${#USER_PW}" -lt 16 ]; then
    echo "FATAL [entrypoint]: NEKO_PASSWORD must be at least 16 characters in length." >&2
    exit 1
fi

if [ "${#ADMIN_PW}" -lt 16 ]; then
    echo "FATAL [entrypoint]: NEKO_ADMIN_PASSWORD must be at least 16 characters in length." >&2
    exit 1
fi

if [ "${#CTRL_TOKEN}" -lt 32 ]; then
    echo "FATAL [entrypoint]: CONTROLLER_AUTH_TOKEN must be at least 32 characters in length (e.g. openssl rand -hex 24)." >&2
    exit 1
fi

# ==============================================================================
# Chromium Profile & Lock Management
# ==============================================================================
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
import json
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
