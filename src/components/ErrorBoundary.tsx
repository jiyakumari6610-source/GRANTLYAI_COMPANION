import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const raw = error instanceof Error ? error.message : '';
    const lower = raw.toLowerCase();
    let message = 'An unexpected rendering error occurred. Please reload the page.';
    if (lower.includes('offline') || lower.includes('network')) {
      message = 'Unable to reach the service right now. Please check your internet connection and reload.';
    } else if (lower.includes('permission') || lower.includes('unauthorized') || lower.includes('forbidden')) {
      message = 'Your session may have expired or lacks permission for this view. Try signing in again.';
    } else if (lower.includes('quota')) {
      message = 'Service request quota reached temporarily. Please wait a moment and try again.';
    } else if (raw && !raw.trim().startsWith('{') && !raw.includes('authInfo') && raw.length < 160) {
      message = raw;
    }
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('Application ErrorBoundary caught an error:', error, info.componentStack);
  }

  handleReload = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    window.location.reload();
  };

  handleGoHome = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    window.location.assign('/');
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#050914] text-slate-100 ambient-mesh grid-pattern-subtle flex items-center justify-center p-6">
          <div
            role="alert"
            className="max-w-md w-full surface-elevated rounded-2xl p-8 text-center space-y-4"
          >
            <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-400/30 text-amber-300 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-white font-display">
              Something went wrong
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              This view encountered an unexpected error. Your saved profile, documents, and tracked applications remain safely stored.
            </p>
            {this.state.errorMessage && (
              <p className="text-xs font-mono text-rose-300/90 bg-slate-900/80 border border-slate-800 rounded-xl p-3 break-words">
                {this.state.errorMessage}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white btn-primary-gradient rounded-xl"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reload Page</span>
              </button>
              <button
                type="button"
                onClick={this.handleGoHome}
                className="px-4 py-2.5 text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 rounded-xl hover:bg-slate-700"
              >
                Return Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
