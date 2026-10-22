import type { AgentObservation, StrategyGoal, StrategyIntent, StrategyIntentState, StrategyIntentStatus } from './agent/contracts.ts';
import { resolvePlayerLifecycles } from './agent/lifecycle.ts';

export const STRATEGY_INTENT_LIMITS = { reserves: 32, avoidTiles: 64, rationale: 512 };
const coordinateSchema = {
  type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 } },
  required: ['x', 'y'], additionalProperties: false,
};
export const STRATEGY_ANCHOR_PROPERTIES = {
  gameId: { type: 'string', minLength: 1, description: '从最新 strategy_brief 或 agent_status 复制的本地对局标识。' },
  controlEpoch: { type: 'integer', minimum: 0, description: '从最新报告复制；暂停或控制权切换后会改变。' },
  revision: { type: 'integer', minimum: 1, description: '本对局和控制版本内严格大于 intent.lastRevision；清除意图也消耗修订号。' },
};
export const STRATEGY_INTENT_PROPERTIES = {
  ...STRATEGY_ANCHOR_PROPERTIES,
  basedOnTurn: { type: 'integer', minimum: 0, description: '形成意图所依据的实际观测 turn，不可写未来 turn。' },
  expiresTurn: { type: 'integer', minimum: 1, description: '排他上界：到达此 turn 即失效，S1恢复自主目标。' },
  goal: { anyOf: [
    { type: 'object', properties: { kind: { type: 'string', enum: ['auto', 'expand'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', enum: ['capture_city', 'gather', 'defend', 'scout'] }, target: coordinateSchema },
      required: ['kind', 'target'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', enum: ['attack_general'] }, player: { type: 'integer', minimum: 0 } },
      required: ['kind', 'player'], additionalProperties: false },
  ], description: '目标由S1核对当前事实、选择路径；完成目标后约束保留至清除或到期。' },
  constraints: { type: 'object', properties: {
    reserves: { type: 'array', maxItems: STRATEGY_INTENT_LIMITS.reserves, items: {
      type: 'object', properties: { tile: coordinateSchema, armies: { type: 'integer', minimum: 0 } },
      required: ['tile', 'armies'], additionalProperties: false,
    }, description: '指定格出兵后至少留下的兵量；不是立即补足要求。提交时格子必须当前归己方。' },
    avoidTiles: { type: 'array', maxItems: STRATEGY_INTENT_LIMITS.avoidTiles, items: coordinateSchema,
      description: '路线不得使用的格子，包含起点；紧急防守也不静默违反。' },
  }, additionalProperties: false },
  preferences: { type: 'object', properties: {
    emphasis: { type: 'string', enum: ['balanced', 'economy', 'pressure', 'information'] },
    risk: { type: 'string', enum: ['low', 'normal', 'high'] },
  }, required: ['emphasis', 'risk'], additionalProperties: false },
  rationale: { type: 'string', maxLength: STRATEGY_INTENT_LIMITS.rationale, description: '简短依据，仅记录解释，不作为代码或动作执行。' },
};

/** Owns revisions and validity at the tool boundary. A rejection leaves the active intent intact. */
export class IntentController {
  private state: StrategyIntentState = this.empty('autonomous', null);

  snapshot(): StrategyIntentState { return structuredClone(this.state); }

  reset(status: StrategyIntentStatus = 'autonomous', reason: string | null = null): void {
    this.state = this.empty(status, reason);
  }

  submit(args: Record<string, unknown>, observation: AgentObservation): StrategyIntent {
    try {
      const intent = parseIntent(args, observation);
      this.assertAnchor(intent, observation);
      if (intent.basedOnTurn > observation.turn) throw new Error('intent_future_observation');
      if (intent.expiresTurn <= observation.turn || intent.expiresTurn <= intent.basedOnTurn) throw new Error('intent_expired');
      this.state = { active: intent, status: 'following', reason: 'awaiting_next_observation',
        lastRevision: intent.revision, lastRejection: null };
      this.refresh(observation);
      return structuredClone(intent);
    } catch (error) {
      this.reject(args, observation, error);
      throw error;
    }
  }

  clear(args: Record<string, unknown>, observation: AgentObservation): void {
    try {
      fields(args, ['gameId', 'controlEpoch', 'revision']);
      const anchor = parseAnchor(args);
      this.assertAnchor(anchor, observation);
      this.state = { active: null, status: 'cancelled', reason: 'cleared_by_s2',
        lastRevision: anchor.revision, lastRejection: null };
    } catch (error) {
      this.reject(args, observation, error);
      throw error;
    }
  }

  refresh(observation: AgentObservation): void {
    const intent = this.state.active;
    if (!intent) return;
    const finish = (status: 'expired' | 'invalidated', reason: string) => {
      this.state = { ...this.state, active: null, status, reason };
    };
    if (intent.gameId !== observation.gameId || intent.controlEpoch !== observation.controlEpoch) {
      finish('invalidated', 'intent_context_changed'); return;
    }
    if (observation.turn >= intent.expiresTurn) { finish('expired', 'intent_expired'); return; }
    if (this.state.status === 'completed') return;
    const goal = intent.goal;
    if ('target' in goal) {
      const tile = observation.tiles[goal.target.y * observation.width + goal.target.x];
      if (tile.terrain === -2) { finish('invalidated', 'intent_target_became_wall'); return; }
      if ((goal.kind === 'gather' || goal.kind === 'defend') && tile.owner !== observation.playerIndex) {
        finish('invalidated', 'intent_target_no_longer_owned'); return;
      }
      if (goal.kind === 'capture_city' && tile.visible && tile.city !== true) {
        finish('invalidated', 'intent_target_no_longer_city'); return;
      }
      if (goal.kind === 'scout' && tile.visible
        || goal.kind === 'capture_city' && tile.owner === observation.playerIndex) {
        this.state.status = 'completed'; this.state.reason = 'goal_observed_complete';
      }
    }
  }

  feedback(value: { revision: number; status: 'following' | 'preempted' | 'blocked' | 'completed'; reason: string } | null): void {
    if (!value || value.revision !== this.state.active?.revision || this.state.status === 'completed') return;
    this.state.status = value.status;
    this.state.reason = value.reason;
  }

  private empty(status: StrategyIntentStatus, reason: string | null): StrategyIntentState {
    return { active: null, status, reason, lastRevision: 0, lastRejection: null };
  }

  private assertAnchor(anchor: ReturnType<typeof parseAnchor>, observation: AgentObservation): void {
    if (anchor.gameId !== observation.gameId) throw new Error('intent_wrong_game');
    if (anchor.controlEpoch !== observation.controlEpoch) throw new Error('intent_wrong_control_epoch');
    if (anchor.revision <= this.state.lastRevision) throw new Error('intent_stale_revision');
  }

  private reject(args: Record<string, unknown>, observation: AgentObservation, error: unknown): void {
    this.state.lastRejection = { revision: Number.isSafeInteger(args.revision) ? args.revision as number : null,
      reason: error instanceof Error ? error.message : String(error), atTurn: observation.turn };
  }
}

function parseIntent(args: Record<string, unknown>, observation: AgentObservation): StrategyIntent {
  fields(args, Object.keys(STRATEGY_INTENT_PROPERTIES));
  const anchor = parseAnchor(args);
  const basedOnTurn = integer(args.basedOnTurn, 'basedOnTurn'), expiresTurn = integer(args.expiresTurn, 'expiresTurn', 1);
  const rawGoal = object(args.goal, 'goal');
  let goal: StrategyGoal;
  if (rawGoal.kind === 'auto' || rawGoal.kind === 'expand') {
    fields(rawGoal, ['kind']); goal = { kind: rawGoal.kind };
  } else if (rawGoal.kind === 'attack_general') {
    fields(rawGoal, ['kind', 'player']);
    const player = integer(rawGoal.player, 'goal.player');
    if (player === observation.playerIndex || !resolvePlayerLifecycles(observation)
      .some((entry) => entry.player === player && entry.status !== 'eliminated')) throw new Error('intent_target_player_must_be_opponent');
    goal = { kind: 'attack_general', player };
  } else if (['capture_city', 'gather', 'defend', 'scout'].includes(String(rawGoal.kind))) {
    fields(rawGoal, ['kind', 'target']);
    const target = coordinate(rawGoal.target, observation);
    const tile = observation.tiles[target.y * observation.width + target.x];
    if (tile.terrain === -2 || observation.history[tile.index]?.terrain === -2) throw new Error('intent_target_known_wall');
    if ((rawGoal.kind === 'gather' || rawGoal.kind === 'defend') && tile.owner !== observation.playerIndex) {
      throw new Error('intent_target_must_be_owned');
    }
    if (rawGoal.kind === 'capture_city' && !(tile.visible ? tile.city : observation.history[tile.index]?.city)) {
      throw new Error('intent_target_not_known_city');
    }
    goal = { kind: rawGoal.kind as 'capture_city' | 'gather' | 'defend' | 'scout', target };
  } else throw new Error('intent_unknown_goal');
  const rawConstraints = object(args.constraints, 'constraints');
  fields(rawConstraints, ['reserves', 'avoidTiles']);
  const constraints: StrategyIntent['constraints'] = {};
  if (rawConstraints.reserves !== undefined) {
    const seen = new Set<number>();
    constraints.reserves = list(rawConstraints.reserves, STRATEGY_INTENT_LIMITS.reserves, 'reserves').map((value) => {
      const entry = object(value, 'reserve'); fields(entry, ['tile', 'armies']);
      const tile = coordinate(entry.tile, observation), index = tile.y * observation.width + tile.x;
      if (seen.has(index)) throw new Error('intent_duplicate_reserve');
      if (observation.tiles[index].owner !== observation.playerIndex) throw new Error('intent_reserve_must_be_owned');
      seen.add(index);
      return { tile, armies: integer(entry.armies, 'reserve.armies') };
    });
  }
  if (rawConstraints.avoidTiles !== undefined) {
    const seen = new Set<number>();
    constraints.avoidTiles = list(rawConstraints.avoidTiles, STRATEGY_INTENT_LIMITS.avoidTiles, 'avoidTiles').map((value) => {
      const tile = coordinate(value, observation), index = tile.y * observation.width + tile.x;
      if (seen.has(index)) throw new Error('intent_duplicate_avoid_tile');
      seen.add(index); return tile;
    });
  }
  let preferences: StrategyIntent['preferences'];
  if (args.preferences !== undefined) {
    const value = object(args.preferences, 'preferences'); fields(value, ['emphasis', 'risk']);
    if (!['balanced', 'economy', 'pressure', 'information'].includes(String(value.emphasis))
      || !['low', 'normal', 'high'].includes(String(value.risk))) throw new Error('intent_invalid_preferences');
    preferences = value as unknown as NonNullable<StrategyIntent['preferences']>;
  }
  if (args.rationale !== undefined && (typeof args.rationale !== 'string' || args.rationale.length > STRATEGY_INTENT_LIMITS.rationale)) {
    throw new Error('intent_invalid_rationale');
  }
  return { ...anchor, basedOnTurn, expiresTurn, goal, constraints,
    ...(preferences ? { preferences: { ...preferences } } : {}), ...(args.rationale === undefined ? {} : { rationale: args.rationale as string }) };
}

function parseAnchor(value: Record<string, unknown>) {
  if (typeof value.gameId !== 'string' || !value.gameId) throw new Error('intent_game_id_required');
  return { gameId: value.gameId, controlEpoch: integer(value.controlEpoch, 'controlEpoch'), revision: integer(value.revision, 'revision', 1) };
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`intent_invalid_${label}`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`intent_invalid_${label}`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('intent_unknown_field');
}
function coordinate(value: unknown, observation: AgentObservation) {
  const tile = object(value, 'coordinate'); fields(tile, ['x', 'y']);
  const x = integer(tile.x, 'coordinate.x'), y = integer(tile.y, 'coordinate.y');
  if (x >= observation.width || y >= observation.height) throw new Error('intent_coordinate_out_of_bounds');
  return { x, y };
}
function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`intent_invalid_${label}`);
  return value;
}
