# MAW Lane B — Durable Browser Tabs and ChatGPT Workspace Integration

## Overview

Lane B introduces the durable browser-tab domain for My Amazing Workspace (MAW), enabling workspaces to associate and persist multiple ChatGPT conversations alongside native CLI and terminal sessions.

This implementation satisfies all 10 core requirements:
1. **Explicit `web` tab kind**: Distinct from native CLI (`kind: 'agent'`) and shell (`kind: 'terminal'`) sessions.
2. **Stable ChatGPT tab descriptor**: Every tab has a stable UUID `id`, `workspaceId`, `title`, validated `url`, sequential `order`, `selected` boolean, and ephemeral browser `targetRef`.
3. **Multi-tab across workspaces**: Supports any number of saved ChatGPT tabs per workspace and across multiple workspaces with strict isolation.
4. **Full tab lifecycle**: Supports creating, selecting, renaming, reordering, navigating, and closing tabs.
5. **Runtime decoupling**: Ephemeral browser runtime identifiers (`targetRef`) are decoupled from durable tab identities (`id`).
6. **Controller-driven selection**: On selection, requests that the browser controller display the already-loaded Chromium target without reloading.
7. **Switching without teardown**: Switching from ChatGPT 1 to ChatGPT 2 activates ChatGPT 2 without navigating ChatGPT 1 away or terminating its target.
8. **Conservative restart**: On server restart, all conversation references, titles, URLs, ordering, and selection states are restored; runtime target references start detached (`targetRef: null`) to avoid flooding the browser engine.
9. **Rigorous URL validation & SSRF defense**: Restricts URLs strictly to HTTPS ChatGPT domains (`chatgpt.com`, `*.chatgpt.com`, `chat.openai.com`), rejecting localhost, loopback, private RFC1918 IPs, cloud metadata endpoints, custom ports, and credentials.
10. **Backwards-compatible persistence**: Preserves the native multi-session architecture and existing schemas (`agency-state.json`, `agency-sessions.json`) without schema regressions.

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
                      │   (create, select, navigate, close)     │
                      └─────────────┬─────────────────────┬─────┘
                                    │                     │
                     Durable State  │      Control Driver │
                                    ▼                     ▼
               ┌───────────────────────┐   ┌───────────────────────────────┐
               │    BrowserTabStore    │   │   BrowserControllerDriver     │
               │ (agency-web-tabs.json)│   │ (Lane A: Neko/Chromium engine)│
               └───────────────────────┘   └───────────────────────────────┘
```

- **Lane B (this work)**: Owns the domain models, durable persistence store, URL validation rules, typed adapter, protocol dispatcher, and isolated test suites.
- **Lane A**: Owns the Neko container and Chromium browser controller. Lane A implements the `BrowserControllerDriver` interface to bridge high-level tab events to Chromium CDP / Neko session APIs.
- **Lane C / Integration**: Connects the typed adapter to the authenticated WebSocket dispatcher and adds the web tab rendering component to `AgencyWorkspaceView.tsx`.

---

## Data Schema

### WebTab Type (`packages/shared/src/browser-tabs.ts`)

```typescript
export type WebTabKind = 'web';

export type WebTabRuntimeState =
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
  /** Ephemeral browser runtime target reference (e.g. Chromium targetId). Null on restart. */
  targetRef?: string | null;
  /** Ephemeral runtime state in the browser controller. */
  runtimeState?: WebTabRuntimeState;
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
      "closedAt": null
    }
  ]
}
```

- **Persistence guarantees**:
  - `writeAtomically` ensures crash safety and prevents partial writes.
  - Automatic `.bak` copy updated before replacing the primary file.
  - Corruption quarantine: damaged primary files are renamed to `agency-web-tabs.json.corrupt-<uuid>` while restoring the valid backup.
  - Conservative restart: `targetRef` is excluded from serialized JSON on disk and restored as `null` on startup.

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
export interface OpenTargetResult {
  targetRef: string;
}

export interface BrowserControllerDriver {
  /**
   * Request that the browser engine open a new Chromium page/target at the specified URL.
   * Returns the browser engine's runtime target reference.
   */
  openTarget(url: string): Promise<OpenTargetResult>;

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
}
```

### Lane A Implementation Notes:
- **Switching behavior (Requirements 6 & 7)**:
  When `activateTarget(targetRef)` is called, Neko / Chromium should switch focus or bring the corresponding page to the foreground. Do **not** reload or re-navigate the page, and do **not** close other targets.
- **Target survival**:
  Targets must remain alive in Chromium when switching between workspaces or between tabs.
- **Offline / Startup behavior**:
  If Neko is still booting, `BrowserTabAdapter` defaults to `NullBrowserControllerDriver` and queues or defers driver calls gracefully without throwing or corrupting metadata.

---

## Typed Adapter Interface: `BrowserTabAdapter`

`packages/server/src/agency/browser-tabs/browser-tab-adapter.ts`:

- `createTab(input: CreateWebTabInput): Promise<WebTab>`
  Validates URL, title, assigns UUID and next order index, opens browser target via driver, sets selected state, persists store.
- `selectTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab>`
  Activates the tab in the workspace, requests driver `activateTarget` for already-loaded target (or lazily opens target if restarted), unselects sibling open tabs, persists store.
- `navigateTab(workspaceId: WorkspaceId, tabId: string, url: string): Promise<WebTab>`
  Validates new URL, delegates navigation to driver target, updates durable store.
- `closeTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab>`
  Marks `closedAt`, requests driver to close target, automatically selects adjacent open tab if the closed tab was active, persists store.
- `renameTab(workspaceId: WorkspaceId, tabId: string, title: string): Promise<WebTab>`
  Validates title (1–120 characters, non-empty, trimmed), updates durable store.
- `orderTabs(workspaceId: WorkspaceId, tabIds: readonly string[]): Promise<readonly WebTab[]>`
  Reorders open workspace tabs sequentially (0, 1, 2, ...), validates permutation.
- `listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly WebTab[]`
  Lists tabs sorted by order, filtering by workspace and closed status.
- `getTabState(tabId: string): WebTab | undefined`
  Returns tab state by ID.
- `restore(): Promise<void>`
  Loads durable state conservatively at server startup.

---

## Protocol & Wire Contract (`agency.webTab.*`)

### Client Messages

| Message Type | Parameters | Response |
|---|---|---|
| `agency.webTab.create` | `workspaceId`, `url`, `title?`, `order?`, `select?` | `agency.webTab.created` |
| `agency.webTab.select` | `workspaceId`, `tabId` | `agency.webTab.updated` |
| `agency.webTab.navigate` | `workspaceId`, `tabId`, `url` | `agency.webTab.updated` |
| `agency.webTab.rename` | `workspaceId`, `tabId`, `title` | `agency.webTab.updated` |
| `agency.webTab.order` | `workspaceId`, `tabIds` | `agency.webTabs.snapshot` |
| `agency.webTab.close` | `workspaceId`, `tabId` | `agency.webTab.closed` |
| `agency.webTabs.list` | `workspaceId?` | `agency.webTabs.snapshot` |

### Broadcast Events

Committed mutations emit `agency.webTab.changed`:
```typescript
{
  type: 'agency.webTab.changed',
  change: 'created' | 'updated' | 'closed' | 'ordered',
  workspaceId: WorkspaceId,
  tab?: WebTab,
  tabs?: readonly WebTab[]
}
```

---

## Frontend Integration Hooks (For Lane C / Integration Phase)

During the integration phase, `AgencyWorkspaceView.tsx` will display web tabs in the unified tab strip:
1. `AgencyTab` items for native CLI/shell remain rendered as `TerminalView`.
2. `WebTab` items (`kind: 'web'`) are rendered with a browser icon (e.g. ChatGPT / web globe) and their custom `title`.
3. Selecting a web tab pane displays the Neko browser container (e.g. Neko WebRTC stream or iframe).
4. No modification was made to `AgencyWorkspaceView.tsx` during Lane B to preserve parallel work.

---

## Validation Summary

All 23 focused unit and integration tests pass cleanly with zero external dependencies or paid inference:

| Test File | Tests | Coverage |
|---|---|---|
| `url-validation.test.ts` | 6 | Canonical ChatGPT URLs, query/fragments, HTTPS enforcement, SSRF defense, port blocking, domain spoofing, credential blocking |
| `browser-tab-persistence.test.ts` | 7 | Atomic writes, file mode 0o600, backup generation, corrupt quarantine, conservative restore, selection normalization, duplicate detection |
| `browser-tab-adapter.test.ts` | 8 | Target opening, target switching without teardown, lazy attach on select, navigation, renaming, reordering, close with adjacent selection, cross-workspace isolation |
| `web-tab-handler.test.ts` | 2 | Message parsing, request dispatch, broadcast emission, error mapping to `agency.error` |
| **Total** | **23** | **100% pass** |
