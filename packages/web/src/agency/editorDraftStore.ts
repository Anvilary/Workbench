/**
 * Centralized in-memory draft store for Agency Workspace Editor Tabs.
 *
 * Preserves unsaved editor edits, scroll positions, document view modes,
 * and loaded previews across tab switching, pane movement, selection changes,
 * and component unmounts.
 */

import type { DocContent, DocEdit } from '../useDocuments.js';
import type { DocMode } from '../doc-tabs.js';
import type { AgentConnection } from '../connection.js';
import type { FilePreview, ServerText } from '@agent-workbench/shared';

export interface EditorDraft {
  edit: DocEdit | null;
  mode: DocMode;
  scrollTop: number;
  content?: DocContent;
  pendingSaveRequestId?: string | null;
}

const STORAGE_KEY = 'maw.agency-editor-drafts.v1';

export function isDraftDirty(draft?: EditorDraft | null): boolean {
  if (!draft || !draft.edit) return false;
  return (
    draft.edit.text !== draft.edit.opened ||
    draft.edit.conflict !== null ||
    draft.edit.pending !== null
  );
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

  reconcilePendingSave(tabId: string, preview: FilePreview): { saved: boolean } {
    const draft = this.drafts.get(tabId);
    if (!draft || !draft.edit || !draft.edit.saving) return { saved: false };
    if (preview.text === draft.edit.text) {
      this.setDraft(tabId, {
        ...draft,
        edit: null,
        pendingSaveRequestId: null,
        content: {
          loaded: { kind: 'file', preview },
          loading: false,
          failed: false,
        },
      });
      return { saved: true };
    }
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
