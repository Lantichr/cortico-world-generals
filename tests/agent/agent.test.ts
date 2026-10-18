import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentDecision, AgentObservation } from '../../src/agent/contracts.ts';
import { Arena, playMatch } from './arena.ts';
import { runGeneralsAgent } from '../../src/agent/runner.ts';

function position(armies: number[], owners: Array<number | null>, home = 0): AgentObservation {
  const tiles = armies.map((army, index) => ({ index, x: index, y: 0, terrain: owners[index] ?? -1,
    visible: true, armies: army, owner: owners[index], city: false, general: index === home, tunnelLimit: 0 }));
  return { gameId: 'position', revision: 1, controlEpoch: 1, turn: 100, playerIndex: 0,
    width: armies.length, height: 1, tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [home, -1], scores: [] };
}

describe('autonomous Generals policy', () => {
  it('advances an existing friendly screen to remove a visible approaching enemy', () => {
    const observation = position([3, 2, 25, 1, 15], [0, 0, 0, 1, 1]);
    const decision = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation);
    expect(decision.kind).toBe('move');
    expect(decision.move).toMatchObject({ from: 2, to: 3 });
  });

  it('captures an exposed general ahead of economic tasks', () => {
    const observation = position([5, 30, 4], [0, 0, 1]);
    observation.tiles[2].general = true;
    observation.generals[1] = 2;
    const decision = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 1, to: 2 }, task: { kind: 'capture_general' } });
  });

  it('does not act twice on duplicate or older frames and resets between games', () => {
    const observation = position([15, 0], [0, null]);
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    expect(agent.decide(observation).kind).toBe('move');
    expect(agent.decide(observation)).toMatchObject({ kind: 'wait', reason: 'duplicate_or_older_observation' });
    expect(agent.decide({ ...observation, revision: 0, turn: 99 }).kind).toBe('wait');
    expect(agent.decide({ ...observation, gameId: 'new' }).kind).toBe('move');
  });

  it('uses a named bounded fallback when no search node is available', () => {
    const decision = new GeneralsAgent({ decisionBudgetMs: 0, maxSearchNodes: 0 }).decide(position([15, 0], [0, null]));
    expect(decision).toMatchObject({ kind: 'move', reason: 'budget_fallback_one_step', search: { nodes: 0, fallback: true } });
    expect(decision.kind === 'move' && decision.plan).toEqual({ routes: [{ path: [0, 1], half: false }], nextStepOnly: false });
  });

  it('rejects retired games and older control epochs', () => {
    const observation = position([15, 0], [0, null]);
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    agent.decide(observation);
    agent.decide({ ...observation, revision: 2, turn: 101, controlEpoch: 2 });
    expect(agent.decide({ ...observation, revision: 3, turn: 102 }).reason).toBe('older_game_or_control_epoch');
    agent.decide({ ...observation, gameId: 'next' });
    expect(agent.decide({ ...observation, revision: 4, turn: 103 }).reason).toBe('older_game_or_control_epoch');
  });

  it('uses a verified corridor screen instead of waiting forever behind a static general reserve', () => {
    const observation = position([11, 0, 10], [0, null, 1]);
    observation.tiles[2].general = true;
    observation.generals[1] = 2;
    const decision = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 0, to: 1, half: true }, task: { kind: 'intercept' } });
    expect(decision.kind === 'move' && decision.plan).toEqual({ routes: [{ path: [0, 1], half: true }], nextStepOnly: false });
    expect(decision.reason).toContain('bottleneck_half_army_screen');
  });

  it('converts corridor land growth into a complete win after a reserve-limited opening', () => {
    const arena = new Arena(15);
    for (const cell of arena.cells) Object.assign(cell, { owner: null, armies: 0, mountain: true, city: false, general: null });
    const home = arena.generals[0], enemy = home + 2;
    arena.generals[1] = enemy;
    Object.assign(arena.cells[home], { owner: 0, armies: 11, mountain: false, general: 0 });
    Object.assign(arena.cells[home + 1], { mountain: false });
    Object.assign(arena.cells[home + 1 + arena.width], { owner: 0, armies: 1, mountain: false });
    Object.assign(arena.cells[enemy], { owner: 1, armies: 10, mountain: false, general: 1 });
    arena.turn = 100;
    const agent = new GeneralsAgent({ decisionBudgetMs: 1000, maxSearchNodes: 4000 });
    let screens = 0;
    while (arena.winner === null && arena.turn < 400) {
      const decision = agent.decide(arena.observe(0));
      if (decision.reason.startsWith('bottleneck_half_army_screen')) screens++;
      arena.step([decision.kind === 'move' ? decision.move : null, null]);
    }
    expect(screens).toBeGreaterThan(0);
    expect(arena.winner).toBe(0);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('guards against a recently hidden main army without presenting its old armies as current facts', () => {
    const observation = position([56, 1, 48], [0, null, 1]);
    Object.assign(observation.tiles[2], { terrain: -3, visible: false, owner: null, armies: null, general: null, city: null, tunnelLimit: null });
    observation.history[2]!.lastSeenTurn = 98;
    const decision = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation);
    expect(decision.kind).toBe('wait');
    expect(decision.reason).toContain('history_guard:2@98');
    expect(decision.reason).toContain('assumption:recent_hidden_or_departed_army_may_approach_general');
  });

  it('retains a possible departed army after its visible source becomes a one-army garrison', () => {
    const observation = position([56, 0, 48, 0], [0, null, 1, null]);
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    agent.decide(observation);
    observation.turn++;
    observation.revision++;
    observation.tiles[2].armies = 1;
    observation.history[2]!.armies = 1;
    const decision = agent.decide(observation);
    expect(decision.kind).toBe('wait');
    expect(decision.reason).toContain('history_guard:2@100');
    expect(observation.tiles[2].armies).toBe(1);
  });

  it('the standalone transport runs a complete game without loading a Persona or model provider', async () => {
    const arena = new Arena(91, true, true);
    const decisions: Array<AgentDecision['kind']> = [];
    async function* observations() {
      while (arena.winner === null && arena.turn < 500) yield arena.observe(0);
    }
    await runGeneralsAgent({ observations: observations(),
      async execute(decision) { arena.step([decision.move, arena.baseline('expander', 1)]); },
      onDecision(decision) {
        decisions.push(decision.kind);
        if (decision.kind === 'wait') arena.step([null, arena.baseline('expander', 1)]);
      },
    }, { decisionBudgetMs: 1000, maxSearchNodes: 4000 });
    expect(arena.winner).toBe(0);
    expect(decisions).toContain('move');
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('the standalone transport aborts while an observation iterator is waiting', async () => {
    const controller = new AbortController();
    let returned = false;
    const running = runGeneralsAgent({ observations: {
      [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<AgentObservation>>(() => {}),
        async return() { returned = true; return { done: true as const, value: undefined }; } }; },
    }, async execute() { throw new Error('No observation should execute'); } },
    { decisionBudgetMs: 50, maxSearchNodes: 4000 }, controller.signal);
    controller.abort();
    await running;
    expect(returned).toBe(true);
  });

  it('reinforces the general over successive independent enemy ticks', () => {
    const arena = new Arena(11);
    for (const cell of arena.cells) Object.assign(cell, { owner: null, armies: 0, mountain: false, city: false, general: null });
    const home = arena.generals[0];
    Object.assign(arena.cells[home], { owner: 0, armies: 3, general: 0 });
    Object.assign(arena.cells[home + 1], { owner: 0, armies: 1 });
    Object.assign(arena.cells[home + 2], { owner: 0, armies: 20 });
    Object.assign(arena.cells[arena.generals[1]], { owner: 1, armies: 1, general: 1 });
    const enemyPath = [home + 2 * arena.width - 1, home + arena.width - 1, home - 1, home];
    Object.assign(arena.cells[enemyPath[0]], { owner: 1, armies: 8 });
    // A visible approach lane exposes the enemy three moves before the general.
    Object.assign(arena.cells[home + arena.width], { owner: 0, armies: 1 });
    arena.turn = 100;
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const tasks = [];
    for (let step = 0; step < 3; step++) {
      const decision = agent.decide(arena.observe(0));
      tasks.push(decision.task.kind);
      arena.step([decision.kind === 'move' ? decision.move : null,
        { from: enemyPath[step], to: enemyPath[step + 1], half: false }]);
    }
    expect(tasks).toContain('defend');
    expect(arena.cells[home]).toMatchObject({ owner: 0, general: 0 });
    expect(arena.cells[home].armies).toBeGreaterThan(3);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('never substitutes last-seen armies for current fog facts', () => {
    const observation = position([10, 3], [0, 1]);
    Object.assign(observation.tiles[1], { terrain: -3, visible: false, owner: null, armies: null, general: null, city: null, tunnelLimit: null });
    const decision = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation);
    expect(decision).toMatchObject({ kind: 'move', task: { kind: 'scout' } });
    expect(decision.prediction).toBeUndefined();
    expect(decision.reason).toContain('current_owner_and_armies_unknown');
  });

  it('retains known mountains after fog returns', () => {
    const observation = position([15, 0], [0, null]);
    observation.history[1]!.terrain = -2;
    Object.assign(observation.tiles[1], { terrain: -4, visible: false, armies: null, owner: null, tunnelLimit: null });
    expect(new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 }).decide(observation).kind).toBe('wait');
  });

  it('the referee applies tie combat, City-State negative garrisons and common production independently', () => {
    const arena = new Arena(1, false, true);
    const source = arena.generals[0], target = source + 1;
    Object.assign(arena.cells[source], { armies: 4 });
    Object.assign(arena.cells[target], { owner: 1, armies: 3 });
    arena.step([{ from: source, to: target, half: false }, null]);
    expect(arena.cells[target]).toMatchObject({ owner: 1, armies: 0 });
    Object.assign(arena.cells[source], { armies: 2 });
    Object.assign(arena.cells[target], { owner: null, armies: -1, city: true });
    arena.step([{ from: source, to: target, half: false }, null]);
    expect(arena.cells[target]).toMatchObject({ owner: 0, armies: 3 });
  });

  it('the referee applies floor-half movement and the fifty-turn land production', () => {
    const arena = new Arena(7);
    const source = arena.generals[0], target = source + 1;
    Object.assign(arena.cells[source], { armies: 9 });
    Object.assign(arena.cells[target], { owner: 0, armies: 3, city: true });
    arena.turn = 49;
    arena.step([{ from: source, to: target, half: true }, null]);
    expect(arena.cells[source].armies).toBe(7);
    expect(arena.cells[target].armies).toBe(9);
    const land = target + 1;
    Object.assign(arena.cells[land], { owner: 0, armies: 4, city: false, general: null });
    arena.turn = 99;
    arena.step([null, null]);
    expect(arena.cells[land].armies).toBe(5);
  });

  it('the referee transfers a defeated player with round-half armies while preserving capture survivors', () => {
    const arena = new Arena(7);
    const target = arena.generals[1], source = target - 1;
    Object.assign(arena.cells[source], { owner: 0, armies: 17, mountain: false, city: false });
    Object.assign(arena.cells[target], { armies: 3 });
    Object.assign(arena.cells[3], { owner: 1, armies: 8 });
    Object.assign(arena.cells[4], { owner: 1, armies: 9 });
    arena.step([{ from: source, to: target, half: false }, null]);
    expect(arena.winner).toBe(0);
    expect(arena.cells[target]).toMatchObject({ owner: 0, armies: 13, general: null, city: true });
    expect(arena.cells[3]).toMatchObject({ owner: 0, armies: 4 });
    expect(arena.cells[4]).toMatchObject({ owner: 0, armies: 5 });
  });

  it('the referee alternates player initiative and distinguishes snapshot validity from competing actions', () => {
    for (const turn of [0, 1]) {
      const arena = new Arena(7);
      Object.assign(arena.cells[1], { owner: 0, armies: 3, mountain: false });
      Object.assign(arena.cells[2], { owner: 1, armies: 3, mountain: false });
      arena.turn = turn;
      arena.step([{ from: 1, to: 2, half: false }, { from: 2, to: 1, half: false }]);
      expect(arena.invalidMoves).toEqual([0, 0]);
      expect(arena.contestedMoves).toEqual(turn === 0 ? [0, 1] : [1, 0]);
    }
  });

  it('completes full fog games against five rule baselines across seeds, mirrored starts and both supported modes', () => {
    const results: ReturnType<typeof playMatch>[] = [];
    for (const baseline of ['stationary', 'random', 'expander', 'pusher', 'raider'] as const) for (const seed of [17, 91, 203, 319]) {
      for (const mirror of [false, true]) for (const cityState of [false, true]) results.push(playMatch(baseline, seed, mirror, cityState));
    }
    const identify = ({ baseline, seed, mirror, cityState, winner }: typeof results[number]) => ({ baseline, seed, mirror, cityState, winner });
    expect(results.filter((result) => (result.baseline === 'stationary' || result.baseline === 'random') && result.winner !== 0).map(identify)).toEqual([]);
    expect(results.filter((result) => result.winner === null).map(identify)).toEqual([]);
    expect(results.every((result) => result.invalidMoves === 0 && result.maxNodes <= 4000)).toBe(true);
    expect(results.some((result) => result.tasks.defend || result.tasks.intercept)).toBe(true);
    expect(results.filter((result) => result.winner === 0).every((result) => result.tasks.capture_general > 0)).toBe(true);
  }, 20000);
});
