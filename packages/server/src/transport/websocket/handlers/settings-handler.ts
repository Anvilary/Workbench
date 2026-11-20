/**
 * App settings, the agent list and agents usage.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { AppSettingsChangeError } from '../../../features/settings/app-settings-service.js';
import type { HandlerContext } from '../handler-context.js';

export const settingsMessageTypes = [
  'agents.refresh',
  'settings.update',
  'agents.usage.get',
] as const;

type SettingsMessage = Extract<ClientMessage, { type: (typeof settingsMessageTypes)[number] }>;

export async function handleSettingsMessage(
  message: SettingsMessage,
  ctx: HandlerContext<'agents' | 'agentsMessage' | 'agentsUsageCollector' | 'appSettings' | 'broadcast' | 'send' | 'sendError' | 'socket'>,
): Promise<void> {
  const { agents, agentsMessage, agentsUsageCollector, appSettings, broadcast, send, sendError, socket } = ctx;
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
      const { type: _type, ...change } = message;
      void appSettings.update(change).catch((error: unknown) => {
        if (error instanceof AppSettingsChangeError) {
          sendError(socket, 'settings-failed', serverText('settingsShellMissing'));
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        console.warn('[settings] a change failed:', detail);
        sendError(socket, 'settings-failed', serverText('settingsFailed'), detail);
      });
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
