"use client";

import { useEffect, useRef } from "react";

// Single motion owner for route transitions. Next.js remounts `template.tsx`
// on every navigation (unlike layout.tsx, which persists across routes) — that
// remount is what re-triggers the effect below on each route change, no
// pathname-keyed state or navigation listener needed. Don't add a competing
// transition wrapper elsewhere; this is the only place that owns nav motion.
export default function Template({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Respect reduced-motion: render in place, no animation.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Short opacity+translateY settle — signals "new route", not decoration.
    // Web Animations API (not a CSS keyframe injected via <style>) keeps this
    // self-contained to this component with no globals.css dependency.
    el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "ease-out", fill: "backwards" },
    );
  }, []);

  return <div ref={ref}>{children}</div>;
}
