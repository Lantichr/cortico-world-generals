import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GENERALS_DEFAULTS } from '../src/config.ts';
import { GeneralsWorld } from '../src/world.ts';
import { CityHalfAgent } from '../src/agent/city-half.ts';

const context: ToolCallContext = { role: 'fixture', log: nullLogger() };
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for city-half-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('city-half-1 World control with a real Python process', () => {
  let server: WebSocketServer, peer: WebSocket, world: GeneralsWorld, dir: string;
  let packets: unknown[][];
  const call = (name: string, args: Record<string, unknown> = {}) => world.tools().find((tool) => tool.name === `generals_${name}`)!.handler(args, context);
  const status = async () => JSON.parse(await call('agent_status') as string);
  const send = (name: string, value: unknown) => peer.send('42' + JSON.stringify([name, value]));
  const attacks = () => packets.filter(([name]) => name === 'attack');
  const frame = (turn: number, overrides: Record<string, unknown> = {}) => {
    const armies = Array(25).fill(0), terrain = Array(25).fill(-1);
    armies[0] = 30; armies[1] = 8; armies[24] = 5;
    terrain[0] = terrain[1] = 0; terrain[24] = 1;
    const map = [5, 5, ...armies, ...terrain];
    send('game_update', { turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 24],
      scores: [{ i: 0, total: 38, tiles: 2 }, { i: 1, total: 5, tiles: 1 }], ...overrides });
  };
  const intent = async (revision: number, extra: Record<string, unknown> = {}) => {
    const report = await status();
    return call('set_intent', { gameId: report.gameId, controlEpoch: report.controlEpoch, revision,
      basedOnTurn: report.observedTurn, expiresTurn: 100, goal: { kind: 'auto' }, constraints: {}, ...extra });
  };
  async function start() {
    await call('start_agent', { room: 'fixture' });
    send('game_start', { playerIndex: 0, usernames: ['Fixture', 'Opponent'], teams: [0, 1] });
    frame(1);
    await until(async () => (await status()).lastDecision?.observedTurn === 1);
  }

  beforeEach(async () => {
    packets = [];
    dir = mkdtempSync(join(tmpdir(), 'generals-city-half-'));
    const store = new JsonlEventStore({ dataDir: dir, run: 'r-20260101-000000-fixture' });
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    server.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data) => {
        const raw = data.toString();
        if (raw === '40') socket.send('40{"sid":"namespace"}');
        else if (raw.startsWith('42')) packets.push(JSON.parse(raw.slice(2)));
      });
      socket.send('0{"sid":"fixture","pingInterval":30000,"pingTimeout":10000}');
    });
    world = new GeneralsWorld({ ...GENERALS_DEFAULTS,
      agent: { ...GENERALS_DEFAULTS.agent, backend: 'city-half-1' },
      serverUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket` }, 'fixture-id', 'UTC');
    await world.start({ store, log: nullLogger(),
      modelFacts: { model: () => { throw new Error('S1 cannot call a model'); }, accepts: () => false, contextWindow: () => undefined },
      pushEvent: async (event) => store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined }),
      pushDeferred: () => {}, drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
    } satisfies WorldHost);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await world.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('submits an S2 gather move through the shared ledger and shows its execution and arrow', async () => {
    await start();
    expect(await intent(1, { goal: { kind: 'gather', target: { x: 1, y: 0 } },
      constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 12 }] } })).toBeTypeOf('string');
    frame(2);
    await until(() => attacks().length === 1);
    expect(attacks()[0]).toEqual(['attack', 0, 1, true, 1]);
    const report = await status();
    expect(report).toMatchObject({ backend: 'city-half-1', method: 'harris_city_half', intent: { status: 'following' },
      pendingAction: { from: 0, to: 1, half: true }, lastDecision: { execution: { mode: 'constraint_fallback' } } });
    const brief = JSON.parse(await call('strategy_brief') as string);
    expect(brief.execution).toMatchObject({ mode: 'constraint_fallback', basedOnTurn: 2 });
    const viewer = await (await fetch(new URL('/api/state', world.webUi().links![0].href))).json() as Record<string, any>;
    expect(viewer.selected.index).toBe(1);
    expect(viewer.queuedMoves).toHaveLength(1);
    await call('stop_agent');
    frame(3, { attackIndex: 1 });
    await until(async () => (await status()).observedTurn === 3);
    expect((await status()).control).toBe('manual');
    expect(attacks()).toHaveLength(1);
  });

  it.each(['stop', 'pause', 'intent', 'map'] as const)('discards a delayed real decision after %s changes', async (change) => {
    await start();
    const original = CityHalfAgent.prototype.decide;
    let release!: () => void, computed!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { computed = resolve; });
    // Delay only transport delivery; the move itself comes from the real policy subprocess.
    vi.spyOn(CityHalfAgent.prototype, 'decide').mockImplementationOnce(async function (this: CityHalfAgent, ...args) {
      const result = await original.apply(this, args);
      computed();
      await held;
      return result;
    });
    try {
      frame(2);
      await ready;
      if (change === 'stop') await call('stop_agent');
      if (change === 'pause') world.onOperatorPausedChanged(true);
      if (change === 'intent') await intent(1, { constraints: { avoidTiles: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } });
      if (change === 'map') {
        frame(3);
        await until(async () => (await status()).observedTurn === 3);
      }
    } finally { release(); }
    if (change === 'map') {
      await until(async () => (await status()).lastDecision?.observedTurn === 3);
      expect(attacks()).toHaveLength(1);
      expect((await status()).pendingAction.observedTurn).toBe(3);
    } else {
      frame(3);
      await until(async () => (await status()).observedTurn === 3);
      if (change === 'intent') await until(async () => (await status()).lastDecision?.observedTurn === 3);
      expect(attacks()).toHaveLength(0);
    }
  });

  it('stops on unsupported terrain instead of submitting the backend proposal', async () => {
    await call('start_agent', { room: 'fixture' });
    send('game_start', { playerIndex: 0, teams: [0, 1] });
    const map = [3, 1, 20, 0, 5, 0, -5, 1];
    send('game_update', { turn: 1, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 2], scores: [] });
    await until(async () => (await status()).error !== null);
    expect(await status()).toMatchObject({ control: 'manual', error: expect.stringContaining('special terrain') });
    expect(attacks()).toHaveLength(0);
  });
});
