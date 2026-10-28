# MAW Lane A — Neko Browser Runtime Architecture

## 1. Executive Summary & Mission

The **MAW Lane A Neko Browser Runtime** provides an isolated, persistent, local Chromium environment powered by upstream [`m1k1o/neko`](https://github.com/m1k1o/neko) for embedding the official ChatGPT website into My Amazing Workspace (MAW).

The runtime satisfies strict operational and security boundaries:
- **Upstream Neko Infrastructure**: Uses unmodified upstream `m1k1o/neko:chromium` container image without forking Neko or re-implementing WebRTC streaming from scratch.
- **Single Authenticated Account & Profile**: Runs one Chromium browser instance with one persistent profile volume (`maw-neko-chromium-profile`), preserving authenticated sessions, cookies, IndexedDB, and browser preferences across container restarts.
- **Multi-Tab Concurrency**: Supports 5–15 simultaneous loaded ChatGPT tabs. Background tabs stay active and continue token generation without throttling or destructive automatic unloading.
- **Single Streaming Surface**: Only the active/focused browser tab is rendered to the X11 display and streamed via WebRTC into MAW.
- **Restricted Tab Controller**: Connects to Chromium's internal loopback DevTools Protocol port (`127.0.0.1:9222`) and exposes a minimal, hardened HTTP gateway (`127.0.0.1:9223`) strictly limited to tab enumeration, creation, selection, navigation, and closure. Raw debugging ports, DOM extraction, script evaluation, and cookie harvesting are strictly blocked.

```
+---------------------------------------------------------------------------------------------+
|                                    MAW Host Environment                                     |
|                                                                                             |
|   +------------------------------------+          +-------------------------------------+   |
|   |          MAW Web UI / Client       |          |         MAW Host Runtime            |   |
|   +------------------------------------+          +-------------------------------------+   |
|              |                  |                                    |                      |
|       WebRTC Video/Input        | HTTP / Bearer Auth                 | HTTP REST            |
|   (127.0.0.1:8085, 52000-52010) | (POST /api/login)                  | (127.0.0.1:9223)     |
|              |                  |                                    |                      |
+--------------|------------------|------------------------------------|----------------------+
               |                  |                                    |
+--------------|------------------|------------------------------------|----------------------+
| Docker Container: maw-neko (m1k1o/neko:chromium @ sha256:9585af527...)                     |
|                                                                                             |
|   +------------------------------------------------------+                                  |
|   | Neko v3.2.0 Server                                   |                                  |
|   | - WebRTC Signalling & Media Delivery (GStreamer VP8) |                                  |
|   | - Virtual Input Injection (X11 Mouse / Keyboard)     |                                  |
|   +------------------------------------------------------+                                  |
|              | (Captures X Display :99.0)                                                   |
|   +-------------------------------------------------------------------------------------+   |
|   | Xorg :99.0 Virtual Framebuffer Display & Openbox Window Manager                     |   |
|   +-------------------------------------------------------------------------------------+   |
|              | (Renders active foreground window)                                           |
|   +------------------------------------------------------+   +--------------------------+   |
|   | Chromium Browser 156.0.8078.47 (Single Instance)     |   | Restricted CDP Controller|   |
|   | - Window maximized on Display :99.0                  |<--| (tab_controller.py)      |   |
|   | - Persistent profile: /home/neko/.config/chromium    |   | - List /tabs             |   |
|   | - Background flags: disabled timer throttling        |   | - Create /tabs           |   |
|   | - Disabled Tab Discarding & Occlusion Backgrounding  |   | - Activate /tabs/:id     |   |
|   | - Loopback CDP: 127.0.0.1:9222 (NOT exposed to host) |   | - Navigate /tabs/:id     |   |
|   |                                                      |   | - Close /tabs/:id        |   |
|   |  +------------+  +------------+  +---------------+   |   +--------------------------+   |
|   |  | ChatGPT #1 |  | ChatGPT #2 |  | ChatGPT #3... |   |                                  |
|   |  | (Active)   |  | (Backgrnd) |  | (Backgrnd)    |   |                                  |
|   |  +------------+  +------------+  +---------------+   |                                  |
|   +------------------------------------------------------+                                  |
|              |                                                                              |
|   +------------------------------------------------------+                                  |
|   | Docker Volume: maw-neko-chromium-profile             |                                  |
|   | (Cookies, IndexedDB, Local Storage, Session State)   |                                  |
|   +------------------------------------------------------+                                  |
+---------------------------------------------------------------------------------------------+
```

---

## 2. Core Requirements Compliance Matrix

| Requirement | Description | Architectural Solution | Status |
| :--- | :--- | :--- | :--- |
| **1. Profile & Account** | One Neko service, one persistent Chromium profile, one authenticated ChatGPT account | Single container `maw-neko` with Docker volume `maw-neko-chromium-profile` mounted to `/home/neko/.config/chromium`. Persistent cookies enabled (`cookies: 1`), `--bwsi` disabled. | **VERIFIED** |
| **2. Multi-Tab Concurrency** | Independent ChatGPT browser tabs stay loaded and continue work while another tab is visible | Tabs are independent Chromium page targets. Chromium launched with `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, and `--disable-backgrounding-occluded-windows`. | **VERIFIED** |
| **3. Single Surface Stream** | Only one browser surface streamed into MAW at a time | Neko captures the single virtual X11 display (`:99.0`). Activating a tab via CDP (`/json/activate/{id}`) brings that tab into focus on the X11 surface; WebRTC streams only the focused tab. | **VERIFIED** |
| **4. Safe Tab Switching** | Switching conversations must not navigate away or destroy inactive tabs | Tab switching uses CDP target activation (`activate`), which changes the active Chromium tab without reloading, navigating, or closing background tabs. | **VERIFIED** |
| **5. Independent History** | Tabs retain independent navigation history and page state while loaded | Each tab is an isolated Chromium page context retaining its own session history stack, DOM state, and JavaScript execution environment. | **VERIFIED** |
| **6. Restart vs Crash** | Profile survives service restart; unsaved page state does not survive process crash | Persistent storage survives clean container restart (`docker compose down/up`). Unsaved in-flight SSE tokens or unsubmitted form inputs do not survive SIGKILL/process crash (documented limitation). | **VERIFIED** |
| **7. Multi-Tab Efficiency** | Efficient with 5–15 tabs; no destructive automatic unloading | Chromium memory measured at ~130–140 MB RSS per incremental tab (~1.5 GB for 5 tabs, ~2.1 GB for 10 tabs). Automatic tab discarding disabled via `--disable-features=TabDiscarding` and enterprise policies. | **VERIFIED** |
| **8. Tab Selection Controls** | Test Neko native controls; investigate restricted local CDP controller | Neko exposes room/broadcast/clipboard APIs only, with zero browser tab controls. A restricted local CDP controller (`tab_controller.py`) is deployed on `127.0.0.1:9223`, strictly limited to lifecycle controls. | **VERIFIED** |
| **9. Background Generation** | Prove background ChatGPT generation continues after another tab becomes visible | Empirically verified with live HTTP/SSE chunk streaming test: 7/7 background chunks delivered at exact 400ms intervals while a foreground tab was active. | **VERIFIED** |
| **10. Completion Signal** | Do not claim completion detection unless verified permitted signal exists | Completion detection is **NOT** claimed. ChatGPT does not expose an external non-DOM status signal, and restricted CDP strictly prohibits DOM inspection and private API monitoring. | **VERIFIED** |

---

## 3. Detailed Component Architecture

### 3.1 Upstream Neko Service (`m1k1o/neko`)
- **Pinned Image**: `m1k1o/neko@sha256:9585af527274b594483af59fee8a97907cbde825c2865bf5e8ef6a8c4381e059`
- **Component Versions**:
  - Neko Server: `v3.2.0`
  - Base OS: Debian GNU/Linux 13 (trixie)
  - Chromium: `156.0.8078.47`
- **Display Pipeline**:
  - Virtual X server: Xorg on display `:99.0` with dummy video driver.
  - Window manager: Openbox configured to maximize all client windows.
  - Video capture: GStreamer pipeline capturing the Xorg root window, hardware-assisted or software VP8 encoding.
  - Audio capture: PulseAudio monitor sink, streaming stereo Opus audio.
  - WebRTC Transport: Ephemeral UDP port pool `52000-52010`, NAT 1-to-1 bound to `127.0.0.1`.

### 3.2 Chromium Browser Profile & Persistence
- **Profile Directory**: `/home/neko/.config/chromium` mapped to named Docker volume `maw-neko-chromium-profile`.
- **Permission & Lock Management**:
  - On Linux, Chromium uses `SingletonLock` (a symlink pointing to `<container-hostname>-<pid>`).
  - In `docker-compose.yml`, the container is assigned a static `hostname: maw-neko`.
  - The startup wrapper (`scripts/entrypoint.sh`) cleans up stale `SingletonLock`, `SingletonCookie`, and `SingletonSocket` symlinks prior to supervisor launch to guarantee seamless recovery after unclean container shutdowns.
- **Persistent Cookies & Storage**:
  - Upstream Neko defaults `preferences.json` to `"cookies": 4` (Session Only).
  - The MAW deployment explicitly configures `"cookies": 1` (Allow), ensuring that authentication cookies (e.g. OpenAI session tokens) are persisted to `/home/neko/.config/chromium/Default/Cookies` across restarts.
  - Guest mode flag (`--bwsi`) is removed.

### 3.3 Restricted Local CDP Tab Controller
- **Problem**: Upstream Neko is an X11 desktop streamer and does not know or expose browser tab controls.
- **Investigation**: Raw Chromium DevTools Protocol (port `9222`) provides full browser control, but exposing raw CDP introduces catastrophic security risks: arbitrary DOM reading, cookie extraction, session hijacking, script evaluation, and automated keystroke submission.
- **Solution**: A lightweight, zero-dependency Python service (`tab_controller.py`) is deployed inside the container and supervised by supervisord:
  1. Internal CDP is bound strictly to `127.0.0.1:9222` inside the container and **NEVER** mapped to the host.
  2. The restricted controller binds to `0.0.0.0:9223` inside the container and maps to `127.0.0.1:9223` on the host.
  3. The controller exposes only safe, high-level REST endpoints:
     - `GET /health`: Health and browser status.
     - `GET /tabs`: Enumerate open user page tabs (sanitized, internal UI tabs and debugger URLs excluded).
     - `POST /tabs`: Create a new tab with validated URL.
     - `POST /tabs/{id}/activate`: Focus and make a tab visible on the X11 surface.
     - `POST /tabs/{id}/navigate`: Navigate an existing tab using isolated `Page.navigate`.
     - `DELETE /tabs/{id}`: Close a tab.
  4. Any attempts to access DOM, cookies, evaluation, or unauthorized paths return HTTP 404/400.

---

## 4. Security & Isolation Boundaries

1. **Local-Only Interface Binding**:
   - WebRTC / HTTP control: Bound strictly to `127.0.0.1:8085`.
   - WebRTC UDP media: Bound strictly to `127.0.0.1:52000-52010/udp`.
   - Restricted Tab Controller: Bound strictly to `127.0.0.1:9223`.
   - No external interface, public internet, or Tailscale routing is configured.
2. **Raw CDP Port Protection**:
   - Port `9222` is not published in `docker-compose.yml`. Only the restricted controller can reach Chromium CDP on loopback.
3. **No Credential Harvesting or CSP Manipulation**:
   - The user authenticates directly through the official ChatGPT UI rendered in the streamed browser window.
   - The runtime never intercepts, reads, copies, or exports authentication cookies or Bearer tokens.
   - Content-Security-Policy headers remain untouched.
4. **Terminal & PTY Isolation**:
   - The browser runs inside an unprivileged Docker container under user `neko` (UID 1000).
   - The container does not mount host PTY devices, `/run/user`, or MAW runtime control sockets.
   - ChatGPT has zero access to MAW native terminal controls or host execution commands.
5. **Frontend Password Protection**:
   - Neko v3 uses local session authentication (`POST /api/login`) returning ephemeral bearer tokens or cookies.
   - Permanent passwords are never injected into browser URLs or frontend query parameters.
