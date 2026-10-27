import { t } from '../i18n/index.js';
import { agencyActivityText } from './agency-labels.js';
import { useMemo, useState } from 'react';
import type {
  AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId, TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { TerminalView } from '../TerminalView.js';
import { useConversation } from '../useConversation.js';
import { AgencyComposer } from './AgencyComposer.js';
import { AgencyTranscript } from './AgencyTranscript.js';
import { agentSession, canLaunchAgent, currentSession, isAttention, latestSession, workspaceLayout } from './model.js';
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
  draft: string;
  onDraft: (value: string) => void;
  onDelivered: (value: string) => void;
  onDone: () => void;
}

function AgentTerminal({ terminalId, connection }: { terminalId: TerminalId; connection: AgentConnection }) {
  return <div className="agency-xterm-host"><TerminalView key={terminalId} connection={connection}
    terminalId={terminalId} theme="dark" active autoFocus /></div>;
}

export function AgencyWorkspaceView({
  workspace, profiles, sessions, connection, request, sendImmediate, online, draft, onDraft, onDelivered, onDone,
}: Props): JSX.Element {
  const activeAgent = agentSession(currentSession(sessions, workspace.id, 'agent'));
  const activeShell = currentSession(sessions, workspace.id, 'terminal');
  const pastAgent = agentSession(latestSession(sessions, workspace.id, 'agent'));
  const agent = activeAgent;
  const [profileId, setProfileId] = useState<CliProfileId | ''>(() =>
    pastAgent?.profileId ?? profiles.find(canLaunchAgent)?.id ?? '');
  const [choice, setChoice] = useState<{ model: string | null; effort: string | null }>({ model: null, effort: null });
  const [showNative, setShowNative] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [shellStarting, setShellStarting] = useState(false);
  const feed = useConversation(connection, (agent ?? pastAgent)?.terminalId ?? null);
  const profile = profiles.find((item) => item.id === (agent?.profileId ?? profileId));
  const model = agent?.selectedModel ?? choice.model;
  const effort = agent?.selectedEffort ?? choice.effort;

  const agentTerminalId = (agent ?? pastAgent)?.terminalId ?? null;
  const shellTerminalId = activeShell?.terminalId ?? null;
  const hasAgent = !!(agent ?? pastAgent);
  const hasShell = !!activeShell;
  const layout = workspaceLayout(hasAgent || addingAgent, hasShell);
  const hasBoth = layout === 'combined';
  // Native PTY first until a provider produces real structured events.
  const nativeFallback = !!agent?.terminalId && feed.events.length === 0;
  const nativeView = !!agentTerminalId && (showNative || nativeFallback);

  const workspaceStatus = useMemo(() => {
    if (agent) return agencyActivityText(agent.activity, agent.lifecycle);
    if (activeShell) return agencyActivityText(activeShell.activity, activeShell.lifecycle);
    return t('agency.ui.ready');
  }, [agent, activeShell]);

  async function launchAgent() {
    if (!profile || !canLaunchAgent(profile) || agent || !online) throw new Error(t('agency.ui.agentProfileIsUnavailable'));
    const selected = choice.model;
    const modelOption = profile.capabilities.models.find((item) => item.id === selected);
    if (selected && (!profile.capabilities.canSelectModel || !modelOption)) {
      throw new Error(t('agency.ui.theSelectedModelIsNotVerifiedForThis'));
    }
    if (choice.effort && (!profile.capabilities.canSelectEffort ||
      !modelOption?.effortOptions.includes(choice.effort))) {
      throw new Error(t('agency.ui.theSelectedReasoningEffortIsUnsupported'));
    }
    const answer = await request({
      type: 'agency.session.create', workspaceId: workspace.id,
      kind: 'agent', profileId: profile.id, cols: 100, rows: 30,
      ...(selected ? { model: selected } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
    });
    if (answer.type !== 'agency.session.created') throw new Error(t('agency.ui.noAgentSessionAcknowledgement'));
    setShowNative(true);
  }

  async function launchShell() {
    if (hasShell || shellStarting || !online) return;
    setSessionError(null);
    setShellStarting(true);
    try {
      const answer = await request({ type: 'agency.session.create', workspaceId: workspace.id,
        kind: 'terminal', cols: 100, rows: 30 });
      if (answer.type !== 'agency.session.created') throw new Error(t('agency.ui.noShellSessionAcknowledgement'));
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : t('agency.ui.shellLaunchFailed'));
    } finally {
      setShellStarting(false);
    }
  }

  async function selectModel(nextModel: string | null, nextEffort: string | null) {
    if (!agent) { setChoice({ model: nextModel, effort: nextEffort }); return; }
    const answer = await request({
      type: 'agency.session.selection.set', sessionId: agent.id, model: nextModel, effort: nextEffort,
    });
    if (answer.type !== 'agency.session.selection') throw new Error(t('agency.ui.selectionNotConfirmedByOriginalCLI'));
  }

  async function submitPrompt(text: string) {
    const terminalId = agent?.terminalId ?? null;
    if (!terminalId || !online || agent?.lifecycle !== 'running') {
      throw new Error(t('agency.ui.startTheAgentAndReconnectBeforeSending'));
    }
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        off();
        if (error) reject(error); else resolve();
      };
      const off = connection.onMessage((message) => {
        if (message.type !== 'agent.submitted' || message.requestId !== requestId ||
            message.terminalId !== terminalId) return;
        finish(message.delivered ? undefined : new Error(t('agency.ui.cLIDidNotConfirmDeliveryYourDraftIs')));
      });
      const timer = window.setTimeout(() =>
        finish(new Error(t('agency.ui.deliveryNotConfirmedCheckTheCLIBeforeResending'))), 15000);
      try {
        const sent = sendImmediate({ type: 'agent.submit', terminalId, text, images: [], requestId });
        if (!sent) finish(new Error(t('agency.ui.transportDidNotSendImmediatelyCheckTheCLI')));
      } catch (reason) { finish(reason instanceof Error ? reason : new Error(t('agency.ui.unableToSend'))); }
    });
    onDelivered(text);
  }

  function stop(terminalId: string | null) {
    if (!terminalId || !online) return;
    // Explicit user action only. Done, navigation and socket disconnect never call this.
    if (!sendImmediate({ type: 'terminal.close', terminalId })) {
      setSessionError(t('agency.ui.stopWasNotSentReconnectAndVerifyThe'));
    }
  }

  return (
    <section className="agency-workspace-view" aria-label={t('agency.ui.workspaceNamed', { name: workspace.name })}>
      <header className="agency-workspace-header">
        <div className="agency-workspace-heading">
          <div className="agency-crumbs">{t('agency.ui.workspace')}<span>/</span> <strong>{workspace.name}</strong></div>
          <div className="agency-path" title={workspace.cwd}>{workspace.cwd}</div>
        </div>
        <span className="agency-live-status" aria-label={t('agency.ui.statusNamed', { status: workspaceStatus })}>
          <span className={'agency-status-dot ' + (agent && isAttention(agent.activity) ? 'attention' : agent?.activity === 'working' ? 'working' : 'idle')} />{workspaceStatus}
        </span>
        <button type="button" className="agency-secondary-button" onClick={onDone}>{t('agency.ui.markDone')}</button>
      </header>
      <div className={'agency-workspace-content' + (hasBoth ? ' agency-content-split' : '')}>
        {(hasAgent || !hasShell || addingAgent) && (
          <main className="agency-agent-pane">
            <div className="agency-pane-bar">
              <span className="agency-pane-label">{profile?.label ?? t('agency.ui.agentLabel')}</span>
              {agent && <span className="agency-muted agency-pane-status">{agencyActivityText(agent.activity, agent.lifecycle)}</span>}
              <span className="agency-flex-spacer" />
              {agentTerminalId && (
                <button type="button" className={'agency-text-button' + (showNative ? ' selected' : '')}
                  onClick={() => setShowNative(!nativeView)} aria-pressed={nativeView} disabled={nativeFallback}>
                  {nativeView && !nativeFallback ? t('agency.ui.conversation') : t('agency.ui.nativeCLI')}
                </button>
              )}
              {!hasShell && <button type="button" className="agency-text-button" disabled={!online || shellStarting}
                onClick={() => void launchShell()}>{shellStarting ? t('agency.ui.startingShell') : t('agency.ui.addShell')}</button>}
              {agent?.terminalId && <button className="agency-text-button agency-text-danger" type="button"
                onClick={() => stop(agent.terminalId)}>{t('agency.ui.stopAgent')}</button>}
            </div>
            <div className="agency-agent-body">
              {nativeView && agentTerminalId ? <AgentTerminal terminalId={agentTerminalId} connection={connection} /> :
                <AgencyTranscript events={feed.events} onOpenCli={() => setShowNative(true)} />}
            </div>
            <AgencyComposer draft={draft} onDraft={onDraft} profiles={profiles} profileId={profileId}
              onProfile={(id) => { setProfileId(id); setChoice({ model: null, effort: null }); }} agent={agent} selectedModel={model} selectedEffort={effort}
              onSelection={selectModel} onLaunch={launchAgent} onSubmit={submitPrompt}
              onConfigureProfile={async (selectedProfile, executable, args) => {
                const result = await request({ type: 'agency.profile.configure', profileId: selectedProfile.id, executable, args });
                if (result.type !== 'agency.profile.configured') throw new Error(t('agency.ui.profileSettingsWereNotConfirmed'));
              }}
              onInterrupt={() => {
                if (agent?.terminalId && online) sendImmediate({ type: 'agent.interrupt', terminalId: agent.terminalId });
              }} online={online} />
          </main>
        )}
        {hasShell && (
          <aside className={'agency-shell-pane' + (!hasAgent ? ' agency-shell-primary' : '')}>
            <div className="agency-pane-bar">
              <span className="agency-pane-label">{t('agency.ui.shell')}</span>
              <span className="agency-flex-spacer" />
              {!hasAgent && !addingAgent && <button type="button" className="agency-text-button"
                onClick={() => setAddingAgent(true)}>{t('agency.ui.agent')}</button>}
              {shellTerminalId && <button type="button" className="agency-text-button agency-text-danger"
                onClick={() => stop(shellTerminalId)}>{t('agency.ui.stopShell')}</button>}
            </div>
            {shellTerminalId ? <AgentTerminal terminalId={shellTerminalId} connection={connection} /> : (
              <div className="agency-shell-placeholder">
                <p>{t('agency.ui.independentTerminal')}</p>
                <span>{t('agency.ui.useTheExistingWorkspaceDirectoryWithNativeShell')}</span>
                <button type="button" className="agency-secondary-button" disabled={!online || shellStarting}
                  onClick={() => void launchShell()}>{shellStarting ? t('agency.ui.startingInProgress') : t('agency.ui.openShell')}</button>
              </div>
            )}
          </aside>
        )}
      </div>
      {sessionError && <div role="alert" className="agency-error-bar">{sessionError}</div>}
      {pastAgent && !agent && <p className="agency-session-ended">
        {pastAgent.exitCode === null
          ? t('agency.ui.previousAgentExited') + '. ' + t('agency.ui.historyRemainsOnTheServer')
          : t('agency.ui.previousAgentExitedCode', { code: pastAgent.exitCode })}
      </p>}
    </section>
  );
}
