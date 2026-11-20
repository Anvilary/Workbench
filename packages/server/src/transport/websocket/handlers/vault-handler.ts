/**
 * The owned copy of sessions on disk.
 */

import type { ClientMessage } from '@agent-workbench/shared';
import type { HandlerContext } from '../handler-context.js';

export const vaultMessageTypes = [
  'vault.measure',
  'vault.enable',
  'vault.setDir',
  'vault.exportProject',
  'vault.openSession',
  'vault.reveal',
] as const;

type VaultMessage = Extract<ClientMessage, { type: (typeof vaultMessageTypes)[number] }>;

export async function handleVaultMessage(
  message: VaultMessage,
  ctx: HandlerContext<'pickers' | 'send' | 'sendVaultError' | 'socket' | 'vault'>,
): Promise<void> {
  const { pickers, send, sendVaultError, socket, vault } = ctx;
  switch (message.type) {
    /*
      La copia propia (hito 28). Ningun pedido nombra una ruta: medir y
      encender no llevan nada, mudar lleva el selector de **este** socket,
      una sesion va por `(agent, sessionId)` —el parser ya valido la forma
      del id— y un proyecto por su clave. El estado nuevo sale a todos por
      `vault.onStatus`; aca solo se contesta lo que falla.
    */
    case 'vault.measure':
      void vault.measure().catch((error: unknown) => sendVaultError(socket, error));
      break;
    case 'vault.enable':
      void vault.setEnabled(message.enabled).catch((error: unknown) => sendVaultError(socket, error));
      break;
    case 'vault.setDir':
      // El selector se cierra despues, desde el cliente, como con un proyecto nuevo.
      void vault.setDirFromPicker(pickers, message.pickerId).catch((error: unknown) => sendVaultError(socket, error));
      break;
    case 'vault.exportProject':
      void vault
        .exportProject(message.projectKey)
        .then((result) => {
          send(socket, { type: 'vault.exported', projectKey: message.projectKey, sessions: result.sessions });
        })
        .catch((error: unknown) => sendVaultError(socket, error));
      break;
    case 'vault.openSession':
      void vault.openSession(message.agent, message.sessionId).catch((error: unknown) => sendVaultError(socket, error));
      break;
    case 'vault.reveal':
      void vault.reveal().catch((error: unknown) => sendVaultError(socket, error));
      break;
  }
}
