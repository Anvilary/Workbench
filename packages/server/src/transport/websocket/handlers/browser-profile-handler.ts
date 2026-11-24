/**
 * Browser profiles.
 */

import type { AgencyErrorCode } from '@agent-workbench/shared';
import type { ClientMessage } from '@agent-workbench/shared';
import { DomainError } from '../../../shared/errors/domain-error.js';
import type { HandlerContext } from '../handler-context.js';

export const browserProfileMessageTypes = [
  'agency.browserProfiles.list',
  'agency.browserProfile.create',
  'agency.browserProfile.rename',
  'agency.browserProfile.delete',
] as const;

type BrowserProfileMessage = Extract<ClientMessage, { type: (typeof browserProfileMessageTypes)[number] }>;

export async function handleBrowserProfileMessage(
  message: BrowserProfileMessage,
  ctx: HandlerContext<'agencyBrowserProfileStore' | 'agencyWorkspaceStore' | 'appSettings' | 'broadcast' | 'browserProfileMutations' | 'send' | 'socket'>,
): Promise<void> {
  const { agencyBrowserProfileStore, agencyWorkspaceStore, appSettings, broadcast, browserProfileMutations, send, socket } = ctx;
  switch (message.type) {
    case 'agency.browserProfiles.list': {
      send(socket, {
        type: 'agency.browserProfiles.snapshot',
        requestId: message.requestId,
        profiles: agencyBrowserProfileStore.listProfiles(),
      });
      break;
    }
    case 'agency.browserProfile.create': {
      try {
        const profile = await agencyBrowserProfileStore.createProfile(message.name, message.sourceProfileId);
        broadcast({ type: 'agency.browserProfile.changed', change: 'created', profileId: profile.id, profile });
        send(socket, {
          type: 'agency.browserProfile.created',
          requestId: message.requestId,
          profile,
          ...(message.sourceProfileId !== undefined ? { sourceProfileId: message.sourceProfileId } : {}),
          ...(message.clearSites !== undefined ? { clearSites: message.clearSites } : {}),
        });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: error instanceof DomainError ? (error.code as AgencyErrorCode) : 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'agency.browserProfile.rename': {
      try {
        const profile = await agencyBrowserProfileStore.renameProfile(message.profileId, message.name);
        broadcast({ type: 'agency.browserProfile.changed', change: 'renamed', profileId: profile.id, profile });
        send(socket, { type: 'agency.browserProfile.renamed', requestId: message.requestId, profile });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: error instanceof DomainError ? (error.code as AgencyErrorCode) : 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'agency.browserProfile.delete': {
      try {
        await browserProfileMutations.runExclusive(message.profileId, async () => {
          const profile = agencyBrowserProfileStore.getProfile(message.profileId);
          if (profile?.isDefault) {
            throw new DomainError('conflict', 'The default Main browser profile cannot be deleted');
          }
          await appSettings.clearProfileCustomDictionary(message.profileId);
          const cleared = await agencyWorkspaceStore.clearBrowserProfile(message.profileId);
          for (const project of cleared.projects) {
            broadcast({ type: 'agency.project.changed', change: 'updated', projectId: project.id, project });
          }
          for (const workspace of cleared.workspaces) {
            broadcast({ type: 'agency.workspace.changed', change: 'updated', workspaceId: workspace.id, workspace });
          }
          if (profile) {
            await agencyBrowserProfileStore.deleteProfile(message.profileId);
            broadcast({ type: 'agency.browserProfile.changed', change: 'deleted', profileId: message.profileId });
          }
        });
        send(socket, { type: 'agency.browserProfile.deleted', requestId: message.requestId, profileId: message.profileId });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: error instanceof DomainError ? (error.code as AgencyErrorCode) : 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
  }
}
