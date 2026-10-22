import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/agent/analysis.ts';
import { planDefense } from '../../src/agent/defense.ts';
import { assessFfaRecovery, selectFfaFocus } from '../../src/agent/ffa.ts';
import { createThreatTiming, projectVisibleRoute } from '../../src/agent/timing.ts';
import { SearchBudget } from '../../src/agent/search.ts';
import { IntentController } from '../../src/intent.ts';
import { FfaArena } from './ffa-arena.ts';
import { GeneralsAgent } from '../../src/agent/agent.ts';

describe('FFA policy and parallel defense', () => {
  it('keeps distant general garrisons as strategic bounds while field armies and nearby generals enforce deadlines', () => {
    const arena = new FfaArena(7, 3, [0, 6, 20]);
    arena.cells[6].armies = 100;
    Object.assign(arena.cells[13], { owner: 0, armies: 1 });
    let analysis = analyzePosition(arena.observe(0));
    expect(analysis.strategicHomeDemands).toContainEqual(expect.objectContaining({ tile: 6, required: 95 }));
    expect(analysis.homeDemands.some((demand) => demand.sources.includes(6))).toBe(false);
    Object.assign(arena.cells[5], { owner: 1, armies: 100 });
    // Reveal the field army without changing its distance to home.
    Object.assign(arena.cells[12], { owner: 0, armies: 1 });
    analysis = analyzePosition(arena.observe(0));
    expect(analysis.homeDemands.some((demand) => demand.sources.includes(5))).toBe(true);
    const adjacent = new FfaArena(5, 1, [0, 2, 4]);
    adjacent.cells[2].armies = 100;
    Object.assign(adjacent.cells[1], { owner: 0, armies: 1 });
    expect(analyzePosition(adjacent.observe(0)).homeDemands.some((demand) => demand.sources.includes(2))).toBe(true);
  });

  it('allows one locally safe recovery step with an existing home deficit but rejects home withdrawal and marching away', () => {
    const arena = new FfaArena(7, 3, [0, 6, 20]);
    arena.cells[0].armies = 10;
    Object.assign(arena.cells[4], { owner: 1, armies: 100 });
    Object.assign(arena.cells[14], { owner: 0, armies: 20 });
    Object.assign(arena.cells[7], { owner: 0, armies: 3 });
    Object.assign(arena.cells[3], { owner: 0, armies: 1 });
    const view = arena.observe(0), analysis = analyzePosition(view), budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(view, analysis);
    const route = projectVisibleRoute(view, [14, 7], false, budget)!.route;
    expect(assessFfaRecovery(view, analysis, route, budget, timing)?.reason).toContain('bounded_recovery');
    const away = projectVisibleRoute(view, [7, 14], false, budget)!.route;
    expect(assessFfaRecovery(view, analysis, away, budget, timing)).toBeNull();
    const outflow = projectVisibleRoute(view, [0, 1], false, budget)!.route;
    expect(assessFfaRecovery(view, analysis, outflow, budget, timing)).toBeNull();
    const decision = new GeneralsAgent({ decisionBudgetMs: 1000, maxSearchNodes: 4000 }).decide(view);
    expect(decision.kind).toBe('move');
    if (decision.kind === 'move') expect(decision.move.from).not.toBe(analysis.home);
  });

  it('does not recover a home screen into a city when the withdrawal increases an enemy arrival deficit', () => {
    const arena = new FfaArena(7, 3, [0, 6, 20]);
    arena.cells[0].armies = 10;
    Object.assign(arena.cells[1], { owner: 0, armies: 120 });
    arena.cells[7].mountain = true;
    Object.assign(arena.cells[8], { owner: null, city: true, armies: 20 });
    Object.assign(arena.cells[3], { owner: 0, armies: 1 });
    Object.assign(arena.cells[4], { owner: 1, armies: 100 });
    const view = arena.observe(0), analysis = analyzePosition(view), budget = new SearchBudget(4000, 1000);
    const route = projectVisibleRoute(view, [1, 8], false, budget)!.route;
    expect(assessFfaRecovery(view, analysis, route, budget, createThreatTiming(view, analysis))).toBeNull();
  });
  it('plays without S2 through elimination and a final victory from a high player index', () => {
    const arena = new FfaArena(5, 3, [0, 4, 12]);
    arena.cells[12].armies = 200;
    const agent = new GeneralsAgent({ decisionBudgetMs: 1000, maxSearchNodes: 4000 });
    let continuedAfterCapture = false;
    while (arena.winner === null && arena.turn < 100) {
      const survivors = arena.alive.filter(Boolean).length;
      const decision = agent.decide(arena.observe(2));
      if (survivors === 2 && decision.kind === 'move') continuedAfterCapture = true;
      arena.step([null, null, decision.kind === 'move' ? decision.move : null]);
    }
    expect(continuedAfterCapture).toBe(true);
    expect(arena.winner).toBe(2);
    expect(arena.invalidMoves[2]).toBe(0);
  });
  it('adds different players on the same deadline while their individually nonlethal attacks exhaust one garrison', () => {
    const arena = new FfaArena(5, 3, [0, 2, 4]);
    arena.turn = 101;
    arena.cells[0].armies = 30;
    Object.assign(arena.cells[1], { owner: 1, armies: 22 });
    Object.assign(arena.cells[5], { owner: 2, armies: 22 });
    const observation = arena.observe(0), analysis = analyzePosition(observation);
    expect(analysis.homeDemands).toContainEqual(expect.objectContaining({ scenario: 'parallel_players',
      owner: null, players: [1, 2], steps: 1, required: 43, sources: [1, 5] }));
    expect(planDefense(observation, analysis, new SearchBudget(4000, 1000)))
      .toMatchObject({ status: 'unavailable', requiredArmies: 43, projectedArmies: 30, deadlineTurn: 102 });
    arena.step([null, { from: 1, to: 0, half: false }, { from: 5, to: 0, half: false }], [1, 2, 0]);
    expect(arena.alive[0]).toBe(false);
    expect(arena.winner).toBeNull();
  });

  it('does not give two armies of the same player simultaneous moves', () => {
    const arena = new FfaArena(5, 3, [0, 2, 4]);
    arena.cells[0].armies = 30;
    Object.assign(arena.cells[1], { owner: 1, armies: 22 });
    Object.assign(arena.cells[5], { owner: 1, armies: 22 });
    const demands = analyzePosition(arena.observe(0)).homeDemands;
    expect(demands.some((demand) => demand.steps === 1 && demand.required > 22)).toBe(false);
    expect(demands).toContainEqual(expect.objectContaining({ owner: 1, steps: 2, required: 43 }));
  });

  it('uses a single historical alternative per owner when bounding a joint attack', () => {
    const arena = new FfaArena(5, 3, [0, 2, 4]), view = arena.observe(0);
    for (const [index, owner, armies] of [[8, 1, 40], [9, 1, 35], [10, 2, 30]]) {
      view.history[index] = { ...view.tiles[index], owner, armies, terrain: owner, visible: true, lastSeenTurn: 0 };
    }
    const demands = analyzePosition(view).homeDemands.filter((demand) => demand.scenario === 'parallel_players');
    expect(demands.length).toBeGreaterThan(0);
    expect(Math.max(...demands.map((demand) => demand.required))).toBeLessThan(70);
    expect(demands.every((demand) => demand.sources.length === 2)).toBe(true);
  });

  it('accepts an arbitrary surviving opponent and rejects self, unknown and eliminated players', () => {
    const arena = new FfaArena(5, 3, [0, 2, 4, 14]), view = arena.observe(2);
    const controller = new IntentController();
    const proposal = { gameId: view.gameId, controlEpoch: 1, revision: 1, basedOnTurn: 0,
      expiresTurn: 100, constraints: {}, goal: { kind: 'attack_general', player: 3 } };
    expect(controller.submit(proposal, view).goal).toEqual({ kind: 'attack_general', player: 3 });
    for (const player of [2, 8]) expect(() => controller.submit({ ...proposal, revision: 2,
      goal: { kind: 'attack_general', player } }, view)).toThrow('intent_target_player_must_be_opponent');
    view.scores = [{ i: 3, total: 0, tiles: 0, dead: true }];
    expect(() => controller.submit({ ...proposal, revision: 2 }, view)).toThrow('intent_target_player_must_be_opponent');
  });

  it('follows an S2 target without removing any other players from defensive analysis', () => {
    const arena = new FfaArena(5, 3, [0, 2, 4]);
    arena.cells[0].armies = 50;
    Object.assign(arena.cells[1], { owner: 1, armies: 20 });
    Object.assign(arena.cells[5], { owner: 2, armies: 20 });
    const view = arena.observe(0), analysis = analyzePosition(view);
    const intent = new IntentController().submit({ gameId: view.gameId, controlEpoch: 1, revision: 1,
      basedOnTurn: 0, expiresTurn: 100, constraints: {}, goal: { kind: 'attack_general', player: 2 } }, view);
    expect(selectFfaFocus(view, analysis, 1, intent)).toMatchObject({ player: 2, reason: 's2_attack_general' });
    expect(new Set(analysis.threats.map((threat) => threat.owner))).toEqual(new Set([1, 2]));
  });

  it('can develop without an attack focus and reselects after the old opponent is eliminated', () => {
    const arena = new FfaArena(7, 3, [0, 6, 20]);
    arena.cells[0].armies = 100;
    Object.assign(arena.cells[1], { owner: 1, armies: 100 });
    const view = arena.observe(0);
    expect(selectFfaFocus(view, analyzePosition(view), null, null)?.player).toBeNull();
    view.scores = [{ i: 1, total: 0, tiles: 0, dead: true }];
    Object.assign(view.tiles[1], { owner: null, armies: 0, terrain: -1 });
    view.generals[2] = 20;
    expect(selectFfaFocus(view, analyzePosition(view), 1, null)?.player).toBe(2);
  });
});
