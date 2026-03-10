"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant. Defaults to `secondary`. */
  variant?: "primary" | "secondary" | "destructive";
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
  primary: "btn-primary",
  secondary: "btn-secondary",
  destructive: "btn-destructive",
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

export default Button;
