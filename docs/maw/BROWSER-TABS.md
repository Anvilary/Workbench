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

### Target Reconciliation & Recovery Semantics:
1. **Server restart with active Neko**:
   When MAW restarts, existing Chromium tabs remain alive in Neko. On selection/reattachment, MAW invokes `driver.verifyTargetOwnership(tab.targetRef, { tabId: tab.id, workspaceId: tab.workspaceId })`. If verified, MAW reattaches to the running page. **No duplicate Chromium tabs are opened.**
2. **Browser restart**:
   If Neko restarts, old target IDs are invalid. `verifyTargetOwnership` fails. MAW clears the stale `targetRef` and lazily creates a fresh target only when explicitly activated by the user.
3. **No ambiguous matching**:
   Targets are never matched by URL or page title alone, preventing misattribution between duplicate conversation URLs or user accounts.
4. **Background tab survival**:
   Background tabs continue generating responses and executing network requests while another tab is active. `activateTarget` must not terminate or navigate away inactive tabs.

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

All 32 focused unit and integration tests pass cleanly with zero external dependencies:

| Test File | Tests | Coverage |
|---|---|---|
| `browser-tab-reconciliation.test.ts` | 9 | Reattachment on restart, zero duplicate pages, background page continuation, atomic operations & launchId dedup, failed close & cleanupRequired, workspace validity, shared native/web selection, saved/unloaded tabs, stale/foreign target detection |
| `url-validation.test.ts` | 6 | Canonical ChatGPT URLs, query/fragments, HTTPS enforcement, SSRF defense, port blocking, domain spoofing, credential blocking |
| `browser-tab-persistence.test.ts` | 7 | Atomic writes, mode 0o600, backup generation, corrupt quarantine, conservative restore, selection normalization, duplicate detection |
| `browser-tab-adapter.test.ts` | 8 | Target opening, target switching without teardown, lazy attach on select, navigation, renaming, reordering, close with adjacent selection, cross-workspace isolation |
| `web-tab-handler.test.ts` | 2 | Message parsing, request dispatch, broadcast emission, error mapping to `agency.error` |
| **Total** | **32** | **100% pass** |
