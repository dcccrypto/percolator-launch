"use client";

interface ShimmerSkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
}

export function ShimmerSkeleton({ className = "", rounded = "lg" }: ShimmerSkeletonProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-${rounded} bg-white/[0.03] ${className}`}
    >
      <div className="absolute inset-0 shimmer" />
    </div>
  );
}
