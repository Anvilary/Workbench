import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AgencyCliProfile } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { parseProfileArgv } from '../workspaces/workspace-model.js';
import { providerSetupDescription, suggestedExecutable } from './profile-suggestions.js';

export function AgentProfileDialog({ profile, onSave, onClose }: {
  profile: AgencyCliProfile;
  onSave: (executable: string, args: string[]) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [executable, setExecutable] = useState(profile.executable);
  const [args, setArgs] = useState(JSON.stringify(profile.args));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const isUnconfigured = profile.executable === '' ||
    (profile.configurationStatus === 'error' && (profile.configurationMessage?.includes('Configure an executable') ?? false));
  const suggested = suggestedExecutable(profile.id, profile.provider);
  const placeholder = suggested || t('agency.profile.executablePlaceholder');

  useEffect(() => {
    return () => { previousFocus.current?.focus(); };
  }, []);

  function keepFocus(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Tab') return;
    const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (!elements.length) { event.preventDefault(); return; }
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  useEffect(() => {
    const esc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [saving, onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const path = executable.trim();
    if (!path) { setError(t('agency.profile.missingExecutable')); return; }
    const argv = parseProfileArgv(args);
    if (argv === null) { setError(t('agency.profile.invalidArgs')); return; }
    setError(null);
    setSaving(true);
    try { await onSave(path, argv); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.profile.invalidConfiguration')); }
    finally { setSaving(false); }
  }

  return <div className="agency-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}>
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="agency-profile-title" className="agency-dialog" onKeyDown={keepFocus}
      onSubmit={(event) => void submit(event)}>
      <div className="agency-dialog-head">
        <h2 id="agency-profile-title">{t('agency.profile.configure')}</h2>
        <button className="agency-icon-button" type="button" onClick={onClose} disabled={saving}
          aria-label={t('common.close')}>×</button>
      </div>

      {isUnconfigured && (
        <div className="agency-setup-guide" style={{
          background: 'rgba(131, 184, 172, 0.1)',
          border: '1px solid rgba(131, 184, 172, 0.3)',
          borderRadius: '10px',
          padding: '12px 14px',
          marginBottom: '16px',
        }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '13px', fontWeight: 650, color: 'var(--agency-highlight)' }}>
            {t('agency.profile.firstTimeSetupRequired')}
          </h3>
          <p style={{ margin: '0 0 8px 0', fontSize: '12px', lineHeight: 1.45, color: 'var(--agency-text)' }}>
            {providerSetupDescription(profile.provider)}
          </p>
          <p style={{ margin: 0, fontSize: '11px', lineHeight: 1.4, color: 'var(--agency-dim)' }}>
            {t('agency.profile.noShareNotice')}
          </p>
        </div>
      )}

      {profile.configurationStatus === 'not-installed' && (
        <div className="agency-setup-warning" role="alert" style={{
          background: 'rgba(232, 138, 138, 0.12)',
          border: '1px solid rgba(232, 138, 138, 0.35)',
          borderRadius: '8px',
          padding: '10px 12px',
          marginBottom: '16px',
          fontSize: '12px',
          color: 'var(--agency-danger)',
          lineHeight: 1.4,
        }}>
          {t('agency.profile.executableNotFound')}
        </div>
      )}

      <p className="agency-muted">{t('agency.profile.help', { name: profile.label })}</p>
      <label className="agency-field">
        <span>{t('agency.profile.executable')}</span>
        <input autoFocus value={executable} onChange={(event) => setExecutable(event.target.value)}
          spellCheck={false} autoComplete="off" placeholder={placeholder}
          disabled={saving} />
      </label>
      <label className="agency-field">
        <span>{t('agency.profile.args')}</span>
        <textarea value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false}
          rows={3} disabled={saving} placeholder={t('agency.ui.flagAValueWithSpaces')} />
      </label>
      <p className="agency-muted">{t('agency.profile.argsHelp')}</p>
      <p className="agency-muted">{t('agency.profile.authHelp')}</p>
      {error && <p className="agency-error" role="alert">{error}</p>}
      <div className="agency-dialog-actions">
        <button className="agency-secondary-button" type="button" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
        <button className="agency-primary-button" type="submit" disabled={saving}>
          {saving ? t('agency.saving') : t('agency.profile.save')}
        </button>
      </div>
    </form>
  </div>;
}
