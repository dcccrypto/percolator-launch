export function InfoBanner({ children, variant = "info" }: { children: React.ReactNode; variant?: "info" | "warning" }) {
  const colors = variant === "warning"
    ? "border-l-[var(--warning)] bg-[var(--warning)]/5 text-[var(--warning)]"
    : "border-l-[var(--accent)] bg-[var(--accent)]/5 text-[var(--text-secondary)]";
  return (
    <div className={`border-l-2 px-3 py-2 text-[11px] leading-relaxed ${colors}`}>
      {children}
    </div>
  );
}
