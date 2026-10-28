import { EMPTY_CONTEXT_USAGE } from '@agent-workbench/shared';
import type { SessionFollower } from './adapter.js';
/** Live native PTY stays usable when its historical account namespace is unverified. */
export function unavailableFollower(): SessionFollower {
  return {
    label: 'Native history unavailable: unverified identity', sourcePath: null,
    async start() {}, async poll() { return { reset: false, added: [], turns: [], plans: [], parts: [] }; },
    getState: () => 'waiting', getUsage: () => ({ ...EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], hasOpenToolCall: () => false, async readImage() { return null; }, noticeChange: () => false,
  };
}
