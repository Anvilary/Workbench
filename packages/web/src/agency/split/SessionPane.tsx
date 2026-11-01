import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, AgencyRuntimeSession } from '@agent-workbench/shared';
import type { Terminal } from '@xterm/xterm';
import type { AgentConnection } from '../../connection.js';
import { TerminalView } from '../../TerminalView.js';
import { t } from '../../i18n/index.js';
import { canLaunchAgent, type AgencyTransport } from '../model.js';
import type { useAgencyStore } from '../useAgencyStore.js';
import { PaneContextMenu } from './PaneContextMenu.js';
import { PaneFeedback } from './PaneFeedback.js';

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
}: Props): JSX.Element {
  const terminal = useRef<Terminal | null>(null);
  const [rendered, setRendered] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const feedbackTimer = useRef<number | null>(null);

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
    let text = term.getSelection();
    if (kind !== 'selection') {
      const buffer = kind === 'all' ? term.buffer.normal : term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)?.translateToString(true) ?? '',
      );
      while (lines.length && !lines.at(-1)?.trim()) lines.pop();
      text = (kind === 'last' ? lines.slice(-60) : lines).join('\n');
    }
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showFeedback(t('agency.ui.copied'), 'success');
    } catch {
      showFeedback(t('agency.ui.clipboardDenied'), 'error');
    }
  };

  const paste = async () => {
    if (!live || !session.terminalId) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendImmediate({ type: 'input', terminalId: session.terminalId, data: text });
      }
    } catch {
      showFeedback(t('agency.ui.clipboardDenied'), 'error');
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
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

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
      title={shellRestartedTitle}
    >
      <div className="agency-agent-body">
        {live && session.terminalId ? (
          <div className="agency-xterm-host">
            <TerminalView
              key={session.terminalId}
              terminalId={session.terminalId}
              connection={connection}
              theme="dark"
              active={active}
              autoFocus={focusTerminal}
              enableAgencyShortcuts
              onTerminalInstance={(instance) => {
                terminal.current = instance;
                if (instance) instance.onRender(() => setRendered(true));
                else setRendered(false);
              }}
              onClipboardError={(err) => showFeedback(err.message, 'error')}
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

      {contextMenu && (
        <PaneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasSelection={!!terminal.current?.hasSelection()}
          isLive={live && !!session.terminalId}
          onCopySelection={() => void copy('selection')}
          onCopyAll={() => void copy('all')}
          onCopyLast={() => void copy('last')}
          onPaste={() => void paste()}
          onInterrupt={interrupt}
          onClear={clear}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
