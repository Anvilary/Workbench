# MAW Lane A — Neko Browser Runtime Operations Guide

## 1. Prerequisites

- Linux Host with Docker Engine 24+ and Docker Compose v2+.
- Available local loopback ports:
  - `127.0.0.1:8085` (Neko WebRTC UI / API)
  - `127.0.0.1:9223` (Restricted Tab Controller)
  - `127.0.0.1:52000-52010/udp` (WebRTC media)

---

## 2. Configuration & Startup

### 2.1 Starting the Runtime
To launch the Neko browser runtime using the verified configuration:
```bash
cd /home/alteixeira20/Projects/My-Amazing-Workspace-neko/infra/neko
./scripts/start.sh
```
This executes `docker compose up -d` and polls `http://127.0.0.1:9223/health` until the Chromium browser and controller are verified healthy.

### 2.2 Checking Service Status
To inspect running containers, controller health, loaded tabs, and memory:
```bash
./scripts/status.sh
```

### 2.3 Stopping the Runtime
To gracefully stop the runtime while preserving the persistent profile volume:
```bash
./scripts/stop.sh
```

---

## 3. Manual ChatGPT Authentication Workflow

To authenticate a ChatGPT account for use in MAW:

1. Start the runtime:
   ```bash
   ./scripts/start.sh
   ```
2. Open the Neko interface in your local browser:
   `http://127.0.0.1:8085`
3. Log in to Neko using the credentials configured in `docker-compose.yml` (default `neko` / `neko`).
4. Click to gain control of the remote browser session.
5. In Chromium, navigate to `https://chatgpt.com`.
6. Complete standard login with your ChatGPT account credentials (including 2FA if enabled).
7. Once logged in, session cookies and IndexedDB records are saved directly into the persistent profile volume (`maw-neko-chromium-profile`).
8. The session is now persisted. You can restart the container (`./scripts/stop.sh && ./scripts/start.sh`), and the account will remain authenticated.

---

## 4. MAW Integration Interface

### 4.1 Tab Controller Commands (CLI)
Using `tab_client.py`:
```bash
# Check health
python3 controller/tab_client.py health

# List loaded tabs
python3 controller/tab_client.py list

# Open a new ChatGPT conversation
python3 controller/tab_client.py new https://chatgpt.com

# Switch/focus a tab
python3 controller/tab_client.py activate <TAB_ID>

# Close a tab
python3 controller/tab_client.py close <TAB_ID>
```

### 4.2 Tab Controller Commands (Node.js)
Using `tab_client.mjs`:
```bash
node controller/tab_client.mjs list
node controller/tab_client.mjs new https://chatgpt.com
node controller/tab_client.mjs activate <TAB_ID>
node controller/tab_client.mjs close <TAB_ID>
```

---

## 5. Automated Verification & Benchmarks

Run the background streaming test:
```bash
python3 scripts/test_background_generation.py
```

Run the memory benchmark suite (1, 5, 10 tabs):
```bash
python3 scripts/measure_memory.py
```

Run the controller unit tests:
```bash
python3 -m unittest controller/test_tab_controller.py
```

---

## 6. Troubleshooting & Recovery

### 6.1 SingletonLock Collisions
If a container crashes abruptly, Chromium's `SingletonLock` symlink may point to the dead container ID. The startup wrapper (`scripts/entrypoint.sh`) cleans this up automatically on start. If manual cleanup is required:
```bash
docker run --rm -v maw-neko-chromium-profile:/profile alpine rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
```

### 6.2 WebRTC Media Issues on Localhost
Neko is configured with `NEKO_WEBRTC_NAT1TO1=127.0.0.1` and `NEKO_WEBRTC_ICELITE=true` to ensure ICE candidate negotiation resolves locally without STUN/TURN or public IP discovery.
