/**
 * Centralized in-memory draft store for Agency Workspace Editor Tabs.
 *
 * Preserves unsaved editor edits, scroll positions, document view modes,
 * and loaded previews across tab switching, pane movement, selection changes,
 * and component unmounts.
 */

import type { DocContent, DocEdit } from '../files/useDocuments.js';
import type { DocMode } from '../files/doc-tabs.js';
import type { AgentConnection } from '../../connection/connection.js';
import type { FilePreview, ServerMessage, ServerText, WorkspaceId, EditorTab } from '@agent-workbench/shared';

export interface EditorDraft {
  edit: DocEdit | null;
  mode: DocMode;
  scrollTop: number;
  content?: DocContent;
  pendingSaveRequestId?: string | null;
}

const STORAGE_KEY = 'maw.agency-editor-drafts.v1';

/** A read response cannot conflict an edit while its write is in flight. */
export function shouldFlagReadPreviewConflict(edit: DocEdit | null, preview: FilePreview): boolean {
  return edit !== null && !edit.saving && edit.conflict === null &&
    typeof preview.hash === 'string' && preview.hash !== edit.baseHash;
}

export function isDraftDirty(draft?: EditorDraft | null): boolean {
  if (!draft || !draft.edit) return false;
  return (
    draft.edit.text !== draft.edit.opened ||
    draft.edit.conflict !== null ||
    draft.edit.pending !== null
  );
}

export interface EditorSessionCallbacks {
  onContentChange?: (content: DocContent | undefined) => void;
  onEditChange?: (edit: DocEdit | null) => void;
  onJustSaved?: () => void;
}

export interface EditorSessionOptions {
  tab: EditorTab;
  workspaceId: WorkspaceId;
  connection: AgentConnection;
  initialDraft?: EditorDraft | null;
  callbacks?: EditorSessionCallbacks;
}

/**
 * Encapsulates the live editor tab read/write request correlation and event handling.
 * Ensures read previews belong to the current relevant request and never settle writes.
 */
export class EditorSession {
  tabId: string;
  workspaceId: WorkspaceId;
  filePath: string;
  private connection: AgentConnection;
  private callbacks: EditorSessionCallbacks;

  private activeReadRequestId: string | null = null;
  private pendingSaveRequestId: string | null = null;
  private content: DocContent | undefined;
  private edit: DocEdit | null = null;
  private hasCompletedSave = false;

  constructor(options: EditorSessionOptions) {
    this.tabId = options.tab.id;
    this.workspaceId = options.workspaceId;
    this.filePath = options.tab.filePath;
    this.connection = options.connection;
    this.callbacks = options.callbacks ?? {};

    const draft = options.initialDraft ?? editorDraftStore.getDraft(this.tabId);
    this.content = draft?.content;
    this.edit = draft?.edit ?? null;
    this.pendingSaveRequestId = draft?.pendingSaveRequestId ?? null;
  }

  setContext(tab: EditorTab, workspaceId: WorkspaceId, connection: AgentConnection): void {
    this.tabId = tab.id;
    this.workspaceId = workspaceId;
    this.filePath = tab.filePath;
    this.connection = connection;
  }

  getContent(): DocContent | undefined {
    return this.content;
  }

  setContent(content: DocContent | undefined): void {
    this.content = content;
    const current = editorDraftStore.getDraft(this.tabId);
    if (current) {
      editorDraftStore.setDraft(this.tabId, { ...current, content });
    }
    this.callbacks.onContentChange?.(content);
  }

  getEdit(): DocEdit | null {
    return this.edit;
  }

  setEdit(edit: DocEdit | null | ((prev: DocEdit | null) => DocEdit | null)): void {
    this.edit = typeof edit === 'function' ? edit(this.edit) : edit;
    editorDraftStore.updateEdit(this.tabId, () => this.edit);
    this.callbacks.onEditChange?.(this.edit);
  }

  getPendingSave(): string | null {
    return this.pendingSaveRequestId ?? editorDraftStore.getPendingSave(this.tabId);
  }

  getActiveReadRequestId(): string | null {
    return this.activeReadRequestId;
  }

  isDirty(): boolean {
    return Boolean(
      this.edit &&
        (this.edit.text !== this.edit.opened ||
          this.edit.conflict !== null ||
          this.edit.pending !== null)
    );
  }

  readFile(customRequestId?: string): string {
    this.hasCompletedSave = false;
    const reqId = customRequestId ?? (typeof crypto !== 'undefined' ? crypto.randomUUID() : 'read-' + Date.now());
    this.activeReadRequestId = reqId;
    this.setContent({
      loaded: this.content?.loaded ?? null,
      loading: this.content?.loaded ? false : true,
      failed: false,
    });
    this.connection.send({
      type: 'files.read',
      requestId: reqId,
      terminalId: this.workspaceId,
      path: this.filePath,
    });
    return reqId;
  }

  save(customRequestId?: string): string | null {
    const current = this.edit;
    if (!current || current.saving || current.conflict !== null) return null;
    const reqId = customRequestId ?? (typeof crypto !== 'undefined' ? crypto.randomUUID() : 'write-' + Date.now());
    this.pendingSaveRequestId = reqId;
    editorDraftStore.setPendingSave(this.tabId, reqId);
    this.setEdit({ ...current, saving: true, failure: null });
    this.connection.send({
      type: 'files.write',
      requestId: reqId,
      terminalId: this.workspaceId,
      path: this.filePath,
      baseHash: current.baseHash,
      text: current.text,
    });
    return reqId;
  }

  discard(): void {
    this.pendingSaveRequestId = null;
    editorDraftStore.setPendingSave(this.tabId, null);
    this.setEdit(null);
  }

  handleMessage(message: ServerMessage): boolean {
    switch (message.type) {
      case 'files.preview': {
        if (message.terminalId !== this.workspaceId || message.preview.path !== this.filePath) {
          return false;
        }

        // Correlate: if message has requestId, it MUST match the current active read request.
        if (message.requestId !== undefined) {
          if (!this.activeReadRequestId || message.requestId !== this.activeReadRequestId) {
            return false;
          }
        } else {
          // Backward-compatible fallback for un-correlated previews:
          // Must not overwrite active in-flight writes or recently saved files.
          if (this.pendingSaveRequestId || this.edit?.saving || this.hasCompletedSave) {
            return false;
          }
        }

        const preview = message.preview;
        const currentEdit = this.edit;

        // Requirement 4: A read response must never settle a write.
        if (currentEdit?.saving || this.pendingSaveRequestId) {
          return false;
        }

        this.setContent({
          loaded: { kind: 'file', preview },
          loading: false,
          failed: false,
        });

        if (shouldFlagReadPreviewConflict(currentEdit, preview)) {
          this.setEdit((prev) =>
            prev ? { ...prev, conflict: { next: preview.editable ? preview : null } } : null,
          );
        }
        return true;
      }

      case 'files.saved': {
        const expectedRequestId = this.pendingSaveRequestId ?? editorDraftStore.getPendingSave(this.tabId);
        if (!expectedRequestId || message.requestId !== expectedRequestId) {
          return false;
        }

        this.pendingSaveRequestId = null;
        editorDraftStore.setPendingSave(this.tabId, null);

        if (message.outcome === 'saved') {
          this.hasCompletedSave = true;
          this.activeReadRequestId = null;
          if (message.preview) {
            this.setContent({
              loaded: { kind: 'file', preview: message.preview },
              loading: false,
              failed: false,
            });
          }
          this.setEdit(null);
          this.callbacks.onJustSaved?.();
        } else {
          // Write conflict outcome: preserve user text and set conflict
          const next = message.preview?.editable ? message.preview : null;
          this.setEdit((prev) =>
            prev ? { ...prev, saving: false, conflict: { next } } : null,
          );
        }
        return true;
      }

      case 'error': {
        const expectedRequestId = this.pendingSaveRequestId ?? editorDraftStore.getPendingSave(this.tabId);
        if (expectedRequestId && message.requestId === expectedRequestId) {
          this.pendingSaveRequestId = null;
          editorDraftStore.setPendingSave(this.tabId, null);
          this.setEdit((prev) =>
            prev
              ? {
                  ...prev,
                  saving: false,
                  failure: { kind: 'server', text: message.text as ServerText },
                }
              : null,
          );
          return true;
        } else if (
          (message.requestId && message.requestId === this.activeReadRequestId) ||
          (!message.requestId && this.content?.loading)
        ) {
          this.setContent({
            loaded: this.content?.loaded ?? null,
            loading: false,
            failed: true,
          });
          return true;
        }
        return false;
      }

      default:
        return false;
    }
  }

  handleDisconnect(): void {
    if (this.pendingSaveRequestId || this.edit?.saving) {
      this.pendingSaveRequestId = null;
      editorDraftStore.setPendingSave(this.tabId, null);
      this.setEdit((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }
}

class EditorDraftStore {
  private readonly drafts = new Map<string, EditorDraft>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.restoreFromStorage();
  }

  private restoreFromStorage(): void {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (value && typeof value === 'object') {
            this.drafts.set(key, value as EditorDraft);
          }
        }
      }
    } catch {
      // Storage unavailable or malformed
    }
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      const serialized: Record<string, EditorDraft> = {};
      for (const [key, draft] of this.drafts.entries()) {
        // Persist drafts that are dirty or have active edits
        if (isDraftDirty(draft) || draft.edit !== null) {
          serialized[key] = draft;
        }
      }
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // Quota exceeded or storage disabled
    }
  }

  private notify(): void {
    this.persistToStorage();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[editorDraftStore] listener error:', err);
      }
    }
  }

  getDraft(tabId: string): EditorDraft | undefined {
    return this.drafts.get(tabId);
  }

  setDraft(tabId: string, draft: EditorDraft): void {
    const prev = this.drafts.get(tabId);
    const pendingSaveRequestId =
      draft.pendingSaveRequestId !== undefined ? draft.pendingSaveRequestId : prev?.pendingSaveRequestId ?? null;
    const finalDraft: EditorDraft = { ...draft, pendingSaveRequestId };
    this.drafts.set(tabId, finalDraft);
    if (
      isDraftDirty(prev) !== isDraftDirty(finalDraft) ||
      prev?.edit?.text !== finalDraft.edit?.text ||
      prev?.edit?.saving !== finalDraft.edit?.saving ||
      prev?.edit?.conflict !== finalDraft.edit?.conflict ||
      prev?.edit?.failure !== finalDraft.edit?.failure ||
      prev?.mode !== finalDraft.mode ||
      prev?.scrollTop !== finalDraft.scrollTop ||
      prev?.pendingSaveRequestId !== finalDraft.pendingSaveRequestId
    ) {
      this.notify();
    }
  }

  updateEdit(tabId: string, update: (current: DocEdit | null) => DocEdit | null): void {
    const current = this.drafts.get(tabId) ?? {
      edit: null,
      mode: 'formatted',
      scrollTop: 0,
    };
    const nextEdit = update(current.edit);
    this.setDraft(tabId, { ...current, edit: nextEdit });
  }

  clearDraft(tabId: string): void {
    if (this.drafts.delete(tabId)) {
      this.notify();
    }
  }

  clearAll(): void {
    this.drafts.clear();
    this.notify();
  }

  isDirty(tabId: string): boolean {
    return isDraftDirty(this.drafts.get(tabId));
  }

  getPendingSave(tabId: string): string | null {
    return this.drafts.get(tabId)?.pendingSaveRequestId ?? null;
  }

  setPendingSave(tabId: string, requestId: string | null): void {
    const draft = this.drafts.get(tabId);
    if (!draft) return;
    this.drafts.set(tabId, { ...draft, pendingSaveRequestId: requestId });
    this.notify();
  }

  findTabIdByPendingSave(requestId: string): string | undefined {
    for (const [tabId, draft] of this.drafts.entries()) {
      if (draft.pendingSaveRequestId === requestId) {
        return tabId;
      }
    }
    return undefined;
  }

  /**
   * A read preview must never acknowledge or cancel a pending write.
   * Only matching files.saved or request-correlated error may settle a write.
   */
  reconcilePendingSave(_tabId: string, _preview: FilePreview): { saved: boolean } {
    return { saved: false };
  }

  attachConnection(connection: AgentConnection): () => void {
    const offMessage = connection.onMessage((message) => {
      if (message.type === 'files.saved') {
        const tabId = this.findTabIdByPendingSave(message.requestId);
        if (!tabId) return;
        const draft = this.drafts.get(tabId);
        if (!draft) return;

        if (message.outcome === 'saved') {
          this.setDraft(tabId, {
            ...draft,
            edit: null,
            pendingSaveRequestId: null,
            content: message.preview
              ? {
                  loaded: { kind: 'file', preview: message.preview },
                  loading: false,
                  failed: false,
                }
              : draft.content,
          });
        } else {
          // Conflict outcome: preserve user text and set conflict
          const next = message.preview?.editable ? message.preview : null;
          this.setDraft(tabId, {
            ...draft,
            pendingSaveRequestId: null,
            edit: draft.edit
              ? {
                  ...draft.edit,
                  saving: false,
                  conflict: { next },
                }
              : null,
          });
        }
      } else if (message.type === 'error') {
        if (!message.requestId) return;
        const tabId = this.findTabIdByPendingSave(message.requestId);
        if (!tabId) return;
        const draft = this.drafts.get(tabId);
        if (!draft) return;

        this.setDraft(tabId, {
          ...draft,
          pendingSaveRequestId: null,
          edit: draft.edit
            ? {
                ...draft.edit,
                saving: false,
                failure: { kind: 'server', text: message.text as ServerText },
              }
            : null,
        });
      }
    });

    const offReopen = connection.onReopen(() => {
      this.handleDisconnect();
    });

    return () => {
      offMessage();
      offReopen();
    };
  }

  handleDisconnect(): void {
    for (const [tabId, draft] of this.drafts.entries()) {
      if (draft.pendingSaveRequestId || draft.edit?.saving) {
        this.setDraft(tabId, {
          ...draft,
          pendingSaveRequestId: null,
          edit: draft.edit ? { ...draft.edit, saving: false } : null,
        });
      }
    }
  }

  listDirtyTabIds(): string[] {
    const result: string[] = [];
    for (const [tabId, draft] of this.drafts.entries()) {
      if (isDraftDirty(draft)) {
        result.push(tabId);
      }
    }
    return result;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const editorDraftStore = new EditorDraftStore();
