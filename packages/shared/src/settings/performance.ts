/**
 * Native Resource Performance Monitor contracts and types.
 */

export type MemoryPressureTierName = 'normal' | 'moderate' | 'high' | 'critical' | 'override';

export interface PerformanceProcessMetric {
  pid: number;
  name: string;
  role: string;
  cpuPercent: number; // Normalized to total system capacity (0-100%)
  cpuCorePercent: number; // Single-core percentage (0-100% * cores)
  pssBytes: number;
  rssBytes: number;
  privateBytes: number;
  sharedBytes: number;
  isAvailable: boolean;
  swapPssBytes?: number;
  sharedWithPids?: number[];
}

export interface PerformanceGroupMetric {
  id: string;
  label: string;
  processCount: number;
  totalCpuPercent: number;
  totalPssBytes: number;
  totalRssBytes: number;
  totalPrivateBytes: number;
  totalSharedBytes: number;
  processes: PerformanceProcessMetric[];
}

export interface PerformanceAgentInstance {
  terminalId: string;
  sessionId?: string;
  workspaceId?: string;
  title: string;
  provider: string; // 'codex' | 'claude-code' | 'gemini-cli' | 'opencode' | 'antigravity' | 'pi'
  providerLabel: string;
  rootPid: number;
  pids: number[];
  cpuPercent: number;
  pssBytes: number;
  rssBytes: number;
  privateBytes: number;
  sharedBytes: number;
  processes: PerformanceProcessMetric[];
}

export interface PerformanceAgentGroup {
  provider: string;
  providerLabel: string;
  instanceCount: number;
  totalCpuPercent: number;
  totalPssBytes: number;
  instances: PerformanceAgentInstance[];
}

export interface PerformanceBrowserViewMetric {
  id: string;
  provider: string; // 'chatgpt' | 'perplexity' | 'github' | 'browser'
  providerLabel: string;
  url: string;
  lifecycle: 'active' | 'background' | 'suspended';
  rendererPid: number | null;
  isSharedRenderer: boolean;
  sharedTabCount: number;
  cpuPercent: number;
  pssBytes: number;
  rssBytes: number;
  privateBytes: number;
  sharedBytes: number;
}

/** Why a resident browser view is currently held in memory by the eviction governor. */
export type BrowserProtectionReason =
  | 'focused'
  | 'download'
  | 'popup'
  | 'loading'
  | 'nondurable'
  | 'devtools'
  | 'interaction'
  | 'provider';

export interface PerformanceBrowserEviction {
  at: number;
  id?: string;
  tier?: MemoryPressureTierName;
  /** Null: renderer processes are shared between views, so no per-view reclaim is measurable. */
  reclaimedPssBytes: number | null;
  reclaimedPssUnavailableReason: string | null;
}

/**
 * Browser lifecycle telemetry, computed by the eviction governor itself.
 * Null fields are explicitly unavailable, never a measured zero.
 */
export interface PerformanceBrowserLifecycle {
  residentViews: number;
  attachedViews: number;
  /** Resident but not attached to the layout. */
  detachedViews: number;
  suspendedViews: number;
  protectedCounts: Partial<Record<BrowserProtectionReason, number>>;
  /** Oldest age in ms of each currently applying protection reason. */
  protectionAgeMs: Partial<Record<BrowserProtectionReason, number | null>>;
  tier: MemoryPressureTierName | null;
  memoryTier: MemoryPressureTierName | null;
  budget: number | null;
  /** Age of the governor's cached tier and budget; telemetry never reassesses pressure. */
  budgetSampleAgeMs: number | null;
  overBudget: boolean | null;
  /** Why the last trim pass stopped while still over budget. Null: no trim pass yet. */
  evictionBlockers: Partial<Record<BrowserProtectionReason | 'unknown', number>> | null;
  lastTrimAt: number | null;
  /** Renderer processes serving resident views (shared renderers counted once). */
  rendererProcessCount: number | null;
  lastEviction: PerformanceBrowserEviction | null;
  tierSource: 'governor' | 'monitor-fallback';
  isAvailable: boolean;
}

export interface PerformanceTerminalMetric {
  terminalId: string;
  sessionId?: string;
  workspaceId?: string;
  title: string;
  shell: string;
  rootPid: number;
  pids: number[];
  cpuPercent: number;
  pssBytes: number;
  rssBytes: number;
  privateBytes: number;
  sharedBytes: number;
  processes: PerformanceProcessMetric[];
}

export interface PerformanceServiceHealth {
  status: 'healthy' | 'degraded' | 'unreachable' | 'disabled';
  pid: number | null;
  type: string;
  details?: string;
}

export interface PerformanceGlobalOverview {
  cpuUsagePercent: number; // Normalized total system CPU usage (0-100%)
  workbenchCpuPercent: number; // CPU used by MAW application overhead (0-100%)
  appWorkbenchCpuPercent?: number; // Explicit MAW application CPU (0-100%)
  workloadCpuPercent?: number; // CPU used by managed workloads (agents + shells) (0-100%)
  totalCombinedCpuPercent?: number; // Combined total CPU (0-100%)
  cpuCoreCount: number;
  workbenchPssBytes: number; // Physical RAM actually held by MAW application processes (PSS)
  appWorkbenchPssBytes?: number; // Explicit MAW application memory (PSS)
  workloadPssBytes?: number; // Physical RAM held by managed workloads (PSS)
  totalCombinedPssBytes?: number; // Combined total RAM (PSS)
  workbenchRssBytes: number; // Raw RSS sum (displayed for comparison, not as actual physical consumption)
  workbenchPrivateBytes: number;
  workbenchSharedBytes: number;
  workbenchSwapPssBytes?: number;
  workloadRssBytes?: number;
  workloadPrivateBytes?: number;
  workloadSharedBytes?: number;
  systemTotalBytes: number;
  systemFreeBytes: number;
  systemAvailableBytes: number;
  systemMemoryPressure: MemoryPressureTierName;
  gpuProcessMetric: PerformanceProcessMetric | null;
  gpuHardwareUtilization: number | null; // Null indicates explicit unavailable state
  gpuVramBytes: number | null; // Null indicates explicit unavailable state
  gpuStatusNote: string;
  totalWorkbenchProcesses: number;
  totalWorkloadProcesses?: number;
  backendHealth: PerformanceServiceHealth;
  supervisorHealth: PerformanceServiceHealth;
  desktopHealth: PerformanceServiceHealth;
}

export interface PerformanceHistoricalPoint {
  timestamp: number;
  workbenchCpuPercent: number;
  systemCpuPercent: number;
  workbenchPssBytes: number;
  workbenchProcessCount: number;
}

export interface PerformanceSnapshot {
  timestamp: number;
  isPaused: boolean;
  sampleDurationMs: number;
  global: PerformanceGlobalOverview;
  infrastructure: PerformanceGroupMetric;
  aiAgents: {
    totalCpuPercent: number;
    totalPssBytes: number;
    activeCount: number;
    groups: PerformanceAgentGroup[];
  };
  browserViews: {
    totalCpuPercent: number;
    totalPssBytes: number;
    totalCount: number;
    activeCount: number;
    backgroundCount: number;
    suspendedCount: number;
    views: PerformanceBrowserViewMetric[];
  };
  browser: PerformanceBrowserLifecycle;
  livePtyCount?: number | null;
  hardwareAcceleration?: {
    configured: boolean;
    effectiveAtStartup: boolean;
    source: string;
    pendingRestart: boolean;
    gpuSummary: { text: string } | null;
  };
  otherTerminals: {
    totalCpuPercent: number;
    totalPssBytes: number;
    count: number;
    terminals: PerformanceTerminalMetric[];
  };
  unattributed: PerformanceGroupMetric;
  history: PerformanceHistoricalPoint[];
}
