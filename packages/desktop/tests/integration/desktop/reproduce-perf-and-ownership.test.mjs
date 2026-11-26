import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ResourceCollector,
  calculateProcessCpuDelta,
  buildProcessTree,
  collectSubtreePids,
  classifyProcessProvider,
} from '../../../src/performance/resource-monitor.mjs';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const here = DESKTOP_ROOT;

// Helper to create synthetic /proc structure
function createMockProc(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });

  const writePid = (pid, ppid, comm, cmdline, exeTarget, utime = 100, stime = 50, starttime = 1000, pssKb = 10240, rssKb = 20480) => {
    const pidDir = path.join(baseDir, String(pid));
    fs.mkdirSync(pidDir, { recursive: true });

    // /proc/[pid]/stat
    const statContent = `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 0 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${starttime} 100000 1000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
    fs.writeFileSync(path.join(pidDir, 'stat'), statContent);

    // /proc/[pid]/status
    const statusContent = `Name:\t${comm}\nPid:\t${pid}\nPPid:\t${ppid}\nVmRSS:\t${rssKb} kB\nVmSize:\t${rssKb * 2} kB\n`;
    fs.writeFileSync(path.join(pidDir, 'status'), statusContent);

    // /proc/[pid]/smaps_rollup
    const smapsContent = `00400000-00452000 r-xp 00000000 08:02 12345 /usr/bin/${comm}\n` +
      `Rss:                ${rssKb} kB\n` +
      `Pss:                ${pssKb} kB\n` +
      `Pss_Dirty:             0 kB\n` +
      `Private_Clean:      ${Math.round(pssKb * 0.8)} kB\n` +
      `Private_Dirty:      ${Math.round(pssKb * 0.2)} kB\n` +
      `Shared_Clean:       ${rssKb - pssKb} kB\n` +
      `Shared_Dirty:          0 kB\n` +
      `Referenced:         ${rssKb} kB\n` +
      `Anonymous:             0 kB\n` +
      `LazyFree:              0 kB\n` +
      `AnonHugePages:         0 kB\n` +
      `ShmemPmdMapped:        0 kB\n` +
      `FilePmdMapped:         0 kB\n` +
      `Shared_Hugetlb:        0 kB\n` +
      `Private_Hugetlb:       0 kB\n` +
      `Swap:                  0 kB\n` +
      `SwapPss:               0 kB\n` +
      `Locked:                0 kB\n`;
    fs.writeFileSync(path.join(pidDir, 'smaps_rollup'), smapsContent);

    // /proc/[pid]/cmdline
    fs.writeFileSync(path.join(pidDir, 'cmdline'), cmdline.replace(/ /g, '\0') + '\0');

    // /proc/[pid]/exe (symlink)
    if (exeTarget) {
      const exePath = path.join(pidDir, 'exe');
      try { fs.unlinkSync(exePath); } catch {}
      try {
        fs.symlinkSync(exeTarget, exePath);
      } catch {
        fs.writeFileSync(exePath, exeTarget);
      }
    }
  };

  return { writePid };
}

// ---------------------------------------------------------------------------
// 1. Process Ownership Tests
// ---------------------------------------------------------------------------
test('ownership: multiple Codex sessions are independently tracked without cross-talk', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-codex-multi-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // Session 1: Terminal root 101 -> Codex 102 -> Compiler child 103
    writePid(101, 1, 'zsh', 'zsh', '/usr/bin/zsh', 50, 20, 1000, 5000, 10000);
    writePid(102, 101, 'codex', 'codex exec task1', '/opt/codex/bin/codex', 150, 80, 1005, 40000, 60000);
    writePid(103, 102, 'python3', 'python3 -m py_compile', '/usr/bin/python3', 80, 30, 1010, 25000, 35000);

    // Session 2: Terminal root 201 -> Codex 202
    writePid(201, 1, 'bash', 'bash', '/usr/bin/bash', 40, 15, 1000, 4500, 9000);
    writePid(202, 201, 'codex', 'codex exec task2', '/opt/codex/bin/codex', 200, 90, 1020, 45000, 65000);

    const collector = new ResourceCollector({
      procRoot: tmpProc,
      getBackendReadiness: async () => ({
        pid: 9999,
        url: new URL('http://127.0.0.1:4000/?token=test'),
      }),
    });

    // Inject mock backend terminals by overriding fetch
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [
          { terminalId: 'term-codex-1', title: 'Codex 1', pid: 101, kind: 'agent', provider: 'codex' },
          { terminalId: 'term-codex-2', title: 'Codex 2', pid: 201, kind: 'agent', provider: 'codex' },
        ],
        supervisorPid: 500,
      }),
    });

    try {
      const snap = await collector.sample();

      assert.equal(snap.aiAgents.groups.length, 1);
      const codexGroup = snap.aiAgents.groups[0];
      assert.equal(codexGroup.provider, 'codex');
      assert.equal(codexGroup.instanceCount, 2);

      // Verify Session 1 captured root 101 + codex 102 + compiler 103
      const inst1 = codexGroup.instances.find((i) => i.terminalId === 'term-codex-1');
      assert.ok(inst1);
      assert.deepEqual(inst1.pids.sort(), [101, 102, 103]);
      assert.equal(inst1.processes.length, 3);
      assert.equal(inst1.pssBytes, (5000 + 40000 + 25000) * 1024);

      // Verify Session 2 captured root 201 + codex 202
      const inst2 = codexGroup.instances.find((i) => i.terminalId === 'term-codex-2');
      assert.ok(inst2);
      assert.deepEqual(inst2.pids.sort(), [201, 202]);
      assert.equal(inst2.processes.length, 2);
      assert.equal(inst2.pssBytes, (4500 + 45000) * 1024);

      // Verify total Codex group PSS equals sum of both sessions without overlap
      assert.equal(codexGroup.totalPssBytes, inst1.pssBytes + inst2.pssBytes);
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test('ownership: multiple simultaneous AI providers (Codex, Claude, Gemini) are segregated', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-prov-multi-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // Terminal 1: Codex
    writePid(301, 1, 'zsh', 'zsh', '/usr/bin/zsh', 10, 5, 1000, 4000, 8000);
    writePid(302, 301, 'codex', 'codex exec', '/usr/bin/codex', 100, 50, 1005, 30000, 50000);

    // Terminal 2: Claude Code
    writePid(401, 1, 'bash', 'bash', '/usr/bin/bash', 10, 5, 1000, 4000, 8000);
    writePid(402, 401, 'node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.js', '/usr/bin/node', 120, 60, 1005, 35000, 55000);

    // Terminal 3: Plain Zsh terminal
    writePid(501, 1, 'zsh', 'zsh', '/usr/bin/zsh', 10, 5, 1000, 4000, 8000);

    const collector = new ResourceCollector({ procRoot: tmpProc });

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [
          { terminalId: 't-codex', title: 'Codex Term', pid: 301, kind: 'agent', provider: 'codex' },
          { terminalId: 't-claude', title: 'Claude Term', pid: 401, kind: 'agent', provider: 'claude' },
          { terminalId: 't-shell', title: 'Shell Term', pid: 501, kind: 'shell', provider: null },
        ],
        supervisorPid: 500,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9999, url: new URL('http://127.0.0.1:4000/?token=x') });
      const snap = await collector.sample();

      // Check providers
      const providers = snap.aiAgents.groups.map((g) => g.provider).sort();
      assert.deepEqual(providers, ['claude-code', 'codex']);
      assert.equal(snap.aiAgents.activeCount, 2);

      // Check plain shell went to otherTerminals
      assert.equal(snap.otherTerminals.count, 1);
      assert.equal(snap.otherTerminals.terminals[0].terminalId, 't-shell');
      assert.equal(snap.otherTerminals.terminals[0].rootPid, 501);
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test('ownership: external AI processes not launched by MAW are NEVER attributed to MAW', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-external-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // MAW Terminal: Plain bash running standard command
    writePid(601, 1, 'bash', 'bash', '/usr/bin/bash', 10, 5, 1000, 4000, 8000);
    writePid(602, 601, 'ls', 'ls -la', '/usr/bin/ls', 5, 2, 1005, 1000, 2000);

    // EXTERNAL processes running on the machine (e.g. user running codex and claude in GNOME terminal or tmux)
    writePid(701, 1, 'gnome-terminal', 'gnome-terminal-server', '/usr/bin/gnome-terminal-server', 50, 20, 500, 25000, 40000);
    writePid(702, 701, 'zsh', 'zsh', '/usr/bin/zsh', 20, 10, 505, 5000, 10000);
    writePid(703, 702, 'codex', 'codex exec external-task', '/usr/bin/codex', 500, 200, 510, 90000, 120000);
    writePid(704, 702, 'claude', 'claude code external', '/usr/bin/claude', 400, 150, 515, 80000, 110000);

    const collector = new ResourceCollector({ procRoot: tmpProc });

    const origFetch = global.fetch;
    // MAW server reports only MAW terminal 601
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [
          { terminalId: 'maw-term-1', title: 'Terminal 1', pid: 601, kind: 'shell', provider: null },
        ],
        supervisorPid: 500,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9999, url: new URL('http://127.0.0.1:4000/?token=x') });
      const snap = await collector.sample();

      // Zero AI agents in MAW
      assert.equal(snap.aiAgents.groups.length, 0);
      assert.equal(snap.aiAgents.activeCount, 0);

      // Only MAW terminal 601 is in otherTerminals
      assert.equal(snap.otherTerminals.count, 1);
      assert.deepEqual(snap.otherTerminals.terminals[0].pids.sort(), [601, 602]);

      // Verify external PIDs 701, 702, 703, 704 were completely ignored
      const allReportedPids = new Set([
        ...snap.infrastructure.processes.map((p) => p.pid),
        ...snap.otherTerminals.terminals.flatMap((t) => t.pids),
        ...snap.aiAgents.groups.flatMap((g) => g.instances.flatMap((i) => i.pids)),
      ]);
      assert.ok(!allReportedPids.has(701), 'External gnome-terminal must not be claimed');
      assert.ok(!allReportedPids.has(702), 'External zsh must not be claimed');
      assert.ok(!allReportedPids.has(703), 'External codex must not be claimed');
      assert.ok(!allReportedPids.has(704), 'External claude must not be claimed');
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Shared Browser Renderer Tests
// ---------------------------------------------------------------------------
test('shared browser: proportionally divides memory/CPU and counts renderer aggregate once', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-shared-render-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // Shared Chromium renderer PID 888: 90 MB PSS, 120 MB RSS
    writePid(888, 1, 'chrome-renderer', 'chromium --type=renderer', '/usr/bin/chromium', 300, 150, 1000, 90000, 120000);

    // Independent Chromium renderer PID 999: 50 MB PSS, 70 MB RSS
    writePid(999, 1, 'chrome-renderer', 'chromium --type=renderer', '/usr/bin/chromium', 100, 50, 1000, 50000, 70000);

    const mockViews = new Map();
    const mockProviders = new Map();
    const mockUrls = new Map();
    const mockAttached = new Map();

    // 3 tabs share renderer PID 888
    for (const tabId of ['chatgpt-tab-1', 'chatgpt-tab-2', 'chatgpt-tab-3']) {
      const v = { webContents: { getOSProcessId: () => 888, isDestroyed: () => false } };
      mockViews.set(tabId, v);
      mockProviders.set(tabId, 'chatgpt');
      mockUrls.set(tabId, 'https://chatgpt.com/');
      if (tabId === 'chatgpt-tab-1') mockAttached.set(tabId, v);
    }

    // 1 tab on independent renderer PID 999
    const v2 = { webContents: { getOSProcessId: () => 999, isDestroyed: () => false } };
    mockViews.set('perplexity-tab-1', v2);
    mockProviders.set('perplexity-tab-1', 'perplexity');
    mockUrls.set('perplexity-tab-1', 'https://perplexity.ai/');
    mockAttached.set('perplexity-tab-1', v2);

    const collector = new ResourceCollector({
      procRoot: tmpProc,
      views: mockViews,
      providers: mockProviders,
      urls: mockUrls,
      attachedViews: mockAttached,
    });

    const snap = await collector.sample();

    assert.equal(snap.browserViews.totalCount, 4);

    // Verify 3 tabs are marked as isSharedRenderer
    const sharedTabs = snap.browserViews.views.filter((v) => v.rendererPid === 888);
    assert.equal(sharedTabs.length, 3);
    for (const tab of sharedTabs) {
      assert.equal(tab.isSharedRenderer, true);
      assert.equal(tab.sharedTabCount, 3);
      // Divided equally: 90000 kB / 3 = 30000 kB = 30720000 bytes
      assert.equal(tab.pssBytes, Math.round((90000 * 1024) / 3));
    }

    // Verify independent tab
    const indepTab = snap.browserViews.views.find((v) => v.rendererPid === 999);
    assert.ok(indepTab);
    assert.equal(indepTab.isSharedRenderer, false);
    assert.equal(indepTab.sharedTabCount, 1);
    assert.equal(indepTab.pssBytes, 50000 * 1024);

    // Verify total browser views aggregate PSS counts renderer 888 once (90MB) + renderer 999 once (50MB) = 140MB
    const expectedTotalPss = (90000 + 50000) * 1024;
    assert.equal(snap.browserViews.totalPssBytes, expectedTotalPss);

    collector.dispose();
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Performance & Overhead Reproduction Tests
// ---------------------------------------------------------------------------
test('overhead: reproduces monitoring overhead and measures latency distribution under load', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-bench-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // Create 10 concurrent terminals with child processes (25 total processes)
    const mockTerminals = [];
    for (let t = 1; t <= 10; t++) {
      const rootPid = 1000 + t * 10;
      const childPid = rootPid + 1;
      writePid(rootPid, 1, 'zsh', 'zsh', '/usr/bin/zsh', 20, 10, 1000, 6000, 12000);
      writePid(childPid, rootPid, t <= 4 ? 'codex' : 'node', t <= 4 ? 'codex exec' : 'node app.js', t <= 4 ? '/usr/bin/codex' : '/usr/bin/node', 80, 40, 1005, 30000, 50000);
      mockTerminals.push({
        terminalId: `term-${t}`,
        title: `Terminal ${t}`,
        pid: rootPid,
        kind: t <= 4 ? 'agent' : 'shell',
        provider: t <= 4 ? 'codex' : null,
      });
    }

    // Infrastructure processes
    writePid(9001, 1, 'electron', 'workbench-desktop', '/opt/maw/electron', 100, 50, 1000, 80000, 120000);
    writePid(9002, 9001, 'electron-gpu', 'workbench-desktop --type=gpu-process', '/opt/maw/electron', 50, 20, 1000, 40000, 70000);

    const collector = new ResourceCollector({
      procRoot: tmpProc,
      intervalMs: 2000,
    });

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: mockTerminals,
        supervisorPid: 500,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9001, url: new URL('http://127.0.0.1:4000/?token=x') });

      // Run initial sample to prime CPU state
      await collector.sample();

      // Measure 50 consecutive collections
      const latencies = [];
      const memBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < 50; i++) {
        const t0 = process.hrtime.bigint();
        const snap = await collector.sample();
        const t1 = process.hrtime.bigint();
        const durationMs = Number(t1 - t0) / 1e6;
        latencies.push(durationMs);
        assert.ok(snap.sampleDurationMs > 0);
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memGrowthBytes = memAfter - memBefore;

      latencies.sort((a, b) => a - b);
      const minLatency = latencies[0];
      const maxLatency = latencies[latencies.length - 1];
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const p95Latency = latencies[Math.floor(latencies.length * 0.95)];

      // Active sampling CPU calculation at 2s interval
      // Duty cycle = avgLatency / 2000ms
      const coreDutyCyclePercent = (avgLatency / 2000) * 100;

      console.log(`[Perf Benchmark Results]`);
      console.log(`  Samples collected: ${latencies.length}`);
      console.log(`  Min latency:       ${minLatency.toFixed(2)} ms`);
      console.log(`  Avg latency:       ${avgLatency.toFixed(2)} ms`);
      console.log(`  P95 latency:       ${p95Latency.toFixed(2)} ms`);
      console.log(`  Max latency:       ${maxLatency.toFixed(2)} ms`);
      console.log(`  Core CPU overhead: ${coreDutyCyclePercent.toFixed(3)}% of 1 core (at 2s interval)`);
      console.log(`  Heap delta (50x):  ${(memGrowthBytes / 1024).toFixed(1)} KiB`);

      // Rigorous assertions
      assert.ok(avgLatency < 20, `Average collection latency (${avgLatency.toFixed(2)}ms) must be under 20ms`);
      assert.ok(coreDutyCyclePercent < 1.0, `Active CPU overhead (${coreDutyCyclePercent.toFixed(3)}%) must be under 1% of 1 core`);
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test('ownership: wrapper script and nested process tree classification', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-wrapper-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    // Root shell (PID 100) -> Bash wrapper script (PID 101) -> Codex CLI (PID 102) -> Language Server (PID 103)
    writePid(100, 1, 'zsh', 'zsh', '/usr/bin/zsh', 10, 5, 1000, 4000, 8000);
    writePid(101, 100, 'bash', 'bash run-agent.sh', '/usr/bin/bash', 15, 8, 1002, 5000, 9000);
    writePid(102, 101, 'codex', 'codex exec', '/opt/codex/bin/codex', 200, 100, 1005, 50000, 75000);
    writePid(103, 102, 'node', 'node /opt/codex/lsp/server.js', '/usr/bin/node', 80, 40, 1010, 35000, 50000);

    const collector = new ResourceCollector({ procRoot: tmpProc });

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [
          { terminalId: 'term-wrapped-codex', title: 'Wrapped Codex', pid: 100, kind: 'shell', provider: null },
        ],
        supervisorPid: 500,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9999, url: new URL('http://127.0.0.1:4000/?token=x') });
      const snap = await collector.sample();

      // Because codex exists in the descendant tree, the whole terminal is dynamically classified as Codex
      assert.equal(snap.aiAgents.groups.length, 1);
      assert.equal(snap.aiAgents.groups[0].provider, 'codex');
      const inst = snap.aiAgents.groups[0].instances[0];
      assert.deepEqual(inst.pids.sort(), [100, 101, 102, 103]);
      assert.equal(inst.processes.length, 4);

      // Verify all 4 process PSS are summed
      const expectedPss = (4000 + 5000 + 50000 + 35000) * 1024;
      assert.equal(inst.pssBytes, expectedPss);
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test('lifecycle: child process termination prunes dead PIDs from CPU state without leaking memory', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-term-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    writePid(200, 1, 'zsh', 'zsh', '/usr/bin/zsh', 10, 5, 1000, 4000, 8000);
    writePid(201, 200, 'codex', 'codex exec', '/opt/codex/bin/codex', 50, 20, 1002, 30000, 50000);
    writePid(202, 201, 'python3', 'python3 worker.py', '/usr/bin/python3', 40, 20, 1005, 20000, 30000);

    const collector = new ResourceCollector({ procRoot: tmpProc });

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [
          { terminalId: 'term-agent', title: 'Agent', pid: 200, kind: 'agent', provider: 'codex' },
        ],
        supervisorPid: 500,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9999, url: new URL('http://127.0.0.1:4000/?token=x') });

      // First sample: 3 active PIDs (200, 201, 202)
      const snap1 = await collector.sample();
      assert.equal(snap1.aiAgents.groups[0].instances[0].processes.length, 3);
      assert.ok(collector.lastProcessCpu.has(202));

      // Simulate child process 202 terminating
      fs.rmSync(path.join(tmpProc, '202'), { recursive: true, force: true });

      // Second sample: 202 should be pruned from lastProcessCpu map
      const snap2 = await collector.sample();
      assert.equal(snap2.aiAgents.groups[0].instances[0].processes.length, 2);
      assert.ok(!collector.lastProcessCpu.has(202), 'Terminated PID 202 must be deleted from lastProcessCpu');
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test('lifecycle: PTY supervisor restart updates supervisor PID and cleans up old supervisor tracking', async () => {
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-proc-supervisor-'));
  try {
    const { writePid } = createMockProc(tmpProc);

    writePid(9999, 1, 'node', 'node backend.js', '/usr/bin/node', 10, 5, 1000, 20000, 40000);
    writePid(500, 1, 'workbench-ptyd', 'workbench-ptyd', '/usr/bin/node', 10, 5, 1000, 15000, 30000);

    let currentSupervisorPid = 500;
    const collector = new ResourceCollector({ procRoot: tmpProc });

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        terminals: [],
        supervisorPid: currentSupervisorPid,
      }),
    });

    try {
      collector.getBackendReadiness = async () => ({ pid: 9999, url: new URL('http://127.0.0.1:4000/?token=x') });

      const snap1 = await collector.sample();
      assert.equal(snap1.global.supervisorHealth.status, 'healthy');
      assert.equal(snap1.global.supervisorHealth.pid, 500);

      // Simulate supervisor crash/restart: old supervisor PID 500 dies, new supervisor PID 600 starts
      fs.rmSync(path.join(tmpProc, '500'), { recursive: true, force: true });
      writePid(600, 1, 'workbench-ptyd', 'workbench-ptyd', '/usr/bin/node', 12, 6, 2000, 16000, 32000);
      currentSupervisorPid = 600;

      const snap2 = await collector.sample();
      assert.equal(snap2.global.supervisorHealth.status, 'healthy');
      assert.equal(snap2.global.supervisorHealth.pid, 600);
      assert.ok(!collector.lastProcessCpu.has(500), 'Old supervisor PID 500 must be pruned');
    } finally {
      global.fetch = origFetch;
      collector.dispose();
    }
  } finally {
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});
