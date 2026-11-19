import { useId, useState, type ReactNode } from 'react';
import { ChevronIcon } from './SettingsIcons.js';

export interface CollapsibleSubsectionProps {
  id?: string;
  title: string;
  description?: string;
  highlighted?: boolean;
  defaultExpanded?: boolean;
  forceExpanded?: boolean;
  expandSignal?: number;
  headerActions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * Accessible collapsible card subsection for Settings categories.
 * Supports keyboard Enter/Space via native button semantics, smooth height/opacity transitions,
 * and automatic expansion when targeted by Settings search.
 */
export function CollapsibleSubsection({
  id,
  title,
  description,
  highlighted = false,
  defaultExpanded = true,
  forceExpanded = false,
  expandSignal,
  headerActions,
  className,
  bodyClassName,
  children,
}: CollapsibleSubsectionProps): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded || forceExpanded);
  const [prevForce, setPrevForce] = useState<boolean>(forceExpanded);
  const [prevSignal, setPrevSignal] = useState<number | undefined>(expandSignal);
  const buttonId = useId();
  const bodyId = useId();

  if (forceExpanded !== prevForce || expandSignal !== prevSignal) {
    setPrevForce(forceExpanded);
    setPrevSignal(expandSignal);
    if (forceExpanded && !expanded) {
      setExpanded(true);
    }
  }

  return (
    <div
      id={id}
      className={`maw-settings-card maw-collapsible-subsection${highlighted ? ' maw-settings-card-highlighted' : ''}${expanded ? ' is-expanded' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
    >
      <div className="maw-settings-card-header maw-settings-card-header-flex maw-subsection-header">
        <button
          type="button"
          id={buttonId}
          className="maw-subsection-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="maw-subsection-chevron" aria-hidden="true">
            <ChevronIcon size={14} />
          </span>
          <span className="maw-subsection-heading">
            <span className="maw-settings-card-title">{title}</span>
            {description && <span className="maw-settings-hint maw-subsection-desc">{description}</span>}
          </span>
        </button>
        {headerActions && (
          <div className="maw-settings-card-header-actions maw-subsection-actions">
            {headerActions}
          </div>
        )}
      </div>

      <div
        id={bodyId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!expanded}
        className={`maw-subsection-collapse${expanded ? ' is-expanded' : ' is-collapsed'}`}
      >
        <div className="maw-subsection-collapse-inner">
          <div className={`maw-settings-card-body maw-subsection-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
