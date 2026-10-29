import { t } from '../i18n/index.js';
import { agencyErrorText } from './agency-labels.js';
import { serverTextMessage } from '../i18n/server-text.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgencyClientMessage, AgencyProject, AgencyRuntimeSession, AgencyServerMessage, AgencyWorkspace,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import {
  EMPTY_AGENCY_SNAPSHOT, applySessionActivity, applySessionsSnapshot, replaceById, transitionNotice,
  type AgencySnapshot, type AgencyTransport, type AgencyNoticeKind,
} from './model.js';

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
      'agency.profiles.list', 'agency.sessions.list', 'agency.webTabs.list', 'agency.notifications.list',
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
      } else if (message.type === 'agency.webTabs.snapshot') {
        const workspaceId = pending.current.get(message.requestId)?.workspaceId;
        setData((old) => ({ ...old, webTabs: workspaceId
          ? [...old.webTabs.filter(tab => tab.workspaceId !== workspaceId), ...message.tabs]
          : message.tabs }));
      } else if (message.type === 'agency.webTab.created' || message.type === 'agency.webTab.updated' || message.type === 'agency.webTab.closed') {
        setData((old) => ({ ...old, webTabs: replaceById(old.webTabs, message.tab) }));
      } else if (message.type === 'agency.webTab.changed') {
        setData((old) => ({ ...old, webTabs: message.tabs
          ? [...old.webTabs.filter(tab => tab.workspaceId !== message.workspaceId), ...message.tabs]
          : message.tab ? replaceById(old.webTabs, message.tab) : old.webTabs }));
      } else if (message.type === 'agency.sessions.snapshot') {
        message.sessions.forEach((session) => record(session, false));
        setData((old) => ({ ...old, sessions: applySessionsSnapshot(old.sessions, message.sessions, message.workspaceId) }));
      } else if (
        message.type === 'agency.project.created' || message.type === 'agency.project.updated' ||
        message.type === 'agency.project.archived' || message.type === 'agency.project.unarchived'
      ) {
        setData((old) => ({ ...old, projects: replaceById(old.projects, message.project) }));
      } else if (message.type === 'agency.project.deleted') {
        setData((old) => ({ ...old, projects: old.projects.filter((p) => p.id !== message.projectId) }));
      } else if (message.type === 'agency.project.changed') {
        setData((old) => ({
          ...old,
          projects: message.change === 'deleted'
            ? old.projects.filter((p) => p.id !== message.projectId)
            : message.project ? replaceById(old.projects, message.project) : old.projects,
        }));
      } else if (
        message.type === 'agency.workspace.created' || message.type === 'agency.workspace.updated' ||
        message.type === 'agency.workspace.done' || message.type === 'agency.workspace.restored' ||
        message.type === 'agency.workspace.archived'
      ) {
        setData((old) => ({ ...old, workspaces: replaceById(old.workspaces, message.workspace) }));
      } else if (message.type === 'agency.workspace.deleted') {
        setData((old) => ({ ...old, workspaces: old.workspaces.filter((w) => w.id !== message.workspaceId) }));
      } else if (message.type === 'agency.workspace.changed') {
        setData((old) => ({
          ...old, workspaces: message.change === 'deleted'
            ? old.workspaces.filter((w) => w.id !== message.workspaceId)
            : message.workspace ? replaceById(old.workspaces, message.workspace) : old.workspaces,
        }));
      } else if (message.type === 'agency.profile.configured' || message.type === 'agency.profile.changed') {
        setData((old) => ({ ...old, profiles: replaceById(old.profiles, message.profile) }));
      } else if (message.type === 'agency.profile.capabilities') {
        setData((old) => ({ ...old, profiles: old.profiles.map((profile) =>
          profile.id === message.profileId ? { ...profile, capabilities: message.capabilities } : profile) }));
      } else if (message.type === 'agency.session.created' || message.type === 'agency.session.selection' ||
                 message.type === 'agency.session.changed') {
        record(message.session, true);
        setData((old) => ({ ...old, sessions: replaceById(old.sessions, message.session) }));
      } else if (message.type === 'agency.session.activity') {
        // Side effects (notice, last-session bookkeeping) happen once here, never inside the state updater,
        // which React may invoke again. lastSessions mirrors every session message, so it is current.
        const previous = lastSessions.current.get(message.sessionId);
        if (previous) record({ ...previous, activity: message.activity, lifecycle: message.lifecycle }, true);
        setData((old) => ({ ...old, sessions: applySessionActivity(old.sessions, previous, message) }));
      }
      if (!('requestId' in message) || !message.requestId) return;
      const waiting = pending.current.get(message.requestId);
      if (!waiting) return;
      window.clearTimeout(waiting.timeout);
      pending.current.delete(message.requestId);
      if (message.type === 'agency.error') {
        waiting.reject(new Error(agencyErrorText(message.code), { cause: message.message }));
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
  const renameProject = (projectId: AgencyProject['id'], name: string) =>
    request({ type: 'agency.project.update', projectId, name });
  const archiveProject = (projectId: AgencyProject['id']) =>
    request({ type: 'agency.project.archive', projectId });
  const unarchiveProject = (projectId: AgencyProject['id']) =>
    request({ type: 'agency.project.unarchive', projectId });
  const deleteProject = (projectId: AgencyProject['id']) =>
    request({ type: 'agency.project.delete', projectId });
  const createWorkspace = (projectId: AgencyWorkspace['projectId'], name: string, pickerId: string) =>
    request({ type: 'agency.workspace.create', projectId, name, pickerId });
  const archiveWorkspace = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.archive', workspaceId });
  const markDone = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.done', workspaceId });
  const restore = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.restore', workspaceId });
  const deleteWorkspace = (workspaceId: AgencyWorkspace['id']) =>
    request({ type: 'agency.workspace.delete', workspaceId });

  return {
    data, online, loaded, synchronized, notice, request, refresh,
    createProject, renameProject, archiveProject, unarchiveProject, deleteProject,
    createWorkspace, archiveWorkspace, markDone, restore, deleteWorkspace,
  };
}
