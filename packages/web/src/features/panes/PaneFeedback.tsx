interface Props {
  message: string;
  type: 'success' | 'error';
}

export function PaneFeedback({ message, type }: Props): JSX.Element {
  return (
    <div className={`wb-pane-feedback wb-pane-feedback-${type}`} role="status">
      {message}
    </div>
  );
}
