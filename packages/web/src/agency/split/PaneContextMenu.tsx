import { useEffect, useRef } from 'react';
import { t } from '../../i18n/index.js';

interface Props {
  x: number;
  y: number;
  hasSelection: boolean;
  isLive: boolean;
  fileCandidate?: { relative: string; absolute: string } | null;
  canCopyNativeFile?: boolean;
  onCopySelection: () => void;
  onSelectAll?: () => void;
  onCopyAll: () => void;
  onCopyLast: () => void;
  onPaste: () => void;
  onInterrupt: () => void;
  onClear: () => void;
  onOpenFile?: () => void;
  onCopyFile?: () => void;
  onCopyAbsolutePath?: () => void;
  onCopyRelativePath?: () => void;
  onCopyFileContents?: () => void;
  onClose: () => void;
}

export function PaneContextMenu({
  x,
  y,
  hasSelection,
  isLive,
  fileCandidate,
  canCopyNativeFile,
  onCopySelection,
  onSelectAll,
  onCopyAll,
  onCopyLast,
  onPaste,
  onInterrupt,
  onClear,
  onOpenFile,
  onCopyFile,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onCopyFileContents,
  onClose,
}: Props): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('pointerdown', handlePointerDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  // Clamp menu coordinates inside the viewport
  const menuWidth = 190;
  const menuHeight = fileCandidate ? 360 : 220;
  const clampedX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
  const clampedY = Math.max(10, Math.min(y, window.innerHeight - menuHeight - 10));

  return (
    <div
      ref={menuRef}
      className="maw-context-menu"
      role="menu"
      aria-label={t('agency.ui.copy')}
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!hasSelection}
        onClick={() => {
          onCopySelection();
          onClose();
        }}
      >
        {t('agency.ui.copySelection')}
      </button>
      {onSelectAll && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onSelectAll();
            onClose();
          }}
        >
          {t('agency.ui.selectAll')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopyAll();
          onClose();
        }}
      >
        {t('agency.ui.copyAll')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopyLast();
          onClose();
        }}
      >
        {t('agency.ui.copyLastOutput')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onPaste();
          onClose();
        }}
      >
        {t('agency.ui.paste')}
      </button>
      <div className="maw-context-menu-divider" role="separator" />
      {isLive && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onInterrupt();
            onClose();
          }}
        >
          {t('agency.ui.interrupt')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClear();
          onClose();
        }}
      >
        {t('agency.ui.clearTerminal')}
      </button>
      {fileCandidate && (
        <>
          <div className="maw-context-menu-divider" role="separator" />
          {onOpenFile && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenFile();
                onClose();
              }}
            >
              {t('agency.terminal.openFile')}
            </button>
          )}
          {onCopyFile && (
            <button
              type="button"
              role="menuitem"
              disabled={!canCopyNativeFile}
              title={!canCopyNativeFile ? t('agency.terminal.copyFileUnavailable') : undefined}
              onClick={() => {
                onCopyFile();
                onClose();
              }}
            >
              {t('agency.terminal.copyFile')}
            </button>
          )}
          {onCopyAbsolutePath && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCopyAbsolutePath();
                onClose();
              }}
            >
              {t('agency.terminal.copyAbsolutePath')}
            </button>
          )}
          {onCopyRelativePath && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCopyRelativePath();
                onClose();
              }}
            >
              {t('agency.terminal.copyRelativePath')}
            </button>
          )}
          {onCopyFileContents && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCopyFileContents();
                onClose();
              }}
            >
              {t('agency.terminal.copyFileContents')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
