import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable } from '@dnd-kit/react';
import { Accessibility, PointerActivationConstraints } from '@dnd-kit/dom';
import type { WorkspaceId } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { PaneMenu, dismissPaneMenus } from './PaneMenu.js';

const sensors = [PointerSensor.configure({ activationConstraints: [new PointerActivationConstraints.Distance({ value: 6 })] })];

export function PaneGrip({ paneId, workspaceId, disabled, destinations, onSwap }: {
  paneId: string; workspaceId: WorkspaceId; disabled: boolean;
  destinations: { id: string; title: string }[]; onSwap: (source: string, target: string) => void;
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const drag = useDraggable({ id: `pane:${workspaceId}:${paneId}`, type: 'pane', data: { workspaceId, paneId }, disabled });
  const setRef = useCallback((element: HTMLButtonElement | null) => { anchor.current = element; drag.ref(element); }, [drag.ref]);
  return <>
    <button type="button" className={`maw-pane-grip maw-pane-action-button${drag.isDragging ? ' is-dragging' : ''}`}
      ref={setRef}
      title={t('agency.splits.movePane')} aria-label={t('agency.splits.movePane')}
      aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => { if (!drag.isDragging) setOpen(value => !value); }}>
      <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">
        {[4, 8, 12].flatMap(y => [4, 8].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />))}
      </svg>
    </button>
    {open && <PaneMenu anchor={anchor} label={t('agency.splits.movePane')} onClose={() => setOpen(false)}>
      {destinations.map(target => <button key={target.id} type="button" role="menuitem"
        onClick={() => { setOpen(false); onSwap(paneId, target.id); }}>{target.title}</button>)}
    </PaneMenu>}
  </>;
}

export function PaneMovement({ workspaceId, onSwap, children }: {
  workspaceId: WorkspaceId; onSwap: (source: string, target: string) => void; children: ReactNode;
}): JSX.Element {
  const [active, setActive] = useState(false);
  const dropTimer = useRef<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const track = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerup', track, true);
    return () => { window.removeEventListener('pointermove', track, true); window.removeEventListener('pointerup', track, true); };
  }, []);
  const instructions = t('agency.splits.moveHint');
  const accessibility = useMemo(() => Accessibility.configure({ screenReaderInstructions: { draggable: instructions }, announcements: {
    dragstart: () => instructions, dragend: () => t('agency.splits.movePane'),
  } }), [instructions]);
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)'));
  useEffect(() => () => {
    if (dropTimer.current !== null) clearTimeout(dropTimer.current);
    document.body.classList.remove('maw-pane-dragging');
  }, []);
  const restore = () => { setActive(false); document.body.classList.remove('maw-pane-dragging'); };
  return <DragDropProvider sensors={sensors} plugins={defaults => [...defaults, accessibility]}
    onDragStart={() => { dismissPaneMenus(); setActive(true); document.body.classList.add('maw-pane-dragging'); }}
    onDragEnd={(event) => {
      const { source, target } = event.operation;
      if (event.canceled || source?.type !== 'pane' || target?.type !== 'pane' ||
          source.data.workspaceId !== workspaceId || target.data.workspaceId !== workspaceId) { restore(); return; }
      // Sensors batch movement into animation frames. Validate the actual release point,
      // so an immediate release outside cannot commit the preceding hover target.
      const bounds = target.element?.getBoundingClientRect(), point = pointer.current;
      if (!bounds || !point || point.x < bounds.left || point.x >= bounds.right || point.y < bounds.top || point.y >= bounds.bottom || source.data.paneId === target.data.paneId) { restore(); return; }
      onSwap(String(source.data.paneId), String(target.data.paneId));
      // Keep the lightweight overlay above native surfaces through its drop animation.
      if (reduced.current.matches) restore();
      else dropTimer.current = window.setTimeout(() => { dropTimer.current = null; restore(); }, 180);
    }}>
    {children}
    {active && <div className="maw-pane-drag-shield" aria-hidden="true" />}
    <DragOverlay className="maw-pane-drag-overlay" dropAnimation={reduced.current.matches ? null : { duration: 180, easing: 'ease-out' }}>
      {source => {
        const pane = document.getElementById(`pane-container-${source.data.paneId}`);
        const titles = [...(pane?.querySelectorAll('[role="tab"]') ?? [])].map(tab => tab.textContent?.trim());
        return <div className="maw-pane-drag-preview"><strong>{t('agency.splits.movePane')}</strong><span>{titles.join(' · ') || t('agency.tabs.empty')}</span></div>;
      }}
    </DragOverlay>
  </DragDropProvider>;
}
