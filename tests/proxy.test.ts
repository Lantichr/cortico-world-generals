import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { DeferredEventSpec, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GENERALS_DEFAULTS } from '../src/config.ts';
import { GeneralsWorldProxy } from '../src/proxy.ts';
import { GeneralsWorld } from '../src/world.ts';

const context: ToolCallContext = { role: 'fixture', log: nullLogger() };
const cleanup: Array<() => Promise<void>> = [];

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Generals engine');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(options: { handshake?: boolean; initialPaused?: boolean; pauseHook?: boolean; start?: boolean; userId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'generals-proxy-'));
  const store = new JsonlEventStore({ dataDir: dir, run: 'r-20260101-000000-fixture' });
  const deferred: Array<Pick<DeferredEventSpec, 'type' | 'render'>> = [];
  const host: WorldHost = {
    store, log: nullLogger(), modelFacts: { model: () => 'fixture', accepts: () => false, contextWindow: () => undefined },
    pushEvent: async (event) => store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined }),
    pushDeferred: (event) => { deferred.push(event); },
    drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const packets: string[] = [];
  const peers: WebSocket[] = [];
  server.on('connection', (peer) => {
    peers.push(peer);
    const ping = setInterval(() => { if (peer.readyState === 1 && options.handshake !== false) peer.send('2'); }, 100);
    peer.on('close', () => clearInterval(ping));
    peer.on('message', (raw) => {
      const packet = raw.toString();
      packets.push(packet);
      if (packet === '40') peer.send('40' + JSON.stringify({ sid: 'fixture-namespace' }));
    });
    if (options.handshake !== false) peer.send('0' + JSON.stringify({ sid: 'fixture', pingInterval: 100, pingTimeout: 2000 }));
  });
  const cfg = { ...GENERALS_DEFAULTS, agent: { ...GENERALS_DEFAULTS.agent }, serverUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket`, connectTimeoutMs: 1000, snapshotIntervalMs: 0 };
  const proxy = new GeneralsWorldProxy(cfg, options.userId ?? 'fixture-private-account', 'UTC');
  if (options.pauseHook !== false) proxy.onOperatorPausedChanged(options.initialPaused ?? false);
  cleanup.push(async () => {
    await proxy.stop();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (verb: string, args: Record<string, unknown> = {}) => proxy.tools().find((tool) => tool.name === `generals_${verb}`)!.handler(args, context);
  const send = (name: string, value: unknown): void => { peers[0].send('42' + JSON.stringify([name, value])); };
  const events = () => store.range({ source: 'generals' });
  const child = (): ChildProcess => (proxy as unknown as { child: ChildProcess }).child;
  const update = (turn: number, armies = [10, 0, 5], terrain = [0, -1, 1], extra: Record<string, unknown> = {}): void => {
    const map = [3, 1, ...armies, ...terrain];
    send('game_update', { turn, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 2], scores: [{ i: 0, total: armies[0], tiles: 1 }, { i: 1, total: armies[2], tiles: 1 }], ...extra });
  };
  const game = async (): Promise<void> => {
    await call('join_private', { room: 'fixture-room' });
    send('game_start', { playerIndex: 0, replay_id: 'fixture-replay', teams: [1, 2], options: { modifiers: [] } });
    await waitFor(() => events().some((event) => event.type === 'generals.start'));
  };
  if (options.start !== false) await proxy.start(host);
  return { proxy, host, store, deferred, cfg, packets, peers, call, send, events, child, update, game };
}

afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

describe('GeneralsWorldProxy with a real engine and local protocol server', () => {
  it('requires the host pause hook before autonomous admission and sends no room or movement request on rejection', async () => {
    const f = await fixture({ pauseHook: false });
    expect(await f.call('start_agent', { room: 'fixture-room' })).toMatchObject({ failed: true, text: expect.stringContaining('onOperatorPausedChanged') });
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ control: 'manual' });
    const requests = f.packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2))[0]);
    expect(requests).not.toContain('join_private');
    expect(requests).not.toContain('attack');

    f.proxy.onOperatorPausedChanged(false);
    expect(await f.call('start_agent', { room: 'fixture-room' })).toBeTypeOf('string');
    await waitFor(() => f.packets.some((packet) => packet.startsWith('42') && JSON.parse(packet.slice(2))[0] === 'join_private'));
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ control: 'autonomous' });
  });

  it('preserves declarations and forwards room tools, failures and console state', async () => {
    const f = await fixture();
    const local = new GeneralsWorld(f.cfg, 'fixture-private-account', 'UTC');
    expect(f.proxy.tools().map(({ handler: _handler, ...decl }) => decl)).toEqual(local.tools().map(({ handler: _handler, ...decl }) => decl));
    expect(f.proxy.webUi().promptDocs).toEqual(local.webUi().promptDocs);
    expect(f.proxy.webUi().config).toEqual(local.webUi().config);
    await waitFor(() => Boolean(f.proxy.webUi().links?.length));
    const viewerUrl = f.proxy.webUi().links![0].href;
    expect(await (await fetch(new URL('/api/state', viewerUrl))).json()).toMatchObject({ phase: 'connected', board: null });
    expect(await f.call('attack', { from: 0, to: 1 })).toMatchObject({ failed: true, text: expect.stringContaining('No active map') });
    expect(await f.call('join_private', { room: 'fixture room' })).toContain('fixture%20room');
    f.send('queue_update', { players: 2 });
    await waitFor(() => f.proxy.webUi().badges?.some((badge) => badge.value === 'lobby') === true);
    await f.call('set_force_start', { enabled: true });
    await waitFor(() => f.packets.some((packet) => packet.includes('set_force_start')));
    expect(f.packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2)))).toEqual([
      ['join_private', 'fixture room', 'fixture-private-account'], ['set_force_start', 'fixture room', true],
    ]);
    expect(f.events().map((event) => event.text).join()).not.toContain('fixture-private-account');
  });

  it('requires a fresh host pause state before delegating after a proxy restart', async () => {
    const f = await fixture();
    await f.proxy.stop();
    await f.proxy.start(f.host);
    expect(await f.call('start_agent', { room: 'fixture-room' })).toMatchObject({ failed: true, text: expect.stringContaining('onOperatorPausedChanged') });
    const requests = f.packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2))[0]);
    expect(requests).not.toContain('join_private');
    expect(requests).not.toContain('attack');
    f.proxy.onOperatorPausedChanged(false);
    expect(await f.call('start_agent', { room: 'fixture-room' })).toBeTypeOf('string');
    await waitFor(() => f.packets.some((packet) => packet.startsWith('42') && JSON.parse(packet.slice(2))[0] === 'join_private'));
  });

  it('renders only the latest pending map using facts updated after event creation', async () => {
    const f = await fixture();
    await f.game();
    f.update(1);
    await waitFor(() => f.deferred.length === 1);
    f.update(2, [12, 0, 6]);
    await waitFor(() => f.deferred.length === 2);
    expect(await f.deferred[0].render()).toBeNull();
    const rendered = await f.deferred[1].render();
    expect(typeof rendered).toBe('string');
    expect(JSON.parse(rendered as string)).toMatchObject({ turn: 2 });
    expect(JSON.parse(rendered as string).grid).toContain('p0:12G');
    f.update(3);
    await waitFor(() => f.deferred.length === 3);
    f.send('game_won', {});
    await waitFor(() => f.events().some((event) => event.type === 'generals.result'));
    expect(await f.deferred[2].render()).toBeNull();
  });

  it('keeps calculation read only and forwards manual moves without changing the observed map', async () => {
    const f = await fixture();
    await f.game();
    f.update(1);
    await waitFor(() => f.deferred.length === 1);
    const before = JSON.parse(await f.call('observe') as string);
    const simulation = JSON.parse(await f.call('simulate_moves', { moves: [{ from: 0, to: 1 }] }) as string);
    expect(simulation).toHaveProperty('steps');
    expect(JSON.parse(await f.call('observe') as string)).toEqual(before);
    expect(f.packets.some((packet) => packet.includes('attack'))).toBe(false);
    await f.call('attack', { from: 0, to: 1 });
    await waitFor(() => f.packets.some((packet) => packet.includes('attack')));
    expect(f.packets.filter((packet) => packet.includes('attack')).map((packet) => JSON.parse(packet.slice(2)))).toEqual([['attack', 0, 1, false, 1]]);
    expect(JSON.parse(await f.call('observe') as string).view.armies).toEqual(before.view.armies);
  });

  it('runs autonomous moves without model replies and suspends and resumes across operator pauses', async () => {
    const f = await fixture({ initialPaused: true });
    expect(await f.call('join_private', { room: 'fixture-room' })).toMatchObject({ failed: true, text: expect.stringContaining('Operator paused') });
    expect(await f.call('start_agent')).toMatchObject({ failed: true, text: expect.stringContaining('Operator paused') });
    f.proxy.onOperatorPausedChanged(false);
    await f.game();
    await f.call('start_agent');
    f.proxy.onOperatorPausedChanged(true);
    await f.call('agent_status');
    f.update(1, [20, 0, 0]);
    await waitFor(async () => JSON.parse(await f.call('observe') as string).view?.turn === 1);
    const status = JSON.parse(await f.call('agent_status') as string);
    expect(status).toMatchObject({ operatorPaused: true, control: 'autonomous' });
    expect(f.packets.some((packet) => packet.includes('attack'))).toBe(false);
    f.proxy.onOperatorPausedChanged(false);
    f.update(2, [21, 0, 0]);
    await waitFor(() => f.packets.some((packet) => packet.includes('attack'))).catch(async () => { throw new Error(`S1 did not send: ${String(await f.call('agent_status'))}`); });
    f.proxy.onOperatorPausedChanged(true);
    await f.call('agent_status');
    const attacks = f.packets.filter((packet) => packet.includes('attack')).length;
    f.update(3, [1, 20, 0], [0, 0, 1], { attackIndex: 1 });
    await waitFor(async () => JSON.parse(await f.call('observe') as string).view.turn === 3);
    expect(f.packets.filter((packet) => packet.includes('attack'))).toHaveLength(attacks);
    f.proxy.onOperatorPausedChanged(false);
    f.update(4, [2, 21, 0], [0, 0, 1], { attackIndex: 1 });
    await waitFor(() => f.packets.filter((packet) => packet.includes('attack')).length > attacks);
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ control: 'autonomous', operatorPaused: false });
  });

  it('waits for namespace readiness and closes the engine after startup connection failure', async () => {
    const f = await fixture({ handshake: false, start: false });
    const starting = f.proxy.start(f.host);
    const outcome = starting.then(() => null, (error: unknown) => error);
    await waitFor(() => f.peers.length === 1);
    expect(await f.call('observe')).toMatchObject({ failed: true });
    const child = f.child();
    expect(await outcome).toBeInstanceOf(Error);
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    expect(f.peers).toHaveLength(1);
    expect(await f.call('observe')).toMatchObject({ failed: true });
  });

  it('rejects startup when its engine exits and does not reconnect automatically', async () => {
    const f = await fixture({ handshake: false, start: false });
    const outcome = f.proxy.start(f.host).then(() => null, (error: unknown) => error);
    await waitFor(() => f.peers.length === 1);
    f.child().kill('SIGKILL');
    expect(await outcome).toBeInstanceOf(Error);
    expect(await f.call('observe')).toMatchObject({ failed: true });
    expect(f.peers).toHaveLength(1);
  });

  it('closes the socket and exits when the parent IPC disconnects', async () => {
    const f = await fixture();
    await f.game();
    const child = f.child();
    child.disconnect();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    await waitFor(() => f.peers[0].readyState === 3);
    expect(await f.call('observe')).toMatchObject({ failed: true });
    expect(f.proxy.webUi().lamps?.some((lamp) => lamp.state === 'error')).toBe(true);
    expect(f.peers).toHaveLength(1);
  });

  it('stops the real engine without leaving a socket or child process', async () => {
    const f = await fixture();
    await f.game();
    const child = f.child();
    await f.proxy.stop();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(f.peers[0].readyState).toBe(3);
    expect(await f.call('observe')).toMatchObject({ failed: true });
    expect(f.packets.some((packet) => packet.includes('leave_game'))).toBe(true);
  });

  it('restarts explicitly with a new engine and invalidates callbacks from the stopped game', async () => {
    const f = await fixture();
    await expect(f.proxy.start(f.host)).rejects.toThrow('already started');
    await f.game();
    f.update(1);
    await waitFor(() => f.deferred.length === 1);
    const renderOld = f.deferred[0].render;
    const first = f.child();
    const firstViewerUrl = f.proxy.webUi().links![0].href;
    await Promise.all([f.proxy.stop(), f.proxy.stop()]);
    await f.proxy.start(f.host);
    expect(f.child().pid).not.toBe(first.pid);
    expect(await renderOld()).toBeNull();
    expect(JSON.parse(await f.call('observe') as string)).toMatchObject({ phase: 'connected', room: null, view: null });
    expect(f.peers).toHaveLength(2);
    expect(f.proxy.webUi().links![0].href).toBe(firstViewerUrl);
  });

  it('reuses the original viewer URL after rebuilding the World proxy and reconnects SSE there', async () => {
    const f = await fixture();
    const viewerUrl = f.proxy.webUi().links![0].href;
    const stateUrl = new URL('/api/state', viewerUrl);
    await f.game();
    f.update(1);
    await waitFor(async () => (await (await fetch(stateUrl)).json() as { turn: number }).turn === 1);
    await f.proxy.stop();
    await expect(fetch(stateUrl)).rejects.toThrow();
    const rebuilt = new GeneralsWorldProxy(f.cfg, 'fixture-private-account', 'UTC');
    cleanup.push(async () => { await rebuilt.stop(); });
    await rebuilt.start(f.host);
    expect(rebuilt.webUi().links![0].href).toBe(viewerUrl);
    expect(f.cfg.viewer.port).toBe(GENERALS_DEFAULTS.viewer.port);
    expect(await (await fetch(stateUrl)).json()).toMatchObject({ phase: 'connected', board: null, selected: null, queuedMoves: [] });
    const stream = await fetch(new URL('/stream', viewerUrl));
    const reader = stream.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(frame.slice('data: '.length))).toMatchObject({ phase: 'connected', board: null });
    await reader.cancel();
    const other = await fixture();
    expect(other.proxy.webUi().links![0].href).not.toBe(viewerUrl);
    expect(await (await fetch(stateUrl)).json()).toMatchObject({ phase: 'connected' });
  });

  it('honors a newly configured port over the remembered automatic port and keeps gameplay available on a conflict', async () => {
    const f = await fixture();
    await f.proxy.stop();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    f.cfg.viewer = { ...f.cfg.viewer, port: (blocker.address() as AddressInfo).port };
    const rebuilt = new GeneralsWorldProxy(f.cfg, 'fixture-private-account', 'UTC');
    cleanup.push(async () => { await rebuilt.stop(); });
    try {
      await rebuilt.start(f.host);
      expect(rebuilt.webUi().links).toEqual([]);
      expect(rebuilt.webUi().lamps).toContainEqual({ label: '画面', state: 'error', hint: expect.stringContaining('EADDRINUSE') });
      const result = await rebuilt.tools().find((tool) => tool.name === 'generals_observe')!.handler({}, context);
      expect(JSON.parse(result as string)).toMatchObject({ connected: true, phase: 'connected' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('keeps an unconfigured engine offline and returns a failed tool result', async () => {
    const f = await fixture({ userId: '' });
    expect(f.peers).toHaveLength(0);
    expect(await f.call('observe')).toMatchObject({ failed: true, text: expect.stringContaining('CORTICO_GENERALS_USER_ID') });
    expect(f.proxy.webUi().lamps?.[0]).toMatchObject({ state: 'offline' });
  });

  it('round trips strategy intents, rejection and clearing through the engine IPC', async () => {
    const f = await fixture();
    await f.game();
    f.update(10, [20, 0, 1]);
    await waitFor(async () => JSON.parse(await f.call('observe') as string).view?.turn === 10);
    await f.call('start_agent');
    const current = JSON.parse(await f.call('agent_status') as string);
    const intent = { gameId: current.gameId, controlEpoch: current.controlEpoch, revision: 1,
      basedOnTurn: current.observedTurn, expiresTurn: current.observedTurn + 20,
      goal: { kind: 'expand' }, constraints: {} };
    expect(await f.call('set_intent', intent)).toBeTypeOf('string');
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ activeIntentRevision: intent.revision,
      intent: { active: intent } });
    expect(f.packets.some((packet) => packet.includes('attack'))).toBe(false);
    expect(await f.call('set_intent', intent)).toMatchObject({ failed: true });
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ activeIntentRevision: intent.revision });
    const brief = JSON.parse(await f.call('strategy_brief') as string);
    expect(JSON.stringify(brief)).not.toContain('"grid"');
    expect(await f.call('clear_intent', { gameId: intent.gameId, controlEpoch: intent.controlEpoch, revision: intent.revision + 1 })).toBeTypeOf('string');
    expect(JSON.parse(await f.call('agent_status') as string)).toMatchObject({ control: 'autonomous', activeIntentRevision: null,
      intent: { active: null, status: 'cancelled' } });
    f.update(11, [20, 0, 1]);
    await waitFor(() => f.packets.some((packet) => packet.includes('attack')));
  });
});
