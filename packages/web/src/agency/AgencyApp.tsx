import { useEffect, useRef, useState } from 'react';
import type { AgencyWorkspace, ProjectId, WorkspaceId } from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { AgencySidebar, AgencyDoneView } from './AgencySidebar.js';
import { AgencyWorkspaceCreator, AgencyProjectCreator } from './AgencyWorkspaceCreator.js';
import { AgencyWorkspaceView } from './AgencyWorkspaceView.js';
import { useAgencyStore } from './useAgencyStore.js';
import { acknowledgeWorkspaceDraft, putWorkspaceDraft, type AgencyTransport } from './model.js';
import { t } from '../i18n/index.js';
import { useLocale } from '../i18n/useLocale.js';
import './agency.css';

const DRAFT_KEY = 'agency-ui.workspace-drafts.v1';

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
 * Caller supplies Workbench's ONE AgentConnection and an AgencyTransport adapter
 * through its existing versioned, authenticated /ws pipeline.
 * No separate socket, backend, process owner, or client-selected cwd is created here.
 */
export function AgencyApp({ connection, agencyTransport }: {
  connection: AgentConnection;
  agencyTransport: AgencyTransport;
}): JSX.Element {
  useLocale();
  const store = useAgencyStore(agencyTransport, connection);
  const { data, loaded, online, notice } = store;
  const [selectedId, setSelectedId] = useState<WorkspaceId | null>(null);
  const [showingDone, setShowingDone] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatorProject, setCreatorProject] = useState<ProjectId | undefined>();
  const [creatingProject, setCreatingProject] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts);
  const [error, setError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  const seenNotice = useRef(new Set<number>());

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Storage optional. */ }
  }, [drafts]);

  useEffect(() => {
    if (!loaded || showingDone) return;
    const active = data.workspaces.filter((ws) => ws.status === t('agency.ui.active'));
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

  const selected = !showingDone ? data.workspaces.find((ws) => ws.id === selectedId && ws.status === t('agency.ui.active')) : undefined;
  const activeCount = data.workspaces.filter((ws) => ws.status === t('agency.ui.active')).length;

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

  async function markDone(workspace: AgencyWorkspace) {
    setError(null);
    try {
      const answer = await store.markDone(workspace.id);
      if (answer.type !== 'agency.workspace.done') throw new Error(t('agency.ui.doneWasNotConfirmed'));
      if (selectedId === workspace.id) setSelectedId(null);
      // No terminal.close, signal or filesystem operation here.
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('agency.ui.unableToMarkDone')); }
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
      <aside className={'agency-sidebar' + (sidebarOpen ? '' : ' agency-sidebar-collapsed')}>
        {sidebarOpen && <AgencySidebar
          projects={data.projects} workspaces={data.workspaces} sessions={data.sessions}
          selected={selectedId} showingDone={showingDone}
          onSelect={(id) => { setSelectedId(id); setShowingDone(false); }}
          onDoneView={() => setShowingDone(true)}
          onCreate={openCreator} onCreateProject={() => setCreatingProject(true)}
          onDone={(ws) => { void markDone(ws); }}
          onRestore={(ws) => { void restore(ws); }}
        />}
      </aside>
      <div className="agency-main">
        <div className="agency-topbar">
          <button className="agency-icon-button" onClick={() => setSidebarOpen(!sidebarOpen)}
            type="button" aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={sidebarOpen}>☰</button>
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
          <AgencyDoneView workspaces={data.workspaces} projects={data.projects}
            onRestore={(ws) => { void restore(ws); }} />
        ) : selected ? (
          <AgencyWorkspaceView key={selected.id} workspace={selected} connection={connection} request={store.request} sendImmediate={agencyTransport.sendImmediate}
            online={online} profiles={data.profiles} sessions={data.sessions}
            draft={drafts[selected.id] ?? ''} onDraft={(value) => updateDraft(selected.id, value)}
            onDelivered={(value) => clearDelivered(selected.id, value)} onDone={() => { void markDone(selected); }} />
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
        connection={connection} projects={data.projects} initialProject={creatorProject}
        onClose={() => setCreatingWorkspace(false)}
        onCreate={async (projectId, name, pickerId) => {
          const answer = await store.createWorkspace(projectId, name, pickerId);
          if (answer.type !== 'agency.workspace.created') throw new Error('Workspace creation not confirmed');
          setSelectedId(answer.workspace.id);
          setShowingDone(false);
        }} />}
    </div>
  );
}
