import type { AgencyRuntimeSession, MawActivityState, SessionActivity, SessionLifecycle } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

/** Workbench keeps transport lifecycle enums independent of translated UI copy. */
export function agencyActivityText(activity: SessionActivity, lifecycle: SessionLifecycle): string {
  if (lifecycle === 'exited') return t('agency.ui.exited');
  if (lifecycle === 'failed') return t('agency.ui.failed');
  if (lifecycle === 'starting') return t('agency.ui.starting');
  if (lifecycle === 'stopping') return t('agency.ui.stopping');
  switch (activity) {
    case 'working': return t('agency.ui.working');
    case 'idle': return t('agency.ui.idle');
    case 'awaiting-user': return t('agency.ui.needsInput');
    case 'awaiting-permission': return t('agency.ui.permissionRequired');
    case 'offline': return t('agency.ui.offline');
    default:
      if (lifecycle === 'running') return t('agency.ui.runningActivityUnavailable');
      return t('agency.ui.activityUnknown');
  }
}

export function agencySessionText(session: AgencyRuntimeSession): string {
  if (session.stoppedByUser) return t('agency.ui.stopped');
  if (session.recovery?.status === 'resuming' || session.recovery?.status === 'pending') return t('agency.ui.resuming');
  if (session.recovery?.status === 'manual') return t('agency.ui.manualResumeRequired');
  if (session.recovery?.status === 'resumed' && session.lifecycle === 'running' && session.activity === 'unknown') return t('agency.ui.resumed');
  return agencyActivityText(session.activity, session.lifecycle);
}

export function agencyErrorText(code: import('@agent-workbench/shared').AgencyErrorCode): string {
  switch (code) {
    case 'invalid-request': return t('agency.errors.invalidRequest');
    case 'not-found': return t('agency.errors.notFound');
    case 'conflict': return t('agency.errors.conflict');
    case 'invalid-directory': return t('agency.errors.invalidDirectory');
    case 'profile-unavailable': return t('agency.errors.profileUnavailable');
    case 'unsupported-capability': return t('agency.errors.unsupportedCapability');
    case 'session-unavailable': return t('agency.errors.sessionUnavailable');
    case 'permission-denied': return t('agency.errors.permissionDenied');
    default: return t('agency.errors.internalError');
  }
}

export function agencyTabActivityText(state: MawActivityState): string {
  switch (state) {
    case 'finished': return t('agency.notifications.statusFinished');
    case 'needs-input': return t('agency.ui.needsInput');
    case 'working': return t('agency.notifications.statusWorking');
    case 'failed': return t('agency.notifications.statusFailed');
    case 'idle': return t('agency.notifications.statusIdle');
    default: return t('agency.notifications.statusUnknown');
  }
}

/**
 * Preserved Agency localization contract keys.
 * Retained across all nine language catalogs for backwards compatibility and localization contracts.
 */
export const PRESERVED_AGENCY_I18N_KEYS = [
  'agency.profile.configureAction',
  'agency.profile.notConfiguredBanner',
  'agency.splits.splitDown',
  'agency.splits.splitRight',
  'agency.tabs.combined',
  'agency.tabs.newCLI',
  'agency.ui.agentComposer',
  'agency.ui.agentDidNotStart',
  'agency.ui.agentWorkspace',
  'agency.ui.askTheOriginalCLIToInterrupt',
  'agency.ui.cLIDefault',
  'agency.ui.cLIProfile',
  'agency.ui.chooseCLI',
  'agency.ui.chooseInstalledCLIProfile',
  'agency.ui.cliProfile',
  'agency.ui.clipboardDenied',
  'agency.ui.currentRunningAgentProfile',
  'agency.ui.defaultEffort',
  'agency.ui.disconnectedSendingAndLaunchingAreDisabled',
  'agency.ui.editProjectName',
  'agency.ui.emptyWorkspace',
  'agency.ui.messageTheAgent',
  'agency.ui.messageToAgent',
  'agency.ui.messageWasNotConfirmed',
  'agency.ui.model',
  'agency.ui.modelAndEffortUseNativeCLIDefaultsWhen',
  'agency.ui.modelDiscoveryUnavailableNativeCLIDefaultRemainsIn',
  'agency.ui.nativeCLIAuthenticationAndPermissionsRemainInControl',
  'agency.ui.newWorkspaceIn',
  'agency.ui.noVerifiedEffortControlsForThisModel',
  'agency.ui.previousSessionEndedSelectANewAgentSession',
  'agency.ui.profileDisabled',
  'agency.ui.profileMisconfigured',
  'agency.ui.profileMissingBinary',
  'agency.ui.profileReady',
  'agency.ui.reasoningEffort',
  'agency.ui.send',
  'agency.ui.sendPrompt',
  'agency.ui.sending',
  'agency.ui.settingWasNotApplied',
  'agency.ui.startAgent',
  'agency.ui.startCLI',
  'agency.ui.startTheAgentThenSendYourPrompt',
  'agency.ui.startingInProgress',
  'agency.ui.terminalOnlyWorkspace',
  'agency.ui.thisCLIProfileIsUnavailable',
  'agency.ui.unavailableSuffix',
  'agency.ui.workspaceType',
  'common.save',
  'terminal.replayTruncated',
  'theme.light',
  'theme.system',
] as const;

