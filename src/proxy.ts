/** 主进程保留工具与控制台声明；游戏连接、地图与自主动作由引擎子进程持有。 */
import { fork, type ChildProcess } from 'node:child_process';
import { emitLogNote, logChildStdio } from 'cortico/core/ipc-logger.ts';
import type { DeferredRendered, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import { GENERALS_DEFAULTS, type GeneralsConfigSection } from './config.ts';
import type { ChildToMain, EngineNote, EngineRequest, HostRequest, MainToChild } from './engine-ipc.ts';
import { GeneralsWorld } from './world.ts';

const CHILD_ENTRY = new URL('./engine-child.ts', import.meta.url);
const RPC_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 3000;
/** World rebuilds share this configuration object, retaining automatic viewer URLs within the process. */
const viewerPorts = new WeakMap<GeneralsConfigSection, number>();

export class GeneralsWorldProxy implements World {
  readonly id = 'generals';
  private readonly declarations: GeneralsWorld;
  private child: ChildProcess | null = null;
  private host: WorldHost | null = null;
  private ready = false;
  private stopping = false;
  private paused = false;
  private operatorPauseKnown = false;
  private nextId = 1;
  private declCache: Pick<WorldWebUiDecl, 'lamps' | 'badges' | 'links'> | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly cfg: GeneralsConfigSection, private readonly userId: string, private readonly timezone: string) {
    this.declarations = new GeneralsWorld(cfg, userId, timezone);
  }

  envPromptVars(): Record<string, string> { return this.declarations.envPromptVars(); }

  tools(): ToolDef[] {
    return this.declarations.tools().map((tool) => ({
      ...tool,
      handler: async (args, context) => {
        if (!this.ready) return { text: 'Generals engine is not running', failed: true };
        try {
          return await this.rpc({
            kind: 'tool', name: tool.name, args, role: context.role,
            ...(context.callId ? { callId: context.callId } : {}), ...(context.round !== undefined ? { round: context.round } : {}),
          }, RPC_TIMEOUT_MS, context.signal) as Awaited<ReturnType<ToolDef['handler']>>;
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), failed: true };
        }
      },
    }));
  }

  webUi(): WorldWebUiDecl {
    const decl = { ...this.declarations.webUi(), ...(this.declCache ?? {}) };
    decl.lamps = [...(decl.lamps ?? []), {
      label: '暂停联动', state: this.operatorPauseKnown ? 'online' : 'offline',
      hint: this.operatorPauseKnown ? 'S1 跟随宿主提供的暂停状态' : '全局暂停不停止 S1；使用 generals_stop_agent 或停用 World 停止',
    }];
    return decl;
  }

  onOperatorPausedChanged(paused: boolean): void {
    this.operatorPauseKnown = true;
    this.paused = paused;
    if (this.child?.connected) this.send(this.child, { t: 'paused', paused });
  }

  async start(host: WorldHost): Promise<void> {
    if (this.child) throw new Error('Generals engine is already started');
    this.host = host;
    this.stopping = false;
    const child = fork(CHILD_ENTRY, [], { execArgv: childExecArgv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child = child;
    this.declCache = { lamps: [{ label: '引擎', state: 'loading', hint: '启动中' }] };
    logChildStdio(child, host.log);
    child.on('message', (message: ChildToMain) => { if (this.child === child) this.onMessage(child, message); });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', (error) => {
      this.rejectPending(new Error(`Generals engine failed: ${error.message}`));
    });
    try {
      const viewer = { ...GENERALS_DEFAULTS.viewer, ...this.cfg.viewer };
      const port = viewer.port === 0 ? viewerPorts.get(this.cfg) ?? 0 : viewer.port;
      const cfg = { ...this.cfg, viewer: { ...viewer, port } };
      await this.rpc({ kind: 'init', init: { cfg, userId: this.userId, timezone: this.timezone, paused: this.paused, pauseLinked: this.operatorPauseKnown } }, this.cfg.connectTimeoutMs + 10_000);
      if (this.child !== child || this.stopping) throw new Error('Generals engine stopped during startup');
      this.ready = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    if (child) {
      try { await this.rpc({ kind: 'shutdown' }, STOP_TIMEOUT_MS); } catch { child.kill(); }
      await waitExit(child, STOP_TIMEOUT_MS);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitExit(child, STOP_TIMEOUT_MS);
      }
      if (this.child === child) this.child = null;
    }
    this.rejectPending(new Error('Generals engine stopped'));
    this.declCache = null;
    this.host = null;
    this.operatorPauseKnown = false;
    this.paused = false;
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.rejectPending(new Error('Generals engine exited'));
    if (this.stopping) return;
    this.declCache = { lamps: [{ label: '引擎', state: 'error', hint: '已退出；重启 World 恢复连接' }], badges: [{ label: '对局', value: '引擎退出' }, { label: '房间', value: '—' }] };
    const host = this.host;
    host?.log.error('Generals engine exited', { code, signal });
    void host?.pushEvent({
      type: 'generals.connection', source: this.id, senderKey: this.id, ts: nowIso(this.timezone),
      text: JSON.stringify({ status: 'engine-exited', code, signal, restartRequired: true }),
    }, { trigger: 'flush' }).catch(() => undefined);
  }

  private onMessage(child: ChildProcess, message: ChildToMain): void {
    if (message.t === 'rep') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error ?? 'Generals engine request failed'));
    } else if (message.t === 'hreq') {
      void this.handleHostRequest(child, message.id, message.req);
    } else {
      this.onNote(child, message.note);
    }
  }

  private async handleHostRequest(child: ChildProcess, id: number, req: HostRequest): Promise<void> {
    try {
      if (!this.host) throw new Error('Generals host is unavailable');
      const value = await this.host.pushEvent(req.event, req.opts);
      if (this.child === child) this.send(child, { t: 'hrep', id, ok: true, value });
    } catch (error) {
      if (this.child === child) this.send(child, { t: 'hrep', id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private onNote(child: ChildProcess, note: EngineNote): void {
    const host = this.host;
    if (!host) return;
    if (note.kind === 'log') emitLogNote(host.log, note, this.timezone);
    else if (note.kind === 'status') {
      this.declCache = note.decl;
      if ((this.cfg.viewer?.port ?? GENERALS_DEFAULTS.viewer.port) === 0 && note.viewerPort !== null) {
        viewerPorts.set(this.cfg, note.viewerPort);
      }
    }
    else host.pushDeferred({
      ...note.spec,
      render: async () => {
        if (this.child !== child || !this.ready) return null;
        try { return await this.rpc({ kind: 'render', token: note.token }, 2000) as DeferredRendered | null; }
        catch { return null; }
      },
    }, note.opts);
  }

  private rpc(req: EngineRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('Generals engine is not running'));
    if (signal?.aborted) return Promise.reject(new Error('Generals tool call was cancelled'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (error: Error): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.send(child, { t: 'cancel', id });
        reject(error);
      };
      const abort = (): void => cancel(new Error('Generals tool call was cancelled'));
      const timer = setTimeout(() => cancel(new Error(`Generals engine request timed out (${req.kind})`)), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      });
      this.send(child, { t: 'req', id, req });
    });
  }

  private send(child: ChildProcess, message: MainToChild): void {
    if (!child.connected) return;
    child.send(message, (error) => { if (error && this.child === child) this.rejectPending(error); });
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    child.once('exit', done);
  });
}
