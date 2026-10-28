import type { MawActivityState } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

export function notificationText(item: {
  title: string; body: string; state: MawActivityState;
  metadata?: Record<string, unknown>; deduplicationKey?: string;
}): { title: string; body: string } {
  const kind = item.metadata?.kind ?? (item.deduplicationKey?.startsWith('cli-') ? 'cli' : item.deduplicationKey?.startsWith('shell-') ? 'shell' : undefined);
  const tabName = typeof item.metadata?.tabName === 'string' ? item.metadata.tabName : item.title;
  const title = tabName === 'CLI Agent' ? t('agency.ui.agentLabel') : tabName === 'Terminal' ? t('agency.ui.shell') : tabName;
  if (!['cli', 'shell', 'browser'].includes(String(kind))) return { title, body: item.body };
  if (item.state !== 'finished' && item.state !== 'failed') {
    return { title, body: item.state === 'working' ? t('agency.notifications.statusWorking') : item.state === 'unknown' ? t('agency.notifications.statusUnknown') : t('agency.notifications.statusIdle') };
  }
  const failed = item.state === 'failed';
  const body = kind === 'shell'
    ? failed ? typeof item.metadata?.exitCode === 'number' ? t('agency.notifications.commandFailedCode', { code: item.metadata.exitCode }) : t('agency.notifications.commandFailed') : t('agency.notifications.commandFinished')
    : failed ? t('agency.notifications.taskFailed') : t('agency.notifications.taskFinished');
  return { title, body };
}
