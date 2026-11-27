/**
 * Trusted Linux graphical session environment resolver (WB-13).
 *
 * Resolves only a strict allowlist of validated local graphical session
 * variables at terminal spawn time so newly opened or relaunched PTYs reflect
 * the current active local graphical session even when workbench.service or
 * workbench-ptyd.service started before graphical login or across session
 * changes.
 *
 * Security invariants:
 * - Never invokes a shell when querying systemd/logind.
 * - Never evaluates systemd output as shell code.
 * - Never reads, copies, or logs XAUTHORITY file contents.
 * - Never imports credentials, tokens, PATH, HOME, GPU overrides, or
 *   XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS from external session blocks.
 * - Never injects host graphical variables into remotely initiated PTYs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REQUIRED_GRAPHICAL_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_SESSION_TYPE',
] as const;

export const OPTIONAL_GRAPHICAL_ENV_KEYS = [
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_DESKTOP',
] as const;

export const GRAPHICAL_ENV_ALLOWLIST = [
  ...REQUIRED_GRAPHICAL_ENV_KEYS,
  ...OPTIONAL_GRAPHICAL_ENV_KEYS,
] as const;

export type GraphicalEnvKey = (typeof GRAPHICAL_ENV_ALLOWLIST)[number];
export type GraphicalEnvMap = Partial<Record<GraphicalEnvKey, string>>;

const ALLOWLIST_SET: ReadonlySet<string> = new Set(GRAPHICAL_ENV_ALLOWLIST);
const GRAPHICAL_SESSION_TYPES = new Set(['wayland', 'x11', 'mir']);
const LOCAL_DISPLAY_RE = /^:(\d{1,5})(?:\.(\d{1,3}))?$/;
const WAYLAND_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DESKTOP_ID_RE = /^[A-Za-z0-9_.:+-]{1,128}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const MAX_VALUE_LENGTH = 1024;
const MAX_LOGINCTL_SESSIONS = 32;

export interface CommandExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number; env: NodeJS.ProcessEnv },
) => Promise<CommandExecResult>;

export interface GraphicalSessionResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly x11SocketDir?: string;
  readonly systemctlBin?: string;
  readonly loginctlBin?: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly runCommand?: CommandRunner;
}

export interface ResolveGraphicalEnvContext {
  readonly remoteClient?: boolean;
}

export type GraphicalEnvResolver = (
  baseEnv: Record<string, string>,
  context?: ResolveGraphicalEnvContext,
) => Promise<Record<string, string>>;

interface LoginctlUserInfo {
  readonly display: string;
  readonly sessions: readonly string[];
  readonly runtimePath: string;
}

interface LoginctlSessionInfo {
  readonly id: string;
  readonly user: string;
  readonly state: string;
  readonly active: string;
  readonly type: string;
  readonly sessionClass: string;
  readonly remote: string;
  readonly display: string;
  readonly desktop: string;
}

const launchOriginStorage = new AsyncLocalStorage<{ remoteClient: boolean }>();

/**
 * Runs a WebSocket dispatch callback under an explicit launch-origin context so
 * any terminal spawned inside that async call chain knows whether a paired
 * remote client initiated it.
 */
export function runWithTerminalLaunchOrigin<T>(
  remoteClient: boolean,
  fn: () => T,
): T {
  return launchOriginStorage.run({ remoteClient }, fn);
}

/** True when the current async chain was initiated by a paired remote client. */
export function isRemoteClientLaunchContext(): boolean {
  return launchOriginStorage.getStore()?.remoteClient === true;
}

function isGraphicalEnvKey(key: string): key is GraphicalEnvKey {
  return ALLOWLIST_SET.has(key);
}

function defaultRunCommand(
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number; env: NodeJS.ProcessEnv },
): Promise<CommandExecResult> {
  return execFileAsync(file, [...args], {
    shell: false,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    encoding: 'utf8',
    killSignal: 'SIGTERM',
    env: options.env,
  });
}

function sanitizedCommandEnv(baseEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  if (typeof baseEnv['PATH'] === 'string') env['PATH'] = baseEnv['PATH'];
  if (typeof baseEnv['XDG_RUNTIME_DIR'] === 'string') env['XDG_RUNTIME_DIR'] = baseEnv['XDG_RUNTIME_DIR'];
  if (typeof baseEnv['DBUS_SESSION_BUS_ADDRESS'] === 'string') {
    env['DBUS_SESSION_BUS_ADDRESS'] = baseEnv['DBUS_SESSION_BUS_ADDRESS'];
  }
  return env;
}

/**
 * Decodes a systemd ANSI-C `$'...'` quoted value without invoking any shell.
 * Returns null if the syntax is malformed or yields control/NUL characters.
 */
function decodeAnsiCString(raw: string): string | null {
  if (!raw.startsWith("$'") || !raw.endsWith("'") || raw.length < 3) return null;
  const inner = raw.slice(2, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "'") return null;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    if (i >= inner.length) return null;
    const esc = inner[i]!;
    switch (esc) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e':
      case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '?': out += '?'; break;
      case 'x': {
        const hex = inner.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{1,2}$/.test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        out += String.fromCharCode(code);
        i += hex.length;
        break;
      }
      case 'u': {
        const hex = inner.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = inner.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
        const cp = Number.parseInt(hex, 16);
        if (cp > 0x10ffff) return null;
        out += String.fromCodePoint(cp);
        i += 8;
        break;
      }
      default: {
        if (/^[0-7]$/.test(esc)) {
          let oct = esc;
          while (oct.length < 3 && i + 1 < inner.length && /^[0-7]$/.test(inner[i + 1]!)) {
            i++;
            oct += inner[i]!;
          }
          out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
        } else {
          return null;
        }
      }
    }
  }
  return out;
}

/**
 * Parses `systemctl --user show-environment` output and retains only allowlisted
 * graphical environment keys. Malformed lines and non-allowlisted entries are
 * discarded immediately.
 */
export function parseSystemdEnvironment(stdout: string): GraphicalEnvMap {
  const result: GraphicalEnvMap = {};
  if (typeof stdout !== 'string' || stdout.length === 0) return result;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const eqIdx = rawLine.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = rawLine.slice(0, eqIdx);
    if (!isGraphicalEnvKey(key)) continue;
    const rawValue = rawLine.slice(eqIdx + 1);
    const decoded = rawValue.startsWith("$'") ? decodeAnsiCString(rawValue) : rawValue;
    if (decoded === null || decoded.length === 0 || decoded.length > MAX_VALUE_LENGTH) continue;
    if (CONTROL_CHARS_RE.test(decoded)) continue;
    result[key] = decoded;
  }
  return result;
}

function parseKeyValueLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    if (!CONTROL_CHARS_RE.test(value)) {
      result[key] = value;
    }
  }
  return result;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function isSystemdUnavailableError(error: unknown): boolean {
  if (isErrorWithCode(error, 'ENOENT')) return true;
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { message?: string; stderr?: string };
  const text = `${err.message ?? ''}\n${err.stderr ?? ''}`;
  return (
    text.includes('System has not been booted with systemd') ||
    text.includes('Failed to connect to bus') ||
    text.includes('Failed to connect to user scope bus') ||
    text.includes('No medium found')
  );
}

function isLoginctlUnavailableError(error: unknown): boolean {
  if (isErrorWithCode(error, 'ENOENT')) return true;
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { message?: string; stderr?: string };
  const text = `${err.message ?? ''}\n${err.stderr ?? ''}`;
  return (
    text.includes('System has not been booted with systemd') ||
    text.includes('Failed to connect to system scope bus')
  );
}

function isValidRuntimeDir(dir: string, uid: number | null): boolean {
  if (!path.isAbsolute(dir) || CONTROL_CHARS_RE.test(dir)) return false;
  try {
    const lst = lstatSync(dir);
    if (!lst.isDirectory()) return false;
    if (uid !== null && lst.uid !== uid) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveValidatedRuntimeDir(
  preferredRuntimePath: string | undefined,
  baseEnv: Record<string, string>,
  uid: number | null,
): string | null {
  const candidates: string[] = [];
  if (preferredRuntimePath) candidates.push(preferredRuntimePath);
  if (typeof baseEnv['XDG_RUNTIME_DIR'] === 'string') candidates.push(baseEnv['XDG_RUNTIME_DIR']);
  if (uid !== null) candidates.push(`/run/user/${uid}`);
  for (const candidate of candidates) {
    if (isValidRuntimeDir(candidate, uid)) return candidate;
  }
  return null;
}

function isValidWaylandSocket(
  waylandDisplay: string,
  runtimeDir: string | null,
  uid: number | null,
): boolean {
  if (!waylandDisplay || waylandDisplay.length > 256 || CONTROL_CHARS_RE.test(waylandDisplay)) {
    return false;
  }
  let socketPath: string;
  if (path.isAbsolute(waylandDisplay)) {
    const normalized = path.posix.normalize(waylandDisplay);
    if (normalized !== waylandDisplay || waylandDisplay.split('/').includes('..')) return false;
    socketPath = normalized;
  } else {
    if (waylandDisplay === '.' || waylandDisplay === '..' || !WAYLAND_NAME_RE.test(waylandDisplay)) {
      return false;
    }
    if (runtimeDir === null) return false;
    socketPath = path.join(runtimeDir, waylandDisplay);
  }
  try {
    const st = lstatSync(socketPath);
    if (!st.isSocket()) return false;
    if (uid !== null && st.uid !== uid) return false;
    return true;
  } catch {
    return false;
  }
}

function parseLocalDisplayNumber(display: string): string | null {
  const match = LOCAL_DISPLAY_RE.exec(display);
  return match ? match[1]! : null;
}

function isValidLocalX11Display(
  display: string,
  x11SocketDir: string,
  uid: number | null,
): boolean {
  const num = parseLocalDisplayNumber(display);
  if (num === null) return false;
  const socketPath = path.join(x11SocketDir, `X${num}`);
  try {
    const st = statSync(socketPath);
    if (!st.isSocket()) return false;
    if (uid !== null && st.uid !== uid && st.uid !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

function isValidXauthorityPath(xauth: string, uid: number | null): boolean {
  if (!xauth || !path.isAbsolute(xauth) || CONTROL_CHARS_RE.test(xauth)) return false;
  const normalized = path.posix.normalize(xauth);
  if (normalized !== xauth || xauth.split('/').includes('..')) return false;
  try {
    // Metadata and access check only: never open or read XAUTHORITY contents.
    const lst = lstatSync(xauth);
    if (uid !== null && lst.uid !== uid) return false;
    const st = lst.isSymbolicLink() ? statSync(xauth) : lst;
    if (!st.isFile()) return false;
    if (uid !== null && st.uid !== uid) return false;
    accessSync(xauth, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function validateCandidates(
  candidates: GraphicalEnvMap,
  context: {
    runtimeDir: string | null;
    x11SocketDir: string;
    uid: number | null;
    session?: LoginctlSessionInfo | null;
  },
): GraphicalEnvMap {
  const validated: GraphicalEnvMap = {};
  const { runtimeDir, x11SocketDir, uid, session } = context;

  // If the systemd manager snapshot explicitly declares a session type or desktop
  // that disagrees with the selected active loginctl session, the manager block is
  // stale/from another session; discard it conservatively.
  if (session !== null && session !== undefined) {
    if (
      candidates.XDG_SESSION_TYPE !== undefined &&
      candidates.XDG_SESSION_TYPE !== session.type
    ) {
      return {};
    }
    if (
      session.desktop.length > 0 &&
      candidates.XDG_SESSION_DESKTOP !== undefined &&
      candidates.XDG_SESSION_DESKTOP !== session.desktop
    ) {
      return {};
    }
  }

  const effectiveType = session?.type ?? candidates.XDG_SESSION_TYPE;

  const waylandCandidate = candidates.WAYLAND_DISPLAY;
  if (
    waylandCandidate !== undefined &&
    effectiveType !== 'x11' &&
    isValidWaylandSocket(waylandCandidate, runtimeDir, uid)
  ) {
    validated.WAYLAND_DISPLAY = waylandCandidate;
  }

  const displayCandidate = candidates.DISPLAY;
  // In a Wayland session, an XWayland DISPLAY is only associated with the active
  // session when the session's Wayland display socket itself is also validated.
  const canAcceptDisplay =
    effectiveType !== 'wayland' || validated.WAYLAND_DISPLAY !== undefined;
  if (
    canAcceptDisplay &&
    displayCandidate !== undefined &&
    isValidLocalX11Display(displayCandidate, x11SocketDir, uid)
  ) {
    const sessionDisplayNum = session?.display ? parseLocalDisplayNumber(session.display) : null;
    const candidateDisplayNum = parseLocalDisplayNumber(displayCandidate);
    if (sessionDisplayNum === null || sessionDisplayNum === candidateDisplayNum) {
      validated.DISPLAY = displayCandidate;
    }
  }

  const xauthCandidate = candidates.XAUTHORITY;
  if (
    xauthCandidate !== undefined &&
    validated.DISPLAY !== undefined &&
    isValidXauthorityPath(xauthCandidate, uid)
  ) {
    validated.XAUTHORITY = xauthCandidate;
  }

  const sessionTypeCandidate = candidates.XDG_SESSION_TYPE;
  if (
    sessionTypeCandidate !== undefined &&
    GRAPHICAL_SESSION_TYPES.has(sessionTypeCandidate) &&
    (session === null || session === undefined || session.type === sessionTypeCandidate)
  ) {
    if (
      (sessionTypeCandidate === 'wayland' && validated.WAYLAND_DISPLAY !== undefined) ||
      (sessionTypeCandidate === 'x11' && validated.DISPLAY !== undefined) ||
      (sessionTypeCandidate === 'mir' &&
        (validated.WAYLAND_DISPLAY !== undefined || validated.DISPLAY !== undefined))
    ) {
      validated.XDG_SESSION_TYPE = sessionTypeCandidate;
    }
  }

  const hasValidDisplayEndpoint =
    validated.WAYLAND_DISPLAY !== undefined || validated.DISPLAY !== undefined;

  if (hasValidDisplayEndpoint) {
    const currentDesktop = candidates.XDG_CURRENT_DESKTOP;
    if (currentDesktop !== undefined && DESKTOP_ID_RE.test(currentDesktop)) {
      validated.XDG_CURRENT_DESKTOP = currentDesktop;
    }
    const sessionDesktop = candidates.XDG_SESSION_DESKTOP;
    if (sessionDesktop !== undefined && DESKTOP_ID_RE.test(sessionDesktop)) {
      validated.XDG_SESSION_DESKTOP = sessionDesktop;
    }
  }

  return validated;
}

function extractAllowlistedFromEnv(env: Record<string, string>): GraphicalEnvMap {
  const extracted: GraphicalEnvMap = {};
  for (const key of GRAPHICAL_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH && !CONTROL_CHARS_RE.test(value)) {
      extracted[key] = value;
    }
  }
  return extracted;
}

function stripAllowlistedGraphicalEnv(baseEnv: Record<string, string>): Record<string, string> {
  const result = { ...baseEnv };
  for (const key of GRAPHICAL_ENV_ALLOWLIST) {
    delete result[key];
  }
  return result;
}

function isSshRemoteEnvironment(env: Record<string, string>): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']);
}

type LoginctlLookupResult =
  | { readonly status: 'unavailable' }
  | { readonly status: 'none'; readonly runtimePath?: string }
  | { readonly status: 'ambiguous'; readonly runtimePath?: string }
  | { readonly status: 'single'; readonly session: LoginctlSessionInfo; readonly runtimePath?: string };

async function queryLoginctlSession(
  runCommand: CommandRunner,
  loginctlBin: string,
  uid: number,
  timeoutMs: number,
  maxBufferBytes: number,
  cmdEnv: NodeJS.ProcessEnv,
): Promise<LoginctlLookupResult> {
  let userStdout: string;
  try {
    const res = await runCommand(
      loginctlBin,
      ['show-user', String(uid), '-p', 'Display', '-p', 'Sessions', '-p', 'RuntimePath'],
      { timeoutMs, maxBufferBytes, env: cmdEnv },
    );
    userStdout = res.stdout;
  } catch (error) {
    if (isLoginctlUnavailableError(error)) return { status: 'unavailable' };
    // User is not logged in / has no active logind sessions.
    return { status: 'none' };
  }

  const userFields = parseKeyValueLines(userStdout);
  const userInfo: LoginctlUserInfo = {
    display: userFields['Display'] ?? '',
    sessions: (userFields['Sessions'] ?? '')
      .split(/\s+/)
      .filter((sid) => sid.length > 0 && SESSION_ID_RE.test(sid))
      .slice(0, MAX_LOGINCTL_SESSIONS),
    runtimePath: userFields['RuntimePath'] ?? '',
  };

  if (userInfo.sessions.length === 0) {
    return { status: 'none', runtimePath: userInfo.runtimePath || undefined };
  }

  const sessionResults = await Promise.all(
    userInfo.sessions.map(async (sid): Promise<LoginctlSessionInfo | null> => {
      try {
        const res = await runCommand(
          loginctlBin,
          [
            'show-session',
            sid,
            '-p', 'Id',
            '-p', 'User',
            '-p', 'State',
            '-p', 'Active',
            '-p', 'Type',
            '-p', 'Class',
            '-p', 'Remote',
            '-p', 'Display',
            '-p', 'Desktop',
          ],
          { timeoutMs, maxBufferBytes, env: cmdEnv },
        );
        const fields = parseKeyValueLines(res.stdout);
        return {
          id: fields['Id'] ?? sid,
          user: fields['User'] ?? '',
          state: fields['State'] ?? '',
          active: fields['Active'] ?? '',
          type: fields['Type'] ?? '',
          sessionClass: fields['Class'] ?? '',
          remote: fields['Remote'] ?? '',
          display: fields['Display'] ?? '',
          desktop: fields['Desktop'] ?? '',
        };
      } catch {
        return null;
      }
    }),
  );

  // All non-closing local graphical user sessions share the same per-UID
  // systemd --user environment block; reject if multiple exist concurrently.
  const localGraphical = sessionResults.filter(
    (s): s is LoginctlSessionInfo =>
      s !== null &&
      s.user === String(uid) &&
      s.sessionClass === 'user' &&
      s.remote === 'no' &&
      (s.state === 'active' || s.state === 'online') &&
      GRAPHICAL_SESSION_TYPES.has(s.type),
  );

  if (localGraphical.length === 0) {
    return { status: 'none', runtimePath: userInfo.runtimePath || undefined };
  }
  if (localGraphical.length > 1) {
    return { status: 'ambiguous', runtimePath: userInfo.runtimePath || undefined };
  }
  const single = localGraphical[0]!;
  if (single.active !== 'yes' || single.state !== 'active') {
    return { status: 'none', runtimePath: userInfo.runtimePath || undefined };
  }
  if (userInfo.display.length > 0 && userInfo.display !== single.id) {
    return { status: 'ambiguous', runtimePath: userInfo.runtimePath || undefined };
  }
  return {
    status: 'single',
    session: single,
    runtimePath: userInfo.runtimePath || undefined,
  };
}

/**
 * Creates a bounded, non-interactive graphical session environment resolver.
 * Concurrent calls share one in-flight lookup so parallel launches observe a
 * consistent snapshot without retaining a stale TTL cache across logins/logouts.
 */
export function createGraphicalSessionEnvResolver(
  options: GraphicalSessionResolverOptions = {},
): GraphicalEnvResolver {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const x11SocketDir = options.x11SocketDir ?? '/tmp/.X11-unix';
  const systemctlBin = options.systemctlBin ?? 'systemctl';
  const loginctlBin = options.loginctlBin ?? 'loginctl';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const runCommand = options.runCommand ?? defaultRunCommand;

  let inFlight: Promise<GraphicalEnvMap> | null = null;

  const lookupHostGraphicalEnv = (baseEnv: Record<string, string>): Promise<GraphicalEnvMap> => {
    if (inFlight !== null) return inFlight;

    const job = (async (): Promise<GraphicalEnvMap> => {
      const cmdEnv = sanitizedCommandEnv(baseEnv);

      const systemdPromise = (async () =>
        runCommand(systemctlBin, ['--user', 'show-environment'], {
          timeoutMs,
          maxBufferBytes,
          env: cmdEnv,
        })
      )()
        .then((res) => ({ ok: true as const, env: parseSystemdEnvironment(res.stdout) }))
        .catch((error: unknown) => ({ ok: false as const, unavailable: isSystemdUnavailableError(error) }));

      const loginctlPromise: Promise<LoginctlLookupResult> =
        uid === null
          ? Promise.resolve({ status: 'unavailable' })
          : queryLoginctlSession(runCommand, loginctlBin, uid, timeoutMs, maxBufferBytes, cmdEnv);

      const [systemdResult, loginctlResult] = await Promise.all([systemdPromise, loginctlPromise]);

      const preferredRuntimePath =
        loginctlResult.status !== 'unavailable' ? loginctlResult.runtimePath : undefined;
      const runtimeDir = resolveValidatedRuntimeDir(preferredRuntimePath, baseEnv, uid);

      if (systemdResult.ok) {
        if (loginctlResult.status === 'none' || loginctlResult.status === 'ambiguous') {
          return {};
        }
        return validateCandidates(systemdResult.env, {
          runtimeDir,
          x11SocketDir,
          uid,
          session: loginctlResult.status === 'single' ? loginctlResult.session : null,
        });
      }

      if (!systemdResult.unavailable) {
        // systemd lookup failed or timed out without indicating absence of systemd:
        // do not re-inject stale display variables; keep terminal usable.
        return {};
      }

      // Non-systemd Linux fallback: preserve validated local graphical variables
      // already in baseEnv when not inside an SSH/remote or ambiguous session.
      if (loginctlResult.status === 'none' || loginctlResult.status === 'ambiguous') {
        return {};
      }
      if (isSshRemoteEnvironment(baseEnv)) {
        return {};
      }
      return validateCandidates(extractAllowlistedFromEnv(baseEnv), {
        runtimeDir,
        x11SocketDir,
        uid,
        session: loginctlResult.status === 'single' ? loginctlResult.session : null,
      });
    })().finally(() => {
      if (inFlight === job) inFlight = null;
    });

    inFlight = job;
    return job;
  };

  return async (
    baseEnv: Record<string, string>,
    context: ResolveGraphicalEnvContext = {},
  ): Promise<Record<string, string>> => {
    if (platform !== 'linux') {
      return { ...baseEnv };
    }

    const stripped = stripAllowlistedGraphicalEnv(baseEnv);
    if (context.remoteClient === true) {
      return stripped;
    }

    const resolved = await lookupHostGraphicalEnv(baseEnv);
    return {
      ...stripped,
      ...resolved,
    };
  };
}
