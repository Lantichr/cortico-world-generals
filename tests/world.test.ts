import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DeferredEventSpec, WorldHost, ToolCallContext } from 'cortico/core/types.ts';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nowIso, nullLogger } from 'cortico/core/util.ts';
import { GENERALS_DEFAULTS, GENERALS_SECRET } from '../src/config.ts';
import { GeneralsWorld } from '../src/world.ts';
import { GENERALS_ARMY_LIMITS } from '../src/state.ts';
import { GENERALS_ANALYSIS_LIMITS } from '../src/planning.ts';
import type { GeneralsViewerSnapshot } from '../src/viewer/contracts.ts';

const ctx: ToolCallContext = { role: 'main', log: nullLogger() };

describe('GeneralsWorld with a local protocol server', () => {
  let server: WebSocketServer;
  let peer: WebSocket;
  let world: GeneralsWorld;
  let store: JsonlEventStore;
  let host: WorldHost;
  let deferred: Array<Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'tags' | 'render'>>;
  let packets: string[];
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'generals-'));
    store = new JsonlEventStore({ dataDir: dir, run: 'r-20260101-000000-test' });
    deferred = [];
    packets = [];
    host = {
      store, log: nullLogger(), modelFacts: { model: () => 'fixture', accepts: () => false, contextWindow: () => undefined },
      pushEvent: async (event) => store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined }),
      pushDeferred: (event) => { deferred.push(event); },
      drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
    };
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    server.on('connection', (socket) => {
      peer = socket;
      const pingTimer = setInterval(() => { if (socket.readyState === 1) socket.send('2'); }, 50);
      socket.on('close', () => clearInterval(pingTimer));
      socket.on('message', (raw) => {
        packets.push(raw.toString());
        if (raw.toString() === '40') socket.send('40' + JSON.stringify({ sid: 'fixture-namespace' }));
      });
      socket.send('0' + JSON.stringify({ sid: 'fixture', pingInterval: 50, pingTimeout: 1000 }));
    });
    const port = (server.address() as AddressInfo).port;
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, serverUrl: `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, snapshotIntervalMs: 0 }, 'private-fixture-id', 'UTC');
    await world.start(host);
  });

  afterEach(async () => {
    await world.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (verb: string, args: Record<string, unknown> = {}) => world.tools().find((t) => t.name === `generals_${verb}`)!.handler(args, ctx);
  const send = (name: string, data: unknown) => peer.send('42' + JSON.stringify([name, data]));
  async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for local protocol');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  async function startGame(extra: Record<string, unknown> = {}): Promise<void> {
    await call('join_private', { room: 'fixture-room' });
    send('game_start', { playerIndex: 0, replay_id: 'fixture-replay', usernames: ['[Bot] Fixture', 'Opponent'], ...extra });
    await waitFor(() => store.range({ source: 'generals' }).some((e) => e.type === 'generals.start'));
  }
  function update(turn: number, map_diff: number[], cities_diff: number[] = [0, 1, 2], extra: Record<string, unknown> = {}): void {
    send('game_update', { turn, map_diff, cities_diff, generals: [0, -1], scores: [{ i: 0, total: 5, tiles: 1 }], ...extra });
  }
  async function flush(): Promise<string[]> {
    const texts: string[] = [];
    for (const event of deferred.splice(0)) {
      const text = await event.render();
      if (typeof text !== 'string') continue;
      texts.push(text);
      store.append({ type: event.type, source: 'generals', origin: 'external', ts: nowIso('UTC'), text, tags: event.tags });
    }
    return texts;
  }

  it('displays only current visible armies and tracks the submitted cursor and pending arrows', async () => {
    const viewerUrl = world.webUi().links!.find((link) => link.label === '对局画面')!.href;
    const display = async () => (await (await fetch(new URL('/api/state', viewerUrl))).json()) as GeneralsViewerSnapshot;
    expect(await display()).toMatchObject({ board: null, selected: null, queuedMoves: [] });
    await startGame({ playerColors: [2, 0] });
    const map = [3, 2, 12, 0, 999, 888, 50, 3, 0, 0, -3, -4, -1, 1];
    update(1, [0, map.length, ...map], [0, 1, 4]);
    await waitFor(async () => (await display()).turn === 1);
    const view = await display();
    expect(view.players[0]).toMatchObject({ color: 2, name: '[Bot] Fixture' });
    expect(view.board!.tiles[2]).toMatchObject({ terrain: -3, armies: null, owner: null, city: null, general: null });
    expect(view.board!.tiles[3]).toMatchObject({ terrain: -4, armies: null });
    expect(JSON.stringify(view)).not.toMatch(/999|888|private-fixture-id/);
    await call('queue_moves', { moves: [{ from: 0, to: 1 }, { from: 1, to: 4, half: true }] });
    expect(await display()).toMatchObject({ selected: { index: 4, half: false }, queuedMoves: [
      { from: 0, to: 1, half: false, attackIndex: 1 }, { from: 1, to: 4, half: true, attackIndex: 2 },
    ], plan: null });
    update(2, [map.length], [1], { attackIndex: 1 });
    await waitFor(async () => (await display()).turn === 2);
    expect((await display()).queuedMoves.map((move) => move.attackIndex)).toEqual([2]);
    expect((await display()).selected?.index).toBe(4);
    await call('clear_moves');
    expect(await display()).toMatchObject({ selected: null, queuedMoves: [], plan: null });
    await call('attack', { from: 0, to: 1 });
    world.onOperatorPausedChanged(true);
    expect(await display()).toMatchObject({ paused: true, selected: null, queuedMoves: [], plan: null });
    send('game_won', {});
    await waitFor(async () => (await display()).phase === 'won');
    expect((await display()).board!.tiles).toHaveLength(6);
    await call('leave');
    expect(await display()).toMatchObject({ board: null, players: [], selected: null, queuedMoves: [] });
  });

  it('joins a custom room, votes and registers a username through real socket packets', async () => {
    expect(await call('join_private', { room: 'fixture room' })).toContain('fixture%20room');
    await call('set_force_start', { enabled: true });
    await call('set_username', { username: '[Bot] Fixture' });
    await waitFor(() => packets.filter((p) => p.startsWith('42')).length === 3);
    expect(packets.filter((p) => p.startsWith('42')).map((p) => JSON.parse(p.slice(2)))).toEqual([
      ['join_private', 'fixture room', 'private-fixture-id'],
      ['set_force_start', 'fixture room', true],
      ['set_username', 'private-fixture-id', '[Bot] Fixture'],
    ]);
    expect(store.range({ source: 'generals' }).map((e) => e.text).join()).not.toContain('private-fixture-id');
  });

  it('patches successive views, preserves fog and persists only the latest pending snapshot', async () => {
    await startGame();
    const map = [2, 2, 5, 0, 20, 0, 0, -3, -1, -4];
    update(1, [0, map.length, ...map]);
    await waitFor(() => deferred.length === 1);
    update(2, [2, 1, 6, 7], [1]);
    await waitFor(() => deferred.length === 2);
    const observed = JSON.parse(await call('observe') as string);
    expect(observed.view).toMatchObject({ playerIndex: 0, turn: 2, width: 2, height: 2, armies: [6, 0, 20, 0], terrain: [0, -3, -1, -4], tunnelLimits: [0, 0, 0, 0], cities: [2], generals: [0, -1] });
    const texts = await flush();
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0])).toEqual(JSON.parse(await call('view_map') as string).view);
    expect(JSON.parse(texts[0])).toMatchObject({ format: 'compact', turn: 2 });
    expect(JSON.parse(texts[0]).grid).toContain('p0:6G');
    expect(store.range({ source: 'generals' }).filter((e) => e.type === 'generals.state')).toHaveLength(1);
  });

  it('delivers current general neighbors in map events and observations, then omits them after reclamation', async () => {
    await call('join_private', { room: 'fixture-room' });
    send('game_start', { playerIndex: 0, replay_id: 'fixture-replay', teams: [1, 2, 1] });
    await waitFor(() => store.range({ source: 'generals' }).some((event) => event.type === 'generals.start'));
    const armies = [1, 0, 20, 5, 50, 0, 999, 0, 888];
    const terrain = [1, 1, 2, -1, 0, 0, -3, -2, -4];
    const frame = (turn: number) => {
      const map = [3, 3, ...armies, ...terrain];
      update(turn, [0, map.length, ...map], [0, 0], { generals: [4, -1, -1] });
    };
    frame(1);
    await waitFor(() => deferred.length === 1);
    const expected = 'p1(0,0):1; p1(1,0):0';
    expect(JSON.parse(await call('observe') as string).view.generalEnemyNeighbors).toBe(expected);
    expect(JSON.parse(await call('view_map') as string).view.generalEnemyNeighbors).toBe(expected);
    expect(JSON.parse((await flush())[0]).generalEnemyNeighbors).toBe(expected);
    terrain[0] = 0; terrain[1] = 0;
    frame(2);
    await waitFor(async () => JSON.parse(await call('observe') as string).view?.turn === 2);
    expect(JSON.parse(await call('observe') as string).view).not.toHaveProperty('generalEnemyNeighbors');
    expect(JSON.parse(await call('view_map') as string).view).not.toHaveProperty('generalEnemyNeighbors');
    expect(JSON.parse((await flush())[0])).not.toHaveProperty('generalEnemyNeighbors');
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
  });

  it('lists the default self army ranking on demand and separates unknown opponents without sending moves', async () => {
    expect(await call('list_armies')).toMatchObject({ failed: true, text: expect.stringContaining('No active map') });
    await startGame();
    const map = [4, 4, ...Array.from({ length: 12 }, (_, index) => index + 1), 999, 888, 777, 666,
      ...Array<number>(12).fill(0), 1, -1, -3, -2];
    update(5, [0, map.length, ...map], [0, 1, 1]);
    await waitFor(() => deferred.length === 1);
    const before = JSON.parse(await call('observe') as string);
    const ranking = JSON.parse(await call('list_armies') as string);
    expect(ranking).toMatchObject({ playerIndex: 0, observedTurn: 5, side: 'self', limit: GENERALS_ARMY_LIMITS.default });
    expect(Object.keys(ranking.groups)).toEqual(['self']);
    expect(ranking.groups.self).toHaveLength(GENERALS_ARMY_LIMITS.default);
    expect(ranking.groups.self.map((tile: { armies: number }) => tile.armies)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(ranking.groups.self[0]).toEqual({ x: 3, y: 2, owner: 0, armies: 12, general: false, city: false });
    const all = JSON.parse(await call('list_armies', { side: 'all', limit: GENERALS_ARMY_LIMITS.max }) as string);
    expect(all.groups.self).toHaveLength(12);
    expect(all.groups.self.find((tile: { general: boolean }) => tile.general)).toMatchObject({ x: 0, y: 0, armies: 1 });
    expect(all.groups.self.find((tile: { city: boolean }) => tile.city)).toMatchObject({ x: 1, y: 0, armies: 2 });
    expect(all.groups.unknown).toEqual([{ x: 0, y: 3, owner: 1, armies: 999, general: false, city: false }]);
    expect(all.groups.enemy).toEqual([]);
    expect(all.groups.allies).toEqual([]);
    expect(JSON.parse(await call('list_armies', { side: 'enemy', limit: 1 }) as string).groups).toEqual({ enemy: [] });
    expect(JSON.parse(await call('observe') as string)).toEqual(before);
    expect(JSON.parse((await flush())[0])).not.toHaveProperty('groups');
    await call('leave');
    expect(await call('list_armies')).toMatchObject({ failed: true, text: expect.stringContaining('No active map') });
    await waitFor(() => packets.some((packet) => packet.includes('leave_game')));
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
  });

  it('rejects invalid ranking filters and limits at the tool boundary', async () => {
    await startGame();
    const map = [2, 1, 5, 8, 0, 1];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    for (const side of ['ally', 1, null]) {
      expect(await call('list_armies', { side })).toMatchObject({ failed: true, text: expect.stringContaining('side must') });
    }
    for (const limit of [0, -1, GENERALS_ARMY_LIMITS.max + 1, 1.5, '10', null]) {
      expect(await call('list_armies', { limit })).toMatchObject({ failed: true, text: expect.stringContaining('limit must') });
    }
    expect(JSON.parse(await call('list_armies', { limit: 1 }) as string).groups.self).toEqual([
      { x: 0, y: 0, owner: 0, armies: 5, general: true, city: false },
    ]);
  });

  it('requires an active map for route simulation and gathering plans', async () => {
    const requests = [
      ['simulate_moves', { moves: [{ from: 0, to: 1 }] }],
      ['plan_gather', { target: 0, maxMoves: 2 }],
    ] as const;
    for (const [verb, args] of requests) {
      expect(await call(verb, args)).toMatchObject({ failed: true, text: expect.stringContaining('No active map') });
    }
    await startGame();
    for (const [verb, args] of requests) {
      expect(await call(verb, args)).toMatchObject({ failed: true, text: expect.stringContaining('No active map') });
    }
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
  });

  it('calculates plans repeatedly without changing the view, pending move progress or the next attack index', async () => {
    await startGame();
    const map = [4, 1, 5, 2, 10, 0, 0, 0, 0, -1];
    update(10, [0, map.length, ...map], [0, 0], { attackIndex: 0 });
    await waitFor(() => deferred.length === 1);
    await call('attack', { from: 1, to: 0 });
    await waitFor(() => packets.filter((packet) => packet.includes('attack')).length === 1);
    const before = JSON.parse(await call('observe') as string);
    const route = { moves: [{ from: 2, to: 1 }, { from: 1, to: 0 }] };
    const simulation = JSON.parse(await call('simulate_moves', route) as string);
    expect(simulation).toMatchObject({
      playerIndex: 0, observedTurn: 10, status: 'complete', completedMoves: 2, endTurn: 12,
      moveProgress: before.moveProgress,
      touchedTiles: [{ x: 0, y: 0, owner: 0, armies: 16 }, { x: 1, y: 0, armies: 1 }, { x: 2, y: 0, armies: 1 }],
    });
    expect(JSON.parse(await call('simulate_moves', route) as string)).toEqual(simulation);
    const args = { target: { x: 0, y: 0 }, maxMoves: 2, sources: [2], targetArmies: 16 };
    const plan = JSON.parse(await call('plan_gather', args) as string);
    expect(plan).toMatchObject({
      playerIndex: 0, observedTurn: 10, usedMoves: 2, deadlineTurn: 12,
      armyAtDeadline: 16, metTarget: true, moveProgress: before.moveProgress,
      moves: [
        { from: { x: 2, y: 0 }, to: { x: 1, y: 0 }, half: false },
        { from: { x: 1, y: 0 }, to: { x: 0, y: 0 }, half: false },
      ],
    });
    expect(JSON.parse(await call('plan_gather', args) as string)).toEqual(plan);
    expect(JSON.parse(await call('observe') as string)).toEqual(before);
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(1);
    const next = JSON.parse(await call('attack', { from: 1, to: 0 }) as string);
    expect(next.attackIndex).toBe(2);
    const queued = JSON.parse(await call('queue_moves', { moves: plan.moves }) as string);
    expect(queued.moves.map((move: { attackIndex: number }) => move.attackIndex)).toEqual([3, 4]);
    await waitFor(() => packets.filter((packet) => packet.includes('attack')).length === 4);
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([
        ['attack', 1, 0, false, 1], ['attack', 1, 0, false, 2],
        ['attack', 2, 1, false, 3], ['attack', 1, 0, false, 4],
      ]);
  });

  it('rejects invalid planning boundaries without consuming an attack index', async () => {
    await startGame();
    const map = [4, 1, 5, 10, 8, 999, 0, 0, 1, -3];
    update(10, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const before = JSON.parse(await call('observe') as string);
    const invalidGather: Record<string, unknown>[] = [
      ...[0, -1, GENERALS_ANALYSIS_LIMITS.maxMoves + 1, 1.5, '2', null].map((maxMoves) => ({ target: 0, maxMoves })),
      ...[2, 3, 4].map((target) => ({ target, maxMoves: 2 })),
      ...[0, -1, 1.5, '10', null].map((targetArmies) => ({ target: 0, maxMoves: 2, targetArmies })),
      ...[[], [2], [3], [4], null].map((sources) => ({ target: 0, maxMoves: 2, sources })),
      ...[
        [{ tile: 0, armies: 0 }], [{ tile: 0, armies: -1 }], [{ tile: 0, armies: 1.5 }],
        [{ tile: 0, armies: '2' }], [{ tile: 2, armies: 1 }], [{ tile: 3, armies: 1 }],
        [{ tile: 0 }], null,
      ].map((reserves) => ({ target: 0, maxMoves: 2, reserves })),
    ];
    for (const args of invalidGather) expect(await call('plan_gather', args)).toMatchObject({ failed: true });
    for (const moves of [[], [{ from: 0, to: 2 }], Array.from({ length: GENERALS_ANALYSIS_LIMITS.maxMoves + 1 }, () => ({ from: 0, to: 1 }))]) {
      expect(await call('simulate_moves', { moves })).toMatchObject({ failed: true });
    }
    expect(JSON.parse(await call('observe') as string)).toEqual(before);
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
    expect(JSON.parse(await call('attack', { from: 1, to: 0 }) as string).attackIndex).toBe(1);
    await waitFor(() => packets.filter((packet) => packet.includes('attack')).length === 1);
  });

  it('rejects unsupported room mechanics through both read tools while leaving ordinary movement available', async () => {
    await startGame({ options: { modifiers: [5] } });
    const map = [2, 1, 5, 10, 0, 0];
    update(10, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const before = JSON.parse(await call('observe') as string);
    expect(await call('simulate_moves', { moves: [{ from: 1, to: 0 }] }))
      .toMatchObject({ failed: true, text: expect.stringContaining('Simulation') });
    expect(await call('plan_gather', { target: 0, maxMoves: 2 }))
      .toMatchObject({ failed: true, text: expect.stringContaining('Simulation') });
    expect(JSON.parse(await call('observe') as string)).toEqual(before);
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
    expect(JSON.parse(await call('attack', { from: 1, to: 0 }) as string).attackIndex).toBe(1);
    await waitFor(() => packets.filter((packet) => packet.includes('attack')).length === 1);
  });

  it('delivers admission rejection, preserves its cause and permits registration followed by a retry', async () => {
    await call('join_private', { room: 'fixture-room' });
    send('gio_error', 'You must choose a username to continue playing!');
    await waitFor(() => store.range({ source: 'generals' }).some((e) => e.type === 'generals.error'));
    expect(JSON.parse(await call('observe') as string)).toMatchObject({
      phase: 'connected', room: null, connected: true, lobby: null,
      lastError: { event: 'gio_error', args: ['You must choose a username to continue playing!'] },
    });
    await call('set_username', { username: '[Bot] Fixture' });
    send('error_set_username', 'That username is taken');
    await waitFor(async () => JSON.parse(await call('observe') as string).lastError.event === 'error_set_username');
    expect(store.range({ source: 'generals' }).filter((e) => e.type === 'generals.error')).toHaveLength(2);
    send('error_set_username', '');
    await waitFor(() => store.range({ source: 'generals' }).some((e) => e.type === 'generals.account'));
    expect(JSON.parse(await call('observe') as string).lastError).toBeNull();
    expect(await call('join_private', { room: 'fixture-room' })).toContain('join_private');
  });

  it('confirms lobby admission from server snapshots and clears it when the server removes the seat', async () => {
    await call('join_private', { room: 'fixture-room' });
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ phase: 'join-requested', lobby: null });
    const lobby = { numPlayers: 2, usernames: ['Opponent', '[Bot] Fixture'], lobbyIndex: 1, numForce: [], owner: 0 };
    send('queue_update', lobby);
    await waitFor(() => store.range({ source: 'generals' }).some((e) => e.type === 'generals.lobby'));
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ phase: 'lobby', room: 'fixture-room', lobby });
    expect(store.range({ source: 'generals' }).find((e) => e.type === 'generals.lobby')).toMatchObject({
      origin: 'external', meta: { event: 'queue_update', args: [lobby] },
    });
    send('queue_left', null);
    await waitFor(async () => JSON.parse(await call('observe') as string).room === null);
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ phase: 'connected', lobby: null });
    expect(await call('join_private', { room: 'another-room' })).toContain('join_private');
  });

  it('keeps the trailing match run when a frame replaces a middle segment', async () => {
    await startGame();
    const map = [2, 2, 5, 0, 20, 0, 0, -3, -1, -4];
    update(1, [0, map.length, ...map]);
    await waitFor(() => deferred.length === 1);
    update(2, [2, 1, 9, 7], [1, 1, 2]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view?.turn === 2);
    const patched = JSON.parse(await call('observe') as string).view;
    expect(patched).toMatchObject({
      turn: 2, width: 2, height: 2, armies: [9, 0, 20, 0], terrain: [0, -3, -1, -4], cities: [2, 2],
    });
    expect(patched.terrain).toHaveLength(4);
    expect(world.webUi().lamps?.[0].state).toBe('online');
  });

  it('reports a fresh connection with no room while earlier lobby events remain in the store', async () => {
    await call('join_private', { room: 'fixture-room' });
    const lobby = { numPlayers: 1, lobbyIndex: 0, isForcing: true, numForce: [0] };
    send('queue_update', lobby);
    await waitFor(async () => JSON.parse(await call('observe') as string).phase === 'lobby');
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ room: 'fixture-room', lobby });
    await world.stop();
    const port = (server.address() as AddressInfo).port;
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, serverUrl: `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket` }, 'private-fixture-id', 'UTC');
    await world.start(host);
    const events = store.range({ source: 'generals' });
    expect(events.some((event) => event.type === 'generals.lobby' && event.meta?.event === 'queue_update')).toBe(true);
    const latestConnection = events.filter((event) => event.type === 'generals.connection').at(-1)!;
    expect(JSON.parse(latestConnection.text)).toEqual({ status: 'connected', phase: 'connected', room: null });
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ phase: 'connected', room: null, connected: true, lobby: null, view: null });
  });

  it('accepts three-block maps and keeps the game connected through tunnel and army updates', async () => {
    await startGame();
    const size = 19 * 18;
    const armies = Array<number>(size).fill(0); armies[0] = 5;
    const terrain = Array<number>(size).fill(-3); terrain[0] = 0;
    const tunnels = Array<number>(size).fill(0); tunnels[1] = -1; tunnels[2] = 12;
    const map = [19, 18, ...armies, ...terrain, ...tunnels];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse(await call('observe') as string)).toMatchObject({
      phase: 'playing', connected: true,
      view: { width: 19, height: 18, armies, terrain, tunnelLimits: tunnels },
    });
    update(2, [2, 1, 8, 2 * size, 1, 20, size - 2], [0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view?.turn === 2);
    armies[0] = 8; tunnels[1] = 20;
    const texts = await flush();
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0])).toMatchObject({ format: 'compact', turn: 2 });
    expect(JSON.parse(texts[0]).grid).toContain('p0:8G');
    expect(JSON.parse(await call('attack', { from: 0, to: 1 }) as string)).toMatchObject({ sent: 'attack', observedTurn: 2 });
    await waitFor(() => packets.some((p) => p.includes('attack')));
    expect(world.webUi().lamps?.[0].state).toBe('online');
  });

  it('rejects a row-wrapping move and sends queued adjacent moves without claiming execution', async () => {
    await startGame();
    const map = [2, 2, 5, 0, 20, 0, 0, -3, -1, -4];
    update(1, [0, map.length, ...map]);
    await waitFor(() => deferred.length === 1);
    expect(await call('attack', { from: 1, to: 2 })).toMatchObject({ failed: true });
    expect(await call('attack', { from: 0, to: 4 })).toMatchObject({ failed: true });
    const receipt = JSON.parse(await call('attack', { from: 0, to: 1, half: true }) as string);
    expect(receipt).toMatchObject({ sent: 'attack', observedTurn: 1 });
    await call('attack', { from: 1, to: 3 });
    await call('clear_moves');
    await waitFor(() => packets.some((p) => p.includes('clear_moves')));
    expect(packets.filter((p) => p.includes('attack')).map((p) => JSON.parse(p.slice(2)))).toEqual([['attack', 0, 1, true, 1], ['attack', 1, 3, false, 2]]);
  });

  it('limits event creation while observe and deferred rendering read updates between events', async () => {
    await world.stop();
    const port = (server.address() as AddressInfo).port;
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, serverUrl: `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, snapshotIntervalMs: 60_000 }, 'private-fixture-id', 'UTC');
    await world.start(host);
    await startGame();
    const map = [2, 1, 5, 0, 0, -3];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    update(2, [2, 1, 7, 3], [0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 2);
    expect(deferred).toHaveLength(1);
    const view = JSON.parse((await flush())[0]);
    expect(view).toMatchObject({ turn: 2, format: 'compact' });
    expect(view.grid).toContain('p0:7G');
  });

  it('invalidates pending maps on results and starts the next game from an empty patch base', async () => {
    await startGame();
    const map = [2, 1, 5, 0, 0, -3];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    send('game_lost', { killer: 1 });
    await waitFor(() => store.range({ source: 'generals' }).some((e) => e.type === 'generals.result'));
    expect(await flush()).toEqual([]);
    expect(await call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true });
    await call('leave');
    await startGame();
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse((await flush())[0]).grid).toContain('p0:5G');
  });

  it('appends batch and path moves in order with shared indices and future-owned sources', async () => {
    await startGame();
    const map = [3, 2, 10, 0, 0, 0, 0, 0, 0, -1, -1, -1, -1, -3];
    update(5, [0, map.length, ...map], [0, 0], { attackIndex: 7 });
    await waitFor(() => deferred.length === 1);
    const batch = JSON.parse(await call('queue_moves', { moves: [
      { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, half: true },
      { from: 0, to: 3 },
    ] }) as string);
    const route = JSON.parse(await call('move_path', { path: [1, { x: 2, y: 0 }, { x: 2, y: 1 }], half: [false, true] }) as string);
    const single = JSON.parse(await call('attack', { from: { x: 0, y: 1 }, to: { x: 1, y: 1 } }) as string);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    const wire = packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2)));
    expect(wire.slice(1)).toEqual([
      ['attack', 0, 1, true, 8], ['attack', 0, 3, false, 9],
      ['attack', 1, 2, false, 10], ['attack', 2, 5, true, 11],
      ['attack', 3, 4, false, 12], ['clear_moves'],
    ]);
    expect(batch).toMatchObject({ sent: 'attack', observedTurn: 5, moves: [
      { from: 0, to: 1, half: true, attackIndex: 8 }, { from: 0, to: 3, half: false, attackIndex: 9 },
    ] });
    expect(route.moves).toEqual([
      { from: 1, to: 2, half: false, step: 1, attackIndex: 10 }, { from: 2, to: 5, half: true, step: 2, attackIndex: 11 },
    ]);
    expect(single).toMatchObject({ attackIndex: 12, observedTurn: 5 });
    const observed = JSON.parse(await call('observe') as string);
    expect(observed.view.terrain).toEqual([0, -1, -1, -1, -1, -3]);
    expect(observed.afk.lastMove).toMatchObject({ attackIndex: 12, observedTurn: 5, sentAt: expect.any(String) });
  });

  it('checks visible map facts without sending and permits sources acquired by earlier moves', async () => {
    await startGame();
    const map = [3, 1, 12, 0, 99, 0, -1, -3];
    update(4, [0, map.length, ...map], [0, 0], { scores: [{ i: 1, total: 30, tiles: 2 }, { i: 0, total: 12, tiles: 1 }] });
    await waitFor(() => deferred.length === 1);
    const args = { moves: [{ from: 0, to: 1 }, { from: 1, to: 2 }] };
    const check = JSON.parse(await call('check_moves', args) as string);
    expect(check).toMatchObject({ observedTurn: 4, checks: [
      { step: 1, from: { index: 0, x: 0, y: 0, owner: 0, armies: 12, general: true }, to: { index: 1, owner: null, terrain: -1, armies: 0 } },
      { step: 2, from: { index: 1, owner: null, terrain: -1 }, to: { index: 2, terrain: -3, owner: null, armies: null, city: null, general: null, tunnelLimit: null } },
    ] });
    expect(JSON.parse(await call('view_map') as string)).toMatchObject({
      moveProgress: { lastSentAttackIndex: null, serverAttackIndex: null },
      view: { selfScore: { i: 0, total: 12, tiles: 1 }, selfGeneral: { index: 0, armies: 12 } },
    });
    const receipt = JSON.parse(await call('queue_moves', args) as string);
    expect(receipt.checks).toEqual(check.checks);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1], ['attack', 1, 2, false, 2]]);
  });

  it('reports server progress independently of sending, unchanged maps and clear requests', async () => {
    await startGame();
    const map = [3, 1, 12, 0, 0, 0, -1, -1];
    update(1, [0, map.length, ...map], [0, 0], { attackIndex: 0 });
    await waitFor(() => deferred.length === 1);
    await call('move_path', { path: [0, 1, 2] });
    expect(JSON.parse(await call('observe') as string).moveProgress).toMatchObject({ lastSentAttackIndex: 2, serverAttackIndex: 0, serverAttackIndexTurn: 1 });
    update(2, [map.length], [0], { attackIndex: 1 });
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 2);
    expect(JSON.parse((await flush())[0]).moveProgress).toMatchObject({ lastSentAttackIndex: 2, serverAttackIndex: 1, serverAttackIndexTurn: 2 });
    const clear = JSON.parse(await call('clear_moves') as string);
    expect(clear.moveProgress).toMatchObject({ serverAttackIndex: 1, lastClearRequest: { observedTurn: 2, lastSentAttackIndex: 2, sentAt: expect.any(String) } });
    update(3, [map.length], [0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 3);
    expect(JSON.parse(await call('observe') as string).moveProgress.serverAttackIndexTurn).toBe(2);
    update(4, [map.length], [0], { attackIndex: 2 });
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 4);
    const view = JSON.parse(await call('view_map') as string).view;
    expect(view.moveProgress).toMatchObject({ serverAttackIndex: 2, serverAttackIndexTurn: 4 });
    expect(view).not.toHaveProperty('selfTiles');
    expect(JSON.parse(await call('observe') as string).view.selfTiles).toEqual([{ index: 0, x: 0, y: 0, armies: 12 }]);
    const receipt = JSON.parse(await call('attack', { from: 0, to: 1 }) as string);
    expect(receipt).toMatchObject({ attackIndex: 3, check: { from: { armies: 12 }, to: { armies: 0 } } });
    await call('leave');
    expect(JSON.parse(await call('observe') as string).moveProgress).toEqual({ lastSentAttackIndex: null, serverAttackIndex: null, serverAttackIndexTurn: null, lastClearRequest: null });
  });

  it('previews and sends retained batch steps in order while reporting every mountain endpoint', async () => {
    await startGame();
    const map = [4, 2, 12, 0, 0, 0, 0, 0, 0, 0, 0, -1, -2, -2, -1, -1, -3, -4];
    update(7, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const batch = { moves: [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 7 }, { from: 4, to: 5, half: true }, { from: 5, to: 6 }, { from: 6, to: 7 }] };
    const preview = JSON.parse(await call('check_moves', batch) as string);
    expect(preview).toMatchObject({ playerIndex: 0, observedTurn: 7, checks: [{ step: 1 }, { step: 5 }, { step: 6 }, { step: 7 }], skipped: [
      { step: 2, reason: 'known_mountain', mountainEndpoints: ['to'], to: { x: 2, y: 0, terrain: -2 } },
      { step: 3, reason: 'known_mountain', mountainEndpoints: ['from', 'to'] },
      { step: 4, reason: 'known_mountain', mountainEndpoints: ['from'], from: { x: 3, y: 0, terrain: -2 } },
    ] });
    expect(JSON.parse(await call('observe') as string).moveProgress.lastSentAttackIndex).toBeNull();
    const receipt = JSON.parse(await call('queue_moves', batch) as string);
    expect(receipt.checks).toEqual(preview.checks);
    expect(receipt.skipped).toEqual(preview.skipped);
    expect(receipt.filteredRoutes).toEqual(preview.filteredRoutes);
    expect(receipt.filteredRoutes).toEqual([{ firstStep: 1, lastStep: 4, retainedSegments: [
      { firstStep: 1, lastStep: 1, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    ] }]);
    expect(receipt.moves.map((move: { step: number; attackIndex: number }) => [move.step, move.attackIndex])).toEqual([[1, 1], [5, 2], [6, 3], [7, 4]]);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1], ['attack', 4, 5, true, 2], ['attack', 5, 6, false, 3], ['attack', 6, 7, false, 4]]);
  });

  it('retains path edges after skipped mountains without joining or replanning them', async () => {
    await startGame();
    const map = [3, 2, 12, 0, 0, 0, 0, 0, 0, -1, -2, -1, -1, -3];
    update(7, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const receipt = JSON.parse(await call('move_path', { path: [0, 1, 2, 5, 4], half: [true, false, true, false] }) as string);
    expect(receipt.moves).toEqual([{ step: 1, from: 0, to: 1, half: true, attackIndex: 1 }, { step: 4, from: 5, to: 4, half: false, attackIndex: 2 }]);
    expect(receipt.skipped.map((step: { step: number }) => step.step)).toEqual([2, 3]);
    expect(receipt.filteredRoutes).toEqual([{ firstStep: 1, lastStep: 4, retainedSegments: [
      { firstStep: 1, lastStep: 1, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
      { firstStep: 4, lastStep: 4, from: { x: 2, y: 1 }, to: { x: 1, y: 1 } },
    ] }]);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, true, 1], ['attack', 5, 4, false, 2]]);
  });

  it.each([
    { label: 'unfiltered', path: [0, 1], retained: [1], segments: null },
    { label: 'prefix removed', path: [2, 3, 4], retained: [2], segments: [{ firstStep: 2, lastStep: 2, from: { x: 3, y: 0 }, to: { x: 4, y: 0 } }] },
    { label: 'suffix removed', path: [3, 4, 5], retained: [1], segments: [{ firstStep: 1, lastStep: 1, from: { x: 3, y: 0 }, to: { x: 4, y: 0 } }] },
    { label: 'multiple gaps', path: [0, 1, 2, 3, 4, 5, 6, 7], retained: [1, 4, 7], segments: [
      { firstStep: 1, lastStep: 1, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
      { firstStep: 4, lastStep: 4, from: { x: 3, y: 0 }, to: { x: 4, y: 0 } },
      { firstStep: 7, lastStep: 7, from: { x: 6, y: 0 }, to: { x: 7, y: 0 } },
    ] },
    { label: 'all removed', path: [1, 2, 3], retained: [], segments: [] },
  ])('reports $label path segments while sending exactly the retained edges', async ({ path, retained, segments }) => {
    await startGame();
    const map = [8, 1, 12, 0, 0, 1, 1, 0, 0, 0, 0, -1, -2, 1, 1, -2, -1, -3];
    update(7, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const moves = path.slice(1).map((to, i) => ({ from: path[i], to }));
    const preview = JSON.parse(await call('check_moves', { moves }) as string);
    expect(JSON.parse(await call('observe') as string).moveProgress.lastSentAttackIndex).toBeNull();
    const receipt = JSON.parse(await call('move_path', { path }) as string);
    expect(receipt.filteredRoutes).toEqual(preview.filteredRoutes);
    expect(receipt.filteredRoutes).toEqual(segments === null ? [] : [{ firstStep: 1, lastStep: path.length - 1, retainedSegments: segments }]);
    expect(receipt.moves.map((move: { step: number }) => move.step)).toEqual(retained);
    expect(receipt.sent).toBe(retained.length ? 'attack' : null);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual(retained.map((step, i) => ['attack', path[step - 1], path[step], false, i + 1]));
  });

  it('separates filtered chains from independent batch moves and keeps multi-edge segments intact', async () => {
    await startGame();
    const map = [8, 1, 12, 0, 0, 1, 1, 1, 1, 1, 0, -1, -2, 1, 1, 1, 1, 1];
    update(7, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const args = { moves: [
      { from: 0, to: 1 }, { from: 1, to: 2 },
      { from: 3, to: 4 }, { from: 4, to: 5 },
      { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 },
      { from: 6, to: 7 },
    ] };
    const preview = JSON.parse(await call('check_moves', args) as string);
    const receipt = JSON.parse(await call('queue_moves', args) as string);
    expect(receipt.filteredRoutes).toEqual(preview.filteredRoutes);
    expect(receipt.filteredRoutes).toEqual([
      { firstStep: 1, lastStep: 2, retainedSegments: [{ firstStep: 1, lastStep: 1, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }] },
      { firstStep: 5, lastStep: 7, retainedSegments: [{ firstStep: 6, lastStep: 7, from: { x: 3, y: 0 }, to: { x: 5, y: 0 } }] },
    ]);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([
        ['attack', 0, 1, false, 1], ['attack', 3, 4, false, 2], ['attack', 4, 5, false, 3],
        ['attack', 3, 4, false, 4], ['attack', 4, 5, false, 5], ['attack', 6, 7, false, 6],
      ]);
  });

  it('reports all-skipped batches and single attacks without changing prior move progress', async () => {
    await startGame();
    const map = [3, 1, 12, 0, 0, 0, -1, -2];
    update(7, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    await call('attack', { from: 0, to: 1 });
    const before = JSON.parse(await call('observe') as string);
    const batch = JSON.parse(await call('queue_moves', { moves: [{ from: 1, to: 2 }, { from: 2, to: 1 }] }) as string);
    expect(batch).toMatchObject({ sent: null, moves: [], checks: [], skipped: [{ step: 1, mountainEndpoints: ['to'] }, { step: 2, mountainEndpoints: ['from'] }] });
    const single = JSON.parse(await call('attack', { from: 2, to: 1 }) as string);
    expect(single).toMatchObject({ sent: null, check: null, skipped: [{ step: 1, reason: 'known_mountain' }] });
    expect(single).not.toHaveProperty('attackIndex');
    const after = JSON.parse(await call('observe') as string);
    expect(after.moveProgress).toEqual(before.moveProgress);
    expect(after.afk.lastMove).toEqual(before.afk.lastMove);
    const next = JSON.parse(await call('attack', { from: 0, to: 1 }) as string);
    expect(next.attackIndex).toBe(2);
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1], ['attack', 0, 1, false, 2]]);
  });

  it('filters the latest map when sending and retains fog steps despite historical mountains', async () => {
    await startGame();
    const open = [3, 1, 12, 0, 0, 0, -1, -1];
    update(1, [0, open.length, ...open], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const args = { moves: [{ from: 0, to: 1 }, { from: 1, to: 2 }] };
    expect(JSON.parse(await call('check_moves', args) as string).skipped).toEqual([]);
    const mountain = [3, 1, 12, 0, 0, 0, -2, -1];
    update(2, [0, mountain.length, ...mountain], [0, 0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 2);
    expect(JSON.parse(await call('queue_moves', args) as string)).toMatchObject({ observedTurn: 2, sent: null, moves: [], skipped: [{ step: 1 }, { step: 2 }] });
    const fog = [3, 1, 12, 0, 0, 0, -4, -1];
    update(3, [0, fog.length, ...fog], [0, 0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 3);
    expect(JSON.parse(await call('view_map') as string).view.grid).toContain('X~#');
    const receipt = JSON.parse(await call('queue_moves', args) as string);
    expect(receipt).toMatchObject({ observedTurn: 3, sent: 'attack', skipped: [], moves: [{ step: 1, attackIndex: 1 }, { step: 2, attackIndex: 2 }] });
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1], ['attack', 1, 2, false, 2]]);
  });

  it('identifies invalid batch endpoints, nested move fields and path edges before sending', async () => {
    await startGame();
    const map = [3, 1, 12, 0, 0, 0, -1, -1];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(await call('queue_moves', { moves: [{ from: 0, to: 1 }, { from: 0, to: 2 }] })).toMatchObject({ failed: true, text: expect.stringContaining('moves[1] (step 2): Error: Tiles must share an edge: (0,0) -> (2,0)') });
    expect(await call('queue_moves', { moves: [{ from: { x: 0, y: 0, to: { x: 1, y: 0 } }, to: 1 }] })).toMatchObject({ failed: true, text: expect.stringContaining('moves[0] (step 1): Error: from: Error: Tile coordinates accept only x and y') });
    expect(await call('queue_moves', { moves: [{ from: 0, to: { x: 3, y: 0 } }] })).toMatchObject({ failed: true, text: expect.stringContaining('to: Error: Tile coordinates are outside the map') });
    expect(await call('move_path', { path: [0, 1, 0, 2] })).toMatchObject({ failed: true, text: expect.stringContaining('path edge 3 (path[2] -> path[3])') });
    expect(await call('move_path', { path: [0, { x: -1, y: 0 }] })).toMatchObject({ failed: true, text: expect.stringContaining('path[1]') });
    await call('attack', { from: 0, to: 1 });
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1]]);
  });

  it('delivers dated opponent generals in map events and clears their records between games', async () => {
    await startGame();
    const hidden = [2, 1, 12, 999, 0, -3];
    update(1, [0, hidden.length, ...hidden], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse((await flush())[0]).enemyGenerals).toBe('p1? G?');
    const visible = [2, 1, 13, 50, 0, 1];
    update(2, [0, visible.length, ...visible], [0, 0], { generals: [0, 1] });
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse((await flush())[0]).enemyGenerals).toBe('p1? G(1,0) 50@2 seen');
    update(3, [0, hidden.length, ...hidden], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse((await flush())[0]).enemyGenerals).toBe('p1? G(1,0) 50@2 last');
    expect(JSON.parse(await call('observe') as string).view.enemyGenerals).toBe('p1? G(1,0) 50@2 last');
    await call('leave');
    expect(JSON.parse(await call('observe') as string).view).toBeNull();
    await startGame();
    update(1, [0, hidden.length, ...hidden], [0, 0]);
    await waitFor(() => deferred.length === 1);
    expect(JSON.parse((await flush())[0]).enemyGenerals).toBe('p1? G?');
  });

  it('inspects last-seen tiles without sending and clears history between games', async () => {
    await startGame();
    const map = [3, 1, 12, 8, 99, 0, 1, -3];
    update(5, [0, map.length, ...map], [0, 1, 1]);
    await waitFor(() => deferred.length === 1);
    const fog = [3, 1, 13, 200, 300, 0, -4, -3];
    update(6, [0, fog.length, ...fog], [0, 0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 6);
    const seen = JSON.parse(await call('inspect_tiles', { tiles: [{ x: 1, y: 0 }, 2] }) as string);
    expect(seen).toMatchObject({ observedTurn: 6, tiles: [
      { current: { index: 1, visible: false, owner: null, armies: null, city: null }, lastSeen: { owner: 1, armies: 8, city: true, lastSeenTurn: 5 } },
      { current: { index: 2, armies: null }, lastSeen: null },
    ] });
    expect(JSON.parse(await call('view_map') as string).view.grid).toContain('X~C');
    expect(await call('inspect_tiles', { tiles: [{ x: 3, y: 0 }] })).toMatchObject({ failed: true, text: expect.stringContaining('tiles[0]') });
    expect(await call('inspect_tiles', { tiles: [] })).toMatchObject({ failed: true });
    expect(await call('inspect_tiles', { tiles: [0, { x: 1, y: 0, half: true }] })).toMatchObject({ failed: true });
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack'))).toHaveLength(0);
    await call('leave');
    expect(await call('inspect_tiles', { tiles: [1] })).toMatchObject({ failed: true });
    await startGame();
    update(1, [0, fog.length, ...fog], [0, 0]);
    await waitFor(async () => JSON.parse(await call('observe') as string).view?.turn === 1);
    const next = JSON.parse(await call('inspect_tiles', { tiles: [1] }) as string);
    expect(next.tiles[0].lastSeen).toBeNull();
    expect(JSON.parse(await call('view_map') as string).view.grid).toContain(' X ?');
  });

  it.each([
    ['queue_moves', { moves: [] }],
    ['queue_moves', { moves: [{ from: 0, to: 1 }, { from: 1, to: 2 }] }],
    ['queue_moves', { moves: [{ from: 0, to: 1 }, { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }] }],
    ['queue_moves', { moves: [{ from: 0, to: 1 }, { from: 1, to: 3, half: 'true' }] }],
    ['move_path', { path: [0] }],
    ['move_path', { path: [0, 1, 2] }],
    ['move_path', { path: [0, 1, 3], half: [true] }],
    ['move_path', { path: [0, 1, 3], half: [true, 1] }],
    ['move_path', { path: [0, { x: 0.5, y: 0 }] }],
  ])('sends no moves from an invalid %s request and preserves the next attack index (%j)', async (verb, args) => {
    await startGame();
    const map = [2, 2, 10, 0, 0, 0, 0, -1, -1, -3];
    update(1, [0, map.length, ...map]);
    await waitFor(() => deferred.length === 1);
    expect(await call(verb as string, args as Record<string, unknown>)).toMatchObject({ failed: true });
    await call('attack', { from: 0, to: 1 });
    await call('clear_moves');
    await waitFor(() => packets.some((packet) => packet.includes('clear_moves')));
    expect(packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2))))
      .toEqual([['attack', 0, 1, false, 1]]);
    expect(JSON.parse(await call('observe') as string).afk.lastMove.attackIndex).toBe(1);
  });

  it('applies a uniform half flag to every path edge and rejects moves after game end', async () => {
    await startGame();
    expect(await call('move_path', { path: [0, 1] })).toMatchObject({ failed: true });
    const map = [3, 1, 9, 0, 0, 0, -1, -1];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    const receipt = JSON.parse(await call('move_path', { path: [0, 1, 2], half: true }) as string);
    expect(receipt.moves.map((move: { half: boolean }) => move.half)).toEqual([true, true]);
    send('game_won', null);
    await waitFor(() => store.range({ source: 'generals' }).some((event) => event.type === 'generals.result'));
    expect(await call('queue_moves', { moves: [{ from: 0, to: 1 }] })).toMatchObject({ failed: true });
    expect(await call('move_path', { path: [0, 1] })).toMatchObject({ failed: true });
  });

  it('delivers AFK score changes immediately despite map throttling without repeating unchanged warnings', async () => {
    await world.stop();
    const port = (server.address() as AddressInfo).port;
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, serverUrl: `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, snapshotIntervalMs: 60_000 }, 'private-fixture-id', 'UTC');
    await world.start(host);
    await startGame();
    const map = [2, 1, 7, 0, 0, -1];
    update(1, [0, map.length, ...map], [0, 0]);
    await waitFor(() => deferred.length === 1);
    await call('attack', { from: 0, to: 1 });
    const scores = [{ i: 1, total: 20, tiles: 12, warn_afk: true }, { i: 0, total: 7, tiles: 1 }];
    update(2, [map.length], [0], { scores });
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 2);
    expect(store.range({ source: 'generals' }).filter((event) => event.type === 'generals.afk')).toHaveLength(0);
    scores[1] = { i: 0, total: 7, tiles: 1, warn_afk: true };
    update(3, [map.length], [0], { scores });
    await waitFor(() => store.range({ source: 'generals' }).some((event) => event.type === 'generals.afk'));
    const warning = store.range({ source: 'generals' }).find((event) => event.type === 'generals.afk')!;
    expect(JSON.parse(warning.text)).toMatchObject({
      event: 'game_update', warnAfk: true, observedTurn: 3, score: { i: 0, tiles: 1, warn_afk: true },
      lastMove: { observedTurn: 1, attackIndex: 1, sentAt: expect.any(String) },
    });
    expect(deferred).toHaveLength(1);
    update(4, [map.length], [0], { scores });
    await waitFor(async () => JSON.parse(await call('view_map') as string).view.turn === 4);
    expect(store.range({ source: 'generals' }).filter((event) => event.type === 'generals.afk')).toHaveLength(1);
    expect(JSON.parse(await call('view_map') as string).afk).toMatchObject({ warnAfk: true, lastWarning: { observedTurn: 3 } });
    scores[1] = { i: 0, total: 8, tiles: 2 };
    update(5, [map.length], [0], { scores });
    await waitFor(async () => JSON.parse(await call('observe') as string).view.turn === 5);
    expect(store.range({ source: 'generals' }).filter((event) => event.type === 'generals.afk').map((event) => JSON.parse(event.text).warnAfk))
      .toEqual([true, false]);
    expect(JSON.parse(await call('view_map') as string).afk.warnAfk).toBe(false);
    await call('leave');
    expect(JSON.parse(await call('observe') as string).afk).toEqual({ warnAfk: false, lastWarning: null, lastMove: null });
  });

  it('forwards server afk_warning payloads without inferring a score warning or a kick deadline', async () => {
    send('afk_warning', 'fixture-warning');
    await waitFor(() => store.range({ source: 'generals' }).some((event) => event.type === 'generals.afk'));
    const warning = JSON.parse(store.range({ source: 'generals' }).find((event) => event.type === 'generals.afk')!.text);
    expect(warning).toEqual({ event: 'afk_warning', args: ['fixture-warning'], observedTurn: null, score: null, lastMove: null });
    expect(JSON.parse(await call('observe') as string).afk).toEqual({ warnAfk: false, lastWarning: warning, lastMove: null });
  });

  it('responds to Engine.IO heartbeats and clears observations after disconnect', async () => {
    await startGame();
    await waitFor(() => packets.includes('3'));
    peer.close(1000, 'fixture disconnected');
    await waitFor(() => world.webUi().lamps?.[0].state === 'error');
    expect(JSON.parse(await call('observe') as string)).toMatchObject({ connected: false, view: null, room: null });
    expect(await call('join_private', { room: 'another' })).toMatchObject({ failed: true });
  });

  it('disconnects on malformed patches without publishing a partial view', async () => {
    await startGame();
    update(1, [10]);
    await waitFor(() => world.webUi().lamps?.[0].state === 'error');
    expect(await flush()).toEqual([]);
    expect(JSON.parse(await call('observe') as string).view).toBeNull();
  });

  it.each([1, 3, 5])('rejects a map with %i extra entries instead of a complete tunnel block', async (extra) => {
    await startGame();
    const map = [2, 2, 5, 0, 20, 0, 0, -3, -1, -4, ...Array<number>(extra).fill(0)];
    update(1, [0, map.length, ...map]);
    await waitFor(() => world.webUi().lamps?.[0].state === 'error');
    expect(await flush()).toEqual([]);
    expect(JSON.parse(await call('observe') as string).view).toBeNull();
  });

  it('keeps tools available when the deployment has no account id', async () => {
    await world.stop();
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS }, '', 'UTC');
    await world.start(host);
    expect(await call('join_private', { room: 'fixture' })).toMatchObject({ failed: true, text: expect.stringContaining(GENERALS_SECRET) });
    expect(world.webUi().lamps?.[0].state).toBe('offline');
  });
});
