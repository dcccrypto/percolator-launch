"use client";

import { FC, useState, useRef, useEffect } from "react";

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  className?: string;
}

export const Tooltip: FC<TooltipProps> = ({ text, children, className = "" }) => {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState<"top" | "bottom">("top");
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (show && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition(rect.top < 80 ? "bottom" : "top");
    }
  }, [show]);

  return (
    <span
      ref={triggerRef}
      className={`relative inline-flex cursor-help ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          className={`absolute z-50 w-64 rounded-lg border border-white/10 bg-[#12141f] px-3 py-2 text-xs leading-relaxed text-[#c4cbde] shadow-xl ${
            position === "top"
              ? "bottom-full left-1/2 mb-2 -translate-x-1/2"
              : "top-full left-1/2 mt-2 -translate-x-1/2"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
};

export const InfoIcon: FC<{ tooltip: string }> = ({ tooltip }) => (
  <Tooltip text={tooltip}>
    <svg className="ml-1 inline h-3.5 w-3.5 text-[#3D4563] hover:text-[#8B95B0] transition-colors" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
    </svg>
  </Tooltip>
);
