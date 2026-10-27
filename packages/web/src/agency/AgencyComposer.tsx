import { useState } from 'react';
import type { AgencyAgentSession, AgencyCliProfile, CliProfileId } from '@agent-workbench/shared';
import { canLaunchAgent, selectableEfforts, selectableModels } from './model.js';

export interface AgencyComposerProps {
  draft: string;
  onDraft: (text: string) => void;
  profileId: CliProfileId | '';
  profiles: readonly AgencyCliProfile[];
  onProfile: (id: CliProfileId) => void;
  agent: AgencyAgentSession | undefined;
  selectedModel: string | null;
  selectedEffort: string | null;
  onSelection: (model: string | null, effort: string | null) => Promise<void>;
  onLaunch: () => Promise<void>;
  onSubmit: (text: string) => Promise<void>;
  onInterrupt: () => void;
  online: boolean;
}

export function AgencyComposer({
  draft, onDraft, profileId, profiles, onProfile, agent,
  selectedModel, selectedEffort, onSelection, onLaunch, onSubmit, onInterrupt, online,
}: AgencyComposerProps): JSX.Element {
  const [sending, setSending] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((item) => item.id === (agent?.profileId ?? profileId));
  const models = selectableModels(profile?.capabilities);
  const efforts = selectableEfforts(profile?.capabilities, selectedModel);
  const live = !!agent && agent.lifecycle === 'running' && !!agent.terminalId;
  const waiting = sending || launching || configuring;
  const canStart = !agent && online && canLaunchAgent(profile);

  async function configure(model: string | null, effort: string | null) {
    setConfiguring(true);
    setError(null);
    try { await onSelection(model, effort); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Setting was not applied'); }
    finally { setConfiguring(false); }
  }

  async function send() {
    if (!live || !online || !draft.trim() || waiting) return;
    setSending(true);
    setError(null);
    try { await onSubmit(draft); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Message was not confirmed'); }
    finally { setSending(false); }
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    try { await onLaunch(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Agent did not start'); }
    finally { setLaunching(false); }
  }

  return (
    <div className="agency-composer-wrap">
      <section className="agency-composer" aria-label="Agent composer">
        <textarea aria-label="Message to agent" placeholder={live ? 'Message the agent…' : 'Write a prompt, then start an agent to send it'}
          value={draft} onChange={(event) => onDraft(event.target.value)} rows={3} spellCheck
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }} />
        <div className="agency-composer-controls">
          <label className="agency-compact-control" title={agent ? 'Current running agent profile' : 'Choose installed CLI profile'}>
            <span className="agency-sr-only">CLI profile</span>
            <select aria-label="CLI profile" value={agent?.profileId ?? profileId} disabled={!!agent || waiting}
              onChange={(event) => onProfile(event.target.value as CliProfileId)}>
              <option value="">Choose CLI</option>
              {profiles.map((item) => <option key={item.id} value={item.id} disabled={!canLaunchAgent(item)}>
                {item.label}{canLaunchAgent(item) ? '' : ' (unavailable)'}
              </option>)}
            </select>
          </label>
          <label className="agency-compact-control" title={!models.length ? 'Model discovery unavailable. Native CLI default remains in effect.' : 'Model'}>
            <span className="agency-sr-only">Model</span>
            <select aria-label="Model" value={selectedModel ?? ''} disabled={waiting || !models.length}
              onChange={(event) => void configure(event.target.value || null, null)}>
              <option value="">CLI default</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
          <label className="agency-compact-control" title={!efforts.length ? 'No verified effort controls for this model' : 'Reasoning effort'}>
            <span className="agency-sr-only">Reasoning effort</span>
            <select aria-label="Reasoning effort" value={selectedEffort ?? ''} disabled={waiting || !efforts.length}
              onChange={(event) => void configure(selectedModel, event.target.value || null)}>
              <option value="">Default effort</option>
              {efforts.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="agency-composer-actions">
            {live && (agent?.activity === 'working' || agent?.activity === 'awaiting-user' ||
              agent?.activity === 'awaiting-permission' || agent?.activity === 'unknown') && (
              <button type="button" className="agency-secondary-button" onClick={onInterrupt} disabled={!online}
                title="Ask the original CLI to interrupt">Interrupt</button>
            )}
            {live ? (
              <button type="button" className="agency-send-button" onClick={() => void send()}
                disabled={!online || !draft.trim() || waiting} aria-label="Send prompt">
                {sending ? 'Sending…' : 'Send ↑'}
              </button>
            ) : (
              <button type="button" className="agency-send-button" disabled={!canStart || waiting}
                onClick={() => void launch()}>{launching ? 'Starting…' : 'Start agent ↗'}</button>
            )}
          </div>
        </div>
      </section>
      {error && <p className="agency-composer-error" role="alert">{error}</p>}
      <div className="agency-composer-footnote">
        {!online ? 'Disconnected. Sending and launching are disabled.' :
          agent?.lifecycle === 'exited' || agent?.lifecycle === 'failed'
            ? 'Previous session ended. Select a new agent session to continue.' :
          profile && !canLaunchAgent(profile)
            ? (profile.configurationMessage ?? 'This CLI profile is unavailable.') :
          !models.length ? 'Model and effort use native CLI defaults when not discoverable.' :
            'Native CLI authentication and permissions remain in control.'}
      </div>
    </div>
  );
}
