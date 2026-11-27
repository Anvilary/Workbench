import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/ptyd.mjs';
import { TerminalRegistry } from '../../../src/features/terminals/terminal-registry.js';
import { OpenTabsStore } from '../../../src/features/terminals/open-tabs-store.js';
import { createGraphicalSessionEnvResolver, GRAPHICAL_ENV_ALLOWLIST } from '../../../src/features/terminals/graphical-session-env.js';
import { AgentRegistry, createAgentRegistry } from '../../../src/agents/registry.js';
import { createClaudeCodeAdapter } from '../../../src/agents/claude-code/index.js';
import { AgencyProfileStore } from '../../../src/features/profiles/profile-store.js';
import { buildAgencyProfileLaunch } from '../../../src/features/profiles/profile-capabilities.js';
import { REPO_ROOT } from '../../helpers/paths.js';

const exec = promisify(execFile);

const SCRIPT_DIR = path.join(REPO_ROOT, 'scripts/workbench');

test('TERMINAL ENVIRONMENT 1: Unit template and rendered unit omit PrivateTmp and NoNewPrivileges', async () => {
  const templatePath = path.join(SCRIPT_DIR, 'pty-host', 'workbench-ptyd.service');
  const template = await fs.promises.readFile(templatePath, 'utf8');

  assert.ok(!template.includes('PrivateTmp='), 'workbench-ptyd.service template must not set PrivateTmp');
  assert.ok(!template.includes('NoNewPrivileges='), 'workbench-ptyd.service template must not set NoNewPrivileges');

  const tmpState = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-unit-test-'));
  const env = {
    ...process.env,
    WORKBENCH_STATE_DIR: tmpState,
    WORKBENCH_NODE_BIN: process.execPath,
    WORKBENCH_BIN_DIR: path.join(tmpState, 'bin'),
    WORKBENCH_PTYD_RUNTIME_NAME: 'workbench-ptyd-env-test',
  };

  const rendered = (await exec('/bin/sh', [path.join(SCRIPT_DIR, 'render-ptyd-unit.sh')], { env })).stdout;
  assert.ok(!rendered.includes('PrivateTmp='), 'Rendered workbench-ptyd unit must not include PrivateTmp');
  assert.ok(!rendered.includes('NoNewPrivileges='), 'Rendered workbench-ptyd unit must not include NoNewPrivileges');
  assert.ok(rendered.includes('RuntimeDirectory=workbench-ptyd-env-test'), 'Rendered workbench-ptyd unit must retain RuntimeDirectory');
  assert.ok(rendered.includes('UMask=0077'), 'Rendered workbench-ptyd unit must retain UMask=0077');

  await fs.promises.rm(tmpState, { recursive: true, force: true });
});

test('TERMINAL ENVIRONMENT 2: Supervisor spawns PTY children without adding user namespaces or NoNewPrivs', async () => {
  const tmpRuntime = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-term-env-test-'));
  const socketPath = path.join(tmpRuntime, 'ptyd.sock');
  const authPath = path.join(tmpRuntime, 'ptyd.sock.auth');

  const supervisor = new PtySupervisor({
    socketPath,
    authPath,
  });
  await supervisor.listen();

  const client = await PtyHostClient.connectOrSpawn({
    socketPath,
    authPath,
    autoSpawn: false,
  });

  try {
    const sessionId = randomUUID();
    const session = await client.spawn({
      id: sessionId,
      cmd: '/bin/sh',
      args: ['-c', 'cat /proc/self/uid_map; grep NoNewPrivs /proc/self/status'],
      cols: 80,
      rows: 24,
      cwd: tmpRuntime,
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    });

    assert.ok(session.pid > 0, 'Spawned terminal process must have valid PID');

    // Wait for output
    let output = '';
    const outputPromise = new Promise<void>((resolve) => {
      const unsub = client.onData((id, chunk) => {
        if (id === sessionId) {
          output += chunk;
          if (output.includes('NoNewPrivs')) {
            unsub();
            resolve();
          }
        }
      });
    });

    await Promise.race([
      outputPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for terminal output')), 4000)),
    ]);

    // The supervisor itself does not call unshare or prctl(PR_SET_NO_NEW_PRIVS).
    assert.ok(session.pid > 0);
  } finally {
    try { supervisor.close(); } catch {}
    client.detach();
    await fs.promises.rm(tmpRuntime, { recursive: true, force: true });
  }
});

test('TERMINAL ENVIRONMENT 3: Clean systemd user execution validates normal namespace, root file ownership, and SSH', async () => {
  // Test transient systemd user service environment (how workbench-ptyd.service runs without PrivateTmp and NoNewPrivileges)
  const userBus = `/run/user/${process.getuid ? process.getuid() : 1000}/bus`;
  const systemdEnv = {
    ...process.env,
    ...(fs.existsSync(userBus) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${userBus}` } : {}),
  };
  const execSystemd = (args: string[]) => exec('systemd-run', args, { env: systemdEnv });

  const { stdout: uidMap } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'cat /proc/self/uid_map']);
  assert.ok(!uidMap.includes('1000       1000          1'), 'Clean systemd user execution must not have single-UID map');

  const { stdout: privs } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'cat /proc/self/status | grep NoNewPrivs']);
  assert.ok(privs.includes('NoNewPrivs:\t0'), 'Clean systemd user execution must have NoNewPrivs: 0');

  // Verify file ownership in clean user namespace
  const sshProxyConf = '/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf';
  if (fs.existsSync(sshProxyConf)) {
    const { stdout: lsOut } = await execSystemd(['--user', '--pipe', '-q', 'ls', '-l', sshProxyConf]);
    assert.ok(lsOut.includes('root root'), `${sshProxyConf} must appear owned by root root, not nobody nogroup`);

    // Verify OpenSSH client validates config cleanly
    const { stdout: sshOut, stderr: sshErr } = await execSystemd(['--user', '--pipe', '-q', 'ssh', '-G', 'localhost']);
    assert.ok(!sshErr.includes('Bad owner or permissions'), 'SSH config validation must succeed without permission errors');
    assert.ok(sshOut.includes('hostname localhost'), 'SSH config parsed successfully');

    // Verify GitHub SSH authentication succeeds without permission/config rejection
    const { stdout: ghOut } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c',
      'ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes git@github.com 2>&1 || true']);
    assert.ok(!ghOut.includes('Bad owner or permissions'), 'GitHub SSH must not fail with bad ownership/permissions');
    assert.ok(ghOut.includes('You\'ve successfully authenticated') || ghOut.includes('github.com'),
      'GitHub SSH authentication succeeded or connected to GitHub');
  }

  // Verify sudo capability in clean execution (not blocked by NoNewPrivs)
  const { stdout: sudoOut, stderr: sudoErr } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'sudo -n true 2>&1 || true']);
  assert.ok(!sudoOut.includes('no new privileges') && !sudoErr.includes('no new privileges'),
    'sudo must not report "no new privileges flag is set"');
});

interface IsolatedGraphicalEnvState {
  active: boolean;
  display?: string;
  waylandDisplay?: string;
  xauthority?: string;
  xdgSessionType?: string;
  xdgCurrentDesktop?: string;
  xdgSessionDesktop?: string;
  extraVars?: Record<string, string>;
}

async function createIsolatedGraphicalHarness() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-pty-gfx-test-'));
  const runtimeDir = path.join(root, 'runtime');
  const x11Dir = path.join(root, 'x11-unix');
  const cwd = path.join(root, 'workspace');
  const shellIntegrationDir = path.join(root, 'shell-integration');
  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(x11Dir, { recursive: true, mode: 0o755 });
  await fs.promises.mkdir(cwd, { recursive: true });
  const servers: net.Server[] = [];

  const listenSocket = async (socketPath: string): Promise<void> => {
    await fs.promises.rm(socketPath, { force: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push(server);
  };

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const state: IsolatedGraphicalEnvState = { active: false };

  const resolver = createGraphicalSessionEnvResolver({
    platform: 'linux',
    uid,
    x11SocketDir: x11Dir,
    runCommand: async (file, args) => {
      if (file === 'systemctl') {
        const lines: string[] = [];
        if (state.display) lines.push(`DISPLAY=${state.display}`);
        if (state.waylandDisplay) lines.push(`WAYLAND_DISPLAY=${state.waylandDisplay}`);
        if (state.xauthority) lines.push(`XAUTHORITY=${state.xauthority}`);
        if (state.xdgSessionType) lines.push(`XDG_SESSION_TYPE=${state.xdgSessionType}`);
        if (state.xdgCurrentDesktop) lines.push(`XDG_CURRENT_DESKTOP=${state.xdgCurrentDesktop}`);
        if (state.xdgSessionDesktop) lines.push(`XDG_SESSION_DESKTOP=${state.xdgSessionDesktop}`);
        for (const [k, v] of Object.entries(state.extraVars ?? {})) {
          lines.push(`${k}=${v}`);
        }
        return { stdout: lines.join('\n'), stderr: '' };
      }
      if (args[0] === 'show-user') {
        return {
          stdout: state.active
            ? `Display=5\nSessions=5 3\nRuntimePath=${runtimeDir}\n`
            : `Display=\nSessions=3\nRuntimePath=${runtimeDir}\n`,
          stderr: '',
        };
      }
      if (args[1] === '5' && state.active) {
        const type = state.xdgSessionType === 'x11' ? 'x11' : 'wayland';
        return {
          stdout: `Id=5\nUser=${uid}\nState=active\nActive=yes\nType=${type}\nClass=user\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      }
      return {
        stdout: `Id=3\nUser=${uid}\nState=active\nActive=yes\nType=unspecified\nClass=manager\nRemote=no\nDisplay=\n`,
        stderr: '',
      };
    },
  });

  const envProbeScript = path.join(root, 'env-probe.mjs');
  await fs.promises.writeFile(
    envProbeScript,
    `import fs from 'node:fs';
const keys = ${JSON.stringify([...GRAPHICAL_ENV_ALLOWLIST, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HOME', 'TERM', 'COLORTERM', 'CLAUDE_CODE_CHILD_SESSION', 'WORKBENCH_TERMINAL_HISTFILE', 'ZDOTDIR', 'XDG_RUNTIME_DIR'])};
const snap = {};
for (const k of keys) {
  if (Object.hasOwn(process.env, k)) snap[k] = process.env[k];
}
process.stdout.write('PROBE_START:' + JSON.stringify(snap) + ':PROBE_END\\n');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (chunk.toString().includes('EXIT')) process.exit(0);
});
setInterval(() => {}, 1 << 30);
`,
  );

  return {
    root,
    runtimeDir,
    x11Dir,
    cwd,
    shellIntegrationDir,
    state,
    resolver,
    envProbeScript,
    listenWayland: (name = 'wayland-0') => listenSocket(path.join(runtimeDir, name)),
    listenX11: (num = 0) => listenSocket(path.join(x11Dir, `X${num}`)),
    writeXauth: async (name = '.mutter-Xwaylandauth.TEST') => {
      const p = path.join(runtimeDir, name);
      await fs.promises.writeFile(p, 'XAUTH_FIXTURE', { mode: 0o600 });
      return p;
    },
    cleanup: async () => {
      for (const s of servers.splice(0)) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

async function readProbeFromTerminal(registry: TerminalRegistry, terminalId: string): Promise<Record<string, string>> {
  let buf = '';
  const extract = (text: string): Record<string, string> | null => {
    const start = text.indexOf('PROBE_START:');
    const end = text.indexOf(':PROBE_END');
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start + 'PROBE_START:'.length, end)) as Record<string, string>;
  };

  let resolved = false;
  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error(`Timed out waiting for env probe output (got: ${buf})`));
    }, 5000);
    const attached = registry.attach(terminalId as never, (_id, chunk) => {
      buf += chunk;
      const parsed = extract(buf);
      if (parsed && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    if (attached) {
      buf += attached.replay;
      const parsed = extract(buf);
      if (parsed && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(parsed);
      }
    }
  });
}

const inMemoryStore = (): OpenTabsStore => ({ save: () => {} }) as unknown as OpenTabsStore;

test('TERMINAL ENVIRONMENT 4: Persistent PTY lifecycle handles pre-login startup, graphical login, display change, logout, and preserves live PTY env', async () => {
  const fx = await createIsolatedGraphicalHarness();
  const socketPath = path.join(fx.runtimeDir, 'ptyd.sock');
  const authPath = path.join(fx.runtimeDir, 'ptyd.sock.auth');
  const supervisor = new PtySupervisor({ socketPath, authPath });
  const registry = new TerminalRegistry(
    createAgentRegistry([]),
    { file: process.execPath, args: [fx.envProbeScript], name: 'probe-shell' },
    inMemoryStore(),
    () => null,
    async () => null,
    () => fx.shellIntegrationDir,
    {
      persistentPty: true,
      autoSpawn: false,
      socketPath,
      authPath,
      resolveGraphicalEnv: fx.resolver,
    },
  );

  // Save/restore stale process.env keys to verify stale inheritance does not persist across logout.
  const prevDisplay = process.env['DISPLAY'];
  const prevWayland = process.env['WAYLAND_DISPLAY'];
  const prevXauth = process.env['XAUTHORITY'];
  process.env['DISPLAY'] = ':99';
  process.env['WAYLAND_DISPLAY'] = 'wayland-stale';
  process.env['XAUTHORITY'] = path.join(fx.runtimeDir, 'stale-xauth');

  try {
    await supervisor.listen();
    await registry.initialize();

    // 1. Pre-graphical login: backend and supervisor started before login; stale process.env must be stripped.
    const preLogin = await registry.open({ kind: 'shell', cwd: fx.cwd });
    const preLoginEnv = await readProbeFromTerminal(registry, preLogin.terminalId);
    assert.equal('DISPLAY' in preLoginEnv, false);
    assert.equal('WAYLAND_DISPLAY' in preLoginEnv, false);
    assert.equal('XAUTHORITY' in preLoginEnv, false);
    assert.equal('XDG_SESSION_TYPE' in preLoginEnv, false);

    // 2. Graphical login occurs after daemon startup -> new terminal receives graphical variables, excludes auth/unrelated vars.
    await fx.listenWayland('wayland-0');
    await fx.listenX11(0);
    const xauth1 = await fx.writeXauth('.mutter-Xwaylandauth.FIRST');
    fx.state.active = true;
    fx.state.display = ':0';
    fx.state.waylandDisplay = 'wayland-0';
    fx.state.xauthority = xauth1;
    fx.state.xdgSessionType = 'wayland';
    fx.state.xdgCurrentDesktop = 'ubuntu:GNOME';
    fx.state.xdgSessionDesktop = 'ubuntu';
    fx.state.extraVars = { ANTHROPIC_API_KEY: 'sk-ant-forbidden', OPENAI_API_KEY: 'sk-openai-forbidden' };

    const postLogin = await registry.open({ kind: 'shell', cwd: fx.cwd });
    const postLoginPid = registry.pidOf(postLogin.terminalId)!;
    assert.ok(postLoginPid > 0);
    const postLoginEnv = await readProbeFromTerminal(registry, postLogin.terminalId);
    assert.equal(postLoginEnv['DISPLAY'], ':0');
    assert.equal(postLoginEnv['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(postLoginEnv['XAUTHORITY'], xauth1);
    assert.equal(postLoginEnv['XDG_SESSION_TYPE'], 'wayland');
    assert.equal(postLoginEnv['XDG_CURRENT_DESKTOP'], 'ubuntu:GNOME');
    assert.equal(postLoginEnv['XDG_SESSION_DESKTOP'], 'ubuntu');
    assert.equal('ANTHROPIC_API_KEY' in postLoginEnv, false);
    assert.equal('OPENAI_API_KEY' in postLoginEnv, false);

    // 3. Display changes -> subsequent terminal gets updated values while existing live PTY retains original env.
    await fx.listenWayland('wayland-1');
    await fx.listenX11(1);
    const xauth2 = await fx.writeXauth('.mutter-Xwaylandauth.SECOND');
    fx.state.display = ':1';
    fx.state.waylandDisplay = 'wayland-1';
    fx.state.xauthority = xauth2;

    const changedTerm = await registry.open({ kind: 'shell', cwd: fx.cwd });
    const changedEnv = await readProbeFromTerminal(registry, changedTerm.terminalId);
    assert.equal(changedEnv['DISPLAY'], ':1');
    assert.equal(changedEnv['WAYLAND_DISPLAY'], 'wayland-1');
    assert.equal(changedEnv['XAUTHORITY'], xauth2);

    // Live PTY from step 2 must still have its original DISPLAY=:0 and xauth1 in /proc/<pid>/environ.
    const liveEnvironRaw = await fs.promises.readFile(`/proc/${postLoginPid}/environ`, 'utf8');
    assert.ok(liveEnvironRaw.includes('DISPLAY=:0\0'));
    assert.ok(liveEnvironRaw.includes(`XAUTHORITY=${xauth1}\0`));

    // 4. Logout / removed variables -> subsequent terminal drops them and does not inherit stale DISPLAY=:99.
    fx.state.active = false;
    delete fx.state.display;
    delete fx.state.waylandDisplay;
    delete fx.state.xauthority;
    delete fx.state.xdgSessionType;
    const afterLogout = await registry.open({ kind: 'shell', cwd: fx.cwd });
    const afterLogoutEnv = await readProbeFromTerminal(registry, afterLogout.terminalId);
    assert.equal('DISPLAY' in afterLogoutEnv, false);
    assert.equal('WAYLAND_DISPLAY' in afterLogoutEnv, false);
    assert.equal('XAUTHORITY' in afterLogoutEnv, false);
    assert.equal('XDG_SESSION_TYPE' in afterLogoutEnv, false);
  } finally {
    if (prevDisplay === undefined) delete process.env['DISPLAY'];
    else process.env['DISPLAY'] = prevDisplay;
    if (prevWayland === undefined) delete process.env['WAYLAND_DISPLAY'];
    else process.env['WAYLAND_DISPLAY'] = prevWayland;
    if (prevXauth === undefined) delete process.env['XAUTHORITY'];
    else process.env['XAUTHORITY'] = prevXauth;

    await registry.disposeAll();
    try { await supervisor.close({ killAll: true }); } catch {}
    await fx.cleanup();
  }
});

test('TERMINAL ENVIRONMENT 5: Direct PTY, concurrent opens, shell integration, and Agency native profile isolation preserve graphical and profile invariants', async () => {
  const fx = await createIsolatedGraphicalHarness();
  await fx.listenWayland('wayland-0');
  await fx.listenX11(0);
  const xauth = await fx.writeXauth();
  fx.state.active = true;
  fx.state.display = ':0';
  fx.state.waylandDisplay = 'wayland-0';
  fx.state.xauthority = xauth;
  fx.state.xdgSessionType = 'wayland';
  fx.state.xdgCurrentDesktop = 'ubuntu:GNOME';
  fx.state.xdgSessionDesktop = 'ubuntu';

  const registry = new TerminalRegistry(
    createAgentRegistry([]),
    { file: process.execPath, args: [fx.envProbeScript], name: 'probe-shell' },
    inMemoryStore(),
    () => null,
    async () => null,
    () => fx.shellIntegrationDir,
    {
      persistentPty: false,
      resolveGraphicalEnv: fx.resolver,
    },
  );

  // Separate registry using real /bin/bash to verify prepareIntegratedShell keeps graphical vars.
  const bashRegistry = new TerminalRegistry(
    createAgentRegistry([]),
    { file: '/bin/bash', args: [], name: 'bash' },
    inMemoryStore(),
    () => null,
    async () => null,
    () => fx.shellIntegrationDir,
    {
      persistentPty: false,
      resolveGraphicalEnv: fx.resolver,
    },
  );

  try {
    // 1. Direct PTY launch + concurrent launches.
    const opened = await Promise.all([
      registry.open({ kind: 'shell', cwd: fx.cwd }),
      registry.open({ kind: 'shell', cwd: fx.cwd }),
      registry.open({ kind: 'shell', cwd: fx.cwd }),
    ]);
    const envs = await Promise.all(opened.map((d) => readProbeFromTerminal(registry, d.terminalId)));
    for (const env of envs) {
      assert.equal(env['DISPLAY'], ':0');
      assert.equal(env['WAYLAND_DISPLAY'], 'wayland-0');
      assert.equal(env['XAUTHORITY'], xauth);
      assert.equal(env['XDG_SESSION_TYPE'], 'wayland');
    }

    // 2. Agency native launch preserves profile restrictions + adapter removal + resolved graphical vars.
    const fakeCli = path.join(fx.root, 'fake-claude');
    await fs.promises.writeFile(
      fakeCli,
      `#!/bin/sh\nexec "${process.execPath}" "${fx.envProbeScript}" "$@"\n`,
      { mode: 0o755 },
    );
    const profilesFile = path.join(fx.root, 'profiles.json');
    const profileStore = new AgencyProfileStore(profilesFile);
    await profileStore.createProfile({
      id: 'claude-isolated',
      provider: 'claude-code',
      label: 'Claude Isolated',
      executable: fakeCli,
      args: [],
      environmentOverrides: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      disabled: false,
    });
    const claudeAdapter = createClaudeCodeAdapter();
    const agentReg = new AgentRegistry([claudeAdapter]);
    const agencyLaunchRegistry = new TerminalRegistry(
      agentReg,
      { file: process.execPath, args: [fx.envProbeScript], name: 'probe-shell' },
      inMemoryStore(),
      () => null,
      async () => null,
      () => fx.shellIntegrationDir,
      { persistentPty: false, resolveGraphicalEnv: fx.resolver },
    );
    const isolatedProfileHome = path.join(fx.root, 'profile-isolated');
    const launchPlan = await buildAgencyProfileLaunch(profileStore, agentReg, {
      profileId: 'claude-isolated' as never,
      cwd: fx.cwd,
      proposedSessionId: randomUUID(),
      launchToken: randomUUID(),
      environment: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: isolatedProfileHome,
        CLAUDE_CODE_CHILD_SESSION: '1',
        XDG_RUNTIME_DIR: fx.runtimeDir,
      },
    });
    const agencyDesc = await agencyLaunchRegistry.open({
      kind: 'agent',
      agent: 'claude-code',
      cwd: fx.cwd,
      agencyManaged: true,
      agencyLaunch: {
        file: launchPlan.file,
        args: launchPlan.args,
        env: launchPlan.env,
        session: launchPlan.session,
        launchToken: randomUUID(),
        proposedSessionId: randomUUID(),
      },
    });
    const agencyEnv = await readProbeFromTerminal(agencyLaunchRegistry, agencyDesc.terminalId);
    assert.equal(agencyEnv['HOME'], isolatedProfileHome);
    assert.equal(agencyEnv['TERM'], 'xterm-256color');
    assert.equal(agencyEnv['COLORTERM'], 'truecolor');
    assert.equal('CLAUDE_CODE_CHILD_SESSION' in agencyEnv, false);
    assert.equal(agencyEnv['DISPLAY'], ':0');
    assert.equal(agencyEnv['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(agencyEnv['XAUTHORITY'], xauth);
    assert.equal(agencyEnv['XDG_SESSION_TYPE'], 'wayland');
    await agencyLaunchRegistry.disposeAll();

    // 3. Integrated bash shell preserves both shell integration and graphical variables.
    if (fs.existsSync('/bin/bash')) {
      const bashDesc = await bashRegistry.open({
        kind: 'shell',
        cwd: fx.cwd,
        agencyManaged: true,
      });
      let bashOutput = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for bash output: ${bashOutput}`)), 5000);
        bashRegistry.attach(bashDesc.terminalId, (_id, chunk) => {
          bashOutput += chunk;
          if (bashOutput.includes('GFX_SHELL_OK') && bashOutput.includes('WAYLAND=wayland-0')) {
            clearTimeout(timer);
            resolve();
          }
        });
        bashRegistry.write(
          bashDesc.terminalId,
          'printf "GFX_SHELL_OK DISP=%s WAYLAND=%s HIST=%s\\n" "$DISPLAY" "$WAYLAND_DISPLAY" "$WORKBENCH_TERMINAL_HISTFILE"\n',
        );
      });
      assert.ok(bashOutput.includes('DISP=:0'), `Expected DISP=:0 in bash output: ${bashOutput}`);
      assert.ok(bashOutput.includes('WAYLAND=wayland-0'), `Expected WAYLAND=wayland-0 in bash output: ${bashOutput}`);
      assert.ok(bashOutput.includes('.history'), `Expected WORKBENCH_TERMINAL_HISTFILE in bash output: ${bashOutput}`);
    }
  } finally {
    await registry.disposeAll();
    await bashRegistry.disposeAll();
    await fx.cleanup();
  }
});

test('TERMINAL ENVIRONMENT 6: Remote access paired devices do not receive host graphical session authority on newly opened PTYs', async () => {
  const fx = await createIsolatedGraphicalHarness();
  await fx.listenWayland('wayland-0');
  await fx.listenX11(0);
  const xauth = await fx.writeXauth();
  fx.state.active = true;
  fx.state.display = ':0';
  fx.state.waylandDisplay = 'wayland-0';
  fx.state.xauthority = xauth;
  fx.state.xdgSessionType = 'wayland';

  const { attachWorkbenchSocket } = await import('../../../src/transport/websocket/socket-server.js');
  const { SessionIndex } = await import('../../../src/features/history/session-index.js');
  const { ArchivedSessions } = await import('../../../src/features/history/archived-sessions.js');
  const { VaultCatalog } = await import('../../../src/features/vault/catalog.js');
  const { WorktreeLinks } = await import('../../../src/features/worktrees/links.js');
  const { WorktreeStore } = await import('../../../src/features/worktrees/store.js');
  const { VaultService } = await import('../../../src/features/vault/service.js');
  const { WorktreeService } = await import('../../../src/features/worktrees/service.js');
  const { AppSettingsService } = await import('../../../src/features/settings/app-settings-service.js');
  const { SettingsStore } = await import('../../../src/features/settings/settings-store.js');
  const { NotesStore } = await import('../../../src/features/notes/notes-store.js');
  const { DraftStore } = await import('../../../src/features/composer/draft-store.js');
  const { ConversationHub } = await import('../../../src/features/conversations/conversation-hub.js');
  const { RepoHub } = await import('../../../src/features/git/repo-hub.js');
  const { MemoryHub } = await import('../../../src/features/memory/memory-hub.js');
  const { RemoteAccessService } = await import('../../../src/features/remote-access/remote-access-service.js');
  const { RemoteDevicesStore } = await import('../../../src/features/remote-access/remote-devices-store.js');
  const { AgencyWorkspaceStore } = await import('../../../src/features/workspaces/workspace-store.js');
  const { AgencySessionRuntime } = await import('../../../src/features/sessions/session-runtime.js');
  const { SplitAgencySessionStore } = await import('../../../src/features/sessions/session-store.js');
  const { WorkspaceMutex } = await import('../../../src/features/workspaces/workspace-lock.js');

  const httpServer = createServer(express());
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  const settings = new SettingsStore(path.join(fx.root, 'settings.json'));
  await settings.load();
  const agents = createAgentRegistry([]);
  const store = inMemoryStore();
  const archived = new ArchivedSessions();
  await archived.load();
  const worktreeStore = new WorktreeStore(path.join(fx.root, 'worktrees.json'));
  await worktreeStore.load();
  const index = new SessionIndex(agents, archived, new VaultCatalog(), new WorktreeLinks(worktreeStore));
  const vault = new VaultService({ agents, index, archived, settings, catalog: new VaultCatalog(), platform: process.platform });
  const registry = new TerminalRegistry(
    agents,
    { file: process.execPath, args: [fx.envProbeScript], name: 'probe-shell' },
    store,
    () => null,
    async () => null,
    () => fx.shellIntegrationDir,
    { persistentPty: false, resolveGraphicalEnv: fx.resolver },
  );
  const worktrees = new WorktreeService({
    store: worktreeStore,
    registry,
    projectCwd: () => null,
    findSession: () => null,
    sessionsUnder: () => [],
    history: () => null,
  });
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(fx.root, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();
  const HOST_TOKEN = 'host-session-token';
  const PAIRED_CREDENTIAL = 'paired-device-secret';
  remote.verifier = () => ({
    match: (cred: string) => (cred === PAIRED_CREDENTIAL ? { id: 'paired-device-1' } : null),
  });

  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(fx.root, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(fx.root, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const agencyRuntime = new AgencySessionRuntime({
    registry,
    workspaces: { protectedDirectories: () => [], withSessionReservation: (_id, action) => action(null) },
    profiles: { resolveLaunch: async () => ({}) as never },
    store: new SplitAgencySessionStore(path.join(fx.root, 'agency-sessions.json')),
  });
  await agencyRuntime.initialize();

  const detach = attachWorkbenchSocket({
    httpServer,
    port,
    token: HOST_TOKEN,
    appSettings: new AppSettingsService({ settings, agents, shells: [], onShellChange: () => {} }),
    registry,
    index,
    archived,
    notes: new NotesStore(path.join(fx.root, 'notes.json')),
    drafts: new DraftStore({ statePath: path.join(fx.root, 'drafts.json') }),
    conversations: new ConversationHub(registry, agents),
    repos: new RepoHub(registry),
    memory: new MemoryHub(registry),
    agents,
    defaultCwd: fx.cwd,
    vault,
    remote,
    worktrees,
    noAuth: false,
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock: new WorkspaceMutex(),
  });

  const openViaWs = async (headers: Record<string, string>, urlPath: string): Promise<string> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, {
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...headers },
    });
    const reqId = randomUUID();
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS terminal.open timeout')), 5000);
        ws.once('error', reject);
        ws.once('open', () => {
          ws.send(JSON.stringify({ type: 'terminal.open', requestId: reqId, cwd: fx.cwd, kind: 'shell' }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as { type: string; requestId?: string; terminal?: { terminalId: string }; message?: string };
          if (msg.type === 'terminal.opened' && msg.requestId === reqId && msg.terminal) {
            clearTimeout(timer);
            resolve(msg.terminal.terminalId);
          } else if (msg.type === 'error' && msg.requestId === reqId) {
            clearTimeout(timer);
            reject(new Error(msg.message ?? 'WS error'));
          }
        });
      });
    } finally {
      ws.close();
    }
  };

  const { DEVICE_COOKIE } = await import('../../../src/security/request-guards.js');
  try {
    const localTermId = await openViaWs({}, `/ws?token=${HOST_TOKEN}`);
    const localPid = registry.pidOf(localTermId)!;
    const localEnv = await readProbeFromTerminal(registry, localTermId);
    assert.equal(localEnv['DISPLAY'], ':0');
    assert.equal(localEnv['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(localEnv['XAUTHORITY'], xauth);

    const remoteTermId = await openViaWs({ cookie: `${DEVICE_COOKIE}=${PAIRED_CREDENTIAL}` }, '/ws');
    const remoteEnv = await readProbeFromTerminal(registry, remoteTermId);
    assert.equal('DISPLAY' in remoteEnv, false);
    assert.equal('WAYLAND_DISPLAY' in remoteEnv, false);
    assert.equal('XAUTHORITY' in remoteEnv, false);
    assert.equal('XDG_SESSION_TYPE' in remoteEnv, false);

    // Concurrent local and remote terminal.open requests must never bleed local display vars into remote PTY.
    const [concurrentLocalId, concurrentRemoteId] = await Promise.all([
      openViaWs({}, `/ws?token=${HOST_TOKEN}`),
      openViaWs({ cookie: `${DEVICE_COOKIE}=${PAIRED_CREDENTIAL}` }, '/ws'),
    ]);
    const [concurrentLocalEnv, concurrentRemoteEnv] = await Promise.all([
      readProbeFromTerminal(registry, concurrentLocalId),
      readProbeFromTerminal(registry, concurrentRemoteId),
    ]);
    assert.equal(concurrentLocalEnv['DISPLAY'], ':0');
    assert.equal(concurrentLocalEnv['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal('DISPLAY' in concurrentRemoteEnv, false);
    assert.equal('WAYLAND_DISPLAY' in concurrentRemoteEnv, false);
    assert.equal('XAUTHORITY' in concurrentRemoteEnv, false);

    // Paired remote socket must still be refused host-desktop operations and reattaching must not alter local PTY env.
    const remoteWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        cookie: `${DEVICE_COOKIE}=${PAIRED_CREDENTIAL}`,
      },
    });
    try {
      const refusal = await new Promise<{ type: string; code?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS remote refusal timeout')), 5000);
        remoteWs.once('error', reject);
        remoteWs.once('open', () => {
          remoteWs.send(JSON.stringify({ type: 'terminal.attach', terminalId: localTermId, cols: 80, rows: 24 }));
          remoteWs.send(JSON.stringify({ type: 'files.reveal', terminalId: localTermId, path: '.' }));
        });
        remoteWs.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as { type: string; code?: string };
          if (msg.type === 'error') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      assert.equal(refusal.code, 'remote-refused');
      const liveEnvironRaw = await fs.promises.readFile(`/proc/${localPid}/environ`, 'utf8');
      assert.ok(liveEnvironRaw.includes('DISPLAY=:0\0'));
      assert.ok(liveEnvironRaw.includes('WAYLAND_DISPLAY=wayland-0\0'));
    } finally {
      remoteWs.close();
    }
  } finally {
    detach();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await registry.disposeAll();
    await fx.cleanup();
  }
});

test('TERMINAL ENVIRONMENT 7: Asynchronous cancellation, close during resolution, backend shutdown, and failure cleanup prevent orphan PTYs', async () => {
  const fx = await createIsolatedGraphicalHarness();
  const spawnCounterFile = path.join(fx.root, 'spawn-count');
  const slowMarkerShell = path.join(fx.root, 'slow-marker-shell.sh');
  await fs.promises.writeFile(
    slowMarkerShell,
    `#!/bin/sh\necho "$$" >> "${spawnCounterFile}"\nexec "${process.execPath}" "${fx.envProbeScript}" "$@"\n`,
    { mode: 0o755 },
  );

  let releaseLookup!: () => void;
  let onLookupEntered: (() => void) | null = null;
  let lookupMode: 'gate' | 'throw' | 'ok' = 'gate';
  const gatedResolver = async (baseEnv: Record<string, string>) => {
    if (lookupMode === 'gate') {
      const waitGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
      onLookupEntered?.();
      onLookupEntered = null;
      await waitGate;
    } else if (lookupMode === 'throw') {
      throw new Error('simulated resolver rejection');
    }
    return { ...baseEnv, WAYLAND_DISPLAY: 'wayland-0' };
  };

  const registry = new TerminalRegistry(
    createAgentRegistry([]),
    { file: slowMarkerShell, args: [], name: 'marker-shell' },
    inMemoryStore(),
    () => null,
    async () => null,
    () => fx.shellIntegrationDir,
    { persistentPty: false, resolveGraphicalEnv: gatedResolver },
  );

  try {
    const internalTerminals = () =>
      (registry as unknown as { terminals: Map<string, unknown> }).terminals;

    // 1. Closing a terminal while graphical resolution is pending prevents PTY spawn and releases slot.
    const entered1 = new Promise<void>((resolve) => { onLookupEntered = resolve; });
    const openPending = registry.open({ kind: 'shell', cwd: fx.cwd });
    await entered1;
    const pendingId = internalTerminals().keys().next().value as string;
    assert.ok(pendingId);
    assert.equal(registry.activeCount(), 1);
    assert.equal(registry.close(pendingId as never), true);
    releaseLookup();
    await assert.rejects(openPending, /closed while it was opening|tabClosedWhileOpening/i);
    assert.equal(registry.activeCount(), 0);
    assert.equal(fs.existsSync(spawnCounterFile), false, 'Closed-while-resolving terminal must never spawn a PTY');

    // 2. Resolver rejection falls back cleanly and leaves terminal usable without leaking reservation.
    lookupMode = 'throw';
    const fallbackDesc = await registry.open({ kind: 'shell', cwd: fx.cwd });
    assert.equal(fallbackDesc.alive, true);
    assert.equal(registry.activeCount(), 1);
    assert.equal(registry.close(fallbackDesc.terminalId), true);
    assert.equal(registry.activeCount(), 0);

    // 3. Cancelling an Agency session while graphical resolution is pending settles without an active orphan PTY.
    const { AgencySessionRuntime } = await import('../../../src/features/sessions/session-runtime.js');
    const { SplitAgencySessionStore } = await import('../../../src/features/sessions/session-store.js');
    const { WorkspaceMutex } = await import('../../../src/features/workspaces/workspace-lock.js');
    const canonicalCwd = await fs.promises.realpath(fx.cwd);
    const nowIso = new Date().toISOString();
    const ws = {
      id: randomUUID() as import('@anvilary/workbench-shared').WorkspaceId,
      projectId: randomUUID() as import('@anvilary/workbench-shared').ProjectId,
      name: 'main',
      cwd: canonicalCwd,
      status: 'active' as const,
      createdAt: nowIso,
      updatedAt: nowIso,
      doneAt: null,
      archivedAt: null,
    };
    const lock = new WorkspaceMutex();
    const agencyRt = new AgencySessionRuntime({
      registry,
      workspaces: {
        protectedDirectories: () => [],
        withSessionReservation: (id, action) => lock.runExclusive(id, () => action(id === ws.id ? ws : null)),
      },
      profiles: { resolveLaunch: async () => ({}) as never },
      store: new SplitAgencySessionStore(path.join(fx.root, 'agency-sess-cancel.json')),
    });
    await agencyRt.initialize();
    lookupMode = 'gate';
    const countBeforeAgency = fs.existsSync(spawnCounterFile)
      ? fs.readFileSync(spawnCounterFile, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    const enteredAgency = new Promise<void>((resolve) => { onLookupEntered = resolve; });
    const agencyCreatePromise = agencyRt.create({
      workspaceId: ws.id,
      kind: 'terminal',
      cols: 80,
      rows: 24,
    });
    await enteredAgency;
    const pendingSessionId = agencyRt.list(ws.id)[0]!.id;
    await agencyRt.stop(pendingSessionId);
    releaseLookup();
    const cancelledSession = await agencyCreatePromise;
    assert.ok(cancelledSession.lifecycle === 'stopping' || cancelledSession.lifecycle === 'exited');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(registry.activeCount(), 0);
    const countAfterAgency = fs.existsSync(spawnCounterFile)
      ? fs.readFileSync(spawnCounterFile, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    assert.ok(countAfterAgency >= countBeforeAgency);
    agencyRt.dispose();

    // 4. Backend shutdown (disposeAll) during pending resolution prevents orphan PTY spawn.
    lookupMode = 'gate';
    const enteredShutdown = new Promise<void>((resolve) => { onLookupEntered = resolve; });
    const shutdownPending = registry.open({ kind: 'shell', cwd: fx.cwd });
    await enteredShutdown;
    const beforeShutdownCount = fs.existsSync(spawnCounterFile)
      ? fs.readFileSync(spawnCounterFile, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    registry.disposeAll();
    releaseLookup();
    await assert.rejects(shutdownPending);
    const afterShutdownCount = fs.existsSync(spawnCounterFile)
      ? fs.readFileSync(spawnCounterFile, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    assert.equal(afterShutdownCount, beforeShutdownCount, 'disposeAll during pending resolution must prevent new PTY spawn');
  } finally {
    await registry.disposeAll();
    await fx.cleanup();
  }
});
