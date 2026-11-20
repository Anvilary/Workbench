interface Props {
  message: string;
  type: 'success' | 'error';
}

export function PaneFeedback({ message, type }: Props): JSX.Element {
  return (
    <div className={`maw-pane-feedback maw-pane-feedback-${type}`} role="status">
      {message}
    </div>
  );
}
