/**
 * Conjunto acotado de terminales con xterm montado (WB-05).
 *
 * Todas las pestanas vivas conservan su pty en el servidor, pero no todas
 * necesitan una instancia de xterm en el navegador: cada una pesa su scrollback
 * (`ACTIVE_TERMINAL_SCROLLBACK` lineas), su DOM, su suscripcion de salida y sus
 * observadores. Con decenas de terminales abiertas eso es la mayor parte de la
 * memoria del renderer.
 *
 * Regla: se montan las terminales visibles mas las `WARM_TERMINAL_LIMIT` que se
 * vieron mas recientemente. Las demas desmontan su xterm y mandan
 * `terminal.detach`; el proceso sigue corriendo. Al volver a mostrarse se montan
 * de nuevo y piden el replay completo (`reset:true`), que trae la pantalla
 * emulada del servidor: pantalla alterna, cursor y SGR incluidos.
 *
 * El estado vive en el modulo, no en React: sobrevive al desmontaje de la vista
 * y lo comparten todos los espacios de trabajo.
 */

import { useEffect, useSyncExternalStore } from 'react';

/** Terminales que siguen montadas aunque no se vean. Unica constante de la politica. */
export const WARM_TERMINAL_LIMIT = 6;

/** Cuantas terminales recuerda la lista de uso reciente. Acota la memoria del modulo. */
const MAX_RECENT = 32;

/**
 * Lo que el replay del servidor no puede reconstruir.
 *
 * `offset` es el ultimo byte crudo que se le aplico a ese xterm antes de
 * desmontarlo. No se usa para pedir el replay (un xterm nuevo esta vacio y una
 * rodaja incremental pintaria el hueco sobre la nada: hace falta la pantalla
 * completa), sino para verificar continuidad: el replay que llega al volver
 * tiene que terminar en un offset mayor o igual.
 */
export interface TerminalRestorePoint {
  readonly offset?: number;
  /** El usuario estaba al final de la salida, no leyendo hacia atras. */
  readonly atBottom: boolean;
  /** Linea del buffer donde estaba el viewport, si no estaba al final. */
  readonly viewportLine: number;
}

const restorePoints = new Map<string, TerminalRestorePoint>();
const visible = new Set<string>();
/** Ids por ultima vez vistos, del mas reciente al mas viejo. */
const recent: string[] = [];
const subscribers = new Set<() => void>();
let mounted: ReadonlySet<string> = new Set<string>();

function computeMounted(): ReadonlySet<string> {
  const next = new Set<string>(visible);
  let warm = 0;
  for (const id of recent) {
    if (visible.has(id)) continue;
    if (warm >= WARM_TERMINAL_LIMIT) break;
    next.add(id);
    warm++;
  }
  return next;
}

function publish(): void {
  const next = computeMounted();
  if (next.size === mounted.size) {
    let same = true;
    for (const id of next) {
      if (!mounted.has(id)) { same = false; break; }
    }
    if (same) return;
  }
  mounted = next;
  for (const notify of subscribers) notify();
}

/** La terminal esta a la vista: se monta y pasa al frente de la lista reciente. */
export function noteTerminalVisible(terminalId: string): void {
  const at = recent.indexOf(terminalId);
  if (at !== -1) recent.splice(at, 1);
  recent.unshift(terminalId);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  visible.add(terminalId);
  publish();
}

/** La terminal dejo de verse: queda caliente mientras entre en el presupuesto. */
export function noteTerminalHidden(terminalId: string): void {
  if (!visible.delete(terminalId)) return;
  publish();
}

export function isTerminalMounted(terminalId: string): boolean {
  return mounted.has(terminalId);
}

export function subscribeWarmSet(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function rememberTerminalRestore(terminalId: string, point: TerminalRestorePoint): void {
  restorePoints.set(terminalId, point);
}

export function readTerminalRestore(terminalId: string): TerminalRestorePoint | undefined {
  return restorePoints.get(terminalId);
}

/** La terminal se fue de la vista para siempre (pestana cerrada o movida de espacio). */
export function forgetTerminal(terminalId: string): void {
  restorePoints.delete(terminalId);
  const at = recent.indexOf(terminalId);
  if (at !== -1) recent.splice(at, 1);
  visible.delete(terminalId);
  publish();
}

/** Solo para pruebas: el estado del modulo es global y se comparte entre casos. */
export function resetWarmSet(): void {
  restorePoints.clear();
  visible.clear();
  recent.length = 0;
  mounted = new Set<string>();
  for (const notify of subscribers) notify();
}

/** Para pruebas y medicion: ids con xterm montado, en orden de uso reciente. */
export function mountedTerminals(): readonly string[] {
  return recent.filter((id) => mounted.has(id)).concat([...mounted].filter((id) => !recent.includes(id)));
}

/**
 * true si esta terminal debe tener su xterm montado.
 *
 * `terminalId` null (pestana sin proceso) no participa del conjunto.
 */
export function useTerminalWarm(terminalId: string | null, isVisible: boolean): boolean {
  useEffect(() => {
    if (terminalId === null) return;
    if (isVisible) noteTerminalVisible(terminalId);
    else noteTerminalHidden(terminalId);
    return () => { noteTerminalHidden(terminalId); };
  }, [terminalId, isVisible]);

  return useSyncExternalStore(
    subscribeWarmSet,
    () => (terminalId === null ? false : isTerminalMounted(terminalId)),
    () => false,
  );
}
