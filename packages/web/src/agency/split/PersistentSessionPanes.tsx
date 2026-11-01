import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AgencyCliProfile, AgencyRuntimeSession, WorkspacePaneLayout } from '@agent-workbench/shared';
import { getPaneNodes } from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection.js';
import type { AgencyTransport, WorkspaceTab } from '../model.js';
import type { useAgencyStore } from '../useAgencyStore.js';
import { SessionPane } from './SessionPane.js';

interface Props {
  tabs: readonly WorkspaceTab[];
  layout: WorkspacePaneLayout;
  paneHosts: { readonly current: Map<string, HTMLElement> };
  hostVersion: number;
  profiles: readonly AgencyCliProfile[];
  connection: AgentConnection;
  online: boolean;
  busy: boolean;
  request: ReturnType<typeof useAgencyStore>['request'];
  sendImmediate: AgencyTransport['sendImmediate'];
  report: (error: string) => void;
  onDisplayed: (tabId: string, ready: boolean) => void;
  onConfigure: (profile: AgencyCliProfile) => void;
  onStartAgain: (session: AgencyRuntimeSession) => void;
  workspaceCwd?: string;
}

/**
 * One xterm per live tab, portaled through a stable holder.
 * Moving the holder between panes does not remount TerminalView, so scrollback,
 * selection and the PTY attachment survive tab switches and pane moves.
 * Holders are removed only when the tab leaves this workspace view.
 */
export function PersistentSessionPanes({
  tabs,
  layout,
  paneHosts,
  hostVersion,
  profiles,
  connection,
  online,
  busy,
  request,
  sendImmediate,
  report,
  onDisplayed,
  onConfigure,
  onStartAgain,
  workspaceCwd,
}: Props): JSX.Element {
  const holders = useRef(new Map<string, HTMLDivElement>());
  const park = useRef<HTMLDivElement>(null);
  const nativeTabs = tabs.filter((tab): tab is Extract<WorkspaceTab, { kind: 'native' }> => tab.kind === 'native');

  const placementKey = nativeTabs.map((tab) => {
    const pane = getPaneNodes(layout.tree).find((item) => item.tabIds.includes(tab.id));
    const paneVisible = !!pane && (!layout.maximizedPaneId || layout.maximizedPaneId === pane.id);
    const selected = paneVisible && pane?.selectedTabId === tab.id;
    return `${tab.id}:${paneVisible ? pane?.id ?? '' : ''}:${selected ? '1' : '0'}`;
  }).join('|') + '#' + hostVersion;

  useLayoutEffect(() => {
    const live = new Set(nativeTabs.map((tab) => tab.id));
    for (const tab of nativeTabs) {
      let holder = holders.current.get(tab.id);
      if (!holder) {
        holder = document.createElement('div');
        holder.className = 'maw-session-holder';
        holder.dataset.tabId = tab.id;
        holders.current.set(tab.id, holder);
      }
      const pane = getPaneNodes(layout.tree).find((item) => item.tabIds.includes(tab.id));
      const paneVisible = !!pane && (!layout.maximizedPaneId || layout.maximizedPaneId === pane.id);
      const host = pane && paneVisible ? paneHosts.current.get(pane.id) : undefined;
      const parent = host ?? park.current;
      if (parent && holder.parentElement !== parent) parent.appendChild(holder);
      const selected = paneVisible && pane?.selectedTabId === tab.id;
      holder.hidden = !selected;
    }
    for (const [id, holder] of holders.current) {
      if (!live.has(id)) {
        holder.remove();
        holders.current.delete(id);
      }
    }
  }, [placementKey, layout, nativeTabs, paneHosts]);

  useLayoutEffect(() => {
    const map = holders.current;
    return () => {
      for (const holder of map.values()) holder.remove();
      map.clear();
    };
  }, []);

  return (
    <>
      <div ref={park} hidden className="maw-terminal-park" />
      {nativeTabs.map((tab) => {
        let holder = holders.current.get(tab.id);
        if (!holder) {
          holder = document.createElement('div');
          holder.className = 'maw-session-holder';
          holder.dataset.tabId = tab.id;
          holders.current.set(tab.id, holder);
        }
        const pane = getPaneNodes(layout.tree).find((item) => item.tabIds.includes(tab.id));
        const paneVisible = !!pane && (!layout.maximizedPaneId || layout.maximizedPaneId === pane.id);
        const active = paneVisible && pane?.selectedTabId === tab.id;
        const profile = tab.session.kind === 'agent'
          ? profiles.find((item) => item.id === tab.session.profileId)
          : undefined;
        return createPortal(
          <SessionPane
            session={tab.session}
            active={active}
            focusTerminal={active && layout.focusedPaneId === pane?.id}
            connection={connection}
            online={online}
            request={request}
            sendImmediate={sendImmediate}
            report={report}
            onDisplayed={onDisplayed}
            profile={profile}
            busy={busy}
            onConfigure={onConfigure}
            onStartAgain={onStartAgain}
            workspaceCwd={workspaceCwd}
          />,
          holder,
          tab.id,
        );
      })}
    </>
  );
}
