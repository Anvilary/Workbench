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
    case 'working': return t('agency.notifications.statusWorking');
    case 'failed': return t('agency.notifications.statusFailed');
    case 'idle': return t('agency.notifications.statusIdle');
    default: return t('agency.notifications.statusUnknown');
  }
}
