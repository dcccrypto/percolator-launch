"use client";

import { FC, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  className?: string;
}

export const Tooltip: FC<TooltipProps> = ({ text, children, className = "" }) => {
  const [show, setShow] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (show && triggerRef.current && tooltipRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const pos = rect.top < 80 ? "bottom" : "top";
      const el = tooltipRef.current;
      const left = Math.max(8, Math.min(window.innerWidth - 264, rect.left + rect.width / 2 - 128));
      if (pos === "top") {
        el.style.top = `${rect.top - 8}px`;
        el.style.left = `${left}px`;
        el.style.transform = "translateY(-100%)";
      } else {
        el.style.top = `${rect.bottom + 8}px`;
        el.style.left = `${left}px`;
        el.style.transform = "translateY(0)";
      }
    }
  }, [show]);

  useEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;

    if (show) {
      if (prefersReduced) {
        el.style.opacity = "1";
        el.style.visibility = "visible";
      } else {
        gsap.fromTo(
          el,
          { opacity: 0, scale: 0.95, visibility: "visible" },
          { opacity: 1, scale: 1, duration: 0.15, ease: "power2.out" }
        );
      }
    } else {
      if (prefersReduced) {
        el.style.visibility = "hidden";
        el.style.opacity = "0";
      } else {
        gsap.to(el, {
          opacity: 0,
          scale: 0.95,
          duration: 0.1,
          ease: "power2.in",
          onComplete: () => { el.style.visibility = "hidden"; },
        });
      }
    }
  }, [show, prefersReduced]);

  const tooltipEl = (
    <span
      ref={tooltipRef}
      className="fixed z-[9999] w-64 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)] shadow-xl pointer-events-none"
      style={{ visibility: "hidden", opacity: 0 }}
    >
      {text}
    </span>
  );

  return (
    <>
      <span
        ref={triggerRef}
        className={`relative inline-flex cursor-help ${className}`}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {mounted && createPortal(tooltipEl, document.body)}
    </>
  );
};

export const InfoIcon: FC<{ tooltip: string }> = ({ tooltip }) => (
  <Tooltip text={tooltip}>
    <svg className="ml-1 inline h-3.5 w-3.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
    </svg>
  </Tooltip>
);
