import type { AgentDecision, AgentObservation, AgentTaskKind, StrategyIntent } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import type { Route, SearchBudget } from './search.ts';
import type { TaskCandidate } from './tasks.ts';
import { knownGeneralIndex, playerLifecycle } from './lifecycle.ts';

export interface StrategyFeedback {
  revision: number;
  status: 'following' | 'preempted' | 'blocked' | 'completed';
  reason: string;
}

export function activeStrategyIntent(observation: AgentObservation, intent?: StrategyIntent | null): StrategyIntent | null {
  return intent && intent.gameId === observation.gameId && intent.controlEpoch === observation.controlEpoch
    && intent.basedOnTurn <= observation.turn && intent.expiresTurn > observation.turn ? intent : null;
}

export function strategyTarget(observation: AgentObservation, intent: StrategyIntent): number | null {
  if ('target' in intent.goal) return intent.goal.target.y * observation.width + intent.goal.target.x;
  if (intent.goal.kind !== 'attack_general') return null;
  return knownGeneralIndex(observation, intent.goal.player);
}

export function strategyReserve(observation: AgentObservation, intent: StrategyIntent | null, index: number): number {
  return Math.max(1, ...(intent?.constraints.reserves ?? []).filter((reserve) =>
    reserve.tile.y * observation.width + reserve.tile.x === index).map((reserve) => reserve.armies));
}

export function strategyGatherTarget(observation: AgentObservation, intent: StrategyIntent): number | null {
  return activeStrategyIntent(observation, intent)?.goal.kind === 'gather'
    && strategyGoalState(observation, intent).status === 'active' ? strategyTarget(observation, intent) : null;
}

/** Ordinary plans retain the gathering garrison, including withdrawals on later legs. */
export function checkStrategyTask(observation: AgentObservation, intent: StrategyIntent,
  kind: AgentTaskKind, routes: readonly Pick<Route, 'path'>[], completed = false): string | null {
  const target = completed ? null : strategyGatherTarget(observation, intent);
  if (target === null || kind === 'defend' || kind === 'intercept'
    || kind === 'capture_general' && routes.length === 1 && routes[0].path.length === 2) return null;
  return routes.some((route) => route.path.slice(0, -1).includes(target)) ? 'strategy_gather_target_held' : null;
}

export function checkStrategyMove(observation: AgentObservation, intent: StrategyIntent,
  move: { from: number; to: number; half: boolean }): string | null {
  const avoided = new Set((intent.constraints.avoidTiles ?? []).map((tile) => tile.y * observation.width + tile.x));
  if (avoided.has(move.from) || avoided.has(move.to)) return 'strategy_avoid_tile';
  const source = observation.tiles[move.from];
  if (source.owner !== observation.playerIndex || source.armies === null) return 'strategy_source_not_currently_owned';
  const sent = move.half ? Math.floor(source.armies / 2) : source.armies - 1;
  if (source.armies - sent < strategyReserve(observation, intent, move.from)) return 'strategy_reserve';
  return null;
}

/** Every leg shares the same copied board; intermediate withdrawals and growth affect later reserves. */
export function checkStrategyRoutes(observation: AgentObservation, intent: StrategyIntent, routes: readonly Route[]): string | null {
  if (!intent.constraints.avoidTiles?.length && !intent.constraints.reserves?.length) return null;
  const avoided = new Set((intent.constraints.avoidTiles ?? []).map((tile) => tile.y * observation.width + tile.x));
  if (routes.some((route) => route.path.some((index) => avoided.has(index)))) return 'strategy_avoid_tile';
  const reserves = new Set((intent.constraints.reserves ?? []).map((reserve) => reserve.tile.y * observation.width + reserve.tile.x));
  if (!routes.some((route) => route.path.slice(0, -1).some((index) => reserves.has(index)))) return null;
  const current = { ...observation, tiles: observation.tiles.map((tile) => ({ ...tile })) };
  for (const route of routes) for (let step = 1; step < route.path.length; step++) {
    const move = { from: route.path[step - 1], to: route.path[step], half: step === 1 && route.half };
    const rejected = checkStrategyMove(current, intent, move);
    if (rejected) return rejected;
    const source = current.tiles[move.from], target = current.tiles[move.to];
    const sent = move.half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    source.armies! -= sent;
    if (target.armies === null) {
      if (step !== route.path.length - 1 || route !== routes.at(-1)) return 'strategy_unknown_intermediate';
    } else if (target.owner === current.playerIndex) target.armies += sent;
    else if (sent > target.armies) { target.armies = sent - target.armies; target.owner = current.playerIndex; }
    else return 'strategy_route_not_capturable';
    const nextTurn = current.turn + 1;
    for (const tile of current.tiles) if (tile.owner !== null && tile.armies !== null) tile.armies += production(tile, current.turn, nextTurn);
    current.turn = nextTurn;
  }
  return null;
}

export function strategyGoalState(observation: AgentObservation, intent: StrategyIntent): { status: 'active' | 'blocked' | 'completed'; reason: string } {
  const target = strategyTarget(observation, intent), tile = target === null ? null : observation.tiles[target];
  if (intent.goal.kind === 'attack_general') {
    const lifecycle = playerLifecycle(observation, intent.goal.player);
    if (lifecycle.status === 'eliminated') return { status: 'completed', reason: `target_player_eliminated_${lifecycle.basis}` };
    return target === null ? { status: 'blocked', reason: 'target_general_location_unknown' } : { status: 'active', reason: 'target_general_known' };
  }
  if (intent.goal.kind === 'capture_city') {
    if (tile?.city && tile.owner === observation.playerIndex) return { status: 'completed', reason: 'target_city_observed_owned' };
    if (tile?.visible && !tile.city) return { status: 'blocked', reason: 'target_is_not_a_current_city' };
  }
  if (intent.goal.kind === 'scout' && target !== null && (tile?.visible
    || (observation.history[target]?.lastSeenTurn ?? -1) >= intent.basedOnTurn)) return { status: 'completed', reason: 'target_observed_since_intent' };
  if ((intent.goal.kind === 'gather' || intent.goal.kind === 'defend') && tile?.owner !== observation.playerIndex) {
    return { status: 'blocked', reason: 'target_not_currently_owned' };
  }
  if (target !== null && intent.constraints.avoidTiles?.some((point) => point.y * observation.width + point.x === target)) {
    return { status: 'blocked', reason: 'target_is_avoided' };
  }
  return { status: 'active', reason: 'goal_active' };
}

export function strategyCandidates(observation: AgentObservation, intent: StrategyIntent, routes: Route[], budget: SearchBudget): TaskCandidate[] {
  if (strategyGoalState(observation, intent).status !== 'active') return [];
  const target = strategyTarget(observation, intent);
  if (target === null) return [];
  const distance = observation.tiles[target].visible ? null : strategyDistances(observation, intent, target);
  const candidates: TaskCandidate[] = [];
  for (const route of routes) {
    if (!budget.timeAvailable()) break;
    if (route.target !== target && !(distance && distance[route.target] < distance[route.source])) continue;
    if ((intent.goal.kind === 'gather' || intent.goal.kind === 'defend')
      && !route.path.every((index) => observation.tiles[index].owner === observation.playerIndex)) continue;
    if (checkStrategyRoutes(observation, intent, [route])) continue;
    candidates.push({
      route, kind: intent.goal.kind === 'gather' || intent.goal.kind === 'defend' ? 'gather'
        : intent.goal.kind === 'attack_general' && route.target === target && !route.unknown ? 'capture_general'
          : intent.goal.kind === 'capture_city' && route.target === target && !route.unknown ? 'capture_city' : 'scout',
      score: 600 + 30 / (route.path.length - 1) - (distance?.[route.target] ?? 0) * 2,
      reason: `strategy_goal:${intent.revision}:${intent.goal.kind}${route.target === target ? '' : ';approach_unknown_target'}`,
    });
  }
  return candidates;
}

export function scoreStrategyCandidate(observation: AgentObservation, intent: StrategyIntent, candidate: TaskCandidate, completed = false): void {
  const state = completed ? { status: 'completed' as const } : strategyGoalState(observation, intent);
  const target = strategyTarget(observation, intent);
  const directGoal = state.status === 'active' && (intent.goal.kind === 'expand' && candidate.kind === 'expand'
    || target !== null && candidate.route.target === target);
  const emergency = candidate.kind === 'defend' || candidate.kind === 'intercept'
    || candidate.kind === 'capture_general' && candidate.route.path.length === 2;
  if (directGoal) {
    candidate.reason += `;strategy_goal:${intent.revision}:${intent.goal.kind}`;
    if (!emergency) candidate.score = Math.min(800, Math.max(100, candidate.score) + 400);
  }
  if (emergency) return;
  if (!directGoal && state.status === 'active' && intent.goal.kind !== 'auto') candidate.score = Math.min(candidate.score, 350);
  const emphasis = intent.preferences?.emphasis;
  if (emphasis === 'economy' && candidate.kind === 'capture_city'
    || emphasis === 'pressure' && (candidate.kind === 'capture_general' || observation.tiles[candidate.route.target].owner !== null
      && observation.tiles[candidate.route.target].owner !== observation.playerIndex)
    || emphasis === 'information' && candidate.kind === 'scout') candidate.score += 15;
  if (intent.preferences?.risk === 'low' && candidate.route.unknown) candidate.score -= 12;
  if (intent.preferences?.risk === 'high' && candidate.route.unknown) candidate.score += 5;
}

export function strategyFeedback(observation: AgentObservation, intent: StrategyIntent, decision: AgentDecision): StrategyFeedback {
  const state = strategyGoalState(observation, intent);
  if (state.status !== 'active') return { revision: intent.revision, status: state.status, reason: state.reason };
  const target = strategyTarget(observation, intent);
  const pursuingTarget = target !== null && decision.task.target === target && (
    intent.goal.kind === 'gather' && decision.task.kind === 'gather'
    || intent.goal.kind === 'defend' && (decision.task.kind === 'gather' || decision.task.kind === 'defend')
    || intent.goal.kind === 'capture_city' && decision.task.kind === 'capture_city'
    || intent.goal.kind === 'attack_general' && decision.task.kind === 'capture_general'
    || intent.goal.kind === 'scout' && decision.task.kind === 'scout');
  if (intent.goal.kind === 'auto' || pursuingTarget || decision.reason.includes(`strategy_goal:${intent.revision}:`)) {
    return { revision: intent.revision, status: 'following', reason: decision.kind === 'move' ? 'goal_candidate_selected' : 'autonomous_wait_with_constraints' };
  }
  if (decision.kind === 'wait' && decision.reason.startsWith('strategy_gather_target_held')) {
    return { revision: intent.revision, status: 'following', reason: 'strategy_gather_target_held' };
  }
  if (decision.kind === 'move' && (decision.task.kind === 'defend' || decision.task.kind === 'intercept'
    || decision.task.kind === 'capture_general' && decision.move.to === decision.task.target)) {
    return { revision: intent.revision, status: 'preempted', reason: 'urgent_tactical_task_selected' };
  }
  return { revision: intent.revision, status: 'blocked', reason: decision.kind === 'move'
    ? 'no_safe_goal_candidate;autonomous_within_constraints' : 'no_safe_goal_candidate;waiting_with_constraints' };
}

/** Goal routes use the current graph; avoided tiles are excluded without changing map facts. */
export function strategyDistances(observation: AgentObservation, intent: StrategyIntent, target: number): number[] {
  const avoided = new Set((intent.constraints.avoidTiles ?? []).map((tile) => tile.y * observation.width + tile.x));
  const distance = Array<number>(observation.tiles.length).fill(Infinity), queue: number[] = [];
  if (!avoided.has(target)) { distance[target] = 0; queue.push(target); }
  for (let head = 0; head < queue.length; head++) for (const next of neighbors(queue[head], observation.width, observation.height)) {
    if (distance[next] !== Infinity || avoided.has(next) || knownWall(observation, next)) continue;
    distance[next] = distance[queue[head]] + 1;
    queue.push(next);
  }
  return distance;
}

export function strategyFallback(observation: AgentObservation, analysis: PositionAnalysis, intent: StrategyIntent,
  completed = false, defenseRequired = false): TaskCandidate | null {
  let best: TaskCandidate | null = null;
  const gatherTarget = completed ? null : strategyGatherTarget(observation, intent);
  for (const source of [...analysis.own].sort((a, b) => b.armies! - a.armies!).slice(0, 8)) {
    const reserve = Math.max(source.index === analysis.home ? analysis.homeReserve : 1, strategyReserve(observation, intent, source.index));
    const half = reserve > 1, sent = half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    if (sent <= 0 || source.armies! - sent < reserve || source.tunnelLimit !== 0) continue;
    for (const next of neighbors(source.index, observation.width, observation.height)) {
      const tile = observation.tiles[next];
      if (checkStrategyMove(observation, intent, { from: source.index, to: next, half })
        || knownWall(observation, next) || tile.tunnelLimit !== 0 || tile.armies === null) continue;
      if (tile.owner === observation.playerIndex && !(next === analysis.home
        && (gatherTarget === null ? analysis.threats.length : defenseRequired))) continue;
      if (tile.owner !== observation.playerIndex && sent <= tile.armies) continue;
      const kind = tile.general && tile.owner !== observation.playerIndex ? 'capture_general'
        : next === analysis.home ? 'defend' : tile.city ? 'capture_city' : 'expand';
      const score = kind === 'capture_general' ? 10000 : kind === 'defend' ? 1000 : kind === 'capture_city' ? 100 : 10 + sent;
      const candidate: TaskCandidate = { kind, score, reason: 'budget_fallback_one_step;strategy_constraints_checked',
        route: { source: source.index, target: next, path: [source.index, next], half, unknown: false, captured: 1,
          armies: tile.owner === observation.playerIndex ? tile.armies + sent : sent - tile.armies } };
      if (checkStrategyTask(observation, intent, kind, [candidate.route], completed)) continue;
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}
