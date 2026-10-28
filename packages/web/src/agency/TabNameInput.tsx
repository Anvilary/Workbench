import { useRef, useState } from 'react';
import { validateWebTabTitle } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

/** Enter saves; Escape and blur cancel. Never commits through tab selection. */
export function TabNameInput({ name, onSave, onClose, report }: {
  name: string; onSave: (name: string) => Promise<unknown>;
  onClose: (restoreFocus: boolean) => void; report: (error: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const flight = useRef(false);
  async function save() {
    if (flight.current) return;
    if (!validateWebTabTitle(value)) { setInvalid(true); report(t('agency.web.invalidTitle')); return; }
    flight.current = true; setSaving(true);
    try { if (value.trim() !== name) await onSave(value.trim()); onClose(true); }
    catch (error) { report(String(error)); }
    finally { flight.current = false; setSaving(false); }
  }
  return <input className="maw-tab-name-input" autoFocus aria-label={t('agency.web.title')}
    aria-invalid={invalid} aria-busy={saving} value={value} readOnly={saving} maxLength={120}
    enterKeyHint="done" onFocus={event => event.currentTarget.select()}
    onChange={event => { setValue(event.target.value); setInvalid(false); }}
    onBlur={event => {
      const input = event.currentTarget;
      // The streamed viewer may autofocus on reconnect. Keep editing until the
      // user saves/cancels or focuses another MAW control, never drop typed text.
      setTimeout(() => {
        if (!input.isConnected || flight.current) return;
        if (document.activeElement?.tagName === 'IFRAME') input.focus();
        else onClose(false);
      }, 0);
    }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); void save(); }
      if (event.key === 'Escape' && !flight.current) { event.preventDefault(); onClose(true); }
    }} />;
}
