import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../../src/agent/contracts.ts';
import { canPlayerAct, historicalArmyMayAct, knownGeneralIndex, playerLifecycle, resolvePlayerLifecycle, resolvePlayerLifecycles } from '../../src/agent/lifecycle.ts';

function observation(): AgentObservation {
  const tiles = [10, 80, 20].map((armies, index) => ({ index, x: index, y: 0, terrain: index === 0 ? 0 : 1,
    visible: true, owner: index === 0 ? 0 : 1, armies, general: index < 2, city: false, tunnelLimit: 0 }));
  return { gameId: 'lifecycle-game', controlEpoch: 1, revision: 1, turn: 100, width: 3, height: 1, playerIndex: 0,
    tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [0, 1],
    scores: [{ i: 1, total: 100, tiles: 2, dead: false }, { i: 0, total: 10, tiles: 1, dead: false }] };
}

describe('player lifecycle', () => {
  it('resolves sparse player ids and refreshes current ownership without reusing a prior batch', () => {
    const view = observation();
    view.generals = [0, -1];
    const first = resolvePlayerLifecycles(view);
    expect(first.map((entry) => entry.player)).toEqual([0, 1]);
    expect(first[1]).toMatchObject({ status: 'active', generalIndex: 1 });
    view.playerLifecycle = first;
    view.history[1] = { ...view.tiles[1], general: false, lastSeenTurn: 101 };
    Object.assign(view.tiles[1], { owner: null, terrain: -1, general: false, city: true });
    view.scores = [{ i: 4, total: 0, tiles: 0, dead: true }];
    const next = resolvePlayerLifecycles(view);
    expect(next.map((entry) => entry.player)).toEqual([0, 1, 4]);
    expect(next.find((entry) => entry.player === 1)).toMatchObject({ status: 'eliminated', basis: 'neutralized' });
    expect(next.find((entry) => entry.player === 4)).toMatchObject({ status: 'eliminated', basis: 'unknown', generalIndex: null });
    expect(first[1].status).toBe('active');
  });

  it.each([2, undefined])('retains inactive generals and static garrisons when remaining tiles are %s', (tiles) => {
    const view = observation();
    view.scores = [{ i: 1, total: 100, tiles, dead: true }, { i: 0, total: 10, tiles: 1, dead: false }];
    const before = structuredClone(view);
    expect(playerLifecycle(view, 1)).toMatchObject({ status: 'inactive', basis: 'score', generalIndex: 1 });
    expect(canPlayerAct(view, 1)).toBe(false);
    expect(canPlayerAct(view, 0)).toBe(true);
    expect(knownGeneralIndex(view, 1)).toBe(1);
    expect(historicalArmyMayAct(view, view.history[2]!)).toBe(false);
    expect(view).toEqual(before);
  });

  it('retains an active historical general when its protocol coordinate disappears', () => {
    const view = observation();
    view.generals[1] = -1;
    Object.assign(view.tiles[1], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    expect(playerLifecycle(view, 1)).toMatchObject({ status: 'active', generalIndex: 1 });
    expect(knownGeneralIndex(view, 1)).toBe(1);
    expect(historicalArmyMayAct(view, view.history[2]!)).toBe(true);
    view.history[1] = null;
    expect(playerLifecycle(view, 1)).toMatchObject({ status: 'active', generalIndex: null });
  });

  it('does not infer capture from a missing general marker while its owner remains', () => {
    const view = observation();
    view.generals[1] = -1;
    view.tiles[1].general = false;
    expect(playerLifecycle(view, 1)).toMatchObject({ status: 'active', generalIndex: 1 });
  });

  it.each([{ owner: 0, basis: 'captured' }, { owner: null, basis: 'neutralized' }])('confirms $basis and does not revive a fogged general', ({ owner, basis }) => {
    const view = observation();
    view.scores = [{ i: 1, total: 0, tiles: 0, dead: true }];
    Object.assign(view.tiles[1], { owner, terrain: owner ?? -1, general: false, city: true });
    const lifecycle = resolvePlayerLifecycle(view, 1);
    expect(lifecycle).toMatchObject({ player: 1, status: 'eliminated', basis, generalIndex: 1, observedTurn: 100 });
    view.playerLifecycle = [lifecycle];
    view.turn = 102;
    view.generals[1] = -1;
    Object.assign(view.tiles[1], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    expect(knownGeneralIndex(view, 1)).toBeNull();
    expect(playerLifecycle(view, 1)).toEqual(lifecycle);
  });

  it('uses an explicit active score after a general swap and waits for the new coordinate', () => {
    const view = observation();
    view.generals[1] = -1;
    Object.assign(view.tiles[1], { owner: 0, terrain: 0, general: false, city: true });
    const previous = resolvePlayerLifecycles(view);
    expect(previous.find((entry) => entry.player === 1)).toMatchObject({ status: 'active', basis: 'score', generalIndex: null });
    view.playerLifecycle = previous;
    Object.assign(view.tiles[1], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    expect(knownGeneralIndex(view, 1)).toBeNull();
    view.playerLifecycle = resolvePlayerLifecycles(view);
    expect(knownGeneralIndex(view, 1)).toBeNull();
    view.generals[1] = 2;
    view.tiles[2].general = true;
    expect(knownGeneralIndex(view, 1)).toBe(2);
  });

  it('uses zero remaining tiles without inventing how the player was eliminated', () => {
    const view = observation();
    view.scores = [{ i: 1, total: 0, tiles: 0, dead: true }];
    const previous = resolvePlayerLifecycle(view, 1);
    expect(previous).toMatchObject({ status: 'eliminated', basis: 'unknown' });
    view.scores = [];
    view.generals[1] = -1;
    Object.assign(view.tiles[1], { owner: null, terrain: -1, general: false, city: true });
    expect(resolvePlayerLifecycle(view, 1, previous)).toMatchObject({ status: 'eliminated', basis: 'neutralized' });
  });

  it('retains an observed inactive status when a later score is absent', () => {
    const view = observation();
    view.scores = [{ i: 1, total: 100, tiles: 2, dead: true }];
    const previous = resolvePlayerLifecycle(view, 1);
    view.scores = [];
    expect(resolvePlayerLifecycle(view, 1, previous)).toEqual(previous);
  });
});
