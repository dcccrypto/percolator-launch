import { Hono } from "hono";
import type { CrankService } from "../services/crank.js";
import { validateSlab } from "../middleware/validateSlab.js";
import { requireApiKey } from "../middleware/auth.js";

export function crankRoutes(deps: { crankService: CrankService }): Hono {
  const app = new Hono();

  // GET /crank/status — all markets with crank health (public, read-only)
  app.get("/crank/status", (c) => {
    return c.json(deps.crankService.getStatus());
  });

  // POST /crank/:slab — trigger crank for specific market (auth required)
  app.post("/crank/:slab", requireApiKey(), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const ok = await deps.crankService.crankMarket(slab);
    return c.json({ slabAddress: slab, success: ok });
  });

  // POST /crank/all — trigger crank for all markets (auth required)
  app.post("/crank/all", requireApiKey(), async (c) => {
    const result = await deps.crankService.crankAll();
    return c.json(result);
  });

  return app;
}
