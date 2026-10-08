/**
 * Binds OrderTicket's Open/Close toggle to source (GH#2651). The behaviour of the
 * close panel itself is tested for real in OrderTicketClosePanel.test.tsx; this
 * only pins the wiring that a unit render of the whole ticket cannot cheaply reach.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const RAW = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/OrderTicket.tsx"),
  "utf8",
);
/** Source without comments, so prose mentioning a hook cannot satisfy or fail a check. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("OrderTicket — Open/Close toggle", () => {
  it("delegates Close mode to OrderTicketClosePanel and does not mount the close hook itself", () => {
    expect(SRC).toContain('import { OrderTicketClosePanel } from "@/components/trade/OrderTicketClosePanel"');
    expect(SRC).toMatch(/<OrderTicketClosePanel[\s\S]*onClosed=\{handleClosed\}/);
    // the open form must not pay for useClosePosition / a reactive price
    expect(SRC).not.toMatch(/useClosePosition\(/);
    expect(SRC).not.toMatch(/useLivePrice\(\)/);
  });

  it("has an open/close toggle, defaulting to open, emitted before the close branch", () => {
    expect(SRC).toMatch(/const \[ticketMode, setTicketMode\] = useState<"open" \| "close">\("open"\)/);
    expect(SRC).toMatch(/role="tablist"/);
    expect(SRC.indexOf("openCloseToggle =")).toBeGreaterThan(-1);
    expect(SRC.indexOf('if (ticketMode === "close")')).toBeGreaterThan(SRC.indexOf("openCloseToggle ="));
  });

  it("no hook is called after the Close-mode early return (rules of hooks)", () => {
    const after = SRC.slice(SRC.indexOf('if (ticketMode === "close")'));
    const componentEnd = after.indexOf("\n};\n");
    const body = after.slice(0, componentEnd === -1 ? undefined : componentEnd);
    expect(body).not.toMatch(/\buse[A-Z][A-Za-z]*\(/);
  });

  it("a close refreshes the ticket; the entry is cleared by useClosePosition on an actual full close", () => {
    // Clearing here on a 100% request wiped the entry after a partial fill.
    expect(SRC).not.toMatch(/percent === 100 && userAccount\) clearEntryPrice/);
    expect(SRC).toMatch(/setTimeout\(\(\) => refreshSlab\(\), \d+\)/);
  });

  it("gates the panel like PositionsDock: engine staleness, LP underfunded, oracle", () => {
    expect(SRC).toMatch(/lpUnderfunded=\{lpUnderfunded\}/);
    expect(SRC).toMatch(/engineStale=\{engineStale\}/);
    expect(SRC).toMatch(/oracleBlocked=\{!mockMode && closeGate\.blocked\}/);
  });
});
