/**
 * The result line is worded from the MEASURED position change (ADL-effective before/after), never
 * from the request or the raw pre-trade position. Table of measured pairs -> exact strings, and
 * every figure in a string must equal the measured delta / sizes.
 */
import { describe, expect, it } from "vitest";
import { classifyOrderChange, orderResultBody } from "@/lib/order-result";
import { COPY, ORDER_CONFIRMED_UNMEASURED, TICKET_COPY } from "@/lib/limits/copy";

const Q = 1_000_000n;
const fmt = (q: bigint) => (Number(q) / 1e6).toString();
const line = (dir: "long" | "short", req: bigint, c: { beforeQ: bigint; afterQ: bigint } | null) => {
  const o = classifyOrderChange(dir, req, c);
  return o.effect === "zero" ? "ZERO" : orderResultBody(o, fmt, "SOL", "$2.00");
};

describe("classifyOrderChange -> orderResultBody", () => {
  it.each([
    ["open", "long", 5n, 0n, 5n, "Opened 5 SOL long at $2.00"],
    ["open short", "short", 5n, 0n, -5n, "Opened 5 SOL short at $2.00"],
    ["add", "long", 5n, 4n, 9n, "Added 5 SOL to your long at $2.00"],
    ["add short", "short", 2n, -4n, -6n, "Added 2 SOL to your short at $2.00"],
    ["reduce", "short", 5n, 8n, 3n, "Reduced your long by 5 SOL at $2.00"],
    ["reduce a short", "long", 2n, -8n, -6n, "Reduced your short by 2 SOL at $2.00"],
    ["close", "short", 5n, 5n, 0n, "Closed your 5 SOL long at $2.00"],
    ["flip", "short", 5n, 3n, -2n, "Closed your 3 SOL long and opened 2 SOL short at $2.00"],
    // raw 8 long, ADL-effective 3 (the measured before): sell 5 is a flip, not "Reduced your long by 5"
    ["ADL flip", "short", 5n, 3n, -2n, "Closed your 3 SOL long and opened 2 SOL short at $2.00"],
    ["partial open", "long", 5n, 0n, 2n, "Opened 2 of 5 SOL. The market had room for part of your order."],
    ["partial add", "long", 5n, 4n, 6n, "Added 2 SOL to your long. The market had room for part of your order."],
    ["partial reduce (clipped)", "short", 5n, 8n, 6n, "Reduced your long by 2 SOL. The market had room for part of your order."],
    ["partial flip", "short", 5n, 3n, -1n, "Closed your 3 SOL long and opened 1 SOL short. The market had room for part of your order."],
    ["flip request clipped to a close", "short", 5n, 3n, 0n, "Closed your 3 SOL long. The market had room for part of your order."],
    ["zero fill", "short", 5n, 8n, 8n, "ZERO"],
    ["opposite-sign surprise", "long", 5n, 8n, 3n, ORDER_CONFIRMED_UNMEASURED],
    ["moved more than asked", "short", 5n, 8n, -4n, ORDER_CONFIRMED_UNMEASURED],
  ] as const)("%s", (_n, dir, req, before, after, want) => {
    expect(line(dir, req * Q, { beforeQ: before * Q, afterQ: after * Q })).toBe(want);
  });

  it("unmeasured (null: flag off, read failed or timed out) claims nothing", () => {
    expect(line("short", 5n * Q, null)).toBe("Your order went through. Your position is updating.");
  });

  it("the unmeasured wording is ONE constant shared with the close toast", () => {
    expect(TICKET_COPY.result.unmeasured).toBe(ORDER_CONFIRMED_UNMEASURED);
    expect(COPY.closeConfirmedUnmeasured).toBe(ORDER_CONFIRMED_UNMEASURED);
  });

  it("no figure in a measured line differs from the measured delta (property over a grid)", () => {
    for (const dir of ["long", "short"] as const) {
      const s = dir === "long" ? 1n : -1n;
      for (let before = -6; before <= 6; before++) {
        for (let d = 1; d <= 6; d++) {
          for (let req = d; req <= 7; req++) {
            const b = BigInt(before) * Q;
            const a = b + s * BigInt(d) * Q;
            const o = classifyOrderChange(dir, BigInt(req) * Q, { beforeQ: b, afterQ: a });
            if (o.effect === "zero" || o.effect === "unmeasured") throw new Error("unexpected");
            // opened + closed legs reconcile with the signed change
            expect(o.filled).toBe(BigInt(d) * Q);
            if (o.effect === "flip") {
              expect(o.closed).toBe(b < 0n ? -b : b);
              expect(o.opened).toBe(o.filled - o.closed);
            }
            if (o.effect === "close") expect(o.closed).toBe(o.filled);
            const nums = (orderResultBody(o, fmt, "SOL", "$2.00").replace("$2.00", "").match(/\d+(\.\d+)?/g) ?? []).map(Number);
            const allowed = new Set([Number(o.filled) / 1e6, Number(o.closed) / 1e6, Number(o.opened) / 1e6, Number(o.requested) / 1e6]);
            for (const n of nums) expect(allowed.has(n)).toBe(true);
          }
        }
      }
    }
  });
});
