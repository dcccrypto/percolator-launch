/**
 * The order ticket's Close-tab copy for a position that is wrapped as an NFT. Kept in its own
 * module so OrderTicketClosePanel does not import PositionNftMenu (and its send/wrap modals)
 * just for two strings. PositionNftMenu's NFT_MENU_COPY re-exports these, so the text has one source.
 */
export const NFT_CLOSE_COPY = {
  /** The order ticket's Close tab when this market's position is wrapped (the ticket can't close it). */
  closeTabTitle: "Position wrapped as an NFT",
  closeTabBody: (side: "long" | "short") =>
    `Your ${side} on this market is held in a Position NFT, so it can't be closed here. Unwrap it from the ⋯ menu on its row in Positions, then close it.`,
} as const;

/** The one calm line shown when a stale NFT (earlier incarnation of the portfolio) is asked to be sent. */
export const NFT_STALE_SEND_REFUSED =
  "This NFT belongs to an earlier version of the account and can't be sent. Burn it to reclaim its rent.";
