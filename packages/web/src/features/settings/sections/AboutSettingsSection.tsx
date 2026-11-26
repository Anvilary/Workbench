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
    <div className="wb-settings-groups">
      <div
        id="setting-card-about"
        className={`wb-settings-card ${highlightedCardId === 'setting-card-about' ? 'wb-settings-card-highlighted' : ''}`}
      >
        <div className="wb-settings-about-hero">
          <img
            src="/brand/workbench-logo-128.png"
            className="wb-settings-about-logo"
            alt=""
            width="44"
            height="44"
          />
          <div>
            <h3 className="wb-settings-about-name">{t('settings.about.app')}</h3>
            <p className="wb-settings-about-tagline">{t('settings.about.tagline')}</p>
          </div>
        </div>

        <div className="wb-settings-spec-table">
          <div className="wb-settings-spec-row">
            <span className="wb-settings-spec-label">{t('settings.about.version')}</span>
            <span className="wb-settings-spec-val">{runtime.displayVersion}</span>
          </div>
          <div className="wb-settings-spec-row">
            <span className="wb-settings-spec-label">{t('settings.about.runtime')}</span>
            <span className="wb-settings-spec-val">{t('settings.about.runtimeValue', { version: runtime.electronVersion })}</span>
          </div>
          <div className="wb-settings-spec-row">
            <span className="wb-settings-spec-label">{t('settings.about.platform')}</span>
            <span className="wb-settings-spec-val">{runtime.platform}</span>
          </div>
        </div>

        <div className="wb-settings-about-links">
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
