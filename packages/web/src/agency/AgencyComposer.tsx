import { useState } from 'react';
import type { AgencyAgentSession, AgencyCliProfile, CliProfileId } from '@agent-workbench/shared';
import { canLaunchAgent, selectableEfforts, selectableModels } from './model.js';
import { AgencyProfileDialog } from './AgencyProfileDialog.js';
import { t } from '../i18n/index.js';

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
  onConfigureProfile: (profile: AgencyCliProfile, executable: string, args: string[]) => Promise<void>;
  online: boolean;
}

export function AgencyComposer({
  draft, onDraft, profileId, profiles, onProfile, agent,
  selectedModel, selectedEffort, onSelection, onLaunch, onSubmit, onInterrupt, onConfigureProfile, online,
}: AgencyComposerProps): JSX.Element {
  const [sending, setSending] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfigure, setShowConfigure] = useState(false);
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
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.settingWasNotApplied')); }
    finally { setConfiguring(false); }
  }

  async function send() {
    if (!live || !online || !draft.trim() || waiting) return;
    setSending(true);
    setError(null);
    try { await onSubmit(draft); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.messageWasNotConfirmed')); }
    finally { setSending(false); }
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    try { await onLaunch(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.agentDidNotStart')); }
    finally { setLaunching(false); }
  }

  return (
    <div className="agency-composer-wrap">
      <section className="agency-composer" aria-label={t('agency.ui.agentComposer')}>
        <textarea aria-label={t('agency.ui.messageToAgent')} placeholder={live ? t('agency.ui.messageTheAgent') : t('agency.ui.startTheAgentThenSendYourPrompt')}
          value={draft} onChange={(event) => onDraft(event.target.value)} rows={3} spellCheck
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!live) { setError(t('agency.ui.startTheAgentThenSendYourPrompt')); return; }
              void send();
            }
          }} />
        <div className="agency-composer-controls">
          <label className="agency-compact-control" title={agent ? t('agency.ui.currentRunningAgentProfile') : t('agency.ui.chooseInstalledCLIProfile')}>
            <span className="agency-sr-only">{t('agency.ui.cLIProfile')}</span>
            <select aria-label={t('agency.ui.cLIProfile')} value={agent?.profileId ?? profileId} disabled={!!agent || waiting}
              onChange={(event) => onProfile(event.target.value as CliProfileId)}>
              <option value="">{t('agency.ui.chooseCLI')}</option>
              {profiles.map((item) => <option key={item.id} value={item.id} >
                {item.label}{canLaunchAgent(item) ? '' : t('agency.ui.unavailableSuffix')}
              </option>)}
            </select>
          </label>
          {profile && !agent && <button type="button" className="agency-text-button" disabled={!online || waiting}
            aria-label={t('agency.profile.configure')} onClick={() => setShowConfigure(true)}>
            {t('agency.profile.configure')}
          </button>}
          <label className="agency-compact-control" title={!models.length ? t('agency.ui.modelDiscoveryUnavailableNativeCLIDefaultRemainsIn') : t('agency.ui.model')}>
            <span className="agency-sr-only">{t('agency.ui.model')}</span>
            <select aria-label={t('agency.ui.model')} value={selectedModel ?? ''} disabled={waiting || !models.length}
              onChange={(event) => void configure(event.target.value || null, null)}>
              <option value="">{t('agency.ui.cLIDefault')}</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
          <label className="agency-compact-control" title={!efforts.length ? t('agency.ui.noVerifiedEffortControlsForThisModel') : t('agency.ui.reasoningEffort')}>
            <span className="agency-sr-only">{t('agency.ui.reasoningEffort')}</span>
            <select aria-label={t('agency.ui.reasoningEffort')} value={selectedEffort ?? ''} disabled={waiting || !efforts.length}
              onChange={(event) => void configure(selectedModel, event.target.value || null)}>
              <option value="">{t('agency.ui.defaultEffort')}</option>
              {efforts.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="agency-composer-actions">
            {live && (agent?.activity === 'working' || agent?.activity === 'awaiting-user' ||
              agent?.activity === 'awaiting-permission' || agent?.activity === 'unknown') && (
              <button type="button" className="agency-secondary-button" onClick={onInterrupt} disabled={!online}
                title={t('agency.ui.askTheOriginalCLIToInterrupt')}>{t('agency.ui.interrupt')}</button>
            )}
            {live ? (
              <button type="button" className="agency-send-button" onClick={() => void send()}
                disabled={!online || !draft.trim() || waiting} aria-label={t('agency.ui.sendPrompt')}>
                {sending ? t('agency.ui.sending') : t('agency.ui.send')}
              </button>
            ) : (
              <button type="button" className="agency-send-button" disabled={!canStart || waiting}
                onClick={() => void launch()}>{launching ? t('agency.ui.startingInProgress') : t('agency.ui.startAgent')}</button>
            )}
          </div>
        </div>
      </section>
      {error && <p className="agency-composer-error" role="alert">{error}</p>}
      <div className="agency-composer-footnote">
        {!online ? t('agency.ui.disconnectedSendingAndLaunchingAreDisabled') :
          agent?.lifecycle === 'exited' || agent?.lifecycle === 'failed'
            ? t('agency.ui.previousSessionEndedSelectANewAgentSession') :
          profile && !canLaunchAgent(profile)
            ? (profile.configurationMessage ?? t('agency.ui.thisCLIProfileIsUnavailable')) :
          !models.length ? t('agency.ui.modelAndEffortUseNativeCLIDefaultsWhen') :
            t('agency.ui.nativeCLIAuthenticationAndPermissionsRemainInControl')}
      </div>
      {showConfigure && profile && <AgencyProfileDialog key={profile.id} profile={profile}
        onClose={() => setShowConfigure(false)}
        onSave={(executable, args) => onConfigureProfile(profile, executable, args)} />}
    </div>
  );
}
