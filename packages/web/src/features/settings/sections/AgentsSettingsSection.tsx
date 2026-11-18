import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { AgentProfilesManager } from '../../../AgentProfilesManager.js';
import type { AgentConnection } from '../../../connection.js';
import { t } from '../../../i18n/index.js';
import type { AppSettingsApi } from '../../../useAppSettings.js';
import { InfoIcon } from '../SettingsIcons.js';
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
  connection,
  onChangeDisabledAgents,
}: AgentsSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <div
        id="setting-card-clis"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-clis' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-card-header">
          <span className="maw-settings-card-title">{t('settings.section.clis')}</span>
        </div>
        <div className="maw-settings-card-body">
          {status === null ? (
            <p className="maw-settings-hint">{t('settings.oldServer')}</p>
          ) : (
            <>
              <ul className="maw-settings-clis">
                {agents.map((agent) => {
                  const off = shownDisabled.includes(agent.id);
                  const offAtStart = status.disabledAtStart.includes(agent.id);
                  const installed = agent.available || offAtStart;
                  const isAgentHighlighted = highlightedCardId === `setting-agent-${agent.id}`;
                  return (
                    <li
                      key={agent.id}
                      id={`setting-agent-${agent.id}`}
                      className={`maw-settings-cli-row ${isAgentHighlighted ? 'maw-settings-card-highlighted' : ''}`}
                    >
                      <div className="maw-settings-cli-main">
                        {installed ? (
                          <label className="maw-settings-choice">
                            <input
                              type="checkbox"
                              checked={!off}
                              disabled={!serverEditable}
                              onChange={(event) => {
                                const next = toggled(shownDisabled, agent.id, !event.target.checked);
                                onChangeDisabledAgents(next);
                              }}
                            />
                            <span className="maw-settings-cli-name">{agent.label}</span>
                          </label>
                        ) : (
                          <span className="maw-settings-cli-name maw-settings-cli-missing">
                            {agent.label}
                          </span>
                        )}
                      </div>
                      <div className="maw-settings-cli-actions">
                        <span
                          className={`maw-settings-badge ${
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
                            className="link-button maw-settings-install-link"
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
              <p className="maw-settings-hint">{t('settings.cli.hint')}</p>
              {restartPending && (
                <div className="maw-settings-banner maw-settings-banner-warning" role="status">
                  <span className="maw-settings-banner-icon" aria-hidden="true">
                    <InfoIcon size={14} />
                  </span>
                  <span>{t('settings.cli.restart')}</span>
                </div>
              )}
              {remoteClient && (
                <p className="maw-settings-hint maw-settings-warning">{t('settings.hostOnly')}</p>
              )}
              {appSettings.problem !== null && (
                <div className="maw-settings-banner maw-settings-banner-error" role="alert">
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
        </div>
      </div>

      <AgentProfilesManager
        agents={agents}
        connection={connection}
        remoteClient={remoteClient}
      />
    </div>
  );
}
