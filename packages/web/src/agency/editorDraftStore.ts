/**
 * Centralized in-memory draft store for Agency Workspace Editor Tabs.
 *
 * Preserves unsaved editor edits, scroll positions, document view modes,
 * and loaded previews across tab switching, pane movement, selection changes,
 * and component unmounts.
 */

import type { DocContent, DocEdit } from '../useDocuments.js';
import type { DocMode } from '../doc-tabs.js';

export interface EditorDraft {
  edit: DocEdit | null;
  mode: DocMode;
  scrollTop: number;
  content?: DocContent;
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
    this.drafts.set(tabId, draft);
    if (
      isDraftDirty(prev) !== isDraftDirty(draft) ||
      prev?.edit?.text !== draft.edit?.text ||
      prev?.mode !== draft.mode ||
      prev?.scrollTop !== draft.scrollTop
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
