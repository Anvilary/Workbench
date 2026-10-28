import type { CliProfileId, CliProvider } from '@agent-workbench/shared';

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

const templates: readonly [string, CliProvider, string][] = [
  ['codex00', 'codex', 'Codex 00'],
  ['codex01', 'codex', 'Codex 01'],
  ['codex03', 'codex', 'Codex 03'],
  ['agy00', 'antigravity', 'AGY 00'],
  ['agy01', 'antigravity', 'AGY 01'],
  ['agy02', 'antigravity', 'AGY 02'],
  ['agy03', 'antigravity', 'AGY 03'],
  ['agy04', 'antigravity', 'AGY 04'],
  ['agy05', 'antigravity', 'AGY 05'],
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

const ENV_RULES: Readonly<Record<string, RegExp>> = {
  LANG: /^[A-Za-z0-9_.@-]{1,80}$/,
  LC_ALL: /^[A-Za-z0-9_.@-]{1,80}$/,
  LC_CTYPE: /^[A-Za-z0-9_.@-]{1,80}$/,
  TERM: /^[A-Za-z0-9_.+-]{1,80}$/,
  COLORTERM: /^(truecolor|24bit)$/,
  NO_COLOR: /^(|1)$/,
  FORCE_COLOR: /^[0-3]$/,
};

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
  const template = defaultDefinitions().find((item) => item.id === id);
  if (template === undefined) throw new Error('Unknown CLI profile: ' + id);
  if (!record(input)) throw new Error('Invalid profile record.');
  if (input['id'] !== id || input['provider'] !== template.provider) {
    throw new Error('Profile identity and provider cannot change.');
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
    id: template.id,
    provider: template.provider,
    label: label.trim(),
    executable,
    args: validateArgs(input['args']),
    environmentOverrides: validateEnv(input['environmentOverrides']),
    disabled,
  };
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
