import type { CSSProperties, ReactNode } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  /** Seconds before the fade-up starts. */
  delay?: number;
  /**
   * Seconds between children. Only applies when the wrapper has more than one child element (as before); every current
   * caller wraps a single element, which then plays the wrapper's own fade-up.
   */
  stagger?: number;
  className?: string;
}

/**
 * The page-section fade-up (20px, 0.7s, ease-out) as CSS: the `.reveal-up` animation globals.css already gives the
 * home hero. It starts at first paint from the server HTML.
 *
 * It used to be a gsap tween run from an effect: the server HTML carried `opacity: 0`, so whatever it wrapped (the
 * /portfolio and /markets headers, page copy) stayed invisible until every client chunk had downloaded, hydrated and
 * the tween had run — those headers were the pages' LCP elements, painted seconds after first paint — and gsap
 * (~27 KB gzip) sat in the first-load JS of every page. Despite the name it was already time-based: a 600 ms safety
 * timer revealed every instance shortly after mount whether or not it had been scrolled to.
 *
 * Kept as before: the same distance, duration and delays (the easing is .reveal-up's easeOutCubic curve, a touch
 * softer than gsap's power3.out); nothing animates under prefers-reduced-motion;
 * `will-change: transform, opacity` stays on the wrapper (it creates the same stacking context and containing block
 * the gsap transform did, so positioned descendants lay out exactly as before).
 */
export function ScrollReveal({ children, delay = 0, stagger = 0, className = "" }: ScrollRevealProps) {
  const style = { willChange: "transform, opacity", "--reveal-delay": `${delay}s`, "--reveal-stagger": `${stagger}s` } as CSSProperties;
  return (
    <div className={`scroll-reveal${stagger > 0 ? " scroll-reveal-stagger" : ""} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}
