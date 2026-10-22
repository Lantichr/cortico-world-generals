import { describe, expect, it } from 'vitest';
import { analyzePosition, type HiddenArmyEstimate } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';

function board(width: number, home: number): AgentObservation {
  const tiles = Array.from({ length: width }, (_, index) => ({ index, x: index, y: 0,
    terrain: -1, visible: true, owner: null as number | null, armies: 0,
    general: index === home, city: false, tunnelLimit: 0 }));
  Object.assign(tiles[home], { owner: 0, terrain: 0, armies: 10 });
  return { gameId: 'analysis', revision: 1, controlEpoch: 1, playerIndex: 0, turn: 100,
    width, height: 1, tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })),
    generals: [home, -1], scores: [] };
}

function force(observation: AgentObservation, index: number, owner: number, armies: number): void {
  Object.assign(observation.tiles[index], { owner, terrain: owner, armies });
}

describe('visible assault and historical home demands', () => {
  it('schedules one enemy player’s two adjacent attacks on successive turns and accumulates their damage', () => {
    const observation = board(3, 1);
    force(observation, 0, 1, 8);
    force(observation, 2, 1, 8);
    const analysis = analyzePosition(observation);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'nearest_first')).toMatchObject([
      { owner: 1, steps: 1, required: 8, sources: [0] },
      { owner: 1, steps: 2, required: 15, sources: [0, 2] },
    ]);
    expect(analysis.homeReserve).toBe(15);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'single')).toHaveLength(2);
  });

  it('merges a larger remote source through a nearer source without marching the consumed source again', () => {
    const observation = board(3, 0);
    force(observation, 1, 1, 30);
    force(observation, 2, 1, 35);
    const before = structuredClone(observation);
    const analysis = analyzePosition(observation);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'largest_first')).toMatchObject([
      { owner: 1, steps: 2, required: 64, sources: [1, 2] },
    ]);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'nearest_first')).toMatchObject([
      { steps: 1, required: 30, sources: [1] },
      { steps: 3, required: 64, sources: [1, 2] },
    ]);
    expect(observation).toEqual(before);
  });

  it('consumes each original source once while later waves may collect the one-army garrisons left along their route', () => {
    const observation = board(4, 0);
    for (const index of [1, 2, 3]) force(observation, index, 1, 10);
    const analysis = analyzePosition(observation);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'nearest_first')).toMatchObject([
      { steps: 1, required: 10, sources: [1] },
      { steps: 3, required: 19, sources: [1, 2] },
      { steps: 6, required: 28, sources: [1, 2, 3] },
    ]);
  });

  it('collects one-army friendly garrisons along a single movable enemy source’s route', () => {
    const observation = board(4, 0);
    force(observation, 0, 0, 8);
    force(observation, 1, 1, 1);
    force(observation, 2, 1, 1);
    force(observation, 3, 1, 10);
    const analysis = analyzePosition(observation);
    expect(analysis.homeDemands.filter((demand) => demand.scenario === 'nearest_first')).toMatchObject([
      { owner: 1, steps: 3, required: 10, sources: [3] },
    ]);
    expect(analysis.homeReserve).toBe(9);
    expect(analysis.homeReserve).toBeGreaterThan(observation.tiles[0].armies!);
  });

  it('retains an earlier single-source arrival when a selected assault order delays it', () => {
    const observation = board(3, 0);
    force(observation, 1, 1, 30);
    force(observation, 2, 1, 35);
    expect(analyzePosition(observation).homeDemands).toContainEqual({
      tile: 1, owner: 1, steps: 1, required: 30, basis: 'visible', sources: [1], scenario: 'single',
    });
  });

  it('gives different owners independent assault clocks without combining their source identities', () => {
    const observation = board(5, 2);
    observation.generals.push(-1);
    for (const index of [0, 1]) force(observation, index, 1, 8);
    for (const index of [3, 4]) force(observation, index, 2, 8);
    const demands = analyzePosition(observation).homeDemands.filter((demand) => demand.scenario === 'nearest_first');
    expect(demands.filter((demand) => demand.owner === 1)).toMatchObject([
      { steps: 1, required: 8, sources: [1] }, { steps: 3, required: 15, sources: [0, 1] },
    ]);
    expect(demands.filter((demand) => demand.owner === 2)).toMatchObject([
      { steps: 1, required: 8, sources: [3] }, { steps: 3, required: 15, sources: [3, 4] },
    ]);
  });

  it('keeps separate historical locations and visible forces as alternative hypotheses instead of adding their armies', () => {
    const observation = board(5, 2);
    force(observation, 3, 1, 20);
    for (const [index, armies] of [[0, 50], [1, 45]]) {
      observation.history[index] = { ...observation.tiles[index], owner: 1, terrain: 1, armies, lastSeenTurn: 99 };
      Object.assign(observation.tiles[index], { visible: false, owner: null, terrain: -3, armies: null, general: null, city: null });
    }
    const departed: HiddenArmyEstimate[] = [{ index: 0, owner: 1, armies: 50, lastSeenTurn: 99 }];
    const analysis = analyzePosition(observation, departed);
    expect(analysis.possibleThreats).toHaveLength(2);
    expect(analysis.homeDemands.filter((demand) => demand.basis === 'history')).toHaveLength(2);
    expect(analysis.homeDemands.filter((demand) => demand.basis === 'history')
      .every((demand) => demand.scenario === 'single' && demand.sources.length === 1)).toBe(true);
    expect(analysis.homeDemands.filter((demand) => demand.basis === 'visible')
      .every((demand) => demand.sources.length === 1 && demand.sources[0] === 3)).toBe(true);
    expect(analysis.homeReserve).toBe(50);
    expect(observation.tiles[0].armies).toBeNull();
  });

  it('keeps inactive players’ garrisons and capturable generals without treating them as moving threats', () => {
    const observation = board(3, 1);
    force(observation, 0, 1, 30);
    force(observation, 2, 1, 35);
    observation.tiles[0].general = true;
    observation.generals[1] = 0;
    observation.scores = [{ i: 1, total: 65, tiles: 2, dead: true }];
    const analysis = analyzePosition(observation, [{ index: 2, owner: 1, armies: 35, lastSeenTurn: 99 }]);
    expect(analysis.enemies).toHaveLength(2);
    expect(analysis.enemyGenerals).toEqual([0]);
    expect(analysis.threats).toEqual([]);
    expect(analysis.possibleThreats).toEqual([]);
    expect(analysis.homeDemands).toEqual([]);
    expect(analysis.homeReserve).toBe(1);
  });

  it('does not use turn-fifty production to defend an attack that resolves before that production', () => {
    const observation = board(2, 0);
    observation.turn = 49;
    force(observation, 0, 0, 2);
    force(observation, 1, 1, 4);
    const analysis = analyzePosition(observation);
    expect(analysis.threats[0]).toMatchObject({ distance: 1, projectedArrivalArmies: 3, projectedHomeArmies: 2 });
    expect(analysis.homeReserve).toBe(4);
  });
});
