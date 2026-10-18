import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import { projectOwnedRoute, type Route, type SearchBudget } from './search.ts';

export interface GatheringAnalysis {
  anchor: number | null;
  recover: Route | null;
}

interface Component { tiles: number[]; frontier: boolean }

/** True proves every source has no external boundary without crossing home; null means the scan was incomplete. */
export function enclosedGatheringSources(observation: AgentObservation, analysis: PositionAnalysis,
  sources: Iterable<number>, budget: SearchBudget): boolean | null {
  const owned = (index: number) => {
    const tile = observation.tiles[index];
    return tile.visible && tile.owner === observation.playerIndex && tile.armies !== null
      && tile.tunnelLimit === 0 && !knownWall(observation, index);
  };
  const visited = new Set<number>();
  for (const source of sources) {
    if (source === analysis.home || !owned(source)) return false;
    if (visited.has(source)) continue;
    const queue = [source];
    visited.add(source);
    for (let head = 0; head < queue.length; head++) {
      for (const next of neighbors(queue[head], observation.width, observation.height)) {
        if (!budget.take()) return null;
        if (next === analysis.home) continue;
        if (owned(next)) {
          if (!visited.has(next)) { visited.add(next); queue.push(next); }
        } else if (!knownWall(observation, next)) return false;
      }
    }
  }
  return visited.size > 0;
}

/** Finds shortest current-owned transports without enemy or general transit shortcuts. */
export function searchGatheringRoutes(observation: AgentObservation, analysis: PositionAnalysis, anchor: number,
  sources: number[], budget: SearchBudget): Route[] {
  const traversable = (index: number) => {
    const tile = observation.tiles[index];
    return tile.visible && tile.owner === observation.playerIndex && tile.armies !== null
      && tile.tunnelLimit === 0 && !knownWall(observation, index);
  };
  if (!traversable(anchor)) return [];
  const wanted = new Set(sources.filter((index) => index !== anchor && traversable(index) && observation.tiles[index].armies! > 1));
  if (!wanted.size) return [];
  const parent = new Map<number, number>([[anchor, -1]]);
  const queue = [anchor], routes: Route[] = [];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === analysis.home && anchor !== analysis.home) continue;
    for (const next of neighbors(current, observation.width, observation.height)) {
      if (!budget.take()) return routes;
      if (parent.has(next) || !traversable(next)) continue;
      parent.set(next, current);
      queue.push(next);
      if (!wanted.delete(next)) continue;
      const path = [next];
      while (path.at(-1) !== anchor) {
        if (!budget.take()) return routes;
        path.push(parent.get(path.at(-1)!)!);
      }
      const route = projectOwnedRoute(observation, path, next === analysis.home ? analysis.homeReserve : 1);
      if (!budget.timeAvailable()) return routes;
      if (route) routes.push(route);
      if (!wanted.size) return routes;
    }
  }
  return routes;
}

/** Field anchors must reach an external boundary without passing through the general. */
export function analyzeGathering(observation: AgentObservation, analysis: PositionAnalysis,
  budget: SearchBudget): GatheringAnalysis {
  const owned = new Set(analysis.own.filter((tile) => tile.visible && tile.armies !== null
    && tile.tunnelLimit === 0 && !knownWall(observation, tile.index)).map((tile) => tile.index));
  if (!owned.has(analysis.home)) return { anchor: null, recover: null };
  const visited = new Set([analysis.home]);
  const components: Component[] = [];
  for (const source of owned) {
    if (visited.has(source)) continue;
    const component: Component = { tiles: [source], frontier: false };
    visited.add(source);
    for (let head = 0; head < component.tiles.length; head++) {
      for (const next of neighbors(component.tiles[head], observation.width, observation.height)) {
        // An incomplete component cannot establish that its only exit is the general.
        if (!budget.take()) return { anchor: null, recover: null };
        if (next === analysis.home) continue;
        if (owned.has(next)) {
          if (!visited.has(next)) { visited.add(next); component.tiles.push(next); }
        } else if (externalBoundary(observation, next)) component.frontier = true;
      }
    }
    components.push(component);
  }
  const anchors = components.filter((component) => component.frontier).flatMap((component) => component.tiles)
    .filter((index) => observation.tiles[index].armies! >= 4);
  const chooseAnchor = (distance?: number[]) => [...anchors].sort((a, b) => observation.tiles[b].armies! - observation.tiles[a].armies!
    || (distance ? distance[b] - distance[a] : 0) || a - b)[0]
    ?? (components.some((component) => component.frontier) ? null : analysis.home);
  const initialAnchor = chooseAnchor();
  const recoverySources = components.filter((component) => !component.frontier).flatMap((component) => component.tiles)
    .filter((source) => observation.tiles[source].armies! > 1);
  const tiedAnchors = initialAnchor !== null && anchors.filter((index) => observation.tiles[index].armies
    === observation.tiles[initialAnchor].armies).length > 1;
  if (!recoverySources.length && !tiedAnchors) return { anchor: initialAnchor, recover: null };
  const distance = Array<number>(observation.tiles.length).fill(Infinity);
  const parent = Array<number>(observation.tiles.length).fill(-1);
  const queue = [analysis.home];
  distance[analysis.home] = 0;
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbors(queue[head], observation.width, observation.height)) {
      if (!budget.take()) return { anchor: chooseAnchor(), recover: null };
      if (!owned.has(next) || distance[next] !== Infinity) continue;
      distance[next] = distance[queue[head]] + 1;
      parent[next] = queue[head];
      queue.push(next);
    }
  }
  const anchor = chooseAnchor(distance);
  let recover: Route | null = null, delivered = 0;
  const home = observation.tiles[analysis.home];
  for (const source of recoverySources) {
    if (distance[source] === Infinity) continue;
    const path = [source];
    while (path.at(-1) !== analysis.home) path.push(parent[path.at(-1)!]);
    const candidate = recoveryRoute(observation, path, budget);
    if (!candidate) {
      if (budget.exhausted) return { anchor, recover };
      continue;
    }
    const added = candidate.armies - home.armies! - production(home, observation.turn, observation.turn + path.length - 1);
    if (!recover || added > delivered || added === delivered && (path.length < recover.path.length
      || path.length === recover.path.length && source < recover.source)) {
      recover = candidate;
      delivered = added;
    }
  }
  return { anchor, recover };
}

function externalBoundary(observation: AgentObservation, index: number): boolean {
  const tile = observation.tiles[index];
  return !knownWall(observation, index) && (tile.tunnelLimit === null || tile.tunnelLimit === 0)
    && (tile.visible || tile.terrain !== -4 || !!observation.history[index]?.city);
}

function recoveryRoute(observation: AgentObservation, path: number[], budget: SearchBudget): Route | null {
  let armies = observation.tiles[path[0]].armies!;
  for (let step = 1; step < path.length; step++) {
    if (!budget.take() || armies <= 1) return null;
    const tile = observation.tiles[path[step]];
    armies = armies - 1 + tile.armies! + production(tile, observation.turn, observation.turn + step);
  }
  return { source: path[0], target: path.at(-1)!, path, armies, captured: 0, unknown: false, half: false };
}
