import { t } from '../i18n/index.js';
import { agencyErrorText } from './agency-labels.js';
import { serverTextMessage } from '../i18n/server-text.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgencyClientMessage, AgencyProject, AgencyRuntimeSession, AgencyServerMessage, AgencyWorkspace,
  BrowserProfileId, BrowserProfileSite, WorkspacePaneLayout, WorkspaceId, WebTab,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import {
  EMPTY_AGENCY_SNAPSHOT, retainUnconfirmedCreations, applySessionActivity, applySessionsSnapshot, replaceById, transitionNotice,
  pruneWorkspaceData, pruneProjectData,
  type AgencySnapshot, type AgencyTransport, type AgencyNoticeKind,
} from './model.js';
import { editorDraftStore } from './editorDraftStore.js';

type Payload = AgencyClientMessage extends infer M
  ? M extends AgencyClientMessage ? Omit<M, 'requestId'> : never
  : never;
type Pending = {
  resolve: (message: AgencyServerMessage) => void;
  reject: (error: Error) => void;
  timeout: number;
  workspaceId?: string;
};
export interface VerifiedNotice {
  sessionId: string;
  workspaceId: string;
  kind: AgencyNoticeKind;
  serial: number;
}

export function useAgencyStore(transport: AgencyTransport, connection: AgentConnection) {
  const [data, setData] = useState<AgencySnapshot>(EMPTY_AGENCY_SNAPSHOT);
  const [online, setOnline] = useState(connection.getStatus() === 'open');
  const [loaded, setLoaded] = useState(false);
  const [synchronized, setSynchronized] = useState(false);
  const snapshots = useRef(new Set<string>());
  const [notice, setNotice] = useState<VerifiedNotice | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const unconfirmedSessions = useRef(new Map<string, AgencyRuntimeSession>());
  const unconfirmedWebTabs = useRef(new Map<string, WebTab>());
  const lastSessions = useRef(new Map<string, AgencyRuntimeSession>());
  const serial = useRef(0);

  const request = useCallback((payload: Payload): Promise<AgencyServerMessage> => {
    if (connection.getStatus() !== 'open') {
      return Promise.reject(new Error(t('agency.web.disconnected')));
    }
    const requestId = crypto.randomUUID();
    return new Promise<AgencyServerMessage>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.current.delete(requestId);
        reject(new Error(t('agency.web.requestTimeout')));
      }, 15000);
      pending.current.set(requestId, { resolve, reject, timeout, ...('workspaceId' in payload ? { workspaceId: payload.workspaceId } : {}) });
      try {
        // The integration adapter must preserve this opaque ID on the existing /ws.
        const immediate = transport.sendImmediate({ ...payload, requestId } as AgencyClientMessage);
        if (!immediate) throw new Error(t('agency.web.sendFailed'));
      } catch (error) {
        window.clearTimeout(timeout);
        pending.current.delete(requestId);
        reject(error instanceof Error ? error : new Error(t('agency.web.sendFailed')));
      }
    });
  }, [connection, transport]);

  const refresh = useCallback((): void => {
    if (connection.getStatus() !== 'open') return;
    snapshots.current.clear();
    setSynchronized(false);
    const types = [
      'agency.projects.list', 'agency.workspaces.list',
      'agency.profiles.list', 'agency.browserProfiles.list', 'agency.sessions.list', 'agency.webTabs.list', 'agency.editorTabs.list', 'agency.notifications.list',
    ] as const;
    types.forEach((type) => { void request({ type }).catch(() => { /* Preserve existing state. */ }); });
  }, [request, connection]);

  useEffect(() => {
    function record(next: AgencyRuntimeSession, notify: boolean): void {
      const previous = lastSessions.current.get(next.id) ?? null;
      if (notify) {
        const kind = transitionNotice(previous, next);
        if (kind) setNotice({ kind, sessionId: next.id, workspaceId: next.workspaceId, serial: ++serial.current });
      }
      lastSessions.current.set(next.id, next);
    }

    const offRefusal = connection.onMessage((message) => {
      if (message.type !== 'error' || !message.requestId) return;
      const task = pending.current.get(message.requestId);
      if (!task) return;
      window.clearTimeout(task.timeout);
      pending.current.delete(message.requestId);
      task.reject(new Error(serverTextMessage(message.text)));
    });
    const offMessage = transport.onMessage((message) => {
      const coreSnapshots = ['agency.projects.snapshot', 'agency.workspaces.snapshot', 'agency.profiles.snapshot', 'agency.sessions.snapshot', 'agency.webTabs.snapshot'];
      if (coreSnapshots.includes(message.type) || (message.type === 'agency.notifications.snapshot' && message.activityStates)) {
        snapshots.current.add(message.type);
        if (coreSnapshots.every(type => snapshots.current.has(type))) {
          setLoaded(true);
          if (snapshots.current.has('agency.notifications.snapshot')) setSynchronized(true);
        }
      }
      if (message.type === 'agency.projects.snapshot') {
        setData((old) => ({ ...old, projects: message.projects }));
      } else if (message.type === 'agency.workspaces.snapshot') {
        setData((old) => ({ ...old, workspaces: message.workspaces }));
      } else if (message.type === 'agency.profiles.snapshot') {
        setData((old) => ({ ...old, profiles: message.profiles }));
      } else if (message.type === 'agency.browserProfiles.snapshot') {
        setData((old) => ({ ...old, browserProfiles: message.profiles }));
      } else if (message.type === 'agency.browserProfile.created' || message.type === 'agency.browserProfile.renamed') {
        setData((old) => ({ ...old, browserProfiles: replaceById(old.browserProfiles, message.profile) }));
      } else if (message.type === 'agency.browserProfile.deleted') {
        setData((old) => ({
          ...old,
          browserProfiles: old.browserProfiles.filter((p) => p.id !== message.profileId),
          projects: old.projects.map((p) => (p.browserProfileId === message.profileId ? { ...p, browserProfileId: undefined } : p)),
          workspaces: old.workspaces.map((w) => (w.browserProfileId === message.profileId ? { ...w, browserProfileId: undefined } : w)),
        }));
      } else if (message.type === 'agency.browserProfile.changed') {
        if (message.change === 'deleted') {
          setData((old) => ({
            ...old,
            browserProfiles: old.browserProfiles.filter((p) => p.id !== message.profileId),
            projects: old.projects.map((p) => (p.browserProfileId === message.profileId ? { ...p, browserProfileId: undefined } : p)),
            workspaces: old.workspaces.map((w) => (w.browserProfileId === message.profileId ? { ...w, browserProfileId: undefined } : w)),
          }));
        } else if (message.profile) {
          setData((old) => ({ ...old, browserProfiles: replaceById(old.browserProfiles, message.profile!) }));
        }
      } else if (message.type === 'agency.webTabs.snapshot') {
        const workspaceId = pending.current.get(message.requestId)?.workspaceId;
        const tabs = retainUnconfirmedCreations(message.tabs, new Map([...unconfirmedWebTabs.current].filter(([, tab]) => !workspaceId || tab.workspaceId === workspaceId)));
        for (const tab of message.tabs) {
          const created = unconfirmedWebTabs.current.get(tab.id);
          if (created && created.updatedAt <= tab.updatedAt) unconfirmedWebTabs.current.delete(tab.id);
        }
        setData((old) => ({ ...old, webTabs: workspaceId
          ? [...old.webTabs.filter(tab => tab.workspaceId !== workspaceId), ...tabs]
          : tabs }));
      } else if (message.type === 'agency.webTab.created' || message.type === 'agency.webTab.updated' || message.type === 'agency.webTab.closed') {
        if (message.type === 'agency.webTab.created' || unconfirmedWebTabs.current.has(message.tab.id)) unconfirmedWebTabs.current.set(message.tab.id, message.tab);
        if (message.tab.closedAt) unconfirmedWebTabs.current.delete(message.tab.id);
        setData((old) => ({ ...old, webTabs: replaceById(old.webTabs, message.tab) }));
      } else if (message.type === 'agency.webTab.changed') {
        if (message.tab && unconfirmedWebTabs.current.has(message.tab.id)) {
          if (message.tab.closedAt) unconfirmedWebTabs.current.delete(message.tab.id);
          else unconfirmedWebTabs.current.set(message.tab.id, message.tab);
        }
        setData((old) => ({ ...old, webTabs: message.tabs
          ? [...old.webTabs.filter(tab => tab.workspaceId !== message.workspaceId), ...message.tabs]
          : message.tab ? replaceById(old.webTabs, message.tab) : old.webTabs }));
      } else if (message.type === 'agency.editorTabs.snapshot') {
        const workspaceId = pending.current.get(message.requestId)?.workspaceId;
        setData((old) => ({
          ...old,
          editorTabs: workspaceId
            ? [...old.editorTabs.filter((tab) => tab.workspaceId !== workspaceId), ...message.tabs]
            : message.tabs,
        }));
      } else if (message.type === 'agency.editorTab.opened' || message.type === 'agency.editorTab.updated' || message.type === 'agency.editorTab.closed') {
        setData((old) => ({ ...old, editorTabs: replaceById(old.editorTabs, message.tab) }));
      } else if (message.type === 'agency.editorTab.changed') {
        setData((old) => ({
          ...old,
          editorTabs: message.tabs
            ? [...old.editorTabs.filter((tab) => tab.workspaceId !== message.workspaceId), ...message.tabs]
            : message.tab ? replaceById(old.editorTabs, message.tab) : old.editorTabs,
        }));
      } else if (message.type === 'agency.sessions.snapshot') {
        const retained = new Map([...unconfirmedSessions.current].filter(([, session]) => !message.workspaceId || session.workspaceId === message.workspaceId));
        const sessions = retainUnconfirmedCreations(message.sessions, retained);
        for (const session of message.sessions) {
          const created = unconfirmedSessions.current.get(session.id);
          if (created && created.updatedAt <= session.updatedAt) unconfirmedSessions.current.delete(session.id);
        }
        sessions.forEach((session) => record(session, false));
        setData((old) => ({ ...old, sessions: applySessionsSnapshot(old.sessions, sessions, message.workspaceId) }));
      } else if (message.type === 'agency.layouts.snapshot') {
        const layoutsMap: Record<string, WorkspacePaneLayout> = {};
        for (const l of message.layouts) layoutsMap[l.workspaceId] = l;
        setData((old) => ({ ...old, layouts: { ...old.layouts, ...layoutsMap } }));
      } else if (message.type === 'agency.layout.changed') {
        setData((old) => {
          const existing = old.layouts?.[message.workspaceId];
          if (existing && existing.updatedAt > message.layout.updatedAt) {
            return old;
          }
          const nextWarnings = old.layoutWarnings ? { ...old.layoutWarnings } : undefined;
          if (nextWarnings && message.workspaceId in nextWarnings) {
            delete nextWarnings[message.workspaceId];
          }
          return {
            ...old,
            layouts: { ...old.layouts, [message.workspaceId]: message.layout },
            layoutWarnings: nextWarnings,
          };
        });
      } else if (
        message.type === 'agency.project.created' || message.type === 'agency.project.updated' ||
        message.type === 'agency.project.archived' || message.type === 'agency.project.unarchived'
      ) {
        setData((old) => ({ ...old, projects: replaceById(old.projects, message.project) }));
      } else if (message.type === 'agency.project.deleted') {
        setData((old) => {
          const targetWsIds = new Set(old.workspaces.filter((w) => w.projectId === message.projectId).map((w) => w.id));
          old.editorTabs.forEach((tab) => {
            if (targetWsIds.has(tab.workspaceId)) editorDraftStore.clearDraft(tab.id);
          });
          return pruneProjectData(old, message.projectId);
        });
      } else if (message.type === 'agency.project.changed') {
        setData((old) => {
          if (message.change === 'deleted') {
            const targetWsIds = new Set(old.workspaces.filter((w) => w.projectId === message.projectId).map((w) => w.id));
            old.editorTabs.forEach((tab) => {
              if (targetWsIds.has(tab.workspaceId)) editorDraftStore.clearDraft(tab.id);
            });
            return pruneProjectData(old, message.projectId);
          }
          return {
            ...old,
            projects: message.projects ?? (message.project ? replaceById(old.projects, message.project) : old.projects),
          };
        });
      } else if (
        message.type === 'agency.workspace.created' || message.type === 'agency.workspace.updated' ||
        message.type === 'agency.workspace.done' || message.type === 'agency.workspace.restored' ||
        message.type === 'agency.workspace.archived'
      ) {
        setData((old) => ({ ...old, workspaces: replaceById(old.workspaces, message.workspace) }));
      } else if (message.type === 'agency.workspace.deleted') {
        setData((old) => {
          old.editorTabs.forEach((tab) => {
            if (tab.workspaceId === message.workspaceId) editorDraftStore.clearDraft(tab.id);
          });
          return pruneWorkspaceData(old, message.workspaceId);
        });
      } else if (message.type === 'agency.workspace.changed') {
        setData((old) => {
          if (message.change === 'deleted') {
            old.editorTabs.forEach((tab) => {
              if (tab.workspaceId === message.workspaceId) editorDraftStore.clearDraft(tab.id);
            });
            return pruneWorkspaceData(old, message.workspaceId);
          }
          return {
            ...old,
            workspaces: message.workspaces ?? (message.workspace ? replaceById(old.workspaces, message.workspace) : old.workspaces),
          };
        });
      } else if (message.type === 'agency.profile.configured' || message.type === 'agency.profile.created' || message.type === 'agency.profile.changed') {
        if (message.type === 'agency.profile.changed' && message.change === 'deleted') {
          setData((old) => ({ ...old, profiles: old.profiles.filter((p) => p.id !== message.profileId) }));
        } else if (message.profile) {
          setData((old) => ({ ...old, profiles: replaceById(old.profiles, message.profile!) }));
        }
      } else if (message.type === 'agency.profile.deleted') {
        setData((old) => ({ ...old, profiles: old.profiles.filter((p) => p.id !== message.profileId) }));
      } else if (message.type === 'agency.profile.capabilities') {
        setData((old) => ({ ...old, profiles: old.profiles.map((profile) =>
          profile.id === message.profileId ? { ...profile, capabilities: message.capabilities } : profile) }));
      } else if (message.type === 'agency.session.created' || message.type === 'agency.session.selection' ||
                 message.type === 'agency.session.changed') {
        if (message.type === 'agency.session.created' || unconfirmedSessions.current.has(message.session.id)) unconfirmedSessions.current.set(message.session.id, message.session);
        if (message.session.tab?.closedAt) unconfirmedSessions.current.delete(message.session.id);
        record(message.session, true);
        setData((old) => ({ ...old, sessions: replaceById(old.sessions, message.session) }));
      } else if (message.type === 'agency.session.activity') {
        // Side effects (notice, last-session bookkeeping) happen once here, never inside the state updater,
        // which React may invoke again. lastSessions mirrors every session message, so it is current.
        const previous = lastSessions.current.get(message.sessionId);
        if (previous) {
          const next = { ...previous, activity: message.activity, lifecycle: message.lifecycle };
          record(next, true);
          if (unconfirmedSessions.current.has(next.id)) unconfirmedSessions.current.set(next.id, next);
        }
        setData((old) => ({ ...old, sessions: applySessionActivity(old.sessions, previous, message) }));
      } else if (message.type === 'agency.error') {
        if (!message.requestId || !pending.current.has(message.requestId)) {
          if (message.workspaceId) {
            setData((old) => ({
              ...old,
              layoutWarnings: { ...(old.layoutWarnings ?? {}), [message.workspaceId!]: message.message },
            }));
          }
        }
      }
      if (!('requestId' in message) || !message.requestId) return;
      const waiting = pending.current.get(message.requestId);
      if (!waiting) return;
      window.clearTimeout(waiting.timeout);
      pending.current.delete(message.requestId);
      if (message.type === 'agency.error') {
        const text = agencyErrorText(message.code);
        const detailed = message.message && message.message !== text ? `${text}: ${message.message}` : text;
        waiting.reject(new Error(detailed, { cause: message.message }));
      } else {
        waiting.resolve(message);
      }
    });

    const cancelPending = (): void => {
      for (const task of pending.current.values()) {
        window.clearTimeout(task.timeout);
        task.reject(new Error(t('agency.web.disconnected')));
      }
      pending.current.clear();
    };
    const offStatus = connection.onStatus((status) => {
      const isOpen = status === 'open';
      setOnline(isOpen);
      if (!isOpen) { snapshots.current.clear(); setSynchronized(false); cancelPending(); }
      else refresh();
    });
    // Existing authenticated socket may already have opened before this UI mounted.
    refresh();
    return () => { offRefusal(); offMessage(); offStatus(); cancelPending(); };
  }, [connection, transport, refresh]);

  const createProject = (name: string) => request({ type: 'agency.project.create', name });
  const updateProject = (projectId: AgencyProject['id'], patch: { name?: string; browserProfileId?: string | null }) =>
    request({ type: 'agency.project.update', projectId, ...patch });
  const renameProject = (projectId: AgencyProject['id'], name: string) =>
    updateProject(projectId, { name });
  const archiveProject = (projectId: AgencyProject['id']) =>
    request({ type: 'agency.project.archive', projectId });
  const unarchiveProject = (projectId: AgencyProject['id']) =>
    request({ type: 'agency.project.unarchive', projectId });
  const deleteProject = (projectId: AgencyProject['id'], cascade = false) =>
    request({ type: 'agency.project.delete', projectId, ...(cascade ? { cascade: true } : {}) });
  const orderProjects = (projectIds: readonly AgencyProject['id'][]) => {
    setData((old) => {
      const orderMap = new Map(projectIds.map((id, index) => [id, index]));
      const sorted = [...old.projects].sort((a, b) => {
        const aIdx = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const bIdx = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return old.projects.indexOf(a) - old.projects.indexOf(b);
      });
      return { ...old, projects: sorted };
    });
    return request({ type: 'agency.projects.order', projectIds });
  };
  const createWorkspace = (projectId: AgencyWorkspace['projectId'], name: string, pickerId: string) =>
    request({ type: 'agency.workspace.create', projectId, name, pickerId });
  const updateWorkspace = (workspaceId: AgencyWorkspace['id'], patch: { name?: string; browserProfileId?: string | null }) =>
    request({ type: 'agency.workspace.update', workspaceId, ...patch });
  const renameWorkspace = (workspaceId: AgencyWorkspace['id'], name: string) =>
    updateWorkspace(workspaceId, { name });
  const archiveWorkspace = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.archive', workspaceId });
  const markDone = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.done', workspaceId });
  const restore = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.restore', workspaceId });
  const deleteWorkspace = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.delete', workspaceId });
  const createBrowserProfile = (
    name: string,
    options?: { sourceProfileId?: BrowserProfileId; clearSites?: readonly BrowserProfileSite[] },
  ) =>
    request({
      type: 'agency.browserProfile.create',
      name,
      ...(options?.sourceProfileId ? { sourceProfileId: options.sourceProfileId } : {}),
      ...(options?.clearSites && options.clearSites.length > 0 ? { clearSites: options.clearSites } : {}),
    });
  const renameBrowserProfile = (profileId: BrowserProfileId, name: string) =>
    request({ type: 'agency.browserProfile.rename', profileId, name });
  const deleteBrowserProfile = (profileId: BrowserProfileId) =>
    request({ type: 'agency.browserProfile.delete', profileId });
  const orderWorkspaces = (projectId: AgencyWorkspace['projectId'], workspaceIds: readonly AgencyWorkspace['id'][]) => {
    setData((old) => {
      const orderMap = new Map(workspaceIds.map((id, index) => [id, index]));
      const projectWorkspaces = old.workspaces.filter((w) => w.projectId === projectId);
      const sortedProjectWorkspaces = [...projectWorkspaces].sort((a, b) => {
        const aIdx = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const bIdx = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return projectWorkspaces.indexOf(a) - projectWorkspaces.indexOf(b);
      });
      let sortedIdx = 0;
      const nextWorkspaces = old.workspaces.map((w) => {
        if (w.projectId === projectId) {
          return sortedProjectWorkspaces[sortedIdx++]!;
        }
        return w;
      });
      return { ...old, workspaces: nextWorkspaces };
    });
    return request({ type: 'agency.workspaces.order', projectId, workspaceIds });
  };
  const saveLayout = useCallback((workspaceId: WorkspaceId, layout: WorkspacePaneLayout) =>
    request({ type: 'agency.layout.save', workspaceId, layout }), [request]);
  const clearLayoutWarning = useCallback((workspaceId: WorkspaceId) => {
    setData((old) => {
      if (!old.layoutWarnings || !(workspaceId in old.layoutWarnings)) return old;
      const next = { ...old.layoutWarnings };
      delete next[workspaceId];
      return { ...old, layoutWarnings: next };
    });
  }, []);

  return {
    data, online, loaded, synchronized, notice, request, refresh,
    createProject, updateProject, renameProject, archiveProject, unarchiveProject, deleteProject, orderProjects,
    createWorkspace, updateWorkspace, renameWorkspace, archiveWorkspace, markDone, restore, deleteWorkspace, orderWorkspaces,
    createBrowserProfile, renameBrowserProfile, deleteBrowserProfile,
    saveLayout, clearLayoutWarning,
  };
}
