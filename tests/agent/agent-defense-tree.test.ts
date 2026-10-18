import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentDecision, AgentObservation } from '../../src/agent/contracts.ts';

function branchPosition(turn: number): AgentObservation {
  const width = 7, height = 7, home = 45;
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index,
    x: index % width, y: Math.floor(index / width), terrain: -1, visible: true,
    owner: null as number | null, armies: 0, general: index === home, city: false, tunnelLimit: 0 }));
  for (const index of [home, 24, 31, 38]) Object.assign(tiles[index], { terrain: 0, owner: 0, armies: 1 });
  for (const index of [23, 25]) Object.assign(tiles[index], { terrain: 0, owner: 0, armies: 12 });
  Object.assign(tiles[3], { terrain: 1, owner: 1, armies: 22 });
  return { gameId: 'defense-branches', revision: turn + 1, controlEpoch: 1, playerIndex: 0,
    turn, width, height, tiles, generals: [home, -1], scores: [],
    history: tiles.map((tile) => ({ ...tile, lastSeenTurn: turn })) };
}

/** Moves resolve before common production; initiative alternates with the turn. */
function step(observation: AgentObservation, friendly: AgentDecision, enemy: { from: number; to: number } | null): void {
  const moves = [friendly.kind === 'move' ? friendly.move : null, enemy && { ...enemy, half: false }];
  for (const owner of observation.turn % 2 ? [1, 0] : [0, 1]) {
    const move = moves[owner];
    if (!move) continue;
    const from = observation.tiles[move.from], to = observation.tiles[move.to];
    expect(from.owner, `source ownership at turn ${observation.turn}`).toBe(owner);
    expect(from.armies, `source armies at turn ${observation.turn}`).toBeGreaterThan(1);
    expect(Math.abs(from.x - to.x) + Math.abs(from.y - to.y)).toBe(1);
    const sent = move.half ? Math.floor(from.armies! / 2) : from.armies! - 1;
    from.armies! -= sent;
    if (to.owner === owner) to.armies! += sent;
    else if (sent > to.armies!) { to.armies = sent - to.armies!; to.owner = to.terrain = owner; }
    else to.armies! -= sent;
  }
  observation.turn++;
  observation.revision++;
  for (const tile of observation.tiles) if (tile.owner !== null) {
    if (observation.turn % 2 === 0 && (tile.city || tile.general)) tile.armies!++;
    if (observation.turn % 50 === 0) tile.armies!++;
  }
  observation.history = observation.tiles.map((tile) => ({ ...tile, lastSeenTurn: observation.turn }));
}

describe('defensive gathering across real policy frames', () => {
  it.each([100, 101])('merges both branches before the shared stem and beats the deadline from turn %i', (turn) => {
    const observation = branchPosition(turn);
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const enemyPath = [3, 10, 17, 24, 31, 38, 45];
    const trace: Array<{ from: number; to: number }> = [];
    let arrivalTurn: number | null = null;
    for (let index = 0; index < enemyPath.length - 1; index++) {
      const decision = agent.decide(observation);
      if (arrivalTurn === null) {
        expect(decision, `turn ${observation.turn}: ${decision.reason}`).toMatchObject({ kind: 'move', task: { kind: 'defend', target: 45 } });
        if (decision.kind === 'move') {
          expect(decision.plan?.routes[0].path.slice(0, 2)).toEqual([decision.move.from, decision.move.to]);
          expect(decision.plan?.routes.at(-1)?.path.at(-1)).toBe(45);
          if (index === 0) {
            expect(decision.plan?.routes.map((route) => route.path[0])).toEqual([23, 25]);
            expect(decision.plan?.routes[0].path).toEqual([23, 24]);
          }
          trace.push({ from: decision.move.from, to: decision.move.to });
          if (decision.move.to === 45) arrivalTurn = observation.turn + 1;
        }
      }
      expect(decision.search.nodes).toBeLessThanOrEqual(4000);
      const enemySource = observation.tiles[enemyPath[index]];
      step(observation, decision, enemySource.owner === 1 && enemySource.armies! > 1
        ? { from: enemyPath[index], to: enemyPath[index + 1] } : null);
      expect(observation.tiles[45].owner).toBe(0);
    }
    expect(trace.slice(0, 2)).toEqual([{ from: 23, to: 24 }, { from: 25, to: 24 }]);
    expect(trace.slice(2)).toEqual([{ from: 24, to: 31 }, { from: 31, to: 38 }, { from: 38, to: 45 }]);
    expect(arrivalTurn).toBeLessThan(turn + 6);
    expect(observation.tiles[45].armies).toBeGreaterThan(0);
  });
});
