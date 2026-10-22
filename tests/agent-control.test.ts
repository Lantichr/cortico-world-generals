import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GENERALS_DEFAULTS } from '../src/config.ts';
import { GeneralsWorld } from '../src/world.ts';
import type { AgentDecision } from '../src/agent/contracts.ts';
import type { GeneralsViewerSnapshot } from '../src/viewer/contracts.ts';

const context: ToolCallContext = { role: 'main', log: nullLogger() };

describe('Generals S1 control over the local protocol', () => {
  let server: WebSocketServer, peer: WebSocket, world: GeneralsWorld, store: JsonlEventStore;
  let dir: string;
  let packets: unknown[][];
  let snapshots: Array<Parameters<WorldHost['pushDeferred']>[0]>;
  const armies = [20, 0, 0, 0, 0, 0, 0, 0, 4];
  const terrain = [0, -1, -1, -1, -1, -1, -1, -1, 1];

  async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for local S1 protocol');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const call = (verb: string, args: Record<string, unknown> = {}) => world.tools().find((tool) => tool.name === `generals_${verb}`)!.handler(args, context);
  const read = async (verb = 'agent_status') => JSON.parse(await call(verb) as string);
  const send = (name: string, value: unknown) => peer.send('42' + JSON.stringify([name, value]));
  const attacks = () => packets.filter((packet) => packet[0] === 'attack');
  async function frame(turn: number, extra: Record<string, unknown> = {}, owner = terrain, count = armies): Promise<void> {
    const map = [3, 3, ...count, ...owner];
    send('game_update', { turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 8],
      scores: [{ i: 0, total: 20, tiles: 1 }, { i: 1, total: 4, tiles: 1 }], ...extra });
    await waitFor(async () => (await read()).observedTurn === turn);
  }
  async function game(extra: Record<string, unknown> = {}): Promise<void> {
    send('game_start', { playerIndex: 0, usernames: ['[Bot] Fixture', 'Opponent'], teams: [0, 1], ...extra });
    await waitFor(async () => (await read()).phase === 'playing');
  }
  async function delegate(extra: Record<string, unknown> = {}): Promise<void> {
    expect(await call('start_agent', { room: 'fixture', ...extra })).toBeTypeOf('string');
    await game();
    await frame(1);
    await waitFor(() => attacks().length === 1);
  }

  beforeEach(async () => {
    packets = []; snapshots = [];
    dir = mkdtempSync(join(tmpdir(), 'generals-s1-'));
    store = new JsonlEventStore({ dataDir: dir, run: 'r-20260101-000000-fixture' });
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    server.on('connection', (socket) => {
      peer = socket;
      const timer = setInterval(() => { if (socket.readyState === 1) socket.send('2'); }, 50);
      socket.on('close', () => clearInterval(timer));
      socket.on('message', (raw) => {
        const message = raw.toString();
        if (message === '40') socket.send('40' + JSON.stringify({ sid: 'fixture-namespace' }));
        if (message.startsWith('42')) packets.push(JSON.parse(message.slice(2)));
      });
      socket.send('0' + JSON.stringify({ sid: 'fixture', pingInterval: 50, pingTimeout: 1000 }));
    });
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, snapshotIntervalMs: 60_000,
      serverUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket` }, 'private-fixture-id', 'UTC');
    await world.start({ store, log: nullLogger(),
      // Any accidental model dependency fails this fixture immediately.
      modelFacts: { model: () => { throw new Error('No model in S1 fixture'); }, accepts: () => false, contextWindow: () => undefined },
      pushEvent: async (event) => store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined }),
      pushDeferred: (spec) => { snapshots.push(spec); }, drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
    } satisfies WorldHost);
  });

  afterEach(async () => {
    await world.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams the current S1 plan without map-event throttling and drops stale plans while awaiting feedback', async () => {
    await delegate();
    const url = new URL('/api/state', world.webUi().links![0].href);
    const display = async () => (await (await fetch(url)).json()) as GeneralsViewerSnapshot;
    const first = await display();
    expect(first.plan?.routes.length).toBeGreaterThan(0);
    expect(first.queuedMoves).toHaveLength(1);
    expect(first.selected?.index).toBe(first.queuedMoves[0].to);
    expect((await read()).lastDecision).not.toHaveProperty('plan');
    expect((await read('observe')).agent.lastDecision).not.toHaveProperty('plan');
    await frame(2);
    expect(await display()).toMatchObject({ turn: 2, plan: null });
    expect((await display()).queuedMoves).toHaveLength(1);
    await frame(3, { attackIndex: 1 });
    expect((await display()).plan?.routes.length).toBeGreaterThan(0);
    world.onOperatorPausedChanged(true);
    expect(await display()).toMatchObject({ paused: true, plan: null, selected: null, queuedMoves: [] });
    world.onOperatorPausedChanged(false);
    expect((await display()).plan).toBeNull();
    await frame(4, { attackIndex: 2 });
    expect((await display()).plan).not.toBeNull();
    await call('stop_agent');
    expect(await display()).toMatchObject({ control: 'manual', plan: null, selected: null, queuedMoves: [] });
    peer.close();
    await waitFor(async () => (await display()).phase === 'disconnected');
    expect((await display()).board).toBeNull();
  });

  it('hides unsubmitted plans after accepted intent changes while rejected changes preserve them', async () => {
    await delegate();
    const url = new URL('/api/state', world.webUi().links![0].href);
    const display = async () => (await (await fetch(url)).json()) as GeneralsViewerSnapshot;
    const { gameId, controlEpoch } = await read();
    const intent = { gameId, controlEpoch, revision: 1, basedOnTurn: 1, expiresTurn: 100, goal: { kind: 'auto' }, constraints: {} };
    const first = await display();
    expect(await call('set_intent', { ...intent, basedOnTurn: 10 })).toMatchObject({ failed: true });
    expect((await display()).plan).toEqual(first.plan);
    expect(await call('set_intent', intent)).toBeTypeOf('string');
    expect((await display()).plan).toBeNull();
    expect((await display()).queuedMoves).toEqual(first.queuedMoves);
    await frame(2, { attackIndex: 1 });
    const second = await display();
    expect(second.plan).not.toBeNull();
    expect(await call('clear_intent', { gameId, controlEpoch, revision: 2 })).toBeTypeOf('string');
    expect((await display()).plan).toBeNull();
    expect((await display()).queuedMoves).toEqual(second.queuedMoves);
  });

  it('votes once only after admission when forceStart was explicitly requested', async () => {
    await call('start_agent', { room: 'fixture', forceStart: true });
    await waitFor(() => packets.length === 1);
    expect(packets).toEqual([['join_private', 'fixture', 'private-fixture-id']]);
    send('queue_update', { isForcing: false });
    await waitFor(() => packets.length === 2);
    send('queue_update', { isForcing: true });
    await waitFor(async () => (await read('observe')).lobby.isForcing === true);
    expect(packets.filter((packet) => packet[0] === 'set_force_start')).toEqual([['set_force_start', 'fixture', true]]);
  });

  it('keeps acting without S2 or additional snapshots and gives manual control a single index ledger', async () => {
    await delegate();
    expect(await call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true });
    expect(await call('clear_moves')).toMatchObject({ failed: true });
    for (let turn = 2; turn <= 5; turn++) {
      await frame(turn, { attackIndex: turn - 1 });
      await waitFor(() => attacks().length === turn);
    }
    expect(snapshots.filter((event) => event.type === 'generals.state')).toHaveLength(0);
    expect(snapshots.some((event) => event.type === 'generals.strategy')).toBe(true);
    expect(attacks().map((packet) => packet[4])).toEqual([1, 2, 3, 4, 5]);
    expect(packets.some((packet) => packet[0] === 'set_force_start')).toBe(false);
    const stopped = JSON.parse(await call('stop_agent') as string);
    expect(stopped).toMatchObject({ control: 'manual', clearRequested: true, lastFeedback: { outcome: 'cancel_requested' } });
    await call('attack', { from: 0, to: 1 });
    await waitFor(() => attacks().length === 6);
    expect(attacks()[5][4]).toBe(6);
  });

  it('pauses immediately, invalidates the old decision and resumes only on a new turn', async () => {
    await delegate();
    const previous = await read();
    world.onOperatorPausedChanged(true);
    await frame(2, { attackIndex: 1 });
    expect(attacks()).toHaveLength(1);
    expect(await call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true });
    world.onOperatorPausedChanged(false);
    const resumed = await read();
    expect(resumed.controlEpoch).toBeGreaterThan(previous.controlEpoch);
    const executor = world as unknown as { sendMoves(moves: Array<{ from: number; to: number; half: boolean }>, decision: AgentDecision): unknown };
    expect(() => executor.sendMoves([{ from: 0, to: 1, half: false }], previous.lastDecision)).toThrow('Stale S1 decision');
    await frame(2, { attackIndex: 1 });
    expect(attacks()).toHaveLength(1);
    await frame(3, { attackIndex: 1 });
    await waitFor(() => attacks().length === 2);
  });

  it('waits for processing, times out missing feedback and reports map changes without claiming success', async () => {
    await delegate();
    await frame(2);
    await frame(3);
    expect(attacks()).toHaveLength(1);
    await frame(4);
    expect(await read()).toMatchObject({ lastFeedback: { outcome: 'unconfirmed_timeout' }, pendingAction: null });
    await frame(5);
    await waitFor(() => attacks().length === 2);
    const changed = [...armies]; changed[0]++;
    await frame(6, {}, terrain, changed);
    expect(await read()).toMatchObject({ lastFeedback: { outcome: 'map_changed' }, pendingAction: null });
    expect(attacks()).toHaveLength(2);
    await frame(7, {}, terrain, changed);
    await waitFor(() => attacks().length === 3);
    await frame(8, { attackIndex: 3 }, terrain, changed);
    await waitFor(() => attacks().length === 4);
    expect(await read()).toMatchObject({ lastFeedback: { outcome: 'server_processed' } });
    expect((await read('observe')).moveProgress.lastClearRequest).toMatchObject({ observedTurn: 6 });
  });

  it.each([
    { options: { modifiers: [2] } },
    { options: { map: 'custom' } },
    { teams: [0, 1, 1] },
    { teams: [0, 0] },
  ])('stops unsupported automatic games before sending attacks: %j', async (start) => {
    await call('start_agent', { room: 'fixture' });
    await game(start);
    await frame(1);
    expect(await read()).toMatchObject({ control: 'manual', error: expect.any(String) });
    expect(attacks()).toHaveLength(0);
  });

  it('plays as player two, continues after one opponent is eliminated and stops only on a server result', async () => {
    await call('start_agent', { room: 'fixture' });
    await game({ playerIndex: 2, usernames: ['First', 'Second', '[Bot] Fixture'], teams: [0, 1, 2] });
    const owners = [0, -1, -1, -1, 2, -1, -1, -1, 1], counts = [1, 0, 0, 0, 30, 0, 0, 0, 1];
    const extra = { generals: [0, 8, 4], scores: [{ i: 0, total: 1, tiles: 1, dead: false },
      { i: 1, total: 1, tiles: 1, dead: false }, { i: 2, total: 30, tiles: 1, dead: false }] };
    await frame(1, extra, owners, counts);
    await waitFor(() => attacks().length > 0);
    expect(await read()).toMatchObject({ control: 'autonomous', error: null });
    await frame(2, { ...extra, attackIndex: 1, generals: [-1, 8, 4], scores: [
      { i: 0, total: 0, tiles: 0, dead: true }, { i: 1, total: 1, tiles: 1, dead: false },
      { i: 2, total: 31, tiles: 2, dead: false }] }, [2, -1, -1, -1, 2, -1, -1, -1, 1], counts);
    expect(await read()).toMatchObject({ control: 'autonomous', phase: 'playing', error: null });
    send('game_won', {});
    await waitFor(async () => (await read()).control === 'manual');
  });

  it('invalidates a pending move when its source changes owner with an unchanged army count', async () => {
    await delegate();
    const pending = (await read()).pendingAction;
    const changed = [...terrain]; changed[pending.from] = 1;
    await frame(2, {}, changed);
    expect(await read()).toMatchObject({ pendingAction: null, lastFeedback: { outcome: 'map_changed' } });
    expect(attacks()).toHaveLength(1);
    const archived = store.range({ source: 'generals' }).find((event) => event.type === 'generals.feedback');
    expect(JSON.parse(archived!.text!)).toMatchObject({ action: { actionId: pending.actionId }, outcome: 'map_changed' });
  });

  it('rejects tunnels before sending an automatic move', async () => {
    await call('start_agent', { room: 'fixture' }); await game();
    const map = [3, 3, ...armies, ...terrain, 0, 10, 0, 0, 0, 0, 0, 0, 0];
    await frame(1, { map_diff: [0, map.length, ...map] });
    expect(await read()).toMatchObject({ control: 'manual', error: expect.stringContaining('tunnels') });
    expect(attacks()).toHaveLength(0);
  });

  it.each(['game_won', 'game_lost'])('ends delegation on %s and never starts another game', async (result) => {
    await delegate();
    const oldGame = (await read()).gameId;
    send(result, {});
    await waitFor(async () => (await read()).control === 'manual');
    expect(await call('start_agent')).toMatchObject({ failed: true });
    await call('leave');
    expect(await read()).toMatchObject({ gameId: null, control: 'manual' });
    await call('join_private', { room: 'second' }); await game(); await frame(1);
    expect((await read()).gameId).not.toBe(oldGame);
    expect(attacks()).toHaveLength(1);
  });

  it('discards delegation on disconnect and refuses new packets', async () => {
    await delegate();
    peer.close();
    await waitFor(async () => (await read()).phase === 'disconnected');
    expect(await read()).toMatchObject({ control: 'manual', gameId: null, pendingAction: null });
    expect(await call('start_agent', { room: 'fixture' })).toMatchObject({ failed: true });
    expect(attacks()).toHaveLength(1);
  });

  it('blocks admission, delegation and voting while initially paused', async () => {
    world.onOperatorPausedChanged(true);
    expect(await call('join_private', { room: 'fixture' })).toMatchObject({ failed: true });
    expect(await call('start_agent', { room: 'fixture' })).toMatchObject({ failed: true });
    world.onOperatorPausedChanged(false);
    await call('join_private', { room: 'fixture' });
    world.onOperatorPausedChanged(true);
    expect(await call('set_force_start', { enabled: true })).toMatchObject({ failed: true });
  });

  it('accepts delegation between game start and the first map, and acts after that map arrives', async () => {
    await call('join_private', { room: 'fixture' });
    await game();
    expect(await read()).toMatchObject({ control: 'manual', observedTurn: -1 });
    expect(await call('start_agent')).toBeTypeOf('string');
    expect(await read()).toMatchObject({ control: 'autonomous', pendingAction: null });
    expect(attacks()).toHaveLength(0);
    await frame(1);
    await waitFor(() => attacks().length === 1);
    expect(await read()).toMatchObject({ control: 'autonomous', pendingAction: { observedTurn: 1 } });
  });

  it('rejects a previous game decision even if its control epoch and map revision match the new game', async () => {
    await delegate();
    const old = await read();
    await call('leave');
    await call('start_agent', { room: 'second' });
    await game();
    await frame(1);
    await waitFor(() => attacks().length === 2);
    const current = await read();
    expect(current.gameId).not.toBe(old.gameId);
    const stale = { ...old.lastDecision, controlEpoch: current.controlEpoch,
      basedOnRevision: current.lastDecision.basedOnRevision } as AgentDecision;
    const executor = world as unknown as {
      sendMoves(moves: Array<{ from: number; to: number; half: boolean }>, decision: AgentDecision): unknown;
    };
    expect(() => executor.sendMoves([{ from: 0, to: 1, half: false }], stale)).toThrow('Stale S1 decision');
    expect(attacks()).toHaveLength(2);
    expect((await read('observe')).moveProgress.lastSentAttackIndex).toBe(1);
  });

  it('closes the real transport and revokes tools even when leave transmission fails during stop', async () => {
    await delegate();
    const socket = (world as unknown as { client: { socket: WebSocket } }).client.socket;
    const closed = once(peer, 'close');
    socket.close();
    await expect(world.stop()).rejects.toThrow('Generals is disconnected');
    await closed;
    expect(await call('start_agent', { room: 'another' })).toMatchObject({ failed: true, text: 'Generals World is not started' });
    expect(world.webUi().badges).toContainEqual({ label: '对局', value: 'offline' });
    expect(world.webUi().badges).toContainEqual({ label: '控制', value: '手动' });
    expect(attacks()).toHaveLength(1);
  });

  it('ignores incoming game frames while asynchronous transport shutdown is still waiting', async () => {
    await delegate();
    const client = (world as unknown as { client: { socket: WebSocket; stop(): Promise<void> } }).client;
    const stopTransport = client.stop.bind(client);
    let release!: () => void;
    client.stop = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      await stopTransport();
    };
    const stopped = world.stop();
    try {
      const received = new Promise<void>((resolve) => {
        const listener = (raw: { toString(): string }): void => {
          const packet = raw.toString();
          if (!packet.startsWith('42') || JSON.parse(packet.slice(2))[0] !== 'game_update') return;
          client.socket.off('message', listener);
          resolve();
        };
        client.socket.on('message', listener);
      });
      const map = [3, 3, ...armies, ...terrain];
      send('game_update', { turn: 2, attackIndex: 1, map_diff: [0, map.length, ...map], cities_diff: [0, 0],
        generals: [0, 8], scores: [{ i: 0, total: 20, tiles: 1 }, { i: 1, total: 4, tiles: 1 }] });
      await received;
      expect(attacks()).toHaveLength(1);
      expect(await call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true, text: 'Generals World is not started' });
      expect(world.webUi().badges).toContainEqual({ label: '对局', value: 'offline' });
    } finally {
      release();
      await stopped;
      client.stop = stopTransport;
    }
  });
});
