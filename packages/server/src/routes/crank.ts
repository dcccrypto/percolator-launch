import { Hono } from "hono";
import type { CrankService } from "../services/crank.js";
import { validateSlab } from "../middleware/validateSlab.js";
import { requireApiKey } from "../middleware/auth.js";
import { readRateLimit, writeRateLimit } from "../middleware/rate-limit.js";

export function crankRoutes(deps: { crankService: CrankService }): Hono {
  const app = new Hono();

  // GET /crank/status — all markets with crank health (H1: rate limited)
  app.get("/crank/status", readRateLimit(), (c) => {
    return c.json(deps.crankService.getStatus());
  });

  // POST /crank/:slab — trigger crank for specific market (C2: auth, H1: rate limited)
  app.post("/crank/:slab", writeRateLimit(), requireApiKey(), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const ok = await deps.crankService.crankMarket(slab);
    return c.json({ slabAddress: slab, success: ok });
  });

  // POST /crank/all — trigger crank for all markets (C2: auth, H1: rate limited)
  app.post("/crank/all", writeRateLimit(), requireApiKey(), async (c) => {
    const result = await deps.crankService.crankAll();
    return c.json(result);
  });

  return app;
}
