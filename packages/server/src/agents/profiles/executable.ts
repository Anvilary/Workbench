/**
 * Resolve ONLY the configured executable. No provider-wide lookup, alternate
 * accounts, shell invocations, --version or model API probes.
 */
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export type ExecutableResult =
  | { readonly status: 'available'; readonly file: string }
  | { readonly status: 'not-installed' | 'error'; readonly reason: string };

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export async function resolveConfiguredExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutableResult> {
  if (!executable) return { status: 'error', reason: 'Configure an executable for this profile.' };
  if (/[\u0000-\u001f\u007f]/.test(executable)) {
    return { status: 'error', reason: 'Executable contains invalid characters.' };
  }
  if (platform === 'win32') {
    return { status: 'error', reason: 'Agency profile execution requires Ubuntu/POSIX; Windows shims are not yet supported.' };
  }

  const candidates: string[] = [];
  if (path.isAbsolute(executable)) {
    candidates.push(executable);
  } else if (COMMAND.test(executable)) {
    const directories = (environment['PATH'] ?? '').split(path.delimiter).filter(Boolean);
    for (const directory of directories) {
      if (path.isAbsolute(directory)) candidates.push(path.join(directory, executable));
    }
  } else {
    return { status: 'error', reason: 'Executable must be an absolute path or a single literal command name.' };
  }

  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      await access(resolved, constants.X_OK);
      return { status: 'available', file: resolved };
    } catch {
      // The explicitly configured executable is absent or not accessible.
    }
  }
  return { status: 'not-installed', reason: 'Configured executable is missing or not executable.' };
}
