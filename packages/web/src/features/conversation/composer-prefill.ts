import type { TerminalId } from '@agent-workbench/shared';

/** Un texto que llego para el cuadro de una pestana y todavia no se aplico. */
export interface ComposerPrefill {
  /** Unico por llegada: el cuadro no aplica dos veces el mismo. */
  id: number;
  terminalId: TerminalId;
  text: string;
  /** Hito 49. Los que van como fichas de texto pegado, con su marca al final del texto. */
  pasted: readonly string[];
  /** El cuadro toma el foco: el usuario lo trajo para editarlo (§6.35.1). */
  focus: boolean;
}
