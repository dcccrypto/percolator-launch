'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { GlowButton } from '@/components/ui/GlowButton';

export default function VaultDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[earn/[slab]] vault error boundary:', error);
  }, [error]);

  return (
    <div role="alert" className="min-h-[calc(100dvh-48px)] flex items-center justify-center">
      <div className="max-w-md mx-auto text-center px-4">
        <div aria-hidden="true" className="text-4xl mb-4">⚠️</div>
        <h1
          className="text-lg font-medium text-[var(--text)] mb-2"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Vault Error
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-6">
          Something went wrong loading this vault. Please try again.
        </p>
        <div className="flex items-center justify-center gap-3">
          <GlowButton onClick={reset} variant="primary" size="md">
            Try Again
          </GlowButton>
          <Link href="/earn">
            <GlowButton variant="secondary" size="md">
              Back to Earn
            </GlowButton>
          </Link>
        </div>
      </div>
    </div>
  );
}
