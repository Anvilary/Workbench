import {
  CLI_PROVIDERS, PROFILE_ENV_RULES,
  type CliProfileId, type CliProvider,
} from '@agent-workbench/shared';
import { resolveConfiguredExecutable } from './executable.js';

export interface ProfileDefinition {
  readonly id: CliProfileId;
  readonly provider: CliProvider;
  readonly label: string;
  /** Empty until explicitly configured. Never infer another account's binary. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly disabled: boolean;
}

export type ProfileChanges = Partial<Pick<ProfileDefinition,
  'label' | 'executable' | 'args' | 'environmentOverrides' | 'disabled'>>;

export const SUPPORTED_PROVIDERS: readonly CliProvider[] = CLI_PROVIDERS;

const templates: readonly [string, CliProvider, string][] = [
  ['codex-0', 'codex', 'Codex 00'],
  ['codex-1', 'codex', 'Codex 01'],
  ['codex-3', 'codex', 'Codex 03'],
  ['agy-0', 'antigravity', 'AGY 00'],
  ['agy-1', 'antigravity', 'AGY 01'],
  ['agy-2', 'antigravity', 'AGY 02'],
  ['agy-3', 'antigravity', 'AGY 03'],
  ['agy-4', 'antigravity', 'AGY 04'],
  ['agy-5', 'antigravity', 'AGY 05'],
  ['claude-code', 'claude-code', 'Claude Code'],
];

export const PROFILE_IDS = templates.map(([id]) => id) as readonly string[];

export function defaultDefinitions(): ProfileDefinition[] {
  return templates.map(([id, provider, label]) => ({
    id: id as CliProfileId,
    provider,
    label,
    executable: '',
    args: [],
    environmentOverrides: {},
    disabled: false,
  }));
}

const ENV_RULES = PROFILE_ENV_RULES;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnv(value: unknown): Record<string, string> {
  if (!record(value)) throw new Error('Profile environment overrides must be an object.');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    const rule = Object.hasOwn(ENV_RULES, key) ? ENV_RULES[key] : undefined;
    if (rule === undefined || typeof item !== 'string' || !rule.test(item)) {
      throw new Error('Profile environment override is not in the reviewed non-secret allowlist: ' + key);
    }
    result[key] = item;
  }
  return result;
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('Profile args must be an argument array of at most 64 items.');
  }
  const result: string[] = [];
  for (const arg of value) {
    if (typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg)) {
      throw new Error('Invalid profile argument.');
    }
    // Never persist credential material as command-line configuration.
    if (/(?:^|[-_])(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|oauth|secret|password|credential)(?:$|[-_=])/i.test(arg)) {
      throw new Error('Credential-bearing arguments are not accepted.');
    }
    result.push(arg);
  }
  return result;
}

export function validateDefinition(id: string, input: unknown): ProfileDefinition {
  if (typeof id !== 'string' || id.trim().length < 1 || id.length > 64 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('Invalid profile ID: ' + id);
  }
  if (!record(input)) throw new Error('Invalid profile record.');
  if (input['id'] !== id) {
    throw new Error('Profile identity and provider cannot change.');
  }
  const template = defaultDefinitions().find((item) => item.id === id);
  let provider: CliProvider;
  if (template !== undefined) {
    if (input['provider'] !== template.provider) {
      throw new Error('Profile identity and provider cannot change.');
    }
    provider = template.provider;
  } else {
    const rawProvider = input['provider'];
    if (typeof rawProvider !== 'string' || !SUPPORTED_PROVIDERS.includes(rawProvider as CliProvider)) {
      throw new Error('Invalid profile provider: ' + String(rawProvider));
    }
    provider = rawProvider as CliProvider;
  }

  const label = input['label'];
  const executable = input['executable'];
  const disabled = input['disabled'];
  if (typeof label !== 'string' || label.trim().length < 1 || label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Invalid profile label.');
  if (typeof executable !== 'string' || executable.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(executable)) throw new Error('Invalid profile executable.');
  // Empty is intentionally unconfigured. Relative paths and command names are not
  // shell commands; validation/resolution happens before launch.
  if (typeof disabled !== 'boolean') throw new Error('Invalid profile disabled flag.');
  return {
    id: id as CliProfileId,
    provider,
    label: label.trim(),
    executable,
    args: validateArgs(input['args']),
    environmentOverrides: validateEnv(input['environmentOverrides']),
    disabled,
  };
}

export interface CreateProfileParams {
  readonly id?: string;
  readonly provider: CliProvider;
  readonly label?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}

export function createProfileDefinition(params: CreateProfileParams, existingIds: readonly string[] = []): ProfileDefinition {
  if (!SUPPORTED_PROVIDERS.includes(params.provider)) {
    throw new Error('Invalid profile provider: ' + String(params.provider));
  }
  let id = params.id?.trim();
  if (!id) {
    let counter = 0;
    const prefix = params.provider === 'claude-code' ? 'claude' : params.provider;
    do {
      id = `${prefix}${counter < 10 ? '0' + counter : counter}`;
      counter++;
    } while (existingIds.includes(id));
  }
  const defaultLabels: Record<CliProvider, string> = {
    codex: 'Codex',
    antigravity: 'AGY',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    pi: 'Pi',
  };
  const label = params.label?.trim() || `${defaultLabels[params.provider]} (${id})`;
  return validateDefinition(id, {
    id,
    provider: params.provider,
    label,
    executable: params.executable ?? '',
    args: params.args ?? [],
    environmentOverrides: params.environmentOverrides ?? {},
    disabled: params.disabled ?? false,
  });
}

export function applyProfileChanges(current: ProfileDefinition, changes: ProfileChanges): ProfileDefinition {
  if (!record(changes)) throw new Error('Invalid profile changes.');
  for (const key of Object.keys(changes)) {
    if (!['label', 'executable', 'args', 'environmentOverrides', 'disabled'].includes(key)) {
      throw new Error('Unsupported profile configuration field: ' + key);
    }
  }
  return validateDefinition(current.id, { ...current, ...changes });
}

/** A fresh process environment for each launch, with no global mutation. */
export function isolatedEnvironment(
  inherited: NodeJS.ProcessEnv,
  filtered: Record<string, string>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  // The caller supplies adapter-filtered environment; never reintroduce keys
  // removed by the original Workbench adapter.
  void inherited;
  const env: Record<string, string> = { ...filtered };
  const reviewed = validateEnv(overrides);
  for (const [key, value] of Object.entries(reviewed)) env[key] = value;
  return env;
}

/**
 * Another enabled profile of the same provider whose launch plan is identical (same resolved entry point,
 * literal args and overrides) necessarily runs the same native account under a different label. Profiles
 * that share a binary but differ in args remain allowed: args may legitimately select another account.
 */
export async function identicalLaunchPeer(
  definition: ProfileDefinition,
  all: readonly ProfileDefinition[],
  environment: NodeJS.ProcessEnv,
): Promise<ProfileDefinition | null> {
  if (definition.disabled || !definition.executable) return null;
  const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const sameEnv = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
    Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
  const own = await resolveConfiguredExecutable(definition.executable, environment);
  for (const other of all) {
    if (other.id === definition.id || other.provider !== definition.provider || other.disabled || !other.executable) continue;
    if (!sameArgs(other.args, definition.args) || !sameEnv(other.environmentOverrides, definition.environmentOverrides)) continue;
    if (other.executable === definition.executable) return other;
    const theirs = await resolveConfiguredExecutable(other.executable, environment);
    if (own.status === 'available' && theirs.status === 'available' && own.file === theirs.file) return other;
  }
  return null;
}

export function identicalLaunchMessage(peer: ProfileDefinition): string {
  return `Same executable and arguments as ${peer.label}: both would run the same native account. Give each profile its own account wrapper.`;
}
