// Chess-specific glue between a chess result and the generic money
// escrow (escrow.ts). The escrow knows nothing about chess; these two
// helpers are the entire chess→money mapping:
//   - which side a finished game pays,
//   - the payout split (winner takes the pot; a draw refunds each
//     side its deposit).
// Everything else (collecting buy-ins, proposing/watching the payout)
// is generic and lives in EscrowState.

import type { ChessGameStatus } from "./chess.js";
import type { EscrowAccount, EscrowPayout } from "./escrow.js";

export type WagerSide = "white" | "black";

/** Map a finished chess status onto who the pot goes to. null while the
 *  game is still active. Exported so the client renders the same verdict
 *  the relay settles on. */
export function winnerFromChessStatus(status: ChessGameStatus): WagerSide | "draw" | null {
  switch (status) {
    case "white_won":
    case "black_resigned":
      return "white";
    case "black_won":
    case "white_resigned":
      return "black";
    case "draw_stalemate":
    case "draw_threefold":
    case "draw_insufficient":
    case "draw_other":
      return "draw";
    case "active":
    default:
      return null;
  }
}

/** The settlement plan for a finished chess wager. Winner takes the whole
 *  escrowed pot; a draw returns each side its own deposit. Amounts come
 *  from actual deposits, so this is correct even if a buy-in was topped
 *  up. */
export function chessPayouts(white: EscrowAccount, black: EscrowAccount, winner: WagerSide | "draw"): EscrowPayout[] {
  if (winner === "draw") {
    return [
      { to: white.key, amountWei: white.depositedWei },
      { to: black.key, amountWei: black.depositedWei },
    ];
  }
  const win = winner === "white" ? white : black;
  const pot = (BigInt(white.depositedWei) + BigInt(black.depositedWei)).toString();
  return [{ to: win.key, amountWei: pot }];
}
