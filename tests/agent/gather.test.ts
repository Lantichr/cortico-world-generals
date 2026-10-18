import { describe, expect, it } from 'vitest';
import { analyzeGathering, searchGatheringRoutes } from '../../src/agent/gather.ts';
import { analyzePosition } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { SearchBudget } from '../../src/agent/search.ts';

function position(rows: string[], turn = 100): AgentObservation {
  const width = rows[0].trim().split(/\s+/).length;
  let home = -1;
  const tiles = rows.flatMap((row, y) => row.trim().split(/\s+/).map((cell, x) => {
    const index = y * width + x, own = /^[Ga]/.test(cell), enemy = cell.startsWith('e');
    if (cell.startsWith('G')) home = index;
    return { index, x, y, terrain: cell === '#' ? -2 : cell === '?' ? -3 : cell === 'X' ? -4 : own ? 0 : enemy ? 1 : -1,
      visible: cell !== '?' && cell !== 'X', owner: own ? 0 : enemy ? 1 : null,
      armies: cell === '?' || cell === 'X' || cell === '#' ? null : own || enemy ? Number(cell.slice(1)) : 0,
      general: cell.startsWith('G'), city: false, tunnelLimit: cell === '?' || cell === 'X' ? null : 0 };
  }));
  return { gameId: 'gather', revision: 1, controlEpoch: 1, playerIndex: 0, turn, width, height: rows.length,
    tiles, history: tiles.map((tile) => tile.visible ? { ...tile, lastSeenTurn: turn } : null), generals: [home, -1], scores: [] };
}

function gather(observation: AgentObservation, nodes = 4000) {
  const budget = new SearchBudget(nodes, 1000, performance.now());
  return { ...analyzeGathering(observation, analyzePosition(observation), budget), budget };
}

describe('autonomous gathering topology', () => {
  it('finds the longer owned gathering route when the attack shortcut crosses enemy land', () => {
    const observation = position(['a1 a1 a1 a1 #', 'a100 a1 e0 a150 .', 'G2 # # # #']);
    const routes = searchGatheringRoutes(observation, analyzePosition(observation), 8, [5], new SearchBudget(4000, 1000, performance.now()));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ source: 5, target: 8, captured: 0, unknown: false });
    expect(routes[0].path).toHaveLength(6);
    expect(routes[0].path).not.toContain(7);
    expect(routes[0].path.every((index) => observation.tiles[index].owner === observation.playerIndex)).toBe(true);
  });

  it('finds the owned detour around the general while allowing its own departure route', () => {
    const observation = position(['a1 a1 a1 a1 #', 'a100 a1 G40 a150 .', '# # # # #']);
    const routes = searchGatheringRoutes(observation, analyzePosition(observation), 8, [5, 7], new SearchBudget(4000, 1000, performance.now()));
    const field = routes.find((route) => route.source === 5)!;
    expect(field.path).toHaveLength(6);
    expect(field.path).not.toContain(7);
    expect(routes.find((route) => route.source === 7)?.path).toEqual([7, 8]);
  });

  it('allows gathering into the general and includes production across turn fifty', () => {
    const observation = position(['G2 a3 a20'], 49);
    const routes = searchGatheringRoutes(observation, analyzePosition(observation), 0, [2], new SearchBudget(4000, 1000, performance.now()));
    expect(routes).toMatchObject([{ source: 2, target: 0, path: [2, 1, 0], armies: 26 }]);
  });

  it('retains the general departure reserve and rejects departures that cannot retain it', () => {
    const observation = position(['G20 a2 a30 .']);
    const analysis = analyzePosition(observation);
    analysis.homeReserve = 10;
    expect(searchGatheringRoutes(observation, analysis, 2, [0], new SearchBudget(4000, 1000, performance.now())))
      .toMatchObject([{ path: [0, 1, 2], half: true, armies: 41 }]);
    analysis.homeReserve = 11;
    expect(searchGatheringRoutes(observation, analysis, 2, [0], new SearchBudget(4000, 1000, performance.now()))).toEqual([]);
  });

  it('keeps completed transports when the shared node budget expires during further source search', () => {
    const observation = position(['G2 a10 a20 a30 .']);
    const budget = new SearchBudget(3, 1000, performance.now());
    expect(searchGatheringRoutes(observation, analyzePosition(observation), 1, [2, 3], budget))
      .toMatchObject([{ source: 2, target: 1, path: [2, 1] }]);
    expect(budget.nodes).toBe(3);
    expect(budget.exhausted).toBe(true);
  });

  it('stops gathering search when the cooperative time budget has expired', () => {
    const observation = position(['G2 a10 a20']);
    const budget = new SearchBudget(4000, 0, performance.now());
    expect(searchGatheringRoutes(observation, analyzePosition(observation), 1, [2], budget)).toEqual([]);
    expect(budget.exhausted).toBe(true);
  });

  it('does not spend search nodes when every supplied source is the target or cannot move', () => {
    const observation = position(['G2 a10 a1']);
    const budget = new SearchBudget(1, 1000, performance.now());
    expect(searchGatheringRoutes(observation, analyzePosition(observation), 1, [1, 2], budget)).toEqual([]);
    expect(budget.nodes).toBe(0);
  });

  it('does not connect a gathering route through historical ownership hidden by fog', () => {
    const observation = position(['G2 a20 ? a30']);
    observation.history[2] = { ...observation.tiles[2], owner: 0, armies: 90, terrain: 0, visible: true,
      general: false, city: false, tunnelLimit: 0, lastSeenTurn: 95 };
    expect(searchGatheringRoutes(observation, analyzePosition(observation), 3, [1], new SearchBudget(4000, 1000, performance.now()))).toEqual([]);
  });

  it('recovers the largest army enclosed by the map edge and two mountains instead of gathering into it', () => {
    const observation = position(['. # #', 'a9 a1 G2', '# # a54', '# # #']);
    const before = structuredClone(observation);
    const result = gather(observation);
    expect(result.anchor).toBe(3);
    expect(result.recover).toEqual({ source: 8, target: 5, path: [8, 5], armies: 55,
      captured: 0, unknown: false, half: false });
    expect(observation).toEqual(before);
  });

  it('keeps an army in a thin multistep corridor with open land at its far end', () => {
    const result = gather(position(['G5 a1 a30 a1 . #']));
    expect(result.anchor).toBe(2);
    expect(result.recover).toBeNull();
  });

  it('uses the general as a temporary target when every field component is enclosed', () => {
    const result = gather(position(['G2 a1 a2 a20 #']));
    expect(result.anchor).toBe(0);
    expect(result.recover).toMatchObject({ source: 3, target: 0, path: [3, 2, 1, 0], armies: 23 });
  });

  it('recomputes the return route when an intervening tile is lost and recaptured', () => {
    const observation = position(['G2 a1 a30 #']);
    expect(gather(observation).recover?.path).toEqual([2, 1, 0]);
    Object.assign(observation.tiles[1], { owner: 1, terrain: 1, armies: 5 });
    expect(gather(observation)).toMatchObject({ anchor: 2, recover: null });
    Object.assign(observation.tiles[1], { owner: 0, terrain: 0, armies: 1 });
    expect(gather(observation)).toMatchObject({ anchor: 0, recover: { path: [2, 1, 0] } });
  });

  it('treats ordinary fog as an exploration boundary without adding historical armies to a route', () => {
    const observation = position(['G2 a30 ?']);
    observation.history[2] = { ...observation.tiles[2], owner: 0, armies: 90, terrain: 0, visible: true,
      general: false, city: false, tunnelLimit: 0, lastSeenTurn: 95 };
    expect(gather(observation)).toMatchObject({ anchor: 1, recover: null });
  });

  it('does not select an unseen historical army as a field anchor or recovery source', () => {
    const observation = position(['G2 ? #']);
    observation.history[1] = { ...observation.tiles[1], owner: 0, armies: 90, terrain: 0, visible: true,
      general: false, city: false, tunnelLimit: 0, lastSeenTurn: 95 };
    expect(gather(observation)).toMatchObject({ anchor: 0, recover: null });
  });

  it('does not use obstacle fog as an exit unless a city was observed there', () => {
    const observation = position(['G2 a30 X']);
    expect(gather(observation)).toMatchObject({ anchor: 0, recover: { path: [1, 0] } });
    observation.history[2] = { ...observation.tiles[2], terrain: -1, city: true, visible: true,
      owner: null, armies: 45, tunnelLimit: 0, lastSeenTurn: 95 };
    expect(gather(observation)).toMatchObject({ anchor: 1, recover: null });
  });

  it('retains a known mountain behind ordinary fog when classifying exits', () => {
    const observation = position(['G2 a30 ?']);
    observation.history[2] = { ...observation.tiles[2], terrain: -2, visible: true, lastSeenTurn: 95 };
    expect(gather(observation)).toMatchObject({ anchor: 0, recover: { path: [1, 0] } });
  });

  it('includes land and general production when an owned recovery route crosses turn fifty', () => {
    const result = gather(position(['G2 a3 a20 #'], 49));
    expect(result.recover).toMatchObject({ path: [2, 1, 0], armies: 26, half: false });
  });

  it('does not return an enclosed army across an unowned tile or an unsupported tunnel', () => {
    const observation = position(['G2 a1 a30 #']);
    Object.assign(observation.tiles[1], { tunnelLimit: 2 });
    expect(gather(observation)).toMatchObject({ anchor: 0, recover: null });
  });

  it('does not classify a partially scanned component as an enclosed recovery source', () => {
    const result = gather(position(['G2 a30 a1 a1 .']), 1);
    expect(result).toMatchObject({ anchor: null, recover: null });
    expect(result.budget.nodes).toBe(1);
    expect(result.budget.exhausted).toBe(true);
  });
});
