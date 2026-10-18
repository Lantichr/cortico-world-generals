import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { analyzePosition } from '../../src/agent/analysis.ts';
import { SearchBudget } from '../../src/agent/search.ts';
import { createThreatTiming } from '../../src/agent/timing.ts';
import { planGatheringTree, reprojectGatheringTree } from '../../src/agent/gather-tree.ts';

function position(rows: string[], turn = 100): AgentObservation {
  const width = rows[0].split(' ').length;
  let home = -1;
  const tiles = rows.flatMap((row, y) => row.split(' ').map((cell, x) => {
    const index = y * width + x, own = /^[GaC]/.test(cell), enemy = /^[eE]/.test(cell);
    if (cell.startsWith('G')) home = index;
    const visible = !['?', 'X'].includes(cell);
    return { index, x, y, terrain: cell === '#' ? -2 : cell === '?' ? -3 : cell === 'X' ? -4 : own ? 0 : enemy ? 1 : -1,
      visible, owner: own ? 0 : enemy ? 1 : null, armies: ['?', 'X', '#'].includes(cell) ? null : cell === '.' ? 0 : Number(cell.slice(1)),
      general: /^[GE]/.test(cell), city: /^[Cc]/.test(cell), tunnelLimit: visible ? 0 : null };
  }));
  return { gameId: 'gather-tree', revision: 1, controlEpoch: 1, playerIndex: 0, turn, width, height: rows.length,
    tiles, history: tiles.map((tile) => tile.visible ? { ...tile, lastSeenTurn: turn } : null), generals: [home, -1], scores: [] };
}

const budget = (nodes = 100000) => new SearchBudget(nodes, 1000, performance.now());

/** Independent owned-move referee consumes each source garrison and applies common 2/50-turn production. */
function referee(observation: AgentObservation, paths: number[][], reserve: number): AgentObservation {
  const next = structuredClone(observation);
  for (const path of paths) for (let step = 1; step < path.length; step++) {
    const source = next.tiles[path[step - 1]], target = next.tiles[path[step]];
    const half = step === 1 && source.general && reserve > 1;
    const amount = half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    source.armies! -= amount; target.armies! += amount; next.turn++;
    for (const tile of next.tiles) if (tile.owner !== null && tile.armies !== null) {
      if (next.turn % 2 === 0 && (tile.city || tile.general)) tile.armies++;
      if (next.turn % 50 === 0) tile.armies++;
    }
  }
  return next;
}

describe('serial gathering trees', () => {
  it('does not use production to reuse a waiting city which was emptied before an enemy arrival', () => {
    const observation = position(['C30 a1 a1 G2', 'e3 # # #'], 99), analysis = analyzePosition(observation);
    const paths = [[0, 1], [1, 2], [0, 1, 2, 3]];
    expect(reprojectGatheringTree(observation, analysis, paths, budget())).not.toBeNull();
    expect(reprojectGatheringTree(observation, analysis, paths, budget(), createThreatTiming(observation, analysis))).toBeNull();
  });

  it('uses completed reinforcements when a merged city waits for an independent leg', () => {
    const observation = position(['a30 C1 a1 G2 a5', 'e10 # # # #']), analysis = analyzePosition(observation);
    const paths = [[0, 1], [4, 3], [1, 2, 3]];
    const plan = reprojectGatheringTree(observation, analysis, paths, budget(), createThreatTiming(observation, analysis));
    expect(plan).not.toBeNull();
    expect(plan!.projectedObservation.tiles.map((tile) => tile.armies))
      .toEqual(referee(observation, paths, analysis.homeReserve).tiles.map((tile) => tile.armies));
  });

  it('merges two branches before traversing their common tail once', () => {
    const observation = position(['# a30 #', 'a30 a1 a1', '# # G2']);
    const result = planGatheringTree(observation, analyzePosition(observation), 8, [1, 3], 4, budget())!;
    expect(result).toMatchObject({ target: 8, usedMoves: 4, complete: true });
    expect(result.paths).toHaveLength(2);
    expect(result.routes[0].target).toBe(4);
    expect(result.routes.at(-1)!.target).toBe(8);
    const moves = result.paths.flatMap((path) => path.slice(1).map((to, i) => `${path[i]}>${to}`));
    expect(moves.filter((move) => move === '4>5')).toHaveLength(1);
    expect(moves.filter((move) => move === '5>8')).toHaveLength(1);
    expect(result.projectedObservation.tiles.map((tile) => tile.armies))
      .toEqual(referee(observation, result.paths, 1).tiles.map((tile) => tile.armies));
    expect(result.projectedArmies).toBeGreaterThan(60);
  });

  it('omits a long low-value branch when its movements would exceed the common deadline', () => {
    const observation = position(['G2 a1 a30 a1 a1 a1 a4']);
    const plan = planGatheringTree(observation, analyzePosition(observation), 0, [2, 6], 3, budget())!;
    expect(plan.paths).toEqual([[2, 1, 0]]);
    expect(plan.usedMoves).toBe(2);
    expect(plan.deadlineTurn).toBe(103);
  });

  it('prefers efficient delivery over collecting more total soldiers on a long branch', () => {
    const observation = position(['a50 a1 a1 G2 a30']);
    const plan = planGatheringTree(observation, analyzePosition(observation), 3, [0, 4], 5, budget())!;
    expect(plan.paths).toEqual([[4, 3]]);
  });

  it('stops adding branches once the requested recipient army can be delivered', () => {
    const observation = position(['a30 G2 a100']);
    const plan = planGatheringTree(observation, analyzePosition(observation), 1, [0, 2], 2, budget(), undefined, 25)!;
    expect(plan.usedMoves).toBe(1);
    expect(plan.paths).toHaveLength(1);
    expect(plan.projectedArmies).toBeGreaterThanOrEqual(25);
  });

  it('uses the projected map for later legs and never collects a departed garrison twice', () => {
    const observation = position(['a30 a20 G2'], 49), analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[0, 1], [1, 2]], budget())!;
    expect(plan.projectedObservation.tiles.map((tile) => tile.armies))
      .toEqual(referee(observation, plan.paths, analysis.homeReserve).tiles.map((tile) => tile.armies));
    expect(plan.projectedArmies).toBe(53);
    expect(plan.addedArmies).toBe(49);
  });

  it('retains the general reserve when it supplies a non-general gathering target', () => {
    const observation = position(['G20 a1 a30 .']), analysis = analyzePosition(observation);
    analysis.homeReserve = 10;
    const plan = reprojectGatheringTree(observation, analysis, [[0, 1, 2]], budget())!;
    expect(plan.routes[0].half).toBe(true);
    expect(plan.projectedObservation.tiles[0].armies).toBeGreaterThanOrEqual(analysis.homeReserve);
    analysis.homeReserve++;
    expect(reprojectGatheringTree(observation, analysis, [[0, 1, 2]], budget())).toBeNull();
  });

  it('does not transit the general between two field branches', () => {
    const observation = position(['a100 G20 a100 .']), analysis = analyzePosition(observation);
    expect(planGatheringTree(observation, analysis, 2, [0], 4, budget())).toBeNull();
    expect(reprojectGatheringTree(observation, analysis, [[0, 1, 2]], budget())).toBeNull();
  });

  it('rejects a stale future leg when its source was captured before the next observation', () => {
    const observation = position(['# a30 #', 'a30 a1 a1', '# # G2']), analysis = analyzePosition(observation);
    const plan = planGatheringTree(observation, analysis, 8, [1, 3], 4, budget())!;
    const next = referee(observation, [plan.paths[0]], 1);
    const future = plan.paths.slice(1);
    Object.assign(next.tiles[future[0][0]], { owner: 1, terrain: 1, armies: 50 });
    expect(reprojectGatheringTree(next, analyzePosition(next), future, budget(), undefined, plan.deadlineTurn)).toBeNull();
  });

  it('counts all serial legs against an absolute deadline after reloading a commitment', () => {
    const observation = position(['a30 a1 G2']), analysis = analyzePosition(observation);
    expect(reprojectGatheringTree(observation, analysis, [[0, 1], [1, 2]], budget(), undefined, 101)).toBeNull();
    expect(reprojectGatheringTree(observation, analysis, [[0, 1], [1, 2]], budget(), undefined, 102))
      .toMatchObject({ usedMoves: 2, deadlineTurn: 102 });
  });

  it('does not output an incomplete future leg when its projection budget is exhausted', () => {
    const observation = position(['a30 a1 G2']);
    expect(reprojectGatheringTree(observation, analyzePosition(observation), [[0, 1], [1, 2]], budget(1))).toBeNull();
  });

  it('retains a complete evaluated candidate when later subset search exhausts its budget', () => {
    const observation = position(['a30 G2 a30 a30']);
    let completed = false;
    for (let nodes = 10; nodes < 100; nodes++) {
      const shared = budget(nodes);
      const plan = planGatheringTree(observation, analyzePosition(observation), 1, [0, 2, 3], 4, shared);
      if (plan && shared.exhausted) {
        expect(plan).toMatchObject({ complete: true, searchComplete: false });
        expect(plan.projectedObservation.tiles[1].armies).toBe(plan.projectedArmies);
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
  });

  it('rejects a force which an enemy can capture while it waits for another branch', () => {
    const observation = position(['e50 a10 a1 G2', '# a20 # #']), analysis = analyzePosition(observation);
    const paths = [[5, 1], [1, 2, 3]];
    expect(reprojectGatheringTree(observation, analysis, paths, budget())).not.toBeNull();
    expect(reprojectGatheringTree(observation, analysis, paths, budget(), createThreatTiming(observation, analysis))).toBeNull();
  });

  it('never mutates the authoritative observation', () => {
    const observation = position(['# a30 #', 'a30 a1 a1', '# # G2']), before = structuredClone(observation);
    planGatheringTree(observation, analyzePosition(observation), 8, [1, 3], 4, budget());
    expect(observation).toEqual(before);
  });
});
