"use client";

import { useEffect, useRef } from "react";

export function CursorGlow() {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = glowRef.current;
    if (!el) return;

    // Check for reduced motion
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Skip on mobile
    if (window.innerWidth < 768) return;

    let raf: number;
    let mouseX = -500;
    let mouseY = -500;
    let currentX = -500;
    let currentY = -500;

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      el.classList.add("active");
    };

    const onLeave = () => {
      el.classList.remove("active");
    };

    const animate = () => {
      // Smooth lerp for that robotic lag feel
      currentX += (mouseX - currentX) * 0.08;
      currentY += (mouseY - currentY) * 0.08;
      el.style.left = `${currentX}px`;
      el.style.top = `${currentY}px`;
      raf = requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={glowRef} className="cursor-glow" />;
}
