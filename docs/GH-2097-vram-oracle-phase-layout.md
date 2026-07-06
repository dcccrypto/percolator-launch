# GH#2097: VRAM vs Oracle Phase Layout Collision

**Issue:** [dcccrypto/percolator-launch#2097](https://github.com/dcccrypto/percolator-launch/issues/2097)  
**Related:** PERC-622 (oracle phase), PERC-8452 (k2_bps layout analysis in percolator-prog)  
**Status:** Dormant in production — VRAM persistence is not enabled; collision triggers only if both subsystems share `_insurance_isolation_padding[4..14]`.

---

## Summary

`_insurance_isolation_padding` bytes `[4..14]` in `MarketConfig` were slated to hold **both**:

1. **Oracle Phase state** (PERC-622): `cumulative_volume`, `phase2_delta_slots`, …
2. **VRAM state**: `ewmv`, `last_vol_price`, `vol_margin_scale_bps`, …

Those byte ranges overlap. Enabling VRAM on any market would corrupt oracle phase tracking; advancing oracle phase would corrupt VRAM state.

---

## Overlapping ranges (buggy packed layout)

| Field | Byte range (in padding) | Width |
|-------|-------------------------|-------|
| `cumul_vol` | `[3..11]` | 8 |
| `ewmv` | `[4..8]` | 4 |
| `last_vol_price` | `[8..12]` | 4 |
| `phase2_delta` | `[11..14]` | 3 |
| `vol_margin_scale` | `[12..14]` | 2 |

Critical overlaps:

- `cumul_vol` ∩ `ewmv` ≠ ∅
- `ewmv` ∩ `last_vol_price` ≠ ∅
- `phase2_delta` ∩ `vol_margin_scale` ≠ ∅

---

## Recommended fix

**Do not pack both subsystems into the same padding window.**

### Option A — Typed fields (preferred)

Follow [PERC-622-oracle-phase-transition-design.md](./PERC-622-oracle-phase-transition-design.md) §4.1: append explicit `MarketConfig` fields for oracle phase (`oracle_phase`, `cumulative_volume_usd_e6`, `phase1_oracle_authority`, …). Place VRAM persistence in a **separate** field block after PERC-8452 reserved space. Expand `CONFIG_LEN` with a coordinated program + SDK migration.

### Option B — Disjoint padding map

If byte packing is unavoidable short-term, use non-overlapping regions inside an expanded padding blob:

```
Bytes 0..15   — Oracle Phase (phase byte, cumulative volume u64, …)
Bytes 16..27  — Oracle metadata (phase2_delta u32, market_created_slot u64)
Bytes 28..41  — VRAM (ewmv, last_vol_price, vol_margin_scale_bps)
```

The layout contract and Vitest guards live in:

- `app/lib/market-config-padding-layout.ts`
- `app/__tests__/lib/gh2097-padding-layout-guards.test.ts`

---

## Implementation checklist (percolator-prog)

- [ ] Remove any raw-byte accessors that alias oracle + VRAM into `_insurance_isolation_padding[4..14]`
- [ ] Wire `get_cumulative_volume` / `set_phase2_delta_slots` to dedicated storage (not stubs)
- [ ] Add `drift_detection` compile-time offset tests mirroring the disjoint map
- [ ] Bump SDK + slab tier builds atomically when `CONFIG_LEN` changes

---

## Risk if unfixed

| Scenario | Outcome |
|----------|---------|
| Enable VRAM on a market | `cumulative_volume` / `phase2_delta` corrupted → wrong phase transitions |
| Advance oracle phase | VRAM EWMA / margin scale corrupted → wrong margin / funding |
| Both active | Mutual destruction of both subsystems' state |

---

## References

- [Issue #2097](https://github.com/dcccrypto/percolator-launch/issues/2097)
- [PERC-622 design](./PERC-622-oracle-phase-transition-design.md)
- [Threat model — VRAM audit](./threat-model.md#vram-audit-results-idle-audit-2026-03-31-0000-utc)
