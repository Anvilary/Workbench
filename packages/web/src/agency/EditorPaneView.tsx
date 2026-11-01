import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServerText, WorkspaceId } from '@agent-workbench/shared';
import type { EditorTab } from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import type { DocMode, OpenDoc } from '../doc-tabs.js';
import { DocumentViewer } from '../DocumentViewer.js';
import { editChanges, plainLineBreaks } from '../edit-changes.js';
import { t } from '../i18n/index.js';
import type { DocContent, DocEdit, DocEditor } from '../useDocuments.js';
import { editorDraftStore } from './editorDraftStore.js';

interface Props {
  tab: EditorTab;
  workspaceId: WorkspaceId;
  connection: AgentConnection;
  online: boolean;
  reportError: (error: string) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
  onOpenRelativeFile?: (targetPath: string) => void;
}

export function EditorPaneView({
  tab,
  workspaceId,
  connection,
  online,
  reportError: _reportError,
  onDirtyChange,
  onOpenRelativeFile,
}: Props): JSX.Element {
  const initialDraft = editorDraftStore.getDraft(tab.id);
  const [content, setContent] = useState<DocContent | undefined>(initialDraft?.content);
  const [edit, setEdit] = useState<DocEdit | null>(initialDraft?.edit ?? null);
  const [justSaved, setJustSaved] = useState(false);
  const [mode, setMode] = useState<DocMode>(initialDraft?.mode ?? 'formatted');
  const [scrollTop, setScrollTop] = useState<number>(initialDraft?.scrollTop ?? 0);

  const editRef = useRef<DocEdit | null>(edit);
  editRef.current = edit;
  const pendingSave = useRef<string | null>(initialDraft?.pendingSaveRequestId ?? null);
  const savedTimer = useRef<number | null>(null);
  const dirtyReported = useRef(false);

  const isDirty = Boolean(
    edit && (edit.text !== edit.opened || edit.conflict !== null || edit.pending !== null),
  );

  useEffect(() => {
    editorDraftStore.setDraft(tab.id, {
      edit,
      mode,
      scrollTop,
      content,
      pendingSaveRequestId: pendingSave.current,
    });
  }, [tab.id, edit, mode, scrollTop, content]);

  useEffect(() => {
    if (!online && edit?.saving) {
      pendingSave.current = null;
      editorDraftStore.setPendingSave(tab.id, null);
      setEdit((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }, [online, edit?.saving, tab.id]);

  useEffect(() => {
    if (dirtyReported.current !== isDirty) {
      dirtyReported.current = isDirty;
      onDirtyChange?.(tab.id, isDirty);
    }
  }, [isDirty, tab.id, onDirtyChange]);

  const doc: OpenDoc = useMemo(
    () => ({
      key: tab.filePath,
      title: tab.title,
      mode,
    }),
    [tab.filePath, tab.title, mode],
  );

  const readFile = useCallback(() => {
    setContent((prev) => ({
      loaded: prev?.loaded ?? null,
      loading: prev?.loaded ? false : true,
      failed: false,
    }));
    connection.send({
      type: 'files.read',
      terminalId: workspaceId,
      path: tab.filePath,
    });
  }, [connection, workspaceId, tab.filePath]);

  useEffect(() => {
    readFile();
  }, [readFile]);

  useEffect(() => {
    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'files.preview': {
          if (message.terminalId === workspaceId && message.preview.path === tab.filePath) {
            const preview = message.preview;
            setContent({
              loaded: { kind: 'file', preview },
              loading: false,
              failed: false,
            });
            const currentEdit = editRef.current;
            if (currentEdit?.saving) {
              pendingSave.current = null;
              editorDraftStore.setPendingSave(tab.id, null);
              if (preview.text === currentEdit.text) {
                setEdit(null);
                setJustSaved(true);
                if (savedTimer.current) window.clearTimeout(savedTimer.current);
                savedTimer.current = window.setTimeout(() => setJustSaved(false), 1600);
              } else {
                setEdit((prev) =>
                  prev ? { ...prev, saving: false, conflict: { next: preview.editable ? preview : null } } : null,
                );
              }
            } else if (currentEdit && typeof preview.hash === 'string' && preview.hash !== currentEdit.baseHash && currentEdit.conflict === null) {
              setEdit((prev) =>
                prev ? { ...prev, conflict: { next: preview.editable ? preview : null } } : null,
              );
            }
          }
          break;
        }
        case 'files.saved': {
          const expectedRequestId = pendingSave.current ?? editorDraftStore.getPendingSave(tab.id);
          if (expectedRequestId && message.requestId === expectedRequestId) {
            pendingSave.current = null;
            editorDraftStore.setPendingSave(tab.id, null);
            if (message.outcome === 'saved') {
              if (message.preview) {
                setContent({
                  loaded: { kind: 'file', preview: message.preview },
                  loading: false,
                  failed: false,
                });
              }
              setEdit(null);
              setJustSaved(true);
              if (savedTimer.current) window.clearTimeout(savedTimer.current);
              savedTimer.current = window.setTimeout(() => setJustSaved(false), 1600);
            } else {
              const next = message.preview?.editable ? message.preview : null;
              setEdit((prev) =>
                prev ? { ...prev, saving: false, conflict: { next } } : null,
              );
            }
          }
          break;
        }
        case 'error': {
          const expectedRequestId = pendingSave.current ?? editorDraftStore.getPendingSave(tab.id);
          if (expectedRequestId && message.requestId === expectedRequestId) {
            pendingSave.current = null;
            editorDraftStore.setPendingSave(tab.id, null);
            setEdit((prev) =>
              prev
                ? {
                    ...prev,
                    saving: false,
                    failure: { kind: 'server', text: message.text as ServerText },
                  }
                : null,
            );
          } else if (content?.loading) {
            setContent((prev) => ({
              loaded: prev?.loaded ?? null,
              loading: false,
              failed: true,
            }));
          }
          break;
        }
        default:
          break;
      }
    });

    const offReopen = connection.onReopen(() => {
      readFile();
    });

    return () => {
      offMessage();
      offReopen();
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    };
  }, [connection, workspaceId, tab.filePath, readFile, content?.loading]);

  const docEditor: DocEditor = useMemo(
    () => ({
      edit,
      unsaved: isDirty,
      justSaved,
      begin: () => {
        const loaded = content?.loaded;
        if (!loaded || loaded.kind !== 'file' || !loaded.preview.editable || typeof loaded.preview.hash !== 'string') return;
        const text = plainLineBreaks(loaded.preview.text);
        setEdit({
          opened: text,
          baseHash: loaded.preview.hash,
          text,
          saving: false,
          failure: null,
          conflict: null,
          pending: null,
          closing: false,
        });
      },
      change: (newText: string) => {
        setEdit((prev) => (prev ? { ...prev, text: newText } : null));
      },
      save: () => {
        const current = editRef.current;
        if (!current || current.saving || current.conflict !== null || !online) return;
        const reqId = crypto.randomUUID();
        pendingSave.current = reqId;
        editorDraftStore.setPendingSave(tab.id, reqId);
        setEdit((prev) => (prev ? { ...prev, saving: true, failure: null } : null));
        connection.send({
          type: 'files.write',
          requestId: reqId,
          terminalId: workspaceId,
          path: tab.filePath,
          baseHash: current.baseHash,
          text: current.text,
        });
      },
      discard: () => {
        pendingSave.current = null;
        editorDraftStore.setPendingSave(tab.id, null);
        setEdit(null);
      },
      adopt: () => {
        const current = editRef.current;
        const next = current?.conflict?.next;
        if (!current || !next || typeof next.hash !== 'string') return;
        const pending = editChanges(current.opened, current.text);
        const nextText = plainLineBreaks(next.text);
        setEdit({
          opened: nextText,
          baseHash: next.hash,
          text: nextText,
          saving: false,
          failure: null,
          conflict: null,
          pending: pending.length > 0 ? pending : null,
          closing: false,
        });
      },
      dismissPending: () => {
        setEdit((prev) => (prev ? { ...prev, pending: null } : null));
      },
      confirmClose: () => {
        setEdit((prev) => (prev ? { ...prev, closing: false } : null));
      },
      keepEditing: () => {
        setEdit((prev) => (prev ? { ...prev, closing: false } : null));
      },
    }),
    [edit, isDirty, justSaved, content?.loaded, online, connection, workspaceId, tab.filePath],
  );

  return (
    <div className="maw-editor-pane">
      <DocumentViewer
        doc={doc}
        content={content}
        readingText={t('files.readingFile')}
        truncatedText={t('files.preview.truncated')}
        onReload={readFile}
        onModeChange={setMode}
        onOpenWithSystem={null}
        onOpenLink={onOpenRelativeFile}
        initialScroll={scrollTop}
        onScrollChange={setScrollTop}
        editor={docEditor}
      />
    </div>
  );
}
