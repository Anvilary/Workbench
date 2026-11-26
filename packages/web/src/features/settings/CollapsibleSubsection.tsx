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
      className={`wb-settings-card wb-collapsible-subsection${highlighted ? ' wb-settings-card-highlighted' : ''}${expanded ? ' is-expanded' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
    >
      <div className="wb-settings-card-header wb-settings-card-header-flex wb-subsection-header">
        <button
          type="button"
          id={buttonId}
          className="wb-subsection-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="wb-subsection-chevron" aria-hidden="true">
            <ChevronIcon size={14} />
          </span>
          <span className="wb-subsection-heading">
            <span className="wb-settings-card-title">{title}</span>
            {description && <span className="wb-settings-hint wb-subsection-desc">{description}</span>}
          </span>
        </button>
        {headerActions && (
          <div className="wb-settings-card-header-actions wb-subsection-actions">
            {headerActions}
          </div>
        )}
      </div>

      <div
        id={bodyId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!expanded}
        className={`wb-subsection-collapse${expanded ? ' is-expanded' : ' is-collapsed'}`}
      >
        <div className="wb-subsection-collapse-inner">
          <div className={`wb-settings-card-body wb-subsection-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
