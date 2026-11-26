import { useEffect, useState, useCallback, useId } from 'react';
import type { PerformanceBrowserLifecycle, PerformanceSnapshot } from '@anvilary/workbench-shared';
import { formatBytes } from '../../i18n/format.js';
import { t } from '../../i18n/index.js';
import { PerformanceSparkline } from './PerformanceSparkline.js';

interface Props {
  onClose: () => void;
}

const UNAVAILABLE = 'unavailable';

function formatSeconds(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return UNAVAILABLE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function formatReasonCounts(counts: Record<string, number | null | undefined> | null | undefined): string {
  if (!counts) return UNAVAILABLE;
  const entries = Object.entries(counts).filter(([, value]) => typeof value === 'number' && value > 0);
  if (entries.length === 0) return 'none';
  return entries.map(([reason, value]) => `${reason} ${value}`).join(', ');
}

/**
 * Compact lifecycle facts from the eviction governor. Metrics the governor cannot
 * measure are shown as unavailable, never as a zero.
 */
function BrowserLifecycleSummary({ browser }: { browser?: PerformanceBrowserLifecycle }): JSX.Element {
  if (!browser) {
    return <div className="wb-perf-shared-notice">Lifecycle telemetry {UNAVAILABLE}</div>;
  }
  const protectionAges = Object.entries(browser.protectionAgeMs ?? {})
    .filter(([, value]) => typeof value === 'number')
    .map(([reason, value]) => `${reason} ${formatSeconds(value as number)}`);
  return (
    <div className="wb-perf-shared-notice">
      <div>
        Resident {browser.residentViews} &bull; attached {browser.attachedViews} &bull; detached{' '}
        {browser.detachedViews} &bull; suspended {browser.suspendedViews} &bull; renderer processes{' '}
        {browser.rendererProcessCount ?? UNAVAILABLE}
      </div>
      <div>
        Tier {browser.tier ?? UNAVAILABLE}
        {browser.tier ? ` (${browser.tierSource})` : ''} &bull; budget {browser.budget ?? UNAVAILABLE} &bull;{' '}
        {browser.overBudget === null ? `over budget ${UNAVAILABLE}` : browser.overBudget ? 'over budget' : 'within budget'} &bull;{' '}
        unload AI tabs under pressure{' '}
        {browser.aiUnloadUnderPressure === null ? UNAVAILABLE : browser.aiUnloadUnderPressure ? 'on' : 'off'}
      </div>
      <div>Protected: {formatReasonCounts(browser.protectedCounts)}</div>
      {protectionAges.length > 0 && <div>Protection age: {protectionAges.join(', ')}</div>}
      <div>Eviction blockers: {formatReasonCounts(browser.evictionBlockers)}</div>
      <div>
        Last eviction:{' '}
        {browser.lastEviction
          ? `${formatSeconds(Date.now() - browser.lastEviction.at)} ago, reclaimed ${
            browser.lastEviction.reclaimedPssBytes === null
              ? `${UNAVAILABLE} (${browser.lastEviction.reclaimedPssUnavailableReason ?? UNAVAILABLE})`
              : formatBytes(browser.lastEviction.reclaimedPssBytes)
          }`
          : 'none this session'}
      </div>
    </div>
  );
}

export function PerformancePanel({ onClose }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group expansion states
  const [expandInfra, setExpandInfra] = useState(true);
  const [expandAgents, setExpandAgents] = useState(true);
  const [expandBrowsers, setExpandBrowsers] = useState(true);
  const [expandTerminals, setExpandTerminals] = useState(false);
  const [expandedAgentTerminals, setExpandedAgentTerminals] = useState<Record<string, boolean>>({});

  const titleId = useId();

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Subscribe to performance monitor via desktop IPC
  useEffect(() => {
    const bridge = (window as unknown as { workbench?: { command: (cmd: any) => Promise<any>; subscribe: (fn: (state: any) => void) => () => void } }).workbench;
    if (!bridge || typeof bridge.command !== 'function') {
      setError(t('performance.desktopRequired'));
      return;
    }

    let unsub: (() => void) | null = null;
    let mounted = true;

    const activeBridge = bridge;
    async function initSubscription() {
      try {
        unsub = activeBridge.subscribe((state: any) => {
          if (!mounted) return;
          if (state?.type === 'performance-update' && state.snapshot) {
            setSnapshot(state.snapshot);
            setIsPaused(!!state.snapshot.isPaused);
          }
        });

        const res = await activeBridge.command({ type: 'performance-subscribe' });
        if (mounted && res?.snapshot) {
          setSnapshot(res.snapshot);
          setIsPaused(!!res.snapshot.isPaused);
        }
      } catch (err: any) {
        if (mounted) {
          setError(err?.message || t('performance.loadError'));
        }
      }
    }

    void initSubscription();

    return () => {
      mounted = false;
      if (unsub) unsub();
      void bridge.command({ type: 'performance-unsubscribe' }).catch(() => {});
    };
  }, []);

  const handleTogglePause = useCallback(async () => {
    const bridge = (window as unknown as { workbench?: { command: (cmd: any) => Promise<any> } }).workbench;
    if (!bridge) return;
    try {
      if (isPaused) {
        await bridge.command({ type: 'performance-resume' });
        setIsPaused(false);
      } else {
        await bridge.command({ type: 'performance-pause' });
        setIsPaused(true);
      }
    } catch {}
  }, [isPaused]);

  const handleRefresh = useCallback(async () => {
    const bridge = (window as unknown as { workbench?: { command: (cmd: any) => Promise<any> } }).workbench;
    if (!bridge) return;
    try {
      setIsRefreshing(true);
      const res = await bridge.command({ type: 'performance-refresh' });
      if (res?.snapshot) {
        setSnapshot(res.snapshot);
        setIsPaused(!!res.snapshot.isPaused);
      }
    } catch {
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const toggleAgentTerminal = (terminalId: string) => {
    setExpandedAgentTerminals((prev) => ({
      ...prev,
      [terminalId]: !prev[terminalId],
    }));
  };

  const cpuHistory = snapshot?.history?.map((h) => h.mawCpuPercent) || [];
  const ramHistory = snapshot?.history?.map((h) => h.mawPssBytes) || [];
  const procHistory = snapshot?.history?.map((h) => h.mawProcessCount) || [];

  return (
    <div
      className="wb-performance-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="wb-perf-header">
        <div className="wb-perf-title-row">
          <svg className="wb-perf-header-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M1 11.5a.5.5 0 0 1 .5-.5h2.793l1.853-3.707a.5.5 0 0 1 .894 0L8.5 10.207l1.646-1.646a.5.5 0 0 1 .708 0L12 9.707V2.5a.5.5 0 0 1 1 0v8a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5z"/>
          </svg>
          <h2 id={titleId} className="wb-perf-title">
            {t('performance.title')}
          </h2>
          {snapshot && (
            <span className={`wb-perf-status-badge ${isPaused ? 'paused' : 'active'}`}>
              {isPaused ? t('performance.paused') : t('performance.sampling2s')}
            </span>
          )}
          {snapshot?.sampleDurationMs !== undefined && (
            <span className="wb-perf-latency-badge" title={t('performance.collectionLatency')}>
              {snapshot.sampleDurationMs} ms
            </span>
          )}
        </div>

        <div className="wb-perf-controls">
          <button
            type="button"
            className="wb-perf-btn"
            onClick={handleTogglePause}
            title={isPaused ? t('performance.resume') : t('performance.pause')}
            aria-label={isPaused ? t('performance.resume') : t('performance.pause')}
          >
            {isPaused ? (
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                <path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5zm5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/>
              </svg>
            )}
            <span>{isPaused ? t('performance.resume') : t('performance.pause')}</span>
          </button>

          <button
            type="button"
            className={`wb-perf-btn ${isRefreshing ? 'spinning' : ''}`}
            onClick={handleRefresh}
            title={t('performance.refresh')}
            aria-label={t('performance.refresh')}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
              <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
            </svg>
          </button>

          <button
            type="button"
            className="wb-perf-btn wb-perf-close-btn"
            onClick={onClose}
            title={t('performance.close')}
            aria-label={t('performance.close')}
          >
            &times;
          </button>
        </div>
      </div>

      <div className="wb-perf-content">
        {error ? (
          <div className="wb-perf-error" role="alert">
            <p>{error}</p>
          </div>
        ) : !snapshot ? (
          <div className="wb-perf-loading">
            <div className="wb-perf-spinner" aria-hidden="true" />
            <p>{t('performance.connecting')}</p>
          </div>
        ) : (
          <>
            {/* Global Overview Grid */}
            <div className="wb-perf-grid">
              {/* Card 1: Workbench App CPU */}
              <div className="wb-perf-card">
                <div className="wb-perf-card-header">
                  <span className="wb-perf-card-label">{t('performance.mawAppCpu')}</span>
                  <span className="wb-perf-card-sub">
                    {snapshot.global.cpuCoreCount} {t('performance.cores')}
                  </span>
                </div>
                <div className="wb-perf-card-body">
                  <div className="wb-perf-card-val-row">
                    <span className="wb-perf-card-val">{snapshot.global.appMawCpuPercent ?? snapshot.global.mawCpuPercent}%</span>
                    <span className="wb-perf-card-note">
                      System: {snapshot.global.cpuUsagePercent}% · Workloads: {snapshot.global.workloadCpuPercent ?? Number(snapshot.aiAgents.totalCpuPercent + snapshot.otherTerminals.totalCpuPercent).toFixed(1)}%
                    </span>
                  </div>
                  <PerformanceSparkline
                    data={cpuHistory}
                    min={0}
                    max={100}
                    color="#d97442"
                    width={100}
                    height={24}
                  />
                </div>
              </div>

              {/* Card 2: Workbench App RAM */}
              <div className="wb-perf-card">
                <div className="wb-perf-card-header">
                  <span className="wb-perf-card-label">{t('performance.mawAppRam')}</span>
                  <span
                    className={`wb-perf-pressure-badge tier-${snapshot.global.systemMemoryPressure}`}
                    title={`System memory pressure: ${snapshot.global.systemMemoryPressure.toUpperCase()}`}
                  >
                    {snapshot.global.systemMemoryPressure.toUpperCase()}
                  </span>
                </div>
                <div className="wb-perf-card-body">
                  <div className="wb-perf-card-val-row">
                    <span className="wb-perf-card-val">{formatBytes(snapshot.global.appMawPssBytes ?? snapshot.global.mawPssBytes)}</span>
                    <span className="wb-perf-card-note">
                      Workloads: {formatBytes(snapshot.global.workloadPssBytes ?? (snapshot.aiAgents.totalPssBytes + snapshot.otherTerminals.totalPssBytes))} · Available: {formatBytes(snapshot.global.systemAvailableBytes)}
                    </span>
                  </div>
                  <PerformanceSparkline
                    data={ramHistory}
                    color="#3d9e6b"
                    width={100}
                    height={24}
                  />
                </div>
              </div>

              {/* Card 3: Embedded Browsers */}
              <div className="wb-perf-card">
                <div className="wb-perf-card-header">
                  <span className="wb-perf-card-label">{t('performance.embeddedBrowsers')}</span>
                  <span className="wb-perf-card-sub">
                    {snapshot.browserViews.activeCount} active · {snapshot.browserViews.suspendedCount} hibernated
                  </span>
                </div>
                <div className="wb-perf-card-body">
                  <div className="wb-perf-card-val-row">
                    <span className="wb-perf-card-val">{snapshot.browserViews.totalCount} {t('performance.tabs')}</span>
                    <span className="wb-perf-card-note">
                      {formatBytes(snapshot.browserViews.totalPssBytes)} PSS · {snapshot.browserViews.totalCpuPercent}% CPU
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 4: Managed Workloads */}
              <div className="wb-perf-card">
                <div className="wb-perf-card-header">
                  <span className="wb-perf-card-label">{t('performance.managedWorkloads')}</span>
                  <span className="wb-perf-card-sub">
                    {snapshot.aiAgents.activeCount} agents · {snapshot.otherTerminals.count} shells
                  </span>
                </div>
                <div className="wb-perf-card-body">
                  <div className="wb-perf-card-val-row">
                    <span className="wb-perf-card-val">
                      {formatBytes(snapshot.global.workloadPssBytes ?? (snapshot.aiAgents.totalPssBytes + snapshot.otherTerminals.totalPssBytes))}
                    </span>
                    <span className="wb-perf-card-note">
                      {snapshot.global.workloadCpuPercent ?? Number(snapshot.aiAgents.totalCpuPercent + snapshot.otherTerminals.totalCpuPercent).toFixed(1)}% CPU · {snapshot.global.totalWorkloadProcesses ?? (snapshot.aiAgents.groups.reduce((a, g) => a + g.instances.reduce((b, i) => b + i.pids.length, 0), 0) + snapshot.otherTerminals.terminals.reduce((a, t) => a + t.pids.length, 0))} procs
                    </span>
                  </div>
                  <PerformanceSparkline
                    data={procHistory}
                    color="#ec8a4a"
                    width={100}
                    height={24}
                  />
                </div>
              </div>
            </div>

            {/* Accounting Note */}
            <div className="wb-perf-accounting-note">
              <span>{t('performance.accountingNote')}</span>
            </div>

            {/* Service Health Line */}
            <div className="wb-perf-health-row">
              <div className="wb-perf-health-item" title={snapshot.global.backendHealth.type}>
                <span className={`wb-perf-health-dot ${snapshot.global.backendHealth.status}`} />
                <span className="wb-perf-health-name">Backend</span>
                <span className="wb-perf-health-pid">
                  {snapshot.global.backendHealth.pid ? `PID ${snapshot.global.backendHealth.pid}` : t('performance.offline')}
                </span>
              </div>
              <div className="wb-perf-health-item" title={snapshot.global.supervisorHealth.type}>
                <span className={`wb-perf-health-dot ${snapshot.global.supervisorHealth.status}`} />
                <span className="wb-perf-health-name">PTY Supervisor</span>
                <span className="wb-perf-health-pid">
                  {snapshot.global.supervisorHealth.pid ? `PID ${snapshot.global.supervisorHealth.pid}` : t('performance.fallbackInProcess')}
                </span>
              </div>
              <div className="wb-perf-health-item" title={snapshot.global.desktopHealth.type}>
                <span className={`wb-perf-health-dot ${snapshot.global.desktopHealth.status}`} />
                <span className="wb-perf-health-name">Electron Desktop</span>
                <span className="wb-perf-health-pid">
                  {snapshot.global.desktopHealth.pid ? `PID ${snapshot.global.desktopHealth.pid}` : t('performance.offline')}
                </span>
              </div>
            </div>

            {/* Resource Groups */}
            <div className="wb-perf-groups">
              {/* Group 1: Workbench Infrastructure */}
              <section className="wb-perf-section">
                <button
                  type="button"
                  className="wb-perf-section-toggle"
                  onClick={() => setExpandInfra(!expandInfra)}
                  aria-expanded={expandInfra}
                >
                  <span className={`wb-perf-chevron ${expandInfra ? 'expanded' : ''}`}>&#9656;</span>
                  <span className="wb-perf-section-title">{t('performance.groupInfrastructure')}</span>
                  <span className="wb-perf-section-meta">
                    {snapshot.infrastructure.processCount} {t('performance.procs')} &bull;{' '}
                    {snapshot.infrastructure.totalCpuPercent}% CPU &bull;{' '}
                    {formatBytes(snapshot.infrastructure.totalPssBytes)} PSS
                  </span>
                </button>

                {expandInfra && (
                  <div className="wb-perf-table-wrapper">
                    <table className="wb-perf-table">
                      <thead>
                        <tr>
                          <th>{t('performance.process')}</th>
                          <th>PID</th>
                          <th>CPU</th>
                          <th>PSS</th>
                          <th>Private</th>
                          <th>Shared</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.infrastructure.processes.map((proc) => (
                          <tr key={`infra-${proc.pid}`}>
                            <td className="wb-perf-td-name">
                              <span className="wb-perf-role-pill">{proc.role}</span>
                              {proc.name}
                            </td>
                            <td className="wb-perf-td-mono">{proc.pid}</td>
                            <td className="wb-perf-td-mono">{proc.cpuPercent}%</td>
                            <td className="wb-perf-td-mono">{formatBytes(proc.pssBytes)}</td>
                            <td className="wb-perf-td-mono">{formatBytes(proc.privateBytes)}</td>
                            <td className="wb-perf-td-mono">{formatBytes(proc.sharedBytes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Group 2: AI Coding Agents */}
              <section className="wb-perf-section">
                <button
                  type="button"
                  className="wb-perf-section-toggle"
                  onClick={() => setExpandAgents(!expandAgents)}
                  aria-expanded={expandAgents}
                >
                  <span className={`wb-perf-chevron ${expandAgents ? 'expanded' : ''}`}>&#9656;</span>
                  <span className="wb-perf-section-title">{t('performance.groupAiAgents')}</span>
                  <span className="wb-perf-section-meta">
                    {snapshot.aiAgents.activeCount} {t('performance.instances')} &bull;{' '}
                    {snapshot.aiAgents.totalCpuPercent}% CPU &bull;{' '}
                    {formatBytes(snapshot.aiAgents.totalPssBytes)} PSS
                  </span>
                </button>

                {expandAgents && (
                  <div className="wb-perf-subgroups">
                    {snapshot.aiAgents.groups.length === 0 ? (
                      <p className="wb-perf-empty">{t('performance.noAgentsRunning')}</p>
                    ) : (
                      snapshot.aiAgents.groups.map((group) => (
                        <div key={`agent-grp-${group.provider}`} className="wb-perf-subgroup">
                          <div className="wb-perf-subgroup-header">
                            <span className="wb-perf-provider-tag">{group.providerLabel}</span>
                            <span className="wb-perf-subgroup-meta">
                              {group.instanceCount} {t('performance.active')} &bull;{' '}
                              {group.totalCpuPercent}% CPU &bull;{' '}
                              {formatBytes(group.totalPssBytes)} PSS
                            </span>
                          </div>

                          <div className="wb-perf-instances-list">
                            {group.instances.map((inst) => {
                              const isExpanded = !!expandedAgentTerminals[inst.terminalId];
                              return (
                                <div key={`agent-inst-${inst.terminalId}`} className="wb-perf-instance-card">
                                  <div
                                    className="wb-perf-instance-row"
                                    onClick={() => toggleAgentTerminal(inst.terminalId)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        toggleAgentTerminal(inst.terminalId);
                                      }
                                    }}
                                  >
                                    <span className={`wb-perf-chevron-sm ${isExpanded ? 'expanded' : ''}`}>&#9656;</span>
                                    <span className="wb-perf-instance-title">{inst.title}</span>
                                    <span className="wb-perf-instance-pids">
                                      Root PID {inst.rootPid} ({inst.pids.length} procs)
                                    </span>
                                    <span className="wb-perf-instance-metrics">
                                      {inst.cpuPercent}% CPU &bull; {formatBytes(inst.pssBytes)} PSS
                                    </span>
                                  </div>

                                  {isExpanded && (
                                    <div className="wb-perf-instance-details">
                                      <table className="wb-perf-table wb-perf-subtable">
                                        <thead>
                                          <tr>
                                            <th>Subprocess</th>
                                            <th>PID</th>
                                            <th>CPU</th>
                                            <th>PSS</th>
                                            <th>Private</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {inst.processes.map((p) => (
                                            <tr key={`agent-proc-${p.pid}`}>
                                              <td className="wb-perf-td-name">{p.name}</td>
                                              <td className="wb-perf-td-mono">{p.pid}</td>
                                              <td className="wb-perf-td-mono">{p.cpuPercent}%</td>
                                              <td className="wb-perf-td-mono">{formatBytes(p.pssBytes)}</td>
                                              <td className="wb-perf-td-mono">{formatBytes(p.privateBytes)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>

              {/* Group 3: Embedded Browser Views */}
              <section className="wb-perf-section">
                <button
                  type="button"
                  className="wb-perf-section-toggle"
                  onClick={() => setExpandBrowsers(!expandBrowsers)}
                  aria-expanded={expandBrowsers}
                >
                  <span className={`wb-perf-chevron ${expandBrowsers ? 'expanded' : ''}`}>&#9656;</span>
                  <span className="wb-perf-section-title">{t('performance.groupBrowsers')}</span>
                  <span className="wb-perf-section-meta">
                    {snapshot.browserViews.totalCount} {t('performance.tabs')} ({snapshot.browserViews.activeCount} {t('performance.active')}, {snapshot.browserViews.suspendedCount} {t('performance.hibernated')}) &bull;{' '}
                    {snapshot.browserViews.totalCpuPercent}% CPU &bull;{' '}
                    {formatBytes(snapshot.browserViews.totalPssBytes)} PSS
                  </span>
                </button>

                {expandBrowsers && (
                  <div className="wb-perf-table-wrapper">
                    <BrowserLifecycleSummary browser={snapshot.browser} />
                    {snapshot.browserViews.views.length === 0 ? (
                      <p className="wb-perf-empty">{t('performance.noBrowsersOpen')}</p>
                    ) : (
                      <table className="wb-perf-table">
                        <thead>
                          <tr>
                            <th>Tab</th>
                            <th>Status</th>
                            <th>PID</th>
                            <th>CPU</th>
                            <th>PSS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.browserViews.views.map((view) => (
                            <tr key={`view-${view.id}`}>
                              <td className="wb-perf-td-name">
                                <span className="wb-perf-browser-badge">{view.providerLabel}</span>
                                <span className="wb-perf-tab-url" title={view.url}>
                                  {view.url ? view.url.replace(/^https?:\/\//, '').slice(0, 32) : 'Untitled'}
                                </span>
                              </td>
                              <td>
                                <span className={`wb-perf-lifecycle-badge ${view.lifecycle}`}>
                                  {view.lifecycle === 'active' ? t('performance.active') : view.lifecycle === 'background' ? t('performance.background') : t('performance.hibernated')}
                                </span>
                                {view.isSharedRenderer && (
                                  <span
                                    className="wb-perf-shared-badge"
                                    title={t('performance.sharedAllocationTooltip', { count: view.sharedTabCount, pid: view.rendererPid ?? '-' })}
                                  >
                                    {t('performance.sharedAllocation')} ({view.sharedTabCount})
                                  </span>
                                )}
                              </td>
                              <td className="wb-perf-td-mono">{view.rendererPid ?? '-'}</td>
                              <td
                                className="wb-perf-td-mono"
                                title={view.isSharedRenderer ? t('performance.sharedAllocationTooltip', { count: view.sharedTabCount, pid: view.rendererPid ?? '-' }) : undefined}
                              >
                                {view.isSharedRenderer ? `~${view.cpuPercent}%` : `${view.cpuPercent}%`}
                              </td>
                              <td
                                className="wb-perf-td-mono"
                                title={view.isSharedRenderer ? t('performance.sharedAllocationTooltip', { count: view.sharedTabCount, pid: view.rendererPid ?? '-' }) : undefined}
                              >
                                {view.isSharedRenderer ? `~${formatBytes(view.pssBytes)}` : formatBytes(view.pssBytes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {snapshot.browserViews.views.some((v) => v.isSharedRenderer) && (
                      <div className="wb-perf-shared-notice">
                        {t('performance.sharedRendererNote')}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Group 4: Other Terminals */}
              <section className="wb-perf-section">
                <button
                  type="button"
                  className="wb-perf-section-toggle"
                  onClick={() => setExpandTerminals(!expandTerminals)}
                  aria-expanded={expandTerminals}
                >
                  <span className={`wb-perf-chevron ${expandTerminals ? 'expanded' : ''}`}>&#9656;</span>
                  <span className="wb-perf-section-title">{t('performance.groupTerminals')}</span>
                  <span className="wb-perf-section-meta">
                    {snapshot.otherTerminals.count} {t('performance.shells')} &bull;{' '}
                    {snapshot.otherTerminals.totalCpuPercent}% CPU &bull;{' '}
                    {formatBytes(snapshot.otherTerminals.totalPssBytes)} PSS
                  </span>
                </button>

                {expandTerminals && (
                  <div className="wb-perf-table-wrapper">
                    {snapshot.otherTerminals.terminals.length === 0 ? (
                      <p className="wb-perf-empty">{t('performance.noOtherTerminals')}</p>
                    ) : (
                      <table className="wb-perf-table">
                        <thead>
                          <tr>
                            <th>Terminal</th>
                            <th>Shell</th>
                            <th>PID</th>
                            <th>CPU</th>
                            <th>PSS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.otherTerminals.terminals.map((term) => (
                            <tr key={`term-${term.terminalId}`}>
                              <td className="wb-perf-td-name">{term.title}</td>
                              <td className="wb-perf-td-mono">{term.shell}</td>
                              <td className="wb-perf-td-mono">{term.rootPid}</td>
                              <td className="wb-perf-td-mono">{term.cpuPercent}%</td>
                              <td className="wb-perf-td-mono">{formatBytes(term.pssBytes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
