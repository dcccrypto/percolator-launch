# Wrapper error table, 7a3ac04c (DERIVED)

Derived for the app's generator, not a gate-agent table: the rows of `error-codes-592286b4-derived.md`
unchanged, plus 91, which percolator-prog `7a3ac04c` appends (`fix/matcher-inventory-sync`, merge of
the non-bound NAV floor `fdf07759`: `LpVaultTargetPotImpaired`, a non-bound Earn deposit routed into
a pot whose net impairment exceeds its principal). Ordinals 0-90 are identical: rustc at `7a3ac04c`
(percolator-sdk `scripts/wrapper-errors/gen.py`, `PercolatorError::X as u32` for every variant)
prints 92 codes, 0-90 byte-equal to the 592286b4/5544302a set. The generator refuses to write
unless this table equals `allErrors` in `__tests__/fixtures/limits/rust-p3-final.json`
(`allErrorsSha` = 7a3ac04c).

| Engine variant | Custom(n) |
|---|---:|
| `V16Error::InvalidConfig` | 14 |
| `V16Error::ArithmeticOverflow` | 15 |
| `V16Error::ProvenanceMismatch` | 16 |
| `V16Error::HiddenLeg` | 17 |
| `V16Error::InvalidLeg` | 18 |
| `V16Error::Stale` | 19 |
| `V16Error::BStale` | 20 |
| `V16Error::LockActive` | 21 |
| `V16Error::NonProgress` | 22 |
| `V16Error::RecoveryRequired` | 23 |
| `V16Error::CounterOverflow` | 24 |
| `V16Error::CounterUnderflow` | 25 |
| `V16Error::InsufficientInitialMargin` | 49 |
| `V16Error::LpVaultZeroSharesMinted` | 41 |

| Custom(n) | Hex | PercolatorError | Engine V16Error mapped here | Source line | Meaning (from the doc comment) |
|---:|---|---|---|---:|---|
| 0 | 0x0 | `InvalidMagic` |  | 964 |  |
| 1 | 0x1 | `InvalidVersion` |  | 965 |  |
| 2 | 0x2 | `AlreadyInitialized` |  | 966 |  |
| 3 | 0x3 | `NotInitialized` |  | 967 |  |
| 4 | 0x4 | `InvalidAccountKind` |  | 968 |  |
| 5 | 0x5 | `InvalidAccountLen` |  | 969 |  |
| 6 | 0x6 | `ExpectedSigner` |  | 970 |  |
| 7 | 0x7 | `ExpectedWritable` |  | 971 |  |
| 8 | 0x8 | `Unauthorized` |  | 972 |  |
| 9 | 0x9 | `InvalidInstruction` |  | 973 |  |
| 10 | 0xa | `InvalidMint` |  | 974 |  |
| 11 | 0xb | `InvalidTokenAccount` |  | 975 |  |
| 12 | 0xc | `InvalidVaultAccount` |  | 976 |  |
| 13 | 0xd | `InvalidTokenProgram` |  | 977 |  |
| 14 | 0xe | `EngineInvalidConfig` | `InvalidConfig` | 978 |  |
| 15 | 0xf | `EngineArithmeticOverflow` | `ArithmeticOverflow` | 979 |  |
| 16 | 0x10 | `EngineProvenanceMismatch` | `ProvenanceMismatch` | 980 |  |
| 17 | 0x11 | `EngineHiddenLeg` | `HiddenLeg` | 981 |  |
| 18 | 0x12 | `EngineInvalidLeg` | `InvalidLeg` | 982 |  |
| 19 | 0x13 | `EngineStale` | `Stale` | 983 |  |
| 20 | 0x14 | `EngineBStale` | `BStale` | 984 |  |
| 21 | 0x15 | `EngineLockActive` | `LockActive` | 985 |  |
| 22 | 0x16 | `EngineNonProgress` | `NonProgress` | 986 |  |
| 23 | 0x17 | `EngineRecoveryRequired` | `RecoveryRequired` | 987 |  |
| 24 | 0x18 | `EngineCounterOverflow` | `CounterOverflow` | 988 |  |
| 25 | 0x19 | `EngineCounterUnderflow` | `CounterUnderflow` | 989 |  |
| 26 | 0x1a | `OracleInvalid` |  | 990 |  |
| 27 | 0x1b | `OracleStale` |  | 991 |  |
| 28 | 0x1c | `OracleConfTooWide` |  | 992 |  |
| 29 | 0x1d | `InvalidOracleKey` |  | 993 |  |
| 30 | 0x1e | `LpVaultAlreadyExists` |  | 997 | Custom(30) |
| 31 | 0x1f | `LpVaultNotFound` |  | 998 | Custom(31) |
| 32 | 0x20 | `LpVaultPaused` |  | 999 | Custom(32) |
| 33 | 0x21 | `LpVaultSharesOutstanding` |  | 1000 | Custom(33) |
| 34 | 0x22 | `LpVaultZeroAmount` |  | 1001 | Custom(34) |
| 35 | 0x23 | `LpVaultInsufficientShares` |  | 1002 | Custom(35) |
| 36 | 0x24 | `LpVaultCooldownActive` |  | 1003 | Custom(36) |
| 37 | 0x25 | `LpVaultOiReservationViolated` |  | 1004 | Custom(37) |
| 38 | 0x26 | `LpVaultNoFeesToCrank` |  | 1005 | Custom(38) |
| 39 | 0x27 | `LpVaultSupplyMismatch` |  | 1006 | Custom(39) |
| 40 | 0x28 | `LpVaultAuthorityMismatch` |  | 1007 | Custom(40) |
| 41 | 0x29 | `LpVaultZeroSharesMinted` | `LpVaultZeroSharesMinted` | 1008 | Custom(41) |
| 42 | 0x2a | `NftRegistryNotFound` |  | 1010 | Custom(42) |
| 43 | 0x2b | `NftPortfolioNotTransferable` |  | 1011 | Custom(43) |
| 44 | 0x2c | `NftTransferSelfOrZero` |  | 1012 | Custom(44) |
| 45 | 0x2d | `NftInvalidMintAuthority` |  | 1013 | Custom(45) |
| 46 | 0x2e | `NftPortfolioProvenance` |  | 1014 | Custom(46) |
| 47 | 0x2f | `InsuranceWithdrawCooldownActive` |  | 1017 | Custom(47) — F-1: cooldown not elapsed |
| 48 | 0x30 | `InsuranceWithdrawCeilingExceeded` |  | 1018 | Custom(48) — F-2: deposits-only ceiling exceeded |
| 49 | 0x31 | `EngineInsufficientInitialMargin` | `InsufficientInitialMargin` | 1025 | Equity fell below the initial-margin requirement for the requested action. Previously collapsed into EngineInvalidConfig (0xe), now surfaced … |
| 50 | 0x32 | `LpVaultDepositBelowMinimumLiquidity` |  | 1036 | The LP vault's TRUE first deposit (`registry.total_lp_shares_outstanding == 0` before this call) must exceed `LP_VAULT_MINIMUM_LIQUIDITY` so a … |
| 51 | 0x33 | `FeeSplitFloorViolation` |  | 1053 | `UpdateFeeSplit` (tag 86) shares violate the non-protocol-remainder floors: `creator > MAX_CREATOR_SHARE_BPS`, `lp < MIN_LP_SHARE_BPS`, or … |
| 52 | 0x34 | `FeeSplitSumInvalid` |  | 1059 | `UpdateFeeSplit` shares do not sum to exactly `FEE_SHARE_TOTAL_BPS` (= 10_000 - PROTOCOL_FEE_BPS). SDK agent: add `FeeSplitSumInvalid = 52` to the … |
| 53 | 0x35 | `NoInsuranceReserveToClaim` |  | 1063 | `WithdrawInsuranceReserveToStake` called with nothing available (`insurance_reserve_accrued == insurance_reserve_withdrawn`). SDK agent: add … |
| 54 | 0x36 | `StakePoolNotBound` |  | 1073 | Asset 0's `insurance_authority` is still zero: no stake pool has ever been bound to this market, so no staker constituency is owed the insurance … |
| 55 | 0x37 | `StakePoolOwnerMismatch` |  | 1090 | The supplied stake-pool account is not owned by the pinned `constants::STAKE_PROGRAM_ID`. THIS IS THE FORGERY GATE: it is checked before any byte … |
| 56 | 0x38 | `StakePoolAuthorityMismatch` |  | 1094 | `["vault_auth", pool]` derived under the pool account's owning program does not equal the bound `insurance_authority`. The supplied pool is not … |
| 57 | 0x39 | `StakePoolMarketMismatch` |  | 1096 | The pool's own stored `slab` does not name this market. |
| 58 | 0x3a | `StakePoolWrapperMismatch` |  | 1099 | The pool's stored `percolator_program` (its CPI target) is not this wrapper deployment. |
| 59 | 0x3b | `StakePoolModeMismatch` |  | 1103 | The pool is not in insurance-LP mode (`pool_mode != 0`). Trading-mode pools carry no `FlushToInsurance` loss exposure, so they are not owed this leg. |
| 60 | 0x3c | `StakeProgramNotPinned` |  | 1109 | This build has no pinned stake program id, so tag 87 has no destination it is willing to trust and refuses to move tokens. Emitted by every … |
| 61 | 0x3d | `AssetSlotAlreadyConfigured` |  | 1127 | `UpdateAssetLifecycle(ACTIVATE)` named an asset slot that is BELOW `max_market_slots` and is already configured and live (lifecycle Active / … |
| 62 | 0x3e | `CreatorFeeOverClaim` |  | 1146 | `WithdrawCreatorFee` (tag 90) asked for more atoms than `WrapperConfigV16::creator_fee_claimable_atoms` currently holds. This is a CALLER error … |
| 63 | 0x3f | `LpVaultBackingBucketNotEmpty` |  | 1160 | CreateLpVault targeted a domain whose backing bucket is ALREADY funded at an expiry that is not `LP_VAULT_BACKING_EXPIRY_SLOT`. Range was checked … |
| 64 | 0x40 | `RentExemptRequired` |  | 1179 | Sync unit W2-S1b (ADOPT upstream `d57411f8`, "prevent whole-market address reuse"). `handle_close_slab`'s tail must retain at least … |
| 65 | 0x41 | `AssetGenerationMismatch` |  | 1193 | A caller-supplied `market_id`/`expected_market_id`/`asset_generation_frontier` param did not match the asset slot's (or market's) current … |
| 66 | 0x42 | `ExecPriceOutsideOracleBand` |  | 1201 | Item 1: a matcher-reported fill price (TradeCpi / BatchTradeCpi) lies outside `reference +- band`, reference = the `oracle_price_e6` the wrapper … |
| 67 | 0x43 | `SameOwnerTrade` |  | 1205 | Item 2 (TradeCpi / BatchTradeCpi): the taker's portfolio owner equals the matcher LP's portfolio owner, or equals the traded asset's `asset_admin` … |
| 68 | 0x44 | `LpExposureCapExceeded` |  | 1208 | Item 3: a matcher-routed fill would leave the LP's \|position\| x mark above `k x LP initial-margin equity` on the traded asset. |
| 69 | 0x45 | `LpFloorHalt` |  | 1212 | Item 5: auto-halt. The matcher LP's initial-margin equity is at or below the protocol floor, so risk-increasing fills against it are refused … |
| 70 | 0x46 | `ProtocolSideOiCapExceeded` |  | 1214 | Item 3: the protocol-set per-asset side-OI cap (tag 93) would be exceeded. |
| 71 | 0x47 | `CloseSlabFeesOutstanding` |  | 1218 | F4: CloseSlab refused because protocol / creator / LP / staker fee legs are still owed. Claim them (tags 84, 90) and sweep the staker leg (tag 87, … |
| 72 | 0x48 | `VaultLpAlreadyBound` |  | 1222 | InitVaultLp on a vault (or asset) that already has a bound vault LP. |
| 73 | 0x49 | `VaultLpNotBound` |  | 1224 | A vault-LP instruction on a vault with no bound vault LP. |
| 74 | 0x4a | `VaultLpSeniorImpaired` |  | 1227 | Earn deposit refused: the senior tranche is impaired (vault value < senior claim). New money would otherwise buy into a loss the junior did not cover. |
| 75 | 0x4b | `VaultLpJuniorWithdrawRefused` |  | 1230 | Junior withdrawal refused: over the junior surplus minus the floor, or the backing pots do not fully cover the senior claim. |
| 76 | 0x4c | `VaultLpRecallRefused` |  | 1232 | Recall refused: zero, or more than the senior liquidity shortfall. |
| 77 | 0x4d | `VaultLpExclusiveCounterparty` |  | 1234 | A risk-increasing matcher fill against an LP other than the asset's bound vault LP. |
| 78 | 0x4e | `VaultLpLeverageStepDown` |  | 1237 | Leverage step-down: the taker's conservative equity does not cover the crowded-book initial-margin requirement for this fill. |
| 79 | 0x4f | `VaultLpBoundCannotClose` |  | 1239 | CloseLpVault on a vault with a bound vault LP. |
| 80 | 0x50 | `VaultLpExposureCapExceeded` |  | 1242 | P3-H2: a vault-LP fill would leave \|vault LP position\| * mark above the protocol leverage cap on its conservative equity … |
| 81 | 0x51 | `VaultLpMatcherNotApproved` |  | 1245 | P3-H2: VaultLpSetMatcher with a matcher program the protocol has not approved for this asset (tag 99), or with an unbounded (0) max_fill_abs / … |
| 82 | 0x52 | `VaultLpUseSettleResolved` |  | 1249 | P3-H1: CloseResolved (30) / ClaimResolvedPayoutTopup (46) on a vault LP portfolio. Its owner is the registry PDA; use VaultLpSettleResolved (101), … |
| 83 | 0x53 | `VaultLpReleaseRefused` |  | 1252 | P3-M1: VaultLpReleaseSurplus of zero or of more than the backing surplus over the senior claim (`nav - C`). |
| 84 | 0x54 | `VaultLpHarvestPending` |  | 1256 | P3-L1: a genesis Earn deposit (no shares yet) while LP fees are still harvestable. Crank tag 78 first (on a bound vault with no senior shares it … |
| 85 | 0x55 | `VaultLpValuationStale` |  | 1259 | P3-L2: the vault LP holds inventory and its health certificate is not current, so the vault cannot be valued. Prepend a permissionless crank (tag … |
| 86 | 0x56 | `VaultLpMultiAssetMarket` |  | 1264 | P3 F14-Q2: a vault LP needs a single-ASSET market: binding (94) is refused while another asset has positions or backing, and on a bound market no … |
| 87 | 0x57 | `VaultLpSeniorDrawRequired` |  | 1268 | P3 senior draw: an engine step would open a bankrupt close on the vault LP (winners haircut) while the vault's own pots can still fund the … |
| 88 | 0x58 | `VaultLpRedeemNeedsRecall` |  | 1272 | P3 B24: a senior redemption on a LIVE bound vault needs more than the chosen pot holds, because part of the senior value sits in the vault LP's … |
| 89 | 0x59 | `VaultLpPausedForSeniorDraw` |  | 1277 | P3 senior draw: PAUSED because Earn is covering a vault-LP loss (a senior draw is pending or outstanding). Halts the vault LP's risk-increasing … |
| 90 | 0x5a | `VaultLpBindRequiresFlatAsset` | | | |
| 91 | 0x5b | `LpVaultTargetPotImpaired` | | | 7a3ac04c (fdf07759): NON-BOUND Earn deposit (75) into a pot whose net impairment exceeds its principal; deposit to the sibling pot. |
