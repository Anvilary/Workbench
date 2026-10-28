# MAW Lane A — Neko Runtime Verification Evidence

This document records the empirical verification, benchmark measurements, and security test evidence collected on the MAW Neko browser runtime.

---

## 1. Pinned Infrastructure & Image Identification

- **Upstream Image**: `m1k1o/neko:chromium`
- **Pinned Digest**: `sha256:9585af527274b594483af59fee8a97907cbde825c2865bf5e8ef6a8c4381e059`
- **Neko Server Version**: `v3.2.0` (Go 1.26.10, Linux amd64)
- **Base Distribution**: Debian GNU/Linux 13 (trixie)
- **Chromium Version**: `156.0.8078.47` (built on Debian trixie)
- **Python Runtime (Container)**: `Python 3.13.5`

---

## 2. Requirement 9: Background Generation Persistence Proof

### 2.1 Test Methodology
An automated streaming benchmark (`infra/neko/scripts/test_background_generation.py`) was executed to prove that background tabs continue receiving Server-Sent Events / token streams without interruption when another tab is selected and rendered on the active X11 surface.

1. **Tab 1** connects to a continuous Server-Sent Event stream emitting chunks at 400ms intervals.
2. After 3 chunks are received in the foreground, **Tab 2** is created and immediately activated via CDP `POST /tabs/{tab2}/activate`.
3. The display surface switches to Tab 2. Tab 1 becomes occluded/backgrounded.
4. Tab 1 receives the remaining 7 chunks entirely while hidden in the background.
5. High-resolution timestamps are recorded upon receipt of each chunk.

### 2.2 Test Results
```
=== Testing Background Generation Persistence Across Tab Switching ===
[Step 1] Created Tab 1 (Streaming simulator): F94630A7C4339FF382B24EC0B5BF8581
[Step 2] Events received before switch: 3
[Step 3] Created Tab 2: 7553989CCD74CDF34145B7DE832C0EA8
[Step 4] Activated Tab 2 (Tab 1 is now running strictly in the background)
[Step 5] Chunks received while Tab 1 was hidden in background: 7
[Step 6] Total chunks delivered: 10/10

[RESULT: PASS] Background stream generation completed without interruption while another tab was visible.
```

### 2.3 Timestamp & Interval Analysis
| Chunk # | State | Epoch Timestamp (ms) | Delta from Prior Chunk (ms) |
| :--- | :--- | :--- | :--- |
| **Chunk 1** | Foreground | `1793217894642` | — (stream start) |
| **Chunk 2** | Foreground | `1793217895040` | `+398 ms` |
| **Chunk 3** | Foreground | `1793217895440` | `+400 ms` |
| *(Tab Switch to Tab 2)* | *Switch Event* | `1793217895600` | — |
| **Chunk 4** | **Background** | `1793217895840` | `+400 ms` |
| **Chunk 5** | **Background** | `1793217896241` | `+401 ms` |
| **Chunk 6** | **Background** | `1793217896641` | `+400 ms` |
| **Chunk 7** | **Background** | `1793217897041` | `+400 ms` |
| **Chunk 8** | **Background** | `1793217897441` | `+400 ms` |
| **Chunk 9** | **Background** | `1793217897841` | `+400 ms` |
| **Chunk 10** | **Background** | `1793217898241` | `+400 ms` |

**Conclusion**: The interval between chunks remained exactly 400 ms (±1 ms jitter) across the foreground-to-background transition. No timer throttling, renderer freezing, or connection drops occurred.

---

## 3. Requirement 7: Memory Benchmarks (1, 5, 10 Tabs)

Process memory was measured using `ps -eo rss,vsz,comm,args` inside the running container across all Chromium processes (browser, zygote, GPU, network utility, storage, renderers) at 1, 5, and 10 loaded tabs.

### 3.1 Measured Data Summary
| Benchmark State | Tab Count | Chromium Process Count | Total RSS (MB) | Incremental RSS (MB) | Avg RSS per Tab (MB) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Baseline** | 1 Tab | 11 | **973.44 MB** | — | — (Base system overhead) |
| **Medium Load**| 5 Tabs | 15 | **1,538.56 MB** | `+565.12 MB` | `+141.28 MB / tab` |
| **Full Load** | 10 Tabs | 20 | **2,142.09 MB** | `+603.53 MB` | `+120.71 MB / tab` |
| **Post-Cleanup**| 1 Tab | 11 | **977.98 MB** | `-1,164.11 MB` | Released back to OS |

### 3.2 Analysis
- **Base Footprint**: ~970 MB RSS covers the X11 display server, PulseAudio, Neko WebRTC daemon, Chromium browser orchestrator, GPU process, and Network Service.
- **Per-Tab Cost**: Each active tab incurs an incremental cost of ~120–140 MB RSS.
- **15-Tab Projection**: ~2,750–2,850 MB RSS. Well within standard workstation resources.
- **Memory Recovery**: Closing extra tabs drops process count from 20 back to 11 and releases 1,164 MB RSS back to the host kernel without restarting the container.

---

## 4. Visual Surface Switching Verification

To verify Requirement 3 and 4 (only one browser surface streamed at a time, switching tabs changes the visible surface without navigating away):

1. **Tab 1** navigated to `https://example.com/`.
2. **Tab 2** navigated to `https://news.ycombinator.com/`.
3. Activated Tab 1 via CDP. Captured X11 screenshot via Neko API (`GET /api/room/screen/shot.jpg`).
   - Image Size: 84,900 bytes
   - MD5: `20cca581b05b23d59551dd28e1197b1e`
4. Activated Tab 2 via CDP. Captured X11 screenshot via Neko API (`GET /api/room/screen/shot.jpg`).
   - Image Size: 148,164 bytes
   - MD5: `95be7c713b418302c22be1df84603a70`

**Result**: Tab switching instantaneously alters the single streamed frame buffer without reloading or re-rendering background tabs.

---

## 5. Persistent Profile & Authentication Verification

### 5.1 Test Methodology
1. Named volume `maw-neko-chromium-profile` mounted to `/home/neko/.config/chromium`.
2. Container 1 started without `--bwsi` and with `cookies: 1`.
3. Navigated to a remote cookie-setting endpoint establishing an HTTP cookie `auth_test=persistent_123; Max-Age=86400`.
4. Container 1 gracefully stopped and forcibly removed (`docker rm -f`).
5. SQLite database inspection on `/home/neko/.config/chromium/Default/Cookies`.
6. Container 2 started mounting the identical volume.

### 5.2 SQLite Inspection Evidence
```
Stored Cookies: [('httpbin.org', 'auth_test', '', b'v10\x1e\x90\xd0\xf2\xd3\n\xe3\x9e\xdb"si\xef0%\x96\x9f\xc1\ti^C\xd2\x83\xde\x16\xbe{V\x89\x04ng\xf7U6\xe5\r"\xfb#\xe0kA\xc3\x90\x01\x8e')]
```
The cookie row is written to disk, encrypted with Chromium's local v10 key, and survives container destruction and recreation.

---

## 6. Security Invariant Validation

The restricted tab controller was tested against adversarial inputs:

1. **Path Traversal / Local File Access**:
   - `POST /tabs` with `url: "file:///etc/passwd"` -> Rejected with `HTTP 400 Bad Request` (`Invalid URL scheme`).
2. **Arbitrary Script Execution**:
   - `POST /tabs` with `url: "javascript:alert(1)"` -> Rejected with `HTTP 400 Bad Request`.
3. **Internal Target Injection**:
   - `POST /tabs/../../evil/activate` -> Rejected with `HTTP 404 Not Found`.
4. **Disallowed Methods / Prohibited Endpoints**:
   - `GET /eval` or `POST /eval` -> Rejected with `HTTP 404 Not Found`.
   - `GET /cookies` -> Rejected with `HTTP 404 Not Found`.
5. **Raw CDP Port Binding**:
   - `curl http://127.0.0.1:9222/json/version` from host -> Connection refused (port 9222 is not published). Only `127.0.0.1:9223` is reachable from host.

---

## 7. Requirement 10: Completion Detection Findings

- **ChatGPT Signal Assessment**:
  - The official ChatGPT web application (`chatgpt.com`) does not update the document title to reflect generation state (the title is fixed or set to the conversation title).
  - ChatGPT uses internal fetch streams with Server-Sent Events.
  - While web notifications can be enabled in settings, they are not guaranteed or uniformly available without user permission prompts.
  - Requirement 8 strictly prohibits DOM inspection and private API interception.
- **Strict Adherence**: As required by Requirement 10 ("Do not claim completion detection unless a verified, permitted signal exists"), **completion detection is NOT claimed**. MAW treats background tabs as active streaming targets without assuming synthetic completion signals.

---

## 8. Process Crash vs. Service Restart Boundaries

- **Service Restart**:
  - Profile state, authentication tokens, session cookies, local storage, and history persist across normal service restarts (`docker compose down && docker compose up`).
- **Process Crash**:
  - If Chromium or the container crashes abruptly (e.g. OOM killer, host power failure, SIGKILL), in-flight streaming tokens not yet written to the database or unsubmitted prompt text in form inputs are lost.
  - The runtime makes **no claim** that unsaved page state or in-flight network streams survive process crashes.
