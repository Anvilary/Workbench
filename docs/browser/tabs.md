# Browser tabs

Workbench embeds provider pages (ChatGPT, GitHub, Perplexity and other sites) as durable web tabs next to agent and shell tabs. Each tab is shown in a native Electron `WebContentsView` owned by the desktop shell. Related: [profiles and sessions](profiles.md), [input isolation](input-isolation.md), [budget policy](../performance/budget-policy.md).

## Ownership

| Concern | Owner |
|---|---|
| Durable tab metadata (identity, workspace, URL, title, order, selection) | Server: `packages/server/src/features/browser/browser-tab-store.ts`, persisted as `agency-web-tabs.json` in the app config directory |
| Wire protocol (`agency.webTab.*`) | `packages/server/src/transport/websocket/handlers/browser-tab-handler.ts`, types in `packages/shared/src/browser/browser-tabs.ts` |
| Selection shared with agent and shell tabs | `packages/server/src/features/workspaces/tab-coordinator.ts` |
| Native views, layout, focus, navigation policy, eviction | Desktop: `BrowserViewController` in `packages/desktop/src/browser/view-controller.mjs`, the only code that mutates a view |
| Renderer integration | `packages/web/src/features/browser/` |

## Invariants

- A web tab is its own kind (`web`), distinct from agent and terminal sessions, with a stable UUID that survives restarts. Runtime view references are ephemeral and never part of the durable identity.
- A workspace can hold any number of web tabs; at most one tab of any kind is selected per workspace.
- Switching tabs never navigates or destroys the previous page: background pages and streaming responses continue (subject to the [budget policy](../performance/budget-policy.md)).
- Mutations are serialized per workspace; an idempotent `launchId` prevents duplicate creation from repeated client requests.
- Mutations require an existing, active workspace whose project is not archived. Done and archived workspaces are rejected.
- Closing a tab that cannot be torn down persists `cleanupRequired` instead of faking closure; siblings are unaffected.
- A transient provider homepage redirect does not erase a committed conversation URL. Explicit navigation can.
- Tab ownership is verified by tab and workspace ID, never guessed from a URL or title.
- Tabs can be reordered by dragging. Completion notifications follow the [session contract](../architecture/session-contract.md).

## URL policy

Each provider has its own validator in `packages/shared/src/browser/browser-tabs.ts` (`validateChatGptUrl`, `validateGithubUrl`, and the Perplexity and other-site equivalents). Common rules: `https:` only, no credentials in the URL, default port only, at most 2048 characters, no control characters, no IP literals, no `localhost`, `.local` or `.internal` hosts, and exact host or subdomain matching (no suffix tricks such as `chatgpt.com.example.net`). In the desktop, navigation, popups, sign-in flows and OAuth loopback callbacks are governed by `navigation-guard.mjs`; links outside a provider policy open in the system browser.

## Data

The `WebTab` type (stable `id`, `workspaceId`, `kind: 'web'`, `provider`, `title`, validated `url`, `order`, `selected`, timestamps, `closedAt`, and the ephemeral `runtimeState`, `cleanupRequired` and `launchId` fields) is defined in `packages/shared/src/browser/browser-tabs.ts`.

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

