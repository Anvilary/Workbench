import { useEffect, type MutableRefObject } from 'react';
import { findPaneNode, type WorkspacePaneLayout } from '@anvilary/workbench-shared';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';

export interface UseBrowserZoomShortcutsOptions {
  layoutRef: MutableRefObject<WorkspacePaneLayout>;
  tabs: readonly WorkspaceTab[];
  enabled?: boolean;
}

/**
 * Listens for Ctrl/Cmd + +/-/0 zoom shortcuts when focus is not inside a
 * terminal, code editor, or text input, forwarding the command to the active web tab.
 */
export function useBrowserZoomShortcuts({
  layoutRef,
  tabs,
  enabled = true,
}: UseBrowserZoomShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const onZoomKeyDown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
      const key = event.key;
      const code = event.code;
      let action: 'zoom-in' | 'zoom-out' | 'zoom-reset' | null = null;
      if (key === '+' || key === '=' || key === 'Add' || code === 'NumpadAdd' || code === 'Equal') {
        action = 'zoom-in';
      } else if (key === '-' || key === '_' || key === 'Subtract' || code === 'NumpadSubtract' || code === 'Minus') {
        action = 'zoom-out';
      } else if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        action = 'zoom-reset';
      }
      if (!action) return;

      const active = document.activeElement;
      if (active) {
        if (
          active.closest('.xterm, .xterm-helper-textarea, .monaco-editor, .cm-editor') ||
          active.tagName === 'TEXTAREA' ||
          (active.tagName === 'INPUT' &&
            !['button', 'submit', 'reset', 'checkbox', 'radio'].includes((active as HTMLInputElement).type)) ||
          (active as HTMLElement).isContentEditable
        ) {
          return;
        }
      }

      const curLayout = layoutRef.current;
      const focusedPane = findPaneNode(curLayout.tree, curLayout.focusedPaneId);
      const activeTabId = focusedPane?.selectedTabId;
      if (!activeTabId) return;
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (activeTab?.kind !== 'web') return;

      event.preventDefault();
      void window.workbench?.command({ type: 'browser-action', id: activeTabId, action });
    };

    window.addEventListener('keydown', onZoomKeyDown);
    return () => window.removeEventListener('keydown', onZoomKeyDown);
  }, [layoutRef, tabs, enabled]);
}
