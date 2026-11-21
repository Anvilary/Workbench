/**
 * The bridge the desktop shell exposes to the page as `window.mawChatGpt` (see
 * `packages/desktop/preload.cjs`). The global keeps its historical name.
 */

export interface DesktopBridgeEvent {
  type: string;
  id?: string;
  sourceTabId?: string;
  url?: string;
  token?: string;
  port?: string;
  message?: string;
  direction?: number;
  filename?: string;
  percent?: number | null;
  linkURL?: string;
  pageURL?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  selection?: boolean;
  selectionText?: string;
  isEditable?: boolean;
  misspelledWord?: string;
  dictionarySuggestions?: string[];
  matches?: number;
  activeMatchOrdinal?: number;
  requestId?: number;
  x?: number;
  y?: number;
  zoomFactor?: number;
  percentage?: number;
}

export interface DesktopBridge {
  command: (command: unknown) => Promise<unknown>;
  subscribe: (callback: (state: DesktopBridgeEvent) => void) => () => void;
}

declare global {
  interface Window {
    mawChatGpt?: DesktopBridge;
  }
}
