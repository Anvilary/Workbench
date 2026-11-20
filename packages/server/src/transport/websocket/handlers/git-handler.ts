/**
 * Repository status and diffs, addressed by terminal.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { resolveInside } from '../../../features/files/path-guard.js';
import { readDiff } from '../../../features/git/git-repo.js';
import type { HandlerContext } from '../handler-context.js';

export const gitMessageTypes = [
  'git.subscribe',
  'git.unsubscribe',
  'git.refresh',
  'git.diff',
] as const;

type GitMessage = Extract<ClientMessage, { type: (typeof gitMessageTypes)[number] }>;

export async function handleGitMessage(
  message: GitMessage,
  ctx: HandlerContext<'gitSubscriptions' | 'repos' | 'send' | 'sendError' | 'sendPathError' | 'socket'>,
): Promise<void> {
  const { gitSubscriptions, repos, send, sendError, sendPathError, socket } = ctx;
  switch (message.type) {
    case 'git.subscribe':
      void (async () => {
        // Una segunda suscripcion del mismo socket contaria dos veces en el
        // refcount y el watcher no se apagaria nunca.
        if (gitSubscriptions.has(message.terminalId)) {
          repos.unsubscribe(message.terminalId);
          gitSubscriptions.delete(message.terminalId);
        }
        const status = await repos.subscribe(message.terminalId);
        if (status === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        gitSubscriptions.add(message.terminalId);
        send(socket, { type: 'git.status', terminalId: message.terminalId, status });
      })();
      break;
    case 'git.unsubscribe':
      if (gitSubscriptions.delete(message.terminalId)) {
        repos.unsubscribe(message.terminalId);
      }
      break;
    case 'git.refresh':
      repos.refresh(message.terminalId);
      break;
    case 'git.diff':
      void (async () => {
        const status = repos.getStatus(message.terminalId);
        if (status === null || status.state !== 'ready') {
          sendError(socket, 'read-failed', serverText('gitStatusUnknown'));
          return;
        }
        try {
          // Las rutas del panel son relativas a la raiz del repo, que puede
          // estar por encima del cwd de la pestana. El guardia se aplica
          // contra esa raiz, que es la que git nos dio: sigue siendo un
          // limite del servidor y no del cliente.
          await resolveInside(status.repoRoot, message.path, { mustExist: false });
          const change = status.changes.find((item) => item.path === message.path);
          const diff = await readDiff({
            repoRoot: status.repoRoot,
            relativePath: message.path,
            staged: message.staged,
            untracked: change?.stage === 'untracked',
          });
          send(socket, { type: 'git.diff', terminalId: message.terminalId, diff });
        } catch (error) {
          sendPathError(error, serverText('diffReadFailed'));
        }
      })();
      break;
  }
}
