import { useEffect, useState, type FormEvent } from 'react';
import type { AgencyCliProfile } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

export function parseArgv(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(t('agency.profile.invalidArgs')); }
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
    throw new Error(t('agency.profile.invalidArgs'));
  }
  return parsed as string[];
}

export function AgencyProfileDialog({ profile, onSave, onClose }: {
  profile: AgencyCliProfile;
  onSave: (executable: string, args: string[]) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [executable, setExecutable] = useState(profile.executable);
  const [args, setArgs] = useState(JSON.stringify(profile.args));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    let argv: string[];
    try { argv = parseArgv(args); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.profile.invalidArgs')); return; }
    setError(null);
    setSaving(true);
    try { await onSave(path, argv); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.profile.invalidConfiguration')); }
    finally { setSaving(false); }
  }

  return <div className="agency-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}>
    <form role="dialog" aria-modal="true" aria-labelledby="agency-profile-title" className="agency-dialog"
      onSubmit={(event) => void submit(event)}>
      <div className="agency-dialog-head">
        <h2 id="agency-profile-title">{t('agency.profile.configure')}</h2>
        <button className="agency-icon-button" type="button" onClick={onClose} disabled={saving}
          aria-label={t('common.close')}>×</button>
      </div>
      <p className="agency-muted">{t('agency.profile.help', { name: profile.label })}</p>
      <label className="agency-field">
        <span>{t('agency.profile.executable')}</span>
        <input autoFocus value={executable} onChange={(event) => setExecutable(event.target.value)}
          spellCheck={false} autoComplete="off" placeholder={t('agency.profile.executablePlaceholder')}
          disabled={saving} />
      </label>
      <label className="agency-field">
        <span>{t('agency.profile.args')}</span>
        <textarea value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false}
          rows={3} disabled={saving} placeholder={'["--flag", "a value with spaces"]'} />
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
