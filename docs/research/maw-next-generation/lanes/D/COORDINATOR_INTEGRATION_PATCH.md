# Lane D: Coordinator Integration Patch & Specification

This document provides the minimal, revision-safe integration patch and specifications for the integration coordinator to wire Lane D's performance optimizations into the shared server entrypoints (`index.ts`, `terminal-socket.ts`, `package.json`, and service units).

Per Lane D's file ownership boundaries, these shared files were **not** modified directly on `feat/maw-performance`. The helper modules (`classic-workbench-lifecycle.ts`, `terminal-output-batcher.ts`, `coalesced-json-store.ts`, `build-bundle.mjs`) have been fully implemented, unit-tested, and benchmarked.

---

## 1. Minimal Diff for `packages/server/src/index.ts`

### Target: Lazy Classic Workbench Initialization (Item D1)

Replace eager initialization of `index.start()`, `vault.start()`, and `watchSessions()` with `ClassicWorkbenchLifecycle`.

```diff
--- a/packages/server/src/index.ts
+++ b/packages/server/src/index.ts
@@ -52,6 +52,7 @@ import { SettingsStore } from './settings-store.js';
 import { SessionIndex } from './session-index.js';
 import { watchSessions } from './session-watcher.js';
+import { ClassicWorkbenchLifecycle } from './classic-workbench-lifecycle.js';
 import { VaultCatalog } from './vault/catalog.js';
 import { defaultVaultDir } from './vault/paths.js';
 import { VaultService } from './vault/service.js';
@@ -403,7 +404,6 @@ async function main(): Promise<void> {
   const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
   const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });
-  vault.start();
   const registry = new TerminalRegistry(
     agents,
     shell,
@@ -470,6 +470,14 @@ async function main(): Promise<void> {
   const memory = new MemoryHub(registry);
   const pasteStore = new PasteStore();

+  // Lazy Classic Workbench lifecycle coordinator (Lane D)
+  const classicLifecycle = new ClassicWorkbenchLifecycle({
+    index,
+    vault,
+    conversations,
+    agents,
+  });
+
   const app = express();
   app.disable('x-powered-by');

@@ -593,6 +601,7 @@ async function main(): Promise<void> {
     appSettings,
     registry,
     index,
+    classicLifecycle,
     archived,
     notes,
     drafts,
@@ -617,10 +626,6 @@ async function main(): Promise<void> {
   void pasteStore.purgeStale();

-  void index.start();
-  const stopWatching = watchSessions(index, conversations, agents);
-  conversations.on('historyGrew', (agent, filePath) => void index.refreshPath(agent, filePath));
-
   /*
     Las pestanas del arranque anterior tambien van en segundo plano: relanzar
     varias sesiones lleva su tiempo y la UI las va viendo aparecer.
@@ -677,6 +682,7 @@ async function main(): Promise<void> {
   const shutdown = async (): Promise<void> => {
     if (shuttingDown) return;
     shuttingDown = true;
+    classicLifecycle.dispose();
     vault.dispose();
     stopWatching();
     await closeUi();
```

---

## 2. Minimal Specification & Diff for `packages/server/src/terminal-socket.ts`

### Target: Output Micro-Batching (Item D3) & Lazy Classic Activation

In `attachTerminalSocket`:
1. Use `TerminalOutputBatcher` inside the per-socket listener to coalesce PTY output.
2. Flush the batcher immediately before sending `terminal.exit` or on socket closure.
3. Trigger `classicLifecycle.ensureStarted()` whenever a non-Agency client connects or sends classic messages (`index.*`, `session.*`, `vault.*`).

```diff
--- a/packages/server/src/terminal-socket.ts
+++ b/packages/server/src/terminal-socket.ts
@@ -128,6 +128,7 @@ import type { SessionIndex } from './session-index.js';
 import type { VaultService } from './vault/service.js';
 import type { WorktreeService } from './worktree-service.js';
+import { TerminalOutputBatcher } from './terminal-output-batcher.js';
+import type { ClassicWorkbenchLifecycle } from './classic-workbench-lifecycle.js';

 export interface TerminalSocketOptions {
   readonly httpServer: HttpServer;
@@ -155,6 +156,7 @@ export interface TerminalSocketOptions {
   readonly defaultCwd: string;
   readonly vault: VaultService;
   readonly remote: RemoteAccessService;
   readonly worktrees: WorktreeService;
   readonly noAuth?: boolean;
+  readonly classicLifecycle?: ClassicWorkbenchLifecycle;
 }

@@ -1141,8 +1143,15 @@ export function attachTerminalSocket(options: TerminalSocketOptions): () => void {
     });
+    const outputBatcher = new TerminalOutputBatcher({
+      maxWaitMs: 2,
+      maxBatchBytes: 64 * 1024,
+      onFlush: (tId, data) => {
+        send(socket, { type: 'terminal.output', terminalId: tId, data });
+      },
+    });
+
     const listener: OutputListener = (terminalId, chunk) => {
-      if (backpressure.shouldSend(terminalId)) send(socket, { type: 'terminal.output', terminalId, data: chunk });
+      if (backpressure.shouldSend(terminalId)) outputBatcher.push(terminalId, chunk);
     };

@@ -1155,6 +1164,7 @@ export function attachTerminalSocket(options: TerminalSocketOptions): () => void {
     socket.on('close', () => {
+      outputBatcher.dispose();
       registry.detach(listener);
     });
```

---

## 3. Production Build & Launcher Configuration (Item D2)

### 3.1 `packages/server/package.json`
Add script to build the production bundle:
```json
"scripts": {
  "build:bundle": "node scripts/build-bundle.mjs",
  "build": "pnpm run build:bundle"
}
```

### 3.2 `scripts/maw/maw-render-unit.sh` / `scripts/maw/maw.service`
Update production unit template to run prebuilt `dist/index.mjs` directly with `node`:

```diff
--- a/scripts/maw/maw-render-unit.sh
+++ b/scripts/maw/maw-render-unit.sh
@@ -35,7 +35,7 @@ Type=exec
 WorkingDirectory=${MAW_ROOT}
 Environment=PATH=${MAW_BIN_DIR}:/usr/local/bin:/usr/bin:/bin
 Environment=NODE_ENV=production
-ExecStart=/usr/bin/env npx tsx packages/server/src/index.ts --prod
+ExecStart=/usr/bin/env node packages/server/dist/index.mjs --prod
 Restart=on-failure
 RestartSec=1s
```

### 3.3 Rollback Mechanism
If rollback is required, `MAW_EAGER_CLASSIC=1` can be exported to restore eager classic startup without code changes. Furthermore, executing `npx tsx packages/server/src/index.ts --prod` remains 100% compatible and functions identically.
