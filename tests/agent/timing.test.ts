import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { planDefense } from '../../src/agent/defense.ts';
import { SearchBudget, type Route } from '../../src/agent/search.ts';
import { assessMissionPlanTiming, assessMissionTiming, createThreatTiming, findReturnRoute } from '../../src/agent/timing.ts';

function board(width: number, height: number, home: number): AgentObservation {
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index, x: index % width, y: Math.floor(index / width),
    terrain: -1, visible: true, armies: 0, owner: null as number | null, city: false, general: index === home, tunnelLimit: 0 }));
  Object.assign(tiles[home], { owner: 0, terrain: 0, armies: 10 });
  return { gameId: 'timing', revision: 1, controlEpoch: 1, playerIndex: 0, turn: 100, width, height,
    tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [home, -1], scores: [] };
}

function force(observation: AgentObservation, index: number, owner: number, armies: number): void {
  Object.assign(observation.tiles[index], { owner, terrain: owner, armies });
}

function route(path: number[], half = false): Route {
  return { source: path[0], target: path.at(-1)!, path, armies: 1, half, captured: 0, unknown: false };
}

function screenedCorridor(): AgentObservation {
  const observation = board(3, 2, 0);
  observation.turn = 101;
  force(observation, 0, 0, 6);
  force(observation, 1, 0, 5);
  force(observation, 2, 1, 10);
  observation.tiles[2].general = true;
  force(observation, 4, 0, 1);
  for (const index of [3, 5]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
  return observation;
}

describe('shared movement timing', () => {
  it('allows reinforcing an unmoved screen when the combined home defense covers every visible enemy', () => {
    const observation = screenedCorridor(), before = structuredClone(observation);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([0, 1], true), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'safe', deadlineTurn: null, returnRoute: null });
    expect(assessment.reason).toContain('held_home_screen:1;aggregate_enemy:11');
    expect(observation).toEqual(before);
  });

  it('restores raw home demand when any mission step withdraws a held screen', () => {
    const observation = screenedCorridor();
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([0, 1, 4], true), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 103 });
    expect(assessment.reason).not.toContain('held_home_screen');
  });

  it('rechecks combined defense after the home force leaves through another branch', () => {
    const observation = screenedCorridor();
    force(observation, 3, 0, 30);
    force(observation, 4, 0, 30);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([0, 3, 4], true), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 103, slackTurns: 0 });
    expect(assessment.reason).toContain('mission_outlasts_unmet_home_deadline');
  });

  it('does not use the same screen separately to cover two enemy forces', () => {
    const observation = board(4, 1, 0);
    observation.turn = 101;
    force(observation, 0, 0, 6);
    force(observation, 1, 0, 10);
    force(observation, 2, 1, 10);
    force(observation, 3, 1, 10);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([0, 1], true), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', returnRoute: { source: 1, target: 0 } });
    expect(assessment.reason).toContain('return_unmet_home_arrival');
  });

  it.each([0, 1, 20])('rejects a twenty-move late home arrival before spending a %i-node budget', (nodes) => {
    const observation = board(21, 2, 0);
    force(observation, 12, 1, 100);
    force(observation, 40, 0, 1000);
    const path = [...Array.from({ length: 20 }, (_, index) => 40 - index), 0];
    const budget = new SearchBudget(nodes, 1000), before = structuredClone(observation);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route(path), budget);
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 112, slackTurns: -8, returnRoute: null });
    expect(assessment.reason).toContain('mission_outlasts_unmet_home_deadline;first_home_move:20');
    expect(budget.nodes).toBe(0);
    expect(observation).toEqual(before);
  });

  it.each([0, 1, 20])('rejects a twenty-move mission without home reinforcement before spending a %i-node budget', (nodes) => {
    const observation = board(21, 2, 0);
    force(observation, 12, 1, 100);
    force(observation, 41, 0, 1000);
    const budget = new SearchBudget(nodes, 1000);
    const assessment = assessMissionTiming(observation, analyzePosition(observation),
      route(Array.from({ length: 21 }, (_, index) => 41 - index)), budget);
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 112, slackTurns: -8, returnRoute: null });
    expect(assessment.reason).toContain('mission_outlasts_unmet_home_deadline;first_home_move:none');
    expect(budget.nodes).toBe(0);
  });

  it('allows reinforcement arriving exactly at the initial home deadline', () => {
    const observation = board(21, 2, 0);
    force(observation, 12, 1, 100);
    force(observation, 32, 0, 1000);
    const path = [...Array.from({ length: 12 }, (_, index) => 32 - index), 0];
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route(path), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: null });
    expect(assessment.reason).toContain('no_unmet_home_arrival');
  });

  it('keeps an early home reinforcement when later independent legs extend beyond the initial deadline', () => {
    const observation = board(21, 3, 0);
    force(observation, 12, 1, 100);
    force(observation, 21, 0, 200);
    force(observation, 62, 0, 1000);
    const assessment = assessMissionPlanTiming(observation, analyzePosition(observation),
      [route([21, 0]), route(Array.from({ length: 21 }, (_, index) => 62 - index))], new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: null });
    expect(assessment.reason).toContain('no_unmet_home_arrival');
  });

  it('does not use later city production to conceal a garrison lost before a transport arrives', () => {
    const observation = board(5, 5, 0);
    for (const index of [1, 5]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    force(observation, 4, 1, 8);
    force(observation, 20, 0, 30);
    force(observation, 8, 0, 5);
    observation.tiles[8].city = true;
    const before = structuredClone(observation);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([20, 21, 22, 23, 18, 13, 8]),
      new SearchBudget(4000, 1000));
    expect(assessment.status).toBe('unsafe');
    expect(assessment.reason).toContain('mission_waiting_garrison_exposed:8');
    expect(observation).toEqual(before);
  });

  it.each([60, 4000])('retains an unsafe primary return when its alternative search is incomplete at %i nodes', (maxNodes) => {
    const observation = board(9, 3, 0);
    force(observation, 8, 1, 80);
    force(observation, 12, 0, 30);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([12, 13]),
      new SearchBudget(maxNodes, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', returnRoute: { source: 13, target: 0 } });
    expect(assessment.reason).toContain('return_unmet_home_arrival');
    expect(assessment.reason).toContain('alternative_return_search_incomplete');
  });

  it('does not treat an independent defense for the first enemy as coverage for a larger later enemy', () => {
    const observation = board(7, 3, 0);
    force(observation, 3, 1, 15);
    force(observation, 6, 1, 50);
    force(observation, 7, 0, 20);
    force(observation, 14, 0, 8);
    const analysis = analyzePosition(observation), budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(observation, analysis);
    const defense = planDefense(observation, analysis, budget, null, timing);
    expect(defense).toMatchObject({ status: 'sufficient', deadlineTurn: 103, requiredArmies: 13 });
    const assessment = assessMissionTiming(observation, analysis, route([14, 15]), budget, timing, defense);
    expect(assessment.status).not.toBe('safe');
  });
  it('still accepts the mission army returning when an independent defense covers only the first enemy', () => {
    const observation = board(7, 3, 0);
    force(observation, 4, 1, 16);
    force(observation, 6, 1, 50);
    force(observation, 7, 0, 20);
    force(observation, 14, 0, 80);
    const analysis = analyzePosition(observation), budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(observation, analysis);
    const defense = planDefense(observation, analysis, budget, null, timing);
    const assessment = assessMissionTiming(observation, analysis, route([14, 15]), budget, timing, defense);
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: { source: 15, target: 0 } });
    expect(assessment.reason).toContain('mission_and_return');
  });
  it('does not add a waiting garrison that an enemy may capture before the transport reaches it', () => {
    const observation = board(5, 3, 0);
    for (const index of [1, 5]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    force(observation, 4, 1, 20);
    force(observation, 10, 0, 30);
    force(observation, 8, 0, 5);
    const analysis = analyzePosition(observation);
    expect(analysis.threats).toEqual([]);
    const assessment = assessMissionPlanTiming(observation, analysis, [route([10, 11, 12, 13, 8])], new SearchBudget(4000, 1000));
    expect(assessment.status).toBe('unsafe');
    expect(assessment.reason).toContain('mission_waiting_garrison_exposed:8');
  });
  it('projects separate real mission legs and recognizes their completed home reinforcement', () => {
    const observation = board(7, 3, 0);
    force(observation, 6, 1, 80);
    force(observation, 14, 0, 8);
    force(observation, 7, 0, 90);
    const before = structuredClone(observation);
    const assessment = assessMissionPlanTiming(observation, analyzePosition(observation), [route([14, 15]), route([7, 0])],
      new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: null });
    expect(assessment.reason).toContain('no_unmet_home_arrival');
    expect(observation).toEqual(before);
  });

  it('does not use a later mission leg to conceal a general lost before that leg arrives', () => {
    const observation = board(7, 3, 0);
    force(observation, 2, 1, 20);
    force(observation, 14, 0, 100);
    force(observation, 7, 0, 100);
    const assessment = assessMissionPlanTiming(observation, analyzePosition(observation), [route([14, 15, 16]), route([7, 0])],
      new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 102, slackTurns: -1 });
    expect(assessment.reason).toContain('mission_outlasts_unmet_home_deadline');
  });
  it('keeps distant visible and recently hidden forces without replacing current fog facts', () => {
    const observation = board(20, 1, 0);
    force(observation, 15, 1, 40);
    observation.history[18] = { ...observation.tiles[18], owner: 1, terrain: 1, armies: 50, lastSeenTurn: 90 };
    Object.assign(observation.tiles[18], { visible: false, terrain: -3, armies: null });
    const analysis = analyzePosition(observation);
    expect(analysis.threats).toContainEqual(expect.objectContaining({ tile: 15, distance: 15 }));
    expect(analysis.possibleThreats).toContainEqual(expect.objectContaining({ tile: 18, minimumDistance: 8, lastSeenArmies: 50 }));
    expect(observation.tiles[18].armies).toBeNull();
  });

  it('allows an economic move while an independent defense retains positive serial slack', () => {
    const observation = board(20, 3, 0);
    force(observation, 19, 1, 80);
    force(observation, 20, 0, 90);
    force(observation, 42, 0, 8);
    const analysis = analyzePosition(observation), budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(observation, analysis);
    const defense = planDefense(observation, analysis, budget, null, timing);
    expect(defense).toMatchObject({ status: 'sufficient', actionRequired: false, slackTurns: 18 });
    const assessment = assessMissionTiming(observation, analysis, route([42, 43]), budget, timing, defense);
    expect(assessment.status).toBe('safe');
    expect(assessment.reason).toContain('independent_defense_serial_budget');
    expect(budget.nodes).toBeLessThanOrEqual(4000);
  });

  it('rejects an economic destination whose full mission and return exceed the enemy deadline', () => {
    const observation = board(15, 3, 0);
    force(observation, 14, 1, 100);
    force(observation, 40, 0, 110);
    const analysis = analyzePosition(observation), budget = new SearchBudget(4000, 1000);
    const assessment = assessMissionTiming(observation, analysis, route([40, 41, 42, 43, 44]), budget);
    expect(assessment.status).toBe('unsafe');
    expect(assessment.deadlineTurn).toBe(114);
    expect(assessment.reason).toMatch(/no_timely_visible_return|route_collision/);
  });

  it('rechecks collisions after an unrelated mission delays an otherwise sufficient defense', () => {
    const observation = board(5, 4, 17);
    force(observation, 3, 1, 39);
    force(observation, 13, 0, 30);
    force(observation, 18, 0, 5);
    force(observation, 5, 0, 8);
    const analysis = analyzePosition(observation), budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(observation, analysis);
    const defense = planDefense(observation, analysis, budget, null, timing);
    expect(defense).toMatchObject({ status: 'sufficient', slackTurns: 2, route: { path: [13, 18, 17] } });
    const assessment = assessMissionTiming(observation, analysis, route([5, 6]), budget, timing, defense);
    expect(assessment).toMatchObject({ status: 'unsafe', slackTurns: 1 });
    expect(assessment.reason).toContain('shifted_defense_collision:18');
  });

  it('uses a visible neutral shortcut for return and leaves the observation unchanged', () => {
    const observation = board(5, 3, 0);
    force(observation, 4, 0, 30);
    force(observation, 2, 1, 2);
    const before = structuredClone(observation);
    const result = findReturnRoute(observation, 4, 0, new SearchBudget(4000, 1000));
    expect(result).toMatchObject({ path: [4, 3, 2, 1, 0], captured: 3 });
    expect(observation).toEqual(before);
  });

  it('checks losing collisions on the same turn and reports an unexamined query as unknown', () => {
    const observation = board(5, 3, 12);
    force(observation, 2, 1, 151);
    const timing = createThreatTiming(observation, analyzePosition(observation));
    expect(timing.exposure(7, 1, 24, new SearchBudget(0, 1000))).toBeUndefined();
    expect(timing.exposure(7, 1, 24, new SearchBudget(4000, 1000))).toMatchObject({ enemy: 2, arrivalTurns: 1, armies: 150 });
    force(observation, 11, 0, 5);
    expect(assessMissionTiming(observation, analyzePosition(observation), route([11, 10]), new SearchBudget(0, 1000)).status).toBe('unknown');
  });

  it('does not spend distance-search nodes on scattered forces too small to win a collision', () => {
    const observation = board(18, 18, 0);
    for (const tile of observation.tiles.slice(1)) force(observation, tile.index, 1, 2);
    const budget = new SearchBudget(4000, 1000);
    const timing = createThreatTiming(observation, analyzePosition(observation));
    expect(timing.exposure(0, 20, 30, budget)).toBeNull();
    expect(budget.nodes).toBe(0);
  });

  it('reports a fog mission as unverified even when no known force threatens the general', () => {
    const observation = board(2, 1, 0);
    Object.assign(observation.tiles[1], { visible: false, terrain: -3, armies: null, city: null, general: null, tunnelLimit: null });
    const before = structuredClone(observation);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([0, 1]), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unknown', deadlineTurn: null, returnRoute: null });
    expect(assessment.reason).toContain('mission_current_visible_projection_unavailable');
    expect(observation).toEqual(before);
  });

  it('does not spend a general garrison again after a possible earlier attack reduced it', () => {
    const observation = board(4, 2, 0);
    observation.turn = 101;
    force(observation, 0, 0, 100);
    force(observation, 1, 1, 41);
    force(observation, 2, 0, 200);
    Object.assign(observation.tiles[4], { owner: null, terrain: -1, armies: 70 });
    const assessment = assessMissionPlanTiming(observation, analyzePosition(observation),
      [route([2, 3]), route([0, 4])], new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe' });
    expect(assessment.reason).toContain('mission_home_outflow_after_possible_attack');
  });

  it('checks the home deadline before the arrival turn produces new troops', () => {
    const observation = board(3, 2, 0);
    observation.turn = 49;
    force(observation, 0, 0, 2);
    force(observation, 1, 1, 4);
    force(observation, 4, 0, 10);
    const assessment = assessMissionTiming(observation, analyzePosition(observation), route([4, 5]), new SearchBudget(4000, 1000));
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: 50 });
  });

  it('checks field-army collisions with an enemy isolated from the general by known mountains', () => {
    const observation = board(5, 3, 0);
    for (const index of [1, 6, 11]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    force(observation, 3, 1, 151);
    force(observation, 9, 0, 24);
    force(observation, 8, 0, 1);
    const analysis = analyzePosition(observation);
    expect(analysis.threats).toEqual([]);
    const timing = createThreatTiming(observation, analysis);
    expect(timing.exposure(8, 1, 24, new SearchBudget(4000, 1000))).toMatchObject({ enemy: 3, arrivalTurns: 1, armies: 150 });
    const assessment = assessMissionTiming(observation, analysis, route([9, 8]), new SearchBudget(4000, 1000), timing);
    expect(assessment).toMatchObject({ status: 'unsafe', deadlineTurn: null });
    expect(assessment.reason).toContain('mission_route_collision:8');
  });
});
