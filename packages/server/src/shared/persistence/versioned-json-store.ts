import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomically } from '../../atomic-write.js';

export interface LoadWithBackupOptions<T> {
  filePath: string;
  parse: (contents: string) => T;
  emptyValue?: () => T;
  isUnsupportedSchemaError?: (error: unknown) => boolean;
  recoveryErrorMessage?: string;
  onQuarantine?: (quarantinePath: string) => void;
}

export interface LoadWithBackupResult<T> {
  value: T;
  recoveredFromBackup: boolean;
}

/**
 * Loads a versioned JSON snapshot with fail-closed `.bak` fallback and
 * forensic quarantine of corrupted primary files.
 *
 * Future schema version errors are never treated as corruption and never
 * downgraded via an older `.bak` file.
 */
export async function loadWithBackupRecovery<T>(
  options: LoadWithBackupOptions<T>,
): Promise<LoadWithBackupResult<T>> {
  const {
    filePath,
    parse,
    emptyValue,
    isUnsupportedSchemaError,
    recoveryErrorMessage = 'Persisted store could not be recovered',
    onQuarantine,
  } = options;

  let primaryMissing = false;
  let primaryFailure: unknown = null;

  try {
    const contents = await readFile(filePath, 'utf8');
    return { value: parse(contents), recoveredFromBackup: false };
  } catch (error) {
    if (isUnsupportedSchemaError?.(error)) throw error;
    primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    primaryFailure = error;
  }

  let recovered: T;
  try {
    const backupContents = await readFile(`${filePath}.bak`, 'utf8');
    recovered = parse(backupContents);
  } catch (backupError) {
    if (isUnsupportedSchemaError?.(backupError)) throw backupError;
    const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
    if (primaryMissing && backupMissing && emptyValue) {
      return { value: emptyValue(), recoveredFromBackup: false };
    }
    throw new AggregateError([primaryFailure, backupError], recoveryErrorMessage);
  }

  if (!primaryMissing) {
    // Preserve damaged primary bytes before any subsequent save can rotate `.bak`.
    const quarantinePath = `${filePath}.corrupt-${randomUUID()}`;
    await rename(filePath, quarantinePath);
    onQuarantine?.(quarantinePath);
  }

  return { value: recovered, recoveredFromBackup: true };
}

export interface WriteSnapshotWithBackupOptions {
  filePath: string;
  content: Buffer | string;
  dirMode?: number;
  fileMode?: number;
  write?: typeof writeAtomically;
}

/**
 * Rotates the existing primary snapshot into `.bak` and atomically replaces
 * the primary file.
 */
export async function writeSnapshotWithBackup(options: WriteSnapshotWithBackupOptions): Promise<void> {
  const {
    filePath,
    content,
    dirMode = 0o700,
    fileMode = 0o600,
    write = writeAtomically,
  } = options;

  await mkdir(path.dirname(filePath), { recursive: true, mode: dirMode });
  await copyFile(filePath, `${filePath}.bak`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  await write(filePath, buffer, { mode: fileMode });
}
