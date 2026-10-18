import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { projectVisibleRoute } from '../../src/agent/timing.ts';
import { SearchBudget } from '../../src/agent/search.ts';

const options = { decisionBudgetMs: 1000, maxSearchNodes: 4000 };

function board(width: number, height: number, home: [number, number]): AgentObservation {
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index,
    x: index % width, y: Math.floor(index / width), terrain: -2, visible: true,
    owner: null as number | null, armies: 0, general: false, city: false, tunnelLimit: 0 }));
  const homeIndex = home[1] * width + home[0];
  Object.assign(tiles[homeIndex], { terrain: 0, owner: 0, armies: 5, general: true });
  return { gameId: 'missions', revision: 101, turn: 100, controlEpoch: 1, playerIndex: 0,
    width, height, tiles, history: [], generals: [homeIndex, -1], scores: [] };
}

function tile(observation: AgentObservation, x: number, y: number, owner: number | null, armies = 0, city = false): number {
  const index = y * observation.width + x;
  Object.assign(observation.tiles[index], { terrain: owner ?? -1, owner, armies, city });
  return index;
}

describe('mission choice with shared defensive time', () => {
  it('explores with an existing main army instead of repeatedly relocating it between frontier cities', () => {
    const observation = board(6, 2, [0, 0]);
    for (const x of [0, 5]) Object.assign(observation.tiles[6 + x], {
      terrain: -3, visible: false, owner: null, armies: null, general: null, city: null, tunnelLimit: null });
    const army = tile(observation, 1, 1, 0, 1800, true);
    tile(observation, 2, 1, 0, 1);
    tile(observation, 3, 1, 0, 1);
    tile(observation, 4, 1, 0, 5, true);
    observation.history = observation.tiles.map((value) => value.visible ? { ...value, lastSeenTurn: observation.turn } : null);
    const decision = new GeneralsAgent(options).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', move: { from: army, to: 6 }, task: { kind: 'scout' } });
  });

  it('recalls a field army before a distant attack leaves no time to return from a city mission', () => {
    const observation = board(12, 9, [1, 7]);
    for (let x = 2; x <= 9; x++) tile(observation, x, 7, 0, 1);
    for (let y = 1; y < 7; y++) tile(observation, 9, y, null);
    const army = tile(observation, 9, 3, 0, 158);
    tile(observation, 9, 1, 1, 164);
    tile(observation, 10, 3, null, 44, true);
    observation.tiles[observation.generals[0]].armies = 33;
    observation.history = observation.tiles.map((value) => ({ ...value, lastSeenTurn: observation.turn }));
    const decision = new GeneralsAgent(options).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', task: { kind: 'defend', target: observation.generals[0] } });
    if (decision.kind !== 'move') throw new Error('A timely return route exists');
    expect(decision.move.from).toBe(army);
    expect(decision.move.to).toBe(army + observation.width);
  });

  it('takes a nearby city while a distant threat leaves ample time for its field army to return', () => {
    const observation = board(18, 3, [0, 1]);
    for (let x = 1; x <= 16; x++) tile(observation, x, 1, null);
    tile(observation, 1, 1, 0, 1);
    const army = tile(observation, 2, 1, 0, 80);
    const city = tile(observation, 3, 1, null, 10, true);
    tile(observation, 16, 1, 1, 30);
    observation.history = observation.tiles.map((value) => ({ ...value, lastSeenTurn: observation.turn }));
    const decision = new GeneralsAgent(options).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', move: { from: army, to: city },
      task: { kind: 'capture_city', target: city } });
  });

  it('advances a safe force through rechecked prefixes until it can capture a city', () => {
    let observation = board(7, 3, [0, 1]);
    observation.tiles[observation.generals[0]].armies = 2000;
    for (let x = 1; x <= 3; x++) tile(observation, x, 1, 0, 1);
    const recipient = tile(observation, 4, 1, 0, 30);
    const city = tile(observation, 5, 1, null, 10, true);
    tile(observation, 6, 1, 1, 100);
    observation.history = observation.tiles.map((value) => ({ ...value, lastSeenTurn: observation.turn }));
    const agent = new GeneralsAgent(options);
    let decision = agent.decide(observation);
    expect(decision.kind).toBe('move');
    expect(['capture_city', 'gather']).toContain(decision.task.kind);
    expect(decision.move?.from).toBe(observation.generals[0]);
    expect(decision.reason).toContain('mission_next_step_only;prefix_verified;goal_unverified');
    if (decision.kind !== 'move') throw new Error('The current prefix is safe');
    expect(decision.plan?.nextStepOnly).toBe(true);
    expect(decision.plan?.routes).toHaveLength(1);
    expect(decision.plan?.routes[0].path.slice(0, 2)).toEqual([decision.move.from, decision.move.to]);
    expect(decision.plan?.routes[0].path.at(-1)).toBe(decision.task.target);
    expect(decision.plan!.routes[0].path.length).toBeGreaterThan(2);
    for (let step = 0; step < 4; step++) {
      expect(['gather', 'capture_city']).toContain(decision.task.kind);
      expect([recipient, city]).toContain(decision.task.target);
      expect(decision).toMatchObject({ kind: 'move',
        move: { from: observation.generals[0] + step, to: observation.generals[0] + step + 1 } });
      if (decision.kind !== 'move') throw new Error('The current prefix is safe');
      const projected = projectVisibleRoute(observation, [decision.move.from, decision.move.to], decision.move.half,
        new SearchBudget(options.maxSearchNodes, options.decisionBudgetMs));
      if (!projected) throw new Error('The issued move must be legal on the current map');
      observation = { ...projected.observation, revision: observation.revision + 1,
        history: projected.observation.tiles.map((value) => ({ ...value, lastSeenTurn: projected.observation.turn })) };
      decision = agent.decide(observation);
    }
    expect(decision).toMatchObject({ kind: 'move', task: { kind: 'capture_city', target: city },
      move: { from: recipient, to: city } });
  });
});
