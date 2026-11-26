/**
 * Lo que la ventana de Ajustes cambia del servidor (Hito 41, §6.32): con que
 * consola abre una nueva, y que CLIs no se usan.
 *
 *  - **La consola vale enseguida** para las que se abran desde ahora; las
 *    abiertas siguen con la suya. Una elegida que no esta instalada no se
 *    acepta: se elige de las que el servidor encontro, por id.
 *  - **Las CLIs apagadas valen al reiniciar.** Apagar una en caliente obligaria
 *    a soltar su historial, sus vigilantes y su lugar en la barra con la app
 *    andando; se guarda, y Ajustes dice que falta reiniciar mientras lo
 *    guardado y lo que corre no coincidan (`disabledAtStart`).
 */

import { EventEmitter } from 'node:events';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  isValidBrowserProfileId,
  type AgentId,
  type AppSettingsChange,
  type AppSettingsStatus,
  type ConsoleShellId,
} from '@agent-workbench/shared';
import type { AgentRegistry } from '../../agents/registry.js';
import type { SettingsStore } from './settings-store.js';
import { pickShell, type ShellCandidate, type ShellLocation } from '../terminals/shell-locator.js';

export interface AppSettingsServiceOptions {
  settings: SettingsStore;
  agents: Pick<AgentRegistry, 'disabledIds'>;
  /** Las consolas instaladas, del arranque. */
  shells: readonly ShellCandidate[];
  /** A quien avisar que cambio la consola de las nuevas: el registro de terminales. */
  onShellChange: (shell: ShellLocation | null) => void;
}

/** Por que no se acepto un cambio. Lo traduce el socket. */
export class AppSettingsChangeError extends Error {
  constructor(readonly reason: 'shell-not-installed') {
    super(reason);
  }
}

export class AppSettingsService extends EventEmitter {
  private readonly disabledAtStart: AgentId[];

  constructor(private readonly options: AppSettingsServiceOptions) {
    super();
    this.disabledAtStart = options.agents.disabledIds();
  }

  /** La consola que abre una nueva con lo que dice `settings.json`. */
  currentShell(): ShellLocation | null {
    return pickShell(this.options.shells, this.options.settings.get().console.shell);
  }

  status(): AppSettingsStatus {
    const settings = this.options.settings.get();
    return {
      consoleShell: settings.console.shell,
      consoleShells: this.options.shells.map(({ id, label }) => ({ id, label })),
      shellName: this.currentShell()?.name ?? null,
      disabledAgents: [...settings.agents.disabled],
      disabledAtStart: [...this.disabledAtStart],
      browser: {
        defaultSearchEngine: settings.browser.defaultSearchEngine,
        favorites: settings.browser.favorites.map((f) => ({ ...f })),
        ...(settings.browser.searchEngines
          ? { searchEngines: settings.browser.searchEngines.map((e) => ({ ...e })) }
          : {}),
        ...(settings.browser.spellCheck
          ? {
              spellCheck: {
                enabled: settings.browser.spellCheck.enabled,
                languages: [...settings.browser.spellCheck.languages],
                configuredLanguages: [...settings.browser.spellCheck.configuredLanguages],
                customWordsByProfile: Object.fromEntries(
                  Object.entries(settings.browser.spellCheck.customWordsByProfile).map(([pid, words]) => [pid, [...words]]),
                ),
              },
            }
          : {}),
        unloadInactiveAiTabsUnderPressure: settings.browser.unloadInactiveAiTabsUnderPressure === true,
      },
    };
  }

  /** Guarda el cambio, avisa al registro si cambio la consola, y emite `status`. */
  async update(change: AppSettingsChange): Promise<AppSettingsStatus> {
    if (change.consoleShell !== undefined && !this.offered(change.consoleShell)) {
      throw new AppSettingsChangeError('shell-not-installed');
    }
    const before = this.currentShell();
    await this.options.settings.update({
      ...(change.consoleShell !== undefined ? { console: { shell: change.consoleShell } } : {}),
      ...(change.disabledAgents !== undefined ? { agents: { disabled: change.disabledAgents } } : {}),
      ...(change.browser !== undefined ? { browser: change.browser } : {}),
      ...(change.customDictionary !== undefined ? { customDictionary: change.customDictionary } : {}),
    });
    const after = this.currentShell();
    if (after !== before) this.options.onShellChange(after);
    const nextStatus = this.status();
    this.emit('status', nextStatus);
    return nextStatus;
  }

  /** Removes custom dictionary entries owned by a deleted custom browser profile. */
  async clearProfileCustomDictionary(profileId: string): Promise<AppSettingsStatus | null> {
    if (!isValidBrowserProfileId(profileId) || profileId === DEFAULT_BROWSER_PROFILE_ID) {
      return null;
    }
    const existing = this.options.settings.get().browser.spellCheck?.customWordsByProfile?.[profileId];
    if (!existing || existing.length === 0) {
      return null;
    }
    return this.update({
      customDictionary: { action: 'clear-profile', profileId },
    });
  }

  private offered(choice: ConsoleShellId): boolean {
    return choice === 'auto' || this.options.shells.some((shell) => shell.id === choice);
  }
}
