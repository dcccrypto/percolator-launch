import { config } from "../config.js";

const HELIUS_WEBHOOKS_URL = `https://api.helius.dev/v0/webhooks`;

/**
 * Manages Helius webhook registration on server startup.
 * Creates or updates a webhook to receive enhanced transaction data
 * for all Percolator program IDs.
 */
export class HeliusWebhookManager {
  private webhookId: string | null = null;
  private _startError: string | null = null;
  private _status: "idle" | "active" | "failed" = "idle";

  /** Get current webhook status for diagnostics */
  getStatus(): { status: string; webhookId: string | null; error: string | null } {
    return { status: this._status, webhookId: this.webhookId, error: this._startError };
  }

  async start(): Promise<void> {
    if (!config.heliusApiKey) {
      console.warn("[HeliusWebhookManager] No HELIUS_API_KEY — skipping webhook registration");
      return;
    }
    if (!config.webhookUrl) {
      console.warn("[HeliusWebhookManager] No WEBHOOK_URL — skipping webhook registration");
      return;
    }

    try {
      // Check for existing webhook first
      const existing = await this.findExistingWebhook();
      if (existing) {
        console.log(`[HeliusWebhookManager] Found existing webhook ${existing.webhookID}, updating...`);
        await this.updateWebhook(existing.webhookID);
        this.webhookId = existing.webhookID;
      } else {
        console.log("[HeliusWebhookManager] Creating new webhook...");
        this.webhookId = await this.createWebhook();
      }
      this._status = "active";
      console.log(`[HeliusWebhookManager] Webhook active: ${this.webhookId}`);
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._status = "failed";
      console.error("[HeliusWebhookManager] Failed to register webhook:", this._startError);
      console.warn("[HeliusWebhookManager] Falling back to polling-only mode");
    }
  }

  async stop(): Promise<void> {
    // Don't delete webhook on shutdown — it persists across deploys
    this.webhookId = null;
  }

  /** Force re-register (for diagnostics) */
  async reRegister(): Promise<{ ok: boolean; webhookId?: string; error?: string }> {
    try {
      this._startError = null;
      await this.start();
      return { ok: this._status === "active", webhookId: this.webhookId ?? undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List all webhooks from Helius (for diagnostics) */
  async listWebhooks(): Promise<any[] | null> {
    if (!config.heliusApiKey) return null;
    try {
      const res = await fetch(`${HELIUS_WEBHOOKS_URL}?api-key=${config.heliusApiKey}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private get webhookPayload() {
    const webhookURL = `${config.webhookUrl}/webhook/trades`;
    // Detect network from RPC URL
    const isDevnet = config.rpcUrl.includes("devnet");
    return {
      webhookURL,
      transactionTypes: ["ANY"],
      accountAddresses: config.allProgramIds,
      webhookType: isDevnet ? "enhancedDevnet" : "enhanced",
      authHeader: config.webhookSecret || undefined,
    };
  }

  private async findExistingWebhook(): Promise<any | null> {
    const url = `${HELIUS_WEBHOOKS_URL}?api-key=${config.heliusApiKey}`;
    console.log(`[HeliusWebhookManager] Fetching ${url.replace(config.heliusApiKey, "***")}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    } catch (fetchErr) {
      console.error(`[HeliusWebhookManager] Fetch to api.helius.dev failed:`, fetchErr instanceof Error ? fetchErr.message : fetchErr);
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[HeliusWebhookManager] Failed to list webhooks: ${res.status} ${body}`);
      return null;
    }

    const webhooks: any[] = await res.json();
    const targetURL = `${config.webhookUrl}/webhook/trades`;

    // Find webhook matching our URL
    return webhooks.find((w) => w.webhookURL === targetURL) ?? null;
  }

  private async createWebhook(): Promise<string> {
    const res = await fetch(`${HELIUS_WEBHOOKS_URL}?api-key=${config.heliusApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.webhookPayload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Helius webhook creation failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data.webhookID;
  }

  private async updateWebhook(webhookId: string): Promise<void> {
    const res = await fetch(`${HELIUS_WEBHOOKS_URL}/${webhookId}?api-key=${config.heliusApiKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.webhookPayload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Helius webhook update failed: ${res.status} ${text}`);
    }
  }
}
