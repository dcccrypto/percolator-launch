/**
 * useDecimalInput keeps what the user typed on screen ("1,", "1,00") while the component's own
 * state holds the canonical dot value, so typing "1,000" key by key ends at 1000, not 1.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type FC } from "react";
import { describe, expect, it } from "vitest";
import { useDecimalInput } from "@/hooks/useDecimalInput";

let held = "";
let setHeld: (v: string) => void = () => {};
const Field: FC = () => {
  const [value, setValue] = useState("");
  held = value;
  setHeld = setValue;
  const field = useDecimalInput(value, setValue);
  return <input aria-label="amount" {...field} />;
};

const typeKeys = (input: HTMLInputElement, keys: string) => {
  for (const k of keys) fireEvent.change(input, { target: { value: input.value + k } });
};

describe("useDecimalInput", () => {
  it("typing 1,000 key by key shows 1,000 and holds 1000", () => {
    render(<Field />);
    const input = screen.getByLabelText("amount") as HTMLInputElement;
    typeKeys(input, "1,");
    expect(input.value).toBe("1,");
    typeKeys(input, "000");
    expect(input.value).toBe("1,000");
    expect(held).toBe("1000");
  });

  it("a decimal comma shows as typed and holds the point form", () => {
    render(<Field />);
    const input = screen.getByLabelText("amount") as HTMLInputElement;
    typeKeys(input, "12,75");
    expect(input.value).toBe("12,75");
    expect(held).toBe("12.75");
  });

  it("a value set by the component (Max, presets, clear) replaces the typed text", () => {
    render(<Field />);
    const input = screen.getByLabelText("amount") as HTMLInputElement;
    typeKeys(input, "1,5");
    act(() => setHeld("42"));
    expect(input.value).toBe("42");
    act(() => setHeld(""));
    expect(input.value).toBe("");
  });
});
