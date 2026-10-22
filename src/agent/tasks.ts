import type { AgentObservation, AgentTaskKind, StrategyIntent } from './contracts.ts';
import { distances, neighbors, production, type PositionAnalysis } from './analysis.ts';
import type { Route, SearchBudget } from './search.ts';
import { analyzeGathering, type GatheringAnalysis } from './gather.ts';
import { evaluateTransport, transportTargets, type TransportObjectives } from './transport.ts';
import { createThreatTiming, type ThreatTiming } from './timing.ts';
import { checkStrategyRoutes, checkStrategyTask, scoreStrategyCandidate, strategyCandidates } from './strategy.ts';
import { scoreFfaTarget, type FfaFocus } from './ffa.ts';

export interface TaskCandidate {
  route: Route;
  kind: AgentTaskKind;
  score: number;
  reason: string;
}

export interface TaskCommitment { kind: AgentTaskKind; target: number; army: number; path?: number[] }

/** Scores are deterministic strategy preferences, not estimated win probabilities. */
export function rankTasks(observation: AgentObservation, analysis: PositionAnalysis, routes: Route[],
  commitment: TaskCommitment | null, budget: SearchBudget,
  gathering: GatheringAnalysis = analyzeGathering(observation, analysis, budget), urgentDefense?: boolean,
  timing: ThreatTiming = createThreatTiming(observation, analysis), selectedTransportTargets?: number[], intent?: StrategyIntent | null,
  completedIntent = false, focus: FfaFocus | null = null): TaskCandidate[] {
  const homeDistance = distances(observation, analysis.home, true);
  const home = observation.tiles[analysis.home];
  const urgent = urgentDefense === false ? []
    : analysis.threats.filter((threat) => threat.projectedArrivalArmies >= threat.projectedHomeArmies);
  const targets = new Set(selectedTransportTargets ?? transportTargets(observation, analysis, gathering,
    [...new Set(routes.map((route) => route.source))], routes, budget, timing));
  const objectives: TransportObjectives = {};
  const availableRoutes: Route[] = [];
  for (const route of routes) {
    if (intent && !budget.timeAvailable()) break;
    if (!intent || !checkStrategyRoutes(observation, intent, [route])) availableRoutes.push(route);
  }
  const candidates: TaskCandidate[] = [];
  if (gathering.recover && !urgent.length) {
    const route = gathering.recover, moves = route.path.length - 1;
    const added = route.armies - home.armies! - production(home, observation.turn, observation.turn + moves);
    if (added > 2 && (!intent || !checkStrategyRoutes(observation, intent, [route]))) candidates.push({ route, kind: 'gather',
      score: 5 + added / (moves + 2) * 1.2 + Math.log2(home.armies! + 1),
      reason: 'recover_trapped_field_army;owned_route_to_general' });
  }
  for (const route of availableRoutes) {
    if (!budget.timeAvailable()) break;
    const tile = observation.tiles[route.target];
    const moves = route.path.length - 1;
    const source = observation.tiles[route.source];
    const first = observation.tiles[route.path[1]];
    // Passing through the general may collect its garrison only if the route ends there.
    if (route.path.slice(1, -1).includes(analysis.home)) continue;
    const coherent = commitment?.army === route.source ? 2.5 : 0;
    const committed = commitment?.target === route.target ? 4 : 0;
    const strength = Math.log2(source.armies! + 1) * 1.2;
    const timeCost = Math.pow(moves, 0.7);
    let kind: AgentTaskKind, score: number, reason: string;
    if (tile.general && tile.owner !== null && tile.owner !== observation.playerIndex) {
      if (urgent.length && moves > urgent[0].distance) continue;
      kind = 'capture_general';
      score = moves === 1 ? 2000 : 900 + 100 / moves;
      reason = 'visible_general;unopposed_route_projection';
    } else if (urgent.some((threat) => threat.tile === route.target && moves <= threat.distance)) {
      kind = 'intercept';
      score = 1050 + route.armies / moves;
      reason = 'visible_threat;interception_before_shortest_arrival_estimate';
    } else if (tile.owner === observation.playerIndex) {
      if (!targets.has(tile.index) || route.source === analysis.home && urgent.length
        || route.source === tile.index || source.armies! < 5
        || route.path.some((index) => observation.tiles[index].owner !== observation.playerIndex)) continue;
      const transport = evaluateTransport(observation, analysis, route, availableRoutes, budget, objectives, timing);
      if (transport?.readyTask && !availableRoutes.some((candidate) => candidate.source === transport.readyTask!.source
        && candidate.target === transport.readyTask!.target && candidate.half === transport.readyTask!.half)) {
        if (!intent || !checkStrategyRoutes(observation, intent, [transport.readyTask])) availableRoutes.push(transport.readyTask);
      }
      if (!transport || !transport.canContinue || transport.score <= 0 || transport.addedArmies <= 2
        || first.owner !== observation.playerIndex) continue;
      kind = 'gather';
      score = transport.score + coherent + committed;
      reason = transport.reason;
    } else if (route.unknown) {
      if (source.armies! < 6 || route.armies < 3) continue;
      kind = 'scout';
      const unseen = observation.history[tile.index] === null;
      const knownGeneral = analysis.enemyGenerals.includes(tile.index);
      score = (knownGeneral ? 90 : 10 + (unseen ? 5 : 0)) / timeCost + strength + coherent + committed;
      reason = 'frontier_probe;current_owner_and_armies_unknown;reobserve_after_step';
    } else if (tile.city) {
      kind = 'capture_city';
      score = (34 + (tile.owner !== null ? 15 : 0) - Math.max(0, tile.armies!) * 0.12) / timeCost + strength + coherent + committed;
      reason = 'visible_city;production_every_two_turns;unopposed_route_projection';
    } else {
      kind = 'expand';
      const info = neighbors(tile.index, observation.width, observation.height)
        .filter((next) => !observation.tiles[next].visible && observation.history[next] === null).length;
      const enemy = tile.owner !== null;
      const outward = Math.max(-3, Math.min(3, homeDistance[tile.index] - homeDistance[route.source]));
      score = ((enemy ? 17 : 8) + info * 1.6 + outward * 0.5 + route.captured * 0.8) / timeCost + strength + coherent + committed;
      reason = enemy ? 'visible_enemy_land;retain_main_army' : 'visible_land;expansion_and_frontier_visibility';
    }
    if (urgent.length && kind !== 'intercept' && kind !== 'capture_general') score -= 200;
    if (kind !== 'capture_general' && route.armies <= 1) score -= 12;
    score += scoreFfaTarget(observation, focus, route.target, kind, moves);
    candidates.push({ route, kind, score, reason });
  }
  if (intent) {
    for (const candidate of candidates) {
      if (!budget.timeAvailable()) break;
      scoreStrategyCandidate(observation, intent, candidate, completedIntent);
    }
    if (!completedIntent) candidates.push(...strategyCandidates(observation, intent, availableRoutes, budget));
  }
  const sorted = candidates.filter((candidate) => !intent
    || !checkStrategyTask(observation, intent, candidate.kind, [candidate.route], completedIntent)).sort(compareCandidates);
  const selected = new Set(sorted.slice(0, 8));
  const kinds = new Set<AgentTaskKind>();
  for (const candidate of sorted) {
    if (!kinds.has(candidate.kind)) { selected.add(candidate); kinds.add(candidate.kind); }
  }
  return [...selected].sort(compareCandidates);
}

function compareCandidates(a: TaskCandidate, b: TaskCandidate): number {
  return b.score - a.score || a.route.path.length - b.route.path.length
    || b.route.armies - a.route.armies || a.route.source - b.route.source || a.route.target - b.route.target;
}
