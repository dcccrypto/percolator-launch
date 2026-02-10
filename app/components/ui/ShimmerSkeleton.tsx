"use client";

interface ShimmerSkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
}

export function ShimmerSkeleton({ className = "" }: ShimmerSkeletonProps) {
  return (
    <div className={`relative overflow-hidden rounded-sm bg-[var(--border)] ${className}`}>
      <div
        className="absolute inset-0"
        style={{
          background: "linear-gradient(90deg, transparent 0%, rgba(153,69,255,0.03) 50%, transparent 100%)",
          animation: "shimmer-sweep 1.5s ease-in-out infinite",
        }}
      />
    </div>
  );
}
