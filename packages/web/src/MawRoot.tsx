import { Component, lazy, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { AgencyApp } from './agency/AgencyApp.js';
import { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { useTheme } from './useTheme.js';
import { useTerminalTheme } from './useTerminalTheme.js';
import { useThreadFont } from './useThreadFont.js';

/** `?view=workbench` opens the classic Workbench; everything else is the MAW interface. */
export function isClassicView(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'workbench';
}

/**
 * The MAW interface without the classic Workbench. Keeps what the classic root did for it: document theme,
 * terminal theme and font-size attributes, and the socket lifecycle (connect on mount, close on unmount).
 */
export function MawRoot(): JSX.Element {
  const theme = useTheme();
  useTerminalTheme(theme.resolved);
  useThreadFont();
  const connection = useMemo(() => new AgentConnection(), []);
  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, [connection]);
  return <AgencyApp connection={connection} theme={theme} />;
}

/** The classic Workbench, fetched only when it is actually opened. */
const ClassicApp = lazy(() => import('./App.js').then((module) => ({ default: module.App })));

class ModuleLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" style={{ padding: 24 }}>
      <p>{t('common.moduleLoadFailed')}</p>
      <button type="button" onClick={() => window.location.reload()}>{t('common.reloadPage')}</button>
    </div>;
  }
}

export function ClassicRoot(): JSX.Element {
  return <ModuleLoadBoundary><Suspense fallback={null}><ClassicApp /></Suspense></ModuleLoadBoundary>;
}
