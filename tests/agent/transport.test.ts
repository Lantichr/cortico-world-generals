import { planGatheringTree, reprojectGatheringTree } from '../../src/agent/gather-tree.ts';
import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { analyzeGathering, searchGatheringRoutes } from '../../src/agent/gather.ts';
import { projectOwnedRoute, SearchBudget, searchRoutes } from '../../src/agent/search.ts';
import { rankTasks } from '../../src/agent/tasks.ts';
import { evaluateTransport, evaluateTransportPlan, transportTargets } from '../../src/agent/transport.ts';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import { Arena } from './arena.ts';
import { assessMissionTiming, createThreatTiming, projectVisibleRoute } from '../../src/agent/timing.ts';

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
  return { gameId: 'transport', revision: 1, controlEpoch: 1, playerIndex: 0, turn, width, height: rows.length,
    tiles, history: tiles.map((tile) => tile.visible ? { ...tile, lastSeenTurn: turn } : null), generals: [home, -1], scores: [] };
}

const budget = (nodes = 100000) => new SearchBudget(nodes, 1000, performance.now());
const missions = (observation: AgentObservation) => observation.tiles.filter((tile) => tile.owner === observation.playerIndex && tile.armies! > 1)
  .flatMap((tile) => searchRoutes(observation, tile.index, 1, budget()));
const transport = (observation: AgentObservation, source: number, target: number) => searchGatheringRoutes(observation,
  analyzePosition(observation), target, [source], budget())[0];

describe('transport purposes', () => {
  it('proves enclosed home recovery when every other boundary is a known mountain', () => {
    const observation = position(['G2 a30 #']), analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[1, 0]], budget())!;
    const evaluation = evaluateTransportPlan(observation, analysis, plan, [], budget())!;
    expect(evaluation).toMatchObject({ purpose: 'home', canContinue: true });
    expect(evaluation.score).toBeGreaterThan(0);
    expect(evaluation.reason).toContain('recovery:all_sources_enclosed_without_home');
  });

  it('does not prove enclosed home recovery across unknown obstacle fog', () => {
    const observation = position(['G2 a30 X']);
    Object.assign(observation.tiles[2], { city: null, general: null });
    const analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[1, 0]], budget())!;
    const evaluation = evaluateTransportPlan(observation, analysis, plan, [], budget())!;
    expect(evaluation).toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    expect(evaluation.reason).not.toContain('recovery:');
  });

  it('does not prove enclosed home recovery across an owned tunnel boundary', () => {
    const observation = position(['G2 a30 a1']);
    observation.tiles[2].tunnelLimit = 1;
    const analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[1, 0]], budget())!;
    const evaluation = evaluateTransportPlan(observation, analysis, plan, [], budget())!;
    expect(evaluation).toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    expect(evaluation.reason).not.toContain('recovery:');
  });

  it('values a home recovery tree only when every source is enclosed without home transit', () => {
    const observation = position(['# a30 # # #', 'a30 a1 G20 a40 .', '# # # # #']);
    const analysis = analyzePosition(observation);
    const closed = reprojectGatheringTree(observation, analysis, [[1, 6], [5, 6, 7]], budget())!;
    const recovery = evaluateTransportPlan(observation, analysis, closed, [], budget())!;
    expect(recovery).toMatchObject({ purpose: 'home', canContinue: true, addedArmies: closed.addedArmies });
    expect(recovery.score).toBeGreaterThan(0);
    expect(recovery.reason).toContain('recovery:all_sources_enclosed_without_home');
    const mixed = reprojectGatheringTree(observation, analysis, [[1, 6], [5, 6, 7], [8, 7]], budget())!;
    const notRecovery = evaluateTransportPlan(observation, analysis, mixed, [], budget())!;
    expect(notRecovery).toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    expect(notRecovery.reason).not.toContain('recovery:');
  });

  it('does not claim enclosed recovery when its component scan runs out of budget', () => {
    const observation = position(['# a30 #', 'a30 a1 a1', '# # G20']);
    const analysis = analyzePosition(observation);
    const plan = planGatheringTree(observation, analysis, 8, [1, 3], 4, budget())!;
    const limited = budget(8);
    const evaluation = evaluateTransportPlan(observation, analysis, plan, [], limited)!;
    expect(evaluation).toMatchObject({ score: 0, canContinue: true });
    expect(evaluation.reason).not.toContain('recovery:');
    expect(limited.exhausted).toBe(true);
  });

  it('keeps proving the closed recovery after each movement and after switching branch sources', () => {
    let observation = position(['# a30 # # #', 'a30 a1 G20 a40 .', '# # # # #']);
    let paths = [[1, 6], [5, 6, 7]];
    const movedFrom: number[] = [];
    while (paths.length) {
      const analysis = analyzePosition(observation);
      const plan = reprojectGatheringTree(observation, analysis, paths, budget())!;
      const evaluation = evaluateTransportPlan(observation, analysis, plan, [], budget())!;
      expect(evaluation.score).toBeGreaterThan(0);
      expect(evaluation.reason).toContain('recovery:all_sources_enclosed_without_home');
      movedFrom.push(paths[0][0]);
      observation = projectVisibleRoute(observation, paths[0].slice(0, 2), false, budget())!.observation;
      paths = [paths[0].slice(1), ...paths.slice(1)].filter((path) => path.length > 1);
    }
    expect(movedFrom).toEqual([1, 5, 6]);
  });

  it('values a multi-leg plan at its final recipient and charges every serial movement', () => {
    const observation = position(['# a30 #', 'a30 a1 a1', 'G2 # a50']), analysis = analyzePosition(observation);
    const plan = planGatheringTree(observation, analysis, 8, [1, 3], 4, budget())!;
    expect(plan.routes[0].target).toBe(4);
    expect(evaluateTransportPlan(observation, analysis, plan, [], budget()))
      .toMatchObject({ purpose: 'army', moves: 4, addedArmies: plan.addedArmies, canContinue: true });
  });

  it('reconstructs every departed multi-leg garrison before evaluating a later general attack', () => {
    const observation = position(['G40 a30 E50', 'a15 a15 #']), analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[4, 1], [3, 0], [1, 0]], budget())!;
    const { projectedObservation: ignored, ...withoutProjection } = plan;
    const complete = evaluateTransportPlan(observation, analysis, plan, [], budget());
    expect(complete).toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    expect(evaluateTransportPlan(observation, analysis, withoutProjection, [], budget())).toEqual(complete);
  });

  it('does not treat unknown ready-task timing as proof to cancel a multi-leg transport', () => {
    const observation = position(['G2 a10 a100 c44']), analysis = analyzePosition(observation);
    const plan = reprojectGatheringTree(observation, analysis, [[1, 2]], budget())!;
    expect(evaluateTransportPlan(observation, analysis, plan, missions(observation), budget(0)))
      .toMatchObject({ canContinue: true });
  });


  it('compares the general, a field army and a frontier with an unmet visible city budget', () => {
    const observation = position(['G2 a1 a20 c45', 'a1 a1 a1 #', 'a90 a1 ? #']);
    const analysis = analyzePosition(observation), routes = missions(observation);
    const gathering = analyzeGathering(observation, analysis, budget());
    expect(transportTargets(observation, analysis, gathering, [0, 2, 8], routes)).toEqual([0, 8, 2]);
    expect(evaluateTransport(observation, analysis, transport(observation, 8, 2), routes, budget()))
      .toMatchObject({ purpose: 'frontier', canContinue: true });
    analysis.homeReserve = 80;
    expect(evaluateTransport(observation, analysis, transport(observation, 8, 0), routes, budget()))
      .toMatchObject({ purpose: 'home', canContinue: true });
  });

  it('does not create a separate recipient for every productive owned city', () => {
    const observation = position(['G10 C30 C40 ?']), analysis = analyzePosition(observation);
    const gathering = analyzeGathering(observation, analysis, budget());
    expect(transportTargets(observation, analysis, gathering, [0, 1, 2], missions(observation))).toEqual([0, 2]);
  });

  it('adds a safe intermediate recipient when enemy timing blocks delivery to the main field army', () => {
    const observation = position(['G300 a50 a1 a50 a1 a1 a100 . E200 #']);
    const analysis = analyzePosition(observation), routes = missions(observation), gathering = analyzeGathering(observation, analysis, budget());
    expect(gathering.anchor).toBe(6);
    const targets = transportTargets(observation, analysis, gathering, [0, 1, 3, 6], routes, budget());
    expect(targets).toHaveLength(3);
    expect(targets).toContain(0);
    expect(targets).toContain(6);
    const middle = targets.find((target) => target !== 0 && target !== 6)!;
    expect([1, 3]).toContain(middle);
    const candidates = routes.filter((route) => route.target === middle && route.source !== middle && route.source !== 0
      && !route.captured && !route.unknown && !route.path.includes(0));
    expect(candidates.some((route) => assessMissionTiming(observation, analysis, route, budget()).status === 'safe')).toBe(true);
  });

  it('keeps the main field recipient when its safe delivery is more efficient than intermediate merging', () => {
    const observation = position(['G2 a10 a1 a30 a100 .']), analysis = analyzePosition(observation);
    const routes = missions(observation), gathering = analyzeGathering(observation, analysis, budget());
    expect(transportTargets(observation, analysis, gathering, [0, 1, 3, 4], routes, budget())).toEqual([0, 4]);
  });

  it('assigns no new home transport value when its projected reserve is already covered', () => {
    const observation = position(['G2 a100 a150 .']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 1, 0), [], budget()))
      .toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    const routes = missions(observation), gathering = analyzeGathering(observation, analysis, budget());
    expect(transportTargets(observation, analysis, gathering, [0, 1, 2], routes)).toEqual([0, 2]);
  });

  it('funds a general departure that can complete a visible objective while retaining its reserve', () => {
    const observation = position(['a100 G40 a30 E50']), analysis = analyzePosition(observation);
    expect(analysis.homeReserve).toBeLessThan(observation.tiles[1].armies!);
    const evaluation = evaluateTransport(observation, analysis, transport(observation, 0, 1), missions(observation), budget())!;
    expect(evaluation).toMatchObject({ purpose: 'home', canContinue: true });
    expect(evaluation.score).toBeGreaterThan(0);
  });

  it('uses an affordable general departure instead of shipping a frontline army home', () => {
    const observation = position(['G70 a1 c44', 'a100 # #']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 3, 0), [], budget()))
      .toMatchObject({ purpose: 'home', canContinue: false, readyTask: { source: 0, target: 2, path: [0, 1, 2] } });
  });

  it('compares direct completion with transport plus departure rather than just the transport leg', () => {
    const observation = position(['G2 a100 a1 c44']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 1, 0), [], budget()))
      .toMatchObject({ purpose: 'home', canContinue: false, readyTask: { source: 1, target: 3, path: [1, 2, 3] } });
  });

  it('does not give new home offense value when the direct completion comparison is incomplete', () => {
    const observation = position(['a100 G40 a30 E50', '. # # #']), analysis = analyzePosition(observation);
    const route = transport(observation, 0, 1), limited = budget(12);
    expect(evaluateTransport(observation, analysis, route, [], limited))
      .toMatchObject({ purpose: 'home', score: 0, canContinue: true });
    expect(limited.exhausted).toBe(true);
    expect(evaluateTransport(observation, analysis, route, [], budget())!.score).toBeGreaterThan(0);
  });

  it('captures a city after leaving home without repeatedly carrying its army back', () => {
    const arena = new Arena(719);
    arena.turn = 100;
    for (const cell of arena.cells) Object.assign(cell, { owner: null, armies: 0, mountain: true, city: false, general: null });
    const home = 4 * arena.width + 4, frontage = home - 1, city = home - 2;
    arena.generals[0] = home;
    arena.generals[1] = 0;
    Object.assign(arena.cells[0], { owner: 1, armies: 1, mountain: false, general: 1 });
    Object.assign(arena.cells[home], { owner: 0, armies: 180, mountain: false, general: 0 });
    Object.assign(arena.cells[frontage], { owner: 0, armies: 1, mountain: false });
    Object.assign(arena.cells[city], { armies: 44, mountain: false, city: true });
    const agent = new GeneralsAgent({ decisionBudgetMs: 1000, maxSearchNodes: 4000 });
    const moves: Array<{ from: number; to: number }> = [];
    for (let tick = 0; tick < 6 && arena.cells[city].owner !== 0; tick++) {
      const decision = agent.decide(arena.observe(0));
      if (decision.kind === 'move') moves.push(decision.move);
      arena.step([decision.kind === 'move' ? decision.move : null, null]);
    }
    expect(arena.cells[city].owner).toBe(0);
    expect(moves).toEqual([{ from: home, to: frontage, half: false }, { from: frontage, to: city, half: false }]);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('does not reuse a screen collected by the home transport to claim the next attack is affordable', () => {
    const observation = position(['G40 a30 E50', '# a15 #']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 4, 0), [], budget()))
      .toMatchObject({ purpose: 'home', score: 0, canContinue: true });
  });

  it('does not credit recipient city production as transported soldiers across turn fifty', () => {
    const observation = position(['G2 a10 C20 #'], 49), analysis = analyzePosition(observation);
    const city = evaluateTransport(observation, analysis, transport(observation, 1, 2), [], budget())!;
    const plain = structuredClone(observation);
    plain.tiles[2].city = false;
    const land = evaluateTransport(plain, analyzePosition(plain), transport(plain, 1, 2), [], budget())!;
    expect(city.addedArmies).toBe(observation.tiles[1].armies! - 1);
    expect(city.addedArmies).toBe(land.addedArmies);
    expect(city.score).toBe(land.score);
  });

  it('stops adding transport value once the visible objective army requirement is covered', () => {
    const observation = position(['G2 a27 a1 a20 c44']), analysis = analyzePosition(observation);
    const enough = evaluateTransport(observation, analysis, transport(observation, 1, 3), [], budget())!;
    const more = structuredClone(observation);
    more.tiles[1].armies = 100;
    const surplus = evaluateTransport(more, analyzePosition(more), transport(more, 1, 3), [], budget())!;
    expect(enough.canContinue).toBe(true);
    expect(surplus.addedArmies).toBeGreaterThan(enough.addedArmies);
    expect(surplus.score).toBe(enough.score);
  });

  it('preserves an active transport when only future recipient production would fund its objective', () => {
    const observation = position(['G2 a10 C45 c44'], 101), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 1, 2), [], budget()))
      .toMatchObject({ canContinue: true, reason: 'owned_transport;purpose:army;added:9;moves:1;useful:0' });
  });

  it('allows a safe merge when its statically affordable city task would collide with an enemy', () => {
    const observation = position(['E100 . c10 a40 a100 G2']), analysis = analyzePosition(observation);
    const routes = missions(observation), route = transport(observation, 4, 3), timing = createThreatTiming(observation, analysis);
    const city = routes.find((candidate) => candidate.source === 3 && candidate.target === 2)!;
    expect(assessMissionTiming(observation, analysis, city, budget(), timing).status).toBe('unsafe');
    expect(assessMissionTiming(observation, analysis, route, budget(), timing).status).toBe('safe');
    expect(evaluateTransport(observation, analysis, route, routes, budget(), {}, timing))
      .toMatchObject({ canContinue: true });
  });

  it('dispatches an already sufficient army to its visible city instead of waiting for a distant transport', () => {
    const observation = position(['G2 a7 a1 a1 a1 a1 a114 c44']), analysis = analyzePosition(observation);
    const route = transport(observation, 1, 6), routes = missions(observation);
    const evaluation = evaluateTransport(observation, analysis, route, routes, budget())!;
    expect(evaluation).toMatchObject({ canContinue: false, readyTask: { source: 6, target: 7, path: [6, 7] } });
    const gathering = analyzeGathering(observation, analysis, budget());
    expect(rankTasks(observation, analysis, [...routes, route], null, budget(), gathering)[0])
      .toMatchObject({ kind: 'capture_city', route: { source: 6, target: 7 } });
  });

  it('can prove a ready visible objective even when the ordinary search omitted its route', () => {
    const observation = position(['G2 a10 a114 c44']), analysis = analyzePosition(observation);
    const evaluation = evaluateTransport(observation, analysis, transport(observation, 1, 2), [], budget());
    expect(evaluation).toMatchObject({ canContinue: false, readyTask: { source: 2, target: 3, path: [2, 3] } });
  });

  it('uses a transporting army on its own affordable objective when it can finish before delivery', () => {
    const observation = position(['G2 a50 a1 a1 a100', '# c10 # # .']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 1, 4), missions(observation), budget()))
      .toMatchObject({ canContinue: false, readyTask: { source: 1, target: 6, path: [1, 6] } });
  });

  it('preserves a normal transport across successive observations despite ordinary expansion opportunities', () => {
    const observation = position(['G2 a18 a1 a1 a50 .']), analysis = analyzePosition(observation);
    const route = transport(observation, 1, 4);
    expect(evaluateTransport(observation, analysis, route, missions(observation), budget()))
      .toMatchObject({ canContinue: true });
    const next = structuredClone(observation);
    next.turn++; next.revision++;
    next.tiles[1].armies = 1; next.tiles[2].armies = 18;
    const remainder = projectOwnedRoute(next, route.path.slice(1), 1)!;
    expect(evaluateTransport(next, analyzePosition(next), remainder, missions(next), budget()))
      .toMatchObject({ canContinue: true });
  });

  it('does not interpret an exhausted objective search as evidence to cancel an active transport', () => {
    const observation = position(['G2 a10 a114 c44']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 1, 2), [], budget(0)))
      .toMatchObject({ canContinue: true });
  });

  it('does not interrupt a transport for an objective route that requires general transit', () => {
    const observation = position(['c10 G20 a50 a10 .']), analysis = analyzePosition(observation);
    expect(evaluateTransport(observation, analysis, transport(observation, 3, 2), missions(observation), budget()))
      .toMatchObject({ canContinue: true });
  });
});
