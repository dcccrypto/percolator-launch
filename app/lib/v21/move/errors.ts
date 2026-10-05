/** Calm, honest copy for a Move step that did not go through. Nothing was lost; say what and why. */
import { humanizeError, userFacingMessage } from "@/lib/errorMessages";

export const MOVE_ERR = {
  hlock:
    "This market is in a short protective lock after a large loss, so the vault cannot pay out yet. Nothing is lost. It lifts by itself; come back and this page will pick up here.",
  vaultNotPaying:
    "This vault cannot pay everyone in full right now, because winning traders are owed first. Your balance is safe and the payout opens as positions close. Try again later.",
  declined: "You declined the request in your wallet. Nothing was sent.",
  notLoaded: "That market did not load in time. Nothing was sent. Try again in a moment.",
} as const;

export function safeUserMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|rejected the request|declined/i.test(raw)) return MOVE_ERR.declined;
  if (/market not loaded/i.test(raw)) return MOVE_ERR.notLoaded;
  if (/Custom\(21\)|custom program error: 0x15\b/i.test(raw)) return MOVE_ERR.hlock;
  if (/Custom\(9[0-9]\)|Custom\(11[0-9]\)|VaultPaused|claims/i.test(raw)) return MOVE_ERR.vaultNotPaying;
  return userFacingMessage(e) ?? humanizeError(raw);
}
