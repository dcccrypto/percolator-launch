// EDGE-PURE blocklist — imported ONLY by middleware.ts.
//
// Self-contained (zero imports, zero side effects) so the bundler gives the Edge
// middleware an ISOLATED chunk. Importing @/lib/blocklist instead co-bundled this
// set into a shared "[root-of-the-server]" chunk that also carried Node-only code
// (pulled in by the many Node-runtime route handlers that import @/lib/blocklist),
//  which Vercel's deploy-time Edge validator rejected as
//   The Edge Function "middleware" is referencing unsupported modules: @/lib/blocklist
//
// KEEP IN SYNC with HARDCODED_BLOCKED_SLABS in lib/blocklist.ts (the canonical set
// used by the rest of the app). Env-var overrides are intentionally omitted here —
// the API-layer blocklist (lib/blocklist.ts) still applies those.
export const BLOCKED_SLAB_ADDRESSES: ReadonlySet<string> = new Set<string>([
  "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD",
  "3bmCyPeeDwAfLbhfnRpYJHkWVqAf3Q5JaWXGfZjbmjNp",
  "3dp3e288oPjs5w92fg26cVYQMHGuUpsj8YbSFn6wrzp4",
  "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ",
  "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn",
  "4txSGha4zABqt2NUbBtbkzv3vA4rfi9J6Yr95adA4fc5",
  "5Rdxh3n4CbLEpzovbMtUJ7M3iaZkoso8jGdfVwkv2eV8",
  "6QSHWb4Vm1M6f1r14t1jB7Jc4en2uieQuLpKqey71Y2S",
  "7mzqfnuAhANvDV8PiqJBG3jehyv3rPrCMr9V6j2bCHPV",
  "7xozYEbKhEdjQn5pCAV8bUDQGugZttqZTduPeHkoqRb8",
  "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
  "8kkED3uZznGzSidr8kYJPd3VhzSh7LVngNUx2V1qnW9L",
  "8L47yqvQRLxZ6PzW3b9jawEM79CmokBvUzeLR7mvtyuU",
  "8NY7rvQJXNTinJkAQG1GUV8NQ1hQzdtF7iWNjK9p7tQN",
  "8nzjXMvdkC4fRF491QkpKE6aFTLmEcpXEnbh4wQT4iUA",
  "8pKtAV3z6iTKekieF9EenQ4tk1rkAVa9oYsqe7h1PGjx",
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83",
  "9oBMLGXq9mLGa5DQapTL2gia9eM425dNvf4DUNoMrzz6",
  "9TGSmPLTLMii4UqstL629twGeVJ9Ndr8VD3pexnvQTsV",
  "Av3zVrW5deLpLo1qZZ7yNJ5Lq5ja4Z9ixijVhV4MuRzE",
  "BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP",
  "CrbDmfiooBUTFfGyMhJ1hpToCrBLAXXKySBwEnLHV6kj",
  "CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v",
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB",
  "dLKhJAVPgmgxJJWvbcGvfQUNBmc7wwjdQp8Jzpg4UGq",
  "DxrZXhTC11gCVtv4b2nkbszScgZPqm9DFqit5X7FvsF7",
  "Eekuz2TgXRPq3rsp5brRW5hofxLdwt6KUXbLUQCKHK9G",
  "FhpPmmuh5UDAjvEjrYBPFwmj4CP4otvsYMxtTb46p1Ss",
  "FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98",
  "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH",
  "GRAgHm9utZy6kWJj1ZpAVntbyFxCBJyZJ1nSJmiMPPpq",
  "H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph",
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT",
  "J6UU4VHbYXpCAACr5o5xjUVmquagiP2NGbbMp68VUCX9",
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG",
]);
