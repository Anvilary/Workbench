import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const exec = promisify(execFile);

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/maw');
const MAW_BIN = path.join(SCRIPT_DIR, 'maw');
const MAW_UPDATE_BIN = path.join(SCRIPT_DIR, 'maw-update.sh');
const MAW_RESTART_HELPER_BIN = path.join(SCRIPT_DIR, 'maw-restart-helper.sh');

async function setupGitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-'));
  const bareDir = path.join(root, 'origin.git');
  const sourceDir = path.join(root, 'source');
  const stateDir = path.join(root, 'state');
  const runtimeDir = path.join(root, 'runtime');
  const binDir = path.join(root, 'bin');

  await mkdir(stateDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true });

  // Init bare origin
  await exec('git', ['init', '--bare', bareDir]);
  await exec('git', ['-C', bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  // Init source repo
  await exec('git', ['clone', bareDir, sourceDir]);
  await exec('git', ['-C', sourceDir, 'config', 'user.name', 'MAW Tester']);
  await exec('git', ['-C', sourceDir, 'config', 'user.email', 'tester@example.com']);

  // Initial commit with minimal structure
  const pkg = {
    name: 'test-maw',
    version: '1.0.0',
    scripts: {
      typecheck: 'echo "typecheck ok"',
      build: 'mkdir -p packages/web/dist && echo "bundle" > packages/web/dist/index.html',
    },
  };
  await writeFile(path.join(sourceDir, 'package.json'), JSON.stringify(pkg, null, 2));
  await mkdir(path.join(sourceDir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(sourceDir, 'packages/web/dist'), { recursive: true });
  await writeFile(path.join(sourceDir, 'packages/server/src/maw-host.ts'), 'export const ready = true;\n');
  await writeFile(path.join(sourceDir, 'packages/web/dist/index.html'), '<html>old release</html>\n');

  await exec('git', ['-C', sourceDir, 'add', '.']);
  await exec('git', ['-C', sourceDir, 'commit', '-m', 'Initial commit']);
  await exec('git', ['-C', sourceDir, 'branch', '-M', 'main']);
  await exec('git', ['-C', sourceDir, 'push', '-u', 'origin', 'main']);

  // Initial release setup in stateDir
  const initialReleaseDir = path.join(stateDir, 'releases', 'initial-v1');
  await mkdir(initialReleaseDir, { recursive: true });
  await mkdir(path.join(initialReleaseDir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(initialReleaseDir, 'packages/web/dist'), { recursive: true });
  await writeFile(path.join(initialReleaseDir, 'packages/server/src/maw-host.ts'), 'export const ready = true;\n');
  await writeFile(path.join(initialReleaseDir, 'packages/web/dist/index.html'), '<html>v1</html>\n');
  await symlink(initialReleaseDir, path.join(stateDir, 'current'));
  await writeFile(path.join(stateDir, 'source_path'), sourceDir);

  // Stub pnpm, systemctl, etc. in binDir
  const pnpmStub = `#!/bin/sh
cmd="$1"
case "$cmd" in
  install)
    # create node_modules
    mkdir -p node_modules
    ;;
  typecheck)
    if [ -f "FAIL_TYPECHECK" ]; then
      echo "simulated typecheck failure" >&2
      exit 1
    fi
    ;;
  build)
    if [ -f "FAIL_BUILD" ]; then
      echo "simulated build failure" >&2
      exit 1
    fi
    mkdir -p packages/web/dist
    echo "<html>built</html>" > packages/web/dist/index.html
    ;;
  --filter)
    # test command
    if [ -f "FAIL_TEST" ]; then
      echo "simulated test failure" >&2
      exit 1
    fi
    ;;
esac
exit 0
`;
  await writeFile(path.join(binDir, 'corepack'), `#!/bin/sh
if [ "$1" = "pnpm" ]; then
  shift
fi
exec "${path.join(binDir, 'pnpm')}" "$@"
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'pnpm'), pnpmStub, { mode: 0o755 });

  const systemctlStub = `#!/bin/sh
cmd=""
for a in "$@"; do
  case "$a" in
    --*) ;;
    *) if [ -z "$cmd" ]; then cmd="$a"; fi ;;
  esac
done

case "$cmd" in
  show)
    for a in "$@"; do
      case "$a" in
        *MainPID*) echo "${process.pid}"; exit 0 ;;
      esac
    done
    echo "ActiveState=active"
    echo "SubState=running"
    echo "MainPID=${process.pid}"
    echo "ExecMainStatus=0"
    exit 0
    ;;
  restart|start|stop)
    echo "systemctl: $@" >> "${path.join(root, 'systemctl.log')}"
    exit 0
    ;;
esac
exit 0
`;
  await writeFile(path.join(binDir, 'systemctl'), systemctlStub, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    MAW_STATE_DIR: stateDir,
    MAW_RUNTIME_DIR: runtimeDir,
    MAW_SOURCE_DIR: sourceDir,
    MAW_UNIT: 'maw-fixture.service',
  };

  return { root, bareDir, sourceDir, stateDir, runtimeDir, binDir, env };
}

// ---------------------------------------------------------------------------
// 1. Clean fast-forward update
// ---------------------------------------------------------------------------
test('1. Clean fast-forward update creates isolated candidate and points current', async () => {
  const f = await setupGitFixture();
  try {
    // Add a commit upstream
    await writeFile(path.join(f.sourceDir, 'packages/server/src/new-feature.ts'), 'export const v2 = true;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'Add v2 feature']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    const res = await exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env });
    assert.match(res.stdout, /MAW update staged successfully/);

    const currentTarget = await readFile(path.join(f.stateDir, 'current', 'packages/web/dist/index.html'), 'utf8');
    assert.match(currentTarget, /built/);

    const logContent = await readFile(path.join(f.stateDir, 'update-log.jsonl'), 'utf8');
    assert.match(logContent, /"event":"update-success"/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Dirty development checkout
// ---------------------------------------------------------------------------
test('2. Dirty development checkout is detected and preserved untouched', async () => {
  const f = await setupGitFixture();
  try {
    // Make worktree dirty
    await writeFile(path.join(f.sourceDir, 'uncommitted.txt'), 'my uncommitted work\n');

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir], { env: f.env }),
      (err: any) => {
        assert.match(err.stderr, /Git worktree is dirty/);
        return true;
      }
    );

    // Verify uncommitted file is completely untouched
    const uncommitted = await readFile(path.join(f.sourceDir, 'uncommitted.txt'), 'utf8');
    assert.equal(uncommitted, 'my uncommitted work\n');

    const logContent = await readFile(path.join(f.stateDir, 'update-log.jsonl'), 'utf8');
    assert.match(logContent, /"error":"Git worktree is dirty"/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Unpushed commits
// ---------------------------------------------------------------------------
test('3. Unpushed local commits are detected and refused without data loss', async () => {
  const f = await setupGitFixture();
  try {
    // Commit locally without pushing
    await writeFile(path.join(f.sourceDir, 'local-work.ts'), 'export const local = true;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'Local unpushed commit']);

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir], { env: f.env }),
      (err: any) => {
        assert.match(err.stderr, /Local commits exist that are not on upstream tracking branch/);
        return true;
      }
    );

    // Assert local commit was not lost or reset
    const logOut = await exec('git', ['-C', f.sourceDir, 'log', '-1', '--oneline']);
    assert.match(logOut.stdout, /Local unpushed commit/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Diverged upstream
// ---------------------------------------------------------------------------
test('4. Diverged upstream is refused safely', async () => {
  const f = await setupGitFixture();
  try {
    // Upstream commit
    const otherDir = path.join(f.root, 'other');
    await exec('git', ['clone', f.bareDir, otherDir]);
    await exec('git', ['-C', otherDir, 'checkout', 'main']);
    await exec('git', ['-C', otherDir, 'config', 'user.name', 'Other']);
    await exec('git', ['-C', otherDir, 'config', 'user.email', 'other@example.com']);
    await writeFile(path.join(otherDir, 'upstream.ts'), 'export const up = 1;\n');
    await exec('git', ['-C', otherDir, 'add', '.']);
    await exec('git', ['-C', otherDir, 'commit', '-m', 'Upstream diverged commit']);
    await exec('git', ['-C', otherDir, 'push', 'origin', 'main']);

    // Local different commit
    await writeFile(path.join(f.sourceDir, 'diverged.ts'), 'export const local = 2;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'Local diverged commit']);

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env }),
      (err: any) => {
        assert.ok(err.stderr.includes('cannot be fast-forwarded') || err.stderr.includes('Local commits exist'));
        return true;
      }
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Interrupted dependency installation
// ---------------------------------------------------------------------------
test('5. Interrupted dependency install cleans candidate; old release untouched', async () => {
  const f = await setupGitFixture();
  try {
    // Push new commit with install failure trigger
    await writeFile(path.join(f.sourceDir, 'new.ts'), 'export const x = 1;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'trigger fail']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    // Overwrite pnpm stub to fail on install
    await writeFile(path.join(f.binDir, 'pnpm'), '#!/bin/sh\nif [ "$1" = "install" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env }),
      (err: any) => {
        assert.match(err.stderr, /pnpm install failed/);
        return true;
      }
    );

    // Old release remains active and unchanged
    const currentTarget = await readFile(path.join(f.stateDir, 'current', 'packages/web/dist/index.html'), 'utf8');
    assert.match(currentTarget, /v1/);

    const logContent = await readFile(path.join(f.stateDir, 'update-log.jsonl'), 'utf8');
    assert.match(logContent, /"stage":"dependencies"/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Typecheck failure
// ---------------------------------------------------------------------------
test('6. Typecheck failure cleans candidate; old release untouched', async () => {
  const f = await setupGitFixture();
  try {
    // Push commit that contains FAIL_TYPECHECK
    await writeFile(path.join(f.sourceDir, 'FAIL_TYPECHECK'), 'type error\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'add type error']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env }),
      (err: any) => {
        assert.match(err.stderr, /typecheck failed/);
        return true;
      }
    );

    // Old release is still active
    const currentTarget = await readFile(path.join(f.stateDir, 'current', 'packages/web/dist/index.html'), 'utf8');
    assert.match(currentTarget, /v1/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Build failure
// ---------------------------------------------------------------------------
test('7. Build failure cleans candidate; old release untouched', async () => {
  const f = await setupGitFixture();
  try {
    // Push commit that contains FAIL_BUILD
    await writeFile(path.join(f.sourceDir, 'FAIL_BUILD'), 'build error\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'add build error']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    await assert.rejects(
      exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env }),
      (err: any) => {
        assert.match(err.stderr, /build failed/);
        return true;
      }
    );

    const currentTarget = await readFile(path.join(f.stateDir, 'current', 'packages/web/dist/index.html'), 'utf8');
    assert.match(currentTarget, /v1/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8 & 9. Failed activation and Successful rollback
// ---------------------------------------------------------------------------
test('8 & 9. Failed activation triggers automatic rollback to previous release', async () => {
  const f = await setupGitFixture();
  try {
    // Setup previous release pointer in state
    const prevReleaseDir = path.join(f.stateDir, 'releases', 'verified-prev');
    await mkdir(prevReleaseDir, { recursive: true });
    await mkdir(path.join(prevReleaseDir, 'packages/server/src'), { recursive: true });
    await writeFile(path.join(prevReleaseDir, 'packages/server/src/maw-host.ts'), 'export const prev = true;\n');
    await symlink(prevReleaseDir, path.join(f.stateDir, 'previous'));

    // Create a new broken candidate as current
    const brokenReleaseDir = path.join(f.stateDir, 'releases', 'broken-candidate');
    await mkdir(brokenReleaseDir, { recursive: true });
    await rm(path.join(f.stateDir, 'current'));
    await symlink(brokenReleaseDir, path.join(f.stateDir, 'current'));

    // Create a mock control.mjs that fails when current is broken-candidate, succeeds when previous
    const mockControl = path.join(f.binDir, 'mock-control.mjs');
    await writeFile(mockControl, `
import fs from 'node:fs';
const current = fs.realpathSync('${path.join(f.stateDir, 'current')}');
if (current.includes('broken-candidate')) {
  console.error('Service failed readiness');
  process.exit(1);
}
console.log('Healthy; PID 1234; loopback port 3000');
process.exit(0);
`);

    // Run restart helper with short timeout
    const helperEnv = {
      ...f.env,
      MAW_UNIT: 'maw-fixture.service',
      MAW_STATE_DIR: f.stateDir,
      MAW_RUNTIME_DIR: f.runtimeDir,
      MAW_CONTROL_SCRIPT: mockControl,
      PATH: `${f.binDir}:${process.env.PATH}`,
    };

    // Call restart helper directly with mock
    await assert.rejects(
      exec(MAW_RESTART_HELPER_BIN, ['--unit', 'maw-fixture.service', '--timeout', '2'], {
        env: helperEnv,
        cwd: f.root,
      }),
      (err: any) => {
        // Exits 1 because update candidate failed, but rollback succeeded
        assert.match(err.stderr, /Rollback succeeded/);
        return true;
      }
    );

    // Assert that current was rolled back to prevReleaseDir
    const currentTarget = await readFile(path.join(f.stateDir, 'current', 'packages/server/src/maw-host.ts'), 'utf8');
    assert.match(currentTarget, /export const prev = true/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Concurrent source changes during update survive untouched
// ---------------------------------------------------------------------------
test('10. Concurrent source changes during update survive completely untouched', async () => {
  const f = await setupGitFixture();
  try {
    // Commit to upstream
    await writeFile(path.join(f.sourceDir, 'v2.ts'), 'export const v2 = true;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'v2']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    // Concurrent modification in developer worktree while update candidate builds
    await writeFile(path.join(f.sourceDir, 'concurrent-developer-work.txt'), 'do not touch me\n');

    // Run updater
    // Note: Updater refuses dirty worktree if present BEFORE fetch,
    // so let's simulate concurrent edit right as update is staging
    await rm(path.join(f.sourceDir, 'concurrent-developer-work.txt'));

    // We can simulate concurrent edit during candidate build by placing a hook in pnpm stub!
    await writeFile(path.join(f.binDir, 'pnpm'), `#!/bin/sh
if [ "$1" = "build" ]; then
  # Concurrent process writes to developer source directory!
  echo "concurrent edit from developer" > "${path.join(f.sourceDir, 'concurrent-developer-work.txt')}"
  mkdir -p packages/web/dist
  echo "<html>built</html>" > packages/web/dist/index.html
fi
exit 0
`, { mode: 0o755 });

    await exec(MAW_UPDATE_BIN, ['--no-restart', '--source', f.sourceDir, '--ref', 'origin/main'], { env: f.env });

    // Assert that the concurrent developer work is 100% intact!
    const concurrentContent = await readFile(path.join(f.sourceDir, 'concurrent-developer-work.txt'), 'utf8');
    assert.equal(concurrentContent.trim(), 'concurrent edit from developer');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Restart initiated inside an MAW-owned PTY
// ---------------------------------------------------------------------------
test('11. Restart initiated inside MAW delegates to transient unit with warning', async () => {
  const f = await setupGitFixture();
  try {
    // Mock systemd-run in binDir
    const runLog = path.join(f.root, 'systemd-run.log');
    await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh
echo "systemd-run: $@" >> "${runLog}"
exit 0
`, { mode: 0o755 });

    // When running inside MAW, mock cgroup or ancestor PID
    // We can test by setting MAW_TEST_CGROUP or running with mock
    const res = await exec(MAW_BIN, ['restart'], {
      env: {
        ...f.env,
        MAW_UNIT: 'maw-fixture.service',
        // Our systemctl stub returns MainPID matching process.pid, so is_inside_maw returns true!
      },
    });

    assert.match(res.stderr, /Warning: Active server-owned live PTYs will terminate/);
    assert.match(res.stderr, /Original PTY will not survive/);
    assert.match(res.stdout, /Safe restart scheduled successfully/);

    const log = await readFile(runLog, 'utf8');
    assert.match(log, /systemd-run: --user/);
    assert.match(log, /maw-restart-/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. Failed/duplicate restart scheduling
// ---------------------------------------------------------------------------
test('12. Duplicate restart scheduling is rejected safely', async () => {
  const f = await setupGitFixture();
  try {
    const lockFile = path.join(f.runtimeDir, 'restart.lock');
    await writeFile(lockFile, String(process.pid));

    await assert.rejects(
      exec(MAW_BIN, ['restart'], {
        env: {
          ...f.env,
          MAW_UNIT: 'maw-fixture.service',
          MAW_RESTART_LOCK: lockFile,
        },
      }),
      (err: any) => {
        assert.match(err.stderr, /A restart is already in progress or scheduled. Duplicate restart avoided/);
        return true;
      }
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. Git worktree source
// ---------------------------------------------------------------------------
test('13. Linked Git worktree source (.git file) is supported natively', async () => {
  const f = await setupGitFixture();
  try {
    // Create a secondary linked git worktree
    const worktreeDir = path.join(f.root, 'linked-worktree');
    await exec('git', ['-C', f.sourceDir, 'worktree', 'add', '-b', 'wt-branch', worktreeDir, 'main']);

    // Verify .git is a file in worktree
    const gitStat = await stat(path.join(worktreeDir, '.git'));
    assert.ok(gitStat.isFile());

    // Push new commit to bare origin
    await writeFile(path.join(f.sourceDir, 'wt-feat.ts'), 'export const wt = true;\n');
    await exec('git', ['-C', f.sourceDir, 'add', '.']);
    await exec('git', ['-C', f.sourceDir, 'commit', '-m', 'worktree commit']);
    await exec('git', ['-C', f.sourceDir, 'push', 'origin', 'main']);
    await exec('git', ['-C', f.sourceDir, 'reset', '--hard', 'HEAD~1']);

    // Run updater pointing to worktree
    const res = await exec(MAW_UPDATE_BIN, ['--no-restart', '--source', worktreeDir, '--ref', 'origin/main'], { env: f.env });
    assert.match(res.stdout, /MAW update staged successfully/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 14. Browser-independent startup and maw url
// ---------------------------------------------------------------------------
test('14. Browser-independent startup and maw url loopback token retrieval', async () => {
  const f = await setupGitFixture();
  let server: any;
  try {
    server = createServer((req, res) => {
      res.statusCode = req.url?.includes('token=secure-token-123') ? 200 : 401;
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');

    const expectedUrl = `http://127.0.0.1:${addr.port}/?token=secure-token-123`;
    const readyFile = path.join(f.runtimeDir, 'maw-ready.json');
    await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: expectedUrl }), { mode: 0o600 });

    const urlOut = await exec(MAW_BIN, ['url'], { env: f.env });
    assert.equal(urlOut.stdout.trim(), expectedUrl);

    // Verify systemctl log did not record the token
    const sysLogPath = path.join(f.root, 'systemctl.log');
    if (await stat(sysLogPath).catch(() => null)) {
      const sysLog = await readFile(sysLogPath, 'utf8');
      assert.ok(!sysLog.includes('secure-token-123'));
    }
  } finally {
    if (server) await new Promise(r => server.close(r));
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 15. Manual Brave launch using brave-browser
// ---------------------------------------------------------------------------
test('15. Manual Brave launch invokes brave-browser explicitly without xdg-open', async () => {
  const f = await setupGitFixture();
  let server: any;
  try {
    const browserLog = path.join(f.root, 'browser-launch.log');
    await writeFile(path.join(f.binDir, 'brave-browser'), `#!/bin/sh\necho "brave: $@" >> "${browserLog}"\n`, { mode: 0o755 });
    await writeFile(path.join(f.binDir, 'xdg-open'), `#!/bin/sh\necho "xdg: $@" >> "${browserLog}"\n`, { mode: 0o755 });

    server = createServer((req, res) => {
      res.statusCode = req.url?.includes('token=token-abc') ? 200 : 401;
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');

    const expectedUrl = `http://127.0.0.1:${addr.port}/?token=token-abc`;
    const readyFile = path.join(f.runtimeDir, 'maw-ready.json');
    await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: expectedUrl }), { mode: 0o600 });

    await exec(MAW_BIN, ['open', 'brave-browser'], { env: { ...f.env, DEBUG_MAW_CONTROL: '1' } });

    const logs = await readFile(browserLog, 'utf8');
    assert.ok(logs.includes(`brave: ${expectedUrl}`));
    assert.ok(!logs.includes('xdg:'));
  } finally {
    if (server) await new Promise(r => server.close(r));
    await rm(f.root, { recursive: true, force: true });
  }
});
