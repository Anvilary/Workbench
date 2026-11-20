/**
 * Writing to a terminal's agent CLI: prompts, answers, permission mode, interrupts, queue edits and rewinds.
 */

import {
  launchModeFor,
  serverText,
  type ClientMessage,
  type ServerErrorCode,
  type ServerText,
} from '@agent-workbench/shared';
import type { QueueEditFailure, QueueEditOutcome, RewindOutcome } from '../../../agents/adapter.js';
import {
  attachmentLine,
  attachmentReference,
  textWithAttachments,
} from '../../../features/composer/attachments.js';
import { draftEntriesOf, draftOwnerOf, submitClearsDraft } from '../../../features/composer/draft-store.js';
import {
  MAX_FILES_PER_SUBMIT,
  MAX_IMAGES_PER_SUBMIT,
  PasteFileError,
  PasteImageError,
} from '../../../features/composer/paste-store.js';
import {
  ANSWER_KEY_INTERVAL_MS,
  ANSWER_MENU_CHANGED_TEXT,
  ANSWER_NOT_PENDING_TEXT,
  CLEAR_EDITOR,
  answerFailureText,
  answerKeysRefusal,
  buildAnswerKeys,
  buildForceSendKeys,
  buildSubmissionWrites,
  planModeChange,
  screenShowsDialog,
  submissionPayload,
  submitRefusal,
  submitStartDelayMs,
} from '../../../features/composer/pty-input.js';
import { LIVE_QUESTION_ID_PREFIX } from '../../../features/conversations/live-question.js';
import { debugLog } from '../../../shared/debug.js';
import type { HandlerContext } from '../handler-context.js';

/** Lo que se le dice al usuario cuando no se pudo sacar la cola (§6.35.1): por que, y donde quedo. */
function queueEditFailureText(reason: QueueEditFailure): ServerText {
  switch (reason) {
    case 'editor-busy':
      return serverText('queueEditBusyEditor');
    case 'no-queue-on-screen':
      return serverText('queueEditNotOnScreen');
    case 'not-restored':
      return serverText('queueEditFailed');
    case 'delivered':
      return serverText('queueEditDelivered');
    case 'not-cleared':
      return serverText('queueEditNotCleared');
    case 'gone':
      return serverText('queueEditNoCli');
  }
}

/**
 * Pasos de mas por la lista del menu de rewind, sobre los mensajes que ve el
 * hilo: la CLI puede listar alguno que el hilo no muestra (hito 44).
 */
const REWIND_EXTRA_STEPS = 30;

export const agentInputMessageTypes = [
  'agent.submit',
  'agent.answer',
  'agent.mode',
  'agent.interrupt',
  'agent.forceSend',
  'agent.editQueue',
  'agent.rewind',
] as const;

type AgentInputMessage = Extract<ClientMessage, { type: (typeof agentInputMessageTypes)[number] }>;

export async function handleAgentInputMessage(
  message: AgentInputMessage,
  ctx: HandlerContext<'adapterOf' | 'broadcast' | 'conversations' | 'drafts' | 'imageStyleFor' | 'inputOf' | 'interruptAgent' | 'pasteStore' | 'pieceWriter' | 'queuedSubmits' | 'registry' | 'send' | 'sendError' | 'socket' | 'writeQueue'>,
): Promise<void> {
  const { adapterOf, broadcast, conversations, drafts, imageStyleFor, inputOf, interruptAgent, pasteStore, pieceWriter, queuedSubmits, registry, send, sendError, socket, writeQueue } = ctx;
  switch (message.type) {
    /*
      Un mensaje del cuadro de escritura.

      Va aparte de `input` porque no son teclas: hay que guardar las
      imagenes en disco antes de poder nombrarlas, y eso es asincrono. El
      orden importa —las rutas se arman en el orden en que se pegaron— asi
      que las escrituras van en serie y no en paralelo.

      Y va por la fila de la terminal, guardado de imagenes incluido: un
      mensaje con una captura que tarda en guardarse no puede quedar detras
      del que se mando despues.
    */
    case 'agent.submit': {
      const { terminalId, text, images } = message;
      /*
        Con `requestId`, el envio se contesta una sola vez (§6.30): entregado
        si se escribio hasta el Enter, no entregado por cualquier otra
        salida. El motivo de un rechazo sigue llegando en su `error`.
      */
      let settled = false;
      const settle = (delivered: boolean): void => {
        if (settled || message.requestId === undefined) return;
        settled = true;
        send(socket, { type: 'agent.submitted', terminalId, requestId: message.requestId, delivered });
      };
      /*
        Lo que el cuadro mando ya no es un borrador (§6.29), llegue o no a
        la CLI: el cuadro se vacio al mandarlo, y lo guardado tiene que decir
        lo mismo. Si no, volveria al dia siguiente un mensaje ya enviado.

        Salvo lo que no salio del cuadro (`keepDraft`): el comando de un
        combo no puede llevarse lo que el usuario venia escribiendo.
      */
      const clearsDraft = submitClearsDraft(message);
      const submittedTab = registry.get(terminalId);
      const submittedOwner = draftOwnerOf(submittedTab);
      if (clearsDraft && submittedOwner !== null) drafts.delete(submittedOwner);
      /*
        Y lo dice a todas las ventanas (09-10-2026): las demas vacian su
        cuadro, y la que lo mando sabe que lo que llegue despues ya no es de
        antes del envio.
      */
      if (clearsDraft && submittedTab !== null) {
        broadcast({
          type: 'composer.drafts',
          drafts:
            submittedOwner === null
              ? [{ terminalId, draft: { text: '', pasted: [] } }]
              : draftEntriesOf(registry.list(), drafts, submittedOwner),
        });
      }
      const files = message.files ?? [];
      if (files.length > MAX_FILES_PER_SUBMIT) {
        sendError(
          socket,
          'submit-failed',
          serverText('filesPerMessage', { max: MAX_FILES_PER_SUBMIT }),
        );
        settle(false);
        break;
      }
      if (images.length > MAX_IMAGES_PER_SUBMIT) {
        sendError(
          socket,
          'submit-failed',
          serverText('imagesPerMessage', { max: MAX_IMAGES_PER_SUBMIT }),
        );
        settle(false);
        break;
      }
      // Sin imagenes no hay nada que comprobar: el texto va igual.
      if (
        images.length > 0 &&
        imageStyleFor(socket, terminalId, serverText('imagesUnsupported')) === null
      ) {
        settle(false);
        break;
      }

      /*
        Una pestana cuyo estado no se ve puede estar mostrando un menu de
        aprobacion sin que la app lo sepa, y ahi el mensaje llegaria como
        teclas: el Enter final aprueba, y un texto que empieza con la letra
        de "aprobar siempre" aprueba para toda la sesion (A1 del hito 25).
        Lo unico que se ve desde aca es una llamada a herramienta de este
        proceso que todavia no tiene resultado, y con eso no se escribe nada.
        Antes de encolar: un rechazo no tiene por que esperar su turno.

        "No se ve" es por pestana, no por CLI (R27-1 del hito 27): la que
        publica su estado solo con algo configurado, y no publico nada, esta
        igual de ciega que la que no lo publica nunca.
      */
      const submitting = adapterOf(terminalId);
      const isBlind = (): boolean =>
        submitting !== null && conversations.isBlindToApprovals(terminalId, submitting);
      /*
        Y una CLI cuya confirmacion abierta aprueba lo que llegue (hito 27,
        R27-2): con el menu de permiso abierto, el Enter aparte del mensaje
        cae sobre la opcion resaltada. Aca la app si sabe que hay un menu —lo
        publica la CLI— y no escribe, por lo mismo que el combo de modo no
        cicla (D16). Con Claude Code la capacidad es false y no cambia nada.
      */
      const guardsPending = submitting?.capabilities.permissionCycle?.approvesPendingOnCycle === true;
      /*
        Y una CLI que declara que su espera bloquea el cuadro (hito 29, D12:
        OpenCode por `serve`). La actividad es la del registro, que la sigue
        siempre; la del hub solo existe con alguien mirando la conversacion.
      */
      const blocksWhileWaiting = submitting?.capabilities.waitingBlocksSubmit === true;
      if (submitting !== null) {
        const launchedAt = registry.launchedAtOf(terminalId);
        const blind = isBlind();
        const refusal = submitRefusal({
          label: submitting.label,
          approvesPendingOnCycle: guardsPending,
          waitingFor: conversations.getWaitingFor(terminalId),
          waitingBlocksSubmit: blocksWhileWaiting,
          activity: registry.activityOf(terminalId),
          blind,
          openToolCall: blind && launchedAt !== null && conversations.hasOpenToolCall(terminalId, launchedAt),
        });
        if (refusal !== null) {
          sendError(socket, 'submit-failed', refusal);
          settle(false);
          break;
        }
      }
      /*
        Y otra vez antes de cada pieza, leyendo el archivo en el momento.
        Entre este chequeo y el Enter pasan el guardado de las imagenes, lo
        que hubiera delante en la fila y 400 ms por pieza: con ocho imagenes,
        casi cuatro segundos en los que la CLI puede abrir un menu. Si abre
        uno, lo que falta —el Enter sobre todo— no se escribe. La ceguera se
        vuelve a preguntar en cada pieza: la status line puede empezar a
        publicar a mitad del envio.
      */
      const approvalGuard =
        submitting !== null && (guardsPending || blocksWhileWaiting || isBlind())
          ? async (): Promise<boolean> => {
              const current = registry.launchedAtOf(terminalId);
              // Sin proceso no hay menu: la escritura la rechaza la terminal.
              if (current === null) return true;
              // D12: el estado llega por eventos, y el registro ya tiene el ultimo.
              if (blocksWhileWaiting && registry.activityOf(terminalId) === 'waiting') return false;
              if (isBlind() && (await conversations.checkOpenToolCall(terminalId, current))) return false;
              return !guardsPending || (await conversations.checkWaitingFor(terminalId)) === null;
            }
          : undefined;

      const input = inputOf(terminalId);
      /*
        La CLI que pregunta algo al arrancar sin publicarlo (20-10-2026,
        §12.14: la confianza de una carpeta nueva, con la status line muda
        hasta que hay conversacion). Antes de la primera pieza de una pestana
        sin conversacion se mira su pantalla; con el dialogo abierto no se
        escribe nada, porque el Enter aparte lo aceptaria sin que nadie lo
        vea, y el texto vuelve al cuadro. Despues de la primera pieza no
        hace falta: el dialogo es del arranque.
      */
      const startupDialog = input.startupDialog;
      const firstMessage = startupDialog !== undefined && (registry.get(terminalId)?.sessionId ?? '') === '';
      let startupChecked = false;
      let stoppedByDialog = false;
      const pieceGuard =
        firstMessage || approvalGuard !== undefined
          ? async (): Promise<boolean> => {
              if (firstMessage && startupDialog !== undefined && !startupChecked) {
                startupChecked = true;
                const screen = registry.watchScreen(terminalId);
                if (screen !== null) {
                  try {
                    stoppedByDialog = screenShowsDialog(await screen.lines(), startupDialog);
                  } finally {
                    screen.dispose();
                  }
                  if (stoppedByDialog) return false;
                }
              }
              return approvalGuard === undefined ? true : approvalGuard();
            }
          : undefined;
      const interrupted = (): void =>
        sendError(socket, 'submit-failed', serverText('submitInterrupted'));
      void writeQueue.enqueue(
        terminalId,
        async (lane) => {
          const imagePaths: string[] = [];
          try {
            for (const image of images) {
              const stored = await pasteStore.save(terminalId, image.mediaType, image.data);
              imagePaths.push(stored.path);
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            sendError(
              socket,
              'submit-failed',
              error instanceof PasteImageError ? error.text : serverText('pasteImageFailed'),
              detail,
            );
            return;
          }

          /*
            Los archivos adjuntos (hito 33, §6.21), despues de las imagenes
            y en el mismo turno de la fila. Se nombran por ruta dentro del
            texto, con la forma que esa CLI ya usa para el transcript de una
            continuacion (D18): no hace falta una capacidad, las cuatro la
            declaran.
          */
          const attachmentLines: string[] = [];
          try {
            for (const file of files) {
              const stored = await pasteStore.saveAttachment(terminalId, file.name, file.data);
              attachmentLines.push(
                attachmentLine(file.name, stored.bytes, attachmentReference(stored.path, input.transcriptReference)),
              );
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            sendError(
              socket,
              'submit-failed',
              error instanceof PasteFileError ? error.text : serverText('attachmentSaveFailed'),
              detail,
            );
            return;
          }
          const fullText = textWithAttachments(text, attachmentLines);

          const pieces = buildSubmissionWrites(fullText, imagePaths, input, {
            send: message.send !== false,
          });
          // Un cuadro vacio no le manda un Enter a la CLI.
          if (pieces === null) return;
          // Antes de la primera escritura: quien busca la sesion por este
          // texto no puede encontrar el archivo de la CLI antes que el texto.
          // Con adjuntos es el texto entero: es lo que la CLI va a guardar.
          registry.noteSubmitted(terminalId, fullText);
          // Un envio justo despues de lanzar espera a que la CLI dibuje su
          // pantalla: lo que llega antes se pierde (hito 35, §10.11).
          const startAfterMs = submitStartDelayMs(
            registry.launchedAtOf(terminalId),
            Date.now(),
            input.readyAfterLaunchMs ?? 0,
          );
          const outcome = await lane.writePieces(
            pieces,
            input.pieceGapMs,
            pieceWriter(socket, terminalId),
            pieceGuard,
            { startAfterMs },
          );
          settle(outcome === 'written');
          /*
            Una CLI cuya cola no queda escrita (hito 45, `source: 'app'`):
            lo mandado con el agente trabajando queda en cola hasta que
            aparezca en el hilo. Un comando de barra no hace cola.
          */
          if (
            outcome === 'written' &&
            message.send !== false &&
            submitting?.promptQueue?.source === 'app' &&
            registry.activityOf(terminalId) === 'busy' &&
            !text.trimStart().startsWith('/')
          ) {
            conversations.noteQueued(terminalId, { text, images: images.length, at: Date.now() });
          }
          /*
            Con la CLI que devuelve a su editor lo que tenia en cola al
            interrumpir (hito 43), se anota lo que llego hasta el Enter: es
            lo que una interrupcion puede tener que recuperar.
          */
          if (outcome === 'written' && message.send !== false && submitting?.queuedSubmits !== undefined) {
            queuedSubmits.note(
              terminalId,
              submissionPayload(fullText, imagePaths, input.imageReference) ?? fullText,
              Date.now(),
              fullText,
            );
          }
          if (outcome === 'interrupted') interrupted();
          if (outcome === 'blocked' && stoppedByDialog) {
            sendError(socket, 'submit-failed', serverText('submitStartupDialog', { label: submitting?.label ?? '' }));
            // Lo que salio del cuadro vuelve a el; un comando de un combo no salio de ahi.
            if (clearsDraft) send(socket, { type: 'composer.prefill', terminalId, text, reason: 'not-ready' });
            return;
          }
          if (outcome === 'blocked') {
            const waitingNow = blocksWhileWaiting && registry.activityOf(terminalId) === 'waiting';
            sendError(
              socket,
              'submit-failed',
              waitingNow
                ? submitting === null
                  ? serverText('submitStoppedWaitingNoLabel')
                  : serverText('submitStoppedWaiting', { label: submitting.label })
                : submitting === null
                  ? serverText('submitStoppedToolNoLabel')
                  : serverText('submitStoppedTool', { label: submitting.label }),
            );
          }
        },
        { onDropped: interrupted },
      )
        // La fila resuelve siempre, tambien si el trabajo lanzo o se descarto:
        // lo que no llego al Enter se contesta como no entregado.
        .then(() => settle(false));
      break;
    }
    /*
      Una respuesta a la pregunta de eleccion que la CLI tiene abierta.

      Lo que llega son indices contra la pregunta que este mismo servidor
      mando; las teclas las arma `buildAnswerKeys`. Se comprueban las dos
      cosas antes de escribir nada, porque escribir de mas en una pty no se
      deshace: que la pregunta abierta sea **esta** —si no, el usuario ya
      contesto desde la solapa CLI y los numeros entrarian en el prompt— y
      que lo elegido case con su forma.
    */
    case 'agent.answer': {
      // Una CLI cuyas preguntas no se contestan con esta secuencia no
      // recibe ninguna tecla: se contesta en su solapa CLI.
      const answering = adapterOf(message.terminalId);
      if (answering !== null && !answering.capabilities.questionCards) {
        sendError(
          socket,
          'agent-unsupported',
          serverText('answersUnsupported'),
        );
        break;
      }
      /*
        Una CLI que contesta por su API (hito 29, D10: OpenCode por
        `serve`). No escribe en la pty, y por eso va fuera de la fila de
        escritura: una respuesta no tiene que esperar a que termine de
        pegarse un mensaje. La pregunta abierta la confirma la propia CLI en
        el momento, con la carpeta de la pestana (A1); un fallo al mandar
        (una version sin esa ruta, el `serve` caido) tambien es
        `answer-failed`, y la tarjeta se reabre.
      */
      const channel = answering?.questions;
      if (channel !== undefined) {
        const descriptor = registry.get(message.terminalId);
        if (descriptor === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          break;
        }
        const { terminalId, toolUseId, selections } = message;
        void (async () => {
          try {
            const failure = answerFailureText(
              await channel.answer({ cwd: descriptor.cwd, sessionId: descriptor.sessionId }, toolUseId, selections),
            );
            if (failure !== null) sendError(socket, 'answer-failed', failure);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            debugLog('socket', `API answer in ${terminalId.slice(0, 8)}: ${error instanceof Error ? error.name : 'error'}`);
            sendError(
              socket,
              'answer-failed',
              serverText('answerSendFailed'),
              detail,
            );
          }
        })();
        break;
      }

      const interruptedAnswer = (): void =>
        sendError(socket, 'answer-failed', serverText('answerInterrupted'));

      /*
        La pregunta leida de la pantalla (§5.5.4). La CLI todavia no la
        escribio en el historial, asi que su id es de la app. Se contesta
        con las teclas de siempre, pero antes, dentro del turno de la fila,
        se relee la pantalla: si la pregunta ya no es esa, o el menu esta
        tocado en la solapa CLI, no se escribe nada. Leer bien no alcanza:
        lo que la hace segura es releer.
      */
      if (message.toolUseId.startsWith(LIVE_QUESTION_ID_PREFIX)) {
        void writeQueue.enqueue(
          message.terminalId,
          async (lane) => {
            const live = conversations.getLiveQuestion(message.terminalId);
            if (live === null || live.toolUseId !== message.toolUseId) {
              sendError(socket, 'answer-failed', ANSWER_NOT_PENDING_TEXT);
              return;
            }
            const shape = live.questions.map((question) => ({
              multiSelect: question.multiSelect,
              optionCount: question.options.length,
            }));
            const keys = buildAnswerKeys(shape, message.selections);
            if (keys === null) {
              sendError(socket, 'answer-failed', answerKeysRefusal(shape, message.selections));
              return;
            }
            const check = await conversations.verifyLiveQuestion(message.terminalId, message.toolUseId);
            if (check !== 'ok') {
              sendError(socket, 'answer-failed', check === 'gone' ? ANSWER_NOT_PENDING_TEXT : ANSWER_MENU_CHANGED_TEXT);
              return;
            }
            const outcome = await lane.writePieces(keys, ANSWER_KEY_INTERVAL_MS, pieceWriter(socket, message.terminalId));
            if (outcome === 'interrupted') interruptedAnswer();
          },
          { onDropped: interruptedAnswer },
        );
        break;
      }

      /*
        La comprobacion va dentro del turno de la fila, justo antes de
        escribir: si habia algo mandandose delante, la pregunta pudo
        cerrarse mientras tanto.
      */
      void writeQueue.enqueue(
        message.terminalId,
        async (lane) => {
          const pending = conversations.getPendingQuestion(message.terminalId);
          if (pending === null || pending.toolUseId !== message.toolUseId) {
            sendError(socket, 'answer-failed', ANSWER_NOT_PENDING_TEXT);
            return;
          }

          const shape = pending.questions.map((question) => ({
            multiSelect: question.multiSelect,
            optionCount: question.options.length,
          }));
          const keys = buildAnswerKeys(shape, message.selections);
          if (keys === null) {
            sendError(socket, 'answer-failed', answerKeysRefusal(shape, message.selections));
            return;
          }
          /*
            Si la pantalla se puede leer, tambien se relee (§5.5.4): la CLI
            a veces escribe la pregunta antes de que se conteste, y el menu
            pudo tocarse en la solapa CLI. Lo que no se puede leer (varias
            preguntas) se contesta como siempre.
          */
          const screen = await conversations.checkHistoryQuestion(message.terminalId, pending);
          if (screen === 'changed' || screen === 'touched' || screen === 'gone') {
            sendError(socket, 'answer-failed', ANSWER_MENU_CHANGED_TEXT);
            return;
          }
          /*
            Las teclas van espaciadas, y no es cortesia: mandadas en un solo
            write el menu de la CLI se queda a mitad y no responde nada
            (medido; ver `ANSWER_KEY_INTERVAL_MS`). Una interrupcion corta
            las que faltan: despues de un Esc el menu ya no esta, y los
            numeros entrarian sueltos en el prompt.
          */
          const outcome = await lane.writePieces(
            keys,
            ANSWER_KEY_INTERVAL_MS,
            pieceWriter(socket, message.terminalId),
          );
          if (outcome === 'interrupted') interruptedAnswer();
        },
        { onDropped: interruptedAnswer },
      );
      break;
    }
    /*
      Cambiar el modo de permiso de la pestana.

      No hay comando de barra que lo haga (medido contra la CLI 2.1.260):
      la unica via en una sesion viva es `shift+tab`, que cicla. Por eso el
      servidor calcula cuantas pulsaciones hacen falta desde el modo en el
      que cree que esta la pestana, y por eso van espaciadas igual que las
      respuestas: son teclas que mueven un estado, no texto.

      Si el destino no esta en el ciclo no se escribe nada. Mandar
      `shift+tab` sin saber a donde lleva deja al usuario en un modo que no
      pidio, que es peor que no hacer nada.
    */
    case 'agent.mode': {
      if (registry.get(message.terminalId) === null) {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'));
        break;
      }
      /*
        El ciclo es de la CLI de la pestana. Una que no lo declara —o una
        consola, que no tiene CLI— no recibe ninguna tecla: contar
        pulsaciones sobre un ciclo que no existe deja a la pestana donde
        nadie pidio.
      */
      const cycle = adapterOf(message.terminalId)?.capabilities.permissionCycle ?? null;
      if (cycle === null) {
        sendError(socket, 'agent-unsupported', serverText('modesUnsupported'));
        break;
      }
      /*
        Sin suscripcion el hub no sabe nada de la pestana, y ahi esta donde
        la lanzo la aplicacion: el modo de arranque de su CLI, o el de solo
        lectura en una pestana de revision (hito 49).
      */
      const capabilities = adapterOf(message.terminalId)?.capabilities ?? null;
      const current =
        conversations.getPermissionMode(message.terminalId) ??
        (capabilities === null
          ? cycle.launchMode
          : (launchModeFor(capabilities, registry.get(message.terminalId)?.review === true) ?? cycle.launchMode));
      /*
        Las pulsaciones se cuentan sobre el ciclo de la CLI de la pestana,
        y con una CLI cuya tecla aprueba lo pendiente no se escribe nada
        mientras haya una confirmacion abierta (ver `planModeChange`).
      */
      const plan = planModeChange({
        cycle,
        current,
        target: message.mode,
        waitingFor: conversations.getWaitingFor(message.terminalId),
      });
      if (plan.kind === 'none') break;
      if (plan.kind === 'refused') {
        sendError(socket, 'mode-failed', plan.text);
        break;
      }
      const { keys } = plan;
      /*
        Se anota a donde vamos **antes** de escribir, no despues: el
        archivo no lo va a decir hasta que la CLI procese un turno, y sin
        esto dos cambios seguidos partirian los dos del mismo lugar.
      */
      conversations.setPermissionMode(message.terminalId, message.mode);
      /*
        Por la fila, para no intercalarse con un envio, pero sin dejarse
        cortar por una interrupcion: un Esc no mueve el modo, y cortar las
        pulsaciones a mitad dejaria la pestana en un modo intermedio que
        nadie pidio y que no es el que se acaba de anotar.
      */
      void writeQueue.enqueue(
        message.terminalId,
        async (lane) => {
          await lane.writePieces(keys, ANSWER_KEY_INTERVAL_MS, pieceWriter(socket, message.terminalId));
        },
        { interruptible: false },
      );
      break;
    }
    /*
      Esc no hace fila: tiene que llegar ya. Lo que faltaba escribir en esa
      terminal se descarta antes, para que no caiga detras del Esc un
      Enter que mande lo que el usuario acaba de interrumpir.
    */
    case 'agent.interrupt':
      interruptAgent(socket, message.terminalId, { resend: false });
      break;
    /*
      "Forzar envio ahora" (hito 45, §6.35): que el agente lea ya lo que
      espera en la cola de la CLI. Es para cuando va por mal camino. Se
      comprueba todo antes de escribir nada: escribir de mas en una pty no
      se deshace. Con su tecla de "enviar ya" (Claude Code, Antigravity), por
      la fila de la pestana: no puede caer en medio de un pegado. Sin tecla
      (Pi), se detiene y se vuelve a mandar lo que la CLI devuelve.
    */
    case 'agent.forceSend': {
      const { terminalId, requestId } = message;
      let replied = false;
      const reply = (sent: boolean): void => {
        if (replied) return;
        replied = true;
        send(socket, { type: 'agent.forceSent', terminalId, requestId, sent });
      };
      const refuse = (code: ServerErrorCode, text: ServerText): void => {
        sendError(socket, code, text, undefined, requestId);
        reply(false);
      };
      const adapter = adapterOf(terminalId);
      const method = adapter !== null && adapter.capabilities.forceSend ? (adapter.promptQueue?.forceSend ?? null) : null;
      if (method === null) {
        refuse('agent-unsupported', serverText('forceSendUnsupported'));
        break;
      }
      const tab = registry.get(terminalId);
      if (tab === null || !tab.alive) {
        refuse('force-send-failed', serverText('forceSendNoCli'));
        break;
      }
      // Con un permiso o una pregunta abiertos, las teclas caerian en ese menu.
      if (registry.activityOf(terminalId) === 'waiting') {
        refuse('force-send-failed', serverText('forceSendWaiting'));
        break;
      }
      // Sin nada en cola no hay que forzar nada: y en Pi, un Esc cortaria el turno por nada.
      if (!conversations.hasQueue(terminalId)) {
        refuse('force-send-failed', serverText('forceSendNothing'));
        break;
      }
      conversations.markQueueForced(terminalId);
      if (method === 'interrupt-and-resend') {
        if (interruptAgent(socket, terminalId, { resend: true })) reply(true);
        else refuse('force-send-failed', serverText('forceSendFailed'));
        break;
      }
      const keys = buildForceSendKeys(method);
      void writeQueue
        .enqueue(
          terminalId,
          async (lane) => {
            const outcome = await lane.writePieces([keys], 0, pieceWriter(socket, terminalId));
            debugLog('write', `force send to ${terminalId.slice(0, 8)}: ${method}, ${outcome}`);
            if (outcome === 'written') reply(true);
            else refuse('force-send-failed', serverText('forceSendFailed'));
          },
          { interruptible: false },
        )
        .then(() => reply(false));
      break;
    }
    /*
      Sacar la cola de la CLI para editarla en el cuadro (§6.35.1), como la
      flecha arriba de la CLI. Se comprueba todo lo que se puede antes de
      escribir nada; despues, cada paso lo comprueba el driver en la
      pantalla. Por la fila de la pestana y sin dejarse cortar: un envio que
      llegara en el medio caeria en la caja de la CLI con lo que salio.
    */
    case 'agent.editQueue': {
      const { terminalId, requestId } = message;
      let replied = false;
      const reply = (edited: boolean): void => {
        if (replied) return;
        replied = true;
        send(socket, { type: 'agent.queueEdited', terminalId, requestId, edited });
      };
      const refuse = (code: ServerErrorCode, text: ServerText, detail?: string): void => {
        sendError(socket, code, text, detail, requestId);
        reply(false);
      };
      const adapter = adapterOf(terminalId);
      const driver = adapter !== null && adapter.capabilities.editQueue ? (adapter.queueEdit ?? null) : null;
      if (adapter === null || driver === null) {
        refuse('agent-unsupported', serverText('queueEditUnsupported'));
        break;
      }
      const tab = registry.get(terminalId);
      if (tab === null || !tab.alive) {
        refuse('queue-edit-failed', serverText('queueEditNoCli'));
        break;
      }
      // Con un permiso o una pregunta abiertos, la flecha moveria ese menu.
      if (registry.activityOf(terminalId) === 'waiting') {
        refuse('queue-edit-failed', serverText('queueEditWaiting'));
        break;
      }
      const queue = conversations.queueSnapshot(terminalId);
      if (queue.length === 0) {
        refuse('queue-edit-failed', serverText('queueEditNothing'));
        break;
      }
      // Forzado, ya se le esta pasando al agente: no queda nada que sacar.
      if (queue.some((prompt) => prompt.forced === true)) {
        refuse('queue-edit-failed', serverText('queueEditForced'));
        break;
      }
      const fromApp = adapter.promptQueue?.source === 'app';
      const queued = fromApp ? conversations.appQueueTexts(terminalId) : [];
      void writeQueue
        .enqueue(
          terminalId,
          async () => {
            const screen = registry.watchScreen(terminalId);
            if (screen === null) {
              refuse('queue-edit-failed', serverText('queueEditNoCli'));
              return;
            }
            let outcome: QueueEditOutcome;
            try {
              outcome = await driver.run(
                {
                  // La tecla de vaciar se anota como las demas: dos seguidas cierran Pi.
                  write: (data) => {
                    const written = registry.write(terminalId, data);
                    if (written && data.includes(CLEAR_EDITOR)) queuedSubmits.noteClearKey(terminalId, Date.now());
                    return written;
                  },
                  screen: () => screen.lines(),
                  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                  now: Date.now,
                },
                {
                  target: tab.sessionId.length === 0 ? null : { cwd: tab.cwd, sessionId: tab.sessionId },
                  queued,
                  lastClearKeyAt: queuedSubmits.lastClearKeyAt(terminalId),
                },
              );
            } catch (error) {
              console.warn(`[queue-edit] ${terminalId.slice(0, 8)}:`, error);
              outcome = { kind: 'failed', reason: 'gone' };
            } finally {
              screen.dispose();
            }
            debugLog('write', `queue edit of ${terminalId.slice(0, 8)}: ${JSON.stringify(outcome)}`);
            // Lo que la app llevaba en cola ya no esta en la CLI: salio, o quedo en su caja.
            if (fromApp && (outcome.kind === 'done' || outcome.reason === 'not-cleared')) {
              conversations.clearQueued(terminalId);
              // Y Detener ya no tiene nada que recuperar de su editor (Pi, hito 43).
              if (adapter.queuedSubmits !== undefined) queuedSubmits.forget(terminalId);
            }
            if (outcome.kind === 'failed') {
              refuse('queue-edit-failed', queueEditFailureText(outcome.reason), outcome.reason);
              return;
            }
            const texts = outcome.texts.length > 0 ? outcome.texts : queued;
            const text = texts.filter((each) => each.trim().length > 0).join('\n\n');
            if (text.length > 0) send(socket, { type: 'composer.prefill', terminalId, text, reason: 'queue-edit' });
            reply(true);
          },
          { interruptible: false },
        )
        .then(() => reply(false));
      break;
    }
    /*
      Volver a antes de un mensaje (hito 44, §4.16): la app maneja el menu de
      rewind de la CLI mirando su pantalla en cada paso, y el mensaje vuelve
      al cuadro. Por la fila de la pestana y sin dejarse cortar: un envio que
      llegara en el medio caeria como teclas sobre el menu.
    */
    case 'agent.rewind': {
      const { terminalId, eventId, requestId } = message;
      const adapter = adapterOf(terminalId);
      const driver = adapter !== null && adapter.capabilities.rewind ? (adapter.rewind ?? null) : null;
      if (driver === null) {
        sendError(socket, 'agent-unsupported', serverText('rewindUnsupported'), undefined, requestId);
        break;
      }
      const tab = registry.get(terminalId);
      if (tab === null || !tab.alive) {
        sendError(socket, 'rewind-failed', serverText('rewindNoCli'), undefined, requestId);
        break;
      }
      // Con la CLI trabajando o esperando, `Esc Esc` interrumpe en vez de abrir el menu.
      if (registry.activityOf(terminalId) !== 'idle') {
        sendError(socket, 'rewind-failed', serverText('rewindBusy'), undefined, requestId);
        break;
      }
      const target = conversations.rewindTarget(terminalId, eventId);
      if (target === null) {
        sendError(socket, 'rewind-failed', serverText('rewindUnknownMessage'), undefined, requestId);
        break;
      }
      const restoreCode = message.restore === 'conversation-and-code';
      const session = { cwd: tab.cwd, sessionId: tab.sessionId };
      void writeQueue.enqueue(
        terminalId,
        async () => {
          const screen = registry.watchScreen(terminalId);
          if (screen === null) {
            sendError(socket, 'rewind-failed', serverText('rewindNoCli'), undefined, requestId);
            return;
          }
          // Las ultimas pantallas distintas que se leyeron: con la traza, es lo que explica un fallo.
          const seen: string[] = [];
          let outcome: RewindOutcome;
          try {
            outcome = await driver.run(
              {
                write: (data) => registry.write(terminalId, data),
                screen: async () => {
                  const lines = await screen.lines();
                  const text = lines.join('\n');
                  if (seen.at(-1) !== text) seen.push(text);
                  if (seen.length > 4) seen.shift();
                  return lines;
                },
                wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                now: Date.now,
              },
              {
                firstLine: target.firstLine,
                occurrence: Math.max(1, target.occurrence),
                maxSteps: target.promptsFromHere + REWIND_EXTRA_STEPS,
                restoreCode,
              },
            );
          } catch (error) {
            console.warn(`[rewind] ${terminalId.slice(0, 8)}:`, error);
            outcome = { kind: 'failed', reason: 'gone' };
          } finally {
            screen.dispose();
          }
          debugLog('write', `rewind of ${terminalId.slice(0, 8)}: ${JSON.stringify(outcome)}`);
          if (outcome.kind === 'failed') debugLog('rewind', `last screens:\n${seen.join('\n-----\n')}`);
          if (outcome.kind === 'failed') {
            sendError(
              socket,
              'rewind-failed',
              outcome.reason === 'gone' ? serverText('rewindNoCli') : serverText('rewindFailed'),
              outcome.reason,
              requestId,
            );
            return;
          }
          // El hilo lo tiene recortado si era largo: el cuadro lo recibe entero.
          const text = target.truncated ? ((await driver.fullText(session, eventId)) ?? target.text) : target.text;
          if (text.trim().length > 0) {
            send(socket, { type: 'composer.prefill', terminalId, text, reason: 'rewound' });
          }
          conversations.withdraw(terminalId, eventId);
          send(socket, { type: 'agent.rewound', terminalId, requestId, codeRestored: outcome.codeRestored });
        },
        { interruptible: false },
      );
      break;
    }
  }
}
