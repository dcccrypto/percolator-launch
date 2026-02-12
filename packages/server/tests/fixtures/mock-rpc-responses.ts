/**
 * Mock RPC responses for testing
 */

export const mockRpcGetAccountInfo = {
  value: {
    data: Buffer.from([]), // Empty buffer for mock
    executable: false,
    lamports: 1000000,
    owner: "11111111111111111111111111111111",
    rentEpoch: 0,
  },
};

export const mockRpcGetLatestBlockhash = {
  blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
  lastValidBlockHeight: 150,
};

export const mockRpcConfirmTransaction = {
  value: {
    err: null,
  },
};

export const mockRpcGetSignatureStatuses = {
  value: [
    {
      slot: 100,
      confirmations: 10,
      err: null,
      confirmationStatus: "confirmed" as const,
    },
  ],
};

export const mockRpcSendTransaction = "5VERv8FjU3MzQPgZqYCWKcpLc6oMWWGigQWiYTkEjWRNP1qTxwLpZMWQWQWQWQWQ";

export const mockRpcGetRecentPrioritizationFees = [
  { slot: 100, prioritizationFee: 5000 },
  { slot: 101, prioritizationFee: 6000 },
  { slot: 102, prioritizationFee: 7000 },
];

export const mockDexScreenerResponse = {
  pairs: [
    {
      priceUsd: "100.50",
      liquidity: { usd: 1000000 },
    },
  ],
};

export const mockJupiterResponse = {
  data: {
    So11111111111111111111111111111111111111112: {
      price: "100.75",
    },
  },
};

export const mockEmptyDexScreenerResponse = {
  pairs: [],
};

export const mockTimeoutError = new Error("fetch failed: timeout");
