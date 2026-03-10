"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "destructive";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
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
 * Design-system button. Single source of truth for all button variants.
 *
 * @example
 * <Button variant="primary" size="lg">Launch Market</Button>
 * <Button variant="destructive" loading>Closing…</Button>
 * <Button variant="secondary" iconLeft={<XIcon />} size="sm">Cancel</Button>
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
            className="animate-[btn-spin_0.75s_linear_infinite] shrink-0"
            width={spinnerSize[sizeKey]}
            height={spinnerSize[sizeKey]}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="31.4 31.4"
            />
          </svg>
        )}
        {!loading && iconLeft}
        {children}
        {!loading && iconRight}
      </button>
    );
  },
);

Button.displayName = "Button";

export default Button;
