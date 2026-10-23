"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import { decimalInputText, sanitizeDecimalInput } from "@/lib/decimal-input";

/**
 * Wire an amount `<input>` so it SHOWS what the user typed ("1,", "1,00", "12,75", "1,000")
 * while the component's own state only ever holds the canonical dot value ("1.", "1.00",
 * "12.75", "1000") from `sanitizeDecimalInput`. Without the split, the field had to show the
 * canonical value, so "1," became "1." on screen and the next three keys made it "1.000" = 1
 * instead of 1000. See lib/decimal-input.ts for the reading rule.
 *
 * `value` is the component's state; `onValue` receives the canonical value on every edit. When
 * the component sets the state itself (Max, presets, clearing after a submit), the typed text no
 * longer matches it and the field shows the new value.
 *
 * Usage: `const field = useDecimalInput(amount, setAmount); <input {...field} inputMode="decimal" />`
 */
export function useDecimalInput(
  value: string,
  onValue: (canonical: string) => void,
): { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void } {
  const [text, setText] = useState(value);
  const shown = sanitizeDecimalInput(text) === value ? text : value;
  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const next = decimalInputText(e.target.value);
      setText(next);
      onValue(sanitizeDecimalInput(next));
    },
    [onValue],
  );
  return { value: shown, onChange };
}
