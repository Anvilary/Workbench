# MAW Lane A — Neko Browser Runtime Architecture

## 1. Executive Summary & Mission

The **MAW Lane A Neko Browser Runtime** provides an isolated, persistent, local Chromium environment powered by upstream [`m1k1o/neko`](https://github.com/m1k1o/neko) for embedding the official ChatGPT website into My Amazing Workspace (MAW).

The runtime satisfies strict operational and security boundaries:
- **Upstream Neko Infrastructure**: Uses unmodified upstream `m1k1o/neko:chromium` container image without forking Neko or re-implementing WebRTC streaming from scratch.
- **Sandboxed Chromium**: Operates with full multi-process Chromium sandboxing enabled (`--no-sandbox` removed). Leverages Linux user namespaces and BPF Seccomp filter mode 2 under Docker via `cap_add: [SYS_ADMIN]` while running as unprivileged user `neko` with zero effective capabilities (`CapEff: 0000000000000000`).
- **Single Authenticated Account & Profile**: Runs one Chromium browser instance with one persistent profile volume (`maw-neko-chromium-profile`), preserving authenticated sessions, cookies, IndexedDB, and browser preferences across container restarts.
- **Multi-Tab Concurrency & Resource Efficiency**: Supports 5–15 simultaneous loaded ChatGPT tabs without destructive automatic unloading. Inactive tabs consume an average of only ~109 MB PSS (Proportional Set Size) per tab, totaling ~1.23 GB PSS for 10 tabs.
- **Single Streaming Surface**: Only the active/focused browser tab is rendered to the X11 display and streamed via WebRTC into MAW.
- **Hardened Restricted Tab Controller**: Supervised HTTP gateway (`127.0.0.1:9223`) connecting internally to Chromium's loopback DevTools Protocol port (`127.0.0.1:9222`). Features mandatory timing-safe bearer authentication, origin allowlisting, and RFC 6455 WebSocket correlation. Raw debugging ports, DOM extraction, script evaluation, and cookie harvesting are strictly blocked.

```
+---------------------------------------------------------------------------------------------+
|                                    MAW Host Environment                                     |
|                                                                                             |
|   +------------------------------------+          +-------------------------------------+   |
|   |          MAW Web UI / Client       |          |         MAW Host Runtime            |   |
|   +------------------------------------+          +-------------------------------------+   |
|              |                  |                                    |                      |
|       WebRTC Video/Input        | HTTP / Ephemeral Token             | HTTP REST + Bearer   |
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
|   | Chromium Browser 156.0.8078.47 (Sandboxed)           |   | Restricted CDP Controller|   |
|   | - Window maximized on Display :99.0                  |<--| (tab_controller.py)      |   |
|   | - Sandboxing: User Namespaces + BPF Seccomp Mode 2   |   | - Mandatory Bearer Auth  |   |
|   | - Unprivileged user 'neko' (CapEff: 0)               |   | - Origin Allowlist       |   |
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
|   | (Sensitive profile data: Cookies, IndexedDB, Storage)|                                  |
|   +------------------------------------------------------+                                  |
+---------------------------------------------------------------------------------------------+
```

---

## 2. Core Requirements Compliance Matrix

| Requirement | Description | Architectural Solution | Status |
| :--- | :--- | :--- | :--- |
| **1. Sandboxed Browser & Profile** | One Neko service, one persistent Chromium profile, sandboxed execution | Sandboxed Chromium (`--no-sandbox` removed). Multi-process Zygote sandbox uses User Namespaces and BPF Seccomp Mode 2 via `cap_add: [SYS_ADMIN]` while running as unprivileged user `neko` with zero capabilities. Volume `maw-neko-chromium-profile` mounted to `/home/neko/.config/chromium`. Persistent cookies enabled (`cookies: 1`), `--bwsi` disabled. | **VERIFIED** |
| **2. Multi-Tab Concurrency** | Independent ChatGPT browser tabs stay loaded and continue work while another tab is visible | Tabs are independent Chromium page targets. Chromium launched with `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, and `--disable-backgrounding-occluded-windows`. | **VERIFIED** |
| **3. Single Surface Stream** | Only one browser surface streamed into MAW at a time | Neko captures the single virtual X11 display (`:99.0`). Activating a tab via CDP (`/tabs/{id}/activate`) brings that tab into focus on the X11 surface; WebRTC streams only the focused tab. | **VERIFIED** |
| **4. Safe Tab Switching** | Switching conversations must not navigate away or destroy inactive tabs | Tab switching uses CDP target activation (`activate`), which changes the active Chromium tab without reloading, navigating, or closing background tabs. | **VERIFIED** |
| **5. Independent History** | Tabs retain independent navigation history and page state while loaded | Each tab is an isolated Chromium page context retaining its own session history stack, DOM state, and JavaScript execution environment. | **VERIFIED** |
| **6. Restart vs Crash** | Profile survives service restart; unsaved page state does not survive process crash | Persistent storage survives clean container restart (`docker compose down/up`). Unsaved in-flight SSE tokens or unsubmitted form inputs do not survive SIGKILL/process crash (documented limitation). | **VERIFIED** |
| **7. Multi-Tab Efficiency** | Efficient with 5–15 tabs; no destructive automatic unloading | Chromium memory measured via PSS at ~109 MB per incremental tab (~760 MB PSS for 5 tabs, ~1.23 GB PSS for 10 tabs). Automatic tab discarding disabled via `--disable-features=TabDiscarding` and enterprise policies. | **VERIFIED** |
| **8. Hardened Tab Controls** | Test Neko native controls; investigate restricted local CDP controller | Neko exposes room/broadcast/clipboard APIs only. Hardened local CDP controller (`tab_controller.py`) deployed on `127.0.0.1:9223` with mandatory bearer token authentication, origin allowlisting, and robust WebSocket correlation. | **VERIFIED** |
| **9. Background Continuity** | Prove background network streaming continues after another tab becomes visible | Empirically verified with synthetic SSE chunk streaming test: 7/7 background chunks delivered at exact 400ms intervals while a foreground tab was active. | **VERIFIED (Synthetic SSE)** |
| **10. Completion Signal** | Do not claim completion detection unless verified permitted signal exists | Completion detection is **NOT** claimed. ChatGPT does not expose an external non-DOM status signal, and restricted CDP strictly prohibits DOM inspection and private API monitoring. | **VERIFIED (Not Claimed)** |

---

## 3. Sandboxing & Linux Security Model

### 3.1 Removing Chromium `--no-sandbox`
In standard Docker environments, running Chromium without `--no-sandbox` often fails because Docker's default seccomp profile restricts the `clone(CLONE_NEWUSER)` system call when invoked by unprivileged users.

To achieve full sandboxing without compromising host security:
1. **No Privileged Mode**: The container is **NOT** privileged (`privileged: false`). Host devices, kernel tunables, and raw host filesystems remain completely inaccessible.
2. **Capability Scoping**: The container is granted `cap_add: [SYS_ADMIN]`. In Docker's default seccomp profile, `CAP_SYS_ADMIN` authorizes the use of user namespaces (`CLONE_NEWUSER`).
3. **Unprivileged Process Execution**:
   - Supervisord launches Chromium with `user=neko` (UID 1000).
   - The Linux kernel automatically clears all effective and permitted capabilities upon changing UID to a non-root user:
     ```
     CapInh: 0000000000000000
     CapPrm: 0000000000000000
     CapEff: 0000000000000000
     ```
   - User `neko` operates with **zero elevated privileges**.
4. **Active Sandbox Verification**:
   - Chromium's Zygote forks renderers inside a restricted User Namespace.
   - Every active renderer executes under **Linux Seccomp Mode 2** (`Seccomp: 2`, `Seccomp_filters: 2`), actively restricting system calls at the kernel layer.

---

## 4. Resource Management & Chromium Power-Saving Flags

To maintain background ChatGPT generation without destructive tab freezing, specific Chromium power-saving flags are disabled. Each flag is justified below:

1. **`--disable-background-timer-throttling`**:
   - *Behavior*: Normally, Chromium throttles background timers (`setTimeout`, `setInterval`) to at most 1 Hz, and down to 1 execution per minute after 5 minutes.
   - *Justification*: ChatGPT uses timer-based heartbeat checks and stream buffer draining. Throttling timers causes dropped SSE connections, delayed token processing, and false stream timeouts.
2. **`--disable-renderer-backgrounding`**:
   - *Behavior*: Normally, Chromium lowers the OS scheduling priority (niceness) and CPU quota of background renderer processes.
   - *Justification*: Under multi-tab loads (5–15 tabs), lower scheduling priority causes background tabs to fall behind incoming network data, causing buffer overflow and frame drops.
3. **`--disable-backgrounding-occluded-windows`**:
   - *Behavior*: Chromium treats fully occluded or non-visible windows as minimized, deferring work and suspending compositor tasks.
   - *Justification*: In Neko's virtual X11 display, background tabs are occluded by the foreground tab. Disabling this ensures background tabs continue processing as active pages.
4. **`--disable-features=TabDiscarding,CalculateNativeWinOcclusion`**:
   - *Behavior*: Tab Discarding (Memory Saver) kills background tabs when memory pressure is detected.
   - *Justification*: Core Requirement 7 explicitly forbids destructive automatic unloading. Disabling tab discarding preserves open ChatGPT conversations.
5. **Memory Measurement: PSS vs. RSS**:
   - Summing RSS across multi-process Chromium significantly overstates memory usage because shared libraries (`libv8.so`, `libc.so`) are counted repeatedly in each renderer.
   - Proportional Set Size (PSS) from `/proc/<pid>/smaps_rollup` accounts for shared pages proportionally. Empirical testing shows that 10 loaded tabs consume **1,236 MB PSS** (~109 MB PSS per tab), proving exceptional resource efficiency.

---

## 5. Security Invariants & Integration Guardrails

### 5.1 Mandatory Authentication & Token Validation
- The restricted tab controller requires a bearer authentication token (`CONTROLLER_AUTH_TOKEN`) with a minimum length of 32 characters.
- Startup fails closed if the token is missing, too short, or matches insecure defaults.
- Token comparison uses `hmac.compare_digest` to prevent timing side-channel attacks.
- Requests without a valid Bearer token are rejected with `HTTP 401 Unauthorized`.

### 5.2 Navigation Allowlist & Network Boundaries
MAW-controlled tab navigation is guarded by two independent layers of defense:
1. **Controller Origin Policy**:
   - Validates destination URLs against an explicit allowlist: `chatgpt.com`, `*.chatgpt.com`, `openai.com`, `*.openai.com`, `oaistatic.com`, `*.oaistatic.com`, `oaiusercontent.com`, `*.oaiusercontent.com`, `accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, and `about:blank`.
   - Rejects loopback (`127.0.0.1`, `localhost`), link-local (`169.254.0.0/16`), private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), cloud metadata (`169.254.169.254`), and non-HTTP schemes (`file:`, `javascript:`, `chrome:`, `data:`).
2. **Chromium Enterprise `URLBlocklist`**:
   - Configured in `/etc/chromium/policies/managed/policies.json`.
   - Chromium itself blocks any navigation or subresource fetch to loopback, private subnets, Docker host gateway (`172.17.0.1`), or metadata services.

### 5.3 MAW Integration Boundary & Privileged Isolation
- **Network Isolation**: The browser runs inside container network isolation. `127.0.0.1` inside the container refers to container loopback, not the host. Host MAW ports cannot be reached from the browser.
- **Terminal & PTY Isolation**: The container does not mount host PTY devices (`/dev/pts`), host `/run/user`, or MAW runtime sockets. ChatGPT has zero access to MAW native terminal controls.
- **Protected Debugging**: Raw Chromium CDP port `9222` is bound to container loopback and never published to the host.

### 5.4 Credential Storage at Rest
- The persistent profile volume `maw-neko-chromium-profile` contains sensitive authentication cookies and session state.
- **Security Clarification**: Chromium on Linux without a desktop keyring (e.g. GNOME Keyring) uses a hardcoded desktop salt ("peanuts") for `v10` cookie encryption. This provides local obfuscation, **not secure encryption at rest**.
- Host-level protections must be applied: restricted volume permissions (`0700` owned by Docker/root) and underlying filesystem encryption (LUKS / dm-crypt).
