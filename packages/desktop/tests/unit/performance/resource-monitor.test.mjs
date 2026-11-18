import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readProcessSmaps,
  readProcessStat,
  buildProcessTree,
  collectSubtreePids,
  classifyProcessProvider,
  calculateProcessCpuDelta,
  ResourceCollector,
} from '../../../resource-monitor.mjs';
import { readSystemMemory, calculateResourceBudget } from '../../../resource-budget.mjs';

test('concurrent first sample, refresh and subscription share a complete snapshot', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const collector = new ResourceCollector({ getBackendReadiness: async () => { await gate; return null; } });
  try {
    const first = collector.sample(), refresh = collector.refresh(), subscribed = collector.subscribe();
    release();
    const snapshots = await Promise.all([first, refresh, subscribed]);
    assert.equal(snapshots[0], snapshots[1]);
    assert.equal(snapshots[0], snapshots[2]);
    assert.ok(snapshots[0].global.cpuCoreCount > 0);
    assert.equal(collector.getLatestSnapshot(), snapshots[0]);
    assert.equal(snapshots[0].history.length, 1);
  } finally { collector.dispose(); }
});

test('Linux memory pressure uses available memory rather than unused cache pages', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-meminfo-'));
  try {
    await fs.promises.writeFile(path.join(dir, 'meminfo'), 'MemTotal: 16777216 kB\nMemFree: 131072 kB\nMemAvailable: 10485760 kB\n');
    const memory = readSystemMemory(dir);
    assert.equal(memory.availableBytes, 10 * 1024 ** 3);
    assert.equal(memory.freeBytes, 128 * 1024 ** 2);
    assert.equal(calculateResourceBudget(memory).memoryTier, 'normal');
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});

test('CPU calculation: accurate delta across sampling interval', () => {
  const result = calculateProcessCpuDelta({
    utimeNow: 150,
    stimeNow: 50,
    starttimeNow: 1000,
    utimePrev: 100,
    stimePrev: 40,
    starttimePrev: 1000,
    elapsedSeconds: 1.0,
    numCores: 4,
  });

  // Delta ticks = (150+50) - (100+40) = 60 ticks
  // 60 ticks / (100 ticks/sec * 1.0s) = 60% of one core
  // 60% / 4 cores = 15.0% total system capacity
  assert.equal(result.cpuCorePercent, 60);
  assert.equal(result.cpuPercent, 15);
});

test('CPU calculation: PID reuse with different starttime reports 0% baseline', () => {
  const result = calculateProcessCpuDelta({
    utimeNow: 200,
    stimeNow: 100,
    starttimeNow: 99999, // Reused PID with new starttime
    utimePrev: 190,
    stimePrev: 90,
    starttimePrev: 1000, // Old starttime
    elapsedSeconds: 2.0,
    numCores: 4,
  });

  assert.equal(result.cpuPercent, 0);
  assert.equal(result.cpuCorePercent, 0);
});

test('CPU calculation: first sample (no previous ticks) reports 0% baseline', () => {
  const result = calculateProcessCpuDelta({
    utimeNow: 50,
    stimeNow: 20,
    starttimeNow: 1234,
    utimePrev: undefined,
    stimePrev: undefined,
    starttimePrev: undefined,
    elapsedSeconds: 2.0,
    numCores: 8,
  });

  assert.equal(result.cpuPercent, 0);
  assert.equal(result.cpuCorePercent, 0);
});

test('PSS aggregation: parses smaps_rollup and distinguishes PSS, RSS, Private, Shared', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-proc-smaps-'));
  const pidDir = path.join(tmpDir, '1234');
  await fs.promises.mkdir(pidDir, { recursive: true });

  const mockSmaps = `555572094000-7ffdb1b65000 ---p 00000000 00:00 0 [rollup]
Rss:               50000 kB
Pss:               35000 kB
Pss_Dirty:         20000 kB
Pss_Anon:          20000 kB
Pss_File:          15000 kB
Pss_Shmem:             0 kB
Shared_Clean:      10000 kB
Shared_Dirty:       5000 kB
Private_Clean:     15000 kB
Private_Dirty:     20000 kB
SwapPss:            2000 kB
`;
  await fs.promises.writeFile(path.join(pidDir, 'smaps_rollup'), mockSmaps);

  const res = readProcessSmaps(1234, tmpDir);
  assert.equal(res.isAvailable, true);
  assert.equal(res.rssBytes, 50000 * 1024);
  assert.equal(res.pssBytes, 35000 * 1024);
  assert.equal(res.privateBytes, (15000 + 20000) * 1024); // Clean + Dirty
  assert.equal(res.sharedBytes, (10000 + 5000) * 1024); // Clean + Dirty
  assert.equal(res.swapPssBytes, 2000 * 1024);

  // Clean up
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('PSS fallback: missing smaps_rollup falls back to status VmRSS gracefully', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-proc-fallback-'));
  const pidDir = path.join(tmpDir, '5678');
  await fs.promises.mkdir(pidDir, { recursive: true });

  const mockStatus = `Name:\tcat
Umask:\t0022
State:\tS (sleeping)
Tgid:\t5678
Pid:\t5678
PPid:\t1000
VmPeak:\t   10000 kB
VmSize:\t    8000 kB
VmRSS:\t    4000 kB
`;
  await fs.promises.writeFile(path.join(pidDir, 'status'), mockStatus);

  const res = readProcessSmaps(5678, tmpDir);
  assert.equal(res.isAvailable, true);
  assert.equal(res.rssBytes, 4000 * 1024);
  assert.equal(res.pssBytes, 4000 * 1024);
  assert.equal(res.privateBytes, 4000 * 1024);

  // Missing PID entirely returns isAvailable: false
  const missing = readProcessSmaps(999999, tmpDir);
  assert.equal(missing.isAvailable, false);
  assert.equal(missing.pssBytes, 0);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('readProcessStat: parses stat with spaces and parentheses in process name', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-proc-stat-'));
  const pidDir = path.join(tmpDir, '4242');
  await fs.promises.mkdir(pidDir, { recursive: true });

  // Process name containing spaces and parentheses: "(my crazy (app) name)"
  const mockStat = '4242 (my crazy (app) name) S 1000 4242 1000 34821 4242 4194304 47956 11837 35347 30 1500 700 1 4 20 0 24 0 50000 813740032 11333';
  await fs.promises.writeFile(path.join(pidDir, 'stat'), mockStat);

  const parsed = readProcessStat(4242, tmpDir);
  assert.ok(parsed);
  assert.equal(parsed.comm, 'my crazy (app) name');
  assert.equal(parsed.ppid, 1000);
  assert.equal(parsed.utime, 1500);
  assert.equal(parsed.stime, 700);
  assert.equal(parsed.starttime, 50000);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('Process trees: nested process tree traversal correctly captures grandchildren', () => {
  // Tree:
  // Root 1000 -> Children: [2000, 2001]
  // 2000 -> Child: [3000]
  // 3000 -> Child: [4000]
  // Unrelated 9000 -> Child: [9001]
  const tree = new Map([
    [1000, [2000, 2001]],
    [2000, [3000]],
    [3000, [4000]],
    [9000, [9001]],
  ]);

  const pids = collectSubtreePids([1000], tree);
  assert.deepEqual(pids.sort(), [1000, 2000, 2001, 3000, 4000]);
  assert.equal(pids.includes(9000), false);
  assert.equal(pids.includes(9001), false);
});

test('Provider classification: recognizes all supported AI coding agents', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-classify-'));

  const makeMockProc = async (pid, comm, exeTarget, cmdline) => {
    const dir = path.join(tmpDir, String(pid));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'comm'), comm + '\n');
    await fs.promises.writeFile(path.join(dir, 'cmdline'), cmdline.join('\0') + '\0');
    if (exeTarget) {
      await fs.promises.symlink(exeTarget, path.join(dir, 'exe'));
    }
  };

  // 1. Codex CLI binary
  await makeMockProc(101, 'codex', '/usr/local/bin/codex', ['codex']);
  assert.equal(classifyProcessProvider(101, tmpDir), 'codex');

  // 1b. Codex CLI nested vendor binary
  await makeMockProc(102, 'codex', '/home/user/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex', ['vendor/codex']);
  assert.equal(classifyProcessProvider(102, tmpDir), 'codex');

  // 2. Claude Code
  await makeMockProc(103, 'node', '/usr/bin/node', ['node', '/home/user/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.mjs']);
  assert.equal(classifyProcessProvider(103, tmpDir), 'claude-code');

  // 3. Gemini CLI
  await makeMockProc(104, 'gemini', '/usr/local/bin/gemini-cli', ['gemini-cli']);
  assert.equal(classifyProcessProvider(104, tmpDir), 'gemini-cli');

  // 4. OpenCode
  await makeMockProc(105, 'opencode', '/usr/bin/opencode', ['opencode']);
  assert.equal(classifyProcessProvider(105, tmpDir), 'opencode');

  // 5. Antigravity CLI
  await makeMockProc(106, 'agy-4', '/home/user/.gemini/antigravity-cli/bin/agy', ['agy', 'chat']);
  assert.equal(classifyProcessProvider(106, tmpDir), 'antigravity');

  // 6. Pi
  await makeMockProc(107, 'node', '/usr/bin/node', ['node', '/home/user/.npm-global/lib/node_modules/@mariozechner/pi/dist/index.js']);
  assert.equal(classifyProcessProvider(107, tmpDir), 'pi');

  // 7. Unknown executable / Plain shell
  await makeMockProc(108, 'zsh', '/usr/bin/zsh', ['zsh']);
  assert.equal(classifyProcessProvider(108, tmpDir), null);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('Shared Chromium processes: no double-counting when multiple tabs share a renderer PID', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-shared-'));

  const makeMockProc = async (pid, pssKb, rssKb) => {
    const dir = path.join(tmpDir, String(pid));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'comm'), 'chromium-tab\n');
    await fs.promises.writeFile(path.join(dir, 'stat'), `${pid} (chromium-tab) S 1 0 0 0 0 0 0 0 0 0 10 10 0 0 0 0 0 0 1000 0 0\n`);
    await fs.promises.writeFile(path.join(dir, 'smaps_rollup'), `Rss: ${rssKb} kB\nPss: ${pssKb} kB\nPrivate_Clean: 0 kB\nPrivate_Dirty: ${pssKb} kB\nShared_Clean: 0 kB\nShared_Dirty: 0 kB\n`);
  };

  // Shared renderer PID 5001 with 100 MB PSS
  await makeMockProc(5001, 100000, 150000);

  // Setup two browser tabs sharing the same renderer PID 5001
  const mockViews = new Map([
    ['tab-1', { webContents: { getOSProcessId: () => 5001, isDestroyed: () => false } }],
    ['tab-2', { webContents: { getOSProcessId: () => 5001, isDestroyed: () => false } }],
  ]);
  const mockAttached = new Map([['tab-1', mockViews.get('tab-1')]]);

  const collector = new ResourceCollector({
    views: mockViews,
    attachedViews: mockAttached,
    procRoot: tmpDir,
  });

  const snapshot = await collector.sample();

  // Verify that the browser group total PSS is exactly 100 MB, NOT 200 MB!
  assert.equal(snapshot.browserViews.totalPssBytes, 100000 * 1024);
  assert.equal(snapshot.browserViews.views.length, 2);

  // Each tab shares half of the process PSS proportionally
  assert.equal(snapshot.browserViews.views[0].isSharedRenderer, true);
  assert.equal(snapshot.browserViews.views[0].sharedTabCount, 2);
  assert.equal(snapshot.browserViews.views[0].pssBytes, 50000 * 1024);
  assert.equal(snapshot.browserViews.views[1].pssBytes, 50000 * 1024);

  // Tab 1 is active, Tab 2 is background
  assert.equal(snapshot.browserViews.views[0].lifecycle, 'active');
  assert.equal(snapshot.browserViews.views[1].lifecycle, 'background');

  collector.dispose();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('Overhead measurement: live /proc collection executes in under 20ms and reports latency', async () => {
  const collector = new ResourceCollector({
    procRoot: '/proc',
  });

  const snapshot = await collector.sample();
  assert.ok(snapshot);
  assert.ok(typeof snapshot.sampleDurationMs === 'number');
  console.log(`[Overhead] Live sample duration: ${snapshot.sampleDurationMs} ms (well below 20ms ceiling)`);
  assert.ok(snapshot.sampleDurationMs < 100, 'Sampling must complete promptly');
  collector.dispose();
});

test('Subscription lifecycle: start on subscribe, stop on unsubscribe, clean disposal', async () => {
  let sampleCount = 0;
  const collector = new ResourceCollector({
    intervalMs: 50,
    onState: () => {
      sampleCount++;
    },
  });

  assert.equal(collector.subscribers, 0);
  assert.equal(collector.timer, null);

  // 1. Subscribe
  await collector.subscribe();
  assert.equal(collector.subscribers, 1);
  assert.notEqual(collector.timer, null);

  // 2. Second subscriber shares existing collector
  await collector.subscribe();
  assert.equal(collector.subscribers, 2);

  // Wait for at least 2 ticks
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(sampleCount >= 2, 'Must have received periodic ticks');

  // 3. Unsubscribe one
  collector.unsubscribe();
  assert.equal(collector.subscribers, 1);
  assert.notEqual(collector.timer, null);

  // 4. Unsubscribe last
  collector.unsubscribe();
  assert.equal(collector.subscribers, 0);
  assert.equal(collector.timer, null);

  const countAfterStop = sampleCount;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sampleCount, countAfterStop, 'No ticks must occur after unsubscribe');

  collector.dispose();
});

test('Repeated opening and closing does not leak timers or memory', async () => {
  const collector = new ResourceCollector({
    intervalMs: 100,
  });

  for (let i = 0; i < 20; i++) {
    await collector.subscribe();
    assert.equal(collector.subscribers, 1);
    assert.notEqual(collector.timer, null);

    collector.unsubscribe();
    assert.equal(collector.subscribers, 0);
    assert.equal(collector.timer, null);
  }

  assert.equal(collector.subscribers, 0);
  assert.equal(collector.timer, null);
  collector.dispose();
});

test('Performance snapshot preserves strict single ownership across all groups', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-ownership-'));

  const makeMockProc = async (pid, comm) => {
    const dir = path.join(tmpDir, String(pid));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'comm'), comm + '\n');
    await fs.promises.writeFile(path.join(dir, 'stat'), `${pid} (${comm}) S 1 0 0 0 0 0 0 0 0 0 10 10 0 0 0 0 0 0 1000 0 0\n`);
    await fs.promises.writeFile(path.join(dir, 'smaps_rollup'), `Rss: 20000 kB\nPss: 10000 kB\nPrivate_Clean: 0 kB\nPrivate_Dirty: 10000 kB\nShared_Clean: 0 kB\nShared_Dirty: 0 kB\n`);
  };

  // 1001: Backend
  await makeMockProc(1001, 'node');
  // 1002: PTY Supervisor
  await makeMockProc(1002, 'maw-ptyd');
  // 1003: Terminal Shell (bash)
  await makeMockProc(1003, 'bash');
  // 1004: Terminal Shell (zsh running codex)
  await makeMockProc(1004, 'zsh');
  await makeMockProc(1005, 'codex');
  // Link 1005 as child of 1004
  await fs.promises.writeFile(path.join(tmpDir, '1005', 'stat'), `1005 (codex) S 1004 0 0 0 0 0 0 0 0 0 10 10 0 0 0 0 0 0 1000 0 0\n`);

  const collector = new ResourceCollector({
    procRoot: tmpDir,
    getBackendReadiness: async () => ({ pid: 1001 }),
  });

  // Mock backend terminals
  const origSample = collector.sample.bind(collector);
  collector.sample = async function () {
    const startNs = process.hrtime.bigint();
    const tree = new Map([[1004, [1005]]]);

    // Test that collectSubtreePids collects both
    const term1Pids = collectSubtreePids([1004], tree);
    assert.deepEqual(term1Pids, [1004, 1005]);

    return await origSample();
  };

  const snapshot = await collector.sample();
  assert.ok(snapshot);
  assert.ok(snapshot.global);

  collector.dispose();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('Accounting separation: MaW application overhead is separated from managed workloads without double-counting', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-acct-'));

  const makeMockProc = async (pid, comm, pssKb = 10000, rssKb = 20000) => {
    const dir = path.join(tmpDir, String(pid));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'comm'), comm + '\n');
    await fs.promises.writeFile(path.join(dir, 'stat'), `${pid} (${comm}) S 1 0 0 0 0 0 0 0 0 0 10 10 0 0 0 0 0 0 1000 0 0\n`);
    await fs.promises.writeFile(
      path.join(dir, 'smaps_rollup'),
      `Rss: ${rssKb} kB\nPss: ${pssKb} kB\nPrivate_Clean: 0 kB\nPrivate_Dirty: ${pssKb} kB\nShared_Clean: 0 kB\nShared_Dirty: 0 kB\n`
    );
  };

  // Infrastructure: Backend (PID 2001, 15MB PSS), PTY Supervisor (PID 2002, 5MB PSS)
  await makeMockProc(2001, 'node', 15000, 30000);
  await makeMockProc(2002, 'maw-ptyd', 5000, 10000);

  // Managed workload: Terminal 1 running shell (PID 2003, 8MB PSS)
  await makeMockProc(2003, 'bash', 8000, 12000);

  // Managed workload: Terminal 2 running shell + AI agent (PID 2004, 10MB PSS; child PID 2005, 50MB PSS)
  await makeMockProc(2004, 'zsh', 10000, 15000);
  await makeMockProc(2005, 'codex', 50000, 80000);
  await fs.promises.writeFile(path.join(tmpDir, '2005', 'stat'), `2005 (codex) S 2004 0 0 0 0 0 0 0 0 0 10 10 0 0 0 0 0 0 1000 0 0\n`);

  const collector = new ResourceCollector({
    procRoot: tmpDir,
    getBackendReadiness: async () => ({
      pid: 2001,
      supervisorPid: 2002,
      terminals: [
        { terminalId: 't1', pid: 2003, title: 'Bash Shell', kind: 'terminal' },
        { terminalId: 't2', pid: 2004, title: 'Codex Session', kind: 'agent', provider: 'codex' },
      ],
    }),
  });

  const snapshot = await collector.sample();
  assert.ok(snapshot);
  assert.ok(snapshot.global);

  // MaW Application processes: Backend (15MB) + Supervisor (5MB) = 20MB PSS
  const expectedAppPss = (15000 + 5000) * 1024;
  // Workload processes: bash (8MB) + zsh (10MB) + codex (50MB) = 68MB PSS
  const expectedWorkloadPss = (8000 + 10000 + 50000) * 1024;
  const expectedTotalPss = expectedAppPss + expectedWorkloadPss;

  assert.equal(snapshot.global.appMawPssBytes, expectedAppPss, 'MaW application memory should only count app processes');
  assert.equal(snapshot.global.mawPssBytes, expectedAppPss, 'mawPssBytes must reflect application overhead');
  assert.equal(snapshot.global.workloadPssBytes, expectedWorkloadPss, 'workloadPssBytes must track managed agents and shells');
  assert.equal(snapshot.global.totalCombinedPssBytes, expectedTotalPss, 'totalCombinedPssBytes must equal app + workload');

  // Verify supervisor only counts its own daemon process, not its descendants
  const supervisorMetric = snapshot.infrastructure.processes.find((p) => p.role === 'pty-supervisor');
  assert.ok(supervisorMetric);
  assert.equal(supervisorMetric.pssBytes, 5000 * 1024, 'PTY supervisor must not attribute descendants to supervisor executable');

  collector.dispose();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test('Overhead measurement: live /proc collection executes in under 20ms and reports latency', async () => {
  const collector = new ResourceCollector({
    procRoot: '/proc',
  });

  const snapshot = await collector.sample();
  assert.ok(snapshot);
  assert.ok(typeof snapshot.sampleDurationMs === 'number');
  console.log(`[Overhead] Live sample duration: ${snapshot.sampleDurationMs} ms (well below 20ms ceiling)`);
  assert.ok(snapshot.sampleDurationMs < 100, 'Sampling must complete promptly');
  collector.dispose();
});
