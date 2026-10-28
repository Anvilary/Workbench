import type { SessionActivity, SessionLifecycle } from '@agent-workbench/shared';
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
