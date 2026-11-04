import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgencyProject, AgencyWorkspace, ProjectId, WorkspaceId } from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { AgencySidebar, AgencyDoneView, SidebarToggleIcon } from './AgencySidebar.js';
import { AgencyWorkspaceCreator, AgencyProjectCreator } from './AgencyWorkspaceCreator.js';
import { AgencyWorkspaceView } from './AgencyWorkspaceView.js';
import { useAgencyStore } from './useAgencyStore.js';
import { useNotificationStore } from './useNotificationStore.js';
import { NotificationBell } from './NotificationBell.js';
import { NotificationInbox, type DesktopPermission } from './NotificationInbox.js';
import { NotificationToastContainer } from './NotificationToast.js';
import { acknowledgeWorkspaceDraft, createAgencyTransport, putWorkspaceDraft, allWorkspaceTabs } from './model.js';
import { t } from '../i18n/index.js';
import { useLocale } from '../i18n/useLocale.js';
import './agency.css';
import { useDropdownDismissal } from './useDropdownDismissal.js';
import { useNativeChatGptTabs } from './useNativeChatGptTabs.js';

const DRAFT_KEY = 'agency-ui.workspace-drafts.v1';
const SIDEBAR_WIDTH_KEY = 'agency-ui.sidebar-width.v1';
const NOTIFICATIONS_STORAGE_KEY = 'agency-ui.notifications-enabled.v1';

function readNotificationsEnabled(): boolean {
  try {
    const saved = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (saved !== null) return saved === 'true';
    const legacy = localStorage.getItem('agent-workbench.notify');
    if (legacy === 'off') return false;
    if (legacy === 'on') return true;
  } catch {}
  return true;
}

function readDesktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || !('Notification' in window) || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

export function SettingsMenuIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />
    </svg>
  );
}

function readDrafts(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      key.length <= 128 && typeof value === 'string' && value.length <= 100000,
    )) as Record<string, string>;
  } catch { return {}; }
}

/**
 * Integration root for the final integration lane.
 * Caller supplies Workbench's ONE AgentConnection, with the documented
 * non-queueing sendImmediate patch, on its existing authenticated /ws pipeline.
 * No separate socket, backend, process owner, or client-selected cwd is created here.
 */
export function AgencyApp({ connection }: { connection: AgentConnection }): JSX.Element {
  useLocale();
  useDropdownDismissal();
  const agencyTransport = useMemo(() => createAgencyTransport(connection), [connection]);
  const store = useAgencyStore(agencyTransport, connection);
  const { data, loaded, online, synchronized, notice } = store;
  useNativeChatGptTabs(data.webTabs, online && synchronized, store.request);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(readNotificationsEnabled);
  const [desktopPermission, setDesktopPermission] = useState<DesktopPermission>(readDesktopPermission);
  const [selectedId, setSelectedId] = useState<WorkspaceId | null>(() => { try { return localStorage.getItem('agency-ui.selected-workspace.v1') as WorkspaceId | null; } catch { return null; } });
  const [showingDone, setShowingDone] = useState(false);
  const notificationStore = useNotificationStore(agencyTransport, store.request, notificationsEnabled, {
    activeWorkspaceId: selectedId,
    showingDone,
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem('agency-ui.sidebar-open.v1') !== 'false'; } catch { return true; } });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 180 && parsed <= 500) return parsed;
      }
    } catch {}
    return 240;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatorProject, setCreatorProject] = useState<ProjectId | undefined>();
  const [creatingProject, setCreatingProject] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts);
  const [error, setError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [launchErrors, setLaunchErrors] = useState<Record<string, string>>({});
  const navigationSerial = useRef(0);
  const [pendingNavigation, setPendingNavigation] = useState<{ workspaceId: WorkspaceId; tabId: string; notificationId?: string } | null>(null);
  const seenNotice = useRef(new Set<number>());

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Storage optional. */ }
  }, [drafts]);

  useEffect(() => {
    if (!loaded || showingDone) return;
    const active = data.workspaces.filter((ws) => ws.status === 'active' && data.projects.some(project => project.id === ws.projectId && project.status !== 'archived'));
    if (selectedId && active.some((ws) => ws.id === selectedId)) return;
    setSelectedId(active[0]?.id ?? null);
  }, [loaded, showingDone, data.workspaces, data.projects, selectedId]);

  const toggleNotifications = useCallback(() => {
    setNotificationsEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, String(next));
      } catch {}
      if (!next) {
        setStatusToast(null);
      }
      return next;
    });
  }, []);

  const requestDesktopPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || !window.isSecureContext) {
      setDesktopPermission('unsupported');
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setDesktopPermission(perm);
    } catch {
      setDesktopPermission(readDesktopPermission());
    }
  }, []);

  useEffect(() => {
    if (!notice || seenNotice.current.has(notice.serial)) return;
    seenNotice.current.add(notice.serial);
    const ws = data.workspaces.find((item) => item.id === notice.workspaceId);
    const noticeSession = data.sessions.find(session => session.id === notice.sessionId);
    const sessionName = noticeSession?.tab?.name ?? (noticeSession?.kind === 'terminal' ? t('agency.tabs.terminalNamed', { number: noticeSession.tab?.terminalNumber ?? 1 }) : data.profiles.find(profile => profile.id === noticeSession?.profileId)?.label ?? '');
    const label = (ws?.name ?? t('agency.ui.workspace')) + (sessionName ? ' / ' + sessionName : '');
    const message = notice.kind === 'attention' ? t('agency.ui.needsAttentionNamed', { name: label }) : t('agency.ui.completedTurnNamed', { name: label });

    if (notice.kind === 'attention' && noticeSession?.tab?.id) {
      notificationStore.notifySessionAttention({
        workspaceId: notice.workspaceId as WorkspaceId,
        tabId: noticeSession.tab.id,
        sessionId: notice.sessionId,
        title: label,
        body: message,
      });
    }
  }, [notice, data.workspaces, data.sessions, data.profiles, notificationStore]);

  const selected = !showingDone ? data.workspaces.find((ws) => ws.id === selectedId && ws.status === 'active') : undefined;
  useEffect(() => { try { if (selectedId) localStorage.setItem('agency-ui.selected-workspace.v1', selectedId); } catch {} }, [selectedId]);
  const selectedProject = data.projects.find((project) => project.id === selected?.projectId);
  useEffect(() => { try { localStorage.setItem('agency-ui.sidebar-open.v1', String(sidebarOpen)); } catch {} }, [sidebarOpen]);

  const handleTabDisplayed = useCallback((workspaceId: WorkspaceId, tabId: string) => {
    if (!pendingNavigation || pendingNavigation.workspaceId !== workspaceId || pendingNavigation.tabId !== tabId || selectedId !== workspaceId || showingDone || !online || !synchronized) return;
    const notificationId = pendingNavigation.notificationId;
    setPendingNavigation(null);
    if (notificationId) void notificationStore.markRead(notificationId).catch(reason => setError(String(reason)));
  }, [pendingNavigation, selectedId, showingDone, online, synchronized, notificationStore.markRead]);

  async function handleNotificationNavigate(item: { workspaceId: WorkspaceId; tabId?: string; id?: string; notificationId?: string }) {
    const serial = ++navigationSerial.current;
    setPendingNavigation(null);
    const targetWorkspace = data.workspaces.find(ws => ws.id === item.workspaceId && ws.status === 'active' && data.projects.some(project => project.id === ws.projectId && project.status !== 'archived'));
    if (!targetWorkspace) { setError(t('agency.web.workspaceUnavailable')); return; }
    const notificationId = item.notificationId ?? item.id;
    if (item.tabId) {
      const tab = allWorkspaceTabs(data.sessions, data.webTabs, item.workspaceId, data.editorTabs).find(tab => tab.id === item.tabId);
      if (!tab) { setError(t('agency.web.tabUnavailable')); return; }
      try {
        await store.request(tab.kind === 'web'
          ? { type: 'agency.webTab.select', workspaceId: item.workspaceId, tabId: tab.id }
          : tab.kind === 'editor'
            ? { type: 'agency.editorTab.select', workspaceId: item.workspaceId, tabId: tab.id }
            : { type: 'agency.tab.action', workspaceId: item.workspaceId, tabId: tab.id, action: 'select' });
      } catch (reason) { if (serial === navigationSerial.current) setError(reason instanceof Error ? reason.message : t('agency.web.selectFailed')); return; }
      if (serial !== navigationSerial.current) return;
      setPendingNavigation({ workspaceId: item.workspaceId, tabId: tab.id, notificationId });
    }
    setSelectedId(item.workspaceId);
    setShowingDone(false);
    setInboxOpen(false);
    if (!item.tabId && notificationId) {
      // Workspace-only items have no completion result to inspect.
      requestAnimationFrame(() => { if (serial === navigationSerial.current) void notificationStore.markRead(notificationId).catch(reason => setError(String(reason))); });
    }
  }

  useEffect(() => {
    const onSelectTab = (event: Event) => {
      const custom = event as CustomEvent<{ workspaceId: WorkspaceId; tabId?: string; notificationId?: string }>;
      if (custom.detail) void handleNotificationNavigate(custom.detail);
    };
    window.addEventListener('maw:select-tab', onSelectTab);
    return () => window.removeEventListener('maw:select-tab', onSelectTab);
  }, [handleNotificationNavigate]);

  function updateDraft(workspaceId: string, value: string) {
    setDrafts((prev) => putWorkspaceDraft(prev, workspaceId as WorkspaceId, value));
  }

  function clearDelivered(workspaceId: string, original: string) {
    setDrafts((prev) => acknowledgeWorkspaceDraft(prev, workspaceId as WorkspaceId, original));
  }

  function openCreator(project?: ProjectId) {
    if (data.projects.length === 0) { setCreatingProject(true); return; }
    setCreatorProject(project);
    setCreatingWorkspace(true);
  }

  function startSidebarResize(event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const resizerEl = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    try {
      resizerEl.setPointerCapture(pointerId);
    } catch {}
    setResizingSidebar(true);
    let latestWidth = sidebarWidth;

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const clamped = Math.max(180, Math.min(500, e.clientX));
      latestWidth = clamped;
      setSidebarWidth(clamped);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onPointerEnd);
      try {
        if (resizerEl.hasPointerCapture(pointerId)) {
          resizerEl.releasePointerCapture(pointerId);
        }
      } catch {}
      setResizingSidebar(false);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, latestWidth.toString());
      } catch {}
    };

    const onPointerEnd = (e: Event) => {
      if ('pointerId' in e && (e as PointerEvent).pointerId !== pointerId) return;
      cleanup();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('blur', onPointerEnd);
  }

  async function markDone(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.markDone(workspace.id);
      if (answer.type !== 'agency.workspace.done') throw new Error(t('agency.ui.doneWasNotConfirmed'));
      if (selectedId === workspace.id) setSelectedId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.unableToMarkDone')); }
  }

  async function archiveWorkspace(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.archiveWorkspace(workspace.id);
      if (answer.type !== 'agency.workspace.archived') throw new Error(t('agency.errors.internalError'));
      if (selectedId === workspace.id) setSelectedId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.errors.internalError')); }
  }

  async function deleteWorkspace(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.deleteWorkspace(workspace.id);
      if (answer.type !== 'agency.workspace.deleted') {
        const msg = answer.type === 'agency.error' ? answer.message : t('agency.errors.internalError');
        throw new Error(msg);
      }
      if (selectedId === workspace.id) setSelectedId(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('agency.errors.internalError');
      setError(message);
      throw reason;
    }
  }

  async function renameProject(project: AgencyProject, newName: string) {
    setError(null);
    try {
      const answer = await store.renameProject(project.id, newName);
      if (answer.type !== 'agency.project.updated') throw new Error(t('agency.errors.internalError'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.errors.internalError')); }
  }

  async function archiveProject(project: AgencyProject) {
    setError(null);
    try {
      const answer = await store.archiveProject(project.id);
      if (answer.type !== 'agency.project.archived') throw new Error(t('agency.errors.internalError'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.errors.internalError')); }
  }

  async function deleteProject(project: AgencyProject) {
    setError(null);
    try {
      const answer = await store.deleteProject(project.id);
      if (answer.type !== 'agency.project.deleted') throw new Error(t('agency.errors.internalError'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.errors.internalError')); }
  }

  async function restore(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.restore(workspace.id);
      if (answer.type !== 'agency.workspace.restored') throw new Error(t('agency.ui.restoreWasNotConfirmed'));
      setShowingDone(false);
      setSelectedId(workspace.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.unableToRestore')); }
  }

  const doneCount = data.workspaces.filter((ws) => ws.status === 'done' || ws.status === 'archived').length;

  return (
    <div className="agency-app">
      <aside
        className={
          'agency-sidebar' +
          (sidebarOpen ? '' : ' agency-sidebar-collapsed') +
          (resizingSidebar ? ' agency-resizing' : '')
        }
        style={sidebarOpen ? { width: `${sidebarWidth}px`, flexBasis: `${sidebarWidth}px` } : undefined}
      >
        {sidebarOpen && (
          <>
            <AgencySidebar
              onCollapse={() => setSidebarOpen(false)}
              projects={data.projects}
              workspaces={data.workspaces}
              sessions={data.sessions}
              webTabs={data.webTabs}
              selected={selectedId}
              showingDone={showingDone}
              onSelect={(id) => { setSelectedId(id); setShowingDone(false); }}
              onCreate={openCreator}
              onCreateProject={() => setCreatingProject(true)}
              onDone={(ws) => { void markDone(ws); }}
              onArchiveWorkspace={(ws) => { void archiveWorkspace(ws); }}
              onDeleteWorkspace={deleteWorkspace}
              onRenameProject={(p, n) => { void renameProject(p, n); }}
              onArchiveProject={(p) => { void archiveProject(p); }}
              onDeleteProject={(p) => { void deleteProject(p); }}
              onRestore={(ws) => { void restore(ws); }}
            />
            <div
              className="agency-sidebar-resizer"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={t('agency.ui.sidebarResizer')}
              onPointerDown={startSidebarResize}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
                event.preventDefault();
                const width = event.key === 'Home' ? 240 : Math.max(180, Math.min(500, sidebarWidth + (event.key === 'ArrowLeft' ? -10 : 10)));
                setSidebarWidth(width);
                try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch {}
              }}
            />
          </>
        )}
      </aside>
      <div className="agency-main">
        <div className="agency-topbar">
          {!sidebarOpen && (
            <button
              className="agency-icon-button"
              onClick={() => setSidebarOpen(true)}
              type="button"
              aria-label={sidebarOpen ? t('agency.ui.collapseSidebar') : t('agency.ui.expandSidebar')}
              aria-expanded={sidebarOpen}
            >
              <SidebarToggleIcon />
            </button>
          )}
          <nav className="agency-breadcrumbs" aria-label={t('agency.ui.breadcrumbs')}>
            {selected ? (
              <>
                <span title={selectedProject?.name}>{selectedProject?.name}</span>
                <span aria-hidden="true">›</span>
                <span title={selected.name}>{selected.name}</span>
                <span aria-hidden="true">›</span>
                <span className="agency-breadcrumb-path" title={selected.cwd}>{selected.cwd}</span>
              </>
            ) : (
              <span>{showingDone ? t('agency.ui.done') : t('agency.ui.agencyUI')}</span>
            )}
          </nav>
          <span className="agency-flex-spacer" />
          <span className={'agency-connection-state' + (online ? ' connected' : '')}>
            <span className="agency-status-dot" />{online ? t('app.status.open') : t('agency.ui.disconnected')}
          </span>
          <NotificationBell
            unreadCount={notificationStore.unreadCount}
            open={inboxOpen}
            onToggle={() => {
              if (!inboxOpen) setMenuOpen(false);
              setInboxOpen(!inboxOpen);
            }}
          />
          <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`agency-icon-button maw-menu-button ${menuOpen ? 'active' : ''}`}
              aria-label={t('agency.ui.workspaceMenu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={t('agency.ui.workspaceMenu')}
              onClick={() => {
                if (!menuOpen) setInboxOpen(false);
                setMenuOpen(!menuOpen);
              }}
            >
              <SettingsMenuIcon />
            </button>
            {menuOpen && (
              <div className="agency-dropdown-menu maw-shell-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={`agency-dropdown-item maw-menu-item ${showingDone ? 'selected' : ''}`}
                  onClick={() => {
                    setMenuOpen(false);
                    setShowingDone(true);
                  }}
                >
                  <span className="maw-menu-item-text">{t('agency.ui.doneWorkspaces')}</span>
                  {doneCount > 0 && <span className="agency-count">{doneCount}</span>}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="agency-dropdown-item maw-menu-item"
                  disabled={!online}
                  onClick={() => {
                    setMenuOpen(false);
                    store.refresh();
                  }}
                >
                  <span className="maw-menu-item-text">{t('agency.ui.refresh')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="agency-dropdown-item maw-menu-item"
                  disabled={!online}
                  onClick={() => {
                    setMenuOpen(false);
                    openCreator();
                  }}
                >
                  <span className="maw-menu-item-text">{t('agency.ui.newWorkspace')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="agency-dropdown-item maw-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setCreatingProject(true);
                  }}
                >
                  <span className="maw-menu-item-text">{t('agency.ui.newProject')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {inboxOpen && (
          <NotificationInbox
            notifications={notificationStore.notifications}
            unreadCount={notificationStore.unreadCount}
            notificationsEnabled={notificationsEnabled}
            desktopPermission={desktopPermission}
            onToggleNotifications={toggleNotifications}
            onRequestDesktopPermission={requestDesktopPermission}
            onClose={() => setInboxOpen(false)}
            onSelect={handleNotificationNavigate}
            onMarkRead={id => { void notificationStore.markRead(id).catch(reason => setError(String(reason))); }}
            onMarkAllRead={() => { void notificationStore.markAllRead().catch(reason => setError(String(reason))); }}
            onDone={id => { void notificationStore.markDone(id).catch(reason => setError(String(reason))); }}
          />
        )}
        {error && <div role="alert" className="agency-error-bar">{error}
          <button type="button" onClick={() => setError(null)} aria-label={t('agency.ui.dismissError')}>×</button></div>}
        {notificationsEnabled && statusToast && <div className="agency-notice-bar" role="status">{statusToast}
          <button type="button" aria-label={t('agency.ui.dismissNotification')} onClick={() => setStatusToast(null)}>×</button>
        </div>}
        {!loaded ? (
          <div className="agency-welcome"><h1>{t('agency.ui.agency')}</h1><p>{t('agency.ui.loadingServerWorkspaceData')}</p></div>
        ) : showingDone ? (
          <AgencyDoneView
            workspaces={data.workspaces}
            projects={data.projects}
            sessions={data.sessions}
            webTabs={data.webTabs}
            onRestore={(ws) => { void restore(ws); }}
            onArchiveWorkspace={(ws) => { void archiveWorkspace(ws); }}
            onDeleteWorkspace={deleteWorkspace}
          />
        ) : selected ? (
          <AgencyWorkspaceView
            key={selected.id}
            workspace={selected}
            connection={connection}
            request={store.request}
            sendImmediate={agencyTransport.sendImmediate}
            online={online && synchronized}
            profiles={data.profiles}
            sessions={data.sessions}
            webTabs={data.webTabs}
            editorTabs={data.editorTabs}
            onTabDisplayed={handleTabDisplayed}
            draft={drafts[selected.id] ?? ''}
            onDraft={(value) => updateDraft(selected.id, value)}
            onDelivered={(value) => clearDelivered(selected.id, value)}
            onDone={() => { void markDone(selected); }}
            launchError={launchErrors[selected.id]}
            placementWarning={data.layoutWarnings?.[selected.id] ?? null}
            onClearPlacementWarning={() => store.clearLayoutWarning(selected.id)}
            getTabActivity={notificationStore.getTabActivity}
            getTabActivityVersion={(workspaceId, tabId) => notificationStore.activityStates.get(workspaceId + '::' + tabId)?.updatedAt ?? ''}
            onAcknowledgeTab={notificationStore.acknowledgeTab}
            savedLayout={data.layouts?.[selected.id]}
            onSaveLayout={store.saveLayout}
            onClearLaunchError={() => {
              setLaunchErrors((prev) => {
                const next = { ...prev };
                delete next[selected.id];
                return next;
              });
            }}
          />
        ) : (
          <div className="agency-welcome">
            <div className="agency-welcome-icon" aria-hidden="true">◇</div>
            <h1>{t('agency.ui.onePlaceForEveryDevelopmentLane')}</h1>
            <p>{t('agency.ui.createAProjectAndAWorkspaceAttachAn')}</p>
            <button type="button" className="agency-primary-button" onClick={() => openCreator()} disabled={!online}>
              {data.projects.length === 0 ? t('agency.ui.createFirstProject') : t('agency.ui.newWorkspace')}
            </button>
          </div>
        )}
      </div>
      {creatingProject && <AgencyProjectCreator
        onClose={() => setCreatingProject(false)}
        onCreate={async (name) => {
          const answer = await store.createProject(name);
          if (answer.type !== 'agency.project.created') throw new Error(t('agency.ui.projectCreationNotConfirmed'));
        }} />}
      {creatingWorkspace && <AgencyWorkspaceCreator
        connection={connection}
        projects={data.projects}
        profiles={data.profiles}
        initialProject={creatorProject}
        onClose={() => setCreatingWorkspace(false)}
        onCreate={async (projectId, name, pickerId, options) => {
          const answer = await store.createWorkspace(projectId, name, pickerId);
          if (answer.type !== 'agency.workspace.created') throw new Error(t('agency.errors.internalError'));
          const newWorkspace = answer.workspace;
          setSelectedId(newWorkspace.id);
          setShowingDone(false);

          const failures: string[] = [];
          const launch = async (kind: 'agent' | 'terminal') => {
            try {
              await store.request({ type: 'agency.session.create', workspaceId: newWorkspace.id, kind, launchId: crypto.randomUUID(), cols: 100, rows: 30,
                ...(kind === 'agent' && options.profileId ? { profileId: options.profileId } : {}) } as Parameters<typeof store.request>[0]);
            } catch (reason) { failures.push((kind === 'agent' ? t('agency.ui.agentLabel') : t('agency.ui.shell')) + ': ' + String(reason)); }
          };
          await launch('terminal');
          if (failures.length) setLaunchErrors(prev => ({ ...prev, [newWorkspace.id]: failures.join(' · ') }));
        }} />}
      {notificationsEnabled && (
        <NotificationToastContainer
          toasts={notificationStore.toasts}
          onDismiss={notificationStore.dismissToast}
          onNavigate={handleNotificationNavigate}
        />
      )}
    </div>
  );
}
