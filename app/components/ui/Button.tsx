"use client";

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import Link, { type LinkProps } from "next/link";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant. Defaults to `secondary`.
   *
   * `glow` is an elevated ghost treatment (transparent fill, brand-purple
   * hairline border, HUD corner brackets, press-scale feedback) for
   * moments that need extra visual weight — e.g. primary CTAs on hero /
   * marketing surfaces. Reproduces the legacy `GlowButton` look via the
   * shared `--accent` brand-purple token so it stays in sync with theme
   * retones automatically.
   */
  variant?: "primary" | "secondary" | "destructive" | "glow";
  /** Size preset. Defaults to `md`. */
  size?: "sm" | "md" | "lg";
  /** Show a spinner and disable interaction while an async action is in progress. */
  loading?: boolean;
  /** Optional icon rendered to the left of the label. */
  iconLeft?: ReactNode;
  /** Optional icon rendered to the right of the label. */
  iconRight?: ReactNode;
  /** Stretch the button to full container width. */
  fullWidth?: boolean;
  children?: ReactNode;
  className?: string;
}

const sizeClass: Record<string, string> = {
  sm: "btn-sm",
  md: "btn-md",
  lg: "btn-lg",
};

const iconSizeClass: Record<string, string> = {
  sm: "btn-icon-sm",
  md: "btn-icon-md",
  lg: "btn-icon-lg",
};

const variantClass: Record<string, string> = {
  // Reads the retoned --btn-primary-* tokens (brand purple) from
  // globals.css — no color values live here.
  primary: "btn-primary",
  secondary: "btn-secondary",
  destructive: "btn-destructive",
  // Elevated purple-ghost treatment: transparent fill, hairline
  // --accent border, HUD corner brackets, press-scale feedback.
  // Mirrors GlowButton's `primary` variant but sourced from the shared
  // brand-purple token so it can't drift from theme retones.
  glow: [
    "border",
    "border-[var(--accent)]/40",
    "bg-transparent",
    "text-[var(--accent)]",
    "hud-btn-corners",
    "hover:border-[var(--accent)]/70",
    "hover:bg-[var(--accent)]/[0.08]",
    "active:scale-[0.98]",
  ].join(" "),
};

const spinnerSize: Record<string, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

/**
 * Design-system button — single source of truth.
 *
 * Uses the `.btn`, `.btn-{variant}`, `.btn-{size}` CSS layer classes
 * defined in `globals.css` and the `--btn-*` custom property tokens.
 *
 * @example
 * <Button variant="primary" size="lg" onClick={handleSubmit}>
 *   Launch Market
 * </Button>
 *
 * @example Icon-only (always supply aria-label)
 * <Button variant="secondary" size="md" aria-label="Close">
 *   <XIcon />
 * </Button>
 *
 * @example Loading state
 * <Button variant="primary" loading>Submitting…</Button>
 *
 * @example Elevated ghost CTA (HUD corner brackets, brand-purple hairline)
 * <Button variant="glow" size="lg">Enter Playground</Button>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      loading = false,
      disabled = false,
      iconLeft,
      iconRight,
      fullWidth = false,
      className = "",
      children,
      type = "button",
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    const isIconOnly = !children && (iconLeft || iconRight);
    const sizeKey = size ?? "md";

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-disabled={isDisabled || undefined}
        aria-busy={loading || undefined}
        className={[
          "btn",
          isIconOnly ? iconSizeClass[sizeKey] : sizeClass[sizeKey],
          variantClass[variant],
          fullWidth ? "w-full" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        {loading && (
          <svg
            className="shrink-0"
            style={{ animation: "spin 0.75s linear infinite" }}
            width={spinnerSize[sizeKey]}
            height={spinnerSize[sizeKey]}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 2a10 10 0 0 1 10 10" />
          </svg>
        )}
        {!loading && iconLeft && (
          <span aria-hidden="true" className="shrink-0">
            {iconLeft}
          </span>
        )}
        {children}
        {!loading && iconRight && (
          <span aria-hidden="true" className="shrink-0">
            {iconRight}
          </span>
        )}
      </button>
    );
  },
);

Button.displayName = "Button";

export interface ButtonLinkProps
  extends LinkProps,
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "className" | "children"> {
  variant?: "primary" | "secondary" | "destructive" | "glow";
  size?: "sm" | "md" | "lg";
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * `<Link>` rendered with the exact same `.btn` classes as {@link Button} —
 * for CTAs that navigate rather than submit/act. Never wrap a `<Button>` in
 * a `<Link>`: nesting a `<button>` inside an `<a>` is invalid HTML (two
 * nested interactive elements) and breaks keyboard/AT navigation. Use this
 * instead so the anchor itself is the single interactive element.
 *
 * @example
 * <ButtonLink href="/trade" variant="primary" size="lg" iconRight={ARROW}>
 *   Start trading
 * </ButtonLink>
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  (
    {
      variant = "secondary",
      size = "md",
      iconLeft,
      iconRight,
      fullWidth = false,
      className = "",
      children,
      ...props
    },
    ref,
  ) => {
    const sizeKey = size ?? "md";

    return (
      <Link
        ref={ref}
        className={[
          "btn",
          sizeClass[sizeKey],
          variantClass[variant],
          fullWidth ? "w-full" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        {iconLeft && (
          <span aria-hidden="true" className="shrink-0">
            {iconLeft}
          </span>
        )}
        {children}
        {iconRight && (
          <span aria-hidden="true" className="shrink-0">
            {iconRight}
          </span>
        )}
      </Link>
    );
  },
);

ButtonLink.displayName = "ButtonLink";

export default Button;
