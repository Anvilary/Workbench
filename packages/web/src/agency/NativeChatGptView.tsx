import { useEffect, useRef, useState } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';
import { nativeLayoutCoordinator } from './native-layout-coordinator.js';

export interface DesktopBridge {
  command: (command: unknown) => Promise<unknown>;
  subscribe: (callback: (state: { type: string; id?: string; url?: string; message?: string; direction?: number; filename?: string; percent?: number | null }) => void) => () => void;
}

declare global {
  interface Window {
    mawChatGpt?: DesktopBridge;
  }
}

export function nativeChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

export function NativeChatGptView({
  tab,
  onDisplayed,
  onFocused,
}: {
  tab: WebTab;
  onDisplayed: (id: string, ready: boolean) => void;
  onFocused?: () => void;
}): JSX.Element {
  const { id } = tab;
  const supported = nativeChatGptUrl(tab.url);
  const callback = useRef(onDisplayed);
  callback.current = onDisplayed;
  const focusCallback = useRef(onFocused);
  focusCallback.current = onFocused;
  const url = useRef(tab.url);
  url.current = tab.url;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [captureBackdrop, setCaptureBackdrop] = useState<string | null>(null);
  const [downloadFeedback, setDownloadFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !supported || !host.current) return;

    void bridge.command({ type: 'open', id, url: url.current }).catch((err) => {
      setError(String(err));
    });

    const unregister = nativeLayoutCoordinator.register({
      id,
      element: host.current,
      onDisplayed: (ready) => callback.current(id, ready),
      onFocused: () => focusCallback.current?.(),
      setCaptureBackdrop,
      onError: (msg) => setError(msg),
      onDownloadEvent: (evt) => {
        if (evt.type === 'download-complete') {
          const name = evt.filename || '';
          setDownloadFeedback({
            message: name ? `${t('agency.ui.fileDownloaded')}: ${name}` : t('agency.ui.fileDownloaded'),
            type: 'success',
          });
          setTimeout(() => setDownloadFeedback(null), 2000);
        } else if (evt.type === 'download-failed') {
          setDownloadFeedback({
            message: t('agency.ui.downloadFailed'),
            type: 'error',
          });
          setTimeout(() => setDownloadFeedback(null), 2000);
        }
      },
    });

    return () => {
      unregister();
    };
  }, [id, supported]);

  return (
    <div ref={host} className="maw-browser-viewer" data-native-id={id}>
      {!window.mawChatGpt || !supported ? (
        <div className="agency-shell-placeholder">
          <p>{t('agency.web.externalHint')}</p>
          <a href={tab.url} target="_blank" rel="noopener noreferrer">{t('agency.web.externalOpen')}</a>
        </div>
      ) : error ? (
        <div className="agency-shell-placeholder" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void window.mawChatGpt?.command({ type: 'close', id }).then(() => setError(''))}>
            {t('common.reloadPage')}
          </button>
        </div>
      ) : (
        <>
          {captureBackdrop && <img className="maw-capture-backdrop" src={captureBackdrop} alt="" />}
          {downloadFeedback && (
            <div className={`maw-pane-feedback maw-pane-feedback-${downloadFeedback.type}`} role="status">
              {downloadFeedback.message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
