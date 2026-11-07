"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import { decimalInputRejection, decimalInputText, sanitizeDecimalInput } from "@/lib/decimal-input";

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
  const { field } = useAmountField(value, onValue, false);
  return field;
}

/**
 * `useDecimalInput` for a money field that must refuse, not rewrite, text that is not an amount ("-5" was read as 5,
 * "1e3" as 13; Council 2026-11-06-go1106-ux, LP). The field keeps what was typed, the state holds no amount, and
 * `rejection` says why. Spread `field` on the input; render `rejection` next to it.
 */
export function useStrictDecimalInput(
  value: string,
  onValue: (canonical: string) => void,
): { field: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void }; rejection: string | null } {
  return useAmountField(value, onValue, true);
}

function useAmountField(
  value: string,
  onValue: (canonical: string) => void,
  strict: boolean,
): { field: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void }; rejection: string | null } {
  const [text, setText] = useState(value);
  // Strict: text that is not an amount ("-5", "1e3") is shown exactly as typed while the state holds no amount.
  const rejection = strict ? decimalInputRejection(text) : null;
  const shown = rejection !== null && value === "" ? text : sanitizeDecimalInput(text) === value ? text : value;
  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      if (strict && decimalInputRejection(raw) !== null) {
        setText(raw);
        onValue("");
        return;
      }
      const next = decimalInputText(raw);
      setText(next);
      onValue(sanitizeDecimalInput(next));
    },
    [onValue, strict],
  );
  return { field: { value: shown, onChange }, rejection: rejection !== null && value === "" ? rejection : null };
}
