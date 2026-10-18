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
import type { StrategyIntent } from '../src/agent/contracts.ts';

const context: ToolCallContext = { role: 'main', log: nullLogger() };

describe('Generals strategy control over the local protocol', () => {
  let server: WebSocketServer, peer: WebSocket, world: GeneralsWorld, store: JsonlEventStore;
  let dir: string, packets: unknown[][];
  let deferred: Array<Parameters<WorldHost['pushDeferred']>[0]>;
  let writes: Array<{ type: string; options: Parameters<WorldHost['pushEvent']>[1] }>;
  const armies = [30, 0, 5, 0, 0, 0, 0, 0, 1];
  const terrain = [0, -1, -1, -1, -1, -1, -1, -1, 1];
  const call = (verb: string, args: Record<string, unknown> = {}) => world.tools().find((tool) => tool.name === `generals_${verb}`)!.handler(args, context);
  const read = async (verb = 'agent_status') => JSON.parse(await call(verb) as string);
  const send = (name: string, value: unknown) => peer.send('42' + JSON.stringify([name, value]));
  const attacks = () => packets.filter((packet) => packet[0] === 'attack');

  async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for local strategy protocol');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function frame(turn: number, extra: Record<string, unknown> = {}): Promise<void> {
    const map = [3, 3, ...armies, ...terrain];
    send('game_update', { turn, map_diff: [0, map.length, ...map], cities_diff: [0, 1, 2], generals: [0, 8],
      scores: [{ i: 0, total: armies[0], tiles: 1 }, { i: 1, total: armies[8], tiles: 1 }], ...extra });
    await waitFor(async () => (await read()).observedTurn === turn);
  }

  async function delegate(room = 'fixture'): Promise<void> {
    await call('join_private', { room });
    send('game_start', { playerIndex: 0, usernames: ['[Bot] Fixture', 'Opponent'], teams: [0, 1] });
    await waitFor(async () => (await read()).phase === 'playing');
    await frame(10);
    expect(await call('start_agent')).toBeTypeOf('string');
  }

  async function intent(overrides: Partial<StrategyIntent> = {}): Promise<StrategyIntent> {
    const status = await read();
    return { gameId: status.gameId, controlEpoch: status.controlEpoch, revision: 1,
      basedOnTurn: status.observedTurn, expiresTurn: status.observedTurn + 30,
      goal: { kind: 'capture_city', target: { x: 2, y: 0 } }, constraints: {}, ...overrides };
  }

  beforeEach(async () => {
    packets = []; deferred = []; writes = [];
    dir = mkdtempSync(join(tmpdir(), 'generals-strategy-'));
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
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS, snapshotIntervalMs: 0,
      serverUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket` }, 'private-fixture-id', 'UTC');
    await world.start({ store, log: nullLogger(),
      modelFacts: { model: () => { throw new Error('No model in strategy fixture'); }, accepts: () => false, contextWindow: () => undefined },
      pushEvent: async (event, options) => {
        writes.push({ type: event.type, options });
        return store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined });
      },
      pushDeferred: (spec) => { deferred.push(spec); }, drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
    } satisfies WorldHost);
  });

  afterEach(async () => {
    await world.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies an accepted intent on the next frame without appending an immediate move', async () => {
    await delegate();
    const proposed = await intent();
    expect(await call('set_intent', { ...proposed })).toBeTypeOf('string');
    expect(await read()).toMatchObject({ activeIntentRevision: proposed.revision,
      intent: { active: proposed }, lastDecision: null, pendingAction: null });
    expect(attacks()).toHaveLength(0);
    expect(await call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true });
    expect(await call('clear_moves')).toMatchObject({ failed: true });
    expect(await call('observe')).toBeTypeOf('string');
    expect(await call('strategy_brief')).toBeTypeOf('string');
    await frame(11);
    await waitFor(() => attacks().length === 1);
    expect(await read()).toMatchObject({ activeIntentRevision: proposed.revision,
      lastDecision: { observedTurn: 11, task: { kind: 'capture_city', target: 2 } } });
  });

  it('retains the valid intent when stale identity, revision, future basis or expiry is rejected', async () => {
    await delegate();
    const proposed = await intent();
    await call('set_intent', { ...proposed });
    const rejected: Array<Partial<StrategyIntent>> = [
      { gameId: 'previous-game', revision: 2 },
      { controlEpoch: proposed.controlEpoch - 1, revision: 2 },
      { revision: proposed.revision },
      { basedOnTurn: proposed.basedOnTurn + 1, revision: 2 },
      { expiresTurn: proposed.basedOnTurn, revision: 2 },
    ];
    for (const invalid of rejected) {
      expect(await call('set_intent', { ...proposed, ...invalid })).toMatchObject({ failed: true });
      expect(await read()).toMatchObject({ activeIntentRevision: proposed.revision, intent: { active: proposed } });
    }
    expect(attacks()).toHaveLength(0);
    expect(await call('clear_intent', { gameId: proposed.gameId, controlEpoch: proposed.controlEpoch, revision: proposed.revision })).toMatchObject({ failed: true });
    expect(await read()).toMatchObject({ activeIntentRevision: proposed.revision });
    expect(await call('clear_intent', { gameId: proposed.gameId, controlEpoch: proposed.controlEpoch, revision: proposed.revision + 1 })).toBeTypeOf('string');
    expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null,
      intent: { active: null, status: 'cancelled', lastRevision: proposed.revision + 1 } });
    await frame(11);
    await waitFor(() => attacks().length === 1);
    expect(await read()).toMatchObject({ control: 'autonomous', pendingAction: { observedTurn: 11 } });
  });

  it('expires before deciding at expiresTurn and keeps S1 autonomous', async () => {
    await delegate();
    const proposed = await intent({ expiresTurn: 11 });
    await call('set_intent', { ...proposed });
    await frame(proposed.expiresTurn);
    await waitFor(() => attacks().length === 1);
    expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null,
      intent: { active: null, status: 'expired' } });
  });

  it('keeps processing 120 turns while an S2 reply becomes expired before arrival', async () => {
    await delegate();
    const delayed = await intent({ expiresTurn: 110 });
    for (let turn = 11; turn <= 130; turn++) {
      await frame(turn, { attackIndex: turn - 11 });
      await waitFor(() => attacks().length === turn - 10);
    }
    expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null,
      lastDecision: { observedTurn: 130 } });
    expect(await call('set_intent', { ...delayed })).toMatchObject({ failed: true });
    expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null,
      intent: { active: null, lastRejection: { revision: delayed.revision, atTurn: 130 } } });
    await frame(131, { attackIndex: 120 });
    await waitFor(() => attacks().length === 121);
    expect(await read()).toMatchObject({ control: 'autonomous', pendingAction: { observedTurn: 131 } });
  });

  it.each(['pause', 'stop', 'leave', 'game_won', 'game_lost', 'disconnect'])(
    'clears an intent on %s without reusing it in another control epoch', async (ending) => {
      await delegate();
      const proposed = await intent();
      await call('set_intent', { ...proposed });
      if (ending === 'pause') world.onOperatorPausedChanged(true);
      else if (ending === 'stop') await call('stop_agent');
      else if (ending === 'leave') await call('leave');
      else if (ending === 'disconnect') {
        peer.close();
        await waitFor(async () => (await read()).phase === 'disconnected');
      } else {
        send(ending, {});
        await waitFor(async () => (await read()).phase === (ending === 'game_won' ? 'won' : 'lost'));
      }
      expect(await read()).toMatchObject({ activeIntentRevision: null, intent: { active: null } });
      expect((await read()).controlEpoch).toBeGreaterThan(proposed.controlEpoch);
      if (ending === 'pause') {
        world.onOperatorPausedChanged(false);
        await frame(11);
        await waitFor(() => attacks().length === 1);
        expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null });
      }
    },
  );

  it('rejects a previous game intent even with the new control epoch', async () => {
    await delegate();
    const previous = await intent();
    await call('set_intent', { ...previous });
    await call('leave');
    await delegate('second-fixture');
    const current = await read();
    expect(current.gameId).not.toBe(previous.gameId);
    expect(await call('set_intent', { ...previous, controlEpoch: current.controlEpoch })).toMatchObject({ failed: true });
    expect(await read()).toMatchObject({ control: 'autonomous', activeIntentRevision: null, intent: { active: null } });
    await frame(11);
    await waitFor(() => attacks().length === 1);
  });

  it('keeps autonomous map records out of delivered context and renders only the latest strategy brief', async () => {
    await delegate();
    const proposed = await intent();
    await call('set_intent', { ...proposed });
    const before = writes.length;
    await frame(11);
    await waitFor(() => attacks().length === 1);
    const pending = deferred.filter((spec) => spec.type === 'generals.strategy');
    expect(pending.length).toBeGreaterThan(0);
    const first = pending[0];
    await call('clear_intent', { gameId: proposed.gameId, controlEpoch: proposed.controlEpoch, revision: proposed.revision + 1 });
    const latest = deferred.filter((spec) => spec.type === 'generals.strategy').at(-1)!;
    expect(latest).not.toBe(first);
    expect(await first.render()).toBeNull();
    const rendered = JSON.parse(await latest.render() as string);
    expect(JSON.stringify(rendered)).not.toContain('"grid"');
    const mapWrites = writes.slice(before).filter((entry) => entry.type === 'generals.state');
    expect(mapWrites.length).toBeGreaterThan(0);
    expect(mapWrites.every((entry) => entry.options?.deliver === false)).toBe(true);
    expect(store.range({ source: 'generals' }).some((event) => event.type === 'generals.action')).toBe(true);
  });
});
