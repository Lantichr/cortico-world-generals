import { describe, expect, it } from 'vitest';
import { MoveExecutor } from '../../src/agent/executor.ts';

function fixture() {
  const packets: unknown[][] = [];
  let failNext = false;
  let time = '2026-01-01T00:00:00.000Z';
  const executor = new MoveExecutor((name, ...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('transport unavailable');
    }
    packets.push([name, ...args]);
  }, () => time);
  return {
    executor,
    packets,
    fail: () => { failNext = true; },
    at: (value: string) => { time = value; },
  };
}

describe('MoveExecutor', () => {
  it('successful moves use consecutive indexes, and server progress only advances the next index', () => {
    const { executor, packets } = fixture();
    expect(executor.move({ from: 0, to: 1, half: false }, 10)).toBe(1);
    expect(executor.move({ from: 1, to: 2, half: true }, 11)).toBe(2);
    executor.onUpdate(7);
    expect(executor.move({ from: 2, to: 3, half: false }, 12)).toBe(8);
    executor.onUpdate(1);
    expect(executor.move({ from: 3, to: 4, half: false }, 13)).toBe(9);
    expect(packets).toEqual([
      ['attack', 0, 1, false, 1],
      ['attack', 1, 2, true, 2],
      ['attack', 2, 3, false, 8],
      ['attack', 3, 4, false, 9],
    ]);
    expect(executor.lastMove).toEqual({ sentAt: '2026-01-01T00:00:00.000Z', observedTurn: 13, attackIndex: 9 });
  });

  it('invalid server indexes leave the next move index unchanged', () => {
    const { executor, packets } = fixture();
    for (const invalid of [null, undefined, '12', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) executor.onUpdate(invalid);
    expect(executor.move({ from: 0, to: 1, half: false }, 1)).toBe(1);
    expect(packets).toEqual([['attack', 0, 1, false, 1]]);
  });

  it('a failed send neither consumes an index nor replaces the last successful move', () => {
    const { executor, packets, fail, at } = fixture();
    executor.move({ from: 0, to: 1, half: false }, 10);
    const previous = executor.lastMove;
    const previousDisplay = executor.display();
    at('2026-01-01T00:00:01.000Z');
    fail();
    expect(() => executor.move({ from: 1, to: 2, half: false }, 11)).toThrow('transport unavailable');
    expect(executor.lastMove).toBe(previous);
    expect(executor.display()).toEqual(previousDisplay);
    expect(executor.move({ from: 1, to: 2, half: false }, 12)).toBe(2);
    expect(packets).toEqual([['attack', 0, 1, false, 1], ['attack', 1, 2, false, 2]]);
    expect(executor.lastMove).toEqual({ sentAt: '2026-01-01T00:00:01.000Z', observedTurn: 12, attackIndex: 2 });
  });

  it('clear records a request without claiming acknowledgement or resetting the move index', () => {
    const { executor, packets, at } = fixture();
    executor.move({ from: 0, to: 1, half: false }, 10);
    const sent = executor.lastMove;
    at('2026-01-01T00:00:01.000Z');
    executor.clear(11);
    expect(executor.lastMove).toBe(sent);
    expect(executor.lastClearRequest).toEqual({
      sentAt: '2026-01-01T00:00:01.000Z', observedTurn: 11, lastSentAttackIndex: 1,
    });
    expect(executor.move({ from: 1, to: 2, half: true }, 12)).toBe(2);
    expect(executor.lastClearRequest?.lastSentAttackIndex).toBe(1);
    expect(packets).toEqual([['attack', 0, 1, false, 1], ['clear_moves'], ['attack', 1, 2, true, 2]]);
  });

  it('clear before any map or move records unknown turn and no sent move, and failures preserve the previous request', () => {
    const { executor, packets, fail, at } = fixture();
    executor.clear(null);
    expect(executor.lastClearRequest).toEqual({
      sentAt: '2026-01-01T00:00:00.000Z', observedTurn: null, lastSentAttackIndex: null,
    });
    const previous = executor.lastClearRequest;
    at('2026-01-01T00:00:01.000Z');
    fail();
    expect(() => executor.clear(2)).toThrow('transport unavailable');
    expect(executor.lastClearRequest).toBe(previous);
    expect(packets).toEqual([['clear_moves']]);
    expect(executor.move({ from: 0, to: 1, half: false }, 3)).toBe(1);
  });

  it('reset clears game-local receipts and starts a fresh index sequence', () => {
    const { executor, packets } = fixture();
    executor.onUpdate(40);
    executor.move({ from: 0, to: 1, half: false }, 100);
    executor.clear(101);
    executor.reset();
    expect(executor.lastMove).toBeNull();
    expect(executor.lastClearRequest).toBeNull();
    expect(executor.display()).toEqual({ selected: null, moves: [] });
    expect(executor.move({ from: 3, to: 4, half: true }, 1)).toBe(1);
    expect(packets).toEqual([['attack', 0, 1, false, 41], ['clear_moves'], ['attack', 3, 4, true, 1]]);
  });

  it('displays multiple submitted batches until processing advances while the cursor stays at the latest destination', () => {
    const { executor } = fixture();
    expect(executor.display()).toEqual({ selected: null, moves: [] });
    executor.move({ from: 0, to: 1, half: true }, 10);
    executor.move({ from: 1, to: 2, half: false }, 10);
    executor.move({ from: 8, to: 9, half: true }, 12);
    const submitted = [
      { from: 0, to: 1, half: true, attackIndex: 1 },
      { from: 1, to: 2, half: false, attackIndex: 2 },
      { from: 8, to: 9, half: true, attackIndex: 3 },
    ];
    expect(executor.display()).toEqual({ selected: { index: 9, half: false }, moves: submitted });
    executor.onUpdate(0);
    expect(executor.display().moves).toEqual(submitted);
    executor.onUpdate(1);
    expect(executor.display()).toEqual({ selected: { index: 9, half: false }, moves: submitted.slice(1) });
    for (const invalid of [null, '3', -1, 1.5, NaN, Infinity]) executor.onUpdate(invalid);
    expect(executor.display().moves).toEqual(submitted.slice(1));
    executor.onUpdate(3);
    executor.onUpdate(1);
    expect(executor.display()).toEqual({ selected: { index: 9, half: false }, moves: [] });
  });

  it('returns independent display snapshots that cannot change submitted movements or the cursor', () => {
    const { executor } = fixture();
    const move = { from: 4, to: 5, half: true };
    executor.move(move, 10);
    move.to = 20;
    const display = executor.display();
    display.selected!.index = 30;
    display.moves[0].to = 40;
    display.moves.length = 0;
    expect(executor.display()).toEqual({ selected: { index: 5, half: false },
      moves: [{ from: 4, to: 5, half: true, attackIndex: 1 }] });
  });

  it('clears the local display only after a successful clear request and reset clears a populated ledger', () => {
    const { executor, fail } = fixture();
    executor.move({ from: 4, to: 5, half: false }, 10);
    const submitted = executor.display();
    fail();
    expect(() => executor.clear(11)).toThrow('transport unavailable');
    expect(executor.display()).toEqual(submitted);
    executor.clear(12);
    expect(executor.display()).toEqual({ selected: null, moves: [] });
    expect(executor.lastClearRequest?.lastSentAttackIndex).toBe(1);
    expect(executor.move({ from: 9, to: 10, half: true }, 13)).toBe(2);
    expect(executor.display().moves).toEqual([{ from: 9, to: 10, half: true, attackIndex: 2 }]);
    executor.reset();
    expect(executor.display()).toEqual({ selected: null, moves: [] });
  });
});
