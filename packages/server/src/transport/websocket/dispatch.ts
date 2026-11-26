/**
 * Routes a validated client message to the handler that owns its type.
 *
 * Every handler module exports the list of message types it owns. The route
 * table is built from those lists, a type claimed twice fails at startup, and
 * the compiler fails the build if a `ClientMessage` type has no owner. Routing
 * is the only thing this module does: authorization, parsing and error
 * serialization happen once, in the connection, before a handler runs.
 */

import type { ClientMessage, ClientMessageType } from '@anvilary/workbench-shared';
import type { FullContext } from './handler-context.js';
import { agentInputMessageTypes, handleAgentInputMessage } from './handlers/agent-input-handler.js';
import { agentProfileMessageTypes, handleAgentProfileMessage } from './handlers/agent-profile-handler.js';
import {
  browserProfileMessageTypes,
  handleBrowserProfileMessage,
} from './handlers/browser-profile-handler.js';
import { browserTabMessageTypes, handleBrowserTabMessage } from './handlers/browser-tab-handler.js';
import { composerMessageTypes, handleComposerMessage } from './handlers/composer-handler.js';
import { conversationMessageTypes, handleConversationMessage } from './handlers/conversation-handler.js';
import { editorTabMessageTypes, handleEditorTabMessage } from './handlers/editor-tab-handler.js';
import { fileMessageTypes, handleFileMessage } from './handlers/file-handler.js';
import { gitMessageTypes, handleGitMessage } from './handlers/git-handler.js';
import { handleHistoryMessage, historyMessageTypes } from './handlers/history-handler.js';
import { handleLayoutMessage, layoutMessageTypes } from './handlers/layout-handler.js';
import { handleMemoryMessage, memoryMessageTypes } from './handlers/memory-handler.js';
import { handleNotesMessage, notesMessageTypes } from './handlers/notes-handler.js';
import { handleNotificationMessage, notificationMessageTypes } from './handlers/notification-handler.js';
import { handleRemoteMessage, remoteMessageTypes } from './handlers/remote-handler.js';
import { handleSessionMessage, sessionMessageTypes } from './handlers/session-handler.js';
import { handleSettingsMessage, settingsMessageTypes } from './handlers/settings-handler.js';
import { handleTerminalMessage, terminalMessageTypes } from './handlers/terminal-handler.js';
import { handleVaultMessage, vaultMessageTypes } from './handlers/vault-handler.js';
import { handleWorkspaceMessage, workspaceMessageTypes } from './handlers/workspace-handler.js';
import { handleWorktreeMessage, worktreeMessageTypes } from './handlers/worktree-handler.js';

type MessageOf<T extends readonly ClientMessageType[]> = Extract<ClientMessage, { type: T[number] }>;
type RouteHandler = (message: ClientMessage, ctx: FullContext) => Promise<void>;

interface MessageFamily {
  readonly types: readonly ClientMessageType[];
  readonly handle: RouteHandler;
}

function family<const T extends readonly ClientMessageType[]>(
  types: T,
  handle: (message: MessageOf<T>, ctx: FullContext) => Promise<void>,
): MessageFamily {
  // The route table is keyed by `type`, so the handler only ever sees messages of its own types.
  return { types, handle: handle as unknown as RouteHandler };
}

const FAMILIES: readonly MessageFamily[] = [
  family(terminalMessageTypes, handleTerminalMessage),
  family(agentInputMessageTypes, handleAgentInputMessage),
  family(conversationMessageTypes, handleConversationMessage),
  family(gitMessageTypes, handleGitMessage),
  family(memoryMessageTypes, handleMemoryMessage),
  family(fileMessageTypes, handleFileMessage),
  family(notesMessageTypes, handleNotesMessage),
  family(composerMessageTypes, handleComposerMessage),
  family(historyMessageTypes, handleHistoryMessage),
  family(vaultMessageTypes, handleVaultMessage),
  family(worktreeMessageTypes, handleWorktreeMessage),
  family(settingsMessageTypes, handleSettingsMessage),
  family(remoteMessageTypes, handleRemoteMessage),
  family(workspaceMessageTypes, handleWorkspaceMessage),
  family(browserProfileMessageTypes, handleBrowserProfileMessage),
  family(agentProfileMessageTypes, handleAgentProfileMessage),
  family(sessionMessageTypes, handleSessionMessage),
  family(browserTabMessageTypes, handleBrowserTabMessage),
  family(editorTabMessageTypes, handleEditorTabMessage),
  family(notificationMessageTypes, handleNotificationMessage),
  family(layoutMessageTypes, handleLayoutMessage),
];

type RoutedType =
  | (typeof terminalMessageTypes)[number]
  | (typeof agentInputMessageTypes)[number]
  | (typeof conversationMessageTypes)[number]
  | (typeof gitMessageTypes)[number]
  | (typeof memoryMessageTypes)[number]
  | (typeof fileMessageTypes)[number]
  | (typeof notesMessageTypes)[number]
  | (typeof composerMessageTypes)[number]
  | (typeof historyMessageTypes)[number]
  | (typeof vaultMessageTypes)[number]
  | (typeof worktreeMessageTypes)[number]
  | (typeof settingsMessageTypes)[number]
  | (typeof remoteMessageTypes)[number]
  | (typeof workspaceMessageTypes)[number]
  | (typeof browserProfileMessageTypes)[number]
  | (typeof agentProfileMessageTypes)[number]
  | (typeof sessionMessageTypes)[number]
  | (typeof browserTabMessageTypes)[number]
  | (typeof editorTabMessageTypes)[number]
  | (typeof notificationMessageTypes)[number]
  | (typeof layoutMessageTypes)[number];

/** Compile time proof that every client message type has a handler. */
export const EVERY_CLIENT_MESSAGE_TYPE_IS_ROUTED: [Exclude<ClientMessageType, RoutedType>] extends [never] ? true : never = true;

const routes = new Map<string, RouteHandler>();
for (const { types, handle } of FAMILIES) {
  for (const type of types) {
    if (routes.has(type)) throw new Error(`message type ${type} is routed twice`);
    routes.set(type, handle);
  }
}

/** The message types this dispatcher knows, for tests. */
export function routedMessageTypes(): ReadonlySet<string> {
  return new Set(routes.keys());
}

export async function dispatchClientMessage(message: ClientMessage, ctx: FullContext): Promise<void> {
  await routes.get(message.type)?.(message, ctx);
}
