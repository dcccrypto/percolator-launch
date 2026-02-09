const ERROR_CODE_MAP: Record<number, string> = {
  0x4: "Invalid slab — market may not exist.",
  0xc: "Oracle price is stale. The market keeper needs to update the price before trading is possible. Try again in a moment.",
  0xd: "Insufficient balance. Deposit more collateral first.",
  0xe: "Position would be undercollateralized at this leverage.",
  0xf: "Unauthorized — you don't have permission for this action.",
};

function extractErrorCode(msg: string): number | null {
  const m = msg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (m) return parseInt(m[1], 16);
  const m2 = msg.match(/\b0x([0-9a-fA-F]+)\b/);
  if (m2) return parseInt(m2[1], 16);
  return null;
}

export function isOracleStaleError(msg: string): boolean {
  return extractErrorCode(msg) === 0xc;
}

export function humanizeError(rawMsg: string): string {
  const code = extractErrorCode(rawMsg);
  if (code !== null && ERROR_CODE_MAP[code]) {
    return ERROR_CODE_MAP[code];
  }
  if (rawMsg.includes("Blockhash not found")) {
    return "Transaction expired. Please try again.";
  }
  if (rawMsg.includes("insufficient funds") || rawMsg.includes("Insufficient")) {
    return "Insufficient funds for this transaction.";
  }
  if (rawMsg.includes("User rejected")) {
    return "Transaction cancelled.";
  }
  return "Transaction failed. Please try again.";
}
