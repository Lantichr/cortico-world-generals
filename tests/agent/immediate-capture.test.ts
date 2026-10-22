import { describe, expect, it } from 'vitest';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import { analyzePosition } from '../../src/agent/analysis.ts';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import type { Route } from '../../src/agent/search.ts';
import { assessImmediateGeneralCapture } from '../../src/agent/timing.ts';
import { Arena } from './arena.ts';

const options = { decisionBudgetMs: 1000, maxSearchNodes: 12000 };

function board(width = 5, height = 3, home = 0, source = 6, target = 7): AgentObservation {
  const tiles = Array.from({ length: width * height }, (_, index) => ({ index, x: index % width, y: Math.floor(index / width),
    terrain: -1, visible: true, owner: null as number | null, armies: 0, general: false, city: false, tunnelLimit: 0 }));
  Object.assign(tiles[home], { owner: 0, terrain: 0, armies: 100, general: true });
  Object.assign(tiles[source], { owner: 0, terrain: 0, armies: 40 });
  Object.assign(tiles[target], { owner: 1, terrain: 1, armies: 10, general: true });
  return { gameId: 'immediate-capture', revision: 1, controlEpoch: 1, playerIndex: 0, turn: 100, width, height, tiles,
    history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [home, target],
    scores: [{ i: 1, total: 10, tiles: 1, dead: false }, { i: 0, total: 140, tiles: 2, dead: false }] };
}

function route(source: number, target: number): Route {
  return { source, target, path: [source, target], armies: 1, captured: 1, half: false, unknown: false };
}

function captureArena(turn: number): { arena: Arena; source: number; target: number; counter: number } {
  const arena = new Arena(907);
  for (const cell of arena.cells) Object.assign(cell, { mountain: true, owner: null, armies: 0, city: false, general: null });
  const home = 12, source = 48, target = 49, counter = 50;
  arena.generals[0] = home;
  arena.generals[1] = target;
  Object.assign(arena.cells[home], { mountain: false, owner: 0, armies: 20, general: 0 });
  Object.assign(arena.cells[source], { mountain: false, owner: 0, armies: 40 });
  Object.assign(arena.cells[target], { mountain: false, owner: 1, armies: 10, general: 1 });
  Object.assign(arena.cells[61], { mountain: false, owner: 0, armies: 1 });
  arena.turn = turn;
  return { arena, source, target, counter };
}

describe('one-tick general capture safety', () => {
  it('permits a visible one-step capture that survives source damage without changing map facts', () => {
    const view = board(), before = structuredClone(view);
    const assessment = assessImmediateGeneralCapture(view, analyzePosition(view), route(6, 7));
    expect(assessment).toMatchObject({ status: 'safe', returnRoute: null });
    expect(assessment?.reason).toContain('checked_source_damage');
    expect(view).toEqual(before);
  });

  it('does not exempt a mutual general attack that would leave one defender at home', () => {
    const view = board(2, 1, 0, 0, 1);
    view.tiles[0].armies = 20;
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(0, 1))).toBeNull();
    const decision = new GeneralsAgent(options).decide(view);
    expect(decision.task.kind).not.toBe('capture_general');
    expect(decision.reason).not.toContain('one_tick_general_capture');
  });

  it('requires enough armies after an adjacent reinforcement reaches the general first', () => {
    const { arena, source, target, counter } = captureArena(101);
    Object.assign(arena.cells[counter], { mountain: false, owner: 1, armies: 30 });
    const view = arena.observe(0);
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(source, target))).toBeNull();
    arena.step([{ from: source, to: target, half: false }, { from: counter, to: target, half: false }]);
    expect(arena.winner).toBeNull();
    expect(arena.cells[target].owner).toBe(1);
  });

  it('requires enough armies after a neighboring enemy damages the moving source first', () => {
    const { arena, source, target } = captureArena(101), attacker = source - 1;
    Object.assign(arena.cells[attacker], { mountain: false, owner: 1, armies: 30 });
    const view = arena.observe(0);
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(source, target))).toBeNull();
    arena.step([{ from: source, to: target, half: false }, { from: attacker, to: source, half: false }]);
    expect(arena.winner).toBeNull();
    expect(arena.cells[target].owner).toBe(1);
    expect(arena.cells[source].owner).toBe(0);
  });

  it('withholds the terminal proof when an adjacent source or general neighbor is unseen', () => {
    const view = board();
    view.scores = [];
    Object.assign(view.tiles[8], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(6, 7))).toBeNull();
  });

  it.each([false, true])('accounts for the general’s remaining defenders after its half=%s counterattack', (half) => {
    const { arena, source, target } = captureArena(101);
    arena.cells[target].armies = 30;
    const view = arena.observe(0);
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(source, target))?.status).toBe('safe');
    arena.step([{ from: source, to: target, half: false }, { from: target, to: source, half }]);
    expect(arena.winner).toBe(0);
    expect(arena.invalidMoves).toEqual([0, 0]);
  });

  it('proves a fogged neighbor contains no hidden reinforcement only when public and visible armies agree', () => {
    const view = board();
    Object.assign(view.tiles[8], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    const visibleTotal = view.tiles.filter((tile) => tile.visible && tile.owner === 1).reduce((sum, tile) => sum + tile.armies!, 0);
    view.scores = [{ i: 1, total: visibleTotal, tiles: 1, dead: false }];
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(6, 7))?.status).toBe('safe');
    view.scores = [{ i: 1, total: visibleTotal + 1, tiles: 2, dead: false }];
    expect(assessImmediateGeneralCapture(view, analyzePosition(view), route(6, 7))).toBeNull();
  });

  it.each([100, 101])('retains a safe field-army capture against a real counterattack at turn %i', (turn) => {
    const { arena, source, target } = captureArena(turn), view = arena.observe(0);
    const assessment = assessImmediateGeneralCapture(view, analyzePosition(view), route(source, target));
    expect(assessment?.status).toBe('safe');
    const decision = new GeneralsAgent(options).decide(view);
    expect(decision).toMatchObject({ kind: 'move', move: { from: source, to: target }, task: { kind: 'capture_general' } });
    expect(decision.reason).toContain('one_tick_general_capture');
    arena.step([decision.kind === 'move' ? decision.move : null, { from: target, to: source, half: false }]);
    expect(arena.winner).toBe(0);
    expect(arena.invalidMoves).toEqual([0, 0]);
  });

  it('clears a prior defense commitment when its historical enemy becomes inactive', () => {
    const view = board();
    view.generals[1] = -1;
    Object.assign(view.tiles[7], { owner: null, terrain: -1, armies: 0, general: false });
    Object.assign(view.tiles[0], { armies: 2 });
    Object.assign(view.tiles[6], { owner: null, terrain: -1, armies: 0 });
    Object.assign(view.tiles[1], { owner: 0, terrain: 0, armies: 60 });
    Object.assign(view.tiles[5], { owner: 1, terrain: 1, armies: 50 });
    view.history = view.tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 }));
    const agent = new GeneralsAgent(options);
    expect(agent.decide(view).task.kind).toBe('defend');
    const next = structuredClone(view);
    next.turn++;
    next.revision++;
    next.scores = [{ i: 1, total: 50, tiles: 1, dead: true }];
    Object.assign(next.tiles[5], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    const decision = agent.decide(next);
    expect(['defend', 'intercept']).not.toContain(decision.task.kind);
    expect(decision.reason).not.toMatch(/history_guard|history_assumption/);
    expect(decision).toMatchObject({ kind: 'move', move: { from: 1 } });
    expect(next.history[5]).toMatchObject({ owner: 1, armies: 50, lastSeenTurn: 100 });
  });
});
