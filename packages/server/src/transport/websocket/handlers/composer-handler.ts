/**
 * Composer drafts.
 */

import type { ServerMessage } from '@anvilary/workbench-shared';
import type { ClientMessage } from '@anvilary/workbench-shared';
import { draftEntriesOf, draftOwnerOf } from '../../../features/composer/draft-store.js';
import { debugLog } from '../../../shared/debug.js';
import type { HandlerContext } from '../handler-context.js';

export const composerMessageTypes = [
  'composer.draft',
] as const;

type ComposerMessage = Extract<ClientMessage, { type: (typeof composerMessageTypes)[number] }>;

export async function handleComposerMessage(
  message: ComposerMessage,
  ctx: HandlerContext<'broadcast' | 'drafts' | 'registry' | 'send' | 'socket'>,
): Promise<void> {
  const { broadcast, drafts, registry, send, socket } = ctx;
  switch (message.type) {
    /*
      El borrador del cuadro de una pestana, despues de una pausa del
      teclado (§6.29). No se contesta. Una consola, o una pestana cuya CLI
      todavia no dijo su conversacion, no tiene donde guardarlo: lo escrito
      sigue en el cuadro, y se guarda con la pausa siguiente a que aparezca.
    */
    case 'composer.draft': {
      const owner = draftOwnerOf(registry.get(message.terminalId));
      if (owner === null) break;
      const outcome = drafts.save(owner, message.draft);
      debugLog('drafts', `${message.terminalId.slice(0, 8)}: ${outcome}`);
      /*
        A todas las ventanas, tambien a la que lo escribio (09-10-2026): las
        demas lo ponen en su cuadro si ahi no estan escribiendo, y esta sabe
        que llego. Sin cambios, solo a ella: las demas ya lo tienen.
      */
      const update: ServerMessage = { type: 'composer.drafts', drafts: draftEntriesOf(registry.list(), drafts, owner) };
      if (outcome === 'unchanged') send(socket, update);
      else broadcast(update);
      break;
    }
  }
}
