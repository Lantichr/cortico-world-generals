import { describe, expect, it } from 'vitest';
import { GeneralsState } from '../src/state.ts';
import { parseMoves } from '../src/moves.ts';
import { GENERALS_ANALYSIS_LIMITS, parseGatherOptions, planGather } from '../src/planning.ts';
import { simulateMoves } from '../src/simulation.ts';

function game(armies: number[], options: {
  width?: number; turn?: number; terrain?: number[]; generals?: number[]; cities?: number[]; tunnels?: number[];
} = {}) {
  const state = new GeneralsState(0, {});
  const width = options.width ?? armies.length;
  const map = [width, armies.length / width, ...armies, ...(options.terrain ?? armies.map(() => 0)), ...(options.tunnels ?? [])];
  const cities = options.cities ?? [];
  state.update({ turn: options.turn ?? 10, map_diff: [0, map.length, ...map], cities_diff: [0, cities.length, ...cities], generals: options.generals ?? [], scores: [] });
  return state;
}

const gather = (state: GeneralsState, args: Record<string, unknown>) => planGather(state, parseGatherOptions(state, args));

describe('Generals gathering plans', () => {
  it('includes intermediate owned armies and leaves a garrison on each departed tile', () => {
    const state = game([5, 4, 10]);
    const plan = gather(state, { target: 0, maxMoves: 2, sources: [2], targetArmies: 17 });
    expect(plan).toMatchObject({ method: 'greedy_owned_routes', initialArmies: 5, usedMoves: 2, deadlineTurn: 12, armyAtDeadline: 17, metTarget: true });
    const simulated = simulateMoves(state, parseMoves(plan.moves, state.width, state.height));
    expect(simulated.touchedTiles.map((tile) => tile.armies)).toEqual([17, 1, 1]);
    expect(plan.contributions).toEqual([{ source: { x: 2, y: 0 }, moves: 2, addedArmies: 12, arrivalTurn: 12 }]);
  });

  it('spends one common serial budget across sources instead of parallel arrival times', () => {
    const state = game([5, 7, 10, 0, 9, 0], { width: 3, terrain: [0, 0, 0, -2, 0, -2] });
    const plan = gather(state, { target: 0, maxMoves: 3, sources: [2, 4], targetArmies: 28 });
    expect(plan).toMatchObject({ usedMoves: 2, actionEndTurn: 12, deadlineTurn: 13, armyAtDeadline: 20, metTarget: false });
    expect(plan.skipped.counts.budget_exceeded).toBeGreaterThan(0);
  });

  it('recalculates overlapping routes without harvesting the middle garrison twice', () => {
    const state = game([5, 7, 10, 0, 9, 0], { width: 3, terrain: [0, 0, 0, -2, 0, -2] });
    const plan = gather(state, { target: 0, maxMoves: 4, sources: [2, 4] });
    expect(plan).toMatchObject({ usedMoves: 4, armyAtDeadline: 28, metTarget: null });
    expect(plan.contributions.map((entry) => entry.addedArmies)).toEqual([15, 8]);
    const simulation = simulateMoves(state, parseMoves(plan.moves, state.width, state.height));
    expect(simulation.touchedTiles.reduce((sum, tile) => sum + tile.armies!, 0)).toBe(31);
  });

  it('cannot reuse a source after its troops have already reached the target', () => {
    const plan = gather(game([5, 8, 10]), { target: 0, maxMoves: 4, sources: [2] });
    expect(plan).toMatchObject({ usedMoves: 2, armyAtDeadline: 21 });
    expect(plan.skipped.counts.no_movable_armies).toBe(1);
  });

  it('protects the general on an intermediate route even when sources excludes it', () => {
    const state = game([5, 20, 10], { generals: [1] });
    const plan = gather(state, { target: 0, maxMoves: 2, sources: [2] });
    expect(plan).toMatchObject({ usedMoves: 0, armyAtDeadline: 5, reserves: [{ tile: { x: 1, y: 0 }, armies: 20 }] });
    expect(plan.skipped.counts.reserve_limited).toBe(1);
    expect(state.tile(1).armies).toBe(20);
  });

  it('uses explicit general reserves and a legal half move for the protected tile', () => {
    const state = game([5, 20, 10], { generals: [1] });
    const plan = gather(state, { target: 0, maxMoves: 2, sources: [2], reserves: [{ tile: 1, armies: 10 }] });
    expect(plan).toMatchObject({ usedMoves: 2, armyAtDeadline: 19 });
    expect(plan.moves.map((move) => move.half)).toEqual([false, true]);
    const simulated = simulateMoves(state, parseMoves(plan.moves, state.width, state.height));
    expect(simulated.steps[1].sourceRemaining).toBeGreaterThanOrEqual(10);
  });

  it('respects the discrete half/full actions rather than inventing an arbitrary troop transfer', () => {
    const state = game([3, 11]);
    const plan = gather(state, { target: 0, maxMoves: 1, reserves: [{ tile: 1, armies: 6 }] });
    expect(plan).toMatchObject({ usedMoves: 1, armyAtDeadline: 8 });
    expect(plan.moves[0].half).toBe(true);
    const blocked = gather(game([3, 10]), { target: 0, maxMoves: 1, reserves: [{ tile: 1, armies: 6 }] });
    expect(blocked.usedMoves).toBe(0);
  });

  it('includes action-end and remaining idle growth at the same deadline', () => {
    const state = game([5, 10], { turn: 49, generals: [0] });
    const plan = gather(state, { target: 0, maxMoves: 3, targetArmies: 17 });
    expect(plan).toMatchObject({ usedMoves: 1, actionEndTurn: 50, projectedArmies: 16, deadlineTurn: 52, armyAtDeadline: 17, metTarget: true });
    expect(plan.contributions[0].addedArmies).toBe(9);
  });

  it('returns an empty candidate when target production alone meets the deadline amount', () => {
    const plan = gather(game([10, 20], { turn: 1, generals: [0] }), { target: 0, maxMoves: 3, targetArmies: 12 });
    expect(plan).toMatchObject({ usedMoves: 0, moves: [], actionEndTurn: 1, projectedArmies: 10, armyAtDeadline: 12, metTarget: true });
  });

  it.each([-1, -2, -3, 1])('does not route through non-self terrain %i', (terrain) => {
    const plan = gather(game([5, 1, 10], { terrain: [0, terrain, 0] }), { target: 0, maxMoves: 3, sources: [2] });
    expect(plan).toMatchObject({ usedMoves: 0, armyAtDeadline: 5 });
    expect(plan.skipped.counts.no_owned_route).toBe(1);
  });

  it('excludes even a known owned tunnel from gather routes', () => {
    const plan = gather(game([5, 1, 10], { tunnels: [0, 20, 0] }), { target: 0, maxMoves: 3, sources: [2] });
    expect(plan.usedMoves).toBe(0);
    expect(plan.skipped.counts.no_owned_route).toBe(1);
  });

  it('reports an unmet heuristic target when the chosen shortest path is reserve-blocked', () => {
    const state = game([5, 20, 1, 10], { width: 2 });
    const plan = gather(state, { target: 0, sources: [3], maxMoves: 2, targetArmies: 14, reserves: [{ tile: 1, armies: 20 }] });
    expect(plan).toMatchObject({ usedMoves: 0, metTarget: false });
    const alternative = simulateMoves(state, [{ from: 3, to: 2, half: false }, { from: 2, to: 0, half: false }]);
    expect(alternative.touchedTiles[0].armies).toBe(14);
  });

  it('uses playerIndex, stays read-only, and produces the same plan on repeated calls', () => {
    const state = new GeneralsState(1, {});
    state.update({ turn: 10, map_diff: [0, 6, 2, 1, 5, 10, 1, 1], cities_diff: [0, 0], generals: [-1, 0], scores: [] });
    const before = state.snapshot();
    const args = { target: { x: 0, y: 0 }, maxMoves: 2 };
    const first = gather(state, args);
    expect(first).toMatchObject({ playerIndex: 1, armyAtDeadline: 15 });
    expect(gather(state, args)).toEqual(first);
    expect(state.snapshot()).toEqual(before);
  });

  it('rejects duplicate reserves and accepts the declared maximum common budget', () => {
    const state = game([5, 10]);
    expect(() => parseGatherOptions(state, { target: 0, maxMoves: 2, reserves: [{ tile: 1, armies: 2 }, { tile: 1, armies: 3 }] })).toThrow('Duplicate reserve');
    expect(gather(state, { target: 0, maxMoves: GENERALS_ANALYSIS_LIMITS.maxMoves }).usedMoves).toBe(1);
  });

  it('rejects extra reserve fields that would otherwise be silently ignored', () => {
    expect(() => gather(game([5, 10]), { target: 0, maxMoves: 1, reserves: [{ tile: 1, armies: 2, half: true }] }))
      .toThrow('only tile and armies');
  });
});
