import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import type { ThreatTiming } from './timing.ts';

export class SearchBudget {
  nodes = 0;
  exhausted = false;

  constructor(private readonly maxNodes: number, private readonly maxMs: number, readonly startedAt = performance.now(),
    private readonly parent?: SearchBudget) {}

  get remainingNodes(): number { return Math.max(0, Math.min(this.maxNodes - this.nodes, this.parent?.remainingNodes ?? Infinity)); }

  fork(maxNodes: number): SearchBudget {
    return new SearchBudget(Math.min(maxNodes, this.remainingNodes), this.maxMs, this.startedAt, this);
  }

  timeAvailable(): boolean {
    if (performance.now() - this.startedAt >= this.maxMs) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  take(): boolean {
    if (this.nodes >= this.maxNodes || !this.timeAvailable()) {
      this.exhausted = true;
      return false;
    }
    if (this.parent && !this.parent.take()) {
      this.exhausted = true;
      return false;
    }
    this.nodes++;
    return true;
  }
}

export interface Route {
  source: number;
  target: number;
  path: number[];
  armies: number;
  captured: number;
  unknown: boolean;
  half: boolean;
}

export interface HeldHomeScreen { tile: number; enemyArmies: number }

/** A single unmoved home neighbor must separate every visible threat; its garrison is counted once against their sum. */
export function findHeldHomeScreen(observation: AgentObservation, analysis: PositionAnalysis, budget: SearchBudget,
  options: { withdrawn?: ReadonlySet<number>; homeArmies?: number } = {}): HeldHomeScreen | null {
  if (analysis.possibleThreats.length || !analysis.threats.length) return null;
  const enemyArmies = visibleEnemyBudget(observation, analysis);
  const candidates = neighbors(analysis.home, observation.width, observation.height)
    .filter((index) => observation.tiles[index].owner === observation.playerIndex && observation.tiles[index].armies! > 1
      && !options.withdrawn?.has(index)
      && (options.homeArmies === undefined || options.homeArmies + observation.tiles[index].armies! >= enemyArmies))
    .sort((a, b) => observation.tiles[b].armies! - observation.tiles[a].armies! || a - b);
  for (const tile of candidates) {
    if (separatesHomeThreats(observation, analysis, tile, budget)) return { tile, enemyArmies };
    if (budget.exhausted) break;
  }
  return null;
}

export interface RouteAlternativeOptions {
  timing: ThreatTiming;
  maxTurns: number;
  startTurns?: number;
  ownedOnly?: boolean;
  /** Distances to this target through the same passable tiles, reusable across reinforcement sources. */
  targetDistances?: readonly number[];
}

export interface RouteAlternatives {
  routes: Route[];
  /** The retained frontier was exhausted without a node/time limit or label truncation. */
  complete: boolean;
}

interface RouteLabel extends Route { active: boolean }

/** Bounded visible-route search retains short and strong alternatives at each tile.
 * Three labels per tile limit path combinations; no candidate does not establish that no route exists.
 */
export function searchRouteAlternatives(observation: AgentObservation, source: number, target: number, reserve: number,
  budget: SearchBudget, options: RouteAlternativeOptions): RouteAlternatives {
  const initial = observation.tiles[source], half = reserve > 1;
  const maxTurns = Math.min(options.maxTurns, observation.tiles.length - 1);
  const sent = half ? Math.floor(initial.armies! / 2) : initial.armies! - 1;
  if (sent <= 0 || initial.armies! - sent < reserve || initial.tunnelLimit !== 0) return { routes: [], complete: true };
  const passable = (index: number) => {
    const tile = observation.tiles[index];
    return tile.visible && tile.armies !== null && tile.tunnelLimit === 0 && !knownWall(observation, index)
      && (!options.ownedOnly || tile.owner === observation.playerIndex);
  };
  if (!passable(target)) return { routes: [], complete: true };
  const home = observation.generals[observation.playerIndex];
  if (source !== home) {
    const waiting = options.timing.exposure(source, options.startTurns ?? 0, initial.armies!, budget);
    if (waiting !== null) return { routes: [], complete: waiting !== undefined };
  }
  const computed = Array<number>(observation.tiles.length).fill(Infinity), ordered = [target];
  const distance = options.targetDistances ?? computed;
  computed[target] = 0;
  let interrupted = false, truncated = false;
  for (let head = 0; !options.targetDistances && head < ordered.length; head++) {
    if (!budget.take()) { interrupted = true; break; }
    const current = ordered[head];
    if (distance[current] >= maxTurns) continue;
    for (const next of neighbors(current, observation.width, observation.height)) {
      if (computed[next] !== Infinity || !passable(next)) continue;
      computed[next] = computed[current] + 1;
      ordered.push(next);
    }
  }
  if (interrupted) return { routes: [], complete: false };
  if (distance[source] > maxTurns) return { routes: [], complete: true };
  const first: RouteLabel = { source, target: source, path: [source], armies: initial.armies!,
    captured: 0, unknown: false, half, active: true };
  const buckets: RouteLabel[][] = Array.from({ length: maxTurns + 1 }, () => []);
  let priority = distance[source];
  buckets[priority].push(first);
  const labels = new Map<number, RouteLabel[]>([[source, [first]]]);
  while (priority <= maxTurns) {
    const route = buckets[priority].pop();
    if (!route) { priority++; continue; }
    const depth = route.path.length;
    if (!route.active || route.target === target || depth > maxTurns) continue;
    if (!budget.take()) { interrupted = true; break; }
    for (const next of neighbors(route.target, observation.width, observation.height)) {
      if (!passable(next) || depth + distance[next] > maxTurns || route.path.includes(next)
        || next === home && next !== target) continue;
      const tile = observation.tiles[next];
      const amount = depth === 1 ? sent : route.armies - 1;
      if (amount <= 0) continue;
      const defenders = tile.armies! + (tile.owner !== null ? production(tile, observation.turn, observation.turn + depth - 1) : 0);
      if (tile.owner === observation.playerIndex && next !== home) {
        const waiting = options.timing.exposure(next, (options.startTurns ?? 0) + depth - 1, defenders, budget);
        if (waiting === undefined) { interrupted = true; break; }
        if (waiting) continue;
      }
      let armies = tile.owner === observation.playerIndex ? amount + defenders : amount - defenders;
      if (armies <= 0) continue;
      if (next !== home) {
        const exposure = options.timing.exposure(next, (options.startTurns ?? 0) + depth + 1, armies, budget);
        if (exposure === undefined) { interrupted = true; break; }
        if (exposure) continue;
      }
      armies += production(tile, observation.turn + depth - 1, observation.turn + depth);
      const candidate: RouteLabel = { source, target: next, path: [...route.path, next], armies,
        captured: route.captured + Number(tile.owner !== observation.playerIndex), unknown: false, half, active: true };
      const existing = labels.get(next) ?? [];
      if (existing.some((label) => dominates(label, candidate))) continue;
      const survivors = existing.filter((label) => {
        if (!dominates(candidate, label)) return true;
        label.active = false;
        return false;
      });
      survivors.push(candidate);
      let retained = survivors;
      if (survivors.length > 3) {
        truncated = true;
        const strongest = [...survivors].sort((a, b) => b.armies - a.armies || compareRoutes(a, b))[0];
        retained = [...survivors].sort(compareRoutes).filter((label) => label !== strongest).slice(0, 2);
        retained.push(strongest);
        for (const label of survivors) if (!retained.includes(label)) label.active = false;
      }
      labels.set(next, retained);
      if (candidate.active) buckets[depth + distance[next]].push(candidate);
    }
    if (interrupted) break;
  }
  return { routes: (labels.get(target) ?? []).sort(compareRoutes).map(({ active: _active, ...route }) => route),
    complete: !interrupted && !truncated };
}

function dominates(a: Route, b: Route): boolean {
  return a.path.length <= b.path.length && a.armies >= b.armies && a.path.every((index) => b.path.includes(index));
}

function compareRoutes(a: Route, b: Route): number {
  const order = a.path.length - b.path.length || b.armies - a.armies;
  if (order) return order;
  for (let index = 0; index < a.path.length; index++) if (a.path[index] !== b.path[index]) return a.path[index] - b.path[index];
  return 0;
}

/** Bounded shortest-route search keeps the strongest equal-distance arrival per tile. */
export function searchRoutes(observation: AgentObservation, source: number, reserve: number,
  budget: SearchBudget, ownedOnly = false, maxNodes = Infinity): Route[] {
  const startedNodes = budget.nodes;
  const initial = observation.tiles[source];
  const half = reserve > 1;
  const sent = half ? Math.floor(initial.armies! / 2) : initial.armies! - 1;
  if (sent <= 0 || initial.armies! - sent < reserve || initial.tunnelLimit !== 0) return [];
  const queue: Route[] = [{ source, target: source, path: [source], armies: initial.armies!, captured: 0, unknown: false, half }];
  const distance = Array<number>(observation.tiles.length).fill(Infinity);
  const bestArmies = Array<number>(observation.tiles.length).fill(-Infinity);
  const result: Route[] = [];
  distance[source] = 0;
  bestArmies[source] = initial.armies!;
  for (let head = 0; head < queue.length; head++) {
    const route = queue[head];
    if (route.path.length > 40 || route.unknown || route.target === observation.generals[observation.playerIndex] && source !== route.target) continue;
    for (const next of neighbors(route.target, observation.width, observation.height)) {
      if (budget.nodes - startedNodes >= maxNodes) return result;
      if (!budget.take()) return result;
      const tile = observation.tiles[next];
      const depth = route.path.length;
      if (knownWall(observation, next) || route.path.includes(next) || depth > distance[next]
        || (tile.tunnelLimit !== null && tile.tunnelLimit !== 0)
        || (ownedOnly && tile.owner !== observation.playerIndex)) continue;
      // Unexplored obstacle fog may be a mountain or a defended city; plain fog is the safer probe.
      if (!tile.visible && tile.terrain === -4 && !observation.history[next]?.city) continue;
      const amount = depth === 1 ? sent : route.armies - 1;
      if (amount <= 0) continue;
      const unknown = !tile.visible || tile.armies === null;
      const defenders = unknown ? 0 : tile.armies! + (tile.owner !== null
        ? production(tile, observation.turn, observation.turn + depth - 1) : 0);
      let armies = tile.owner === observation.playerIndex ? amount + defenders : amount - defenders;
      if (!unknown && tile.owner !== observation.playerIndex && armies <= 0) continue;
      if (tile.owner === observation.playerIndex || (!unknown && armies > 0)) {
        armies += production(tile, observation.turn + depth - 1, observation.turn + depth);
      }
      if (depth === distance[next] && armies <= bestArmies[next]) continue;
      distance[next] = depth;
      bestArmies[next] = armies;
      const candidate: Route = { source, target: next, path: [...route.path, next], armies,
        captured: route.captured + (tile.owner === observation.playerIndex ? 0 : 1), unknown, half };
      result.push(candidate);
      queue.push(candidate);
    }
  }
  return result;
}

/** Revalidates a remaining transport against current ownership and the general's departure reserve. */
export function projectOwnedRoute(observation: AgentObservation, path: number[], reserve: number): Route | null {
  if (path.length < 2 || path.slice(1, -1).includes(observation.generals[observation.playerIndex]) || path.some((index) => {
    const tile = observation.tiles[index];
    return tile.owner !== observation.playerIndex || tile.armies === null || tile.tunnelLimit !== 0 || knownWall(observation, index);
  })) return null;
  const source = observation.tiles[path[0]];
  const half = reserve > 1;
  const sent = half ? Math.floor(source.armies! / 2) : source.armies! - 1;
  if (sent <= 0 || source.armies! - sent < reserve) return null;
  let armies = source.armies!;
  for (let depth = 1; depth < path.length; depth++) {
    if (!neighbors(path[depth - 1], observation.width, observation.height).includes(path[depth])) return null;
    const tile = observation.tiles[path[depth]];
    const amount = depth === 1 ? sent : armies - 1;
    if (amount <= 0) return null;
    armies = amount + tile.armies! + production(tile, observation.turn, observation.turn + depth);
  }
  return { source: source.index, target: path.at(-1)!, path, armies, captured: 0, unknown: false, half };
}

/** A half-army screen may replace static reserves only on a verified single-entry corridor. */
export function bottleneckScreen(observation: AgentObservation, analysis: PositionAnalysis, budget: SearchBudget): Route | null {
  const home = observation.tiles[analysis.home];
  if (analysis.possibleThreats.length || !analysis.threats.length || !home || home.armies! < 7
    || Math.ceil(home.armies! / 2) >= analysis.homeReserve) return null;
  const sent = Math.floor(home.armies! / 2), remaining = home.armies! - sent;
  const enemyBudget = visibleEnemyBudget(observation, analysis);
  for (const next of neighbors(analysis.home, observation.width, observation.height)) {
    const tile = observation.tiles[next];
    if (!tile.visible || tile.armies === null || tile.tunnelLimit !== 0 || knownWall(observation, next)
      || tile.owner !== null && tile.owner !== observation.playerIndex) continue;
    const screenArmies = tile.owner === observation.playerIndex ? sent + tile.armies : sent - tile.armies;
    if (screenArmies <= 0 || remaining + screenArmies < enemyBudget) continue;
    if (!separatesHomeThreats(observation, analysis, next, budget)) continue;
    return { source: analysis.home, target: next, path: [analysis.home, next], half: true,
      armies: screenArmies, captured: tile.owner === observation.playerIndex ? 0 : 1, unknown: false };
  }
  return null;
}

function visibleEnemyBudget(observation: AgentObservation, analysis: PositionAnalysis): number {
  return analysis.threats.reduce((sum, threat) => sum + threat.armies
    + production(observation.tiles[threat.tile], observation.turn, observation.turn + threat.distance), 0);
}

function separatesHomeThreats(observation: AgentObservation, analysis: PositionAnalysis, screen: number, budget: SearchBudget): boolean {
  const reached = new Set([analysis.home]), queue = [analysis.home];
  for (let head = 0; head < queue.length; head++) {
    for (const index of neighbors(queue[head], observation.width, observation.height)) {
      if (!budget.take()) return false;
      if (index === screen || reached.has(index) || knownWall(observation, index)) continue;
      reached.add(index);
      queue.push(index);
    }
  }
  return analysis.threats.every((threat) => !reached.has(threat.tile));
}
