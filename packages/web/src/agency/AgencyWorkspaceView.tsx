import { useMemo, useState } from 'react';
import type {
  AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId, TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { TerminalView } from '../TerminalView.js';
import { useConversation } from '../useConversation.js';
import { AgencyComposer } from './AgencyComposer.js';
import { AgencyTranscript } from './AgencyTranscript.js';
import { activityLabel, agentSession, canLaunchAgent, currentSession, latestSession } from './model.js';
import type { useAgencyStore } from './useAgencyStore.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  connection: AgentConnection;
  request: ReturnType<typeof useAgencyStore>['request'];
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
  workspace, profiles, sessions, connection, request, online, draft, onDraft, onDelivered, onDone,
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
  const profile = profiles.find((item) => item.id === (agent?.profileId ?? pastAgent?.profileId ?? profileId));
  const model = agent?.selectedModel ?? choice.model;
  const effort = agent?.selectedEffort ?? choice.effort;

  const agentTerminalId = (agent ?? pastAgent)?.terminalId ?? null;
  const shellTerminalId = activeShell?.terminalId ?? null;
  const hasAgent = !!(agent ?? pastAgent);
  const hasShell = !!activeShell;
  const hasBoth = (hasAgent || addingAgent) && hasShell;

  const workspaceStatus = useMemo(() => {
    if (agent) return activityLabel(agent.activity, agent.lifecycle);
    if (activeShell) return activityLabel(activeShell.activity, activeShell.lifecycle);
    return 'Ready';
  }, [agent, activeShell]);

  async function launchAgent() {
    if (!profile || !canLaunchAgent(profile) || agent || !online) throw new Error('Agent profile is unavailable');
    const selected = choice.model;
    const modelOption = profile.capabilities.models.find((item) => item.id === selected);
    if (selected && (!profile.capabilities.canSelectModel || !modelOption)) {
      throw new Error('The selected model is not verified for this CLI');
    }
    if (choice.effort && (!profile.capabilities.canSelectEffort ||
      !modelOption?.effortOptions.includes(choice.effort))) {
      throw new Error('The selected reasoning effort is unsupported');
    }
    const answer = await request({
      type: 'agency.session.create', workspaceId: workspace.id,
      kind: 'agent', profileId: profile.id, cols: 100, rows: 30,
      ...(selected ? { model: selected } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
    });
    if (answer.type !== 'agency.session.created') throw new Error('No agent session acknowledgement');
    setShowNative(false);
  }

  async function launchShell() {
    if (hasShell || shellStarting || !online) return;
    setSessionError(null);
    setShellStarting(true);
    try {
      const answer = await request({ type: 'agency.session.create', workspaceId: workspace.id,
        kind: 'terminal', cols: 100, rows: 30 });
      if (answer.type !== 'agency.session.created') throw new Error('No shell session acknowledgement');
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : 'Shell launch failed');
    } finally {
      setShellStarting(false);
    }
  }

  async function selectModel(nextModel: string | null, nextEffort: string | null) {
    if (!agent) { setChoice({ model: nextModel, effort: nextEffort }); return; }
    const answer = await request({
      type: 'agency.session.selection.set', sessionId: agent.id, model: nextModel, effort: nextEffort,
    });
    if (answer.type !== 'agency.session.selection') throw new Error('Selection not confirmed by original CLI');
  }

  async function submitPrompt(text: string) {
    const terminalId = agent?.terminalId ?? null;
    if (!terminalId || !online || agent?.lifecycle !== 'running') {
      throw new Error('Start the agent and reconnect before sending.');
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
        finish(message.delivered ? undefined : new Error('CLI did not confirm delivery. Your draft is preserved.'));
      });
      const timer = window.setTimeout(() =>
        finish(new Error('Delivery not confirmed. Check the CLI before resending.')), 15000);
      try {
        const sent = connection.send({ type: 'agent.submit', terminalId, text, images: [], requestId });
        if (!sent) finish(new Error('Transport did not send immediately. Check the CLI before resending.'));
      } catch (reason) { finish(reason instanceof Error ? reason : new Error('Unable to send')); }
    });
    onDelivered(text);
  }

  function stop(terminalId: string | null) {
    if (!terminalId || !online) return;
    // Explicit user action only. Done, navigation and socket disconnect never call this.
    connection.send({ type: 'terminal.close', terminalId });
  }

  return (
    <section className="agency-workspace-view" aria-label={'Workspace ' + workspace.name}>
      <header className="agency-workspace-header">
        <div className="agency-workspace-heading">
          <div className="agency-crumbs">Workspace <span>/</span> <strong>{workspace.name}</strong></div>
          <div className="agency-path" title={workspace.cwd}>{workspace.cwd}</div>
        </div>
        <span className="agency-live-status" aria-label={'Status: ' + workspaceStatus}>
          <span className="agency-status-dot idle" />{workspaceStatus}
        </span>
        <button type="button" className="agency-secondary-button" onClick={onDone}>Mark Done</button>
      </header>
      <div className={'agency-workspace-content' + (hasBoth ? ' agency-content-split' : '')}>
        {(hasAgent || !hasShell || addingAgent) && (
          <main className="agency-agent-pane">
            <div className="agency-pane-bar">
              <span className="agency-pane-label">{profile?.label ?? 'Agent'}</span>
              {agent && <span className="agency-muted agency-pane-status">{activityLabel(agent.activity, agent.lifecycle)}</span>}
              <span className="agency-flex-spacer" />
              {agentTerminalId && (
                <button type="button" className={'agency-text-button' + (showNative ? ' selected' : '')}
                  onClick={() => setShowNative(!showNative)} aria-pressed={showNative}>
                  {showNative ? '← Conversation' : 'Native CLI ↗'}
                </button>
              )}
              {!hasShell && <button type="button" className="agency-text-button" disabled={!online || shellStarting}
                onClick={() => void launchShell()}>{shellStarting ? 'Starting shell…' : '+ Shell'}</button>}
              {agent?.terminalId && <button className="agency-text-button agency-text-danger" type="button"
                onClick={() => stop(agent.terminalId)}>Stop agent</button>}
            </div>
            <div className="agency-agent-body">
              {showNative && agentTerminalId ? <AgentTerminal terminalId={agentTerminalId} connection={connection} /> :
                <AgencyTranscript events={feed.events} onOpenCli={() => setShowNative(true)} />}
            </div>
            <AgencyComposer draft={draft} onDraft={onDraft} profiles={profiles} profileId={profileId}
              onProfile={setProfileId} agent={agent} selectedModel={model} selectedEffort={effort}
              onSelection={selectModel} onLaunch={launchAgent} onSubmit={submitPrompt}
              onInterrupt={() => {
                if (agentTerminalId && online) connection.send({ type: 'agent.interrupt', terminalId: agentTerminalId });
              }} online={online} />
          </main>
        )}
        {(hasShell || (!hasAgent && !hasShell)) && (
          <aside className={'agency-shell-pane' + (!hasAgent ? ' agency-shell-primary' : '')}>
            <div className="agency-pane-bar">
              <span className="agency-pane-label">Shell</span>
              <span className="agency-flex-spacer" />
              {!hasAgent && !addingAgent && <button type="button" className="agency-text-button"
                onClick={() => setAddingAgent(true)}>+ Agent</button>}
              {shellTerminalId && <button type="button" className="agency-text-button agency-text-danger"
                onClick={() => stop(shellTerminalId)}>Stop shell</button>}
            </div>
            {shellTerminalId ? <AgentTerminal terminalId={shellTerminalId} connection={connection} /> : (
              <div className="agency-shell-placeholder">
                <p>Independent terminal</p>
                <span>Use the existing workspace directory with native shell input and output.</span>
                <button type="button" className="agency-secondary-button" disabled={!online || shellStarting}
                  onClick={() => void launchShell()}>{shellStarting ? 'Starting…' : 'Open shell'}</button>
              </div>
            )}
          </aside>
        )}
      </div>
      {sessionError && <div role="alert" className="agency-error-bar">{sessionError}</div>}
      {pastAgent && !agent && <p className="agency-session-ended">
        Previous agent exited{pastAgent.exitCode === null ? '' : ' (code ' + pastAgent.exitCode + ')'}. History remains on the server.
      </p>}
    </section>
  );
}
