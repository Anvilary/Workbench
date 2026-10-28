# MAW Lane A — Neko Browser Runtime Operations Guide

## 1. Prerequisites

- Linux Host with Docker Engine 24+ and Docker Compose v2+.
- Available local loopback ports:
  - `127.0.0.1:8085` (Neko WebRTC UI / HTTP API)
  - `127.0.0.1:9223` (Restricted Tab Controller HTTP API)
  - `127.0.0.1:52000-52010/udp` (WebRTC media transport)

---

## 2. Configuration & Startup

### 2.1 Mandatory Secrets Configuration

The runtime enforces **fail-closed security**. Startup immediately halts if required credentials and authentication tokens are missing or fail length/entropy checks. Default credentials have been removed.

1. Navigate to the Neko infrastructure directory:
   ```bash
   cd infra/neko
   ```
2. Copy the example configuration template:
   ```bash
   cp .env.example .env
   chmod 600 .env
   ```
3. Generate high-entropy secrets and populate `.env`:
   ```bash
   # Minimum requirements:
   # NEKO_PASSWORD: >= 16 characters (WebRTC viewer access)
   # NEKO_PASSWORD_ADMIN: >= 16 characters (Admin access)
   # CONTROLLER_AUTH_TOKEN: >= 32 characters (Tab controller API Bearer token)

   NEKO_PASSWORD=$(openssl rand -base64 24)
   NEKO_PASSWORD_ADMIN=$(openssl rand -base64 24)
   CONTROLLER_AUTH_TOKEN=$(openssl rand -hex 32)
   ```

> [!CAUTION]
> Never commit `.env` to git or paste credentials in command-line arguments that appear in process lists (`ps`). Keep `.env` permissions set to `0600`.

### 2.2 Starting the Runtime
To launch the runtime using the validated Docker Compose configuration:
```bash
./scripts/start.sh
```
This script:
1. Validates that `.env` exists and contains secrets meeting length thresholds (`NEKO_PASSWORD` >= 16 chars, `CONTROLLER_AUTH_TOKEN` >= 32 chars).
2. Executes `docker compose up -d`.
3. Polls `http://127.0.0.1:9223/health` with Bearer authentication until Chromium and the supervised tab controller report healthy.

### 2.3 Checking Service Status
To inspect running container state, health, loaded tab count, and memory:
```bash
./scripts/status.sh
```

### 2.4 Stopping the Runtime
To gracefully stop the runtime while preserving the persistent profile volume:
```bash
./scripts/stop.sh
```

---

## 3. Manual ChatGPT Authentication Workflow

The runtime uses one persistent Chromium profile and one normal authenticated ChatGPT account:

1. Start the runtime:
   ```bash
   ./scripts/start.sh
   ```
2. Open the Neko interface in your local host browser:
   `http://127.0.0.1:8085`
3. Enter username `neko` and the `NEKO_PASSWORD` configured in your `.env`.
4. Click to gain control of the remote browser session.
5. In Chromium, navigate to `https://chatgpt.com`.
6. Complete standard login with your ChatGPT account credentials (including multi-factor authentication if enabled).
7. Once logged in, session cookies, local storage, and IndexedDB state are saved into the persistent profile volume (`maw-neko-chromium-profile`).
8. The session is now persisted. Restarting the container (`./scripts/stop.sh && ./scripts/start.sh`) retains the authenticated state.

> [!WARNING]
> Chromium's `v10` cookie format on headless Linux provides local file obfuscation, **not secure encryption at rest** (the encryption key is derived using a fixed hardcoded string when no desktop Secret Service/Keyring daemon is present). The persistent Docker volume must be treated as sensitive plaintext-equivalent data and secured using host disk-level encryption (e.g., LUKS) and restrictive file permissions.

---

## 4. MAW Integration Interface

All programmatic interactions with the Chromium browser tabs must go through the restricted tab controller at `http://127.0.0.1:9223`. Direct CDP ports (`9222`) are strictly bound inside the container and not published.

All requests require the Bearer authentication token configured in `CONTROLLER_AUTH_TOKEN`.

### 4.1 CLI Usage (Python)

Set your token in the environment:
```bash
export CONTROLLER_AUTH_TOKEN="<YOUR_CONTROLLER_AUTH_TOKEN>"
```

```bash
# Health check
python3 controller/tab_client.py health

# List active tabs
python3 controller/tab_client.py list

# Open a new ChatGPT conversation tab
python3 controller/tab_client.py new https://chatgpt.com

# Switch/focus a tab (switches streamed visual surface)
python3 controller/tab_client.py activate <TAB_ID>

# Navigate an existing tab (restricted to approved origins)
python3 controller/tab_client.py navigate <TAB_ID> https://chatgpt.com/c/<conversation-id>

# Close a tab
python3 controller/tab_client.py close <TAB_ID>
```

Alternatively, pass the token explicitly via `--token`:
```bash
python3 controller/tab_client.py --token "<TOKEN>" list
```

### 4.2 CLI Usage (Node.js)

```bash
export CONTROLLER_AUTH_TOKEN="<YOUR_CONTROLLER_AUTH_TOKEN>"

node controller/tab_client.mjs list
node controller/tab_client.mjs new https://chatgpt.com
node controller/tab_client.mjs activate <TAB_ID>
node controller/tab_client.mjs navigate <TAB_ID> https://chatgpt.com/c/<conversation-id>
node controller/tab_client.mjs close <TAB_ID>
```

---

## 5. Automated Verification & Testing

The following automated test suites are provided in `infra/neko/scripts/` to verify security boundaries, resource efficiency, and controller functionality:

### 5.1 Security Boundary Suite
Verifies mandatory authentication, origin allowlisting, Chromium sandbox enforcement, and MAW host/PTY isolation:
```bash
python3 scripts/test_security_boundary.py
```

### 5.2 Controller Unit Tests
Runs unit tests for the restricted tab controller (URL validation, timing-safe auth, parameter sanitization):
```bash
python3 -m unittest controller/test_tab_controller.py
```

### 5.3 Memory Profiling (PSS & RSS)
Measures multi-process memory scaling across 1, 5, and 10 loaded tabs reading `/proc/<pid>/smaps_rollup`:
```bash
python3 scripts/measure_memory.py
```

### 5.4 Synthetic Streaming Continuity Test
Measures background network stream continuity across visual tab switches:
```bash
python3 scripts/test_background_generation.py
```

---

## 6. Security Hardening & Profile Storage Protection

1. **Docker Host Access**:
   The Docker socket (`/var/run/docker.sock`) must remain strictly accessible only to `root` and trusted administrative users.
2. **Profile Volume Protection**:
   The persistent volume `maw-neko-chromium-profile` stores session cookies and local cache. Ensure the host backing path (typically `/var/lib/docker/volumes/maw-neko-chromium-profile/_data`) resides on an encrypted filesystem (LUKS/dm-crypt) with standard `0700` directory permissions.
3. **Network Isolation**:
   Container ports `8085` and `9223` are bound exclusively to host loopback `127.0.0.1`. Never bind `0.0.0.0` or route traffic via Tailscale/VPNs without an intervening authenticated reverse proxy.
4. **Sandboxing Invariant**:
   Chromium runs with unprivileged user namespaces and BPF Seccomp Mode 2 enabled via `cap_add: [SYS_ADMIN]` in `docker-compose.yml`. Process `neko` drops all capabilities (`CapEff: 0000000000000000`). Never add `--no-sandbox` to `chromium.conf` or specify `privileged: true` in `docker-compose.yml`.

---

## 7. Troubleshooting & Recovery

### 7.1 SingletonLock Collisions
If the container or host crashes abruptly while Chromium is writing to disk, a stale `SingletonLock` symlink may prevent Chromium from starting on the next run.

The entrypoint wrapper (`scripts/entrypoint.sh`) automatically detects and cleans up stale `SingletonLock`, `SingletonCookie`, and `SingletonSocket` symlinks before launching the browser.

If manual cleanup of an orphaned volume is needed:
```bash
docker run --rm -v maw-neko-chromium-profile:/profile alpine rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
```

### 7.2 WebRTC Media Issues on Localhost
Neko is configured with `NEKO_WEBRTC_NAT1TO1=127.0.0.1` and `NEKO_WEBRTC_ICELITE=true` to ensure ICE candidate negotiation resolves locally without STUN/TURN servers or external network discovery. If WebRTC video fails to connect:
- Ensure UDP ports `52000-52010` on `127.0.0.1` are not blocked by a local host firewall (`ufw` or `iptables`).
- Verify the WebRTC UI is accessed via `http://127.0.0.1:8085` (matching the NAT 1-to-1 address).
