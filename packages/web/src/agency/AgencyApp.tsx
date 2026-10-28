import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgencyProject, AgencyWorkspace, ProjectId, WorkspaceId } from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { AgencySidebar, AgencyDoneView } from './AgencySidebar.js';
import { AgencyWorkspaceCreator, AgencyProjectCreator } from './AgencyWorkspaceCreator.js';
import { AgencyWorkspaceView } from './AgencyWorkspaceView.js';
import { useAgencyStore } from './useAgencyStore.js';
import { acknowledgeWorkspaceDraft, createAgencyTransport, putWorkspaceDraft } from './model.js';
import { t } from '../i18n/index.js';
import { useLocale } from '../i18n/useLocale.js';
import './agency.css';

const DRAFT_KEY = 'agency-ui.workspace-drafts.v1';
const SIDEBAR_WIDTH_KEY = 'agency-ui.sidebar-width.v1';

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
  const agencyTransport = useMemo(() => createAgencyTransport(connection), [connection]);
  const store = useAgencyStore(agencyTransport, connection);
  const { data, loaded, online, notice } = store;
  const [selectedId, setSelectedId] = useState<WorkspaceId | null>(null);
  const [showingDone, setShowingDone] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  const [notificationPermission, setNotificationPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  const seenNotice = useRef(new Set<number>());

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Storage optional. */ }
  }, [drafts]);

  useEffect(() => {
    if (!loaded || showingDone) return;
    const active = data.workspaces.filter((ws) => ws.status === 'active');
    if (selectedId && active.some((ws) => ws.id === selectedId)) return;
    setSelectedId(active[0]?.id ?? null);
  }, [loaded, showingDone, data.workspaces, selectedId]);

  useEffect(() => {
    if (!notice || seenNotice.current.has(notice.serial)) return;
    seenNotice.current.add(notice.serial);
    const ws = data.workspaces.find((item) => item.id === notice.workspaceId);
    const label = ws?.name ?? t('agency.ui.workspace');
    const message = notice.kind === 'attention' ? t('agency.ui.needsAttentionNamed', { name: label }) : t('agency.ui.completedTurnNamed', { name: label });
    setStatusToast(message);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      // Only confirmed server transitions, never snapshots or local send clicks.
      new Notification(t('agency.ui.agency'), { body: message, tag: 'agency-' + notice.sessionId + '-' + notice.kind });
    }
  }, [notice, data.workspaces]);

  const selected = !showingDone ? data.workspaces.find((ws) => ws.id === selectedId && ws.status === 'active') : undefined;
  const activeCount = data.workspaces.filter((ws) => ws.status === 'active').length;

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
    event.preventDefault();
    setResizingSidebar(true);
    const onPointerMove = (e: PointerEvent) => {
      const clamped = Math.max(180, Math.min(500, e.clientX));
      setSidebarWidth(clamped);
    };
    const onPointerUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setResizingSidebar(false);
      const clamped = Math.max(180, Math.min(500, e.clientX));
      setSidebarWidth(clamped);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, clamped.toString());
      } catch {}
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
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
      if (answer.type !== 'agency.workspace.archived') throw new Error('Workspace archive was not confirmed');
      if (selectedId === workspace.id) setSelectedId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to archive workspace'); }
  }

  async function deleteWorkspace(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.deleteWorkspace(workspace.id);
      if (answer.type !== 'agency.workspace.deleted') throw new Error('Workspace deletion was not confirmed');
      if (selectedId === workspace.id) setSelectedId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete workspace'); }
  }

  async function renameProject(project: AgencyProject, newName: string) {
    setError(null);
    try {
      const answer = await store.renameProject(project.id, newName);
      if (answer.type !== 'agency.project.updated') throw new Error('Project rename was not confirmed');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to rename project'); }
  }

  async function archiveProject(project: AgencyProject) {
    setError(null);
    try {
      const answer = await store.archiveProject(project.id);
      if (answer.type !== 'agency.project.archived') throw new Error('Project archive was not confirmed');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to archive project'); }
  }

  async function deleteProject(project: AgencyProject) {
    setError(null);
    try {
      const answer = await store.deleteProject(project.id);
      if (answer.type !== 'agency.project.deleted') throw new Error('Project deletion was not confirmed');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete project'); }
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
              projects={data.projects}
              workspaces={data.workspaces}
              sessions={data.sessions}
              selected={selectedId}
              showingDone={showingDone}
              onSelect={(id) => { setSelectedId(id); setShowingDone(false); }}
              onDoneView={() => setShowingDone(true)}
              onCreate={openCreator}
              onCreateProject={() => setCreatingProject(true)}
              onDone={(ws) => { void markDone(ws); }}
              onArchiveWorkspace={(ws) => { void archiveWorkspace(ws); }}
              onDeleteWorkspace={(ws) => { void deleteWorkspace(ws); }}
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
            />
          </>
        )}
      </aside>
      <div className="agency-main">
        <div className="agency-topbar">
          <button className="agency-icon-button" onClick={() => setSidebarOpen(!sidebarOpen)}
            type="button" aria-label={sidebarOpen ? t('agency.ui.collapseSidebar') : t('agency.ui.expandSidebar')} aria-expanded={sidebarOpen}>☰</button>
          <span className="agency-topbar-title">{t('agency.ui.agencyUI')}</span>
          <span className="agency-muted agency-topbar-count">{t('agency.ui.activeCount', { count: activeCount })}</span>
          <span className="agency-flex-spacer" />
          <span className={'agency-connection-state' + (online ? ' connected' : '')}>
            <span className="agency-status-dot" />{online ? t('app.status.open') : t('agency.ui.disconnected')}
          </span>
          {notificationPermission === 'default' && (
            <button type="button" className="agency-secondary-button" onClick={() => {
              void Notification.requestPermission().then(setNotificationPermission);
            }}>{t('agency.ui.enableNotifications')}</button>
          )}
          <button type="button" className="agency-secondary-button" disabled={!online}
            onClick={() => store.refresh()}>{t('agency.ui.refresh')}</button>
        </div>
        {error && <div role="alert" className="agency-error-bar">{error}
          <button type="button" onClick={() => setError(null)} aria-label={t('agency.ui.dismissError')}>×</button></div>}
        {statusToast && <div className="agency-notice-bar" role="status">{statusToast}
          <button type="button" aria-label={t('agency.ui.dismissNotification')} onClick={() => setStatusToast(null)}>×</button>
        </div>}
        {!loaded ? (
          <div className="agency-welcome"><h1>{t('agency.ui.agency')}</h1><p>{t('agency.ui.loadingServerWorkspaceData')}</p></div>
        ) : showingDone ? (
          <AgencyDoneView
            workspaces={data.workspaces}
            projects={data.projects}
            onRestore={(ws) => { void restore(ws); }}
            onArchiveWorkspace={(ws) => { void archiveWorkspace(ws); }}
            onDeleteWorkspace={(ws) => { void deleteWorkspace(ws); }}
          />
        ) : selected ? (
          <AgencyWorkspaceView
            key={selected.id}
            workspace={selected}
            connection={connection}
            request={store.request}
            sendImmediate={agencyTransport.sendImmediate}
            online={online}
            profiles={data.profiles}
            sessions={data.sessions}
            draft={drafts[selected.id] ?? ''}
            onDraft={(value) => updateDraft(selected.id, value)}
            onDelivered={(value) => clearDelivered(selected.id, value)}
            onDone={() => { void markDone(selected); }}
            launchError={launchErrors[selected.id]}
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
          if (answer.type !== 'agency.workspace.created') throw new Error('Workspace creation not confirmed');
          const newWorkspace = answer.workspace;
          setSelectedId(newWorkspace.id);
          setShowingDone(false);

          if (options.mode === 'agent' && options.profileId) {
            try {
              const launchAnswer = await store.request({
                type: 'agency.session.create',
                workspaceId: newWorkspace.id,
                kind: 'agent',
                profileId: options.profileId,
                cols: 100,
                rows: 30,
              });
              if (launchAnswer.type !== 'agency.session.created') {
                setLaunchErrors((prev) => ({
                  ...prev,
                  [newWorkspace.id]: t('agency.ui.noAgentSessionAcknowledgement'),
                }));
              }
            } catch (err) {
              setLaunchErrors((prev) => ({
                ...prev,
                [newWorkspace.id]: err instanceof Error ? err.message : String(err),
              }));
            }
          } else if (options.mode === 'terminal') {
            try {
              const launchAnswer = await store.request({
                type: 'agency.session.create',
                workspaceId: newWorkspace.id,
                kind: 'terminal',
                cols: 100,
                rows: 30,
              });
              if (launchAnswer.type !== 'agency.session.created') {
                setLaunchErrors((prev) => ({
                  ...prev,
                  [newWorkspace.id]: t('agency.ui.noShellSessionAcknowledgement'),
                }));
              }
            } catch (err) {
              setLaunchErrors((prev) => ({
                ...prev,
                [newWorkspace.id]: err instanceof Error ? err.message : String(err),
              }));
            }
          }
        }} />}
    </div>
  );
}
