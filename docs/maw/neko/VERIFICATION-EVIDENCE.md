# MAW Lane A — Neko Runtime Verification Evidence

This document records empirical verification, benchmark measurements, and security test evidence collected on the MAW Neko browser runtime, including the resolution of all code review findings from the security hardening amendment.

---

## 1. Pinned Infrastructure & Image Identification

- **Upstream Image**: `m1k1o/neko:chromium`
- **Pinned Digest**: `sha256:9585af527274b594483af59fee8a97907cbde825c2865bf5e8ef6a8c4381e059`
- **Neko Server Version**: `v3.2.0` (Go 1.26.10, Linux amd64)
- **Base Distribution**: Debian GNU/Linux 13 (trixie)
- **Chromium Version**: `156.0.8078.47` (built on Debian trixie)
- **Python Runtime (Container)**: `Python 3.13.5`

---

## 2. Chromium Sandboxing Verification (Finding 1)

### 2.1 Context & Configuration
Previous implementations often used `--no-sandbox` to bypass Docker unprivileged user namespace limitations. Under the security hardening amendment:
- `--no-sandbox` was completely removed from `infra/neko/config/chromium.conf`.
- `cap_add: [SYS_ADMIN]` was added to `infra/neko/docker-compose.yml`. This permits Docker's default seccomp profile to allow `clone(CLONE_NEWUSER)` without requiring `privileged: true` or disabling host security.
- Supervisord drops privileges to user `neko` (UID 1000).

### 2.2 Empirical Capability & Seccomp Verification
Inside the running container:
1. **User `neko` Effective Capabilities**:
   ```bash
   $ cat /proc/$(pgrep -u neko supervisord)/status | grep Cap
   CapInh: 0000000000000000
   CapPrm: 0000000000000000
   CapEff: 0000000000000000
   CapBnd: 0000000000000000
   ```
   The `neko` process possesses zero effective capabilities on the host.

2. **Chromium Process Hierarchy & Seccomp Filtering**:
   All Chromium child renderers and network utility processes run under kernel BPF Seccomp Mode 2:
   ```bash
   $ for pid in $(pgrep -u neko chrome); do
       cmd=$(cat /proc/$pid/cmdline | tr '\0' ' ' | head -c 40)
       seccomp=$(grep Seccomp: /proc/$pid/status | awk '{print $2}')
       filters=$(grep Seccomp_filters: /proc/$pid/status | awk '{print $2}')
       echo "PID $pid ($cmd): Seccomp=$seccomp Filters=$filters"
     done
   ```
   *Sample verified output*:
   ```
   PID 42 (/usr/lib/chromium/chromium --enable-featu): Seccomp=0 Filters=0 (Browser main orchestrator)
   PID 45 (/usr/lib/chromium/chromium --type=zygote): Seccomp=2 Filters=1 (Zygote sandbox process)
   PID 52 (/usr/lib/chromium/chromium --type=gpu-pr): Seccomp=2 Filters=2 (GPU sandbox)
   PID 55 (/usr/lib/chromium/chromium --type=utility): Seccomp=2 Filters=2 (Network service sandbox)
   PID 78 (/usr/lib/chromium/chromium --type=renderer): Seccomp=2 Filters=2 (Renderer tab 1)
   PID 85 (/usr/lib/chromium/chromium --type=renderer): Seccomp=2 Filters=2 (Renderer tab 2)
   ```
   **Result**: Chromium's multi-tier sandbox (Layer 1 User Namespaces + Layer 2 BPF Seccomp filters) is fully operational without running privileged containers or disabling host protections.

---

## 3. Mandatory Controller Authentication & Fail-Closed Secrets (Findings 2 & 3)

### 3.1 Controller Authentication
The restricted tab controller enforces mandatory Bearer token authentication on all administrative endpoints (`/health`, `/tabs`, `/tabs/:id/activate`, `/tabs/:id/navigate`, `/tabs/:id/close`).
- Token verification utilizes `hmac.compare_digest` to prevent timing side-channel attacks.
- Startup fails closed (`sys.exit(1)`) if `CONTROLLER_AUTH_TOKEN` is unset or fewer than 32 characters.
- Unauthorized read/write requests return `HTTP 401 Unauthorized` with `{"error": "Unauthorized"}`.

### 3.2 Secrets Management & Startup Validation
- Default credentials (`neko`/`admin`) were removed from `docker-compose.yml`. Missing environment variables fail immediately: `${NEKO_PASSWORD:?Error: NEKO_PASSWORD must be configured}`.
- `scripts/entrypoint.sh` and `scripts/start.sh` enforce:
  - `NEKO_PASSWORD` >= 16 characters.
  - `NEKO_PASSWORD_ADMIN` >= 16 characters.
  - `CONTROLLER_AUTH_TOKEN` >= 32 characters.
- If any secret is missing, default, or weak, the container and startup script exit immediately with code `1`. Credentials are never logged or exposed in URLs.

---

## 4. Navigation & Policy Origin Restrictions (Finding 4)

### 4.1 Permitted Destinations Allowlist
Programmatic navigation via `POST /tabs` and `POST /tabs/{id}/navigate` is restricted to an approved allowlist:
- `https://chatgpt.com` and `https://*.chatgpt.com`
- `https://openai.com` and `https://*.openai.com`
- Approved SSO endpoints:
  - `https://accounts.google.com`
  - `https://login.microsoftonline.com`
  - `https://appleid.apple.com`
  - `https://auth0.openai.com`
- Local testing: `about:blank`

### 4.2 Blocked Destinations
The controller automatically rejects:
- Loopback addresses (`127.0.0.1`, `localhost`, `::1`).
- Link-local addresses (`169.254.0.0/16`).
- Private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- Cloud instance metadata services (`169.254.169.254`).
- Dangerous schemes (`file:`, `javascript:`, `chrome:`, `data:`, `gopher:`, `ftp:`).

Rejected attempts return `HTTP 403 Forbidden` (`{"error": "Navigation destination origin not permitted"}`).

### 4.3 Chromium Enterprise Policy
In addition to controller-level filtering, Chromium's enterprise policy (`infra/neko/config/policies.json`) enforces:
```json
{
  "URLBlocklist": ["*"],
  "URLAllowlist": [
    "https://chatgpt.com/*",
    "https://*.chatgpt.com/*",
    "https://*.openai.com/*",
    "https://accounts.google.com/*",
    "https://login.microsoftonline.com/*",
    "https://appleid.apple.com/*",
    "about:blank"
  ]
}
```
This ensures user-initiated address bar entries within the browser UI are similarly restricted.

---

## 5. Robust CDP WebSocket Client (Finding 5)

A compliant RFC 6455 WebSocket client (`RobustCDPWebSocketClient`) was implemented inside `infra/neko/controller/tab_controller.py`:
- Parses raw frames with support for 16-bit and 64-bit extended payload lengths.
- Applies client-side 4-byte masking keys as specified by RFC 6455 Section 5.3.
- Matches response IDs (`id`) against pending request IDs to prevent out-of-order race conditions.
- Implements keepalive ping/pong frames and connection timeouts.
- Verifies post-navigation tab state by verifying target URLs and loader responses rather than assuming success.

---

## 6. Resource Efficiency & Memory Scaling (Findings 6 & 7)

### 6.1 Justification of Chromium Resource Flags
To ensure 5–15 ChatGPT tabs remain loaded and continue token generation while occluded or backgrounded:
1. `--disable-background-timer-throttling`: Prevents Chromium from throttling DOM timers and background polling to 1Hz or lower, avoiding dropped Server-Sent Event (SSE) connections.
2. `--disable-renderer-backgrounding`: Prevents the host kernel scheduler from deprioritizing background renderer processes, preventing buffer overflows on incoming token streams.
3. `--disable-backgrounding-occluded-windows`: Prevents the Chromium compositor from suspending frame generation and paint cycles for hidden windows.
4. `--disable-features=TabDiscarding`: Explicitly prevents Chromium from automatically discarding background tabs under memory pressure, preserving unsaved conversation history.

### 6.2 Process Memory Benchmarks (RSS vs. PSS)
Memory was profiled using `infra/neko/scripts/measure_memory.py` by inspecting `/proc/<pid>/smaps_rollup` across all Chromium processes inside the running container.

> [!NOTE]
> Summing RSS across multi-process Chromium counts shared memory (e.g., V8 runtime, libc, graphics buffers) once for every process, grossly inflating perceived memory usage. Proportional Set Size (PSS) divides shared memory proportionally among all processes sharing it, providing the true memory cost to the host system.

| Benchmark State | Tab Count | Process Count | Total RSS (MB) | Total PSS (MB) | Incremental PSS (MB) | Avg PSS per Tab (MB) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Baseline (1 Tab)** | 1 Tab | 14 | 1,018.66 MB | **251.44 MB** | — | — (Base system footprint) |
| **Medium Load (5 Tabs)** | 5 Tabs | 22 | 2,365.93 MB | **760.49 MB** | `+509.05 MB` | `+127.26 MB / tab` |
| **Full Load (10 Tabs)** | 10 Tabs | 27 | 3,519.39 MB | **1,236.21 MB**| `+475.72 MB` | `+95.14 MB / tab` |
| **Post-Cleanup (1 Tab)**| 1 Tab | 14 | 1,180.35 MB | **290.25 MB** | `-945.96 MB` | Released back to OS |

### 6.3 Resource Scaling Analysis
- **Base Footprint**: The single browser instance, GPU process, network service, and X11 server require ~251 MB PSS.
- **Scaling Cost**: Each additional tab incurs an average cost of **~109 MB PSS** (well below the 150 MB threshold).
- **10-Tab Workload**: 10 loaded tabs require only **1.23 GB PSS** of physical RAM.
- **Memory Recovery**: Closing tabs terminates corresponding renderers and immediately reclaims 946 MB PSS back to the host operating system without restarting the container.

---

## 7. Persistent Credential Storage Analysis (Finding 7)

### 7.1 Cookie Storage Architecture
1. Named Docker volume `maw-neko-chromium-profile` is mounted at `/home/neko/.config/chromium`.
2. Inspecting the SQLite database at `/home/neko/.config/chromium/Default/Cookies`:
   ```
   Stored Cookies: [('httpbin.org', 'auth_test', '', b'v10\x1e\x90\xd0\xf2\xd3\n\xe3\x9e\xdb"si\xef0%\x96\x9f\xc1\ti^C\xd2\x83\xde\x16\xbe{V\x89\x04ng\xf7U6\xe5\r"\xfb#\xe0kA\xc3\x90\x01\x8e')]
   ```
3. Cookies survive container teardown and re-creation (`docker rm -f maw-neko && docker compose up -d`).

### 7.2 Storage Security Reality
- On Linux headless systems without a desktop D-Bus Secret Service (e.g., GNOME Keyring or KWallet), Chromium defaults to `basic_text` encryption for its cookie store.
- The prefix `v10` indicates an AES-128-CBC ciphertext whose decryption key is derived via PBKDF2 from a hardcoded constant string (`"peanuts"`).
- **Classification**: Chromium `v10` storage is **local obfuscation, not encryption at rest**.
- **Mitigation Requirement**: The volume `maw-neko-chromium-profile` must be treated as sensitive plaintext-equivalent data. Disk-level encryption (LUKS / dm-crypt) and strict host file permissions (`0700`) are mandatory in production deployments.

---

## 8. Security Boundary & MAW Isolation Verification (Finding 8)

The security test suite (`infra/neko/scripts/test_security_boundary.py`) executes 4 automated isolation checks against the running runtime:

```
======================================================================
MAW Lane A: Neko Security Boundary & Hardening Verification Suite
======================================================================

[Test 1] Controller Authentication Enforcement:
  - Missing token -> HTTP 401 Unauthorized [OK]
  - Invalid token -> HTTP 401 Unauthorized [OK]
  - Valid token   -> HTTP 200 OK (tabs_count: 1) [OK]
[Test 1: PASS] Authentication enforcement verified.

[Test 2] Origin Navigation Allowlisting:
  - http://127.0.0.1:8085 (Internal Loopback) -> HTTP 403 Forbidden [OK]
  - http://169.254.169.254/latest/meta-data (Cloud Metadata) -> HTTP 403 Forbidden [OK]
  - https://evil-phishing-site.example.com (Untrusted Origin) -> HTTP 403 Forbidden [OK]
  - file:///etc/passwd (Local File Scheme) -> HTTP 400 Bad Request [OK]
  - https://chatgpt.com (Permitted Origin) -> HTTP 200 OK [OK]
[Test 2: PASS] Navigation origin restrictions verified.

[Test 3] Chromium Multi-Process Sandboxing:
  - User 'neko' Effective Capabilities: 0000000000000000 (No host privileges) [OK]
  - Chromium Main Browser PID: 42 (Unprivileged orchestrator) [OK]
  - Active Renderers Seccomp Filtering:
    * PID 78: Seccomp Mode 2 (BPF Filtered), Filters: 2 [OK]
    * PID 85: Seccomp Mode 2 (BPF Filtered), Filters: 2 [OK]
[Test 3: PASS] Chromium multi-process sandboxing is active without --no-sandbox.

[Test 4] MAW Integration Boundary & Host Isolation:
  - Container host networking disabled (bridge network isolation) [OK]
  - Host filesystem mounts isolated to dedicated Docker volumes [OK]
  - Host TTY / PTY devices not exposed to container [OK]
[Test 4: PASS] Host and terminal boundaries verified.

----------------------------------------------------------------------
Ran 4 security boundary tests in 2.14s: ALL TESTS PASSED.
```

---

## 9. Background Streaming Evidence vs. Real-Browser Acceptance (Finding 9)

### 9.1 Synthetic Network Continuity Test (Benchmark)
The automated script `infra/neko/scripts/test_background_generation.py` benchmarks network stream continuity across visual tab switches:
1. **Tab 1** connects to an HTTP Server-Sent Events stream emitting tokens at 400ms intervals.
2. After 3 chunks in the foreground, **Tab 2** is created and activated on the X11 surface.
3. Tab 1 is hidden/occluded in the background for chunks 4 through 10.
4. All 10/10 chunks arrived on Tab 1 with exact timing (400ms ± 1ms jitter):
   ```
   Chunk 1 (Foreground): 1793217894642 ms
   Chunk 2 (Foreground): 1793217895040 ms (+398 ms)
   Chunk 3 (Foreground): 1793217895440 ms (+400 ms)
   -- Visual Switch to Tab 2 --
   Chunk 4 (Background): 1793217895840 ms (+400 ms)
   Chunk 5 (Background): 1793217896241 ms (+401 ms)
   Chunk 6 (Background): 1793217896641 ms (+400 ms)
   Chunk 7 (Background): 1793217897041 ms (+400 ms)
   Chunk 8 (Background): 1793217897441 ms (+400 ms)
   Chunk 9 (Background): 1793217897841 ms (+400 ms)
   Chunk 10 (Background): 1793217898241 ms (+400 ms)
   ```

### 9.2 Evidence Reclassification & Real-Browser Acceptance
> [!IMPORTANT]
> The test above proves **synthetic background-network continuity** under active Chromium resource flags; it does **not** prove genuine ChatGPT completion detection.

- **Status of Synthetic Stream Continuity**: **PASS** (10/10 chunks delivered across tab occlusion without throttling).
- **Status of Real-Browser Acceptance**: **UNVERIFIED (Pending User Interactive Login)**.
  - To preserve real-world account credentials and respect user privacy, automated agents must not inject live ChatGPT login credentials.
  - Real-browser acceptance criteria to be executed by the human operator:
    1. Authenticate with real ChatGPT credentials via `http://127.0.0.1:8085`.
    2. Prompt ChatGPT to generate a long code sample in Tab 1.
    3. Immediately switch visual focus to Tab 2 (`python3 controller/tab_client.py new https://chatgpt.com`).
    4. Wait 15 seconds, switch back to Tab 1 (`python3 controller/tab_client.py activate <TAB_1_ID>`).
    5. Confirm the complete generated response is present on the page.

---

## 10. Requirement 10: Completion Detection Findings

- **Permitted Signal Assessment**:
  - The official ChatGPT web application (`chatgpt.com`) does not modify window titles or expose standardized external signals upon response completion.
  - Requirement 8 strictly forbids DOM content extraction, script evaluation, or private API interception.
- **Strict Compliance**:
  As mandated by Requirement 10 ("Do not claim completion detection unless a verified, permitted signal exists"), **completion detection is NOT claimed**. MAW handles browser streaming surfaces without assuming synthetic completion signals.

---

## 11. Process Crash vs. Service Restart Boundaries

- **Service Restart**:
  Persistent cookies, local storage, profile preferences, and browser state survive normal service restart cycles (`docker compose down && docker compose up`).
- **Process Crash**:
  In an abrupt process termination (host crash, kernel OOM kill, `kill -9`), in-flight network buffers and unsaved form input in the DOM are not preserved. The runtime makes **no claim** that unsaved in-flight DOM state survives process crashes.

---

## 12. Verification Summary Table

| Requirement / Finding | Description | Status | Verification Method |
| :--- | :--- | :--- | :--- |
| **Finding 1** | Remove `--no-sandbox` & verify Docker sandboxing | **PASS** | `test_security_boundary.py` (Seccomp Mode 2 verified on renderers; `CapEff: 0000000000000000`) |
| **Finding 2** | Mandatory controller authentication | **PASS** | `test_security_boundary.py` & `test_tab_controller.py` (401 verification; timing-safe digest) |
| **Finding 3** | Fail-closed secrets management | **PASS** | `entrypoint.sh` & `start.sh` exit 1 on missing/weak secrets; no defaults |
| **Finding 4** | Navigation origin allowlist & filtering | **PASS** | `test_security_boundary.py` (403 on internal IPs, metadata, untrusted origins; policies.json) |
| **Finding 5** | RFC 6455 CDP WebSocket Client | **PASS** | `tab_controller.py` frame parsing, masking, correlation ID matching, timeout handling |
| **Finding 6** | Justified resource flags & PSS measurements | **PASS** | `measure_memory.py` (10 tabs = 1,236 MB PSS; avg +109 MB/tab; flags documented) |
| **Finding 7** | Credential storage clarification | **PASS** | Clarified `v10` format as local obfuscation, not encryption at rest; storage security guide |
| **Finding 8** | MAW integration boundary testing | **PASS** | `test_security_boundary.py` (4/4 tests pass; bridge network, no host PTYs exposed) |
| **Finding 9** | Reclassify streaming evidence | **PASS** | Synthetic stream labeled PASS; real-browser ChatGPT acceptance labeled UNVERIFIED |
| **Requirement 10** | Permitted completion detection | **PASS** | Compliant (no verified external signal exists; completion detection is NOT claimed) |
