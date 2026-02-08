# Percolator (Solana Program)

> **⚠️ DISCLAIMER: FOR EDUCATIONAL PURPOSES ONLY**
>
> This code has **NOT been audited**. Do NOT use in production or with real funds. This is experimental software provided for learning and testing purposes only. Use at your own risk.

Percolator is a minimal Solana program that wraps the `percolator` crate's `RiskEngine` inside a single on-chain **slab** account and exposes a small, composable instruction set for deploying and operating perpetual markets.

This README is intentionally **high-level**: it explains the trust model, account layout, operational flows, and the parts that are easy to get wrong (CPI binding, nonce discipline, oracle usage, and gating). It does **not** restate code structure or obvious Rust/Solana boilerplate.

---

## Table of contents

- [Concepts](#concepts)
- [Trust boundaries](#trust-boundaries)
- [Account model](#account-model)
- [Instruction overview](#instruction-overview)
- [Matcher CPI model](#matcher-cpi-model)
- [Risk-reduction gating and auto-threshold](#risk-reduction-gating-and-auto-threshold)
- [Operational runbook](#operational-runbook)
- [Deployment flow](#deployment-flow)
- [Security properties and verification](#security-properties-and-verification)
- [Failure modes and recovery](#failure-modes-and-recovery)
- [Build & test](#build--test)

---

## Concepts

### One market = one slab account
A market is represented by a single **program-owned** account (“slab”) containing:

- **Header**: magic/version/admin + reserved fields (nonce + threshold update slot)
- **MarketConfig**: mint/vault/oracle keys + policy knobs
- **RiskEngine**: stored in-place (zero-copy)

Benefits:
- one canonical state address per market (simple address model)
- deterministic, auditable layout
- easy snapshotting / archival
- minimizes CPI/state scattering

### Two trade paths
- **TradeNoCpi**: no external matcher; used for baseline integration, local testing, and deterministic program-test scenarios.
- **TradeCpi**: production path; calls an external matcher program (LP-chosen), validates the returned prefix, then executes the engine trade using the matcher’s `exec_price` / `exec_size`.

---

## Trust boundaries

Percolator enforces three layers with distinct responsibilities:

### 1) `RiskEngine` (trusted core)
- pure accounting + risk checks + state transitions
- **no CPI**
- **no token transfers**
- **no signature/ownership checks**
- relies on Solana transaction atomicity (if instruction fails, state changes revert)

### 2) Percolator program (trusted glue)
- validates account owners/keys and signers
- performs token transfers (vault deposit/withdraw)
- reads oracle prices
- runs optional matcher CPI for `TradeCpi`
- enforces wrapper-level policy (risk-reduction gating / auto-threshold)
- ensures coupling invariants (identity binding, nonce discipline, “use exec_size not requested size”)

### 3) Matcher program (LP-scoped trust)
- provides execution result (`exec_price`, `exec_size`) and “accept/reject/partial” flags
- trusted **only by the LP that registered it**, not by the protocol as a whole
- Percolator treats matcher as adversarial except for LP-chosen semantics and validates strict ABI constraints.

---

## Account model

### Slab account (market state)
- **Owner**: Percolator program id
- **Size**: fixed `SLAB_LEN`
- **Layout**: header + config + aligned `RiskEngine`

Reserved header fields are used for:
- **request nonce**: monotonic `u64` used to bind matcher responses to a specific request
- **last threshold update slot**: rate-limits auto-threshold updates

### Vault token account (market collateral)
- SPL Token account holding collateral for this market
- **Mint**: market collateral mint
- **Owner**: the vault authority PDA

Vault authority PDA:
- seeds: `["vault", slab_pubkey]`

### LP PDA (TradeCpi-only signer identity)
A per-LP PDA is used only as a CPI signer to the matcher.

LP PDA:
- seeds: `["lp", slab_pubkey, lp_idx_le]`
- required **shape constraints**:
  - system-owned
  - empty data
  - unfunded (0 lamports)

This makes it a “pure identity signer” and prevents it from becoming an attack surface.

### Matcher context (TradeCpi)
- account owned by matcher program
- matcher writes its return prefix into the first bytes
- Percolator reads and validates the prefix after CPI

---

## Instruction overview

This section describes intent and operational ordering, not argument-by-argument decoding.

### Market lifecycle
- **InitMarket**
  - initializes slab header/config + constructs `RiskEngine::new(risk_params)`
  - binds vault token account + oracle keys into config
  - initializes nonce + threshold update slot to zero
- **UpdateAdmin**
  - rotates admin key
  - setting admin to all-zeros “burns” governance permanently (admin ops disabled forever)
- **SetRiskThreshold**
  - manual override of `risk_reduction_threshold` (optional if auto-threshold is used)

### Participant lifecycle
- **InitUser**
  - adds a user entry to the engine and binds `owner = signer`
- **InitLP**
  - adds an LP entry, records `(matcher_program, matcher_context)`, binds `owner = signer`
- **DepositCollateral**
  - transfers collateral into vault; credits engine balance for that account
- **WithdrawCollateral**
  - performs oracle-read + engine checks; withdraws from vault via PDA signer; debits engine
- **CloseAccount**
  - settles and withdraws remaining funds (subject to engine rules)

### Risk / maintenance
- **KeeperCrank**
  - permissionless global maintenance entrypoint
  - accrues funding, charges maintenance fees, liquidates stale/unsafe accounts
  - optionally updates risk threshold via auto-threshold policy
- **LiquidateAtOracle**
  - explicit liquidation for a specific target at current oracle
- **TopUpInsurance**
  - transfers collateral into vault; credits insurance fund in engine

### Trading
- **TradeNoCpi**
  - trade without external matcher (used for testing / deterministic scenarios)
- **TradeCpi**
  - trade via LP-chosen matcher CPI with strict binding + validation

---

## Matcher CPI model

Percolator treats a matcher like a price/size oracle **with rules** chosen by the LP, but enforces a hard safety envelope.

### What Percolator enforces (non-negotiable)
- **Signer checks**: user and LP owner must sign
- **LP identity signer**: LP PDA is derived, not provided by the user
- **Matcher identity binding**: matcher program + context must equal what the LP registered
- **Matcher account shape**:
  - matcher program must be executable
  - context must not be executable
  - context owner must be matcher program
  - context length must be sufficient for the return prefix
- **Nonce binding**: response must echo the current request id derived from slab nonce
- **ABI validation**: strict validation of return prefix fields
- **Execution size discipline**: engine trade uses matcher’s `exec_size` (never the user’s requested size)

### What the matcher controls (LP-scoped)
- execution `price` and `size` (including partial fills)
- whether it rejects a trade
- any internal pricing logic, inventory logic, or matching behavior

### ABI validation principles
The matcher return is treated as adversarial input. It must:
- match ABI version
- set `VALID` flag
- not set `REJECTED` flag
- echo request identifiers and fields (LP account id, oracle price, req_id)
- have reserved/padding fields set to zero
- enforce size constraints (`|exec_size| <= |req_size|`, sign match when req_size != 0)
- handle `i128::MIN` safely via `unsigned_abs`/`unsigned_abs()` semantics (no `.abs()` panics)

---

## Risk-reduction gating and auto-threshold

### Why gating exists
When the system is under-insured, the wrapper can enforce “risk-reduction-only” trades to reduce griefing/DoS and protect the insurance fund from adversarial volatility.

### Activation condition
Gating is active when:
- `threshold > 0` **and**
- `insurance_balance <= threshold`

When active:
- **risk-increasing** trades are rejected
- risk-reducing trades are allowed

### Risk metric (wrapper-level)
Percolator computes a deterministic system risk metric from LP exposure:
- one O(n) scan to compute aggregate LP risk state
- O(1) delta check to decide whether a proposed LP delta increases risk
- conservative behavior when the max-position LP shrinks (overestimates risk rather than underestimates)

### Auto-threshold update (KeeperCrank)
Threshold can be updated by KeeperCrank (rate-limited + smoothed):
- update at most once per `THRESH_UPDATE_INTERVAL_SLOTS`
- compute target from risk units * oracle price
- apply EWMA smoothing
- apply step clamp to prevent sudden threshold jumps
- clamp to `[THRESH_MIN, THRESH_MAX]`

This policy is intentionally outside the engine so the engine remains a clean state machine.

---

## Operational runbook

### Who runs what?
- **Users / LPs**: init + deposits + trades
- **Keepers (permissionless)**: call `KeeperCrank` regularly
- **Admin**: may set threshold / rotate admin (unless burned)

### KeeperCrank cadence
Run `KeeperCrank` often enough to satisfy engine freshness rules:
- engine may enforce staleness bounds (e.g., `max_crank_staleness_slots`)
- in stressed markets, higher cadence reduces liquidation latency and funding drift

A typical ops approach:
- a keeper bot that calls `KeeperCrank` every N slots (or every M seconds) and retries on failure
- alerting on prolonged inability to crank (errors, oracle stale, account issues)

### Monitoring checklist
At minimum, monitor:
- insurance fund balance (and whether gating is active)
- total open interest / LP exposure concentration
- crank success rate + last successful crank slot
- oracle freshness (age vs max staleness) and confidence filter failures
- rejection rates for TradeCpi (ABI failures, identity mismatch, PDA mismatch)
- liquidation frequency spikes

### Governance / admin handling
- rotating admin changes who can:
  - set manual risk threshold
  - rotate admin again
- burning admin (setting to all zeros) is irreversible and disables admin ops forever

---

## Deployment flow

### Step 0: Create accounts off-chain
Create:
1) **Slab** account
   - owner: Percolator program id
   - size: `SLAB_LEN`
2) **Vault SPL token account**
   - mint: collateral mint
   - owner: vault authority PDA derived from `["vault", slab_pubkey]`

### Step 1: InitMarket
Call `InitMarket` with:
- admin signer
- slab (writable)
- mint + vault
- oracle pubkeys
- staleness/conf filter params
- `RiskParams` (warmup, margins, fees, liquidation knobs, crank staleness, etc.)

### Step 2: Onboard LPs and users
- LP:
  - deploy or choose matcher program
  - create matcher context account owned by matcher program
  - call `InitLP(matcher_program, matcher_context, fee_payment)`
  - deposit collateral
- User:
  - `InitUser(fee_payment)`
  - deposit collateral

### Step 3: Fund insurance
Call `TopUpInsurance` as needed.

### Step 4: Start keepers
Run `KeeperCrank` continuously.

### Step 5: Enable trading
- Use `TradeNoCpi` for local testing or deterministic environments
- Use `TradeCpi` for production execution via matcher CPI

---

## Security properties and verification

Percolator’s security model is “engine correctness + wrapper enforcement”.

### Wrapper-level properties (Kani-proven)
Kani harnesses are designed to prove program-level coupling invariants, including:

- matcher ABI validation rejects malformed/malicious returns
- owner/signer enforcement
- admin authorization + burned admin handling
- CPI identity binding (matcher program/context must match LP registration)
- matcher account shape validation
- PDA key mismatch rejection
- nonce monotonicity (unchanged on reject, +1 on accept)
- CPI uses `exec_size` (never requested size)
- i128 edge cases (`i128::MIN`) do not panic and are validated correctly

> Note: Kani does not model full CPI execution or internal engine accounting; it targets wrapper security properties and binding logic.

### Engine properties
Engine-specific invariants (conservation, warmup, liquidation properties, etc.) live in the `percolator` crate’s verification suite. The program relies on engine correctness but does not restate it.

---

## Failure modes and recovery

### Common rejection causes (TradeCpi)
- matcher identity mismatch (LP registered different program/context)
- bad matcher shape (non-executable program, executable ctx, wrong ctx owner, short ctx)
- LP PDA mismatch / wrong PDA shape
- ABI prefix invalid (flags, echoed fields, reserved bytes, size constraints)
- gating active + risk-increasing trade

These are expected and should be treated as **hard safety rejections**, not transient errors.

### Oracle failures
- stale price (age > max staleness)
- confidence too wide (conf filter)

Recovery:
- wait for oracle updates
- adjust market config (if governance allows)
- ensure keepers are running so freshness rules remain satisfied

### Admin burned
Once admin is burned (all zeros), admin ops are permanently disabled.
Recovery is “by design impossible” (this is a one-way governance lock).

---

## Build & test

```bash
# unit tests / program-test style
cargo test

# Kani harnesses (requires kani toolchain)
cargo kani --tests
```

---

## Devnet Deployments

### Programs

| Program | Address |
|---------|---------|
| Percolator | `46iB4ET4WpqfTXAqGSmyBczLBgVhd1sHre93KtU3sTg9` |
| vAMM Matcher | `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy` |

### Test Market (SOL Perp)

| Account | Address |
|---------|---------|
| Market Slab | `AcF3Q3UMHqx2xZR2Ty6pNvfCaogFmsLEqyMACQ2c4UPK` |
| Vault | `D7QrsrJ4emtsw5LgPGY2coM5K9WPPVgQNJVr5TbK7qtU` |
| Vault PDA | `37ofUw9TgFqqU4nLJcJLUg7L4GhHYRuJLHU17EXMPVi9` |
| Matcher Context | `Gspp8GZtHhYR1kWsZ9yMtAhMiPXk5MF9sRdRrSycQJio` |
| Collateral | Native SOL (wrapped) |

### Test Market Configuration

- **Maintenance margin**: 5% (500 bps)
- **Initial margin**: 10% (1000 bps)
- **Trading fee**: 0.1% (10 bps)
- **Liquidation fee**: 0.5% (50 bps)
- **Admin Oracle**: Prices pushed via `PushOraclePrice` instruction

### Using the Devnet Market

1. **Create user account**: Call `InitUser` with your wallet
2. **Deposit collateral**: Call `DepositCollateral` with wrapped SOL
3. **Trade**: Call `TradeNoCpi` with LP index 0 and your user index
4. **Check state**: Run `KeeperCrank` permissionlessly

Example with CLI (see `percolator-cli/`):
```bash
cd ../percolator-cli
npx tsx tests/t22-devnet-stress.ts
```

These addresses are deployed on Solana **devnet**.