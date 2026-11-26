/**
 * Desktop main process diagnostics.
 *
 * The supported launcher starts Electron with stdio on /dev/null, so anything
 * the main process prints is lost. This module keeps a small, bounded log file
 * and installs the process level handlers that write to it:
 *
 *   - a rotating file logger that never throws (every write is guarded);
 *   - console.error/console.warn mirroring into the file;
 *   - stdout/stderr 'error' handlers that ignore EPIPE only;
 *   - uncaughtException (log, then the fatal dialog and a non-zero exit) and
 *     unhandledRejection (log only) handlers;
 *   - child-process-gone and render-process-gone logging.
 *
 * Secrets are redacted before anything reaches the file: query strings,
 * `token=` parameters and long hex strings. Environment variables are never
 * logged.
 */

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Path segments under the XDG state directory. The single place a rebrand changes. */
export const DESKTOP_LOG_PATH_SEGMENTS = Object.freeze(['workbench', 'logs']);
export const DESKTOP_LOG_FILENAME = 'desktop-main.log';
export const DESKTOP_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DESKTOP_LOG_KEEP = 2;
const MAX_ENTRY_CHARS = 16 * 1024;

/**
 * WORKBENCH_DESKTOP_LOG_DIR wins. A non-production instance with its own data
 * directory (test and dev harnesses) logs inside it, so it never writes into the
 * installed instance's log. Otherwise `${XDG_STATE_HOME:-~/.local/state}/workbench/logs`.
 */
export function resolveDesktopLogDir({ env = process.env, homedir = os.homedir } = {}) {
  if (env.WORKBENCH_DESKTOP_LOG_DIR && path.isAbsolute(env.WORKBENCH_DESKTOP_LOG_DIR)) return path.resolve(env.WORKBENCH_DESKTOP_LOG_DIR);
  if (env.WORKBENCH_DESKTOP_PRODUCTION !== '1' && env.WORKBENCH_DESKTOP_DATA_DIR && path.isAbsolute(env.WORKBENCH_DESKTOP_DATA_DIR)) {
    return path.join(path.resolve(env.WORKBENCH_DESKTOP_DATA_DIR), 'logs');
  }
  const stateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(homedir(), '.local', 'state');
  return path.join(stateHome, ...DESKTOP_LOG_PATH_SEGMENTS);
}

/** Removes secrets from text that is about to be logged. */
export function redact(text) {
  return String(text)
    // Any URL loses its query string and fragment.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?[redacted]')
    // Bare token-like parameters outside URLs.
    .replace(/\b((?:access_|auth_|refresh_)?token|password|secret|cookie)=([^\s&;"']+)/gi, '$1=[redacted]')
    // Long hex strings (auth tokens, passwords generated with randomBytes).
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]');
}

/** A readable, single string description of a thrown value. */
export function describeError(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); }
}

/**
 * A bounded append-only log file. Every method swallows its own failures: a
 * diagnostic logger must never be the reason the process dies.
 */
export function createDiagnosticLogger({
  dir = resolveDesktopLogDir(),
  filename = DESKTOP_LOG_FILENAME,
  maxBytes = DESKTOP_LOG_MAX_BYTES,
  keep = DESKTOP_LOG_KEEP,
  fs = nodeFs,
  now = () => new Date(),
} = {}) {
  const file = path.join(dir, filename);
  let dirReady = false;

  function ensureDir() {
    if (dirReady) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    dirReady = true;
  }

  function rotateIfNeeded(incoming) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size + incoming <= maxBytes) return;
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try { fs.renameSync(from, `${file}.${i}`); } catch {}
    }
    if (keep < 1) { try { fs.unlinkSync(file); } catch {} }
  }

  function write(level, ...parts) {
    try {
      let message = redact(parts.map(part => (typeof part === 'string' ? part : describeError(part))).join(' '));
      if (message.length > MAX_ENTRY_CHARS) message = `${message.slice(0, MAX_ENTRY_CHARS)} [truncated]`;
      const line = `${now().toISOString()} [${level}] pid=${process.pid} ${message}\n`;
      ensureDir();
      rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      dirReady = false;
      return false;
    }
  }

  return {
    file,
    dir,
    write,
    info: (...parts) => write('info', ...parts),
    warn: (...parts) => write('warn', ...parts),
    error: (...parts) => write('error', ...parts),
  };
}

/**
 * Stream 'error' handler that ignores EPIPE (the reader of stdout/stderr went
 * away) and rethrows anything else, which keeps the default fatal behaviour for
 * every other error.
 */
export function ignoreEpipeOnly(error) {
  if (error && error.code === 'EPIPE') return;
  throw error;
}

/**
 * Mirrors console.error/console.warn into the log file, keeping the console
 * output, and guards stdout/stderr against EPIPE. Returns an uninstall function.
 */
export function installConsoleMirror({ logger, consoleRef = console, streams = [process.stdout, process.stderr] }) {
  const originals = { error: consoleRef.error, warn: consoleRef.warn };
  for (const level of ['error', 'warn']) {
    const original = originals[level];
    consoleRef[level] = (...args) => {
      logger.write(level, ...args);
      try { original.apply(consoleRef, args); } catch (error) { if (error?.code !== 'EPIPE') throw error; }
    };
  }
  const guarded = streams.filter(stream => stream && typeof stream.on === 'function');
  for (const stream of guarded) stream.on('error', ignoreEpipeOnly);
  return () => {
    consoleRef.error = originals.error;
    consoleRef.warn = originals.warn;
    for (const stream of guarded) stream.removeListener('error', ignoreEpipeOnly);
  };
}

/** `{ releaseId, commit }` from the release meta file of an installed release, or null. */
export function readReleaseInfo(appPath, { fs = nodeFs } = {}) {
  if (typeof appPath !== 'string' || !appPath) return null;
  for (const candidate of [path.join(appPath, '.workbench-release-meta.json'), path.resolve(appPath, '..', '..', '.workbench-release-meta.json')]) {
    try {
      const meta = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const releaseId = typeof meta?.releaseId === 'string' ? meta.releaseId.slice(0, 128) : null;
      const commit = typeof meta?.commit === 'string' ? meta.commit.slice(0, 64) : null;
      if (releaseId || commit) return { releaseId, commit };
    } catch {}
  }
  return null;
}

export const MAIN_PROCESS_ERROR_TITLE = 'A JavaScript error occurred in the main process';

/**
 * uncaughtException and unhandledRejection handlers for the main process.
 *
 * Electron's own uncaughtException handler steps aside once another listener
 * exists, so this one reproduces its dialog (same title, `Uncaught Exception:`
 * prefix and stack) and then exits with code 1: after an uncaught exception
 * the main process state is unknown, so it is treated as fatal. Rejections are
 * logged only, as Node reports them as warnings in the Electron main process.
 *
 * Every collaborator is injected so the fatal path is testable.
 */
export function installFatalHandlers({
  processRef = process,
  logger,
  lifecycle = () => 'unknown',
  context = () => ({}),
  showErrorBox,
  exit = code => processRef.exit(code),
}) {
  let handling = false;

  function header(kind) {
    const ctx = (() => { try { return context() || {}; } catch { return {}; } })();
    const fields = [
      `kind=${kind}`,
      `processType=${processRef.type || 'browser'}`,
      `lifecycle=${(() => { try { return lifecycle(); } catch { return 'unknown'; } })()}`,
    ];
    if (ctx.version) fields.push(`version=${ctx.version}`);
    if (ctx.releaseId) fields.push(`release=${ctx.releaseId}`);
    if (ctx.commit) fields.push(`commit=${ctx.commit}`);
    return fields.join(' ');
  }

  const onUncaught = (error, origin) => {
    logger.error(`${header('uncaughtException')} origin=${origin || 'uncaughtException'}\n${describeError(error)}`);
    if (handling) { exit(1); return; }
    handling = true;
    try {
      const stack = error instanceof Error ? (error.stack || error.message) : describeError(error);
      showErrorBox?.(MAIN_PROCESS_ERROR_TITLE, `Uncaught Exception:\n${stack}`);
    } catch (dialogError) {
      logger.error('could not show the error dialog', dialogError);
    }
    exit(1);
  };

  const onRejection = (reason) => {
    logger.error(`${header('unhandledRejection')}\n${describeError(reason)}`);
  };

  processRef.on('uncaughtException', onUncaught);
  processRef.on('unhandledRejection', onRejection);
  return {
    onUncaught,
    onRejection,
    uninstall() {
      processRef.removeListener('uncaughtException', onUncaught);
      processRef.removeListener('unhandledRejection', onRejection);
    },
  };
}

/** Logs child-process-gone and render-process-gone app events. */
export function installProcessGoneLogging({ app, logger }) {
  app.on('child-process-gone', (_event, details = {}) => {
    logger.warn(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ''}`);
  });
  app.on('render-process-gone', (_event, _webContents, details = {}) => {
    logger.warn(`render-process-gone type=renderer reason=${details.reason} exitCode=${details.exitCode}`);
  });
}

/**
 * Composition helper for main.mjs: one logger, console mirroring, fatal
 * handlers and process-gone logging, with the lifecycle state tracked from app
 * events. Must run before anything else in the main process.
 */
export function installDesktopDiagnostics({ app, dialog, env = process.env, processRef = process }) {
  const logger = createDiagnosticLogger({ dir: resolveDesktopLogDir({ env }) });
  let lifecycle = 'before-ready';
  app.once('ready', () => { if (lifecycle === 'before-ready') lifecycle = 'ready'; });
  app.once('before-quit', () => { lifecycle = 'quitting'; });
  const release = (() => { try { return readReleaseInfo(app.getAppPath()); } catch { return null; } })();
  const version = (() => { try { return app.getVersion(); } catch { return null; } })();
  installConsoleMirror({ logger });
  installFatalHandlers({
    processRef,
    logger,
    lifecycle: () => lifecycle,
    context: () => ({ version, releaseId: release?.releaseId, commit: release?.commit }),
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
    exit: code => app.exit(code),
  });
  installProcessGoneLogging({ app, logger });
  logger.info(`desktop main starting version=${version ?? '?'}${release?.releaseId ? ` release=${release.releaseId}` : ''}`);
  return logger;
}
