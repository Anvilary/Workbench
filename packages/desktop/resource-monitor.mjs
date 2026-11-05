/**
 * Native Resource Performance Monitor for MAW Desktop
 *
 * Lightweight, accurate Linux process accounting and resource telemetry.
 * Attributions:
 *   - MAW Infrastructure (Electron Main, GPU, Utilities, UI Renderer, Backend, PTY Supervisor)
 *   - AI Coding Agents (Codex CLI, Claude Code, Gemini CLI, OpenCode, Antigravity CLI, Pi)
 *   - Embedded Browser Views (ChatGPT, Perplexity, GitHub WebContentsViews: active, background, suspended)
 *   - Other Terminals (plain shells, scripts, tests)
 *
 * Operating Principles:
 *   - Proportional Set Size (PSS) preference via /proc/[pid]/smaps_rollup
 *   - Never sums RSS as physical memory consumption
 *   - Strict single ownership: every process has at most one accounting owner
 *   - Sampled CPU deltas with PID reuse and clock variation handling
 *   - Starts sampling only when subscribed; stops cleanly when panel closes
 *   - Maintains bounded 60-second in-memory history (max 30 samples)
 *   - Zero credentials or environment exposure
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { calculateResourceBudget, MemoryPressureTier } from './resource-budget.mjs';

const CLK_TCK = 100; // Standard Linux jiffies per second
const MAX_HISTORY_POINTS = 30; // 30 points @ 2s = 60 seconds
const DEFAULT_INTERVAL_MS = 2000;

export const AGENT_PROVIDERS = [
  { id: 'codex', label: 'Codex CLI' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'antigravity', label: 'Antigravity CLI' },
  { id: 'pi', label: 'Pi' },
];

/**
 * Safely parse /proc/[pid]/smaps_rollup on Linux
 * Distinguishes PSS, RSS, Private (Clean+Dirty), and Shared (Clean+Dirty) memory.
 * Returns values in bytes.
 *
 * @param {number} pid
 * @param {string} [procRoot='/proc']
 * @returns {{ isAvailable: boolean, pssBytes: number, rssBytes: number, privateBytes: number, sharedBytes: number, swapPssBytes: number }}
 */
export function readProcessSmaps(pid, procRoot = '/proc') {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'smaps_rollup'), 'utf8');
    const get = (name) => {
      const match = raw.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'));
      return match ? parseInt(match[1], 10) * 1024 : 0;
    };
    const pss = get('Pss');
    const rss = get('Rss');
    const privClean = get('Private_Clean');
    const privDirty = get('Private_Dirty');
    const sharedClean = get('Shared_Clean');
    const sharedDirty = get('Shared_Dirty');
    const swapPss = get('SwapPss');

    return {
      isAvailable: true,
      pssBytes: pss,
      rssBytes: rss,
      privateBytes: privClean + privDirty,
      sharedBytes: sharedClean + sharedDirty,
      swapPssBytes: swapPss,
    };
  } catch {
    // Fallback to /proc/[pid]/status VmRSS if smaps_rollup is missing
    try {
      const statusRaw = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
      const getStatus = (name) => {
        const match = statusRaw.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'));
        return match ? parseInt(match[1], 10) * 1024 : 0;
      };
      const vmRss = getStatus('VmRSS');
      return {
        isAvailable: true,
        pssBytes: vmRss, // Best approximation when smaps_rollup is missing
        rssBytes: vmRss,
        privateBytes: vmRss,
        sharedBytes: 0,
        swapPssBytes: 0,
      };
    } catch {
      return {
        isAvailable: false,
        pssBytes: 0,
        rssBytes: 0,
        privateBytes: 0,
        sharedBytes: 0,
        swapPssBytes: 0,
      };
    }
  }
}

/**
 * Safely parse /proc/[pid]/stat on Linux for CPU ticks and starttime.
 * Handles process names with spaces and parentheses.
 *
 * @param {number} pid
 * @param {string} [procRoot='/proc']
 * @returns {{ isAvailable: boolean, utime: number, stime: number, starttime: number, ppid: number, comm: string } | null}
 */
export function readProcessStat(pid, procRoot = '/proc') {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const openParen = raw.indexOf('(');
    const closeParen = raw.lastIndexOf(')');
    if (openParen === -1 || closeParen === -1 || closeParen <= openParen) return null;

    const comm = raw.slice(openParen + 1, closeParen);
    const rest = raw.slice(closeParen + 2).trim().split(/\s+/);

    const ppid = parseInt(rest[1], 10);
    const utime = parseInt(rest[11], 10);
    const stime = parseInt(rest[12], 10);
    const starttime = parseInt(rest[19], 10);

    return {
      isAvailable: true,
      comm,
      ppid,
      utime,
      stime,
      starttime,
    };
  } catch {
    return null;
  }
}

/**
 * Builds process parent-child adjacency map by reading /proc on Linux.
 *
 * @param {string} [procRoot='/proc']
 * @returns {Map<number, number[]>} Map of parentPid -> childPids[]
 */
export function buildProcessTree(procRoot = '/proc') {
  const tree = new Map();
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return tree;
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    try {
      const stat = readProcessStat(pid, procRoot);
      if (!stat) continue;
      const ppid = stat.ppid;
      if (!tree.has(ppid)) tree.set(ppid, []);
      tree.get(ppid).push(pid);
    } catch {
      // Process exited during iteration
    }
  }

  return tree;
}

/**
 * Recursively collects all descendant PIDs for a set of root PIDs.
 *
 * @param {number[]} rootPids
 * @param {Map<number, number[]>} tree
 * @param {Set<number>} [alreadyClaimed=new Set()]
 * @returns {number[]} Array of unique descendant PIDs including roots
 */
export function collectSubtreePids(rootPids, tree, alreadyClaimed = new Set()) {
  const results = [];
  const queue = [...rootPids];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || alreadyClaimed.has(current)) continue;
    visited.add(current);
    results.push(current);

    const children = tree.get(current);
    if (children && children.length > 0) {
      for (const child of children) {
        if (!visited.has(child) && !alreadyClaimed.has(child)) {
          queue.push(child);
        }
      }
    }
  }

  return results;
}

/**
 * Inspects process executable and comm to classify AI coding agent provider.
 * Does NOT inspect or log arguments containing credentials.
 *
 * @param {number} pid
 * @param {string} [procRoot='/proc']
 * @returns {string | null} Provider id ('codex', 'claude-code', 'gemini-cli', 'opencode', 'antigravity', 'pi') or null
 */
export function classifyProcessProvider(pid, procRoot = '/proc') {
  const pidStr = String(pid);
  let exe = '';
  let comm = '';
  let cmdlineFirst = '';

  try {
    exe = fs.readlinkSync(path.join(procRoot, pidStr, 'exe')).toLowerCase();
  } catch {}

  try {
    comm = fs.readFileSync(path.join(procRoot, pidStr, 'comm'), 'utf8').trim().toLowerCase();
  } catch {}

  try {
    const rawCmd = fs.readFileSync(path.join(procRoot, pidStr, 'cmdline'), 'utf8');
    const parts = rawCmd.split('\0');
    cmdlineFirst = (parts[0] || '').toLowerCase() + ' ' + (parts[1] || '').toLowerCase();
  } catch {}

  const exeBase = path.basename(exe);

  // 1. Codex CLI
  if (
    comm === 'codex' ||
    exeBase === 'codex' ||
    exe.includes('/@openai/codex') ||
    exe.includes('/codex-linux') ||
    cmdlineFirst.includes('@openai/codex') ||
    cmdlineFirst.includes('/codex')
  ) {
    return 'codex';
  }

  // 2. Claude Code
  if (
    comm === 'claude' ||
    exeBase === 'claude' ||
    cmdlineFirst.includes('@anthropic-ai/claude-code') ||
    cmdlineFirst.includes('claude-code') ||
    cmdlineFirst.includes('/claude.js') ||
    cmdlineFirst.includes('/claude/cli.mjs')
  ) {
    return 'claude-code';
  }

  // 3. Gemini CLI
  if (
    comm === 'gemini' ||
    comm === 'gemini-cli' ||
    exeBase === 'gemini' ||
    exeBase === 'gemini-cli' ||
    cmdlineFirst.includes('@google/gemini-cli') ||
    cmdlineFirst.includes('gemini-cli')
  ) {
    return 'gemini-cli';
  }

  // 4. OpenCode
  if (comm === 'opencode' || exeBase === 'opencode' || cmdlineFirst.includes('opencode')) {
    return 'opencode';
  }

  // 5. Antigravity CLI (verifiable executable identity)
  if (
    comm === 'agy' ||
    /^agy(?:0[0-5])?$/.test(comm) ||
    comm === 'antigravity' ||
    exeBase === 'agy' ||
    exeBase === 'antigravity' ||
    exe.includes('/antigravity-cli') ||
    exe.includes('/.gemini/antigravity') ||
    cmdlineFirst.includes('antigravity-cli')
  ) {
    return 'antigravity';
  }

  // 6. Pi
  if (comm === 'pi' || exeBase === 'pi' || cmdlineFirst.includes('@mariozechner/pi') || cmdlineFirst.includes('/pi.js')) {
    return 'pi';
  }

  return null;
}

/**
 * Calculates CPU percentage usage based on sampled tick deltas.
 *
 * @param {object} params
 * @param {number} params.utimeNow
 * @param {number} params.stimeNow
 * @param {number} params.starttimeNow
 * @param {number} [params.utimePrev]
 * @param {number} [params.stimePrev]
 * @param {number} [params.starttimePrev]
 * @param {number} params.elapsedSeconds
 * @param {number} params.numCores
 * @returns {{ cpuPercent: number, cpuCorePercent: number }}
 */
export function calculateProcessCpuDelta({
  utimeNow,
  stimeNow,
  starttimeNow,
  utimePrev,
  stimePrev,
  starttimePrev,
  elapsedSeconds,
  numCores,
}) {
  // If first sample or PID was reused (different starttime), report 0% for baseline
  if (
    utimePrev === undefined ||
    stimePrev === undefined ||
    starttimePrev === undefined ||
    starttimePrev !== starttimeNow ||
    elapsedSeconds <= 0
  ) {
    return { cpuPercent: 0, cpuCorePercent: 0 };
  }

  const deltaTicks = (utimeNow + stimeNow) - (utimePrev + stimePrev);
  if (deltaTicks <= 0) return { cpuPercent: 0, cpuCorePercent: 0 };

  // Total CPU core percentage (0-100% per core)
  const cpuCorePercent = Math.max(0, (deltaTicks / (CLK_TCK * elapsedSeconds)) * 100);

  // Normalized to total system capacity (0-100% across all cores)
  const cpuPercent = Math.min(100, Math.max(0, cpuCorePercent / Math.max(1, numCores)));

  return {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    cpuCorePercent: Number(cpuCorePercent.toFixed(1)),
  };
}

/**
 * Primary Resource Collector for MAW Native Performance Monitor
 */
export class ResourceCollector {
  /**
   * @param {object} options
   * @param {object} [options.app] Electron app object
   * @param {object} [options.win] Electron BrowserWindow instance
   * @param {Map<string, object>} [options.views] Map of id -> WebContentsView
   * @param {Map<string, string>} [options.providers] Map of id -> provider string
   * @param {Map<string, string>} [options.urls] Map of id -> url string
   * @param {Map<string, object>} [options.attachedViews] Map of id -> WebContentsView
   * @param {Map<string, object>} [options.suspendedTabs] Map of id -> suspended record
   * @param {Function} [options.getBackendReadiness] Async function returning { url, pid }
   * @param {Function} [options.onState] Callback when new snapshot is sampled
   * @param {number} [options.intervalMs=2000] Sampling interval in ms
   * @param {string} [options.procRoot='/proc'] Linux /proc directory
   */
  constructor({
    app,
    win,
    views = new Map(),
    providers = new Map(),
    urls = new Map(),
    attachedViews = new Map(),
    suspendedTabs = new Map(),
    getBackendReadiness,
    onState,
    intervalMs = DEFAULT_INTERVAL_MS,
    procRoot = '/proc',
  } = {}) {
    this.app = app;
    this.win = win;
    this.views = views;
    this.providers = providers;
    this.urls = urls;
    this.attachedViews = attachedViews;
    this.suspendedTabs = suspendedTabs;
    this.getBackendReadiness = getBackendReadiness;
    this.onState = onState;
    this.intervalMs = intervalMs;
    this.procRoot = procRoot;

    this.subscribers = 0;
    this.timer = null;
    this.isPaused = false;
    this.isSampling = false;

    // Previous CPU state: Map<pid, { utime, stime, starttime, timestampNs }>
    this.lastProcessCpu = new Map();
    this.lastSystemCpu = null;
    this.history = [];
    this.lastSnapshot = null;
    this.lastSampleDurationMs = 0;
  }

  /**
   * Subscribes to periodic performance updates.
   * Starts collection timer when the first subscriber joins.
   *
   * @returns {Promise<object>} Current performance snapshot
   */
  async subscribe() {
    this.subscribers++;
    if (this.subscribers === 1 && !this.timer) {
      this.timer = setInterval(() => {
        if (!this.isPaused && !this.isSampling) {
          void this.sample().catch((err) => {
            console.error('[resource-monitor] Sample error:', err);
          });
        }
      }, this.intervalMs);
      this.timer.unref?.();
    }

    return await this.sample();
  }

  /**
   * Unsubscribes from performance updates.
   * Stops timer immediately when the last subscriber leaves.
   */
  unsubscribe() {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers === 0) {
      this.stop();
    }
  }

  pause() {
    this.isPaused = true;
    if (this.lastSnapshot) {
      const latest = { ...this.lastSnapshot, isPaused: true };
      this.lastSnapshot = latest;
      this.emit(latest);
    }
  }

  resume() {
    this.isPaused = false;
    if (this.lastSnapshot) {
      const latest = { ...this.lastSnapshot, isPaused: false };
      this.lastSnapshot = latest;
      this.emit(latest);
    }
    void this.sample();
  }

  async refresh() {
    return await this.sample();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clean up process tracking maps to bound memory
    this.lastProcessCpu.clear();
    this.lastSystemCpu = null;
  }

  dispose() {
    this.stop();
    this.subscribers = 0;
    this.history = [];
  }

  /**
   * Performs an atomic resource accounting sample across all MAW processes.
   *
   * @returns {Promise<object>} Complete PerformanceSnapshot
   */
  async sample() {
    if (this.isSampling) return this.getLatestSnapshot();
    this.isSampling = true;
    const startNs = process.hrtime.bigint();

    try {
      const nowMs = Date.now();
      const numCores = os.cpus().length || 1;

      // 1. Discover Backend & Terminals
      let backendInfo = null;
      let backendTerminals = [];
      let supervisorPid = null;
      let backendPid = null;

      if (this.getBackendReadiness) {
        try {
          const readiness = await this.getBackendReadiness();
          if (readiness && readiness.pid) {
            backendPid = readiness.pid;
            // Fetch live terminals from the administrative loopback endpoint
            if (readiness.url) {
              const termUrl = new URL('/api/performance/terminals', readiness.url);
              const token = readiness.url.searchParams.get('token');
              if (token) termUrl.searchParams.set('token', token);

              const resp = await fetch(termUrl, {
                signal: AbortSignal.timeout(1000),
                headers: { Accept: 'application/json' },
              });
              if (resp.ok) {
                const termData = await resp.json();
                if (termData.ok) {
                  backendTerminals = termData.terminals || [];
                  supervisorPid = termData.supervisorPid || null;
                }
              }
            }
          }
        } catch {
          // Backend temporarily offline or unreachable
        }
      }

      // 2. Discover Electron Processes
      let electronMainPid = process.pid;
      let electronGpuPid = null;
      let electronUtilityPids = [];
      let electronRendererPids = [];
      let electronMetrics = [];

      if (this.app && typeof this.app.getAppMetrics === 'function') {
        try {
          electronMetrics = this.app.getAppMetrics();
          for (const metric of electronMetrics) {
            if (metric.type === 'GPU') electronGpuPid = metric.pid;
            else if (metric.type === 'Utility') electronUtilityPids.push(metric.pid);
            else if (metric.type === 'Tab') electronRendererPids.push(metric.pid);
          }
        } catch {}
      }

      const electronWindowPid = this.win && !this.win.isDestroyed() && this.win.webContents && !this.win.webContents.isDestroyed()
        ? this.win.webContents.getOSProcessId()
        : null;

      // 3. Scan system process tree on Linux
      const processTree = buildProcessTree(this.procRoot);
      const claimedPids = new Set();
      const currentActivePids = new Set();

      // Helper to measure process metrics
      const measureProcess = (pid, name, role, sharedWith = []) => {
        currentActivePids.add(pid);
        const smaps = readProcessSmaps(pid, this.procRoot);
        const stat = readProcessStat(pid, this.procRoot);

        let cpuPercent = 0;
        let cpuCorePercent = 0;

        if (stat) {
          const prev = this.lastProcessCpu.get(pid);
          const elapsedSec = prev ? Number(startNs - prev.timestampNs) / 1e9 : 0;

          const cpu = calculateProcessCpuDelta({
            utimeNow: stat.utime,
            stimeNow: stat.stime,
            starttimeNow: stat.starttime,
            utimePrev: prev?.utime,
            stimePrev: prev?.stime,
            starttimePrev: prev?.starttime,
            elapsedSeconds: elapsedSec,
            numCores,
          });

          cpuPercent = cpu.cpuPercent;
          cpuCorePercent = cpu.cpuCorePercent;

          this.lastProcessCpu.set(pid, {
            utime: stat.utime,
            stime: stat.stime,
            starttime: stat.starttime,
            timestampNs: startNs,
          });
        }

        return {
          pid,
          name,
          role,
          cpuPercent,
          cpuCorePercent,
          pssBytes: smaps.pssBytes,
          rssBytes: smaps.rssBytes,
          privateBytes: smaps.privateBytes,
          sharedBytes: smaps.sharedBytes,
          isAvailable: smaps.isAvailable,
          ...(sharedWith.length > 0 ? { sharedWithPids: sharedWith } : {}),
        };
      };

      // -------------------------------------------------------------
      // Group 1: Embedded Browser Views (WebContentsViews)
      // -------------------------------------------------------------
      const browserViewMetrics = [];
      const rendererToTabs = new Map();

      // Collect active/background views and detect shared renderer processes
      for (const [id, view] of this.views.entries()) {
        const contents = view?.webContents;
        if (contents && !contents.isDestroyed()) {
          const rPid = contents.getOSProcessId();
          if (rPid) {
            if (!rendererToTabs.has(rPid)) rendererToTabs.set(rPid, []);
            rendererToTabs.get(rPid).push(id);
          }
        }
      }

      const measuredRenderers = new Map(); // pid -> measured metric

      for (const [id, view] of this.views.entries()) {
        const provider = this.providers.get(id) || 'chatgpt';
        const providerLabel = provider === 'github' ? 'GitHub' : provider === 'perplexity' ? 'Perplexity' : 'ChatGPT';
        const url = this.urls.get(id) || '';
        const isAttached = this.attachedViews.has(id);
        const lifecycle = isAttached ? 'active' : 'background';

        const contents = view?.webContents;
        const rPid = contents && !contents.isDestroyed() ? contents.getOSProcessId() : null;

        if (rPid) {
          const sharingTabIds = rendererToTabs.get(rPid) || [id];
          const isShared = sharingTabIds.length > 1;

          let metric = measuredRenderers.get(rPid);
          if (!metric) {
            claimedPids.add(rPid);
            metric = measureProcess(rPid, `${providerLabel} Renderer`, 'browser-renderer', sharingTabIds);
            measuredRenderers.set(rPid, metric);
          }

          // Strict accounting: divide shared process PSS and CPU proportionally by sharing tabs
          // so the group total never double counts!
          const divisor = isShared ? sharingTabIds.length : 1;

          browserViewMetrics.push({
            id,
            provider,
            providerLabel,
            url,
            lifecycle,
            rendererPid: rPid,
            isSharedRenderer: isShared,
            sharedTabCount: sharingTabIds.length,
            cpuPercent: Number((metric.cpuPercent / divisor).toFixed(1)),
            pssBytes: Math.round(metric.pssBytes / divisor),
            rssBytes: Math.round(metric.rssBytes / divisor),
            privateBytes: Math.round(metric.privateBytes / divisor),
            sharedBytes: Math.round(metric.sharedBytes / divisor),
          });
        } else {
          browserViewMetrics.push({
            id,
            provider,
            providerLabel,
            url,
            lifecycle,
            rendererPid: null,
            isSharedRenderer: false,
            sharedTabCount: 1,
            cpuPercent: 0,
            pssBytes: 0,
            rssBytes: 0,
            privateBytes: 0,
            sharedBytes: 0,
          });
        }
      }

      // Suspended/Hibernated tabs
      for (const [id, record] of this.suspendedTabs.entries()) {
        const provider = record.provider || 'chatgpt';
        const providerLabel = provider === 'github' ? 'GitHub' : provider === 'perplexity' ? 'Perplexity' : 'ChatGPT';
        browserViewMetrics.push({
          id,
          provider,
          providerLabel,
          url: record.url || record.requestedUrl || '',
          lifecycle: 'suspended',
          rendererPid: null,
          isSharedRenderer: false,
          sharedTabCount: 1,
          cpuPercent: 0,
          pssBytes: 0,
          rssBytes: 0,
          privateBytes: 0,
          sharedBytes: 0,
        });
      }

      // -------------------------------------------------------------
      // Group 2: AI Coding Agents & Other Terminals
      // -------------------------------------------------------------
      const agentInstances = [];
      const otherTerminalMetrics = [];

      for (const term of backendTerminals) {
        if (!term.pid) continue;
        const rootPid = term.pid;

        // Traverse process subtree for this terminal
        const termPids = collectSubtreePids([rootPid], processTree, claimedPids);
        for (const p of termPids) claimedPids.add(p);

        // Classify if any process in this terminal tree is an AI Coding Agent
        let detectedProvider = null;
        for (const p of termPids) {
          const prov = classifyProcessProvider(p, this.procRoot);
          if (prov) {
            detectedProvider = prov;
            break;
          }
        }

        // If backend explicitly assigned agent/native identity and no runtime binary was found yet, use it
        if (!detectedProvider && term.provider && term.kind === 'agent') {
          detectedProvider = term.provider;
        }

        // Measure all processes in this terminal
        const termProcesses = [];
        let termCpu = 0;
        let termPss = 0;
        let termRss = 0;
        let termPrivate = 0;
        let termShared = 0;

        for (const p of termPids) {
          const stat = readProcessStat(p, this.procRoot);
          const pName = stat ? stat.comm : `PID ${p}`;
          const pRole = p === rootPid ? 'terminal-shell' : (detectedProvider ? 'agent-process' : 'terminal-child');
          const m = measureProcess(p, pName, pRole);
          termProcesses.push(m);
          termCpu += m.cpuPercent;
          termPss += m.pssBytes;
          termRss += m.rssBytes;
          termPrivate += m.privateBytes;
          termShared += m.sharedBytes;
        }

        if (detectedProvider) {
          const provDef = AGENT_PROVIDERS.find((ap) => ap.id === detectedProvider) || {
            id: detectedProvider,
            label: detectedProvider,
          };
          agentInstances.push({
            terminalId: term.terminalId,
            sessionId: term.sessionId || undefined,
            title: term.title || provDef.label,
            provider: detectedProvider,
            providerLabel: provDef.label,
            rootPid,
            pids: termPids,
            cpuPercent: Number(termCpu.toFixed(1)),
            pssBytes: termPss,
            rssBytes: termRss,
            privateBytes: termPrivate,
            sharedBytes: termShared,
            processes: termProcesses,
          });
        } else {
          otherTerminalMetrics.push({
            terminalId: term.terminalId,
            sessionId: term.sessionId || undefined,
            title: term.title || `Terminal (${rootPid})`,
            shell: termProcesses.find((p) => p.pid === rootPid)?.name || 'shell',
            rootPid,
            pids: termPids,
            cpuPercent: Number(termCpu.toFixed(1)),
            pssBytes: termPss,
            rssBytes: termRss,
            privateBytes: termPrivate,
            sharedBytes: termShared,
            processes: termProcesses,
          });
        }
      }

      // Group AI Agents by Provider
      const agentGroupsMap = new Map();
      for (const prov of AGENT_PROVIDERS) {
        agentGroupsMap.set(prov.id, {
          provider: prov.id,
          providerLabel: prov.label,
          instanceCount: 0,
          totalCpuPercent: 0,
          totalPssBytes: 0,
          instances: [],
        });
      }

      for (const inst of agentInstances) {
        let group = agentGroupsMap.get(inst.provider);
        if (!group) {
          group = {
            provider: inst.provider,
            providerLabel: inst.providerLabel,
            instanceCount: 0,
            totalCpuPercent: 0,
            totalPssBytes: 0,
            instances: [],
          };
          agentGroupsMap.set(inst.provider, group);
        }
        group.instanceCount++;
        group.totalCpuPercent = Number((group.totalCpuPercent + inst.cpuPercent).toFixed(1));
        group.totalPssBytes += inst.pssBytes;
        group.instances.push(inst);
      }

      const agentGroups = [...agentGroupsMap.values()].filter((g) => g.instanceCount > 0);

      // -------------------------------------------------------------
      // Group 3: MAW Infrastructure
      // -------------------------------------------------------------
      const infraProcesses = [];

      // Electron Main
      if (electronMainPid && !claimedPids.has(electronMainPid)) {
        claimedPids.add(electronMainPid);
        infraProcesses.push(measureProcess(electronMainPid, 'Electron Main', 'electron-main'));
      }

      // Electron UI Window Renderer
      if (electronWindowPid && !claimedPids.has(electronWindowPid)) {
        claimedPids.add(electronWindowPid);
        infraProcesses.push(measureProcess(electronWindowPid, 'MAW UI Renderer', 'electron-renderer'));
      }

      // Electron GPU Process
      if (electronGpuPid && !claimedPids.has(electronGpuPid)) {
        claimedPids.add(electronGpuPid);
        infraProcesses.push(measureProcess(electronGpuPid, 'Electron GPU', 'electron-gpu'));
      }

      // Electron Utilities (NetworkService, etc.)
      for (const uPid of electronUtilityPids) {
        if (!claimedPids.has(uPid)) {
          claimedPids.add(uPid);
          infraProcesses.push(measureProcess(uPid, 'Electron Utility', 'electron-utility'));
        }
      }

      // Backend Server
      if (backendPid && !claimedPids.has(backendPid)) {
        const backendSubtree = collectSubtreePids([backendPid], processTree, claimedPids);
        for (const p of backendSubtree) {
          claimedPids.add(p);
          const stat = readProcessStat(p, this.procRoot);
          const pName = p === backendPid ? 'MAW Backend Server' : stat?.comm || 'Backend Worker';
          infraProcesses.push(measureProcess(p, pName, 'backend-process'));
        }
      }

      // PTY Supervisor Daemon
      if (supervisorPid && !claimedPids.has(supervisorPid)) {
        claimedPids.add(supervisorPid);
        infraProcesses.push(measureProcess(supervisorPid, 'PTY Supervisor (maw-ptyd)', 'pty-supervisor'));
      }

      // Group rollups
      const sumGroup = (procs, id, label) => ({
        id,
        label,
        processCount: procs.length,
        totalCpuPercent: Number(procs.reduce((acc, p) => acc + p.cpuPercent, 0).toFixed(1)),
        totalPssBytes: procs.reduce((acc, p) => acc + p.pssBytes, 0),
        totalRssBytes: procs.reduce((acc, p) => acc + p.rssBytes, 0),
        totalPrivateBytes: procs.reduce((acc, p) => acc + p.privateBytes, 0),
        totalSharedBytes: procs.reduce((acc, p) => acc + p.sharedBytes, 0),
        processes: procs,
      });

      const infraGroup = sumGroup(infraProcesses, 'infrastructure', 'MAW Infrastructure');

      // -------------------------------------------------------------
      // Global Overview & Memory Pressure Tier
      // -------------------------------------------------------------
      const freeBytes = typeof os.freemem === 'function' ? os.freemem() : 4 * 1024 * 1024 * 1024;
      const totalBytes = typeof os.totalmem === 'function' ? os.totalmem() : 16 * 1024 * 1024 * 1024;

      // Calculate Tab working set for memory tier calculation
      const tabWorkingSetBytes = browserViewMetrics.reduce((acc, v) => acc + v.pssBytes, 0);

      const budgetInfo = calculateResourceBudget({
        freeBytes,
        totalBytes,
        tabWorkingSetBytes,
        attachedCount: this.attachedViews.size,
        envOverride: process.env.MAW_MAX_RESIDENT_VIEWS,
        tierOverride: process.env.MAW_MEMORY_PRESSURE_TIER,
      });

      // Total MAW resources
      const allMeasuredProcesses = [
        ...infraProcesses,
        ...agentInstances.flatMap((a) => a.processes),
        ...otherTerminalMetrics.flatMap((t) => t.processes),
        ...measuredRenderers.values(),
      ];

      const totalMawPss = allMeasuredProcesses.reduce((acc, p) => acc + p.pssBytes, 0);
      const totalMawRss = allMeasuredProcesses.reduce((acc, p) => acc + p.rssBytes, 0);
      const totalMawPrivate = allMeasuredProcesses.reduce((acc, p) => acc + p.privateBytes, 0);
      const totalMawShared = allMeasuredProcesses.reduce((acc, p) => acc + p.sharedBytes, 0);
      const totalMawCpu = Number(allMeasuredProcesses.reduce((acc, p) => acc + p.cpuPercent, 0).toFixed(1));

      // Clean up terminated PIDs from lastProcessCpu map
      for (const p of this.lastProcessCpu.keys()) {
        if (!currentActivePids.has(p)) {
          this.lastProcessCpu.delete(p);
        }
      }

      const sampleEndNs = process.hrtime.bigint();
      this.lastSampleDurationMs = Number(sampleEndNs - startNs) / 1e6;

      const snapshot = {
        timestamp: nowMs,
        isPaused: this.isPaused,
        sampleDurationMs: Number(this.lastSampleDurationMs.toFixed(2)),
        global: {
          cpuUsagePercent: totalMawCpu,
          mawCpuPercent: totalMawCpu,
          cpuCoreCount: numCores,
          mawPssBytes: totalMawPss,
          mawRssBytes: totalMawRss,
          mawPrivateBytes: totalMawPrivate,
          mawSharedBytes: totalMawShared,
          systemTotalBytes: totalBytes,
          systemFreeBytes: freeBytes,
          systemAvailableBytes: freeBytes,
          systemMemoryPressure: budgetInfo.tier || MemoryPressureTier.NORMAL,
          gpuProcessMetric: infraProcesses.find((p) => p.role === 'electron-gpu') || null,
          gpuHardwareUtilization: null, // Explicit unavailable state without external driver polling
          gpuVramBytes: null, // Explicit unavailable state: dedicated VRAM cannot be inferred from RSS
          gpuStatusNote: 'Hardware VRAM & GPU engine telemetry unavailable without external driver polling',
          totalMawProcesses: allMeasuredProcesses.length,
          backendHealth: {
            status: backendPid ? 'healthy' : 'unreachable',
            pid: backendPid,
            type: 'Node.js Express & WebSocket Backend',
          },
          supervisorHealth: {
            status: supervisorPid ? 'healthy' : 'disabled',
            pid: supervisorPid,
            type: supervisorPid ? 'Persistent PTY Supervisor (maw-ptyd)' : 'In-Process node-pty Fallback',
          },
          desktopHealth: {
            status: electronMainPid ? 'healthy' : 'unreachable',
            pid: electronMainPid,
            type: 'Electron 45.2.0 Main Process',
          },
        },
        infrastructure: infraGroup,
        aiAgents: {
          totalCpuPercent: Number(agentInstances.reduce((acc, a) => acc + a.cpuPercent, 0).toFixed(1)),
          totalPssBytes: agentInstances.reduce((acc, a) => acc + a.pssBytes, 0),
          activeCount: agentInstances.length,
          groups: agentGroups,
        },
        browserViews: {
          totalCpuPercent: Number(browserViewMetrics.reduce((acc, v) => acc + v.cpuPercent, 0).toFixed(1)),
          totalPssBytes: browserViewMetrics.reduce((acc, v) => acc + v.pssBytes, 0),
          totalCount: browserViewMetrics.length,
          activeCount: browserViewMetrics.filter((v) => v.lifecycle === 'active').length,
          backgroundCount: browserViewMetrics.filter((v) => v.lifecycle === 'background').length,
          suspendedCount: browserViewMetrics.filter((v) => v.lifecycle === 'suspended').length,
          views: browserViewMetrics,
        },
        otherTerminals: {
          totalCpuPercent: Number(otherTerminalMetrics.reduce((acc, t) => acc + t.cpuPercent, 0).toFixed(1)),
          totalPssBytes: otherTerminalMetrics.reduce((acc, t) => acc + t.pssBytes, 0),
          count: otherTerminalMetrics.length,
          terminals: otherTerminalMetrics,
        },
        unattributed: {
          id: 'unattributed',
          label: 'Unattributed',
          processCount: 0,
          totalCpuPercent: 0,
          totalPssBytes: 0,
          totalRssBytes: 0,
          totalPrivateBytes: 0,
          totalSharedBytes: 0,
          processes: [],
        },
        history: [],
      };

      // Maintain in-memory history (ring buffer)
      this.history.push({
        timestamp: nowMs,
        mawCpuPercent: snapshot.global.mawCpuPercent,
        systemCpuPercent: snapshot.global.cpuUsagePercent,
        mawPssBytes: snapshot.global.mawPssBytes,
        mawProcessCount: snapshot.global.totalMawProcesses,
      });

      if (this.history.length > MAX_HISTORY_POINTS) {
        this.history.shift();
      }

      snapshot.history = [...this.history];
      this.lastSnapshot = snapshot;
      this.emit(snapshot);
      return snapshot;
    } finally {
      this.isSampling = false;
    }
  }

  emit(snapshot) {
    if (this.onState) {
      try {
        this.onState(snapshot);
      } catch (err) {
        console.error('[resource-monitor] onState delivery error:', err);
      }
    }
  }

  getLatestSnapshot() {
    if (this.history.length > 0) {
      return { history: [...this.history] };
    }
    return null;
  }
}
