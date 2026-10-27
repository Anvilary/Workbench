/**
 * Server-only profile availability, native adapter reuse, and launch plan.
 * No direct provider APIs or active authentication/model probing.
 */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgencyCliProfile, AgencyModelOption, AgencyProfileCapabilities,
  CliProfileId, CliProvider, AgentId,
} from '@agent-workbench/shared';
import type { LaunchSession } from '../agents/adapter.js';
import type { AgentRegistry } from '../agents/registry.js';
import {
  isolatedEnvironment, type ProfileDefinition,
} from '../agents/profiles/definition.js';
import { resolveConfiguredExecutable } from '../agents/profiles/executable.js';
import type { AgencyProfileStore } from './agency-profile-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedNativeCatalog {
  /** Trusted server-side observation from THIS profile's original CLI, not a static list. */
  readonly profileId: CliProfileId;
  readonly provider: CliProvider;
  readonly models: readonly AgencyModelOption[];
}

/**
 * CLI-provided catalogs must be supplied by a future verified native discovery
 * path. Existing Workbench model constants and cached history are NOT
 * account-specific evidence and cannot be used as live availability claims.
 */
export interface CapabilityContext {
  readonly environment?: NodeJS.ProcessEnv;
  readonly catalog?: VerifiedNativeCatalog | null;
}

export async function inspectAgencyProfile(
  definition: ProfileDefinition,
  registry: AgentRegistry,
  context: CapabilityContext = {},
): Promise<AgencyCliProfile> {
  const empty: AgencyProfileCapabilities = {
    canLaunch: false, canResumeNativeSession: false, canInterrupt: false,
    canReportActivity: false, canSelectModel: false, canSelectEffort: false,
    canRequestPermissions: false, models: [], discovery: 'unavailable',
  };
  const base = context.environment ?? process.env;
  const registered = registry.get(definition.provider as AgentId);
  let configurationStatus: AgencyCliProfile['configurationStatus'] = 'error';
  let configurationMessage: string | null = null;
  let capabilities = empty;

  if (definition.disabled) {
    configurationStatus = 'disabled';
    configurationMessage = 'Profile disabled.';
  } else if (registered === null) {
    configurationMessage = 'Workbench native adapter unavailable.';
  } else {
    const located = await resolveConfiguredExecutable(definition.executable, base);
    if (located.status !== 'available') {
      configurationStatus = located.status;
      configurationMessage = located.reason;
    } else {
      configurationStatus = 'available';
      configurationMessage = 'Executable available; native CLI authentication has not been checked.';
      // This means the executable is found, NOT that the account is authenticated.
      // Only the native CLI can determine authentication when launched.
      const native = registered.adapter.capabilities;
      const evidence = context.catalog;
      const verified = evidence?.profileId === definition.id &&
        evidence.provider === definition.provider;
      capabilities = {
        canLaunch: true,
        canResumeNativeSession: native.resume,
        canInterrupt: registered.adapter.input.interruptPresses > 0,
        canReportActivity: native.statusSource,
        // Existing TUI model/effort shortcuts have no reliable synchronous
        // acknowledgement. Selection via agency.session.selection.set is off.
        canSelectModel: false,
        canSelectEffort: false,
        canRequestPermissions: native.permissionCycle !== null,
        models: verified ? [...evidence.models] : [],
        discovery: verified ? 'native' : 'unavailable',
      };
    }
  }

  return {
    id: definition.id,
    label: definition.label,
    provider: definition.provider,
    executable: definition.executable,
    args: [...definition.args],
    environmentOverrides: { ...definition.environmentOverrides },
    capabilities,
    configurationStatus,
    configurationMessage,
  };
}

export async function listAgencyProfiles(
  store: AgencyProfileStore, registry: AgentRegistry, context: CapabilityContext = {},
): Promise<readonly AgencyCliProfile[]> {
  const definitions = await store.listDefinitions();
  return Promise.all(definitions.map((definition) => inspectAgencyProfile(definition, registry, context)));
}

export interface ProfileLaunchRequest {
  readonly profileId: CliProfileId;
  /** Already validated and selected by the workspace lane, never from a client launch request. */
  readonly cwd: string;
  readonly resumeNativeSessionId?: string | null;
  readonly proposedSessionId: string;
  readonly launchToken: string;
  readonly model?: string;
  readonly effort?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ValidatedProfileLaunch {
  readonly profileId: CliProfileId;
  readonly provider: CliProvider;
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly session: LaunchSession;
  readonly environmentNotice: string | null;
}

/**
 * Consumable by Lane C: construct a single native Workbench adapter launch
 * with a profile-local, already filtered process environment. Throws instead
 * of switching accounts, starting a different adapter or guessing flags.
 */
export async function buildAgencyProfileLaunch(
  store: AgencyProfileStore,
  registry: AgentRegistry,
  request: ProfileLaunchRequest,
): Promise<ValidatedProfileLaunch> {
  const definition = await store.getDefinition(request.profileId);
  if (definition === null) throw new Error('Unknown Agency CLI profile.');
  if (definition.disabled) throw new Error('Agency CLI profile is disabled.');
  if (request.model !== undefined || request.effort !== undefined) {
    throw new Error('Native model or effort selection has no verified acknowledgement path.');
  }
  if (!UUID.test(request.proposedSessionId) || !UUID.test(request.launchToken)) {
    throw new Error('Invalid runtime native session proposal or launch token.');
  }
  if (request.resumeNativeSessionId != null && !UUID.test(request.resumeNativeSessionId)) {
    throw new Error('Invalid native resume session ID.');
  }
  if (!path.isAbsolute(request.cwd) || await realpath(request.cwd) !== request.cwd ||
      !(await stat(request.cwd)).isDirectory()) {
    throw new Error('Workspace directory must exist and be canonical.');
  }

  const entry = registry.get(definition.provider as AgentId);
  if (entry === null) throw new Error('Native Workbench adapter unavailable.');
  const base = request.environment ?? process.env;
  const executable = await resolveConfiguredExecutable(definition.executable, base);
  if (executable.status !== 'available') throw new Error(executable.reason);

  const location = { resolvedPath: executable.file, file: executable.file, prefixArgs: [], version: null };
  const native = await entry.adapter.launch({
    location,
    cwd: request.cwd,
    resumeSessionId: request.resumeNativeSessionId ?? null,
    proposedSessionId: request.proposedSessionId,
    launchToken: request.launchToken,
  });
  if (native.file !== executable.file) {
    throw new Error('Native adapter returned a different executable.');
  }
  const adapterEnv = entry.adapter.environment(base);
  const env = isolatedEnvironment(base, adapterEnv.env, definition.environmentOverrides);
  return {
    profileId: definition.id,
    provider: definition.provider,
    file: executable.file,
    args: [...definition.args, ...native.args],
    cwd: request.cwd,
    env,
    session: native.session,
    environmentNotice: adapterEnv.notice,
  };
}
