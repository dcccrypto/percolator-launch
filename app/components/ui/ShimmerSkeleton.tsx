interface ShimmerSkeletonProps {
  className?: string;
  rounded?: "none" | "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  style?: React.CSSProperties;
}

const roundedMap = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
};

export function ShimmerSkeleton({
  className = "",
  rounded,
  style,
}: ShimmerSkeletonProps) {
  // ponytail: simplified class resolver; cut speculative children, duration, and animation props.
  const roundedClass = rounded
    ? roundedMap[rounded]
    : className.includes("rounded")
    ? ""
    : "rounded-sm";

  const bgClass = className.includes("bg-") ? "" : "bg-[var(--border)]";

  return (
    <div
      className={`relative overflow-hidden ${roundedClass} ${bgClass} ${className}`}
      style={style}
    >
      <div
        className="absolute inset-0 pointer-events-none animate-shimmer-sweep"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 50%, transparent 100%)",
        }}
      />
    </div>
  );
}
