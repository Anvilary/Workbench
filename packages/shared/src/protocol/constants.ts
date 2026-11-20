/**
 * Protocolo WebSocket entre el navegador y el servidor local.
 *
 * Version 7 — la copia propia.
 *
 * Cambio de la v1 a la v2: el WebSocket dejo de ser duenio de la pty. Las
 * terminales viven en el servidor y el socket solo se engancha a ellas. Por eso
 * existen `terminal.attach` y `terminal.replay`: un cliente que reconecta
 * recupera la pantalla sin que el proceso se haya enterado de nada.
 *
 * Lo que agrega la v3: la familia `conversation.*`. El servidor sigue el JSONL
 * de la sesion de una pestana y manda eventos ya recortados. El navegador nunca
 * ve una linea cruda del JSONL — pueden pesar 290 KB.
 *
 * Lo que agrega la v4: `git.*` y `files.*`. Las dos familias se dirigen a una
 * pestana por `terminalId` y **nunca** llevan una ruta absoluta: el servidor
 * resuelve todo dentro del `cwd` de esa pestana. Un servidor que lanza procesos
 * no puede aceptar rutas arbitrarias de un cliente, aunque el cliente sea el
 * navegador del propio usuario.
 *
 * Lo que agrega la v5: `terminal.open` lleva `kind`. Con `shell` se abre la
 * consola del sistema en vez de la CLI. Es el mismo transporte —`input`,
 * `resize`, `terminal.attach` no cambian— porque del lado del servidor las dos
 * cosas son una pty y nada mas; lo unico que cambia es que se lanza.
 *
 * Lo que cambia en la v6: `hello` deja de describir **una** CLI con campos
 * sueltos y trae la lista `agents`, cada una con sus capacidades, mas
 * `defaultAgent`. `terminal.open` puede pedir una CLI con `agent`, y una accion
 * que la CLI de la pestana no declara se rechaza con `agent-unsupported` en vez
 * de fallar a ciegas. `terminal.activity` suma `unknown`, para la CLI que no
 * publica su estado.
 *
 * Lo que cambia en la v7: la familia `vault.*` (la copia propia, hito 28), y
 * `SessionSummary` suma `storage` y `partial` y puede traer un `agent`
 * importado. Ningun `vault.*` nombra una ruta: la carpeta nueva es donde esta
 * parado un selector del servidor, una sesion se pide por `(agent, sessionId)`
 * y un proyecto por su `key`.
 *
 * Lo que agrega el hito 29 sin subir la version, porque es aditivo (D24):
 * `session.continue`, `session.continued`, `composer.prefill`,
 * `search.global`, `search.progress`, `search.results`, `search.cancel` y los
 * errores `continue-failed` y `search-failed`; y `offlineReason` en
 * `terminal.activity`, opcional. Un cliente anterior ignora los mensajes y el
 * campo nuevos, y uno anterior no manda ninguno de los pedidos.
 *
 * Lo que agrega el hito 37 sin subir la version, por lo mismo: la familia
 * `remote.*` (el acceso remoto, CLAUDE.md 14), `remoteClient` en `hello` y los
 * errores `remote-failed` y `remote-refused`. Ningun `remote.*` lleva una
 * credencial: el codigo para emparejar va solo al socket que lo pidio, y la
 * credencial de un equipo no viaja nunca por el WebSocket.
 *
 * Lo que agrega el hito 38 sin subir la version: `remote.phone.start`,
 * `remote.phone.cancel` y `remote.phone.pairing`, para emparejar la app de
 * Android (CLAUDE.md 14.9). `remote.phone.pairing` si lleva un secreto -la
 * semilla de la llave SSH del telefono, dentro del texto del QR-, y por eso va
 * solo al socket que lo pidio, como el codigo.
 *
 * Y las mejoras de la 0.4.0, sin subir la version: `composer.draft` y
 * `composer.drafts`, el borrador del cuadro guardado entre arranques (§6.29).
 * Un servidor anterior rechaza `composer.draft` con `bad-message`; la web solo
 * lo manda despues de recibir un `composer.drafts`, que ese servidor no manda.
 *
 * Y las mejoras del hilo, sin subir la version (§6.30): `requestId` en
 * `agent.submit` y su respuesta `agent.submitted`, que dice si el mensaje llego
 * a la CLI; y `conversation.subagents`, con `subagents` en `conversation.reset`,
 * los subagentes que siguen trabajando (§4.15). Un servidor anterior no contesta
 * ni manda nada de eso, y la web lo lleva como "sin acuse" y "sin subagentes".
 *
 * Y el hito 45, sin subir la version (§6.35): la cola de mensajes que esperan
 * en la CLI, en `conversation.queue`, en `queue` dentro de `conversation.reset`
 * y, opcional, dentro del `conversation.append` que la cambio; y el pedido
 * `agent.forceSend` con su respuesta `agent.forceSent` y el error
 * `force-send-failed`. Un servidor anterior no manda cola ni contesta el pedido,
 * y la web no ofrece el boton sin la capacidad `forceSend`. Despues, tambien sin
 * subirla (§6.35.1): `agent.editQueue` con su respuesta `agent.queueEdited`, el
 * error `queue-edit-failed` y el motivo `queue-edit` de `composer.prefill`. Un
 * servidor anterior no contesta el pedido, y la web no ofrece editar la cola
 * sin la capacidad `editQueue`.
 *
 * Y el hito 47, sin subir la version (§6.37): `plan.limits`, los limites del
 * plan de cada CLI, y `planLimitsSetup` en `AgentInfo`. Un servidor anterior no
 * los manda, y la web no dibuja el medidor del plan.
 *
 * Y el hito 48, sin subir la version (§6.38): la familia `worktree.*` (las ramas
 * aparte), el error `worktree-failed`, el motivo `requested` de
 * `composer.prefill`, y `worktree` en el descriptor de una pestana y en una
 * sesion, e `isGitRepo` en un proyecto, opcionales. Un servidor anterior no
 * contesta ningun `worktree.*` y no manda los campos, y la web no ofrece ramas
 * aparte sin `isGitRepo`.
 *
 * Y el hito 49, sin subir la version: `worktree.changes`, `changesDiff`,
 * `planReview`, `requestReview`, `sendReview`, `catchUp`, `planIntegrate` e
 * `integrate`, con sus respuestas; el estado contra la base y la revision en
 * cada fila, `readOnlyLaunch` en las capacidades, `review` en el descriptor,
 * `pasted` y `requestId` en `composer.prefill`, y la punta de la rama en el plan
 * de integrar y en `integrate`, todos opcionales. Un servidor anterior no manda
 * nada de eso, y la web no ofrece las acciones nuevas sin `behind` en la fila.
 *
 * Y la pregunta leida de la pantalla de la CLI (23-10-2026, §5.5.4), sin subir
 * la version: `conversation.liveQuestion` y `liveQuestion` en
 * `conversation.reset`, opcional. Se contesta con el `agent.answer` de siempre,
 * con el id que trae. Un servidor anterior no la manda, y la web sigue con la
 * barra de "esperando".
 *
 * Reglas:
 *  - Sin `any`. Lo que entra de la red es `unknown` hasta que un parser lo
 *    estrecha.
 *  - Uniones discriminadas por `type`.
 *  - Un mensaje desconocido no rompe: se ignora y se avisa.
 */


/** Se incrementa cuando el contrato cambia de forma incompatible. */
export const PROTOCOL_VERSION = 8;

/** Ruta del WebSocket. El resto del servidor sirve la UI. */
export const WS_PATH = '/ws';

/** Nombre del parametro de query que lleva el token de arranque. */
export const TOKEN_QUERY_PARAM = 'token';
