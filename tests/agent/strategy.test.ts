import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentObservation, AgentReport, StrategyGoal, StrategyIntent } from '../../src/agent/contracts.ts';
import type { Route } from '../../src/agent/search.ts';
import { SearchBudget } from '../../src/agent/search.ts';
import { analyzePosition } from '../../src/agent/analysis.ts';
import { planDefense } from '../../src/agent/defense.ts';
import { assessMissionPlanTiming } from '../../src/agent/timing.ts';
import { checkStrategyMove, checkStrategyRoutes, checkStrategyTask, scoreStrategyCandidate, strategyGoalState } from '../../src/agent/strategy.ts';
import type { TaskCandidate } from '../../src/agent/tasks.ts';
import { Arena } from './arena.ts';
import { createStrategyBrief } from '../../src/agent/report.ts';

const options = { decisionBudgetMs: 1000, maxSearchNodes: 12000 };

function board(armies: number[], owners: Array<number | null>, width = armies.length): AgentObservation {
  const tiles = armies.map((army, index) => ({ index, x: index % width, y: Math.floor(index / width),
    terrain: owners[index] ?? -1, visible: true, owner: owners[index], armies: army,
    general: index === 0, city: false, tunnelLimit: 0 }));
  return { gameId: 'intent-game', revision: 1, controlEpoch: 3, playerIndex: 0, turn: 100,
    width, height: armies.length / width, tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })),
    generals: [0, -1], scores: [] };
}

function intent(goal: StrategyGoal, constraints: StrategyIntent['constraints'] = {}): StrategyIntent {
  return { gameId: 'intent-game', controlEpoch: 3, revision: 1, basedOnTurn: 100, expiresTurn: 300, goal, constraints };
}

function route(path: number[], half = false): Route {
  return { source: path[0], target: path.at(-1)!, path, half, armies: 0, captured: 0, unknown: false };
}

function twoCities(): AgentObservation {
  const observation = board([10, 1, 30, 1, 0], [0, null, 0, null, null]);
  observation.tiles[1].city = observation.tiles[3].city = true;
  return observation;
}

function gatheringArena(): { arena: Arena; anchor: number; source: number; strategy: StrategyIntent } {
  const arena = new Arena(901);
  for (const cell of arena.cells) Object.assign(cell, { mountain: true, owner: null, armies: 0, city: false, general: null });
  const at = (x: number, y: number) => y * arena.width + x;
  arena.generals[0] = at(1, 7);
  arena.generals[1] = at(9, 7);
  arena.generals.forEach((index, owner) => Object.assign(arena.cells[index], { mountain: false, owner, armies: 1, general: owner }));
  const anchor = at(5, 3), source = at(5, 5);
  for (const [index, armies] of [[anchor, 80], [at(5, 4), 1], [source, 40]]) {
    Object.assign(arena.cells[index], { mountain: false, owner: 0, armies });
  }
  arena.cells[anchor].city = true;
  Object.assign(arena.cells[at(5, 2)], { mountain: false, owner: 1, armies: 1 });
  arena.turn = 100;
  const observation = arena.observe(0);
  return { arena, anchor, source, strategy: { ...intent({ kind: 'gather', target: { x: 5, y: 3 } }),
    gameId: observation.gameId, controlEpoch: observation.controlEpoch } };
}

describe('Generals strategy constraints', () => {
  it('checks half and full withdrawals against the actual source without modifying facts', () => {
    const observation = board([5, 20, 10], [0, 0, 0]);
    const strategy = intent({ kind: 'auto' }, { reserves: [{ tile: { x: 1, y: 0 }, armies: 10 }] });
    const original = structuredClone(observation);
    expect(checkStrategyMove(observation, strategy, { from: 1, to: 0, half: false })).toBe('strategy_reserve');
    expect(checkStrategyMove(observation, strategy, { from: 1, to: 0, half: true })).toBeNull();
    expect(observation).toEqual(original);
  });

  it('rejects forbidden sources, targets and later route tiles', () => {
    const observation = board([5, 20, 10, 4], [0, 0, 0, 0]);
    const strategy = intent({ kind: 'auto' }, { avoidTiles: [{ x: 3, y: 0 }] });
    expect(checkStrategyMove(observation, strategy, { from: 1, to: 2, half: false })).toBeNull();
    expect(checkStrategyRoutes(observation, strategy, [route([1, 2, 3])])).toBe('strategy_avoid_tile');
    expect(checkStrategyMove(observation, strategy, { from: 3, to: 2, half: false })).toBe('strategy_avoid_tile');
  });

  it('checks intermediate garrisons after merging instead of validating only the sent step', () => {
    const observation = board([5, 20, 10], [0, 0, 0]);
    const strategy = intent({ kind: 'auto' }, { reserves: [{ tile: { x: 1, y: 0 }, armies: 5 }] });
    expect(checkStrategyMove(observation, strategy, { from: 2, to: 1, half: false })).toBeNull();
    expect(checkStrategyRoutes(observation, strategy, [route([2, 1, 0])])).toBe('strategy_reserve');
  });

  it('uses the common sequential turn and producer growth across multiple legs', () => {
    const observation = board([5, 4, 1, 5], [0, 0, 0, 0]);
    observation.turn = 49;
    observation.tiles[1].city = true;
    const strategy = intent({ kind: 'auto' }, { reserves: [{ tile: { x: 1, y: 0 }, armies: 3 }] });
    expect(checkStrategyMove(observation, strategy, { from: 1, to: 0, half: true })).toBe('strategy_reserve');
    expect(checkStrategyRoutes(observation, strategy, [route([3, 2]), route([1, 0], true)])).toBeNull();
  });

  it('permits reinforcement of an under-reserve target while forbidding further withdrawal', () => {
    const observation = board([5, 20], [0, 0]);
    const strategy = intent({ kind: 'auto' }, { reserves: [{ tile: { x: 0, y: 0 }, armies: 10 }] });
    expect(checkStrategyMove(observation, strategy, { from: 0, to: 1, half: true })).toBe('strategy_reserve');
    expect(checkStrategyRoutes(observation, strategy, [route([1, 0])])).toBeNull();
  });
});

describe('Generals S2 intent selection', () => {
  it('selects the specified city over an equally cheap city', () => {
    const observation = twoCities(), original = structuredClone(observation);
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'capture_city', target: { x: 3, y: 0 } }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3 }, task: { kind: 'capture_city', target: 3 } });
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: 1, status: 'following' });
    expect(observation).toEqual(original);
  });

  it.each(['gather', 'defend'] as const)('reinforces a specified owned %s target', (kind) => {
    const observation = board([10, 1, 30, 1, 5], [0, 0, 0, 0, 0]);
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind, target: { x: 4, y: 0 } }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3 }, task: { kind: 'gather', target: 4 } });
    expect(decision.reason).toContain('no_unmet_home_arrival');
    expect(agent.getStrategyFeedback()?.status).toBe('following');
  });

  it('checks the full timing of a requested defense and advances only its verified prefix', () => {
    const armies = Array<number>(15).fill(0), owners = Array<number | null>(15).fill(null);
    for (const [index, army] of [[0, 10], [10, 30], [11, 1], [12, 1], [13, 1], [8, 5]]) {
      armies[index] = army;
      owners[index] = 0;
    }
    armies[4] = 20;
    owners[4] = 1;
    const observation = board(armies, owners, 5);
    for (const index of [1, 5, 6, 7]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'defend', target: { x: 3, y: 1 } }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 10, to: 11 }, task: { kind: 'gather', target: 8 } });
    expect(decision.reason).toContain('mission_next_step_only;prefix_verified;goal_unverified');
    expect(agent.getStrategyFeedback()?.status).toBe('following');
  });

  it('approaches a distant unknown scouting target using current visible steps', () => {
    const observation = board([10, 20, 0, 0, 0, 0, 0], [0, 0, null, null, null, null, null]);
    for (const index of [4, 5, 6]) Object.assign(observation.tiles[index], {
      terrain: -3, visible: false, armies: null, owner: null, city: null, general: null, tunnelLimit: null,
    });
    observation.history[4] = observation.history[5] = observation.history[6] = null;
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'scout', target: { x: 6, y: 0 } }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 1, to: 2 }, task: { kind: 'scout' } });
    expect(decision.reason).toContain('approach_unknown_target');
    expect(agent.getStrategyFeedback()?.status).toBe('following');
    expect(observation.tiles[6].armies).toBeNull();
  });

  it('attacks the selected known enemy general', () => {
    const observation = board([10, 0, 30, 0, 1], [0, null, 0, null, 1]);
    observation.generals[1] = 4;
    observation.tiles[4].general = true;
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'attack_general', player: 1 }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3 }, task: { kind: 'capture_general', target: 4 } });
    expect(agent.getStrategyFeedback()?.status).toBe('following');
  });

  it('reports a tactical preemption for an immediately capturable general', () => {
    const observation = twoCities();
    observation.tiles[3].owner = 1;
    observation.tiles[3].general = true;
    observation.generals[1] = 3;
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'capture_city', target: { x: 1, y: 0 } }));
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3 }, task: { kind: 'capture_general' } });
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'preempted', reason: 'urgent_tactical_task_selected' });
  });

  it('lets an urgent general reinforcement preempt an economic target', () => {
    const observation = board([2, 1, 30, 1, 1, 0, 0, 0, 10, 0, 0, 0],
      [0, 0, 0, null, 0, null, null, null, 1, null, null, null], 4);
    observation.tiles[3].city = true;
    const agent = new GeneralsAgent(options);
    const decision = agent.decide(observation, intent({ kind: 'capture_city', target: { x: 3, y: 0 } }));
    expect(['defend', 'intercept']).toContain(decision.task.kind);
    expect(agent.getStrategyFeedback()?.status).toBe('preempted');
  });

  it.each([2, 4])('does not credit a reserve-breaking defense while selecting a city at enemy distance %i', (enemy) => {
    const armies = Array<number>(15).fill(0), owners = Array<number | null>(15).fill(null);
    for (const [index, army] of [[0, 1], [5, 40], [12, 8]]) { armies[index] = army; owners[index] = 0; }
    armies[enemy] = 30;
    owners[enemy] = 1;
    const observation = board(armies, owners, 5);
    observation.tiles[13].city = true;
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 2 } },
      { reserves: [{ tile: { x: 0, y: 1 }, armies: 20 }] });
    const defense = planDefense(observation, analyzePosition(observation), new SearchBudget(options.maxSearchNodes, options.decisionBudgetMs));
    expect(defense).toMatchObject({ status: 'sufficient', actionRequired: enemy === 2 });
    expect(checkStrategyRoutes(observation, strategy, defense!.paths.map((path) => route(path)))).toBe('strategy_reserve');
    const decision = new GeneralsAgent(options).decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 5, to: 0, half: true }, task: { kind: 'defend' } });
    expect(decision.reason).not.toContain('independent_defense_serial_budget');
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it.each(['avoid', 'reserve'] as const)('does not restart an unsafe economy step through fallback after a %s-invalid defense', (kind) => {
    const observation = board([10, 0, 0, 30, 90, 0, 0, 0, 8, 1, 0, 0],
      [0, null, null, 1, 0, null, null, null, 0, null, null, null], 4);
    observation.tiles[9].city = true;
    const strategy = intent({ kind: 'capture_city', target: { x: 1, y: 2 } }, kind === 'avoid'
      ? { avoidTiles: [{ x: 0, y: 1 }] } : { reserves: [{ tile: { x: 0, y: 1 }, armies: 90 }] });
    const mission = route([8, 9]), defense = planDefense(observation, analyzePosition(observation), new SearchBudget(12000, 1000));
    expect(checkStrategyRoutes(observation, strategy, [mission])).toBeNull();
    const withDefense = assessMissionPlanTiming(observation, analyzePosition(observation), [mission], new SearchBudget(12000, 1000), undefined, defense);
    expect(withDefense.status).toBe('safe');
    expect(withDefense.reason).toContain('independent_defense_serial_budget');
    expect(checkStrategyRoutes(observation, strategy, [mission, ...defense!.paths.map((path) => route(path))]))
      .toBe(kind === 'avoid' ? 'strategy_avoid_tile' : 'strategy_reserve');
    const decision = new GeneralsAgent(options).decide(observation, strategy);
    expect(decision.kind).toBe('wait');
    expect(decision.reason).not.toContain('independent_defense_serial_budget');
  });

  it.each(['avoid', 'reserve'] as const)('rejects city safety that depends on a %s-invalid return route', (kind) => {
    const observation = board([10, 3, 0, 30, 80, 1, 0, 0], [0, 0, null, 1, 0, null, null, null], 4);
    observation.tiles[5].city = true;
    const strategy = intent({ kind: 'capture_city', target: { x: 1, y: 1 } }, kind === 'avoid'
      ? { avoidTiles: [{ x: 1, y: 0 }] } : { reserves: [{ tile: { x: 1, y: 0 }, armies: 3 }] });
    const mission = route([4, 5]);
    expect(checkStrategyRoutes(observation, strategy, [mission])).toBeNull();
    const assessment = assessMissionPlanTiming(observation, analyzePosition(observation), [mission], new SearchBudget(12000, 1000));
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: { path: [5, 1, 0] } });
    const rejected = kind === 'avoid' ? 'strategy_avoid_tile' : 'strategy_reserve';
    expect(checkStrategyRoutes(observation, strategy, [mission, assessment.returnRoute!])).toBe(rejected);
    const decision = new GeneralsAgent(options).decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 4, to: 0 }, task: { kind: 'defend', target: 0 } });
    expect(decision.reason).toContain(`strategy_return_rejected:${rejected}`);
  });

  it('uses an explicit reserve to choose a legal half deployment', () => {
    const observation = twoCities(), agent = new GeneralsAgent(options);
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } },
      { reserves: [{ tile: { x: 2, y: 0 }, armies: 15 }] });
    const decision = agent.decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3, half: true } });
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it('keeps hard constraints when the requested goal is blocked', () => {
    const observation = twoCities(), agent = new GeneralsAgent(options);
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } },
      { avoidTiles: [{ x: 0, y: 0 }], reserves: [{ tile: { x: 2, y: 0 }, armies: 29 }] });
    const decision = agent.decide(observation, strategy);
    expect(decision.kind).toBe('wait');
    expect(agent.getStrategyFeedback()?.status).toBe('blocked');
  });

  it('applies constraints to the zero-budget fallback and can select a different legal neighbor', () => {
    const observation = board([10, 0, 20, 1], [0, null, 0, null]);
    observation.tiles[3].city = true;
    const strategy = intent({ kind: 'auto' }, { avoidTiles: [{ x: 0, y: 0 }, { x: 3, y: 0 }],
      reserves: [{ tile: { x: 2, y: 0 }, armies: 10 }] });
    const agent = new GeneralsAgent({ decisionBudgetMs: 0, maxSearchNodes: 0 });
    const decision = agent.decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 1, half: true }, search: { fallback: true } });
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it('reports observed completion and retains its constraints during autonomous play', () => {
    const observation = twoCities();
    observation.tiles[3].owner = 0;
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } }, { avoidTiles: [{ x: 1, y: 0 }] });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'completed', reason: 'target_city_observed_owned' });
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it('latches completion after a city is lost and lets a new revision request it again', () => {
    const observation = twoCities();
    observation.tiles[3].owner = 0;
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } }, { avoidTiles: [{ x: 1, y: 0 }] });
    const agent = new GeneralsAgent(options);
    agent.decide(observation, strategy);
    observation.tiles[3].owner = null;
    observation.turn++;
    observation.revision++;
    const autonomous = agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: strategy.revision, status: 'completed' });
    expect(autonomous.reason).not.toContain(`strategy_goal:${strategy.revision}:`);
    if (autonomous.kind === 'move') expect(checkStrategyMove(observation, strategy, autonomous.move)).toBeNull();
    observation.turn++;
    observation.revision++;
    const renewed = agent.decide(observation, { ...strategy, revision: 2 });
    expect(renewed).toMatchObject({ kind: 'move', task: { kind: 'capture_city', target: 3 } });
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: 2, status: 'following' });
  });

  it('retains completion observed by the caller before the first agent frame while keeping constraints', () => {
    const observation = twoCities(), strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } },
      { avoidTiles: [{ x: 1, y: 0 }], reserves: [{ tile: { x: 2, y: 0 }, armies: 15 }] });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy, true);
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: strategy.revision, status: 'completed' });
    expect(decision.reason).not.toContain(`strategy_goal:${strategy.revision}:`);
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it('keeps an observed scouting target completed when it returns to fog', () => {
    const observation = twoCities(), strategy = intent({ kind: 'scout', target: { x: 4, y: 0 } });
    const agent = new GeneralsAgent(options);
    agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()?.status).toBe('completed');
    Object.assign(observation.tiles[4], { terrain: -3, visible: false, armies: null, owner: null,
      general: null, city: null, tunnelLimit: null });
    observation.turn++;
    observation.revision++;
    const decision = agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'completed', reason: 'target_observed_since_intent' });
    expect(decision.reason).not.toContain(`strategy_goal:${strategy.revision}:`);
    expect(observation.tiles[4].armies).toBeNull();
  });

  it('releases an existing gathering tree when a scouting target becomes visible', () => {
    const observation = board(Array<number>(35).fill(0), Array<number | null>(35).fill(null), 7);
    for (const tile of observation.tiles) Object.assign(tile, { terrain: -2, armies: null, general: false });
    for (const [index, armies] of [[2, 50], [4, 50], [3, 1], [10, 1], [17, 1], [24, 1], [31, 20]]) {
      Object.assign(observation.tiles[index], { terrain: 0, owner: 0, armies });
    }
    for (const index of [32, 33, 34]) Object.assign(observation.tiles[index], { terrain: -1, armies: 0 });
    Object.assign(observation.tiles[0], { terrain: -3, visible: false, general: null, city: null, tunnelLimit: null });
    observation.generals[0] = 31;
    observation.tiles[31].general = true;
    observation.history = observation.tiles.map((tile) => tile.visible ? { ...tile, lastSeenTurn: observation.turn } : null);
    const strategy = intent({ kind: 'scout', target: { x: 0, y: 0 } });
    const agent = new GeneralsAgent(options), first = agent.decide(observation, strategy);
    expect(first).toMatchObject({ kind: 'move', task: { kind: 'gather', target: 31 } });
    expect(first.reason).toContain('gathering_tree');
    if (first.kind !== 'move') throw new Error('The scenario requires an active gathering tree');
    const sent = observation.tiles[first.move.from].armies! - 1;
    observation.tiles[first.move.from].armies = 1;
    observation.tiles[first.move.to].armies! += sent;
    Object.assign(observation.tiles[0], { terrain: -1, visible: true, armies: 0, general: false, city: false, tunnelLimit: 0 });
    observation.turn++;
    observation.revision++;
    const decision = agent.decide(observation, strategy);
    const autonomous = new GeneralsAgent(options).decide(observation, strategy, true);
    expect(agent.getStrategyFeedback()?.status).toBe('completed');
    expect(decision).toMatchObject({ kind: autonomous.kind, move: autonomous.move, task: autonomous.task });
    expect(decision.reason).not.toContain('committed_gather');
  });

  it.each(['clear', 'expiry'] as const)('clears completed feedback on %s and accepts a later target', (mode) => {
    const observation = twoCities();
    observation.tiles[3].owner = 0;
    const strategy = intent({ kind: 'capture_city', target: { x: 3, y: 0 } });
    const agent = new GeneralsAgent(options);
    agent.decide(observation, strategy);
    observation.tiles[3].owner = null;
    observation.turn++;
    observation.revision++;
    agent.decide(observation, mode === 'clear' ? null : { ...strategy, expiresTurn: observation.turn });
    expect(agent.getStrategyFeedback()).toBeNull();
    observation.turn++;
    observation.revision++;
    agent.decide(observation, { ...strategy, revision: 2 });
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: 2, status: 'following' });
  });

  it('replaces a previous target when a newer intent revision arrives', () => {
    const observation = twoCities();
    observation.tiles[3].city = false;
    observation.tiles[4].city = true;
    observation.tiles[4].armies = 1;
    const agent = new GeneralsAgent(options);
    const first = agent.decide(observation, intent({ kind: 'capture_city', target: { x: 4, y: 0 } }));
    expect(first).toMatchObject({ kind: 'move', move: { from: 2, to: 3 } });
    Object.assign(observation.tiles[2], { armies: 1 });
    Object.assign(observation.tiles[3], { owner: 0, armies: 29 });
    observation.revision++;
    observation.turn++;
    const next = { ...intent({ kind: 'capture_city', target: { x: 1, y: 0 } }), revision: 2 };
    const decision = agent.decide(observation, next);
    expect(decision).toMatchObject({ kind: 'move', move: { to: 1 }, task: { target: 1 } });
    expect(agent.getStrategyFeedback()).toMatchObject({ revision: 2, status: 'following' });
  });

  it('preserves autonomous decisions with omitted, null or expired intents', () => {
    const observation = twoCities();
    const fresh = () => new GeneralsAgent(options);
    const plain = fresh().decide(observation), cleared = fresh().decide(observation, null);
    expect(cleared).toMatchObject({ kind: plain.kind, move: plain.move, task: plain.task, reason: plain.reason });
    for (const expiresTurn of [observation.turn - 1, observation.turn]) {
      const expired = fresh().decide(observation, { ...intent({ kind: 'auto' }), expiresTurn });
      expect(expired).toMatchObject({ kind: plain.kind, move: plain.move, task: plain.task, reason: plain.reason });
    }
  });

  it.each(['older_frame', 'older_epoch'] as const)('does not latch completion from an %s rejection', (kind) => {
    const observation = twoCities(), strategy = { ...intent({ kind: 'capture_city', target: { x: 3, y: 0 } }), basedOnTurn: 98 };
    const agent = new GeneralsAgent(options);
    agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()?.status).toBe('following');
    const stale = structuredClone(observation);
    stale.tiles[3].owner = 0;
    if (kind === 'older_frame') { stale.turn--; stale.revision--; } else stale.controlEpoch--;
    expect(agent.decide(stale, { ...strategy, controlEpoch: stale.controlEpoch }).kind).toBe('wait');
    expect(agent.getStrategyFeedback()?.status).toBe('following');
    observation.turn++;
    observation.revision++;
    agent.decide(observation, strategy);
    expect(agent.getStrategyFeedback()?.status).toBe('following');
  });

  it('uses preferences as soft scores while retaining mechanical and hard constraints', () => {
    const observation = twoCities(), agent = new GeneralsAgent(options);
    const strategy = { ...intent({ kind: 'auto' }, { avoidTiles: [{ x: 3, y: 0 }] }),
      preferences: { emphasis: 'economy' as const, risk: 'high' as const } };
    const decision = agent.decide(observation, strategy);
    expect(decision.task.kind).toBe('capture_city');
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });

  it('lets economy emphasis favor a city over a closely scored land candidate', () => {
    const observation = twoCities();
    const city: TaskCandidate = { kind: 'capture_city', route: route([2, 3]), score: 24, reason: 'city_candidate' };
    const land: TaskCandidate = { kind: 'expand', route: route([2, 3, 4]), score: 30, reason: 'land_candidate' };
    expect(city.score).toBeLessThan(land.score);
    const strategy = { ...intent({ kind: 'auto' }), preferences: { emphasis: 'economy' as const, risk: 'normal' as const } };
    scoreStrategyCandidate(observation, strategy, city);
    scoreStrategyCandidate(observation, strategy, land);
    expect(city.score).toBeGreaterThan(land.score);
  });

  it('uses risk preference to change a close scouting tradeoff', () => {
    const observation = twoCities();
    const candidates = (): [TaskCandidate, TaskCandidate] => [
      { kind: 'scout', route: { ...route([2, 3, 4]), unknown: true }, score: 30, reason: 'frontier_candidate' },
      { kind: 'expand', route: route([2, 3]), score: 30, reason: 'visible_land_candidate' },
    ];
    const low = candidates(), high = candidates();
    for (const [risk, pair] of [['low', low], ['high', high]] as const) for (const candidate of pair) {
      scoreStrategyCandidate(observation, { ...intent({ kind: 'auto' }),
        preferences: { emphasis: 'balanced', risk } }, candidate);
    }
    expect(low[0].score).toBeLessThan(low[1].score);
    expect(high[0].score).toBeGreaterThan(high[1].score);
  });

  it('does not invent a completion threshold for persistent gathering or defense', () => {
    const observation = board([10, 20], [0, 0]);
    for (const kind of ['gather', 'defend'] as const) {
      expect(strategyGoalState(observation, intent({ kind, target: { x: 1, y: 0 } })).status).toBe('active');
    }
  });
});

describe('persistent strategic gathering', () => {
  it.each(['expand', 'scout', 'capture_city', 'gather'] as const)('retains the target garrison across full %s plans and multiple legs', (kind) => {
    const observation = board([1, 30, 80, 1, 0], [0, 0, 0, 0, null]);
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } });
    expect(checkStrategyTask(observation, strategy, kind, [route([1, 2])])).toBeNull();
    expect(checkStrategyTask(observation, strategy, kind, [route([1, 2, 3, 4])])).toBe('strategy_gather_target_held');
    expect(checkStrategyTask(observation, strategy, kind, [route([1, 2]), route([2, 3])])).toBe('strategy_gather_target_held');
    expect(checkStrategyTask(observation, strategy, kind, [route([2, 3], true)])).toBe('strategy_gather_target_held');
  });

  it('finishes gathering and retains the merged army across subsequent authoritative turns', () => {
    const { arena, anchor, source, strategy } = gatheringArena();
    const agent = new GeneralsAgent(options);
    const first = agent.decide(arena.observe(0), strategy);
    expect(first).toMatchObject({ kind: 'move', move: { from: source }, task: { kind: 'gather', target: anchor } });
    arena.step([first.kind === 'move' ? first.move : null, null]);
    const second = agent.decide(arena.observe(0), strategy);
    expect(second).toMatchObject({ kind: 'move', move: { to: anchor }, task: { kind: 'gather', target: anchor } });
    arena.step([second.kind === 'move' ? second.move : null, null]);
    const arrived = arena.cells[anchor].armies;
    expect(arrived).toBeGreaterThan(110);
    for (let tick = 0; tick < 12; tick++) {
      const decision = agent.decide(arena.observe(0), strategy);
      expect(decision).toMatchObject({ kind: 'wait' });
      expect(decision.reason).toContain('strategy_gather_target_held');
      expect(agent.getStrategyFeedback()).toMatchObject({ status: 'following', reason: 'strategy_gather_target_held' });
      arena.step([null, null]);
      expect(arena.cells[anchor].armies).toBeGreaterThanOrEqual(arrived);
    }
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it.each(['clear', 'expiry', 'replacement'] as const)('releases the merged army after intent %s', (mode) => {
    const { arena, anchor, strategy } = gatheringArena();
    arena.cells[5 * arena.width + 5].armies = 1;
    const agent = new GeneralsAgent(options);
    expect(agent.decide(arena.observe(0), strategy).kind).toBe('wait');
    arena.step([null, null]);
    const next = mode === 'clear' ? null : mode === 'expiry' ? { ...strategy, expiresTurn: arena.turn }
      : { ...strategy, revision: 2, goal: { kind: 'expand' as const } };
    const decision = agent.decide(arena.observe(0), next);
    expect(decision).toMatchObject({ kind: 'move', move: { from: anchor, to: 2 * arena.width + 5 }, task: { kind: 'expand' } });
  });

  it.each([options, { decisionBudgetMs: 0, maxSearchNodes: 0 }])('lets other armies expand without an owned route to the target at budget $maxSearchNodes', (budget) => {
    const { arena, anchor, strategy } = gatheringArena();
    arena.cells[5 * arena.width + 5].armies = 1;
    const other = 3 * arena.width + 8, frontier = other + 1;
    Object.assign(arena.cells[other], { mountain: false, owner: 0, armies: 20 });
    Object.assign(arena.cells[frontier], { mountain: false, armies: 0 });
    const decision = new GeneralsAgent(budget).decide(arena.observe(0), strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: other, to: frontier }, task: { kind: 'expand' } });
    expect(arena.cells[anchor].armies).toBe(80);
  });

  it('retains the target even when the zero-budget fallback could capture adjacent land', () => {
    const observation = board([1, 1, 80, 1], [0, 0, 0, 1]);
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } });
    const agent = new GeneralsAgent({ decisionBudgetMs: 0, maxSearchNodes: 0 });
    expect(agent.decide(observation, strategy)).toMatchObject({ kind: 'wait' });
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'following', reason: 'strategy_gather_target_held' });
  });

  it('does not use a weak enemy as a fallback defense excuse to empty the gathering target', () => {
    const observation = board([100, 80, 2], [0, 0, 1]);
    const strategy = intent({ kind: 'gather', target: { x: 1, y: 0 } });
    expect(planDefense(observation, analyzePosition(observation), new SearchBudget(12000, 1000))).toBeNull();
    const agent = new GeneralsAgent({ decisionBudgetMs: 0, maxSearchNodes: 0 });
    expect(agent.decide(observation, strategy)).toMatchObject({ kind: 'wait' });
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'following', reason: 'strategy_gather_target_held' });
  });

  it('retains a future home defense gap in the strategy brief while the gathering army is unreachable', () => {
    const observation = board([2, 0, 80, 1, 0, 0, 50, 0, 0], [0, null, 0, 0, null, null, 1, null, null], 3);
    for (const index of [1, 4, 5, 7, 8]) Object.assign(observation.tiles[index], { terrain: -2, armies: null });
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } });
    const defense = planDefense(observation, analyzePosition(observation), new SearchBudget(12000, 1000));
    expect(defense).toMatchObject({ status: 'unavailable', actionRequired: false, deadlineTurn: observation.turn + 2 });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy);
    expect(decision.kind).toBe('wait');
    expect(agent.getStrategyFeedback()?.status).toBe('blocked');
    const report: AgentReport = { gameId: observation.gameId, controlEpoch: observation.controlEpoch, control: 'autonomous',
      operatorPaused: false, phase: 'playing', observedTurn: observation.turn, method: 'bounded_rule_search', activeIntentRevision: strategy.revision,
      supportedRules: 'standard_or_city_state_1v1', error: null, lastDecision: decision, pendingAction: null, lastFeedback: null,
      intent: { active: strategy, status: agent.getStrategyFeedback()!.status, reason: agent.getStrategyFeedback()!.reason,
        lastRevision: strategy.revision, lastRejection: null } };
    const brief = createStrategyBrief(observation, report);
    expect(brief.estimates?.homeDefense).toEqual({ status: defense!.status, requiredArmies: defense!.requiredArmies,
      projectedArmies: defense!.projectedArmies, gapArmies: defense!.requiredArmies - defense!.projectedArmies,
      deadlineTurn: defense!.deadlineTurn, slackTurns: defense!.slackTurns });
    expect(brief.estimates?.threat).toMatchObject({ x: 0, y: 2, basis: 'visible' });
  });

  it('allows an urgent reinforcement to withdraw from the gathering target', () => {
    const observation = board([2, 1, 80, 1, 1, 0, 0, 0, 50, 0, 0, 0],
      [0, 0, 0, null, 0, null, null, null, 1, null, null, null], 4);
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2 } });
    expect(['defend', 'intercept']).toContain(decision.task.kind);
    expect(agent.getStrategyFeedback()?.status).toBe('preempted');
  });

  it.each(['avoid', 'reserve'] as const)('keeps %s constraints when urgent defense needs the gathering target', (kind) => {
    const observation = board([2, 1, 80, 1, 1, 0, 0, 0, 50, 0, 0, 0],
      [0, 0, 0, null, 0, null, null, null, 1, null, null, null], 4);
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } }, kind === 'avoid'
      ? { avoidTiles: [{ x: 1, y: 0 }] } : { reserves: [{ tile: { x: 2, y: 0 }, armies: 80 }] });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy);
    expect(decision.kind).toBe('wait');
    expect(decision.reason).not.toContain('strategy_gather_target_held');
    expect(agent.getStrategyFeedback()?.status).toBe('blocked');
  });

  it.each([options, { decisionBudgetMs: 0, maxSearchNodes: 0 }])('allows an immediate general capture while retaining its reserve at budget $maxSearchNodes', (budget) => {
    const observation = board([1, 1, 80, 1], [0, 0, 0, 1]);
    observation.tiles[3].general = true;
    observation.generals[1] = 3;
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } });
    const agent = new GeneralsAgent(budget), decision = agent.decide(observation, strategy);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 2, to: 3 }, task: { kind: 'capture_general' } });
    expect(agent.getStrategyFeedback()?.status).toBe('preempted');
    const reserved = { ...strategy, constraints: { reserves: [{ tile: { x: 2, y: 0 }, armies: 80 }] } };
    expect(new GeneralsAgent(budget).decide(observation, reserved).kind).toBe('wait');
    expect(checkStrategyTask(observation, strategy, 'capture_general', [route([2, 1, 0])]))
      .toBe('strategy_gather_target_held');
  });

  it('reports a lost gathering target as blocked and keeps its hard constraints', () => {
    const observation = board([1, 1, 80, 1], [0, 0, 1, null]);
    const strategy = intent({ kind: 'gather', target: { x: 2, y: 0 } }, { avoidTiles: [{ x: 1, y: 0 }] });
    const agent = new GeneralsAgent(options), decision = agent.decide(observation, strategy);
    expect(decision.reason).not.toContain('strategy_gather_target_held');
    expect(agent.getStrategyFeedback()).toMatchObject({ status: 'blocked', reason: 'target_not_currently_owned' });
    if (decision.kind === 'move') expect(checkStrategyMove(observation, strategy, decision.move)).toBeNull();
  });
});
