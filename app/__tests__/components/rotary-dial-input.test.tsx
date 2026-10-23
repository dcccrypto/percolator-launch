/**
 * RotaryDial input model. The dial face has no pointer/touch drag (laggy on the live playground) and
 * no scroll-to-adjust (removed: users didn't find it and it was a page-scroll hazard, #2716). It is
 * operated by typing into the readout, the vertical slider, tap-able -/+ buttons and keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RotaryDial, parseDialInput, sanitizeDialTyping } from "@/components/create/RotaryDial";

afterEach(cleanup);

function mount(over: Partial<{ value: number; min: number; max: number; step: number; disabled: boolean }> = {}) {
  const onChange = vi.fn();
  const props = { label: "Leverage", value: 5, min: 2, max: 10, step: 0.5, ...over };
  render(<RotaryDial {...props} format={(v) => `${v}x`} onChange={onChange} />);
  return { onChange, slider: screen.getByRole("slider", { name: "Leverage" }) };
}

describe("RotaryDial ARIA", () => {
  it("exposes slider semantics", () => {
    const { slider } = mount();
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
    expect(slider.getAttribute("aria-valuemin")).toBe("2");
    expect(slider.getAttribute("aria-valuemax")).toBe("10");
    expect(slider.getAttribute("aria-valuetext")).toBe("5x");
    expect(slider.tabIndex).toBe(0);
  });
});

describe("RotaryDial has no scroll-to-adjust", () => {
  it("a wheel over the dial, focused or not, never changes the value or blocks the page scroll", () => {
    const { slider, onChange } = mount({ value: 1500, min: 100, max: 10_000, step: 100 });
    const unfocused = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
    slider.dispatchEvent(unfocused);
    slider.focus();
    const focused = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    slider.dispatchEvent(focused);
    expect(onChange).not.toHaveBeenCalled();
    expect(unfocused.defaultPrevented || focused.defaultPrevented).toBe(false);
  });
});

describe("RotaryDial typed value (numbers only, within the dial's limits)", () => {
  const lev = { min: 2, max: 10, step: 0.5 };
  const lp = { min: 100, max: 10_000, step: 100 };
  it("keeps only digits (and one decimal separator when the dial has fractional steps)", () => {
    expect(sanitizeDialTyping("4.5x", true)).toBe("4.5");
    expect(sanitizeDialTyping("-4.5.5abc", true)).toBe("4.55");
    expect(sanitizeDialTyping("1,000", false)).toBe("1000");
    expect(sanitizeDialTyping("1.5e3", false)).toBe("153");
    expect(sanitizeDialTyping("<script>", false)).toBe("");
  });
  it("snaps to the step and clamps to the limits; rejects non-numbers", () => {
    expect(parseDialInput("4.3", lev)).toBe(4.5);
    expect(parseDialInput("4,5", lev)).toBe(4.5);
    expect(parseDialInput("4.", lev)).toBe(4);
    expect(parseDialInput("50", lev)).toBe(10);
    expect(parseDialInput("1", lev)).toBe(2);
    expect(parseDialInput("1,000", lp)).toBe(1000);
    expect(parseDialInput("10 000", lp)).toBe(10_000);
    expect(parseDialInput("30", lp)).toBe(100);
    expect(parseDialInput("99999999", lp)).toBe(10_000);
    for (const bad of ["", "abc", ".", "1e", "--"]) expect(parseDialInput(bad, lp)).toBeNull();
  });
  it("Enter commits the typed value, clamped; Escape cancels", () => {
    const { onChange } = mount();
    const box = screen.getByRole("textbox", { name: "Leverage value" }) as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "50abc" } });
    expect(box.value).toBe("50");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith(10);
    onChange.mockClear();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(box.value).toBe("5x");
  });
  it("a slider or -/+ change during an edit wins; leaving the box afterwards does not undo it", () => {
    const { onChange } = mount();
    const box = screen.getByRole("textbox", { name: "Leverage value" }) as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("Leverage-vertical-slider"), { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith(8);
    onChange.mockClear();
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("RotaryDial vertical slider", () => {
  it("moves the value within the dial's limits and step", () => {
    const { onChange } = mount();
    const range = screen.getByTestId("Leverage-vertical-slider") as HTMLInputElement;
    expect([range.min, range.max, range.step]).toEqual(["2", "10", "0.5"]);
    fireEvent.change(range, { target: { value: "7.5" } });
    expect(onChange).toHaveBeenLastCalledWith(7.5);
    expect(range.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("RotaryDial keys", () => {
  it("arrows, Home, End", () => {
    const { slider, onChange } = mount();
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(5.5);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(4.5);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(10);
  });
});

describe("RotaryDial tap step buttons (touch users)", () => {
  it("+ and - step by one detent", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Increase Leverage" }));
    expect(onChange).toHaveBeenLastCalledWith(5.5);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Leverage" }));
    expect(onChange).toHaveBeenLastCalledWith(4.5);
  });
  it("buttons disable at the stops", () => {
    mount({ value: 10 });
    expect((screen.getByRole("button", { name: "Increase Leverage" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount({ value: 2 });
    expect((screen.getByRole("button", { name: "Decrease Leverage" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("disabled dial ignores keys, taps, typing and the slider", () => {
    const { slider, onChange } = mount({ disabled: true });
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect((screen.getByRole("textbox", { name: "Leverage value" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("Leverage-vertical-slider") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Increase Leverage" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("RotaryDial has no drag", () => {
  it("mouse/touch drag never changes the value and adds no window listeners", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { slider, onChange } = mount();
    fireEvent.mouseDown(slider, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 100 });
    fireEvent.touchStart(slider, { touches: [{ clientY: 500 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 100 }] });
    expect(onChange).not.toHaveBeenCalled();
    const dragEvents = add.mock.calls.filter(([t]) => ["mousemove", "touchmove", "mouseup", "touchend"].includes(t as string));
    expect(dragEvents).toHaveLength(0);
    add.mockRestore();
  });
});

describe("RotaryDial tick timer", () => {
  it("cancels the pending tick-glow timer on unmount", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const onChange = vi.fn();
      const { unmount } = render(
        <RotaryDial label="Leverage" value={5} min={2} max={10} step={0.5} format={(v) => `${v}x`} onChange={onChange} />,
      );
      const slider = screen.getByRole("slider", { name: "Leverage" });
      fireEvent.keyDown(slider, { key: "ArrowUp" });
      expect(onChange).toHaveBeenLastCalledWith(5.5);
      const glow = setSpy.mock.calls.findIndex(([, ms]) => ms === 90);
      expect(glow).toBeGreaterThanOrEqual(0);
      const glowTimer = setSpy.mock.results[glow].value;
      unmount();
      // A tick timer left running set state on the unmounted dial — in CI that
      // fired after jsdom tore the window down and failed the run.
      expect(clearSpy).toHaveBeenCalledWith(glowTimer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
