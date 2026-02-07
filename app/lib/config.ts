export const config = {
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.helius-rpc.com/?api-key=e568033d-06d6-49d1-ba90-b3564c91851b",
  programId: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
  matcherProgramId: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX",
  slabSize: 992_560,
  matcherCtxSize: 320,
  priorityFee: 50_000,
} as const;
