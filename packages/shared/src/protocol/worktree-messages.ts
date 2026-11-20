/**
 * Worktree messages: separate branches created and reviewed from the app.
 */

import { AGENT_IDS, type AgentId } from '../agents/agents.js';
import { parseGitDiff, type GitDiff } from '../git/git.js';
import {
  WORKTREE_CREATE_MODES,
  asCommitId,
  asUntrackedStamp,
  parseWorktreeChanges,
  parseWorktreeDeleteBranchPlan,
  parseWorktreeInspection,
  parseWorktreeIntegrateOutcome,
  parseWorktreeIntegratePlan,
  parseWorktreeKeptBranch,
  parseWorktreeRemoveOutcome,
  parseWorktreeRemovePlan,
  parseWorktreeReviewPlan,
  parseWorktreeRow,
  parseWorktreeSource,
  type WorktreeChanges,
  type WorktreeCreateMode,
  type WorktreeDeleteBranchPlan,
  type WorktreeInspection,
  type WorktreeIntegrateOutcome,
  type WorktreeIntegratePlan,
  type WorktreeKeptBranch,
  type WorktreeRemoveOutcome,
  type WorktreeRemovePlan,
  type WorktreeReviewPlan,
  type WorktreeRow,
  type WorktreeSource,
} from '../git/worktrees.js';
import type { SessionId, TerminalId } from '../sessions/models.js';
import { asArrayFiltered, asBoolean, asLiteral, asNonEmptyString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Las ramas aparte (`worktree.*`, hito 48, §6.38).
 *
 * **Ningun pedido lleva una ruta** (§2.4): una rama nueva sale de un proyecto
 * de la barra (su `key`) o de una pestana, y una que ya existe se nombra por el
 * id del registro de la app. El servidor arma las carpetas y rehace cada plan
 * antes de escribir. `requestId` vuelve en la respuesta y en el `error`
 * (`worktree-failed`).
 */
export interface ClientWorktreeInspectMessage {
  type: 'worktree.inspect';
  requestId: string;
  source: WorktreeSource;
}

/**
 * Crea la rama aparte y abre ahi una pestana, que llega en un `terminal.opened`
 * con este `requestId`.
 */
export interface ClientWorktreeCreateMessage {
  type: 'worktree.create';
  requestId: string;
  source: WorktreeSource;
  branch: string;
  /** De que rama sale una nueva; con `existing`, contra cual se mira si ya esta integrada. */
  base: string;
  mode: WorktreeCreateMode;
  /** Que CLI se abre. Ausente: la que decide el servidor, como `terminal.open`. */
  agent?: AgentId;
  /** Copiar las instrucciones y la memoria que el repo ignora. */
  copyNotes: boolean;
  /** Lo pone el parser: se pidio una CLI que este lado no conoce. */
  unsupportedAgent?: string;
}

/** El estado de las ramas del repo de una pestana, para Cambios. Contesta `worktree.rows`. */
export interface ClientWorktreeStatusMessage {
  type: 'worktree.status';
  terminalId: TerminalId;
}

export interface ClientWorktreePlanRemoveMessage {
  type: 'worktree.planRemove';
  requestId: string;
  worktreeId: string;
}

export interface ClientWorktreeRemoveMessage {
  type: 'worktree.remove';
  requestId: string;
  worktreeId: string;
  /** "Quitar y perder esos cambios": se pierde lo que la rama cambio en las notas que no se pueden juntar. */
  discardConflicts: boolean;
  /**
   * "Quitar y perder estos archivos" (23-10-2026): la huella de los archivos
   * nuevos que mostro el plan (`WorktreeRemovePlan.untracked`). Si ya no es la
   * misma, el servidor no borra nada; una mal formada cuenta como ausente.
   */
  discardUntracked?: string;
}

/** Vuelve a abrir la rama quitada de una sesion de la barra, y la reanuda. */
export interface ClientWorktreeReopenMessage {
  type: 'worktree.reopen';
  requestId: string;
  agent: AgentId;
  sessionId: SessionId;
}

/**
 * Deja en el cuadro del agente de la rama, sin mandarlo, el pedido de pasar a la
 * carpeta principal las notas que chocaron. Si la rama no tiene pestana, abre
 * una (con este `requestId`).
 */
export interface ClientWorktreeAskNotesMessage {
  type: 'worktree.askNotes';
  requestId: string;
  worktreeId: string;
}

/**
 * Deja en el cuadro del agente de la rama, sin mandarlo, el pedido de
 * commitear lo que tiene sin commit, que no deja quitarla (21-10-2026). Como
 * `worktree.catchUp`: si la rama no tiene pestana, abre una.
 */
export interface ClientWorktreeAskCommitMessage {
  type: 'worktree.askCommit';
  requestId: string;
  worktreeId: string;
}

/**
 * Hito 49. "Ver cambios": lo que trae la rama contra su base (commits y
 * archivos). Contesta `worktree.branchChanges`.
 */
export interface ClientWorktreeChangesMessage {
  type: 'worktree.changes';
  requestId: string;
  worktreeId: string;
}

/**
 * El diff de un archivo de la rama contra su base (`git diff <base>...<rama>`).
 * `path` tiene que ser uno de los que listo `worktree.changes`: el servidor lo
 * comprueba. Contesta `worktree.branchDiff`.
 */
export interface ClientWorktreeChangesDiffMessage {
  type: 'worktree.changesDiff';
  requestId: string;
  worktreeId: string;
  path: string;
}

/** Lo que muestra el dialogo de "Pedir revision". Contesta `worktree.reviewPlan`. No abre nada. */
export interface ClientWorktreePlanReviewMessage {
  type: 'worktree.planReview';
  requestId: string;
  worktreeId: string;
}

/**
 * Abre una pestana de revision en la carpeta de la rama, con esa CLI y en su
 * modo de solo lectura si lo tiene, y le manda el pedido (que arma el servidor)
 * cuando esta lista; si la CLI no avisa cuando esta lista, queda en su cuadro.
 * La pestana llega en un `terminal.opened` con este `requestId`.
 */
export interface ClientWorktreeRequestReviewMessage {
  type: 'worktree.requestReview';
  requestId: string;
  worktreeId: string;
  agent: AgentId;
  /** Lo pone el parser: se pidio una CLI que este lado no conoce. */
  unsupportedAgent?: string;
}

/**
 * Deja en el cuadro de la pestana de la rama, sin mandarlo, la ultima respuesta
 * del revisor con el pedido de arreglar lo que comparta. Si la rama no tiene
 * pestana, abre su sesion mas reciente que no sea de revision.
 */
export interface ClientWorktreeSendReviewMessage {
  type: 'worktree.sendReview';
  requestId: string;
  worktreeId: string;
}

/** Deja en el cuadro de la pestana de la rama, sin mandarlo, el pedido de ponerse al dia con la base. */
export interface ClientWorktreeCatchUpMessage {
  type: 'worktree.catchUp';
  requestId: string;
  worktreeId: string;
}

/** El plan de integrar la rama en su base. Contesta `worktree.integratePlan`. No cambia nada. */
export interface ClientWorktreePlanIntegrateMessage {
  type: 'worktree.planIntegrate';
  requestId: string;
  worktreeId: string;
}

/** Integra: rehace el plan y corre `git merge --ff-only`, nada mas. Contesta `worktree.integrated`. */
export interface ClientWorktreeIntegrateMessage {
  type: 'worktree.integrate';
  requestId: string;
  worktreeId: string;
  /**
   * La punta de la rama que mostro el plan (`WorktreeIntegratePlan.branchCommit`).
   * Si la rama avanzo desde entonces, el servidor no integra nada.
   */
  branchCommit?: string;
}

/**
 * El plan de borrar una rama guardada: una que creo la app, cuya carpeta se
 * quito y que sigue en el repo (20-10-2026). Contesta `worktree.deleteBranchPlan`.
 * No cambia nada.
 */
export interface ClientWorktreePlanDeleteBranchMessage {
  type: 'worktree.planDeleteBranch';
  requestId: string;
  worktreeId: string;
}

/** Borra esa rama: rehace el plan y corre `git branch -d`, nada mas. Contesta `worktree.branchDeleted`. */
export interface ClientWorktreeDeleteBranchMessage {
  type: 'worktree.deleteBranch';
  requestId: string;
  worktreeId: string;
}

/** Lo que el dialogo de crear una rama aparte muestra antes de crear nada (hito 48). */
export interface ServerWorktreeInspectedMessage {
  type: 'worktree.inspected';
  requestId: string;
  inspection: WorktreeInspection;
}

/** Las ramas del repo de una pestana, con su estado, para Cambios. */
export interface ServerWorktreeRowsMessage {
  type: 'worktree.rows';
  terminalId: TerminalId;
  rows: WorktreeRow[];
  /**
   * 20-10-2026. Las ramas que creo la app, sin carpeta y todavia en el repo:
   * Cambios ofrece borrarlas. Un servidor anterior no lo manda.
   */
  kept?: WorktreeKeptBranch[];
}

/**
 * La respuesta a `worktree.planRemove`, y desde el 23-10-2026 también a un
 * `worktree.remove` que otro programa frenó: el plan de ese momento, con quién
 * tiene la carpeta, y nada cambiado.
 */
export interface ServerWorktreeRemovePlanMessage {
  type: 'worktree.removePlan';
  requestId: string;
  plan: WorktreeRemovePlan;
}

export interface ServerWorktreeRemovedMessage {
  type: 'worktree.removed';
  requestId: string;
  worktreeId: string;
  outcome: WorktreeRemoveOutcome;
}

/**
 * Se creo, se quito o se volvio a abrir una rama aparte, y desde el hito 49 se
 * integro una o cambio una revision: Cambios vuelve a preguntar. A todos.
 */
export interface ServerWorktreeChangedMessage {
  type: 'worktree.changed';
}

/** Hito 49. Lo que trae una rama contra su base, para "Ver cambios". */
export interface ServerWorktreeBranchChangesMessage {
  type: 'worktree.branchChanges';
  requestId: string;
  changes: WorktreeChanges;
}

/** El diff de un archivo de la rama contra su base, con los topes del de Cambios. */
export interface ServerWorktreeBranchDiffMessage {
  type: 'worktree.branchDiff';
  requestId: string;
  worktreeId: string;
  diff: GitDiff;
}

export interface ServerWorktreeReviewPlanMessage {
  type: 'worktree.reviewPlan';
  requestId: string;
  plan: WorktreeReviewPlan;
}

export interface ServerWorktreeIntegratePlanMessage {
  type: 'worktree.integratePlan';
  requestId: string;
  plan: WorktreeIntegratePlan;
}

export interface ServerWorktreeIntegratedMessage {
  type: 'worktree.integrated';
  requestId: string;
  worktreeId: string;
  outcome: WorktreeIntegrateOutcome;
}

export interface ServerWorktreeDeleteBranchPlanMessage {
  type: 'worktree.deleteBranchPlan';
  requestId: string;
  plan: WorktreeDeleteBranchPlan;
}

export interface ServerWorktreeBranchDeletedMessage {
  type: 'worktree.branchDeleted';
  requestId: string;
  worktreeId: string;
  branch: string;
}

/** Los pedidos del hito 49 que nombran una rama aparte y nada mas. */
export type WorktreeIdMessageType =
  | 'worktree.changes'
  | 'worktree.planReview'
  | 'worktree.sendReview'
  | 'worktree.catchUp'
  | 'worktree.askCommit'
  | 'worktree.planIntegrate'
  | 'worktree.integrate'
  | 'worktree.planDeleteBranch'
  | 'worktree.deleteBranch';

export function worktreeIdMessage<T extends WorktreeIdMessageType>(
  record: Record<string, unknown>,
  type: T,
): { type: T; requestId: string; worktreeId: string } | null {
  const requestId = asNonEmptyString(record['requestId']);
  const worktreeId = asNonEmptyString(record['worktreeId']);
  return requestId === null || worktreeId === null ? null : { type, requestId, worktreeId };
}

/** Every client message of this family. */
export type ClientWorktreeMessage =
  | ClientWorktreeInspectMessage
  | ClientWorktreeCreateMessage
  | ClientWorktreeStatusMessage
  | ClientWorktreePlanRemoveMessage
  | ClientWorktreeRemoveMessage
  | ClientWorktreeReopenMessage
  | ClientWorktreeAskNotesMessage
  | ClientWorktreeAskCommitMessage
  | ClientWorktreeChangesMessage
  | ClientWorktreeChangesDiffMessage
  | ClientWorktreePlanReviewMessage
  | ClientWorktreeRequestReviewMessage
  | ClientWorktreeSendReviewMessage
  | ClientWorktreeCatchUpMessage
  | ClientWorktreePlanIntegrateMessage
  | ClientWorktreeIntegrateMessage
  | ClientWorktreePlanDeleteBranchMessage
  | ClientWorktreeDeleteBranchMessage;

/** Every server message of this family. */
export type ServerWorktreeMessage =
  | ServerWorktreeInspectedMessage
  | ServerWorktreeRowsMessage
  | ServerWorktreeRemovePlanMessage
  | ServerWorktreeRemovedMessage
  | ServerWorktreeChangedMessage
  | ServerWorktreeBranchChangesMessage
  | ServerWorktreeBranchDiffMessage
  | ServerWorktreeReviewPlanMessage
  | ServerWorktreeIntegratePlanMessage
  | ServerWorktreeIntegratedMessage
  | ServerWorktreeDeleteBranchPlanMessage
  | ServerWorktreeBranchDeletedMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientWorktreeMessage(record: UnknownRecord): ClientWorktreeMessage | null | undefined {
  switch (record['type']) {
    case 'worktree.inspect': {
      const requestId = asNonEmptyString(record['requestId']);
      const source = parseWorktreeSource(record['source']);
      return requestId === null || source === null ? null : { type: 'worktree.inspect', requestId, source };
    }
    case 'worktree.create': {
      const requestId = asNonEmptyString(record['requestId']);
      const source = parseWorktreeSource(record['source']);
      const branch = asNonEmptyString(record['branch']);
      const base = asNonEmptyString(record['base']);
      const mode = asLiteral(record['mode'], WORKTREE_CREATE_MODES);
      const copyNotes = asBoolean(record['copyNotes']);
      if (requestId === null || source === null || branch === null || base === null || mode === null || copyNotes === null) {
        return null;
      }
      const message: ClientWorktreeCreateMessage = { type: 'worktree.create', requestId, source, branch, base, mode, copyNotes };
      // Como `terminal.open`: una CLI que este lado no conoce se conserva para rechazarla.
      const rawAgent = record['agent'];
      if (rawAgent !== undefined && rawAgent !== null) {
        const agent = asLiteral(rawAgent, AGENT_IDS);
        if (agent !== null) message.agent = agent;
        else message.unsupportedAgent = String(rawAgent);
      }
      return message;
    }
    case 'worktree.status': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'worktree.status', terminalId };
    }
    case 'worktree.planRemove': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      return requestId === null || worktreeId === null ? null : { type: 'worktree.planRemove', requestId, worktreeId };
    }
    case 'worktree.remove': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const discardConflicts = asBoolean(record['discardConflicts']);
      if (requestId === null || worktreeId === null || discardConflicts === null) return null;
      const message: ClientWorktreeRemoveMessage = { type: 'worktree.remove', requestId, worktreeId, discardConflicts };
      /*
        Una huella que no es una huella cuenta como ausente: sin ella el servidor
        no borra nada y se niega con este `requestId`. Invalidar el pedido entero
        dejaria al dialogo en "Quitando..." (el `bad-message` no lo lleva).
      */
      const discardUntracked = asUntrackedStamp(record['discardUntracked']);
      return discardUntracked === null ? message : { ...message, discardUntracked };
    }
    case 'worktree.reopen': {
      const requestId = asNonEmptyString(record['requestId']);
      const agent = asLiteral(record['agent'], AGENT_IDS);
      const sessionId = asNonEmptyString(record['sessionId']);
      return requestId === null || agent === null || sessionId === null
        ? null
        : { type: 'worktree.reopen', requestId, agent, sessionId };
    }
    case 'worktree.askNotes': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      return requestId === null || worktreeId === null ? null : { type: 'worktree.askNotes', requestId, worktreeId };
    }
    case 'worktree.changes':
      return worktreeIdMessage(record, 'worktree.changes');
    case 'worktree.planReview':
      return worktreeIdMessage(record, 'worktree.planReview');
    case 'worktree.sendReview':
      return worktreeIdMessage(record, 'worktree.sendReview');
    case 'worktree.catchUp':
      return worktreeIdMessage(record, 'worktree.catchUp');
    case 'worktree.askCommit':
      return worktreeIdMessage(record, 'worktree.askCommit');
    case 'worktree.planIntegrate':
      return worktreeIdMessage(record, 'worktree.planIntegrate');
    case 'worktree.planDeleteBranch':
      return worktreeIdMessage(record, 'worktree.planDeleteBranch');
    case 'worktree.deleteBranch':
      return worktreeIdMessage(record, 'worktree.deleteBranch');
    case 'worktree.integrate': {
      const message = worktreeIdMessage(record, 'worktree.integrate');
      if (message === null || record['branchCommit'] === undefined) return message;
      // Una punta que no es un commit invalida el pedido: integrar sin poder comparar seria integrar a ciegas.
      const branchCommit = asCommitId(record['branchCommit']);
      return branchCommit === null ? null : { ...message, branchCommit };
    }
    case 'worktree.changesDiff': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      // Relativa y con `/`: la valida el servidor contra los archivos de la rama.
      const path = asNonEmptyString(record['path']);
      return requestId === null || worktreeId === null || path === null
        ? null
        : { type: 'worktree.changesDiff', requestId, worktreeId, path };
    }
    case 'worktree.requestReview': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const rawAgent = asNonEmptyString(record['agent']);
      if (requestId === null || worktreeId === null || rawAgent === null) return null;
      // Como `terminal.open`: una CLI que este lado no conoce se conserva para rechazarla.
      const agent = asLiteral(rawAgent, AGENT_IDS);
      const message: ClientWorktreeRequestReviewMessage = { type: 'worktree.requestReview', requestId, worktreeId, agent: agent ?? 'claude-code' };
      if (agent === null) message.unsupportedAgent = rawAgent;
      return message;
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerWorktreeMessage(record: UnknownRecord): ServerWorktreeMessage | null | undefined {
  switch (record['type']) {
    case 'worktree.inspected': {
      const requestId = asNonEmptyString(record['requestId']);
      const inspection = parseWorktreeInspection(record['inspection']);
      return requestId === null || inspection === null ? null : { type: 'worktree.inspected', requestId, inspection };
    }
    case 'worktree.rows': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // Filtrada: una fila que este lado no entiende no se lleva a las demas.
      const rows = asArrayFiltered(record['rows'], parseWorktreeRow);
      if (terminalId === null || rows === null) return null;
      const kept = asArrayFiltered(record['kept'], parseWorktreeKeptBranch);
      return kept === null ? { type: 'worktree.rows', terminalId, rows } : { type: 'worktree.rows', terminalId, rows, kept };
    }
    case 'worktree.removePlan': {
      const requestId = asNonEmptyString(record['requestId']);
      const plan = parseWorktreeRemovePlan(record['plan']);
      return requestId === null || plan === null ? null : { type: 'worktree.removePlan', requestId, plan };
    }
    case 'worktree.removed': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const outcome = parseWorktreeRemoveOutcome(record['outcome']);
      return requestId === null || worktreeId === null || outcome === null
        ? null
        : { type: 'worktree.removed', requestId, worktreeId, outcome };
    }
    case 'worktree.changed':
      return { type: 'worktree.changed' };
    case 'worktree.branchChanges': {
      const requestId = asNonEmptyString(record['requestId']);
      const changes = parseWorktreeChanges(record['changes']);
      return requestId === null || changes === null ? null : { type: 'worktree.branchChanges', requestId, changes };
    }
    case 'worktree.branchDiff': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const diff = parseGitDiff(record['diff']);
      return requestId === null || worktreeId === null || diff === null
        ? null
        : { type: 'worktree.branchDiff', requestId, worktreeId, diff };
    }
    case 'worktree.reviewPlan': {
      const requestId = asNonEmptyString(record['requestId']);
      const plan = parseWorktreeReviewPlan(record['plan']);
      return requestId === null || plan === null ? null : { type: 'worktree.reviewPlan', requestId, plan };
    }
    case 'worktree.integratePlan': {
      const requestId = asNonEmptyString(record['requestId']);
      const plan = parseWorktreeIntegratePlan(record['plan']);
      return requestId === null || plan === null ? null : { type: 'worktree.integratePlan', requestId, plan };
    }
    case 'worktree.integrated': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const outcome = parseWorktreeIntegrateOutcome(record['outcome']);
      return requestId === null || worktreeId === null || outcome === null
        ? null
        : { type: 'worktree.integrated', requestId, worktreeId, outcome };
    }
    case 'worktree.deleteBranchPlan': {
      const requestId = asNonEmptyString(record['requestId']);
      const plan = parseWorktreeDeleteBranchPlan(record['plan']);
      return requestId === null || plan === null ? null : { type: 'worktree.deleteBranchPlan', requestId, plan };
    }
    case 'worktree.branchDeleted': {
      const requestId = asNonEmptyString(record['requestId']);
      const worktreeId = asNonEmptyString(record['worktreeId']);
      const branch = asNonEmptyString(record['branch']);
      return requestId === null || worktreeId === null || branch === null
        ? null
        : { type: 'worktree.branchDeleted', requestId, worktreeId, branch };
    }
    default:
      return undefined;
  }
}
