/**
 * Gestion del historial de comandos shell por terminal (Lane F / Per-Terminal History).
 *
 * Cada terminal o pestana de terminal posee su propio archivo persistente
 * de historial de comandos shell, separado del historial global de ~/.bash_history
 * o ~/.zsh_history.
 *
 * De este modo, tras un reinicio de la maquina o un fallo del sistema, cada
 * terminal recupera unicamente sus propios comandos anteriores y el usuario
 * puede retomar su trabajo de inmediato pulsando Flecha Arriba.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { terminalCommandHistoryDir, terminalCommandHistoryPath } from '../../shared/app-paths.js';

export interface PrepareHistoryOptions {
  /** Directorio base para pruebas o aislamiento. Por omision: terminalCommandHistoryDir(). */
  baseDir?: string;
  /** Ruta explicita del archivo de origen para sembrar. */
  sourceHistoryPath?: string;
  /** Maximo de lineas recientes a sembrar en la creacion inicial. Por omision: 500. */
  maxSeedLines?: number;
}

const DEFAULT_MAX_SEED_LINES = 500;

/**
 * Resuelve la ruta del historial global por defecto del usuario segun la shell.
 */
function defaultGlobalHistoryPath(shellName?: string): string {
  const home = homedir();
  if (shellName === 'zsh') {
    return path.join(home, '.zsh_history');
  }
  return path.join(home, '.bash_history');
}

/**
 * Prepara el archivo de historial de comandos dedicado para una terminal.
 *
 * Si el archivo ya existe (por ejemplo, tras recuperar la sesion o tras un reinicio),
 * se conserva intacto para que la terminal reanude con su historial previo.
 *
 * Si no existe aun, se crea con permisos 0600 y se inicializa opcionalmente con
 * las ultimas lineas del historial del usuario para no arrancar vacio en el primer uso.
 */
export async function prepareTerminalCommandHistory(
  historyId: string,
  shellName?: string,
  options: PrepareHistoryOptions = {},
): Promise<string> {
  const targetDir = options.baseDir ?? terminalCommandHistoryDir();
  const historyFile = options.baseDir
    ? path.join(options.baseDir, `${historyId}.history`)
    : terminalCommandHistoryPath(historyId);

  try {
    if (existsSync(historyFile)) {
      return historyFile;
    }

    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(targetDir, 0o700);
    } catch {
      // Ignorar fallos de chmod en sistemas de archivos no POSIX
    }

    let seedContent = '';
    const sourcePath = options.sourceHistoryPath ?? defaultGlobalHistoryPath(shellName);
    const maxLines = options.maxSeedLines ?? DEFAULT_MAX_SEED_LINES;

    if (maxLines > 0 && existsSync(sourcePath)) {
      try {
        const sourceStat = await stat(sourcePath);
        // Limitar lectura si el archivo de origen es enorme (maximo 256 KB)
        const readLength = Math.min(sourceStat.size, 256 * 1024);
        const fd = await readFile(sourcePath);
        const slice = fd.length > readLength ? fd.subarray(fd.length - readLength) : fd;
        const text = slice.toString('utf-8');
        const lines = text.split('\n').filter((line) => line.trim().length > 0);
        const recent = lines.slice(-maxLines);
        seedContent = recent.join('\n');
        if (seedContent.length > 0) {
          seedContent += '\n';
        }
      } catch {
        seedContent = '';
      }
    }

    await writeFile(historyFile, seedContent, { mode: 0o600, flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') {
        return;
      }
      throw err;
    });

    try {
      await chmod(historyFile, 0o600);
    } catch {
      // Ignorar fallos de chmod en sistemas de archivos no POSIX
    }

    return historyFile;
  } catch (error) {
    console.warn(`[terminal-command-history] Failed preparing history for ${historyId}:`, error);
    return historyFile;
  }
}
