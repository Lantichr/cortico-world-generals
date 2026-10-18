import type { AgentTile } from '../agent/contracts.ts';

/** Read-only display of the current server view and locally submitted actions. */
export interface GeneralsViewerSnapshot {
  phase: string;
  connected: boolean;
  control: 'manual' | 'autonomous';
  paused: boolean;
  turn: number | null;
  playerIndex: number | null;
  board: { width: number; height: number; tiles: AgentTile[] } | null;
  players: Array<{
    index: number;
    name: string;
    color: number | null;
    total: number | null;
    tiles: number | null;
    dead: boolean;
  }>;
  /** Equivalent local cursor: the destination of the latest submitted move. */
  selected: { index: number; half: boolean } | null;
  /** Locally sent moves awaiting a reported processing index; execution is not established. */
  queuedMoves: Array<{ from: number; to: number; half: boolean; attackIndex: number }>;
  /** Plans are recomputed every turn; only queuedMoves have been submitted. */
  plan: { routes: Array<{ path: number[]; half: boolean }>; nextStepOnly: boolean } | null;
}
