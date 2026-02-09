import { Hono } from "hono";
import { validateSlab } from "../middleware/validateSlab.js";
import type { InsuranceLPService } from "../services/InsuranceLPService.js";
import { validateSlab } from "../middleware/validateSlab.js";

interface InsuranceDeps {
  insuranceService: InsuranceLPService;
}

export function insuranceRoutes(deps: InsuranceDeps): Hono {
  const app = new Hono();

  // GET /api/markets/:slab/insurance
  app.get("/api/markets/:slab/insurance", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const stats = deps.insuranceService.getStats(slab);

    if (!stats) {
      return c.json({ error: "No insurance data for this market" }, 404);
    }

    const depositors = await deps.insuranceService.getDepositorCount(slab);

    return c.json({
      balance: stats.balance,
      lpSupply: stats.lpSupply,
      redemptionRate: stats.redemptionRate,
      apy7d: stats.apy7d,
      apy30d: stats.apy30d,
      depositors,
    });
  });

  // GET /api/markets/:slab/insurance/events
  app.get("/api/markets/:slab/insurance/events", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const limit = Number(c.req.query("limit") ?? 50);

    try {
      const events = await deps.insuranceService.getEvents(slab, limit);
      return c.json({ events });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
    }
  });

  return app;
}
