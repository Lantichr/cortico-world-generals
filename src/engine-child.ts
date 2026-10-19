/** 游戏连接、地图与实时决策在引擎子进程运行；父进程只转发宿主调用。 */
import { createIpcLogger } from 'cortico/core/ipc-logger.ts';
import { withAnchors } from 'cortico/core/log-context.ts';
import type { DeferredRendered, WorldHost } from 'cortico/core/types.ts';
import { GeneralsWorld } from './world.ts';
import type { ChildToMain, EngineRequest, HostRequest, MainToChild } from './engine-ipc.ts';

const send = (message: ChildToMain): void => { if (process.connected) process.send?.(message); };
const log = createIpcLogger((note) => send({ t: 'note', note }));
let world: GeneralsWorld | null = null;
let paused = false;
let stopping = false;
let stopTask: Promise<void> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = '';
let nextHostId = 1;
let nextRenderToken = 1;
const deferred = new Map<number, () => DeferredRendered | null | Promise<DeferredRendered | null>>();
const renderByType = new Map<string, number>();
const pendingHost = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const requests = new Map<number, AbortController>();

function pushStatus(): void {
  if (!world) return;
  const { lamps, badges, links } = world.webUi();
  const decl = { lamps, badges, links };
  const viewerPort = world.viewerPort;
  const key = JSON.stringify({ decl, viewerPort });
  if (key === lastStatus) return;
  lastStatus = key;
  send({ t: 'note', note: { kind: 'status', decl, viewerPort } });
}

function hostRpc(req: HostRequest): Promise<unknown> {
  if (!process.connected) return Promise.reject(new Error('Generals parent IPC disconnected'));
  const id = nextHostId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error('Generals host did not acknowledge the event'));
    }, 10_000);
    timer.unref();
    pendingHost.set(id, { resolve, reject, timer });
    send({ t: 'hreq', id, req });
  });
}

const unavailable = (): never => { throw new Error('Synchronous Core facilities are unavailable in the Generals engine'); };
const host: WorldHost = {
  pushEvent: async (event, opts) => {
    pushStatus();
    return await hostRpc({ kind: 'push', event, opts }) as Awaited<ReturnType<WorldHost['pushEvent']>>;
  },
  pushDeferred: (spec, opts) => {
    const previous = renderByType.get(spec.type);
    if (previous !== undefined) deferred.delete(previous);
    const token = nextRenderToken++;
    renderByType.set(spec.type, token);
    deferred.set(token, spec.render);
    const { render: _render, ...fields } = spec;
    send({ t: 'note', note: { kind: 'deferred', token, spec: fields, opts } });
    pushStatus();
  },
  store: { get: unavailable, latestCursor: unavailable, range: unavailable, around: unavailable, grep: unavailable },
  drainPendingEvents: async () => [],
  modelFacts: { model: unavailable, accepts: unavailable, contextWindow: unavailable },
  blob: unavailable,
  reportUsage: unavailable,
  log,
};

function shutdown(exitCode: number): Promise<void> {
  if (stopTask) return stopTask;
  stopping = true;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  for (const controller of requests.values()) controller.abort();
  for (const entry of pendingHost.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Generals engine is stopping'));
  }
  pendingHost.clear();
  deferred.clear();
  renderByType.clear();
  stopTask = (async () => {
    const deadline = setTimeout(() => process.exit(exitCode), 2000);
    await world?.stop().catch((error: unknown) => log.warn('Generals engine stop failed', { error: String(error) }));
    world = null;
    clearTimeout(deadline);
  })();
  return stopTask;
}

async function handle(req: EngineRequest, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (req.kind === 'init') {
    if (world) throw new Error('Generals engine is already initialized');
    paused = req.init.paused;
    world = new GeneralsWorld(req.init.cfg, req.init.userId, req.init.timezone);
    if (req.init.pauseLinked) world.onOperatorPausedChanged(paused);
    await world.start(host);
    signal.throwIfAborted();
    pushStatus();
    statusTimer = setInterval(pushStatus, 100);
    statusTimer.unref();
    return null;
  }
  if (req.kind === 'shutdown') {
    await shutdown(0);
    return null;
  }
  if (!world || stopping) throw new Error('Generals engine is not running');
  if (req.kind === 'render') {
    const render = deferred.get(req.token);
    deferred.delete(req.token);
    for (const [type, token] of renderByType) if (token === req.token) renderByType.delete(type);
    return render ? await render() : null;
  }
  const tool = world.tools().find((candidate) => candidate.name === req.name);
  if (!tool) throw new Error(`Unknown Generals tool: ${req.name}`);
  const outcome = await withAnchors({ sess: req.role, ...(req.callId ? { call: req.callId } : {}), ...(req.round !== undefined ? { round: req.round } : {}) }, () => tool.handler(req.args, {
    role: req.role, log, signal,
    ...(req.callId ? { callId: req.callId } : {}), ...(req.round !== undefined ? { round: req.round } : {}),
  }));
  pushStatus();
  return outcome;
}

process.on('message', (message: MainToChild) => {
  if (message.t === 'hrep') {
    const entry = pendingHost.get(message.id);
    if (!entry) return;
    pendingHost.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error ?? 'Generals host request failed'));
    return;
  }
  if (message.t === 'paused') {
    paused = message.paused;
    world?.onOperatorPausedChanged(paused);
    pushStatus();
    return;
  }
  if (message.t === 'cancel') {
    requests.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(message.id, controller);
  void handle(message.req, controller.signal).then(
    (value) => send({ t: 'rep', id: message.id, ok: true, value }),
    (error: unknown) => send({ t: 'rep', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  ).finally(() => {
    requests.delete(message.id);
    if (message.req.kind === 'shutdown') setImmediate(() => process.exit(0));
  });
});

process.on('disconnect', () => { void shutdown(0).finally(() => process.exit(0)); });
process.on('uncaughtException', (error) => {
  log.error('Generals engine uncaught exception', { error });
  void shutdown(1).finally(() => process.exit(1));
});
process.on('unhandledRejection', (error) => {
  log.error('Generals engine unhandled rejection', { error });
  void shutdown(1).finally(() => process.exit(1));
});
