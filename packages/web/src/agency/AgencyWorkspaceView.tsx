import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { TerminalView } from '../TerminalView.js';
import { useConversation } from '../useConversation.js';
import { Terminal } from '@xterm/xterm';
import {
  agentSession, canLaunchAgent, currentSession, isAttention, latestSession, workspaceLayout,
} from './model.js';
import type { useAgencyStore } from './useAgencyStore.js';
import type { AgencyTransport } from './model.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  connection: AgentConnection;
  request: ReturnType<typeof useAgencyStore>['request'];
  sendImmediate: AgencyTransport['sendImmediate'];
  online: boolean;
  draft?: string;
  onDraft?: (value: string) => void;
  onDelivered?: (value: string) => void;
  onDone: () => void;
  launchError?: string | null;
  onClearLaunchError?: () => void;
}

const SPLIT_STORAGE_KEY = 'agency-ui.split-ratio.v1';

export function AgencyWorkspaceView({
  workspace, profiles, sessions, connection, request, sendImmediate, online,
  onDone, launchError, onClearLaunchError,
}: Props): JSX.Element {
  const activeAgent = agentSession(currentSession(sessions, workspace.id, 'agent'));
  const activeShell = currentSession(sessions, workspace.id, 'terminal');
  const pastAgent = agentSession(latestSession(sessions, workspace.id, 'agent'));
  const resumeAgent = pastAgent?.nativeSessionId ? pastAgent : agentSession([...sessions].reverse().find(item => item.workspaceId === workspace.id && item.kind === 'agent' && item.nativeSessionId !== null));
  const recoverySource = [...sessions].reverse().find(item => item.workspaceId === workspace.id && item.recovery?.status === 'manual');
  const retryResume = useRef(false);
  const agent = activeAgent;

  const [profileId, setProfileId] = useState<CliProfileId | ''>(() =>
    pastAgent?.profileId ?? profiles.find(canLaunchAgent)?.id ?? profiles[0]?.id ?? '');
  const effectiveProfileId = profileId || pastAgent?.profileId || profiles.find(canLaunchAgent)?.id || profiles[0]?.id || '';

  useEffect(() => {
    if (!profileId && effectiveProfileId) {
      setProfileId(effectiveProfileId);
    }
  }, [profileId, effectiveProfileId]);

  const [sessionError, setSessionError] = useState<string | null>(null);
  const [shellStarting, setShellStarting] = useState(false);
  const [agentStarting, setAgentStarting] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);

  // Copy dropdown menus state
  const [copyMenuAgent, setCopyMenuAgent] = useState(false);
  const [copyMenuShell, setCopyMenuShell] = useState(false);

  // Terminal instances
  const agentTerminalRef = useRef<Terminal | null>(null);
  const shellTerminalRef = useRef<Terminal | null>(null);

  // Split resize state
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(SPLIT_STORAGE_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0.2 && parsed <= 0.8) return parsed;
      }
    } catch { /* storage optional */ }
    return 0.6;
  });
  const [draggingSplit, setDraggingSplit] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const profile = profiles.find((item) => item.id === (agent?.profileId ?? effectiveProfileId));
  const agentTerminalId = agent?.terminalId ?? null;
  const pastShell = latestSession(sessions, workspace.id, 'terminal');
  const shellTerminalId = activeShell?.terminalId ?? null;
  const feed = useConversation(connection, agentTerminalId);
  const hasAgent = !!(agent ?? pastAgent);
  const hasShell = !!activeShell;
  const layout = workspaceLayout(hasAgent || addingAgent, hasShell);
  const [view, setView] = useState<'cli' | 'terminal' | 'split'>(() => {
    try {
      const saved = localStorage.getItem('agency-ui.view.' + workspace.id);
      if (saved === 'terminal' || saved === 'split') return saved;
    } catch {}
    return 'cli';
  });
  const hasBoth = layout === 'combined' && view === 'split';
  useEffect(() => {
    try { localStorage.setItem('agency-ui.view.' + workspace.id, view); } catch {}
    setCopyMenuAgent(false); setCopyMenuShell(false);
  }, [view, workspace.id]);

  const workspaceStatus = useMemo(() => {
    if (agent) return agencySessionText(agent);
    if (activeShell) return agencySessionText(activeShell);
    return t('agency.ui.ready');
  }, [agent, activeShell]);

  async function launchAgent(resume = false) {
    retryResume.current = resume;
    const launchProfile = resume ? profiles.find(item => item.id === resumeAgent?.profileId) : profile;
    if (!launchProfile || !canLaunchAgent(launchProfile) || (resume && (!resumeAgent?.nativeSessionId || !launchProfile.capabilities.canResumeNativeSession)) || agent || !online) {
      setSessionError(t('agency.ui.agentProfileIsUnavailable'));
      return;
    }
    setAgentStarting(true);
    setSessionError(null);
    onClearLaunchError?.();
    try {
      const answer = await request({
        type: 'agency.session.create',
        workspaceId: workspace.id,
        kind: 'agent',
        profileId: launchProfile.id,
        ...(resume && resumeAgent?.nativeSessionId ? { resumeNativeSessionId: resumeAgent.nativeSessionId } : {}),
        cols: 100,
        rows: 30,
      });
      if (answer.type !== 'agency.session.created') {
        throw new Error(t('agency.ui.noAgentSessionAcknowledgement'));
      }
      setAddingAgent(false);
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : t('agency.ui.workspaceCreationFailed'));
    } finally {
      setAgentStarting(false);
    }
  }

  async function launchShell() {
    if (hasShell || shellStarting || !online) return;
    setSessionError(null);
    setShellStarting(true);
    try {
      const answer = await request({
        type: 'agency.session.create',
        workspaceId: workspace.id,
        kind: 'terminal',
        cols: 100,
        rows: 30,
      });
      if (answer.type !== 'agency.session.created') {
        throw new Error(t('agency.ui.noShellSessionAcknowledgement'));
      }
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : t('agency.ui.shellLaunchFailed'));
    } finally {
      setShellStarting(false);
    }
  }

  function interruptAgent() {
    if (agent?.terminalId && online) {
      sendImmediate({ type: 'agent.interrupt', terminalId: agent.terminalId });
    }
  }

  function interruptShell() {
    if (activeShell?.terminalId && online) {
      connection.send({ type: 'input', terminalId: activeShell.terminalId, data: '\x03' });
    }
  }

  function stop(terminalId: string | null) {
    if (!terminalId || !online) return;
    if (!sendImmediate({ type: 'terminal.close', terminalId })) {
      setSessionError(t('agency.ui.stopWasNotSentReconnectAndVerifyThe'));
    }
  }

  async function copySelection(term: Terminal | null) {
    if (!term) return;
    const text = term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyAll(term: Terminal | null) {
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
      lines.pop();
    }
    const text = lines.join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyLastAssistantMessage() {
    const assistantTurns = feed.events.filter((e) => e.role === 'assistant');
    const lastTurn = assistantTurns[assistantTurns.length - 1];
    if (lastTurn) {
      const text = lastTurn.parts
        .filter((p) => p.kind === 'text')
        .map((p) => (p as { text: string }).text)
        .join('\n');
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch (err) {
          setSessionError(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  async function copyLastOutput(term: Terminal | null) {
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
      lines.pop();
    }
    const text = lines.slice(-60).join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  }

  const startSplitDrag = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setDraggingSplit(true);
    const container = contentRef.current;
    if (!container) return;

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(0.2, Math.min(0.8, ratio));
      setSplitRatio(clamped);
    };

    const onPointerUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setDraggingSplit(false);
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) {
        const ratio = (e.clientX - rect.left) / rect.width;
        const clamped = Math.max(0.2, Math.min(0.8, ratio));
        setSplitRatio(clamped);
        try {
          localStorage.setItem(SPLIT_STORAGE_KEY, clamped.toString());
        } catch { /* storage optional */ }
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, []);

  function handleSplitKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSplitRatio((prev) => {
        const next = Math.max(0.2, prev - 0.02);
        try { localStorage.setItem(SPLIT_STORAGE_KEY, next.toString()); } catch {}
        return next;
      });
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSplitRatio((prev) => {
        const next = Math.min(0.8, prev + 0.02);
        try { localStorage.setItem(SPLIT_STORAGE_KEY, next.toString()); } catch {}
        return next;
      });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplitRatio(0.5);
      try { localStorage.setItem(SPLIT_STORAGE_KEY, '0.5'); } catch {}
    }
  }

  const activeLaunchError = launchError || sessionError;

  return (
    <section className="agency-workspace-view" aria-label={t('agency.ui.workspaceNamed', { name: workspace.name })}>
      <header className="agency-workspace-header">
        <div className="agency-view-tabs" role="group" aria-label={t('agency.ui.sessionViews')}>
          <button type="button" aria-pressed={view === 'cli'} onClick={() => setView('cli')}>{t('agency.ui.cliTab')}</button>
          <button type="button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')}>{t('agency.ui.terminalTab')}</button>
          {hasAgent && hasShell && <button type="button" aria-pressed={view === 'split'} onClick={() => setView('split')}>{t('agency.ui.splitView')}</button>}
        </div>
        <span className="agency-live-status" aria-label={t('agency.ui.statusNamed', { status: workspaceStatus })}>
          <span className={'agency-status-dot ' + (agent && isAttention(agent.activity) ? 'attention' : agent?.activity === 'working' ? 'working' : 'idle')} />{workspaceStatus}
        </span>
        <button type="button" className="agency-secondary-button" onClick={onDone}>{t('agency.ui.markDone')}</button>
      </header>

      {activeLaunchError && (
        <div role="alert" className="agency-error-bar">
          <span>{t('agency.ui.launchFailed', { error: activeLaunchError })}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="button" className="agency-secondary-button" onClick={() => void launchAgent(retryResume.current)}>
              {t('agency.ui.retryLaunch')}
            </button>
            <button type="button" onClick={() => { setSessionError(null); onClearLaunchError?.(); }} aria-label={t('agency.ui.dismissError')}>×</button>
          </div>
        </div>
      )}

      <div
        ref={contentRef}
        className={'agency-workspace-content' + (hasBoth ? ' agency-content-split' : '') + (draggingSplit ? ' agency-dragging-split' : '')}
      >
        {true && (
          <main
            className="agency-agent-pane"
            hidden={view === 'terminal'}
            style={hasBoth ? { flex: `0 0 ${splitRatio * 100}%` } : undefined}
          >
            <div className="agency-pane-bar">
              <span className="agency-pane-label">{profile?.label ?? t('agency.ui.agentLabel')}</span>
              {agent && <span className="agency-muted agency-pane-status">{agencySessionText(agent)}</span>}
              <span className="agency-flex-spacer" />

              {/* Copy dropdown */}
              {agentTerminalId && (
                <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="agency-text-button"
                    aria-haspopup="true"
                    aria-expanded={copyMenuAgent}
                    onClick={() => setCopyMenuAgent(!copyMenuAgent)}
                  >
                    {t('agency.ui.copy')} ▾
                  </button>
                  {copyMenuAgent && (
                    <div className="agency-dropdown-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="agency-dropdown-item"
                        onClick={() => {
                          setCopyMenuAgent(false);
                          void copySelection(agentTerminalRef.current);
                        }}
                      >
                        {t('agency.ui.copySelection')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="agency-dropdown-item"
                        onClick={() => {
                          setCopyMenuAgent(false);
                          void copyAll(agentTerminalRef.current);
                        }}
                      >
                        {t('agency.ui.copyAll')}
                      </button>
                      {feed.events.some((e) => e.role === 'assistant') ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="agency-dropdown-item"
                          onClick={() => {
                            setCopyMenuAgent(false);
                            void copyLastAssistantMessage();
                          }}
                        >
                          {t('agency.ui.copyLastMessage')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="agency-dropdown-item"
                          onClick={() => {
                            setCopyMenuAgent(false);
                            void copyLastOutput(agentTerminalRef.current);
                          }}
                        >
                          {t('agency.ui.copyLastOutput')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Explicit Interrupt Action */}
              {agentTerminalId && (
                <button
                  type="button"
                  className="agency-text-button"
                  title={t('agency.ui.interrupt')}
                  onClick={interruptAgent}
                  disabled={!online}
                >
                  {t('agency.ui.interrupt')}
                </button>
              )}

              {!hasShell && (
                <button
                  type="button"
                  className="agency-text-button"
                  disabled={!online || shellStarting}
                  onClick={() => void launchShell()}
                >
                  {shellStarting ? t('agency.ui.startingShell') : t('agency.ui.addShell')}
                </button>
              )}

              {agent?.terminalId && (
                <button
                  className="agency-text-button agency-text-danger"
                  type="button"
                  onClick={() => stop(agent.terminalId)}
                >
                  {t('agency.ui.stopAgent')}
                </button>
              )}
            </div>

            <div className="agency-agent-body">
              {agentTerminalId ? (
                <div className="agency-xterm-host">
                  <TerminalView
                    key={agentTerminalId}
                    terminalId={agentTerminalId}
                    connection={connection}
                    theme="dark"
                    active={view !== 'terminal'}
                    autoFocus
                    enableAgencyShortcuts
                    onTerminalInstance={(inst) => { agentTerminalRef.current = inst; }}
                    onClipboardError={(err) => setSessionError(err.message)}
                  />
                </div>
              ) : (
                <div className="agency-shell-placeholder">
                  <p>{pastAgent ? (pastAgent.exitCode === null ? t('agency.ui.previousAgentExited') : t('agency.ui.previousAgentExitedCode', { code: pastAgent.exitCode })) : t('agency.ui.noSession')}</p>
                  <span>{recoverySource?.recovery?.message ?? pastAgent?.recovery?.message ?? t('agency.ui.readyWhenYouAre')}</span>
                  {resumeAgent?.nativeSessionId && profiles.find(p => p.id === resumeAgent.profileId)?.capabilities.canResumeNativeSession && <button type="button" className="agency-secondary-button" disabled={!online || agentStarting} onClick={() => void launchAgent(true)}>{t('agency.ui.resumeNative')}</button>}
                  {profiles.length > 0 && (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <select
                        value={profileId}
                        onChange={(e) => setProfileId(e.target.value as CliProfileId)}
                        disabled={agentStarting}
                        style={{ padding: '6px 10px', background: 'var(--agency-raised)', border: '1px solid var(--agency-line)', borderRadius: '6px' }}
                      >
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="agency-primary-button"
                        disabled={!online || agentStarting}
                        onClick={() => void launchAgent()}
                      >
                        {agentStarting ? t('agency.ui.startingInProgress') : t('agency.ui.startCLI')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </main>
        )}

        {/* Resizable vertical divider between agent and shell */}
        {hasBoth && (
          <div
            className={'agency-pane-divider' + (draggingSplit ? ' active' : '')}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('agency.ui.splitResizer')}
            onPointerDown={startSplitDrag}
            onKeyDown={handleSplitKeyDown}
          />
        )}

        {true && (
          <aside
            className={'agency-shell-pane' + (!hasAgent ? ' agency-shell-primary' : '')}
            hidden={view === 'cli'}
            style={hasBoth ? { flex: '1 1 0%' } : undefined}
          >
            <div className="agency-pane-bar">
              <span className="agency-pane-label">{t('agency.ui.shell')}</span>
              {activeShell && <span className="agency-muted agency-pane-status">{agencySessionText(activeShell)}</span>}
              <span className="agency-flex-spacer" />

              {/* Copy dropdown */}
              {shellTerminalId && (
                <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="agency-text-button"
                    aria-haspopup="true"
                    aria-expanded={copyMenuShell}
                    onClick={() => setCopyMenuShell(!copyMenuShell)}
                  >
                    {t('agency.ui.copy')} ▾
                  </button>
                  {copyMenuShell && (
                    <div className="agency-dropdown-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="agency-dropdown-item"
                        onClick={() => {
                          setCopyMenuShell(false);
                          void copySelection(shellTerminalRef.current);
                        }}
                      >
                        {t('agency.ui.copySelection')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="agency-dropdown-item"
                        onClick={() => {
                          setCopyMenuShell(false);
                          void copyAll(shellTerminalRef.current);
                        }}
                      >
                        {t('agency.ui.copyAll')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="agency-dropdown-item"
                        onClick={() => {
                          setCopyMenuShell(false);
                          void copyLastOutput(shellTerminalRef.current);
                        }}
                      >
                        {t('agency.ui.copyLastOutput')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Explicit Interrupt Action */}
              {shellTerminalId && (
                <button
                  type="button"
                  className="agency-text-button"
                  title={t('agency.ui.interrupt')}
                  onClick={interruptShell}
                  disabled={!online}
                >
                  {t('agency.ui.interrupt')}
                </button>
              )}

              {!hasAgent && !addingAgent && (
                <button type="button" className="agency-text-button" onClick={() => setAddingAgent(true)}>
                  {t('agency.ui.agent')}
                </button>
              )}

              {shellTerminalId && (
                <button
                  type="button"
                  className="agency-text-button agency-text-danger"
                  onClick={() => stop(shellTerminalId)}
                >
                  {t('agency.ui.stopShell')}
                </button>
              )}
            </div>

            <div className="agency-agent-body">
              {shellTerminalId ? (
                <div className="agency-xterm-host">
                  <TerminalView
                    key={shellTerminalId}
                    terminalId={shellTerminalId}
                    connection={connection}
                    theme="dark"
                    active={view !== 'cli'}
                    autoFocus
                    enableAgencyShortcuts
                    onTerminalInstance={(inst) => { shellTerminalRef.current = inst; }}
                    onClipboardError={(err) => setSessionError(err.message)}
                  />
                </div>
              ) : (
                <div className="agency-shell-placeholder">
                  <p>{pastShell ? (pastShell.exitCode === null ? t('agency.ui.previousAgentExited') : t('agency.ui.previousAgentExitedCode', { code: pastShell.exitCode })) : t('agency.ui.independentTerminal')}</p>
                  <span>{t('agency.ui.useTheExistingWorkspaceDirectoryWithNativeShell')}</span>
                  <button
                    type="button"
                    className="agency-secondary-button"
                    disabled={!online || shellStarting}
                    onClick={() => void launchShell()}
                  >
                    {shellStarting ? t('agency.ui.startingInProgress') : t('agency.ui.startTerminal')}
                  </button>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {pastAgent && !agent && (
        <p className="agency-session-ended">
          {pastAgent.exitCode === null
            ? t('agency.ui.previousAgentExited') + '. ' + t('agency.ui.historyRemainsOnTheServer')
            : t('agency.ui.previousAgentExitedCode', { code: pastAgent.exitCode })}
        </p>
      )}
    </section>
  );
}
