"use client";

import dynamic from "next/dynamic";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

const DevnetMintContent = dynamic(() => import("./devnet-mint-content"), {
  ssr: false,
  loading: () => (
    <div className="min-h-[calc(100dvh-48px)] relative bg-[var(--bg)]">
      <div className="absolute inset-x-0 top-0 h-16 bg-grid pointer-events-none opacity-50" />
      <div className="relative mx-auto max-w-4xl px-4 pt-4 pb-10">
        <div className="mb-8 animate-fade-in">
          <ShimmerSkeleton className="mb-2 h-3.5 w-16" />
          <ShimmerSkeleton className="h-7 w-56" />
          <ShimmerSkeleton className="mt-2 h-4 w-96 max-w-full" />
          <ShimmerSkeleton className="mt-2 h-3.5 w-48" />
        </div>
        <div className="max-w-xl mx-auto space-y-6 animate-fade-in">
          {/* Card 1 */}
          <div className="bg-[var(--panel-bg)] border border-[var(--border)] p-4 sm:p-6 space-y-4 rounded-sm">
            <ShimmerSkeleton className="h-3 w-48" />
            <ShimmerSkeleton className="h-3.5 w-full" />
            <div className="space-y-1">
              <ShimmerSkeleton className="h-3 w-28" />
              <ShimmerSkeleton className="h-10 w-full" />
            </div>
            <ShimmerSkeleton className="h-10 w-32" />
          </div>
          {/* Card 2 */}
          <div className="bg-[var(--panel-bg)] border border-[var(--border)] p-4 sm:p-6 space-y-4 rounded-sm">
            <ShimmerSkeleton className="h-3 w-48" />
            <ShimmerSkeleton className="h-3.5 w-full" />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <ShimmerSkeleton className="h-3 w-16" />
                <ShimmerSkeleton className="h-10 w-full" />
              </div>
              <div className="space-y-1">
                <ShimmerSkeleton className="h-3 w-16" />
                <ShimmerSkeleton className="h-10 w-full" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <ShimmerSkeleton className="h-3 w-16" />
                <ShimmerSkeleton className="h-10 w-full" />
              </div>
              <div className="space-y-1">
                <ShimmerSkeleton className="h-3 w-16" />
                <ShimmerSkeleton className="h-10 w-full" />
              </div>
            </div>
            <div className="space-y-1">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-24 w-full" />
            </div>
            <ShimmerSkeleton className="h-10 w-36" />
          </div>
        </div>
      </div>
    </div>
  ),
});

export default function DevnetMintPage() {
  return <DevnetMintContent />;
}
