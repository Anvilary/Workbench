/**
 * Loose notes, their images and sending a note to a terminal.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { deliverWhenReady } from '../../../features/composer/deliver-when-ready.js';
import type { HandlerContext } from '../handler-context.js';

/**
 * Cuanto se espera a que arranque la CLI de una pestana recien abierta antes de
 * mandarle una nota.
 *
 * Medido con una pty propia: la CLI se declara `idle` a los 2 o 3 segundos de
 * lanzarse. Quince deja margen para una maquina cargada sin que el usuario se
 * quede mirando un boton que no dice nada.
 */
const NOTE_SEND_TIMEOUT_MS = 15_000;

export const notesMessageTypes = [
  'notes.create',
  'notes.update',
  'notes.delete',
  'notes.addImage',
  'notes.removeImage',
  'notes.image',
  'notes.send',
] as const;

type NotesMessage = Extract<ClientMessage, { type: (typeof notesMessageTypes)[number] }>;

export async function handleNotesMessage(
  message: NotesMessage,
  ctx: HandlerContext<'broadcast' | 'broadcastExcept' | 'deliverDeps' | 'notes' | 'pieceWriter' | 'registry' | 'send' | 'sendError' | 'sendNotesError' | 'socket'>,
): Promise<void> {
  const { broadcast, broadcastExcept, deliverDeps, notes, pieceWriter, registry, send, sendError, sendNotesError, socket } = ctx;
  switch (message.type) {
    /*
      Notas sueltas. No van dirigidas a ninguna pestana.

      Los errores del almacen son de usuario —tope de notas, imagen que no
      es imagen— y viajan como `notes-failed`; lo demas es un fallo interno.
    */
    case 'notes.create':
      try {
        notes.create(message.noteId);
        broadcast({ type: 'notes.list', notes: notes.list() });
      } catch (error) {
        sendNotesError(error);
      }
      break;
    case 'notes.update':
      try {
        // Sin eco al que escribe: pisaria lo tecleado entre envio y respuesta.
        if (notes.update(message.noteId, message.text)) {
          broadcastExcept(socket, { type: 'notes.list', notes: notes.list() });
        }
      } catch (error) {
        sendNotesError(error);
      }
      break;
    case 'notes.delete':
      void notes
        .delete(message.noteId)
        .then((changed) => {
          if (changed) broadcast({ type: 'notes.list', notes: notes.list() });
        })
        .catch(sendNotesError);
      break;
    case 'notes.addImage':
      void notes
        .addImage(message.noteId, message.image.mediaType, message.image.data)
        .then((image) => {
          // El que la pego ya tiene los bytes: se le devuelven con el id
          // para que la miniatura no vuelva a pedirlos.
          send(socket, {
            type: 'notes.imageData',
            imageId: image.imageId,
            mediaType: image.mediaType,
            data: message.image.data,
          });
          broadcast({ type: 'notes.list', notes: notes.list() });
        })
        .catch(sendNotesError);
      break;
    case 'notes.removeImage':
      void notes
        .removeImage(message.noteId, message.imageId)
        .then((changed) => {
          if (changed) broadcast({ type: 'notes.list', notes: notes.list() });
        })
        .catch(sendNotesError);
      break;
    case 'notes.image':
      void notes
        .readImage(message.imageId)
        .catch(() => null)
        .then((image) => {
          send(socket, {
            type: 'notes.imageData',
            imageId: message.imageId,
            mediaType: image?.mediaType ?? 'image/png',
            data: image?.data ?? null,
          });
        });
      break;
    case 'notes.send':
      void (async () => {
        const descriptor = registry.get(message.terminalId);
        if (descriptor === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        if (descriptor.kind !== 'agent' || descriptor.sessionId.length === 0) {
          sendError(socket, 'submit-failed', serverText('noteNoAgent'));
          return;
        }

        const note = await notes.readForSubmit(message.noteId);
        if (note === null) {
          sendError(socket, 'submit-failed', serverText('noteGone'));
          return;
        }
        if (note.text.trim().length === 0 && note.images.length === 0) {
          sendError(socket, 'submit-failed', serverText('noteEmpty'));
          return;
        }

        /*
          Una pty recien abierta puede estar todavia arrancando, y ahi el
          pegado se perderia o —peor— contestaria un menu. Se espera a que
          la CLI se declare lista; si no llega, no se escribe nada. Una CLI
          que no avisa cuando esta lista no recibe notas: pegar a ciegas es
          justo lo que esta espera evita.

          Desde el hito 29 la espera y la escritura estan en
          `deliverWhenReady`, que tambien usa la continuacion en otra CLI
          (M3): mismas comprobaciones en el mismo orden, misma fila, mismas
          piezas. Los textos de cada fallo siguen aca.
        */
        const outcome = await deliverWhenReady(deliverDeps, {
          terminalId: message.terminalId,
          text: note.text,
          images: note.images,
          timeoutMs: NOTE_SEND_TIMEOUT_MS,
          write: pieceWriter(socket, message.terminalId),
        });
        switch (outcome.kind) {
          case 'sent':
          case 'nothing':
          // La fila ya lo dijo al no poder escribir (`writeToTerminal`).
          case 'refused':
            return;
          case 'gone':
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
            return;
          case 'no-agent':
          case 'no-session':
            sendError(socket, 'submit-failed', serverText('noteNoAgent'));
            return;
          case 'no-ready-signal':
            sendError(socket, 'agent-unsupported', serverText('noteNoReadySignal'));
            return;
          case 'no-images':
            sendError(socket, 'agent-unsupported', serverText('noteImagesUnsupported'));
            return;
          case 'not-ready':
            sendError(socket, 'submit-failed', serverText('noteCliNotStarted'));
            return;
          case 'image-failed':
            sendError(socket, 'submit-failed', serverText('noteImageFailed'), outcome.detail);
            return;
          case 'interrupted':
            sendError(socket, 'submit-failed', serverText('noteInterrupted'));
            return;
        }
      })();
      break;
  }
}
