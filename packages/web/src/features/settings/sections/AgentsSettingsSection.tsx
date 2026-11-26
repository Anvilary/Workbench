import type { AgentId, AgentInfo } from '@anvilary/workbench-shared';
import { AgentProfilesManager } from '../../agents/AgentProfilesManager.js';
import type { AgentConnection } from '../../../connection/connection.js';
import { t } from '../../../i18n/index.js';
import type { AppSettingsApi } from '../useAppSettings.js';
import { CollapsibleSubsection } from '../CollapsibleSubsection.js';
import { InfoIcon, ProviderIcon } from '../SettingsIcons.js';
import { toggled } from '../version-info.js';

export interface AgentsSettingsSectionProps {
  status: AppSettingsApi['status'];
  appSettings: AppSettingsApi;
  agents: readonly AgentInfo[];
  shownDisabled: readonly AgentId[];
  serverEditable: boolean;
  restartPending: boolean;
  remoteClient: boolean;
  highlightedCardId: string | null;
  expandSignal?: number;
  connection?: AgentConnection;
  onChangeDisabledAgents: (next: AgentId[]) => void;
}

export function AgentsSettingsSection({
  status,
  appSettings,
  agents,
  shownDisabled,
  serverEditable,
  restartPending,
  remoteClient,
  highlightedCardId,
  expandSignal,
  connection,
  onChangeDisabledAgents,
}: AgentsSettingsSectionProps): JSX.Element {
  const isClisTarget =
    highlightedCardId === 'setting-card-clis' ||
    Boolean(highlightedCardId?.startsWith('setting-agent-'));

  return (
    <div className="wb-settings-groups">
      <CollapsibleSubsection
        id="setting-card-clis"
        title={t('settings.section.clis')}
        highlighted={highlightedCardId === 'setting-card-clis'}
        forceExpanded={isClisTarget}
        expandSignal={expandSignal}
      >
        {status === null ? (
          <p className="wb-settings-hint">{t('settings.oldServer')}</p>
        ) : (
          <>
            <ul className="wb-settings-clis">
              {agents.map((agent) => {
                const off = shownDisabled.includes(agent.id);
                const offAtStart = status.disabledAtStart.includes(agent.id);
                const installed = agent.available || offAtStart;
                const isAgentHighlighted = highlightedCardId === `setting-agent-${agent.id}`;
                return (
                  <li
                    key={agent.id}
                    id={`setting-agent-${agent.id}`}
                    className={`wb-settings-cli-row ${isAgentHighlighted ? 'wb-settings-card-highlighted' : ''}`}
                  >
                    <div className="wb-settings-cli-main">
                      {installed ? (
                        <label className="wb-settings-choice wb-settings-cli-choice">
                          <input
                            type="checkbox"
                            checked={!off}
                            disabled={!serverEditable}
                            onChange={(event) => {
                              const next = toggled(shownDisabled, agent.id, !event.target.checked);
                              onChangeDisabledAgents(next);
                            }}
                          />
                          <span className="wb-provider-icon" aria-hidden="true">
                            <ProviderIcon provider={agent.id} size={15} />
                          </span>
                          <span className="wb-settings-cli-name">{agent.label}</span>
                        </label>
                      ) : (
                        <>
                          <span className="wb-provider-icon" aria-hidden="true">
                            <ProviderIcon provider={agent.id} size={15} />
                          </span>
                          <span className="wb-settings-cli-name wb-settings-cli-missing">
                            {agent.label}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="wb-settings-cli-actions">
                      <span
                        className={`wb-settings-badge ${
                          agent.available
                            ? 'badge-available'
                            : offAtStart
                              ? 'badge-disabled'
                              : 'badge-missing'
                        }`}
                      >
                        {agent.available
                          ? agent.version || t('settings.cli.available')
                          : offAtStart
                            ? t('settings.cli.disabled')
                            : t('settings.cli.notInstalled')}
                      </span>
                      {!installed && (
                        <a
                          className="link-button wb-settings-install-link"
                          href={agent.installUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {t('settings.cli.install')}
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="wb-settings-hint">{t('settings.cli.hint')}</p>
            {restartPending && (
              <div className="wb-settings-banner wb-settings-banner-warning" role="status">
                <span className="wb-settings-banner-icon" aria-hidden="true">
                  <InfoIcon size={14} />
                </span>
                <span>{t('settings.cli.restart')}</span>
              </div>
            )}
            {remoteClient && (
              <p className="wb-settings-hint wb-settings-warning">{t('settings.hostOnly')}</p>
            )}
            {appSettings.problem !== null && (
              <div className="wb-settings-banner wb-settings-banner-error" role="alert">
                <span>{appSettings.problem}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={appSettings.dismissProblem}
                >
                  {t('common.close')}
                </button>
              </div>
            )}
          </>
        )}
      </CollapsibleSubsection>

      <AgentProfilesManager
        agents={agents}
        connection={connection}
        remoteClient={remoteClient}
        highlightedCardId={highlightedCardId}
        expandSignal={expandSignal}
      />
    </div>
  );
}
