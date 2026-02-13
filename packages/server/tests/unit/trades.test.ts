/**
 * Trade Routes Tests — GET /markets/:slab/trades, /markets/:slab/volume, /trades/recent
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { tradeRoutes } from "../../src/routes/trades.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetRecentTrades = vi.fn();
const mockGet24hVolume = vi.fn();
const mockGetGlobalRecentTrades = vi.fn();

vi.mock("../../src/db/queries.js", () => ({
  getRecentTrades: (...args: any[]) => mockGetRecentTrades(...args),
  get24hVolume: (...args: any[]) => mockGet24hVolume(...args),
  getGlobalRecentTrades: (...args: any[]) => mockGetGlobalRecentTrades(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_SLAB = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function createApp() {
  const app = new Hono();
  app.route("/", tradeRoutes());
  return app;
}

async function get(app: Hono, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Trade Routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("GET /markets/:slab/trades", () => {
    it("returns trades array", async () => {
      const trades = [{ id: "1", trader: "abc", side: "long", size: "100" }];
      mockGetRecentTrades.mockResolvedValue(trades);

      const res = await get(app, `/markets/${VALID_SLAB}/trades`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.trades).toEqual(trades);
    });

    it("returns 400 for invalid slab format", async () => {
      const res = await get(app, "/markets/not-valid!!!/trades");
      expect(res.status).toBe(400);
    });

    it("respects limit param clamped 1-200", async () => {
      mockGetRecentTrades.mockResolvedValue([]);

      // limit=0 → clamped to 1
      await get(app, `/markets/${VALID_SLAB}/trades?limit=0`);
      expect(mockGetRecentTrades).toHaveBeenCalledWith(VALID_SLAB, 1);

      mockGetRecentTrades.mockClear();

      // limit=999 → clamped to 200
      await get(app, `/markets/${VALID_SLAB}/trades?limit=999`);
      expect(mockGetRecentTrades).toHaveBeenCalledWith(VALID_SLAB, 200);
    });
  });

  describe("GET /markets/:slab/volume", () => {
    it("returns BigInt volume string and trade count", async () => {
      mockGet24hVolume.mockResolvedValue({ volume: "123456789012345678", tradeCount: 42 });

      const res = await get(app, `/markets/${VALID_SLAB}/volume`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.volume_24h).toBe("123456789012345678");
      expect(json.trade_count_24h).toBe(42);
      expect(json.slab_address).toBe(VALID_SLAB);
    });

    it("returns 400 for invalid slab", async () => {
      const res = await get(app, "/markets/invalid/volume");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /trades/recent", () => {
    it("returns global trades", async () => {
      const trades = [{ id: "1" }, { id: "2" }];
      mockGetGlobalRecentTrades.mockResolvedValue(trades);

      const res = await get(app, "/trades/recent");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.trades).toEqual(trades);
    });
  });
});
