import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorScreen } from './ErrorScreen';

/**
 * Catches a render error anywhere below it (main.tsx puts it around the whole app) and shows the
 * "Something went wrong" screen instead of leaving the dark page empty. The router has its own
 * for a page's errors (`defaultErrorComponent`); this one is for what the router cannot catch:
 * the router, the providers and the app frame themselves.
 */
export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; failed: boolean }
> {
  state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Studio Engine render error', error, info.componentStack);
  }

  render() {
    if (this.state.failed) return <ErrorScreen error={this.state.error} />;
    return this.props.children;
  }
}
