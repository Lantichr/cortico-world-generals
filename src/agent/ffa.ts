import type { AgentObservation, StrategyIntent } from './contracts.ts';
import { analyzePosition, distances, type PositionAnalysis } from './analysis.ts';
import { canPlayerAct, knownGeneralIndex, resolvePlayerLifecycles } from './lifecycle.ts';
import type { Route, SearchBudget } from './search.ts';
import { assessMissionPlanTiming, projectVisibleRoute, type MissionTiming, type ThreatTiming } from './timing.ts';

export interface FfaFocus { player: number | null; reason: string }

/** One-step recovery preserves visible home-arrival deficits and still checks local combat exposure.
 * It does not establish complete home coverage or safety against unseen reinforcement.
 */
export function assessFfaRecovery(observation: AgentObservation, analysis: PositionAnalysis, route: Route,
  budget: SearchBudget, timing: ThreatTiming): MissionTiming | null {
  if (route.path.length !== 2 || route.source === analysis.home) return null;
  const from = observation.tiles[route.source], to = observation.tiles[route.target], home = observation.tiles[analysis.home];
  const distance = (tile: typeof from) => Math.abs(tile.x - home.x) + Math.abs(tile.y - home.y);
  if (!(to.owner === observation.playerIndex && distance(to) < distance(from)
    || to.city && to.owner !== observation.playerIndex)) return null;
  const projected = projectVisibleRoute(observation, route.path, route.half, budget);
  if (!projected) return null;
  const after = analyzePosition(projected.observation);
  const noWorse = after.threats.every((threat) => {
    const before = analysis.threats.find((entry) => entry.tile === threat.tile && entry.owner === threat.owner);
    return before && threat.projectedArrivalArmies <= before.projectedArrivalArmies;
  });
  if (!noWorse) return null;
  const local = assessMissionPlanTiming(observation, { ...analysis, homeDemands: [] }, [route], budget, timing);
  return local.status === 'safe' ? { ...local,
    reason: `bounded_recovery;existing_home_gap_not_worsened;one_step_only;${local.reason}` } : null;
}

/** Deterministic FFA preferences are policy estimates; a focus never suppresses other players' threats. */
export function selectFfaFocus(observation: AgentObservation, analysis: PositionAnalysis,
  previous: number | null, intent: StrategyIntent | null): FfaFocus | null {
  const players = resolvePlayerLifecycles(observation);
  if (players.length <= 2) return null;
  const requested = intent?.goal.kind === 'attack_general' ? intent.goal.player : null;
  if (requested !== null && players.some((entry) => entry.player === requested
    && entry.status !== 'eliminated')) return { player: requested, reason: 's2_attack_general' };
  const main = [...analysis.own].sort((a, b) => b.armies! - a.armies! || a.index - b.index)[0];
  if (!main) return { player: null, reason: 'no_available_force' };
  const distance = distances(observation, main.index, true);
  const choices = players.filter((entry) => entry.player !== observation.playerIndex && entry.status !== 'eliminated')
    .flatMap((entry) => {
      const army = analysis.enemies.filter((tile) => tile.owner === entry.player);
      const general = knownGeneralIndex(observation, entry.player);
      const reach = Math.min(...army.map((tile) => distance[tile.index]), general === null ? Infinity : distance[general]);
      if (!Number.isFinite(reach)) return [];
      const largest = Math.max(0, ...army.map((tile) => tile.armies!));
      const pressure = canPlayerAct(observation, entry.player)
        ? Math.max(0, ...analysis.threats.filter((threat) => threat.owner === entry.player)
          .map((threat) => threat.projectedArrivalArmies / (Math.max(1, observation.tiles[analysis.home].armies!) * (threat.distance + 1)))) : 0;
      // Without a known general or defensive pressure, prefer growth over starting a stronger visible fight.
      if (general === null && largest >= main.armies! && pressure < 1) return [];
      const score = (general === null ? 0 : 2) + pressure + 4 / (reach + 1)
        + (main.armies! - largest) / Math.max(1, main.armies! + largest) + Number(previous === entry.player) * 0.5;
      return [{ player: entry.player, score }];
    }).sort((a, b) => b.score - a.score || a.player - b.player);
  return choices[0] ? { player: choices[0].player, reason: 'known_general_pressure_distance_and_force;retained_focus_bonus' }
    : { player: null, reason: 'grow_or_scout_without_attack_focus' };
}

export function scoreFfaTarget(observation: AgentObservation, focus: FfaFocus | null, target: number,
  kind: string, moves: number): number {
  if (!focus || kind === 'intercept' || kind === 'defend' || kind === 'gather') return 0;
  const tile = observation.tiles[target], owner = tile.owner ?? observation.history[target]?.owner;
  if (kind === 'capture_general') {
    const score = observation.scores.find((value) => value && typeof value === 'object'
      && (value as Record<string, unknown>).i === owner) as Record<string, unknown> | undefined;
    const total = typeof score?.total === 'number' ? Math.max(0, score.total) : 0;
    return Math.log2(total + 1) * 4 / moves;
  }
  if (owner === null || owner === undefined || owner === observation.playerIndex) return 0;
  return owner === focus.player ? 10 / Math.pow(moves, 0.7) : -10 / Math.pow(moves, 0.7);
}
