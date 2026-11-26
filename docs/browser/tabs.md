# MAW Lane B — Durable Browser Tabs and ChatGPT Workspace Integration

## Overview

Lane B introduces the durable browser-tab domain for My Amazing Workspace (MAW), enabling workspaces to associate and persist multiple ChatGPT conversations alongside native CLI and terminal sessions.

This implementation satisfies all core requirements and lifecycle safety amendments:
1. **Explicit `web` tab kind**: Distinct from native CLI (`kind: 'agent'`) and shell (`kind: 'terminal'`) sessions.
2. **Stable ChatGPT tab descriptor**: Every tab has a stable UUID `id`, `workspaceId`, `title`, validated `url`, sequential `order`, `selected` boolean, and ephemeral browser `targetRef`.
3. **Multi-tab across workspaces**: Supports any number of saved ChatGPT tabs per workspace and across multiple workspaces with strict isolation.
4. **Full tab lifecycle**: Supports creating, selecting, renaming, reordering, navigating, and closing tabs.
5. **Runtime decoupling**: Ephemeral browser runtime identifiers (`targetRef`) are decoupled from durable tab identities (`id`).
6. **Controller-driven selection & target reconciliation**: On selection, requests that the browser controller display the verified live Chromium target. On restart, reattaches to existing live Chromium targets without creating duplicate pages.
7. **Switching without teardown**: Switching from ChatGPT 1 to ChatGPT 2 activates ChatGPT 2 without navigating ChatGPT 1 away or terminating its target. Background pages and streaming responses continue uninterrupted.
8. **Truthful recovery semantics**: Differentiates between MAW server restart (where Neko targets may still be alive) and browser restart (where targets are dead). Verifies ownership via `{ tabId, workspaceId }` and never guesses by URL or title.
9. **Atomic tab operations**: In-process operation queue serializes mutations per workspace; idempotent `launchId` prevents duplicate tab creation from rapid client requests.
10. **Workspace lifecycle validity**: Validates workspace existence and lifecycle state (`active`, non-archived, non-deleted parent project) before mutations.
11. **Reliable closing**: Persists `cleanupRequired` state if browser target destruction fails; reconciles orphaned targets without touching sibling tabs.
12. **Shared single selection**: Coordinates with native CLI/terminal sessions so only one tab is visibly selected within a workspace.
13. **Rigorous URL validation & SSRF defense**: Restricts URLs strictly to HTTPS ChatGPT domains (`chatgpt.com`, `*.chatgpt.com`, `chat.openai.com`), rejecting localhost, loopback, private RFC1918 IPs, cloud metadata endpoints, custom ports, and credentials.
14. **Backwards-compatible persistence**: Preserves the native multi-session architecture and existing schemas (`agency-state.json`, `agency-sessions.json`) without schema regressions.

---

## Architecture and Lane Division

```
                      ┌─────────────────────────────────────────┐
                      │             Agency Client               │
                      │ (AgencyWorkspaceView / Web Tab Strip)   │
                      └────────────────────┬────────────────────┘
                                           │
                         WebSocket (agency.webTab.*)
                                           │
                      ┌────────────────────▼────────────────────┐
                      │          WebTab Message Handler         │
                      │     (web-tab-handler.ts: parse/route)   │
                      └────────────────────┬────────────────────┘
                                           │
                      ┌────────────────────▼────────────────────┐
                      │           BrowserTabAdapter             │
                      │  (serialized per-workspace operations)  │
                      └─────────────┬─────────────────────┬─────┘
                                    │                     │
                     Durable State  │      Control Driver │
                                    ▼                     ▼
               ┌───────────────────────┐   ┌───────────────────────────────┐
               │    BrowserTabStore    │   │   BrowserControllerDriver     │
               │ (agency-web-tabs.json)│   │ (Lane A: Neko/Chromium engine)│
               └───────────────────────┘   └───────────────────────────────┘
```

- **Lane B (this work)**: Owns the domain models, durable persistence store, URL validation rules, typed adapter, protocol dispatcher, reconciliation logic, and isolated test suites.
- **Lane A**: Owns the Neko container and Chromium browser controller. Lane A implements the `BrowserControllerDriver` interface to bridge high-level tab events to Chromium CDP / Neko session APIs.
- **Lane C / Integration**: Connects the typed adapter to the authenticated WebSocket dispatcher and adds the web tab rendering component to `AgencyWorkspaceView.tsx`.

---

## Data Schema

### WebTab Type (`packages/shared/src/browser-tabs.ts`)

```typescript
export type WebTabKind = 'web';

export type WebTabRuntimeState =
  | 'unloaded'
  | 'detached'
  | 'attaching'
  | 'attached'
  | 'navigating'
  | 'ready'
  | 'crashed'
  | 'closed'
  | 'error';

export interface WebTab {
  /** Stable UUID identifying this tab across restarts. */
  id: string;
  /** Owning Agency workspace ID. */
  workspaceId: WorkspaceId;
  /** Explicit discriminator separate from native CLI and terminal sessions. */
  kind: 'web';
  /** Human-readable tab title (e.g. conversation title or user-renamed label). */
  title: string;
  /** Strictly validated ChatGPT conversation URL. */
  url: string;
  /** Presentation order in the tab strip (0-indexed). */
  order: number;
  /** Whether this tab is selected in its workspace. At most one open tab is selected per workspace. */
  selected: boolean;
  /** Creation timestamp. */
  createdAt: IsoTimestamp;
  /** Last update timestamp. */
  updatedAt: IsoTimestamp;
  /** Timestamp when the tab was intentionally closed, or null if open. */
  closedAt: IsoTimestamp | null;
  /** Ephemeral browser runtime target reference (e.g. Chromium targetId). Null if unloaded or unverified. */
  targetRef?: string | null;
  /** Ephemeral runtime state in the browser controller. */
  runtimeState?: WebTabRuntimeState;
  /** True if Chromium target destruction failed during closure, requiring subsequent cleanup. */
  cleanupRequired?: boolean;
  /** Optional client-supplied idempotent launch identifier. */
  launchId?: string;
}
```

### Durable Storage (`agency-web-tabs.json`)

Stored in `appConfigDir()` (mode `0o600`):

```json
{
  "version": 1,
  "tabs": [
    {
      "id": "c6264f3d-82d2-4011-9689-d1cfbc1c2512",
      "workspaceId": "d05908c6-ff26-444a-a43c-687f2a1bfe48",
      "kind": "web",
      "title": "ChatGPT - Research",
      "url": "https://chatgpt.com/c/671fd123-4567-89ab-cdef-0123456789ab",
      "order": 0,
      "selected": true,
      "createdAt": "2026-10-28T19:00:00.000Z",
      "updatedAt": "2026-10-28T19:00:00.000Z",
      "closedAt": null,
      "targetRef": "mem-target-1",
      "cleanupRequired": false,
      "launchId": "launch-xyz"
    }
  ]
}
```

- **Persistence guarantees**:
  - `writeAtomically` ensures crash safety and prevents partial writes.
  - Automatic `.bak` copy updated before replacing the primary file.
  - Corruption quarantine: damaged primary files are renamed to `agency-web-tabs.json.corrupt-<uuid>` while restoring the valid backup.
  - Conservative restart: `targetRef` is preserved for controller reconciliation, but starts with `runtimeState: 'detached'` until ownership is verified.

---

## URL Validation & Security Model

`validateChatGptUrl(url: string)` enforces strict safety rules:
1. **Allowed Hosts**: Only `chatgpt.com`, `*.chatgpt.com` (valid subdomains), and `chat.openai.com`.
2. **Protocol**: Strictly `https:`. Rejects `http:`, `file:`, `data:`, `javascript:`, `blob:`, `chrome:`, `about:`.
3. **Port Enforcement**: Rejects explicit custom ports (e.g. `:8080`, `:34187`). Only default port 443 / omitted is allowed.
4. **SSRF Defense**: Rejects `localhost`, `127.0.0.1`, loopback, IPv6 addresses, private RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata IP `169.254.169.254`.
5. **Credential Prevention**: Rejects URLs containing `username` or `password` (`https://user:pass@...`).
6. **Anti-Spoofing**: Rejects domain suffix tricks (`evil-chatgpt.com`, `chatgpt.com.attacker.com`).

---

## Lane A Integration Contract: `BrowserControllerDriver`

Lane A implements `BrowserControllerDriver` (`packages/server/src/agency/browser-tabs/browser-controller-driver.ts`):

```typescript
export interface TargetMetadata {
  /** Stable MAW tab ID. */
  tabId: string;
  /** Owning Agency workspace ID. */
  workspaceId: string;
  /** Conversation URL. */
  url?: string;
}

export interface BrowserControllerDriver {
  /**
   * Request that the browser engine open a new Chromium page/target at the specified URL
   * tagged with MAW tab ownership metadata.
   */
  openTarget(url: string, metadata?: TargetMetadata): Promise<OpenTargetResult>;

  /**
   * Request that the browser engine display/focus an already-loaded target.
   * Switching targets must NEVER close or navigate away previously loaded targets.
   */
  activateTarget(targetRef: string): Promise<void>;

  /**
   * Request that an existing target navigate to a new URL.
   */
  navigateTarget(targetRef: string, url: string): Promise<void>;

  /**
   * Request that the browser engine close a target.
   */
  closeTarget(targetRef: string): Promise<void>;

  /**
   * Inquire whether a target reference is still open/alive in the browser engine.
   */
  isTargetAlive(targetRef: string): Promise<boolean>;

  /**
   * Verify whether an existing browser target strictly matches the expected tab ownership.
   * Returns true only when tabId and workspaceId match.
   * Never blindly matches based on URL or title alone.
   */
  verifyTargetOwnership(targetRef: string, expected: TargetMetadata): Promise<boolean>;

  /**
   * Inquire active ongoing background operations (e.g. assistant streaming response).
   */
  hasOngoingOperation?(targetRef: string): Promise<boolean>;
}
```

### Trusted Target-Ownership Registry Specification

To guarantee safety across server and container restarts, the integration contract defines a trusted server-side target-ownership registry:

1. **Target Creation (`openTarget`)**:
   - The driver must associate the newly created Chromium page target with `TargetMetadata`: `{ tabId, workspaceId, url }`.
   - The target ID returned to MAW is treated as an ephemeral runtime handle.
2. **Reattachment (`verifyTargetOwnership`)**:
   - MAW loads persisted `targetRef` values strictly as **untrusted reconciliation hints**, never as proof of ownership.
   - On reattachment / selection, MAW invokes `driver.verifyTargetOwnership(targetRef, expected)`.
   - The driver MUST verify that:
     1. The target is alive and valid in Chromium CDP.
     2. The target's registered metadata matches `expected.tabId` and `expected.workspaceId`.
   - **Never infer ownership from URL or page title alone**, as distinct workspaces or tabs may share identical URLs.
   - If verified, MAW activates the target without reopening or navigating the page.
   - If unverified, stale, dead, or belonging to another workspace, MAW treats the target as unavailable, clears the stale reference, and opens a fresh verified target.
3. **Closure (`closeTarget`)**:
   - The driver destroys the Chromium CDP page target and removes its ownership entry from the registry.
   - If destruction fails (e.g. CDP timeout), MAW marks `cleanupRequired: true` on the tab and safely retries closure later via `reconcileCleanup()`, without affecting sibling tabs.
4. **Browser Container Restart**:
   - When the Neko container restarts, all previous Chromium targets are destroyed.
   - `verifyTargetOwnership` returns `false` for old handles. MAW safely discards stale hints and lazily allocates new targets upon explicit user activation.
5. **Lane A Implementation Boundary**:
   - Lane A currently exposes Chromium target IDs in Neko, but has **not yet implemented** server-side metadata attachment and `verifyTargetOwnership`.
   - **Real Neko reattachment must not be claimed until Lane A implements this registry contract and it is tested against the live controller.**
   - In Lane B, all reattachment and recovery mechanics are verified deterministically using `MemoryBrowserControllerDriver`. Real Neko integration will take place in the dedicated integration lane once Lane A adds metadata support.

---

## Error Handling & Unavailable Engines

1. **Explicit Engine Failures (`BrowserEngineUnavailableError`)**:
   - `NullBrowserControllerDriver` (used when Neko is unconfigured or offline) explicitly throws `BrowserEngineUnavailableError` on `openTarget()`, `activateTarget()`, `navigateTarget()`, and `closeTarget()`. It does not invent fictional targets such as `null-target`.
   - When the engine is unavailable, the user's logical web tab is **safely persisted to disk** with `runtimeState: 'error'` and `targetRef: null`.
   - The operation throws `BrowserTabStoreError` with code `'session-unavailable'`. A failed browser operation is never presented to the user or client as attached or ready.
2. **Activation State Safety**:
   - If `activateTarget()` fails during creation or selection, the tab is **never marked `ready`**; it transitions to `runtimeState: 'error'`.
   - Selection state is preserved coherently so the user can see which tab was selected and retry.
3. **Idempotency & Clean Rejection Handling**:
   - In-flight tab creations are scoped by workspace (`${workspaceId}:${launchId}`).
   - Launch promise cleanup uses `.catch(() => undefined).finally(...)` to guarantee zero unhandled promise rejections on failure.

---

## Authoritative Workspace Validation

Production `BrowserTabAdapter` operations require an authoritative `AgencyWorkspaceStore` or equivalent `workspaceValidator`:
- **Workspace Existence**: Rejects non-existent workspace IDs with `not-found`.
- **Done Workspaces**: Rejects workspaces with `status === 'done'` or `doneAt != null` with `conflict`.
- **Archived Workspaces**: Rejects workspaces with `status === 'archived'` or `archivedAt != null` with `conflict`.
- **Parent Project Lifecycle**: Rejects workspaces whose parent project is missing (`not-found`) or archived (`conflict`).
- **Testing Exemption**: Isolated unit tests must explicitly set `allowUnvalidatedWorkspacesForTesting: true` to bypass authoritative validation.

---

## Typed Adapter Interface: `BrowserTabAdapter`

`packages/server/src/agency/browser-tabs/browser-tab-adapter.ts`:

- `createTab(input: CreateWebTabInput): Promise<WebTab>`
  Validates workspace, URL, title, assigns UUID and order index. Uses `launchId` for idempotency. Opens target or creates saved `unloaded` tab without eager allocation.
- `selectTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab>`
  Validates workspace, serializes via lock, reattaches to verified live target or lazily opens fresh target, coordinates unselection of native tabs.
- `navigateTab(workspaceId: WorkspaceId, tabId: string, url: string): Promise<WebTab>`
  Validates new URL, delegates navigation to driver target, updates durable store.
- `closeTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab>`
  Marks `closedAt`. If driver close fails, persists `cleanupRequired: true` without faking closure. Sibling tabs are unaffected.
- `reconcileCleanup(workspaceId?: WorkspaceId): Promise<void>`
  Retries destruction of orphaned targets with `cleanupRequired === true`.
- `clearWorkspaceSelection(workspaceId: WorkspaceId): Promise<void>`
  Clears selection on all web tabs when a native CLI or shell tab is selected.
- `orderTabs(workspaceId: WorkspaceId, tabIds: readonly string[]): Promise<readonly WebTab[]>`
  Reorders open workspace tabs sequentially (0, 1, 2, ...), validates permutation.
- `listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly WebTab[]`
  Lists tabs sorted by order, filtering by workspace and closed status.
- `getTabState(tabId: string): WebTab | undefined`
  Returns tab state by ID.
- `restore(): Promise<void>`
  Loads durable state conservatively at server startup, reconciling pending cleanups.

---

## Protocol & Wire Contract (`agency.webTab.*`)

### Client Messages

| Message Type | Parameters | Response |
|---|---|---|
| `agency.webTab.create` | `workspaceId`, `url`, `title?`, `order?`, `select?`, `launchId?`, `unloaded?` | `agency.webTab.created` |
| `agency.webTab.select` | `workspaceId`, `tabId` | `agency.webTab.updated` |
| `agency.webTab.navigate` | `workspaceId`, `tabId`, `url` | `agency.webTab.updated` |
| `agency.webTab.rename` | `workspaceId`, `tabId`, `title` | `agency.webTab.updated` |
| `agency.webTab.order` | `workspaceId`, `tabIds` | `agency.webTabs.snapshot` |
| `agency.webTab.close` | `workspaceId`, `tabId` | `agency.webTab.closed` |
| `agency.webTabs.list` | `workspaceId?` | `agency.webTabs.snapshot` |

---

## Validation Summary

All 39 focused unit, regression, and acceptance tests pass cleanly with zero external dependencies:

| Test File | Tests | Coverage |
|---|---|---|
| `browser-tab-reconciliation.test.ts` | 16 | Reattachment on restart, zero duplicate pages, background page continuation, atomic operations & launchId dedup, failed close & cleanupRequired, workspace validity, shared native/web selection, saved/unloaded tabs, stale/foreign target detection, unconfigured Neko driver explicitly failing, failed activation leaving error state, invalid workspace configuration rejecting Done/archived/unknown, cross-workspace duplicate launch IDs, failed creation without unhandled rejection, MAW restart with verified target identity, and failed browser cleanup safe retry |
| `url-validation.test.ts` | 6 | Canonical ChatGPT URLs, query/fragments, HTTPS enforcement, SSRF defense, port blocking, domain spoofing, credential blocking |
| `browser-tab-persistence.test.ts` | 7 | Atomic writes, mode 0o600, backup generation, corrupt quarantine, conservative restore, selection normalization, duplicate detection |
| `browser-tab-adapter.test.ts` | 8 | Target opening, target switching without teardown, lazy attach on select, navigation, renaming, reordering, close with adjacent selection, cross-workspace isolation |
| `web-tab-handler.test.ts` | 2 | Message parsing, request dispatch, broadcast emission, error mapping to `agency.error` |
| **Total** | **39** | **100% pass** |

### Verified via Mocks vs Requiring Real Neko Integration

- **Verified through In-Memory Mocks (`MemoryBrowserControllerDriver`)**:
  - Serialization of concurrent tab operations per workspace queue.
  - Idempotent tab creation scoped by workspace and launch ID.
  - Fail-explicit behavior for unconfigured/offline browser engines (`NullBrowserControllerDriver` throwing `BrowserEngineUnavailableError`).
  - Coherent error state transitions: failed activation never marks `ready`, preserves selection.
  - Rejection safety: zero unhandled promise rejections on launch cleanup failure.
  - Strict ownership verification rejecting foreign, stale, or mismatched targets.
  - Shared selection coordination ensuring single selection across native CLI, terminal, and web tabs.
  - Durable persistence: atomic replacement, mode `0o600`, backup recovery, and corruption quarantine.
  - Authoritative workspace lifecycle validation: rejection of unknown, Done, or archived workspaces and projects.
- **Requiring Real Neko Integration (Lane A / Integration Lane)**:
  - Live Chromium DevTools Protocol (CDP) session attachment and target lifecycle events.
  - Streaming WebRTC rendering of live Chromium tab viewports inside Neko.
  - Live browser container restart and network reconnect recovery.
  - ChatGPT session cookies, user credentials, and Cloudflare challenge persistence within Neko's Chromium browser user data directory.
