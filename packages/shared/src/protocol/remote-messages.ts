/**
 * Remote access messages: pairing, devices and phone pairing.
 */

import {
  cleanDeviceLabel,
  parseRemoteAccessStatus,
  parseRemotePairingCode,
  parseRemotePhonePairing,
  type RemoteAccessStatus,
  type RemotePairingCode,
  type RemotePhonePairing,
} from '../settings/remote.js';
import { asBoolean, asFiniteNumber, asNonEmptyString, asString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Enciende o apaga el acceso remoto, o cambia su puerto (hito 37). Lleva al
 * menos uno de los dos. Solo lo atiende el servidor si quien lo pide entro con el
 * token del arranque: un equipo remoto no administra el acceso remoto.
 */
export interface ClientRemoteConfigureMessage {
  type: 'remote.configure';
  enabled?: boolean;
  port?: number;
}

/** Pide un codigo de un solo uso para emparejar un equipo. Llega en `remote.pairing.code`. */
export interface ClientRemotePairingStartMessage {
  type: 'remote.pairing.start';
}

/** Da de baja el codigo vigente: se cerro el dialogo sin usarlo. */
export interface ClientRemotePairingCancelMessage {
  type: 'remote.pairing.cancel';
}

export interface ClientRemoteDeviceRenameMessage {
  type: 'remote.device.rename';
  deviceId: string;
  label: string;
}

/** Revoca un equipo: sus ventanas se cierran y su credencial deja de entrar. */
export interface ClientRemoteDeviceRevokeMessage {
  type: 'remote.device.revoke';
  deviceId: string;
}

/**
 * Empareja un teléfono (hito 38): un código de un solo uso y, la primera vez,
 * una llave SSH nueva, armada en memoria. Mientras la ventana no lo cancele, la
 * llave se conserva: pedir otro código no obliga a autorizar otra. Llega en
 * `remote.phone.pairing`, sólo a quien lo pidió.
 */
export interface ClientRemotePhoneStartMessage {
  type: 'remote.phone.start';
}

/** Olvida la llave y el código: se cerró el diálogo. */
export interface ClientRemotePhoneCancelMessage {
  type: 'remote.phone.cancel';
}

/**
 * Un equipo emparejado se da de baja a sí mismo: "Olvidar este equipo" del
 * teléfono (24-09-2026). No nombra ningún equipo: el servidor revoca el de la
 * credencial con la que entró esta ventana, y a una ventana del anfitrión se lo
 * rechaza. Sólo quita acceso, así que una credencial robada no gana nada.
 */
export interface ClientRemoteDeviceForgetSelfMessage {
  type: 'remote.device.forgetSelf';
}

/**
 * Estado del acceso remoto (hito 37). Al conectar y a todos en cada cambio, pero
 * **solo a las ventanas del anfitrion**: a un equipo remoto no se le cuenta que
 * otros equipos hay ni con que usuario se entra.
 */
export interface ServerRemoteStatusMessage {
  type: 'remote.status';
  status: RemoteAccessStatus;
}

/** El codigo que pidio `remote.pairing.start`, solo al socket que lo pidio. */
export interface ServerRemotePairingCodeMessage {
  type: 'remote.pairing.code';
  pairing: RemotePairingCode;
}

/**
 * Lo que pidio `remote.phone.start` (hito 38), solo al socket que lo pidio:
 * lleva la llave privada del telefono dentro del texto del QR.
 */
export interface ServerRemotePhonePairingMessage {
  type: 'remote.phone.pairing';
  pairing: RemotePhonePairing;
}

/** Every client message of this family. */
export type ClientRemoteMessage =
  | ClientRemoteConfigureMessage
  | ClientRemotePairingStartMessage
  | ClientRemotePairingCancelMessage
  | ClientRemoteDeviceRenameMessage
  | ClientRemoteDeviceRevokeMessage
  | ClientRemotePhoneStartMessage
  | ClientRemotePhoneCancelMessage
  | ClientRemoteDeviceForgetSelfMessage;

/** Every server message of this family. */
export type ServerRemoteMessage =
  | ServerRemoteStatusMessage
  | ServerRemotePairingCodeMessage
  | ServerRemotePhonePairingMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientRemoteMessage(record: UnknownRecord): ClientRemoteMessage | null | undefined {
  switch (record['type']) {
    case 'remote.configure': {
      // Que el puerto este en rango lo decide el servidor, que contesta con su
      // texto; aca solo se exige la forma, y que el pedido diga algo.
      const rawEnabled = record['enabled'];
      const rawPort = record['port'];
      const enabled = rawEnabled === undefined ? undefined : asBoolean(rawEnabled);
      const port = rawPort === undefined ? undefined : asFiniteNumber(rawPort);
      if (enabled === null || port === null || (enabled === undefined && port === undefined)) return null;
      return {
        type: 'remote.configure',
        ...(enabled !== undefined ? { enabled } : {}),
        ...(port !== undefined ? { port } : {}),
      };
    }
    case 'remote.pairing.start':
      return { type: 'remote.pairing.start' };
    case 'remote.pairing.cancel':
      return { type: 'remote.pairing.cancel' };
    case 'remote.device.rename': {
      const deviceId = asNonEmptyString(record['deviceId']);
      const rawLabel = asString(record['label']);
      const label = rawLabel === null ? '' : cleanDeviceLabel(rawLabel);
      return deviceId === null || label.length === 0 ? null : { type: 'remote.device.rename', deviceId, label };
    }
    case 'remote.device.revoke': {
      const deviceId = asNonEmptyString(record['deviceId']);
      return deviceId === null ? null : { type: 'remote.device.revoke', deviceId };
    }
    case 'remote.phone.start':
      return { type: 'remote.phone.start' };
    case 'remote.phone.cancel':
      return { type: 'remote.phone.cancel' };
    case 'remote.device.forgetSelf':
      return { type: 'remote.device.forgetSelf' };
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerRemoteMessage(record: UnknownRecord): ServerRemoteMessage | null | undefined {
  switch (record['type']) {
    case 'remote.status': {
      const status = parseRemoteAccessStatus(record['status']);
      return status === null ? null : { type: 'remote.status', status };
    }
    case 'remote.pairing.code': {
      const pairing = parseRemotePairingCode(record['pairing']);
      return pairing === null ? null : { type: 'remote.pairing.code', pairing };
    }
    case 'remote.phone.pairing': {
      const pairing = parseRemotePhonePairing(record['pairing']);
      return pairing === null ? null : { type: 'remote.phone.pairing', pairing };
    }
    default:
      return undefined;
  }
}
