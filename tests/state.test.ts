import { describe, expect, it } from 'vitest';
import { GeneralsState } from '../src/state.ts';

describe('GeneralsState compact maps', () => {
  it('lists current nonfriendly general neighbors by ownership, including zero armies and diagonal unknowns', () => {
    const state = new GeneralsState(1, { teams: [1, 2, 2] });
    const armies = Array<number>(25).fill(0), terrain = Array<number>(25).fill(-1);
    terrain[12] = 1; armies[12] = 100;
    terrain[0] = 0; armies[0] = 999;
    terrain[7] = 0; armies[7] = 1;
    terrain[8] = 3;
    terrain[11] = 2; armies[11] = 80;
    terrain[13] = 0;
    terrain[16] = -2;
    terrain[17] = 0; armies[17] = 200;
    terrain[18] = -4; armies[18] = 888;
    const frame = (turn: number) => {
      const map = [5, 5, ...armies, ...terrain];
      state.update({ turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [-1, 12, -1, -1], scores: [] });
    };
    frame(10);
    terrain[17] = -3; armies[17] = 9999;
    frame(20);
    expect(state.lastSeen(17)).toMatchObject({ owner: 0, armies: 200, lastSeenTurn: 10 });
    const expected = 'p0(2,1):1; p3?(3,1):0; p0(3,2):0';
    expect(state.snapshot().generalEnemyNeighbors).toBe(expected);
    expect(state.compactSnapshot().generalEnemyNeighbors).toBe(expected);
  });

  it.each([
    { general: 0, expected: 'p1(1,0):1; p1(0,1):1; p1(1,1):1' },
    { general: 2, expected: 'p1(1,0):1; p1(1,1):1; p1(2,1):1' },
    { general: 3, expected: 'p1(0,0):1; p1(1,0):1; p1(1,1):1' },
    { general: 5, expected: 'p1(1,0):1; p1(2,0):1; p1(1,1):1' },
  ])('clips neighbors at corner index $general without wrapping rows', ({ general, expected }) => {
    const state = new GeneralsState(0, { teams: [1, 2] });
    const armies = Array<number>(6).fill(1), terrain = Array<number>(6).fill(1);
    armies[general] = 100; terrain[general] = 0;
    const map = [3, 2, ...armies, ...terrain];
    state.update({ turn: 10, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [general, -1], scores: [] });
    expect(state.compactSnapshot().generalEnemyNeighbors).toBe(expected);
  });

  it('includes all eight occupied enemy neighbors without a ranking limit', () => {
    const state = new GeneralsState(1, { teams: [1, 2] });
    const map = [3, 3, 1, 2, 3, 4, 100, 5, 6, 7, 8, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    state.update({ turn: 10, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [-1, 4], scores: [] });
    expect(state.snapshot().generalEnemyNeighbors).toBe('p0(0,0):1; p0(1,0):2; p0(2,0):3; p0(0,1):4; p0(2,1):5; p0(0,2):6; p0(1,2):7; p0(2,2):8');
  });

  it('removes reclaimed and hidden neighbors, and uses only the currently confirmed self general position', () => {
    const state = new GeneralsState(0, { teams: [1, 2, 1] });
    const frame = (turn: number, terrain: number[], general = 0) => {
      const map = [3, 1, 10, 1, 20, ...terrain];
      state.update({ turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [general, -1, -1], scores: [] });
    };
    frame(1, [0, 1, 1]);
    expect(state.snapshot().generalEnemyNeighbors).toBe('p1(1,0):1');
    frame(2, [0, 0, 1]);
    expect(state.snapshot()).not.toHaveProperty('generalEnemyNeighbors');
    frame(3, [0, 2, 1]);
    expect(state.compactSnapshot()).not.toHaveProperty('generalEnemyNeighbors');
    frame(4, [0, 1, 1]);
    for (const [turn, terrain] of [[5, [0, -3, 1]], [6, [0, -4, 1]]] as const) {
      frame(turn, [...terrain]);
      expect(state.lastSeen(1)?.owner).toBe(1);
      expect(state.snapshot()).not.toHaveProperty('generalEnemyNeighbors');
      expect(state.compactSnapshot()).not.toHaveProperty('generalEnemyNeighbors');
    }
    frame(7, [0, 1, 1], -1);
    expect(state.snapshot()).not.toHaveProperty('generalEnemyNeighbors');
    frame(8, [1, 1, 1]);
    expect(state.compactSnapshot()).not.toHaveProperty('generalEnemyNeighbors');
    frame(9, [1, 1, 0], 2);
    expect(state.snapshot().generalEnemyNeighbors).toBe('p1(1,0):1');
  });

  it('renders coordinate grids with visible armies, cities, generals and tunnels while preserving fog', () => {
    const state = new GeneralsState(1, { usernames: ['Opponent', '[Bot] Fixture'], teams: [1, 2], replay_id: 'fixture' });
    const armies = [12, 40, 8, 0, 99, 88, 3, 6];
    const terrain = [1, -1, 0, -2, -3, -4, -1, 1];
    const tunnels = [0, 10, -1, 0, 0, 0, 0, 5];
    const map = [4, 2, ...armies, ...terrain, ...tunnels];
    const scores = [{ i: 0, tiles: 1, total: 8 }, { i: 1, tiles: 2, total: 18, warn_afk: true }];
    state.update({ turn: 99, map_diff: [0, map.length, ...map], cities_diff: [0, 2, 1, 7], generals: [-1, 0], scores });
    const raw = state.snapshot();
    const compact = state.compactSnapshot();
    expect(compact).toMatchObject({ playerIndex: 1, turn: 99, format: 'compact', scores });
    expect((compact.grid as string).split('\n').map((row) => row.trim().split(/\s+/))).toEqual([
      ['y\\x', '0', '1', '2', '3'],
      ['0', 'p1:12G', '.:40CT10', 'p0:8T?', '#'],
      ['1', '?', 'X', '.:3', 'p1:6CT5'],
    ]);
    expect(compact).not.toHaveProperty('armies');
    expect(compact).not.toHaveProperty('terrain');
    expect(compact).not.toHaveProperty('tunnelLimits');
    expect(compact.grid).not.toContain(':99');
    expect(compact.grid).not.toContain(':88');
    expect(state.snapshot()).toEqual(raw);
    expect(state.ownScore()).toEqual(scores[1]);
    const observedScore = state.ownScore()!;
    observedScore.tiles = 100;
    expect(state.ownScore()?.tiles).toBe(2);
    expect(raw).toMatchObject({ selfScore: scores[1], selfTiles: [
      { index: 0, x: 0, y: 0, armies: 12 }, { index: 7, x: 3, y: 1, armies: 6 },
    ], selfGeneral: { index: 0, x: 0, y: 0, armies: 12, general: true, city: false } });
    expect(state.tile(4)).toMatchObject({ terrain: -3, armies: null, owner: null, city: null, general: null, tunnelLimit: null });
    expect(state.tile(5)).toMatchObject({ terrain: -4, armies: null, owner: null, city: null, general: null, tunnelLimit: null });
    for (const key of ['selfTiles', 'cities', 'generals', 'usernames', 'teams', 'replayId']) expect(compact).not.toHaveProperty(key);
    expect(compact.selfGeneral).toEqual(raw.selfGeneral);
  });

  it('renders coordinates across multiple digits and shows no tunnel suffix for older maps', () => {
    const state = new GeneralsState(0, {});
    const width = 11, height = 11, size = width * height;
    const armies = Array<number>(size).fill(0), terrain = Array<number>(size).fill(-3);
    armies[size - 1] = 21; terrain[size - 1] = 0;
    const map = [width, height, ...armies, ...terrain];
    state.update({ turn: 2, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [size - 1], scores: [] });
    const grid = state.compactSnapshot().grid as string;
    expect(grid.split('\n')[0]).toMatch(/9\s+10$/);
    expect(grid.split('\n')[11]).toMatch(/^10 .*p0:21G$/);
    expect(grid).not.toContain('T');
    expect(state.ownScore()).toBeNull();
  });

  it('maps server colors to stable player ids and preserves teams when scores reorder', () => {
    const state = new GeneralsState(1, { playerColors: [6, 0, 1], teams: [3, 2, 2], usernames: ['A', 'B', 'C'] });
    const map = [3, 1, 10, 20, 30, 0, 1, 2];
    state.update({ turn: 1, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 1, 2], scores: [{ i: 2, total: 30 }, { i: 0, total: 10 }, { i: 1, total: 20 }] });
    const view = state.compactSnapshot();
    expect(view.playerLegend).toBe('p0 紫 敌 队3\np1 红 我 队2\np2 浅蓝 队友 队2');
    expect(view.grid).toBe('y\\x 0 1 2\n0 p0:10G p1:20G p2:30G');
    state.update({ turn: 2, map_diff: [map.length], cities_diff: [0], generals: [0, 1, 2], scores: [{ i: 1, total: 20 }, { i: 2, total: 30 }, { i: 0, total: 10 }] });
    expect(state.compactSnapshot().playerLegend).toEqual(view.playerLegend);
    expect(state.compactSnapshot().selfScore).toEqual({ i: 1, total: 20 });
  });

  it('leaves missing colors and team relations unknown instead of deriving them from player indices', () => {
    const state = new GeneralsState(0, { usernames: ['A', 'B'] });
    expect(state.compactSnapshot().playerLegend).toBe('p0 颜色未知 我\np1 颜色未知 关系未知');
    expect(state.compactSnapshot().enemyGenerals).toBe('p1? G?');
  });

  it('ranks visible owned armies per relation with stable ties and excludes last-seen fog armies', () => {
    const state = new GeneralsState(1, { teams: [1, 2, 2] });
    const armies = [100, 12, 90, 75, 999, 50, 50, 0, 20, 0, 500, 999, 1, -1, 888];
    const terrain = [0, 1, 2, 3, -1, 1, 1, 1, 0, 0, 0, -2, 1, 1, -4];
    const frame = (turn: number) => {
      const map = [5, 3, ...armies, ...terrain];
      state.update({ turn, map_diff: [0, map.length, ...map], cities_diff: [0, 3, 4, 5, 8], generals: [0, 1, 2, 3], scores: [] });
    };
    frame(10);
    terrain[10] = -3;
    armies[10] = 9999;
    frame(20);
    expect(state.lastSeen(10)?.armies).toBe(500);
    const groups = state.listArmies('all', 2);
    expect(groups).toEqual({
      self: [
        { x: 0, y: 1, owner: 1, armies: 50, general: false, city: true },
        { x: 1, y: 1, owner: 1, armies: 50, general: false, city: false },
      ],
      enemy: [
        { x: 0, y: 0, owner: 0, armies: 100, general: true, city: false },
        { x: 3, y: 1, owner: 0, armies: 20, general: false, city: true },
      ],
      allies: [{ x: 2, y: 0, owner: 2, armies: 90, general: true, city: false }],
      unknown: [{ x: 3, y: 0, owner: 3, armies: 75, general: true, city: false }],
    });
    expect(state.listArmies('self', 10).self.map((tile) => tile.armies)).toEqual([50, 50, 12, 1]);
    expect(state.listArmies('enemy', 1)).toEqual({ enemy: groups.enemy.slice(0, 1) });
    terrain[10] = 1;
    armies[10] = 600;
    frame(30);
    expect(state.listArmies('self', 1)).toEqual({ self: [{ x: 0, y: 2, owner: 1, armies: 600, general: false, city: false }] });
  });

  it('retains each opponent general sighting through fog and replaces it when the general moves', () => {
    const state = new GeneralsState(1, { teams: [1, 2, 2], usernames: ['A', 'B', 'C'] });
    const frame = (turn: number, armies: number[], terrain: number[], generals: number[]) => {
      const map = [2, 2, ...armies, ...terrain];
      state.update({ turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals, scores: [] });
    };
    frame(10, [999, 0, 5, 12], [-3, -1, 2, 1], [-1, 3, 2]);
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G?');
    frame(20, [50, 0, 5, 12], [0, -1, 2, 1], [0, 3, 2]);
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G(0,0) 50@20 seen');
    frame(30, [999, 0, 5, 12], [-3, -1, 2, 1], [-1, 3, 2]);
    expect(state.snapshot().enemyGenerals).toBe('p0 G(0,0) 50@20 last');
    frame(40, [72, 0, 5, 12], [0, -1, 2, 1], [0, 3, 2]);
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G(0,0) 72@40 seen');
    frame(50, [75, 0, 5, 12], [0, -1, 2, 1], [-1, 3, 2]);
    expect(state.lastSeen(0)?.general).toBe(false);
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G(0,0) 72@40 last');
    frame(60, [75, 8, 5, 12], [0, 0, 2, 1], [1, 3, 2]);
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G(1,0) 8@60 seen');
    const next = [4, 1, 999, 0, 5, 12, -3, -1, 2, 1];
    state.update({ turn: 70, map_diff: [0, next.length, ...next], cities_diff: [0, 0], generals: [-1, 3, 2], scores: [] });
    expect(state.compactSnapshot().enemyGenerals).toBe('p0 G?');
  });

  it('keeps dated facts behind fog, never records hidden armies, and replaces history when a tile is revealed again', () => {
    const state = new GeneralsState(2, {});
    const frame = (turn: number, armies: number[], terrain: number[], cities: number[], generals: number[], tunnels = [0, 0, 0, 0, 0]) => {
      const map = [5, 1, ...armies, ...terrain, ...tunnels];
      state.update({ turn, map_diff: [0, map.length, ...map], cities_diff: [0, cities.length, ...cities], generals, scores: [] });
    };
    frame(10, [10, 7, 0, 999, 5], [0, 1, -2, -3, 2], [1], [0, -1, 4], [0, 5, 0, 0, 0]);
    frame(20, [70, 88, 0, 999, 6], [-3, -4, -4, -3, 2], [], [-1, -1, 4]);
    expect(state.compactSnapshot().grid).toBe('y\\x 0 1 2 3 4\n0 ?~G X~CT X~# ? p2:6G');
    expect(state.tile(0)).toMatchObject({ visible: false, terrain: -3, armies: null, owner: null, general: null });
    expect(state.lastSeen(0)).toMatchObject({ terrain: 0, owner: 0, armies: 10, general: true, lastSeenTurn: 10 });
    expect(state.lastSeen(1)).toMatchObject({ owner: 1, armies: 7, city: true, tunnelLimit: 5, lastSeenTurn: 10 });
    expect(state.lastSeen(2)).toMatchObject({ terrain: -2, lastSeenTurn: 10 });
    expect(state.lastSeen(3)).toBeNull();
    expect(state.snapshot().terrain).toEqual([-3, -4, -4, -3, 2]);
    expect(state.compactSnapshot().grid).not.toContain(':70');
    expect(state.compactSnapshot().grid).not.toContain(':88');
    const copy = state.lastSeen(0)!;
    copy.armies = 500;
    expect(state.lastSeen(0)?.armies).toBe(10);
    frame(30, [3, 0, 0, 999, 7], [1, -1, -4, -3, 2], [0], [-1, -1, 4]);
    expect(state.lastSeen(0)).toMatchObject({ owner: 1, armies: 3, general: false, city: true, lastSeenTurn: 30 });
    frame(40, [90, 80, 0, 999, 8], [-4, -3, -4, -3, 2], [], [-1, -1, 4]);
    expect(state.compactSnapshot().grid).toBe('y\\x 0 1 2 3 4\n0 X~C ?~. X~# ? p2:8G');
    expect(state.lastSeen(1)).toMatchObject({ terrain: -1, armies: 0, city: false, tunnelLimit: 0, lastSeenTurn: 30 });
  });

  it('clears coordinate history when dimensions change even if the tile count stays the same', () => {
    const state = new GeneralsState(1, {});
    const map = [2, 2, 10, 0, 0, 5, 0, -1, -3, 1];
    state.update({ turn: 1, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 3], scores: [] });
    const next = [4, 1, 0, 0, 0, 6, -3, -3, -3, 1];
    state.update({ turn: 2, map_diff: [0, next.length, ...next], cities_diff: [0, 0], generals: [-1, 3], scores: [] });
    expect(state.lastSeen(0)).toBeNull();
    expect(state.compactSnapshot().grid).toBe('y\\x 0 1 2 3\n0 ? ? ? p1:6G');
  });
});
