import { describe, expect, it } from 'vitest';
import { FfaArena } from './ffa-arena.ts';

describe('independent FFA referee', () => {
  it('reinforces its own general once without triggering reciprocal capture', () => {
    const arena = new FfaArena(5, 1, [0, 2, 4]);
    Object.assign(arena.cells[1], { owner: 0, armies: 30 });
    arena.step([{ from: 1, to: 0, half: false }, null, null]);
    expect(arena.cells[1].armies).toBe(1);
    expect(arena.cells[0]).toMatchObject({ owner: 0, general: 0, armies: 30 });
    expect(arena.generals).toEqual([0, 2, 4]);
  });
  it('inherits rounded half garrisons after a capture and continues until the final survivor', () => {
    const arena = new FfaArena(5, 1, [0, 1, 4]);
    arena.cells[0].armies = 20;
    Object.assign(arena.cells[2], { owner: 1, armies: 5 });
    arena.step([{ from: 0, to: 1, half: false }, { from: 2, to: 3, half: false }, null], [0, 1, 2]);
    expect(arena.alive).toEqual([true, false, true]);
    expect(arena.generals[1]).toBe(-1);
    expect(arena.cells[1]).toMatchObject({ owner: 0, city: true, general: null, armies: 18 });
    expect(arena.cells[2]).toMatchObject({ owner: 0, armies: 3 });
    expect(arena.cells[3].owner).toBeNull();
    expect(arena.winner).toBeNull();
    Object.assign(arena.cells[3], { owner: 0, armies: 10 });
    arena.step([{ from: 3, to: 4, half: false }, null, null]);
    expect(arena.winner).toBe(0);
  });

  it('preserves both players after a simultaneous general trade and leaves the third player unchanged', () => {
    const arena = new FfaArena(5, 1, [0, 1, 4]);
    arena.cells[0].armies = 20; arena.cells[1].armies = 10;
    Object.assign(arena.cells[2], { owner: 0, armies: 5 });
    arena.step([{ from: 0, to: 1, half: false }, { from: 1, to: 0, half: false }, null]);
    expect(arena.alive).toEqual([true, true, true]);
    expect(arena.generals).toEqual([1, 0, 4]);
    expect(arena.cells[0]).toMatchObject({ owner: 1, general: 1, armies: 8 });
    expect(arena.cells[1]).toMatchObject({ owner: 0, general: 0, armies: 18 });
    expect(arena.cells[2]).toMatchObject({ owner: 1, armies: 3 });
    expect(arena.cells[4]).toMatchObject({ owner: 2, general: 2, armies: 1 });
    expect(arena.winner).toBeNull();
  });

  it.each([[0, 1, 2], [2, 1, 0]])('resolves a contested third-player general in the supplied order %j', (...order) => {
    const arena = new FfaArena(3, 1, [0, 1, 2]);
    arena.cells[0].armies = 20; arena.cells[2].armies = 20;
    arena.step([{ from: 0, to: 1, half: false }, null, { from: 2, to: 1, half: false }], order);
    expect(arena.alive[1]).toBe(false);
    expect(arena.winner).toBeNull();
    expect(arena.cells[1].owner).toBe(order[0] === 0 ? 2 : 0);
  });
});
