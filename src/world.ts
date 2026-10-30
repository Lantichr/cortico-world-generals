import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { World, WorldHost, WorldWebUiDecl, ToolDef, ToolTag } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { GENERALS_CONFIG_GROUP, GENERALS_DEFAULTS, GENERALS_SECRET, type GeneralsConfigSection } from './config.ts';
import { GeneralsClient } from './client.ts';
import { GENERALS_ARMY_LIMITS, GeneralsState } from './state.ts';
import { GENERALS_MOVE_SCHEMA, GENERALS_TILE_SCHEMA, describeFilteredRoutes, parseMove, parseMoves, parsePath, parseTiles, type Move } from './moves.ts';
import { createSimulationBoard, simulateMoves } from './simulation.ts';
import { GENERALS_ANALYSIS_LIMITS, parseGatherOptions, planGather } from './planning.ts';
import { GeneralsAgent } from './agent/agent.ts';
import { CityHalfAgent } from './agent/city-half.ts';
import { MoveExecutor } from './agent/executor.ts';
import type { AgentAction, AgentDecision, AgentFeedback, AgentObservation, AgentReport } from './agent/contracts.ts';
import { checkStrategyMove } from './agent/strategy.ts';
import { createStrategyBrief, significantStrategyChange, type StrategyBrief } from './agent/report.ts';
import { IntentController, STRATEGY_ANCHOR_PROPERTIES, STRATEGY_INTENT_PROPERTIES } from './intent.ts';
import { GeneralsViewerServer } from './viewer/server.ts';
import type { GeneralsViewerSnapshot } from './viewer/contracts.ts';

interface MoveCheck {
  step: number;
  from: ReturnType<GeneralsState['tile']>;
  to: ReturnType<GeneralsState['tile']>;
  half: boolean;
}

export class GeneralsWorld implements World {
  readonly id = 'generals';
  private host: WorldHost | null = null;
  private readonly client: GeneralsClient;
  private state: GeneralsState | null = null;
  private room: string | null = null;
  private lobby: Record<string, unknown> | null = null;
  private lastError: { event: string; args: unknown[] } | null = null;
  private phase = 'offline';
  private revision = 0;
  private lastSnapshotAtMs = -Infinity;
  private readonly executor: MoveExecutor;
  private readonly agent: GeneralsAgent;
  private readonly cityHalf: CityHalfAgent | null;
  private cityStep: Promise<void> | null = null;
  private lastAfkWarning: Record<string, unknown> | null = null;
  private scoreWarnAfk = false;
  private gameId: string | null = null;
  private controlEpoch = 0;
  private control: 'manual' | 'autonomous' = 'manual';
  private operatorPaused = false;
  private operatorPauseLinked = false;
  private observationRevision = 0;
  private agentLastTurn = -1;
  private agentForceStart = false;
  private agentVoted = false;
  private agentError: string | null = null;
  private lastDecision: AgentDecision | null = null;
  private lastDecisionIntentRevision = 0;
  private lastFeedback: AgentFeedback | null = null;
  private pendingAction: { action: AgentAction; sourceArmies: number | null; targetArmies: number | null; targetOwner: number | null } | null = null;
  private lastAgentReportAtMs = -Infinity;
  private readonly intents = new IntentController();
  private lastQueuedBrief: StrategyBrief | null = null;
  private lastRenderedBrief: StrategyBrief | undefined;
  private strategyReportRevision = 0;
  private strategyReportsEnabled = false;
  private readonly viewer: GeneralsViewerServer;
  private viewerError: string | null = null;

  constructor(private readonly cfg: GeneralsConfigSection, private readonly userId: string, private readonly timezone: string) {
    this.cfg = { ...cfg, agent: { ...GENERALS_DEFAULTS.agent, ...cfg.agent }, viewer: { ...GENERALS_DEFAULTS.viewer, ...cfg.viewer } };
    this.viewer = new GeneralsViewerServer({ preferredPort: this.cfg.viewer.port, snapshot: () => this.viewerSnapshot() });
    this.client = new GeneralsClient((name, args) => this.onEvent(name, args), (reason) => {
      this.reset('disconnected');
      this.emit('connection', { status: 'disconnected', phase: this.phase, room: this.room, reason });
    });
    this.executor = new MoveExecutor((name, ...args) => this.client.send(name, ...args), () => nowIso(this.timezone));
    this.agent = new GeneralsAgent(this.cfg.agent);
    if (!['legacy', 'city-half-1'].includes(this.cfg.agent.backend)) throw new Error('Unsupported S1 backend');
    if (!this.cfg.agent.pythonExecutable.trim() || !Number.isSafeInteger(this.cfg.agent.pythonTimeoutMs)
      || this.cfg.agent.pythonTimeoutMs < 100 || this.cfg.agent.pythonTimeoutMs > 60_000) throw new Error('Invalid Python backend configuration');
    this.cityHalf = this.cfg.agent.backend === 'city-half-1' ? new CityHalfAgent(this.cfg.agent) : null;
  }

  envPromptVars(): Record<string, string> { return {}; }

  get viewerPort(): number | null { return this.viewer.port; }

  webUi(): WorldWebUiDecl {
    return {
      label: 'Generals',
      lamps: [{ label: '连接', state: this.client.connected ? 'online' : this.phase === 'connecting' ? 'loading' : this.phase === 'disconnected' ? 'error' : 'offline', hint: this.userId ? this.phase : `${GENERALS_SECRET} 未配置` },
        ...(this.viewerError ? [{ label: '画面', state: 'error' as const, hint: this.viewerError }] : [])],
      badges: [{ label: '对局', value: this.phase }, { label: '房间', value: this.room ?? '—' }, { label: '控制', value: this.control === 'autonomous' ? this.operatorPaused ? 'S1 暂停' : 'S1 自主' : '手动' }],
      links: this.viewer.running ? [{ label: '对局画面', href: this.viewer.viewerUrl }] : [],
      config: [GENERALS_CONFIG_GROUP],
      promptDocs: [{ key: 'worlds.generals.envPrompt', title: 'Generals · 环境提示词', description: 'Bot Server 的观测、战争迷雾与移动回执契约。', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)), role: 'envPrompt' }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.viewerError = null;
    if (this.cfg.viewer.enabled) {
      try { await this.viewer.start(); }
      catch (error) {
        this.viewerError = String(error);
        host.log.warn('Generals viewer failed to start', { error: String(error) });
      }
    }
    if (!this.userId) return;
    this.phase = 'connecting';
    try {
      await this.client.start(this.cfg.serverUrl, this.cfg.connectTimeoutMs);
      this.phase = 'connected';
      this.emit('connection', { status: 'connected', phase: this.phase, room: this.room });
    } catch (error) {
      await this.client.stop();
      this.reset('disconnected');
      await this.viewer.stop();
      this.host = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const leave = this.client.connected && this.room !== null;
    this.host = null;
    this.reset('offline');
    try {
      if (leave) {
        this.client.send('leave_game');
        this.client.send('cancel');
      }
    } finally {
      try { await this.client.stop(); }
      finally { await Promise.all([this.viewer.stop(), this.cityHalf?.close()]); }
    }
  }

  onOperatorPausedChanged(paused: boolean): void {
    this.operatorPauseLinked = true;
    if (this.operatorPaused === paused) return;
    this.operatorPaused = paused;
    this.controlEpoch++;
    this.intents.reset('invalidated', 'operator_pause_changed');
    this.resetAgent();
    this.agentLastTurn = this.state?.turn ?? -1;
    if (this.control === 'autonomous' && this.phase === 'playing' && this.client.connected) this.requestClear();
    this.reportAgent(true);
    if (!paused) this.voteForAgent();
    this.viewer.publish();
  }

  tools(): ToolDef[] {
    const movesProperty = {
      type: 'array', minItems: 1, items: GENERALS_MOVE_SCHEMA,
      description: '按执行顺序给出 {from,to,half}。例如 moves:[{from:{x:0,y:0},to:{x:1,y:0}},{from:{x:1,y:0},to:{x:1,y:1},half:true}]。每步必须共边；from 和 to 内只放 x、y。',
    };
    const tool = (verb: string, description: string, tags: ToolTag[], properties: Record<string, unknown>, required: string[], action: (args: Record<string, unknown>) => unknown): ToolDef => ({
      name: `generals_${verb}`, description, tags,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      ...(['start_agent', 'stop_agent', 'set_intent', 'clear_intent'].includes(verb) ? { barrierAfter: true } : {}),
      handler: async (args, context) => {
        if (!this.host) return { text: 'Generals World is not started', failed: true };
        if (!this.userId) return { text: `Configure ${GENERALS_SECRET} in the deployment .env`, failed: true };
        try { context.signal?.throwIfAborted(); return JSON.stringify(action(args)); }
        catch (error) { return { text: String(error), failed: true }; }
        finally { this.viewer.publish(); }
      },
    });
    return [
      tool('observe', 'Read current connection, phase, room, lobby, error and AFK status, plus the latest map, selfScore, selfGeneral and moveProgress. Check this after restart or before another game; historical lobby events do not establish current admission or a force-start vote. Compact returns a grid and player color legend; raw (default) includes arrays and selfTiles. No hidden tiles are inferred.', ['read'], {
        format: { type: 'string', enum: ['raw', 'compact'], default: 'raw', description: 'compact 读坐标地图；raw 读完整 armies、terrain、tunnelLimits 数组。' },
      }, [], (args) => {
        if (args.format !== undefined && args.format !== 'raw' && args.format !== 'compact') throw new Error('format must be raw or compact');
        return this.observation(args.format === 'compact');
      }),
      tool('view_map', 'Read a compact grid, player color legend, selfScore, general garrison, move progress and AFK status. Fog cells with ~ carry historical features, not current ownership or armies. Use inspect_tiles for last-seen details and observe(format=raw) for full arrays.', ['read'], {}, [], () => this.observation(true)),
      tool('list_armies', 'Locate the largest currently visible owned stacks for gathering, defense or tracking enemy forces. Defaults to the top 10 self tiles. Returns observedTurn and coordinates, owner, armies, general/city flags. all ranks self, confirmed enemies, allies and unknown relations separately. Excludes neutral and fog tiles, including historical armies. Results are visibility- and limit-bound; a small visible maximum does not establish a small enemy army. Compare that player\'s public scores.total. Garrison size does not mean all troops can safely be moved.', ['read'], {
        side: { type: 'string', enum: ['self', 'enemy', 'all'], default: 'self', description: 'self 找己方兵源；enemy 查已确认敌方主力；all 分 self、enemy、allies、unknown 四组，关系未知者不算已确认敌方。' },
        limit: { type: 'integer', minimum: 1, maximum: GENERALS_ARMY_LIMITS.max, default: GENERALS_ARMY_LIMITS.default, description: '每组最多返回多少格；按兵力降序，同兵力按行优先索引顺序。' },
      }, [], (args) => {
        const state = this.activeMap();
        const side = args.side === undefined ? 'self' : args.side;
        const limit = args.limit === undefined ? GENERALS_ARMY_LIMITS.default : args.limit;
        if (side !== 'self' && side !== 'enemy' && side !== 'all') throw new Error('side must be self, enemy or all');
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > GENERALS_ARMY_LIMITS.max) throw new Error(`limit must be an integer from 1 to ${GENERALS_ARMY_LIMITS.max}`);
        return { playerIndex: state.playerIndex, observedTurn: state.turn, side, limit, groups: state.listArmies(side, limit) };
      }),
      tool('inspect_tiles', 'Read selected tiles with current visibility and separate last-seen facts for this game. lastSeenTurn dates historical ownership, armies and features; null means never seen. This sends no moves and does not refresh hidden information.', ['read'], {
        tiles: { type: 'array', minItems: 1, items: GENERALS_TILE_SCHEMA, description: '要核对的格子索引或 {x,y} 坐标，例如 tiles:[{x:1,y:2},35]。返回 current 和 lastSeen；旧兵力不代表当前兵力。' },
      }, ['tiles'], (args) => {
        const state = this.activeMap();
        return { playerIndex: state.playerIndex, observedTurn: state.turn, tiles: parseTiles(args.tiles, state.width, state.height).map((index) => ({ current: state.tile(index), lastSeen: state.lastSeen(index) })) };
      }),
      tool('check_moves', 'Preview movement filtering without sending. Returns playerIndex, retained checks, skipped mountain steps and filteredRoutes: affected original chains and their retained consecutive segments, with step ranges and endpoint coordinates. Independent moves start separate chains. Rejects malformed or nonadjacent moves. Future-owned sources are allowed; ownership, armies and combat are not simulated.', ['read'], { moves: movesProperty }, ['moves'], (args) => {
        const state = this.activeMap();
        return { playerIndex: state.playerIndex, observedTurn: state.turn, ...this.checkMoves(parseMoves(args.moves, state.width, state.height)), moveProgress: this.moveProgress() };
      }),
      tool('simulate_moves', 'Calculate an ordered route or multi-source batch on a copy of the current map. Accounts for full/half movement, garrisons, merging, combat and standard turn production. Assumes immediate serial execution, no existing queue and no opponent movement; missing room metadata assumes standard rules. Stops at unknown facts, mountains, unusable sources, tunnels or allied transfers; general capture stops after its local result. Rejects known unsupported modes. Sends no moves. Predictions do not confirm execution; check moveProgress and current facts before sending.', ['read'], {
        moves: { ...movesProperty, maxItems: GENERALS_ANALYSIS_LIMITS.maxMoves },
      }, ['moves'], (args) => {
        const state = this.activeMap();
        if (Array.isArray(args.moves) && args.moves.length > GENERALS_ANALYSIS_LIMITS.maxMoves) throw new Error(`moves accepts at most ${GENERALS_ANALYSIS_LIMITS.maxMoves} steps`);
        return { ...simulateMoves(state, parseMoves(args.moves, state.width, state.height)), moveProgress: this.moveProgress() };
      }),
      tool('plan_gather', 'Suggest gathering or reinforcement moves to a self-owned target within one shared serial move budget. Greedy shortest paths use currently visible self-owned tiles without tunnels. Sources are candidate starts; troops along their paths also merge. Default reserves preserve the current self-general garrison; explicit reserves override it. Estimates target armies at observedTurn + maxMoves, including idle production. Assumes no old queue, thinking delay or enemy actions. This heuristic is not optimal and an unmet target does not prove infeasibility. Sends no moves; choose the strategic target and decide whether to submit returned moves with queue_moves.', ['read'], {
        target: { ...GENERALS_TILE_SCHEMA, description: '当前己方可见的集结或回防目标格；战略目标由你选择。' },
        maxMoves: { type: 'integer', minimum: 1, maximum: GENERALS_ANALYSIS_LIMITS.maxMoves, description: '所有兵源共用的动作预算；预测截止 turn = observedTurn + maxMoves，未使用的 turn 按静置产兵计。' },
        targetArmies: { type: 'integer', minimum: 1, description: '可选：截止时目标总驻军；包含原有驻军及产兵，达到后停止添加路线。' },
        sources: { type: 'array', minItems: 1, items: GENERALS_TILE_SCHEMA, description: '可选的己方可见候选起点；省略时考虑所有己方格，沿途其他己军仍会合兵。' },
        reserves: { type: 'array', items: {
          type: 'object', properties: { tile: GENERALS_TILE_SCHEMA, armies: { type: 'integer', minimum: 1 } },
          required: ['tile', 'armies'], additionalProperties: false,
        }, description: '离开指定己方格时至少保留多少兵；王城默认保留当前驻军，可显式覆盖。只能全兵或半兵，不能任意指定出兵数。' },
      }, ['target', 'maxMoves'], (args) => {
        const state = this.activeMap();
        return { ...planGather(state, parseGatherOptions(state, args)), moveProgress: this.moveProgress() };
      }),
      tool('start_agent', 'Delegate one supported standard or City-State 1v1 or free-for-all game to the autonomous S1 agent. S1 chooses goals and plays without model replies. Joins the supplied room when currently unseated; forceStart explicitly requests a start vote after lobby admission. Existing move queues receive a clear request before autonomous control. Manual movement is blocked until stop_agent. Does not register usernames or start another game after a result.', ['act'], {
        room: { type: 'string', minLength: 1, description: '当前无房间时必填；有房间时只可填当前房间。' },
        forceStart: { type: 'boolean', default: false, description: 'true 表示入房确认后自动投本局开始票；省略时不投。' },
      }, [], (args) => this.startAgent(args)),
      tool('stop_agent', 'Revoke autonomous control and request clearing remaining server moves. Retains the game for manual play. A clear request does not confirm that the server queue is empty; actions already executed cannot be recalled.', ['act'], {}, [], () => {
        this.control = 'manual';
        this.controlEpoch++;
        this.intents.reset('stopped', 'manual_takeover');
        this.agentForceStart = false;
        this.resetAgent();
        const clearRequested = this.phase === 'playing' && this.client.connected;
        if (clearRequested) this.requestClear();
        this.reportAgent(true);
        return { ...this.agentStatus(), clearRequested };
      }),
      tool('agent_status', 'Read configured S1 backend and method, control, game id, control epoch, active intent, revision ledger, intent outcome, current decision and backend execution state, search cost, pending action and observed feedback. Predictions are separate from server processing and map changes. Use strategy_brief for a compressed strategic view.', ['read'], {}, [], () => this.agentStatus()),
      tool('strategy_brief', 'Read a compressed current strategic report: intent and revision anchors, constraint counts, public scores and dated changes, own cities, largest visible forces, general sightings, task, conditional estimates and last action feedback. Read agent_status for the complete intent before replacing constraints. No full map or search tree. Historical armies remain dated history. S1 keeps acting while S2 thinks.', ['read'], {}, [], () => this.strategyBrief()),
      tool('set_intent', 'Give autonomous S1 a versioned strategic goal, hard departure reserves and excluded route tiles, with optional preferences. Copy gameId/controlEpoch/turn and intent.lastRevision from a fresh strategy_brief. Set basedOnTurn to the observed turn and increase revision; expiresTurn is exclusive. Rejected requests preserve the active intent. Accepted changes apply to subsequent decisions; already sent actions cannot be recalled. Emergency tactics may preempt the goal within its hard constraints. Completion retains constraints until clear or expiry.', ['act'], STRATEGY_INTENT_PROPERTIES,
        ['gameId', 'controlEpoch', 'revision', 'basedOnTurn', 'expiresTurn', 'goal', 'constraints'], (args) => {
          const observation = this.intentObservation();
          if (this.operatorPaused) throw new Error('Operator paused strategy changes');
          try { this.intents.submit(args, observation); }
          finally { this.reportAgent(true); }
          return this.strategyBrief();
        }),
      tool('clear_intent', 'Remove the strategic goal and its hard constraints while S1 continues autonomous play. Requires the current gameId/controlEpoch and a revision strictly greater than intent.lastRevision, so a delayed clear cannot remove a newer plan. Does not stop S1 or clear server moves.', ['act'], STRATEGY_ANCHOR_PROPERTIES,
        ['gameId', 'controlEpoch', 'revision'], (args) => {
          const observation = this.intentObservation();
          try { this.intents.clear(args, observation); }
          finally { this.reportAgent(true); }
          return this.strategyBrief();
        }),
      tool('join_private', 'Send a request to join a Bot Server custom room.', ['act'], { room: { type: 'string', minLength: 1 } }, ['room'], (args) => {
        return this.joinRoom(args.room);
      }),
      tool('set_force_start', 'Set your force-start vote in the current custom room.', ['act'], { enabled: { type: 'boolean' } }, ['enabled'], (args) => {
        if (this.operatorPaused) throw new Error('Operator paused room actions');
        if (!this.room || this.state) throw new Error('A custom room lobby is required');
        if (typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean');
        this.client.send('set_force_start', this.room, args.enabled);
        return { sent: 'set_force_start', enabled: args.enabled };
      }),
      tool('attack', 'Append one adjacent move, or report it as skipped if either endpoint is a known mountain. sent=null means nothing sent. Use queue_moves for batches or move_path for a route. Receipts confirm sending only; queued sources may become owned later.', ['act'], {
        ...GENERALS_MOVE_SCHEMA.properties,
      }, ['from', 'to'], (args) => {
        const state = this.activeMap();
        const receipt = this.sendMoves([parseMove(args, state.width, state.height)]);
        return { sent: receipt.sent, ...receipt.moves[0], playerIndex: receipt.playerIndex, observedTurn: receipt.observedTurn, check: receipt.checks[0] ?? null, skipped: receipt.skipped, filteredRoutes: receipt.filteredRoutes, moveProgress: receipt.moveProgress };
      }),
      tool('queue_moves', 'Append adjacent moves in order after filtering known-mountain steps. Returns retained checks, skipped steps and filteredRoutes describing retained segments of affected original chains. Independent moves start separate chains; ranges use original step numbers. sent=null when all are skipped. Malformed or nonadjacent moves reject the whole request. Later moves are kept without replanning; sources may become owned later. Receipts do not confirm execution. Use clear_moves to cancel remaining moves.', ['act'], {
        moves: movesProperty,
      }, ['moves'], (args) => {
        const state = this.activeMap();
        return this.sendMoves(parseMoves(args.moves, state.width, state.height));
      }),
      tool('move_path', 'Append supplied route edges in order after filtering known-mountain steps. Reports skipped original step numbers and filteredRoutes with retained consecutive segments and endpoint coordinates. Later edges are kept even when the original route is interrupted; a later segment needs its own troops or incoming queued troops. No pathfinding or replanning. Malformed or nonadjacent edges reject the whole request. sent=null when nothing is sent; later maps show the outcome. Use clear_moves to cancel remaining moves.', ['act'], {
        path: {
          type: 'array', minItems: 2, items: GENERALS_TILE_SCHEMA,
          description: '起点及后续相邻格，例如 path:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]；也可用格子索引。',
        },
        half: {
          anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'boolean' }, minItems: 1 }], default: false,
          description: '布尔值应用到每步；数组逐步指定，长度须为 path.length - 1。false 全兵，true 半兵。',
        },
      }, ['path'], (args) => {
        const state = this.activeMap();
        return this.sendMoves(parsePath(args.path, args.half, state.width, state.height));
      }),
      tool('clear_moves', 'Request removal of all queued moves.', ['act'], {}, [], () => {
        if (this.phase !== 'playing') throw new Error('No active game');
        if (this.control === 'autonomous') throw new Error('S1 owns movement; use stop_agent before manual queue changes');
        this.requestClear();
        return { sent: 'clear_moves', moveProgress: this.moveProgress() };
      }),
      tool('leave', 'Leave the game and cancel the current lobby request.', ['act'], {}, [], () => {
        try {
          this.client.send('leave_game');
          this.client.send('cancel');
        } finally {
          this.reset('connected');
        }
        return { sent: ['leave_game', 'cancel'] };
      }),
      tool('set_username', 'Set an account username once. The Bot Server requires the [Bot] prefix and a unique name.', ['act'], { username: { type: 'string' } }, ['username'], (args) => {
        if (typeof args.username !== 'string' || !args.username.startsWith('[Bot]')) throw new Error('username must start with [Bot]');
        this.client.send('set_username', this.userId, args.username);
        return { sent: 'set_username', username: args.username };
      }),
    ];
  }

  private onEvent(name: string, args: unknown[]): void {
    try { this.applyEvent(name, args); }
    finally { this.viewer.publish(); }
  }

  private applyEvent(name: string, args: unknown[]): void {
    if (!this.host) return;
    if (name === 'game_start') {
      if (!this.room) return;
      const data = this.object(args[0]);
      if (!Number.isSafeInteger(data.playerIndex) || (data.playerIndex as number) < 0) throw new Error('Invalid playerIndex');
      this.state = new GeneralsState(data.playerIndex as number, data);
      this.gameId = randomUUID();
      this.strategyReportRevision++;
      this.controlEpoch++;
      this.intents.reset();
      this.observationRevision = 0;
      this.resetAgent();
      this.agentLastTurn = -1;
      this.agentError = null;
      this.lastDecision = null;
      this.lastFeedback = null;
      this.pendingAction = null;
      this.lobby = null;
      this.phase = 'playing';
      this.revision++;
      this.lastSnapshotAtMs = -Infinity;
      this.executor.reset();
      this.lastAfkWarning = null;
      this.scoreWarnAfk = false;
      this.emit('start', data);
    } else if (name === 'game_update') {
      if (this.phase !== 'playing' || !this.state) return;
      const data = this.object(args[0]);
      this.state.update(data);
      this.observationRevision++;
      if (this.state.turn >= 0) this.intents.refresh(this.agentObservation());
      this.executor.onUpdate(data.attackIndex);
      this.stepAgent();
      const score = this.state.ownScore();
      const warnAfk = score?.warn_afk === true;
      if (warnAfk !== this.scoreWarnAfk) {
        this.scoreWarnAfk = warnAfk;
        this.reportAfk({ event: 'game_update', warnAfk });
      }
      if (Date.now() - this.lastSnapshotAtMs < this.cfg.snapshotIntervalMs) return;
      this.lastSnapshotAtMs = Date.now();
      if (this.control === 'autonomous') {
        this.emit('state', this.mapView(true)!, false);
        return;
      }
      const revision = ++this.revision;
      this.host.pushDeferred({
        type: 'generals.state', senderKey: this.id, tags: ['snapshot'],
        render: () => revision === this.revision && this.phase === 'playing' && this.control === 'manual' && this.state ? JSON.stringify(this.mapView(true)) : null,
      }, { trigger: 'flush' });
    } else if (name === 'afk_warning') {
      this.reportAfk({ event: name, args });
    } else if (name === 'game_won' || name === 'game_lost') {
      this.phase = name === 'game_won' ? 'won' : 'lost';
      this.control = 'manual';
      this.controlEpoch++;
      this.intents.reset('stopped', this.phase);
      this.agentForceStart = false;
      this.pendingAction = null;
      this.resetAgent();
      this.revision++;
      this.emit('result', { outcome: this.phase, data: args[0] ?? null, view: this.mapView(false) });
      this.reportAgent(true);
    } else if (name === 'queue_update') {
      if (this.room) {
        this.lobby = this.object(args[0]);
        if (this.phase === 'join-requested') this.phase = 'lobby';
        this.voteForAgent();
      }
      this.emit('lobby', { event: name, args });
    } else if (name === 'queue_left') {
      if (this.phase === 'join-requested' || this.phase === 'lobby') this.reset('connected');
      this.emit('lobby', { event: name, args });
    } else if (name === 'error_set_username' && args[0] === '') {
      this.lastError = null;
      this.emit('account', { event: name, args });
    } else if (name === 'gio_error' || name.startsWith('error')) {
      this.lastError = { event: name, args };
      if (name === 'gio_error' && this.phase === 'join-requested') this.reset('connected');
      this.emit('error', { event: name, args });
    } else if (name === 'chat_message') {
      this.emit('chat', { event: name, args });
    }
  }

  private object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an event object');
    return value as Record<string, unknown>;
  }

  private observation(compact: boolean): Record<string, unknown> {
    return {
      phase: this.phase, room: this.room, connected: this.client.connected, lobby: this.lobby, lastError: this.lastError,
      afk: { warnAfk: this.scoreWarnAfk, lastWarning: this.lastAfkWarning, lastMove: this.executor.lastMove },
      agent: this.agentStatus(),
      moveProgress: this.moveProgress(), view: this.mapView(compact),
    };
  }

  private moveProgress() {
    return {
      lastSentAttackIndex: this.executor.lastMove?.attackIndex ?? null,
      serverAttackIndex: this.state?.serverAttackIndex ?? null,
      serverAttackIndexTurn: this.state?.serverAttackIndexTurn ?? null,
      lastClearRequest: this.executor.lastClearRequest,
    };
  }

  private mapView(compact: boolean): Record<string, unknown> | null {
    return this.state ? { ...(compact ? this.state.compactSnapshot() : this.state.snapshot()), moveProgress: this.moveProgress() } : null;
  }

  private activeMap(): GeneralsState {
    if (this.phase !== 'playing' || !this.state || this.state.turn < 0) throw new Error('No active map');
    return this.state;
  }

  private checkMoves(moves: Move[]) {
    const state = this.activeMap();
    const checks: MoveCheck[] = [];
    const skipped: Array<MoveCheck & { reason: 'known_mountain'; mountainEndpoints: Array<'from' | 'to'> }> = [];
    moves.forEach((move, i) => {
      const from = state.tile(move.from), to = state.tile(move.to);
      const mountainEndpoints = (['from', 'to'] as const).filter((end) => (end === 'from' ? from : to).terrain === -2);
      const check = { step: i + 1, from, to, half: move.half };
      if (mountainEndpoints.length) skipped.push({ ...check, reason: 'known_mountain', mountainEndpoints });
      else checks.push(check);
    });
    return { checks, skipped, filteredRoutes: describeFilteredRoutes(moves, skipped.map((check) => check.step), state.width) };
  }

  private sendMoves(moves: Move[], decision?: AgentDecision) {
    const state = this.activeMap();
    if (this.operatorPaused) throw new Error('Operator paused movement');
    if (this.control === 'autonomous' && !decision) throw new Error('S1 owns movement; use stop_agent before manual movement');
    if (decision && (this.control !== 'autonomous' || decision.controlEpoch !== this.controlEpoch
      || decision.gameId !== this.gameId || decision.basedOnRevision !== this.observationRevision)) throw new Error('Stale S1 decision');
    const intent = this.intents.snapshot().active;
    if (decision && intent) {
      const observation = this.agentObservation();
      for (const move of moves) {
        const violation = checkStrategyMove(observation, intent, move);
        if (violation) throw new Error(`S1 decision violates strategy: ${violation}`);
      }
    }
    const { checks, skipped, filteredRoutes } = this.checkMoves(moves);
    const sent = checks.map((check) => {
      const move = moves[check.step - 1];
      const attackIndex = this.executor.move(move, state.turn);
      return { ...move, step: check.step, attackIndex };
    });
    return { sent: sent.length ? 'attack' : null, moves: sent, playerIndex: state.playerIndex, observedTurn: state.turn, checks, skipped, filteredRoutes, moveProgress: this.moveProgress() };
  }

  private joinRoom(value: unknown) {
    if (this.operatorPaused) throw new Error('Operator paused room actions');
    if (typeof value !== 'string' || !value.trim()) throw new Error('room must be nonempty');
    if (this.room) throw new Error('Leave the current room first');
    const room = value.trim();
    this.client.send('join_private', room, this.userId);
    this.room = room;
    this.lastError = null;
    this.phase = 'join-requested';
    return { sent: 'join_private', room, url: `https://bot.generals.io/games/${encodeURIComponent(room)}` };
  }

  private startAgent(args: Record<string, unknown>) {
    if (this.operatorPaused) throw new Error('Operator paused S1');
    if (args.forceStart !== undefined && typeof args.forceStart !== 'boolean') throw new Error('forceStart must be boolean');
    if (args.room !== undefined && (typeof args.room !== 'string' || !args.room.trim())) throw new Error('room must be nonempty');
    if (this.phase === 'won' || this.phase === 'lost') throw new Error('Leave the completed game before starting another agent game');
    if (this.room && args.room !== undefined && (args.room as string).trim() !== this.room) throw new Error('Leave the current room before choosing another room');
    if (this.control === 'autonomous') return this.agentStatus();
    if (this.state) this.assertAgentRules();
    if (!this.room) this.joinRoom(args.room);
    this.controlEpoch++;
    this.control = 'autonomous';
    this.strategyReportsEnabled = true;
    this.intents.reset();
    this.agentForceStart = args.forceStart === true;
    this.agentVoted = false;
    this.agentError = null;
    this.resetAgent();
    this.agentLastTurn = this.state?.turn ?? -1;
    this.lastDecision = null;
    if (this.phase === 'playing') this.requestClear();
    this.voteForAgent();
    this.reportAgent(true);
    return this.agentStatus();
  }

  private voteForAgent(): void {
    if (this.control !== 'autonomous' || this.operatorPaused || !this.agentForceStart || this.agentVoted
      || this.phase !== 'lobby' || !this.room) return;
    this.client.send('set_force_start', this.room, true);
    this.agentVoted = true;
  }

  private assertAgentRules(): void {
    const state = this.state!;
    createSimulationBoard(state);
    const metadataCounts = ['usernames', 'playerColors', 'teams'].map((key) => Array.isArray(state.start[key]) ? (state.start[key] as unknown[]).length : 0);
    const view = state.turn >= 0 ? state.snapshot() : null;
    const scores = view?.scores as Array<{ i?: number }> | undefined;
    const playerCount = Math.max(...metadataCounts, scores?.length ?? 0,
      Array.isArray(view?.generals) ? view.generals.length : 0, state.playerIndex + 1);
    if (playerCount < 2) throw new Error('S1 requires a confirmed multiplayer game');
    const teams = Array.isArray(state.start.teams) ? state.start.teams : [];
    const assignedTeams = teams.filter((team) => team != null && (typeof team !== 'number' || team >= 0));
    if (new Set(assignedTeams).size !== assignedTeams.length) throw new Error('S1 does not support allied transfers');
    for (let index = 0; index < state.width * state.height; index++) {
      const tile = state.tile(index);
      if (tile.tunnelLimit !== null && tile.tunnelLimit !== 0) throw new Error('S1 does not support tunnels');
      if (this.cityHalf && tile.terrain < -4) throw new Error('city-half-1 does not support special terrain');
    }
  }

  private requestClear(): void {
    this.executor.clear(this.state?.turn ?? null);
    if (this.pendingAction) {
      this.recordFeedback({ action: this.pendingAction.action, observedTurn: this.state?.turn ?? -1, outcome: 'cancel_requested' });
      this.pendingAction = null;
    }
  }

  private recordFeedback(feedback: AgentFeedback): void {
    this.lastFeedback = feedback;
    void this.host?.pushEvent({
      type: 'generals.feedback', source: this.id, senderKey: this.id, ts: nowIso(this.timezone),
      text: JSON.stringify(feedback), meta: { ...feedback },
    }, { deliver: false }).catch((error) => this.host?.log.warn('Generals feedback archive failed', { error: String(error) }));
  }

  private agentObservation(): AgentObservation {
    const state = this.state!;
    const view = state.snapshot();
    return {
      gameId: this.gameId!, revision: this.observationRevision, controlEpoch: this.controlEpoch,
      playerIndex: state.playerIndex, turn: state.turn, width: state.width, height: state.height,
      tiles: Array.from({ length: state.width * state.height }, (_, index) => state.tile(index)),
      history: Array.from({ length: state.width * state.height }, (_, index) => state.lastSeen(index)),
      generals: view.generals as number[], cities: view.cities as number[], scores: view.scores as unknown[],
      playerLifecycle: state.playerLifecycle(),
    };
  }

  private intentObservation(): AgentObservation {
    this.activeMap();
    if (this.control !== 'autonomous') throw new Error('S1 autonomous control is required for strategic intents');
    return this.agentObservation();
  }

  private stepAgent(): void {
    const state = this.state;
    if (this.control !== 'autonomous' || this.operatorPaused || !state || this.phase !== 'playing'
      || this.cityStep || state.turn <= this.agentLastTurn) return;
    this.agentLastTurn = state.turn;
    try {
      this.assertAgentRules();
      if (this.pendingAction) {
        const pending = this.pendingAction;
        const source = state.tile(pending.action.from), target = state.tile(pending.action.to);
        const processed = state.serverAttackIndex !== null && state.serverAttackIndex >= pending.action.attackIndex;
        const changed = source.owner !== state.playerIndex || source.armies !== pending.sourceArmies
          || target.owner !== pending.targetOwner || target.armies !== pending.targetArmies;
        if (!processed && !changed && state.turn - pending.action.observedTurn < 3) { this.reportAgent(); return; }
        const outcome = processed ? 'server_processed' : changed ? 'map_changed' : 'unconfirmed_timeout';
        this.recordFeedback({ action: pending.action, observedTurn: state.turn, outcome });
        this.pendingAction = null;
        if (outcome !== 'server_processed') {
          this.executor.clear(state.turn);
          this.reportAgent();
          return;
        }
      }
      const intent = this.intents.snapshot();
      if (this.cityHalf) {
        const observation = this.agentObservation(), backend = this.cityHalf;
        const isCurrentControl = () => this.control === 'autonomous' && !this.operatorPaused && this.phase === 'playing'
          && this.gameId === observation.gameId && this.controlEpoch === observation.controlEpoch;
        const pending = backend.decide(observation, intent).then(({ decision, feedback }) => {
          if (!isCurrentControl()) return;
          // Every move still has to match the current map and S2 revision at submission.
          if (this.observationRevision !== observation.revision || this.intents.snapshot().lastRevision !== intent.lastRevision) return;
          this.intents.feedback(feedback);
          this.acceptAgentDecision(decision);
        }).catch((error) => { if (isCurrentControl()) this.failAgent(error); }).finally(() => {
          if (this.cityStep !== pending) return;
          this.cityStep = null;
          this.viewer.publish();
          this.stepAgent();
        });
        this.cityStep = pending;
        return;
      }
      const decision = this.agent.decide(this.agentObservation(), intent.active, intent.status === 'completed');
      this.intents.feedback(this.agent.getStrategyFeedback());
      this.acceptAgentDecision(decision);
    } catch (error) { this.failAgent(error); }
  }

  private acceptAgentDecision(decision: AgentDecision): void {
    const state = this.state!;
    this.lastDecision = decision;
    this.lastDecisionIntentRevision = this.intents.snapshot().lastRevision;
    if (decision.kind === 'move') {
      const move = parseMove(decision.move, state.width, state.height);
      const source = state.tile(move.from), target = state.tile(move.to);
      if (source.owner !== state.playerIndex || source.armies === null || source.armies < 2
        || target.terrain === -2 || state.lastSeen(move.to)?.terrain === -2) throw new Error('S1 decision violates current ownership, movable armies or known terrain');
      const receipt = this.sendMoves([move], decision);
      const attackIndex = receipt.moves[0]?.attackIndex;
      if (attackIndex !== undefined) {
        const action: AgentAction = {
          actionId: `${this.gameId}:${this.controlEpoch}:${attackIndex}`, gameId: this.gameId!,
          controlEpoch: this.controlEpoch, observedTurn: state.turn, attackIndex, ...move,
        };
        this.pendingAction = { action, sourceArmies: source.armies, targetArmies: target.armies, targetOwner: target.owner };
        void this.host?.pushEvent({
          type: 'generals.action', source: this.id, senderKey: this.id, ts: nowIso(this.timezone),
          text: JSON.stringify({ action, decision }), meta: { action, decision },
        }, { deliver: false }).catch((error) => this.host?.log.warn('Generals action archive failed', { error: String(error) }));
      }
    }
    this.reportAgent();
  }

  private failAgent(error: unknown): void {
    this.agentError = String(error);
    this.control = 'manual';
    this.controlEpoch++;
    this.intents.reset('stopped', 'agent_error');
    this.resetAgent();
    this.requestClear();
    this.reportAgent(true);
  }

  private resetAgent(): void {
    this.agent.reset();
    this.cityHalf?.reset();
    this.cityStep = null;
  }

  private agentStatus(): AgentReport {
    let lastDecision = this.lastDecision;
    if (lastDecision?.kind === 'move') {
      const { plan: _plan, ...decision } = lastDecision;
      lastDecision = decision;
    }
    return {
      gameId: this.gameId, controlEpoch: this.controlEpoch, control: this.control,
      operatorPaused: this.operatorPaused, operatorPauseLinked: this.operatorPauseLinked,
      phase: this.phase, observedTurn: this.state?.turn ?? null,
      backend: this.cfg.agent.backend, method: this.cityHalf ? 'harris_city_half' : 'bounded_rule_search',
      activeIntentRevision: this.intents.snapshot().active?.revision ?? null,
      intent: this.intents.snapshot(),
      supportedRules: 'standard_or_city_state_ffa', error: this.agentError,
      lastDecision, pendingAction: this.pendingAction?.action ?? null,
      lastFeedback: this.lastFeedback,
    };
  }

  private reportAgent(force = false): void {
    if (!this.host) return;
    if (!this.strategyReportsEnabled) {
      this.emit('agent', { ...this.agentStatus() }, false);
      return;
    }
    const brief = this.strategyBrief();
    const change = significantStrategyChange(this.lastQueuedBrief, brief);
    if (!force && !change && Date.now() - this.lastAgentReportAtMs < this.cfg.agent.reportIntervalMs) return;
    this.lastAgentReportAtMs = Date.now();
    this.lastQueuedBrief = brief;
    this.emit('agent', { ...this.agentStatus() }, false);
    const revision = ++this.strategyReportRevision;
    this.host.pushDeferred({
      type: 'generals.strategy', senderKey: this.id, tags: ['snapshot'],
      render: () => {
        if (revision !== this.strategyReportRevision || !this.host) return null;
        const current = this.strategyBrief();
        this.lastRenderedBrief = current;
        return JSON.stringify(current);
      },
    }, { trigger: 'flush' });
  }

  private strategyBrief(): StrategyBrief {
    return createStrategyBrief(this.state && this.state.turn >= 0 ? this.agentObservation() : null,
      this.agentStatus(), this.lastRenderedBrief);
  }

  private reportAfk(data: Record<string, unknown>): void {
    const warning = { ...data, observedTurn: this.state?.turn ?? null, score: this.state?.ownScore() ?? null, lastMove: this.executor.lastMove };
    if (data.warnAfk !== false) this.lastAfkWarning = warning;
    this.emit('afk', warning);
  }

  private reset(phase: string): void {
    this.phase = phase;
    this.room = null;
    this.lobby = null;
    this.state = null;
    this.gameId = null;
    this.control = 'manual';
    this.controlEpoch++;
    this.intents.reset('stopped', phase);
    this.agentForceStart = false;
    this.agentVoted = false;
    this.agentError = null;
    this.resetAgent();
    this.agentLastTurn = -1;
    this.lastDecision = null;
    this.lastFeedback = null;
    this.pendingAction = null;
    this.revision++;
    this.lastSnapshotAtMs = -Infinity;
    this.executor.reset();
    this.lastAfkWarning = null;
    this.scoreWarnAfk = false;
    this.reportAgent(true);
    this.strategyReportsEnabled = false;
    this.viewer.publish();
  }

  private viewerSnapshot(): GeneralsViewerSnapshot {
    const state = this.state;
    const tiles = state ? Array.from({ length: state.width * state.height }, (_, index) => state.tile(index)) : [];
    const names = Array.isArray(state?.start.usernames) ? state.start.usernames : [];
    const colors = Array.isArray(state?.start.playerColors) ? state.start.playerColors : [];
    const scores = (state?.snapshot().scores as unknown[] | undefined ?? [])
      .filter((score): score is Record<string, unknown> => score !== null && typeof score === 'object' && !Array.isArray(score));
    const playerCount = state ? Math.max(names.length, colors.length, state.playerIndex + 1,
      tiles.reduce((count, tile) => Math.max(count, (tile.owner ?? -1) + 1), 0),
      ...scores.map((score) => typeof score.i === 'number' ? score.i + 1 : 0)) : 0;
    const active = this.phase === 'playing' && this.client.connected && !this.operatorPaused;
    const display = this.executor.display();
    const decision = this.lastDecision;
    const plan = active && this.control === 'autonomous' && this.pendingAction && decision?.kind === 'move'
      && decision.gameId === this.gameId && decision.controlEpoch === this.controlEpoch
      && decision.basedOnRevision === this.observationRevision && decision.observedTurn === state?.turn
      && this.lastDecisionIntentRevision === this.intents.snapshot().lastRevision
      && this.pendingAction.action.observedTurn === decision.observedTurn ? decision.plan ?? null : null;
    const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      phase: this.phase, connected: this.client.connected, control: this.control, paused: this.operatorPaused,
      turn: state && state.turn >= 0 ? state.turn : null, playerIndex: state?.playerIndex ?? null,
      board: state && state.width > 0 ? { width: state.width, height: state.height, tiles } : null,
      players: Array.from({ length: playerCount }, (_, index) => {
        const score = scores.find((entry) => entry.i === index);
        return { index, name: typeof names[index] === 'string' ? names[index] : `p${index}`,
          color: number(colors[index]), total: number(score?.total), tiles: number(score?.tiles), dead: score?.dead === true };
      }),
      selected: active ? display.selected : null,
      queuedMoves: active ? display.moves : [],
      plan: plan ? structuredClone(plan) : null,
    };
  }

  private emit(noun: string, data: Record<string, unknown>, deliver = true): void {
    const host = this.host;
    if (!host) return;
    void host.pushEvent({ type: `generals.${noun}`, source: this.id, senderKey: this.id, ts: nowIso(this.timezone), text: JSON.stringify(data), meta: data }, deliver ? { trigger: 'flush' } : { deliver: false })
      .catch((error) => host.log.warn('Generals event delivery failed', { error: String(error) }));
  }
}
