/**
 * Public API of @anvilary/workbench-shared.
 *
 * This is the only barrel of the package. Everything else lives in the
 * directory that owns it: `protocol/` is the wire contract, the other
 * directories hold the runtime independent domain types and pure logic.
 */

export * from './protocol/index.js';
export * from './protocol/notification-messages.js';
export * from './protocol/server-text.js';

export * from './validation/narrowing.js';

export * from './agents/agent-controls.js';
export * from './agents/agents.js';
export * from './agents/agents-usage.js';
export * from './agents/memory.js';
export * from './agents/permission-modes.js';
export * from './agents/plan-limits.js';

export * from './sessions/composer-draft.js';
export * from './sessions/conversation.js';
export * from './sessions/models.js';
export * from './sessions/pasted-text.js';
export * from './sessions/vault.js';

export * from './workspaces/editor-tabs.js';
export * from './workspaces/project-key.js';
export * from './workspaces/split-layout.js';
export * from './workspaces/tab-order.js';

export * from './browser/browser-profiles.js';
export * from './browser/browser-settings.js';
export * from './browser/browser-tabs.js';

export * from './git/git.js';
export * from './git/worktrees.js';

export * from './files/files.js';
export * from './files/notes.js';
export * from './files/search.js';

export * from './settings/performance.js';
export * from './settings/remote.js';
export * from './settings/settings.js';
export * from './settings/support.js';
