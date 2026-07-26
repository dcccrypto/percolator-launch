'use client';

/**
 * The LP-vault surface was redesigned from a card grid into a dense, scannable
 * table (see EarnVaultView). The old per-vault card here was repurposed into a
 * selectable table row — `VaultRow`. This module is kept as a thin re-export so
 * any lingering `VaultCard`-path import resolves to the new row.
 */
export { VaultRow, VAULT_GRID_COLS } from './VaultRow';
