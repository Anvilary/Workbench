/**
 * WebSocket protocol between the browser and the local server.
 *
 * The wire contract is split by message family. Each `<family>-messages.ts`
 * owns the types, constants and parsers of one family; this module assembles
 * the `ClientMessage` and `ServerMessage` unions, dispatches parsing to the
 * owning family and encodes outgoing messages. See `constants.ts` for the
 * version history of the contract.
 */

import { asRecord, parseJson } from '../validation/narrowing.js';
import {
  type AgencyClientMessage,
  type AgencyServerMessage,
  parseAgencyClientMessage,
  parseAgencyServerMessage,
} from './agency-messages.js';
import {
  type ClientAgentMessage,
  type ServerAgentMessage,
  parseClientAgentMessage,
  parseServerAgentMessage,
} from './agent-messages.js';
import {
  type ClientComposerMessage,
  type ServerComposerMessage,
  parseClientComposerMessage,
  parseServerComposerMessage,
} from './composer-messages.js';
import {
  type ClientConnectionMessage,
  type ServerConnectionMessage,
  parseClientConnectionMessage,
  parseServerConnectionMessage,
} from './connection-messages.js';
import {
  type ClientConversationMessage,
  type ServerConversationMessage,
  parseClientConversationMessage,
  parseServerConversationMessage,
} from './conversation-messages.js';
import {
  type ClientFileMessage,
  type ServerFileMessage,
  parseClientFileMessage,
  parseServerFileMessage,
} from './file-messages.js';
import {
  type ClientGitMessage,
  type ServerGitMessage,
  parseClientGitMessage,
  parseServerGitMessage,
} from './git-messages.js';
import {
  type ClientHistoryMessage,
  type ServerHistoryMessage,
  parseClientHistoryMessage,
  parseServerHistoryMessage,
} from './history-messages.js';
import {
  type ClientMemoryMessage,
  type ServerMemoryMessage,
  parseClientMemoryMessage,
  parseServerMemoryMessage,
} from './memory-messages.js';
import {
  type ClientNoteMessage,
  type ServerNoteMessage,
  parseClientNoteMessage,
  parseServerNoteMessage,
} from './note-messages.js';
import {
  type ClientPickerMessage,
  type ServerPickerMessage,
  parseClientPickerMessage,
  parseServerPickerMessage,
} from './picker-messages.js';
import {
  type ClientRemoteMessage,
  type ServerRemoteMessage,
  parseClientRemoteMessage,
  parseServerRemoteMessage,
} from './remote-messages.js';
import {
  type ClientSettingsMessage,
  type ServerSettingsMessage,
  parseClientSettingsMessage,
  parseServerSettingsMessage,
} from './settings-messages.js';
import {
  type ClientTerminalMessage,
  type ServerTerminalMessage,
  parseClientTerminalMessage,
  parseServerTerminalMessage,
} from './terminal-messages.js';
import {
  type ClientVaultMessage,
  type ServerVaultMessage,
  parseClientVaultMessage,
  parseServerVaultMessage,
} from './vault-messages.js';
import {
  type ClientWorktreeMessage,
  type ServerWorktreeMessage,
  parseClientWorktreeMessage,
  parseServerWorktreeMessage,
} from './worktree-messages.js';

export * from './agency-messages.js';
export {
MAX_SUBMIT_FILES,MAX_SUBMIT_FILE_BYTES,MAX_SUBMIT_IMAGES,MAX_SUBMIT_IMAGE_BYTES,REWIND_RESTORES
} from './agent-messages.js';
export type {
AnswerSelection,
ClientAnswerMessage,ClientEditQueueMessage,ClientForceSendMessage,ClientInterruptMessage,ClientPermissionModeMessage,ClientRewindMessage,ClientSubmitMessage,
FreeTextSelection,RewindRestore,ServerAgentForceSentMessage,
ServerAgentQueueEditedMessage,ServerAgentRewoundMessage,ServerAgentSubmittedMessage,SubmitFile,SubmitImage
} from './agent-messages.js';
export {
COMPOSER_PREFILL_REASONS
} from './composer-messages.js';
export type {
ClientComposerDraftMessage,ComposerDraftEntry,ComposerPrefillReason,ServerComposerDraftsMessage,ServerComposerPrefillMessage
} from './composer-messages.js';
export {
SERVER_ERROR_CODES
} from './connection-messages.js';
export type {
ClientAgentsRefreshMessage,ServerAgentsMessage,
ServerErrorCode,
ServerErrorMessage,ServerHelloMessage
} from './connection-messages.js';
export {
PROTOCOL_VERSION,TOKEN_QUERY_PARAM,WS_PATH
} from './constants.js';
export type {
ClientConversationImageMessage,ClientLoadMoreConversationMessage,ClientReadPlanMessage,ClientSubscribeConversationMessage,
ClientUnsubscribeConversationMessage,ServerConversationAppendMessage,ServerConversationImageMessage,ServerConversationLiveQuestionMessage,ServerConversationModeMessage,ServerConversationPageMessage,ServerConversationPartsMessage,ServerConversationPlansMessage,ServerConversationQueueMessage,ServerConversationResetMessage,ServerConversationStateMessage,ServerConversationSubagentsMessage,
ServerConversationToolCallMessage,
ServerConversationTurnsMessage,ServerConversationWaitingMessage,ServerPlanContentMessage
} from './conversation-messages.js';
export {
FILES_CHECK_MAX_PATHS,
FILES_CHECK_MAX_PATH_CHARS,
FILE_SAVE_OUTCOMES
} from './file-messages.js';
export type {
ClientCheckFilesMessage,ClientListFilesMessage,ClientReadFileMessage,ClientRevealFileMessage,ClientSearchFilesMessage,ClientWriteFileMessage,FileSaveOutcome,ServerFilePreviewMessage,ServerFileSavedMessage,
ServerFileSearchMessage,ServerFilesCheckedMessage,ServerFilesListingMessage
} from './file-messages.js';
export type {
ClientGitDiffMessage,ClientRefreshGitMessage,ClientSubscribeGitMessage,
ClientUnsubscribeGitMessage,ServerGitDiffMessage,ServerGitStatusMessage
} from './git-messages.js';
export {
CONTINUE_LABEL_MAX_CHARS,
HANDOFF_DELIVERIES
} from './history-messages.js';
export type {
ClientArchiveSessionsMessage,ClientCancelGlobalSearchMessage,ClientContinueSessionMessage,
ClientGlobalSearchMessage,ClientRefreshIndexMessage,HandoffDelivery,ServerGlobalSearchMessage,ServerGlobalSearchProgressMessage,ServerIndexProjectsMessage,ServerIndexStatusMessage,ServerSessionContinuedMessage
} from './history-messages.js';
export type {
ClientMemoryImportMessage,ClientMemoryInstallMessage,ClientMemoryPlanMessage,ClientMemoryReadMessage,ClientMemorySubscribeMessage,
ClientMemoryUnsubscribeMessage,ServerMemoryContentMessage,ServerMemoryImportedMessage,ServerMemoryInstalledMessage,ServerMemoryPlannedMessage,ServerMemoryStatusMessage
} from './memory-messages.js';
export type {
ClientAddNoteImageMessage,ClientCreateNoteMessage,ClientDeleteNoteMessage,ClientNoteImageMessage,ClientRemoveNoteImageMessage,ClientSendNoteMessage,ClientUpdateNoteMessage,ServerNoteImageMessage,ServerNotesListMessage
} from './note-messages.js';
export type {
ClientPickerCloseMessage,ClientPickerCreateMessage,ClientPickerEnterMessage,ClientPickerOpenMessage,ClientPickerRootMessage,ServerPickerListingMessage
} from './picker-messages.js';
export type {
ClientRemoteConfigureMessage,ClientRemoteDeviceForgetSelfMessage,ClientRemoteDeviceRenameMessage,
ClientRemoteDeviceRevokeMessage,ClientRemotePairingCancelMessage,ClientRemotePairingStartMessage,ClientRemotePhoneCancelMessage,ClientRemotePhoneStartMessage,ServerRemotePairingCodeMessage,
ServerRemotePhonePairingMessage,ServerRemoteStatusMessage
} from './remote-messages.js';
export type {
ClientAgentsUsageGetMessage,ClientSettingsUpdateMessage,ServerAgentsUsageFailedMessage,ServerAgentsUsageSnapshotMessage,ServerPlanLimitsMessage,ServerSettingsStatusMessage
} from './settings-messages.js';
export type {
ClientAttachTerminalMessage,ClientCloseTerminalMessage,ClientDetachTerminalMessage,ClientInputMessage,ClientOpenTerminalMessage,ClientRenameTerminalMessage,
ClientReorderTabsMessage,ClientResizeMessage,ClientTerminalHistoryPageMessage,ClientWakeTerminalMessage,ServerTerminalActivityMessage,ServerTerminalClosedMessage,ServerTerminalExitMessage,ServerTerminalHistoryDataMessage,
ServerTerminalHistoryErrorMessage,ServerTerminalListMessage,
ServerTerminalOpenedMessage,
ServerTerminalOutputMessage,
ServerTerminalReplayMessage
} from './terminal-messages.js';
export type {
ClientVaultEnableMessage,ClientVaultExportProjectMessage,ClientVaultMeasureMessage,ClientVaultOpenSessionMessage,
ClientVaultRevealMessage,ClientVaultSetDirMessage,ServerVaultExportedMessage,ServerVaultStatusMessage
} from './vault-messages.js';
export type {
ClientWorktreeAskCommitMessage,ClientWorktreeAskNotesMessage,ClientWorktreeCatchUpMessage,ClientWorktreeChangesDiffMessage,ClientWorktreeChangesMessage,ClientWorktreeCreateMessage,ClientWorktreeDeleteBranchMessage,ClientWorktreeInspectMessage,ClientWorktreeIntegrateMessage,
ClientWorktreePlanDeleteBranchMessage,ClientWorktreePlanIntegrateMessage,ClientWorktreePlanRemoveMessage,ClientWorktreePlanReviewMessage,ClientWorktreeRemoveMessage,
ClientWorktreeReopenMessage,ClientWorktreeRequestReviewMessage,
ClientWorktreeSendReviewMessage,ClientWorktreeStatusMessage,ServerWorktreeBranchChangesMessage,ServerWorktreeBranchDeletedMessage,ServerWorktreeBranchDiffMessage,ServerWorktreeChangedMessage,ServerWorktreeDeleteBranchPlanMessage,ServerWorktreeInspectedMessage,ServerWorktreeIntegratePlanMessage,
ServerWorktreeIntegratedMessage,ServerWorktreeRemovePlanMessage,
ServerWorktreeRemovedMessage,ServerWorktreeReviewPlanMessage,ServerWorktreeRowsMessage
} from './worktree-messages.js';

/** Every message the browser can send. */
export type ClientMessage =
  | ClientTerminalMessage
  | ClientAgentMessage
  | ClientHistoryMessage
  | ClientConversationMessage
  | ClientGitMessage
  | ClientFileMessage
  | ClientNoteMessage
  | ClientPickerMessage
  | ClientConnectionMessage
  | ClientMemoryMessage
  | ClientVaultMessage
  | ClientRemoteMessage
  | ClientSettingsMessage
  | ClientComposerMessage
  | ClientWorktreeMessage
  | AgencyClientMessage;

export type ClientMessageType = ClientMessage['type'];

/** Every message the server can send. */
export type ServerMessage =
  | ServerTerminalMessage
  | ServerAgentMessage
  | ServerHistoryMessage
  | ServerConversationMessage
  | ServerGitMessage
  | ServerFileMessage
  | ServerNoteMessage
  | ServerPickerMessage
  | ServerConnectionMessage
  | ServerMemoryMessage
  | ServerVaultMessage
  | ServerRemoteMessage
  | ServerSettingsMessage
  | ServerComposerMessage
  | ServerWorktreeMessage
  | AgencyServerMessage;

export type ServerMessageType = ServerMessage['type'];

const CLIENT_FAMILY_PARSERS = [
  parseClientTerminalMessage,
  parseClientAgentMessage,
  parseClientHistoryMessage,
  parseClientConversationMessage,
  parseClientGitMessage,
  parseClientFileMessage,
  parseClientNoteMessage,
  parseClientPickerMessage,
  parseClientConnectionMessage,
  parseClientMemoryMessage,
  parseClientVaultMessage,
  parseClientRemoteMessage,
  parseClientSettingsMessage,
  parseClientComposerMessage,
  parseClientWorktreeMessage,
] as const;

const SERVER_FAMILY_PARSERS = [
  parseServerTerminalMessage,
  parseServerAgentMessage,
  parseServerHistoryMessage,
  parseServerConversationMessage,
  parseServerGitMessage,
  parseServerFileMessage,
  parseServerNoteMessage,
  parseServerPickerMessage,
  parseServerConnectionMessage,
  parseServerMemoryMessage,
  parseServerVaultMessage,
  parseServerRemoteMessage,
  parseServerSettingsMessage,
  parseServerComposerMessage,
  parseServerWorktreeMessage,
] as const;

export function parseClientMessage(raw: string): ClientMessage | null {
  const record = asRecord(parseJson(raw));
  if (record === null) return null;

  if (typeof record['type'] === 'string' && record['type'].startsWith('agency.')) {
    return parseAgencyClientMessage(record);
  }

  for (const parseFamily of CLIENT_FAMILY_PARSERS) {
    const parsed = parseFamily(record);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const record = asRecord(parseJson(raw));
  if (record === null) return null;

  if (typeof record['type'] === 'string' && record['type'].startsWith('agency.')) {
    return parseAgencyServerMessage(record);
  }

  for (const parseFamily of SERVER_FAMILY_PARSERS) {
    const parsed = parseFamily(record);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/** Serializes with the type applied, so nobody sends a loose object. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
