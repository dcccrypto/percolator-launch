"use client";

import { FC } from "react";

type IconType = "perps" | "onchain" | "deploy";

interface OnboardingIconProps {
  type: IconType;
  size?: number;
  className?: string;
}

/**
 * Brand SVG icons for onboarding/landing sections.
 * Replaces generic emoji with Percolator-themed illustrations.
 *
 * Colors:
 *   cyan  = #22d3ee (var(--cyan))
 *   accent = #7c3aed (var(--accent))
 *
 * Adapted from designer spec (mobile-oi-bar-and-onboarding-icons-spec.md)
 * for Next.js/web SVG rendering.
 */
export const OnboardingIcon: FC<OnboardingIconProps> = ({ type, size = 64, className }) => {
  if (type === "perps") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Permissionless Perps icon"
        role="img"
      >
        {/* Circular arc (perpetual loop) */}
        <circle
          cx="32" cy="32" r="24"
          stroke="#22d3ee" strokeWidth="1.5"
          strokeDasharray="40 30" strokeLinecap="round"
          opacity="0.4"
        />
        {/* Glow halo */}
        <circle cx="32" cy="32" r="18" fill="#22d3ee" opacity="0.06" />
        {/* Lightning bolt body */}
        <path
          d="M36 8 L22 34 H31 L28 56 L46 28 H36 L40 8 Z"
          fill="#22d3ee" opacity="0.9"
        />
        {/* Lightning bolt inner highlight */}
        <path
          d="M36 14 L27 32 H33 L30 46 L41 30 H35 L38 14 Z"
          fill="#7c3aed" opacity="0.6"
        />
      </svg>
    );
  }

  if (type === "onchain") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Fully On-Chain icon"
        role="img"
      >
        {/* Outer glow */}
        <ellipse cx="32" cy="32" rx="22" ry="16" fill="#7c3aed" opacity="0.05" />
        {/* Left hexagon block */}
        <path
          d="M12 32 L20 18 L36 18 L44 32 L36 46 L20 46 Z"
          stroke="#7c3aed" strokeWidth="1.5"
          fill="rgba(124,58,237,0.08)" strokeLinejoin="round"
        />
        {/* Right hexagon block (overlapping) */}
        <path
          d="M28 32 L36 18 L52 18 L60 32 L52 46 L36 46 Z"
          stroke="#22d3ee" strokeWidth="1.5"
          fill="rgba(34,211,238,0.08)" strokeLinejoin="round"
        />
        {/* Center link highlights */}
        <path
          d="M36 22 L40 32 L36 42"
          stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" opacity="0.7"
        />
        <path
          d="M28 22 L24 32 L28 42"
          stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" opacity="0.7"
        />
      </svg>
    );
  }

  // type === "deploy"
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Deploy in 60s icon"
      role="img"
    >
      {/* Exhaust glow */}
      <ellipse cx="32" cy="48" rx="6" ry="10" fill="#7c3aed" opacity="0.2" />
      {/* Exhaust trail */}
      <path
        d="M28 46 Q32 54 36 46"
        stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" opacity="0.6"
      />
      <path
        d="M30 48 Q32 58 34 48"
        stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"
      />
      {/* Rocket body */}
      <path
        d="M32 8 C32 8 22 22 22 36 L32 40 L42 36 C42 22 32 8 32 8 Z"
        fill="#22d3ee" opacity="0.9"
      />
      {/* Rocket window */}
      <circle cx="32" cy="28" r="5" fill="#06060c" opacity="0.8" />
      <circle cx="32" cy="28" r="3" fill="#7c3aed" opacity="0.9" />
      <circle cx="30.5" cy="26.5" r="1" fill="white" opacity="0.5" />
      {/* Rocket fins */}
      <path d="M22 36 L16 44 L24 40 Z" fill="#7c3aed" opacity="0.7" />
      <path d="M42 36 L48 44 L40 40 Z" fill="#7c3aed" opacity="0.7" />
    </svg>
  );
};

export default OnboardingIcon;
