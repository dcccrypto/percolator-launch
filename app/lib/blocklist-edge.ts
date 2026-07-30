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
  "7FBXdrm1vQ4ktQJjMwurq4cAHkVB1gKoZ7Hx3CAQv6P4",
  "7mzqfnuAhANvDV8PiqJBG3jehyv3rPrCMr9V6j2bCHPV",
  "7xozYEbKhEdjQn5pCAV8bUDQGugZttqZTduPeHkoqRb8",
  "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
  "8kkED3uZznGzSidr8kYJPd3VhzSh7LVngNUx2V1qnW9L",
  "8L47yqvQRLxZ6PzW3b9jawEM79CmokBvUzeLR7mvtyuU",
  "8NY7rvQJXNTinJkAQG1GUV8NQ1hQzdtF7iWNjK9p7tQN",
  "8nzjXMvdkC4fRF491QkpKE6aFTLmEcpXEnbh4wQT4iUA",
  "8pKtAV3z6iTKekieF9EenQ4tk1rkAVa9oYsqe7h1PGjx",
  "8SHhSKuY9cun15Y2Q9p9SNEV86zzSWbeP4e59xLAv99h",
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83",
  "9oBMLGXq9mLGa5DQapTL2gia9eM425dNvf4DUNoMrzz6",
  "9TGSmPLTLMii4UqstL629twGeVJ9Ndr8VD3pexnvQTsV",
  "Av3zVrW5deLpLo1qZZ7yNJ5Lq5ja4Z9ixijVhV4MuRzE",
  "BLAHwD5wZ3Wo6naHD4GTT6zpYFcyLWAviEWR4zT7C36p",
  "BPgSUbDsxZ9bkauWgd6eQ8oLHVx6pSsvfAjPGsS2Sso8",
  "BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP",
  "CrbDmfiooBUTFfGyMhJ1hpToCrBLAXXKySBwEnLHV6kj",
  "CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v",
  "CseeeuKKbgNU38VRukG38mTdcPJ4KWci5GmFikEtp1X5",
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB",
  "dLKhJAVPgmgxJJWvbcGvfQUNBmc7wwjdQp8Jzpg4UGq",
  "DxrZXhTC11gCVtv4b2nkbszScgZPqm9DFqit5X7FvsF7",
  "Eekuz2TgXRPq3rsp5brRW5hofxLdwt6KUXbLUQCKHK9G",
  "FhpPmmuh5UDAjvEjrYBPFwmj4CP4otvsYMxtTb46p1Ss",
  "FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98",
  "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH",
  "gHey79gB1xGQyXne8yEHoKmGi6jrEVigLwxSXQrYkD3",
  "GRAgHm9utZy6kWJj1ZpAVntbyFxCBJyZJ1nSJmiMPPpq",
  "H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph",
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT",
  "J6UU4VHbYXpCAACr5o5xjUVmquagiP2NGbbMp68VUCX9",
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG",
  // 2026-07-28: harness/QA markets from the devnet-2.0 verification sweep.
  "14RFDSTK6eJ3VKprgfAafU3kqgYRVCATMV7f5Ukf2pzh",
  "2Md6RJoxQG89bKh7uzhhcHqwAmgGTJN9PN7EkZt1ZTPC",
  "43zufCcajU6H8ySqjG9vDcwFCbjGPhRCSJJAEf3E6Hiw",
  "4gM5qkkmsSqnBXHXtbM4pqGZ36sheo3cYL1jpdDfsJrS",
  "54Bbsy7q5L5LhusWkKeCon7StywWa8Vezb5zw5pfBo2o",
  "BgWFGPgNasesbiihEhadYuDdHAckSTu6AMvEBBkrdfmn",
  "CZJHRKQMHNUVy2muC7iojovnTgGtyVnpjCk1QpqheUZ5",
  "D6QgPGvo5KGFzYCuzk4U9tDm6UbEpCrjWwu9SGQTfQeU",
  "DE2c59suA6NVxRMHvhEhaWJxtBQu8XSMB2CM8wxwyoT7",
  "EtgRphLa69F15krir2E1kZL6LCCuQHDS9Cher3hmYunJ",
  "EuYE6qaNic3KhaRAtB9cM5YG62Z88dTcu3YQJNkKZQ3F",
  "GHCLa7oMUZo7qTwV8YH5RrPJGHG7z9sZ3y19dAAsgE2e",
  "GzQCM1DLMDXkbX85kVB2Un12aKc62ZRN5RdKGjqnNsbX",
  "XxCeVcNDHqEuB7GDx6zMPKN5iwvskPYAJgpy51TLuy6",

  // 2026-07-29: full retirement of every market in the database — see the
  // matching note in lib/blocklist.ts. These rows were also deleted from the DB
  // and are blocked in percolator-indexer/src/blocklist.ts so discovery cannot
  // re-register them.
  "5kSw1fX8Ps2kBkVU4bc1qHgUQ8AKFXHkqoq2u2ztcdJs",

  // ── 2026-07-29: the two launch-verification markets ──
  // Created while proving the devnet-2.0 launch path end to end. Both are real,
  // funded, wrapper-owned markets, but both were seeded with insurance = 0: the
  // step-4 idempotency check mistook the backing-bucket collateral for the
  // insurance seed and skipped TopUpInsurance entirely (tag 9 appears in none of
  // their launch transactions). Insurance is written once at creation and is the
  // layer that absorbs losses before the LP, so these cannot be repaired into
  // the shape a real market should have — retire them and launch fresh.
  "H9ey1RBnVoBBit2o7EUCPZWJLMNtQpuA6QiqGmM95ZJ4",  // FRANK
  "4hJ9hUotH6BwUXVmgLGmXWHfg3YLjnmA8fwAtjex3wBU",  // Percolator

  // ── 2026-07-30 clean slate: every market still live on the current wrapper ──
  // None had a creator-written row: POST /api/markets sent oracle_mode='keeper'
  // into a column whose CHECK accepts only pyth|hyperp|admin, so that write
  // failed on every keeper-oracle launch and the indexer's placeholder is all
  // that ever existed. Relaunch on the fixed path rather than repair them.
  "5sDvEs2Zwn42ESkAmQm6Ycvi1XC3X8zHhhTDX1FX3hT7",  // Fauci
  "5xRkBU83ogswJnjzqMb1a2M41NczMzyajSLvrVAsAG9Z",  // ZERO
  "3bGWBK25iHH4FusT2c7JS7VjKxghtEHLWxXpLQarwRf3",  // TripleT-PERP
  "2DDBehzGAKJPzwZXZ9HbcHBEtdkoHPRPaGBDjMCqSAUv",  // unnamed
  "FaNFCmyputbCTvSGGmxe7EU1DyjagtGKf6eYPDTvmdFC",  // unnamed
  "6RobABa7gpPvN8WsoQuXgbKKinpURwGXzUS4NJiYNaPR",  // unnamed
]);
