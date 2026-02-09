import { config } from "../config.js";
import { acquireToken } from "./rpc-client.js";

interface PriorityFeeResponse {
  result?: {
    priorityFeeEstimate?: number;
  };
}

export async function estimatePriorityFee(accountKeys: string[] = []): Promise<number> {
  try {
    await acquireToken();
    const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys,
            options: { recommended: true },
          },
        ],
      }),
    });
    const json = (await res.json()) as PriorityFeeResponse;
    return json.result?.priorityFeeEstimate ?? 50_000;
  } catch {
    return 50_000;
  }
}
