/**
 * Lo que la ventana de Ajustes (Hito 41, §6.32) lee y cambia del servidor.
 *
 * Son dos ajustes de `settings.json` que deciden cosas del servidor: que consola
 * abre una nueva, y que CLIs no se usan. El resto de Ajustes —el idioma, el tema
 * de la terminal, que paneles se ven— es de la ventana y no viaja (§6.26).
 *
 * El cliente nunca manda una ruta: elige una consola por su id, de las que el
 * servidor encontro instaladas.
 */

import { isAgentId, type AgentId } from '../agents/agents.js';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  isValidBrowserProfileId,
} from '../browser/browser-profiles.js';
import {
  parseBrowserFavorite,
  parseBrowserSettings,
  parseSearchEngine,
  type BrowserFavorite,
  type BrowserSettings,
  type SearchEngine,
  type SearchEngineId,
} from '../browser/browser-settings.js';
import { asArrayFiltered, asLiteral, asNonEmptyString, asRecord } from '../validation/narrowing.js';

/**
 * Con que consola abre una nueva. `auto` es la de siempre (en Windows, `pwsh`,
 * `powershell` o `cmd`, en ese orden; en macOS y Linux, `$SHELL`). `login` es la
 * de `$SHELL`, para elegirla aunque no sea la automatica.
 */
export type ConsoleShellId = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'login' | 'bash' | 'sh' | 'zsh';

export const CONSOLE_SHELL_IDS: readonly ConsoleShellId[] = [
  'auto',
  'pwsh',
  'powershell',
  'cmd',
  'git-bash',
  'login',
  'bash',
  'sh',
  'zsh',
];

/** Una consola instalada que se puede elegir. */
export interface ConsoleShellOption {
  id: Exclude<ConsoleShellId, 'auto'>;
  /** Como se la nombra: "PowerShell 7", "Windows PowerShell", "Git Bash". */
  label: string;
}

export interface AppSettingsStatus {
  /** La elegida en `settings.json`. */
  consoleShell: ConsoleShellId;
  /** Las instaladas, en el orden de la automatica. */
  consoleShells: ConsoleShellOption[];
  /** El nombre de la consola que abre una nueva ahora, o null si no hay ninguna. */
  shellName: string | null;
  /** Las CLIs que el usuario apago, segun `settings.json`. */
  disabledAgents: AgentId[];
  /**
   * Las que este arranque dejo apagadas. Apagar o prender una CLI vale al
   * reiniciar la app: si difiere de `disabledAgents`, Ajustes lo dice.
   */
  disabledAtStart: AgentId[];
  /** Browser favorites and default search engine. */
  browser?: BrowserSettings;
}

function asConsoleShellId(value: unknown): ConsoleShellId | null {
  return asLiteral(value, CONSOLE_SHELL_IDS);
}

function parseConsoleShellOption(value: unknown): ConsoleShellOption | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asConsoleShellId(record['id']);
  const label = asNonEmptyString(record['label']);
  return id === null || id === 'auto' || label === null ? null : { id, label };
}

/**
 * Las CLIs de una lista que esta build conoce, sin repetir. Lo que no es una
 * —una desconocida, algo que ni es texto— se descarta solo, sin llevarse el
 * resto. null si no es una lista.
 */
export function asAgentIdList(value: unknown): AgentId[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is AgentId => typeof item === 'string' && isAgentId(item)))];
}

export function parseAppSettingsStatus(value: unknown): AppSettingsStatus | null {
  const record = asRecord(value);
  if (record === null) return null;
  const consoleShell = asConsoleShellId(record['consoleShell']);
  const consoleShells = asArrayFiltered(record['consoleShells'], parseConsoleShellOption);
  const rawShellName = record['shellName'];
  const shellName = rawShellName === null ? null : asNonEmptyString(rawShellName);
  const disabledAgents = asAgentIdList(record['disabledAgents']);
  const disabledAtStart = asAgentIdList(record['disabledAtStart']);
  if (consoleShell === null || consoleShells === null || disabledAgents === null || disabledAtStart === null) return null;
  if (rawShellName !== null && shellName === null) return null;
  const rawBrowser = record['browser'];
  const browser = rawBrowser !== undefined ? (parseBrowserSettings(rawBrowser) ?? undefined) : undefined;
  return { consoleShell, consoleShells, shellName, disabledAgents, disabledAtStart, ...(browser ? { browser } : {}) };
}

export interface SpellCheckSettingsPatch {
  enabled?: boolean;
  languages?: string[];
  configuredLanguages?: string[];
  customWordsByProfile?: Record<string, string[]>;
}

export interface BrowserSettingsPatch {
  favorites?: BrowserFavorite[];
  defaultSearchEngine?: SearchEngineId;
  searchEngines?: SearchEngine[];
  spellCheck?: SpellCheckSettingsPatch;
}

export type CustomDictionaryMutation =
  | { action: 'add' | 'remove'; profileId: string; word: string }
  | { action: 'clear-profile'; profileId: string };

/** El cambio que pide Ajustes: al menos uno. */
export interface AppSettingsChange {
  consoleShell?: ConsoleShellId;
  disabledAgents?: AgentId[];
  browser?: BrowserSettingsPatch;
  customDictionary?: CustomDictionaryMutation;
}

const CHANGE_LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})*$/;

function parseChangeSpellCheck(value: unknown): SpellCheckSettingsPatch | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const patch: SpellCheckSettingsPatch = {};
  let hasField = false;

  if ('enabled' in rec && rec['enabled'] !== undefined) {
    if (typeof rec['enabled'] !== 'boolean') return null;
    patch.enabled = rec['enabled'];
    hasField = true;
  }

  const parseLangArray = (raw: unknown): string[] | null => {
    if (!Array.isArray(raw)) return null;
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item === 'string' && item.length <= 32 && CHANGE_LANG_RE.test(item)) {
        seen.add(item);
      }
    }
    return [...seen];
  };

  if ('configuredLanguages' in rec && rec['configuredLanguages'] !== undefined) {
    const parsed = parseLangArray(rec['configuredLanguages']);
    if (parsed === null) return null;
    patch.configuredLanguages = parsed;
    hasField = true;
  }

  if ('languages' in rec && rec['languages'] !== undefined) {
    const parsed = parseLangArray(rec['languages']);
    if (parsed === null) return null;
    patch.languages = patch.configuredLanguages
      ? parsed.filter((l) => patch.configuredLanguages!.includes(l))
      : parsed;
    hasField = true;
  }

  if ('customWordsByProfile' in rec && rec['customWordsByProfile'] !== undefined) {
    const mapRec = asRecord(rec['customWordsByProfile']);
    if (mapRec === null) return null;
    const normalized: Record<string, string[]> = {};
    for (const profileId of Object.keys(mapRec).sort()) {
      if (!isValidBrowserProfileId(profileId)) return null;
      const rawList = mapRec[profileId];
      if (!Array.isArray(rawList)) return null;
      const seen = new Set<string>();
      for (const item of rawList) {
        if (typeof item !== 'string' || item.length > 128 || /[\r\n\0]/.test(item)) continue;
        const clean = item.trim();
        if (clean.length > 0 && clean.length <= 128) seen.add(clean);
      }
      if (seen.size > 0) normalized[profileId] = [...seen];
    }
    patch.customWordsByProfile = normalized;
    hasField = true;
  }

  return hasField ? patch : null;
}

function parseBrowserSettingsPatch(value: unknown): BrowserSettingsPatch | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const patch: BrowserSettingsPatch = {};
  let hasField = false;

  if ('defaultSearchEngine' in rec && rec['defaultSearchEngine'] !== undefined) {
    const engine = asNonEmptyString(rec['defaultSearchEngine']);
    if (engine === null || engine.length > 128) return null;
    patch.defaultSearchEngine = engine;
    hasField = true;
  }

  if ('favorites' in rec && rec['favorites'] !== undefined) {
    if (!Array.isArray(rec['favorites'])) return null;
    const parsed = asArrayFiltered(rec['favorites'], parseBrowserFavorite);
    if (parsed === null) return null;
    patch.favorites = parsed;
    hasField = true;
  }

  if ('searchEngines' in rec && rec['searchEngines'] !== undefined) {
    if (!Array.isArray(rec['searchEngines'])) return null;
    if (rec['searchEngines'].length === 0) {
      patch.searchEngines = [];
    } else {
      const parsed = asArrayFiltered(rec['searchEngines'], parseSearchEngine);
      if (parsed === null || parsed.length === 0) return null;
      patch.searchEngines = parsed;
    }
    hasField = true;
  }

  if ('spellCheck' in rec && rec['spellCheck'] !== undefined) {
    const parsedSpellCheck = parseChangeSpellCheck(rec['spellCheck']);
    if (parsedSpellCheck === null) return null;
    patch.spellCheck = parsedSpellCheck;
    hasField = true;
  }

  return hasField ? patch : null;
}

function parseCustomDictionaryMutation(value: unknown): CustomDictionaryMutation | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const action = rec['action'];
  const profileId = rec['profileId'];
  if (typeof profileId !== 'string' || !isValidBrowserProfileId(profileId)) return null;
  if (action === 'clear-profile') {
    if (profileId === DEFAULT_BROWSER_PROFILE_ID) return null;
    return { action: 'clear-profile', profileId };
  }
  if (action === 'add' || action === 'remove') {
    const rawWord = rec['word'];
    if (typeof rawWord !== 'string' || rawWord.length > 128 || /[\r\n\0]/.test(rawWord)) return null;
    const word = rawWord.trim();
    if (word.length === 0 || word.length > 128) return null;
    return { action, profileId, word };
  }
  return null;
}

export function parseAppSettingsChange(record: Record<string, unknown>): AppSettingsChange | null {
  const rawShell = record['consoleShell'];
  const rawAgents = record['disabledAgents'];
  const rawBrowser = record['browser'];
  const rawCustomDict = record['customDictionary'];
  const consoleShell = rawShell === undefined ? undefined : asConsoleShellId(rawShell);
  const disabledAgents = rawAgents === undefined ? undefined : asAgentIdList(rawAgents);
  let browser: BrowserSettingsPatch | undefined;
  if (rawBrowser !== undefined) {
    const parsed = parseBrowserSettingsPatch(rawBrowser);
    if (parsed === null) return null;
    browser = parsed;
  }
  let customDictionary: CustomDictionaryMutation | undefined;
  if (rawCustomDict !== undefined) {
    const parsed = parseCustomDictionaryMutation(rawCustomDict);
    if (parsed === null) return null;
    customDictionary = parsed;
  }
  if (consoleShell === null || disabledAgents === null) return null;
  if (consoleShell === undefined && disabledAgents === undefined && browser === undefined && customDictionary === undefined) return null;
  return {
    ...(consoleShell !== undefined ? { consoleShell } : {}),
    ...(disabledAgents !== undefined ? { disabledAgents } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(customDictionary !== undefined ? { customDictionary } : {}),
  };
}
