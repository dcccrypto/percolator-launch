import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Button } from "@/components/ui/Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeDefined();
  });

  it("applies variant class", () => {
    render(<Button variant="primary">Go</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-primary");
  });

  it("applies size class", () => {
    render(<Button size="lg">Big</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-lg");
  });

  it("defaults to secondary md", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-secondary");
    expect(btn.className).toContain("btn-md");
  });

  it("sets disabled and aria-disabled when disabled", () => {
    render(<Button disabled>Nope</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("sets disabled and aria-busy when loading", () => {
    render(<Button loading>Loading…</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("shows spinner svg when loading", () => {
    const { container } = render(<Button loading>Wait</Button>);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("applies fullWidth class", () => {
    render(<Button fullWidth>Wide</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("w-full");
  });

  it("applies destructive variant", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-destructive");
  });

  it("forwards onClick", () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Press</Button>);
    screen.getByRole("button").click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not fire onClick when disabled", () => {
    const handler = vi.fn();
    render(<Button disabled onClick={handler}>No</Button>);
    screen.getByRole("button").click();
    expect(handler).not.toHaveBeenCalled();
  });
});
