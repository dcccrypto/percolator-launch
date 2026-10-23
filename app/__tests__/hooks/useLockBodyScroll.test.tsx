import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { lockPageScroll, useLockBodyScroll } from "@/hooks/useLockBodyScroll";

function Locker() {
  useLockBodyScroll();
  return null;
}

describe("useLockBodyScroll", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
    document.documentElement.style.scrollbarGutter = "";
  });

  // globals.css makes <html> the viewport scroller (html { overflow-x: hidden }),
  // so a lock on <body> alone leaves the page scrolling behind the dialog.
  it("locks <html>, not just <body>, and restores both on unmount", () => {
    const { unmount } = render(<Locker />);
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the page locked until the last of two stacked locks releases, in any order", () => {
    const first = lockPageScroll();
    const second = lockPageScroll();
    first();
    expect(document.documentElement.style.overflow).toBe("hidden");
    second();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("ignores a second release of the same lock", () => {
    const outer = lockPageScroll();
    const inner = lockPageScroll();
    inner();
    inner();
    expect(document.documentElement.style.overflow).toBe("hidden");
    outer();
    expect(document.documentElement.style.overflow).toBe("");
  });
});
