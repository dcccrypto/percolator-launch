import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InfoTabs, nextOpenTab } from "@/components/waitlist/InfoTabs";

const tabs = [
  { id: "how", label: "How it works", content: <p>how body</p> },
  { id: "faq", label: "FAQ", content: <p>faq body</p> },
];

describe("nextOpenTab", () => {
  it("opens a closed tab, switches between tabs, and closes the open one", () => {
    expect(nextOpenTab(null, "how")).toBe("how");
    expect(nextOpenTab("how", "faq")).toBe("faq");
    expect(nextOpenTab("faq", "faq")).toBeNull();
  });
});

describe("InfoTabs", () => {
  it("starts with every panel closed", () => {
    render(<InfoTabs tabs={tabs} />);
    for (const b of screen.getAllByRole("button")) expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("how body")).toBeNull();
  });

  it("shows one panel at a time and collapses on a second click", () => {
    render(<InfoTabs tabs={tabs} />);
    const how = screen.getByRole("button", { name: "How it works" });
    const faq = screen.getByRole("button", { name: "FAQ" });

    fireEvent.click(how);
    expect(screen.getByText("how body")).toBeTruthy();
    expect(how.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(faq);
    expect(screen.queryByText("how body")).toBeNull();
    expect(screen.getByText("faq body")).toBeTruthy();
    expect(how.getAttribute("aria-expanded")).toBe("false");
    expect(faq.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(faq);
    expect(screen.queryByText("faq body")).toBeNull();
    expect(faq.getAttribute("aria-expanded")).toBe("false");
  });

  it("points every button at the panel, which is labelled by the open tab", () => {
    render(<InfoTabs tabs={tabs} />);
    const how = screen.getByRole("button", { name: "How it works" });
    const panelId = how.getAttribute("aria-controls")!;
    expect(document.getElementById(panelId)).not.toBeNull();
    fireEvent.click(how);
    expect(document.getElementById(panelId)!.getAttribute("aria-labelledby")).toBe(how.id);
  });
});
