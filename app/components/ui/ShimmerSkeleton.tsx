"use client";

interface ShimmerSkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
}

export function ShimmerSkeleton({ className = "" }: ShimmerSkeletonProps) {
  return (
    <div className={`rounded-[4px] shimmer ${className}`} />
  );
}
