import { describe, expect, it } from 'vitest';
import { GeneralsState } from '../src/state.ts';
import { applySimulationMove, cloneSimulationBoard, createSimulationBoard, simulateMoves } from '../src/simulation.ts';

function game(options: {
  armies: number[]; terrain: number[]; width?: number; turn?: number;
  cities?: number[]; generals?: number[]; tunnels?: number[]; teams?: unknown[];
}) {
  const state = new GeneralsState(0, { teams: options.teams });
  const map = [options.width ?? options.armies.length, options.width ? options.armies.length / options.width : 1,
    ...options.armies, ...options.terrain, ...(options.tunnels ?? [])];
  const cities = options.cities ?? [];
  state.update({ turn: options.turn ?? 10, map_diff: [0, map.length, ...map], cities_diff: [0, cities.length, ...cities], generals: options.generals ?? [], scores: [] });
  return state;
}

const full = (from: number, to: number) => ({ from, to, half: false });

describe('Generals movement simulation', () => {
  it('merges a route before advancing and leaves one soldier on every departed tile', () => {
    const state = game({ armies: [10, 3, 0], terrain: [0, 0, -1] });
    const result = simulateMoves(state, [full(0, 1), full(1, 2)]);
    expect(result).toMatchObject({ playerIndex: 0, observedTurn: 10, status: 'complete', completedMoves: 2, endTurn: 12, halt: null });
    expect(result.steps).toEqual([
      { step: 1, turn: 10, from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, sourceArmies: 10, sentArmies: 9, sourceRemaining: 1,
        targetArmies: 3, targetRemaining: 12, targetOwner: 0, result: 'merged' },
      { step: 2, turn: 11, from: { x: 1, y: 0 }, to: { x: 2, y: 0 }, sourceArmies: 12, sentArmies: 11, sourceRemaining: 1,
        targetArmies: 0, targetRemaining: 11, targetOwner: 0, result: 'captured' },
    ]);
    expect(result.touchedTiles.map((tile) => tile.armies)).toEqual([1, 1, 11]);
  });

  it.each([2, 3, 8, 9])('half of %i armies moves the floor and leaves the ceiling', (armies) => {
    const state = game({ armies: [armies, 4], terrain: [0, 0] });
    const result = simulateMoves(state, [{ from: 0, to: 1, half: true }]);
    expect(result.steps[0]).toMatchObject({ sentArmies: Math.floor(armies / 2), sourceRemaining: Math.ceil(armies / 2), targetRemaining: 4 + Math.floor(armies / 2) });
  });

  it('captures with the exact combat remainder', () => {
    const result = simulateMoves(game({ armies: [9, 5], terrain: [0, 1] }), [full(0, 1)]);
    expect(result.steps[0]).toMatchObject({ sentArmies: 8, targetArmies: 5, targetRemaining: 3, targetOwner: 0, result: 'captured' });
  });

  it('equal armies keep enemy ownership and prevent continuing the route from the defended tile', () => {
    const result = simulateMoves(game({ armies: [6, 5, 0], terrain: [0, 1, -1] }), [full(0, 1), full(1, 2)]);
    expect(result.steps[0]).toMatchObject({ targetRemaining: 0, targetOwner: 1, result: 'held' });
    expect(result).toMatchObject({ status: 'halted', completedMoves: 1, endTurn: 11, halt: { step: 2, reason: 'source_not_owned' } });
    expect(result.touchedTiles).toHaveLength(2);
  });

  it('keeps another independent move after a failed capture', () => {
    const result = simulateMoves(game({ armies: [4, 9, 5, 0], terrain: [0, 1, 0, -1] }), [full(0, 1), full(2, 3)]);
    expect(result.status).toBe('complete');
    expect(result.steps.map((step) => step.result)).toEqual(['held', 'captured']);
    expect(result.steps.map((step) => step.targetRemaining)).toEqual([6, 4]);
  });

  it('moves before production and includes the newly captured city in that tick', () => {
    const result = simulateMoves(game({ armies: [10, 3], terrain: [0, -1], cities: [1], generals: [0], turn: 1 }), [full(0, 1)]);
    expect(result.steps[0]).toMatchObject({ sourceArmies: 10, sentArmies: 9, sourceRemaining: 1, targetRemaining: 6 });
    expect(result.touchedTiles.map((tile) => tile.armies)).toEqual([2, 7]);
    expect(result.endTurn).toBe(2);
  });

  it('applies city/general and land growth together at turn 50, including other visible occupied tiles', () => {
    const state = game({ armies: [10, 3, 7, 5, 40], terrain: [0, -1, 0, 1, -1], cities: [1, 3, 4], generals: [0], turn: 49 });
    const board = createSimulationBoard(state);
    const result = applySimulationMove(board, full(0, 1), 1);
    expect(result.step).toMatchObject({ sourceRemaining: 1, targetRemaining: 6 });
    expect(board.tiles.map((tile) => tile.armies)).toEqual([3, 8, 8, 7, 40]);
    expect(board.turn).toBe(50);
  });

  it('preserves the visible minus-one City-State garrison in combat arithmetic', () => {
    const result = simulateMoves(game({ armies: [2, -1], terrain: [0, -1], cities: [1], turn: 1 }), [full(0, 1)]);
    expect(result.steps[0]).toMatchObject({ sentArmies: 1, targetArmies: -1, targetRemaining: 2, result: 'captured' });
    expect(result.touchedTiles[1]).toMatchObject({ owner: 0, armies: 3, city: true });
  });

  it('stops at fog despite a previous sighting without changing the source view', () => {
    const state = game({ armies: [10, 99], terrain: [0, 1], turn: 10 });
    const map = [2, 1, 10, 9999, 0, -3];
    state.update({ turn: 11, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [], scores: [] });
    expect(state.lastSeen(1)?.armies).toBe(99);
    const before = state.snapshot();
    const result = simulateMoves(state, [full(0, 1)]);
    expect(result).toMatchObject({ status: 'halted', completedMoves: 0, endTurn: 11, steps: [], touchedTiles: [], halt: { step: 1, reason: 'unknown_current_tile' } });
    expect(state.snapshot()).toEqual(before);
  });

  it.each([
    { armies: [10, 0], terrain: [0, -2], reason: 'known_mountain' },
    { armies: [10, 0], terrain: [1, -1], reason: 'source_not_owned' },
    { armies: [1, 0], terrain: [0, -1], reason: 'source_has_no_movable_armies' },
    { armies: [10, 0], terrain: [0, -1], tunnels: [0, -1], reason: 'unsupported_tunnel' },
    { armies: [10, 3], terrain: [0, 1], teams: [4, 4], reason: 'unsupported_allied_transfer' },
  ])('halts before unsupported or impossible movement: $reason', ({ reason, ...options }) => {
    const state = game(options);
    const result = simulateMoves(state, [full(0, 1)]);
    expect(result).toMatchObject({ status: 'halted', completedMoves: 0, endTurn: state.turn, halt: { step: 1, reason }, touchedTiles: [] });
  });

  it('shares consumed source armies across independent moves in one batch', () => {
    const state = game({ armies: [0, 10, 0], terrain: [-1, 0, -1] });
    const result = simulateMoves(state, [full(1, 0), full(1, 2)]);
    expect(result).toMatchObject({ status: 'halted', completedMoves: 1, halt: { step: 2, reason: 'source_has_no_movable_armies' } });
    expect(result.touchedTiles.map((tile) => tile.armies)).toEqual([9, 1]);
  });

  it('keeps null team entries independent in combat simulation', () => {
    const result = simulateMoves(game({ armies: [10, 3], terrain: [0, 1], teams: [null, null] }), [full(0, 1)]);
    expect(result.steps[0]).toMatchObject({ targetOwner: 0, targetRemaining: 6, result: 'captured' });
    expect(result.status).toBe('complete');
  });

  it('stops zero-amount simulation on a one-army move to an empty friendly tile', () => {
    const result = simulateMoves(game({ armies: [1, 0], terrain: [0, 0] }), [full(0, 1)]);
    expect(result).toMatchObject({ completedMoves: 0, endTurn: 10, halt: { reason: 'source_has_no_movable_armies' } });
  });

  it('keeps a completed prefix when a later step reaches an unknown tile', () => {
    const result = simulateMoves(game({ armies: [10, 0, 999], terrain: [0, -1, -4] }), [full(0, 1), full(1, 2)]);
    expect(result).toMatchObject({ completedMoves: 1, endTurn: 11, halt: { step: 2, reason: 'unknown_current_tile' } });
    expect(result.touchedTiles.map((tile) => tile.armies)).toEqual([1, 9]);
  });

  it('records local general capture and halts before any following move or whole-player transfer', () => {
    const state = game({ armies: [10, 4, 8], terrain: [0, 1, 1], generals: [-1, 1], turn: 1 });
    const result = simulateMoves(state, [full(0, 1), full(1, 2)]);
    expect(result).toMatchObject({ completedMoves: 1, endTurn: 2, status: 'halted', halt: { step: 1, reason: 'general_capture_transfer_unmodeled' } });
    expect(result.steps[0]).toMatchObject({ result: 'captured', targetRemaining: 5, targetOwner: 0 });
    expect(result.touchedTiles[1]).toMatchObject({ armies: 6, owner: 0, general: false, city: true });
    expect(state.tile(2)).toMatchObject({ owner: 1, armies: 8 });
  });

  it('keeps simulation branches and repeated calculations independent of observation', () => {
    const state = game({ armies: [10, 3, 0], terrain: [0, 0, -1] });
    const before = state.snapshot();
    const board = createSimulationBoard(state), branch = cloneSimulationBoard(board);
    applySimulationMove(branch, full(0, 1), 1);
    expect(board.tiles[0].armies).toBe(10);
    const first = simulateMoves(state, [full(0, 1), full(1, 2)]);
    expect(simulateMoves(state, [full(0, 1), full(1, 2)])).toEqual(first);
    expect(state.snapshot()).toEqual(before);
  });

  it.each([
    { options: { modifiers: [2] } },
    { options: { modifiers: [1, 2] } },
    { options: { modifiers: [1, 1] } },
    { options: { city_regen: true } },
    { options: { chessClock: {} } },
    { chessClock: {} },
    { options: { map: 'fixture' } },
    { swamps: [0] },
    { deserts: [0] },
  ])('rejects known unsupported room mechanics before changing a board: %j', (start) => {
    const state = game({ armies: [10, 0], terrain: [0, -1] });
    Object.assign(state.start, start);
    const before = state.snapshot();
    expect(() => createSimulationBoard(state)).toThrow('Simulation');
    expect(state.snapshot()).toEqual(before);
  });

  it('accepts normal options and City-State with absent special terrain', () => {
    const state = game({ armies: [10, 0], terrain: [0, -1] });
    Object.assign(state.start, { options: { modifiers: [1], city_regen: false, map: null, chessClock: null }, swamps: [], deserts: [] });
    expect(simulateMoves(state, [full(0, 1)]).status).toBe('complete');
  });
});
