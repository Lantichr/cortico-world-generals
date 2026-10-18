import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import type { Route, SearchBudget } from './search.ts';
import { projectVisibleRoute, type ThreatTiming } from './timing.ts';

export interface GatheringTreePlan {
  target: number;
  paths: number[][];
  routes: Route[];
  route: Route;
  addedArmies: number;
  projectedArmies: number;
  usedMoves: number;
  deadlineTurn: number;
  complete: true;
  searchComplete: boolean;
  projectedObservation: AgentObservation;
  reason: string;
}

interface TreeState { selected: number[]; plan: GatheringTreePlan }

/** Searches source subsets on a visible owned shortest-path tree; each selected edge moves once after its branches merge. */
export function planGatheringTree(observation: AgentObservation, analysis: PositionAnalysis, target: number,
  sources: number[], maxMoves: number, budget: SearchBudget, timing?: ThreatTiming, targetArmies?: number): GatheringTreePlan | null {
  if (maxMoves < 1 || !Number.isFinite(maxMoves) || !traversable(observation, target)
    || targetArmies !== undefined && observation.tiles[target].armies! >= targetArmies) return null;
  const deadlineTurn = observation.turn + Math.floor(maxMoves);
  const parent = new Map<number, number>([[target, -1]]), distance = new Map([[target, 0]]), queue = [target];
  let topologyComplete = true;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (distance.get(current)! >= maxMoves || current === analysis.home && target !== analysis.home) continue;
    for (const next of neighbors(current, observation.width, observation.height)) {
      if (!budget.take()) { topologyComplete = false; break; }
      if (parent.has(next) || !traversable(observation, next)) continue;
      parent.set(next, current); distance.set(next, distance.get(current)! + 1); queue.push(next);
    }
    if (!topologyComplete) break;
  }
  const paths = new Map<number, number[]>();
  for (const source of [...new Set(sources)].sort((a, b) => a - b)) {
    if (source === target || !parent.has(source) || observation.tiles[source].armies! <= 1) continue;
    const path = [source];
    while (path.at(-1) !== target) {
      if (!budget.take()) break;
      path.push(parent.get(path.at(-1)!)!);
    }
    if (path.at(-1) === target) paths.set(source, path);
    if (budget.exhausted) break;
  }
  const available = [...paths.keys()];
  let best: GatheringTreePlan | null = null;
  const frontier: TreeState[] = [];
  const evaluated = new Set<string>();
  const evaluate = (selected: number[]) => {
    const key = selected.join(',');
    if (evaluated.has(key)) return;
    evaluated.add(key);
    let selectedBest: GatheringTreePlan | null = null;
    for (const reversed of [false, true]) {
      const legs = compileTree(selected, paths, target, reversed, budget);
      if (!legs) break;
      const moves = legs.reduce((sum, path) => sum + path.length - 1, 0);
      if (moves > maxMoves) continue;
      const plan = reprojectGatheringTree(observation, analysis, legs, budget, timing, deadlineTurn);
      if (plan && plan.addedArmies > 0 && better(plan, selectedBest, observation, targetArmies)) selectedBest = plan;
      if (budget.exhausted) break;
    }
    if (!selectedBest) return;
    if (better(selectedBest, best, observation, targetArmies)) best = selectedBest;
    if (targetArmies === undefined || selectedBest.projectedArmies < targetArmies) frontier.push({ selected, plan: selectedBest });
  };
  for (let source = 0; source < available.length && !budget.exhausted; source++) evaluate([source]);
  while (frontier.length && budget.timeAvailable() && !budget.exhausted) {
    frontier.sort((a, b) => efficiency(b.plan, observation, targetArmies) - efficiency(a.plan, observation, targetArmies)
      || a.plan.usedMoves - b.plan.usedMoves);
    const state = frontier.shift()!;
    for (let next = state.selected.at(-1)! + 1; next < available.length && !budget.exhausted; next++) {
      evaluate([...state.selected, next]);
    }
  }
  if (best) {
    const result = best as GatheringTreePlan;
    result.searchComplete = topologyComplete && !budget.exhausted && !frontier.length;
    result.reason = `gathering_tree;bounded_owned_shortest_tree;added:${result.addedArmies};moves:${result.usedMoves}`
      + `;legs:${result.paths.length};search_complete:${result.searchComplete}`;
  }
  return best;

  function compileTree(selected: number[], sourcePaths: Map<number, number[]>, root: number, reversed: boolean,
    sharedBudget: SearchBudget): number[][] | null {
    const children = new Map<number, Set<number>>();
    for (const source of selected) {
      const path = sourcePaths.get(available[source])!;
      for (let step = 1; step < path.length; step++) {
        const childrenOfParent = children.get(path[step]) ?? new Set<number>();
        childrenOfParent.add(path[step - 1]); children.set(path[step], childrenOfParent);
      }
    }
    const legs: number[][] = [];
    const emit = (node: number): boolean => {
      const ordered = [...children.get(node) ?? []].sort((a, b) => reversed ? b - a : a - b);
      for (const child of ordered) {
        if (!emit(child) || !sharedBudget.take()) return false;
        const last = legs.at(-1);
        if (last?.at(-1) === child) last.push(node);
        else legs.push([child, node]);
      }
      return true;
    };
    return emit(root) ? legs : null;
  }
}

/** Every leg shares the same serial clock; a result exists only after all current-owned legs pass projection and timing. */
export function reprojectGatheringTree(observation: AgentObservation, analysis: PositionAnalysis, paths: number[][],
  budget: SearchBudget, timing?: ThreatTiming, deadlineTurn = observation.turn
    + paths.reduce((sum, path) => sum + Math.max(0, path.length - 1), 0)): GatheringTreePlan | null {
  const usedMoves = paths.reduce((sum, path) => sum + path.length - 1, 0), target = paths.at(-1)?.at(-1);
  if (target === undefined || usedMoves < 1 || observation.turn + usedMoves > deadlineTurn
    || paths.some((path) => path.length < 2 || path.slice(1, -1).includes(analysis.home)
      || path.some((index) => !traversable(observation, index)))) return null;
  let current = observation;
  const routes: Route[] = [];
  const available = new Map(observation.tiles.filter((tile) => tile.owner === observation.playerIndex)
    .map((tile) => [tile.index, tile.armies!]));
  let elapsed = 0;
  for (const path of paths) {
    const source = current.tiles[path[0]], half = source.index === analysis.home && analysis.homeReserve > 1;
    const sent = half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    if (sent <= 0 || source.index === analysis.home && source.armies! - sent < analysis.homeReserve) return null;
    if (timing && source.index !== analysis.home) {
      const exposure = timing.exposure(source.index, elapsed, available.get(source.index)!, budget);
      if (exposure !== null) return null;
    }
    let projectedArmies = 0;
    for (let step = 1; step < path.length; step++) {
      const next = path[step];
      if (timing && next !== analysis.home) {
        const waiting = timing.exposure(next, elapsed, available.get(next)!, budget);
        if (waiting !== null) return null;
      }
      const projected = projectVisibleRoute(current, [path[step - 1], next], step === 1 && half, budget);
      if (!projected) return null;
      current = projected.observation; elapsed++;
      projectedArmies = current.tiles[next].armies!;
      if (timing && next !== analysis.home) {
        const exposure = timing.exposure(next, elapsed + 1,
          projectedArmies - production(current.tiles[next], current.turn - 1, current.turn), budget);
        if (exposure !== null) return null;
      }
      for (const index of [path[step - 1], next]) {
        const tile = current.tiles[index];
        available.set(index, tile.armies! - production(tile, current.turn - 1, current.turn));
      }
    }
    routes.push({ source: path[0], target: path.at(-1)!, path: [...path], armies: projectedArmies,
      captured: 0, unknown: false, half });
  }
  const projectedArmies = current.tiles[target].armies!;
  return { target, paths: paths.map((path) => [...path]), routes, route: routes[0], usedMoves, deadlineTurn,
    addedArmies: projectedArmies - observation.tiles[target].armies! - production(observation.tiles[target], observation.turn, current.turn),
    projectedArmies, projectedObservation: current, complete: true, searchComplete: true,
    reason: 'gathering_tree_reprojected;all_legs_current_owned;shared_serial_clock' };
}

function traversable(observation: AgentObservation, index: number): boolean {
  const tile = observation.tiles[index];
  return !!tile && tile.visible && tile.owner === observation.playerIndex && tile.armies !== null
    && tile.tunnelLimit === 0 && !knownWall(observation, index);
}

function efficiency(plan: GatheringTreePlan, observation: AgentObservation, targetArmies?: number): number {
  const useful = targetArmies === undefined ? plan.addedArmies : Math.max(0, Math.min(plan.addedArmies,
    targetArmies - observation.tiles[plan.target].armies! - production(observation.tiles[plan.target], observation.turn,
      observation.turn + plan.usedMoves)));
  return useful / plan.usedMoves;
}

function better(candidate: GatheringTreePlan, previous: GatheringTreePlan | null, observation: AgentObservation,
  targetArmies?: number): boolean {
  if (!previous) return true;
  if (targetArmies !== undefined) {
    const enough = candidate.projectedArmies >= targetArmies, previousEnough = previous.projectedArmies >= targetArmies;
    if (enough !== previousEnough) return enough;
    if (enough && candidate.usedMoves !== previous.usedMoves) return candidate.usedMoves < previous.usedMoves;
  }
  return efficiency(candidate, observation, targetArmies) > efficiency(previous, observation, targetArmies)
    || efficiency(candidate, observation, targetArmies) === efficiency(previous, observation, targetArmies)
      && (candidate.usedMoves < previous.usedMoves || candidate.usedMoves === previous.usedMoves
        && candidate.projectedArmies > previous.projectedArmies);
}
