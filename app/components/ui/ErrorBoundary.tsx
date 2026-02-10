"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary for catching rendering crashes.
 * Prevents a single broken component from killing the entire page.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ""}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="rounded-[4px] border border-[#FF4466]/20 bg-[#FF4466]/5 p-6 text-center">
          <p className="text-sm font-medium text-[#FF4466]">
            something broke{this.props.label ? ` in ${this.props.label}` : ""}.
          </p>
          <p className="mt-1 text-xs text-[#71717a]">
            {this.state.error?.message ?? "Unknown error"}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-3 rounded-md bg-white/5 px-3 py-1.5 text-xs text-[#fafafa] hover:bg-white/10 transition-colors"
          >
            try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
