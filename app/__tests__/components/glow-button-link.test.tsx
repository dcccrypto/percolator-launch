/**
 * #64: "+ Launch Market", "Browse Markets", "Open faucet" and others were a <GlowButton> (a
 * <button>) inside a <Link>: two tab stops for one control, and a button inside a link is invalid
 * nested interactive content. GlowButton takes an `href` and renders the link itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { GlowButton } from "@/components/ui/GlowButton";

afterEach(cleanup);

describe("#64: GlowButton as a link", () => {
  it("with href it renders one link with the button's look, no nested button", () => {
    render(
      <GlowButton href="/create" aria-label="Launch a new market" size="sm" data-testid="launch">
        + LAUNCH MARKET
      </GlowButton>,
    );
    const link = screen.getByRole("link", { name: "Launch a new market" });
    expect(link.getAttribute("href")).toBe("/create");
    expect(link.getAttribute("data-testid")).toBe("launch");
    expect(link.querySelector("button")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const cls = link.className.split(/\s+/);
    // Same look as the button, sized like it (w-fit), and the button's 44px phone tap height.
    expect(cls).toEqual(expect.arrayContaining(["hud-btn-corners", "px-4", "py-2", "w-fit", "max-md:min-h-[44px]"]));
  });

  it("without href it is still a button", () => {
    render(<GlowButton onClick={() => {}}>Try Again</GlowButton>);
    expect(screen.getByRole("button", { name: "Try Again" }).tagName).toBe("BUTTON");
  });

  it("no GlowButton is wrapped in a link anywhere in app/ or components/", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
          if (name !== "node_modules") walk(p);
        } else if (p.endsWith(".tsx") && name !== "GlowButton.tsx") files.push(p); // its own <Link> branch
      }
    };
    walk(path.join(root, "app"));
    walk(path.join(root, "components"));
    const hits: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/<(Link|a)\b[^>]*>((?:(?!<\/(?:Link|a)>)[\s\S]){0,600}?)<\/(?:Link|a)>/g)) {
        if (/<(button|GlowButton|Button|IconButton)\b|role=["']button["']/.test(m[2])) hits.push(`${path.relative(root, f)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
