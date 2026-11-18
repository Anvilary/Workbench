# Module Boundaries

Each package owns a clear set of runtime responsibilities and internal layers (`shared/`, `features/`, and legacy/domain orchestration modules under `src/`).

## `@agent-workbench/shared`

- Pure TypeScript types, message codecs, URL validators (`browser-tabs.ts`), layout math, and narrowing helpers (`validation.ts`).
- Must stay runtime-agnostic: zero Node.js `fs`/`child_process` imports, zero React imports, and zero Electron imports.

## `@agent-workbench/server`

- **Shared Foundations (`src/shared/`)**:
  - `concurrency/serial-queue.ts`: FIFO `SerialQueue` isolating failed operations while keeping queue continuity.
  - `errors/domain-error.ts`: `DomainError` and `UnsupportedSchemaVersionError`.
  - `persistence/versioned-json-store.ts`: `loadWithBackupRecovery` and `writeSnapshotWithBackup` with quarantine on corrupt primaries and fail-closed schema checks.
  - `validation/primitives.ts`: `isRecord`, `isValidUuid`, `isIsoUtcTimestamp`, `isValidTimestamp`, `isNullableTimestamp`, `isPrintableName`, `isCanonicalAbsolutePath`, `isValidRequestId`.
- **Feature Barrels (`src/features/`)**:
  - `workspaces/`, `sessions/`, `agents/`, `settings/` establish clean entry modules as domain logic is migrated out of central handlers.
- **Core Runtime & Persistence (`src/agency/`, `src/pty-host/`, `src/agents/`)**:
  - Authoritative state stores (`agency-layout-store.ts`, `browser-tab-store.ts`, `editor-tab-store.ts`, `agency-profile-store.ts`, `agency-session-store.ts`).
  - Persistent PTY supervisor (`src/pty-host/maw-ptyd.mjs`) separated cleanly from Express/WebSocket request routing (`src/index.ts`).

## `@agent-workbench/web`

- **Shared UI & Hooks (`src/shared/`)**:
  - `ui/`: Generic primitives (`ModalDialog.tsx`, `ConfirmDialog.tsx`, `InlineRenameInput.tsx`, `StatusDot.tsx`, `BannerNotice.tsx`).
  - `hooks/`: Generic focus and keyboard helpers (`useFocusTrap.ts`, `useEscapeKey.ts`, `useMenuKeyboardNav.ts`).
  - `lib/`: Pure viewport positioning (`overlay-position.ts`).
- **Feature Modules (`src/features/`)**:
  - `settings/`: Sectioned settings panels (`sections/{About,Agents,General,Panels,Terminal}SettingsSection.tsx`), `SettingsIcons.tsx`, `version-info.ts`, `settings-search.ts`.
  - `workspaces/`: `AgencyDoneView.tsx`, `DeleteWorkspaceDialog.tsx`, `SidebarConfirmDialogs.tsx`, `SidebarDropdownMenu.tsx`, `WorkspaceSessionDialogs.tsx`, `workspace-tab-helpers.ts`.
  - `browser/`: `useBrowserZoomShortcuts.ts`, `useNativeWebTabLinks.ts`.
  - `panes/`: `TabStatusIcon.tsx`, `useHorizontalWheelScroll.ts`, `useTabPointerDrag.ts`.
  - `terminals/`, `agents/`, `editor/`: Feature barrels for ongoing extraction.
- **Top-Level Compositions (`src/SettingsDialog.tsx`, `src/agency/AgencyWorkspaceView.tsx`, `src/agency/AgencySidebar.tsx`, `src/agency/split/PaneHeader.tsx`)**:
  - Compose feature modules while preserving public exports and avoiding component remounts.

## `@agent-workbench/desktop`

- Trusted Electron main process (`main.mjs`) and loopback/browser policy validator (`policy.mjs`).
- Focused native modules under `src/`:
  - `security/oauth-loopback.mjs`: `isOAuthLoopbackCallback`
  - `security/session-permissions.mjs`: `configureBrowserSessionPermissions`, `isDurableProviderPage`
  - `ipc/backend-readiness.mjs`: `discoverBackendReadiness`
  - `browser/zoom-controller.mjs`: `applyWebContentsZoom`
