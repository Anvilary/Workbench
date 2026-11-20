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
  mawCpuPercent: number; // CPU used by MAW application overhead (0-100%)
  appMawCpuPercent?: number; // Explicit MAW application CPU (0-100%)
  workloadCpuPercent?: number; // CPU used by managed workloads (agents + shells) (0-100%)
  totalCombinedCpuPercent?: number; // Combined total CPU (0-100%)
  cpuCoreCount: number;
  mawPssBytes: number; // Physical RAM actually held by MAW application processes (PSS)
  appMawPssBytes?: number; // Explicit MAW application memory (PSS)
  workloadPssBytes?: number; // Physical RAM held by managed workloads (PSS)
  totalCombinedPssBytes?: number; // Combined total RAM (PSS)
  mawRssBytes: number; // Raw RSS sum (displayed for comparison, not as actual physical consumption)
  mawPrivateBytes: number;
  mawSharedBytes: number;
  mawSwapPssBytes?: number;
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
  totalMawProcesses: number;
  totalWorkloadProcesses?: number;
  backendHealth: PerformanceServiceHealth;
  supervisorHealth: PerformanceServiceHealth;
  desktopHealth: PerformanceServiceHealth;
}

export interface PerformanceHistoricalPoint {
  timestamp: number;
  mawCpuPercent: number;
  systemCpuPercent: number;
  mawPssBytes: number;
  mawProcessCount: number;
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
  otherTerminals: {
    totalCpuPercent: number;
    totalPssBytes: number;
    count: number;
    terminals: PerformanceTerminalMetric[];
  };
  unattributed: PerformanceGroupMetric;
  history: PerformanceHistoricalPoint[];
}
