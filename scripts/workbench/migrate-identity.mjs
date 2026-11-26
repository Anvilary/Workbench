#!/usr/bin/env node
// Identity migration: legacy MAW / Agent Workbench installation to the canonical Workbench identity.
//
// Single implementation, two entry points:
//   - CLI: `migrate-identity.mjs plan|apply|verify|rollback|clean` (the Linux CLI calls this).
//   - Library: `migrateConfigDir({ legacyDir, canonicalDir })`, used by server startup on non-systemd
//     installs (Windows, npm) where only the config directory needs migrating.
//
// Semantics: COPY, never move. The legacy installation stays intact until `clean`.
//
// Safety: the CLI refuses to run unless `--home <dir>` is given explicitly, or HOME is the real home
// directory AND `--i-am-the-owner` is passed. Every XDG path is derived under `--home`; an inherited
// XDG_* variable pointing outside it is a refusal, never silently ignored.
//
// Node built-ins and the config-copy implementation shared with standalone startup.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export { migrateConfigDir } from './migrate-config.mjs';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;
export const EXIT_AWAITING_RUNTIME = 3;

/** userData entries excluded from the copy, matched by exact basename at any depth. */
export const USERDATA_EXCLUDES = Object.freeze([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'ShaderCache',
  'Crashpad',
]);

const STEP_NAMES = Object.freeze([
  'backup',
  'config',
  'env',
  'userdata',
  'helpers',
  'release',
  'runtime',
  'units',
  'desktop',
]);

const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 96, 128, 192, 256, 512]);

const LEGACY_UNITS = Object.freeze(['maw.service', 'maw-ptyd.service']);
const CANONICAL_UNITS = Object.freeze(['workbench-ptyd.service', 'workbench.service']);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

class Refusal extends Error {
  constructor(message, code = EXIT_REFUSED) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** Walk `dir` and return `{ "<relative/posix/path>": "<sha256>" }`. Symlinks are recorded as their target. */
export function fileManifest(dir, filter = () => true) {
  const manifest = {};
  if (!isDirectory(dir)) return manifest;
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (!filter(rel, entry)) continue;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isSymbolicLink()) {
        manifest[rel] = `symlink:${fs.readlinkSync(full)}`;
      } else if (entry.isFile()) {
        manifest[rel] = sha256File(full);
      }
    }
  };
  walk(dir, '');
  return manifest;
}

function manifestEquals(a, b) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (a[aKeys[i]] !== b[bKeys[i]]) return false;
  }
  return true;
}

function dirSize(dir, filter = () => true) {
  let total = 0;
  if (!exists(dir)) return 0;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return stat.size;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!filter(full, entry)) continue;
    if (entry.isDirectory()) total += dirSize(full, filter);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function writeFileMode(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Argument parsing and the hard safety guard
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'home', 'config-home', 'data-home', 'state-home', 'runtime-dir',
  'bin-dir', 'lib-dir', 'unit-dir', 'legacy-state-dir',
  'systemctl-cmd', 'gsettings-cmd', 'tar-cmd', 'initial-release-cmd', 'readiness-cmd',
  'proc-root', 'free-space-bytes', 'electron-root', 'electron-version',
  'unit-template', 'ptyd-unit-template', 'helpers-source', 'icon-source',
  'source', 'expect-commit', 'commit-map', 'commit-map-sha256',
]);

const BOOL_FLAGS = new Set(['i-am-the-owner', 'accept', 'yes', 'dry-run', 'quiet', 'help']);

export function parseArgs(argv) {
  const options = { command: null, flags: {}, bools: {} };
  let index = 0;
  if (argv[index] !== undefined && !argv[index].startsWith('--')) {
    options.command = argv[index];
    index += 1;
  }
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Refusal(`Unexpected argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (BOOL_FLAGS.has(name)) {
      options.bools[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Refusal(`Unknown option: --${name}`);
    if (eq !== -1) {
      options.flags[name] = body.slice(eq + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Refusal(`Option --${name} needs a value`);
    options.flags[name] = value;
    index += 1;
  }
  return options;
}

/**
 * The hard guard. Either an explicit `--home` (development and tests), or the real home plus
 * `--i-am-the-owner`. Any inherited XDG_* variable pointing outside the chosen home is a refusal.
 */
function assertAllowedToRun(options, env) {
  const explicitHome = options.flags['home'];
  if (explicitHome !== undefined) {
    if (!isDirectory(explicitHome)) throw new Refusal(`--home is not a directory: ${explicitHome}`);
    const home = fs.realpathSync(explicitHome);
    if (home === path.resolve(os.userInfo().homedir) && options.bools['i-am-the-owner'] !== true) {
      throw new Refusal('--home points at the real home directory: pass --i-am-the-owner to allow it.');
    }
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
      const value = env[name];
      if (value === undefined || value === '') continue;
      const flagName = { XDG_CONFIG_HOME: 'config-home', XDG_DATA_HOME: 'data-home', XDG_STATE_HOME: 'state-home', XDG_RUNTIME_DIR: 'runtime-dir' }[name];
      if (options.flags[flagName] !== undefined) continue;
      if (!isInside(home, value) && home !== path.resolve(os.userInfo().homedir)) {
        throw new Refusal(`${name}=${value} resolves outside --home ${home}. Pass --${flagName} explicitly.`);
      }
    }
    return home;
  }
  const home = env['HOME'];
  if (home === undefined || home === '') throw new Refusal('No --home given and HOME is unset.');
  if (path.resolve(home) !== path.resolve(os.userInfo().homedir)) {
    throw new Refusal('HOME is not the real home directory: pass --home explicitly.');
  }
  if (options.bools['i-am-the-owner'] !== true) {
    throw new Refusal('Refusing to run against the real home directory without --i-am-the-owner.');
  }
  return path.resolve(home);
}

// ---------------------------------------------------------------------------
// Path model
// ---------------------------------------------------------------------------

export function resolveContext(options, env = process.env) {
  const home = assertAllowedToRun(options, env);
  const explicitHome = options.flags['home'] !== undefined;
  const xdg = (flag, envName, fallback) => {
    const flagValue = options.flags[flag];
    if (flagValue !== undefined) return path.resolve(flagValue);
    const envValue = env[envName];
    if (envValue !== undefined && envValue !== '' && (!explicitHome || isInside(home, envValue))) return path.resolve(envValue);
    return path.join(home, fallback);
  };
  const configHome = xdg('config-home', 'XDG_CONFIG_HOME', '.config');
  const dataHome = xdg('data-home', 'XDG_DATA_HOME', '.local/share');
  const stateHome = xdg('state-home', 'XDG_STATE_HOME', '.local/state');
  const realHome = home === fs.realpathSync(os.userInfo().homedir);
  const runtimeDir = realHome && options.flags['runtime-dir'] === undefined && !env.XDG_RUNTIME_DIR
    ? `/run/user/${process.getuid()}`
    : xdg('runtime-dir', 'XDG_RUNTIME_DIR', '.runtime');
  const binDir = options.flags['bin-dir'] !== undefined ? path.resolve(options.flags['bin-dir']) : path.join(home, '.local/bin');
  const unitDir = options.flags['unit-dir'] !== undefined ? path.resolve(options.flags['unit-dir']) : path.join(configHome, 'systemd/user');

  if (!realHome) {
    for (const directory of [configHome, dataHome, stateHome, runtimeDir, binDir, unitDir]) {
      if (!isInside(home, directory)) throw new Refusal(`isolated migration path is outside --home: ${directory}`);
    }
  }

  if (realHome) {
    const fixtureSeams = ['systemctl-cmd', 'gsettings-cmd', 'tar-cmd', 'initial-release-cmd',
      'readiness-cmd', 'proc-root', 'free-space-bytes', 'electron-root', 'electron-version',
      'unit-template', 'ptyd-unit-template', 'helpers-source', 'icon-source'];
    const override = fixtureSeams.find(flag => options.flags[flag] !== undefined);
    if (override) throw new Refusal(`--${override} is available only for isolated test homes`);
  }
  const sourceDir = options.flags['source'] !== undefined ? path.resolve(options.flags['source']) : null;

  const legacy = {
    configDir: path.join(configHome, 'agent-workbench'),
    envDir: path.join(configHome, 'maw'),
    envFile: path.join(configHome, 'maw', 'environment'),
    userData: path.join(dataHome, 'maw-desktop'),
    prototypeUserData: path.join(dataHome, 'maw-desktop-prototype'),
    stateDir: options.flags['legacy-state-dir'] !== undefined ? path.resolve(options.flags['legacy-state-dir']) : path.join(dataHome, 'maw'),
    libDir: path.join(home, '.local/lib/maw'),
    logDir: path.join(stateHome, 'maw/logs'),
    units: LEGACY_UNITS,
    desktopFile: path.join(dataHome, 'applications/maw.desktop'),
    iconName: 'maw-workspace',
    ptydSocket: path.join(runtimeDir, 'maw-ptyd/ptyd.sock'),
    electronRoot: '/opt/maw-electron',
  };
  const canonical = {
    configDir: path.join(configHome, 'workbench'),
    envFile: path.join(configHome, 'workbench', 'environment'),
    userData: path.join(dataHome, 'workbench-desktop'),
    stateDir: path.join(dataHome, 'workbench'),
    libDir: path.join(home, '.local/lib/workbench'),
    logDir: path.join(stateHome, 'workbench/logs'),
    units: CANONICAL_UNITS,
    desktopFile: path.join(dataHome, 'applications/workbench.desktop'),
    iconName: 'workbench',
    ptydSocket: path.join(runtimeDir, 'workbench-ptyd/ptyd.sock'),
    electronRoot: options.flags['electron-root'] !== undefined ? path.resolve(options.flags['electron-root']) : '/opt/workbench-electron',
  };

  const migrationDir = path.join(canonical.stateDir, 'migration');
  return {
    options,
    env,
    home,
    configHome,
    dataHome,
    stateHome,
    runtimeDir,
    binDir,
    unitDir,
    applicationsDir: path.join(dataHome, 'applications'),
    hicolorDir: path.join(dataHome, 'icons/hicolor'),
    legacy,
    canonical,
    migrationDir,
    stateFile: path.join(migrationDir, 'identity-v1.json'),
    binBackupDir: path.join(migrationDir, 'bin-backup'),
    desktopBackupDir: path.join(migrationDir, 'desktop-backup'),
    backupDir: path.join(dataHome, 'workbench-migration-backup'),
    systemctlCmd: splitCommand(options.flags['systemctl-cmd'] ?? 'systemctl'),
    gsettingsCmd: options.flags['gsettings-cmd'] !== undefined ? splitCommand(options.flags['gsettings-cmd']) : realHome ? ['gsettings'] : null,
    tarCmd: splitCommand(options.flags['tar-cmd'] ?? 'tar'),
    initialReleaseCmd: options.flags['initial-release-cmd'] ?? null,
    readinessCmd: options.flags['readiness-cmd'] ?? null,
    procRoot: options.flags['proc-root'] !== undefined ? path.resolve(options.flags['proc-root']) : '/proc',
    freeSpaceBytes: options.flags['free-space-bytes'] !== undefined ? Number(options.flags['free-space-bytes']) : null,
    electronVersion: options.flags['electron-version'] ?? null,
    unitTemplate: options.flags['unit-template'] ?? null,
    ptydUnitTemplate: options.flags['ptyd-unit-template'] ?? null,
    helpersSource: options.flags['helpers-source'] !== undefined ? path.resolve(options.flags['helpers-source']) : sourceDir ? path.join(sourceDir, 'scripts/workbench') : MODULE_DIR,
    iconSource: options.flags['icon-source'] !== undefined ? path.resolve(options.flags['icon-source']) : sourceDir ? path.join(sourceDir, 'packages/desktop/assets/icons') : null,
    sourceDir,
    expectCommit: options.flags['expect-commit'] ?? null,
    commitMap: options.flags['commit-map'] !== undefined ? path.resolve(options.flags['commit-map']) : null,
    commitMapSha256: options.flags['commit-map-sha256'] ?? null,
    realHome,
    quiet: options.bools['quiet'] === true,
    out: [],
  };
}

function splitCommand(value) {
  const parts = String(value).trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Refusal('Empty command given');
  return parts;
}

function say(ctx, line) {
  ctx.out.push(line);
  if (!ctx.quiet) process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function readState(ctx) {
  try {
    const raw = fs.readFileSync(ctx.stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

function emptyState() {
  const now = new Date().toISOString();
  const steps = {};
  for (const name of STEP_NAMES) steps[name] = { status: 'pending' };
  return { version: 1, status: 'in-progress', startedAt: now, updatedAt: now, steps, notes: {} };
}

function writeState(ctx, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(ctx.migrationDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(ctx.canonical.stateDir, 0o700);
    fs.chmodSync(ctx.migrationDir, 0o700);
  } catch {
    // Best effort.
  }
  writeFileMode(ctx.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return state;
}

// ---------------------------------------------------------------------------
// systemd and process inspection
// ---------------------------------------------------------------------------

function runSystemctl(ctx, args, { allowFailure = true } = {}) {
  const [bin, ...prefix] = ctx.systemctlCmd;
  const result = spawnSync(bin, [...prefix, '--user', ...args], { encoding: 'utf8', env: ctx.env });
  if (result.error) {
    if (allowFailure) return { status: 1, stdout: '', stderr: String(result.error.message) };
    throw new Error(`systemctl failed: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function unitActiveState(ctx, unit) {
  return runSystemctl(ctx, ['is-active', unit]).stdout.trim();
}

function unitEnabledState(ctx, unit) {
  return runSystemctl(ctx, ['is-enabled', unit]).stdout.trim();
}

function activeLegacyUnits(ctx) {
  const blocking = [];
  for (const unit of LEGACY_UNITS) {
    const state = unitActiveState(ctx, unit);
    if (state === 'active' || state === 'activating') blocking.push(`${unit} is ${state}`);
  }
  const listed = runSystemctl(ctx, ['list-units', '--all', '--plain', '--no-legend', 'maw-restart-helper*']);
  if ((listed.status ?? 1) !== 0) blocking.push('could not verify the user service manager');
  for (const line of listed.stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    if (/\b(active|activating)\b/.test(text)) blocking.push(`restart helper unit active: ${text.split(/\s+/)[0]}`);
  }
  return blocking;
}

function ownPids(ctx) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let names;
  try {
    names = fs.readdirSync(ctx.procRoot);
  } catch {
    return [];
  }
  const pids = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    if (Number(name) === process.pid) continue;
    try {
      if (uid !== null && fs.statSync(path.join(ctx.procRoot, name)).uid !== uid) continue;
    } catch {
      continue;
    }
    pids.push(name);
  }
  return pids;
}

function unixSocketInodes(ctx, socketPath) {
  const result = new Set();
  let lines;
  try { lines = fs.readFileSync(path.join(ctx.procRoot, 'net/unix'), 'utf8').split('\n'); } catch { return result; }
  for (const line of lines.slice(1)) {
    const match = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(.*)$/.exec(line);
    if (match?.[2] === socketPath) result.add(match[1]);
  }
  return result;
}

function pidsHoldingSocket(ctx, socketPath) {
  const inodes = unixSocketInodes(ctx, socketPath);
  if (inodes.size === 0) return [];
  const holders = [];
  for (const pid of ownPids(ctx)) {
    const fdDir = path.join(ctx.procRoot, pid, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match !== null && inodes.has(match[1])) {
        holders.push(pid);
        break;
      }
    }
  }
  return holders;
}

function pidsUsingUserDataDir(ctx, userDataDir) {
  const users = [];
  for (const pid of ownPids(ctx)) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(ctx.procRoot, pid, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    for (const arg of raw.split('\0')) {
      if (!arg.startsWith('--user-data-dir=')) continue;
      const value = arg.slice('--user-data-dir='.length);
      if (value === '') continue;
      if (path.resolve(value) === path.resolve(userDataDir)) users.push(pid);
    }
  }
  return users;
}

function pidsWithAnyUserDataDir(ctx) {
  const found = [];
  for (const pid of ownPids(ctx)) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(ctx.procRoot, pid, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    for (const arg of raw.split('\0')) {
      if (arg.startsWith('--user-data-dir=')) {
        const dir = path.resolve(arg.slice('--user-data-dir='.length));
        if (dir === path.resolve(ctx.canonical.userData) || dir === path.resolve(ctx.legacy.userData)) found.push({ pid, dir });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function userDataFilter(src) {
  const base = path.basename(src);
  if (USERDATA_EXCLUDES.includes(base)) return false;
  if (base.startsWith('Singleton')) return false;
  return true;
}

function sourcesPresent(ctx) {
  return [
    isDirectory(ctx.legacy.configDir),
    fs.existsSync(ctx.legacy.envFile),
    isDirectory(ctx.legacy.userData),
    isDirectory(ctx.legacy.stateDir),
    isDirectory(ctx.legacy.libDir),
  ].some(Boolean);
}

function destinationConflicts(ctx, state) {
  if (state !== null) return [];
  const conflicts = [];
  const candidates = [
    ['canonical config dir', ctx.canonical.configDir],
    ['canonical env file', ctx.canonical.envFile],
    ['canonical userData', ctx.canonical.userData],
    ['canonical state dir', ctx.canonical.stateDir],
    ['canonical lib dir', ctx.canonical.libDir],
    ['canonical desktop entry', ctx.canonical.desktopFile],
    ...CANONICAL_UNITS.map((unit) => [`unit ${unit}`, path.join(ctx.unitDir, unit)]),
  ];
  for (const [label, target] of candidates) {
    if (exists(target)) conflicts.push(`${label} already exists without a v1 migration state file: ${target}`);
  }
  return conflicts;
}

function copySizeBytes(ctx) {
  return dirSize(ctx.legacy.configDir) + dirSize(ctx.legacy.userData, (full) => userDataFilter(full));
}

function freeSpaceBytes(ctx) {
  if (ctx.freeSpaceBytes !== null) return ctx.freeSpaceBytes;
  const stats = fs.statfsSync(ctx.dataHome, { bigint: false });
  return stats.bavail * stats.bsize;
}

function checkSourceCheckout(ctx) {
  if (ctx.sourceDir === null) return ['--source is required for an identity migration initial release'];
  if (ctx.expectCommit === null || !/^[0-9a-f]{40}$/.test(ctx.expectCommit)) return ['--expect-commit must be an explicit full 40-character SHA'];
  if (ctx.commitMap === null || ctx.commitMapSha256 === null || !/^[0-9a-f]{64}$/.test(ctx.commitMapSha256)) return ['--commit-map and its full --commit-map-sha256 digest are required'];
  if (!isDirectory(ctx.sourceDir)) return [`--source is not a directory: ${ctx.sourceDir}`];
  const problems = [];
  const git = (args) => spawnSync('git', ['-C', ctx.sourceDir, ...args], { encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  if ((head.status ?? 1) !== 0) return [`--source is not a git checkout: ${ctx.sourceDir}`];
  const commit = head.stdout.trim();
  if (ctx.expectCommit !== null && commit !== ctx.expectCommit) {
    problems.push(`--source is at ${commit}, expected ${ctx.expectCommit}`);
  }
  const status = git(['status', '--porcelain']);
  if ((status.status ?? 1) !== 0) problems.push('git status failed on --source');
  else if (status.stdout.trim() !== '') problems.push(`--source checkout is not clean: ${ctx.sourceDir}`);
  let map;
  try {
    const content = fs.readFileSync(ctx.commitMap, 'utf8');
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (digest !== ctx.commitMapSha256) problems.push('--commit-map SHA-256 does not match --commit-map-sha256');
    const rows = content.trim().split(/\r?\n/);
    if (rows.shift()?.trim() !== 'old new') problems.push('--commit-map must use git-filter-repo format with `old new` header');
    map = new Map();
    for (const row of rows) {
      if (row.trim() === '') continue;
      const [oldSha, newSha, ...extra] = row.trim().split(/\s+/);
      if (extra.length !== 0 || !/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) { problems.push('invalid full-SHA row in --commit-map'); break; }
      if (map.has(oldSha)) { problems.push(`duplicate old SHA in --commit-map: ${oldSha}`); break; }
      map.set(oldSha, newSha);
    }
  } catch {
    problems.push(`cannot read --commit-map: ${ctx.commitMap}`);
  }
  const legacyCommit = legacyHealthyCommit(ctx);
  if (legacyCommit === null) problems.push('legacy healthy release commit could not be determined');
  else if (map?.has(legacyCommit) !== true) problems.push(`--commit-map has no row for legacy healthy commit ${legacyCommit}`);
  else {
    const mapped = map.get(legacyCommit);
    const ancestor = git(['merge-base', '--is-ancestor', mapped, ctx.expectCommit]);
    if (mapped === '0'.repeat(40) || (ancestor.status ?? 1) !== 0) problems.push('mapped legacy healthy commit is neither the expected candidate nor its ancestor');
  }
  return problems;
}

function pidsUsingReleaseDir(ctx, stateDir) {
  const releaseDir = path.join(stateDir, 'releases') + path.sep;
  return ownPids(ctx).filter(pid => {
    const proc = path.join(ctx.procRoot, pid);
    try {
      const cwd = fs.readlinkSync(path.join(proc, 'cwd'));
      if (cwd.startsWith(releaseDir)) return true;
    } catch {}
    try {
      const argv = fs.readFileSync(path.join(proc, 'cmdline'), 'utf8').split('\0');
      return argv.some(arg => arg.startsWith(releaseDir));
    } catch {
      return false;
    }
  });
}

function preflight(ctx, state) {
  const refusals = [];
  refusals.push(...activeLegacyUnits(ctx));
  const releaseUsers = pidsUsingReleaseDir(ctx, ctx.legacy.stateDir);
  if (releaseUsers.length) refusals.push(`legacy release still in use by pid(s) ${releaseUsers.join(', ')}`);
  const socketHolders = pidsHoldingSocket(ctx, ctx.legacy.ptydSocket);
  if (socketHolders.length > 0) refusals.push(`legacy PTY socket in use by pid(s) ${socketHolders.join(', ')}: ${ctx.legacy.ptydSocket}`);
  const userDataUsers = pidsUsingUserDataDir(ctx, ctx.legacy.userData);
  if (userDataUsers.length > 0) refusals.push(`legacy userData in use by pid(s) ${userDataUsers.join(', ')}: ${ctx.legacy.userData}`);
  refusals.push(...destinationConflicts(ctx, state));
  refusals.push(...checkSourceCheckout(ctx));
  const needed = copySizeBytes(ctx) * 2;
  const free = freeSpaceBytes(ctx);
  if (free < needed) refusals.push(`insufficient free space: ${free} bytes available, ${needed} needed (2x the copy size)`);
  return refusals;
}

// ---------------------------------------------------------------------------
// Env file transform
// ---------------------------------------------------------------------------

/**
 * Rename the legacy env keys. `MAW_UNSAFE_LOCAL_NO_AUTH` is dropped (never renamed: the migration must
 * not carry token-free mode forward). Unknown keys are kept verbatim and reported by name.
 * Values are never echoed anywhere.
 */
export function transformEnvFile(content, identityPaths = {}) {
  const lines = content.split('\n');
  const outLines = [];
  const dropped = [];
  const renamed = [];
  const unknown = [];
  const collisions = [];
  const emitted = new Map(); // canonical key -> true when it came from a canonical key
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      outLines.push(line);
      continue;
    }
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (match === null) {
      outLines.push(line);
      continue;
    }
    const [, key, value] = match;
    if (key === 'MAW_UNSAFE_LOCAL_NO_AUTH' || key === 'AGENT_WORKBENCH_UNSAFE_LOCAL_NO_AUTH' || key === 'WORKBENCH_UNSAFE_LOCAL_NO_AUTH') {
      dropped.push(key);
      continue;
    }
    let newKey = key;
    let isCanonicalSource = false;
    if (key.startsWith('WORKBENCH_')) {
      isCanonicalSource = true;
    } else if (key.startsWith('MAW_')) {
      newKey = `WORKBENCH_${key.slice('MAW_'.length)}`;
      renamed.push(`${key} -> ${newKey}`);
    } else if (key.startsWith('AGENT_WORKBENCH_')) {
      newKey = `WORKBENCH_${key.slice('AGENT_WORKBENCH_'.length)}`;
      renamed.push(`${key} -> ${newKey}`);
    } else {
      unknown.push(key);
    }
    if (newKey.startsWith('WORKBENCH_')) {
      const previous = emitted.get(newKey);
      if (previous !== undefined) {
        // Canonical wins; a later legacy duplicate is skipped and reported by name only.
        if (previous === true || !isCanonicalSource) {
          collisions.push(newKey);
          continue;
        }
        const index = outLines.findIndex((existing) => existing.startsWith(`${newKey}=`));
        if (index !== -1) outLines.splice(index, 1);
        collisions.push(newKey);
      }
      emitted.set(newKey, isCanonicalSource);
    }
    const effectiveValue = Object.hasOwn(identityPaths, newKey) ? JSON.stringify(identityPaths[newKey]) : value;
    outLines.push(`${newKey}=${effectiveValue}`);
  }
  let text = outLines.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return { content: text, dropped, renamed, unknown, collisions };
}

// ---------------------------------------------------------------------------
// JSON path rewrite inside the copied Preferences / Local State
// ---------------------------------------------------------------------------

function rewriteJsonPaths(value, legacyPath, canonicalPath) {
  let changed = 0;
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node === legacyPath) {
        changed += 1;
        return canonicalPath;
      }
      if (node.startsWith(`${legacyPath}/`)) {
        changed += 1;
        return canonicalPath + node.slice(legacyPath.length);
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return { value: walk(value), changed };
}

function rewritePreferenceFiles(ctx, dataDir = ctx.canonical.userData) {
  const files = [];
  for (const name of ['Preferences', 'Local State']) {
    files.push(path.join(dataDir, name));
  }
  const partitionsDir = path.join(dataDir, 'Partitions');
  if (isDirectory(partitionsDir)) {
    for (const entry of fs.readdirSync(partitionsDir)) {
      for (const name of ['Preferences', 'Local State']) files.push(path.join(partitionsDir, entry, name));
    }
  }
  let rewritten = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const { value, changed } = rewriteJsonPaths(parsed, ctx.legacy.userData, ctx.canonical.userData);
    if (changed === 0) continue;
    fs.writeFileSync(file, JSON.stringify(value));
    rewritten += changed;
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// Apply steps
// ---------------------------------------------------------------------------

function tarSupportsZstd(ctx) {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v zstd'], { encoding: 'utf8' });
  return (probe.status ?? 1) === 0;
}

function stepBackup(ctx, state) {
  const entry = state.steps.backup;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.backupDir, 0o700);

  // Legacy state-dir metadata is captured as text: pointers as readlink output, update log, release meta.
  const stage = path.join(ctx.migrationDir, `backup-stage-${ts}`);
  fs.rmSync(stage, { recursive: true, force: true });
  const metaDir = path.join(stage, 'legacy-state-meta');
  fs.mkdirSync(metaDir, { recursive: true, mode: 0o700 });
  const pointers = [];
  for (const name of ['current', 'staged', 'healthy', 'previous', 'legacy-current']) {
    const link = path.join(ctx.legacy.stateDir, name);
    if (!exists(link)) continue;
    let target = '';
    try {
      target = fs.readlinkSync(link);
    } catch {
      target = '(not a symlink)';
    }
    pointers.push(`${name}\t${target}`);
  }
  fs.writeFileSync(path.join(metaDir, 'pointers.txt'), pointers.length > 0 ? `${pointers.join('\n')}\n` : '');
  for (const name of ['update-log.jsonl', 'source_path', 'node_path', 'headless']) {
    const file = path.join(ctx.legacy.stateDir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.copyFileSync(file, path.join(metaDir, name));
  }
  const releasesDir = path.join(ctx.legacy.stateDir, 'releases');
  if (isDirectory(releasesDir)) {
    const outDir = path.join(metaDir, 'release-meta');
    fs.mkdirSync(outDir, { recursive: true });
    for (const release of fs.readdirSync(releasesDir)) {
      const meta = path.join(releasesDir, release, '.maw-release-meta.json');
      if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(outDir, `${release}.json`));
    }
  }

  const useZstd = tarSupportsZstd(ctx);
  const archive = path.join(ctx.backupDir, `${ts}.tar.${useZstd ? 'zst' : 'gz'}`);
  const relative = [];
  const addRelative = (target) => {
    if (!exists(target)) return;
    if (!isInside(ctx.home, target)) return;
    relative.push(path.relative(ctx.home, target));
  };
  addRelative(ctx.legacy.configDir);
  addRelative(ctx.legacy.envFile);
  addRelative(ctx.legacy.userData);
  addRelative(ctx.legacy.desktopFile);
  for (const unit of LEGACY_UNITS) addRelative(path.join(ctx.unitDir, unit));
  if (relative.length === 0 && pointers.length === 0) {
    entry.status = 'skipped';
    entry.reason = 'nothing to back up';
    return;
  }
  const [tarBin, ...tarPrefix] = ctx.tarCmd;
  const args = [...tarPrefix, '-c', '-f', archive, useZstd ? '--zstd' : '-z'];
  for (const name of USERDATA_EXCLUDES) args.push(`--exclude=${name}`);
  args.push('--exclude=Singleton*');
  args.push('-C', ctx.home, ...relative);
  args.push('-C', stage, 'legacy-state-meta');
  const created = spawnSync(tarBin, args, { encoding: 'utf8' });
  if ((created.status ?? 1) !== 0) {
    throw new Error(`backup archive failed: ${created.stderr || created.stdout}`);
  }
  fs.chmodSync(archive, 0o600);
  const listed = spawnSync(tarBin, [...tarPrefix, '-t', '-f', archive], { encoding: 'utf8' });
  if ((listed.status ?? 1) !== 0 || listed.stdout.trim() === '') {
    throw new Error('backup archive could not be listed: refusing to continue');
  }
  const digest = sha256File(archive);
  writeFileMode(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, 0o600);
  fs.rmSync(stage, { recursive: true, force: true });
  entry.status = 'done';
  entry.dest = archive;
  entry.sha256 = digest;
  entry.entries = listed.stdout.trim().split('\n').length;
  say(ctx, `backup: ${archive} (${entry.entries} entries, sha256 ${digest.slice(0, 12)}...)`);
}

function verifyBackup(ctx, entry) {
  if (entry.status === 'skipped') return !sourcesPresent(ctx);
  if (typeof entry.dest !== 'string' || !fs.existsSync(entry.dest)) return false;
  return sha256File(entry.dest) === entry.sha256;
}

function stepConfig(ctx, state) {
  const entry = state.steps.config;
  if (!isDirectory(ctx.legacy.configDir)) {
    entry.status = 'skipped';
    entry.reason = 'no legacy config dir';
    return;
  }
  if (exists(ctx.canonical.configDir)) {
    if (entry.status === 'prepared' && manifestEquals(entry.manifest ?? {}, fileManifest(ctx.canonical.configDir, (rel) => rel !== 'environment'))) {
      entry.status = 'done';
      return;
    }
    throw new Refusal(`canonical config dir already exists and does not match the prepared migration copy; refusing to overwrite: ${ctx.canonical.configDir}`);
  }
  const staging = `${ctx.canonical.configDir}.identity-migration-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.cpSync(ctx.legacy.configDir, staging, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    force: false,
  });
  fs.chmodSync(staging, 0o700);
  const source = fileManifest(ctx.legacy.configDir, (rel) => rel !== 'environment');
  const copied = fileManifest(staging, (rel) => rel !== 'environment');
  if (!manifestEquals(source, copied)) throw new Error('config dir copy does not match the source manifest');
  entry.status = 'prepared';
  entry.source = ctx.legacy.configDir;
  entry.dest = ctx.canonical.configDir;
  entry.manifest = copied;
  writeState(ctx, state);
  fs.renameSync(staging, ctx.canonical.configDir);
  fs.chmodSync(ctx.canonical.configDir, 0o700);
  entry.status = 'done';
  say(ctx, `config: copied ${Object.keys(copied).length} files to ${ctx.canonical.configDir}`);
}

function verifyConfig(ctx, entry) {
  if (entry.status === 'skipped') return !isDirectory(ctx.legacy.configDir);
  if (!isDirectory(ctx.canonical.configDir)) return false;
  const current = fileManifest(ctx.canonical.configDir, (rel) => rel !== 'environment');
  return manifestEquals(entry.manifest ?? {}, current);
}

function stepEnv(ctx, state) {
  const entry = state.steps.env;
  if (!fs.existsSync(ctx.legacy.envFile)) {
    entry.status = 'skipped';
    entry.reason = 'no legacy env file';
    return;
  }
  const ptyRuntimeDir = path.dirname(ctx.canonical.ptydSocket);
  const identityPaths = {
    WORKBENCH_RUNTIME_DIR: path.join(ctx.runtimeDir, 'workbench'),
    WORKBENCH_PTYD_RUNTIME_DIR: ptyRuntimeDir,
    WORKBENCH_PTYD_SOCKET: ctx.canonical.ptydSocket,
    WORKBENCH_PTYD_AUTH_FILE: `${ctx.canonical.ptydSocket}.auth`,
    WORKBENCH_STATE_DIR: ctx.canonical.stateDir,
    WORKBENCH_RELEASES_DIR: path.join(ctx.canonical.stateDir, 'releases'),
    WORKBENCH_LIB_DIR: ctx.canonical.libDir,
    WORKBENCH_DESKTOP_DATA_DIR: ctx.canonical.userData,
  };
  const result = transformEnvFile(fs.readFileSync(ctx.legacy.envFile, 'utf8'), identityPaths);
  const digest = crypto.createHash('sha256').update(result.content).digest('hex');
  if (exists(ctx.canonical.envFile)) {
    if (entry.status === 'prepared' && sha256File(ctx.canonical.envFile) === entry.sha256) {
      entry.status = 'done';
      return;
    }
    throw new Refusal(`canonical environment file already exists and does not match the prepared migration copy; refusing to overwrite: ${ctx.canonical.envFile}`);
  }
  entry.status = 'prepared';
  entry.source = ctx.legacy.envFile;
  entry.dest = ctx.canonical.envFile;
  entry.sha256 = digest;
  entry.dropped = result.dropped;
  entry.renamed = result.renamed;
  entry.unknownKeys = result.unknown;
  entry.collisions = result.collisions;
  writeState(ctx, state);
  writeFileMode(ctx.canonical.envFile, result.content, 0o600);
  entry.status = 'done';
  say(ctx, `env: wrote ${ctx.canonical.envFile} (0600), renamed ${result.renamed.length} key(s)`);
  if (result.dropped.length > 0) say(ctx, `env: dropped (not carried forward): ${result.dropped.join(', ')}`);
  if (result.unknown.length > 0) say(ctx, `env: kept unknown keys verbatim: ${result.unknown.join(', ')}`);
  if (result.collisions.length > 0) say(ctx, `env: canonical key kept over legacy duplicate: ${result.collisions.join(', ')}`);
}

function verifyEnv(ctx, entry) {
  if (entry.status === 'skipped') return !fs.existsSync(ctx.legacy.envFile);
  if (!fs.existsSync(ctx.canonical.envFile)) return false;
  if ((fs.statSync(ctx.canonical.envFile).mode & 0o777) !== 0o600) return false;
  return sha256File(ctx.canonical.envFile) === entry.sha256;
}

function partitionManifest(userData) {
  const result = {};
  const partitionsDir = path.join(userData, 'Partitions');
  if (!isDirectory(partitionsDir)) return result;
  for (const name of fs.readdirSync(partitionsDir).sort()) {
    const dir = path.join(partitionsDir, name);
    if (!isDirectory(dir)) continue;
    const files = fileManifest(dir);
    result[name] = { files: Object.keys(files).length, bytes: dirSize(dir) };
  }
  return result;
}

function stepUserData(ctx, state) {
  const entry = state.steps.userdata;
  if (!isDirectory(ctx.legacy.userData)) {
    entry.status = 'skipped';
    entry.reason = 'no legacy userData';
    return;
  }
  if (exists(ctx.canonical.userData)) {
    if (entry.status === 'prepared' && manifestEquals(entry.manifest ?? {}, fileManifest(ctx.canonical.userData))) {
      entry.status = 'done';
      entry.partitions = partitionManifest(ctx.canonical.userData);
      return;
    }
    throw new Refusal(`canonical userData already exists and does not match the prepared migration copy; refusing to overwrite: ${ctx.canonical.userData}`);
  }
  const staging = `${ctx.canonical.userData}.identity-migration-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.cpSync(ctx.legacy.userData, staging, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    force: true,
    filter: (src) => userDataFilter(src),
  });
  fs.chmodSync(staging, 0o700);
  // Partition rename happens before the JSON rewrite so the per-partition files are found at their new path.
  const partitionsDir = path.join(staging, 'Partitions');
  const renamedPartitions = [];
  if (isDirectory(partitionsDir)) {
    for (const name of fs.readdirSync(partitionsDir)) {
      if (!name.startsWith('maw-')) continue;
      const target = `workbench-${name.slice('maw-'.length)}`;
      const from = path.join(partitionsDir, name);
      const to = path.join(partitionsDir, target);
      if (exists(to)) {
        // A redo after an interrupted run: the freshly copied legacy partition is authoritative, so it is
        // merged into the already renamed one and then removed. Nothing named `maw-*` may survive here.
        fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, dereference: false, force: true });
        fs.rmSync(from, { recursive: true, force: true });
      } else {
        fs.renameSync(from, to);
      }
      renamedPartitions.push(`${name} -> ${target}`);
    }
  }
  const rewritten = rewritePreferenceFiles(ctx, staging);
  const copied = fileManifest(staging);
  entry.status = 'prepared';
  entry.source = ctx.legacy.userData;
  entry.dest = ctx.canonical.userData;
  entry.files = Object.keys(copied).length;
  entry.manifest = copied;
  entry.partitions = partitionManifest(staging);
  entry.renamedPartitions = renamedPartitions;
  entry.rewrittenPaths = rewritten;
  writeState(ctx, state);
  fs.renameSync(staging, ctx.canonical.userData);
  entry.status = 'done';
  say(ctx, `userData: copied ${entry.files} files to ${ctx.canonical.userData}`);
  if (renamedPartitions.length > 0) say(ctx, `userData: renamed partitions ${renamedPartitions.join(', ')}`);
  say(ctx, `userData: rewrote ${rewritten} legacy path value(s) in Preferences / Local State`);
}

function verifyUserData(ctx, entry) {
  if (entry.status === 'skipped') return !isDirectory(ctx.legacy.userData);
  if (!isDirectory(ctx.canonical.userData)) return false;
  const partitionsDir = path.join(ctx.canonical.userData, 'Partitions');
  if (isDirectory(partitionsDir) && fs.readdirSync(partitionsDir).some((name) => name.startsWith('maw-'))) return false;
  return manifestEquals(entry.manifest ?? {}, fileManifest(ctx.canonical.userData));
}

function legacyHealthyCommit(ctx) {
  const link = path.join(ctx.legacy.stateDir, 'healthy');
  if (!exists(link)) return null;
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return null;
  }
  const meta = path.join(target, '.maw-release-meta.json');
  if (!fs.existsSync(meta)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return typeof parsed.commit === 'string' && /^[0-9a-f]{40}$/.test(parsed.commit) ? parsed.commit : null;
  } catch {
    return null;
  }
}

function canonicalCurrentRelease(ctx) {
  const link = path.join(ctx.canonical.stateDir, 'current');
  if (!exists(link)) return null;
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return null;
  }
  if (!isInside(path.join(ctx.canonical.stateDir, 'releases'), target)) return null;
  for (const name of ['.workbench-release-meta.json', '.maw-release-meta.json']) {
    const meta = path.join(target, name);
    if (!fs.existsSync(meta)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
      return { dir: target, releaseId: parsed.releaseId ?? null, commit: parsed.commit ?? null };
    } catch {
      return null;
    }
  }
  return null;
}

function stepRelease(ctx, state) {
  const entry = state.steps.release;
  if (!ctx.sourceDir || !ctx.expectCommit) throw new Refusal('initial release requires a pinned source checkout.');
  fs.mkdirSync(path.join(ctx.canonical.stateDir, 'releases'), { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.canonical.stateDir, 0o700);
  fs.mkdirSync(ctx.canonical.logDir, { recursive: true, mode: 0o700 });
  if (ctx.sourceDir !== null) fs.writeFileSync(path.join(ctx.canonical.stateDir, 'source_path'), `${ctx.sourceDir}\n`);
  fs.writeFileSync(path.join(ctx.canonical.stateDir, 'node_path'), `${process.execPath}\n`);
  const inherited = Object.fromEntries(Object.entries(ctx.env).filter(([name]) =>
    !/^(?:MAW_|WORKBENCH_|AGENT_WORKBENCH_)/.test(name)));
  const childEnv = {
    ...inherited,
    HOME: ctx.home,
    XDG_CONFIG_HOME: ctx.configHome,
    XDG_DATA_HOME: ctx.dataHome,
    XDG_STATE_HOME: ctx.stateHome,
    XDG_RUNTIME_DIR: ctx.runtimeDir,
    WORKBENCH_STATE_DIR: ctx.canonical.stateDir,
    WORKBENCH_LIB_DIR: ctx.canonical.libDir,
    WORKBENCH_BIN_DIR: ctx.binDir,
    WORKBENCH_NODE_BIN: process.execPath,
    WORKBENCH_SOURCE: ctx.sourceDir,
    // The runtime has its own gate before canonical services can be enabled.
    WORKBENCH_HEADLESS: '1',
  };
  if (ctx.sourceDir === null || ctx.expectCommit === null) throw new Refusal('initial release needs explicit --source and full --expect-commit SHA');
  const args = ['--initial', '--source', ctx.sourceDir, '--ref', ctx.expectCommit, '--allow-unapproved-ref'];
  const command = ctx.initialReleaseCmd === null ? null : `${ctx.initialReleaseCmd} ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(' ')}`;
  const commandArgs = command === null
    ? [path.join(ctx.helpersSource, 'update.sh'), ...args]
    : ['-c', command];
  const result = spawnSync('/bin/sh', commandArgs, {
    encoding: 'utf8', env: childEnv, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`initial release command failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const release = canonicalCurrentRelease(ctx);
  if (release === null) throw new Error('initial release command did not produce a valid `current` release');
  if (release.commit !== ctx.expectCommit) throw new Error(`initial release commit ${release.commit ?? '(missing)'} does not match requested SHA ${ctx.expectCommit}`);
  // The first release is never marked healthy here: only the readiness probe after a real start may do that.
  const healthy = path.join(ctx.canonical.stateDir, 'healthy');
  if (exists(healthy)) throw new Error('initial release was marked healthy before any readiness probe: refusing');
  const legacyCommit = legacyHealthyCommit(ctx);
  const logLine = JSON.stringify({
    event: 'identity-migration-initial-release',
    at: new Date().toISOString(),
    legacyHealthyCommit: legacyCommit,
    commit: release.commit,
    releaseId: release.releaseId,
  });
  fs.appendFileSync(path.join(ctx.canonical.stateDir, 'update-log.jsonl'), `${logLine}\n`);
  entry.status = 'done';
  entry.dest = ctx.canonical.stateDir;
  entry.releaseId = release.releaseId;
  entry.commit = release.commit;
  entry.legacyHealthyCommit = legacyCommit;
  say(ctx, `release: initial canonical release ${release.releaseId ?? release.dir} (not healthy until the readiness probe)`);
}

function verifyRelease(ctx, entry) {
  const release = canonicalCurrentRelease(ctx);
  if (release === null) return false;
  if (entry.releaseId !== null && entry.releaseId !== undefined) return release.releaseId === entry.releaseId && release.commit === entry.commit;
  return true;
}

const SHIM_NAMES = Object.freeze(['maw', 'anvil-bench', 'workbench']);

function shimContent(name) {
  return `#!/bin/sh\nWORKBENCH_CLI_NAME=${name} exec "$(dirname "$0")/anvi-bench" "$@"\n`;
}

function stepHelpers(ctx, state) {
  const entry = state.steps.helpers;
  fs.mkdirSync(ctx.canonical.libDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.canonical.libDir, 0o700);
  const installed = [];
  if (isDirectory(ctx.helpersSource)) {
    for (const item of fs.readdirSync(ctx.helpersSource, { withFileTypes: true })) {
      if (item.name === 'tests' || item.name.endsWith('.test.sh') || item.name.endsWith('.test.mjs')) continue;
      const src = path.join(ctx.helpersSource, item.name);
      const dest = path.join(ctx.canonical.libDir, item.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, dereference: false });
      installed.push(item.name);
    }
  }
  const sharedEnv = ctx.sourceDir === null ? null : path.join(ctx.sourceDir, 'packages/shared/src/workbench-env.mjs');
  if (sharedEnv === null || !fs.existsSync(sharedEnv)) {
    throw new Refusal('the pinned source checkout is missing packages/shared/src/workbench-env.mjs');
  }
  fs.copyFileSync(sharedEnv, path.join(ctx.canonical.libDir, 'env.mjs'));
  fs.chmodSync(path.join(ctx.canonical.libDir, 'env.mjs'), 0o644);
  installed.push('env.mjs');
  writeFileMode(path.join(ctx.canonical.libDir, 'activation-helper-api'), '2\n', 0o644);
  writeFileMode(path.join(ctx.canonical.libDir, 'desktop-launcher-api'), '1\n', 0o644);
  const version = electronVersion(ctx);
  if (!version) throw new Refusal('cannot determine the canonical Electron runtime version');
  writeFileMode(path.join(ctx.canonical.libDir, 'desktop-runtime-version'), `${version}\n`, 0o644);
  installed.push('activation-helper-api', 'desktop-launcher-api', 'desktop-runtime-version');
  // The real CLI, then the shims. Originals are backed up once, into the state file directory.
  fs.mkdirSync(ctx.binBackupDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ctx.binDir, { recursive: true });
  if (!entry.binOriginals) {
    entry.binOriginals = Object.fromEntries([...SHIM_NAMES, 'anvi-bench'].map((name) => {
      const target = path.join(ctx.binDir, name);
      if (!exists(target)) return [name, { existed: false }];
      const stat = fs.lstatSync(target);
      return [name, stat.isSymbolicLink()
        ? { existed: true, type: 'symlink', target: fs.readlinkSync(target) }
        : { existed: true, type: 'file', mode: stat.mode & 0o777, sha256: sha256File(target) }];
    }));
    entry.binBackups = Object.entries(entry.binOriginals).filter(([, original]) => original.existed).map(([name]) => name);
    writeState(ctx, state);
  }
  const backedUp = [...(entry.binBackups ?? [])];
  for (const name of [...SHIM_NAMES, 'anvi-bench']) {
    const target = path.join(ctx.binDir, name);
    const backup = path.join(ctx.binBackupDir, name);
    if (!entry.binOriginals[name]?.existed || exists(backup)) continue;
    const original = entry.binOriginals[name];
    if (original.type === 'symlink') fs.symlinkSync(original.target, backup);
    else fs.copyFileSync(target, backup);
    if (!backedUp.includes(name)) backedUp.push(name);
  }
  let cliSource = null;
  for (const candidate of ['anvi-bench', 'anvil-bench', 'maw']) {
    const file = path.join(ctx.helpersSource, candidate);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      cliSource = file;
      break;
    }
  }
  if (cliSource === null) throw new Refusal(`no CLI entry point found in --helpers-source ${ctx.helpersSource}`);
  const cliDest = path.join(ctx.binDir, 'anvi-bench');
  fs.copyFileSync(cliSource, cliDest);
  fs.chmodSync(cliDest, 0o755);
  fs.copyFileSync(cliSource, path.join(ctx.canonical.libDir, 'anvi-bench'));
  fs.chmodSync(path.join(ctx.canonical.libDir, 'anvi-bench'), 0o755);
  for (const name of SHIM_NAMES) {
    writeFileMode(path.join(ctx.binDir, name), shimContent(name), 0o755);
  }
  entry.status = 'done';
  entry.dest = ctx.canonical.libDir;
  entry.installed = installed;
  entry.envSha256 = sha256File(path.join(ctx.canonical.libDir, 'env.mjs'));
  entry.binBackups = backedUp;
  entry.shims = [...SHIM_NAMES];
  say(ctx, `helpers: installed ${installed.length} file(s) in ${ctx.canonical.libDir}, anvi-bench plus ${SHIM_NAMES.length} shims in ${ctx.binDir}`);
}

function verifyHelpers(ctx, entry) {
  if (!isDirectory(ctx.canonical.libDir)) return false;
  const cli = path.join(ctx.binDir, 'anvi-bench');
  if (!fs.existsSync(cli)) return false;
  const envFile = path.join(ctx.canonical.libDir, 'env.mjs');
  if (!fs.existsSync(envFile) || sha256File(envFile) !== entry.envSha256) return false;
  for (const name of SHIM_NAMES) {
    const file = path.join(ctx.binDir, name);
    if (!fs.existsSync(file)) return false;
    if (!fs.readFileSync(file, 'utf8').includes('exec "$(dirname "$0")/anvi-bench"')) return false;
  }
  return entry.status === 'done';
}

function renderUnit(ctx, templateFile, destName, runtimeName) {
  const template = fs.readFileSync(templateFile, 'utf8');
  const nodeBin = process.execPath;
  const replacements = {
    '@NODE_BIN@': nodeBin,
    '@STATE_DIR@': ctx.canonical.stateDir,
    '@LIB_DIR@': ctx.canonical.libDir,
    '@BIN_DIR@': ctx.binDir,
    '@ENV_FILE@': ctx.canonical.envFile,
    '@LOG_DIR@': ctx.canonical.logDir,
    '@RUNTIME_NAME@': runtimeName,
    '@PTYD_RUNTIME_NAME@': 'workbench-ptyd',
    '@PATH@': `${path.dirname(nodeBin)}:${ctx.binDir}:/usr/local/bin:/usr/bin:/bin`,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(String(value).replace(/%/g, '%%'));
  }
  const dest = path.join(ctx.unitDir, destName);
  writeFileMode(dest, rendered, 0o644);
  return dest;
}

function stepUnits(ctx, state) {
  const entry = state.steps.units;
  if (ctx.unitTemplate === null || ctx.ptydUnitTemplate === null) {
    throw new Refusal('apply needs --unit-template and --ptyd-unit-template pointing at the canonical unit templates.');
  }
  fs.mkdirSync(ctx.unitDir, { recursive: true });
  const written = [
    renderUnit(ctx, ctx.unitTemplate, 'workbench.service', 'workbench'),
    renderUnit(ctx, ctx.ptydUnitTemplate, 'workbench-ptyd.service', 'workbench-ptyd'),
  ];
  for (const file of written) {
    const text = fs.readFileSync(file, 'utf8');
    const leftover = text.match(/@[A-Z_]+@/g);
    if (leftover !== null) throw new Error(`unit ${path.basename(file)} still has unresolved tokens: ${leftover.join(', ')}`);
  }
  const commands = [
    ['disable', ...LEGACY_UNITS],
  ];
  if (!entry.originalUnits) {
    entry.originalUnits = {};
    for (const unit of LEGACY_UNITS) {
      const file = path.join(ctx.unitDir, unit);
      if (!exists(file)) { entry.originalUnits[unit] = null; continue; }
      const stat = fs.lstatSync(file);
      entry.originalUnits[unit] = stat.isSymbolicLink()
        ? { type: 'symlink', target: fs.readlinkSync(file) }
        : { type: 'file', content: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 };
    }
    writeState(ctx, state);
  }
  for (const args of commands) runSystemctl(ctx, args);
  for (const unit of LEGACY_UNITS) {
    const file = path.join(ctx.unitDir, unit);
    if (exists(file) && fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === '/dev/null') continue;
    const mask = `${file}.mask-${process.pid}`;
    fs.symlinkSync('/dev/null', mask);
    fs.renameSync(mask, file);
  }
  for (const args of [['mask', ...LEGACY_UNITS],
    ['enable', ...CANONICAL_UNITS],
    ['daemon-reload']]) {
    const result = runSystemctl(ctx, args);
    // `disable` on a never-enabled unit is not an error worth stopping for; mask and enable are.
    if ((result.status ?? 1) !== 0 && args[0] !== 'disable') {
      throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  }
  entry.status = 'done';
  entry.dest = written;
  entry.masked = [...LEGACY_UNITS];
  entry.enabled = [...CANONICAL_UNITS];
  say(ctx, `units: rendered ${written.map((file) => path.basename(file)).join(', ')}; legacy units disabled and masked; canonical units enabled (not started)`);
}

function verifyUnits(ctx, entry) {
  for (const unit of CANONICAL_UNITS) {
    if (!fs.existsSync(path.join(ctx.unitDir, unit))) return false;
  }
  for (const unit of LEGACY_UNITS) {
    if (unitEnabledState(ctx, unit) !== 'masked') return false;
  }
  for (const unit of CANONICAL_UNITS) {
    const state = unitEnabledState(ctx, unit);
    if (state !== 'enabled' && state !== 'enabled-runtime') return false;
  }
  return entry.status === 'done';
}

function desktopEntryContent(ctx) {
  const exec = `"${path.join(ctx.binDir, 'anvi-bench').replace(/(["\\`$])/g, '\\$1')}" desktop`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Workbench',
    'GenericName=Anvilary Workbench',
    `Exec=${exec}`,
    'Icon=workbench',
    'StartupWMClass=workbench',
    'Terminal=false',
    'Categories=Development;',
    'Keywords=Anvilary;Workbench;anvi-bench;Workspace;Terminal;',
    '',
  ].join('\n');
}

function hideLegacyDesktopEntry(ctx, entry) {
  if (!fs.existsSync(ctx.legacy.desktopFile)) return false;
  fs.mkdirSync(ctx.desktopBackupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(ctx.desktopBackupDir, path.basename(ctx.legacy.desktopFile));
  if (!fs.existsSync(backup)) fs.copyFileSync(ctx.legacy.desktopFile, backup);
  entry.legacyDesktopBackup = backup;
  if (ctx._state) writeState(ctx, ctx._state);
  const original = fs.readFileSync(backup, 'utf8');
  const lines = original.split('\n').filter((line) => !/^\s*(NoDisplay|Hidden)\s*=/.test(line));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push('NoDisplay=true', 'Hidden=true', '');
  writeFileMode(ctx.legacy.desktopFile, lines.join('\n'), 0o644);
  return true;
}

function updateFavoriteApps(ctx, entry) {
  if (ctx.gsettingsCmd === null) return null;
  const [bin, ...prefix] = ctx.gsettingsCmd;
  const read = spawnSync(bin, [...prefix, 'get', 'org.gnome.shell', 'favorite-apps'], { encoding: 'utf8', env: ctx.env });
  if ((read.status ?? 1) !== 0) return null;
  const raw = read.stdout.trim();
  if (!raw.includes("'maw.desktop'")) return null;
  const next = raw.replace(/'maw\.desktop'/g, "'workbench.desktop'");
  entry.favoriteAppsPrevious = raw;
  entry.favoriteAppsNext = next;
  if (ctx._state) writeState(ctx, ctx._state);
  const write = spawnSync(bin, [...prefix, 'set', 'org.gnome.shell', 'favorite-apps', next], { encoding: 'utf8', env: ctx.env });
  if ((write.status ?? 1) !== 0) return null;
  return next;
}

function copyIcons(ctx) {
  const copied = [];
  for (const size of ICON_SIZES) {
    const dir = path.join(ctx.hicolorDir, `${size}x${size}`, 'apps');
    const candidates = [
      ctx.iconSource === null ? null : path.join(ctx.iconSource, `workbench-${size}.png`),
      path.join(dir, `${ctx.legacy.iconName}.png`),
    ].filter((candidate) => candidate !== null && fs.existsSync(candidate));
    if (candidates.length === 0) continue;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${ctx.canonical.iconName}.png`);
    fs.copyFileSync(candidates[0], dest);
    fs.chmodSync(dest, 0o644);
    copied.push(`${size}x${size}`);
  }
  return copied;
}

function runIfAvailable(ctx, command) {
  const probe = spawnSync('/bin/sh', ['-c', `command -v ${command[0]}`], { encoding: 'utf8', env: ctx.env });
  if ((probe.status ?? 1) !== 0) return false;
  spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: ctx.env });
  return true;
}

function stepDesktop(ctx, state) {
  const entry = state.steps.desktop;
  fs.mkdirSync(ctx.applicationsDir, { recursive: true });
  writeFileMode(ctx.canonical.desktopFile, desktopEntryContent(ctx), 0o644);
  const icons = copyIcons(ctx);
  const hidden = hideLegacyDesktopEntry(ctx, entry);
  const favorites = updateFavoriteApps(ctx, entry);
  runIfAvailable(ctx, ['update-desktop-database', ctx.applicationsDir]);
  runIfAvailable(ctx, ['gtk-update-icon-cache', '-q', '-f', '-t', ctx.hicolorDir]);
  entry.status = 'done';
  entry.dest = ctx.canonical.desktopFile;
  entry.icons = icons;
  entry.legacyHidden = hidden;
  say(ctx, `desktop: wrote ${ctx.canonical.desktopFile}, ${icons.length} icon size(s)${hidden ? ', legacy entry hidden' : ''}${favorites !== null ? ', favorite-apps updated' : ''}`);
}

function verifyDesktop(ctx, entry) {
  if (!fs.existsSync(ctx.canonical.desktopFile)) return false;
  if (entry.legacyHidden === true) {
    if (!fs.existsSync(ctx.legacy.desktopFile)) return false;
    const text = fs.readFileSync(ctx.legacy.desktopFile, 'utf8');
    if (!text.includes('Hidden=true') || !text.includes('NoDisplay=true')) return false;
  }
  return entry.status === 'done';
}

function electronVersion(ctx) {
  if (ctx.electronVersion !== null) return ctx.electronVersion;
  const legacyMarker = path.join(ctx.legacy.libDir, 'desktop-runtime-version');
  if (fs.existsSync(legacyMarker)) {
    const value = fs.readFileSync(legacyMarker, 'utf8').trim();
    if (value !== '') return value;
  }
  if (ctx.sourceDir !== null) {
    const pkg = path.join(ctx.sourceDir, 'packages/desktop/package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        const version = parsed.devDependencies?.electron;
        if (typeof version === 'string' && version !== '') return version.replace(/^[^0-9]*/, '');
      } catch {
        // Fall through to the error below.
      }
    }
  }
  return null;
}

function stepRuntime(ctx, state) {
  const entry = state.steps.runtime;
  const version = electronVersion(ctx);
  if (version === null) {
    throw new Refusal('cannot determine the Electron runtime version: pass --electron-version.');
  }
  const binary = path.join(ctx.canonical.electronRoot, version, 'electron');
  entry.version = version;
  entry.dest = binary;
  if (!fs.existsSync(binary)) {
    entry.status = 'pending';
    entry.reason = 'canonical Electron runtime is not installed';
    state.status = 'awaiting-runtime';
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch;
    say(ctx, `runtime: missing ${binary}`);
    say(ctx, 'runtime: install the canonical Electron runtime, then re-run apply:');
    say(ctx, `  sudo apt install ./workbench-electron-${version}_${arch}.deb`);
    throw new Refusal(`canonical Electron runtime missing: ${binary}`, EXIT_AWAITING_RUNTIME);
  }
  entry.status = 'done';
  say(ctx, `runtime: ${binary} present`);
}

function verifyRuntime(ctx, entry) {
  return typeof entry.dest === 'string' && fs.existsSync(entry.dest);
}

const STEPS = Object.freeze([
  { name: 'backup', title: 'Backup legacy config, env file, userData (minus caches), state metadata, units and desktop entry', run: stepBackup, verify: verifyBackup },
  { name: 'config', title: 'Copy the config dir to the canonical config dir', run: stepConfig, verify: verifyConfig },
  { name: 'env', title: 'Rewrite the env file into the canonical config dir (0600)', run: stepEnv, verify: verifyEnv },
  { name: 'userdata', title: 'Copy userData, rename partitions and rewrite stored paths', run: stepUserData, verify: verifyUserData },
  { name: 'helpers', title: 'Install the canonical helpers, anvi-bench and the CLI shims', run: stepHelpers, verify: verifyHelpers },
  { name: 'release', title: 'Build the first canonical release with the canonical updater (never healthy here)', run: stepRelease, verify: verifyRelease },
  { name: 'runtime', title: 'Check the canonical Electron runtime', run: stepRuntime, verify: verifyRuntime },
  { name: 'units', title: 'Render the canonical units, disable and mask the legacy units, enable the new ones (no start)', run: stepUnits, verify: verifyUnits },
  { name: 'desktop', title: 'Write the canonical desktop entry and icons, hide the legacy entry, update favorites', run: stepDesktop, verify: verifyDesktop },
]);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function nothingToMigrate(ctx) {
  say(ctx, 'nothing to migrate: no legacy installation found (a fresh install is not a migration)');
  return EXIT_OK;
}

function commandPlan(ctx) {
  const state = readState(ctx);
  if (!sourcesPresent(ctx)) return nothingToMigrate(ctx);
  const refusals = preflight(ctx, state);
  if (refusals.length > 0) {
    for (const reason of refusals) say(ctx, `refused: ${reason}`);
    return EXIT_REFUSED;
  }
  say(ctx, `plan: ${state === null ? 'no previous state' : `resuming state ${state.status}`}`);
  say(ctx, `plan: legacy config   ${ctx.legacy.configDir} -> ${ctx.canonical.configDir}`);
  say(ctx, `plan: legacy env      ${ctx.legacy.envFile} -> ${ctx.canonical.envFile}`);
  say(ctx, `plan: legacy userData ${ctx.legacy.userData} -> ${ctx.canonical.userData}`);
  say(ctx, `plan: legacy state    ${ctx.legacy.stateDir} -> ${ctx.canonical.stateDir} (new initial release, nothing copied)`);
  say(ctx, `plan: copy size ${copySizeBytes(ctx)} bytes, free ${freeSpaceBytes(ctx)} bytes`);
  for (const [index, step] of STEPS.entries()) {
    const entry = state?.steps?.[step.name] ?? { status: 'pending' };
    const done = entry.status === 'done' || entry.status === 'skipped' ? step.verify(ctx, entry) : false;
    say(ctx, `plan: step ${index + 1}. ${step.name} [${done ? 'already done' : 'todo'}] ${step.title}`);
  }
  return EXIT_OK;
}

function commandApply(ctx) {
  let state = readState(ctx);
  if (!sourcesPresent(ctx)) return nothingToMigrate(ctx);
  const refusals = preflight(ctx, state);
  if (refusals.length > 0) {
    for (const reason of refusals) say(ctx, `refused: ${reason}`);
    return EXIT_REFUSED;
  }
  if (state === null) state = emptyState();
  ctx._state = state;
  if (state.status === 'cleaned') throw new Refusal('this installation was already cleaned: nothing to apply');
  if (state.status !== 'verified') state.status = 'in-progress';
  writeState(ctx, state);
  for (const step of STEPS) {
    const entry = state.steps[step.name] ?? { status: 'pending' };
    state.steps[step.name] = entry;
    if ((entry.status === 'done' || entry.status === 'skipped') && step.verify(ctx, entry)) {
      say(ctx, `step ${step.name}: already done (re-verified from disk)`);
      continue;
    }
    if (entry.status === 'done' || entry.status === 'skipped') {
      say(ctx, `step ${step.name}: marker says done but the observable state does not match: redoing`);
      entry.status = 'pending';
    }
    try {
      step.run(ctx, state);
    } catch (error) {
      entry.status = entry.status === 'pending' ? 'failed' : entry.status;
      entry.error = String(error.message ?? error);
      writeState(ctx, state);
      throw error;
    }
    writeState(ctx, state);
  }
  state.status = state.status === 'verified' ? 'verified' : 'applied';
  writeState(ctx, state);
  say(ctx, 'apply: complete. The canonical units are enabled but not started.');
  say(ctx, `apply: start them with: systemctl --user start ${CANONICAL_UNITS.join(' ')}`);
  say(ctx, 'apply: then run this module with `verify --accept`.');
  return EXIT_OK;
}

function commandVerify(ctx) {
  const state = readState(ctx);
  if (state === null) throw new Refusal('no v1 migration state file: run apply first');
  const checks = [];
  for (const unit of CANONICAL_UNITS) {
    checks.push([`${unit} is active`, unitActiveState(ctx, unit) === 'active']);
  }
  const mainPid = runSystemctl(ctx, ['show', '-p', 'MainPID', '--value', 'workbench-ptyd.service']).stdout.trim();
  const socketOk = exists(ctx.canonical.ptydSocket)
    && mainPid !== ''
    && mainPid !== '0'
    && pidsHoldingSocket(ctx, ctx.canonical.ptydSocket).includes(mainPid);
  checks.push(['canonical PTY socket is owned by the workbench-ptyd MainPID', socketOk]);
  const release = canonicalCurrentRelease(ctx);
  checks.push(['running release matches the migration pin',
    release?.commit === state.steps.release?.commit && release?.releaseId === state.steps.release?.releaseId]);
  const control = path.join(ctx.canonical.libDir, 'control.mjs');
  const testOverride = ctx.readinessCmd !== null && ctx.options.flags.home !== undefined && path.resolve(ctx.home) !== path.resolve(os.userInfo().homedir);
  const probe = testOverride
    ? spawnSync('/bin/sh', ['-c', ctx.readinessCmd], { encoding: 'utf8', env: ctx.env })
    : release?.releaseId
      ? spawnSync(process.execPath, [control, 'migration-ready', String(release.releaseId)], { encoding: 'utf8', env: ctx.env })
      : { status: 1, stdout: '' };
  const reported = (probe.stdout ?? '').replace(/\r?\n$/, '');
  checks.push([
    'readiness probe reports the canonical release id',
    (probe.status ?? 1) === 0 && release !== null && release.releaseId !== null && reported === String(release.releaseId),
  ]);
  const desktopUsers = pidsWithAnyUserDataDir(ctx);
  const desktopOk = desktopUsers.every((user) => user.dir === path.resolve(ctx.canonical.userData));
  checks.push(['the running desktop uses the canonical userData', desktopOk]);
  const configEntry = state.steps.config ?? { status: 'pending' };
  // Apply verifies the exact bytes before activation. The running application may
  // then legitimately write its settings, workspaces and history.
  checks.push(['initial config copy was verified and canonical config is present',
    configEntry.status === 'skipped' ||
    (configEntry.status === 'done' && configEntry.manifest && fs.lstatSync(ctx.canonical.configDir, { throwIfNoEntry: false })?.isDirectory())]);
  for (const unit of LEGACY_UNITS) {
    const enabled = unitEnabledState(ctx, unit);
    const active = unitActiveState(ctx, unit);
    checks.push([`${unit} is masked and inactive`, enabled === 'masked' && active !== 'active' && active !== 'activating']);
  }
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    say(ctx, `verify: ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  }
  state.verification = { at: new Date().toISOString(), checks: checks.map(([label, ok]) => ({ label, ok })) };
  if (failed > 0) {
    writeState(ctx, state);
    say(ctx, `verify: ${failed} check(s) failed: not marking verified`);
    return EXIT_REFUSED;
  }
  if (ctx.options.bools['accept'] !== true) {
    writeState(ctx, state);
    say(ctx, 'verify: all checks pass. Re-run with --accept to mark the migration verified.');
    return EXIT_OK;
  }
  state.status = 'verified';
  writeState(ctx, state);
  say(ctx, 'verify: all checks pass, state marked verified');
  return EXIT_OK;
}

function commandRollback(ctx) {
  const state = readState(ctx);
  if (state === null) throw new Refusal('no v1 migration state file: nothing to roll back');
  if (state.status === 'cleaned') throw new Refusal('the legacy installation was already removed by clean: rollback is impossible');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (const [name, original] of Object.entries(state.steps.helpers?.binOriginals ?? {})) {
    if (original.existed && !exists(path.join(ctx.binBackupDir, name))) {
      throw new Refusal(`rollback refused: missing write-ahead CLI backup for ${name}`);
    }
  }
  const stopped = runSystemctl(ctx, ['stop', ...CANONICAL_UNITS]);
  if (stopped.status !== 0) throw new Refusal(`rollback refused: failed to stop canonical units: ${stopped.stderr || stopped.stdout}`);
  for (const [args, label] of [
    [['disable', ...CANONICAL_UNITS], 'disable canonical units'],
    [['unmask', ...LEGACY_UNITS], 'unmask legacy units'],
  ]) {
    const result = runSystemctl(ctx, args);
    if (result.status !== 0) throw new Refusal(`rollback refused: failed to ${label}: ${result.stderr || result.stdout}`);
  }
  const originals = state.steps.units?.originalUnits ?? {};
  for (const [unit, original] of Object.entries(originals)) {
    if (original === null) continue;
    const file = path.join(ctx.unitDir, unit);
    if (exists(file) && fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === '/dev/null') fs.unlinkSync(file);
    if (!exists(file)) {
      if (original.type === 'symlink') fs.symlinkSync(original.target, file);
      else {
        fs.writeFileSync(file, Buffer.from(original.content, 'base64'), { mode: original.mode });
        fs.chmodSync(file, original.mode);
      }
    }
  }
  for (const [args, label] of [
    [['enable', ...LEGACY_UNITS], 'enable legacy units'],
    [['daemon-reload'], 'reload systemd'],
  ]) {
    const result = runSystemctl(ctx, args);
    if (result.status !== 0) throw new Refusal(`rollback refused: failed to ${label}: ${result.stderr || result.stdout}`);
  }

  const binBackups = state.steps.helpers?.binBackups ?? [];
  const restored = [];
  for (const name of binBackups) {
    const backup = path.join(ctx.binBackupDir, name);
    if (!fs.existsSync(backup)) continue;
    const target = path.join(ctx.binDir, name);
    const original = state.steps.helpers?.binOriginals?.[name];
    fs.rmSync(target, { force: true });
    if (original?.type === 'symlink') fs.symlinkSync(original.target, target);
    else {
      fs.copyFileSync(backup, target);
      if (original?.mode !== undefined) fs.chmodSync(target, original.mode);
    }
    restored.push(name);
  }
  for (const name of SHIM_NAMES) {
    if (restored.includes(name)) continue;
    const target = path.join(ctx.binDir, name);
    // Only remove what this migration created.
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === shimContent(name)) fs.rmSync(target);
  }
  for (const [name, original] of Object.entries(state.steps.helpers?.binOriginals ?? {})) {
    if (original.existed) continue;
    const target = path.join(ctx.binDir, name);
    if (!exists(target)) continue;
    const expected = name === 'anvi-bench' ? path.join(ctx.canonical.libDir, 'anvi-bench') : null;
    if (name === 'anvi-bench' && exists(expected) && sha256File(target) === sha256File(expected)) fs.rmSync(target);
    else if (SHIM_NAMES.includes(name) && fs.readFileSync(target, 'utf8') === shimContent(name)) fs.rmSync(target);
  }
  const desktopBackup = state.steps.desktop?.legacyDesktopBackup;
  if (typeof desktopBackup === 'string' && fs.existsSync(desktopBackup)) {
    fs.copyFileSync(desktopBackup, ctx.legacy.desktopFile);
  }
  const favoritePrevious = state.steps.desktop?.favoriteAppsPrevious;
  if (typeof favoritePrevious === 'string' && ctx.gsettingsCmd !== null) {
    const [bin, ...prefix] = ctx.gsettingsCmd;
    spawnSync(bin, [...prefix, 'set', 'org.gnome.shell', 'favorite-apps', favoritePrevious], { encoding: 'utf8', env: ctx.env });
  }
  const renamed = [];
  const rename = (target) => {
    if (!exists(target)) return;
    const dest = `${target}.rolled-back-${ts}`;
    if (exists(dest)) return;
    fs.renameSync(target, dest);
    renamed.push(dest);
  };
  rename(ctx.canonical.configDir);
  rename(ctx.canonical.userData);
  rename(ctx.canonical.libDir);
  rename(ctx.canonical.desktopFile);
  for (const unit of CANONICAL_UNITS) rename(path.join(ctx.unitDir, unit));
  runSystemctl(ctx, ['daemon-reload']);
  state.status = 'rolled-back';
  state.rollback = { at: new Date().toISOString(), renamed, restoredBinScripts: restored };
  writeState(ctx, state);
  say(ctx, `rollback: legacy units unmasked and enabled, ${restored.length} bin script(s) restored`);
  for (const target of renamed) say(ctx, `rollback: kept canonical copy as ${target}`);
  say(ctx, `rollback: start the legacy installation with: systemctl --user start ${LEGACY_UNITS.slice().reverse().join(' ')}`);
  return EXIT_OK;
}

function commandClean(ctx) {
  const state = readState(ctx);
  if (state === null) throw new Refusal('no v1 migration state file: nothing to clean');
  if (state.status !== 'verified') throw new Refusal(`clean needs a verified migration (state is ${state.status}): run verify --accept first`);
  const removals = [
    ...LEGACY_UNITS.map((unit) => path.join(ctx.unitDir, unit)),
    ctx.legacy.libDir,
    ctx.legacy.stateDir,
    ctx.legacy.configDir,
    ctx.legacy.userData,
    ctx.legacy.prototypeUserData,
    ctx.legacy.envFile,
    ctx.legacy.envDir,
    ctx.legacy.desktopFile,
    path.join(ctx.configHome, 'agent-workbench-preview'),
    path.join(ctx.dataHome, 'maw-desktop-dev'),
    ...ICON_SIZES.map((size) => path.join(ctx.hicolorDir, `${size}x${size}`, 'apps', `${ctx.legacy.iconName}.png`)),
  ].filter((target) => exists(target));
  for (const target of removals) say(ctx, `clean: will remove ${target}`);
  say(ctx, `clean: the legacy Electron runtime needs root: sudo apt remove maw-electron   (${ctx.legacy.electronRoot})`);
  say(ctx, `clean: the backup archive in ${ctx.backupDir} is kept until you delete it`);
  if (ctx.options.bools['yes'] !== true) {
    say(ctx, 'clean: nothing removed. Re-run with --yes to remove the list above.');
    return EXIT_REFUSED;
  }
  runSystemctl(ctx, ['unmask', ...LEGACY_UNITS]);
  const removed = [];
  for (const target of removals) {
    if (!isInside(ctx.home, target)) {
      say(ctx, `clean: skipping ${target}: outside ${ctx.home}`);
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  runSystemctl(ctx, ['daemon-reload']);
  state.status = 'cleaned';
  state.clean = { at: new Date().toISOString(), removed };
  writeState(ctx, state);
  say(ctx, `clean: removed ${removed.length} path(s)`);
  return EXIT_OK;
}

const USAGE = `Usage: migrate-identity.mjs <plan|apply|verify|rollback|clean> [options]

Safety: either --home <dir> (development and tests), or the real HOME plus --i-am-the-owner.

Commands
  plan                 read-only preflight and the full step list
  apply                run every step, each idempotent and re-verified from disk
  verify [--accept]    post-reboot checks; --accept marks the migration verified
  rollback             re-enable the legacy installation, keep the canonical copies renamed
  clean --yes          remove the legacy installation (needs a verified migration)

Paths
  --home DIR  --config-home DIR  --data-home DIR  --state-home DIR  --runtime-dir DIR
  --bin-dir DIR  --lib-dir DIR  --unit-dir DIR  --legacy-state-dir DIR

Injectable seams (tests and unusual installs)
  --systemctl-cmd CMD  --gsettings-cmd CMD  --tar-cmd CMD
  --initial-release-cmd CMD  --readiness-cmd CMD
  --proc-root DIR  --free-space-bytes N
  --electron-root DIR  --electron-version VER
  --unit-template FILE  --ptyd-unit-template FILE
  --helpers-source DIR  --icon-source DIR
  --source DIR  --expect-commit SHA
  --commit-map FILE  --commit-map-sha256 HASH

Exit codes: 0 ok (or nothing to migrate), 1 error, 2 refused, 3 awaiting the Electron runtime.
`;

function withMigrationLock(ctx, perform) {
  if (!ctx.realHome) return perform();
  const info = fs.lstatSync(ctx.runtimeDir);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Refusal('the migration requires a private XDG runtime directory');
  }
  const lockPath = path.join(ctx.runtimeDir, 'workbench-identity-migration.lock');
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const lock = fs.fstatSync(fd);
    if (!lock.isFile() || lock.uid !== process.getuid() || lock.mode & 0o077 || lock.nlink !== 1) {
      throw new Refusal('the identity migration lock is unsafe');
    }
    const acquired = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (acquired.error || acquired.status !== 0) throw new Refusal('could not acquire the identity migration lock');
    return perform();
  } finally {
    fs.closeSync(fd);
  }
}

export function run(argv, env = process.env) {
  let ctx = null;
  try {
    const options = parseArgs(argv);
    if (options.bools['help'] === true || options.command === null || options.command === 'help') {
      process.stdout.write(USAGE);
      return options.command === null && options.bools['help'] !== true ? EXIT_REFUSED : EXIT_OK;
    }
    ctx = resolveContext(options, env);
    switch (options.command) {
      case 'plan': return commandPlan(ctx);
      case 'apply': return withMigrationLock(ctx, () => commandApply(ctx));
      case 'verify': return withMigrationLock(ctx, () => commandVerify(ctx));
      case 'rollback': return withMigrationLock(ctx, () => commandRollback(ctx));
      case 'clean': return withMigrationLock(ctx, () => commandClean(ctx));
      default: throw new Refusal(`Unknown command: ${options.command}`);
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    process.stderr.write(`${message}\n`);
    if (error instanceof Refusal) return error.code;
    return EXIT_ERROR;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(run(process.argv.slice(2)));
