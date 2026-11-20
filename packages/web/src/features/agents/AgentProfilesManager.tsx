import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PROFILE_ALLOWED_ENV_KEYS,
  PROFILE_ENV_RULES,
  type AgencyCliProfile,
  type AgentInfo,
  type CliProfileId,
  type CliProvider,
  type ProfileStatus,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection/connection.js';
import { t } from '../../i18n/index.js';
import { parseProfileArgv } from '../workspaces/workspace-model.js';
import { suggestedExecutable } from './profile-suggestions.js';
import { CollapsibleSubsection } from '../settings/CollapsibleSubsection.js';
import { ProviderIcon } from '../settings/SettingsIcons.js';
import { useEscapeKey } from '../../shared/hooks/useEscapeKey.js';
import { useFocusTrap } from '../../shared/hooks/useFocusTrap.js';

export interface AgentProfilesManagerProps {
  agents?: readonly AgentInfo[];
  connection?: AgentConnection;
  remoteClient?: boolean;
  highlightedCardId?: string | null;
  expandSignal?: number;
}

interface ProviderMeta {
  readonly id: CliProvider;
  readonly label: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'antigravity', label: 'Antigravity CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi', label: 'Pi' },
];

export async function browseNativeExecutable(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as {
    mawChatGpt?: {
      browseExecutable?: (opts?: { title?: string }) => Promise<string | null>;
      command?: (cmd: { type: string; title?: string }) => Promise<{ ok?: boolean; path?: string | null }>;
    };
  }).mawChatGpt;

  if (bridge?.browseExecutable) {
    return bridge.browseExecutable({ title: t('settings.profiles.browseTitle') });
  }
  if (bridge?.command) {
    const res = await bridge.command({ type: 'browse-executable', title: t('settings.profiles.browseTitle') });
    if (res?.ok && res.path) return res.path;
  }
  return null;
}

export function AgentProfilesManager({
  agents = [],
  connection,
  remoteClient = false,
  highlightedCardId = null,
  expandSignal,
}: AgentProfilesManagerProps): JSX.Element {
  const [profiles, setProfiles] = useState<readonly AgencyCliProfile[]>([]);
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AgencyCliProfile | null>(null);
  const [removingProfile, setRemovingProfile] = useState<AgencyCliProfile | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const addModalRef = useRef<HTMLDivElement | null>(null);
  const editModalRef = useRef<HTMLDivElement | null>(null);
  const removeModalRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap(addModalRef, showAddModal, { restoreFocus: true });
  useFocusTrap(editModalRef, Boolean(editingProfile), { restoreFocus: true });
  useFocusTrap(removeModalRef, Boolean(removingProfile), { restoreFocus: true });

  useEscapeKey((event) => {
    if (saving) return;
    event.preventDefault();
    event.stopPropagation();
    if (removingProfile) {
      setRemovingProfile(null);
    } else if (editingProfile) {
      setEditingProfile(null);
    } else if (showAddModal) {
      setShowAddModal(false);
    }
  }, showAddModal || Boolean(editingProfile) || Boolean(removingProfile));

  // New profile form state
  const [newProvider, setNewProvider] = useState<CliProvider>('codex');
  const [newLabel, setNewLabel] = useState('');
  const [newExecutable, setNewExecutable] = useState('');
  const [newArgs, setNewArgs] = useState('[]');
  const [newEnvOverrides, setNewEnvOverrides] = useState<[string, string][]>([]);

  // Edit profile form state
  const [editLabel, setEditLabel] = useState('');
  const [editExecutable, setEditExecutable] = useState('');
  const [editArgs, setEditArgs] = useState('[]');
  const [editDisabled, setEditDisabled] = useState(false);
  const [editEnvOverrides, setEditEnvOverrides] = useState<[string, string][]>([]);

  // Load profiles from server
  const loadProfiles = useCallback(() => {
    if (!connection || connection.getStatus() !== 'open') return;
    const reqId = `profiles-list-${Date.now()}`;
    connection.send({ type: 'agency.profiles.list', requestId: reqId });
  }, [connection]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (!connection) return;
    const unsubReopen = connection.onReopen?.(() => {
      loadProfiles();
    });
    const unsubMessage = connection.onMessage((message) => {
      if (message.type === 'agency.profiles.snapshot') {
        setProfiles(message.profiles);
      } else if (message.type === 'agency.profile.configured' || message.type === 'agency.profile.created') {
        setProfiles((prev) => {
          const index = prev.findIndex((p) => p.id === message.profile.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = message.profile;
            return next;
          }
          return [...prev, message.profile];
        });
      } else if (message.type === 'agency.profile.deleted') {
        setProfiles((prev) => prev.filter((p) => p.id !== message.profileId));
      } else if (message.type === 'agency.profile.changed') {
        if (message.change === 'deleted') {
          setProfiles((prev) => prev.filter((p) => p.id !== message.profileId));
        } else if (message.profile) {
          const p = message.profile;
          setProfiles((prev) => {
            const index = prev.findIndex((item) => item.id === p.id);
            if (index >= 0) {
              const next = [...prev];
              next[index] = p;
              return next;
            }
            return [...prev, p];
          });
        }
      }
    });

    return () => {
      unsubMessage();
      unsubReopen?.();
    };
  }, [connection, loadProfiles]);

  // Group profiles by provider
  const profilesByProvider = useMemo(() => {
    const groups: Record<CliProvider, AgencyCliProfile[]> = {
      codex: [],
      'claude-code': [],
      antigravity: [],
      opencode: [],
      pi: [],
    };
    for (const profile of profiles) {
      if (groups[profile.provider]) {
        groups[profile.provider].push(profile);
      }
    }
    return groups;
  }, [profiles]);

  // Collapsed check: if a provider has multiple profiles, default group to collapsed with expansion toggle
  const isGroupCollapsed = useCallback((providerId: CliProvider): boolean => {
    if (collapsedProviders[providerId] !== undefined) {
      return collapsedProviders[providerId]!;
    }
    const count = profilesByProvider[providerId]?.length ?? 0;
    return count > 1;
  }, [collapsedProviders, profilesByProvider]);

  const toggleGroup = (providerId: CliProvider) => {
    setCollapsedProviders((prev) => ({
      ...prev,
      [providerId]: !isGroupCollapsed(providerId),
    }));
  };

  // Open Add modal
  const openAdd = (presetProvider?: CliProvider) => {
    const prov = presetProvider ?? 'codex';
    setNewProvider(prov);
    setNewLabel('');
    const suggested = suggestedExecutable('', prov);
    setNewExecutable(suggested);
    setNewArgs('[]');
    setNewEnvOverrides([]);
    setFormError(null);
    setShowAddModal(true);
  };

  // Open Edit modal
  const openEdit = (profile: AgencyCliProfile) => {
    setEditingProfile(profile);
    setEditLabel(profile.label);
    setEditExecutable(profile.executable);
    setEditArgs(JSON.stringify(profile.args));
    setEditDisabled(profile.configurationStatus === 'disabled');
    setEditEnvOverrides(Object.entries(profile.environmentOverrides));
    setFormError(null);
  };

  // Submit Add Profile
  const handleSaveNew = async () => {
    if (saving) return;
    const exec = newExecutable.trim();
    if (!exec) {
      setFormError(t('agency.profile.missingExecutable'));
      return;
    }
    const parsedArgs = parseProfileArgv(newArgs);
    if (parsedArgs === null) {
      setFormError(t('agency.profile.invalidArgs'));
      return;
    }

    const envMap: Record<string, string> = {};
    for (const [key, val] of newEnvOverrides) {
      const trimmedKey = key.trim();
      const trimmedVal = val.trim();
      if (!trimmedKey) continue;
      const rule = PROFILE_ENV_RULES[trimmedKey];
      if (!rule || !rule.test(trimmedVal)) {
        setFormError(t('settings.profiles.invalidEnvOverride', { key: trimmedKey }));
        return;
      }
      envMap[trimmedKey] = trimmedVal;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (connection && connection.getStatus() === 'open') {
        const reqId = `create-profile-${Date.now()}`;
        connection.send({
          type: 'agency.profile.create',
          requestId: reqId,
          provider: newProvider,
          label: newLabel.trim() || undefined,
          executable: exec,
          args: parsedArgs,
          environmentOverrides: envMap,
        });
      } else {
        // Fallback local addition if offline
        const fakeId = `${newProvider}-${Date.now().toString(36)}` as CliProfileId;
        const fallbackProfile: AgencyCliProfile = {
          id: fakeId,
          label: newLabel.trim() || `${newProvider} (${fakeId})`,
          provider: newProvider,
          executable: exec,
          args: parsedArgs,
          environmentOverrides: envMap,
          capabilities: {
            canLaunch: true,
            canResumeNativeSession: false,
            canInterrupt: false,
            canReportActivity: false,
            canSelectModel: false,
            canSelectEffort: false,
            canRequestPermissions: false,
            models: [],
            discovery: 'configured',
          },
          configurationStatus: 'available',
          configurationMessage: null,
        };
        setProfiles((prev) => [...prev, fallbackProfile]);
      }
      // Expand the provider group to reveal newly added profile
      setCollapsedProviders((prev) => ({ ...prev, [newProvider]: false }));
      setShowAddModal(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Submit Edit Profile
  const handleSaveEdit = async () => {
    if (!editingProfile || saving) return;
    const exec = editExecutable.trim();
    if (!exec) {
      setFormError(t('agency.profile.missingExecutable'));
      return;
    }
    const parsedArgs = parseProfileArgv(editArgs);
    if (parsedArgs === null) {
      setFormError(t('agency.profile.invalidArgs'));
      return;
    }

    const envMap: Record<string, string> = {};
    for (const [key, val] of editEnvOverrides) {
      const trimmedKey = key.trim();
      const trimmedVal = val.trim();
      if (!trimmedKey) continue;
      const rule = PROFILE_ENV_RULES[trimmedKey];
      if (!rule || !rule.test(trimmedVal)) {
        setFormError(t('settings.profiles.invalidEnvOverride', { key: trimmedKey }));
        return;
      }
      envMap[trimmedKey] = trimmedVal;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (connection && connection.getStatus() === 'open') {
        const reqId = `edit-profile-${Date.now()}`;
        connection.send({
          type: 'agency.profile.configure',
          requestId: reqId,
          profileId: editingProfile.id,
          label: editLabel.trim() || editingProfile.label,
          executable: exec,
          args: parsedArgs,
          environmentOverrides: envMap,
          disabled: editDisabled,
        });
      } else {
        // Fallback local update
        setProfiles((prev) =>
          prev.map((p) =>
            p.id === editingProfile.id
              ? {
                  ...p,
                  label: editLabel.trim() || editingProfile.label,
                  executable: exec,
                  args: parsedArgs,
                  environmentOverrides: envMap,
                  configurationStatus: editDisabled ? 'disabled' : p.configurationStatus,
                }
              : p,
          ),
        );
      }
      setEditingProfile(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Confirm Delete Profile
  const handleConfirmRemove = async () => {
    if (!removingProfile || saving) return;
    setSaving(true);
    try {
      if (connection && connection.getStatus() === 'open') {
        const reqId = `delete-profile-${Date.now()}`;
        connection.send({
          type: 'agency.profile.delete',
          requestId: reqId,
          profileId: removingProfile.id,
        });
      }
      setProfiles((prev) => prev.filter((p) => p.id !== removingProfile.id));
      setRemovingProfile(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = (status: ProfileStatus) => {
    switch (status) {
      case 'available':
        return <span className="maw-settings-badge badge-available">{t('settings.profiles.statusAvailable')}</span>;
      case 'disabled':
        return <span className="maw-settings-badge badge-disabled">{t('settings.profiles.statusDisabled')}</span>;
      case 'needs-authentication':
        return <span className="maw-settings-badge badge-missing">{t('settings.profiles.statusNeedsAuth')}</span>;
      case 'not-installed':
        return <span className="maw-settings-badge badge-missing">{t('settings.profiles.statusNotInstalled')}</span>;
      case 'error':
      default:
        return <span className="maw-settings-badge badge-missing">{t('settings.profiles.statusError')}</span>;
    }
  };

  return (
    <CollapsibleSubsection
      id="setting-card-profiles"
      title={t('settings.profiles.sectionTitle')}
      description={t('settings.profiles.sectionDesc')}
      highlighted={highlightedCardId === 'setting-card-profiles'}
      forceExpanded={highlightedCardId === 'setting-card-profiles'}
      expandSignal={expandSignal}
      bodyClassName="maw-profiles-body"
      headerActions={
        !remoteClient ? (
          <button
            type="button"
            className="action-button primary maw-add-profile-btn"
            onClick={() => openAdd()}
          >
            + {t('settings.profiles.add')}
          </button>
        ) : undefined
      }
    >
      {PROVIDERS.map((provider) => {
        const providerProfiles = profilesByProvider[provider.id] || [];
        const count = providerProfiles.length;
        const collapsed = isGroupCollapsed(provider.id);

        return (
          <div key={provider.id} className="maw-provider-group">
            <button
              type="button"
              className="maw-provider-group-toggle"
              onClick={() => toggleGroup(provider.id)}
              aria-expanded={!collapsed}
            >
              <div className="maw-provider-title-wrapper">
                <span className="maw-provider-icon" aria-hidden="true">
                  <ProviderIcon provider={provider.id} size={16} />
                </span>
                <span className="maw-provider-name">{provider.label}</span>
                <span className="maw-profiles-count">
                  ({count} {count === 1 ? t('settings.profiles.countSingle') : t('settings.profiles.countPlural')})
                </span>
              </div>
              <span className={`maw-provider-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
                ▾
              </span>
            </button>

              {!collapsed && (
                <div className="maw-provider-profiles-list">
                  {providerProfiles.length === 0 ? (
                    <div className="maw-no-profiles">
                      <p className="agency-muted">{t('settings.profiles.noProfiles')}</p>
                      {!remoteClient && (
                        <button
                          type="button"
                          className="link-button maw-inline-add-btn"
                          onClick={() => openAdd(provider.id)}
                        >
                          + {t('settings.profiles.addForProvider', { provider: provider.label })}
                        </button>
                      )}
                    </div>
                  ) : (
                    <ul className="maw-profiles-items">
                      {providerProfiles.map((p) => (
                        <li key={p.id} className="maw-profile-row">
                          <div className="maw-profile-main">
                            <div className="maw-profile-header-line">
                              <span className="maw-profile-label">{p.label}</span>
                              <span className="maw-profile-id">({p.id})</span>
                              {statusBadge(p.configurationStatus)}
                            </div>
                            <div className="maw-profile-details">
                              <span className="maw-profile-executable">
                                {p.executable ? (
                                  <code>{p.executable}</code>
                                ) : (
                                  <span className="agency-muted">{t('settings.profiles.notConfigured')}</span>
                                )}
                              </span>
                              {p.args.length > 0 && (
                                <span className="maw-profile-args">
                                  {t('settings.profiles.argsLabel')}: <code>{JSON.stringify(p.args)}</code>
                                </span>
                              )}
                              {Object.keys(p.environmentOverrides).length > 0 && (
                                <span className="maw-profile-env">
                                  {t('settings.profiles.envLabel')}:{' '}
                                  {Object.entries(p.environmentOverrides)
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join(', ')}
                                </span>
                              )}
                            </div>
                          </div>
                          {!remoteClient && (
                            <div className="maw-profile-actions">
                              <button
                                type="button"
                                className="action-button secondary maw-profile-btn"
                                onClick={() => openEdit(p)}
                              >
                                {t('settings.profiles.edit')}
                              </button>
                              <button
                                type="button"
                                className="action-button danger maw-profile-btn"
                                onClick={() => setRemovingProfile(p)}
                              >
                                {t('settings.profiles.remove')}
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}

      {/* Add Profile Modal */}
      {showAddModal && (
        <div className="agency-modal-backdrop" onClick={() => !saving && setShowAddModal(false)}>
          <div
            ref={addModalRef}
            className="agency-dialog maw-profile-form-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="maw-add-profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="maw-add-profile-title">{t('settings.profiles.addTitle')}</h2>
            <p className="agency-muted">{t('settings.profiles.addDesc')}</p>

            {formError && (
              <div className="maw-settings-banner maw-settings-banner-error" role="alert">
                <span>{formError}</span>
              </div>
            )}

            <div className="maw-form-group">
              <label htmlFor="new-profile-provider">{t('settings.profiles.provider')}</label>
              <select
                id="new-profile-provider"
                value={newProvider}
                onChange={(e) => {
                  const prov = e.target.value as CliProvider;
                  setNewProvider(prov);
                  setNewExecutable(suggestedExecutable('', prov));
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="maw-form-group">
              <label htmlFor="new-profile-label">
                {t('settings.profiles.label')} <span className="agency-muted">({t('settings.profiles.optional')})</span>
              </label>
              <input
                id="new-profile-label"
                type="text"
                placeholder={t('settings.profiles.labelPlaceholder')}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>

            <div className="maw-form-group">
              <label htmlFor="new-profile-executable">{t('settings.profiles.executable')}</label>
              <div className="maw-executable-input-row">
                <input
                  id="new-profile-executable"
                  type="text"
                  placeholder={t('agency.profile.executablePlaceholder')}
                  value={newExecutable}
                  onChange={(e) => setNewExecutable(e.target.value)}
                />
                <button
                  type="button"
                  className="action-button secondary maw-browse-btn"
                  onClick={async () => {
                    const picked = await browseNativeExecutable();
                    if (picked) setNewExecutable(picked);
                  }}
                >
                  {t('settings.profiles.browse')}
                </button>
              </div>
              {/* Discovered / suggested executables quick pick */}
              {(() => {
                const foundAgent = agents.find((a) => a.id === newProvider && a.available);
                const suggested = suggestedExecutable('', newProvider);
                const quickPicks = [foundAgent?.command, suggested].filter(
                  (val): val is string => !!val && val !== newExecutable,
                );
                if (quickPicks.length === 0) return null;
                return (
                  <div className="maw-quick-picks">
                    <span className="agency-muted">{t('settings.profiles.discovered')}:</span>
                    {quickPicks.map((pick) => (
                      <button
                        key={pick}
                        type="button"
                        className="link-button maw-pick-chip"
                        onClick={() => setNewExecutable(pick)}
                      >
                        {pick}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="maw-form-group">
              <label htmlFor="new-profile-args">
                {t('agency.profile.args')}{' '}
                <span className="agency-muted">({t('settings.profiles.optional')})</span>
              </label>
              <input
                id="new-profile-args"
                type="text"
                placeholder={t('settings.profiles.argsPlaceholder')}
                value={newArgs}
                onChange={(e) => setNewArgs(e.target.value)}
              />
              <span className="agency-muted maw-help-text">{t('agency.profile.argsHelp')}</span>
            </div>

            <div className="maw-form-group">
              <div className="maw-env-header">
                <label>{t('settings.profiles.envOverrides')}</label>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setNewEnvOverrides((prev) => [...prev, [PROFILE_ALLOWED_ENV_KEYS[0] || 'LANG', '']])}
                >
                  + {t('settings.profiles.addEnv')}
                </button>
              </div>
              {newEnvOverrides.map(([key, val], idx) => (
                <div key={idx} className="maw-env-row">
                  <select
                    value={key}
                    onChange={(e) => {
                      const next = [...newEnvOverrides];
                      next[idx] = [e.target.value, val];
                      setNewEnvOverrides(next);
                    }}
                  >
                    {PROFILE_ALLOWED_ENV_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder={t('settings.profiles.envPlaceholder')}
                    value={val}
                    onChange={(e) => {
                      const next = [...newEnvOverrides];
                      next[idx] = [key, e.target.value];
                      setNewEnvOverrides(next);
                    }}
                  />
                  <button
                    type="button"
                    className="action-button danger maw-env-remove-btn"
                    onClick={() => setNewEnvOverrides((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="maw-modal-footer">
              <button
                type="button"
                className="action-button secondary"
                disabled={saving}
                onClick={() => setShowAddModal(false)}
              >
                {t('settings.profiles.cancel')}
              </button>
              <button
                type="button"
                className="action-button primary"
                disabled={saving}
                onClick={handleSaveNew}
              >
                {saving ? t('agency.saving') : t('settings.profiles.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Profile Modal */}
      {editingProfile && (
        <div className="agency-modal-backdrop" onClick={() => !saving && setEditingProfile(null)}>
          <div
            ref={editModalRef}
            className="agency-dialog maw-profile-form-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="maw-edit-profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="maw-edit-profile-title">
              {t('settings.profiles.editTitle', { name: editingProfile.label })}
            </h2>
            <p className="agency-muted">{t('agency.profile.help', { name: editingProfile.label })}</p>

            {formError && (
              <div className="maw-settings-banner maw-settings-banner-error" role="alert">
                <span>{formError}</span>
              </div>
            )}

            <div className="maw-form-group">
              <label htmlFor="edit-profile-label">{t('settings.profiles.label')}</label>
              <input
                id="edit-profile-label"
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
              />
            </div>

            <div className="maw-form-group">
              <label htmlFor="edit-profile-executable">{t('settings.profiles.executable')}</label>
              <div className="maw-executable-input-row">
                <input
                  id="edit-profile-executable"
                  type="text"
                  value={editExecutable}
                  onChange={(e) => setEditExecutable(e.target.value)}
                />
                <button
                  type="button"
                  className="action-button secondary maw-browse-btn"
                  onClick={async () => {
                    const picked = await browseNativeExecutable();
                    if (picked) setEditExecutable(picked);
                  }}
                >
                  {t('settings.profiles.browse')}
                </button>
              </div>
            </div>

            <div className="maw-form-group">
              <label htmlFor="edit-profile-args">{t('agency.profile.args')}</label>
              <input
                id="edit-profile-args"
                type="text"
                value={editArgs}
                onChange={(e) => setEditArgs(e.target.value)}
              />
              <span className="agency-muted maw-help-text">{t('agency.profile.argsHelp')}</span>
            </div>

            <div className="maw-form-group">
              <label className="maw-settings-choice">
                <input
                  type="checkbox"
                  checked={editDisabled}
                  onChange={(e) => setEditDisabled(e.target.checked)}
                />
                <span>{t('settings.profiles.disabledCheckbox')}</span>
              </label>
            </div>

            <div className="maw-form-group">
              <div className="maw-env-header">
                <label>{t('settings.profiles.envOverrides')}</label>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setEditEnvOverrides((prev) => [...prev, [PROFILE_ALLOWED_ENV_KEYS[0] || 'LANG', '']])}
                >
                  + {t('settings.profiles.addEnv')}
                </button>
              </div>
              {editEnvOverrides.map(([key, val], idx) => (
                <div key={idx} className="maw-env-row">
                  <select
                    value={key}
                    onChange={(e) => {
                      const next = [...editEnvOverrides];
                      next[idx] = [e.target.value, val];
                      setEditEnvOverrides(next);
                    }}
                  >
                    {PROFILE_ALLOWED_ENV_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => {
                      const next = [...editEnvOverrides];
                      next[idx] = [key, e.target.value];
                      setEditEnvOverrides(next);
                    }}
                  />
                  <button
                    type="button"
                    className="action-button danger maw-env-remove-btn"
                    onClick={() => setEditEnvOverrides((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="maw-modal-footer">
              <button
                type="button"
                className="action-button secondary"
                disabled={saving}
                onClick={() => setEditingProfile(null)}
              >
                {t('settings.profiles.cancel')}
              </button>
              <button
                type="button"
                className="action-button primary"
                disabled={saving}
                onClick={handleSaveEdit}
              >
                {saving ? t('agency.saving') : t('settings.profiles.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal with explicit safety notice */}
      {removingProfile && (
        <div className="agency-modal-backdrop" onClick={() => !saving && setRemovingProfile(null)}>
          <div
            ref={removeModalRef}
            className="agency-dialog maw-profile-remove-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="maw-remove-profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="maw-remove-profile-title">{t('settings.profiles.removeConfirmTitle')}</h2>
            <p>
              {t('settings.profiles.removeConfirmMessage', {
                name: removingProfile.label,
                id: removingProfile.id,
              })}
            </p>

            <div className="maw-settings-banner maw-settings-banner-info" role="status">
              <span className="maw-remove-notice-text">
                {t('settings.profiles.removeNotice')}
              </span>
            </div>

            <div className="maw-modal-footer">
              <button
                type="button"
                className="action-button secondary"
                disabled={saving}
                onClick={() => setRemovingProfile(null)}
              >
                {t('settings.profiles.cancel')}
              </button>
              <button
                type="button"
                className="action-button danger"
                disabled={saving}
                onClick={handleConfirmRemove}
              >
                {saving ? t('agency.saving') : t('settings.profiles.removeConfirmBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </CollapsibleSubsection>
  );
}
