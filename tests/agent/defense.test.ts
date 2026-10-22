import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { planDefense } from '../../src/agent/defense.ts';
import { SearchBudget } from '../../src/agent/search.ts';

function board(width: number, height: number, home: number, enemy: number, enemyArmies: number): AgentObservation {
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index, x: index % width, y: Math.floor(index / width),
    terrain: -1, visible: true, armies: 0, owner: null as number | null, city: false, general: index === home, tunnelLimit: 0 }));
  Object.assign(tiles[home], { owner: 0, terrain: 0, armies: 1 });
  Object.assign(tiles[enemy], { owner: 1, terrain: 1, armies: enemyArmies });
  return { gameId: 'defense', revision: 1, controlEpoch: 1, playerIndex: 0, turn: 100, width, height,
    tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [home, -1], scores: [] };
}

function own(observation: AgentObservation, index: number, armies: number, city = false): void {
  Object.assign(observation.tiles[index], { owner: 0, terrain: 0, armies, city });
}

function plan(observation: AgentObservation, maxNodes = 4000) {
  return planDefense(observation, analyzePosition(observation), new SearchBudget(maxNodes, 1000));
}

describe('serial general defense planning', () => {
  it('keeps a sufficient screen which separates every visible enemy from home', () => {
    const observation = board(3, 2, 0, 2, 10);
    observation.turn = 101;
    own(observation, 0, 6);
    own(observation, 1, 5);
    own(observation, 4, 1);
    observation.tiles[2].general = true;
    for (const index of [3, 5]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    const before = structuredClone(observation);
    expect(plan(observation)).toBeNull();
    expect(observation).toEqual(before);
  });

  it('does not spend screen-proof nodes when home already covers every raw arrival', () => {
    const observation = board(3, 1, 0, 2, 10);
    own(observation, 0, 100);
    own(observation, 1, 5);
    const budget = new SearchBudget(0, 1000);
    expect(planDefense(observation, analyzePosition(observation), budget)).toBeNull();
    expect(budget.nodes).toBe(0);
    expect(budget.exhausted).toBe(false);
  });

  it('counts a held screen once against all visible enemy forces', () => {
    const observation = board(4, 1, 0, 2, 10);
    own(observation, 0, 6);
    own(observation, 1, 10);
    Object.assign(observation.tiles[3], { terrain: 1, owner: 1, armies: 10 });
    expect(plan(observation)).toMatchObject({ requiredArmies: 9, status: 'sufficient', route: { source: 1, target: 0 } });
  });

  it('does not credit a screen when an enemy can take an open route around it', () => {
    const observation = board(3, 2, 0, 2, 10);
    own(observation, 0, 6);
    own(observation, 1, 50);
    expect(plan(observation)).toMatchObject({ requiredArmies: 9, status: 'sufficient', route: { source: 1, target: 0 } });
  });

  it('does not count later city production after a waiting reinforcement could already have been captured', () => {
    const observation = board(5, 5, 23, 0, 45);
    own(observation, 23, 2);
    own(observation, 15, 30);
    own(observation, 8, 5, true);
    for (const index of [20, 21, 22]) own(observation, index, 1);
    for (const index of [1, 6, 11, 16]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    Object.assign(observation.tiles[4], { terrain: 1, owner: 1, armies: 8 });
    const before = structuredClone(observation);
    const result = plan(observation);
    expect(result).toMatchObject({ status: 'partial', projectedArmies: 34, deadlineTurn: 107 });
    expect(observation).toEqual(before);
  });

  it('merges two branches before the shared return stem when separate home shipments miss the deadline', () => {
    const observation = board(7, 7, 45, 3, 22);
    for (const index of [24, 31, 38]) own(observation, index, 1);
    own(observation, 23, 12);
    own(observation, 25, 12);
    const result = plan(observation);
    expect(result).toMatchObject({ status: 'sufficient', deadlineTurn: 106, route: { source: 23, target: 24, path: [23, 24] } });
    expect(result?.paths.length).toBeGreaterThan(1);
    expect(result?.reason).toContain('owned_gathering_tree');
    expect(result?.paths.reduce((sum, path) => sum + path.length - 1, 0)).toBeLessThanOrEqual(6);
  });
  it('combines two insufficient reinforcements within one shared move deadline', () => {
    const observation = board(5, 3, 12, 2, 11);
    own(observation, 11, 6);
    expect(plan(observation)).toMatchObject({ requiredArmies: 10, projectedArmies: 6, status: 'partial' });
    own(observation, 13, 6);
    expect(plan(observation)).toMatchObject({ requiredArmies: 10, projectedArmies: 11, deadlineTurn: 102, status: 'sufficient',
      route: { target: 12, path: [11, 12], armies: 6 } });
  });

  it('consumes overlapping path garrisons before evaluating a second reinforcement', () => {
    const observation = board(7, 5, 31, 3, 22);
    own(observation, 30, 6);
    own(observation, 29, 6);
    own(observation, 23, 6);
    const before = structuredClone(observation);
    expect(plan(observation)).toMatchObject({ requiredArmies: 19, projectedArmies: 17, status: 'partial', deadlineTurn: 104 });
    expect(observation).toEqual(before);
  });

  it('retains a partial reinforcement when two individually timely routes exceed the shared deadline', () => {
    const observation = board(7, 4, 24, 3, 22);
    own(observation, 23, 6);
    own(observation, 22, 6);
    own(observation, 16, 6);
    const result = plan(observation);
    expect(result).toMatchObject({ deadlineTurn: 103, status: 'partial', projectedArmies: 12 });
    expect(result?.reason).toContain('gap:8');
    expect(result?.reason).toContain('serial_moves:2');
    expect(result?.route?.path).toHaveLength(3);
  });

  it('prepares against a recent hidden force while preserving unknown current facts', () => {
    const observation = board(5, 3, 12, 2, 14);
    own(observation, 11, 7);
    Object.assign(observation.tiles[2], { terrain: -3, visible: false, owner: null, armies: null,
      city: null, general: null, tunnelLimit: null });
    const result = plan(observation);
    expect(result).toMatchObject({ basis: 'history', requiredArmies: 13, status: 'partial', route: { source: 11, target: 12 } });
    expect(result?.reason).toContain('history_assumption:2@100');
    expect(observation.tiles[2]).toMatchObject({ visible: false, owner: null, armies: null });
  });

  it('includes shared clock production at cities and the general between successive shipments', () => {
    const observation = board(5, 3, 12, 2, 5);
    observation.turn = 101;
    own(observation, 11, 2, true);
    expect(plan(observation)).toMatchObject({ requiredArmies: 4, projectedArmies: 4, deadlineTurn: 103,
      status: 'sufficient', route: { path: [11, 12], armies: 3 } });
  });

  it('retains a raw defense demand when a visible friendly screen can be withdrawn', () => {
    const observation = board(5, 1, 0, 4, 15);
    own(observation, 0, 3);
    own(observation, 1, 2);
    own(observation, 2, 25);
    own(observation, 3, 1);
    expect(plan(observation)).toMatchObject({ status: 'sufficient', requiredArmies: 12, projectedArmies: 29,
      actionRequired: false, route: { source: 2, target: 0 } });
  });

  it('reports an unmet target when the search budget cannot examine a reinforcement', () => {
    const observation = board(5, 3, 12, 2, 11);
    own(observation, 11, 6);
    const budget = new SearchBudget(0, 1000);
    const result = planDefense(observation, analyzePosition(observation), budget);
    expect(result).toMatchObject({ route: null, requiredArmies: 10, projectedArmies: 1, status: 'unavailable' });
    expect(result?.reason).toContain('gap:9');
    expect(budget.nodes).toBe(0);
  });

  it('recognizes a fourteen-move attack and a twelve-move visible return before defense becomes immediate', () => {
    const observation = board(15, 3, 0, 14, 164);
    own(observation, 0, 33);
    const path = [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 15, 0];
    for (const index of path.slice(1, -1)) own(observation, index, 1);
    own(observation, 40, 158);
    Object.assign(observation.tiles[39], { owner: null, terrain: -1, armies: 0 });
    for (const index of [37, 35]) Object.assign(observation.tiles[index], { owner: 1, terrain: 1, armies: 2 });
    const before = structuredClone(observation);
    const result = plan(observation);
    expect(result).toMatchObject({ deadlineTurn: 114, status: 'sufficient', slackTurns: 2,
      latestStartTurn: 102, actionRequired: false, timingComplete: true, route: { source: 40, target: 0 } });
    expect(result?.route?.path).toHaveLength(13);
    expect(result?.route?.captured).toBeGreaterThan(0);
    expect(observation).toEqual(before);

    observation.turn += 2;
    Object.assign(observation.tiles[14], { armies: 1 });
    Object.assign(observation.tiles[12], { owner: 1, terrain: 1, armies: 162 });
    expect(plan(observation)).toMatchObject({ actionRequired: true, slackTurns: 0, latestStartTurn: 102 });
  });

  it('does not count a twenty-three-army shipment through a tile a larger enemy can capture on its arrival turn', () => {
    const observation = board(5, 4, 17, 7, 151);
    for (const tile of observation.tiles) {
      if ([7, 11, 12, 17].includes(tile.index)) continue;
      Object.assign(tile, { terrain: -2, owner: null, armies: null });
    }
    own(observation, 17, 38);
    own(observation, 11, 24);
    own(observation, 12, 1);
    expect(plan(observation)).toMatchObject({ route: null, paths: [], projectedArmies: 38, status: 'unavailable' });
  });

  it('cannot spend turn-fifty recruitment before an adjacent attack has resolved', () => {
    const observation = board(2, 1, 0, 1, 4);
    observation.turn = 49;
    own(observation, 0, 2);
    expect(analyzePosition(observation)).toMatchObject({ homeReserve: 4 });
    expect(plan(observation)).toMatchObject({ requiredArmies: 4, projectedArmies: 2,
      deadlineTurn: 50, status: 'unavailable', actionRequired: true });
  });
});
