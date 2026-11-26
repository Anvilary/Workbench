/**
 * Remote access: pairing and paired devices.
 */

import { ServerTextError, serverText, type ClientMessage } from '@anvilary/workbench-shared';
import type { HandlerContext } from '../handler-context.js';

export const remoteMessageTypes = [
  'remote.configure',
  'remote.pairing.start',
  'remote.pairing.cancel',
  'remote.phone.start',
  'remote.phone.cancel',
  'remote.device.rename',
  'remote.device.revoke',
  'remote.device.forgetSelf',
] as const;

type RemoteMessage = Extract<ClientMessage, { type: (typeof remoteMessageTypes)[number] }>;

export async function handleRemoteMessage(
  message: RemoteMessage,
  ctx: HandlerContext<'deviceId' | 'noAuth' | 'phonePairing' | 'remote' | 'send' | 'sendError' | 'sendRemoteError' | 'socket'>,
): Promise<void> {
  const { deviceId, noAuth, phonePairing, remote, send, sendError, sendRemoteError, socket } = ctx;
  switch (message.type) {
    /*
      El acceso remoto (hito 37). Hasta aca solo llega una ventana del
      anfitrion: a un equipo remoto lo freno `remoteRefusal`. El estado
      nuevo sale a las ventanas del anfitrion por `remote.onChange`; aca
      solo se contesta lo que falla, y el codigo, que va **solo** a quien lo
      pidio.
    */
    case 'remote.configure': {
      const patch: { enabled?: boolean; port?: number } = {};
      if (message.enabled !== undefined) patch.enabled = message.enabled;
      if (message.port !== undefined) patch.port = message.port;
      if (noAuth && patch.enabled === true) {
        sendRemoteError(socket, new ServerTextError(serverText('raw', { text: 'Remote access cannot be enabled in token-free mode.' })));
        break;
      }
      void remote.configure(patch).catch((error: unknown) => sendRemoteError(socket, error));
      break;
    }
    case 'remote.pairing.start':
      if (noAuth) {
        sendRemoteError(socket, new ServerTextError(serverText('raw', { text: 'Remote access cannot be enabled in token-free mode.' })));
        break;
      }
      try {
        send(socket, { type: 'remote.pairing.code', pairing: remote.startPairing() });
      } catch (error) {
        sendRemoteError(socket, error);
      }
      break;
    case 'remote.pairing.cancel':
      remote.cancelPairing();
      break;
    /*
      El telefono (hito 38): la respuesta lleva su llave privada dentro del
      texto del QR, asi que va solo a esta ventana, y si esta ventana se
      cierra sin cancelar, la llave se olvida igual (`teardown`).
    */
    case 'remote.phone.start':
      phonePairing.owner = socket;
      void remote
        .startPhonePairing()
        .then((pairing) => send(socket, { type: 'remote.phone.pairing', pairing }))
        .catch((error: unknown) => sendRemoteError(socket, error));
      break;
    case 'remote.phone.cancel':
      if (phonePairing.owner === socket) phonePairing.owner = null;
      remote.cancelPhonePairing();
      break;
    case 'remote.device.rename':
      void remote
        .renameDevice(message.deviceId, message.label)
        .then((renamed) => {
          if (!renamed) sendError(socket, 'remote-failed', serverText('remoteDeviceGone'));
        })
        .catch((error: unknown) => sendRemoteError(socket, error));
      break;
    case 'remote.device.revoke':
      void remote
        .revokeDevice(message.deviceId)
        .then((revoked) => {
          if (!revoked) sendError(socket, 'remote-failed', serverText('remoteDeviceGone'));
        })
        .catch((error: unknown) => sendRemoteError(socket, error));
      break;
    /*
      "Olvidar este equipo" del teléfono: se revoca el equipo con el que
      entró esta ventana, y ningún otro. Revocar cierra sus ventanas con
      4001, esta incluida: ése es el acuse. Una ventana del anfitrión no es
      un equipo, y no tiene nada que olvidar.
    */
    case 'remote.device.forgetSelf':
      if (deviceId === null) break;
      void remote.revokeDevice(deviceId).catch((error: unknown) => sendRemoteError(socket, error));
      break;
  }
}
