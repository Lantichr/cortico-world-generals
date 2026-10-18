import type { Move } from '../moves.ts';

type Send = (name: string, ...args: unknown[]) => void;

/** Both manual and autonomous actions share one ordered transport and attack-index ledger. */
export class MoveExecutor {
  private nextAttackIndex = 1;
  private selected: { index: number; half: boolean } | null = null;
  private displayedMoves: Array<Move & { attackIndex: number }> = [];
  lastMove: { sentAt: string; observedTurn: number; attackIndex: number } | null = null;
  lastClearRequest: { sentAt: string; observedTurn: number | null; lastSentAttackIndex: number | null } | null = null;

  constructor(private readonly send: Send, private readonly timestamp: () => string) {}

  reset(): void {
    this.nextAttackIndex = 1;
    this.selected = null;
    this.displayedMoves = [];
    this.lastMove = null;
    this.lastClearRequest = null;
  }

  onUpdate(attackIndex: unknown): void {
    if (typeof attackIndex === 'number' && Number.isSafeInteger(attackIndex) && attackIndex >= 0) {
      this.nextAttackIndex = Math.max(this.nextAttackIndex, attackIndex + 1);
      this.displayedMoves = this.displayedMoves.filter((move) => move.attackIndex > attackIndex);
    }
  }

  /** The local cursor follows submitted destinations; moves remain until processing is reported or clearing is requested. */
  display(): { selected: { index: number; half: boolean } | null; moves: Array<Move & { attackIndex: number }> } {
    return { selected: this.selected ? { ...this.selected } : null, moves: this.displayedMoves.map((move) => ({ ...move })) };
  }

  move(move: Move, observedTurn: number): number {
    const attackIndex = this.nextAttackIndex;
    this.send('attack', move.from, move.to, move.half, attackIndex);
    this.nextAttackIndex++;
    this.lastMove = { sentAt: this.timestamp(), observedTurn, attackIndex };
    this.displayedMoves.push({ ...move, attackIndex });
    this.selected = { index: move.to, half: false };
    return attackIndex;
  }

  clear(observedTurn: number | null): void {
    this.send('clear_moves');
    this.lastClearRequest = { sentAt: this.timestamp(), observedTurn, lastSentAttackIndex: this.lastMove?.attackIndex ?? null };
    this.selected = null;
    this.displayedMoves = [];
  }
}
