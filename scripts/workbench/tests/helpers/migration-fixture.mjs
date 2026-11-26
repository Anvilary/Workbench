// Isolated fixture for the identity migration tests.
//
// Every test gets a throwaway HOME with explicit XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and
// XDG_RUNTIME_DIR under it, plus a stateful mock `systemctl` and `gsettings` on PATH. Nothing here ever
// touches the real home directory: the fixture refuses to build one inside it.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_PATH = path.resolve(HELPERS_DIR, '../../migrate-identity.mjs');
export const SCRIPTS_DIR = path.resolve(HELPERS_DIR, '../..');

// A stateful mock: `mask` really prevents `start`, and every invocation is logged in order.
const MOCK_SYSTEMCTL = `#!/bin/sh
set -eu
state="\${MOCK_SYSTEMD_STATE:?}"
mkdir -p "$state"
printf '%s\\n' "$*" >> "\${MOCK_SYSTEMCTL_LOG:-/dev/null}"
unit_file() { printf '%s/%s.%s' "$state" "$(printf '%s' "$1" | tr '/' '_')" "$2"; }
get() { f=$(unit_file "$1" "$2"); if [ -f "$f" ]; then cat "$f"; else printf '%s' "$3"; fi; }
set_value() { f=$(unit_file "$1" "$2"); printf '%s' "$3" > "$f"; }
verb="\${1:-}"
[ "$#" -gt 0 ] && shift || true
[ "$verb" = "--user" ] && { verb="\${1:-}"; shift || true; }
rc=0
case "$verb" in
  is-active)
    for u in "$@"; do
      v=$(get "$u" active inactive)
      printf '%s\\n' "$v"
      [ "$v" = active ] || rc=3
    done
    ;;
  is-enabled)
    for u in "$@"; do
      v=$(get "$u" enabled disabled)
      printf '%s\\n' "$v"
      [ "$v" = enabled ] || rc=1
    done
    ;;
  enable)
    for u in "$@"; do
      [ "$(get "$u" enabled disabled)" = masked ] && { printf 'Unit %s is masked.\\n' "$u" >&2; rc=1; continue; }
      set_value "$u" enabled enabled
    done
    ;;
  disable) for u in "$@"; do set_value "$u" enabled disabled; done ;;
  mask) for u in "$@"; do set_value "$u" enabled masked; [ -z "\${MOCK_SYSTEMD_UNIT_DIR:-}" ] || ln -sfn /dev/null "$MOCK_SYSTEMD_UNIT_DIR/$u"; done ;;
  unmask) for u in "$@"; do set_value "$u" enabled disabled; target="\${MOCK_SYSTEMD_UNIT_DIR:-}/$u"; [ ! -L "$target" ] || [ "$(readlink "$target")" != /dev/null ] || unlink "$target"; done ;;
  start)
    for u in "$@"; do
      if [ "$(get "$u" enabled disabled)" = masked ]; then
        printf 'Failed to start %s: Unit %s is masked.\\n' "$u" "$u" >&2
        rc=1
      else
        set_value "$u" active active
      fi
    done
    ;;
  stop) for u in "$@"; do set_value "$u" active inactive; done ;;
  show)
    unit=""
    for a in "$@"; do case "$a" in -p|--value|MainPID|-p*) ;; *) unit="$a" ;; esac; done
    printf '%s\\n' "$(get "$unit" mainpid 0)"
    ;;
  daemon-reload) : ;;
  list-units) cat "$state/restart-helpers" 2>/dev/null || true ;;
  *) : ;;
esac
exit $rc
`;

const MOCK_GSETTINGS = `#!/bin/sh
set -eu
file="\${MOCK_GSETTINGS_FILE:?}"
printf '%s\\n' "$*" >> "\${MOCK_GSETTINGS_LOG:-/dev/null}"
case "\${1:-}" in
  get) if [ -f "$file" ]; then cat "$file"; else printf "@as []\\n"; fi ;;
  set) printf '%s\\n' "\${4:-}" > "$file" ;;
  *) exit 1 ;;
esac
`;

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function writePinnedSource(fixture) {
  fs.mkdirSync(fixture.sourceDir, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', fixture.sourceDir, ...args], { encoding: 'utf8' });
  if (git('init', '-q').status !== 0) throw new Error('could not initialize synthetic source checkout');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(fixture.sourceDir, 'README.md'), 'synthetic migration source\n');
  fs.mkdirSync(path.join(fixture.sourceDir, 'packages/shared/src'), { recursive: true });
  fs.writeFileSync(path.join(fixture.sourceDir, 'packages/shared/src/workbench-env.mjs'), 'export const fixture = true;\n');
  git('add', '.');
  if (git('commit', '-q', '-m', 'fixture source').status !== 0) throw new Error('could not commit synthetic source checkout');
  fixture.expectedCommit = git('rev-parse', 'HEAD').stdout.trim();
  const mapText = `old new\n${fixture.expectedCommit} ${fixture.expectedCommit}\n`;
  fs.writeFileSync(fixture.commitMap, mapText);
  fixture.commitMapSha256 = crypto.createHash('sha256').update(mapText).digest('hex');
  const healthy = path.join(fixture.legacy.stateDir, 'releases/20261101120000-abcdef12/.maw-release-meta.json');
  if (fs.existsSync(healthy)) {
    const meta = JSON.parse(fs.readFileSync(healthy, 'utf8'));
    meta.commit = fixture.expectedCommit;
    fs.writeFileSync(healthy, JSON.stringify(meta));
  }
}

/**
 * Build an isolated fixture. `t` is a node:test context; the fixture is removed on test teardown.
 * @param {{ populate?: boolean, xdgLayout?: 'default'|'custom' }} opts
 */
export function createFixture(t, opts = {}) {
  const { populate = true, xdgLayout = 'default' } = opts;
  const realHome = path.resolve(os.homedir());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-migration-home-'));
  if (home === realHome || home.startsWith(`${realHome}${path.sep}`)) {
    throw new Error(`Refusing to build a fixture inside the real home: ${home}`);
  }
  const layout = xdgLayout === 'custom'
    ? { configHome: path.join(home, 'xdg/conf'), dataHome: path.join(home, 'xdg/data'), stateHome: path.join(home, 'xdg/state'), runtimeDir: path.join(home, 'xdg/run') }
    : { configHome: path.join(home, '.config'), dataHome: path.join(home, '.local/share'), stateHome: path.join(home, '.local/state'), runtimeDir: path.join(home, 'run') };
  const fixture = {
    home,
    ...layout,
    binDir: path.join(home, '.local/bin'),
    libDir: path.join(home, '.local/lib'),
    unitDir: path.join(layout.configHome, 'systemd/user'),
    mockBin: path.join(home, 'mockbin'),
    systemdState: path.join(home, 'systemd-state'),
    systemctlLog: path.join(home, 'systemctl.log'),
    gsettingsFile: path.join(home, 'gsettings-favorites'),
    gsettingsLog: path.join(home, 'gsettings.log'),
    procRoot: path.join(home, 'proc'),
    electronRoot: path.join(home, 'opt/workbench-electron'),
    electronVersion: '45.2.0',
    sourceDir: path.join(home, 'source-checkout'),
    commitMap: path.join(home, 'commit-map'),
  };
  for (const dir of [fixture.configHome, fixture.dataHome, fixture.stateHome, fixture.runtimeDir, fixture.binDir, fixture.unitDir, fixture.mockBin, fixture.systemdState, fixture.procRoot]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeExecutable(path.join(fixture.mockBin, 'systemctl'), MOCK_SYSTEMCTL);
  writeExecutable(path.join(fixture.mockBin, 'gsettings'), MOCK_GSETTINGS);

  fixture.legacy = {
    configDir: path.join(fixture.configHome, 'agent-workbench'),
    envFile: path.join(fixture.configHome, 'maw/environment'),
    userData: path.join(fixture.dataHome, 'maw-desktop'),
    stateDir: path.join(fixture.dataHome, 'maw'),
    libDir: path.join(home, '.local/lib/maw'),
    desktopFile: path.join(fixture.dataHome, 'applications/maw.desktop'),
  };
  fixture.canonical = {
    configDir: path.join(fixture.configHome, 'workbench'),
    envFile: path.join(fixture.configHome, 'workbench/environment'),
    userData: path.join(fixture.dataHome, 'workbench-desktop'),
    stateDir: path.join(fixture.dataHome, 'workbench'),
    libDir: path.join(home, '.local/lib/workbench'),
    desktopFile: path.join(fixture.dataHome, 'applications/workbench.desktop'),
    stateFile: path.join(fixture.dataHome, 'workbench/migration/identity-v1.json'),
    backupDir: path.join(fixture.dataHome, 'workbench-migration-backup'),
  };

  if (populate) populateLegacy(fixture);
  writePinnedSource(fixture);
  writeFakeUpdater(fixture);
  writeUnitTemplates(fixture);
  installElectronStub(fixture);

  fixture.env = {
    PATH: `${fixture.mockBin}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
    XDG_STATE_HOME: fixture.stateHome,
    XDG_RUNTIME_DIR: fixture.runtimeDir,
    MOCK_SYSTEMD_STATE: fixture.systemdState,
    MOCK_SYSTEMD_UNIT_DIR: fixture.unitDir,
    MOCK_SYSTEMCTL_LOG: fixture.systemctlLog,
    MOCK_GSETTINGS_FILE: fixture.gsettingsFile,
    MOCK_GSETTINGS_LOG: fixture.gsettingsLog,
  };

  fixture.baseArgs = () => [
    '--home', fixture.home,
    '--config-home', fixture.configHome,
    '--data-home', fixture.dataHome,
    '--state-home', fixture.stateHome,
    '--runtime-dir', fixture.runtimeDir,
    '--bin-dir', fixture.binDir,
    '--unit-dir', fixture.unitDir,
    '--systemctl-cmd', path.join(fixture.mockBin, 'systemctl'),
    '--gsettings-cmd', path.join(fixture.mockBin, 'gsettings'),
    '--proc-root', fixture.procRoot,
    '--free-space-bytes', '10000000000',
    '--electron-root', fixture.electronRoot,
    '--electron-version', fixture.electronVersion,
    '--initial-release-cmd', `/bin/sh ${path.join(home, 'fake-updater.sh')}`,
    '--source', fixture.sourceDir,
    '--expect-commit', fixture.expectedCommit,
    '--commit-map', fixture.commitMap,
    '--commit-map-sha256', fixture.commitMapSha256,
    '--unit-template', path.join(home, 'templates/workbench.service'),
    '--ptyd-unit-template', path.join(home, 'templates/workbench-ptyd.service'),
    '--helpers-source', path.join(home, 'helpers-source'),
  ];

  /** Run the module. `args` are appended to the base args unless `bare` is set. */
  fixture.run = (args, options = {}) => {
    const full = options.bare === true ? args : [...args.slice(0, 1), ...fixture.baseArgs(), ...args.slice(1)];
    const result = spawnSync(process.execPath, [MODULE_PATH, ...full], {
      encoding: 'utf8',
      env: { ...fixture.env, ...(options.env ?? {}) },
      cwd: home,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  fixture.systemctlCalls = () => (fs.existsSync(fixture.systemctlLog)
    ? fs.readFileSync(fixture.systemctlLog, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => line.replace(/^--user /, ''))
    : []);
  fixture.unitState = (unit, kind) => {
    const file = path.join(fixture.systemdState, `${unit}.${kind}`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  fixture.setUnitState = (unit, kind, value) => fs.writeFileSync(path.join(fixture.systemdState, `${unit}.${kind}`), value);
  fixture.state = () => JSON.parse(fs.readFileSync(fixture.canonical.stateFile, 'utf8'));

  /** Add a fake /proc entry owned by this user. */
  fixture.addProcess = (pid, { cmdline = [], fds = [] } = {}) => {
    const dir = path.join(fixture.procRoot, String(pid));
    fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmdline'), `${cmdline.join('\0')}\0`);
    for (const [index, target] of fds.entries()) {
      const link = path.join(dir, 'fd', String(index));
      fs.rmSync(link, { force: true });
      if (target.endsWith('/ptyd.sock')) {
        const inode = String(100000 + Number(pid));
        fs.symlinkSync(`socket:[${inode}]`, link);
        const netFile = path.join(fixture.procRoot, 'net/unix');
        fs.mkdirSync(path.dirname(netFile), { recursive: true });
        if (!fs.existsSync(netFile)) fs.writeFileSync(netFile, 'Num RefCount Protocol Flags Type St Inode Path\n');
        fs.appendFileSync(netFile, `000: 00000002 00000000 00010000 0001 01 ${inode} ${target}\n`);
      } else fs.symlinkSync(target, link);
    }
  };

  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  return fixture;
}

function populateLegacy(fixture) {
  const { legacy } = fixture;
  fs.mkdirSync(legacy.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy.configDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  fs.writeFileSync(path.join(legacy.configDir, 'workspace.json'), JSON.stringify({ tabs: [1, 2] }));
  fs.mkdirSync(path.join(legacy.configDir, 'agent-status/claude'), { recursive: true });
  fs.writeFileSync(path.join(legacy.configDir, 'agent-status/claude/abc.json'), '{"state":"idle"}');

  fs.mkdirSync(path.dirname(legacy.envFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacy.envFile, [
    '# legacy environment',
    'MAW_PORT=45643',
    'MAW_UNSAFE_LOCAL_NO_AUTH=1',
    'AGENT_WORKBENCH_LOG_LEVEL=debug',
    'EDITOR=vim',
    'GIT_PAGER=cat',
    'WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1',
    '',
  ].join('\n'), { mode: 0o600 });

  // userData with two legacy partitions, the caches that must be dropped and the data that must survive.
  const partitions = ['maw-browser', 'maw-profile-test1-chatgpt'];
  fs.mkdirSync(legacy.userData, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy.userData, 'Preferences'), JSON.stringify({
    download: { default_directory: path.join(legacy.userData, 'Downloads') },
    spellcheck: { dictionaries: ['en-US'], dictionary_path: path.join(legacy.userData, 'Dictionaries') },
    unrelated: 'keep me',
  }));
  fs.writeFileSync(path.join(legacy.userData, 'Local State'), JSON.stringify({
    user_experience_metrics: { stability: {} },
    profile: { last_used: path.join(legacy.userData, 'Default') },
  }));
  fs.writeFileSync(path.join(legacy.userData, 'SingletonLock'), 'pid');
  fs.writeFileSync(path.join(legacy.userData, 'SingletonCookie'), 'cookie');
  for (const name of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'ShaderCache', 'Crashpad']) {
    fs.mkdirSync(path.join(legacy.userData, name), { recursive: true });
    fs.writeFileSync(path.join(legacy.userData, name, 'junk.bin'), 'x'.repeat(64));
  }
  fs.mkdirSync(path.join(legacy.userData, 'Dictionaries'), { recursive: true });
  fs.writeFileSync(path.join(legacy.userData, 'Dictionaries', 'en-US-10-1.bdic'), 'dictionary');
  for (const partition of partitions) {
    const dir = path.join(legacy.userData, 'Partitions', partition);
    for (const sub of ['Local Storage/leveldb', 'IndexedDB/http_127.0.0.1_0.indexeddb.leveldb', 'Service Worker/CacheStorage/abc', 'Session Storage']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      fs.writeFileSync(path.join(dir, sub, 'CURRENT'), `${partition}:${sub}`);
    }
    for (const name of ['Cache', 'Code Cache', 'GPUCache']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'junk.bin'), 'y'.repeat(32));
    }
    fs.writeFileSync(path.join(dir, 'Cookies'), `cookies-for-${partition}`);
    fs.writeFileSync(path.join(dir, 'Network Persistent State'), '{}');
    fs.writeFileSync(path.join(dir, 'TransportSecurity'), '{}');
    fs.writeFileSync(path.join(dir, 'Custom Dictionary.txt'), 'anvilary\n');
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      download: { default_directory: path.join(legacy.userData, 'Downloads') },
      partition,
    }));
  }

  // Legacy release state: one healthy release plus pointers and the update log.
  const releaseId = '20261101120000-abcdef12';
  const releaseDir = path.join(legacy.stateDir, 'releases', releaseId);
  fs.mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(releaseDir, '.maw-release-meta.json'), JSON.stringify({ releaseId, commit: 'a'.repeat(40), channelState: 'healthy' }));
  for (const name of ['current', 'healthy']) {
    const link = path.join(legacy.stateDir, name);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(releaseDir, link);
  }
  fs.writeFileSync(path.join(legacy.stateDir, 'update-log.jsonl'), `${JSON.stringify({ event: 'activate', releaseId })}\n`);
  fs.writeFileSync(path.join(legacy.stateDir, 'source_path'), '/home/user/src/workbench\n');
  fs.writeFileSync(path.join(legacy.stateDir, 'node_path'), `${process.execPath}\n`);

  fs.mkdirSync(legacy.libDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy.libDir, 'maw-lib.sh'), '# legacy lib\n');
  fs.writeFileSync(path.join(legacy.libDir, 'desktop-runtime-version'), fixture.electronVersion);

  for (const name of ['maw', 'anvil-bench']) {
    writeExecutable(path.join(fixture.binDir, name), `#!/bin/sh\necho "legacy ${name}"\n`);
  }

  fs.mkdirSync(path.dirname(legacy.desktopFile), { recursive: true });
  fs.writeFileSync(legacy.desktopFile, '[Desktop Entry]\nType=Application\nName=Workbench\nExec=maw desktop\nIcon=maw-workspace\n');
  for (const size of [48, 256]) {
    const dir = path.join(fixture.dataHome, 'icons/hicolor', `${size}x${size}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'maw-workspace.png'), `icon-${size}`);
  }
  for (const unit of ['maw.service', 'maw-ptyd.service']) {
    fs.writeFileSync(path.join(fixture.unitDir, unit), `[Unit]\nDescription=${unit}\n[Service]\nExecStart=/bin/true\n`);
    fs.writeFileSync(path.join(fixture.systemdState, `${unit}.enabled`), 'enabled');
  }
  fs.writeFileSync(path.join(fixture.systemdState, 'maw.service.active'), 'inactive');
  fs.writeFileSync(path.join(fixture.systemdState, 'maw-ptyd.service.active'), 'inactive');
}

/**
 * The fake canonical updater: builds a release structure the module accepts as `current`,
 * without ever marking it healthy.
 */
function writeFakeUpdater(fixture) {
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${fixture.home}/updater-args.log"
state_dir="\${WORKBENCH_STATE_DIR:?}"
release_id="20261126090000-beef1234"
dir="$state_dir/releases/$release_id"
mkdir -p "$dir/packages/server/dist"
printf '{"releaseId":"%s","commit":"%s","channelState":"staged"}\\n' "$release_id" "${fixture.expectedCommit}" > "$dir/.workbench-release-meta.json"
printf 'export default 1;\\n' > "$dir/packages/server/dist/index.mjs"
printf 'export default 1;\\n' > "$dir/packages/server/dist/ptyd.mjs"
rm -f "$state_dir/current.tmp"
ln -s "$dir" "$state_dir/current.tmp"
mv -Tf "$state_dir/current.tmp" "$state_dir/current"
printf 'initial release %s\\n' "$release_id"
`;
  writeExecutable(path.join(fixture.home, 'fake-updater.sh'), script);

  const helpers = path.join(fixture.home, 'helpers-source');
  fs.mkdirSync(helpers, { recursive: true });
  writeExecutable(path.join(helpers, 'anvi-bench'), '#!/bin/sh\necho "anvi-bench ${WORKBENCH_CLI_NAME:-anvi-bench} $*"\n');
  fs.writeFileSync(path.join(helpers, 'lib.sh'), '# canonical lib\n');
  fs.writeFileSync(path.join(helpers, 'update.sh'), '# canonical updater\n');
}

function writeUnitTemplates(fixture) {
  const dir = path.join(fixture.home, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workbench.service'), [
    '[Unit]',
    'Description=Anvilary Workbench',
    '[Service]',
    'Environment=PATH=@PATH@',
    'EnvironmentFile=-@ENV_FILE@',
    'RuntimeDirectory=@RUNTIME_NAME@',
    'ExecStart=@NODE_BIN@ @STATE_DIR@/current/packages/server/dist/index.mjs',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'workbench-ptyd.service'), [
    '[Unit]',
    'Description=Anvilary Workbench PTY supervisor',
    '[Service]',
    'Environment=PATH=@PATH@',
    'RuntimeDirectory=@PTYD_RUNTIME_NAME@',
    'ExecStart=@NODE_BIN@ @STATE_DIR@/current/packages/server/dist/ptyd.mjs',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
}

function installElectronStub(fixture) {
  const dir = path.join(fixture.electronRoot, fixture.electronVersion);
  fs.mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'electron'), '#!/bin/sh\nexit 0\n');
}

export function removeElectronStub(fixture) {
  fs.rmSync(path.join(fixture.electronRoot, fixture.electronVersion), { recursive: true, force: true });
}
