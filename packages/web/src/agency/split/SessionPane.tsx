import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, AgencyRuntimeSession } from '@agent-workbench/shared';
import type { Terminal } from '@xterm/xterm';
import type { AgentConnection } from '../../connection.js';
import { TerminalView } from '../../TerminalView.js';
import type { SearchAddon } from '@xterm/addon-search';
import { t } from '../../i18n/index.js';
import { canLaunchAgent, type AgencyTransport } from '../model.js';
import type { useAgencyStore } from '../useAgencyStore.js';
import { PaneContextMenu } from './PaneContextMenu.js';
import { TerminalSearchBar } from './TerminalSearchBar.js';
import { PaneFeedback } from './PaneFeedback.js';
import { terminalPathCandidate } from './terminal-path.mjs';
import { extractBufferText, extractLastOutput } from './terminal-buffer.js';
import { writeClipboard, readClipboard } from '../clipboard.js';

interface Props {
  session: AgencyRuntimeSession;
  active: boolean;
  focusTerminal: boolean;
  connection: AgentConnection;
  online: boolean;
  request: ReturnType<typeof useAgencyStore>['request'];
  sendImmediate: AgencyTransport['sendImmediate'];
  report: (error: string) => void;
  onDisplayed: (tabId: string, ready: boolean) => void;
  profile?: AgencyCliProfile;
  busy?: boolean;
  onConfigure?: (profile: AgencyCliProfile) => void;
  onStartAgain?: (session: AgencyRuntimeSession) => void;
  workspaceCwd?: string;
}

export function SessionPane({
  session,
  active,
  focusTerminal,
  connection,
  online,
  request,
  sendImmediate,
  report,
  onDisplayed,
  profile,
  busy,
  onConfigure,
  onStartAgain,
  workspaceCwd,
}: Props): JSX.Element {
  const terminal = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [rendered, setRendered] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    candidate: { relative: string; absolute: string } | null;
    selectedText: string;
  } | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  const openSearch = (initial?: string) => {
    const q = initial !== undefined ? initial : (terminal.current?.getSelection() || '');
    setSearchQuery(q);
    setSearchOpen(true);
  };

  const live = ['starting', 'running', 'stopping'].includes(session.lifecycle);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        clearTimeout(feedbackTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!session.tab) return;
    const id = session.tab.id;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        onDisplayed(id, active && online && !document.hidden && (!live || rendered)),
      );
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', check);
      onDisplayed(id, false);
    };
  }, [active, online, live, rendered, session.tab?.id, onDisplayed]);

  const showFeedback = (message: string, type: 'success' | 'error') => {
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    setFeedback({ message, type });
    feedbackTimer.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimer.current = null;
    }, 2000);
  };

  const copy = async (kind: 'selection' | 'all' | 'last') => {
    const term = terminal.current;
    if (!term) return;
    const isRemote = connection.isRemoteClient ? connection.isRemoteClient() : false;
    let text = '';
    let isAlternate = false;

    if (kind === 'selection') {
      text = term.getSelection() || contextMenu?.selectedText || '';
      if (!text) {
        showFeedback(t('agency.ui.nothingSelected'), 'error');
        return;
      }
    } else if (kind === 'all') {
      const buffer = term.buffer.active;
      isAlternate = buffer.type === 'alternate';
      text = extractBufferText(buffer, 0, buffer.length - 1);
    } else if (kind === 'last') {
      const marker = (term as unknown as { __mawLastCommandMarker?: { line: number } | null }).__mawLastCommandMarker;
      text = extractLastOutput(term, marker);
    }

    if (!text) {
      showFeedback(t('agency.ui.nothingSelected'), 'error');
      return;
    }

    try {
      const ok = await writeClipboard(text, isRemote);
      if (ok) {
        if (kind === 'all' && isAlternate) {
          showFeedback(t('agency.ui.availableBufferCopied'), 'success');
        } else {
          showFeedback(t('agency.ui.copied'), 'success');
        }
        if (kind === 'selection') {
          term.clearSelection();
        }
      } else {
        showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
      }
    } catch {
      showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
    }
  };

  const paste = async () => {
    if (!live || !session.terminalId) return;
    try {
      const isRemote = connection.isRemoteClient ? connection.isRemoteClient() : false;
      const text = await readClipboard(isRemote);
      if (text) {
        sendImmediate({ type: 'input', terminalId: session.terminalId, data: text });
      }
    } catch {
      showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
    }
  };

  const interrupt = () => {
    if (!live || !session.terminalId || !online) return;
    sendImmediate({ type: 'input', terminalId: session.terminalId, data: '\x03' });
  };

  const clear = () => {
    terminal.current?.clear();
  };

  async function resume() {
    if (resuming || !session.tab) return;
    setResuming(true);
    try {
      await request({
        type: 'agency.tab.action',
        workspaceId: session.workspaceId,
        tabId: session.tab.id,
        action: 'resume',
      });
    } catch (reason) {
      report(String(reason));
    } finally {
      setResuming(false);
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const selection = terminal.current?.getSelection() || '';
    const trimmed = selection.trim();
    let candidate: { relative: string; absolute: string } | null = null;
    if (trimmed && workspaceCwd) {
      const res = terminalPathCandidate(trimmed, workspaceCwd);
      if (res.ok) candidate = { relative: res.relative, absolute: res.absolute };
    }
    setContextMenu({ x: e.clientX, y: e.clientY, candidate, selectedText: selection });
  };

  const openFile = (relativePath: string) => {
    void request({
      type: 'agency.editorTab.open',
      workspaceId: session.workspaceId,
      filePath: relativePath,
      select: true,
    })
      .then(() => {
        showFeedback(t('agency.terminal.fileOpened'), 'success');
      })
      .catch((err) => {
        report(err instanceof Error ? err.message : String(err));
      });
  };

  const copyFile = async (relativePath: string) => {
    if (!workspaceCwd) return;
    if (typeof window !== 'undefined' && window.mawChatGpt?.command && !(connection.isRemoteClient ? connection.isRemoteClient() : false)) {
      try {
        const res = (await window.mawChatGpt.command({
          type: 'copy-file',
          cwd: workspaceCwd,
          relative: relativePath,
        })) as { ok: boolean; error?: string } | undefined;
        if (res && res.ok) {
          showFeedback(t('agency.ui.copied'), 'success');
        } else {
          showFeedback(t('agency.terminal.copyFileUnavailable'), 'error');
        }
      } catch {
        showFeedback(t('agency.terminal.copyFileUnavailable'), 'error');
      }
    } else {
      showFeedback(t('agency.terminal.copyFileUnavailable'), 'error');
    }
  };

  const copyAbsolutePath = async (absolute: string) => {
    const isRemote = connection.isRemoteClient ? connection.isRemoteClient() : false;
    const ok = await writeClipboard(absolute, isRemote);
    if (ok) {
      showFeedback(t('agency.ui.copied'), 'success');
    } else {
      showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
    }
  };

  const copyRelativePath = async (relative: string) => {
    const isRemote = connection.isRemoteClient ? connection.isRemoteClient() : false;
    const ok = await writeClipboard(relative, isRemote);
    if (ok) {
      showFeedback(t('agency.ui.copied'), 'success');
    } else {
      showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
    }
  };

  const copyFileContents = (relativePath: string) => {
    if (!session.terminalId || !online) return;
    let timer: number | null = null;
    let cleaned = false;
    const unsubscribe = connection.onMessage((msg) => {
      if (
        msg.type === 'files.preview' &&
        msg.terminalId === session.terminalId &&
        msg.preview.path === relativePath
      ) {
        if (timer !== null) clearTimeout(timer);
        if (!cleaned) {
          cleaned = true;
          unsubscribe();
        }
        if (msg.preview.binary) {
          showFeedback(t('agency.terminal.binaryFileError'), 'error');
        } else {
          const isRemote = connection.isRemoteClient ? connection.isRemoteClient() : false;
          void writeClipboard(msg.preview.text, isRemote).then(
            (ok) => {
              if (ok) showFeedback(t('agency.ui.copied'), 'success');
              else showFeedback(t('agency.ui.clipboardUnavailable'), 'error');
            },
            () => showFeedback(t('agency.ui.clipboardUnavailable'), 'error'),
          );
        }
      }
    });
    timer = window.setTimeout(() => {
      if (!cleaned) {
        cleaned = true;
        unsubscribe();
      }
      showFeedback(t('agency.terminal.copyFileUnavailable'), 'error');
    }, 3000);
    connection.send({ type: 'files.read', terminalId: session.terminalId, path: relativePath });
  };

  const canCopyNativeFile = typeof window !== 'undefined' && !!window.mawChatGpt?.command && !(connection.isRemoteClient ? connection.isRemoteClient() : false);

  const shellRestartedTitle =
    session.kind === 'terminal' && session.recovery?.status === 'resumed'
      ? t('agency.tabs.shellRestarted')
      : undefined;

  return (
    <div
      className="maw-session-pane"
      hidden={!active}
      role="tabpanel"
      id={'pane-' + session.tab?.id}
      aria-labelledby={'tab-' + session.tab?.id}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          e.stopPropagation();
          openSearch();
        }
      }}
      title={shellRestartedTitle}
    >
      <div className="agency-agent-body">
        {live && session.terminalId ? (
          <div className="agency-xterm-host">
            {searchOpen && (
              <TerminalSearchBar
                terminal={terminal.current}
                searchAddon={searchAddonRef.current}
                initialQuery={searchQuery}
                onClose={() => setSearchOpen(false)}
              />
            )}
            <TerminalView
              key={session.terminalId}
              terminalId={session.terminalId}
              connection={connection}
              theme={typeof document !== 'undefined' && document.documentElement.dataset['terminalTheme'] === 'light' ? 'light' : 'dark'}
              active={active}
              autoFocus={focusTerminal}
              enableAgencyShortcuts
              isRemoteClient={connection.isRemoteClient ? connection.isRemoteClient() : false}
              onTerminalInstance={(instance) => {
                terminal.current = instance;
                if (instance) instance.onRender(() => setRendered(true));
                else setRendered(false);
              }}
              onSearchAddon={(addon) => {
                searchAddonRef.current = addon;
              }}
              onOpenSearch={() => openSearch()}
              onClipboardError={(err) => showFeedback(err.message, 'error')}
              onClipboardSuccess={(msg) => showFeedback(msg || t('agency.ui.copied'), 'success')}
            />
          </div>
        ) : (
          <div className="agency-shell-placeholder">
            <p>
              {session.lifecycle === 'starting'
                ? t('agency.ui.starting')
                : session.exitCode === null
                  ? t('agency.ui.previousAgentExited')
                  : t('agency.ui.previousAgentExitedCode', { code: session.exitCode })}
            </p>
            {session.recovery?.message && <p role="status">{session.recovery.message}</p>}
            <p>{t('agency.tabs.historyKept')}</p>
            {(session.kind === 'terminal' || session.nativeSessionId) && (
              <button
                type="button"
                className="agency-secondary-button"
                disabled={!online || resuming || live}
                onClick={() => void resume()}
              >
                {session.kind === 'terminal' ? t('agency.tabs.restartShell') : t('agency.ui.resumeNative')}
              </button>
            )}
            {session.kind === 'agent' && !session.nativeSessionId && (session.lifecycle === 'failed' || session.lifecycle === 'exited') && session.tab && (
              <div className="agency-dialog-actions">
                {onStartAgain && (
                  <button
                    type="button"
                    className="agency-secondary-button"
                    disabled={!online || busy || !canLaunchAgent(profile)}
                    onClick={() => onStartAgain(session)}
                  >
                    {t('agency.tabs.startAgain')}
                  </button>
                )}
                {onConfigure && profile && !(connection.isRemoteClient ? connection.isRemoteClient() : false) && (
                  <button
                    type="button"
                    className="agency-secondary-button"
                    disabled={!online}
                    onClick={() => onConfigure(profile)}
                  >
                    {t('agency.profile.configure')}
                  </button>
                )}
                <button
                  type="button"
                  className="agency-secondary-button"
                  disabled={!online}
                  onClick={() =>
                    void request({
                      type: 'agency.tab.action',
                      workspaceId: session.workspaceId,
                      tabId: session.tab!.id,
                      action: 'close',
                    })
                  }
                >
                  {t('agency.tabs.closeSession')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {feedback && <PaneFeedback message={feedback.message} type={feedback.type} />}

      {contextMenu && (() => {
        const term = terminal.current;
        const buffer = term?.buffer.active;
        const hasBuffer = Boolean(buffer && buffer.length > 0 && extractBufferText(buffer, 0, Math.min(buffer.length - 1, 50)).trim().length > 0);
        const hasLast = Boolean(term && extractLastOutput(term, (term as unknown as { __mawLastCommandMarker?: { line: number } | null }).__mawLastCommandMarker).trim().length > 0);

        return (
          <PaneContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            hasSelection={!!(terminal.current?.hasSelection() || (contextMenu ? contextMenu.selectedText.length > 0 : false))}
            canCopyLast={hasLast}
            canCopyAll={hasBuffer}
            isLive={live && !!session.terminalId}
            fileCandidate={contextMenu.candidate}
            canCopyNativeFile={canCopyNativeFile}
            onCopySelection={() => void copy('selection')}
            onCopyLast={() => void copy('last')}
            onCopyAll={() => void copy('all')}
            onOpenSearch={() => openSearch(contextMenu.selectedText)}
            onSelectAll={() => {
              terminal.current?.selectAll();
              terminal.current?.focus();
            }}
            onPaste={() => void paste()}
            onInterrupt={interrupt}
            onClear={clear}
            onOpenFile={contextMenu.candidate ? () => openFile(contextMenu.candidate!.relative) : undefined}
            onCopyFile={contextMenu.candidate ? () => void copyFile(contextMenu.candidate!.relative) : undefined}
            onCopyAbsolutePath={contextMenu.candidate ? () => void copyAbsolutePath(contextMenu.candidate!.absolute) : undefined}
            onCopyRelativePath={contextMenu.candidate ? () => void copyRelativePath(contextMenu.candidate!.relative) : undefined}
            onCopyFileContents={contextMenu.candidate ? () => copyFileContents(contextMenu.candidate!.relative) : undefined}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}
    </div>
  );
}
