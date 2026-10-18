import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/agent/analysis.ts';
import { createThreatTiming } from '../../src/agent/timing.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { projectOwnedRoute, SearchBudget, searchRoutes, searchRouteAlternatives } from '../../src/agent/search.ts';

function line(armies: number[], home = 0): AgentObservation {
  const tiles = armies.map((army, index) => ({ index, x: index, y: 0, terrain: 0, visible: true,
    owner: 0, armies: army, general: index === home, city: false, tunnelLimit: 0 }));
  return { gameId: 'transport', controlEpoch: 1, revision: 1, turn: 100, playerIndex: 0,
    width: armies.length, height: 1, tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })),
    generals: [home, -1], scores: [] };
}

describe('shared route search budget and transport projection', () => {
  it('charges child searches to the parent while preserving unused nodes for other searches', () => {
    const observation = line([20, 2, 2, 20]);
    const budget = new SearchBudget(20, 1000);
    const first = budget.fork(2);
    searchRoutes(observation, 0, 1, first);
    expect(first.exhausted).toBe(true);
    expect(budget.nodes).toBe(first.nodes);
    expect(budget.exhausted).toBe(false);
    const remaining = budget.remainingNodes;
    const second = budget.fork(remaining);
    const routes = searchRoutes(observation, 3, 1, second);
    expect(routes.some((route) => route.source === 3 && route.target === 2)).toBe(true);
    expect(budget.nodes).toBe(first.nodes + second.nodes);
    expect(budget.nodes).toBeLessThanOrEqual(20);
  });

  it('recomputes committed transfers from current armies and retains the general departure reserve', () => {
    const observation = line([11, 2, 3]);
    const route = projectOwnedRoute(observation, [0, 1, 2], 6);
    expect(route).toMatchObject({ source: 0, target: 2, half: true, armies: 9 });
    expect(searchRoutes(observation, 0, 6, new SearchBudget(100, 1000))
      .find((candidate) => candidate.target === 2)).toMatchObject({ half: true, armies: 9 });
    observation.tiles[0].armies = 10;
    expect(projectOwnedRoute(observation, [0, 1, 2], 6)).toBeNull();
  });

  it('invalidates a committed route when an intermediate tile is lost or becomes unusable', () => {
    const observation = line([20, 2, 3]);
    observation.tiles[1].owner = 1;
    expect(projectOwnedRoute(observation, [0, 1, 2], 1)).toBeNull();
    observation.tiles[1].owner = 0;
    observation.tiles[1].tunnelLimit = 5;
    expect(projectOwnedRoute(observation, [0, 1, 2], 1)).toBeNull();
  });

  it('allows returning to the general but rejects crossing it as an intermediate transport step', () => {
    const observation = line([20, 6, 3], 1);
    expect(projectOwnedRoute(observation, [0, 1], 1)).toMatchObject({ target: 1, armies: 25 });
    expect(projectOwnedRoute(observation, [0, 1, 2], 1)).toBeNull();
  });
});

function board(width: number, height: number, home = 0): AgentObservation {
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index, x: index % width, y: Math.floor(index / width),
    terrain: -1, visible: true, armies: 0, owner: null as number | null, city: false, general: index === home, tunnelLimit: 0 }));
  Object.assign(tiles[home], { owner: 0, terrain: 0, armies: 10 });
  return { gameId: 'alternatives', revision: 1, controlEpoch: 1, playerIndex: 0, turn: 100, width, height,
    tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [home, -1], scores: [] };
}

function force(observation: AgentObservation, index: number, owner: number, armies: number): void {
  Object.assign(observation.tiles[index], { owner, terrain: owner, armies });
}

describe('bounded route alternatives', () => {
  it('searches around the general when a shorter transit route would be discarded', () => {
    const observation = board(5, 3, 7);
    force(observation, 6, 0, 50);
    Object.assign(observation.tiles[8], { city: true, armies: 10 });
    const routes = searchRoutes(observation, 6, 1, new SearchBudget(4000, 50));
    expect(routes.find((route) => route.target === 7)).toMatchObject({ path: [6, 7] });
    const attack = routes.find((route) => route.target === 8);
    expect(attack?.path).toHaveLength(5);
    expect(attack?.path).not.toContain(7);
  });

  it('uses a two-move detour to collect enough support when the shortest route loses a timed collision', () => {
    const observation = board(7, 5);
    for (const index of [1, 8, 15, 22, 29]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    force(observation, 16, 0, 20);
    force(observation, 20, 0, 100);
    force(observation, 23, 0, 50);
    force(observation, 4, 1, 30);
    const before = structuredClone(observation), budget = new SearchBudget(4000, 50);
    const result = searchRouteAlternatives(observation, 16, 20, 1, budget,
      { timing: createThreatTiming(observation, analyzePosition(observation)), maxTurns: 6 });
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes[0].path).toHaveLength(7);
    expect(result.routes[0].path).toContain(23);
    expect(result.routes.every((route) => route.path.length > 5)).toBe(true);
    expect(budget.nodes).toBeLessThanOrEqual(4000);
    expect(observation).toEqual(before);
  });

  it('retains both a shorter weak arrival and a longer strong arrival', () => {
    const observation = board(5, 3);
    force(observation, 5, 0, 20);
    force(observation, 11, 0, 50);
    const timing = createThreatTiming(observation, analyzePosition(observation));
    const result = searchRouteAlternatives(observation, 5, 9, 1, new SearchBudget(4000, 50), { timing, maxTurns: 6 });
    expect(result.routes.some((route) => route.path.length === 5 && route.armies < 20)).toBe(true);
    expect(result.routes.some((route) => route.path.length === 7 && route.armies > 50)).toBe(true);
    const limited = searchRouteAlternatives(observation, 5, 9, 1, new SearchBudget(4000, 50), { timing, maxTurns: 4 });
    expect(limited.routes.every((route) => route.path.length === 5)).toBe(true);
    expect(limited.routes.some((route) => route.armies > 50)).toBe(false);
  });

  it('charges truncated alternative searches to their shared parent budget', () => {
    const observation = board(18, 18);
    force(observation, 18, 0, 80);
    const budget = new SearchBudget(4000, 50), child = budget.fork(7);
    const result = searchRouteAlternatives(observation, 18, 323, 1, child,
      { timing: createThreatTiming(observation, analyzePosition(observation)), maxTurns: 40 });
    expect(result).toEqual({ routes: [], complete: false });
    expect(budget.nodes).toBe(child.nodes);
    expect(child.nodes).toBe(7);
    expect(budget.exhausted).toBe(false);
  });
});
