import { useEffect, useMemo, useRef } from 'react';
import type { ConversationEvent, ConversationToolResultPart } from '@agent-workbench/shared';
import { Markdown } from '../Markdown.js';

function shortTime(at: number): string {
  return at > 0 ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}

export function AgencyTranscript({ events, onOpenCli }: {
  events: readonly ConversationEvent[];
  onOpenCli: () => void;
}): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'auto' }); }, [events.length]);
  const results = useMemo(() => {
    const map = new Map<string, ConversationToolResultPart>();
    events.forEach((event) => event.parts.forEach((part) => {
      if (part.kind === 'tool-result') map.set(part.toolUseId, part);
    }));
    return map;
  }, [events]);

  const visibleEvents = events.filter((event) => event.parts.some((part) =>
    part.kind === 'text' || part.kind === 'tool-call' || part.kind === 'question' ||
    part.kind === 'notice' || part.kind === 'image',
  ));

  return (
    <div className="agency-transcript" role="log" aria-label="Agent conversation" aria-live="off">
      <div className="agency-transcript-inner">
        {visibleEvents.length === 0 && (
          <div className="agency-thread-empty">
            <div className="agency-thread-symbol">◇</div>
            <h2>Ready when you are.</h2>
            <p>Start a native CLI profile and use the composer. The terminal remains available for approvals and interactive prompts.</p>
          </div>
        )}
        {visibleEvents.map((event) => (
          <article key={event.eventId} className={'agency-turn agency-turn-' + event.role}>
            <div className="agency-turn-meta">{event.role === 'user' ? 'You' :
              event.role === 'assistant' ? 'Assistant' : 'CLI'} <time>{shortTime(event.at)}</time></div>
            {event.parts.map((part, index) => {
              if (part.kind === 'tool-result' || part.kind === 'thinking') return null;
              if (part.kind === 'text') {
                return <div key={index} className="agency-turn-text">
                  {event.role === 'user' ? <span className="agency-user-text">{part.text}</span> : <Markdown text={part.text} />}
                </div>;
              }
              if (part.kind === 'tool-call') {
                const result = results.get(part.toolUseId);
                return <details key={index} className="agency-command-output">
                  <summary><span aria-hidden="true">⌘</span> {part.name}
                    <span className="agency-command-summary">{result ? result.isError ? 'Error' : 'Output' : 'Running / unknown'}</span>
                  </summary>
                  <pre>{part.input}</pre>
                  {result && <pre className={result.isError ? 'agency-command-error' : ''}>{result.text}
                    {result.truncated ? '\n[Output truncated]' : ''}</pre>}
                </details>;
              }
              if (part.kind === 'question') return <div key={index} className="agency-question">
                <strong>Action needed in the native CLI</strong>
                {part.questions.map((question, i) => <p key={i}>{question.question}</p>)}
                <button type="button" className="agency-text-button" onClick={onOpenCli}>Open interactive CLI</button>
              </div>;
              if (part.kind === 'image') return <p key={index} className="agency-muted">Image attachment (view in native CLI)</p>;
              if (part.kind === 'notice') return <p key={index} className="agency-muted">CLI notice (open terminal for details)</p>;
              return null;
            })}
          </article>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
