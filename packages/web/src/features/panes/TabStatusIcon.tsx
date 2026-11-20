import type { MawActivityState } from '@agent-workbench/shared';
import { agencySessionText, agencyTabActivityText } from '../workspaces/workspace-labels.js';
import { GlobeIcon } from '../../shared/ui/GlobeIcon.js';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import { t } from '../../i18n/index.js';

export function resolvePaneTabStatus(
  tab: WorkspaceTab,
  tabState: MawActivityState | undefined,
  isUnsaved: boolean | undefined,
): { status: string; dotClass: string } {
  const session = tab.kind === 'native' ? tab.session : undefined;
  const status = tabState
    ? agencyTabActivityText(tabState)
    : session
      ? agencySessionText(session)
      : tab.kind === 'editor'
        ? (isUnsaved ? t('docs.edit.unsaved') : t('agency.tabs.editor'))
        : t('agency.web.tabKind');

  const dotClass =
    tab.kind === 'editor'
      ? (isUnsaved ? 'attention' : 'idle')
      : tabState === 'finished'
        ? 'finished'
        : tabState === 'failed' ||
            session?.lifecycle === 'failed' ||
            session?.recovery?.status === 'manual' ||
            (tab.kind === 'web' && ['error', 'crashed'].includes(tab.web.runtimeState ?? ''))
          ? 'failed'
          : session?.lifecycle === 'exited'
            ? 'muted'
            : session && ['awaiting-user', 'awaiting-permission'].includes(session.activity)
              ? 'attention'
              : (tab.kind === 'web' && ['navigating', 'attaching'].includes(tab.web.runtimeState ?? ''))
                ? 'working'
                : tabState === 'needs-input'
                  ? 'attention'
                  : tabState ?? (session?.activity === 'working' ? 'working' : session?.activity === 'idle' ? 'idle' : 'unknown');

  return { status, dotClass };
}

export function PaneTabIcon({ tab, favicon }: { tab: WorkspaceTab; favicon?: string }): JSX.Element {
  if (tab.kind === 'web') {
    if (favicon) {
      return (
        <span className="maw-tab-icon-wrapper" aria-hidden="true">
          <img
            className="maw-tab-favicon"
            src={favicon}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = 'inline-flex';
            }}
          />
          <span className="maw-tab-icon-fallback" style={{ display: 'none' }}>
            <GlobeIcon size={14} />
          </span>
        </span>
      );
    }
    return (
      <span className="maw-tab-icon-fallback" aria-hidden="true">
        <GlobeIcon size={14} />
      </span>
    );
  }
  if (tab.kind === 'editor') return <span aria-hidden="true">✎</span>;
  if (tab.session?.kind === 'agent') return <span aria-hidden="true">◇</span>;
  return <span aria-hidden="true">&gt;_</span>;
}
