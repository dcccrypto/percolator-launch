"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import { decimalInputText, sanitizeDecimalInput, strictDecimalReading, type StrictAmountEcho } from "@/lib/decimal-input";

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
  const { field } = useAmountField(value, onValue);
  return field;
}

/**
 * `useDecimalInput` for a money field that must refuse, not rewrite, text that is not exactly one amount ("-5" was read
 * as 5, "1e3" as 13, "1.2.3" as 1.23, "1,000,00" as 100000; Council 2026-11-06-go1106-ux LP, 2026-11-07
 * council-leftovers run 2). The field always shows what was typed; the state holds the amount `strictDecimalReading`
 * read, or nothing; `rejection` says why there is none; `echo` names the amount read whenever a comma was involved
 * (and the other reading of "1,500"). Spread `field` on the input; render `rejection` and `echo` next to it.
 */
export function useStrictDecimalInput(
  value: string,
  onValue: (canonical: string) => void,
): {
  field: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void };
  rejection: string | null;
  echo: StrictAmountEcho | null;
  /** Forget the typed text (a tab or unit switch), so a refused "-5" does not follow the user to the other tab. */
  reset: () => void;
} {
  const [text, setText] = useState(value);
  const reading = strictDecimalReading(text);
  const readValue = reading.ok ? reading.value : "";
  // The component set the amount itself (Max, clear after submit): show its value. Otherwise show the typed text.
  const own = readValue === value;
  const shown = own ? text : value;
  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setText(raw);
      const r = strictDecimalReading(raw);
      onValue(r.ok ? r.value : "");
    },
    [onValue],
  );
  return {
    field: { value: shown, onChange },
    rejection: own && !reading.ok ? reading.reason : null,
    echo: own && reading.ok ? reading.echo : null,
    reset: useCallback(() => setText(""), []),
  };
}

function useAmountField(
  value: string,
  onValue: (canonical: string) => void,
): { field: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void } } {
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
  return { field: { value: shown, onChange } };
}
