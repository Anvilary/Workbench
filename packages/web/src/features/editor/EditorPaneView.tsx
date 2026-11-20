import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceId } from '@agent-workbench/shared';
import type { EditorTab } from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection/connection.js';
import type { DocMode, OpenDoc } from '../files/doc-tabs.js';
import { DocumentViewer } from '../files/DocumentViewer.js';
import { editChanges, plainLineBreaks } from '../files/edit-changes.js';
import { t } from '../../i18n/index.js';
import type { DocContent, DocEdit, DocEditor } from '../files/useDocuments.js';
import { editorDraftStore, EditorSession } from './editorDraftStore.js';

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

  const savedTimer = useRef<number | null>(null);
  const dirtyReported = useRef(false);

  const sessionRef = useRef<EditorSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new EditorSession({
      tab,
      workspaceId,
      connection,
      initialDraft,
      callbacks: {
        onContentChange: setContent,
        onEditChange: setEdit,
        onJustSaved: () => {
          setJustSaved(true);
          if (savedTimer.current) window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setJustSaved(false), 1600);
        },
      },
    });
  } else {
    sessionRef.current.setContext(tab, workspaceId, connection);
  }

  const isDirty = Boolean(
    edit && (edit.text !== edit.opened || edit.conflict !== null || edit.pending !== null),
  );

  useEffect(() => {
    editorDraftStore.setDraft(tab.id, {
      edit,
      mode,
      scrollTop,
      content,
      pendingSaveRequestId: sessionRef.current?.getPendingSave() ?? null,
    });
  }, [tab.id, edit, mode, scrollTop, content]);

  useEffect(() => {
    if (!online && edit?.saving) {
      sessionRef.current?.handleDisconnect();
    }
  }, [online, edit?.saving]);

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
    sessionRef.current?.readFile();
  }, []);

  useEffect(() => {
    readFile();
  }, [readFile]);

  useEffect(() => {
    const offMessage = connection.onMessage((message) => {
      sessionRef.current?.handleMessage(message);
    });

    const offReopen = connection.onReopen(() => {
      sessionRef.current?.handleDisconnect();
      sessionRef.current?.readFile();
    });

    return () => {
      offMessage();
      offReopen();
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    };
  }, [connection]);

  const docEditor: DocEditor = useMemo(
    () => ({
      edit,
      unsaved: isDirty,
      justSaved,
      begin: () => {
        const loaded = content?.loaded;
        if (!loaded || loaded.kind !== 'file' || !loaded.preview.editable || typeof loaded.preview.hash !== 'string') return;
        const text = plainLineBreaks(loaded.preview.text);
        sessionRef.current?.setEdit({
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
        sessionRef.current?.setEdit((prev) => (prev ? { ...prev, text: newText } : null));
      },
      save: () => {
        if (!online) return;
        sessionRef.current?.save();
      },
      discard: () => {
        sessionRef.current?.discard();
      },
      adopt: () => {
        const current = sessionRef.current?.getEdit();
        const next = current?.conflict?.next;
        if (!current || !next || typeof next.hash !== 'string') return;
        const pending = editChanges(current.opened, current.text);
        const nextText = plainLineBreaks(next.text);
        sessionRef.current?.setEdit({
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
        sessionRef.current?.setEdit((prev) => (prev ? { ...prev, pending: null } : null));
      },
      confirmClose: () => {
        sessionRef.current?.setEdit((prev) => (prev ? { ...prev, closing: false } : null));
      },
      keepEditing: () => {
        sessionRef.current?.setEdit((prev) => (prev ? { ...prev, closing: false } : null));
      },
    }),
    [edit, isDirty, justSaved, content?.loaded, online],
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
