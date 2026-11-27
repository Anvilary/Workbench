import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GRAPHICAL_ENV_ALLOWLIST,
  createGraphicalSessionEnvResolver,
  parseSystemdEnvironment,
  type CommandExecResult,
} from '../../../src/features/terminals/graphical-session-env.js';

interface IsolatedGraphicalFixture {
  root: string;
  runtimeDir: string;
  x11Dir: string;
  uid: number;
  closeSockets: () => Promise<void>;
  createWaylandSocket: (name?: string) => Promise<string>;
  createX11Socket: (num?: number) => Promise<string>;
  createXauthority: (name?: string, mode?: number) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function createIsolatedFixture(): Promise<IsolatedGraphicalFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gfx-unit-'));
  const runtimeDir = path.join(root, 'runtime');
  const x11Dir = path.join(root, 'x11-unix');
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(x11Dir, { recursive: true, mode: 0o755 });
  const servers: net.Server[] = [];

  const listenUnix = async (socketPath: string): Promise<string> => {
    await fs.rm(socketPath, { force: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push(server);
    return socketPath;
  };

  return {
    root,
    runtimeDir,
    x11Dir,
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    closeSockets: async () => {
      for (const s of servers.splice(0)) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
    createWaylandSocket: (name = 'wayland-0') => listenUnix(path.join(runtimeDir, name)),
    createX11Socket: (num = 0) => listenUnix(path.join(x11Dir, `X${num}`)),
    createXauthority: async (name = '.mutter-Xwaylandauth.TEST', mode = 0o600) => {
      const p = path.join(runtimeDir, name);
      await fs.writeFile(p, 'SECRET_COOKIE_DO_NOT_READ', { mode });
      return p;
    },
    cleanup: async () => {
      for (const s of servers.splice(0)) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('parseSystemdEnvironment decodes allowlisted vars safely without shell evaluation', () => {
  const raw = [
    'ANTHROPIC_API_KEY=sk-ant-secret',
    'OPENAI_API_KEY=sk-openai-secret',
    'WORKBENCH_PTYD_AUTH_FILE=/tmp/auth',
    'LD_PRELOAD=/tmp/evil.so',
    'DISPLAY=:0',
    "WAYLAND_DISPLAY=$'wayland-0'",
    "XAUTHORITY=$'/run/user/1000/.mutter-Xwaylandauth.\\x41\\x42'",
    'XDG_SESSION_TYPE=wayland',
    'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
    'XDG_SESSION_DESKTOP=ubuntu',
    'MALFORMED_LINE_WITHOUT_EQUALS',
    'DISPLAY=$(touch /tmp/pwned)',
    'DISPLAY=:1',
    "XDG_SESSION_DESKTOP=$'unterminated",
    'XDG_CURRENT_DESKTOP=bad\u0000value',
  ].join('\n');

  const parsed = parseSystemdEnvironment(raw);
  assert.deepEqual(Object.keys(parsed).sort(), [...GRAPHICAL_ENV_ALLOWLIST].sort());
  assert.equal(parsed.DISPLAY, ':1');
  assert.equal(parsed.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(parsed.XAUTHORITY, '/run/user/1000/.mutter-Xwaylandauth.AB');
  assert.equal(parsed.XDG_SESSION_TYPE, 'wayland');
  // Control/NUL line was rejected so earlier ubuntu:GNOME stays intact.
  assert.equal(parsed.XDG_CURRENT_DESKTOP, 'ubuntu:GNOME');
  // Unterminated ANSI-C line was rejected so earlier ubuntu stays intact.
  assert.equal(parsed.XDG_SESSION_DESKTOP, 'ubuntu');
  assert.equal('ANTHROPIC_API_KEY' in parsed, false);
  assert.equal('LD_PRELOAD' in parsed, false);
});

test('resolver propagates validated allowlist and excludes auth, runtime, and GPU overrides', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    await fx.createX11Socket(0);
    const xauth = await fx.createXauthority();
    const calls: string[] = [];

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        calls.push(`${file} ${args.join(' ')}`);
        if (file === 'systemctl') {
          return {
            stdout: [
              'ANTHROPIC_API_KEY=should-not-import',
              'OPENAI_API_KEY=should-not-import',
              'GITHUB_TOKEN=ghp_should_not_import',
              'WORKBENCH_PTYD_AUTH_FILE=/bad/auth',
              'PATH=/evil/bin',
              'HOME=/evil/home',
              'XDG_RUNTIME_DIR=/evil/runtime',
              'DBUS_SESSION_BUS_ADDRESS=unix:path=/evil/bus',
              '__NV_PRIME_RENDER_OFFLOAD=1',
              'LD_PRELOAD=/evil/lib.so',
              'SSH_AUTH_SOCK=/evil/ssh.sock',
              'DISPLAY=:0',
              'WAYLAND_DISPLAY=wayland-0',
              `XAUTHORITY=${xauth}`,
              'XDG_SESSION_TYPE=wayland',
              'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
              'XDG_SESSION_DESKTOP=ubuntu',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5 3\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        if (args[1] === '5') {
          return {
            stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\n`,
            stderr: '',
          };
        }
        return {
          stdout: `Id=3\nUser=${fx.uid}\nState=active\nActive=yes\nType=unspecified\nClass=manager\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      },
    });

    const isolatedHome = path.join(fx.root, 'home');
    const baseEnv: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      XDG_RUNTIME_DIR: fx.runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${fx.runtimeDir}/bus`,
      CODEX_HOME: path.join(isolatedHome, '.codex'),
    };

    const resolved = await resolver(baseEnv);
    assert.equal(resolved['DISPLAY'], ':0');
    assert.equal(resolved['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(resolved['XAUTHORITY'], xauth);
    assert.equal(resolved['XDG_SESSION_TYPE'], 'wayland');
    assert.equal(resolved['XDG_CURRENT_DESKTOP'], 'ubuntu:GNOME');
    assert.equal(resolved['XDG_SESSION_DESKTOP'], 'ubuntu');

    // Trusted existing variables remain intact.
    assert.equal(resolved['PATH'], '/usr/bin:/bin');
    assert.equal(resolved['HOME'], isolatedHome);
    assert.equal(resolved['CODEX_HOME'], path.join(isolatedHome, '.codex'));
    assert.equal(resolved['XDG_RUNTIME_DIR'], fx.runtimeDir);
    assert.equal(resolved['DBUS_SESSION_BUS_ADDRESS'], `unix:path=${fx.runtimeDir}/bus`);

    // Excluded variables never enter.
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'WORKBENCH_PTYD_AUTH_FILE',
      '__NV_PRIME_RENDER_OFFLOAD',
      'LD_PRELOAD',
      'SSH_AUTH_SOCK',
    ]) {
      assert.equal(key in resolved, false, `${key} must be excluded`);
    }
    assert.ok(calls.some((c) => c.startsWith('systemctl --user show-environment')));
  } finally {
    await fx.cleanup();
  }
});

test('Wayland-only session omits absent or expired XAUTHORITY without failing Wayland vars', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: [
              'WAYLAND_DISPLAY=wayland-0',
              `XAUTHORITY=${path.join(fx.runtimeDir, 'expired-xauth')}`,
              'XDG_SESSION_TYPE=wayland',
              'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({
      XDG_RUNTIME_DIR: fx.runtimeDir,
      XAUTHORITY: '/tmp/stale-xauth',
      DISPLAY: ':99',
    });
    assert.equal(resolved['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(resolved['XDG_SESSION_TYPE'], 'wayland');
    assert.equal(resolved['XDG_CURRENT_DESKTOP'], 'ubuntu:GNOME');
    assert.equal('XAUTHORITY' in resolved, false);
    assert.equal('DISPLAY' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('multiple active graphical sessions for same user are treated as ambiguous and never guessed', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    await fx.createX11Socket(0);
    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: 'DISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n',
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5 7\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=${args[1]}\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, DISPLAY: ':9' });
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('headless or logged-out user strips stale graphical variables and leaves terminal env usable', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return { stdout: 'DISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n', stderr: '' };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=\nSessions=3 9\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        if (args[1] === '9') {
          // SSH session (Remote=yes, Type=tty)
          return {
            stdout: `Id=9\nUser=${fx.uid}\nState=active\nActive=yes\nType=tty\nClass=user\nRemote=yes\nDisplay=\n`,
            stderr: '',
          };
        }
        return {
          stdout: `Id=3\nUser=${fx.uid}\nState=active\nActive=yes\nType=unspecified\nClass=manager\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: fx.runtimeDir,
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_SESSION_TYPE: 'wayland',
    });
    assert.equal(resolved['PATH'], '/usr/bin');
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('missing systemd user manager preserves valid local non-systemd graphical env and rejects SSH forwarded DISPLAY', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createX11Socket(0);
    const xauth = await fx.createXauthority('.Xauthority');
    const enoent = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async () => {
        throw enoent;
      },
    });

    const localNonSystemd = await resolver({
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: fx.runtimeDir,
      DISPLAY: ':0',
      XAUTHORITY: xauth,
      XDG_SESSION_TYPE: 'x11',
    });
    assert.equal(localNonSystemd['DISPLAY'], ':0');
    assert.equal(localNonSystemd['XAUTHORITY'], xauth);
    assert.equal(localNonSystemd['XDG_SESSION_TYPE'], 'x11');

    const sshEnv = await resolver({
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: fx.runtimeDir,
      SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22',
      DISPLAY: 'localhost:10.0',
      XDG_SESSION_TYPE: 'x11',
    });
    assert.equal('DISPLAY' in sshEnv, false);
    assert.equal('XDG_SESSION_TYPE' in sshEnv, false);
  } finally {
    await fx.cleanup();
  }
});

test('timeout during systemd lookup never throws and strips stale display vars', async () => {
  const fx = await createIsolatedFixture();
  try {
    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async () => {
        throw Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' });
      },
    });

    const resolved = await resolver({
      PATH: '/usr/bin',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-stale',
    });
    assert.equal(resolved['PATH'], '/usr/bin');
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('concurrent resolver calls share a single in-flight lookup', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    let systemctlCalls = 0;

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          systemctlCalls++;
          await new Promise((r) => setTimeout(r, 40));
          return { stdout: 'WAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n', stderr: '' };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\n`,
          stderr: '',
        };
      },
    });

    const results = await Promise.all([
      resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, TAG: 'a' }),
      resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, TAG: 'b' }),
      resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, TAG: 'c' }),
    ]);

    assert.equal(systemctlCalls, 1);
    for (const res of results) {
      assert.equal(res['WAYLAND_DISPLAY'], 'wayland-0');
      assert.equal(res['XDG_SESSION_TYPE'], 'wayland');
    }
    assert.deepEqual(results.map((r) => r['TAG']), ['a', 'b', 'c']);
  } finally {
    await fx.cleanup();
  }
});

test('remoteClient context withholds host graphical session variables', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    let ranCommands = 0;
    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async () => {
        ranCommands++;
        return { stdout: 'WAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n', stderr: '' };
      },
    });

    const remoteEnv = await resolver(
      { PATH: '/usr/bin', XDG_RUNTIME_DIR: fx.runtimeDir, DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
      { remoteClient: true },
    );
    assert.equal(ranCommands, 0);
    assert.equal(remoteEnv['PATH'], '/usr/bin');
    assert.equal('DISPLAY' in remoteEnv, false);
    assert.equal('WAYLAND_DISPLAY' in remoteEnv, false);
  } finally {
    await fx.cleanup();
  }
});

test('Windows and macOS platforms return baseEnv unchanged without invoking Linux tools', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    let called = false;
    const resolver = createGraphicalSessionEnvResolver({
      platform,
      runCommand: async () => {
        called = true;
        return { stdout: '', stderr: '' };
      },
    });

    const input = { PATH: 'C:\\Windows\\System32', DISPLAY: ':0', CUSTOM: '1' };
    const out = await resolver(input);
    assert.equal(called, false);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
  }
});

test('disagreement between loginctl session type and manager snapshot discards stale display values', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    await fx.createX11Socket(0);
    const xauth = await fx.createXauthority();

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: [
              'DISPLAY=:0',
              `XAUTHORITY=${xauth}`,
              'XDG_SESSION_TYPE=x11',
              'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\nDesktop=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir });
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('XAUTHORITY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
    assert.equal('XDG_CURRENT_DESKTOP' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('Wayland session rejects orphaned XWayland DISPLAY when Wayland socket is absent', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createX11Socket(0);
    const xauth = await fx.createXauthority();

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: [
              'DISPLAY=:0',
              'WAYLAND_DISPLAY=wayland-missing',
              `XAUTHORITY=${xauth}`,
              'XDG_SESSION_TYPE=wayland',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\nDesktop=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir });
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
    assert.equal('XAUTHORITY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('multiple graphical user sessions (active + background online) are rejected as ambiguous', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    await fx.createX11Socket(0);

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: 'DISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n',
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5 6\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        if (args[1] === '5') {
          return {
            stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\nDesktop=\n`,
            stderr: '',
          };
        }
        return {
          stdout: `Id=6\nUser=${fx.uid}\nState=online\nActive=no\nType=x11\nClass=user\nRemote=no\nDisplay=:1\nDesktop=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir });
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('accessible leftover display sockets after logout are ignored when loginctl has no active graphical session', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    await fx.createX11Socket(0);
    const xauth = await fx.createXauthority();

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl') {
          return {
            stdout: `DISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXAUTHORITY=${xauth}\nXDG_SESSION_TYPE=wayland\n`,
            stderr: '',
          };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=\nSessions=3\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=3\nUser=${fx.uid}\nState=active\nActive=yes\nType=unspecified\nClass=manager\nRemote=no\nDisplay=\nDesktop=\n`,
          stderr: '',
        };
      },
    });

    const resolved = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, DISPLAY: ':0' });
    assert.equal('DISPLAY' in resolved, false);
    assert.equal('WAYLAND_DISPLAY' in resolved, false);
    assert.equal('XAUTHORITY' in resolved, false);
    assert.equal('XDG_SESSION_TYPE' in resolved, false);
  } finally {
    await fx.cleanup();
  }
});

test('failed lookup is not cached and recovers immediately on subsequent call, and missing user bus falls back cleanly', async () => {
  const fx = await createIsolatedFixture();
  try {
    await fx.createWaylandSocket('wayland-0');
    let failFirst = true;

    const resolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file, args): Promise<CommandExecResult> => {
        if (file === 'systemctl' && failFirst) {
          throw Object.assign(new Error('Command timed out'), { killed: true });
        }
        if (file === 'systemctl') {
          return { stdout: 'WAYLAND_DISPLAY=wayland-0\nXDG_SESSION_TYPE=wayland\n', stderr: '' };
        }
        if (args[0] === 'show-user') {
          return { stdout: `Display=5\nSessions=5\nRuntimePath=${fx.runtimeDir}\n`, stderr: '' };
        }
        return {
          stdout: `Id=5\nUser=${fx.uid}\nState=active\nActive=yes\nType=wayland\nClass=user\nRemote=no\nDisplay=\nDesktop=\n`,
          stderr: '',
        };
      },
    });

    const first = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir, WAYLAND_DISPLAY: 'wayland-stale' });
    assert.equal('WAYLAND_DISPLAY' in first, false);

    failFirst = false;
    const second = await resolver({ XDG_RUNTIME_DIR: fx.runtimeDir });
    assert.equal(second['WAYLAND_DISPLAY'], 'wayland-0');
    assert.equal(second['XDG_SESSION_TYPE'], 'wayland');

    const noBusResolver = createGraphicalSessionEnvResolver({
      platform: 'linux',
      uid: fx.uid,
      x11SocketDir: fx.x11Dir,
      runCommand: async (file) => {
        if (file === 'systemctl') {
          throw Object.assign(new Error('Failed to connect to user scope bus via local transport: No such file or directory'), { code: 1 });
        }
        throw Object.assign(new Error('spawn loginctl ENOENT'), { code: 'ENOENT' });
      },
    });
    const nonSystemd = await noBusResolver({
      XDG_RUNTIME_DIR: fx.runtimeDir,
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_SESSION_TYPE: 'wayland',
    });
    assert.equal(nonSystemd['WAYLAND_DISPLAY'], 'wayland-0');
  } finally {
    await fx.cleanup();
  }
});
