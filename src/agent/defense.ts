import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis, type HomeDemand } from './analysis.ts';
import { findHeldHomeScreen, searchRouteAlternatives, type Route, type SearchBudget } from './search.ts';
import { createThreatTiming, type ThreatTiming } from './timing.ts';
import { planGatheringTree } from './gather-tree.ts';

export interface DefensePlan {
  route: Route | null;
  requiredArmies: number;
  projectedArmies: number;
  deadlineTurn: number;
  status: 'sufficient' | 'partial' | 'unavailable';
  basis: 'visible' | 'history';
  paths: number[][];
  slackTurns: number;
  latestStartTurn: number;
  actionRequired: boolean;
  timingComplete: boolean;
  reason: string;
}

type Demand = HomeDemand & { requiredArmies: number };

interface ReinforcementState {
  armies: number[];
  available: number[];
  owners: Array<number | null>;
  elapsed: number;
  first: Route | null;
  projectedArmies: number;
  paths: number[][];
}

/** Bounded reinforcement search shares one move per turn and consumes every transported garrison.
 * Arrival targets ignore friendly screens, which reinforcement routes may withdraw, and assume no enemy reinforcements.
 */
export function planDefense(observation: AgentObservation, analysis: PositionAnalysis, budget: SearchBudget,
  preferredArmy: number | null = null, timing = createThreatTiming(observation, analysis)): DefensePlan | null {
  const home = observation.tiles[analysis.home];
  if (!home || home.owner !== observation.playerIndex || home.armies === null) return null;
  const demands: Demand[] = analysis.homeDemands.map((demand) => ({ ...demand, requiredArmies: demand.required }))
    .filter((demand) => demand.requiredArmies > home.armies! + production(home, observation.turn, observation.turn + demand.steps - 1))
    .sort((a, b) => a.steps - b.steps || b.requiredArmies - a.requiredArmies || Number(a.basis === 'history') - Number(b.basis === 'history'));
  const demand = demands[0];
  if (!demand) return null;
  if (findHeldHomeScreen(observation, analysis, budget, { homeArmies: home.armies })) return null;
  const deadlineTurn = observation.turn + demand.steps;
  const topologies = [topology(observation, analysis.home, demand.steps, budget, false),
    topology(observation, analysis.home, demand.steps, budget, true)];
  const initial: ReinforcementState = { armies: observation.tiles.map((tile) => tile.armies ?? 0), elapsed: 0,
    available: observation.tiles.map((tile) => tile.armies ?? 0),
    owners: observation.tiles.map((tile) => tile.owner), paths: [],
    first: null, projectedArmies: home.armies + production(home, observation.turn, deadlineTurn - 1) };
  let best = initial;
  let frontier = [initial];
  const primaryBudget = budget.fork(Math.floor(budget.remainingNodes * 0.75));
  while (frontier.length && primaryBudget.timeAvailable() && !primaryBudget.exhausted) {
    const nextStates: ReinforcementState[] = [];
    for (const state of frontier) {
      if (!primaryBudget.timeAvailable() || primaryBudget.exhausted) break;
      const paths = topologies.flatMap(({ distance, ordered }) =>
        reinforcementPaths(observation, analysis.home, distance, ordered, state, demand.steps, primaryBudget));
      paths.sort((a, b) => b.gain / (b.path.length - 1) - a.gain / (a.path.length - 1)
        || b.gain - a.gain || Number(b.path[0] === preferredArmy) - Number(a.path[0] === preferredArmy) || a.path[0] - b.path[0]);
      for (const { path } of paths.slice(0, 8)) {
        const candidate = reinforce(observation, analysis.home, state, path, deadlineTurn, primaryBudget, timing);
        if (!candidate || candidate.projectedArmies <= state.projectedArmies) continue;
        if (better(candidate, best, demand.requiredArmies, preferredArmy)) best = candidate;
        if (candidate.projectedArmies >= demand.requiredArmies) continue;
        nextStates.push(candidate);
      }
    }
    if (best.projectedArmies >= demand.requiredArmies) break;
    nextStates.sort((a, b) => b.projectedArmies - a.projectedArmies || a.elapsed - b.elapsed);
    const seen = new Set<string>();
    frontier = nextStates.filter((state) => {
      const key = `${state.elapsed}:${state.armies.join(',')}:${state.owners.join(',')}:${state.available.join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);
  }
  let timingComplete = !primaryBudget.exhausted && !budget.exhausted, alternativesUsed = false, treeUsed = false;
  if (best.projectedArmies < demand.requiredArmies && budget.timeAvailable() && !budget.exhausted) {
    const treeBudget = budget.fork(Math.floor(budget.remainingNodes * 0.6));
    const sources = analysis.own.filter((tile) => tile.index !== analysis.home && tile.armies! > 1)
      .sort((a, b) => b.armies! - a.armies! || a.index - b.index).slice(0, 12).map((tile) => tile.index);
    const tree = planGatheringTree(observation, analysis, analysis.home, sources, demand.steps, treeBudget, timing, demand.requiredArmies);
    timingComplete &&= tree?.searchComplete ?? !treeBudget.exhausted;
    if (tree) {
      const available = [...initial.available];
      const lastMove = new Map<number, number>();
      let elapsed = 0;
      for (const path of tree.paths) for (let step = 1; step < path.length; step++) {
        elapsed++;
        lastMove.set(path[step - 1], elapsed);
        lastMove.set(path[step], elapsed);
      }
      for (const [index, move] of lastMove) {
        const tile = tree.projectedObservation.tiles[index];
        available[index] = tile.armies! - production(tile, observation.turn + move - 1, observation.turn + tree.usedMoves);
      }
      const candidate: ReinforcementState = { armies: tree.projectedObservation.tiles.map((tile) => tile.armies ?? 0),
        available,
        owners: tree.projectedObservation.tiles.map((tile) => tile.owner), elapsed: tree.usedMoves,
        first: tree.route, paths: tree.paths,
        projectedArmies: tree.projectedArmies + production(home, observation.turn + tree.usedMoves, deadlineTurn - 1) };
      if (better(candidate, best, demand.requiredArmies, preferredArmy)) { best = candidate; treeUsed = true; }
    }
  }
  if (best.projectedArmies < demand.requiredArmies && budget.timeAvailable() && !budget.exhausted) {
    const base = best;
    const projected = { ...observation, turn: observation.turn + base.elapsed,
      tiles: observation.tiles.map((tile) => ({ ...tile, owner: base.owners[tile.index],
        armies: tile.armies === null ? null : base.armies[tile.index] })) };
    const sources = projected.tiles.filter((tile) => tile.index !== analysis.home && tile.owner === observation.playerIndex && tile.armies! > 1)
      .sort((a, b) => b.armies! - a.armies! || Number(b.index === preferredArmy) - Number(a.index === preferredArmy) || a.index - b.index).slice(0, 4);
    for (const [index, source] of sources.entries()) {
      const allowance = budget.fork(Math.max(1, Math.floor(budget.remainingNodes / (sources.length - index))));
      const alternatives = searchRouteAlternatives(projected, source.index, analysis.home, 1, allowance,
        { timing, startTurns: base.elapsed, maxTurns: demand.steps - base.elapsed, targetDistances: topologies[0].distance });
      timingComplete &&= alternatives.complete;
      for (const route of alternatives.routes) {
        const candidate = reinforce(observation, analysis.home, base, route.path, deadlineTurn, budget, timing);
        if (candidate && better(candidate, best, demand.requiredArmies, preferredArmy)) { best = candidate; alternativesUsed = true; }
      }
      if (best.projectedArmies >= demand.requiredArmies || budget.exhausted || !budget.timeAvailable()) break;
    }
  }
  const status = best.projectedArmies >= demand.requiredArmies ? 'sufficient' : best.first ? 'partial' : 'unavailable';
  const gap = Math.max(0, demand.requiredArmies - best.projectedArmies);
  const slackTurns = demand.steps - best.elapsed;
  const actionRequired = best.first !== null ? slackTurns <= 1 : demand.steps <= 1;
  return { route: best.first, requiredArmies: demand.requiredArmies, projectedArmies: best.projectedArmies,
    deadlineTurn, status, basis: demand.basis, paths: best.paths, slackTurns,
    latestStartTurn: observation.turn + slackTurns, actionRequired, timingComplete: status === 'sufficient' || timingComplete,
    reason: `defense_${status};target:${demand.requiredArmies};projected:${best.projectedArmies};gap:${gap};serial_moves:${best.elapsed}`
      + `;deadline_turn:${deadlineTurn};slack:${slackTurns};action_required:${actionRequired}`
      + (alternativesUsed ? ';route_search:bounded_alternatives' : '')
      + (treeUsed ? ';route_search:owned_gathering_tree' : '')
      + `;${demand.basis === 'history' ? `history_assumption:${demand.tile}@${demand.lastSeenTurn}` : `visible_enemy:${demand.tile}`}`
      + `;enemy_player:${demand.owner};enemy_sources:${demand.sources.join(',')};enemy_scenario:${demand.scenario}`
      + ';assumption:ignore_friendly_screen;possible_enemy_paths;ignore_enemy_transit_resistance;no_enemy_reinforcement;same_turn_home_reinforcement_before_attack;cumulative_visible_sequences;historical_sources_alternative;selected_enemy_orders;attack_before_production' };
}

function topology(observation: AgentObservation, home: number, deadline: number, budget: SearchBudget,
  ownedOnly: boolean): { distance: number[]; ordered: number[] } {
  const distance = Array<number>(observation.tiles.length).fill(Infinity), ordered = [home];
  distance[home] = 0;
  for (let head = 0; head < ordered.length; head++) {
    if (!budget.take()) break;
    const index = ordered[head];
    if (distance[index] >= deadline) continue;
    for (const next of neighbors(index, observation.width, observation.height)) {
      const tile = observation.tiles[next];
      if (distance[next] !== Infinity || !tile.visible || tile.armies === null || tile.tunnelLimit !== 0
        || knownWall(observation, next) || ownedOnly && tile.owner !== observation.playerIndex) continue;
      distance[next] = distance[index] + 1;
      ordered.push(next);
    }
  }
  return { distance, ordered };
}

function reinforcementPaths(observation: AgentObservation, home: number, distance: number[], ordered: number[],
  state: ReinforcementState, deadline: number, budget: SearchBudget): Array<{ path: number[]; gain: number }> {
  const result: Array<{ path: number[]; gain: number }> = [];
  const nextIndex = Array<number>(observation.tiles.length).fill(-1);
  const gain = Array<number>(observation.tiles.length).fill(0);
  for (const index of ordered) {
    if (index === home || distance[index] + state.elapsed > deadline) continue;
    if (!budget.take()) break;
    const next = neighbors(index, observation.width, observation.height).filter((neighbor) => distance[neighbor] === distance[index] - 1)
      .sort((a, b) => gain[b] - gain[a] || a - b)[0];
    if (next === undefined) continue;
    nextIndex[index] = next;
    gain[index] = (state.owners[index] === observation.playerIndex ? state.armies[index] : -state.armies[index]) - 1 + gain[next];
    if (state.owners[index] !== observation.playerIndex || state.armies[index] <= 1) continue;
    const path = [index];
    for (let current = index; current !== home;) {
      current = nextIndex[current];
      path.push(current);
    }
    result.push({ path, gain: gain[index] });
  }
  return result;
}

function reinforce(observation: AgentObservation, home: number, state: ReinforcementState, path: number[],
  deadlineTurn: number, budget: SearchBudget, timing: ThreatTiming): ReinforcementState | null {
  const armies = [...state.armies];
  const available = [...state.available];
  const owners = [...state.owners];
  if (path[0] !== home && timing.exposure(path[0], state.elapsed, available[path[0]], budget) !== null) return null;
  for (let step = 1; step < path.length; step++) {
    if (!budget.take()) return null;
    const from = path[step - 1], to = path[step];
    const sent = armies[from] - 1;
    if (sent <= 0) return null;
    if (to !== home && owners[to] === observation.playerIndex
      && timing.exposure(to, state.elapsed + step - 1, available[to], budget) !== null) return null;
    armies[from] = 1;
    if (owners[to] === observation.playerIndex) armies[to] += sent;
    else {
      if (sent <= armies[to]) return null;
      armies[to] = sent - armies[to];
      owners[to] = observation.playerIndex;
    }
    available[from] = armies[from];
    available[to] = armies[to];
    if (to !== home) {
      const exposure = timing.exposure(to, state.elapsed + step + 1, armies[to], budget);
      if (exposure !== null) return null;
    }
    const turn = observation.turn + state.elapsed + step;
    for (const tile of observation.tiles) {
      if (owners[tile.index] !== null) armies[tile.index] += production(tile, turn - 1, turn);
    }
  }
  const elapsed = state.elapsed + path.length - 1;
  return { armies, available, owners, elapsed, paths: [...state.paths, path],
    first: state.first ?? { source: path[0], target: home, path, armies: armies[home],
      captured: path.slice(1).filter((index) => state.owners[index] !== observation.playerIndex).length, unknown: false, half: false },
    projectedArmies: armies[home] + production(observation.tiles[home], observation.turn + elapsed, deadlineTurn - 1) };
}

function better(candidate: ReinforcementState, current: ReinforcementState, required: number, preferred: number | null): boolean {
  const enough = candidate.projectedArmies >= required, currentEnough = current.projectedArmies >= required;
  if (enough !== currentEnough) return enough;
  if (enough && candidate.elapsed !== current.elapsed) return candidate.elapsed < current.elapsed;
  if (candidate.projectedArmies !== current.projectedArmies) return candidate.projectedArmies > current.projectedArmies;
  if (candidate.elapsed !== current.elapsed) return candidate.elapsed < current.elapsed;
  return candidate.first?.source === preferred && current.first?.source !== preferred;
}
