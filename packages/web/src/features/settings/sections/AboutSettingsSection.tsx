import { t } from '../../../i18n/index.js';
import type { RuntimeInfo } from '../version-info.js';

export interface AboutSettingsSectionProps {
  runtime: RuntimeInfo;
  highlightedCardId: string | null;
}

export function AboutSettingsSection({
  runtime,
  highlightedCardId,
}: AboutSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <div
        id="setting-card-about"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-about' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-about-hero">
          <img
            src="/brand/workbench-logo-128.png"
            className="maw-settings-about-logo"
            alt=""
            width="44"
            height="44"
          />
          <div>
            <h3 className="maw-settings-about-name">{t('settings.about.app')}</h3>
            <p className="maw-settings-about-tagline">{t('settings.about.tagline')}</p>
          </div>
        </div>

        <div className="maw-settings-spec-table">
          <div className="maw-settings-spec-row">
            <span className="maw-settings-spec-label">{t('settings.about.version')}</span>
            <span className="maw-settings-spec-val">{runtime.displayVersion}</span>
          </div>
          <div className="maw-settings-spec-row">
            <span className="maw-settings-spec-label">{t('settings.about.runtime')}</span>
            <span className="maw-settings-spec-val">{t('settings.about.runtimeValue', { version: runtime.electronVersion })}</span>
          </div>
          <div className="maw-settings-spec-row">
            <span className="maw-settings-spec-label">{t('settings.about.platform')}</span>
            <span className="maw-settings-spec-val">{runtime.platform}</span>
          </div>
        </div>

        <div className="maw-settings-about-links">
          <a
            className="link-button"
            href="https://github.com/Anvilary/Workbench"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('settings.about.github')} ↗
          </a>
        </div>
      </div>
    </div>
  );
}
