# Production browser ownership and recovery

`NekoBrowserControllerDriver`, exported from
`packages/server/src/agency/browser-tabs/index.ts`, implements the browser driver
against the restricted controller. Its options are `{ baseUrl?, token?, timeoutMs? }`.
Defaults come from `NEKO_CONTROLLER_URL` (otherwise `http://127.0.0.1:9223`) and
`CONTROLLER_AUTH_TOKEN` / `NEKO_CONTROLLER_TOKEN`. The configured endpoint must be
HTTP on loopback, with no credentials, path, query or fragment. The token stays
on the server. Requests have deadlines, reject redirects, validate response
receipts, and never include arbitrary upstream bodies or credentials in errors.

The parent runtime supplies authoritative workspace validation and coordinates
native/web selection. It may call `refreshLiveTabs()` periodically. That method
observes inventory URLs through verified ownership, persists valid ChatGPT
conversation addresses, and ignores SSO redirects. It never creates, navigates
or selects a page. `orderTabs(workspaceId, subset, positions?)` accepts global
interleaved positions after validating the web subset permutation.

## Trusted controller receipts

Managed routes are separate from the legacy restricted tab API:

| Request | Result |
| --- | --- |
| `POST /managed/tabs` with `{url, metadata:{tabId,workspaceId}}` | Durable, idempotent target receipt |
| `GET /managed/tabs?tabId=…&workspaceId=…` | Resolve a live owned receipt after response loss |
| `GET /managed/tabs/:target?tabId=…&workspaceId=…` | Verify ownership and observe inventory URL |
| `POST /managed/tabs/:target/activate` with `{metadata}` | Verify then activate without navigation |
| `POST /managed/tabs/:target/navigate` with `{url,metadata}` | Verify then request validated navigation |
| `DELETE /managed/tabs/:target` with `{metadata}` | Verify then confirm target absence |

Every route requires the existing server bearer token. `tabId` and `workspaceId`
must be valid UUIDs. A page URL or title never establishes ownership. Legacy
unscoped mutation endpoints reject managed targets, so they cannot bypass this
check. DOM, script execution, cookies, keystrokes and raw CDP remain outside the
controller API.

`ownership_registry.py` stores mode `0600` receipts in the separate
`maw-neko-controller-state` volume, under a directory initialized as `0700`.
Writes use an exclusive temporary file, file synchronization, atomic replacement
and directory synchronization. No URLs, page content or credentials are written
to these receipts. A digest of Chromium's internal browser WebSocket identity
binds them to one browser instance; the raw endpoint is never returned to MAW.
Concurrent managed operations serialize in the controller.

## Partial failure and restart rules

- The adapter persists the logical tab UUID before requesting target creation.
  The controller persists a creation intent before CDP, then its target receipt
  before responding. Repeated creates for the same live owner reuse its target
  without navigating or focusing it.
- If only the HTTP response was lost, the durable controller receipt allows
  selection or owner-based cleanup to recover the target, even if MAW has no
  `targetRef`. An activation failure retains an already-created handle.
- A crash or timeout between the CDP create side effect and receipt capture is
  inherently ambiguous. The durable operation stays `pending`/`uncertain` and
  subsequent requests return `409`. No automatic retry creates another page,
  and no unknown target is claimed or destroyed by URL/title matching. Operator
  recovery requires resolving the browser incident; a deliberate browser restart
  clears the old instance's ambiguous intents. It interrupts running pages and
  is never performed automatically by the driver.
- A MAW restart starts targets detached. Selection verifies ownership and
  activates the existing target. A controller restart keeps valid receipts.
  A Chromium/container restart changes browser identity and invalidates all old
  receipts, even if a target ID were reused. Logical tabs recreate lazily on
  selection; cookie/profile persistence is independent from target lifetime.
- Authentication failures, transport failures and registry corruption are
  errors, not evidence that a target is absent. They do not authorize replacement
  or destruction. A corrupt registry fails closed rather than reconstructing
  ownership from live page addresses.
- Closure intent and `cleanupRequired` are durable before destruction. Closed
  cleanup tombstones are included on restore. Cleanup is serialized per workspace,
  verifies ownership again, and retries retained receipts without touching
  sibling targets. An uncertain owner lookup retains its tombstone.
- Navigation failures are reported to the client and preserve the last confirmed
  logical address. An offline/unconfigured driver never clears pending cleanup
  by pretending that ownership was disproved. Runtime `ready` means activation
  was acknowledged; it does not mean ChatGPT loaded or completed a response.

## Viewer deployment settings

Compose configures Neko's path prefix as `/api/agency/browser/viewer` (overridable
with `NEKO_SERVER_PATH_PREFIX`) and explicitly enables session cookies. The
multiuser ordinary profile can log in, connect, watch and host for genuine
mouse/keyboard input. It is not an administrator and cannot access clipboard or
share media. The host server uses the ordinary password for the proxied viewer;
the controller bearer token and Neko administrator password are separate secrets.

## Verification on 2026-10-28

The original 39 TypeScript browser tests plus 13 production/driver regressions
pass (52 total), together with 19 Python controller/registry tests and server
typecheck:

```sh
pnpm --filter @agent-workbench/server exec sh -c 'pnpm exec tsx --test src/agency/browser-tabs/*.test.ts'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/neko/controller -p 'test_*.py' -v
pnpm --filter @agent-workbench/server typecheck
```

An isolated real runtime used the pinned Neko image
`m1k1o/neko@sha256:9585af527274b594483af59fee8a97907cbde825c2865bf5e8ef6a8c4381e059`
with Chrome `156.0.8078.47`. It used container
`maw-neko-integration-b1d1p0my`, separate fresh profile/controller volumes,
loopback ports `18085`/`19223`, and freshly generated credentials. Existing
containers, profiles, sessions and credentials were not used. Fixed container
and volume names in the production Compose file were explicitly replaced;
changing only Compose's project name would not provide isolation.

The executable verification command was:

```sh
pnpm --filter @agent-workbench/server exec tsx ../../infra/neko/scripts/verify_managed_runtime.mts /tmp/maw-neko-integration-b1d1p0my/maw-env.json maw-neko-integration-b1d1p0my
```

It passed real managed creation/idempotency, rejection of foreign ownership,
reattachment through a new MAW driver and adapter, persistence through a
controller-only restart, observation of an allowed inventory address, receipt
invalidation through a Chromium-only restart, and owned cleanup. A final live
HTTP check additionally passed owner-based receipt lookup and absence after
confirmed closure. Unit tests cover lost create/close responses, uncertain
intents, corrupt receipts, stale/foreign hints, cleanup across restart, UTF-8
WebSocket fragmentation, upgrade response buffering and ping payloads.

The synthetic background test ran with `NEKO_CONTROLLER_URL`,
`CONTROLLER_AUTH_TOKEN`, `GATEWAY_IP`, and `NEKO_TEST_BIND_ADDRESS` set from this
generated-only fixture, using:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 infra/neko/scripts/test_background_generation.py
```

Only the disposable runtime temporarily allowed its Docker gateway test origin;
the host stream fixture bound to that bridge address. All 10 chunks were received,
7 while the streaming tab was occluded. Production browser policy was restored
and the disposable runtime recreated before UI acceptance. This proves synthetic
background network continuity, not authenticated ChatGPT response completion.
No existing login was used or inspected. Parent integration records cover the
actual proxied WebRTC viewer and mouse/keyboard acceptance separately.

The generated `/tmp` runtime configuration is mode `0600` and is not committed.
After acceptance the owner may remove only the named disposable container,
`maw-neko-integration-b1d1p0my-profile`,
`maw-neko-integration-b1d1p0my-controller`, its matching Compose network and its
temporary directory. Production volumes must remain untouched.
