import { describe, expect, it } from 'vitest';
import { snapshotScenarios, gameScenarios } from '../../scripts/llm-suite/scenarios.ts';
import { IntentController } from '../../src/intent.ts';
import { analyzePosition } from '../../src/agent/analysis.ts';

describe('standalone LLM suite scenarios', () => {
  it('creates six independent masked snapshots with internally consistent ownership', () => {
    const scenarios = snapshotScenarios();
    expect(scenarios).toHaveLength(6);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    for (const scenario of scenarios) {
      const first = scenario.create(), second = scenario.create();
      const view = first.arena.observe(first.player);
      expect(view.playerIndex).toBe(first.player);
      expect(view.generals).toHaveLength(first.arena.alive.length);
      expect(view.tiles.some((tile) => !tile.visible)).toBe(true);
      for (const tile of view.tiles) {
        if (tile.visible && !first.arena.cells[tile.index].mountain) {
          expect(tile.owner).toBe(first.arena.cells[tile.index].owner);
          expect(tile.armies).toBe(first.arena.cells[tile.index].armies);
        } else {
          expect(tile.owner).toBeNull();
          expect(tile.armies).toBeNull();
        }
      }
      first.arena.cells[first.arena.generals[first.player]].armies += 1000;
      first.arena.history[first.player][0] = { ...view.tiles[0], lastSeenTurn: view.turn };
      expect(second.arena.cells[second.arena.generals[second.player]].armies).toBeLessThan(1000);
      expect(second.arena.history[second.player].every((entry) => entry === null)).toBe(true);
    }
  });

  it('contains a combined home deadline and a roster with a surviving high-index player', () => {
    const joint = snapshotScenarios().find((scenario) => scenario.id === 'converging-fronts')!.create();
    const demands = analyzePosition(joint.arena.observe(joint.player)).homeDemands;
    expect(demands.some((demand) => demand.scenario === 'parallel_players' && demand.players?.length === 2)).toBe(true);
    const changed = snapshotScenarios().find((scenario) => scenario.id === 'changed-roster')!.create();
    const view = changed.arena.observe(changed.player);
    expect(changed.player).toBeGreaterThan(1);
    expect(changed.arena.alive).toEqual([true, false, true]);
    expect(view.generals[0]).toBeGreaterThanOrEqual(0);
    expect(view.generals[1]).toBe(-1);
    expect(changed.arena.winner).toBeNull();
  });

  it('accepts initial intents and rejects a previously valid proposal after the frontier capture', () => {
    for (const scenario of snapshotScenarios().filter((entry) => entry.initialIntent)) {
      const { arena, player } = scenario.create();
      const view = arena.observe(player), args = scenario.initialIntent!(view);
      expect(() => new IntentController().submit(args, view)).not.toThrow();
      if (!scenario.beforeReply) continue;
      scenario.beforeReply(arena, player);
      expect(arena.turn).toBeGreaterThan(view.turn);
      expect(arena.invalidMoves.every((count) => count === 0)).toBe(true);
      expect(() => new IntentController().submit(args, arena.observe(player))).toThrow('intent_target_must_be_owned');
      expect(view.tiles[12].owner).toBe(player);
      expect(arena.observe(player).tiles[12].owner).not.toBe(player);
    }
  });

  it('starts four games with masked spawn knowledge, both rule sets and up to four players', () => {
    const games = gameScenarios();
    expect(games).toHaveLength(4);
    expect(new Set(games.map((scenario) => scenario.id)).size).toBe(games.length);
    expect(games.map((scenario) => scenario.create().arena.alive.length)).toEqual([2, 2, 3, 4]);
    expect(games.map((scenario) => scenario.create().player)).toEqual([0, 1, 2, 3]);
    for (const game of games) {
      const { arena, player } = game.create(), view = arena.observe(player);
      expect(arena.turn).toBe(0);
      expect(arena.alive.every(Boolean)).toBe(true);
      expect(view.generals.filter((index) => index >= 0)).toEqual([arena.generals[player]]);
      expect(arena.cells[arena.generals[player]].armies).toBe(1);
      if (game.id.includes('city-state')) for (const index of arena.generals) {
        expect(arena.adjacent(index).some((next) => arena.cells[next].city && arena.cells[next].armies === -1)).toBe(true);
      }
    }
  });
});
