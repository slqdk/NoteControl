import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render-time exceptions in its subtree so one broken
 * component doesn't blank the whole app.
 *
 * Before this existed there was no boundary anywhere: an exception
 * thrown while rendering (the ST sandbox evaluating a bad
 * declaration initializer was the reported case) unmounted the
 * entire React tree and left a white page. Pending note edits are
 * still flushed by the editor's unmount handler either way; this just
 * keeps the UI usable and says what happened.
 *
 * Two uses:
 *   - `variant="app"` at the root: a full-page message with Reload.
 *   - `variant="inline"` around a self-contained widget (the ST
 *     sandbox modal): a small panel with a Close button, the rest of
 *     the page keeps working.
 */
interface Props {
  children: ReactNode;
  variant?: 'app' | 'inline';
  /** For the inline variant: dismiss the failed widget. */
  onClose?: () => void;
  /** Shown in the heading, e.g. "The ST sandbox". */
  what?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const what = this.props.what ?? 'This part of NoteControl';
    if (this.props.variant === 'inline') {
      return (
        <div className="nc-error-boundary nc-error-boundary-inline" role="alert">
          <strong>{what} ran into a problem and was closed.</strong>
          <div className="nc-error-boundary-detail">{error.message}</div>
          {this.props.onClose && (
            <button type="button" onClick={() => { this.setState({ error: null }); this.props.onClose?.(); }}>
              Close
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="nc-error-boundary nc-error-boundary-app" role="alert">
        <h1>Something went wrong</h1>
        <p>
          {what} hit an unexpected error. Reloading the page usually fixes this.
        </p>
        <pre className="nc-error-boundary-detail">{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
