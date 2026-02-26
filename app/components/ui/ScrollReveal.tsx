"use client";

import { type ReactNode, useRef, useEffect } from "react";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface ScrollRevealProps {
  children: ReactNode;
  direction?: "up" | "down" | "left" | "right";
  delay?: number;
  duration?: number;
  distance?: number;
  stagger?: number;
  once?: boolean;
  scale?: number;
  className?: string;
}

function getOffset(direction: string, distance: number) {
  switch (direction) {
    case "up": return { y: distance, x: 0 };
    case "down": return { y: -distance, x: 0 };
    case "left": return { y: 0, x: distance };
    case "right": return { y: 0, x: -distance };
    default: return { y: distance, x: 0 };
  }
}

export function ScrollReveal({
  children,
  direction = "up",
  delay = 0,
  duration = 0.7,
  distance = 20,
  stagger = 0,
  once = true,
  scale,
  className = "",
}: ScrollRevealProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (prefersReduced) {
      el.style.opacity = "1";
      el.style.transform = "none";
      return;
    }

    const offset = getOffset(direction, distance);

    gsap.set(el, {
      opacity: 0,
      x: offset.x,
      y: offset.y,
      scale: scale ?? 1,
    });

    // Safety net: if observer doesn't fire within 2s (e.g. element is
    // already in the viewport but rootMargin clips it), reveal anyway.
    // This prevents invisible "gap" sections at certain viewport sizes.
    const safetyTimer = setTimeout(() => {
      if (!hasAnimated.current) {
        hasAnimated.current = true;
        gsap.to(el, {
          opacity: 1,
          x: 0,
          y: 0,
          scale: 1,
          duration,
          delay: 0,
          ease: "power3.out",
        });
      }
    }, 2000);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !(once && hasAnimated.current)) {
            hasAnimated.current = true;
            clearTimeout(safetyTimer);

            if (stagger > 0) {
              const childEls = el.children;
              if (childEls.length > 1) {
                gsap.set(childEls, {
                  opacity: 0,
                  x: offset.x,
                  y: offset.y,
                  scale: scale ?? 1,
                });
                gsap.set(el, { opacity: 1, x: 0, y: 0, scale: 1 });
                gsap.to(childEls, {
                  opacity: 1,
                  x: 0,
                  y: 0,
                  scale: 1,
                  duration,
                  delay,
                  stagger,
                  ease: "power3.out",
                });
                return;
              }
            }

            gsap.to(el, {
              opacity: 1,
              x: 0,
              y: 0,
              scale: 1,
              duration,
              delay,
              ease: "power3.out",
            });

            if (once) observer.disconnect();
          }
        }
      },
      { threshold: 0.05, rootMargin: "0px 0px -30px 0px" }
    );

    observer.observe(el);
    return () => {
      clearTimeout(safetyTimer);
      observer.disconnect();
    };
  }, [direction, delay, duration, distance, stagger, once, scale, prefersReduced]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={prefersReduced ? undefined : { opacity: 0, willChange: "transform, opacity" }}
    >
      {children}
    </div>
  );
}
