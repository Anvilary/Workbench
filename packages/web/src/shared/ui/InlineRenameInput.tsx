import { useEffect, useRef, useState } from 'react';

export interface InlineRenameInputProps {
  initialValue: string;
  onCommit: (cleanValue: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  maxLength?: number;
  className?: string;
}

export function InlineRenameInput({
  initialValue,
  onCommit,
  onCancel,
  ariaLabel,
  maxLength = 120,
  className = 'agency-inline-rename-input',
}: InlineRenameInputProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canBlurRef = useRef(false);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
    // Defer blur-commit slightly so menu dismissal doesn't immediately blur the newly focused input.
    const timer = setTimeout(() => {
      canBlurRef.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const handleCommit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const clean = value.trim();
    if (clean) {
      onCommit(clean);
    } else {
      onCancel();
    }
  };

  const handleCancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className={className}
      value={value}
      maxLength={maxLength}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          handleCancel();
        }
      }}
      onBlur={() => {
        if (canBlurRef.current) {
          handleCommit();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}
