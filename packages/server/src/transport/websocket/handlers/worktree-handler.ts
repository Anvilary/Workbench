/**
 * Separate branches created and reviewed from the app.
 */

import { serverText, type ClientMessage, type TerminalId } from '@anvilary/workbench-shared';
import { deliverWhenReady, prefillReasonFor } from '../../../features/composer/deliver-when-ready.js';
import { HANDOFF_DELIVERY_TIMEOUT_MS } from '../../../features/history/handoff.js';
import { WorktreeInUseError } from '../../../features/worktrees/service.js';
import { debugLog } from '../../../shared/debug.js';
import type { HandlerContext } from '../handler-context.js';

export const worktreeMessageTypes = [
  'worktree.inspect',
  'worktree.create',
  'worktree.status',
  'worktree.planRemove',
  'worktree.remove',
  'worktree.reopen',
  'worktree.askNotes',
  'worktree.changes',
  'worktree.changesDiff',
  'worktree.planReview',
  'worktree.requestReview',
  'worktree.sendReview',
  'worktree.catchUp',
  'worktree.askCommit',
  'worktree.planIntegrate',
  'worktree.integrate',
  'worktree.planDeleteBranch',
  'worktree.deleteBranch',
] as const;

type WorktreeMessage = Extract<ClientMessage, { type: (typeof worktreeMessageTypes)[number] }>;

export async function handleWorktreeMessage(
  message: WorktreeMessage,
  ctx: HandlerContext<'adapterOf' | 'deliverDeps' | 'dropTab' | 'registry' | 'send' | 'sendError' | 'sendWorktreeError' | 'socket' | 'worktrees'>,
): Promise<void> {
  const { adapterOf, deliverDeps, dropTab, registry, send, sendError, sendWorktreeError, socket, worktrees } = ctx;
  switch (message.type) {
    /*
      Las ramas aparte (hito 48, §6.38). Ningun pedido trae una ruta: el
      servicio arma las carpetas, y crear y quitar rehacen lo que se mostro
      antes de escribir. Desde un equipo remoto, lo mismo que en la PC
      (decision 5 del plan): ya puede abrir pestanas y guardar archivos.
    */
    case 'worktree.inspect': {
      const { requestId, source } = message;
      void worktrees.inspect(source).then(
        (inspection) => send(socket, { type: 'worktree.inspected', requestId, inspection }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.create': {
      const { requestId } = message;
      if (message.unsupportedAgent !== undefined) {
        sendError(socket, 'agent-unsupported', serverText('agentUnknown'), message.unsupportedAgent, requestId);
        break;
      }
      void worktrees
        .create({
          source: message.source,
          branch: message.branch,
          base: message.base,
          mode: message.mode,
          copyNotes: message.copyNotes,
          ...(message.agent !== undefined ? { agent: message.agent } : {}),
        })
        .then(
          (terminal) => send(socket, { type: 'terminal.opened', requestId, terminal }),
          (error: unknown) => sendWorktreeError(socket, error, requestId),
        );
      break;
    }
    case 'worktree.status': {
      const { terminalId } = message;
      // Con las ramas guardadas (20-10-2026): las que creo la app, sin carpeta y todavia en el repo.
      void Promise.all([worktrees.rows(terminalId), worktrees.keptBranches(terminalId)]).then(
        ([rows, kept]) => send(socket, { type: 'worktree.rows', terminalId, rows, ...(kept.length > 0 ? { kept } : {}) }),
        (error: unknown) => sendWorktreeError(socket, error),
      );
      break;
    }
    case 'worktree.planRemove': {
      const { requestId, worktreeId } = message;
      void worktrees.planRemove(worktreeId).then(
        (plan) => send(socket, { type: 'worktree.removePlan', requestId, plan }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.remove': {
      const { requestId, worktreeId, discardConflicts } = message;
      // Las pestanas de la rama se cierran como desde la barra, soltando todo lo que las seguia.
      const closeTab = (terminalId: TerminalId): void => void dropTab(terminalId);
      void worktrees.remove(worktreeId, discardConflicts, closeTab, message.discardUntracked ?? null).then(
        (outcome) => send(socket, { type: 'worktree.removed', requestId, worktreeId, outcome }),
        // Otro programa tiene la carpeta: el plan otra vez, que dice cuál (23-10-2026).
        (error: unknown) =>
          error instanceof WorktreeInUseError
            ? send(socket, { type: 'worktree.removePlan', requestId, plan: error.plan })
            : sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.reopen': {
      const { requestId } = message;
      void worktrees.reopen(message.agent, message.sessionId).then(
        (terminal) => send(socket, { type: 'terminal.opened', requestId, terminal }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.askNotes': {
      const { requestId, worktreeId } = message;
      void worktrees.notesRequest(worktreeId).then(
        ({ terminal, opened, text }) => {
          if (opened) send(socket, { type: 'terminal.opened', requestId, terminal });
          send(socket, { type: 'composer.prefill', terminalId: terminal.terminalId, text, reason: 'requested', requestId });
        },
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    /*
      Hito 49: trabajar como un equipo. Ver lo que trae una rama, pedirle la
      revision a otra CLI, pasarle la respuesta al autor, ponerse al dia e
      integrar. Ninguno trae una ruta salvo `changesDiff`, que nombra un
      archivo de los que listo el servidor y el servicio lo comprueba.
    */
    case 'worktree.changes': {
      const { requestId, worktreeId } = message;
      void worktrees.changes(worktreeId).then(
        (changes) => send(socket, { type: 'worktree.branchChanges', requestId, changes }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.changesDiff': {
      const { requestId, worktreeId } = message;
      void worktrees.changesDiff(worktreeId, message.path).then(
        (diff) => send(socket, { type: 'worktree.branchDiff', requestId, worktreeId, diff }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.planReview': {
      const { requestId, worktreeId } = message;
      void worktrees.planReview(worktreeId).then(
        (plan) => send(socket, { type: 'worktree.reviewPlan', requestId, plan }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    /*
      La pestana del revisor llega con `terminal.opened` y este `requestId`,
      y despues el pedido, como una continuacion (§6.18): se manda solo si
      la CLI avisa cuando esta lista (decision 5: solo lee); si no, queda en
      su cuadro y lo manda el usuario. Nunca las dos cosas.
    */
    case 'worktree.requestReview': {
      const { requestId, worktreeId } = message;
      if (message.unsupportedAgent !== undefined) {
        sendError(socket, 'agent-unsupported', serverText('agentUnknown'), message.unsupportedAgent, requestId);
        break;
      }
      void (async () => {
        let opened;
        try {
          opened = await worktrees.requestReview(worktreeId, message.agent);
        } catch (error) {
          sendWorktreeError(socket, error, requestId);
          return;
        }
        const { terminal, prompt } = opened;
        const { terminalId } = terminal;
        send(socket, { type: 'terminal.opened', requestId, terminal });
        if (adapterOf(terminalId)?.capabilities.readySignal !== true) {
          send(socket, { type: 'composer.prefill', terminalId, text: prompt, reason: 'requested', requestId });
          return;
        }
        const delivered = await deliverWhenReady(deliverDeps, {
          terminalId,
          text: prompt,
          images: [],
          timeoutMs: HANDOFF_DELIVERY_TIMEOUT_MS,
          write: (piece) => registry.write(terminalId, piece),
        });
        const reason = prefillReasonFor(delivered);
        if (reason !== null) {
          debugLog('worktrees', `review not sent on its own to ${terminalId.slice(0, 8)}: ${delivered.kind}`);
          send(socket, { type: 'composer.prefill', terminalId, text: prompt, reason });
        }
      })();
      break;
    }
    // Lo que se le deja al autor de la rama: queda en su cuadro, sin mandar, y lo manda el usuario.
    case 'worktree.sendReview':
    case 'worktree.catchUp':
    case 'worktree.askCommit': {
      const { requestId, worktreeId } = message;
      const asked =
        message.type === 'worktree.sendReview'
          ? worktrees.sendReview(worktreeId)
          : message.type === 'worktree.catchUp'
            ? worktrees.catchUp(worktreeId)
            : worktrees.commitRequest(worktreeId);
      void asked.then(
        ({ terminal, opened, text, pasted }) => {
          if (opened) send(socket, { type: 'terminal.opened', requestId, terminal });
          send(socket, {
            type: 'composer.prefill',
            terminalId: terminal.terminalId,
            text,
            reason: 'requested',
            requestId,
            ...(pasted.length > 0 ? { pasted } : {}),
          });
        },
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.planIntegrate': {
      const { requestId, worktreeId } = message;
      void worktrees.planIntegrate(worktreeId).then(
        (plan) => send(socket, { type: 'worktree.integratePlan', requestId, plan }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.integrate': {
      const { requestId, worktreeId } = message;
      void worktrees.integrate(worktreeId, message.branchCommit).then(
        (outcome) => send(socket, { type: 'worktree.integrated', requestId, worktreeId, outcome }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    // Borrar una rama guardada (20-10-2026): primero el plan, y al confirmar el servidor lo rehace.
    case 'worktree.planDeleteBranch': {
      const { requestId, worktreeId } = message;
      void worktrees.planDeleteBranch(worktreeId).then(
        (plan) => send(socket, { type: 'worktree.deleteBranchPlan', requestId, plan }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
    case 'worktree.deleteBranch': {
      const { requestId, worktreeId } = message;
      void worktrees.deleteKeptBranch(worktreeId).then(
        ({ branch }) => send(socket, { type: 'worktree.branchDeleted', requestId, worktreeId, branch }),
        (error: unknown) => sendWorktreeError(socket, error, requestId),
      );
      break;
    }
  }
}
