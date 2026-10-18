import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentDecision } from '../../src/agent/contracts.ts';
import { Arena } from './arena.ts';

type Cell = Arena['cells'][number];
type Move = Extract<AgentDecision, { kind: 'move' }>['move'];
const options = { decisionBudgetMs: 1000, maxSearchNodes: 4000 };
const at = (arena: Arena, x: number, y: number): number => y * arena.width + x;

function open(arena: Arena, x: number, y: number, facts: Partial<Cell> = {}): number {
  const index = at(arena, x, y);
  Object.assign(arena.cells[index], { mountain: false, ...facts });
  return index;
}

function board(seed: number, home: [number, number], enemy: [number, number]): Arena {
  const arena = new Arena(seed);
  for (const cell of arena.cells) Object.assign(cell, { owner: null, armies: 0, mountain: true, city: false, general: null });
  arena.generals[0] = open(arena, ...home, { owner: 0, armies: 1, general: 0 });
  arena.generals[1] = open(arena, ...enemy, { owner: 1, armies: 1, general: 1 });
  arena.turn = 100;
  return arena;
}

function play(arena: Arena, agent: GeneralsAgent, enemyMove: Move | null = null): AgentDecision {
  const decision = agent.decide(arena.observe(0));
  arena.step([decision.kind === 'move' ? decision.move : null, enemyMove]);
  return decision;
}

function gatheringBoard(seed: number, detour = false): Arena {
  const arena = board(seed, [1, 4], [9, 7]);
  for (let x = 1; x <= 7; x++) open(arena, x, 4, { owner: 0, armies: 1 });
  arena.cells[arena.generals[0]].general = 0;
  open(arena, 2, 4, { armies: 60 });
  open(arena, 4, 4, { armies: 40 });
  open(arena, 7, 4, { armies: 90 });
  open(arena, 8, 4, { armies: 120 });
  open(arena, 9, 4);
  open(arena, 4, 3);
  if (detour) for (let x = 3; x <= 7; x++) open(arena, x, 5, { owner: 0, armies: 1 });
  return arena;
}

function beginGather(arena: Arena, agent: GeneralsAgent) {
  const observation = arena.observe(0);
  const decision = agent.decide(observation);
  expect(decision.kind).toBe('move');
  expect(decision.task.kind).toBe('gather');
  if (decision.kind !== 'move' || decision.task.target === null) throw new Error('The scenario requires an initial gathering route');
  const target = decision.task.target;
  const source = observation.tiles[decision.move.from], destination = observation.tiles[target];
  expect(Math.abs(source.x - destination.x) + Math.abs(source.y - destination.y)).toBeGreaterThanOrEqual(3);
  arena.step([decision.move, null]);
  return { target, initialArmies: observation.tiles[target].armies!, carrier: decision.move.to, decision };
}

describe('autonomous plans across authoritative arena turns', () => {
  it('returns a trapped main army through its general and sends it toward the reachable frontier', () => {
    const arena = board(601, [4, 4], [9, 7]);
    for (let x = 1; x <= 6; x++) open(arena, x, 4, { owner: 0, armies: 1 });
    for (let x = 7; x <= 9; x++) open(arena, x, 4);
    const deadEnd = open(arena, 1, 4, { armies: 80 });
    open(arena, 3, 4, { armies: 15, city: true });
    const home = arena.generals[0];
    Object.assign(arena.cells[home], { general: 0, armies: 20 });
    const agent = new GeneralsAgent(options);
    const moves: Move[] = [];
    let returned = false, reachedFront = false;
    for (let tick = 0; tick < 20; tick++) {
      const decision = play(arena, agent);
      if (decision.kind === 'move') moves.push(decision.move);
      returned ||= arena.cells[home].armies >= 60;
      reachedFront ||= arena.cells.some((cell, index) => cell.owner === 0 && cell.armies >= 50
        && Math.floor(index / arena.width) === 4 && index % arena.width > 4);
      if (reachedFront) break;
    }
    expect(returned).toBe(true);
    expect(reachedFront).toBe(true);
    expect(moves.some((move) => move.to === deadEnd)).toBe(false);
    expect(arena.cells[home].owner).toBe(0);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('finishes its chosen gathering route after intermediate merges create a larger field army', () => {
    const arena = gatheringBoard(602);
    const agent = new GeneralsAgent(options);
    const initial = beginGather(arena, agent);
    let carrier = initial.carrier;
    let arrived = carrier === initial.target;
    for (let tick = 0; tick < 10 && !arrived; tick++) {
      const decision = agent.decide(arena.observe(0));
      expect(decision).toMatchObject({ kind: 'move', task: { kind: 'gather', target: initial.target } });
      if (decision.kind !== 'move') throw new Error('Gathering stopped before arrival');
      expect(decision.move.from).toBe(carrier);
      arena.step([decision.move, null]);
      carrier = decision.move.to;
      arrived = carrier === initial.target;
      expect(arena.cells[at(arena, 4, 3)].owner).toBeNull();
    }
    expect(arrived).toBe(true);
    expect(arena.cells[initial.target].armies).toBeGreaterThan(initial.initialArmies + 15);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it.each(['enemy', 'general'] as const)('keeps gathering along its owned detour around a shorter %s crossing', (shortcut) => {
    const home: [number, number] = shortcut === 'general' ? [3, 4] : [1, 5];
    const arena = board(shortcut === 'general' ? 610 : 609, home, [9, 7]);
    arena.cells[arena.generals[0]].armies = 2;
    const source = open(arena, 1, 4, { owner: 0, armies: 100 });
    open(arena, 2, 4, { owner: 0, armies: 1 });
    if (shortcut === 'enemy') open(arena, 3, 4, { owner: 1, armies: 0 });
    const anchor = open(arena, 4, 4, { owner: 0, armies: 150 });
    open(arena, 5, 4);
    for (let x = 1; x <= 4; x++) open(arena, x, 3, { owner: 0, armies: 1 });
    const agent = new GeneralsAgent(options);
    let carrier = source;
    for (let step = 0; step < 5; step++) {
      const observation = arena.observe(0);
      const decision = agent.decide(observation);
      expect(decision).toMatchObject({ kind: 'move', task: { kind: 'gather', target: anchor } });
      if (decision.kind !== 'move') throw new Error('The owned detour stopped before arrival');
      expect(decision.move.from).toBe(carrier);
      expect(observation.tiles[decision.move.to].owner).toBe(0);
      expect(decision.move.to).not.toBe(arena.generals[0]);
      arena.step([decision.move, null]);
      carrier = decision.move.to;
    }
    expect(carrier).toBe(anchor);
    expect(arena.cells[anchor].armies).toBeGreaterThan(200);
    expect(arena.cells[arena.generals[0]].owner).toBe(0);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('continues frontier expansion while enclosed cities produce small reinforcements', () => {
    const arena = board(608, [4, 4], [9, 7]);
    arena.cells[arena.generals[0]].armies = 20;
    open(arena, 3, 4, { owner: 0, armies: 1, city: true });
    open(arena, 4, 3, { owner: 0, armies: 1, city: true });
    open(arena, 5, 4, { owner: 0, armies: 50 });
    for (let x = 6; x <= 9; x++) open(arena, x, 4);
    const agent = new GeneralsAgent(options);
    play(arena, agent);
    play(arena, agent);
    const nextFrontier = at(arena, 7, 4);
    expect(arena.cells[nextFrontier].owner).toBeNull();
    for (let tick = 0; tick < 20; tick++) play(arena, agent);
    expect(arena.cells[nextFrontier].owner).toBe(0);
    expect(arena.cells[arena.generals[0]].owner).toBe(0);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('interrupts a gathering route when a newly visible force can take the general', () => {
    const arena = gatheringBoard(603);
    arena.cells[arena.generals[0]].armies = 30;
    open(arena, 1, 5, { owner: 0, armies: 1 });
    open(arena, 2, 5, { owner: 0, armies: 40 });
    const approach = [open(arena, 0, 2, { owner: 1, armies: 50 }), open(arena, 0, 3), open(arena, 0, 4), arena.generals[0]];
    const agent = new GeneralsAgent(options);
    const first = agent.decide(arena.observe(0));
    expect(first).toMatchObject({ kind: 'move', task: { kind: 'gather' } });
    arena.step([first.kind === 'move' ? first.move : null, { from: approach[0], to: approach[1], half: false }]);
    const response = play(arena, agent, { from: approach[1], to: approach[2], half: false });
    expect(['defend', 'intercept']).toContain(response.task.kind);
    play(arena, agent, { from: approach[2], to: approach[3], half: false });
    expect(arena.cells[arena.generals[0]].owner).toBe(0);
    expect(arena.winner).not.toBe(1);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('replans after the army carrying a gathering route is captured between observations', () => {
    const arena = gatheringBoard(604);
    const agent = new GeneralsAgent(options);
    const initial = beginGather(arena, agent);
    Object.assign(arena.cells[initial.carrier], { owner: 1, armies: 200 });
    arena.step([null, null]);
    const next = play(arena, agent);
    if (next.kind === 'move') expect(next.move.from).not.toBe(initial.carrier);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('replans a gathering route after an enemy capture blocks its next owned step', () => {
    const arena = gatheringBoard(605, true);
    const agent = new GeneralsAgent(options);
    const initial = beginGather(arena, agent);
    const direction = Math.sign(initial.target - initial.carrier);
    const blocked = initial.carrier + direction;
    expect(arena.cells[blocked].owner).toBe(0);
    Object.assign(arena.cells[blocked], { owner: 1, armies: 200 });
    arena.step([null, null]);
    const next = agent.decide(arena.observe(0));
    if (next.kind === 'move') {
      expect(next.move.from === initial.carrier && next.move.to === blocked).toBe(false);
      arena.step([next.move, null]);
    }
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it.each([
    { seed: 606, longArmies: 13, nearArmies: 8, enemyArmies: 22 },
    { seed: 607, longArmies: 500, nearArmies: 300, enemyArmies: 550 },
  ])('combines two reinforcements within their shared deadline against $enemyArmies attackers', ({ seed, longArmies, nearArmies, enemyArmies }) => {
    const arena = board(seed, [5, 5], [9, 7]);
    const home = arena.generals[0];
    arena.cells[home].armies = 3;
    const longSource = open(arena, 2, 5, { owner: 0, armies: longArmies });
    for (const x of [3, 4]) open(arena, x, 5, { owner: 0, armies: 1 });
    const north = open(arena, 5, 3, { owner: 0, armies: nearArmies });
    open(arena, 5, 4, { owner: 0, armies: 1 });
    const south = open(arena, 5, 7, { owner: 0, armies: nearArmies });
    open(arena, 5, 6, { owner: 0, armies: 1 });
    open(arena, 8, 4, { owner: 0, armies: 1 });
    const approach = [open(arena, 9, 5, { owner: 1, armies: enemyArmies }), open(arena, 8, 5), open(arena, 7, 5), open(arena, 6, 5), home];
    // Four turns admit both two-step routes; the three-step source alone cannot cover the attack.
    // This initiative gives the final reinforcement its action before the fourth enemy move.
    arena.turn = 101;
    const agent = new GeneralsAgent(options);
    const moves: Move[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const decision = play(arena, agent, { from: approach[tick], to: approach[tick + 1], half: false });
      if (tick === 0) expect(decision.reason).toContain('defense_sufficient');
      if (decision.kind === 'move') moves.push(decision.move);
    }
    expect(moves.some((move) => move.from === north)).toBe(true);
    expect(moves.some((move) => move.from === south)).toBe(true);
    expect(arena.cells[longSource].armies).toBe(longArmies);
    expect(arena.cells[home]).toMatchObject({ owner: 0, general: 0 });
    expect(arena.cells[home].armies).toBeGreaterThan(0);
    expect(arena.winner).not.toBe(1);
    expect(arena.invalidMoves[0]).toBe(0);
  });
});
