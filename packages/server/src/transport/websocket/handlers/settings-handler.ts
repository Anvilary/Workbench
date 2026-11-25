/**
 * App settings, the agent list and agents usage.
 */

import { DEFAULT_BROWSER_PROFILE_ID, serverText, type ClientMessage } from '@agent-workbench/shared';
import { AppSettingsChangeError } from '../../../features/settings/app-settings-service.js';
import type { HandlerContext } from '../handler-context.js';

export const settingsMessageTypes = [
  'agents.refresh',
  'settings.update',
  'agents.usage.get',
] as const;

type SettingsMessage = Extract<ClientMessage, { type: (typeof settingsMessageTypes)[number] }>;

async function runWithProfileLocks<T>(
  mutex: HandlerContext<'browserProfileMutations'>['browserProfileMutations'],
  profileIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const sorted = [...new Set(profileIds)].sort();
  const acquire = (index: number): Promise<T> => {
    if (index >= sorted.length) return fn();
    return mutex.runExclusive(sorted[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

export async function handleSettingsMessage(
  message: SettingsMessage,
  ctx: HandlerContext<
    | 'agencyBrowserProfileStore'
    | 'agents'
    | 'agentsMessage'
    | 'agentsUsageCollector'
    | 'appSettings'
    | 'broadcast'
    | 'browserProfileMutations'
    | 'send'
    | 'sendError'
    | 'socket'
    | 'tabReady'
  >,
): Promise<void> {
  const {
    agencyBrowserProfileStore,
    agents,
    agentsMessage,
    agentsUsageCollector,
    appSettings,
    broadcast,
    browserProfileMutations,
    send,
    sendError,
    socket,
    tabReady,
  } = ctx;
  switch (message.type) {
    /*
      "Comprobar" del dialogo de la status line: relee la configuracion de
      cada CLI y contesta con la lista. Si algo cambio va a todos, no solo
      a quien pregunto: el aviso automatico ya no lo va a repetir, porque
      esta lectura dejo el estado al dia.
    */
    case 'agents.refresh':
      void agents.refreshSetups().then((changed) => {
        if (changed) broadcast(agentsMessage());
        else send(socket, agentsMessage());
      });
      break;
    /*
      Ajustes (Hito 41, §6.32). Una consola que ya no esta, o un disco que no
      deja escribir, se dicen; lo demas lo valido el parser. A una ventana
      remota no llega: lo frena `remoteRefusal`.
    */
    case 'settings.update': {
      const { type: _type, requestId, ...change } = message;
      void (async () => {
        try {
          const verifiedNonMainIds = new Set<string>();
          if (
            change.customDictionary &&
            (change.customDictionary.action === 'add' || change.customDictionary.action === 'remove') &&
            change.customDictionary.profileId !== DEFAULT_BROWSER_PROFILE_ID
          ) {
            verifiedNonMainIds.add(change.customDictionary.profileId);
          }

          const incomingMap = change.browser?.spellCheck?.customWordsByProfile;
          if (incomingMap && typeof incomingMap === 'object') {
            for (const pid of Object.keys(incomingMap)) {
              if (pid !== DEFAULT_BROWSER_PROFILE_ID) {
                verifiedNonMainIds.add(pid);
              }
            }
          }

          const lockIds = new Set<string>(verifiedNonMainIds);
          if (
            change.customDictionary &&
            change.customDictionary.profileId !== DEFAULT_BROWSER_PROFILE_ID
          ) {
            lockIds.add(change.customDictionary.profileId);
          }
          if (incomingMap && typeof incomingMap === 'object') {
            const existingMap = appSettings.status().browser?.spellCheck?.customWordsByProfile;
            if (existingMap) {
              for (const pid of Object.keys(existingMap)) {
                if (pid !== DEFAULT_BROWSER_PROFILE_ID) {
                  lockIds.add(pid);
                }
              }
            }
          }

          const applyChange = async () => {
            const nextStatus = await appSettings.update(change);
            if (requestId !== undefined) {
              send(socket, {
                type: 'settings.status',
                settings: nextStatus,
                requestId,
              });
            }
          };

          if (lockIds.size > 0) {
            await tabReady;
            const missingProfile = await runWithProfileLocks(browserProfileMutations, [...lockIds], async () => {
              for (const pid of verifiedNonMainIds) {
                if (!agencyBrowserProfileStore.getProfile(pid)) {
                  return pid;
                }
              }
              await applyChange();
              return null;
            });
            if (missingProfile !== null) {
              sendError(
                socket,
                'settings-failed',
                serverText('settingsFailed'),
                `Browser profile not found: ${missingProfile}`,
                requestId,
              );
            }
          } else {
            await applyChange();
          }
        } catch (error: unknown) {
          if (error instanceof AppSettingsChangeError) {
            sendError(socket, 'settings-failed', serverText('settingsShellMissing'), undefined, requestId);
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          console.warn('[settings] a change failed:', detail);
          sendError(socket, 'settings-failed', serverText('settingsFailed'), detail, requestId);
        }
      })();
      break;
    }
    case 'agents.usage.get': {
      void (async () => {
        try {
          const snapshot = await agentsUsageCollector.getSnapshot(message.forceRefresh);
          send(socket, {
            type: 'agents.usage.snapshot',
            requestId: message.requestId,
            usage: snapshot,
          });
        } catch (error) {
          send(socket, {
            type: 'agents.usage.failed',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      break;
    }
  }
}
