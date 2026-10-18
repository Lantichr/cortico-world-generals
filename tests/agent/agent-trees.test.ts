import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import { Arena } from './arena.ts';

function enclosedBranches(): { arena: Arena; home: number; left: number; right: number; join: number } {
  const arena = new Arena(819);
  for (const cell of arena.cells) Object.assign(cell, { owner: null, armies: 0, mountain: true, city: false, general: null });
  const at = (x: number, y: number) => y * arena.width + x;
  const open = (x: number, y: number, owner: number | null, armies: number) => {
    const index = at(x, y);
    Object.assign(arena.cells[index], { owner, armies, mountain: false });
    return index;
  };
  const home = open(3, 5, 0, 20), left = open(2, 1, 0, 50), right = open(4, 1, 0, 50);
  const join = open(3, 1, 0, 1);
  for (let y = 2; y <= 4; y++) open(3, y, 0, 1);
  for (let x = 4; x <= 9; x++) open(x, 5, null, 0);
  const enemy = open(9, 7, 1, 1);
  arena.generals[0] = home;
  arena.generals[1] = enemy;
  arena.cells[home].general = 0;
  arena.cells[enemy].general = 1;
  arena.turn = 100;
  return { arena, home, left, right, join };
}

describe('economic trees across authoritative turns', () => {
  it('keeps its final recipient while switching carriers between branches', () => {
    const { arena, home, left, right, join } = enclosedBranches();
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const moves: Array<{ from: number; to: number }> = [];
    for (let tick = 0; tick < 6; tick++) {
      const observation = arena.observe(0), decision = agent.decide(observation);
      expect(decision).toMatchObject({ kind: 'move', task: { kind: 'gather', target: home } });
      if (decision.kind !== 'move') throw new Error('The tree stopped before delivery');
      expect(decision.plan?.nextStepOnly).toBe(false);
      expect(decision.plan?.routes[0].path.slice(0, 2)).toEqual([decision.move.from, decision.move.to]);
      expect(decision.plan?.routes.at(-1)?.path.at(-1)).toBe(home);
      if (tick === 0) {
        expect(decision.plan?.routes).toHaveLength(2);
        expect(decision.plan?.routes.map((route) => route.path[0]).sort((a, b) => a - b)).toEqual([left, right].sort((a, b) => a - b));
        expect(decision.plan?.routes[0].path.at(-1)).toBe(join);
      }
      expect(observation.tiles[decision.move.from].owner).toBe(0);
      moves.push(decision.move);
      arena.step([decision.move, null]);
    }
    expect(moves.slice(0, 2).map((move) => move.from).sort((a, b) => a - b)).toEqual([left, right].sort((a, b) => a - b));
    expect(moves[0].to).toBe(join);
    expect(moves[1].to).toBe(join);
    expect(arena.cells[home].armies).toBeGreaterThan(110);
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('keeps its retained tree independent from returned route snapshots', () => {
    const { arena, home, left, right } = enclosedBranches();
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const first = agent.decide(arena.observe(0));
    if (first.kind !== 'move' || !first.plan) throw new Error('The scenario requires a displayed gathering tree');
    for (const route of first.plan.routes) route.path.fill(-1);
    first.plan.routes.length = 0;
    arena.step([first.move, null]);
    const next = agent.decide(arena.observe(0));
    expect(next).toMatchObject({ kind: 'move', task: { kind: 'gather', target: home } });
    expect(next.move?.from).toBe(first.move.from === left ? right : left);
    expect(next.kind === 'move' && next.plan?.routes[0].path[0]).toBe(next.move?.from);
  });

  it('abandons its remaining tree when an unconsumed branch is captured', () => {
    const { arena, left, right } = enclosedBranches();
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const first = agent.decide(arena.observe(0));
    expect(first.kind).toBe('move');
    if (first.kind !== 'move') throw new Error('The scenario requires a gathering tree');
    expect(first.reason).toContain('gathering_tree');
    arena.step([first.move, null]);
    const captured = first.move.from === left ? right : left;
    Object.assign(arena.cells[captured], { owner: 1, armies: 200 });
    for (let tick = 0; tick < 3; tick++) {
      const observation = arena.observe(0), decision = agent.decide(observation);
      if (decision.kind === 'move') {
        expect(decision.move.from).not.toBe(captured);
        expect(observation.tiles[decision.move.from].owner).toBe(0);
      }
      arena.step([decision.kind === 'move' ? decision.move : null, null]);
    }
    expect(arena.invalidMoves[0]).toBe(0);
  });

  it('replans an expired tree after observations skip its original deadline', () => {
    const { arena } = enclosedBranches();
    const agent = new GeneralsAgent({ decisionBudgetMs: 50, maxSearchNodes: 4000 });
    const first = agent.decide(arena.observe(0));
    expect(first.reason).toContain('gathering_tree');
    if (first.kind !== 'move') throw new Error('The scenario requires a gathering tree');
    arena.step([first.move, null]);
    for (let tick = 0; tick < 12; tick++) arena.step([null, null]);
    const observation = arena.observe(0), decision = agent.decide(observation);
    expect(decision.reason).not.toContain('committed_gather_tree');
    if (decision.kind === 'move') {
      expect(observation.tiles[decision.move.from].owner).toBe(0);
      arena.step([decision.move, null]);
    }
    expect(arena.invalidMoves[0]).toBe(0);
  });
});
