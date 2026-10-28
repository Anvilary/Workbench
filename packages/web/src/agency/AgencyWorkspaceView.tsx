import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId, MawActivityState, WorkspaceId } from '@agent-workbench/shared';
import type { Terminal } from '@xterm/xterm';
import type { AgentConnection } from '../connection.js';
import { TerminalView } from '../TerminalView.js';
import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { canLaunchAgent, workspaceTabs } from './model.js';
import type { AgencyTransport } from './model.js';
import type { useAgencyStore } from './useAgencyStore.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  connection: AgentConnection;
  request: ReturnType<typeof useAgencyStore>['request'];
  sendImmediate: AgencyTransport['sendImmediate'];
  online: boolean;
  draft?: string;
  onDraft?: (value: string) => void;
  onDelivered?: (value: string) => void;
  onDone: () => void;
  launchError?: string | null;
  onClearLaunchError?: () => void;
  getTabActivity?: (workspaceId: WorkspaceId, tabId: string) => MawActivityState;
  onAcknowledgeTab?: (workspaceId: WorkspaceId, tabId: string) => Promise<any> | void;
}

function SessionPane({ session, active, focusTerminal, connection, online, request, sendImmediate, report }: {
  session: AgencyRuntimeSession; active: boolean; focusTerminal: boolean; connection: AgentConnection; online: boolean;
  request: Props['request']; sendImmediate: Props['sendImmediate']; report: (error: string) => void;
}) {
  const terminal = useRef<Terminal | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const live = ['starting', 'running', 'stopping'].includes(session.lifecycle);
  useEffect(() => { if (!active) setCopyOpen(false); }, [active]);
  async function copy(kind: 'selection' | 'all' | 'last') {
    setCopyOpen(false);
    const term = terminal.current;
    if (!term) return;
    let text = term.getSelection();
    if (kind !== 'selection') {
      const buffer = term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '');
      while (lines.length && !lines.at(-1)?.trim()) lines.pop();
      text = (kind === 'last' ? lines.slice(-60) : lines).join('\n');
    }
    try { if (text) await navigator.clipboard.writeText(text); } catch (reason) { report(String(reason)); }
  }
  async function resume() {
    if (resuming || !session.tab) return;
    setResuming(true);
    try { await request({ type: 'agency.tab.action', workspaceId: session.workspaceId, tabId: session.tab.id, action: 'resume' }); }
    catch (reason) { report(String(reason)); }
    finally { setResuming(false); }
  }
  return <div className="maw-session-pane" hidden={!active} role="tabpanel" id={'pane-' + session.tab?.id} aria-labelledby={'tab-' + session.tab?.id}>
    <div className="agency-pane-bar">
      <span className="agency-muted" role="status">{session.kind === 'terminal' && session.recovery?.status === 'resumed' && live ? t('agency.tabs.shellRestarted') : agencySessionText(session)}</span>
      <span className="agency-flex-spacer" />
      {live && session.terminalId && <>
        <div className="agency-dropdown" onClick={event => event.stopPropagation()}>
          <button type="button" className="agency-text-button" aria-haspopup="menu" aria-expanded={copyOpen} onClick={() => setCopyOpen(!copyOpen)}>{t('agency.ui.copy')} ▾</button>
          {copyOpen && <div className="agency-dropdown-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => void copy('selection')}>{t('agency.ui.copySelection')}</button>
            <button type="button" role="menuitem" onClick={() => void copy('all')}>{t('agency.ui.copyAll')}</button>
            <button type="button" role="menuitem" onClick={() => void copy('last')}>{t('agency.ui.copyLastOutput')}</button>
          </div>}
        </div>
        <button type="button" className="agency-text-button" disabled={!online} onClick={() => sendImmediate({ type: 'input', terminalId: session.terminalId!, data: '\x03' })}>{t('agency.ui.interrupt')}</button>
      </>}
    </div>
    <div className="agency-agent-body">
      {live && session.terminalId ? <div className="agency-xterm-host"><TerminalView key={session.terminalId} terminalId={session.terminalId} connection={connection} theme="dark" active={active} autoFocus={focusTerminal} enableAgencyShortcuts onTerminalInstance={instance => { terminal.current = instance; }} onClipboardError={error => report(error.message)} /></div> : <div className="agency-shell-placeholder">
        <p>{session.lifecycle === 'starting' ? t('agency.ui.starting') : session.exitCode === null ? t('agency.ui.previousAgentExited') : t('agency.ui.previousAgentExitedCode', { code: session.exitCode })}</p>
        {session.recovery?.message && <p role="status">{session.recovery.message}</p>}
        <p>{t('agency.tabs.historyKept')}</p>
        {(session.kind === 'terminal' || session.nativeSessionId) && <button type="button" className="agency-secondary-button" disabled={!online || resuming || live} onClick={() => void resume()}>{session.kind === 'terminal' ? t('agency.tabs.restartShell') : t('agency.ui.resumeNative')}</button>}
      </div>}
    </div>
  </div>;
}

export function AgencyWorkspaceView({ workspace, profiles, sessions, connection, request, sendImmediate, online, onDone, launchError, onClearLaunchError, getTabActivity, onAcknowledgeTab }: Props): JSX.Element {
  const tabs = workspaceTabs(sessions, workspace.id);
  const selected = tabs.find(session => session.tab?.selected) ?? tabs[0];
  const [keyboardTabs, setKeyboardTabs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [profileId, setProfileId] = useState<CliProfileId | ''>(profiles[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<AgencyRuntimeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const strip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; scroll: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const dialog = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!profileId && profiles.length) setProfileId(profiles[0]!.id); }, [profileId, profiles]);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [selected?.tab?.id, tabs.length]);
  useEffect(() => {
    if (selected?.tab && getTabActivity?.(workspace.id, selected.tab.id) === 'finished') {
      onAcknowledgeTab?.(workspace.id, selected.tab.id);
    }
  }, [selected?.tab?.id, workspace.id, getTabActivity, onAcknowledgeTab]);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault(); element.scrollLeft += event.deltaY;
    };
    const resize = new ResizeObserver(() => element.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement?.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
    resize.observe(element);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { resize.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);
  useEffect(() => {
    if (!picker && !closing) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !flight.current) { setPicker(false); setClosing(null); }
      if (event.key === 'Tab' && dialog.current) {
        const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [picker, closing]);
  async function add(kind: 'agent' | 'terminal') {
    if (flight.current || !online || (kind === 'agent' && !profileId)) return;
    setKeyboardTabs(false);
    flight.current = true; setBusy(true); setError(null); setMenu(false);
    try {
      await request({ type: 'agency.session.create', workspaceId: workspace.id, kind, launchId: crypto.randomUUID(), cols: 100, rows: 30, ...(kind === 'agent' ? { profileId: profileId as CliProfileId } : {}) } as Parameters<Props['request']>[0]);
      setPicker(false);
    } catch (reason) { setError(String(reason)); }
    finally { flight.current = false; setBusy(false); }
  }
  async function action(session: AgencyRuntimeSession, action: 'select' | 'close') {
    if (!session.tab || !online) return;
    try { await request({ type: 'agency.tab.action', workspaceId: workspace.id, tabId: session.tab.id, action }); }
    catch (reason) { setError(String(reason)); throw reason; }
  }
  async function close(session: AgencyRuntimeSession) {
    setKeyboardTabs(false);
    if (flight.current) return;
    flight.current = true; setBusy(true);
    try { await action(session, 'close'); setClosing(null); }
    catch { /* Keep confirmation and error visible until server termination is confirmed. */ }
    finally {
      flight.current = false; setBusy(false);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.maw-session-pane:not([hidden]) .xterm-helper-textarea')?.focus());
    }
  }
  async function navigate(event: React.KeyboardEvent) {
    if (!selected || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    setKeyboardTabs(true);
    const focusedId = (event.target as Element).closest('[data-tab-id]')?.getAttribute('data-tab-id');
    const current = Math.max(0, tabs.findIndex(session => session.tab!.id === (focusedId ?? selected.tab!.id)));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    if (event.altKey && event.key.startsWith('Arrow')) {
      const ids = tabs.map(session => session.tab!.id); [ids[current],ids[next]] = [ids[next]!,ids[current]!];
      try { await request({ type: 'agency.tabs.order', workspaceId: workspace.id, tabIds: ids }); } catch (reason) { setError(String(reason)); }
    } else {
      void action(tabs[next]!, 'select').catch(() => undefined);
      document.getElementById('tab-' + tabs[next]!.tab!.id)?.focus();
    }
  }
  function name(session: AgencyRuntimeSession) { return session.tab?.name ?? (session.kind === 'terminal' ? t('agency.tabs.terminalNamed', { number: session.tab?.terminalNumber ?? 1 }) : profiles.find(profile => profile.id === session.profileId)?.label ?? t('agency.ui.agentLabel')); }
  return <section className="agency-workspace-view" aria-label={t('agency.ui.workspaceNamed', { name: workspace.name })}>
    <header className="maw-tabs-header">
      <div className="maw-tabs-strip" ref={strip} role="tablist" aria-label={t('agency.tabs.tabList')} onKeyDown={event => void navigate(event)}
        onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('[data-close]')) return; drag.current = { id: event.pointerId, x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false }; }}
        onPointerMove={event => { const start = drag.current; if (!start) return; if (Math.abs(event.clientX - start.x) > 6) { start.moved = true; event.currentTarget.setPointerCapture(event.pointerId); } if (start.moved) { event.preventDefault(); event.currentTarget.scrollLeft = start.scroll - (event.clientX - start.x); } }}
        onPointerUp={event => { dragged.current = !!drag.current?.moved; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; setTimeout(() => { dragged.current = false; }, 0); }}
        onPointerCancel={() => { drag.current = null; dragged.current = false; }}
        onClickCapture={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); } }}>
        {tabs.map(session => {
          const tabState = getTabActivity && session.tab ? getTabActivity(workspace.id, session.tab.id) : undefined;
          const dotClass =
            tabState === 'finished' ? 'finished' :
            tabState === 'failed' || session.lifecycle === 'failed' || session.recovery?.status === 'manual' ? 'failed' :
            session.lifecycle === 'exited' ? 'muted' :
            ['awaiting-user','awaiting-permission'].includes(session.activity) ? 'attention' :
            session.activity === 'working' || tabState === 'working' ? 'working' :
            tabState === 'unknown' ? 'unknown' : 'idle';
          return (
            <div className={'maw-session-tab' + (selected?.id === session.id ? ' active' : '')} key={session.tab!.id} data-tab-id={session.tab!.id}>
              <button type="button" role="tab" id={'tab-' + session.tab!.id} aria-selected={selected?.id === session.id} aria-controls={'pane-' + session.tab!.id} tabIndex={selected?.id === session.id ? 0 : -1} title={name(session) + ' · ' + agencySessionText(session)} onClick={() => { setKeyboardTabs(false); void action(session, 'select').catch(() => undefined); if (session.tab) onAcknowledgeTab?.(workspace.id, session.tab.id); }}>
                <span aria-hidden="true">{session.kind === 'agent' ? '◇' : '>_'}</span><span className="agency-truncate">{name(session)}</span><span className={'agency-status-dot ' + dotClass} aria-label={agencySessionText(session)} />
              </button>
              <button type="button" data-close aria-label={t('agency.tabs.closeNamed', { name: name(session) })} disabled={!online || busy} onClick={() => { if (['starting','running','stopping'].includes(session.lifecycle)) setClosing(session); else void close(session); }}>×</button>
            </div>
          );
        })}
      </div>
      <div className="agency-dropdown maw-add-tab" onClick={event => event.stopPropagation()}>
        <button type="button" className="agency-icon-button" aria-label={t('agency.tabs.add')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={!online || busy}>+</button>
        {menu && <div className="agency-dropdown-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setPicker(true); }}>{t('agency.tabs.newCLI')}</button>
          <button type="button" role="menuitem" onClick={() => void add('terminal')}>{t('agency.tabs.newTerminal')}</button>
        </div>}
      </div>
      <button type="button" className="agency-text-button" onClick={onDone}>{t('agency.ui.markDone')}</button>
    </header>
    {(error || launchError) && <div className="agency-error-bar" role="alert"><span>{error || launchError}</span><button type="button" aria-label={t('agency.ui.dismissError')} onClick={() => { setError(null); onClearLaunchError?.(); }}>×</button></div>}
    <div className="maw-session-content">
      {tabs.map(session => <SessionPane focusTerminal={!keyboardTabs} key={session.tab!.id} session={session} active={selected?.id === session.id} connection={connection} online={online} request={request} sendImmediate={sendImmediate} report={setError} />)}
      {!tabs.length && <div className="agency-shell-placeholder"><p>{t('agency.tabs.empty')}</p><button type="button" className="agency-secondary-button" disabled={!online} onClick={() => setPicker(true)}>{t('agency.tabs.newCLI')}</button><button type="button" className="agency-secondary-button" disabled={!online || busy} onClick={() => void add('terminal')}>{t('agency.tabs.newTerminal')}</button></div>}
    </div>
    {(picker || closing) && <div className="agency-modal-backdrop"><div ref={dialog} className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="maw-session-dialog">
      <h2 id="maw-session-dialog">{closing ? t('agency.tabs.confirmClose', { name: name(closing) }) : t('agency.tabs.newCLI')}</h2>
      {!closing && !canLaunchAgent(profiles.find(profile => profile.id === profileId)) && <p role="status">{profiles.find(profile => profile.id === profileId)?.configurationMessage}</p>}
      {closing ? <p>{t('agency.tabs.closeExplanation')}</p> : <label className="agency-field"><span>{t('agency.ui.cliProfile')}</span><select autoFocus value={profileId} onChange={event => setProfileId(event.target.value as CliProfileId)}>{profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.label}</option>)}</select></label>}
      {error && <p role="alert" className="agency-error">{error}</p>}
      <div className="agency-dialog-actions"><button type="button" autoFocus={!!closing} disabled={busy} onClick={() => { setPicker(false); setClosing(null); }}>{t('common.cancel')}</button><button type="button" className="agency-primary-button" disabled={busy || !online || (!closing && !canLaunchAgent(profiles.find(profile => profile.id === profileId)))} onClick={() => closing ? void close(closing) : void add('agent')}>{closing ? t('agency.tabs.closeSession') : t('agency.ui.startCLI')}</button></div>
    </div></div>}
  </section>;
}
