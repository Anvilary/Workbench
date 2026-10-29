import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId, MawActivityState, WebTab, WorkspaceId } from '@agent-workbench/shared';
import type { Terminal } from '@xterm/xterm';
import type { AgentConnection } from '../connection.js';
import { TerminalView } from '../TerminalView.js';
import { t } from '../i18n/index.js';
import { agencySessionText, agencyTabActivityText } from './agency-labels.js';
import { allWorkspaceTabs, canLaunchAgent, selectedWorkspaceTab, type WorkspaceTab } from './model.js';
import { TabNameInput } from './TabNameInput.js';
import { AgencyBrowserViewer } from './AgencyBrowserViewer.js';
import { validateChatGptUrl, validateWebTabTitle } from '@agent-workbench/shared';
import type { AgencyTransport } from './model.js';
import type { useAgencyStore } from './useAgencyStore.js';
import { AgencyProfileDialog } from './AgencyProfileDialog.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
  getTabActivityVersion?: (workspaceId: WorkspaceId, tabId: string) => string;
  onTabDisplayed?: (workspaceId: WorkspaceId, tabId: string) => void;
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
  onAcknowledgeTab?: (workspaceId: WorkspaceId, tabId: string) => Promise<void> | void;
}

function SessionPane({ session, active, focusTerminal, connection, online, request, sendImmediate, report, onDisplayed }: {
  session: AgencyRuntimeSession; active: boolean; focusTerminal: boolean; connection: AgentConnection; online: boolean;
  request: Props['request']; sendImmediate: Props['sendImmediate']; report: (error: string) => void; onDisplayed: (tabId: string, ready: boolean) => void;
}) {
  const terminal = useRef<Terminal | null>(null);
  const [rendered, setRendered] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const live = ['starting', 'running', 'stopping'].includes(session.lifecycle);
  useEffect(() => { if (!active) setCopyOpen(false); }, [active]);
  useEffect(() => {
    if (!session.tab) return;
    const id = session.tab.id;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onDisplayed(id, active && online && !document.hidden && (!live || rendered)));
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', check); onDisplayed(id, false); };
  }, [active, online, live, rendered, session.tab?.id, onDisplayed]);
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
      {live && session.terminalId ? <div className="agency-xterm-host"><TerminalView key={session.terminalId} terminalId={session.terminalId} connection={connection} theme="dark" active={active} autoFocus={focusTerminal} enableAgencyShortcuts onTerminalInstance={instance => { terminal.current = instance; if (instance) instance.onRender(() => setRendered(true)); else setRendered(false); }} onClipboardError={error => report(error.message)} /></div> : <div className="agency-shell-placeholder">
        <p>{session.lifecycle === 'starting' ? t('agency.ui.starting') : session.exitCode === null ? t('agency.ui.previousAgentExited') : t('agency.ui.previousAgentExitedCode', { code: session.exitCode })}</p>
        {session.recovery?.message && <p role="status">{session.recovery.message}</p>}
        <p>{t('agency.tabs.historyKept')}</p>
        {(session.kind === 'terminal' || session.nativeSessionId) && <button type="button" className="agency-secondary-button" disabled={!online || resuming || live} onClick={() => void resume()}>{session.kind === 'terminal' ? t('agency.tabs.restartShell') : t('agency.ui.resumeNative')}</button>}
        {session.kind === 'agent' && !session.nativeSessionId && (session.lifecycle === 'failed' || session.lifecycle === 'exited') && session.tab && (
          <button type="button" className="agency-secondary-button" disabled={!online} onClick={() => void request({ type: 'agency.tab.action', workspaceId: session.workspaceId, tabId: session.tab!.id, action: 'close' })}>{t('agency.tabs.closeSession')}</button>
        )}
      </div>}
    </div>
  </div>;
}

export function AgencyWorkspaceView({ workspace, profiles, sessions, webTabs, connection, request, sendImmediate, online, onDone, launchError, onClearLaunchError, getTabActivity, onAcknowledgeTab, onTabDisplayed, getTabActivityVersion }: Props): JSX.Element {
  const tabs = allWorkspaceTabs(sessions, webTabs, workspace.id);
  const selected = selectedWorkspaceTab(tabs);
  const [keyboardTabs, setKeyboardTabs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [webDialog, setWebDialog] = useState<'create' | 'navigate' | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [webUrl, setWebUrl] = useState('https://chatgpt.com/');
  const [webTitle, setWebTitle] = useState('');
  const [profileId, setProfileId] = useState<CliProfileId | ''>(profiles[0]?.id ?? '');
  const [configuringProfile, setConfiguringProfile] = useState<AgencyCliProfile | null>(null);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const isUnconfigured = selectedProfile?.configurationStatus === 'error' &&
    (selectedProfile.configurationMessage?.includes('Configure an executable') ?? false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<WorkspaceTab | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayed, setDisplayed] = useState<string | null>(null);
  const flight = useRef(false);
  const acknowledged = useRef(new Set<string>());
  const strip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; scroll: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const dialog = useRef<HTMLDivElement | null>(null);
  const reportDisplayed = useCallback((id: string, ready: boolean) => {
    setDisplayed(previous => ready ? id : previous === id ? null : previous);
  }, []);
  useEffect(() => { if (!profileId && profiles.length) setProfileId(profiles[0]!.id); }, [profileId, profiles]);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [selected?.id, tabs.length]);
  const activity = selected ? getTabActivity?.(workspace.id, selected.id) : undefined;
  const activityVersion = selected ? getTabActivityVersion?.(workspace.id, selected.id) ?? '' : '';
  useEffect(() => {
    if (!online || !selected || displayed !== selected.id || document.hidden) return;
    onTabDisplayed?.(workspace.id, selected.id);
    const key = selected.id + ':' + activityVersion;
    if (activity !== 'finished') { acknowledged.current.delete(key); return; }
    if (!onAcknowledgeTab || acknowledged.current.has(key)) return;
    acknowledged.current.add(key);
    void Promise.resolve(onAcknowledgeTab(workspace.id, selected.id)).catch(reason => {
      acknowledged.current.delete(key); setError(String(reason));
    });
  }, [selected?.id, displayed, activity, activityVersion, workspace.id, online, onAcknowledgeTab, onTabDisplayed]);
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
    if ((!picker && !closing && !webDialog) || configuringProfile) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !flight.current) { setPicker(false); setClosing(null); setWebDialog(null); }
      if (event.key === 'Tab' && dialog.current) {
        const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [picker, closing, webDialog, configuringProfile]);
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
  async function action(tab: WorkspaceTab, action: 'select' | 'close') {
    if (!online) throw new Error(t('agency.web.disconnected'));
    try {
      await request(tab.kind === 'web'
        ? { type: action === 'select' ? 'agency.webTab.select' : 'agency.webTab.close', workspaceId: workspace.id, tabId: tab.id }
        : { type: 'agency.tab.action', workspaceId: workspace.id, tabId: tab.id, action });
    } catch (reason) { setError(String(reason)); throw reason; }
  }
  async function close(tab: WorkspaceTab) {
    setKeyboardTabs(false);
    if (flight.current) return;
    flight.current = true; setBusy(true);
    try { await action(tab, 'close'); setClosing(null); }
    catch { /* Keep confirmation and error visible until the server confirms close. */ }
    finally {
      flight.current = false; setBusy(false);
      requestAnimationFrame(() => {
        if (!document.activeElement?.closest('input, [role=tab]')) document.querySelector<HTMLTextAreaElement>('.maw-session-pane:not([hidden]) .xterm-helper-textarea')?.focus();
      });
    }
  }
  async function navigate(event: React.KeyboardEvent) {
    if (!tabs.length || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); setKeyboardTabs(true);
    const focusedId = (event.target as Element).closest('[data-tab-id]')?.getAttribute('data-tab-id');
    const current = Math.max(0, tabs.findIndex(tab => tab.id === (focusedId ?? selected?.id)));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    if (event.altKey && event.key.startsWith('Arrow')) {
      const ids = tabs.map(tab => tab.id); [ids[current],ids[next]] = [ids[next]!,ids[current]!];
      try { await request({ type: 'agency.tabs.order', workspaceId: workspace.id, tabIds: ids }); } catch (reason) { setError(String(reason)); }
    } else {
      void action(tabs[next]!, 'select').catch(() => undefined);
      document.getElementById('tab-' + tabs[next]!.id)?.focus();
    }
  }
  function name(tab: WorkspaceTab) {
    if (tab.kind === 'web') return tab.web.title;
    const session = tab.session;
    return session.tab?.name ?? (session.kind === 'terminal' ? t('agency.tabs.terminalNamed', { number: session.tab?.terminalNumber ?? 1 }) : profiles.find(profile => profile.id === session.profileId)?.label ?? t('agency.ui.agentLabel'));
  }
  function webEditor(mode: 'create' | 'navigate') {
    setMenu(false); setError(null); setWebDialog(mode);
    setWebUrl(selected?.kind === 'web' && mode !== 'create' ? selected.web.url : 'https://chatgpt.com/');
    setWebTitle(selected?.kind === 'web' && mode !== 'create' ? selected.web.title : t('agency.web.defaultTitle'));
  }
  async function saveWeb() {
    if (flight.current || !online || !webDialog) return;
    const url = validateChatGptUrl(webUrl);
    if (!url.valid) { setError(t('agency.web.invalidUrl')); return; }
    if (webDialog !== 'navigate' && !validateWebTabTitle(webTitle)) { setError(t('agency.web.invalidTitle')); return; }
    flight.current = true; setBusy(true); setError(null);
    try {
      if (webDialog === 'create') await request({ type: 'agency.webTab.create', workspaceId: workspace.id, url: url.normalizedUrl!, title: webTitle.trim(), select: true, launchId: crypto.randomUUID() });
      else if (selected?.kind === 'web') await request({ type: 'agency.webTab.navigate', workspaceId: workspace.id, tabId: selected.id, url: url.normalizedUrl! });
      setWebDialog(null);
    } catch (reason) { setError(String(reason)); }
    finally { flight.current = false; setBusy(false); }
  }
  const webHeading = webDialog === 'create' ? t('agency.web.newTab') : t('agency.web.navigate');
  return <section className="agency-workspace-view" aria-label={t('agency.ui.workspaceNamed', { name: workspace.name })}>
    <header className="maw-tabs-header">
      <div className="maw-tabs-strip" ref={strip} role="tablist" aria-label={t('agency.tabs.tabList')} onKeyDown={event => void navigate(event)}
        onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('[data-close], input')) return; drag.current = { id: event.pointerId, x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false }; }}
        onPointerMove={event => { const start = drag.current; if (!start) return; if (Math.abs(event.clientX - start.x) > 6) { start.moved = true; event.currentTarget.setPointerCapture(event.pointerId); } if (start.moved) { event.preventDefault(); event.currentTarget.scrollLeft = start.scroll - (event.clientX - start.x); } }}
        onPointerUp={event => { dragged.current = !!drag.current?.moved; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; setTimeout(() => { dragged.current = false; }, 0); }}
        onPointerCancel={() => { drag.current = null; dragged.current = false; }}
        onClickCapture={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); } }}>
        {tabs.map((tab, index) => {
          const tabState = getTabActivity?.(workspace.id, tab.id);
          const session = tab.kind === 'native' ? tab.session : undefined;
          const status = tabState ? agencyTabActivityText(tabState) : session ? agencySessionText(session) : t('agency.web.tabKind');
          const dotClass = tabState === 'finished' ? 'finished' :
            tabState === 'failed' || session?.lifecycle === 'failed' || session?.recovery?.status === 'manual' || (tab.kind === 'web' && ['error','crashed'].includes(tab.web.runtimeState ?? '')) ? 'failed' :
            session?.lifecycle === 'exited' ? 'muted' :
            session && ['awaiting-user','awaiting-permission'].includes(session.activity) ? 'attention' :
            tabState ?? (session?.activity === 'working' ? 'working' : session?.activity === 'idle' ? 'idle' : 'unknown');
          return <div className={'maw-session-tab' + (selected?.id === tab.id ? ' active' : '')} key={tab.id} data-tab-id={tab.id}>
            {renaming === tab.id ? <TabNameInput name={name(tab)} report={setError}
              onSave={async title => { await request(tab.kind === 'web'
                ? { type: 'agency.webTab.rename', workspaceId: workspace.id, tabId: tab.id, title }
                : { type: 'agency.tab.rename', workspaceId: workspace.id, tabId: tab.id, name: title }); setError(null); }}
              onClose={restore => { setRenaming(null); if (restore) requestAnimationFrame(() => document.getElementById('tab-' + tab.id)?.focus()); }}
            /> : <button type="button" role="tab" id={'tab-' + tab.id} aria-selected={selected?.id === tab.id} aria-controls={'pane-' + tab.id} tabIndex={selected?.id === tab.id || (!selected && index === 0) ? 0 : -1} disabled={!online} title={name(tab) + ' · ' + status} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); setKeyboardTabs(true); setRenaming(tab.id); } }} onClick={() => { setKeyboardTabs(false); void action(tab, 'select').catch(() => undefined); }}>
              <span aria-hidden="true">{tab.kind === 'web' ? '◎' : session?.kind === 'agent' ? '◇' : '>_'}</span><span className="agency-truncate" onDoubleClick={() => { setKeyboardTabs(true); setRenaming(tab.id); }}>{name(tab)}</span><span className={'agency-status-dot ' + dotClass} aria-label={status} />
            </button>}
            <button type="button" data-close aria-label={t('agency.tabs.closeNamed', { name: name(tab) })} disabled={!online || busy} onClick={() => { if (session && ['starting','running','stopping'].includes(session.lifecycle)) setClosing(tab); else void close(tab); }}>×</button>
          </div>;
        })}
      </div>
      <div className="agency-dropdown maw-add-tab" onClick={event => event.stopPropagation()}>
        <button type="button" className="agency-icon-button" aria-label={t('agency.tabs.add')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={!online || busy}>+</button>
        {menu && <div className="agency-dropdown-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setPicker(true); }}>{t('agency.tabs.newCLI')}</button>
          <button type="button" role="menuitem" onClick={() => void add('terminal')}>{t('agency.tabs.newTerminal')}</button>
          <button type="button" role="menuitem" onClick={() => webEditor('create')}>{t('agency.web.newTab')}</button>
          {selected && <button type="button" role="menuitem" onClick={() => { setMenu(false); setKeyboardTabs(true); setRenaming(selected.id); }}>{t('agency.web.rename')}</button>}
        </div>}
      </div>
      <button type="button" className="agency-text-button" onClick={onDone}>{t('agency.ui.markDone')}</button>
    </header>
    {(error || launchError) && <div className="agency-error-bar" role="alert"><span>{error || launchError}</span><button type="button" aria-label={t('agency.ui.dismissError')} onClick={() => { setError(null); onClearLaunchError?.(); }}>×</button></div>}
    <div className="maw-session-content">
      {tabs.filter(tab => tab.kind === 'native').map(tab => tab.kind === 'native' && <SessionPane focusTerminal={!keyboardTabs} key={tab.id} session={tab.session} active={selected?.id === tab.id} connection={connection} online={online} request={request} sendImmediate={sendImmediate} report={setError} onDisplayed={reportDisplayed} />)}
      {selected?.kind === 'web' && <div className="maw-session-pane" role="tabpanel" id={'pane-' + selected.id} aria-labelledby={'tab-' + selected.id}>
        <div className="agency-pane-bar maw-browser-toolbar"><span className="agency-truncate" title={selected.web.url}>{selected.web.url}</span><span className="agency-flex-spacer" />
          <button type="button" className="agency-text-button" disabled={!online || busy} onClick={() => webEditor('navigate')}>{t('agency.web.navigate')}</button>
          <button type="button" className="agency-text-button" disabled={!online || busy} onClick={() => { setKeyboardTabs(true); setRenaming(selected.id); }}>{t('agency.web.rename')}</button>
        </div>
        <AgencyBrowserViewer key={selected.id + ':' + selected.web.targetRef} tab={selected.web} online={online} onDisplayed={reportDisplayed} onReconnect={() => action(selected, 'select')} />
      </div>}
      {!selected && <div className="agency-shell-placeholder"><p>{tabs.length ? t('agency.web.selectTab') : t('agency.tabs.empty')}</p>
        {!tabs.length && <><button type="button" className="agency-secondary-button" disabled={!online} onClick={() => setPicker(true)}>{t('agency.tabs.newCLI')}</button><button type="button" className="agency-secondary-button" disabled={!online || busy} onClick={() => void add('terminal')}>{t('agency.tabs.newTerminal')}</button><button type="button" className="agency-secondary-button" disabled={!online || busy} onClick={() => webEditor('create')}>{t('agency.web.newTab')}</button></>}
      </div>}
    </div>
    {(picker || closing || webDialog) && <div className="agency-modal-backdrop"><div ref={dialog} className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="maw-session-dialog">
      <h2 id="maw-session-dialog">{closing ? t('agency.tabs.confirmClose', { name: name(closing) }) : webDialog ? webHeading : t('agency.tabs.newCLI')}</h2>
      {!closing && !webDialog && isUnconfigured && (
        <div className="agency-callout" role="alert" style={{
          background: 'rgba(234, 179, 8, 0.12)',
          border: '1px solid rgba(234, 179, 8, 0.35)',
          borderRadius: '8px',
          padding: '10px 14px',
          margin: '12px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          fontSize: '12px',
          color: '#fef08a',
        }}>
          <span>⚙ Profile not configured — click Configure to set the executable path</span>
          <button
            type="button"
            className="agency-primary-button"
            style={{ padding: '6px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}
            onClick={() => setConfiguringProfile(selectedProfile ?? null)}
          >
            Configure
          </button>
        </div>
      )}
      {!closing && !webDialog && !isUnconfigured && !canLaunchAgent(selectedProfile) && (
        <p role="status">{selectedProfile?.configurationStatus === 'not-installed'
          ? 'Executable configured but not found on PATH. Check the command name and try again.'
          : selectedProfile?.configurationMessage}
        </p>
      )}
      {closing ? <p>{t('agency.tabs.closeExplanation')}</p> : webDialog ? <form id="maw-web-tab-form" onSubmit={event => { event.preventDefault(); void saveWeb(); }}>
        {webDialog !== 'navigate' && <label className="agency-field"><span>{t('agency.web.title')}</span><input autoFocus value={webTitle} maxLength={120} required onChange={event => setWebTitle(event.target.value)} /></label>}
        {<label className="agency-field"><span>{t('agency.web.url')}</span><input autoFocus={webDialog === 'navigate'} type="url" value={webUrl} maxLength={2048} required onChange={event => setWebUrl(event.target.value)} /></label>}
      </form> : <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', marginBottom: '16px' }}>
        <label className="agency-field" style={{ flex: 1, marginBottom: 0 }}>
          <span>{t('agency.ui.cliProfile')}</span>
          <select autoFocus value={profileId} onChange={event => setProfileId(event.target.value as CliProfileId)}>
            {profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.label}</option>)}
          </select>
        </label>
        {selectedProfile && (
          <button
            type="button"
            className={isUnconfigured ? "agency-primary-button" : "agency-secondary-button"}
            style={{ height: '40px', padding: '0 14px', whiteSpace: 'nowrap', fontWeight: 600 }}
            onClick={() => setConfiguringProfile(selectedProfile)}
          >
            Configure
          </button>
        )}
      </div>}
      {error && <p role="alert" className="agency-error">{error}</p>}
      <div className="agency-dialog-actions"><button type="button" autoFocus={!!closing} disabled={busy} onClick={() => { setPicker(false); setClosing(null); setWebDialog(null); }}>{t('common.cancel')}</button>
        {webDialog ? <button type="submit" form="maw-web-tab-form" className="agency-primary-button" disabled={busy || !online}>{webHeading}</button> : <button type="button" className="agency-primary-button" disabled={busy || !online || (!closing && !canLaunchAgent(selectedProfile))} onClick={() => closing ? void close(closing) : void add('agent')}>{closing ? t('agency.tabs.closeSession') : t('agency.ui.startCLI')}</button>}
      </div>
    </div></div>}
    {configuringProfile && <AgencyProfileDialog
      profile={configuringProfile}
      onClose={() => setConfiguringProfile(null)}
      onSave={async (executablePath, argv) => {
        await request({
          type: 'agency.profile.configure',
          profileId: configuringProfile.id,
          executable: executablePath,
          args: argv,
        });
      }}
    />}
  </section>;
}
