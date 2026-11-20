/**
 * CLI agent profiles and their capabilities.
 */

import type { ClientMessage } from '@agent-workbench/shared';
import { inspectAgencyProfile, listAgencyProfiles } from '../../../features/profiles/profile-capabilities.js';
import type { HandlerContext } from '../handler-context.js';

export const agentProfileMessageTypes = [
  'agency.profiles.list',
  'agency.profile.configure',
  'agency.profile.create',
  'agency.profile.delete',
  'agency.profile.capabilities.get',
] as const;

type AgentProfileMessage = Extract<ClientMessage, { type: (typeof agentProfileMessageTypes)[number] }>;

export async function handleAgentProfileMessage(
  message: AgentProfileMessage,
  ctx: HandlerContext<'agencyIdentities' | 'agencyProfileStore' | 'agents' | 'broadcast' | 'send' | 'socket'>,
): Promise<void> {
  const { agencyIdentities, agencyProfileStore, agents, broadcast, send, socket } = ctx;
  switch (message.type) {
    case 'agency.profiles.list': {
      try {
        const profiles = await listAgencyProfiles(agencyProfileStore, agents, { identities: agencyIdentities });
        send(socket, { type: 'agency.profiles.snapshot', requestId: message.requestId, profiles });
      } catch {
        send(socket, { type: 'agency.error', requestId: message.requestId,
          code: 'internal-error', message: 'Unable to load Agency profiles.' });
      }
      break;
    }
    case 'agency.profile.configure': {
      try {
        const { type: _, requestId, profileId, ...changes } = message;
        const def = await agencyProfileStore.configure(profileId, changes);
        const profile = await inspectAgencyProfile(def, agents, { identities: agencyIdentities });
        broadcast({ type: 'agency.profile.changed', profileId: profile.id, profile, change: 'configured' });
        send(socket, { type: 'agency.profile.configured', requestId: message.requestId, profile });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'agency.profile.create': {
      try {
        const { type: _, requestId, ...input } = message;
        const def = await agencyProfileStore.createProfile(input);
        const profile = await inspectAgencyProfile(def, agents, { identities: agencyIdentities });
        broadcast({ type: 'agency.profile.changed', profileId: profile.id, profile, change: 'created' });
        send(socket, { type: 'agency.profile.created', requestId: message.requestId, profile });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'agency.profile.delete': {
      try {
        const { profileId } = message;
        await agencyProfileStore.deleteProfile(profileId);
        broadcast({ type: 'agency.profile.changed', profileId, change: 'deleted' });
        send(socket, { type: 'agency.profile.deleted', requestId: message.requestId, profileId });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: 'invalid-request',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'agency.profile.capabilities.get': {
      try {
        const def = await agencyProfileStore.getDefinition(message.profileId);
        if (!def) {
          send(socket, {
            type: 'agency.error',
            requestId: message.requestId,
            code: 'not-found',
            message: 'Profile not found',
          });
          break;
        }
        const profile = await inspectAgencyProfile(def, agents, { identities: agencyIdentities });
        send(socket, {
          type: 'agency.profile.capabilities',
          requestId: message.requestId,
          profileId: profile.id,
          capabilities: profile.capabilities,
        });
      } catch (error) {
        send(socket, {
          type: 'agency.error',
          requestId: message.requestId,
          code: 'internal-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
  }
}
